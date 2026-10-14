// The Ops view's storms and lightning part: a small compass of the nearest lightning, the numbers
// behind it, and what the forecast says of thunderstorms; and the keeping of it up to date while the
// tab is open (the lightning monitor, and the rings and image on the map). It is a part for ops.js.
import { escapeHtml } from './airportview.js';
import { LightningMonitor, RING_KM, isCovered, loadFrameImage, makeGeometry } from './lightning.js';
import { LEVEL_STATUS, analyseLightning, lightningFact, motionLine, trendText } from './opslightning.js';

// The compass is drawn 200 units wide, the airport in the middle and the outer ring (30 km) at
// SCALE units a kilometre. Lightning beyond it is cut off at the edge.
const MID = 100;
const SCALE = 80 / RING_KM.at(-1);
const EDGE = 88;
// The size on the compass of the biggest cell (km): the window the images show is 60 km each way.
const MAX_CELL_KM = 40;
const OVERLAY_RINGS = RING_KM.slice(0, 3);

const point = (x, y) => [MID + x * SCALE, MID - y * SCALE];
const at = (bearing, km) => point(km * Math.sin((bearing * Math.PI) / 180), km * Math.cos((bearing * Math.PI) / 180));
const n1 = (v) => Math.round(v * 10) / 10;

// The compass: the rings, the cells of the newest image (drawn as circles of their area, only a
// sketch) with a dot where each is nearest the airport, and an arrow for the nearest cell's way.
export function compassSvg(result) {
  const frame = result.frames.at(-1);
  const status = `status-${LEVEL_STATUS[result.status.level]}`;
  const rings = RING_KM.map((km) => `<circle class="lc-ring" cx="${MID}" cy="${MID}" r="${km * SCALE}" /><text class="lc-label" x="${MID + 2}" y="${MID - km * SCALE - 1.5}">${km}</text>`).join('');
  const letters = [['N', 0], ['E', 90], ['S', 180], ['W', 270]]
    .map(([letter, bearing]) => {
      const [x, y] = at(bearing, RING_KM.at(-1) + 5.5);
      return `<text class="lc-compass" x="${n1(x)}" y="${n1(y + 3)}" text-anchor="middle">${letter}</text>`;
    })
    .join('');
  const cells = frame.cells
    .map((c) => {
      const [x, y] = point(c.x, c.y);
      const radius = Math.min(MAX_CELL_KM, Math.sqrt(c.areaKm2 / Math.PI)) * SCALE;
      return `<circle class="lc-cell" cx="${n1(x)}" cy="${n1(y)}" r="${n1(radius)}" />`;
    })
    .join('');
  const dots = frame.cells
    .map((c) => {
      const [x, y] = at(c.nearestBearing, c.nearestKm);
      return `<circle class="lc-near" cx="${n1(x)}" cy="${n1(y)}" r="2.6" />`;
    })
    .join('');
  const { motion } = result;
  const lead = frame.cells[0];
  let arrow = '';
  if (lead && motion.headingDeg != null && ['approaching', 'passing', 'receding'].includes(motion.state)) {
    // Ten minutes of its movement.
    const km = (motion.speedKmh / 60) * 10;
    const rad = (motion.headingDeg * Math.PI) / 180;
    const [x0, y0] = point(lead.x, lead.y);
    const [x1, y1] = point(lead.x + km * Math.sin(rad), lead.y + km * Math.cos(rad));
    arrow = `<line class="lc-arrow" x1="${n1(x0)}" y1="${n1(y0)}" x2="${n1(x1)}" y2="${n1(y1)}" marker-end="url(#lc-head)" />`;
  }
  const label = `Lightning around the airport, rings at ${RING_KM.join(', ')} km: ${result.status.text}`;
  return `<svg class="lightning-compass ${status}" viewBox="0 0 200 200" role="img" aria-label="${escapeHtml(label)}">
    <defs><clipPath id="lc-clip"><circle cx="${MID}" cy="${MID}" r="${EDGE}" /></clipPath><marker id="lc-head" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0L6 3L0 6z" fill="currentColor" /></marker></defs>
    <line class="lc-axis" x1="${MID}" y1="${MID - EDGE}" x2="${MID}" y2="${MID + EDGE}" /><line class="lc-axis" x1="${MID - EDGE}" y1="${MID}" x2="${MID + EDGE}" y2="${MID}" />
    <g clip-path="url(#lc-clip)">${cells}</g>${rings}${arrow}${dots}${letters}
    <circle class="lc-airport" cx="${MID}" cy="${MID}" r="3.2" />
  </svg>`;
}

