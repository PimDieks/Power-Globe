// Airports and their runways (from OurAirports, see scripts/build-airports.mjs), airport search,
// and hourly ground conditions at airports from Open-Meteo.
import { fetchAirportHourly } from './weather.js';

// Case- and accent-insensitive form for matching, so "sao" finds "São Paulo".
export const fold = (text) =>
  String(text)
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

// One airport from a row of airports.json (see its "fields" and "runwayFields").
export function toAirport([ident, iata, name, city, country, lat, lng, elevationFt, large, scheduled, runways]) {
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
    runways: runways.map(([le, leHeading, he, heHeading, lengthFt, surface]) => ({
      le,
      leHeading,
      he,
      heHeading,
      lengthFt,
      surface,
    })),
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
// Larger airports win ties.
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
    .sort(([sa, a], [sb, b]) => sa - sb || Number(b.large) - Number(a.large) || Number(b.scheduled) - Number(a.scheduled) || a.ident.localeCompare(b.ident))
    .slice(0, limit)
    .map(([, a]) => a);
}

// Airports covered by the wind check: large airports with scheduled flights.
export const majorAirports = (airports) => airports.filter((a) => a.large && a.scheduled);

// Conditions at an airport at a GMT time ("2026-10-13T15:00"), or null if outside the data.
export function conditionsAt(hourly, time) {
  const i = hourly?.time?.indexOf(time) ?? -1;
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

// Hourly ground conditions for `airports`, fetching only those not cached. `onData(map)` is
// called as each batch arrives, so a long list can fill in progressively.
export async function airportWeather(airports, { onData, onProgress, onWait } = {}) {
  const now = Date.now();
  const result = new Map();
  const missing = [];
  for (const a of airports) {
    const cached = weatherCache.get(a.ident);
    if (cached && now - cached.at < CACHE_MS) result.set(a.ident, cached.hourly);
    else missing.push(a);
  }
  if (result.size) onData?.(result);
  if (missing.length) {
    await fetchAirportHourly(missing, {
      onProgress,
      onWait,
      onBatch: (batch, hourly) => {
        batch.forEach((a, i) => {
          weatherCache.set(a.ident, { at: Date.now(), hourly: hourly[i] });
          result.set(a.ident, hourly[i]);
        });
        onData?.(result);
      },
    });
  }
  return result;
}
