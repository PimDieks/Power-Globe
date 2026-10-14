// Public transport for the Ops view's Access part: the trains from the airport's station (NS) and
// the buses at its terminal stops (OVapi, the open real-time feed of the Dutch bus operators), as
// the API gives them (api/worker.js: /access/trains and /access/buses). Pure functions of that data,
// so they can be tested without a browser; the HTML is in opstransitview.js.
//
// What is said of them is kept honest: nothing is "on time" without data that is fresh and live,
// and the cancellations of the bus feed, which are often wrong, are only ever "reported", and never
// make the status fact anything but a count in the section.

// The airports with train and bus data: Schiphol only for now (the others have no railway station,
// and no bus feed has been set up for them).
export const TRANSIT_AIRPORTS = ['EHAM'];
export const hasTransit = (airport) => TRANSIT_AIRPORTS.includes(airport?.ident);

// Answers older than this (minutes) are not taken for how things are now. The page asks every minute
// and the API keeps an answer for one.
export const OLD_MIN = 10;
// A departure this many minutes late counts as delayed.
export const LATE_MIN = 5;
export const MAX_TRAINS_SHOWN = 6;
export const MAX_BUS_LINES = 8;
export const BUS_PER_LINE = 3;
// Buses are delayed when at least BUS_LATE_COUNT of the next hour's run LATE_MIN late or more, and
// BUS_LATE_SHARE of those that run; or when two or more are this many minutes late.
export const BUS_LATE_COUNT = 3;
export const BUS_LATE_SHARE = 0.3;
export const BUS_VERY_LATE_MIN = 15;
// Live times are needed from at least this many buses for "on time" to mean anything.
export const BUS_MIN_LIVE = 2;
const TRAIN_VERY_LATE_MIN = 10;

const minutesOld = (fetched, now) => (Number.isFinite(fetched) ? Math.max(0, Math.round((now - fetched) / 60_000)) : null);

// The shared part of both analyses. `result` is what the poll last found: { state: 'ok', data,
// problem? }, { state: 'unavailable', reason } or { state: 'error', error }, or null while there is none.
function shell(airport, now, result) {
  if (!hasTransit(airport)) return { covered: false };
  if (!result) return { covered: true, loading: true };
  if (result.state === 'unavailable') return { covered: true, unavailable: result.reason ?? 'not available' };
  if (result.state !== 'ok') return { covered: true, error: result.error ?? 'did not load' };
  const { data } = result;
  const ageMin = minutesOld(data.fetched, now);
  return {
    covered: true,
    data,
    ageMin: ageMin ?? 0,
    // An answer without a time on it, or an old one, is not the present.
    old: ageMin == null || ageMin > OLD_MIN,
    stale: Boolean(data.stale),
    problem: result.problem ?? null,
  };
}

// ---- Trains ----

// The next trains and the disruptions through the station. `departures` are those not yet gone, in
// time order; `shown` the first few. `disruptions` is null when the API could not get them (which is
// not the same as there being none).
export function analyseTrains({ airport, now = Date.now(), result = null }) {
  const base = shell(airport, now, result);
  if (!base.data) return base;
  const { data } = base;
  const departures = (data.departures ?? []).filter((d) => d.cancelled || Math.max(d.planned, d.actual ?? d.planned) >= now - 60_000);
  const known = Array.isArray(data.disruptions);
  const disruptions = known ? data.disruptions.filter((d) => d.kind !== 'maintenance') : null;
  const works = known ? data.disruptions.filter((d) => d.kind === 'maintenance') : [];
  const running = departures.filter((d) => !d.cancelled);
  return {
    ...base,
    departures,
    shown: departures.slice(0, MAX_TRAINS_SHOWN),
    more: Math.max(0, departures.length - MAX_TRAINS_SHOWN),
    disruptions,
    works,
    cancelled: departures.filter((d) => d.cancelled).length,
    delayed: running.filter((d) => d.delayMin >= LATE_MIN).length,
    maxDelay: Math.max(0, ...running.map((d) => d.delayMin)),
  };
}

// The train part's contribution to the summary: { text, status, asOf }, or null where it has nothing
// to say (no data for the airport, no key, or still loading).
export function trainsFact(t) {
  if (!t.covered || t.loading || t.unavailable) return null;
  if (t.error) return { text: 'Train data unavailable', status: 'unknown' };
  if (t.old) return { text: `Train data ${t.ageMin} min old`, status: 'unknown' };
  const asOf = t.data.fetched;
  if (t.disruptions?.length) return { text: t.disruptions.length === 1 ? 'Trains disrupted' : `Trains disrupted, ${t.disruptions.length} disruptions`, status: 'caution', asOf };
  if (t.cancelled) return { text: `${t.cancelled} ${t.cancelled === 1 ? 'train' : 'trains'} cancelled`, status: 'caution', asOf };
  if (t.maxDelay >= TRAIN_VERY_LATE_MIN || t.delayed >= 2) return { text: `Trains delayed up to ${t.maxDelay} min`, status: 'caution', asOf };
  if (!t.disruptions) return { text: 'Train disruptions not known', status: 'unknown', asOf };
  if (!t.departures.length) return { text: 'No train departures listed', status: 'unknown', asOf };
  return { text: 'Trains on time', status: 'ok', asOf };
}

