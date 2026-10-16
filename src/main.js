import Globe from 'globe.gl';
import { LAYERS, getLayer, describeWeatherCode } from './layers.js';
import {
  FORECAST_DAYS,
  GRID_STEP,
  gridShape,
  apiBudget,
  isRegionCached,
  precipitationRate,
  loadForecast,
  loadPointForecast,
  loadRegion,
  cloudTimes,
  parseTime,
  seriesHours,
  startIndex,
} from './weather.js';
import { FieldOverlay, covers, fillPoleRows, padPoles, sampleGrid } from './field.js';
import { RESTING_STEPS_PER_SECOND, SMALL_WIDTH, STEPS_PER_SECOND, WIDTH, WindFlow, windGrids } from './flow.js';
import { ScreenFlow } from './screenflow.js';
import { HAZARDS, hazardRings, reuseRings } from './patterns.js';
import { DETAIL_ALTITUDE, needsNewRegion, regionFor, viewBounds } from './detail.js';
import { BASEMAPS, setupBasemap, setupMapFeatures } from './map.js';
import { buildTimeline, forecastPosition, samePlace, stepNearest } from './timeline.js';
import { setupSearch } from './search.js';
import { airportPanelWeather, conditionsAt, loadAirports, searchAirports } from './airports.js';
import { airportDetailsHtml, airportPlace, panelStays, verdictText } from './airportview.js';
import { setupWindCheck } from './windcheck.js';
import { DETAIL_TABS, createOpsHost, isTopicTab, readTab, saveTab, tabAfterKey } from './ops.js';
import { formatClock, formatClockShort, formatTick, zoneName } from './opsclock.js';
import { afterDeselect, backAction, escapeAction, opsKeepsWatching, opsReturnFor } from './opsreturn.js';
import { setLightningOverlay } from './opslightningview.js';
import { setupLightningOverlay } from './lightningmap.js';
import { setAccessOverlay } from './opsaccessview.js';
import { setupAccessOverlay } from './accessmap.js';
import { STATUS, assessAirport } from './runways.js';
import { TRAFFIC_LEGEND, setupTraffic } from './traffic.js';
import { AIRPORT_ALTITUDE, airportFlightAltitude, setupAirportMap } from './airportmap.js';
import { DragTracker, dragged, followStep, startFollow, stopReason, sideShift, visibleShift } from './follow.js';
import { setupPilotView, trafficPov } from './pilotview.js';
import { CARD_REFRESH_MS, cardText, focusTarget, followLayout, freeArea, spokenDue, spokenText } from './followcard.js';
import { latestObservation } from './metar.js';
import { latestTaf } from './taf.js';
import { explain } from './api.js';
import { FrameBudget, FrameLoop, FrameMeter, busyNow, pixelRatio, playStep, unattended } from './pacing.js';
import { onPhone, phoneLandscape, phoneLayout, setupPhoneLayout } from './phonelayout.js';

// Timeline playback speed: three hours of forecast a second, whatever the forecast's step.
const PLAY_HOURS_PER_SECOND = 3;
// While the timeline plays, the moving clouds load the images for this many hours ahead (see
// cloudTimes), two seconds' worth.
const CLOUD_LOOKAHEAD_HOURS = 2 * PLAY_HOURS_PER_SECOND;
// Seconds for the colour field to fade in after switching layers.
const LAYER_FADE = 0.9;
// Controls fade away after this long without interaction, leaving just the globe.
const IDLE_MS = 4000;
// Minimum gap between fetches of zoomed-in detail, to stay within the free API's limits.
const REGION_FETCH_INTERVAL_MS = 4000;
// Wait before retrying a failed forecast load.
const RETRY_MS = 20_000;
// API locations kept free for tapping on the map, so zoomed-in detail never uses them up.
const POINT_RESERVE = 20;
// How long zoomed-in detail waits before retrying when the API budget is low.
const REGION_RETRY_MS = 15_000;
// How long the airport panel waits for its forecast before it falls back to the site's own copy
// (the request carries on and still fills the panel in if it answers later). One request to
// Open-Meteo gives up after 30 s and the Power Globe API gets its turn after that, but Open-Meteo
// requests also queue one behind another, so the panel's can start late.
const AIRPORT_WEATHER_TIMEOUT_MS = 45_000;
// How often the zoomed-in detail follows a moving camera.
const REGION_FOLLOW_MS = 400;
// Seconds for zoomed-in detail to fade in once it arrives.
const REGION_FADE = 0.8;
const IMAGE_BASE = `${import.meta.env.BASE_URL}img`;
const NO_OVERLAY = { key: 'none', label: 'None' };

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const largeScreen = window.innerWidth * window.devicePixelRatio >= 1400;
const narrowScreen = phoneLayout.matches;

const els = {
  globe: document.getElementById('globe'),
  layerButtons: document.getElementById('layer-buttons'),
  basemapButtons: document.getElementById('basemap-buttons'),
  basemapCredit: document.getElementById('credit-basemap'),
  legend: document.getElementById('legend'),
  patternLegend: document.getElementById('pattern-legend'),
  wind: document.getElementById('toggle-wind'),
  hazards: document.getElementById('toggle-hazards'),
  status: document.getElementById('status'),
  refresh: document.getElementById('refresh'),
  details: document.getElementById('details'),
  detailsTitle: document.getElementById('details-title'),
  detailsSummary: document.getElementById('details-summary'),
  detailsTabs: document.getElementById('details-tabs'),
  detailsBody: document.getElementById('details-body'),
  detailsClose: document.getElementById('details-close'),
  playIcon: document.getElementById('play-icon'),
  playText: document.getElementById('play-text'),
  announcer: document.getElementById('announcer'),
  timeline: document.getElementById('timeline'),
  credits: document.querySelector('.attribution'),
  play: document.getElementById('play'),
  slider: document.getElementById('time-slider'),
  timeLabel: document.getElementById('time-label'),
  now: document.getElementById('now'),
  cloudsLoop: document.getElementById('clouds-loop'),
  caption: document.getElementById('caption'),
  controls: document.getElementById('controls'),
  controlsToggle: document.getElementById('controls-toggle'),
  controlsBody: document.getElementById('controls-body'),
  searchInput: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),
  searchStatus: document.getElementById('search-status'),
  detailsBack: document.getElementById('details-back'),
  detailsFollow: document.getElementById('details-follow'),
  detailsPilot: document.getElementById('details-pilot'),
  detailsMinimise: document.getElementById('details-minimise'),
  followCard: document.getElementById('follow-card'),
  followCardOpen: document.getElementById('follow-card-open'),
  followCardName: document.getElementById('follow-card-name'),
  followCardLine: document.getElementById('follow-card-line'),
  followCardStop: document.getElementById('follow-card-stop'),
  followCardPilot: document.getElementById('follow-card-pilot'),
  followCardLive: document.getElementById('follow-card-live'),
  creditsToggle: document.getElementById('credits-toggle'),
  traffic: {
    flights: document.getElementById('toggle-flights'),
    military: document.getElementById('toggle-military'),
    satellites: document.getElementById('toggle-satellites'),
    group: document.getElementById('satellite-group'),
    groupRow: document.getElementById('satellite-group-row'),
    status: document.getElementById('traffic-status'),
    legend: document.getElementById('traffic-legend'),
    credits: {
      flights: document.getElementById('credit-flights'),
      satellites: document.getElementById('credit-satellites'),
      adsbName: document.getElementById('credit-adsb'),
    },
  },
  windCheckOpen: document.getElementById('windcheck-open'),
  windCheckClose: document.getElementById('windcheck-close'),
  windCheck: {
    panel: document.getElementById('windcheck'),
    preset: document.getElementById('limits-preset'),
    crosswind: document.getElementById('limit-crosswind'),
    tailwind: document.getElementById('limit-tailwind'),
    marginal: document.getElementById('windcheck-marginal'),
    limitsSummary: document.getElementById('limits-summary'),
    order: document.getElementById('windcheck-order'),
    status: document.getElementById('windcheck-status'),
    retry: document.getElementById('windcheck-retry'),
    summary: document.getElementById('windcheck-summary'),
    list: document.getElementById('windcheck-list'),
  },
};

const state = {
  layer: getLayer('temperature'),
  // Whether the weather layer is drawn at all, or just the map. It starts as just the map
  // ("None"); picking a layer turns it on.
  overlay: false,
  forecast: null,
  winds: null,
  // Fractional index into timeline.times; the field and wind blend between neighbouring steps.
  t: 0,
  // The timeline: the forecast's times, after the past day's in the Clouds view (see timeline.js).
  timeline: null,
  // The clouds loop's status as last shown ('loading', 'playing', 'failed' or null).
  loopStatus: null,
  playing: false,
  // Whether the play is the one the page starts by itself, which plays the forecast once.
  autoplay: false,
  // Step whose discrete layers (the storm rings) are currently drawn.
  drawnStep: -1,
  // The storm rings the globe shows, kept so that unchanged ones are not given to it again.
  rings: [],
  // Hours between the forecast's steps: 1, or 3 for an older copy of the site's data.
  stepHours: 1,
  dirty: true,
  // 0..1 progress of the colour field fading in after a layer change.
  fieldFade: 0,
  // Open details: a spot { lat, lng, data } or an airport { airport, hourly, fromList }.
  detail: null,
  // The airport panel's tab: 'details', 'weather', 'traffic' or 'access' (see ops.js); remembered per browser.
  detailTab: readTab(),
  // The airport detail to go back to from an aircraft picked while one of its topic tabs was open, or null.
  // The airport keeps being watched meanwhile (see opstrafficview.js).
  opsReturn: null,
  // Whether the wind check is in use: its panel is open, or one of its airports is.
  windCheck: false,
  // Zoomed-in area with finer data: { shape, bounds, data, winds, times, fade }, or null.
  region: null,
  // The aircraft the camera is following, see follow.js, or null.
  follow: null,
  // On phones: whether the full panel was asked for while following, instead of the small card.
  followExpanded: false,
  autoRotate: !reducedMotion,
  // Whether the globe has stopped turning because nobody has used the page for a while (see pacing.js).
  resting: false,
};

