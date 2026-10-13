import { VARIABLES } from './layers.js';
import { PROXY_URL, SNAPSHOT_FRESH_MS, fetchSnapshot } from './api.js';

const API_URL = 'https://api.open-meteo.com/v1/forecast';
// Open-Meteo accepts many coordinates per request; keep URLs and responses a sensible size.
const CHUNK_SIZE = 100;
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

// Open-Meteo's free tier allows 600 locations per minute and 5,000 per hour. Requests are
// counted here so optional ones (zoomed-in detail) can hold back before hitting the limit.
const LIMITS = [
  [60_000, 600],
  [3_600_000, 5_000],
];
// After the API reports a rate limit, wait this long before asking again.
const RATE_LIMIT_PAUSE_MS = 60_000;
let spent = [];
let pausedUntil = 0;

// How long to stop asking after a usage limit: until the next day (GMT) for the daily limit, an
// hour for the hourly one, else a minute. The site's own copy of the forecast covers meanwhile.
export function limitPause(reason, now = Date.now()) {
  if (/daily/i.test(reason ?? '')) return Math.max(RATE_LIMIT_PAUSE_MS, (Math.floor(now / 86_400_000) + 1) * 86_400_000 - now);
  if (/hourly/i.test(reason ?? '')) return 3_600_000;
  return RATE_LIMIT_PAUSE_MS;
}

// Whether Open-Meteo asked us to stop for now.
export const apiPaused = (now = Date.now()) => now < pausedUntil;

// Each browser keeps to half of Open-Meteo's free 10,000 locations a day, counted across page
// loads, so one visitor never uses up the allowance (shared with others on the same network).
export const DAILY_BUDGET = 5_000;
const DAILY_KEY = 'power-globe:open-meteo-today';
const today = (now) => new Date(now).toISOString().slice(0, 10);
let daily = { day: '', used: 0 };

function usedToday(now = Date.now()) {
  if (daily.day !== today(now)) {
    try {
      const saved = JSON.parse(localStorage.getItem(DAILY_KEY));
      daily = saved?.day === today(now) ? saved : { day: today(now), used: 0 };
    } catch {
      daily = { day: today(now), used: 0 };
    }
  }
  return daily.used;
}

function spend(locations, now = Date.now()) {
  spent.push([now, locations]);
  usedToday(now);
  daily.used += locations;
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(daily));
  } catch {
    // Counting within this page still works.
  }
}

// Locations that can still be requested now without exceeding the free limits.
export function apiBudget(now = Date.now()) {
  if (now < pausedUntil) return 0;
  spent = spent.filter(([t]) => now - t < LIMITS.at(-1)[0]);
  return Math.min(
    DAILY_BUDGET - usedToday(now),
    ...LIMITS.map(([window, limit]) => limit - spent.reduce((sum, [t, n]) => (now - t < window ? sum + n : sum), 0)),
  );
}

// For tests.
export function resetApiBudget() {
  spent = [];
  pausedUntil = 0;
  daily = { day: '', used: 0 };
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Retries, with growing waits, when Open-Meteo is busy with another of our requests.
const BUSY_RETRIES = 4;
const BUSY_RETRY_MS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The same request through the Power Globe API, which caches answers for all visitors and keeps
// a backup for when Open-Meteo is unavailable.
const proxied = (url) => (PROXY_URL && url.startsWith(API_URL) ? `${PROXY_URL}/forecast?${url.split('?')[1]}` : null);

async function fetchViaProxy(url, cause) {
  const via = proxied(url);
  if (!via) throw cause;
  let res;
  try {
    res = await fetch(via, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw cause;
  }
  if (!res.ok) throw cause;
  return res.json();
}

// Ask Open-Meteo directly while this browser is within its allowance, else (or if Open-Meteo
// refuses or cannot be reached) through the Power Globe API.
async function fetchJsonNow(url) {
  // Requests are counted before they are sent, so this one is already included.
  if (apiPaused() || usedToday() > DAILY_BUDGET) {
    return fetchViaProxy(url, new ApiError('Open-Meteo usage limit reached for today', 429));
  }
  try {
    return await fetchDirect(url);
  } catch (err) {
    // Not for bad requests: those would fail through the proxy too.
    if (err.status && err.status !== 429 && err.status < 500) throw err;
    return fetchViaProxy(url, err);
  }
}

async function fetchDirect(url) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new ApiError(err.name === 'TimeoutError' ? 'Open-Meteo did not respond in time' : 'Could not reach Open-Meteo');
    }
    if (res.ok) return res.json();
    // Open-Meteo explains errors as { error: true, reason: "..." }.
    const reason = await res.json().then((body) => body.reason, () => null);
    if (res.status === 429) {
      // "Too many concurrent requests" clears as soon as the other request finishes; a usage
      // limit ("... limit exceeded") does not, so stop asking for a while.
      if (/concurrent/i.test(reason ?? '') && attempt < BUSY_RETRIES) {
        await sleep(BUSY_RETRY_MS * 2 ** attempt);
        continue;
      }
      if (!/concurrent/i.test(reason ?? '')) pausedUntil = Date.now() + limitPause(reason);
    }
    throw new ApiError(`Open-Meteo: ${reason ?? res.statusText ?? 'request failed'} (${res.status})`, res.status);
  }
}

