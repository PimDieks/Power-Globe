// The Ops view's Access part: the road traffic around the airport as HTML, and the keeping of it
// up to date while the tab is open (a poll of the API every minute, and the dots and lines on the
// map). It is a part for ops.js.
import { PROXY_URL } from './api.js';
import { escapeHtml } from './airportview.js';
import { factItemHtml } from './opsfact.js';
import {
  GREEN_FROM,
  MAX_INCIDENTS,
  RED_BELOW,
  accessFact,
  analyseAccess,
  isCovered,
  kindText,
  mapShapes,
  roadText,
  situationText,
  typeLabel,
} from './opsaccess.js';

// The data is asked for this often while the tab is open; NDW publishes new speeds every minute.
export const POLL_MS = 60_000;
const TIMEOUT_MS = 15_000;
export const SOURCE_TEXT = 'Source: NDW (opendata.ndw.nu)';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---- HTML ----

function incidentsHtml(data) {
  const { jams, accidents, closures, obstructions } = data;
  const listed = [...jams, ...accidents, ...closures].slice(0, MAX_INCIDENTS);
  if (!listed.length && !obstructions.length) return '<p class="ops-empty">No jams, accidents or closures reported near the airport.</p>';
  const rows = listed.map((s) => {
    const kind = kindText(s.kind);
    return `<li class="access-${escapeHtml(s.type)}"><span class="access-badge">${typeLabel(s.type)}</span> <span class="access-what">${escapeHtml(situationText(s))}</span>${kind ? ` <span class="ops-note">${escapeHtml(kind)}</span>` : ''}</li>`;
  });
  const more = jams.length + accidents.length + closures.length - listed.length;
  const rest = [more > 0 ? `${more} more` : null, obstructions.length ? plural(obstructions.length, 'vehicle or object on the road', 'vehicles or objects on the road') : null].filter(Boolean);
  return `${rows.length ? `<ul class="access-list">${rows.join('')}</ul>` : ''}${rest.length ? `<p class="ops-more">and ${rest.join(', ')}</p>` : ''}`;
}

function stretchesHtml(data) {
  if (!data.stretches.length) return '<p class="ops-empty">No slow stretches on the roads near the airport.</p>';
  const rows = data.stretches.map((s) => {
    const band = s.minSpeed < RED_BELOW ? 'red' : 'amber';
    const sites = s.sites > 1 ? `, over ${plural(s.sites, 'measuring point')}` : '';
    return `<li><i class="access-dot access-${band}" aria-hidden="true"></i> <b>${escapeHtml(roadText(s.road, s.dir))}</b> ${s.minSpeed} km/h at the slowest${sites}, ${Math.round(s.km)} km from the airport</li>`;
  });
  return `<ul class="access-list access-stretches">${rows.join('')}</ul>`;
}

function legendHtml(counts) {
  const items = [
    ['green', `${GREEN_FROM}+ km/h`, counts.green],
    ['amber', `${RED_BELOW} to ${GREEN_FROM}`, counts.amber],
    ['red', `under ${RED_BELOW}`, counts.red],
    ['grey', 'no traffic or no data', counts.grey],
  ];
  return `<p class="access-legend" aria-label="Measuring points by speed">${items.map(([band, label, n]) => `<span><i class="access-dot access-${band}" aria-hidden="true"></i> ${n} ${label}</span>`).join('')}</p>`;
}

// The roads: one sub-section of the Access part. Trains (NS) and buses are meant to come as
// further entries of `subsections` below, each with its own heading, drawn in this order.
function roadsHtml(data) {
  const age = data.ageMin < 1 ? 'less than a minute' : plural(data.ageMin, 'minute');
  const warnings = [];
  if (data.stale) warnings.push(`The API could not reach its road source and is showing its last answer, ${data.ageMin} min old.`);
  else if (data.old) warnings.push(`The road data is ${data.ageMin} min old and says little of the roads now.`);
  if (data.problem) warnings.push(`The last update failed (${data.problem}); this is the last answer.`);
  return `${warnings.map((w) => `<p class="access-old"><b>${escapeHtml(w)}</b></p>`).join('')}
    <h4>Jams and incidents within ${data.data.radiusKm} km</h4>
    ${incidentsHtml(data)}
    <h4>Slowest stretches</h4>
    ${stretchesHtml(data)}
    ${legendHtml(data.counts)}
    <p class="ops-note">Speed is the slowest lane that had traffic in the last minute, at ${plural(data.data.sites.length, 'measuring point')}; a lane with no traffic says nothing. Data from ${age} ago. ${SOURCE_TEXT}.</p>`;
}

// Where trains and buses go when they exist: add `{ id, html(data) }` entries, with the heading
// they need, and a fact for the strip if they have one. Nothing else in this part changes.
export const subsections = [{ id: 'roads', html: roadsHtml }];