// On phones the controls start folded so the globe gets the screen.
if (onPhone()) setControlsOpen(false);

const fmt = (value, unit) => (value == null ? '–' : `${Math.round(value * 10) / 10} ${unit}`);

// A time in milliseconds, as formatTime writes it.
const formatMs = (ms) => formatTime(new Date(ms).toISOString().slice(0, 16));

const formatTime = (time) =>
  new Date(parseTime(time)).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

// Severe weather rings: how far (degrees) and how fast (degrees a second) each pulse spreads.
const RING_MAX_RADIUS = 4;
const RING_SPEED = 1.4;
const globe = new Globe(els.globe, { animateIn: !reducedMotion })
  .backgroundColor('rgba(0, 0, 0, 0)')
  .atmosphereColor('#8ec5ff')
  .atmosphereAltitude(0.22)
  // Severe weather: slow, soft pulses
  .ringColor((d) => (t) => `rgba(${HAZARDS[d.kind].rgb}, ${0.7 * (1 - t) ** 2})`)
  .ringMaxRadius(RING_MAX_RADIUS)
  .ringPropagationSpeed(RING_SPEED)
  .ringRepeatPeriod(2400)
  // Drawn after the colour field and wind layers, which do not write depth, so they show on top.
  .ringAltitude(0.0008)
  .onGlobeClick(({ lat, lng }) => !pickedTraffic() && showDetails(lat, lng));

// Fewer pixels on high-density screens (see pacing.js), read again when the window changes size
// (or moves to another screen). The post-processing composer keeps its own copy of the ratio for
// its buffers.
function applyPixelRatio() {
  const ratio = pixelRatio();
  if (globe.renderer().getPixelRatio() === ratio) return;
  globe.renderer().setPixelRatio(ratio);
  globe.postProcessingComposer?.()?.setPixelRatio?.(ratio);
}
applyPixelRatio();

// globe.gl draws the globe on every frame the screen shows. Instead, `tick` draws it, only as
// often as the frame budget allows (see pacing.js): globe.gl looks up its `_animationCycle` on
// the globe each time it asks for the next frame, so with a stand-in that does nothing its own
// loop stops after the frame in flight, and the original draws one frame (controls, tweens, the
// scene and the HTML labels) when called. pauseAnimation and resumeAnimation, which also pause the
// globe's layers (the pulsing rings), keep working. Without that method, globe.gl keeps drawing
// on its own.
const drawGlobe = typeof globe._animationCycle === 'function' ? globe._animationCycle : null;
if (drawGlobe) globe._animationCycle = () => {};
else console.warn('globe.gl has no _animationCycle: it draws every frame itself, and frame pacing is off.');
const budget = new FrameBudget(performance.now());
const meter = new FrameMeter();
// `tick` runs on the screen's frames, except while the frames due are far apart (see wakeAt in
// pacing.js): the page then sleeps until shortly before the next one due, and input, or anything
// else that brings the full rate back, wakes it at once (see wakeFrames).
const frames = new FrameLoop(tick, (now) => budget.wakeAt(now, frameMode));
const wakeFrames = () => frames.wake();
// Until when the camera is flying somewhere (see goToAirport).
let cameraFlightUntil = 0;
let frameMode = 'active';
// three-globe runs loops of its own on every frame the screen shows, whatever the frame budget:
// one for its tweens (the globe's animate-in and the rings' pulses) and one for each of the arcs,
// paths and rings layers. Only the rings and the animate-in need them: there are no arcs, the
// borders (paths) do not move, the labels and borders change without transitions, and the
// camera's flights are globe.gl's own tweens, which drawGlobe runs. So they run only while the
// globe animates in and while there are rings (and a pulse after, while the last ones fade), and
// not at all while the pilot view covers the globe.
const GLOBE_INTRO_MS = 1500; // the animate-in, 1.2 s, from when the globe is ready
// A ring's pulse, with a little to spare, so the last ones finish fading before the loops stop.
const RING_FADE_MS = Math.ceil((RING_MAX_RADIUS / RING_SPEED) * 1000) + 200;
// Until the globe is ready, or 20 s, should it never say so.
let globeIntroUntil = performance.now() + 20_000;
let ringsUntil = 0;
let globeCovered = false;
let globeAnimates = true;
globe.onGlobeReady(() => {
  globeIntroUntil = performance.now() + (reducedMotion ? 0 : GLOBE_INTRO_MS);
});
function syncGlobeAnimation(now) {
  if (state.rings.length) ringsUntil = now + RING_FADE_MS;
  const animate = !globeCovered && (now < globeIntroUntil || now < ringsUntil);
  if (animate === globeAnimates) return;
  globeAnimates = animate;
  if (animate) globe.resumeAnimation();
  else globe.pauseAnimation();
}
// For checking what the page is doing, in the browser's console.
window.__powerGlobe = { fps: () => meter.fps(performance.now()), mode: () => frameMode };

const BASEMAP_KEY = 'power-globe:basemap';
state.basemap = (() => {
  try {
    const saved = localStorage.getItem(BASEMAP_KEY);
    return BASEMAPS[saved] ? saved : 'satellite';
  } catch {
    return 'satellite';
  }
})();
const basemap = setupBasemap(globe, `${IMAGE_BASE}/earth-blue-marble.jpg`, {
  initial: state.basemap,
  onCredit: (html) => {
    els.basemapCredit.innerHTML = html;
  },
  onClouds: () => {
    renderCaption();
    renderCloudsLoop();
  },
});
const mapFeatures = setupMapFeatures(globe);
const traffic = setupTraffic({
  globe,
  els: els.traffic,
  onSelect: (item, title) => showTraffic(item, title),
  onDeselect: () => {
    stopFollowing();
    const next = afterDeselect(state);
    if (!next) return;
    // The aircraft's panel goes, and the way back to an airport's tab with it: what the airport watched stops.
    const returning = state.opsReturn;
    Object.assign(state, next);
    els.details.classList.add('hidden');
    syncDetailTabs();
    if (returning) airportMap.select(null);
  },
  onFlightEnds: (ends) => mapFeatures.setFlightEnds(ends),
  announce: (message) => announce(message),
  // Moves of the view without input (auto-rotate) wait for the next poll, and an unattended page polls less.
  lastInput: () => budget.lastInput,
});

// The outside view from the selected aircraft. The globe stops drawing while it is open; the
// traffic keeps being updated, so the aircraft's reports keep coming (see pilotview.js).
const pilot = setupPilotView({
  els: {
    root: document.getElementById('pilot'),
    map: document.getElementById('pilot-map'),
    title: document.getElementById('pilot-title'),
    status: document.getElementById('pilot-status'),
    terrain: document.getElementById('pilot-terrain'),
    terrainCredit: document.getElementById('pilot-terrain-credit'),
    close: document.getElementById('pilot-close'),
    button: els.detailsPilot,
    cardButton: els.followCardPilot,
    detailsClose: els.detailsClose,
    hud: {
      alt: document.getElementById('pilot-alt'),
      altUnit: document.getElementById('pilot-alt-unit'),
      gs: document.getElementById('pilot-gs'),
      trk: document.getElementById('pilot-trk'),
    },
  },
  traffic,
  background: () => [...document.body.children].filter((el) => !['pilot', 'announcer'].includes(el.id) && el.tagName !== 'SCRIPT'),
  onOpen: () => {
    // The clouds loop is for the globe, which the pilot view covers.
    stopCloudsLoop();
    globeCovered = true;
    syncGlobeAnimation(performance.now());
  },
  onClose: () => {
    globeCovered = false;
    syncGlobeAnimation(performance.now());
  },
  // Where focus goes when the view closes and the button it was opened from is not on screen.
  afterClose: () => {
    if (!traffic.selectedAircraft()) return els.globe;
    if (followLayoutNow === 'card') return els.followCardPilot;
    return els.details.classList.contains('hidden') ? els.globe : null;
  },
  announce: (message) => announce(message),
});
const windCheck = setupWindCheck({
  els: els.windCheck,
  getTime: () => currentTime(),
  // Airports near the middle of the view are checked first.
  getCenter: () => globe.pointOfView(),
  formatTime: (time) => formatTime(time),
  // Its airports are worked out only while it is in use: its panel is open, or one of its airports is.
  inUse: () => state.windCheck,
  onSelect: (airport) => goToAirport(airport, { fromList: true }),
  // Airports with wind trouble are marked on the map while the wind check is in use; zoomed
  // in, their airfield labels show it instead (see airportmap.js).
  onProblems: (problems) => {
    state.problems = state.windCheck ? problems : [];
    mapFeatures.setAirports(state.problems, (airport) => {
      pickedAt = performance.now();
      goToAirport(airport, { fromList: state.windCheck });
    });
    airportMap.refresh();
  },
  onLimitsChange: () => {
    renderDetails();
    airportMap.refresh();
  },
});// Zoomed in to airports: runways coloured by whether they can be used in the wind.
const airportMap = setupAirportMap({
  globe,
  mapFeatures,
  getTime: () => currentTime(),
  getLimits: () => windCheck.limits(),
  getProblems: () => state.problems ?? [],
  onSelect: (airport) => {
    // A tap on a label should not also open the weather where it landed.
    pickedAt = performance.now();
    goToAirport(airport, { stayClose: true });
  },
});

// The lightning part draws its rings and image on the map, while the Weather tab is open, through this.
setLightningOverlay(setupLightningOverlay(globe));
// The Ops tab's access part draws the road traffic through this: dots at the measurement sites, lines for jams and closures.
setAccessOverlay(setupAccessOverlay(globe));

