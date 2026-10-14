// Runway and wind outlook for the Ops view: which runway end is favoured hour by hour, how each
// end fares against the limits, and the plain-language lines and status fact made from that. Pure
// functions of the data, so they can be tested without a browser.
import { conditionsAt } from './airports.js';
import { STATUS, assessRunwayEnd, runwayEnds } from './runways.js';

export const RUNWAY_OUTLOOK_HOURS = 24;
// Wind below this many knots counts as calm, as in formatWind.
const CALM_KT = 1;
// Headwinds this close (in knots) count as equal, so the runway in use stays favoured.
const TIE_KT = 1;
const HOUR_MS = 3_600_000;
// Most limit lines shown before the rest are summed up.
const MAX_LIMIT_LINES = 4;
// Most runs of favoured runways named in the first line.
const MAX_RUNS = 3;

const withinLimits = (end) => end.status === 'ok' || end.status === 'caution';

// The GMT hours ("2026-10-14T15:00") from the one containing `now` for `hours` hours.
export function outlookTimes(now, hours = RUNWAY_OUTLOOK_HOURS) {
  const start = Math.floor(now / HOUR_MS) * HOUR_MS;
  return Array.from({ length: hours }, (_, i) => new Date(start + i * HOUR_MS).toISOString().slice(0, 16));
}

// One hour: every runway end in the wind, and the favoured one. `previous` is the end favoured the
// hour before, which stays favoured when another has no more than TIE_KT more headwind.
// Favoured is the end with the most headwind among those within limits (marginal ones count: they
// are within). `favoured` is null when calm (any runway will do), when no end is within limits
// and when there is no wind data; `state` says which.
export function assessHour(runwayEndList, conditions, limits, previous = null) {
  const time = conditions?.time ?? null;
  const known = conditions && [conditions.speed, conditions.direction].every((v) => v != null && !Number.isNaN(v));
  if (!known) {
    return { time, state: 'missing', status: 'unknown', favoured: null, wind: conditions ?? null, ends: runwayEndList.map((e) => ({ ident: e.ident, status: 'unknown' })) };
  }
  const ends = runwayEndList.map((e) => ({ ident: e.ident, ...assessRunwayEnd(e.heading, conditions, limits) }));
  const rank = (status) => STATUS[status].rank;
  const status = ends.length ? ends.reduce((best, e) => (rank(e.status) < rank(best) ? e.status : best), 'nogo') : 'unknown';
  const result = { time, wind: conditions, status, ends };
  if (!ends.length) return { ...result, state: 'missing', favoured: null };
  if (conditions.speed < CALM_KT) return { ...result, state: 'calm', favoured: null };
  const usable = ends.filter(withinLimits);
  if (!usable.length) return { ...result, state: 'none', favoured: null };
  const top = Math.max(...usable.map((e) => e.headwind));
  const close = usable.filter((e) => e.headwind >= top - TIE_KT);
  const keep = close.find((e) => e.ident === previous);
  // Of the equally good, the one furthest from its limits.
  const pick = keep ?? close.sort((a, b) => b.headwind - a.headwind || a.load - b.load)[0];
  return { ...result, state: 'favoured', favoured: pick.ident };
}

// The next hours at an airport. `reason` says why there is nothing to show: 'noRunways' (no
// runway with a usable heading) or 'noForecast' (no hourly data at all); otherwise `hours` has an
// entry per hour, with state 'missing' where the forecast has a gap.
export function runwayOutlook({ airport, hourly, now = Date.now(), limits, hours = RUNWAY_OUTLOOK_HOURS }) {
  const ends = runwayEnds(airport);
  const times = outlookTimes(now, hours);
  if (!ends.length) return { reason: 'noRunways', ends: [], times, hours: [] };
  if (!hourly?.time?.length) return { reason: 'noForecast', ends, times, hours: [] };
  let previous = null;
  const list = times.map((time) => {
    const hour = assessHour(ends, conditionsAt(hourly, time), limits, previous);
    previous = hour.favoured ?? previous;
    return { ...hour, time };
  });
  if (list.every((h) => h.state === 'missing')) return { reason: 'noForecast', ends, times, hours: [] };
  return { reason: null, ends, times, hours: list, runways: new Set(ends.map((e) => e.runway)).size };
}

// What each hour has to say about the runway to use: 'favoured' with the end, 'calm', 'none' or
// 'missing'. Consecutive hours saying the same are one run: { key, state, favoured, from, to, start, end },
// where `from` is its first hour, `to` the first hour after it (null at the end of the outlook).
export function favouredRuns(outlook) {
  const runs = [];
  outlook.hours.forEach((hour, i) => {
    const key = hour.state === 'favoured' ? hour.favoured : hour.state;
    const last = runs.at(-1);
    if (last && last.key === key) return;
    if (last) last.to = hour.time;
    runs.push({ key, state: hour.state, favoured: hour.favoured, from: hour.time, to: null, start: i });
  });
  return runs;
}

// Runs of consecutive hours satisfying `test`: [{ from, to, start, end }] with `to` the first
// hour after (null when the run lasts to the end of the outlook); `end` is that hour's index.
function spans(hours, test) {
  const out = [];
  let open = null;
  hours.forEach((hour, i) => {
    if (test(hour)) {
      open ??= { from: hour.time, start: i };
    } else if (open) {
      out.push({ ...open, to: hour.time, end: i });
      open = null;
    }
  });
  if (open) out.push({ ...open, to: null, end: hours.length });
  return out;
}

