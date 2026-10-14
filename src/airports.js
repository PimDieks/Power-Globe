// Airports and their runways (from OurAirports, see scripts/build-airports.mjs), airport search,
// and hourly ground conditions at airports from Open-Meteo.
import { AIRPORT_VARIABLES, fetchAirportHourly, openMeteoOpen, parseTime } from './weather.js';
import { LARGE_SNAPSHOT_TIMEOUT_MS, SNAPSHOT_FRESH_MS, SNAPSHOT_TIMEOUT_MS, fetchSnapshot, withTimeout } from './api.js';

// Case- and accent-insensitive form for matching, so "sao" finds "São Paulo".
export const fold = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

// One airport from a row of airports.json (see its "fields" and "runwayFields").
export function toAirport([ident, iata, name, city, country, lat, lng, elevationFt, large, scheduled, runways, routes = 0]) {
  return {
    ident,
    iata,
    name,
    city,
    country,
    lat,
    lng,
    elevationFt,
    large: large === 1,
    scheduled: scheduled === 1,
    runways: runways.map(([le, leHeading, he, heHeading, lengthFt, surface, widthFt = 0, leLat = null, leLng = null, heLat = null, heLng = null]) => ({
      le,
      leHeading,
      he,
      heHeading,
      lengthFt,
      surface,
      widthFt,
      // Threshold positions, or null where OurAirports has none.
      leEnd: leLat == null ? null : { lat: leLat, lng: leLng },
      heEnd: heLat == null ? null : { lat: heLat, lng: heLng },
    })),
    // Airports it has scheduled routes to: a measure of how busy it is.
    routes,
    words: fold(`${name} ${city}`).split(/[^a-z0-9]+/).filter(Boolean),
  };
}

let airportsPromise = null;

// All airports, loaded once on first use (about 240 KB compressed).
export function loadAirports() {
  airportsPromise ??= fetch(`${import.meta.env?.BASE_URL ?? '/'}data/airports.json`)
    .then((res) => {
      if (!res.ok) throw new Error(`Could not load the airport list (${res.status})`);
      return res.json();
    })
    .then((data) => data.airports.map(toAirport))
    .catch((err) => {
      airportsPromise = null;
      throw err;
    });
  return airportsPromise;
}

// Airports matching a code, name or city, best match first: exact ICAO or IATA code, then codes
// starting with the query, then names or cities with a word starting with it, then anywhere.
// Larger and better connected airports win ties.
export function searchAirports(airports, query, limit = 8) {
  const q = fold(query);
  if (q.length < 2) return [];
  const code = q.toUpperCase();
  const scored = [];
  for (const a of airports) {
    let score;
    if (a.ident === code || a.iata === code) score = 0;
    else if (a.ident.startsWith(code) || (a.iata && a.iata.startsWith(code))) score = 1;
    else if (a.words.some((w) => w.startsWith(q)) || fold(`${a.name} ${a.city}`).startsWith(q)) score = 2;
    else if (fold(`${a.name} ${a.city}`).includes(q)) score = 3;
    else continue;
    scored.push([score, a]);
  }
  return scored
    .sort(([sa, a], [sb, b]) => sa - sb || Number(b.large) - Number(a.large) || b.routes - a.routes || a.ident.localeCompare(b.ident))
    .slice(0, limit)
    .map(([, a]) => a);
}

// Airports covered by the wind check: large airports with scheduled flights.
export const majorAirports = (airports) => airports.filter((a) => a.large && a.scheduled);

// Conditions at an airport at a GMT time ("2026-10-13T15:00"), or null if outside the data.
// Series every few hours (older copies of the site's own data) give the latest entry for up to three
// hours after it; the last entry of such a series holds for as long as one step of it, so a series
// ending at 21:00 still answers until 23:00 and no later, and an hourly one for the hour after its last.
export function conditionsAt(hourly, time) {
  const times = hourly?.time;
  if (!times) return null;
  let i = times.indexOf(time);
  if (i < 0) {
    const t = Date.parse(`${time}Z`);
    const step = times.length > 1 ? Date.parse(`${times.at(-1)}Z`) - Date.parse(`${times.at(-2)}Z`) : 0;
    for (let k = times.length - 1; k >= 0; k--) {
      const tk = Date.parse(`${times[k]}Z`);
      if (tk <= t) {
        if (t - tk < Math.min(3 * 3_600_000, k < times.length - 1 ? Infinity : step)) i = k;
        break;
      }
    }
  }
  if (i < 0) return null;
  return {
    time,
    temperature: hourly.temperature_2m?.[i] ?? null,
    dewPoint: hourly.dew_point_2m?.[i] ?? null,
    speed: hourly.wind_speed_10m?.[i] ?? null,
    direction: hourly.wind_direction_10m?.[i] ?? null,
    gust: hourly.wind_gusts_10m?.[i] ?? null,
  };
}

// Hourly conditions per airport ident, kept for an hour like the global forecast.
const CACHE_MS = 60 * 60 * 1000;
const weatherCache = new Map();

// The site's own airport weather (major airports, every hour, see build-data.mjs; copies built
// earlier have a step every three hours):
// { built, end, get(ident) → series like Open-Meteo's hourly }, or null. A series says when the
// copy was built (`builtAt`, in ms), so that what is shown can say how old it is.
export function snapshotSeries(snapshot) {
  if (!snapshot?.times?.length || !snapshot.airports) return null;
  const variables = snapshot.variables ?? AIRPORT_VARIABLES;
  const built = Date.parse(snapshot.built);
  return {
    built,
    end: parseTime(snapshot.times.at(-1)),
    get(ident) {
      const rows = snapshot.airports[ident];
      if (!rows) return null;
      return Object.fromEntries([['time', snapshot.times], ...variables.map((v, i) => [v, rows[i]]), ['builtAt', built]]);
    },
  };
}

