// The Ops view's Access part: the road traffic around the airport, and the trains and buses at
// Schiphol, as HTML, and the keeping of them up to date (a poll of the API every minute while the
// panel is open: for the summary line, and with the Access tab shown also the section and the roads
// on the map). Roads, trains and buses are three sources with their own results and their own
// failures; the summary line gets one fact from all three. It is a part for ops.js.
import { PROXY_URL } from './api.js';
import { escapeHtml } from './airportview.js';
import {
  GREEN_FROM,
  MAX_INCIDENTS,
  RED_BELOW,
  RED_MIN_FLOW,
  accessFact,
  analyseAccess,
  isCovered,
  kindText,
  mapShapes,
  roadText,
  situationText,
  typeLabel,
} from './opsaccess.js';
import { analyseBuses, analyseTrains, busesFact, combineAccessFacts, hasTransit, trainsFact } from './opstransit.js';
import { busesHtml, trainsHtml } from './opstransitview.js';

// The data is asked for this often while the panel is open; NDW publishes new speeds every minute.
export const POLL_MS = 60_000;
// A source that said it has nothing (no relay, no NS key) is asked again this often, not every poll.
export const RECHECK_MS = 10 * 60_000;
export const TIMEOUT_MS = 15_000;
export const SOURCE_TEXT = 'Source: NDW (opendata.ndw.nu)';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- HTML ----

function incidentsHtml(data) {
  const { listed, more, others } = data;
  const rows = listed.map((s) => {
    const kind = s.measured ? 'measured from the speeds on the road' : kindText(s.kind);
    return `<li class="access-${escapeHtml(s.type)}"><span class="access-badge">${typeLabel(s.type)}</span> <span class="access-what">${escapeHtml(situationText(s))}</span>${kind ? ` <span class="ops-note">${escapeHtml(kind)}</span>` : ''}</li>`;
  });
  const empty = '<p class="ops-empty">No jams, accidents, closures or vehicles on the road reported on the motorways near the airport.</p>';
  const rest = [
    more > 0 ? `${more} more` : null,
    others.closures ? `${plural(others.closures, 'closure')} on other roads` : null,
    others.obstructions ? `${plural(others.obstructions, 'vehicle or object', 'vehicles or objects')} on other roads` : null,
  ].filter(Boolean);
  const planned = others.planned ? `<p class="ops-note">${plural(others.planned, 'roadworks closure')} on a motorway ends within 48 hours; roadworks are otherwise left out.</p>` : '';
  return `${rows.length ? `<ul class="access-list">${rows.join('')}</ul>` : empty}${rest.length ? `<p class="ops-more">and ${rest.join(', ')}</p>` : ''}${planned}`;
}

function stretchesHtml(data) {
  if (!data.stretches.length) return '<p class="ops-empty">No slow stretches on the roads near the airport.</p>';
  const rows = data.stretches.map((s) => {
    const band = s.minSpeed < RED_BELOW ? 'red' : 'amber';
    const sites = s.sites > 1 ? `, over ${plural(s.sites, 'measuring point')}` : '';
    const limit = s.limitKmh ? `, a temporary limit of ${s.limitKmh} km/h is in force` : '';
    return `<li><i class="access-dot access-${band}" aria-hidden="true"></i> <b>${escapeHtml(roadText(s.road, s.dir))}</b> ${s.minSpeed} km/h at the slowest${sites}, ${Math.round(s.km)} km from the airport${limit}${s.provincial ? ' (not a motorway)' : ''}</li>`;
  });
  return `<ul class="access-list access-stretches">${rows.join('')}</ul>`;
}

function legendHtml(counts) {
  const items = [
    ['green', `${GREEN_FROM}+ km/h`, counts.green],
    ['amber', `${RED_BELOW} to ${GREEN_FROM}`, counts.amber],
    ['red', `under ${RED_BELOW}`, counts.red],
    ['grey', 'too little traffic or no data', counts.grey],
  ];
  return `<p class="access-legend" aria-label="Motorway measuring points by speed">${items.map(([band, label, n]) => `<span><i class="access-dot access-${band}" aria-hidden="true"></i> ${n} ${label}</span>`).join('')}</p>`;
}