// "now until 16:00", "from 13:00 to 16:00", "from 13:00 onwards" or "for the whole outlook".
function spanText(span, total, fmt) {
  if (span.start === 0 && span.end >= total) return `for the next ${total} hours`;
  if (span.start === 0) return `now, until ${fmt(span.to)}`;
  if (span.end >= total) return `from ${fmt(span.from)} onwards`;
  return `from ${fmt(span.from)} to ${fmt(span.to)}`;
}

const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const capital = (text) => text[0].toUpperCase() + text.slice(1);

// The favoured runway as a phrase: "runway 27 favoured", "calm, any runway".
function runPhrase(run, first) {
  switch (run.state) {
    case 'favoured':
      return first ? `runway ${run.favoured} favoured` : run.favoured;
    case 'calm':
      return 'calm, any runway';
    case 'none':
      return 'no runway within limits';
    default:
      return 'no forecast';
  }
}

// The idents of the ends of each runway, runway by runway: Map(runway → ['09', '27']).
function runwayIdents(outlook) {
  const map = new Map();
  for (const end of outlook.ends) map.set(end.runway, [...(map.get(end.runway) ?? []), end.ident]);
  return map;
}

// The lines under the heading, as plain sentences in order of importance: who is favoured when,
// when every runway is over limit, and when a single runway is (runways with the same trouble over
// the same time share a line). `fmt` writes a GMT time as the reader's local time.
export function outlookLines(outlook, fmt) {
  const { hours } = outlook;
  if (!hours.length) return [];
  const total = hours.length;
  const lines = [];

  const runs = favouredRuns(outlook);
  const shown = runs.length > MAX_RUNS ? runs.slice(0, MAX_RUNS - 1) : runs;
  if (runs.length === 1) {
    const [run] = runs;
    lines.push(run.state === 'calm' ? `Calm for the next ${total} hours, any runway.` : capital(`${runPhrase(run, true)} for the next ${total} hours.`));
  } else {
    const parts = shown.map((run, i) => {
      const until = run.to ? ` until ${fmt(run.to)}` : '';
      return i === 0 ? `${capital(runPhrase(run, true))}${until}` : `${runPhrase(run, false)}${until}`;
    });
    const text = parts.join(', then ');
    const more = shown.length < runs.length ? `, and changes again after ${fmt(shown.at(-1).to)}` : '';
    lines.push(`${text}${more}.`);
  }

  const limit = [];
  // Every runway over limit (a single runway is covered by its ends below).
  if (outlook.runways > 1) {
    for (const span of spans(hours, (h) => h.state !== 'missing' && h.status === 'nogo')) {
      limit.push(`All runways over limit ${spanText(span, total, fmt)}.`);
    }
  }
  // Runways no end of which can be used, grouped by what is wrong and when. (An end with a tailwind
  // over the limit while the other end of its runway is fine is simply the wrong way round.)
  const groups = new Map();
  for (const [runway, idents] of runwayIdents(outlook)) {
    const status = (h, ident) => h.ends.find((e) => e.ident === ident)?.status;
    for (const span of spans(hours, (h) => idents.every((ident) => status(h, ident) === 'nogo'))) {
      const names = new Set(hours.slice(span.start, span.end).flatMap((h) => h.ends.filter((e) => idents.includes(e.ident)).flatMap((e) => e.reasons ?? [])));
      const what = ['crosswind', 'tailwind'].filter((n) => names.has(n)).join(' and ');
      const key = `${what}|${span.start}|${span.end}`;
      const group = groups.get(key) ?? { what, span, names: [] };
      group.names.push(idents.join('/'));
      groups.set(key, group);
    }
  }
  const grouped = [...groups.values()].sort((a, b) => a.span.start - b.span.start || b.names.length - a.names.length);
  for (const { what, span, names } of grouped) {
    limit.push(`${capital(what)} on ${list(names)} over limit ${spanText(span, total, fmt)}.`);
  }
  lines.push(...limit.slice(0, MAX_LIMIT_LINES));
  if (limit.length > MAX_LIMIT_LINES) lines.push(`${limit.length - MAX_LIMIT_LINES} more over-limit spells in the strips below.`);
  return lines;
}

// The Ops status strip's runway fact: the favoured runway now and when it changes, as
// { text, status } ("RWY 27 → 24 at 15:00"), or null when there is nothing to say.
export function runwayFact(outlook, fmt) {
  const [first, next] = favouredRuns(outlook);
  if (!first) return null;
  const now = outlook.hours[0];
  const head = { favoured: `RWY ${first.favoured}`, calm: 'Calm', none: 'None within limits', missing: 'No forecast' }[first.state];
  const status = now.state === 'missing' ? 'unknown' : now.status;
  if (!next) return { text: first.state === 'calm' ? 'Calm, any runway' : `${head}, no change in ${outlook.hours.length} h`, status };
  const tail = { favoured: next.favoured, calm: 'calm', none: 'none within limits', missing: 'no forecast' }[next.state];
  return { text: `${head} → ${tail} at ${fmt(next.from)}`, status };
}

// When no outlook can be made: why, in a sentence.
export function noOutlookText(outlook, error) {
  if (outlook.reason === 'noRunways') return 'This airport has no runway with known headings, so no runway can be favoured.';
  return error ? `The forecast could not be loaded here (${error}).` : 'No forecast for the next hours here yet.';
}