function ringsTableHtml(rings) {
  const rows = rings.map((r) => `<tr><th scope="row">${r.km} km</th><td>${r.areaKm2 ? `${Math.round(r.areaKm2)} km²` : 'none'}</td><td>${r.peak || ''}</td></tr>`).join('');
  return `<table class="lightning-rings"><caption>Newest image, within each distance</caption><thead><tr><th scope="col">Within</th><th scope="col">Active area</th><th scope="col">Peak intensity</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function forecastHtml(data) {
  const { risk, fields } = data;
  if (!risk) return '<p class="ops-note">The forecast loaded for this airport has no thunderstorm fields (weather code, CAPE), so no thunderstorm risk can be given from it.</p>';
  const basis = `from the forecast's ${fields.map((f) => ({ weather_code: 'weather code', cape: 'CAPE' })[f]).join(', ')}`;
  return `<p class="lightning-risk"><b>Forecast:</b> ${escapeHtml(risk.text)} <span class="ops-note">(${escapeHtml(basis)})</span></p>`;
}

// The inside of the section; what is drawn again when the lightning changes.
export function lightningInnerHtml(data, ctx = {}) {
  const r = data.lightning;
  const zone = ctx.zone ? `<p class="ops-zone">Local time, ${escapeHtml(ctx.zone)}</p>` : '';
  const forecast = forecastHtml(data);
  if (data.loading) return `${zone}<p>Loading lightning data from the Meteosat Lightning Imager…</p>${forecast}`;
  if (r.state === 'uncovered') {
    return `<p>The Meteosat Lightning Imager does not see this airport: it covers Europe, Africa and the Atlantic, up to about 70° from 0° N, 0° E. There is no lightning data here.</p>${forecast}`;
  }
  if (r.state === 'unavailable') {
    return `${zone}<p>No lightning data right now. ${escapeHtml(r.problem ?? '')}</p>${forecast}<p class="ops-note">It tries again by itself.</p>`;
  }
  const old = r.stale ? `<p class="lightning-old"><b>The lightning data is ${r.behindMin} min old and says nothing of now.</b> Do not take it for an all clear.</p>` : '';
  const move = r.stale ? '' : motionLine(r);
  const lines = [r.status.text, move, r.status.hold].filter(Boolean);
  const [head, ...rest] = lines;
  const attribution = `${escapeHtml(r.attribution)}. Intensity is read from the colours of EUMETSAT's flash map, so it is rough; the map counts flashes per pixel of each flash's footprint, which is not a flash count.`;
  return `${zone}
    ${old}
    <div class="lightning-body">
      ${compassSvg(r)}
      <div class="lightning-text">
        <p class="lightning-head">${escapeHtml(head)}</p>
        ${rest.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}
        <p>${escapeHtml(trendText(r.trend))}.</p>
        <p class="ops-note">${escapeHtml(r.status.dataText.replace(/^./, (c) => c.toUpperCase()))}.${r.problem ? ` ${escapeHtml(r.problem)}` : ''}</p>
      </div>
    </div>
    ${ringsTableHtml(r.rings)}
    ${forecast}
    <p class="ops-note">${attribution}</p>`;
}

export function lightningSectionHtml(data, ctx) {
  return `<div class="ops-lightning">${lightningInnerHtml(data, ctx)}</div>`;
}

