// Low visibility outlook for the Ops view: the latest METAR, the TAF and the model's hourly
// visibility, each judged against low visibility procedure (LVP) style limits hour by hour, with
// the plain-language lines, the fog hint and the status fact made from that. Pure functions of the
// data, so they can be tested without a browser.
import { STATUS } from './runways.js';
import { outlookTimes } from './opsrunway.js';
import { metarVisibility, milesToMetres } from './taf.js';

export const VISIBILITY_OUTLOOK_HOURS = 24;
const HOUR_MS = 3_600_000;

// LVP when the visibility is below `lvpVisibility` metres or the ceiling below `lvpCeiling` feet;
// marginal below the others.
export const DEFAULT_LVP_LIMITS = { lvpVisibility: 1500, lvpCeiling: 300, marginalVisibility: 3000, marginalCeiling: 500 };

const LIMIT_KEY = 'power-globe:ops-visibility-limits';

// The limits as numbers: anything missing or not a number is the default, and marginal is never
// stricter than LVP.
export function cleanLimits(raw) {
  const out = {};
  for (const [name, fallback] of Object.entries(DEFAULT_LVP_LIMITS)) {
    const value = Number(raw?.[name]);
    out[name] = raw?.[name] != null && raw[name] !== '' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
  }
  out.marginalVisibility = Math.max(out.marginalVisibility, out.lvpVisibility);
  out.marginalCeiling = Math.max(out.marginalCeiling, out.lvpCeiling);
  return out;
}

// The limits remembered for this browser, or the defaults.
export function readLimits(storage) {
  try {
    return cleanLimits(JSON.parse((storage ?? globalThis.localStorage).getItem(LIMIT_KEY)));
  } catch {
    return { ...DEFAULT_LVP_LIMITS };
  }
}

export function saveLimits(limits, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(LIMIT_KEY, JSON.stringify(cleanLimits(limits)));
  } catch {
    // Remembering the limits is only a convenience.
  }
}

const isNumber = (v) => typeof v === 'number' && !Number.isNaN(v);

// How conditions fare against the limits: { status, reasons } with the status 'ok', 'caution'
// (marginal), 'nogo' (LVP) or 'unknown', and the reasons 'visibility' and 'ceiling'. A visibility
// or ceiling that is not known, or no ceiling at all, is not judged.
export function classify({ visibility, ceiling } = {}, limits = DEFAULT_LVP_LIMITS) {
  if (!isNumber(visibility) && !isNumber(ceiling)) return { status: 'unknown', reasons: [] };
  const reasonsBelow = (vis, cig) => [isNumber(visibility) && visibility < vis && 'visibility', isNumber(ceiling) && ceiling < cig && 'ceiling'].filter(Boolean);
  const lvp = reasonsBelow(limits.lvpVisibility, limits.lvpCeiling);
  if (lvp.length) return { status: 'nogo', reasons: lvp };
  const marginal = reasonsBelow(limits.marginalVisibility, limits.marginalCeiling);
  if (marginal.length) return { status: 'caution', reasons: marginal };
  return { status: 'ok', reasons: [] };
}

const assess = (conditions, limits) => ({ visibility: conditions.visibility, ceiling: conditions.ceiling, ...classify(conditions, limits) });

// Runway visual range groups in a METAR: "R21/0900N", "R35R/P1500U", "R04R/2400VP6000FT". Metres,
// `above` for P (more than the value), `below` for M. Other groups that start with R (runway
// state) are not RVR.
export function parseRvr(raw) {
  const groups = [];
  for (const token of String(raw ?? '').split(/\sRMK\s/)[0].split(/\s+/)) {
    const m = /^R(\d{2}[LCR]?)\/([MP]?)(\d{4})(?:V([MP]?)(\d{4}))?(FT)?(?:\/?([UDN]))?$/.exec(token);
    if (!m) continue;
    // Feet (US reports) to the nearest 10 m.
    const metres = (n) => (m[6] ? Math.round((Number(n) * 0.3048) / 10) * 10 : Number(n));
    groups.push({
      runway: m[1],
      value: metres(m[3]),
      above: m[2] === 'P',
      below: m[2] === 'M',
      ...(m[5] ? { to: metres(m[5]), toAbove: m[4] === 'P' } : {}),
      trend: m[7] ?? null,
    });
  }
  return groups;
}