// Open-Meteo's free tier also limits how many requests may run at once, so every request
// (the global forecast, zoomed-in detail and tapped spots) waits its turn in one queue.
let queue = Promise.resolve();
function fetchJson(url) {
  const run = queue.then(() => fetchJsonNow(url));
  queue = run.catch(() => {});
  return run;
}

// Hourly forecasts for a list of points, in the same order. The API returns an array for
// multiple coordinates and a single object for one. `onProgress(done, total)` reports chunks.
export async function fetchHourly(points, { threeHourly = false, onProgress } = {}) {
  const parts = chunk(points, CHUNK_SIZE);
  const results = [];
  for (const [i, part] of parts.entries()) {
    let data;
    spend(part.length);
    try {
      data = await fetchJson(buildUrl(part, { threeHourly }));
    } catch (err) {
      // Fall back to plain hourly data if the API rejects the aggregation option.
      if (!threeHourly || err.status !== 400) throw err;
      data = await fetchJson(buildUrl(part));
    }
    onProgress?.(i + 1, parts.length);
    results.push(...(Array.isArray(data) ? data : [data]).map((item) => item.hourly));
  }
  return results;
}

// Ground conditions at airports, as aviation weather reports them: wind in knots at 10 m (the
// height of airport anemometers), temperature and dew point at 2 m, every hour.
export const AIRPORT_VARIABLES = [
  'temperature_2m',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
];
const FEET = 0.3048;

// The airport's own elevation lets Open-Meteo correct the temperature for its height.
export function buildAirportUrl(airports) {
  const params = new URLSearchParams({
    latitude: airports.map((a) => a.lat).join(','),
    longitude: airports.map((a) => a.lng).join(','),
    elevation: airports.map((a) => Math.round(a.elevationFt * FEET)).join(','),
    hourly: AIRPORT_VARIABLES.join(','),
    wind_speed_unit: 'kn',
    forecast_days: String(FORECAST_DAYS),
    timezone: 'GMT',
  });
  return `${API_URL}?${params}`;
}

// Locations kept free for tapping on the map while a long airport list loads.
export const AIRPORT_RESERVE = 20;
// Hourly airport conditions every this many hours in the site's own data.
export const AIRPORT_SNAPSHOT_STEP = 3;
const BUDGET_POLL_MS = 2000;

// Whether waiting could give the allowance room for `locations`. It cannot while Open-Meteo has
// asked us to stop or this browser's share of the day is spent: that lasts for hours, and
// fetchJson sends such requests to the Power Globe API instead. Only the per-minute allowance
// refills while waiting.
const waitingHelps = (locations, now = Date.now()) => now >= pausedUntil && DAILY_BUDGET - usedToday(now) >= locations;