// ---- Keeping it up to date ----

let overlay = null;
// The map's rings and image (see lightningmap.js), set up by main.js: { show({ geometry, image }), hide() }.
export const setLightningOverlay = (value) => {
  overlay = value;
};

// Stops looking at the airport now, as another one is being opened, without waiting for the panel to
// be drawn for it: nothing more is fetched for the old airport and its rings and image go.
export function releaseLightning() {
  halt();
}

// The session: { api, root, watching, paused, key, airport, startTimer, result, geometry, overlay, covers,
// images, monitor }. It runs while the part is bound (its tab is shown, with `root` and the map's
// rings and image) or watching (summary mode: the same images and monitor, nothing drawn on the map
// or in a section). It is paused while the page is hidden.
let bound = null;

// In summary mode the monitor starts this long after an airport is opened, so that flicking through
// airports asks for nothing. With the tab shown it starts at once.
export const START_DELAY_MS = 1500;

// The monitor, with the newest image of each airport it has looked at, is made once and kept
// between binds: opening the tab again at an airport only asks for what is new. Both are bounded
// (see LightningMonitor's maxAirports and MAX_IMAGES).
let shared = null;
const MAX_IMAGES = 4;

const keyOf = (airport) => `${airport.lat},${airport.lng}`;
const safe = (fn) => {
  try {
    return fn();
  } catch {
    return null;
  }
};

function keepImage(images, key, time, image) {
  if (images.get(key)?.time > time) return;
  images.delete(key);
  images.set(key, { time, image });
  while (images.size > MAX_IMAGES) images.delete(images.keys().next().value);
}

function makeHolder(deps) {
  const images = new Map();
  const load = deps.loadImage ?? loadFrameImage;
  // The images go into the map's keeping for the airport they were asked for.
  const options = {
    onUpdate: (result) => update(result),
    loadImage: async (url) => {
      const key = bound?.key;
      const image = await load(url);
      if (key != null) keepImage(images, key, Date.parse(new URL(url).searchParams.get('time')), image);
      return image;
    },
  };
  return { images, monitor: deps.createMonitor ? deps.createMonitor(options) : new LightningMonitor(options) };
}

// Whether the rings and image are drawn: the tab is shown and its map profile turns them on.
function mapOn(state) {
  if (!state.root) return false;
  const profile = state.api.mapProfile?.();
  return profile ? profile.lightning : true;
}

function showOverlay(state) {
  if (mapOn(state)) state.overlay?.show({ geometry: state.geometry, image: state.images.get(state.key)?.image ?? null });
}

// Starts the monitor for the airport being followed: at once with the tab shown, after a short wait
// in summary mode; not at all while the page is hidden (it starts when the page is shown again).
function startLooking() {
  const state = bound;
  if (!state || state.key === null || state.paused) return;
  state.clearTimer(state.startTimer);
  state.startTimer = null;
  const go = () => {
    state.startTimer = null;
    if (bound === state && state.key !== null && !state.paused) state.monitor.start(state.airport);
  };
  if (state.root || !state.delayMs) go();
  else state.startTimer = state.setTimer(go, state.delayMs);
}

// The page is hidden: nothing is fetched meanwhile. Shown again: it goes on.
function onVisibility() {
  const state = bound;
  if (!state) return;
  if (globalThis.document?.hidden) {
    state.paused = true;
    state.clearTimer(state.startTimer);
    state.startTimer = null;
    if (state.key !== null) state.monitor.stop();
  } else if (state.paused) {
    state.paused = false;
    startLooking();
  }
}

// Stops looking and takes the map's part away, if an airport is being looked at.
function halt() {
  if (!bound || bound.key === null) return;
  bound.clearTimer(bound.startTimer);
  bound.startTimer = null;
  bound.monitor.stop();
  bound.key = null;
  bound.result = null;
  bound.overlay?.hide();
}