// "800 m", "1,500 m", "10 km or more".
export function formatVisibility(metres) {
  if (!isNumber(metres)) return 'unknown';
  return metres >= 10_000 ? '10 km or more' : `${Math.round(metres).toLocaleString('en-US')} m`;
}

export const formatCeiling = (feet) => (isNumber(feet) ? `${Math.round(feet).toLocaleString('en-US')} ft` : 'none');

// The METAR as conditions: { visibility, ceiling, rvr, rvrMin, controlling, spread, ... } or null.
// The lowest RVR counts as the visibility when it is lower (it is what LVP is judged by on the
// runway); an RVR given only as "more than" does not.
export function observedConditions(observation) {
  if (!observation || observation.error) return null;
  // The report's own words are exact; the data API gives miles, rounded.
  const written = metarVisibility(observation.raw);
  const visibility = written !== undefined ? written : isNumber(observation.visibility) ? milesToMetres(observation.visibility) : null;
  const rvr = parseRvr(observation.raw);
  const values = rvr.filter((g) => !g.above).map((g) => g.value);
  const rvrMin = values.length ? Math.min(...values) : null;
  const byRvr = rvrMin != null && (visibility == null || rvrMin < visibility);
  const spread = isNumber(observation.temperature) && isNumber(observation.dewPoint) ? observation.temperature - observation.dewPoint : null;
  return {
    visibility,
    rvr,
    rvrMin,
    controlling: byRvr ? rvrMin : visibility,
    byRvr,
    ceiling: isNumber(observation.ceiling) ? observation.ceiling : null,
    verticalVisibility: /\bVV\d{3}\b/.test(observation.raw ?? ''),
    category: observation.category ?? null,
    spread,
    temperature: observation.temperature ?? null,
    dewPoint: observation.dewPoint ?? null,
    speed: observation.speed ?? null,
    time: observation.time ?? null,
    raw: observation.raw ?? '',
  };
}

// The worse of states, each a { visibility, ceiling } with undefined or null for what is not
// stated: the lowest of each.
function worstState(states) {
  const lowest = (key) => {
    const numbers = states.map((s) => s[key]).filter(isNumber);
    if (numbers.length) return Math.min(...numbers);
    return states.some((s) => s[key] === null) ? null : undefined;
  };
  return { visibility: lowest('visibility'), ceiling: lowest('ceiling') };
}

// A state with what a group states put over it.
const overlay = (state, group) => ({
  visibility: group.visibility === undefined ? state.visibility : group.visibility,
  ceiling: group.ceiling === undefined ? state.ceiling : group.ceiling,
});

// The conditions that last, as stretches of time: the first group, then each FM and BECMG group
// changing what was stated before. A BECMG stretch has its transition ([from, settled)) in which
// the conditions before and after both count.
function prevailingStretches(taf) {
  const chain = taf.periods.filter((p) => ['BASE', 'FM', 'BECMG'].includes(p.kind));
  let state = {};
  return chain.map((p, i) => {
    const before = state;
    state = overlay(state, p);
    const becomes = p.kind === 'BECMG';
    return { from: p.from, to: chain[i + 1]?.from ?? taf.to, settled: becomes ? (p.becoming ?? p.from) : p.from, before: becomes ? before : null, state };
  });
}

// What a TAF's groups are called: "TEMPO", "PROB30", "PROB40 TEMPO".
const changeLabel = (p) => (p.kind === 'PROB' ? `PROB${p.probability}` : p.probability ? `PROB${p.probability} TEMPO` : 'TEMPO');