// ---- Buses ----

// The buses due in the next hour, grouped by line and destination. `lines` is [{ line, destination,
// next: [pass...], delayMin }] by the time of the next bus; `late` counts the buses LATE_MIN or more
// late, `live` those the feed has real-time information for, and `cancelledReported` those it says
// are cancelled (which it often says wrongly).
export function analyseBuses({ airport, now = Date.now(), result = null }) {
  const base = shell(airport, now, result);
  if (!base.data) return base;
  const { data } = base;
  const until = now + (data.windowMinutes ?? 60) * 60_000;
  const passes = (data.passes ?? []).filter((p) => p.expected >= now - 60_000 && Math.min(p.planned, p.expected) <= until);
  const running = passes.filter((p) => !p.cancelled);
  const groups = new Map();
  for (const p of passes) {
    const key = `${p.line}\u0000${p.destination ?? ''}`;
    if (!groups.has(key)) groups.set(key, { line: p.line, destination: p.destination, next: [], cancelledReported: 0 });
    const g = groups.get(key);
    if (p.cancelled) g.cancelledReported++;
    else g.next.push(p);
  }
  // A line with nothing but reported cancellations has no times to show.
  const cancelledLines = [...groups.values()].filter((g) => g.cancelledReported).map((g) => g.line);
  const lines = [...groups.values()]
    .filter((g) => g.next.length)
    .map((g) => ({ ...g, delayMin: Math.max(0, ...g.next.map((p) => p.delayMin)), next: g.next.slice(0, BUS_PER_LINE) }))
    .sort((a, b) => (a.next[0]?.expected ?? Infinity) - (b.next[0]?.expected ?? Infinity) || a.line.localeCompare(b.line, 'en', { numeric: true }));
  return {
    ...base,
    passes,
    lines: lines.slice(0, MAX_BUS_LINES),
    moreLines: Math.max(0, lines.length - MAX_BUS_LINES),
    running: running.length,
    live: running.filter((p) => ['DRIVING', 'ARRIVED', 'PASSED'].includes(p.status) || p.delayMin > 0).length,
    late: running.filter((p) => p.delayMin >= LATE_MIN).length,
    maxDelay: Math.max(0, ...running.map((p) => p.delayMin)),
    cancelledReported: passes.filter((p) => p.cancelled).length,
    cancelledLines: [...new Set(cancelledLines)].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
  };
}

// The bus part's contribution to the summary. Reported cancellations are left out of it: the feed
// is not good enough to say anything with them.
export function busesFact(b) {
  if (!b.covered || b.loading || b.unavailable) return null;
  if (b.error) return { text: 'Bus data unavailable', status: 'unknown' };
  if (b.old) return { text: `Bus data ${b.ageMin} min old`, status: 'unknown' };
  const asOf = b.data.fetched;
  if (!b.running) return { text: 'No buses listed', status: 'unknown', asOf };
  if ((b.late >= BUS_LATE_COUNT && b.late / b.running >= BUS_LATE_SHARE) || (b.late >= 2 && b.maxDelay >= BUS_VERY_LATE_MIN)) {
    return { text: `Buses delayed, up to ${b.maxDelay} min`, status: 'caution', asOf };
  }
  if (b.live < BUS_MIN_LIVE) return { text: 'No live bus times', status: 'unknown', asOf };
  return { text: 'Buses on time', status: 'ok', asOf };
}

// ---- Together ----

const RANK = { caution: 2, unknown: 1, ok: 0 };
const MAX_PARTS = 2;

// One fact from the roads', trains' and buses' (any may be null or missing): the worst first. Anything
// that needs attention is said and nothing else; failing that, anything that is not known (old data,
// an error) is said, with the good news after it, in grey; only when everything that has data is fine
// is it green, and then it says exactly what is fine. A source with nothing to say (no key, no data for
// the airport) is left out rather than counted as fine. Null when there is no fact at all.
export function combineAccessFacts(facts) {
  const parts = facts.filter((f) => f?.text);
  if (!parts.length) return null;
  const sorted = [...parts].sort((a, b) => RANK[b.status] - RANK[a.status]);
  const worst = sorted[0].status;
  const shown = (worst === 'caution' ? sorted.filter((f) => f.status === 'caution') : sorted).slice(0, MAX_PARTS);
  const stamps = shown.map((f) => f.asOf).filter(Number.isFinite);
  const fact = { text: shown.map((f) => f.text).join('; '), status: worst };
  if (stamps.length) fact.asOf = Math.min(...stamps);
  return fact;
}
