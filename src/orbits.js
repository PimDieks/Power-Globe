// Satellite positions from two-line element sets (TLEs), with the SGP4 model in satellite.js.
// Only the plain JavaScript parts of satellite.js (see the alias in vite.config.js).
import { twoline2satrec } from 'satellite.js/sgp4/io.js';
import { gstime, propagate } from 'satellite.js/sgp4/propagation.js';
import { eciToEcf } from 'satellite.js/sgp4/transforms.js';

export const EARTH_RADIUS_KM = 6371;
const MINUTES_PER_DAY = 1440;

// Name, line 1, line 2, repeated, as CelesTrak serves them.
export function parseTle(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length; ) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      out.push({ name: lines[i].replace(/^0 /, '').trim(), line1: lines[i + 1], line2: lines[i + 2] });
      i += 3;
    } else {
      i += 1;
    }
  }
  return out;
}

// Orbital period in minutes, from the mean motion in radians per minute.
export const periodMinutes = (satrec) => (2 * Math.PI) / satrec.no;

// Broad orbit classes, by period: low Earth orbit (up to about 2,000 km), medium (navigation
// satellites) and geosynchronous or highly elliptical.
export function orbitClass(satrec) {
  const period = periodMinutes(satrec);
  if (period < 128) return 'leo';
  if (period < 600) return 'meo';
  return 'geo';
}

export const ORBIT_LABELS = { leo: 'Low Earth orbit', meo: 'Medium Earth orbit', geo: 'High orbit (geosynchronous or elliptical)' };

// Earth-fixed position (km, x towards 0°N 0°E, z towards the North Pole) and speed (km/s) of a
// satellite at `date`, or null if the model has nothing sensible for it (e.g. it has decayed).
export function satellitePosition(satrec, date, gmst = gstime(date)) {
  const pv = propagate(satrec, date);
  if (!pv?.position || Number.isNaN(pv.position.x)) return null;
  const ecf = eciToEcf(pv.position, gmst);
  const v = pv.velocity;
  return { ...ecf, speed: v ? Math.hypot(v.x, v.y, v.z) : null };
}

// The same frame the globe uses: three-globe puts the North Pole at +y and 0°N 0°E at +z.
export const toScene = ({ x, y, z }, scale) => ({ x: y * scale, y: z * scale, z: x * scale });

export function toGeodetic({ x, y, z }) {
  const r = Math.hypot(x, y, z);
  return { lat: (Math.asin(z / r) * 180) / Math.PI, lng: (Math.atan2(y, x) * 180) / Math.PI, altitudeKm: r - EARTH_RADIUS_KM };
}

// Positions of many satellites at once, as x, y, z triples in a Float32Array (NaN where there is
// no position).
export function positionsAt(satrecs, date, out = new Float32Array(satrecs.length * 3)) {
  const gmst = gstime(date);
  satrecs.forEach((satrec, i) => {
    const p = satrec && satellitePosition(satrec, date, gmst);
    out[3 * i] = p ? p.x : NaN;
    out[3 * i + 1] = p ? p.y : NaN;
    out[3 * i + 2] = p ? p.z : NaN;
  });
  return out;
}

export function toSatrec({ line1, line2 }) {
  // satellite.js reads fixed columns and makes something of anything, so check the shape first.
  if (!/^1 [ \d]{5}/.test(line1) || !/^2 [ \d]{5}/.test(line2) || line1.length < 68 || line2.length < 68) return null;
  try {
    const satrec = twoline2satrec(line1, line2);
    return satrec.error || !(satrec.no > 0) ? null : satrec;
  } catch {
    return null;
  }
}

// The path a satellite will follow over the ground-fixed globe during its next orbit (at most a
// day), as Earth-fixed points.
export function orbitPath(satrec, from, steps = 180) {
  const minutes = Math.min(MINUTES_PER_DAY, periodMinutes(satrec));
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const p = satellitePosition(satrec, new Date(from.getTime() + (i / steps) * minutes * 60_000));
    if (p) points.push(p);
  }
  return points;
}

// When the elements were measured, from the epoch in line 1 (two-digit year, day of year).
export function tleEpoch(line1) {
  const year = Number(line1.slice(18, 20));
  const day = Number(line1.slice(20, 32));
  return new Date(Date.UTC(year < 57 ? 2000 + year : 1900 + year, 0, 1) + (day - 1) * 86_400_000);
}
