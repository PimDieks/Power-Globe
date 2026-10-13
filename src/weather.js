import { VARIABLES } from './layers.js';

const API_URL = 'https://api.open-meteo.com/v1/forecast';
// Open-Meteo accepts many coordinates per request; keep URLs and responses a sensible size.
const CHUNK_SIZE = 100;
// Requests in flight at once.
const CONCURRENCY = 3;
// Give up on a request after this long rather than leaving the page loading forever.
const TIMEOUT_MS = 30_000;
const CACHE_KEY = 'power-globe:forecast:v2';
const CACHE_TTL_MS = 60 * 60 * 1000;

export const FORECAST_DAYS = 5;
// The global timeline uses 3-hour steps to keep the download and cache small.
export const STEP_HOURS = 3;
// 12° spacing gives 390 locations: under the free API's 600 locations per minute, while the
// bicubic field and wind particles keep the result smooth.
export const GRID_STEP = 12;

// Evenly spaced sample points covering the globe up to ±80°, `step` degrees apart.
export function buildGrid(step = GRID_STEP) {
  return shapePoints(gridShape(step));
}

// Grid layout used throughout: `rows` x `cols` points `step` degrees apart, starting at
// (lat0, lng0), ordered row by row from south to north and west to east within a row.
// A global grid wraps around in longitude; a regional one does not.
export function gridShape(step = GRID_STEP) {
  const edge = Math.floor(80 / step) * step;
  return { step, lat0: -edge, lng0: -180, rows: (2 * edge) / step + 1, cols: Math.ceil(360 / step), wrap: true };
}

const normalizeLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;

export function shapePoints({ step, lat0, lng0, rows, cols }) {
  const points = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Rounded so that floating-point noise does not leak into URLs or labels.
      points.push({ lat: +(lat0 + r * step).toFixed(3), lng: +normalizeLng(lng0 + c * step).toFixed(3) });
    }
  }
  return points;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// `threeHourly` asks Open-Meteo to aggregate to 3-hour steps, cutting the download ~3x.
export function buildUrl(points, { threeHourly = false } = {}) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lng).join(','),
    hourly: VARIABLES.join(','),
    forecast_days: String(FORECAST_DAYS),
    timezone: 'GMT',
  });
  if (threeHourly) params.set('temporal_resolution', 'hourly_3');
  return `${API_URL}?${params}`;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function fetchJson(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new ApiError(err.name === 'TimeoutError' ? 'Open-Meteo did not respond in time' : 'Could not reach Open-Meteo');
  }
  if (!res.ok) {
    // Open-Meteo explains errors as { error: true, reason: "..." }.
    const reason = await res.json().then((body) => body.reason, () => null);
    throw new ApiError(`Open-Meteo: ${reason ?? res.statusText ?? 'request failed'} (${res.status})`, res.status);
  }
  return res.json();
}

// Run `fn` over `items` with at most `limit` calls in flight, keeping result order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Hourly forecasts for a list of points, in the same order. The API returns an array for
// multiple coordinates and a single object for one. `onProgress(done, total)` reports chunks.
export async function fetchHourly(points, { threeHourly = false, onProgress } = {}) {
  const parts = chunk(points, CHUNK_SIZE);
  let done = 0;
  const responses = await mapLimit(parts, CONCURRENCY, async (part) => {
    let data;
    try {
      data = await fetchJson(buildUrl(part, { threeHourly }));
    } catch (err) {
      // Fall back to plain hourly data if the API rejects the aggregation option.
      if (!threeHourly || err.status !== 400) throw err;
      data = await fetchJson(buildUrl(part));
    }
    onProgress?.(++done, parts.length);
    return (Array.isArray(data) ? data : [data]).map((item) => item.hourly);
  });
  return responses.flat();
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// Indices of the times falling on a multiple of `stepHours` (00:00, 03:00, ... GMT), or all
// of them when the API already aggregated the series to that step.
function stepIndices(times, stepHours) {
  const gapHours = times.length > 1 ? (parseTime(times[1]) - parseTime(times[0])) / 3_600_000 : 1;
  if (gapHours >= stepHours) return times.map((_, i) => i);
  return times.flatMap((t, i) => (Number(t.slice(11, 13)) % stepHours === 0 ? [i] : []));
}

// Reshape per-location series into values[variable][timeIndex][pointIndex] at `stepHours`.
export function toForecast(points, hourly, stepHours = STEP_HOURS) {
  const keep = hourly.map((h) => stepIndices(h.time, stepHours));
  const times = keep[0].map((i) => hourly[0].time[i]);
  const values = {};
  for (const v of VARIABLES) {
    values[v] = times.map((_, k) => hourly.map((h, p) => round1(h[v]?.[keep[p][k]])));
  }
  return { times, points, values };
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
export async function loadForecast({ step = GRID_STEP, force = false, onProgress } = {}) {
  const key = `${CACHE_KEY}:${step}`;
  if (!force) {
    const cached = readCache(key);
    if (cached) return cached;
  }
  const points = buildGrid(step);
  const data = toForecast(points, await fetchHourly(points, { threeHourly: true, onProgress }));
  writeCache(key, data);
  return data;
}

// Finer forecast for one region of the globe, for when the view is zoomed in. Kept in
// memory only, as regions change with every pan.
const regionCache = new Map();
const REGION_CACHE_SIZE = 8;

export const isRegionCached = (shape) => regionCache.has(JSON.stringify(shape));

export async function loadRegion(shape) {
  const key = JSON.stringify(shape);
  if (!regionCache.has(key)) {
    const points = shapePoints(shape);
    const request = fetchHourly(points, { threeHourly: true }).then((hourly) => ({
      ...toForecast(points, hourly),
      shape,
    }));
    regionCache.set(key, request);
    request.catch(() => regionCache.delete(key));
    if (regionCache.size > REGION_CACHE_SIZE) regionCache.delete(regionCache.keys().next().value);
  }
  return regionCache.get(key);
}

// Full hourly forecast for one location: { time: [...], temperature_2m: [...], ... }.
export async function loadPointForecast(lat, lng) {
  const [hourly] = await fetchHourly([{ lat: +lat.toFixed(2), lng: +lng.toFixed(2) }]);
  return hourly;
}
