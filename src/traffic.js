// Live traffic on the globe: flights, military flights and satellites, each behind a toggle.
//
// Flights worldwide come from the OpenSky Network every few minutes; zoomed in, the area in view
// comes from an ADS-B Exchange style feed (adsb.lol, else adsb.fi) every
// few seconds, which also marks military aircraft, and a worldwide military feed comes from the
// same. Between reports each aircraft moves along its track at its ground speed. Satellites
// follow CelesTrak's orbital elements, computed in a worker.
import { AircraftStore, drawnAltitude, estimatePosition, fromAdsb, fromOpenSky, hiddenByLayers } from './aircraft.js';
import { aircraftLayer, behindGlobe, orbitLine, satelliteLayer, selectionRing } from './trafficlayer.js';
import { EARTH_RADIUS_KM, orbitClass, orbitPath, parseTle, periodMinutes, satellitePosition, toGeodetic, toSatrec, tleEpoch } from './orbits.js';
import { aircraftDetailsHtml, aircraftName, satelliteDetailsHtml } from './trafficview.js';
import { PROXY_URL, explain } from './api.js';
import { loadAirports } from './airports.js';
import { setupFlightLines } from './flightlines.js';
import { loadRoute, loadTrack } from './flightroute.js';

const OPENSKY_URL = 'https://opensky-network.org/api/states/all?extended=1';
export const ADSB_PROVIDERS = [
  {
    name: 'adsb.lol',
    military: 'https://api.adsb.lol/v2/mil',
    area: (lat, lng, nm) => `https://api.adsb.lol/v2/point/${lat}/${lng}/${nm}`,
  },
  {
    name: 'adsb.fi',
    military: 'https://opendata.adsb.fi/api/v2/mil',
    area: (lat, lng, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lng}/dist/${nm}`,
  },
];
const CELESTRAK_URL = (group) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
const SNAPSHOT_URL = `${import.meta.env?.BASE_URL ?? '/'}data/satellites/`;

export const SATELLITE_GROUPS = {
  active: 'All active satellites',
  stations: 'Space stations',
  starlink: 'Starlink',
  gnss: 'Navigation (GPS, Galileo, GLONASS, BeiDou)',
  weather: 'Weather',
  military: 'Military',
};

// OpenSky's free anonymous allowance is about 100 worldwide requests a day, so ask rarely and
// move the aircraft in between.
const GLOBAL_MS = 5 * 60_000;
const GLOBAL_RETRY_MS = 5 * 60_000;
const GLOBAL_LIMIT_PAUSE_MS = 30 * 60_000;
const AREA_MS = 15_000;
const MILITARY_MS = 60_000;
// After every ADS-B feed failed, wait this long before asking again.
const FEED_RETRY_MS = 60_000;
// Aircraft not heard from for this long are dropped.
const STALE_MS = GLOBAL_MS + 2 * 60_000;
// Flights within this many nautical miles of the middle of the view come from an ADS-B feed
// every few seconds, at any zoom: it is fresher than the worldwide feed, includes military
// aircraft, and works when the worldwide feed (OpenSky) cannot be reached.
const MAX_AREA_NM = 250;
// Moving the aircraft is smooth enough at 10 updates a second; with many aircraft, a share of
// them moves each frame instead, so no single frame does all the work.
const AIRCRAFT_FRAME_MS = 100;
const AIRCRAFT_PER_FRAME = 2000;
// Satellite positions are worked out a second apart and blended in between.
const SATELLITE_STEP_MS = 1000;
// Orbital elements: CelesTrak asks for each set at most every two hours per browser; the copy
// bundled with the site (refreshed when it is deployed) is used while it is fresh enough.
const LIVE_ELEMENTS_MS = 2 * 3_600_000;
const FRESH_SNAPSHOT_MS = 12 * 3_600_000;
const TIMEOUT_MS = 20_000;

const SETTINGS_KEY = 'power-globe:traffic';
const KM_PER_NM = 1.852;

const EMERGENCY = new Set(['7500', '7600', '7700']);
const COLORS = {
  civil: [0.97, 0.95, 0.9],
  ground: [0.62, 0.66, 0.72],
  military: [0.43, 0.95, 0.76],
  emergency: [1, 0.42, 0.38],
  leo: [0.66, 0.85, 1],
  meo: [1, 0.84, 0.48],
  geo: [1, 0.62, 0.8],
  station: [1, 1, 0.75],
};
export const TRAFFIC_LEGEND = [
  ['plane', COLORS.civil, 'Flight'],
  ['plane', COLORS.military, 'Military flight'],
  ['dot', COLORS.leo, 'Satellite, low orbit'],
  ['dot', COLORS.meo, 'Satellite, medium orbit (navigation)'],
  ['dot', COLORS.geo, 'Satellite, high orbit'],
];

// Why a feed did not answer this browser, in a few words: a blocked request ("Failed to fetch")
// usually means the feed does not accept requests from web pages.
function browserReason(err) {
  if (err.status) return `answered ${err.status}`;
  if (err.name === 'TimeoutError') return 'timed out';
  return /failed to fetch|networkerror|load failed/i.test(err.message) ? 'blocked' : err.message;
}

async function fetchChecked(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    // The Power Globe API says what went wrong upstream as { error }.
    const detail = await res.json().then((body) => body?.error, () => null);
    const err = new Error(detail ? `${detail}` : `${new URL(url).host} answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

const fetchJson = async (url) => (await fetchChecked(url)).json();

// Radius in nautical miles of a circle around the middle of the view that covers most of it.
export function areaRadiusNm(altitude) {
  const halfLatSpan = Math.min(100, 70 * altitude + 0.2) / 2;
  return Math.max(10, Math.min(MAX_AREA_NM, Math.round(halfLatSpan * 1.3 * 60)));
}

const greatCircleNm = (a, b) => {
  const rad = Math.PI / 180;
  const cos =
    Math.sin(a.lat * rad) * Math.sin(b.lat * rad) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((a.lng - b.lng) * rad);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * EARTH_RADIUS_KM) / KM_PER_NM;
};

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Remembering the toggles is only a convenience.
  }
}

