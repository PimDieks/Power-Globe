// Where a selected aircraft came from and where it is going: the track the Power Globe API gets
// from OpenSky (api/worker.js, /track), the airport it left from, and the route the static
// route database gives for its callsign, which is only used when the aircraft's position bears it
// out. The parts that need no browser; flightlines.js draws them.
import { PROXY_URL } from './api.js';

// Static route data (VRS standing data, CC0, published through adsb.lol), one small file per
// callsign, and open to web pages.
export const ROUTES_URL = 'https://vrs-standing-data.adsb.lol/routes';
const KM_PER_NM = 1.852;
const EARTH_RADIUS_KM = 6371;
const RAD = Math.PI / 180;

// A track starts at an airport if its first point is on the ground or below this height, and
// within this distance of one.
export const DEPARTURE_MAX_FT = 8000;
export const DEPARTURE_MAX_KM = 15;
// A route fits if the track begins within this distance of its first airport, and the aircraft is
// within the larger of this distance and this share of the route's length from the line between
// the two airports.
export const ROUTE_START_KM = 60;
export const ROUTE_OFF_LINE_NM = 50;
export const ROUTE_OFF_LINE_SHARE = 0.2;
// An aircraft this close to its destination has arrived; no line is drawn to it.
export const ARRIVED_KM = 5;

const TIMEOUT_MS = 20_000;
// A track is kept for this long in the page, so that selecting the same aircraft again, or
// failing to get a track, does not ask again every time. A failed route lookup is asked again
// after a while; a route (or its absence) is kept for the session.
export const TRACK_CACHE_MS = 90_000;
export const ROUTE_RETRY_MS = 2 * 60_000;

// Great-circle distance in kilometres.
export function distanceKm(a, b) {
  const cos = Math.sin(a.lat * RAD) * Math.sin(b.lat * RAD) + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((a.lng - b.lng) * RAD);
  return Math.acos(Math.min(1, Math.max(-1, cos))) * EARTH_RADIUS_KM;
}

// Initial bearing from a to b, in radians.
function bearing(a, b) {
  const dLng = (b.lng - a.lng) * RAD;
  return Math.atan2(Math.sin(dLng) * Math.cos(b.lat * RAD), Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos(dLng));
}

// How far a point is from the great-circle segment between a and b, in kilometres: across the
// line where the point is alongside the segment, else to the nearer end.
export function distanceToSegmentKm(p, a, b) {
  const ap = distanceKm(a, p) / EARTH_RADIUS_KM;
  const across = Math.asin(Math.min(1, Math.max(-1, Math.sin(ap) * Math.sin(bearing(a, p) - bearing(a, b)))));
  const along = Math.acos(Math.min(1, Math.max(-1, Math.cos(ap) / Math.cos(across))));
  const alongward = Math.cos(bearing(a, p) - bearing(a, b)) >= 0;
  if (!alongward || along * EARTH_RADIUS_KM > distanceKm(a, b)) return Math.min(distanceKm(p, a), distanceKm(p, b));
  return Math.abs(across) * EARTH_RADIUS_KM;
}

// `steps` + 1 points along the great circle from a to b, as { lat, lng, f } with f going from 0 to 1.
export function greatCircle(a, b, steps) {
  const d = distanceKm(a, b) / EARTH_RADIUS_KM;
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    if (d < 1e-9) {
      out.push({ lat: a.lat, lng: a.lng, f });
      continue;
    }
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(a.lat * RAD) * Math.cos(a.lng * RAD) + B * Math.cos(b.lat * RAD) * Math.cos(b.lng * RAD);
    const y = A * Math.cos(a.lat * RAD) * Math.sin(a.lng * RAD) + B * Math.cos(b.lat * RAD) * Math.sin(b.lng * RAD);
    const z = A * Math.sin(a.lat * RAD) + B * Math.sin(b.lat * RAD);
    out.push({ lat: Math.atan2(z, Math.hypot(x, y)) / RAD, lng: Math.atan2(y, x) / RAD, f });
  }
  return out;
}

// The API's answer to /track ({ points: [[time in seconds, lat, lon, altitude in feet or null,
// 1 on the ground], ...] }) as points the page uses, oldest first; none for anything unusable.
export function trackFromApi(body) {
  const points = (Array.isArray(body?.points) ? body.points : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]))
    .map(([t, lat, lng, altitudeFt, onGround]) => ({ t, lat, lng, altitudeFt: Number.isFinite(altitudeFt) ? altitudeFt : null, onGround: !!onGround }));
  return points.sort((a, b) => a.t - b.t);
}

// The line's points: the track, then the positions seen since (those at or before the track's end
// are already in it).
export function joinPath(track, trail) {
  const end = track.at(-1)?.t ?? -Infinity;
  return [...track, ...trail.filter((p) => p.t > end)];
}

