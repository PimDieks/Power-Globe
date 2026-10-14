// Runways drawn on the map when zoomed in to airports, coloured by whether they can be used in
// the wind: green within limits, amber marginal, red out of limits, white without data. A runway
// takes the status of its better end (see runwayCall in opsrunway.js).
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

// A flat frame in metres around `origin` (x east, y north); accurate over the few kilometres of
// an airport view, where the screen also shows north up.
export function localFrame(origin) {
  const k = 111_320;
  const c = Math.cos(origin.lat * RAD);
  const wrap = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
  return {
    toXY: (p) => ({ x: wrap(p.lng - origin.lng) * k * c, y: (p.lat - origin.lat) * k }),
    toLatLng: ({ x, y }) => ({ lat: origin.lat + y / k, lng: origin.lng + x / (k * c) }),
  };
}

const inRect = (p, r) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;

function segmentsCross(p1, p2, q1, q2) {
  const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(q1, q2, p1);
  const d2 = d(q1, q2, p2);
  const d3 = d(p1, p2, q1);
  const d4 = d(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// Whether the segment a–b passes through the rectangle.
export function segmentHitsRect(a, b, r) {
  if (inRect(a, r) || inRect(b, r)) return true;
  const c = [
    { x: r.x0, y: r.y0 },
    { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 },
    { x: r.x0, y: r.y1 },
  ];
  return c.some((p, i) => segmentsCross(a, b, p, c[(i + 1) % 4]));
}

const overlaps = (r, s) => r.x0 < s.x1 && r.x1 > s.x0 && r.y0 < s.y1 && r.y1 > s.y0;

// Where to put labels so none covers a runway or another label. Each label has an `anchor`
// (x, y in metres), a preferred unit `direction` to sit in, and a size `w` × `h`; each runway
// is a segment `a`–`b` with half width `r`. `px` is metres per screen pixel. Candidates go out
// from the anchor, first straight along the direction, then turning to either side and moving
// further out. A label with no free spot takes the first one clear of other labels, else its
// first candidate; an `optional` label is left out instead (null). A label's own `distances`
// (pixels) can keep it close to its anchor. Returns label centres.
export function placeLabels(labels, runways, px, { gap = 3, taken = [] } = {}) {
  // `taken`: rectangles already used on screen (e.g. city names), in the same metres.
  const placed = [...taken];
  const ANGLES = [0, 25, -25, 50, -50, 80, -80, 115, -115, 150, -150, 180];
  const DISTANCES = [6, 14, 24, 36, 52, 72, 100, 140];
  return labels.map(({ anchor, direction, w, h, distances = DISTANCES, optional = false }) => {
    const rect = (c) => ({ x0: c.x - w / 2 - gap * px, x1: c.x + w / 2 + gap * px, y0: c.y - h / 2 - gap * px, y1: c.y + h / 2 + gap * px });
    const clearOfLabels = (c) => !placed.some((s) => overlaps(rect(c), s));
    const free = (c) => {
      const r = rect(c);
      if (!clearOfLabels(c)) return false;
      // Grow the label by each runway's half width, so the runway's edges stay clear too.
      return !runways.some((rw) => segmentHitsRect(rw.a, rw.b, { x0: r.x0 - rw.r, x1: r.x1 + rw.r, y0: r.y0 - rw.r, y1: r.y1 + rw.r }));
    };
    let first = null;
    let firstClear = null;
    let chosen = null;
    for (const d of distances) {
      for (const angle of ANGLES) {
        const t = (angle * Math.PI) / 180;
        const dir = { x: direction.x * Math.cos(t) - direction.y * Math.sin(t), y: direction.x * Math.sin(t) + direction.y * Math.cos(t) };
        // From the anchor to the label's edge, then the gap, then to its centre.
        const reach = d * px + Math.abs(dir.x) * (w / 2) + Math.abs(dir.y) * (h / 2);
        const c = { x: anchor.x + dir.x * reach, y: anchor.y + dir.y * reach };
        first ??= c;
        if (!firstClear && clearOfLabels(c)) firstClear = c;
        if (free(c)) {
          chosen = c;
          break;
        }
      }
      if (chosen) break;
    }
    if (!chosen && optional) return null;
    chosen ??= firstClear ?? first;
    placed.push(rect(chosen));
    return chosen;
  });
}