// A copy that could not be had is not asked for again for this long.
const SNAPSHOT_MISS_MS = 60_000;
let snapshotPromise = null;
let snapshotMissedAt = -Infinity;
// Only a copy that was found is kept. One that was not is asked for again after a minute, not on
// every call.
function airportSnapshot() {
  if (!snapshotPromise) {
    if (Date.now() - snapshotMissedAt < SNAPSHOT_MISS_MS) return Promise.resolve(null);
    snapshotPromise = fetchSnapshot('api/airport-weather.json', LARGE_SNAPSHOT_TIMEOUT_MS)
      .then(snapshotSeries)
      .then((snapshot) => {
        if (!snapshot) {
          snapshotPromise = null;
          snapshotMissedAt = Date.now();
        }
        return snapshot;
      });
  }
  return snapshotPromise;
}

// Fills `result` from the site's own data (`snapshot`, see airportSnapshot), if it is no older than
// `maxAge` and still reaches the present; returns the airports in `list` it did not have.
function fromSnapshot(snapshot, list, result, maxAge, now = Date.now()) {
  if (!snapshot || now - snapshot.built > maxAge || snapshot.end < now) return list;
  return list.filter((a) => {
    const series = snapshot.get(a.ident);
    if (series) result.set(a.ident, series);
    return !series;
  });
}

// Hourly ground conditions for `airports`, fetching only those not cached: from the site's own
// data while it is recent, else Open-Meteo (through the Power Globe API when Open-Meteo refuses),
// else the site's data however old. When Open-Meteo cannot be asked for all of them, a list takes
// the site's data however old first and sends only the airports it lacks on.
// `preferLive` asks Open-Meteo first, and does not wait for the pacing but goes to the Power Globe
// API (for the one airport being looked at, see fetchAirportHourly). `onData(map)` is called as
// each batch arrives, so a long list can fill in progressively.
export async function airportWeather(airports, { onData, onProgress, onWait, preferLive = false } = {}) {
  const now = Date.now();
  const result = new Map();
  let missing = [];
  for (const a of airports) {
    const cached = weatherCache.get(a.ident);
    if (cached && now - cached.at < CACHE_MS) result.set(a.ident, cached.hourly);
    else missing.push(a);
  }
  // The site's copy, fetched at most once in this call.
  let copy;
  const snapshot = () => (copy ??= airportSnapshot());
  if (missing.length && !preferLive) {
    missing = fromSnapshot(await snapshot(), missing, result, SNAPSHOT_FRESH_MS, now);
    if (missing.length && !openMeteoOpen(missing.length)) missing = fromSnapshot(await snapshot(), missing, result, Infinity, now);
  }
  if (result.size) onData?.(result);
  if (!missing.length) return result;
  try {
    await fetchAirportHourly(missing, {
      onProgress,
      onWait,
      preferLive,
      onBatch: (batch, hourly) => {
        batch.forEach((a, i) => {
          weatherCache.set(a.ident, { at: Date.now(), hourly: hourly[i] });
          result.set(a.ident, hourly[i]);
        });
        onData?.(result);
      },
    });
  } catch (err) {
    const before = result.size;
    fromSnapshot(await snapshot(), missing.filter((a) => !result.has(a.ident)), result, Infinity, now);
    if (result.size === before) throw err;
    onData?.(result);
  }
  return result;
}

// The forecast for the one airport someone is looking at, never leaving them waiting. Every
// Open-Meteo request shares one queue, so this one can sit behind slower ones, and one request can
// take a while to be refused and passed on. After `timeoutMs` the site's own data, however old,
// answers instead (once), while the request carries on; its answer, if it comes in the end, goes
// to `onLate(hourly)`, or answers in place of the site's data if it comes while that is being
// fetched, which is itself given up on after SNAPSHOT_TIMEOUT_MS. Throws with the reason when there
// is nothing to show.
export async function airportPanelWeather(airport, { timeoutMs, onLate } = {}) {
  const request = airportWeather([airport], { preferLive: true }).then((weather) => weather.get(airport.ident));
  let hourly;
  try {
    hourly = await withTimeout(request, timeoutMs, 'no answer in time');
  } catch (err) {
    if (err.name !== 'TimeoutError') throw err;
    let late;
    let returned = false;
    let arrived;
    const lateAnswer = new Promise((resolve) => (arrived = resolve));
    request.then(
      (answer) => {
        if (!answer) return;
        late = answer;
        arrived();
        if (returned) onLate?.(answer);
      },
      () => {},
    );
    const copy = new Map();
    const fromCopy = withTimeout(
      airportSnapshot().then((snapshot) => fromSnapshot(snapshot, [airport], copy, Infinity)),
      SNAPSHOT_TIMEOUT_MS,
      'no copy in time',
    ).catch(() => {});
    await Promise.race([fromCopy, lateAnswer]);
    returned = true;
    hourly = late ?? copy.get(airport.ident);
    if (!hourly) throw err;
  }
  if (!hourly) throw new Error('no forecast for this airport');
  return hourly;
}
