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
// ... and if it starts in the air, climbs at least this much afterwards.
export const DEPARTURE_CLIMB_FT = 500;
// A track belongs to the aircraft's flight now if it ends no longer than this before its latest
// report, and within the larger of this many kilometres and what its speed covers in that time.
export const TRACK_MAX_GAP_S = 600;
export const TRACK_MIN_REACH_KM = 50;
// Without a track, the aircraft must be heading within this many degrees of its destination.
export const ROUTE_HEADING_DEG = 60;
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

// Points with no altitude that are not on the ground take the last altitude known before them, so
// that a missing one does not draw as a drop to the ground. (A point on the ground forgets it.)
export function carryAltitudes(points) {
  let last = null;
  return points.map((p) => {
    if (p.altitudeFt != null) last = p.altitudeFt;
    else if (p.onGround) last = null;
    else if (last != null) return { ...p, altitudeFt: last };
    return p;
  });
}

// The API's answer to /track ({ callsign, endTime, points: [[time in seconds, lat, lon, altitude
// in feet or null, 1 on the ground], ...] }) as { points, endTime, callsign } with the points the
// page uses, oldest first; no points for anything unusable.
export function trackFromApi(body) {
  const points = (Array.isArray(body?.points) ? body.points : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]))
    .map(([t, lat, lng, altitudeFt, onGround]) => ({ t, lat, lng, altitudeFt: Number.isFinite(altitudeFt) ? altitudeFt : null, onGround: !!onGround }))
    .sort((a, b) => a.t - b.t);
  return { points: carryAltitudes(points), endTime: Number.isFinite(body?.endTime) ? body.endTime : null, callsign: String(body?.callsign ?? '').trim() };
}

export const NO_TRACK = Object.freeze({ points: [], endTime: null, callsign: '' });
const sameCallsign = (a, b) => a.trim().toUpperCase() === b.trim().toUpperCase();

// Whether a track is the track of this aircraft's flight now (`ac` is its latest report): it
// is not if it is for another callsign, if it ended more than TRACK_MAX_GAP_S before the report (the
// flight before this one, say), or if it ends further from the aircraft than it could have flown
// since (the larger of 50 km and what its speed covers in the time between).
export function trackFits(track, ac) {
  const last = track?.points?.at(-1);
  if (!last) return false;
  if (track.callsign && ac.callsign && !sameCallsign(track.callsign, ac.callsign)) return false;
  const gap = Math.max(0, ac.seen / 1000 - last.t);
  if (gap > TRACK_MAX_GAP_S) return false;
  return distanceKm(last, ac) <= Math.max(TRACK_MIN_REACH_KM, ((ac.speedKt ?? 0) * KM_PER_NM * gap) / 3600);
}

// The line's points: the track, then the positions seen since (those at or before the track's end
// are already in it).
export function joinPath(track, trail) {
  const end = track.at(-1)?.t ?? -Infinity;
  return [...track, ...trail.filter((p) => p.t > end)];
}

// Whether a track's first point could be at an airport: on the ground or low.
export const lowStart = (first) => Boolean(first && (first.onGround || (first.altitudeFt != null && first.altitudeFt < DEPARTURE_MAX_FT)));

// The airport an aircraft took off from, judging by its track: it starts low and near an airport of
// the list, else null. A track that starts in the air must climb after that, or it began on the way
// down and the airport is where it lands. Of several airports in reach a large one, or one with
// scheduled flights, comes before a small field, then the nearest.
export function departureAirport(track, airports) {
  const first = track?.[0];
  if (!lowStart(first)) return null;
  if (!first.onGround && !track.some((p) => p.altitudeFt != null && p.altitudeFt >= first.altitudeFt + DEPARTURE_CLIMB_FT)) return null;
  const dLat = DEPARTURE_MAX_KM / 111;
  let best = null;
  let bestRank = Infinity;
  let bestKm = Infinity;
  for (const airport of airports) {
    if (Math.abs(airport.lat - first.lat) > dLat) continue;
    const km = distanceKm(first, airport);
    if (km > DEPARTURE_MAX_KM) continue;
    const rank = airport.large || airport.scheduled ? 0 : 1;
    if (rank < bestRank || (rank === bestRank && km < bestKm)) {
      best = airport;
      bestRank = rank;
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
  return airports.map((a) => ({ code: a.iata || a.icao, icao: a.icao, name: a.name ?? '', lat: a.lat, lng: a.lon }));
}

// The angle in degrees, 0 to 180, between two compass directions.
const angleBetween = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

// Whether a route fits the aircraft, and which leg of it: { from, to } or null. For each leg (a
// route with stops has several) the aircraft must be near the line between its airports, the
// track (if there is one) must begin near its first airport, and the aircraft must be nearer its
// last airport than the track's start was. Without a track nothing says which way the flight
// began, so a flying aircraft (`heading`, its track over the ground in degrees, if known) must be
// heading toward the last airport, which a route flown the other way is not. Of several legs that
// fit the nearest to the aircraft is taken. A route that does not fit is no use: it is never
// guessed at.
export function acceptRoute(airports, { position, trackStart = null, heading = null }) {
  let best = null;
  for (let i = 0; i + 1 < (airports?.length ?? 0); i++) {
    const [from, to] = [airports[i], airports[i + 1]];
    const length = distanceKm(from, to);
    if (length < 1) continue;
    if (trackStart && distanceKm(trackStart, from) > ROUTE_START_KM) continue;
    const off = distanceToSegmentKm(position, from, to);
    if (off > Math.max(ROUTE_OFF_LINE_NM * KM_PER_NM, ROUTE_OFF_LINE_SHARE * length)) continue;
    if (trackStart && distanceKm(position, to) >= distanceKm(trackStart, to)) continue;
    if (!trackStart && heading != null && angleBetween(heading, (bearing(position, to) * 180) / Math.PI) > ROUTE_HEADING_DEG) continue;
    if (!best || off < best.off) best = { from, to, off };
  }
  return best && { from: best.from, to: best.to };
}

const caches = { tracks: new Map(), routes: new Map() };

// The track of an aircraft's current flight from the Power Globe API, { points, endTime, callsign },
// with no points if it has none or cannot be had. Kept for TRACK_CACHE_MS, whatever the answer
// (`fresh` asks again, for an aircraft that has just taken off again), and none is asked for
// an address that OpenSky has no tracks for (it is not a 24-bit ICAO address).
export function loadTrack(id, { fetchFn = fetch, now = Date.now, proxy = PROXY_URL, fresh = false } = {}) {
  for (const [key, entry] of caches.tracks) if (now() - entry.at >= TRACK_CACHE_MS) caches.tracks.delete(key);
  const hit = caches.tracks.get(id);
  if (hit && !fresh) return hit.promise;
  const promise = (async () => {
    if (!proxy || !/^[0-9a-f]{6}$/.test(id)) return NO_TRACK;
    try {
      const res = await fetchFn(`${proxy}/track?icao24=${id}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      return res.ok ? trackFromApi(await res.json()) : NO_TRACK;
    } catch {
      return NO_TRACK;
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
  const entry = { promise: null, failedAt: null, value: undefined };
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
  entry.promise.then((route) => {
    entry.value = route;
  });
  caches.routes.set(url, entry);
  return entry.promise;
}

// The route of a callsign if it has already been looked up (and found), else null. Asks nothing: for
// the aircraft whose route is known anyway.
export function knownRoute(callsign) {
  const url = routeUrl(callsign);
  return (url && caches.routes.get(url)?.value) || null;
}

export const clearFlightCaches = () => {
  caches.tracks.clear();
  caches.routes.clear();
};
