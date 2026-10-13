// Airports and their runways (from OurAirports, see scripts/build-airports.mjs), airport search,
// and hourly ground conditions at airports from Open-Meteo.
import { AIRPORT_VARIABLES, fetchAirportHourly, openMeteoOpen, parseTime } from './weather.js';
import { SNAPSHOT_FRESH_MS, fetchSnapshot, withTimeout } from './api.js';

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
// Series every few hours (the site's own data) give the latest entry up to three hours before.
export function conditionsAt(hourly, time) {
  const times = hourly?.time;
  if (!times) return null;
  let i = times.indexOf(time);
  if (i < 0) {
    const t = Date.parse(`${time}Z`);
    for (let k = times.length - 1; k >= 0; k--) {
      const tk = Date.parse(`${times[k]}Z`);
      if (tk <= t) {
        if (t - tk < 3 * 3_600_000 && k < times.length - 1) i = k;
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

// The site's own airport weather (major airports, every three hours, see build-data.mjs):
// { built, end, get(ident) → series like Open-Meteo's hourly }, or null.
export function snapshotSeries(snapshot) {
  if (!snapshot?.times?.length || !snapshot.airports) return null;
  const variables = snapshot.variables ?? AIRPORT_VARIABLES;
  return {
    built: Date.parse(snapshot.built),
    end: parseTime(snapshot.times.at(-1)),
    get(ident) {
      const rows = snapshot.airports[ident];
      if (!rows) return null;
      return Object.fromEntries([['time', snapshot.times], ...variables.map((v, i) => [v, rows[i]])]);
    },
  };
}

let snapshotPromise = null;
// Only a copy that was found is kept: a failed fetch is tried again the next time.
function airportSnapshot() {
  snapshotPromise ??= fetchSnapshot('api/airport-weather.json')
    .then(snapshotSeries)
    .then((snapshot) => {
      if (!snapshot) snapshotPromise = null;
      return snapshot;
    });
  return snapshotPromise;
}

// Fills `result` from the site's own data, if it is no older than `maxAge` and still reaches the
// present; resolves to the airports in `list` it did not have.
async function fromSnapshot(list, result, maxAge, now = Date.now()) {
  const snapshot = await airportSnapshot();
  if (!snapshot || now - snapshot.built > maxAge || snapshot.end < now) return list;
  return list.filter((a) => {
    const series = snapshot.get(a.ident);
    if (series) result.set(a.ident, series);
    return !series;
  });
}

// Hourly ground conditions for `airports`, fetching only those not cached: from the site's own
// data while it is recent, else Open-Meteo (through the Power Globe API when Open-Meteo refuses),
// else the site's data however old. When Open-Meteo cannot be asked at all, a list takes the
// site's data however old first and sends only the airports it lacks to the Power Globe API.
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
  if (missing.length && !preferLive) {
    missing = await fromSnapshot(missing, result, SNAPSHOT_FRESH_MS, now);
    if (missing.length && !openMeteoOpen(missing.length)) missing = await fromSnapshot(missing, result, Infinity, now);
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
    await fromSnapshot(missing.filter((a) => !result.has(a.ident)), result, Infinity, now);
    if (result.size === before) throw err;
    onData?.(result);
  }
  return result;
}

// The forecast for the one airport someone is looking at, never leaving them waiting. Every
// Open-Meteo request shares one queue, so this one can sit behind slower ones, and one request can
// take a while to be refused and passed on. After `timeoutMs` the site's own data, however old,
// answers instead (once), while the request carries on; its answer, if it comes in the end, goes
// to `onLate(hourly)`. Throws with the reason when there is nothing to show.
export async function airportPanelWeather(airport, { timeoutMs, onLate } = {}) {
  const request = airportWeather([airport], { preferLive: true }).then((weather) => weather.get(airport.ident));
  let hourly;
  try {
    hourly = await withTimeout(request, timeoutMs, 'no answer in time');
  } catch (err) {
    if (err.name !== 'TimeoutError') throw err;
    let late;
    let returned = false;
    request.then(
      (answer) => {
        late = answer;
        if (returned && answer) onLate?.(answer);
      },
      () => {},
    );
    const copy = new Map();
    await fromSnapshot([airport], copy, Infinity);
    returned = true;
    hourly = late ?? copy.get(airport.ident);
    if (!hourly) throw err;
  }
  if (!hourly) throw new Error('no forecast for this airport');
  return hourly;
}
