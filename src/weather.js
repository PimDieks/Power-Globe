import { VARIABLES } from './layers.js';

const API_URL = 'https://api.open-meteo.com/v1/forecast';
// Open-Meteo accepts many coordinates per request; keep URLs a sensible length.
const CHUNK_SIZE = 100;
const CACHE_KEY = 'power-globe:forecast:v1';
const CACHE_TTL_MS = 60 * 60 * 1000;

export const FORECAST_DAYS = 5;
// The global timeline keeps every 3rd hour to keep the download and cache small.
export const STEP_HOURS = 3;

// Evenly spaced sample points covering the globe, `step` degrees apart, ordered row by row
// from south to north and west to east within a row.
export function buildGrid(step = 10) {
  const points = [];
  for (let lat = -80; lat <= 80; lat += step) {
    for (let lng = -180; lng < 180; lng += step) {
      points.push({ lat, lng });
    }
  }
  return points;
}

// Dimensions of buildGrid(step), for code that needs to index it as a 2D grid.
export function gridShape(step = 10) {
  return { step, lat0: -80, rows: Math.floor(160 / step) + 1, cols: Math.ceil(360 / step) };
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function buildUrl(points) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lng).join(','),
    hourly: VARIABLES.join(','),
    forecast_days: String(FORECAST_DAYS),
    timezone: 'GMT',
  });
  return `${API_URL}?${params}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo request failed (${res.status})`);
  return res.json();
}

// Hourly forecasts for a list of points, in the same order. The API returns an array for
// multiple coordinates and a single object for one.
export async function fetchHourly(points) {
  const results = [];
  for (const part of chunk(points, CHUNK_SIZE)) {
    const data = await fetchJson(buildUrl(part));
    results.push(...(Array.isArray(data) ? data : [data]).map((item) => item.hourly));
  }
  return results;
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// Keep every `stepHours`-th hour and reshape into values[variable][timeIndex][pointIndex].
export function toForecast(points, hourly, stepHours = STEP_HOURS) {
  const keep = hourly[0].time.map((_, i) => i).filter((i) => i % stepHours === 0);
  const values = {};
  for (const v of VARIABLES) {
    values[v] = keep.map((t) => hourly.map((h) => round1(h[v]?.[t])));
  }
  return { times: keep.map((t) => hourly[0].time[t]), points, values };
}

// Open-Meteo times are GMT ISO strings without a zone suffix.
export const parseTime = (time) => Date.parse(`${time}Z`);

// Index of the last forecast time at or before `now`, so the timeline opens on the present.
export function startIndex(times, now = Date.now()) {
  let index = 0;
  times.forEach((t, i) => {
    if (parseTime(t) <= now) index = i;
  });
  return index;
}

function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { savedAt, data } = JSON.parse(raw);
    return Date.now() - savedAt < CACHE_TTL_MS ? data : null;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // Storage unavailable or full; caching is only a convenience.
  }
}

// Global forecast grid, cached locally to stay within the free API's limits.
export async function loadForecast({ step = 10, force = false } = {}) {
  const key = `${CACHE_KEY}:${step}`;
  if (!force) {
    const cached = readCache(key);
    if (cached) return cached;
  }
  const points = buildGrid(step);
  const data = toForecast(points, await fetchHourly(points));
  writeCache(key, data);
  return data;
}

// Full hourly forecast for one location: { time: [...], temperature_2m: [...], ... }.
export async function loadPointForecast(lat, lng) {
  const [hourly] = await fetchHourly([{ lat: +lat.toFixed(2), lng: +lng.toFixed(2) }]);
  return hourly;
}