// What the traffic part reads from the page and asks of it (see opstrafficview.js).
const opsTraffic = {
  subscribe: traffic.subscribe,
  watchArea: traffic.watchArea,
  aircraft: traffic.aircraft,
  layerOn: traffic.layerOn,
  // What to mark on the map: the aircraft and stacks on the globe, the runways in use on the airport map.
  setOverlay(overlay) {
    traffic.setOverlay(overlay);
    airportMap.setRunwayUse(overlay?.runwayUse?.ident, overlay?.runwayUse?.ends);
  },
  // Selects an aircraft as tapping it on the map does.
  select(id) {
    if (!traffic.has(id)) return false;
    traffic.select({ kind: 'aircraft', id });
    return true;
  },
};

globe.pointOfView({ lat: 22, lng: -25, altitude: narrowScreen ? 3.6 : 2.4 });
const controls = globe.controls();
controls.autoRotate = !reducedMotion;
controls.autoRotateSpeed = 0.22;
controls.enableDamping = true;
controls.dampingFactor = 0.06;
// Stop about 16 km above the ground: above the weather layers, close enough to see runways.
controls.minDistance = globe.getGlobeRadius() * 1.0025;

const shape = gridShape(GRID_STEP);
const field = new FieldOverlay(globe, { shape });
// On a large screen a texel of the wind's canvas spans more pixels, so its trails are drawn a
// little wider (see WIDTH in flow.js).
const flow = new WindFlow(globe, {
  count: largeScreen ? 4500 : 2200,
  width: largeScreen ? WIDTH : SMALL_WIDTH,
  lineWidth: largeScreen ? 1.2 : 1,
});
// Zoomed in, the area in view gets its own sharper layers on top of the global ones.
const initialRegion = regionFor(viewBounds({ lat: 0, lng: 0, altitude: 0.5 }));
const detailField = new FieldOverlay(globe, {
  shape: initialRegion.shape,
  bounds: initialRegion.bounds,
  width: 256,
  height: 256,
  altitude: 0.0012,
  depthBias: 3,
  feather: 0.12,
  renderOrder: -2,
});
// Zoomed-in wind is drawn at screen resolution so it stays crisp at any zoom.
const detailFlow = new ScreenFlow(globe, els.globe, { count: largeScreen ? 2200 : 1400 });
detailField.visible = false;
detailFlow.visible = false;

window.addEventListener('resize', () => {
  applyPixelRatio();
  globe.width(window.innerWidth).height(window.innerHeight);
});

function radioButtons(container, items, activeKey, onSelect) {
  // The buttons are redrawn on every change; keep keyboard focus on the same one.
  const focused = [...container.children].indexOf(document.activeElement);
  container.replaceChildren(
    ...items.map((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item.label;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(item.key === activeKey));
      btn.addEventListener('click', () => onSelect(item.key));
      return btn;
    }),
  );
  if (focused >= 0) container.children[focused]?.focus();
}

function renderControls() {
  // "None" leaves just the map: no colour field (wind and storms have their own toggles).
  radioButtons(els.layerButtons, [...LAYERS, NO_OVERLAY], state.overlay ? state.layer.key : NO_OVERLAY.key, (key) => {
    if (key === NO_OVERLAY.key) {
      if (!state.overlay) return;
      state.overlay = false;
    } else {
      if (state.overlay && key === state.layer.key) return;
      state.overlay = true;
      state.layer = getLayer(key);
      state.fieldFade = 0;
    }
    invalidate();
  });
  radioButtons(
    els.basemapButtons,
    Object.entries(BASEMAPS).map(([key, { label }]) => ({ key, label })),
    state.basemap,
    (key) => {
      state.basemap = key;
      basemap.setStyle(key);
      els.cloudsLoop.hidden = key !== 'clouds';
      rebuildTimeline();
      try {
        localStorage.setItem(BASEMAP_KEY, key);
      } catch {
        // Remembering the map is only a convenience.
      }
      renderControls();
    },
  );
  els.legend.hidden = !state.overlay;

  const { stops, unit } = state.layer;
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  const gradient = stops.map(([v, c]) => `${c} ${((v - min) / (max - min)) * 100}%`).join(', ');
  els.legend.innerHTML = `
    <div class="legend-bar" style="background: linear-gradient(to right, ${gradient})"></div>
    <div class="legend-labels"><span>${min} ${unit}</span><span>${max} ${unit}</span></div>`;

  const items = [];
  if (els.wind.checked) items.push('<span class="swatch streak"></span>Wind particles drift downwind');
  if (els.hazards.checked) {
    for (const { label, rgb } of Object.values(HAZARDS)) {
      items.push(`<span class="swatch ring" style="border-color: rgb(${rgb})"></span>${label}`);
    }
  }
  els.patternLegend.innerHTML = items.map((i) => `<div>${i}</div>`).join('');
  renderCaption();
}

// Swatches for the live traffic layers that are switched on.
function renderTrafficLegend() {
  const on = { Flight: els.traffic.flights.checked, 'Military flight': els.traffic.military.checked };
  const items = TRAFFIC_LEGEND.filter(([kind, , label]) => (kind === 'plane' ? on[label] : els.traffic.satellites.checked));
  els.traffic.legend.innerHTML = items
    .map(([kind, rgb, label]) => {
      const color = `rgb(${rgb.map((c) => Math.round(c * 255)).join(' ')})`;
      const swatch =
        kind === 'plane'
          ? `<svg class="swatch plane" viewBox="-28 -28 56 56" aria-hidden="true"><path fill="${color}" stroke="#000" stroke-width="3" d="M0-28 3.5-22V-8L27 5v5L3.5 4v12l7.5 6v4L0 23l-11 3v-4l7.5-6V4L-27 10V5L-3.5-8v-14z"/></svg>`
          : `<span class="swatch sat" style="background: ${color}"></span>`;
      return `<div>${swatch}${label}</div>`;
    })
    .join('');
}
for (const el of [els.traffic.flights, els.traffic.military, els.traffic.satellites]) el.addEventListener('change', renderTrafficLegend);
renderTrafficLegend();

function renderCaption() {
  const loop = basemap.cloudsLoop();
  if (loop?.status === 'playing') {
    els.caption.textContent = `Clouds · last 12 hours · ${formatMs(loop.frame)}`;
    return;
  }
  const time = state.timeline?.times[Math.round(state.t)];
  const label = state.overlay ? state.layer.label : 'Map';
  // In the forecast part of the timeline the moving clouds stay on the newest image there is.
  const asOf = basemap.cloudsAsOf();
  const clouds = asOf ? ` · clouds as of ${new Date(asOf).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}` : '';
  // Before the forecast the weather layers hold its first hour.
  const weatherOn = state.overlay || els.wind.checked || els.hazards.checked;
  const held = weatherOn && inPast() ? ` · weather shown for ${formatTime(state.forecast.times[0])}` : '';
  els.caption.textContent = time ? `${label} · ${formatTime(time)}${clouds}${held}` : label;
}

// Whether timeline step `step` is in the past day shown before the forecast in the Clouds view.
function inPast(step = Math.round(state.t)) {
  return !!state.timeline && step < state.timeline.past;
}

// The forecast's step for timeline step `step`: the past steps hold the forecast's first.
function forecastStep(step = Math.round(state.t)) {
  return Math.round(forecastPosition(step, state.timeline));
}

// Builds the timeline afresh, with or without the past day for the Clouds view, and keeps its
// place when the new one has the same time; else it goes to the present.
function rebuildTimeline() {
  if (!state.forecast) return;
  const previous = state.timeline;
  state.timeline = buildTimeline(state.forecast.times, { withPast: state.basemap === 'clouds' });
  els.slider.max = String(state.timeline.times.length - 1);
  const place = previous && samePlace(state.t, previous, state.timeline);
  seek(place ?? startIndex(state.timeline.times));
  state.drawnStep = -1;
  els.cloudsLoop.hidden = state.basemap !== 'clouds';
}

// The clouds loop's button, and its progress or image time in place of the timeline's time.
function renderCloudsLoop() {
  const loop = basemap.cloudsLoop();
  const on = loop?.status === 'loading' || loop?.status === 'playing';
  els.cloudsLoop.setAttribute('aria-pressed', String(on));
  els.cloudsLoop.textContent = on && loop.status === 'playing' && reducedMotion ? 'Next image' : 'Last 12 h';
  if (loop?.status === 'loading') els.timeLabel.textContent = `Loading ${Math.round(loop.progress * 100)}%`;
  else if (loop?.status === 'playing') els.timeLabel.textContent = formatMs(loop.frame);
  else if (loop?.status === 'failed') els.timeLabel.textContent = 'Clouds did not load';
  else if (state.timeline) els.timeLabel.textContent = formatTime(state.timeline.times[Math.round(state.t)]);
  if (loop?.status !== state.loopStatus) {
    if (loop?.status === 'playing') {
      // The loop's own frame rate applies from now (see tick), not at the end of a sleep.
      wakeFrames();
      announce(reducedMotion ? 'The clouds of 12 hours ago. Press Next image for each half hour after.' : 'Playing the clouds of the last 12 hours.');
    } else if (loop?.status === 'failed') {
      announce('The clouds of the last 12 hours could not be loaded.');
    }
    state.loopStatus = loop?.status ?? null;
  }
}

// The loop button: starts the loop, stops it, or with reduced motion shows the next image.
function toggleCloudsLoop() {
  const loop = basemap.cloudsLoop();
  if (loop?.status === 'playing' && reducedMotion) {
    basemap.advanceCloudsLoop();
    return;
  }
  if (loop?.status === 'loading' || loop?.status === 'playing') {
    basemap.stopCloudsLoop();
    return;
  }
  setPlaying(false);
  if (basemap.startCloudsLoop({ manual: reducedMotion })) announce('Loading the clouds of the last 12 hours.');
  else announce('No moving clouds in view: they cover Europe and Africa, and not when zoomed in close.');
}