// Starts looking at `airport`, if it is not the one already looked at; stops when the images do not
// cover it. Gives what has been found for it so far. Render calls this on every draw, so that
// opening another airport with the tab open moves it along.
function follow(airport) {
  if (!bound || !Number.isFinite(airport?.lat)) return null;
  const key = keyOf(airport);
  if (bound.key === key) return bound.result;
  halt();
  if (!bound.covers(airport.lat, airport.lng)) return null;
  bound.key = key;
  bound.airport = { lat: airport.lat, lon: airport.lng };
  bound.geometry = makeGeometry(airport.lat, airport.lng);
  showOverlay(bound);
  startLooking();
  return null;
}

// A result came in: draws the section if the tab is shown, and the summary line, and the map.
function update(result) {
  const state = bound;
  if (!state || state.key === null) return;
  const ctx = safe(() => state.api.getContext());
  // Another airport, or none, is open now (or none is any longer: the panel closed).
  if (!ctx?.airport || keyOf(ctx.airport) !== state.key) {
    halt();
    return;
  }
  state.result = result;
  if (state.root) {
    const data = analyseLightning({ airport: ctx.airport, hourly: ctx.hourly, now: ctx.now, result });
    const inner = state.root.querySelector('[data-part="lightning"] .ops-lightning');
    if (inner) inner.innerHTML = lightningInnerHtml(data, ctx);
    showOverlay(state);
  }
  state.api.refreshSummary?.();
}

function open(api, deps) {
  const holder = deps.createMonitor ? makeHolder(deps) : (shared ??= makeHolder(deps));
  bound = {
    root: null,
    api,
    watching: false,
    paused: globalThis.document?.hidden === true,
    key: null,
    airport: null,
    startTimer: null,
    delayMs: deps.delayMs ?? START_DELAY_MS,
    setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: deps.clearTimer ?? ((timer) => clearTimeout(timer)),
    result: null,
    geometry: null,
    overlay: deps.overlay ?? overlay,
    covers: deps.covers ?? isCovered,
    ...holder,
  };
  globalThis.document?.addEventListener?.('visibilitychange', onVisibility);
}

// Called when the panel is open on another tab: the lightning is looked at for the summary line,
// with nothing drawn. `deps` are for tests.
export function watch(api, deps = {}) {
  if (!bound) open(api, deps);
  bound.watching = true;
}

export function unwatch() {
  if (!bound) return;
  bound.watching = false;
  if (!bound.root) end();
}

// Called when the Weather tab is shown: the section and the map are kept up to date. `deps` are
// for tests.
export function bind(root, api, deps = {}) {
  if (!bound?.watching) unbind();
  if (!bound) open(api, deps);
  bound.root = root;
  bound.api = api;
  // An airport already looked at for the summary line gets its rings and image now, and no more waiting.
  if (bound.key !== null) {
    showOverlay(bound);
    if (bound.startTimer) startLooking();
  }
}

// Called when the tab goes: the map is cleared, and the lightning is looked at no longer unless the
// summary line still watches it.
export function unbind() {
  if (!bound) return;
  if (bound.root) bound.overlay?.hide();
  bound.root = null;
  if (!bound.watching) end();
}

// Nothing is fetched or drawn after.
function end() {
  halt();
  globalThis.document?.removeEventListener?.('visibilitychange', onVisibility);
  bound = null;
}

export const lightningPart = {
  id: 'lightning',
  tab: 'weather',
  overlay: 'lightning',
  title: 'Storms and lightning',
  factLabel: 'Lightning',
  needs: ['airport', 'hourly', 'now', 'zone'],
  analyse: (ctx) => analyseLightning({ airport: ctx.airport, hourly: ctx.hourly, now: ctx.now, result: follow(ctx.airport) }),
  fact: lightningFact,
  html: lightningSectionHtml,
  bind,
  unbind,
  watch,
  unwatch,
  release: releaseLightning,
};
