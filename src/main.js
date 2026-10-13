import Globe from 'globe.gl';
import { LAYERS, getLayer, colorFor, normalize, describeWeatherCode } from './layers.js';
import {
  FORECAST_DAYS,
  GRID_STEP,
  gridShape,
  apiBudget,
  isRegionCached,
  loadForecast,
  loadPointForecast,
  loadRegion,
  parseTime,
  startIndex,
} from './weather.js';
import { FieldOverlay, covers, sampleGrid } from './field.js';
import { WindFlow, windGrids } from './flow.js';
import { HAZARDS, hazardRings } from './patterns.js';
import { DETAIL_ALTITUDE, needsNewRegion, regionFor, viewBounds } from './detail.js';
import { setupBasemap, setupMapFeatures } from './map.js';

// Timeline playback speed, in forecast steps (3 hours each) per second.
const STEPS_PER_SECOND = 1;
// Seconds for the colour field to fade in after switching layers.
const LAYER_FADE = 0.9;
// Controls fade away after this long without interaction, leaving just the globe.
const IDLE_MS = 4000;
// Minimum gap between fetches of zoomed-in detail, to stay within the free API's limits.
const REGION_FETCH_INTERVAL_MS = 4000;
// API locations kept free for tapping on the map, so zoomed-in detail never uses them up.
const POINT_RESERVE = 20;
// How long zoomed-in detail waits before retrying when the API budget is low.
const REGION_RETRY_MS = 15_000;
// How often the zoomed-in detail follows a moving camera.
const REGION_FOLLOW_MS = 400;
// Seconds for zoomed-in detail to fade in once it arrives.
const REGION_FADE = 0.8;
const IMAGE_BASE = `${import.meta.env.BASE_URL}img`;
const MODES = [
  { key: 'field', label: 'Smooth field' },
  { key: 'bars', label: 'Bars' },
];

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const largeScreen = window.innerWidth * window.devicePixelRatio >= 1400;
const narrowScreen = window.innerWidth < 640;

const els = {
  globe: document.getElementById('globe'),
  layerButtons: document.getElementById('layer-buttons'),
  modeButtons: document.getElementById('mode-buttons'),
  legend: document.getElementById('legend'),
  patternLegend: document.getElementById('pattern-legend'),
  wind: document.getElementById('toggle-wind'),
  hazards: document.getElementById('toggle-hazards'),
  status: document.getElementById('status'),
  refresh: document.getElementById('refresh'),
  details: document.getElementById('details'),
  play: document.getElementById('play'),
  slider: document.getElementById('time-slider'),
  timeLabel: document.getElementById('time-label'),
  now: document.getElementById('now'),
  caption: document.getElementById('caption'),
  controls: document.getElementById('controls'),
};

const state = {
  layer: getLayer('temperature'),
  mode: 'field',
  forecast: null,
  winds: null,
  // Fractional index into forecast.times; the field and wind blend between neighbouring steps.
  t: 0,
  playing: false,
  // Step whose discrete layers (bars, rings) are currently drawn.
  drawnStep: -1,
  dirty: true,
  // 0..1 progress of the colour field fading in after a layer change.
  fieldFade: 0,
  detail: null,
  // Zoomed-in area with finer data: { shape, bounds, data, winds, times, fade }, or null.
  region: null,
  autoRotate: !reducedMotion,
};

if (reducedMotion) els.wind.checked = false;
// On phones the controls start folded so the globe gets the screen.
if (narrowScreen) els.controls.open = false;

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
  // Bars
  .pointLat('lat')
  .pointLng('lng')
  .pointRadius(GRID_STEP * 0.18)
  .pointColor((d) => colorFor(state.layer.stops, d.value))
  .pointAltitude((d) => 0.005 + normalize(state.layer.stops, d.value) * 0.2)
  .pointsTransitionDuration(600)
  .pointLabel(
    (d) => `<div class="tooltip">
      <b>${d.lat}°, ${d.lng}°</b><br/>
      ${state.layer.label}: ${fmt(d.value, state.layer.unit)}<br/>
      ${describeWeatherCode(d.code)}
    </div>`,
  )
  .onPointClick((d) => showDetails(d.lat, d.lng))
  // Severe weather: slow, soft pulses
  .ringColor((d) => (t) => `rgba(${HAZARDS[d.kind].rgb}, ${0.7 * (1 - t) ** 2})`)
  .ringMaxRadius(4)
  .ringPropagationSpeed(1.4)
  .ringRepeatPeriod(2400)
  // Drawn after the colour field and wind layers, which do not write depth, so they show on top.
  .ringAltitude(0.0008)
  .onGlobeClick(({ lat, lng }) => showDetails(lat, lng));

