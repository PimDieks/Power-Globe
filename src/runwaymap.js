// Runways drawn on the map when zoomed in to airports, coloured by whether they can be used in
// the wind: green within limits, amber marginal, red out of limits, white without data.
import * as THREE from 'three';

const RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6_371_000;
const FT = 0.3048;

export const STATUS_COLORS = {
  ok: [0.49, 0.89, 0.66],
  caution: [1, 0.78, 0.34],
  nogo: [1, 0.54, 0.5],
  unknown: [0.9, 0.93, 0.96],
};

// The point `distance` metres from `from` along `bearing` degrees (great circle).
export function destination({ lat, lng }, bearing, distance) {
  const d = distance / EARTH_RADIUS_M;
  const b = bearing * RAD;
  const lat1 = lat * RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = lng * RAD + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / RAD, lng: ((((lng2 / RAD + 180) % 360) + 360) % 360) - 180 };
}

// Both thresholds of a runway: from the data where known, else laid out from the airport's
// reference point along the runway heading (an estimate: parallel runways then overlap).
export function runwayEnds(airport, runway) {
  if (runway.leEnd && runway.heEnd) return [runway.leEnd, runway.heEnd];
  const half = (Math.max(runway.lengthFt, 1500) * FT) / 2;
  const center = { lat: airport.lat, lng: airport.lng };
  return [destination(center, runway.leHeading + 180, half), destination(center, runway.leHeading, half)];
}

// The better of a runway's two directions: one usable direction is enough to use the runway.
const RANK = { unknown: -1, ok: 0, caution: 1, nogo: 2 };
export function runwayStatus(runway, endStatus) {
  const statuses = [endStatus.get(runway.le), runway.he ? endStatus.get(runway.he) : undefined].filter(Boolean);
  if (!statuses.length) return 'unknown';
  return statuses.reduce((best, s) => (RANK[s] < RANK[best] ? s : best));
}

// Runway shapes as one mesh: a dark outline under a coloured strip for each runway, at least
// a few pixels wide so they read at any zoom.
export function setupRunways(globe) {
  const R = globe.getGlobeRadius();
  const outline = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x05080f, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }),
  );
  const strip = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }),
  );
  // Over the weather layers, under aircraft.
  outline.renderOrder = 5;
  strip.renderOrder = 6;
  for (const mesh of [outline, strip]) {
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.visible = false;
    globe.scene().add(mesh);
  }

  const toScene = ({ lat, lng }, out) => {
    const r = R * 1.00002;
    const cos = Math.cos(lat * RAD);
    out.push(r * cos * Math.sin(lng * RAD), r * Math.sin(lat * RAD), r * cos * Math.cos(lng * RAD));
  };

  // A quad from `a` to `b`, `width` metres wide, as two triangles.
  function quad([a, b], width, extend, positions) {
    const bearing = bearingBetween(a, b);
    const a2 = destination(a, bearing + 180, extend);
    const b2 = destination(b, bearing, extend);
    const corners = [
      destination(a2, bearing - 90, width / 2),
      destination(a2, bearing + 90, width / 2),
      destination(b2, bearing + 90, width / 2),
      destination(b2, bearing - 90, width / 2),
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) toScene(corners[i], positions);
  }

  // `runways`: [{ ends: [a, b], widthFt, status }]; `metresPerPixel` sets the minimum width.
  function draw(runways, metresPerPixel) {
    if (!runways.length) {
      outline.visible = strip.visible = false;
      return;
    }
    const inner = [];
    const outer = [];
    const colors = [];
    for (const rw of runways) {
      const width = Math.max(rw.widthFt * FT, 5 * metresPerPixel);
      quad(rw.ends, width + 3 * metresPerPixel, 1.5 * metresPerPixel, outer);
      quad(rw.ends, width, 0, inner);
      const c = STATUS_COLORS[rw.status] ?? STATUS_COLORS.unknown;
      for (let k = 0; k < 6; k++) colors.push(...c);
    }
    outline.geometry.dispose();
    strip.geometry.dispose();
    outline.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(outer, 3));
    strip.geometry = new THREE.BufferGeometry()
      .setAttribute('position', new THREE.Float32BufferAttribute(inner, 3))
      .setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    outline.visible = strip.visible = true;
  }

  return { draw };
}

export function bearingBetween(a, b) {
  const lat1 = a.lat * RAD;
  const lat2 = b.lat * RAD;
  const dl = (b.lng - a.lng) * RAD;
  const y = Math.sin(dl) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dl);
  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}
