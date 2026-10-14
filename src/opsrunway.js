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

// The runways of a list of ends, in order: [{ label: '18R/36L', idents: ['18R', '36L'] }].
export function runwayRows(endList) {
  const rows = new Map();
  for (const end of endList) rows.set(end.runway, [...(rows.get(end.runway) ?? []), end.ident]);
  return [...rows.values()].map((idents) => ({ label: idents.join('/'), idents }));
}

const rank = (status) => STATUS[status].rank;

// Of the ends within limits, the one with the most headwind, except that `previous` stays when it
// is within TIE_KT of the best: the runway in use is not swapped for a knot.
function mostHeadwind(usable, previous) {
  const top = Math.max(...usable.map((e) => e.headwind));
  const close = usable.filter((e) => e.headwind >= top - TIE_KT);
  return close.find((e) => e.ident === previous) ?? close.reduce((best, e) => (e.headwind > best.headwind ? e : best));
}

// The better end of one runway: the one most into the wind among those within limits, else the
// one nearest its limits.
function betterEnd(rowEnds, previous) {
  const usable = rowEnds.filter(withinLimits);
  if (usable.length) return mostHeadwind(usable, previous);
  return rowEnds.reduce((best, e) => (e.load < best.load ? e : best));
}

// What the next hour is judged against: the end favoured so far, and the better end of each runway.
export const noCarry = () => ({ favoured: null, best: {} });

// The carry after `hour`. Hours without a judgement (calm, none, missing) leave what was in place:
// the runway in use stays in use through a calm hour or a gap.
export function nextCarry(carry, hour) {
  if (hour.state === 'missing') return carry;
  const best = { ...carry.best };
  for (const row of hour.runways) best[row.label] = row.best;
  return { favoured: hour.favoured ?? carry.favoured, best };
}

// One hour: every runway end in the wind, the runways and the favoured end. Favoured is the end
// with the most headwind among those within limits (marginal ones count: they are within), and
// stays the end in `carry` when that is within TIE_KT of it. `favoured` is null when calm (any
// runway will do), when no end is within limits and when there is no wind data; `state` says which.
export function assessHour(endList, conditions, limits, carry = noCarry()) {
  const time = conditions?.time ?? null;
  const known = conditions && [conditions.speed, conditions.direction].every((v) => v != null && !Number.isNaN(v));
  const rows = runwayRows(endList);
  if (!known || !endList.length) {
    const unknown = { time, state: 'missing', status: 'unknown', favoured: null, wind: conditions ?? null };
    return { ...unknown, ends: endList.map((e) => ({ ident: e.ident, status: 'unknown' })), runways: rows.map((r) => ({ ...r, status: 'unknown', best: null })) };
  }
  const ends = endList.map((e) => ({ ident: e.ident, ...assessRunwayEnd(e.heading, conditions, limits) }));
  const runways = rows.map((row) => {
    const own = ends.filter((e) => row.idents.includes(e.ident));
    const best = betterEnd(own, carry.best[row.label]);
    return { ...row, status: best.status, best: best.ident };
  });
  const status = runways.reduce((best, r) => (rank(r.status) < rank(best) ? r.status : best), 'nogo');
  const result = { time, wind: conditions, status, ends, runways };
  // Calm means calm in the gusts too.
  if (conditions.speed < CALM_KT && (conditions.gust ?? conditions.speed) < CALM_KT) return { ...result, state: 'calm', favoured: null };
  const usable = ends.filter(withinLimits);
  if (!usable.length) return { ...result, state: 'none', favoured: null };
  return { ...result, state: 'favoured', favoured: mostHeadwind(usable, carry.favoured).ident };
}

// The hours from the start of the forecast up to `until` (ms), judged one after the other, so that
// the end in use going into the outlook is the same whenever it is asked for.
function carryUpTo(ends, hourly, limits, until) {
  const first = Date.parse(`${hourly.time[0]}Z`);
  let carry = noCarry();
  for (let t = Math.floor(first / HOUR_MS) * HOUR_MS; t < until; t += HOUR_MS) {
    carry = nextCarry(carry, assessHour(ends, conditionsAt(hourly, new Date(t).toISOString().slice(0, 16)), limits, carry));
  }
  return carry;
}