// The TAF in the hour from `start` to `end` (ms): the conditions that prevail (the worst of any
// that apply in the hour) and the worst of the TEMPO and PROB groups that apply, each judged;
// null for what the TAF does not cover. Only groups that state a visibility or a ceiling count as
// changes.
function tafHour(taf, stretches, start, end, limits) {
  const states = [];
  for (const s of stretches) {
    if (s.from >= end || s.to <= start) continue;
    // In a BECMG transition what was before and what is coming both count.
    if (s.before && start < s.settled) states.push(s.before, s.state);
    else if (end > s.settled) states.push(s.state);
  }
  if (!states.length) return { prevailing: null, change: null };
  let change = null;
  for (const p of taf.periods) {
    if (!['TEMPO', 'PROB'].includes(p.kind) || p.from >= end || p.to <= start) continue;
    if (p.visibility === undefined && p.ceiling === undefined) continue;
    const found = { ...assess(worstState(states.map((s) => overlay(s, p))), limits), label: changeLabel(p), weight: p.probability ? 'prob' : 'tempo' };
    if (!change || STATUS[found.status].rank > STATUS[change.status].rank) change = found;
  }
  return { prevailing: assess(worstState(states), limits), change };
}

// Relative humidity in percent from temperature and dew point (°C), by the Magnus formula.
export function relativeHumidity(temperature, dewPoint) {
  if (!isNumber(temperature) || !isNumber(dewPoint)) return null;
  const a = 17.625;
  const b = 243.04;
  return 100 * Math.exp((a * dewPoint) / (b + dewPoint) - (a * temperature) / (b + temperature));
}

// Fog is likely to form or last when the air is within FOG_SPREAD °C of its dew point, the wind is
// light (at most FOG_WIND_KT) and the model has the air humid.
export const FOG_SPREAD = 2;
export const FOG_WIND_KT = 8;
export const FOG_HUMIDITY = 90;

// The model's hour: its visibility judged, and the numbers the fog hint reads.
function modelHour(hourly, i, limits) {
  const at = (name) => (isNumber(hourly[name]?.[i]) ? hourly[name][i] : null);
  const visibility = at('visibility');
  const temperature = at('temperature_2m');
  const dewPoint = at('dew_point_2m');
  return {
    visibility,
    ...(visibility == null ? { status: 'unknown', reasons: [] } : classify({ visibility }, limits)),
    spread: temperature != null && dewPoint != null ? temperature - dewPoint : null,
    speed: at('wind_speed_10m'),
    humidity: relativeHumidity(temperature, dewPoint),
  };
}

const rank = (status) => STATUS[status].rank;

// An hour's verdict from its sources: the worst status among them (`level`), the sources at that
// level and how sure it is. A METAR or a TAF's prevailing conditions are firm (`expected`); a
// TEMPO group counts 2, a PROB group or the model 1, and 3 together make it `likely`, less
// `possible`.
function combine(hour) {
  const found = [
    hour.metar && { id: 'metar', label: 'METAR', status: hour.metar.status, firm: true },
    hour.taf?.prevailing && { id: 'taf', label: 'TAF', status: hour.taf.prevailing.status, firm: true },
    hour.taf?.change && { id: 'change', label: `TAF ${hour.taf.change.label}`, status: hour.taf.change.status, weight: hour.taf.change.weight === 'tempo' ? 2 : 1 },
    hour.model && { id: 'model', label: 'model', status: hour.model.status, weight: 1 },
  ].filter((s) => s && s.status !== 'unknown');
  if (!found.length) return { level: 'unknown', sources: [], strength: null };
  const level = found.reduce((worst, s) => (rank(s.status) > rank(worst) ? s.status : worst), 'ok');
  const sources = found.filter((s) => s.status === level);
  if (level === 'ok') return { level, sources, strength: null };
  const score = sources.reduce((sum, s) => sum + (s.weight ?? 0), 0);
  return { level, sources, strength: sources.some((s) => s.firm) ? 'expected' : score >= 3 ? 'likely' : 'possible' };
}

