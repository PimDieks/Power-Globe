import { VARIABLES } from './layers.js';
import { LARGE_SNAPSHOT_TIMEOUT_MS, PROXY_URL, SNAPSHOT_FRESH_MS, fetchSnapshot } from './api.js';

const API_URL = 'https://api.open-meteo.com/v1/forecast';
// Open-Meteo accepts many coordinates per request; keep URLs and responses a sensible size.
const CHUNK_SIZE = 100;
// Give up on a request after this long rather than leaving the page loading forever.
const TIMEOUT_MS = 30_000;
// Bumped when the shape of the forecast changes (v3: a step for every hour, where v2 had one in
// three), so that a copy kept by an older version is never mixed with new data.
const CACHE_KEY = 'power-globe:forecast:v3';
const CACHE_PREFIX = 'power-globe:forecast:';
const CACHE_TTL_MS = 60 * 60 * 1000;

export const FORECAST_DAYS = 5;
// The global timeline has a step for every hour of the forecast. The grid of 390 locations makes
// the browser's copy 1.1 MB, well within the 5 MB a site may store.
export const STEP_HOURS = 1;
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

// Locations that can still be requested now without exceeding the per-minute and per-hour limits.
// These refill as time passes, unlike a pause or the day's share.
function windowBudget(now = Date.now()) {
  spent = spent.filter(([t]) => now - t < LIMITS.at(-1)[0]);
  return Math.min(
    ...LIMITS.map(([window, limit]) => limit - spent.reduce((sum, [t, n]) => (now - t < window ? sum + n : sum), 0)),
  );
}