// Any use of the timeline ends the clouds loop.
function stopCloudsLoop() {
  basemap.stopCloudsLoop();
}

// Re-draw everything on the next frame, e.g. after a layer or display change.
function invalidate() {
  state.drawnStep = -1;
  state.dirty = true;
  flow.visible = els.wind.checked && !state.region;
  detailFlow.visible = els.wind.checked && !!state.region;
  if (state.region) requestRegion(state.region);
  renderControls();
}

// The moving clouds for the timeline at `step`: which images they show differs while it plays.
function syncClouds(step = Math.round(state.t)) {
  const { times } = state.timeline;
  const lookahead = Math.ceil(CLOUD_LOOKAHEAD_HOURS / state.stepHours);
  // In the past, where every hour has its own image, the clouds follow every hour while playing too
  // (see cloudTimes).
  const hourlyBefore = Date.now();
  // The play the page starts by itself ends at the end of the timeline: nothing to load past it.
  const loops = state.playing && !state.autoplay;
  const clouds = cloudTimes(times, step, { playing: state.playing, loops, lookahead, hourlyBefore });
  basemap.setTime(clouds.time, clouds.ahead, state.playing);
}

// Discrete layers only change when the timeline reaches a new step.
function drawStep(step) {
  const { points, values } = state.forecast;
  const { times } = state.timeline;
  const at = forecastStep(step);

  // The globe restarts the pulse of every ring it is given, so it only hears of changes.
  const rings = reuseRings(
    state.rings,
    els.hazards.checked ? hazardRings(points, values.weather_code[at], values.precipitation[at]) : [],
  );
  if (rings !== state.rings) {
    state.rings = rings;
    globe.ringsData(rings);
  }

  els.slider.value = String(step);
  els.slider.setAttribute('aria-valuetext', formatTime(times[step]));
  els.timeLabel.textContent = formatTime(times[step]);
  syncClouds(step);
  renderCaption();
  renderCloudsLoop();
  renderDetails();
  // The wind check refreshes the airport map with its findings; if it is not in use, the map is
  // refreshed here.
  if (!windCheck.update()) airportMap.refresh();
  state.drawnStep = step;
}

function blendIndices() {
  const last = state.forecast.times.length - 1;
  const position = forecastPosition(state.t, state.timeline);
  const i0 = Math.min(Math.floor(position), last);
  return [i0, Math.min(i0 + 1, last), position - i0];
}

// Indices into the zoomed-in region's data matching global steps i0 and i1, or null if the
// region has no data for them (e.g. it was fetched after the forecast rolled over a day).
function regionIndices(i0, i1) {
  const region = state.region;
  if (!region?.data) return null;
  const r0 = region.times.get(state.forecast.times[i0]);
  const r1 = region.times.get(state.forecast.times[i1]);
  return r0 == null || r1 == null ? null : [r0, r1];
}

function drawField() {
  const show = state.overlay;
  field.visible = show;
  const [i0, i1, t] = blendIndices();
  const ri = show && regionIndices(i0, i1);
  detailField.visible = !!ri;
  if (!show) return;
  const series = state.forecast.values[state.layer.variable];
  field.render(series[i0], series[i1], t, state.layer);
  if (ri) {
    const regional = state.region.data.values[state.layer.variable];
    detailField.render(regional[ri[0]], regional[ri[1]], t, state.layer);
  }
}

// Wind for the current moment, blended between steps: global, and regional when zoomed in.
// The global wind gets a row of pole averages at each end, so particles near the poles follow
// one averaged wind instead of spokes (see padPoles).
const windShape = padPoles(shape);
const globalWind = {
  u: new Float32Array(windShape.rows * windShape.cols),
  v: new Float32Array(windShape.rows * windShape.cols),
};
let regionWind = null;

function blendWind(steps, a, b, t, out, offset = 0) {
  for (let i = 0; i < steps[a].u.length; i++) {
    out.u[offset + i] = steps[a].u[i] + (steps[b].u[i] - steps[a].u[i]) * t;
    out.v[offset + i] = steps[a].v[i] + (steps[b].v[i] - steps[a].v[i]) * t;
  }
}

// Wind at a point from the sharpest data available there.
function sampleWind(lat, lng, out) {
  const regionShape = regionWind && state.region.data.shape;
  if (regionShape && covers(regionShape, lat, lng)) {
    out[0] = sampleGrid(regionWind.u, regionShape, lat, lng);
    out[1] = sampleGrid(regionWind.v, regionShape, lat, lng);
  } else {
    out[0] = sampleGrid(globalWind.u, windShape, lat, lng);
    out[1] = sampleGrid(globalWind.v, windShape, lat, lng);
  }
  return true;
}

function stepWind(frameDt) {
  const active = state.region ? detailFlow : flow;
  if (!active.visible) return;
  // The global flow steps at most 30 times a second, fewer while nobody uses the page (see
  // flow.js): the wind is blended only then.
  const dt = active.take(frameDt, frameMode === 'active' ? STEPS_PER_SECOND : RESTING_STEPS_PER_SECOND);
  if (!dt) return;
  const [i0, i1, t] = blendIndices();
  blendWind(state.winds, i0, i1, t, globalWind, shape.cols);
  fillPoleRows(globalWind.u, windShape);
  fillPoleRows(globalWind.v, windShape);
  const ri = regionIndices(i0, i1);
  if (ri) {
    const size = state.region.winds[0].u.length;
    if (regionWind?.u.length !== size) regionWind = { u: new Float32Array(size), v: new Float32Array(size) };
    blendWind(state.region.winds, ri[0], ri[1], t, regionWind);
  } else {
    regionWind = null;
  }
  active.step(dt, sampleWind);
}

const ease = (x) => 1 - (1 - x) ** 3;

// The globe stops turning after a while without anyone using the page, and turns again (if it
// was) at the next touch.
function setResting(resting) {
  if (resting === state.resting) return;
  state.resting = resting;
  controls.autoRotate = state.autoRotate && !resting && globe.pointOfView().altitude >= DETAIL_ALTITUDE;
}

let lastFrame = performance.now();
let lastTrafficRender = 0;
// Runs `fn`, reporting only the first error of each `kind`, so that one going wrong on every frame
// neither stops the rest of the frame nor floods the console.
const reported = new Set();
function guarded(kind, fn) {
  try {
    fn();
  } catch (err) {
    if (reported.has(kind)) return;
    reported.add(kind);
    console.error(err);
  }
}

// The clouds loop plays by itself unless motion is reduced (each press shows the next image then).
const cloudsLoopPlays = () => state.loopStatus === 'playing' && !reducedMotion;

// One frame of the screen (see `frames`); `slept`: the page slept before it.
function tick(now, slept) {
  // Active while something moves by itself that should look smooth (see busyNow in pacing.js). The
  // clouds loop stops after a long while without input, like a play started with the Play button;
  // until then it has a rate of its own.
  const attended = !unattended(now, budget.lastInput);
  if (cloudsLoopPlays() && !attended) guarded('clouds loop', stopCloudsLoop);
  const busy = busyNow({ playing: state.playing, flying: now < cameraFlightUntil, following: !!state.follow, attended });
  // The wind would jump at the still rate: while it shows, the page stays idle. Without the forecast
  // (not loaded yet, or failing to) it does not move, and the page may rest.
  const moving = !!state.winds && (flow.visible || detailFlow.visible);
  frameMode = budget.mode(now, { busy, looping: cloudsLoopPlays(), moving, paused: pilot.isOpen });
  setResting(budget.resting(now));
  syncGlobeAnimation(now);
  if (!budget.due(now, frameMode, slept)) return;
  // The globe is drawn first, as globe.gl did on its own: what this frame changes shows in the
  // next, and the zoomed-in wind is drawn with the camera the globe was just drawn with.
  if (frameMode !== 'paused') {
    if (cloudsLoopPlays()) guarded('clouds loop', () => basemap.frameCloudsLoop(now));
    if (drawGlobe) guarded('globe', drawGlobe);
    meter.count(now);
  }
  // At most a frame of the slowest rate (5 a second), so fades and particles keep their speed then.
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  // The weather is not drawn while the pilot view covers the globe.
  if (state.forecast && !pilot.isOpen) {
    const last = state.timeline.times.length - 1;
    if (state.playing) {
      const next = playStep(state.t, (dt * PLAY_HOURS_PER_SECOND) / state.stepHours, last, { once: state.autoplay });
      state.t = next.t;
      // The play the page started by itself goes back to the present at the end; one started
      // with the Play button stops when nobody has touched the page for a long while.
      if (next.ended) {
        setPlaying(false);
        seek(startIndex(state.timeline.times));
      } else if (!state.autoplay && !attended) {
        setPlaying(false);
      }
      state.dirty = true;
    }
    if (state.dirty) {
      const step = Math.round(state.t);
      if (step !== state.drawnStep) drawStep(step);
      drawField();
      state.dirty = false;
    }
    if (state.fieldFade < 1) {
      state.fieldFade = Math.min(1, state.fieldFade + dt / LAYER_FADE);
    }
    field.strength = ease(state.fieldFade);
    if (state.region?.data && state.region.fade < 1) {
      state.region.fade = Math.min(1, state.region.fade + dt / REGION_FADE);
    }
    detailField.strength = ease(state.fieldFade) * ease(state.region?.fade ?? 0);
    stepWind(dt);
  }
  // Live traffic is extra: a problem with it must not stop the globe.
  try {
    updateFollow();
    traffic.frame(now, trafficPov(globe.pointOfView(), pilot.position()));
  } catch (err) {
    console.error(err);
  }
  syncFollowButton();
  pilot.sync();
  syncFollowUi();
  // Live positions change all the time; refresh the open aircraft or satellite every second.
  if (state.detail?.traffic && now - lastTrafficRender > 1000) {
    lastTrafficRender = now;
    renderDetails();
  }
}