// The hour of `hourly` for `time`, or -1.
const hourIndex = (hourly, time) => hourly?.time?.indexOf(time) ?? -1;

// The fog hint's verdict for an hour. The spread and the wind come from the METAR in the hour it
// belongs to, else from the model; the humidity is the model's.
function foggy(hour, metar) {
  const model = hour.model;
  if (!model || model.humidity == null) return false;
  const spread = metar?.spread ?? model.spread;
  const speed = metar?.speed ?? model.speed;
  return spread != null && spread <= FOG_SPREAD && speed != null && speed <= FOG_WIND_KT && model.humidity >= FOG_HUMIDITY;
}

// The state of a source that is loaded by the page: 'loading' (undefined), 'none' (null), 'error'
// or 'ok'.
function sourceState(value) {
  if (value === undefined) return 'loading';
  if (value === null) return 'none';
  return value.error ? 'error' : 'ok';
}

// The next hours: `hours` has an entry per hour with the verdict of each source (`metar` in the
// first hour only, `taf` with the prevailing conditions and the worst TEMPO or PROB group, `model`),
// the worst `level` and `strength` of it, and whether the fog hint applies. `metar`, `taf` and
// `model` say what each source gave: a `state` of 'ok', 'loading', 'none' or 'error'.
export function visibilityOutlook({ hourly, observation, taf, now = Date.now(), limits = DEFAULT_LVP_LIMITS, hours = VISIBILITY_OUTLOOK_HOURS }) {
  const times = outlookTimes(now, hours);
  const first = Date.parse(`${times[0]}Z`);
  const current = sourceState(observation) === 'ok' ? observedConditions(observation) : null;
  const metar = { state: sourceState(observation), error: observation?.error ?? null, now: current ? { ...current, ...classify({ visibility: current.controlling, ceiling: current.ceiling }, limits) } : null };
  const stretches = taf && !taf.error ? prevailingStretches(taf) : [];
  const tafState = taf && !taf.error && taf.to <= first ? 'expired' : sourceState(taf);
  const modelOk = Array.isArray(hourly?.visibility) && times.some((t) => isNumber(hourly.visibility[hourIndex(hourly, t)]));

  const list = times.map((time, k) => {
    const start = Date.parse(`${time}Z`);
    const hour = {
      time,
      metar: k === 0 && metar.now ? metar.now : null,
      taf: tafState === 'ok' ? tafHour(taf, stretches, start, start + HOUR_MS, limits) : null,
      model: modelOk && hourIndex(hourly, time) >= 0 ? modelHour(hourly, hourIndex(hourly, time), limits) : null,
    };
    return { ...hour, ...combine(hour), fog: foggy(hour, hour.metar) };
  });
  const tafChanges = list.some((h) => h.taf?.change);
  return {
    limits,
    times,
    metar,
    taf: { state: tafState, error: taf?.error ?? null, value: tafState === 'ok' ? taf : null, changes: tafChanges },
    model: { state: modelOk ? 'ok' : 'none' },
    hours: list,
    hasData: metar.state === 'ok' || tafState === 'ok' || modelOk,
  };
}

// Whether an outlook whose first hour is `first` is out of date at `now`.
export const visibilityStale = (first, now) => first !== outlookTimes(now, 1)[0];

// Runs of consecutive hours at the same level and strength: { level, strength, start, end, from,
// to, sources } with `end` the index after the last hour, `to` the first hour after it (null at
// the end of the outlook) and `sources` the labels of the sources in any hour of it.
export function problemRuns(outlook) {
  const runs = [];
  const { hours } = outlook;
  hours.forEach((hour, i) => {
    if (hour.level !== 'nogo' && hour.level !== 'caution') return;
    const last = runs.at(-1);
    if (last && last.end === i && last.level === hour.level && last.strength === hour.strength) {
      last.end = i + 1;
      last.to = hours[i + 1]?.time ?? null;
      for (const s of hour.sources) if (!last.sources.includes(s.label)) last.sources.push(s.label);
      return;
    }
    runs.push({ level: hour.level, strength: hour.strength, start: i, end: i + 1, from: hour.time, to: hours[i + 1]?.time ?? null, sources: hour.sources.map((s) => s.label) });
  });
  return runs;
}

