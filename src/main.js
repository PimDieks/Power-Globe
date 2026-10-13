import Globe from 'globe.gl';
import { LAYERS, getLayer, colorFor, normalize, describeWeatherCode } from './layers.js';
import { loadGlobalWeather, loadPointWeather } from './weather.js';

const GRID_STEP = 10;
const IMAGE_BASE = `${import.meta.env.BASE_URL}img`;

const els = {
  globe: document.getElementById('globe'),
  buttons: document.getElementById('layer-buttons'),
  legend: document.getElementById('legend'),
  status: document.getElementById('status'),
  refresh: document.getElementById('refresh'),
  details: document.getElementById('details'),
};

let activeLayer = getLayer('temperature');
let weather = [];

const fmt = (value, unit) => (value == null ? '–' : `${Math.round(value * 10) / 10} ${unit}`);

const globe = new Globe(els.globe)
  .globeImageUrl(`${IMAGE_BASE}/earth-blue-marble.jpg`)
  .bumpImageUrl(`${IMAGE_BASE}/earth-topology.png`)
  .backgroundImageUrl(`${IMAGE_BASE}/night-sky.png`)
  .pointLat('lat')
  .pointLng('lng')
  .pointRadius(GRID_STEP * 0.18)
  .pointColor((d) => colorFor(activeLayer.stops, d[activeLayer.variable]))
  .pointAltitude((d) => 0.005 + normalize(activeLayer.stops, d[activeLayer.variable]) * 0.2)
  .pointLabel(
    (d) => `<div class="tooltip">
      <b>${d.lat}°, ${d.lng}°</b><br/>
      ${activeLayer.label}: ${fmt(d[activeLayer.variable], activeLayer.unit)}<br/>
      ${describeWeatherCode(d.weather_code)}
    </div>`,
  )
  .onPointClick((d) => showDetails(d.lat, d.lng))
  .onGlobeClick(({ lat, lng }) => showDetails(lat, lng));

globe.controls().autoRotate = true;
globe.controls().autoRotateSpeed = 0.35;

window.addEventListener('resize', () => globe.width(window.innerWidth).height(window.innerHeight));

function renderButtons() {
  els.buttons.replaceChildren(
    ...LAYERS.map((layer) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = layer.label;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(layer === activeLayer));
      btn.addEventListener('click', () => setLayer(layer.key));
      return btn;
    }),
  );
}

function renderLegend() {
  const { stops, unit } = activeLayer;
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  const gradient = stops.map(([v, c]) => `${c} ${((v - min) / (max - min)) * 100}%`).join(', ');
  els.legend.innerHTML = `
    <div class="legend-bar" style="background: linear-gradient(to right, ${gradient})"></div>
    <div class="legend-labels"><span>${min} ${unit}</span><span>${max} ${unit}</span></div>`;
}

function setLayer(key) {
  activeLayer = getLayer(key);
  renderButtons();
  renderLegend();
  // Re-assigning the data makes globe.gl re-evaluate colour and altitude accessors.
  globe.pointsData([...weather]);
}

async function refresh(force = false) {
  els.status.textContent = 'Loading weather…';
  els.refresh.disabled = true;
  try {
    weather = await loadGlobalWeather({ step: GRID_STEP, force });
    globe.pointsData(weather);
    const time = weather.find((d) => d.time)?.time;
    els.status.textContent = time ? `Updated ${time.replace('T', ' ')} UTC` : 'Updated';
  } catch (err) {
    console.error(err);
    els.status.textContent = 'Could not load weather data.';
  } finally {
    els.refresh.disabled = false;
  }
}

async function showDetails(lat, lng) {
  globe.controls().autoRotate = false;
  els.details.classList.remove('hidden');
  els.details.innerHTML = `<h2>${lat.toFixed(2)}°, ${lng.toFixed(2)}°</h2><p>Loading…</p>`;
  try {
    const d = await loadPointWeather(lat, lng);
    const rows = LAYERS.map((l) => `<dt>${l.label}</dt><dd>${fmt(d[l.variable], l.unit)}</dd>`).join('');
    els.details.innerHTML = `
      <h2>${lat.toFixed(2)}°, ${lng.toFixed(2)}°</h2>
      <p>${describeWeatherCode(d.weather_code)}</p>
      <dl>${rows}<dt>Wind direction</dt><dd>${fmt(d.wind_direction_10m, '°')}</dd></dl>`;
  } catch (err) {
    console.error(err);
    els.details.innerHTML = `<h2>${lat.toFixed(2)}°, ${lng.toFixed(2)}°</h2><p>Could not load weather here.</p>`;
  }
}

els.refresh.addEventListener('click', () => refresh(true));

renderButtons();
renderLegend();
refresh();