// `auto`: the play the page starts by itself, which plays the forecast once.
function setPlaying(playing, { auto = false } = {}) {
  state.playing = playing;
  state.autoplay = playing && auto;
  if (playing) wakeFrames();
  // The moving clouds follow the timeline differently while it plays (see cloudTimes).
  if (state.forecast) syncClouds();
  els.playIcon.textContent = playing ? '❚❚' : '▶';
  els.playText.textContent = playing ? 'Pause forecast' : 'Play forecast';
}

function seek(step) {
  state.t = step;
  state.dirty = true;
}

let retryTimer;
async function refresh(force = false) {
  clearTimeout(retryTimer);
  els.status.textContent = 'Loading forecast…';
  els.refresh.disabled = true;
  try {
    state.forecast = await loadForecast({
      force,
      onProgress: (done, total) => {
        els.status.textContent = `Loading forecast… ${Math.round((done / total) * 100)}%`;
      },
    });
    state.winds = windGrids(state.forecast.values.wind_speed_10m, state.forecast.values.wind_direction_10m);
    const { times } = state.forecast;
    state.stepHours = seriesHours(times);
    // The timeline starts afresh, and plays: the clouds loop and the timeline do not play together.
    stopCloudsLoop();
    state.timeline = null;
    rebuildTimeline();
    for (const el of [els.play, els.slider, els.now]) el.disabled = false;
    state.fieldFade = 0;
    seek(startIndex(state.timeline.times));
    if (!reducedMotion) setPlaying(true, { auto: true });
    const updated = state.forecast.built
      ? ` · updated ${new Date(state.forecast.built).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
      : '';
    els.status.textContent = `${FORECAST_DAYS}-day forecast, every hour${updated}`;
  } catch (err) {
    console.error(err);
    // Most failures are temporary (a busy or rate-limited API), so try again by itself.
    els.status.textContent = `${err.message || 'Could not load weather data'}. Retrying shortly…`;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => refresh(), RETRY_MS);
  } finally {
    els.refresh.disabled = false;
  }
}

// Zoomed in past DETAIL_ALTITUDE the view behaves like a map: it stops turning, and the area
// in view gets finer weather data and its own sharper wind layer.
function aspect() {
  return window.innerWidth / window.innerHeight;
}

function enterRegion(pov) {
  const region = { ...regionFor(viewBounds(pov, aspect())), data: null, winds: null, times: null, fade: 0, requested: false };
  state.region = region;
  detailFlow.setBounds(region.bounds);
  flow.visible = false;
  detailFlow.visible = els.wind.checked;
  detailField.visible = false;
  state.dirty = true;
  requestRegion(region);
}

function leaveRegion() {
  state.region = null;
  regionWind = null;
  detailField.visible = false;
  detailFlow.visible = false;
  flow.visible = els.wind.checked;
  state.dirty = true;
}

// Only the colour field and the wind particles draw zoomed-in detail (the storm markers and the
// airport tools use the global forecast and their own data), so without either on it is not
// fetched: it would only spend the day's allowance.
const regionWanted = (region) => state.region === region && (state.overlay || els.wind.checked);

// Fetches the zoomed-in detail for `region` once, if something would draw it. Called again when a
// weather layer or wind flow is switched on while zoomed in.
function requestRegion(region) {
  if (region.requested || !regionWanted(region)) return;
  region.requested = true;
  fetchRegion(region);
}

let lastRegionFetch = 0;
async function fetchRegion(region) {
  if (!regionWanted(region)) {
    region.requested = false;
    return;
  }
  if (!isRegionCached(region.shape)) {
    // Zoomed-in detail is optional: wait rather than spend the API's free allowance down to zero.
    if (apiBudget() < region.shape.rows * region.shape.cols + POINT_RESERVE) {
      setTimeout(() => state.region === region && fetchRegion(region), REGION_RETRY_MS);
      return;
    }
    const wait = lastRegionFetch + REGION_FETCH_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    // The view may have moved on while waiting, or the layers been switched off.
    if (!regionWanted(region)) {
      region.requested = false;
      return;
    }
    lastRegionFetch = Date.now();
  }
  try {
    const data = await loadRegion(region.shape);
    if (state.region !== region) return;
    region.winds = windGrids(data.values.wind_speed_10m, data.values.wind_direction_10m);
    region.times = new Map(data.times.map((time, i) => [time, i]));
    region.data = data;
    detailField.setRegion(data.shape, region.bounds);
    state.dirty = true;
  } catch (err) {
    // Keep showing the global data; zoomed-in detail is a bonus.
    console.error('Could not load detail for this area', err);
  }
}

let regionTimer;
function onView(pov) {
  basemap.setAltitude(pov.altitude);
  mapFeatures.update(pov.altitude);
  airportMap.view(pov);
  const zoomedIn = pov.altitude < DETAIL_ALTITUDE;
  controls.autoRotate = state.autoRotate && !zoomedIn && !state.resting;
  if (!zoomedIn) {
    clearTimeout(regionTimer);
    regionTimer = null;
    if (state.region) leaveRegion();
    return;
  }
  // Follow the camera at most every REGION_FOLLOW_MS while it moves, rather than waiting for
  // it to settle: its damped motion can take seconds to come to rest.
  if (!regionTimer && needsNewRegion(state.region, pov, aspect())) {
    regionTimer = setTimeout(() => {
      regionTimer = null;
      const now = globe.pointOfView();
      if (now.altitude < DETAIL_ALTITUDE && needsNewRegion(state.region, now, aspect())) enterRegion(now);
    }, REGION_FOLLOW_MS);
  }
}
globe.onZoom(onView);

const coords = (lat, lng) =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(2)}° ${lng >= 0 ? 'E' : 'W'}`;

// Tell screen readers once, rather than making a region that changes every frame "live".
function announce(message) {
  els.announcer.textContent = '';
  // A fresh text node after clearing makes screen readers read repeated messages too.
  requestAnimationFrame(() => {
    els.announcer.textContent = message;
  });
}

// The layers and display options fold away; the title, search box and wind check button stay visible.
function setControlsOpen(open) {
  els.controlsBody.hidden = !open;
  els.controlsToggle.setAttribute('aria-expanded', String(open));
  els.controls.classList.toggle('collapsed', !open);
  // On a landscape phone the menu and the panel column sit side by side, so both can be open.
  if (open && phoneLayout.matches) {
    closeDetails();
    windCheck.close();
    syncWindCheckButton();
  }
}

// The details panel and the wind check share one place on screen, so opening one closes the
// other. On phones the menu folds too, leaving the globe the room the panel does not take.
function openSidePanel({ keepTraffic = false } = {}) {
  state.autoRotate = false;
  controls.autoRotate = false;
  if (!keepTraffic) traffic.deselect();
  if (onPhone()) setControlsOpen(false);
}

// A tapped aircraft or satellite: live details, refreshed every second, with a ring around it.
function showTraffic(item, title) {
  // Tapping the aircraft that is followed keeps following it.
  if (state.follow && !(item.kind === 'aircraft' && item.id === state.follow.id)) stopFollowing();
  // An aircraft picked while a topic tab is open (or from the aircraft picked that way) can go back to the airport.
  const back = opsReturnFor(state, item);
  openSidePanel({ keepTraffic: true });
  windCheck.close();
  syncWindCheckButton();
  state.opsReturn = back;
  state.detail = { traffic: item };
  syncDetailTabs();
  mapFeatures.setMarker(null);
  airportMap.select(back?.airport ?? null);
  els.details.classList.remove('hidden');
  els.details.classList.add('keep-awake');
  setBackLabel(back ? 'Airport' : 'Wind check');
  els.detailsBack.hidden = !back;
  els.detailsTitle.textContent = title;
  renderDetails();
  announce(`${item.kind === 'aircraft' ? 'Flight' : 'Satellite'} ${title} selected.`);
  // On a phone an aircraft under the panels is brought into view (see phonelayout.js).
  const reveal = item.kind === 'aircraft' && !state.follow && phone.reveal(traffic.selectedAircraft(), { reduced: reducedMotion });
  if (reveal) flyTo(reveal.pose, reveal.ms);
}

// Taps that select an aircraft or satellite should not also open the weather where they landed.
let pickedAt = -Infinity;
const pickedTraffic = () => performance.now() - pickedAt < 500;
{
  let down = null;
  els.globe.addEventListener(
    'pointerdown',
    (event) => {
      down = { x: event.clientX, y: event.clientY };
    },
    { capture: true, passive: true },
  );
  els.globe.addEventListener(
    'pointerup',
    (event) => {
      if (!down || event.button !== 0 || dragged(down, { x: event.clientX, y: event.clientY })) return;
      const hit = traffic.pick(event.clientX, event.clientY);
      if (!hit) return;
      pickedAt = performance.now();
      traffic.select(hit);
    },
    { capture: true, passive: true },
  );
}

// Following an aircraft: the camera keeps it in the middle of the view, north up, from straight
// above, as it flies (see follow.js). The visitor keeps the zoom; dragging the map, Escape, closing
// the panel, picking anything else or switching the flights off ends it.
function startFollowing() {
  const report = traffic.selectedAircraft();
  if (!report) return;
  state.autoRotate = false;
  controls.autoRotate = false;
  // Momentum left in the camera controls would carry the view off the aircraft.
  stopCameraDrift();
  // Zooming toward the cursor would move the view off the aircraft for a frame at each step.
  zoomToCursor = controls.zoomToCursor;
  controls.zoomToCursor = false;
  basemap.setFollowing(true);
  airportMap.setFollowing(true);
  state.follow = startFollow(report, globe.pointOfView(), Date.now(), { reduced: reducedMotion });
  state.followExpanded = false;
  announce(`Following ${els.detailsTitle.textContent}.`);
}

let zoomToCursor = true;
function stopFollowing(message) {
  if (!state.follow) return;
  state.follow = null;
  state.followExpanded = false;
  controls.zoomToCursor = zoomToCursor;
  basemap.setFollowing(false);
  airportMap.setFollowing(false);
  if (message) announce(message);
}

// How far above the middle of the screen to hold the aircraft: on phones the panel covers the
// lower part, and the aircraft belongs in the part of the map left above it. Measured twice a
// second at most.
// { shift, shiftX }: shiftX is sideways, on a landscape phone where the full panel is a column on
// the right (see sideShift).
let followShift = { shift: 0, shiftX: 0 };
let followShiftAt = 0;
let followShiftShape = '';
// An invisible bar as tall as the notch, to measure it.
const safeTopProbe = document.createElement('div');
safeTopProbe.setAttribute('aria-hidden', 'true');
safeTopProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top, 0px);visibility:hidden;pointer-events:none';
document.body.append(safeTopProbe);
function followShiftNow(now) {
  // Turning the phone moves the panels: measure at once, and jump there rather than glide.
  const shape = `${onPhone()}:${phoneLandscape.matches}`;
  if (shape !== followShiftShape) {
    followShiftShape = shape;
    followShiftAt = 0;
    if (state.follow) state.follow.shift = state.follow.shiftX = null;
  }
  if (!onPhone()) return { shift: 0, shiftX: 0 };
  if (now - followShiftAt > 500) {
    followShiftAt = now;
    const { top, bottom, right } = freeArea({
      layout: followLayoutNow,
      controlsBottom: els.controls.offsetTop + els.controls.offsetHeight,
      detailsTop: els.details.offsetTop,
      cardTop: els.followCard.offsetTop,
      safeTop: safeTopProbe.offsetHeight,
      columnLeft: phoneLandscape.matches ? els.details.offsetLeft : null,
      height: window.innerHeight,
    });
    followShift = {
      shift: visibleShift({ top, bottom, height: window.innerHeight, minFree: 20 }),
      shiftX: right == null ? 0 : sideShift({ left: 0, right, width: window.innerWidth, height: window.innerHeight }),
    };
  }
  return followShift;
}

function updateFollow() {
  const follow = state.follow;
  if (!follow) return;
  const now = Date.now();
  const report = traffic.selectedAircraft();
  const reason = stopReason({ id: follow.id, selected: traffic.selected, report });
  if (reason) {
    stopFollowing(reason === 'lost' ? `${els.detailsTitle.textContent} is no longer received. Stopped following.` : undefined);
    return;
  }
  const pose = followStep(follow, { report, pov: globe.pointOfView(), now, ...followShiftNow(now) });
  if (pose) globe.pointOfView(pose);
}

// The Follow button is in the panel's header, which is not rebuilt every second like its body. It
// shows for an aircraft, and is off while the aircraft is not being received.
let followButtonState = '';
function syncFollowButton() {
  const aircraft = state.detail?.traffic?.kind === 'aircraft';
  const following = !!state.follow;
  const received = !!traffic.selectedAircraft();
  const key = `${aircraft}:${following}:${received}`;
  if (key === followButtonState) return;
  followButtonState = key;
  els.detailsFollow.hidden = !aircraft;
  els.detailsFollow.textContent = following ? 'Stop following' : 'Follow';
  els.detailsFollow.disabled = !following && !received;
  // A disabled button cannot keep focus: the panel's close button is the next stop.
  if (els.detailsFollow.disabled && document.activeElement === els.detailsFollow) els.detailsClose.focus();
}
els.detailsFollow.addEventListener('click', () => {
  if (state.follow) stopFollowing('Stopped following.');
  else {
    startFollowing();
    followStarted = true;
  }
  syncFollowUi();
});

// Phones: while an aircraft is followed, the controls, the timeline, the credits and the full
// panel make way for a small card with the flight's name, altitude, speed and track and a Stop
// button, so the aircraft stays in view (see followcard.js). Tapping the card brings the full
// panel back, still following; its Minimise button goes back to the card. Hiding is done in the
// stylesheet, so everything is back as it was, the folded controls included, once following ends.
let followLayoutNow = 'normal';
let cardAt = -Infinity;
let cardSpoken = null;
let narrowNow = onPhone();
// Set by the Follow button, so that the card's Stop button gets focus for that follow only.
let followStarted = false;
function syncFollowUi() {
  const narrow = onPhone();
  const resized = narrow !== narrowNow;
  narrowNow = narrow;
  const layout = followLayout({ following: !!state.follow, narrow, expanded: state.followExpanded });
  if (layout !== followLayoutNow) switchFollowLayout(layout, { resized });
  followStarted = false;
  syncFollowCard();
}

function switchFollowLayout(layout, { resized }) {
  const previous = followLayoutNow;
  const active = document.activeElement;
  const inside = !!active && (els.details.contains(active) || els.followCard.contains(active));
  followLayoutNow = layout;
  followShiftAt = 0;
  cardAt = -Infinity;
  cardSpoken = null;
  const compact = layout !== 'normal';
  document.body.classList.toggle('follow-compact', compact);
  document.body.classList.toggle('follow-with-card', layout === 'card');
  document.body.classList.toggle('follow-with-panel', layout === 'panel');
  if (!compact) setCreditsOpen(false);
  els.followCard.hidden = layout !== 'card';
  els.detailsMinimise.hidden = layout !== 'panel';
  phone.syncCredits();
  // The measurements were left alone while the panels were away.
  if (!compact) updateLayout();
  const target = focusTarget({ previous, layout, inside, started: followStarted, resized });
  if (target === 'stop') els.followCardStop.focus();
  else if (target === 'open') els.followCardOpen.focus();
  else if (target === 'minimise') els.detailsMinimise.focus();
  else if (target === 'follow' && !els.details.classList.contains('hidden')) {
    (els.detailsFollow.hidden || els.detailsFollow.disabled ? els.detailsClose : els.detailsFollow).focus();
  }
}

// Keeps the card's text up to date. Screen readers get theirs less often and in words.
function syncFollowCard() {
  const now = Date.now();
  if (followLayoutNow !== 'card' || now - cardAt < CARD_REFRESH_MS) return;
  const report = traffic.selectedAircraft();
  if (!report) return;
  cardAt = now;
  const { name, line } = cardText(report, { to: traffic.flightInfo()?.to?.code });
  if (els.followCardName.textContent !== name) {
    els.followCardName.textContent = name;
    els.followCardOpen.setAttribute('aria-label', `Show full details for ${name}`);
  }
  if (els.followCardLine.textContent !== line) els.followCardLine.textContent = line;
  const spoken = spokenText(report);
  if (spokenDue(cardSpoken, spoken, now)) {
    els.followCardLive.textContent = spoken;
    cardSpoken = { text: spoken, at: now };
  }
}

function setCreditsOpen(open) {
  document.body.classList.toggle('credits-open', open);
  els.creditsToggle.setAttribute('aria-expanded', String(open));
}
els.creditsToggle.addEventListener('click', () => setCreditsOpen(!document.body.classList.contains('credits-open')));
els.followCardStop.addEventListener('click', () => {
  stopFollowing('Stopped following.');
  syncFollowUi();
});
els.followCardOpen.addEventListener('click', () => {
  state.followExpanded = true;
  syncFollowUi();
});
els.detailsMinimise.addEventListener('click', () => {
  state.followExpanded = false;
  syncFollowUi();
});

// Dragging the map ends following. Zooming does not: the wheel is no drag, and neither is a
// gesture with more than one finger down.
{
  const tracker = new DragTracker();
  const point = (event) => ({ id: event.pointerId, x: event.clientX, y: event.clientY });
  const options = { capture: true, passive: true };
  els.globe.addEventListener('pointerdown', (event) => tracker.down({ ...point(event), primary: event.isPrimary, button: event.button }), options);
  els.globe.addEventListener('pointermove', (event) => tracker.move(point(event)) && state.follow && stopFollowing(), options);
  for (const type of ['pointerup', 'pointercancel']) els.globe.addEventListener(type, (event) => tracker.up(event.pointerId), options);
}

// `name` titles the panel, e.g. a searched place (tapped spots show coordinates); `pinLabel`
// is the shorter name shown on the map pin.
async function showDetails(lat, lng, name, pinLabel = name) {
  openSidePanel();
  windCheck.close();
  syncWindCheckButton();
  const detail = { lat, lng, data: null };
  state.opsReturn = null;
  state.detail = detail;
  syncDetailTabs();
  const title = name ?? coords(lat, lng);
  mapFeatures.setMarker({ lat, lng, name: pinLabel });
  airportMap.select(null);
  els.details.classList.remove('hidden', 'keep-awake');
  els.detailsBack.hidden = true;
  els.detailsTitle.textContent = title;
  els.detailsBody.innerHTML = '<p>Loading…</p>';
  try {
    const data = await loadPointForecast(lat, lng);
    // Ignore the response if another spot was clicked meanwhile.
    if (state.detail === detail) {
      detail.data = data;
      renderDetails();
      const index = detailIndex(data);
      announce(
        `Weather at ${title}: ${describeWeatherCode(data.weather_code?.[index])}, ` +
          `${fmt(data.temperature_2m?.[index], '°C')}.`,
      );
    }
  } catch (err) {
    console.error(err);
    if (state.detail !== detail) return;
    // Open-Meteo could not be asked (e.g. its daily allowance is used up): show what the map
    // shows here, from the global forecast.
    if (state.forecast) {
      detail.data = gridPointForecast(lat, lng);
      renderDetails();
      return;
    }
    els.detailsBody.innerHTML = `<p>Could not load weather here. ${err.message ?? ''}</p>`;
    announce(`Could not load weather at ${title}.`);
  }
}

// The forecast at a spot from the global grid, as the map shows it: interpolated between grid
// points, and from the nearest one for wind direction and the weather type.
function gridPointForecast(lat, lng) {
  const { times, values } = state.forecast;
  const r = Math.max(0, Math.min(shape.rows - 1, Math.round((lat - shape.lat0) / shape.step)));
  const c = Math.round((((lng - shape.lng0) % 360) + 360) % 360 / shape.step) % shape.cols;
  const nearest = r * shape.cols + c;
  const data = { time: times, fromGrid: true };
  for (const v of Object.keys(values)) {
    data[v] = values[v].map((step) =>
      v === 'weather_code' || v === 'wind_direction_10m' ? step[nearest] : sampleGrid(step, shape, lat, lng),
    );
  }
  return data;
}

// An airport's ground conditions and runway winds. `fromList`: opened from the wind check, which
// the back button returns to.
async function showAirport(airport, { fromList = false } = {}) {
  stopAutoplay();
  openSidePanel();
  windCheck.close();
  syncWindCheckButton();
  // `observation` and `taf`: undefined while the METAR or TAF loads, null if there is none. `error`: why there is no forecast, once it is known.
  const detail = { airport, hourly: null, fromList, observation: undefined, taf: undefined, error: null };
  // What the airport that was open was watching (lightning, traffic) stops now, not when the new one
  // has its forecast, and its summary line goes.
  ops.release();
  state.opsReturn = null;
  setBackLabel('Wind check');
  state.detail = detail;
  syncDetailTabs();
  // The summary line needs the TAF whatever the tab, so it is asked for with the METAR.
  requestTaf(detail);
  // The airport's own label on the map shows it is open (see airportmap.js): no pin of its own.
  mapFeatures.setMarker(null);
  airportMap.select(airport);
  els.details.classList.remove('hidden');
  // A tool to read, so it stays on screen rather than fading with the other controls.
  els.details.classList.add('keep-awake');
  els.detailsBack.hidden = !fromList;
  els.detailsTitle.textContent = airport.name;
  els.detailsBody.innerHTML = `<p>${airportPlace(airport)}</p><p>Loading conditions…</p>`;
  latestObservation(airport.ident)
    .then((observation) => {
      detail.observation = observation;
      // When it was fetched, for the summary line to know how old it is (see ops.js).
      detail.observationAt = Date.now();
    })
    .catch((err) => {
      console.error(err);
      detail.observation = { error: explain(err) };
    })
    .finally(() => state.detail === detail && renderDetails());
  // Shows a forecast, if the panel is still on this airport.
  const showForecast = (hourly) => {
    if (state.detail !== detail) return;
    detail.hourly = hourly;
    detail.hourlyAt = Date.now();
    detail.error = null;
    renderDetails();
    const conditions = conditionsAt(hourly, currentTime());
    if (conditions) {
      const result = assessAirport(airport, conditions, windCheck.limits());
      announce(`${airport.name}: ${STATUS[result.status].label}. ${verdictText(result)}.`);
    }
  };
  try {
    // The freshest forecast for the one airport being looked at. Whatever happens, the panel says
    // something within AIRPORT_WEATHER_TIMEOUT_MS rather than staying on "Loading conditions…".
    showForecast(await airportPanelWeather(airport, { timeoutMs: AIRPORT_WEATHER_TIMEOUT_MS, onLate: showForecast }));
  } catch (err) {
    console.error(err);
    if (state.detail === detail) {
      detail.error = explain(err);
      renderDetails();
      announce(`Could not load conditions at ${airport.name}.`);
    }
  }
}

function closeDetails() {
  const tracked = state.detail?.traffic;
  state.detail = null;
  state.opsReturn = null;
  syncDetailTabs();
  if (tracked) traffic.deselect();
  els.details.classList.add('hidden');
  els.details.classList.remove('keep-awake');
  mapFeatures.setMarker(null);
  airportMap.select(null);
}

// Airport tools show the present rather than wherever the autoplay happened to be.
function stopAutoplay() {
  if (!state.playing || !state.forecast) return;
  setPlaying(false);
  seek(startIndex(state.timeline.times));
}

function openWindCheck() {
  stopAutoplay();
  openSidePanel();
  closeDetails();
  state.windCheck = true;
  windCheck.open();
  syncWindCheckButton();
}

// Closing the wind check also takes its markers off the map.
function closeWindCheck() {
  state.windCheck = false;
  windCheck.close();
  state.problems = [];
  mapFeatures.setAirports([]);
  airportMap.refresh();
  syncWindCheckButton();
}

function syncWindCheckButton() {
  els.windCheckOpen.setAttribute('aria-expanded', String(!els.windCheck.panel.classList.contains('hidden')));
}

// The label of the panel's back button.
function setBackLabel(text) {
  els.detailsBack.lastChild.textContent = ` ${text}`;
}

// Back from an aircraft picked in a topic tab to the airport, on the tab it came from.
function backToAirport() {
  const detail = state.opsReturn;
  if (!detail) return;
  state.opsReturn = null;
  state.detail = detail;
  traffic.deselect();
  setBackLabel('Wind check');
  els.detailsBack.hidden = !detail.fromList;
  els.detailsTitle.textContent = detail.airport.name;
  airportMap.select(detail.airport);
  syncDetailTabs();
  renderDetails();
  // Focus goes to the tab it came from, the aircraft's button being gone.
  document.getElementById(`details-tab-${state.detailTab}`)?.focus();
}

// Back from an airport to the wind check list, with focus on the airport just shown.
function backToWindCheck() {
  const ident = state.detail?.airport?.ident;
  openWindCheck();
  const row = ident && els.windCheck.list.querySelector(`[data-ident="${CSS.escape(ident)}"]`);
  (row || els.windCheck.panel.querySelector('h2')).focus?.();
}


// Glide to an airport and open its conditions, from a height at which its runways show.
// `stayClose` (a label on the map) never backs out from a closer view: it only centres on the
// airport, and leaves the panel alone if that airport is already open (unless the panel is showing
// an error, when it tries again). On phones the details panel covers the lower half of the screen,
// so aim the camera a little south to put the airport in the open space between the search box and
// the panel.
function goToAirport(airport, { stayClose = false, ...options } = {}) {
  const altitude = stayClose ? airportFlightAltitude(globe.pointOfView().altitude) : AIRPORT_ALTITUDE;
  let { lat, lng } = airport;
  if (onPhone()) {
    // Following ends with the airport, and the controls the card hid must be there to measure.
    stopFollowing();
    syncFollowUi();
    // The controls fold when the panel opens: measure them folded.
    setControlsOpen(false);
    ({ lat, lng } = phone.aim(airport, altitude));
  }
  flyTo({ lat, lng, altitude }, reducedMotion ? 0 : 2200);
  if (stayClose && panelStays(state.detail, airport)) return;
  // Trying an open airport again keeps the way back to the wind check.
  const again = stayClose && state.detail?.airport?.ident === airport.ident;
  showAirport(airport, again ? { fromList: state.detail.fromList, ...options } : options);
}

// Drop any momentum left in the camera controls (damping eases movement out over many frames).
function stopCameraDrift() {
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
}

// Glide the camera to `pov` over `ms`. Stop turning first: the camera controls keep the turn's
// momentum, which would otherwise carry the view on past the place after the flight.
function flyTo(pov, ms) {
  state.autoRotate = false;
  controls.autoRotate = false;
  stopCameraDrift();
  globe.pointOfView(pov, ms);
  cameraFlightUntil = performance.now() + ms + 100;
  wakeFrames();
  setTimeout(stopCameraDrift, ms + 50);
}

// The timeline's time, or the current hour before the forecast has loaded.
function currentTime() {
  return state.forecast?.times[forecastStep()] ?? new Date().toISOString().slice(0, 13) + ':00';
}

const formatHour = (time) => new Date(parseTime(time)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// Temperature sparkline for the clicked spot, with a marker at the timeline position.
function sparkline(series, index) {
  const w = 248;
  const h = 56;
  const valid = series.filter((v) => v != null);
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const x = (i) => (i / (series.length - 1)) * w;
  const y = (v) => h - 4 - ((v - min) / (max - min || 1)) * (h - 8);
  const path = series
    .map((v, i) => (v == null ? '' : `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`))
    .join('');
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" role="img"
      aria-label="Temperature over the next ${FORECAST_DAYS} days, ${Math.round(min)} to ${Math.round(max)} °C">
      <path d="${path}" />
      <line x1="${x(index)}" x2="${x(index)}" y1="0" y2="${h}" />
    </svg>
    <div class="legend-labels"><span>Temperature, next ${FORECAST_DAYS} days</span><span>${Math.round(min)} to ${Math.round(max)} °C</span></div>`;
}

// The hour in a spot's forecast matching the timeline position.
function detailIndex(data) {
  const time = state.forecast?.times[forecastStep()];
  return Math.max(0, data.time.indexOf(time));
}

// The airport panel's tabs: shown for an airport only, with the body as the selected tab's panel.
function syncDetailTabs() {
  const show = !!state.detail?.airport;
  els.detailsTabs.hidden = !show;
  els.detailsSummary.hidden = !show;
  els.details.classList.toggle('with-tabs', show);
  for (const tab of els.detailsTabs.children) {
    const on = tab.dataset.tab === state.detailTab;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  if (show) {
    els.detailsBody.setAttribute('role', 'tabpanel');
    els.detailsBody.setAttribute('aria-labelledby', `details-tab-${state.detailTab}`);
  } else {
    els.detailsBody.removeAttribute('role');
    els.detailsBody.removeAttribute('aria-labelledby');
  }
  if (show) ops.show(state.detailTab);
  // An aircraft picked from a tab leaves the tab's own watching on for the way back, and the summary
  // line, which is hidden meanwhile, no longer watches anything.
  else if (opsKeepsWatching(state)) ops.hold();
  else ops.stop();
}

function selectDetailTab(id) {
  if (id === state.detailTab) return;
  state.detailTab = id;
  saveTab(id);
  renderDetails();
}

els.detailsTabs.replaceChildren(
  ...DETAIL_TABS.map(({ id, label }) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `details-tab-${id}`;
    tab.className = 'detail-tab';
    tab.setAttribute('role', 'tab');
    tab.dataset.tab = id;
    tab.textContent = label;
    return tab;
  }),
);
els.detailsTabs.addEventListener('click', (event) => {
  const id = event.target.closest('[data-tab]')?.dataset.tab;
  if (id) selectDetailTab(id);
});
// Arrow keys, Home and End move between the tabs and select the one reached.
els.detailsTabs.addEventListener('keydown', (event) => {
  const tabs = [...els.detailsTabs.children];
  const next = tabAfterKey(event.key, tabs.indexOf(document.activeElement), tabs.length);
  if (next === null) return;
  event.preventDefault();
  selectDetailTab(tabs[next].dataset.tab);
  tabs[next].focus();
});

// The summary line and the Weather, Traffic and Access tabs (see ops.js): what their parts read, and
// what they may ask of the page.
const ops = createOpsHost({
  root: els.detailsBody,
  summaryRoot: els.detailsSummary,
  getContext: airportContext,
  requestRender: () => renderDetails(),
  selectTab: (id) => selectDetailTab(id),
  // The airport map shows what fits the tab (see mapprofile.js).
  onProfile: (profile) => airportMap.setProfile(profile),
  // An hour in the Weather tab sets the timeline to it, so the map and the panel agree.
  setTime(time, { quiet = false } = {}) {
    const step = state.timeline ? stepNearest(state.timeline.times, time) : -1;
    if (step < 0) return;
    stopCloudsLoop();
    setPlaying(false);
    seek(step);
    if (!quiet) announce(`Timeline set to ${formatTime(time)}.`);
  },
});

// Asks for the open airport's TAF, once; the panel is drawn again when it arrives.
function requestTaf(detail) {
  if (detail.taf !== undefined || detail.tafAsked) return;
  detail.tafAsked = true;
  latestTaf(detail.airport.ident)
    .then((taf) => {
      detail.taf = taf;
    })
    .catch((err) => {
      console.error(err);
      detail.taf = { error: explain(err) };
    })
    .finally(() => state.detail === detail && renderDetails());
}

// What is known of the open airport, for the airport panel's tabs and summary line.
function airportContext() {
  // While an aircraft picked from the tab is open, the airport it was picked at.
  const detail = state.detail?.airport ? state.detail : state.opsReturn;
  return {
    trafficSource: opsTraffic,
    airport: detail.airport,
    hourly: detail.hourly,
    time: currentTime(),
    now: Date.now(),
    limits: windCheck.limits(),
    limitsLabel: windCheck.label(),
    formatTime,
    formatHour,
    formatClock,
    formatClockShort,
    formatTick,
    zone: zoneName(),
    observation: detail.observation,
    observationAsOf: detail.observationAt,
    hourlyAsOf: detail.hourlyAt,
    taf: detail.taf,
    error: detail.error,
  };
}

// Updates only the panel's body, so the heading and close button keep their focus.
function renderDetails() {
  const detail = state.detail;
  syncDetailTabs();
  if (detail?.traffic) {
    els.detailsBody.innerHTML = traffic.detailsHtml() ?? '<p>No longer in view.</p>';
    return;
  }
  if (detail?.airport) {
    if (!detail.hourly && !detail.error) return;
    requestTaf(detail);
    const ctx = airportContext();
    if (!isTopicTab(state.detailTab)) els.detailsBody.innerHTML = airportDetailsHtml(ctx);
    // The summary line, and the tab's parts if it is one of theirs.
    ops.render(ctx);
    return;
  }
  if (!detail?.data || !state.forecast) return;
  const { data } = detail;
  const index = detailIndex(data);
  const value = (variable) =>
    // Same definition as the map: the rate over the hour up to this time (the global grid already
    // holds that rate).
    variable === 'precipitation' && !data.fromGrid ? precipitationRate(data.precipitation ?? [], index) : data[variable]?.[index];
  const rows = LAYERS.map((l) => `<dt>${l.label}</dt><dd>${fmt(value(l.variable), l.unit)}</dd>`).join('');
  els.detailsBody.innerHTML = `
    <p>${formatTime(data.time[index])} · ${describeWeatherCode(value('weather_code'))}</p>
    ${data.fromGrid ? "<p>From the global forecast, as Open-Meteo could not be asked for this spot right now.</p>" : ''}
    <dl>${rows}<dt>Wind direction</dt><dd>${fmt(value('wind_direction_10m'), '°')}</dd></dl>
    ${sparkline(data.temperature_2m, index)}`;
}

// Fade the controls out when nobody is interacting, so the globe can be watched like a painting.
let idleTimer;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    // Airport panels are for reading, so they keep everything on screen.
    if (document.querySelector('.panel:focus-within, .panel.keep-awake:not(.hidden)')) wake();
    else document.body.classList.add('idle');
  }, IDLE_MS);
}
// Any input also brings the full frame rate back at once (see pacing.js).
function onInput() {
  budget.input(performance.now());
  wakeFrames();
  setResting(false);
  wake();
}
// A screen reader's activation can be just a click, and a resize clears the canvas, which must be
// drawn again at once.
for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'click', 'input', 'focusin', 'resize']) {
  window.addEventListener(type, onInput, { passive: true, capture: true });
}
// A tab shown again draws at once, rather than at the end of a sleep that may have run long.
document.addEventListener('visibilitychange', () => !document.hidden && wakeFrames());

els.refresh.addEventListener('click', () => refresh(true));
els.play.addEventListener('click', () => {
  stopCloudsLoop();
  setPlaying(!state.playing);
});
els.slider.addEventListener('input', () => {
  stopCloudsLoop();
  setPlaying(false);
  seek(Number(els.slider.value));
});
els.now.addEventListener('click', () => {
  stopCloudsLoop();
  setPlaying(false);
  // The past day moves on with the clock.
  rebuildTimeline();
  seek(startIndex(state.timeline.times));
});
els.cloudsLoop.addEventListener('click', toggleCloudsLoop);
els.cloudsLoop.hidden = state.basemap !== 'clouds';
els.wind.addEventListener('change', invalidate);
els.detailsClose.addEventListener('click', closeDetails);
els.detailsBack.addEventListener('click', () => (backAction(state) === 'back-to-airport' ? backToAirport() : backToWindCheck()));
els.windCheckOpen.addEventListener('click', () => {
  if (els.windCheck.panel.classList.contains('hidden')) openWindCheck();
  else closeWindCheck();
});
els.windCheckClose.addEventListener('click', () => {
  closeWindCheck();
  els.windCheckOpen.focus();
});
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (pilot.isOpen) {
    pilot.close();
    return;
  }
  // Open credits close first.
  if (document.body.classList.contains('credits-open')) {
    setCreditsOpen(false);
    els.creditsToggle.focus();
    return;
  }
  // A sheet pulled up goes back down before it closes.
  if (phone.collapseSheet()) return;
  const action = escapeAction(state, { following: Boolean(state.follow) });
  if (action === 'stop-following') stopFollowing('Stopped following.');
  else if (action === 'back-to-airport') backToAirport();
  else if (action === 'back-to-wind-check') backToWindCheck();
  else if (action === 'close') closeDetails();
  else if (!els.windCheck.panel.classList.contains('hidden')) {
    closeWindCheck();
    els.windCheckOpen.focus();
  }
});
els.controlsToggle.addEventListener('click', () => setControlsOpen(els.controlsBody.hidden));
setupSearch({
  input: els.searchInput,
  list: els.searchResults,
  status: els.searchStatus,
  search: async (query) =>
    searchAirports(await loadAirports(), query).map((airport) => ({
      airport,
      name: airport.name,
      detail: airportPlace(airport),
    })),
  describe: (n) => `${n} airport${n === 1 ? '' : 's'} found`,
  onSelect: ({ airport }) => goToAirport(airport),
});
// Start loading the airport list as soon as someone heads for the search box.
els.searchInput.addEventListener('focus', () => loadAirports().catch(() => {}), { once: true });
els.hazards.addEventListener('change', invalidate);

// Panels stop above the timeline, and on phones the timeline above the credits; their heights
// change with screen width and wrapping. Uses offsetTop, which ignores the idle fade's transform.
function updateLayout() {
  // The hidden panels would measure as nothing; the numbers are taken again when they return.
  if (document.body.classList.contains('follow-compact')) return;
  const root = document.documentElement.style;
  root.setProperty('--credits-height', `${els.credits.offsetHeight}px`);
  root.setProperty('--controls-bottom', `${els.controls.offsetTop + els.controls.offsetHeight}px`);
  root.setProperty('--timeline-top', `${window.innerHeight - els.timeline.offsetTop}px`);
}
const phone = setupPhoneLayout({
  globe,
  globeEl: els.globe,
  controls: els.controls,
  timeline: els.timeline,
  sheets: [els.details, els.windCheck.panel],
  titles: [els.detailsTitle],
  creditsToggle: els.creditsToggle,
  collapseControls: () => els.controlsBody.hidden || setControlsOpen(false),
  closeCredits: () => setCreditsOpen(false),
});
const layoutObserver = new ResizeObserver(updateLayout);
layoutObserver.observe(els.timeline);
layoutObserver.observe(els.credits);
layoutObserver.observe(els.controls);
window.addEventListener('resize', updateLayout);
updateLayout();

flow.visible = els.wind.checked;
onView(globe.pointOfView());
renderControls();
wake();
refresh();
frames.start();

