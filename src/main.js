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
  parseTime,
  startIndex,
} from './weather.js';
import { FieldOverlay, covers, fillPoleRows, padPoles, sampleGrid } from './field.js';
import { WindFlow, windGrids } from './flow.js';
import { ScreenFlow } from './screenflow.js';
import { HAZARDS, hazardRings } from './patterns.js';
import { DETAIL_ALTITUDE, needsNewRegion, regionFor, viewBounds } from './detail.js';
import { BASEMAPS, setupBasemap, setupMapFeatures } from './map.js';
import { setupSearch } from './search.js';
import { airportPanelWeather, conditionsAt, loadAirports, searchAirports } from './airports.js';
import { airportDetailsHtml, airportPlace, panelStays, verdictText } from './airportview.js';
import { setupWindCheck } from './windcheck.js';
import { STATUS, assessAirport } from './runways.js';
import { TRAFFIC_LEGEND, setupTraffic } from './traffic.js';
import { AIRPORT_ALTITUDE, airportFlightAltitude, setupAirportMap } from './airportmap.js';
import { DragTracker, dragged, followStep, startFollow, stopReason, shiftedLat, visibleShift } from './follow.js';
import { CARD_REFRESH_MS, cardText, focusTarget, followLayout, freeArea, spokenDue, spokenText } from './followcard.js';
import { latestObservation } from './metar.js';
import { explain } from './api.js';

// Timeline playback speed, in forecast steps (3 hours each) per second.
const STEPS_PER_SECOND = 1;
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
const narrowScreen = window.innerWidth < 640;
// On phones the controls and the details panel share the screen, so only one is open at a time.
const phoneLayout = window.matchMedia('(max-width: 640px)');

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
  caption: document.getElementById('caption'),
  controls: document.getElementById('controls'),
  controlsToggle: document.getElementById('controls-toggle'),
  controlsBody: document.getElementById('controls-body'),
  searchInput: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),
  searchStatus: document.getElementById('search-status'),
  detailsBack: document.getElementById('details-back'),
  detailsFollow: document.getElementById('details-follow'),
  detailsMinimise: document.getElementById('details-minimise'),
  followCard: document.getElementById('follow-card'),
  followCardOpen: document.getElementById('follow-card-open'),
  followCardName: document.getElementById('follow-card-name'),
  followCardLine: document.getElementById('follow-card-line'),
  followCardStop: document.getElementById('follow-card-stop'),
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
  // Fractional index into forecast.times; the field and wind blend between neighbouring steps.
  t: 0,
  playing: false,
  // Step whose discrete layers (the storm rings) are currently drawn.
  drawnStep: -1,
  dirty: true,
  // 0..1 progress of the colour field fading in after a layer change.
  fieldFade: 0,
  // Open details: a spot { lat, lng, data } or an airport { airport, hourly, fromList }.
  detail: null,
  // Whether the wind check is in use: its panel is open, or one of its airports is.
  windCheck: false,
  // Zoomed-in area with finer data: { shape, bounds, data, winds, times, fade }, or null.
  region: null,
  // The aircraft the camera is following, see follow.js, or null.
  follow: null,
  // On phones: whether the full panel was asked for while following, instead of the small card.
  followExpanded: false,
  autoRotate: !reducedMotion,
};

// On phones the controls start folded so the globe gets the screen.
if (narrowScreen) setControlsOpen(false);

const fmt = (value, unit) => (value == null ? '–' : `${Math.round(value * 10) / 10} ${unit}`);

const formatTime = (time) =>
  new Date(parseTime(time)).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });

