// The latest official observation at an airport (METAR), from the Aviation Weather Center's
// public data API (NOAA, public domain).
import { PROXY_URL } from './api.js';

const METAR_URL = (ident) => `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(ident)}&format=json&hours=3`;
const TIMEOUT_MS = 12_000;
const CACHE_MS = 5 * 60_000;

export const FLIGHT_CATEGORIES = {
  VFR: { label: 'VFR', description: 'Visual flight rules: ceiling above 3,000 ft and visibility over 5 miles' },
  MVFR: { label: 'MVFR', description: 'Marginal VFR: ceiling 1,000–3,000 ft or visibility 3–5 miles' },
  IFR: { label: 'IFR', description: 'Instrument flight rules: ceiling 500–1,000 ft or visibility 1–3 miles' },
  LIFR: { label: 'LIFR', description: 'Low IFR: ceiling below 500 ft or visibility under 1 mile' },
};

// Visibility in statute miles from the API ("10+", "1/2", 6, ...).
export function visibilityMiles(visib) {
  if (visib == null || visib === '') return null;
  if (typeof visib === 'number') return visib;
  const text = String(visib).replace('+', '').trim();
  const [whole, frac] = text.includes(' ') ? text.split(' ') : text.includes('/') ? ['0', text] : [text, null];
  const [n, d] = frac ? frac.split('/').map(Number) : [0, 1];
  const v = Number(whole) + (d ? n / d : 0);
  return Number.isNaN(v) ? null : v;
}

// The lowest broken or overcast layer (or vertical visibility), in feet.
export function ceilingFt(clouds = []) {
  const bases = clouds.filter((c) => ['BKN', 'OVC', 'OVX', 'VV'].includes(c.cover) && c.base != null).map((c) => c.base);
  return bases.length ? Math.min(...bases) : null;
}

// Flight category from ceiling and visibility, as the FAA defines it.
export function flightCategory(ceiling, visibility) {
  const c = ceiling ?? Infinity;
  const v = visibility ?? Infinity;
  if (c < 500 || v < 1) return 'LIFR';
  if (c < 1000 || v < 3) return 'IFR';
  if (c <= 3000 || v <= 5) return 'MVFR';
  return 'VFR';
}

// The parts of a METAR the panel uses; wind in knots, directions true.
export function toObservation(m) {
  if (!m) return null;
  const visibility = visibilityMiles(m.visib);
  const ceiling = ceilingFt(m.clouds);
  return {
    raw: m.rawOb ?? '',
    time: m.obsTime ? m.obsTime * 1000 : Date.parse(m.reportTime ?? '') || null,
    temperature: m.temp ?? null,
    dewPoint: m.dewp ?? null,
    // Variable wind has no direction; it is treated as coming from anywhere (see airport panel).
    direction: typeof m.wdir === 'number' ? m.wdir : null,
    variable: m.wdir === 'VRB',
    speed: m.wspd ?? null,
    gust: m.wgst ?? null,
    visibility,
    ceiling,
    category: FLIGHT_CATEGORIES[m.fltCat] ? m.fltCat : flightCategory(ceiling, visibility),
  };
}

const cache = new Map();

// The newest METAR for an airport, or null if none was issued in the last three hours. Throws
// if the service cannot be reached.
export async function latestObservation(ident) {
  const hit = cache.get(ident);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let text;
  // Through the Power Globe API when there is one, else straight from aviationweather.gov.
  for (const url of [PROXY_URL && `${PROXY_URL}/metar?ids=${encodeURIComponent(ident)}`, METAR_URL(ident)].filter(Boolean)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
      text = await res.text();
      break;
    } catch (err) {
      if (url === METAR_URL(ident)) throw err;
    }
  }
  const list = text.trim() ? JSON.parse(text) : [];
  const newest = list.sort((a, b) => (b.obsTime ?? 0) - (a.obsTime ?? 0))[0];
  const value = toObservation(newest);
  cache.set(ident, { at: Date.now(), value });
  return value;
}