// The sources in the order they are written: METAR, TAF, TAF TEMPO or PROB, model.
const sourceRank = (label) => (label === 'METAR' ? 0 : label === 'TAF' ? 1 : label === 'model' ? 3 : 2);
const sourcesText = (labels) => [...labels].sort((a, b) => sourceRank(a) - sourceRank(b)).join(', ');

// "now, until 16:00", "from 13:00 to 16:00", "from 13:00 onwards" or "for the next 24 hours".
function spanText(run, total, fmt) {
  if (run.start === 0 && run.end >= total) return `for the next ${total} hours`;
  if (run.start === 0) return `now, until ${fmt(run.to)}`;
  if (run.end >= total) return `from ${fmt(run.from)} onwards`;
  return `from ${fmt(run.from)} to ${fmt(run.to)}`;
}

// Most lines about spells of LVP or marginal conditions before the rest are summed up.
const MAX_LINES = 4;

// How a run is written: "LVP likely from 03:00 to 08:00 (TAF TEMPO, model)".
function runLine(run, total, fmt) {
  const what = run.level === 'nogo' ? 'LVP' : 'Marginal visibility or ceiling';
  const sources = `(${sourcesText(run.sources)})`;
  // The METAR is what is happening now, not something expected.
  if (run.start === 0 && run.sources.includes('METAR')) {
    return `${what} ${run.end > 1 ? spanText(run, total, fmt) : 'now'} ${sources}.`;
  }
  return `${what} ${run.strength} ${spanText(run, total, fmt)} ${sources}.`;
}

// The fog hint's runs of hours: { start, end, from, to }.
export function fogRuns(outlook) {
  const runs = [];
  outlook.hours.forEach((hour, i) => {
    if (!hour.fog) return;
    const last = runs.at(-1);
    if (last && last.end === i) {
      last.end = i + 1;
      last.to = outlook.hours[i + 1]?.time ?? null;
    } else {
      runs.push({ start: i, end: i + 1, from: hour.time, to: outlook.hours[i + 1]?.time ?? null });
    }
  });
  return runs;
}

// What the lines say about a source that is not there.
function missingNotes(outlook) {
  const notes = [];
  const { metar, taf } = outlook;
  if (metar.state === 'loading') notes.push('Loading the METAR…');
  else if (metar.state === 'none') notes.push('No METAR from this airport in the last 3 hours.');
  else if (metar.state === 'error') notes.push(`The METAR could not be loaded (${metar.error}).`);
  if (taf.state === 'loading') notes.push('Loading the TAF…');
  else if (taf.state === 'none') notes.push('No TAF for this airport.');
  else if (taf.state === 'expired') notes.push('The latest TAF is no longer valid.');
  else if (taf.state === 'error') notes.push(`The TAF could not be loaded (${taf.error}).`);
  return notes;
}