// Every hour of a forecast judged one after the other, as the outlook does it, so that the
// favoured ends are the ones the outlook shows. Kept for the last airport and limits asked about
// per forecast, so that scrubbing the timeline does not judge them again.
const histories = new WeakMap();
function hourHistory(airport, hourly, limits) {
  const key = `${airport.ident}|${limits.crosswind}|${limits.tailwind}`;
  const kept = histories.get(hourly);
  if (kept?.key === key) return kept.hours;
  const ends = runwayEnds(airport);
  const hours = new Map();
  const last = Date.parse(`${hourly.time.at(-1)}Z`) + 3 * HOUR_MS;
  let carry = noCarry();
  for (let t = Math.floor(Date.parse(`${hourly.time[0]}Z`) / HOUR_MS) * HOUR_MS; t <= last; t += HOUR_MS) {
    const time = new Date(t).toISOString().slice(0, 16);
    const hour = { ...assessHour(ends, conditionsAt(hourly, time), limits, carry), time };
    hours.set(time, hour);
    carry = nextCarry(carry, hour);
  }
  histories.set(hourly, { key, hours });
  return hours;
}

// The outlook's judgement of the hour containing `time` ("2026-10-14T15:30"), or null without a
// forecast. Outside the forecast it is the hour's own judgement, with no hours before it.
export function hourAt(airport, hourly, time, limits) {
  if (!hourly?.time?.length) return null;
  const hourTime = `${time.slice(0, 13)}:00`;
  return hourHistory(airport, hourly, limits).get(hourTime) ?? { ...assessHour(runwayEnds(airport), conditionsAt(hourly, time), limits), time: hourTime };
}

// What the map says about one runway in an hour of the outlook, the same as its strip does: the
// runway takes the status of its better end; that end keeps its own status and the other end is
// 'neutral' (with a hint when it has a tailwind), unless the whole runway is over limits or the
// wind is calm, when every end shows its own status. { status, best, ends: { ident: { status,
// hint } } }; 'unknown' without a judgement of this runway.
export function runwayCall(runway, hour) {
  const idents = [runway.le, runway.he].filter(Boolean);
  const unknown = { status: 'unknown', best: null, ends: Object.fromEntries(idents.map((ident) => [ident, { status: 'unknown', hint: null }])) };
  const row = hour?.runways.find((r) => r.idents.some((ident) => idents.includes(ident)));
  if (!row || hour.state === 'missing') return unknown;
  const shared = row.status === 'nogo' || hour.state === 'calm';
  const ends = Object.fromEntries(
    idents.map((ident) => {
      const end = hour.ends.find((e) => e.ident === ident);
      if (!end) return [ident, { status: 'unknown', hint: null }];
      if (shared || ident === row.best) return [ident, { status: end.status, hint: null }];
      return [ident, { status: 'neutral', hint: end.tailwind >= TIE_KT ? 'tailwind' : null }];
    }),
  );
  return { status: row.status, best: row.best, ends };
}

// The next hours at an airport. `reason` says why there is nothing to show: 'noRunways' (no
// runway with a usable heading) or 'noForecast' (no hourly data at all); otherwise `hours` has an
// entry per hour, with state 'missing' where the forecast has a gap. The favoured end of an hour
// depends on the hours before it (see assessHour), so those are judged too, from the start of the
// forecast; opening the panel at 14:55 or 15:05 gives the same favoured ends for the same hours.
export function runwayOutlook({ airport, hourly, now = Date.now(), limits, hours = RUNWAY_OUTLOOK_HOURS }) {
  const ends = runwayEnds(airport);
  const times = outlookTimes(now, hours);
  const rows = runwayRows(ends);
  if (!ends.length) return { reason: 'noRunways', ends: [], runwayRows: [], times, hours: [] };
  if (!hourly?.time?.length) return { reason: 'noForecast', ends, runwayRows: rows, times, hours: [] };
  let carry = carryUpTo(ends, hourly, limits, Date.parse(`${times[0]}Z`));
  const list = times.map((time) => {
    const hour = { ...assessHour(ends, conditionsAt(hourly, time), limits, carry), time };
    carry = nextCarry(carry, hour);
    return hour;
  });
  if (list.every((h) => h.state === 'missing')) return { reason: 'noForecast', ends, runwayRows: rows, times, hours: [] };
  return { reason: null, ends, runwayRows: rows, times, hours: list, runways: rows.length };
}

// Whether an outlook whose first hour is `first` is out of date at `now`: a new hour has begun.
export const outlookStale = (first, now) => first !== outlookTimes(now, 1)[0];

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
  for (const { idents } of outlook.runwayRows) {
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