// Locations that can still be requested now without exceeding the free limits.
export function apiBudget(now = Date.now()) {
  if (now < pausedUntil) return 0;
  return Math.min(DAILY_BUDGET - usedToday(now), windowBudget(now));
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

// Why Open-Meteo is not asked: it has paused us, or this browser's share of the day or of the
// minute or hour is spent.
const limitReached = () => new ApiError('Open-Meteo usage limit reached for now', 429);

// Ask Open-Meteo directly while this browser is within its allowance, else (or if Open-Meteo
// refuses or cannot be reached) through the Power Globe API. `skipped`: the caller has decided not
// to ask Open-Meteo at all.
async function fetchJsonNow(url, skipped = false) {
  // Requests are counted before they are sent, so this one is already included.
  if (skipped || apiPaused() || usedToday() > DAILY_BUDGET) {
    return fetchViaProxy(url, limitReached());
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
function fetchJson(url, { skipped = false } = {}) {
  // A request that does not ask Open-Meteo has no need to wait for the ones that do.
  if (skipped) return fetchJsonNow(url, true);
  const run = queue.then(() => fetchJsonNow(url));
  queue = run.catch(() => {});
  return run;
}

// Hourly forecasts for a list of points, in the same order. The API returns an array for
// multiple coordinates and a single object for one. `onProgress(done, total)` reports chunks.
export async function fetchHourly(points, { onProgress } = {}) {
  const parts = chunk(points, CHUNK_SIZE);
  const results = [];
  for (const [i, part] of parts.entries()) {
    spend(part.length);
    const data = await fetchJson(buildUrl(part));
    onProgress?.(i + 1, parts.length);
    results.push(...(Array.isArray(data) ? data : [data]).map((item) => item.hourly));
  }
  return results;
}

// Ground conditions at airports, as aviation weather reports them: wind in knots at 10 m (the
// height of airport anemometers), temperature and dew point at 2 m, visibility in metres, every
// hour, and the weather code and CAPE that the Ops view's thunderstorm risk is made from (the
// site's copy is about 0.7 MB compressed with them, see build-data.mjs).
export const AIRPORT_VARIABLES = [
  'temperature_2m',
  'dew_point_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'weather_code',
  'cape',
  'visibility',
];

// Visibility as the site's copy keeps it: to 100 m, and no more than 10 km (reports say 9999 for
// that or more, and no limit is anywhere near), so that the clear hours that are nearly all of them
// are the same number and the copy compresses to almost the size it had without visibility.
export const AIRPORT_VISIBILITY_CAP = 10_000;
export const roundVisibility = (metres) => (metres == null ? null : Math.min(AIRPORT_VISIBILITY_CAP, Math.round(metres / 100) * 100));

// One value of an airport series as the site's copy keeps it: temperatures and dew points to a
// tenth, visibility as above, everything else to a whole number.
export function airportValue(variable, value) {
  if (variable === 'visibility') return roundVisibility(value);
  if (value == null) return null;
  return Number(value.toFixed(variable === 'temperature_2m' || variable === 'dew_point_2m' ? 1 : 0));
}
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
// Airport conditions every this many hours in the site's own data: every hour, as on the timeline,
// so that the wind check and the airport panels agree at every step.
export const AIRPORT_SNAPSHOT_STEP = 1;
const BUDGET_POLL_MS = 2000;

// Whether Open-Meteo may be asked at all for `count` airports, which are sent a part at a time. It
// may not while it has asked us to stop (a minute for the per-minute limit, an hour or until the
// next day for the others) or while this browser's share of the day cannot cover them: waiting
// does not help then, and the Power Globe API answers instead. The share shrinks as the parts go
// out, so the last part is the first to find it closed, and the whole count is what counts. A list
// also leaves the reserve free for the airport someone is looking at (`preferLive`, which may use
// it). The per-minute and per-hour allowances are a separate matter: they refill, so a list waits
// for them.
export function openMeteoOpen(count, { preferLive = false } = {}, now = Date.now()) {
  const room = count + (preferLive ? 0 : AIRPORT_RESERVE);
  return now >= pausedUntil && DAILY_BUDGET - usedToday(now) >= room;
}

// Hourly airport conditions, 100 airports per request. Long lists are paced to the free API's
// limits rather than running into them: each request waits until the per-minute and per-hour
// allowance has room for it (`onWait(true)` while waiting). `preferLive` is for the airport someone
// is looking at: it may use the reserve, and does not wait but goes to the Power Globe API when the
// allowance is short. Either way Open-Meteo is not asked at all while openMeteoOpen says it may
// not be. `onBatch(airports, hourly)` hands over each part as it arrives.
export async function fetchAirportHourly(airports, { onProgress, onBatch, onWait, preferLive = false } = {}) {
  const parts = chunk(airports, CHUNK_SIZE);
  for (const [i, part] of parts.entries()) {
    const room = part.length + (preferLive ? 0 : AIRPORT_RESERVE);
    const open = () => openMeteoOpen(part.length, { preferLive });
    const short = () => windowBudget() < room;
    if (!preferLive && open() && short()) {
      onWait?.(true);
      while (open() && short()) await sleep(BUDGET_POLL_MS);
      onWait?.(false);
    }
    const ask = open() && !short();
    if (ask) spend(part.length);
    const data = await fetchJson(buildAirportUrl(part), { skipped: !ask });
    onBatch?.(part, (Array.isArray(data) ? data : [data]).map((item) => item.hourly));
    onProgress?.(i + 1, parts.length);
  }
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

// Hours between consecutive entries of a series: 1 for hourly data, more when the data was
// aggregated to longer steps.
export const seriesHours = (times) => (times.length > 1 ? (parseTime(times[1]) - parseTime(times[0])) / 3_600_000 : 1);

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

// The times (ms) of the `count` steps after step `step`, wrapping round to the start as the timeline
// does when it plays round and round (`loops`), else ending at its last step.
export function timesAhead(times, step, count, { loops = true } = {}) {
  const ahead = loops ? count : Math.max(0, Math.min(count, times.length - 1 - step));
  return Array.from({ length: ahead }, (_, k) => parseTime(times[(step + k + 1) % times.length]));
}

// While the timeline plays, the moving clouds change every three hours rather than every hour: an
// image for each hour would be three times the downloads, more than the tiles kept in memory
// could hold, so every pass would load them all again. Paused or scrubbed, they follow the hour.
export const CLOUD_PLAY_HOURS = 3;

// The time (ms) the moving clouds show at `step`, and while `playing` the times of the next
// `lookahead` steps to load images for in advance (without repeats), past the end of the timeline
// to its start only if the play `loops` (the play the page starts by itself does not). Times before
// `hourlyBefore` (ms, the present), where every hour has its own image, follow every step while
// playing too.
export function cloudTimes(times, step, { playing = false, loops = true, lookahead = 0, hourlyBefore = -Infinity } = {}) {
  const time = parseTime(times[step]);
  if (!playing) return { time, ahead: [] };
  const span = CLOUD_PLAY_HOURS * 3_600_000;
  const floor = (t) => (t < hourlyBefore ? t : Math.floor(t / span) * span);
  const shown = floor(time);
  const ahead = [...new Set(timesAhead(times, step, lookahead, { loops }).map(floor))].filter((t) => t !== shown);
  return { time: shown, ahead };
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

// Removes forecast copies kept by other versions (such as the 3-hourly v2): they are never read
// again and only take up room.
function dropStaleCaches() {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const name = localStorage.key(i);
    if (name?.startsWith(CACHE_PREFIX) && !name.startsWith(`${CACHE_KEY}:`)) localStorage.removeItem(name);
  }
}

function writeCache(key, data) {
  try {
    dropStaleCaches();
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // Storage unavailable or full; caching is only a convenience.
  }
}

// The file the site's own data API holds for the global forecast (see build-data.mjs): the grid
// spacing, the hours between steps and the forecast itself.
export const forecastCopyOf = (points, hourly) => ({ step: GRID_STEP, hours: STEP_HOURS, data: toForecast(points, hourly) });

// What a file from the data API (`file`) gives: { data, hours } with `built` (ms) in the data, if it
// has this grid and still reaches the present. `hours` is the time between its steps, which a copy
// built when the timeline had 3-hour steps does not say, so it is worked out from the times.
export function usableForecastCopy(file, step, now = Date.now()) {
  const data = file?.data;
  if (!data?.times?.length || file.step !== step || parseTime(data.times.at(-1)) < now) return null;
  return { data: { ...data, built: Date.parse(file.built) }, hours: file.hours ?? seriesHours(data.times) };
}

const forecastCopy = async (step) => usableForecastCopy(await fetchSnapshot('api/forecast.json', LARGE_SNAPSHOT_TIMEOUT_MS), step);

// Global forecast grid: cached locally, else the site's own copy while it is recent (so
// visitors share one download instead of each spending the free API's allowance), else
// Open-Meteo, else the site's copy however old, even one built with 3-hour steps (the timeline
// goes by the steps the forecast has). Only hourly data is kept in the browser. `force` asks
// Open-Meteo first.
export async function loadForecast({ step = GRID_STEP, force = false, onProgress } = {}) {
  const key = `${CACHE_KEY}:${step}`;
  let copy;
  if (!force) {
    const cached = readCache(key);
    if (cached) return cached;
    copy = await forecastCopy(step);
    if (copy?.hours === STEP_HOURS && Date.now() - copy.data.built < SNAPSHOT_FRESH_MS) {
      writeCache(key, copy.data);
      return copy.data;
    }
  }
  try {
    const points = buildGrid(step);
    const data = toForecast(points, await fetchHourly(points, { onProgress }));
    writeCache(key, data);
    return data;
  } catch (err) {
    if (copy === undefined) copy = await forecastCopy(step);
    if (copy) return copy.data;
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
    const request = fetchHourly(points).then((hourly) => ({
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