// Orbital elements for a group of satellites, as text: the bundled copy while it is fresh, else
// live (see askLive), else the bundled copy however old it is.
export async function loadElements(group) {
  const snapshot = async () => {
    try {
      const res = await fetch(`${SNAPSHOT_URL}${group}.tle`);
      const text = res.ok ? await res.text() : '';
      return /^1 /m.test(text) ? text : null;
    } catch {
      return null;
    }
  };
  let fetched = 0;
  try {
    const meta = await fetch(`${SNAPSHOT_URL}meta.json`).then((r) => (r.ok ? r.json() : null));
    // Each group has its own time; a copy made before that only says when it was all built.
    fetched = Date.parse(meta?.fetched ? meta.fetched[group] : meta?.built) || 0;
  } catch {
    // No bundled copy (e.g. in development).
  }
  if (Date.now() - fetched < FRESH_SNAPSHOT_MS) {
    const text = await snapshot();
    if (text) return text;
  }
  try {
    return await liveElements(group);
  } catch (err) {
    const text = fetched ? await snapshot() : null;
    if (text) return text;
    throw err;
  }
}

// Groups being asked for now, so that two callers share one request.
const asking = new Map();

function liveElements(group) {
  if (!asking.has(group)) asking.set(group, askLive(group).finally(() => asking.delete(group)));
  return asking.get(group);
}

// A group that neither the API nor CelesTrak would give is remembered for two hours (in this
// page and, as far as the browser allows, across page loads), so that a refusal does not turn
// into a request every time satellites are switched on.
const FAILED_KEY = 'power-globe:satellites-failed';
const failures = new Map();

function recentFailure(group) {
  let known = failures.get(group);
  try {
    known ??= JSON.parse(localStorage.getItem(FAILED_KEY))?.[group];
  } catch {
    // Not remembered across page loads.
  }
  return known && Date.now() - known.at < LIVE_ELEMENTS_MS ? known.message : null;
}