// The roads: one sub-section of the Access part, with the states of having no data. Trains and buses
// are the entries after it in `subsections` below.
function roadsHtml(data) {
  const head = '<h4 class="access-title">Roads</h4>';
  if (data.loading) return `${head}<p>Loading road data from NDW…</p>`;
  if (data.unavailable) return `${head}<p class="ops-empty">No road data right now. ${escapeHtml(data.unavailable)}.</p><p class="ops-note">${SOURCE_TEXT}.</p>`;
  if (data.error) return `${head}<p class="ops-empty">Road data did not load (${escapeHtml(data.error)}). It tries again by itself.</p><p class="ops-note">${SOURCE_TEXT}.</p>`;
  const age = data.ageMin < 1 ? 'less than a minute' : plural(data.ageMin, 'minute');
  const warnings = [];
  if (data.stale) warnings.push(`The API could not reach its road source and is showing its last answer, ${data.ageMin} min old.`);
  if (!data.speedOk) warnings.push(Number.isFinite(data.data.measuredAt) ? (data.old ? `There is no recent speed data (the newest is ${data.ageMin} min old), so nothing can be said of how fast the roads flow.` : 'The speed data has nothing to say yet, so nothing can be said of how fast the roads flow.') : 'There is no speed data, so nothing can be said of how fast the roads flow.');
  if (data.problem) warnings.push(`The last update failed (${data.problem}); this is the last answer.`);
  return `${head}${warnings.map((w) => `<p class="access-old"><b>${escapeHtml(w)}</b></p>`).join('')}
    <h5>Jams and incidents within ${data.data.radiusKm} km</h5>
    ${incidentsHtml(data)}
    <h5>Slowest stretches</h5>
    ${stretchesHtml(data)}
    ${data.speedOk ? legendHtml(data.counts) : ''}
    <p class="ops-note">Speeds are those of the motorways: the average of the lanes with at least 120 vehicles an hour in the last minute, and red needs at least ${RED_MIN_FLOW} vehicles an hour in all; roadworks and roads other than motorways are left out unless they are an incident or a standing queue. Speed data from ${age} ago. ${SOURCE_TEXT}.</p>`;
}

// The sub-sections, drawn in this order, each with its own heading: `{ id, html(data) }`, where `data`
// is the whole analysis (the roads' own, with `trains` and `buses` added). One that has nothing to
// draw gives an empty string and is left out.
export const subsections = [
  { id: 'roads', html: roadsHtml },
  { id: 'trains', html: trainsHtml },
  { id: 'buses', html: busesHtml },
];

export function accessBodyHtml(data) {
  if (!data.covered) return '<p class="ops-empty">Road data only for Dutch airports for now.</p>';
  return subsections
    .map((sub) => ({ sub, html: sub.html(data) }))
    .filter(({ html }) => html)
    .map(({ sub, html }) => `<div class="access-sub" data-access="${sub.id}">${html}</div>`)
    .join('');
}

export const accessSectionHtml = (data) => `<div class="ops-access" data-ops-access>${accessBodyHtml(data)}</div>`;

// ---- Keeping it up to date ----

let overlay = null;
// The map's roads (see accessmap.js), set up by main.js: { show(shapes), hide() }.
export const setAccessOverlay = (value) => {
  overlay = value;
};

// The three sources: what the API route is called, and whether the airport has it.
export const SOURCES = [
  { id: 'roads', applies: isCovered },
  { id: 'trains', applies: hasTransit },
  { id: 'buses', applies: hasTransit },
];