// The lines under the heading, as plain sentences in order of importance: LVP spells, marginal
// spells, fog risk, and what is missing. `fmt` writes a GMT time as the reader's local time.
export function outlookLines(outlook, fmt) {
  const total = outlook.hours.length;
  const lines = [];
  const forecasts = [outlook.taf.state === 'ok' && 'TAF', outlook.model.state === 'ok' && 'model'].filter(Boolean);
  const runs = problemRuns(outlook);
  const spells = [...runs.filter((r) => r.level === 'nogo'), ...runs.filter((r) => r.level === 'caution')].map((r) => runLine(r, total, fmt));
  lines.push(...spells.slice(0, MAX_LINES));
  if (spells.length > MAX_LINES) lines.push(`${spells.length - MAX_LINES} more ${spells.length - MAX_LINES === 1 ? 'spell' : 'spells'} in the strips below.`);
  if (!runs.length && forecasts.length) {
    // Only the TAF gives ceilings; the model gives visibility alone.
    const what = outlook.taf.state === 'ok' ? 'Visibility and ceiling' : 'Visibility';
    lines.push(`${what} above limits for the next ${total} hours (${forecasts.join(', ')}).`);
  } else if (!forecasts.length && outlook.metar.state === 'ok') {
    lines.push('There is no forecast of visibility here, so the next hours cannot be judged.');
  }
  fogRuns(outlook).slice(0, 2).forEach((run, i) => {
    // The first line says what the hint rests on.
    const why = i === 0 ? `: spread ${FOG_SPREAD} °C or less, wind ${FOG_WIND_KT} kt or less, humidity ${FOG_HUMIDITY}% or more` : '';
    lines.push(`Fog risk ${spanText(run, total, fmt)}${why}.`);
  });
  lines.push(...missingNotes(outlook));
  if (!outlook.hasData && !lines.length) lines.push('No METAR, TAF or model visibility for this airport.');
  return lines;
}

// What the METAR says in a few words, for the status strip: "VIS 800 m", "RVR 700 m", "CIG 200 ft".
function measure(now) {
  const parts = [];
  const vis = now.byRvr ? `RVR ${formatVisibility(now.rvrMin)}` : now.visibility != null ? `VIS ${formatVisibility(now.visibility)}` : null;
  const lowVis = now.reasons.includes('visibility');
  const lowCig = now.reasons.includes('ceiling');
  if (vis && (lowVis || !lowCig)) parts.push(vis);
  if (now.ceiling != null && (lowCig || !parts.length)) parts.push(`${now.verticalVisibility ? 'VV' : 'CIG'} ${formatCeiling(now.ceiling)}`);
  return parts.join(', ') || 'No visibility';
}

// The Ops status strip's visibility fact: { text, status } ("VIS 800 m, LVP", "LVP expected 03:00",
// "VIS 10 km or more, no LVP in 24 h"), or null when there is nothing to say.
export function visibilityFact(outlook, fmt) {
  if (!outlook.hasData) return { text: 'No data', status: 'unknown' };
  const { metar, hours } = outlook;
  const total = hours.length;
  const now = metar.now && metar.now.status !== 'unknown' ? metar.now : null;
  const level = now ? now.status : hours[0].level;
  const word = { nogo: 'LVP', caution: 'marginal' };
  if (level === 'nogo' || level === 'caution') {
    return { text: now ? `${measure(now)}, ${word[level]}` : `${level === 'nogo' ? 'LVP' : 'Marginal'} now`, status: level };
  }
  const next = hours.find((h) => h.level === 'nogo') ?? hours.find((h) => h.level === 'caution');
  if (next) {
    return { text: `${next.level === 'nogo' ? 'LVP' : 'Marginal'} ${next.strength} ${fmt(next.time)}`, status: 'caution' };
  }
  const judged = level === 'ok' || hours.some((h) => h.level === 'ok');
  if (!judged) return { text: 'No data', status: 'unknown' };
  const forecast = outlook.taf.state === 'ok' || outlook.model.state === 'ok';
  return { text: now ? `${measure(now)}${forecast ? `, no LVP in ${total} h` : ''}` : `No LVP expected in ${total} h`, status: 'ok' };
}

// When there is nothing to show at all, in a sentence.
export function noOutlookText(outlook) {
  const notes = missingNotes(outlook);
  return notes.length ? notes.join(' ') : 'No METAR, TAF or model visibility for this airport.';
}

// What an hour has to say, short enough to be read out for every hour: "03:00, LVP likely".
export function hourSummary(hour) {
  const verdict = hour.level === 'unknown' ? 'no data' : hour.level === 'ok' ? 'above limits' : `${hour.level === 'nogo' ? 'LVP' : 'marginal'} ${hour.strength}`;
  return `${verdict}${hour.fog ? ', fog risk' : ''}`;
}