function rememberFailure(group, message) {
  const known = { at: Date.now(), message };
  failures.set(group, known);
  try {
    localStorage.setItem(FAILED_KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(FAILED_KEY)), [group]: known }));
  } catch {
    // Remembered in this page only.
  }
}

// A group's elements from one source. CelesTrak answers unknown or throttled requests with a
// short message instead of elements.
async function fetchElements(url) {
  const text = await (await fetchChecked(url)).text();
  if (!/^1 /m.test(text)) throw new Error(`sent no elements (${text.trim().slice(0, 80)})`);
  return text;
}

// Elements from the Power Globe API (which asks CelesTrak from a server), else from CelesTrak
// directly, which accepts requests from web pages. Each group is asked for at most once every
// two hours per browser: an answer is kept for that long whichever way it came, and so is a
// failure. The error says which of the two failed and how.
async function askLive(group) {
  const celestrak = CELESTRAK_URL(group);
  let cache = null;
  try {
    cache = await caches.open('power-globe-satellites');
    const hit = await cache.match(celestrak);
    if (hit && Date.now() - Number(hit.headers.get('x-saved-at')) < LIVE_ELEMENTS_MS) return hit.text();
  } catch {
    cache = null;
  }
  const remembered = recentFailure(group);
  if (remembered) throw new Error(remembered);
  const keep = (text) => {
    cache?.put(celestrak, new Response(text, { headers: { 'x-saved-at': String(Date.now()) } })).catch(() => {});
    return text;
  };
  let proxyReason = null;
  if (PROXY_URL) {
    try {
      return keep(await fetchElements(`${PROXY_URL}/satellites/${group}`));
    } catch (err) {
      console.error(err);
      proxyReason = err.status ? err.message : browserReason(err);
    }
  }
  try {
    return keep(await fetchElements(celestrak));
  } catch (err) {
    console.error(err);
    const own = `CelesTrak ${browserReason(err)}`;
    const message = proxyReason ? `Power Globe API: ${proxyReason}; from this browser: ${own}` : own;
    rememberFailure(group, message);
    throw new Error(message);
  }
}