const setMapBrightness = setupBasemap(globe, `${IMAGE_BASE}/earth-blue-marble.jpg`);
const updateMapFeatures = setupMapFeatures(globe);
globe.pointOfView({ lat: 22, lng: -25, altitude: narrowScreen ? 3.6 : 2.4 });
const controls = globe.controls();
controls.autoRotate = !reducedMotion;
controls.autoRotateSpeed = 0.22;
controls.enableDamping = true;
controls.dampingFactor = 0.06;
// Stop about 40 km above the ground, a little above the weather layers.
controls.minDistance = globe.getGlobeRadius() * 1.006;

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
const detailFlow = new WindFlow(globe, {
  bounds: initialRegion.bounds,
  count: largeScreen ? 2200 : 1200,
  width: 1024,
  height: 1024,
  lineWidth: 1.2,
  altitude: 0.0018,
});
detailField.visible = false;
detailFlow.visible = false;

window.addEventListener('resize', () => globe.width(window.innerWidth).height(window.innerHeight));

function radioButtons(container, items, activeKey, onSelect) {
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
}

function renderControls() {
  radioButtons(els.layerButtons, LAYERS, state.layer.key, (key) => {
    if (key === state.layer.key) return;
    state.layer = getLayer(key);
    state.fieldFade = 0;
    invalidate();
  });
  radioButtons(els.modeButtons, MODES, state.mode, (key) => {
    state.mode = key;
    state.fieldFade = 0;
    invalidate();
  });

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

function renderCaption() {
  const time = state.forecast?.times[Math.round(state.t)];
  els.caption.textContent = time ? `${state.layer.label} · ${formatTime(time)}` : state.layer.label;
}

// Re-draw everything on the next frame, e.g. after a layer or display change.
function invalidate() {
  state.drawnStep = -1;
  state.dirty = true;
  flow.visible = els.wind.checked && !state.region;
  detailFlow.visible = els.wind.checked && !!state.region;
  renderControls();
}

// Discrete layers only change when the timeline reaches a new step.
function drawStep(step) {
  const { points, values, times } = state.forecast;
  const layerValues = values[state.layer.variable][step];

  globe.pointsData(
    state.mode === 'bars'
      ? points.map((p, i) => ({ ...p, value: layerValues[i], code: values.weather_code[step][i] }))
      : [],
  );
  globe.ringsData(
    els.hazards.checked ? hazardRings(points, values.weather_code[step], values.precipitation[step]) : [],
  );

  els.slider.value = String(step);
  els.timeLabel.textContent = formatTime(times[step]);
  renderCaption();
  renderDetails();
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
  const show = state.mode === 'field';
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
const globalWind = { u: new Float32Array(shape.rows * shape.cols), v: new Float32Array(shape.rows * shape.cols) };
let regionWind = null;

function blendWind(steps, a, b, t, out) {
  for (let i = 0; i < out.u.length; i++) {
    out.u[i] = steps[a].u[i] + (steps[b].u[i] - steps[a].u[i]) * t;
    out.v[i] = steps[a].v[i] + (steps[b].v[i] - steps[a].v[i]) * t;
  }
}

// Wind at a point from the sharpest data available there.
function sampleWind(lat, lng, out) {
  const regionShape = regionWind && state.region.data.shape;
  if (regionShape && covers(regionShape, lat, lng)) {
    out[0] = sampleGrid(regionWind.u, regionShape, lat, lng);
    out[1] = sampleGrid(regionWind.v, regionShape, lat, lng);
  } else {
    out[0] = sampleGrid(globalWind.u, shape, lat, lng);
    out[1] = sampleGrid(globalWind.v, shape, lat, lng);
  }
  return true;
}

function stepWind(dt) {
  const active = state.region ? detailFlow : flow;
  if (!active.visible) return;
  const [i0, i1, t] = blendIndices();
  blendWind(state.winds, i0, i1, t, globalWind);
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
  requestAnimationFrame(tick);
}

function setPlaying(playing) {
  state.playing = playing;
  els.play.textContent = playing ? '❚❚' : '▶';
  els.play.setAttribute('aria-label', playing ? 'Pause forecast' : 'Play forecast');
}

function seek(step) {
  state.t = step;
  state.dirty = true;
}

async function refresh(force = false) {
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
    els.status.textContent = `${FORECAST_DAYS}-day forecast, every 3 hours`;
  } catch (err) {
    console.error(err);
    els.status.textContent = `${err.message || 'Could not load weather data'}. Try Refresh.`;
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
  const region = { ...regionFor(viewBounds(pov, aspect())), data: null, winds: null, times: null, fade: 0 };
  state.region = region;
  detailFlow.setBounds(region.bounds);
  flow.visible = false;
  detailFlow.visible = els.wind.checked;
  detailField.visible = false;
  state.dirty = true;
  fetchRegion(region);
}

function leaveRegion() {
  state.region = null;
  regionWind = null;
  detailField.visible = false;
  detailFlow.visible = false;
  flow.visible = els.wind.checked;
  state.dirty = true;
}

let lastRegionFetch = 0;
async function fetchRegion(region) {
  if (!isRegionCached(region.shape)) {
    // Zoomed-in detail is optional: wait rather than spend the API's free allowance down to zero.
    if (apiBudget() < region.shape.rows * region.shape.cols + POINT_RESERVE) {
      setTimeout(() => state.region === region && fetchRegion(region), REGION_RETRY_MS);
      return;
    }
    const wait = lastRegionFetch + REGION_FETCH_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    // The view may have moved on while waiting.
    if (state.region !== region) return;
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
  setMapBrightness(pov.altitude);
  updateMapFeatures(pov.altitude);
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

async function showDetails(lat, lng) {
  state.autoRotate = false;
  controls.autoRotate = false;
  const detail = { lat, lng, data: null };
  state.detail = detail;
  els.details.classList.remove('hidden');
  els.details.innerHTML = `<h2>${lat.toFixed(2)}°, ${lng.toFixed(2)}°</h2><p>Loading…</p>`;
  try {
    const data = await loadPointForecast(lat, lng);
    // Ignore the response if another spot was clicked meanwhile.
    if (state.detail === detail) {
      detail.data = data;
      renderDetails();
    }
  } catch (err) {
    console.error(err);
    if (state.detail === detail) {
      els.details.innerHTML = `<h2>${lat.toFixed(2)}°, ${lng.toFixed(2)}°</h2><p>Could not load weather here. ${err.message ?? ''}</p>`;
    }
  }
}

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

function renderDetails() {
  const detail = state.detail;
  if (!detail?.data || !state.forecast) return;
  const { data, lat, lng } = detail;
  const time = state.forecast.times[Math.round(state.t)];
  const index = Math.max(0, data.time.indexOf(time));
  const value = (variable) => data[variable]?.[index];
  const rows = LAYERS.map((l) => `<dt>${l.label}</dt><dd>${fmt(value(l.variable), l.unit)}</dd>`).join('');
  els.details.innerHTML = `
    <h2>${lat.toFixed(2)}°, ${lng.toFixed(2)}°</h2>
    <p>${formatTime(data.time[index])} · ${describeWeatherCode(value('weather_code'))}</p>
    <dl>${rows}<dt>Wind direction</dt><dd>${fmt(value('wind_direction_10m'), '°')}</dd></dl>
    ${sparkline(data.temperature_2m, index)}`;
}

// Fade the controls out when nobody is interacting, so the globe can be watched like a painting.
let idleTimer;
function wake() {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (document.querySelector('.panel:focus-within')) wake();
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
els.hazards.addEventListener('change', invalidate);

flow.visible = els.wind.checked;
onView(globe.pointOfView());
renderControls();
wake();
refresh();
requestAnimationFrame(tick);
