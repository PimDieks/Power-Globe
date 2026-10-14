// The latest forecast for an airport (TAF), from the Aviation Weather Center's public data API
// (NOAA, public domain), and its groups read into periods with a visibility and a ceiling.
import { PROXY_URL } from './api.js';
import { visibilityMiles } from './metar.js';

const TAF_URL = (ident) => `https://aviationweather.gov/api/data/taf?ids=${encodeURIComponent(ident)}&format=json`;
const TIMEOUT_MS = 12_000;
const CACHE_MS = 10 * 60_000;

const METRES_PER_MILE = 1609.344;
// Visibility of 6 statute miles or more is written 9999 (10 km or more) or P6SM, and the data
// API gives it as "6+".
const MILES_AT_LEAST = 6;
const AT_LEAST_M = 10_000;

// Statute miles in metres, to the 100 m that reports are written in; 6 miles and over is "10 km
// or more", as the reports say it.
export function milesToMetres(miles) {
  if (miles == null || Number.isNaN(miles)) return null;
  const metres = Math.round((miles * METRES_PER_MILE) / 100) * 100;
  return miles >= MILES_AT_LEAST ? Math.max(AT_LEAST_M, metres) : metres;
}

// A visibility from the data API ("6+", "1/2", 0.19) in metres; undefined when the group does not
// state one.
export function visibilityMetres(visib) {
  const miles = visibilityMiles(visib);
  return miles == null ? undefined : milesToMetres(miles);
}

// The lowest broken or overcast layer of a TAF group in feet: a number, null when clouds are
// stated and none is a ceiling (few, scattered, clear, CAVOK, no significant cloud), undefined when
// the group does not state clouds. Vertical visibility counts as a ceiling.
export function tafCeiling(clouds, vertVis) {
  if (!clouds?.length) return undefined;
  const bases = clouds.flatMap((c) => {
    if (c.cover === 'OVX') return [c.base ?? vertVis];
    return ['BKN', 'OVC', 'VV'].includes(c.cover) ? [c.base] : [];
  });
  const known = bases.filter((b) => b != null);
  return known.length ? Math.min(...known) : null;
}

const seconds = (s) => (s == null ? null : s * 1000);

// The kind of a group: BASE (the first), FM, BECMG, TEMPO, or PROB (a probability alone).
function kindOf(change) {
  if (change == null) return 'BASE';
  return ['FM', 'BECMG', 'TEMPO', 'PROB'].includes(change) ? change : 'TEMPO';
}

// One TAF of the data API as { ident, issued, from, to, raw, periods } with times in ms. A period
// is { kind, probability, from, to, becoming, visibility, ceiling, weather }: `becoming` is when a
// BECMG change is complete, `visibility` (metres) and `ceiling` (feet) are undefined where the
// group does not state them, and mean that what was before goes on.
export function parseTaf(entry) {
  if (!entry?.fcsts?.length) return null;
  const periods = entry.fcsts
    .map((f) => ({
      kind: kindOf(f.fcstChange),
      probability: f.probability ?? null,
      from: seconds(f.timeFrom),
      to: seconds(f.timeTo),
      becoming: seconds(f.timeBec),
      visibility: visibilityMetres(f.visib),
      ceiling: tafCeiling(f.clouds, f.vertVis),
      weather: f.wxString ?? '',
    }))
    .filter((p) => p.from != null && p.to != null)
    .sort((a, b) => a.from - b.from);
  if (!periods.length) return null;
  return {
    ident: entry.icaoId ?? '',
    issued: Date.parse(entry.issueTime ?? '') || seconds(entry.validTimeFrom),
    from: seconds(entry.validTimeFrom) ?? periods[0].from,
    to: seconds(entry.validTimeTo) ?? Math.max(...periods.map((p) => p.to)),
    raw: entry.rawTAF ?? '',
    periods,
  };
}

// The newest TAF in an answer of the data API, or null.
export function newestTaf(list) {
  const parsed = (Array.isArray(list) ? list : []).map(parseTaf).filter(Boolean);
  return parsed.sort((a, b) => b.issued - a.issued)[0] ?? null;
}

const cache = new Map();

// The current TAF for an airport, or null when it has none (most small fields do not). Throws if
// the service cannot be reached.
export async function latestTaf(ident) {
  const hit = cache.get(ident);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  let text;
  // Through the Power Globe API when there is one, else straight from aviationweather.gov.
  for (const url of [PROXY_URL && `${PROXY_URL}/taf?ids=${encodeURIComponent(ident)}`, TAF_URL(ident)].filter(Boolean)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
      text = await res.text();
      break;
    } catch (err) {
      if (url === TAF_URL(ident)) throw err;
    }
  }
  const value = newestTaf(text.trim() ? JSON.parse(text) : []);
  cache.set(ident, { at: Date.now(), value });
  return value;
}