export function setupTraffic({ globe, els, onSelect, onDeselect, onFlightEnds, announce }) {
  const R = globe.getGlobeRadius();
  const RAD = Math.PI / 180;
  const store = new AircraftStore();
  const planes = aircraftLayer(globe);
  const sats = satelliteLayer(globe);
  const ring = selectionRing(globe);
  const orbit = orbitLine(globe);
  const lines = setupFlightLines({ globe, scenePoint, onLabels: onFlightEnds, loadAirports, loadTrack, loadRoute });

  const settings = { flights: false, military: false, satellites: false, group: 'active', ...readSettings() };
  els.flights.checked = !!settings.flights;
  els.military.checked = !!settings.military;
  els.satellites.checked = !!settings.satellites;
  els.group.replaceChildren(...Object.entries(SATELLITE_GROUPS).map(([key, label]) => new Option(label, key)));
  els.group.value = SATELLITE_GROUPS[settings.group] ? settings.group : 'active';

  const status = { flights: '', military: '', satellites: '' };
  let provider = 0;
  let nextGlobal = 0;
  let nextMilitary = 0;
  let nextArea = 0;
  let lastArea = null;
  // Whether the last request for the area failed. Its retry waits FEED_RETRY_MS whatever the view does.
  let areaFailed = false;
  const inFlight = new Set();
  let shown = [];
  // Bumped when new aircraft data arrives or the toggles change, to rebuild the shown list.
  let version = 0;
  let shownVersion = -1;
  let lastAircraftFrame = 0;
  let cursor = 0;
  let selected = null;
  let announcedFlights = false;

  // Satellites: elements, worker and the two most recent position sets.
  let satellites = { group: null, tles: [], classes: [], frames: [], pending: false, loading: null };
  let worker = null;

  // ADS-B Exchange style feeds: the one that worked last, else the next.
  async function fromProviders(urlFor, proxyPath) {
    // The Power Globe API asks the feeds server-side; most feeds do not answer web pages.
    let proxyError = null;
    if (PROXY_URL) {
      try {
        const { source, data } = await fetchJson(`${PROXY_URL}${proxyPath}`);
        return { data, name: source };
      } catch (err) {
        console.error(err);
        proxyError = err;
      }
    }
    const failures = [];
    for (let k = 0; k < ADSB_PROVIDERS.length; k++) {
      const i = (provider + k) % ADSB_PROVIDERS.length;
      try {
        const data = await fetchJson(urlFor(ADSB_PROVIDERS[i]));
        provider = i;
        return { data, name: ADSB_PROVIDERS[i].name };
      } catch (err) {
        failures.push(`${ADSB_PROVIDERS[i].name} ${browserReason(err)}`);
      }
    }
    // What the API and this browser were each told, so it is clear which way is blocked.
    throw new Error([proxyError && `Power Globe API: ${proxyError.message}`, `from this browser: ${failures.join(', ')}`].filter(Boolean).join('; '));
  }

  async function once(key, task) {
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      await task();
    } finally {
      inFlight.delete(key);
      renderStatus();
    }
  }

  function addAircraft(list, source) {
    for (const ac of list) ac.source = source;
    store.update(list);
    store.prune(Date.now(), STALE_MS);
    version++;
    lastAircraftFrame = 0;
  }

  const timeText = () => new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  async function openSky() {
    let proxyError = null;
    if (PROXY_URL) {
      try {
        return (await fetchJson(`${PROXY_URL}/flights/global`)).data;
      } catch (err) {
        console.error(err);
        proxyError = err;
      }
    }
    try {
      return await fetchJson(OPENSKY_URL);
    } catch (err) {
      if (!proxyError) throw err;
      const reported = new Error(`Power Globe API: ${proxyError.message}; from this browser: OpenSky ${browserReason(err)}`);
      reported.status = err.status === 429 ? 429 : proxyError.status;
      throw reported;
    }
  }

  function loadGlobal() {
    return once('global', async () => {
      try {
        const list = fromOpenSky(await openSky());
        addAircraft(list, 'OpenSky Network');
        nextGlobal = Date.now() + GLOBAL_MS;
        status.flights = `Worldwide from OpenSky Network, ${timeText()}`;
        if (!announcedFlights) {
          announcedFlights = true;
          announce?.(`${list.length.toLocaleString()} flights shown.`);
        }
      } catch (err) {
        console.error(err);
        const limited = err.status === 429;
        nextGlobal = Date.now() + (limited ? GLOBAL_LIMIT_PAUSE_MS : GLOBAL_RETRY_MS);
        status.flights = limited
          ? "OpenSky's free daily allowance is used up for now; showing flights around the middle of the view."
          : `Worldwide flights unavailable (${explain(err)}); showing flights around the middle of the view.`;
      }
    });
  }

  function loadArea(pov) {
    const center = { lat: +pov.lat.toFixed(2), lng: +pov.lng.toFixed(2) };
    const nm = areaRadiusNm(pov.altitude);
    return once('area', async () => {
      try {
        const { data, name } = await fromProviders((p) => p.area(center.lat, center.lng, nm), `/flights/area?lat=${center.lat}&lon=${center.lng}&nm=${nm}`);
        addAircraft(fromAdsb(data), name);
        lastArea = { ...center, nm };
        areaFailed = false;
        status.area = `In view from ${name}, ${timeText()}`;
        nextArea = Date.now() + AREA_MS;
      } catch (err) {
        console.error(err);
        areaFailed = true;
        status.area = `Flights in view unavailable (${explain(err)})`;
        nextArea = Date.now() + FEED_RETRY_MS;
      }
    });
  }

  function loadMilitary() {
    return once('military', async () => {
      try {
        const { data, name } = await fromProviders((p) => p.military, '/flights/military');
        addAircraft(fromAdsb(data, { military: true }), name);
        status.military = `Worldwide from ${name}, ${timeText()}`;
        nextMilitary = Date.now() + MILITARY_MS;
      } catch (err) {
        console.error(err);
        status.military = `Worldwide military flights unavailable (${explain(err)}); showing those around the middle of the view.`;
        nextMilitary = Date.now() + FEED_RETRY_MS;
      }
    });
  }

  function startWorker() {
    worker ??= new Worker(new URL('./satworker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'loaded') {
        satellites.classes = data.classes;
        // Colours and sizes, worked out once: by orbit, with space stations brighter.
        const n = data.classes.length;
        satellites.colors = new Float32Array(n * 3);
        satellites.scales = new Float32Array(n);
        data.classes.forEach((cls, i) => {
          const station = /\b(ISS|TIANHE|CSS)\b/.test(satellites.tles[i]?.name ?? '');
          satellites.colors.set(station ? COLORS.station : (COLORS[cls] ?? COLORS.leo), 3 * i);
          satellites.scales[i] = station ? 2.2 : 1;
        });
        satellites.frames = [];
      } else if (data.type === 'positions') {
        satellites.pending = false;
        if (data.id !== satellites.group) return;
        satellites.frames = [...satellites.frames, { time: data.time, positions: data.positions }].sort((a, b) => a.time - b.time).slice(-2);
      }
    };
  }

  function loadSatellites(group) {
    if (satellites.group === group && (satellites.loading || satellites.tles.length)) return;
    satellites = { group, tles: [], classes: [], frames: [], pending: false, loading: null };
    status.satellites = `Loading ${SATELLITE_GROUPS[group].toLowerCase()}…`;
    renderStatus();
    const current = satellites;
    current.loading = loadElements(group)
      .then((text) => {
        if (satellites !== current) return;
        current.tles = parseTle(text);
        startWorker();
        worker.postMessage({ type: 'load', tles: current.tles.map(({ line1, line2 }) => ({ line1, line2 })) });
        const newest = current.tles.reduce((t, s) => Math.max(t, tleEpoch(s.line1).getTime()), 0);
        status.satellites =
          `${current.tles.length.toLocaleString()} ${SATELLITE_GROUPS[group].toLowerCase()} from CelesTrak` +
          (newest ? `, elements up to ${new Date(newest).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '');
        announce?.(`${current.tles.length.toLocaleString()} satellites shown.`);
      })
      .catch((err) => {
        console.error(err);
        if (satellites === current) status.satellites = `Satellites unavailable (${explain(err)})`;
      })
      .finally(() => {
        current.loading = null;
        renderStatus();
      });
  }

  function renderStatus() {
    const lines = [];
    if (settings.flights) lines.push(status.flights || 'Loading flights…');
    if ((settings.flights || settings.military) && status.area) lines.push(status.area);
    if (settings.military) lines.push(status.military || 'Loading military flights…');
    if (settings.satellites) lines.push(status.satellites);
    els.status.replaceChildren(
      ...lines.map((text) => {
        const p = document.createElement('p');
        p.textContent = text;
        return p;
      }),
    );
    els.groupRow.hidden = !settings.satellites;
    for (const [key, on] of Object.entries({ flights: settings.flights || settings.military, satellites: settings.satellites })) {
      els.credits[key].hidden = !on;
    }
    els.credits.adsbName.textContent = ADSB_PROVIDERS[provider].name;
  }

  function applySettings() {
    settings.flights = els.flights.checked;
    settings.military = els.military.checked;
    settings.satellites = els.satellites.checked;
    settings.group = els.group.value;
    saveSettings(settings);
    planes.visible = settings.flights || settings.military;
    sats.visible = settings.satellites;
    if (selected?.kind === 'aircraft' && hiddenByLayers(store.byId.get(selected.id), settings)) deselect();
    if (selected?.kind === 'satellite' && (!settings.satellites || selected.group !== settings.group)) deselect();
    if (settings.satellites) loadSatellites(settings.group);
    version++;
    lastAircraftFrame = 0;
    renderStatus();
  }
  for (const el of [els.flights, els.military, els.satellites, els.group]) el.addEventListener('change', applySettings);

  // Scene position of a point `altitude` globe radii above lat/lng (as three-globe places it).
  function scenePoint(lat, lng, altitude, out, i) {
    const r = R * (1 + altitude);
    const cosLat = Math.cos(lat * RAD);
    out[3 * i] = r * cosLat * Math.sin(lng * RAD);
    out[3 * i + 1] = r * Math.sin(lat * RAD);
    out[3 * i + 2] = r * cosLat * Math.cos(lng * RAD);
  }

  function drawAircraft(now) {
    const show = settings.flights || settings.military;
    if (!show) return;
    if (shownVersion === version && shown.length <= AIRCRAFT_PER_FRAME && now - lastAircraftFrame < AIRCRAFT_FRAME_MS) return;
    lastAircraftFrame = now;
    const capacity = planes.capacity;
    const attrs = planes.reserve(store.size);
    const rebuilt = shownVersion !== version || planes.capacity !== capacity;
    if (rebuilt) {
      // Which aircraft, and their colours and sizes, change only with new data.
      shownVersion = version;
      shown = store.list({ civil: settings.flights, military: settings.military });
      shown.forEach((ac, i) => {
        const color = EMERGENCY.has(ac.squawk) ? COLORS.emergency : ac.military ? COLORS.military : ac.onGround ? COLORS.ground : COLORS.civil;
        attrs.aColor[3 * i] = color[0];
        attrs.aColor[3 * i + 1] = color[1];
        attrs.aColor[3 * i + 2] = color[2];
        attrs.aScale[i] = ac.onGround ? 0.7 : 1;
        attrs.aHeading[i] = (ac.track ?? 0) * RAD;
      });
    }
    // Move all aircraft after new data, else a slice per frame so the work is spread out.
    const all = rebuilt || shown.length <= AIRCRAFT_PER_FRAME;
    const from = all ? 0 : cursor % shown.length;
    const n = all ? shown.length : AIRCRAFT_PER_FRAME;
    for (let k = 0; k < n; k++) {
      const i = (from + k) % shown.length;
      const ac = shown[i];
      const p = estimatePosition(ac, now);
      ac.estimate = p;
      scenePoint(p.lat, p.lng, drawnAltitude(ac), attrs.position, i);
    }
    cursor = from + n;
    planes.commit(shown.length);
  }

  function drawSatellites(now) {
    if (!settings.satellites || !worker || !satellites.colors) return;
    const frames = satellites.frames;
    // Keep a position set a second ahead of now.
    const latest = frames.at(-1)?.time ?? 0;
    if (!satellites.pending && latest - now < SATELLITE_STEP_MS) {
      satellites.pending = true;
      worker.postMessage({ type: 'positions', time: Math.max(latest + SATELLITE_STEP_MS, now), id: satellites.group });
    }
    if (!frames.length) return;
    const [a, b] = frames.length > 1 ? frames : [frames[0], frames[0]];
    if (satellites.drawn !== b) fillSatellites(a, b);
    sats.mix = b.time === a.time ? 0 : Math.min(1, Math.max(0, (now - a.time) / (b.time - a.time)));
  }

  // Load a pair of position sets into the GPU buffers, once per new set; the shader blends them.
  function fillSatellites(a, b) {
    satellites.drawn = b;
    const n = satellites.tles.length;
    const attrs = sats.reserve(n);
    const scale = R / EARTH_RADIUS_KM;
    satellites.index = satellites.index?.length === n ? satellites.index : new Int32Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      const j = 3 * i;
      if (Number.isNaN(a.positions[j]) || Number.isNaN(b.positions[j])) continue;
      const k = 3 * count;
      // Earth-fixed to the globe's frame: north is +y, 0°N 0°E is +z.
      attrs.position[k] = a.positions[j + 1] * scale;
      attrs.position[k + 1] = a.positions[j + 2] * scale;
      attrs.position[k + 2] = a.positions[j] * scale;
      attrs.aNext[k] = b.positions[j + 1] * scale;
      attrs.aNext[k + 1] = b.positions[j + 2] * scale;
      attrs.aNext[k + 2] = b.positions[j] * scale;
      attrs.aColor[k] = satellites.colors[j];
      attrs.aColor[k + 1] = satellites.colors[j + 1];
      attrs.aColor[k + 2] = satellites.colors[j + 2];
      attrs.aScale[count] = satellites.scales[i];
      satellites.index[count] = i;
      count++;
    }
    sats.commit(count);
  }

  // Where satellite `k` (in drawing order) is drawn right now.
  function satelliteAt(k) {
    const p = sats.geometry.attributes.position.array;
    const q = sats.geometry.attributes.aNext.array;
    const t = sats.points.material.uniforms.uMix.value;
    return [0, 1, 2].map((c) => p[3 * k + c] + (q[3 * k + c] - p[3 * k + c]) * t);
  }

  // Pixel sizes for the zoom: small when looking at the whole globe, bigger zoomed in.
  function resize(altitude) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const planePx = Math.max(6, Math.min(20, 20 * (0.12 / Math.max(altitude, 0.01)) ** 0.35));
    planes.size = planePx * dpr;
    // The plane drawn in the sprite reaches about 0.44 of its width from the middle.
    lines.setSprite(planePx * 0.44);
    sats.size = Math.max(2.5, Math.min(5, 4 * (1.2 / Math.max(altitude, 0.05)) ** 0.25)) * dpr;
    ring.size = 34 * dpr;
    planes.setViewport(window.innerWidth, window.innerHeight);
    lines.setViewport(window.innerWidth, window.innerHeight);
  }

  // Called every frame with the camera's point of view.
  function frame(now, pov) {
    if (!document.hidden) {
      const wall = Date.now();
      if (settings.flights && wall >= nextGlobal) loadGlobal();
      if (settings.military && wall >= nextMilitary) loadMilitary();
      if (settings.flights || settings.military) {
        // A view that has moved on is asked for at once, except after a failure: the area then stays
        // the one before it, so it would look moved on every frame and ask again and again.
        const moved = lastArea && !areaFailed && greatCircleNm(lastArea, pov) > lastArea.nm / 2;
        if (wall >= nextArea || moved) loadArea(pov);
      }
    }
    resize(pov.altitude);
    drawAircraft(Date.now());
    drawSatellites(Date.now());
    ring.place(selectedPosition());
    if (selected?.kind === 'aircraft') {
      const ac = store.byId.get(selected.id);
      lines.frame(ac, ac?.estimate, pov.altitude);
    }
  }

  // Scene position of the selected aircraft or satellite, or null.
  function selectedPosition() {
    if (selected?.kind === 'aircraft') {
      const ac = store.byId.get(selected.id);
      if (!ac?.estimate) return null;
      const out = [0, 0, 0];
      scenePoint(ac.estimate.lat, ac.estimate.lng, drawnAltitude(ac), out, 0);
      return { x: out[0], y: out[1], z: out[2] };
    }
    if (selected?.kind === 'satellite') {
      const k = indexOfSatellite(selected.index);
      if (k < 0) return null;
      const [x, y, z] = satelliteAt(k);
      return { x, y, z };
    }
    return null;
  }

  function indexOfSatellite(i) {
    const idx = satellites.index;
    if (!idx) return -1;
    for (let k = 0; k < sats.count; k++) if (idx[k] === i) return k;
    return -1;
  }

  // The aircraft or satellite drawn nearest to a screen point, within a finger's reach, that is
  // not hidden behind the globe (by the same test as the layers use to hide them).
  function pick(clientX, clientY) {
    const camera = globe.camera();
    const rect = globe.renderer().domElement.getBoundingClientRect();
    const cam = camera.position;
    const reach = 16;
    let best = null;
    let bestD = reach * reach;
    const v = { x: 0, y: 0, z: 0 };
    const test = (x, y, z, hit) => {
      if (behindGlobe(cam, x, y, z, R)) return;
      v.x = x;
      v.y = y;
      v.z = z;
      const p = project(v, camera);
      if (!p) return;
      const sx = rect.left + ((p.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - p.y) / 2) * rect.height;
      const d = (sx - clientX) ** 2 + (sy - clientY) ** 2;
      if (d < bestD) {
        bestD = d;
        best = hit();
      }
    };
    if (planes.points.visible) {
      const p = planes.geometry.attributes.position?.array;
      for (let i = 0; i < planes.count; i++) test(p[3 * i], p[3 * i + 1], p[3 * i + 2], () => ({ kind: 'aircraft', id: shown[i].id }));
    }
    if (sats.points.visible && sats.count) {
      for (let k = 0; k < sats.count; k++) {
        const [x, y, z] = satelliteAt(k);
        test(x, y, z, () => ({ kind: 'satellite', index: satellites.index[k], group: satellites.group }));
      }
    }
    return best;
  }

  function select(item) {
    selected = item;
    orbit.hide();
    if (item.kind === 'aircraft') lines.start(item.id, store.byId.get(item.id));
    else lines.stop();
    if (item.kind === 'satellite') {
      const tle = satellites.tles[item.index];
      item.satrec = toSatrec(tle);
      item.tle = tle;
      showOrbit();
    }
    onSelect?.(item, title(item));
  }

  function showOrbit() {
    if (selected?.kind !== 'satellite' || !selected.satrec) return;
    const scale = R / EARTH_RADIUS_KM;
    selected.orbitAt = Date.now();
    orbit.show(orbitPath(selected.satrec, new Date()).map((p) => ({ x: p.y * scale, y: p.z * scale, z: p.x * scale })));
  }

  function deselect() {
    if (!selected) return;
    selected = null;
    orbit.hide();
    lines.stop();
    ring.place(null);
    onDeselect?.();
  }

  function title(item) {
    if (item.kind === 'aircraft') {
      const ac = store.byId.get(item.id);
      return ac ? aircraftName(ac) : item.id.toUpperCase();
    }
    return satellites.tles[item.index]?.name ?? 'Satellite';
  }

  // The selected aircraft's latest report (see aircraft.js), for a camera that follows it, or null
  // when an aircraft is not selected or is no longer received.
  function selectedAircraft() {
    return selected?.kind === 'aircraft' ? (store.byId.get(selected.id) ?? null) : null;
  }

  // Details of the selected aircraft or satellite, as HTML, or null if it is gone.
  function detailsHtml() {
    const now = Date.now();
    if (selected?.kind === 'aircraft') {
      const ac = store.byId.get(selected.id);
      if (!ac) return '<p>No longer received.</p>';
      return aircraftDetailsHtml(ac, { position: ac.estimate ?? ac, now, flight: lines.info() });
    }
    if (selected?.kind === 'satellite' && selected.satrec) {
      // Keep the drawn orbit ahead of the satellite.
      if (now - selected.orbitAt > 60_000) showOrbit();
      const p = satellitePosition(selected.satrec, new Date(now));
      return satelliteDetailsHtml(selected.tle, {
        position: p && toGeodetic(p),
        speed: p?.speed,
        period: periodMinutes(selected.satrec),
        inclination: selected.satrec.inclo / RAD,
        orbit: orbitClass(selected.satrec),
        epoch: tleEpoch(selected.tle.line1),
        now,
      });
    }
    return null;
  }

  applySettings();

  return { frame, pick, select, deselect, detailsHtml, title, selectedAircraft, flightInfo: lines.info, get selected() { return selected; } };
}

// Normalised device coordinates of a point, or null if it is behind the camera.
function project(v, camera) {
  const e = camera.matrixWorldInverse.elements;
  const x = e[0] * v.x + e[4] * v.y + e[8] * v.z + e[12];
  const y = e[1] * v.x + e[5] * v.y + e[9] * v.z + e[13];
  const z = e[2] * v.x + e[6] * v.y + e[10] * v.z + e[14];
  if (z >= 0) return null;
  const p = camera.projectionMatrix.elements;
  const w = p[3] * x + p[7] * y + p[11] * z + p[15];
  return { x: (p[0] * x + p[4] * y + p[8] * z + p[12]) / w, y: (p[1] * x + p[5] * y + p[9] * z + p[13]) / w };
}