// Hourly airport conditions, 100 airports per request. Long lists are paced to the free API's
// limits rather than running into them: each request waits until the allowance has room for it
// (`onWait(true)` while waiting). `wait: false` is for the airport someone is looking at, which
// is what the reserve is for. `onBatch(airports, hourly)` hands over each part as it arrives.
export async function fetchAirportHourly(airports, { onProgress, onBatch, onWait, wait = true } = {}) {
  const parts = chunk(airports, CHUNK_SIZE);
  for (const [i, part] of parts.entries()) {
    const room = part.length + AIRPORT_RESERVE;
    const mustWait = () => wait && apiBudget() < room && waitingHelps(room);
    if (mustWait()) {
      onWait?.(true);
      while (mustWait()) await sleep(BUDGET_POLL_MS);
      onWait?.(false);
    }
    spend(part.length);
    const data = await fetchJson(buildAirportUrl(part));
    onBatch?.(part, (Array.isArray(data) ? data : [data]).map((item) => item.hourly));
    onProgress?.(i + 1, parts.length);
  }
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// Hours between consecutive entries of a series: 1 for hourly data, 3 when the API
// aggregated it to 3-hour steps.
const seriesHours = (times) => (times.length > 1 ? (parseTime(times[1]) - parseTime(times[0])) / 3_600_000 : 1);

// Indices of the times falling on a multiple of `stepHours` (00:00, 03:00, ... GMT), or all
// of them when the API already aggregated the series to that step.
function stepIndices(times, stepHours) {
  if (seriesHours(times) >= stepHours) return times.map((_, i) => i);
  return times.flatMap((t, i) => (Number(t.slice(11, 13)) % stepHours === 0 ? [i] : []));
}

// Precipitation is shown everywhere as a rate: mm per hour, averaged over the `hours` hours up
// to and including entry `index` of an hourly series (Open-Meteo gives each hour's total).
export function precipitationRate(hourly, index, hours = STEP_HOURS) {
  const window = hourly.slice(Math.max(0, index - hours + 1), index + 1).filter((v) => v != null);
  return window.length ? window.reduce((a, b) => a + b, 0) / window.length : null;
}

// Reshape per-location series into values[variable][timeIndex][pointIndex] at `stepHours`.
// Precipitation becomes a rate over the step (see precipitationRate), whether the API sent
// 3-hour totals or plain hourly data.
export function toForecast(points, hourly, stepHours = STEP_HOURS) {
  const keep = hourly.map((h) => stepIndices(h.time, stepHours));
  const times = keep[0].map((i) => hourly[0].time[i]);
  const values = {};
  for (const v of VARIABLES) {
    values[v] = times.map((_, k) =>
      hourly.map((h, p) => {
        const i = keep[p][k];
        if (v !== 'precipitation') return round1(h[v]?.[i]);
        const hours = seriesHours(h.time);
        // Aggregated data holds one total per step; hourly data needs averaging over the step.
        if (hours <= 1) return round1(precipitationRate(h[v] ?? [], i, stepHours));
        const total = h[v]?.[i];
        return total == null ? null : round1(total / hours);
      }),
    );
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

// The global forecast from the site's own data API, with `built` (ms), if it is there and still
// reaches the present.
async function forecastSnapshot(step) {
  const snapshot = await fetchSnapshot('api/forecast.json');
  const data = snapshot?.data;
  if (!data?.times?.length || snapshot.step !== step) return null;
  if (parseTime(data.times.at(-1)) < Date.now()) return null;
  return { ...data, built: Date.parse(snapshot.built) };
}

// Global forecast grid: cached locally, else the site's own copy while it is recent (so
// visitors share one download instead of each spending the free API's allowance), else
// Open-Meteo, else the site's copy however old. `force` asks Open-Meteo first.
export async function loadForecast({ step = GRID_STEP, force = false, onProgress } = {}) {
  const key = `${CACHE_KEY}:${step}`;
  let snapshot = null;
  if (!force) {
    const cached = readCache(key);
    if (cached) return cached;
    snapshot = await forecastSnapshot(step);
    if (snapshot && Date.now() - snapshot.built < SNAPSHOT_FRESH_MS) {
      writeCache(key, snapshot);
      return snapshot;
    }
  }
  try {
    const points = buildGrid(step);
    const data = toForecast(points, await fetchHourly(points, { threeHourly: true, onProgress }));
    writeCache(key, data);
    return data;
  } catch (err) {
    snapshot ??= await forecastSnapshot(step);
    if (snapshot) return snapshot;
    throw err;
  }
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
