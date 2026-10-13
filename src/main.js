import Globe from 'globe.gl';
import { LAYERS, getLayer, colorFor, normalize, describeWeatherCode } from './layers.js';
import { FORECAST_DAYS, gridShape, loadForecast, loadPointForecast, parseTime, startIndex } from './weather.js';
import { FieldOverlay } from './field.js';
import { HAZARDS, hazardRings, windStreaks } from './patterns.js';

const GRID_STEP = 10;
// Timeline playback speed, in forecast steps (3 hours each) per second.
const STEPS_PER_SECOND = 2;
const IMAGE_BASE = `${import.meta.env.BASE_URL}img`;
const MODES = [
  { key: 'field', label: 'Smooth field' },
  { key: 'bars', label: 'Bars' },
];

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
};

const state = {
  layer: getLayer('temperature'),
  mode: 'field',
  forecast: null,
  // Fractional index into forecast.times; the field blends between neighbouring steps.
  t: 0,
  playing: false,
  // Step whose discrete layers (bars, wind, rings) are currently drawn.
  drawnStep: -1,
  dirty: true,
  detail: null,
};

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

const globe = new Globe(els.globe)
  .globeImageUrl(`${IMAGE_BASE}/earth-blue-marble.jpg`)
  .bumpImageUrl(`${IMAGE_BASE}/earth-topology.png`)
  .backgroundImageUrl(`${IMAGE_BASE}/night-sky.png`)
  // Bars
  .pointLat('lat')
  .pointLng('lng')
  .pointRadius(GRID_STEP * 0.18)
  .pointColor((d) => colorFor(state.layer.stops, d.value))
  .pointAltitude((d) => 0.005 + normalize(state.layer.stops, d.value) * 0.2)
  .pointsTransitionDuration(400)
  .pointLabel(
    (d) => `<div class="tooltip">
      <b>${d.lat}°, ${d.lng}°</b><br/>
      ${state.layer.label}: ${fmt(d.value, state.layer.unit)}<br/>
      ${describeWeatherCode(d.code)}
    </div>`,
  )
  .onPointClick((d) => showDetails(d.lat, d.lng))
  // Wind flow
  .pathPoints('points')
  .pathPointLat('lat')
  .pathPointLng('lng')
  .pathPointAlt(0.006)
  .pathResolution(1)
  .pathStroke(0.6)
  .pathColor((d) => ['rgba(255, 255, 255, 0)', `rgba(255, 255, 255, ${Math.min(0.95, 0.35 + d.speed / 60)})`])
  .pathDashLength(0.35)
  .pathDashGap(0.25)
  .pathDashAnimateTime(1400)
  .pathTransitionDuration(0)
  // Severe weather
  .ringColor((d) => (t) => `rgba(${HAZARDS[d.kind].rgb}, ${1 - t})`)
  .ringMaxRadius(5)
  .ringPropagationSpeed(3)
  .ringRepeatPeriod(1100)
  .onGlobeClick(({ lat, lng }) => showDetails(lat, lng));

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.35;

const field = new FieldOverlay(globe, gridShape(GRID_STEP));

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
    state.layer = getLayer(key);
    invalidate();
  });
  radioButtons(els.modeButtons, MODES, state.mode, (key) => {
    state.mode = key;
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
  if (els.wind.checked) items.push('<span class="swatch streak"></span>Wind, pointing downwind');
  if (els.hazards.checked) {
    for (const { label, rgb } of Object.values(HAZARDS)) {
      items.push(`<span class="swatch ring" style="border-color: rgb(${rgb})"></span>${label}`);
    }
  }
  els.patternLegend.innerHTML = items.map((i) => `<div>${i}</div>`).join('');
}

// Re-draw everything on the next frame, e.g. after a layer or display change.
function invalidate() {
  state.drawnStep = -1;
  state.dirty = true;
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
  globe.pathsData(
    els.wind.checked ? windStreaks(points, values.wind_speed_10m[step], values.wind_direction_10m[step]) : [],
  );
  globe.ringsData(
    els.hazards.checked ? hazardRings(points, values.weather_code[step], values.precipitation[step]) : [],
  );

  els.slider.value = String(step);
  els.timeLabel.textContent = formatTime(times[step]);
  renderDetails();
  state.drawnStep = step;
}

function drawField() {
  field.visible = state.mode === 'field';
  if (state.mode !== 'field') return;
  const series = state.forecast.values[state.layer.variable];
  const i0 = Math.floor(state.t);
  const i1 = Math.min(i0 + 1, series.length - 1);
  field.render(series[i0], series[i1], state.t - i0, state.layer.stops);
}

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
    state.forecast = await loadForecast({ step: GRID_STEP, force });
    const { times } = state.forecast;
    els.slider.max = String(times.length - 1);
    for (const el of [els.play, els.slider, els.now]) el.disabled = false;
    state.drawnStep = -1;
    seek(startIndex(times));
    els.status.textContent = `${FORECAST_DAYS}-day forecast, every 3 hours`;
  } catch (err) {
    console.error(err);
    els.status.textContent = 'Could not load weather data.';
  } finally {
    els.refresh.disabled = false;
  }
}

async function showDetails(lat, lng) {
  globe.controls().autoRotate = false;
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
      els.details.innerHTML = `<h2>${lat.toFixed(2)}°, ${lng.toFixed(2)}°</h2><p>Could not load weather here.</p>`;
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

renderControls();
refresh();
requestAnimationFrame(tick);