// The airport an aircraft took off from, judging by the first point of its track: on the ground or
// low, and near an airport of the list (the nearest one), else null.
export function departureAirport(first, airports) {
  if (!first || !(first.onGround || (first.altitudeFt != null && first.altitudeFt < DEPARTURE_MAX_FT))) return null;
  const dLat = DEPARTURE_MAX_KM / 111;
  let best = null;
  let bestKm = DEPARTURE_MAX_KM;
  for (const airport of airports) {
    if (Math.abs(airport.lat - first.lat) > dLat) continue;
    const km = distanceKm(first, airport);
    if (km <= bestKm) {
      best = airport;
      bestKm = km;
    }
  }
  return best;
}

// What an airport is called on the map and in the panel: its IATA code, else its ICAO one. (An
// airport of the list has `iata` and `ident`; one of a route has `code` already.)
export const airportCode = (airport) => airport.code || airport.iata || airport.ident || airport.icao;

// Where to ask for a callsign's route, or null for a callsign that cannot have one.
export function routeUrl(callsign) {
  const name = String(callsign ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{3,8}$/.test(name) ? `${ROUTES_URL}/${name.slice(0, 2)}/${name}.json` : null;
}

// A route file ({ airport_codes: "EGKK-EDDB", _airports: [{ name, icao, iata, lat, lon }, ...] }) as
// its airports in order, { code, name, lat, lng }, or null if it has fewer than two or one is missing.
export function parseRoute(data) {
  const codes = String(data?.airport_codes ?? '').split('-').filter(Boolean);
  const listed = Array.isArray(data?._airports) ? data._airports : [];
  const airports = codes.map((icao) => listed.find((a) => a?.icao === icao));
  if (airports.length < 2 || airports.some((a) => !a || !Number.isFinite(a.lat) || !Number.isFinite(a.lon))) return null;
  return airports.map((a) => ({ code: a.iata || a.icao, name: a.name ?? '', lat: a.lat, lng: a.lon }));
}

// Whether a route fits the aircraft, and which leg of it: { from, to } or null. For each leg (a
// route with stops has several) the aircraft must be near the line between its airports, the
// track (if there is one) must begin near its first airport, and the aircraft must be nearer its
// last airport than the track's start was. Of several legs that fit the nearest to the aircraft
// is taken. A route that does not fit is no use: it is never guessed at.
export function acceptRoute(airports, { position, trackStart = null }) {
  let best = null;
  for (let i = 0; i + 1 < (airports?.length ?? 0); i++) {
    const [from, to] = [airports[i], airports[i + 1]];
    const length = distanceKm(from, to);
    if (length < 1) continue;
    if (trackStart && distanceKm(trackStart, from) > ROUTE_START_KM) continue;
    const off = distanceToSegmentKm(position, from, to);
    if (off > Math.max(ROUTE_OFF_LINE_NM * KM_PER_NM, ROUTE_OFF_LINE_SHARE * length)) continue;
    if (trackStart && distanceKm(position, to) >= distanceKm(trackStart, to)) continue;
    if (!best || off < best.off) best = { from, to, off };
  }
  return best && { from: best.from, to: best.to };
}

const caches = { tracks: new Map(), routes: new Map() };

// The track of an aircraft's current flight from the Power Globe API: a list of points, empty if
// it has none or cannot be had. Kept for TRACK_CACHE_MS, whatever the answer.
export function loadTrack(id, { fetchFn = fetch, now = Date.now, proxy = PROXY_URL } = {}) {
  const hit = caches.tracks.get(id);
  if (hit && now() - hit.at < TRACK_CACHE_MS) return hit.promise;
  const promise = (async () => {
    if (!proxy) return [];
    try {
      const res = await fetchFn(`${proxy}/track?icao24=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok ? trackFromApi(await res.json()) : [];
    } catch {
      return [];
    }
  })();
  caches.tracks.set(id, { at: now(), promise });
  return promise;
}

// The airports of a callsign's route, or null if the database has none. A route (or its absence)
// is kept for the session; a lookup that failed is asked again after ROUTE_RETRY_MS.
export function loadRoute(callsign, { fetchFn = fetch, now = Date.now } = {}) {
  const url = routeUrl(callsign);
  if (!url) return Promise.resolve(null);
  const hit = caches.routes.get(url);
  if (hit && (hit.failedAt === null || now() - hit.failedAt < ROUTE_RETRY_MS)) return hit.promise;
  const entry = { promise: null, failedAt: null };
  entry.promise = (async () => {
    try {
      const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`answered ${res.status}`);
      return parseRoute(await res.json());
    } catch {
      entry.failedAt = now();
      return null;
    }
  })();
  caches.routes.set(url, entry);
  return entry.promise;
}

export const clearFlightCaches = () => {
  caches.tracks.clear();
  caches.routes.clear();
};