const globe = new Globe(els.globe, { animateIn: !reducedMotion })
  .backgroundColor('rgba(0, 0, 0, 0)')
  .atmosphereColor('#8ec5ff')
  .atmosphereAltitude(0.22)
  // Severe weather: slow, soft pulses
  .ringColor((d) => (t) => `rgba(${HAZARDS[d.kind].rgb}, ${0.7 * (1 - t) ** 2})`)
  .ringMaxRadius(4)
  .ringPropagationSpeed(1.4)
  .ringRepeatPeriod(2400)
  // Drawn after the colour field and wind layers, which do not write depth, so they show on top.
  .ringAltitude(0.0008)
  .onGlobeClick(({ lat, lng }) => !pickedTraffic() && showDetails(lat, lng));

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
  onClouds: () => renderCaption(),
});
const mapFeatures = setupMapFeatures(globe);
const traffic = setupTraffic({
  globe,
  els: els.traffic,
  onSelect: (item, title) => showTraffic(item, title),
  onDeselect: () => {
    stopFollowing();
    if (!state.detail?.traffic) return;
    state.detail = null;
    els.details.classList.add('hidden');
  },
  announce: (message) => announce(message),
});
const windCheck = setupWindCheck({
  els: els.windCheck,
  getTime: () => currentTime(),
  // Airports near the middle of the view are checked first.
  getCenter: () => globe.pointOfView(),
  formatTime: (time) => formatTime(time),
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
const flow = new WindFlow(globe, {
  count: largeScreen ? 4500 : 2200,
  width: largeScreen ? 2048 : 1024,
  lineWidth: largeScreen ? 1.3 : 1,
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

window.addEventListener('resize', () => globe.width(window.innerWidth).height(window.innerHeight));

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
  const time = state.forecast?.times[Math.round(state.t)];
  const label = state.overlay ? state.layer.label : 'Map';
  // In the forecast part of the timeline the moving clouds stay on the newest image there is.
  const asOf = basemap.cloudsAsOf();
  const clouds = asOf ? ` · clouds as of ${new Date(asOf).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}` : '';
  els.caption.textContent = time ? `${label} · ${formatTime(time)}${clouds}` : label;
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

// Discrete layers only change when the timeline reaches a new step.
function drawStep(step) {
  const { points, values, times } = state.forecast;

  globe.ringsData(
    els.hazards.checked ? hazardRings(points, values.weather_code[step], values.precipitation[step]) : [],
  );

  els.slider.value = String(step);
  els.slider.setAttribute('aria-valuetext', formatTime(times[step]));
  els.timeLabel.textContent = formatTime(times[step]);
  // While the timeline plays, the clouds for the next two steps load ahead.
  const ahead = state.playing ? [1, 2].map((k) => parseTime(times[(step + k) % times.length])) : [];
  basemap.setTime(parseTime(times[step]), ahead);
  renderCaption();
  renderDetails();
  windCheck.update();
  airportMap.refresh();
  state.drawnStep = step;
}

function blendIndices() {
  const last = state.forecast.times.length - 1;
  const i0 = Math.min(Math.floor(state.t), last);
  return [i0, Math.min(i0 + 1, last), state.t - i0];
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

function stepWind(dt) {
  const active = state.region ? detailFlow : flow;
  if (!active.visible) return;
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

let lastFrame = performance.now();
let lastTrafficRender = 0;
function tick(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (state.forecast) {
    const last = state.forecast.times.length - 1;
    if (state.playing) {
      state.t += dt * STEPS_PER_SECOND;
      if (state.t >= last) state.t = 0;
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
    traffic.frame(now, globe.pointOfView());
  } catch (err) {
    console.error(err);
  }
  syncFollowButton();
  syncFollowUi();
  // Live positions change all the time; refresh the open aircraft or satellite every second.
  if (state.detail?.traffic && now - lastTrafficRender > 1000) {
    lastTrafficRender = now;
    renderDetails();
  }
  requestAnimationFrame(tick);
}

function setPlaying(playing) {
  state.playing = playing;
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
    els.slider.max = String(times.length - 1);
    for (const el of [els.play, els.slider, els.now]) el.disabled = false;
    state.drawnStep = -1;
    state.fieldFade = 0;
    seek(startIndex(times));
    if (!reducedMotion) setPlaying(true);
    const updated = state.forecast.built
      ? ` · updated ${new Date(state.forecast.built).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
      : '';
    els.status.textContent = `${FORECAST_DAYS}-day forecast, every 3 hours${updated}`;
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
  controls.autoRotate = state.autoRotate && !zoomedIn;
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
  if (open && phoneLayout.matches) {
    closeDetails();
    windCheck.close();
    syncWindCheckButton();
  }
}

// The details panel and the wind check share one place on screen, so opening one closes the
// other. On phones they also share it with the controls.
function openSidePanel({ keepTraffic = false } = {}) {
  state.autoRotate = false;
  controls.autoRotate = false;
  if (!keepTraffic) traffic.deselect();
  if (phoneLayout.matches) setControlsOpen(false);
}

// A tapped aircraft or satellite: live details, refreshed every second, with a ring around it.
function showTraffic(item, title) {
  // Tapping the aircraft that is followed keeps following it.
  if (state.follow && !(item.kind === 'aircraft' && item.id === state.follow.id)) stopFollowing();
  openSidePanel({ keepTraffic: true });
  windCheck.close();
  syncWindCheckButton();
  state.detail = { traffic: item };
  mapFeatures.setMarker(null);
  airportMap.select(null);
  els.details.classList.remove('hidden');
  els.details.classList.add('keep-awake');
  els.detailsBack.hidden = true;
  els.detailsTitle.textContent = title;
  renderDetails();
  announce(`${item.kind === 'aircraft' ? 'Flight' : 'Satellite'} ${title} selected.`);
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
let followShift = 0;
let followShiftAt = 0;
// An invisible bar as tall as the notch, to measure it.
const safeTopProbe = document.createElement('div');
safeTopProbe.setAttribute('aria-hidden', 'true');
safeTopProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:env(safe-area-inset-top, 0px);visibility:hidden;pointer-events:none';
document.body.append(safeTopProbe);
function followShiftNow(now) {
  if (!phoneLayout.matches) return 0;
  if (now - followShiftAt > 500) {
    followShiftAt = now;
    const { top, bottom } = freeArea({
      layout: followLayoutNow,
      controlsBottom: els.controls.offsetTop + els.controls.offsetHeight,
      detailsTop: els.details.offsetTop,
      cardTop: els.followCard.offsetTop,
      safeTop: safeTopProbe.offsetHeight,
    });
    followShift = visibleShift({ top, bottom, height: window.innerHeight, minFree: 20 });
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
  const pose = followStep(follow, { report, pov: globe.pointOfView(), now, shift: followShiftNow(now) });
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
let narrowNow = phoneLayout.matches;
// Set by the Follow button, so that the card's Stop button gets focus for that follow only.
let followStarted = false;
function syncFollowUi() {
  const narrow = phoneLayout.matches;
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
  els.creditsToggle.hidden = !compact;
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
  const { name, line } = cardText(report);
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
  state.detail = detail;
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
  // `observation`: undefined while the METAR loads, null if there is none. `error`: why there is
  // no forecast, once it is known.
  const detail = { airport, hourly: null, fromList, observation: undefined, error: null };
  state.detail = detail;
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
  seek(startIndex(state.forecast.times));
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
  let lat = airport.lat;
  if (phoneLayout.matches) {
    // Following ends with the airport, and the controls the card hid must be there to measure.
    stopFollowing();
    syncFollowUi();
    // The controls fold when the panel opens: measure them folded.
    setControlsOpen(false);
    const top = els.controls.offsetTop + els.controls.offsetHeight;
    const shift = visibleShift({ top, bottom: window.innerHeight * 0.45, height: window.innerHeight });
    lat = shiftedLat(lat, shift, altitude);
  }
  // Stop turning first: the camera controls keep the turn's momentum, which would otherwise carry
  // the view on past the airport after the flight.
  state.autoRotate = false;
  controls.autoRotate = false;
  stopCameraDrift();
  const duration = reducedMotion ? 0 : 2200;
  globe.pointOfView({ lat, lng: airport.lng, altitude }, duration);
  setTimeout(stopCameraDrift, duration + 50);
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

// The timeline's time, or the current hour before the forecast has loaded.
function currentTime() {
  return state.forecast?.times[Math.round(state.t)] ?? new Date().toISOString().slice(0, 13) + ':00';
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
  const time = state.forecast?.times[Math.round(state.t)];
  return Math.max(0, data.time.indexOf(time));
}

// Updates only the panel's body, so the heading and close button keep their focus.
function renderDetails() {
  const detail = state.detail;
  if (detail?.traffic) {
    els.detailsBody.innerHTML = traffic.detailsHtml() ?? '<p>No longer in view.</p>';
    return;
  }
  if (detail?.airport) {
    if (!detail.hourly && !detail.error) return;
    els.detailsBody.innerHTML = airportDetailsHtml({
      airport: detail.airport,
      hourly: detail.hourly,
      time: currentTime(),
      limits: windCheck.limits(),
      limitsLabel: windCheck.label(),
      formatTime,
      formatHour,
      observation: detail.observation,
      error: detail.error,
    });
    return;
  }
  if (!detail?.data || !state.forecast) return;
  const { data } = detail;
  const index = detailIndex(data);
  const value = (variable) =>
    // Same definition as the map: the average rate over the 3 hours up to this time (the global
    // grid already holds that rate).
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
for (const type of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(type, wake, { passive: true });
}

els.refresh.addEventListener('click', () => refresh(true));
els.play.addEventListener('click', () => setPlaying(!state.playing));
els.slider.addEventListener('input', () => {
  setPlaying(false);
  seek(Number(els.slider.value));
});
els.now.addEventListener('click', () => {
  setPlaying(false);
  seek(startIndex(state.forecast.times));
});
els.wind.addEventListener('change', invalidate);
els.detailsClose.addEventListener('click', closeDetails);
els.detailsBack.addEventListener('click', backToWindCheck);
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
  // Open credits close first.
  if (document.body.classList.contains('credits-open')) {
    setCreditsOpen(false);
    els.creditsToggle.focus();
    return;
  }
  if (state.follow) stopFollowing('Stopped following.');
  else if (state.detail?.fromList) backToWindCheck();
  else if (state.detail) closeDetails();
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
requestAnimationFrame(tick);