export function accessBodyHtml(data) {
  if (!data.covered) return '<p class="ops-empty">Road data only for Dutch airports for now.</p>';
  if (data.loading) return '<p>Loading road data from NDW…</p>';
  if (data.unavailable) return `<p class="ops-empty">No road data right now. ${escapeHtml(data.unavailable)}.</p><p class="ops-note">${SOURCE_TEXT}.</p>`;
  if (data.error) return `<p class="ops-empty">Road data did not load (${escapeHtml(data.error)}). It tries again by itself.</p><p class="ops-note">${SOURCE_TEXT}.</p>`;
  return subsections.map((sub) => `<div class="access-sub" data-access="${sub.id}">${sub.html(data)}</div>`).join('');
}

export const accessSectionHtml = (data) => `<div class="ops-access" data-ops-access>${accessBodyHtml(data)}</div>`;

// ---- Keeping it up to date ----

let overlay = null;
// The map's dots and lines (see accessmap.js), set up by main.js: { show(shapes), hide() }.
export const setAccessOverlay = (value) => {
  overlay = value;
};

let session = null;

const ask = async (ident, signal) => {
  const res = await fetch(`${PROXY_URL}/access/roads?airport=${encodeURIComponent(ident)}`, { signal });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `answered ${res.status}`);
  return body;
};

function stopPolling() {
  if (!session) return;
  // Called as plain functions: the browser's timers refuse to be called as methods of another object.
  const { clearTimer, timer } = session;
  if (timer != null) clearTimer(timer);
  session.timer = null;
  session.controller?.abort();
  session.controller = null;
  session.overlay?.hide();
}

// Draws the section and the part's fact in the strip again in place, and the map.
function refresh() {
  if (!session?.ident) return;
  const { root, api } = session;
  let ctx;
  try {
    ctx = api.getContext();
  } catch {
    return;
  }
  if (!ctx?.airport || ctx.airport.ident !== session.ident) return;
  const data = analyseAccess({ airport: ctx.airport, now: ctx.now ?? Date.now(), result: session.result });
  const inner = root.querySelector('.ops-access');
  if (inner) inner.innerHTML = accessBodyHtml(data);
  const item = root.querySelector('.ops-strip li[data-part="access"]');
  const fact = accessFact(data);
  if (item && fact) item.outerHTML = factItemHtml(accessPart, fact);
  if (data.data && !data.old) session.overlay?.show(mapShapes(data.data));
  else session.overlay?.hide();
}

async function poll() {
  const state = session;
  if (!state?.ident || state.busy) return;
  const ident = state.ident;
  state.busy = true;
  const controller = new AbortController();
  state.controller = controller;
  const { signal } = controller;
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const body = await state.ask(ident, signal);
    if (session !== state || state.ident !== ident) return;
    state.result = body.available === false ? { state: 'unavailable', reason: body.reason } : { state: 'ok', data: body };
  } catch (err) {
    if (session !== state || state.ident !== ident) return;
    const message = signal.aborted ? 'it took too long' : err.message;
    // The last answer stays on screen, said to be the last, until it is too old to use.
    state.result = state.result?.state === 'ok' ? { ...state.result, problem: message } : { state: 'error', error: message };
  } finally {
    clearTimeout(timeout);
    // A poll that was cancelled by a move to another airport does not end the new one's.
    if (state.controller === controller) state.busy = false;
  }
  refresh();
}

// Starts asking for `airport`, if it is not the one asked for; stops for any other. Gives what
// has been found for it so far. Render calls this on every draw, so that opening another airport
// with the tab open moves it along.
function follow(airport) {
  if (!session) return null;
  const ident = airport?.ident ?? null;
  if (ident === session.ident) return session.result;
  stopPolling();
  session.ident = ident;
  session.result = null;
  session.busy = false;
  if (isCovered(airport)) {
    poll();
    const { setTimer } = session;
    session.timer = setTimer(poll, POLL_MS);
  }
  return null;
}

// Called when the Ops tab is shown. `deps` are for tests.
export function bind(root, api, deps = {}) {
  unbind();
  session = {
    root,
    api,
    ident: null,
    result: null,
    busy: false,
    timer: null,
    controller: null,
    overlay: deps.overlay ?? overlay,
    ask: deps.ask ?? ask,
    setTimer: deps.setTimer ?? setInterval,
    clearTimer: deps.clearTimer ?? clearInterval,
  };
  follow(api.getContext()?.airport);
}

// Called when the tab goes, or the panel closes: nothing is asked or drawn after.
export function unbind() {
  if (!session) return;
  stopPolling();
  session = null;
}

// Stops looking at the airport now, as another one is being opened.
export function releaseAccess() {
  if (!session) return;
  stopPolling();
  session.ident = null;
  session.result = null;
}

export const accessPart = {
  id: 'access',
  // The topic tab it belongs to once the Ops view is split into tabs; its polling and its map overlay
  // live only between bind and unbind, so they follow that tab.
  tab: 'access',
  title: 'Access',
  factLabel: 'Access',
  needs: ['airport', 'now'],
  analyse: (ctx) => analyseAccess({ airport: ctx.airport, now: ctx.now, result: follow(ctx.airport) }),
  fact: accessFact,
  html: accessSectionHtml,
  bind,
  unbind,
};