// The session: { api, root, watching, paused, ident, results, busy, timer, controllers, overlay, ask,
// setTimer, clearTimer, now }. `results` and `busy` are kept per source. It runs while the part is
// bound (its tab is shown, with `root` and the roads on the map) or watching (summary mode: the same
// poll, nothing drawn on the map or in a section). It is paused while the page is hidden.
let session = null;

const ask = async (ident, signal, source = 'roads') => {
  const res = await fetch(`${PROXY_URL}/access/${source}?airport=${encodeURIComponent(ident)}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `answered ${res.status}`);
  return body;
};

// Whether the roads are drawn: the tab is shown and its map profile turns them on.
function mapOn(state) {
  if (!state.root) return false;
  const profile = state.api.mapProfile?.();
  return profile ? profile.roads : true;
}

function stopPolling() {
  if (!session) return;
  // Called as plain functions: the browser's timers refuse to be called as methods of another object.
  const { clearTimer, timer } = session;
  if (timer != null) clearTimer(timer);
  session.timer = null;
  for (const controller of session.controllers.values()) controller.abort();
  session.controllers.clear();
  session.overlay?.hide();
}

const forgetResults = (state) => {
  state.results = {};
  state.busy = {};
};

// The analysis of everything found for the airport so far: the roads', with the trains' and buses'
// added where the airport has them. An airport without road data is only `{ covered: false }`.
export function analyseSources({ airport, now = Date.now(), results = {} }) {
  const roads = analyseAccess({ airport, now, result: results.roads ?? null });
  if (!roads.covered) return roads;
  return {
    ...roads,
    trains: analyseTrains({ airport, now, result: results.trains ?? null }),
    buses: analyseBuses({ airport, now, result: results.buses ?? null }),
  };
}

// The summary line's one fact from the roads, the trains and the buses.
export const accessFactAll = (data) => combineAccessFacts([accessFact(data), data.trains ? trainsFact(data.trains) : null, data.buses ? busesFact(data.buses) : null]);

// Draws the section if the tab is shown, the roads on the map, and the summary line again.
function refresh() {
  const state = session;
  if (!state?.ident) return;
  let ctx;
  try {
    ctx = state.api.getContext();
  } catch {
    return;
  }
  if (!ctx?.airport || ctx.airport.ident !== state.ident) return;
  const data = analyseSources({ airport: ctx.airport, now: ctx.now ?? Date.now(), results: state.results });
  if (state.root) {
    const inner = state.root.querySelector('.ops-access');
    if (inner) inner.innerHTML = accessBodyHtml(data);
    if (data.data && !data.old && mapOn(state)) state.overlay?.show(mapShapes(data));
    else state.overlay?.hide();
  }
  state.api.refreshSummary?.();
}

// Asks for one source, if it is not being asked for already and has not said it has nothing very
// recently, and keeps what comes.
async function pollSource(state, source) {
  const ident = state.ident;
  const kept = state.results[source];
  if (state.busy[source]) return;
  if (kept?.state === 'unavailable' && state.now() - kept.at < RECHECK_MS) return;
  state.busy[source] = true;
  const controller = new AbortController();
  state.controllers.set(source, controller);
  const { signal } = controller;
  const timeout = state.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const body = await state.ask(ident, signal, source);
    if (session !== state || state.ident !== ident) return;
    state.results[source] = body.available === false ? { state: 'unavailable', reason: body.reason, at: state.now() } : { state: 'ok', data: body };
  } catch (err) {
    // An answer for an airport that has been left is not for this one.
    if (session !== state || state.ident !== ident) return;
    const message = signal.aborted ? 'it took too long' : err.message;
    // The last answer stays on screen, said to be the last, until it is too old to use.
    state.results[source] = kept?.state === 'ok' ? { ...kept, problem: message } : { state: 'error', error: message };
  } finally {
    state.clearTimeout(timeout);
    // A poll that was cancelled by a move to another airport does not end the new one's.
    if (state.controllers.get(source) === controller) {
      state.busy[source] = false;
      state.controllers.delete(source);
    }
  }
  refresh();
}

function poll() {
  const state = session;
  if (!state?.ident || state.paused) return;
  const airport = state.airport;
  for (const { id, applies } of SOURCES) if (applies(airport)) pollSource(state, id);
}

// Starts asking for `airport`, if it is not the one asked for; stops for any other. Gives what
// has been found for it so far. Render calls this on every draw, so that opening another airport
// moves it along.
function follow(airport) {
  if (!session) return null;
  const ident = airport?.ident ?? null;
  if (ident === session.ident) return session.results;
  stopPolling();
  session.ident = ident;
  session.airport = airport ?? null;
  forgetResults(session);
  if (isCovered(airport)) {
    poll();
    const { setTimer } = session;
    session.timer = setTimer(poll, POLL_MS);
  }
  return null;
}

// The page is hidden: nothing is asked meanwhile. Shown again: it asks at once and goes on.
function onVisibility() {
  const state = session;
  if (!state) return;
  if (globalThis.document?.hidden) state.paused = true;
  else if (state.paused) {
    state.paused = false;
    poll();
  }
}

function open(api, deps) {
  session = {
    api,
    root: null,
    watching: false,
    paused: globalThis.document?.hidden === true,
    ident: null,
    airport: null,
    results: {},
    busy: {},
    timer: null,
    controllers: new Map(),
    overlay: deps.overlay ?? overlay,
    ask: deps.ask ?? ask,
    now: deps.now ?? (() => Date.now()),
    setTimer: deps.setTimer ?? setInterval,
    clearTimer: deps.clearTimer ?? clearInterval,
    setTimeout: deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimeout: deps.clearTimeout ?? ((id) => clearTimeout(id)),
  };
  globalThis.document?.addEventListener?.('visibilitychange', onVisibility);
}

// Nothing is asked or drawn after.
function end() {
  if (!session) return;
  stopPolling();
  globalThis.document?.removeEventListener?.('visibilitychange', onVisibility);
  session = null;
}

// Called when the panel is open on another tab: the sources are asked for for the summary line, with
// nothing drawn. `deps` are for tests.
export function watch(api, deps = {}) {
  if (!session) open(api, deps);
  session.watching = true;
  session.api = api;
  follow(api.getContext()?.airport);
}

export function unwatch() {
  if (!session) return;
  session.watching = false;
  if (!session.root) end();
}

// Called when the Access tab is shown: the section and the map are kept up to date. `deps` are for tests.
export function bind(root, api, deps = {}) {
  if (!session?.watching) unbind();
  if (!session) open(api, deps);
  session.root = root;
  session.api = api;
  follow(api.getContext()?.airport);
  // What the poll already found is drawn at once.
  if (Object.keys(session.results).length) refresh();
}

// Called when the tab goes: the map is cleared, and the sources are asked for no longer unless the
// summary line still watches them.
export function unbind() {
  if (!session) return;
  if (session.root) session.overlay?.hide();
  session.root = null;
  if (!session.watching) end();
}

// Another airport is being opened: this one is let go of now, and the poll moves on with the next draw.
export function release() {
  if (!session) return;
  stopPolling();
  session.ident = null;
  session.airport = null;
  forgetResults(session);
}

export const accessPart = {
  id: 'access',
  tab: 'access',
  overlay: 'roads',
  title: 'Access',
  factLabel: 'Access',
  needs: ['airport', 'now'],
  analyse: (ctx) => analyseSources({ airport: ctx.airport, now: ctx.now, results: follow(ctx.airport) ?? {} }),
  fact: accessFactAll,
  // NDW's readings are 4 to 6 minutes old when they arrive, and the poll is every minute.
  staleAfterMs: 15 * 60_000,
  html: accessSectionHtml,
  bind,
  unbind,
  watch,
  unwatch,
  release,
};

// Forgets everything, for tests.
export const forgetAccess = () => end();
