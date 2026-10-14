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

// Statute miles in metres, to the 50 m that metric reports use below 800 m and the 100 m they use
// above; 6 miles and over is "10 km or more", as the reports say it.
export function milesToMetres(miles) {
  if (miles == null || Number.isNaN(miles)) return null;
  const exact = miles * METRES_PER_MILE;
  const step = exact < 800 ? 50 : 100;
  const metres = Math.round(exact / step) * step;
  return miles >= MILES_AT_LEAST ? Math.max(AT_LEAST_M, metres) : metres;
}

// The visibility written in the words of a report or of one group of a TAF ("9999", "0800",
// "CAVOK", "P6SM", "0SM", "1 1/2SM"), in metres, or undefined when there is none. The first one
// counts: the later ones of a METAR are directions, trends and remarks.
export function visibilityInWords(words) {
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (word === 'CAVOK') return AT_LEAST_M;
    if (/^\d{4}$/.test(word)) return word === '9999' ? AT_LEAST_M : Number(word);
    const sm = /^[PM]?(\d+)(?:\/(\d+))?SM$/.exec(word);
    if (!sm) continue;
    const whole = sm[2] && /^\d+$/.test(words[i - 1] ?? '') ? Number(words[i - 1]) : 0;
    return milesToMetres(sm[2] ? whole + Number(sm[1]) / Number(sm[2]) : Number(sm[1]));
  }
  return undefined;
}

// The visibility of a METAR as it is written, or undefined when the text does not give one
// (the data API's own figure is in miles, rounded).
export function metarVisibility(raw) {
  const words = String(raw ?? '').split(/\s+/);
  const end = words.findIndex((w) => /^(RMK|BECMG|TEMPO|NOSIG)$/.test(w));
  const wind = words.findIndex((w) => /^(\d{3}|VRB)\d{2,3}(G\d{2,3})?(KT|MPS|KMH)$/.test(w));
  return visibilityInWords(words.slice(wind + 1, end < 0 ? undefined : end));
}

// The groups of a TAF's text: the first (BASE), then each FM, BECMG, TEMPO, INTER and PROB group
// with its words. PROB30 TEMPO is one TEMPO group.
function rawGroups(raw) {
  const words = String(raw ?? '').split(/\s+/).filter(Boolean);
  const start = words.findIndex((w) => /^\d{4}\/\d{4}$/.test(w));
  if (start < 0) return [];
  const cut = words.findIndex((w, i) => i > start && w === 'RMK');
  const groups = [];
  let open = { kind: 'BASE', words: [] };
  for (const word of words.slice(start + 1, cut < 0 ? undefined : cut)) {
    const kind = /^FM\d{6}$/.test(word) ? 'FM' : word === 'BECMG' ? 'BECMG' : word === 'INTER' || word === 'TEMPO' ? 'TEMPO' : /^PROB\d\d$/.test(word) ? 'PROB' : null;
    if (kind === 'TEMPO' && open.kind === 'PROB' && !open.words.length) open.kind = 'TEMPO';
    else if (kind) {
      groups.push(open);
      open = { kind, words: [] };
    } else open.words.push(word);
  }
  groups.push(open);
  return groups;
}

// The text's groups matched one for one with the data API's, or null when they do not match (then
// the data API's own figures are used).
function groupsOf(entry) {
  const groups = rawGroups(entry.rawTAF);
  const same = groups.length === entry.fcsts.length && groups.every((g, i) => g.kind === kindOf(entry.fcsts[i].fcstChange));
  return same ? groups : null;
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
  const groups = groupsOf(entry);
  const periods = entry.fcsts
    .map((f, i) => ({
      kind: kindOf(f.fcstChange),
      probability: f.probability ?? null,
      from: seconds(f.timeFrom),
      to: seconds(f.timeTo),
      becoming: seconds(f.timeBec),
      // The data API gives no visibility for 0SM, and miles for the metres of a metric TAF, so a
      // group's visibility is what its text says; "not stated" only when it really is not.
      visibility: groups ? visibilityInWords(groups[i].words) : visibilityMetres(f.visib),
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
