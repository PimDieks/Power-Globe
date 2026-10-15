// The wind check: the operating limits, and a list of major airports where wind and gusts put
// every runway near or over them at the time on the timeline.
import { DEFAULT_LIMITS, PRESETS } from './runways.js';
import { airportWeather, loadAirports, majorAirports } from './airports.js';
import { AIRPORT_RESERVE, apiBudget } from './weather.js';
import { listCopyNote, problemRowHtml, windProblems } from './airportview.js';

const LIMITS_KEY = 'power-globe:limits';
const ORDER_KEY = 'power-globe:check-order';
const LIMIT_NAMES = ['crosswind', 'tailwind'];
const MAX_LIMIT = 99;
// Airports per round of requests, and the fewest worth sending without waiting.
const ROUND = 100;
const MIN_ROUND = 10;
// Weather older than this is fetched again when the panel opens.
const STALE_MS = 60 * 60 * 1000;

const validLimit = (v) => Number.isFinite(v) && v >= 0 && v <= MAX_LIMIT;

export function readLimits(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage.getItem(LIMITS_KEY));
    if (LIMIT_NAMES.every((name) => validLimit(saved?.[name]))) {
      return Object.fromEntries(LIMIT_NAMES.map((name) => [name, saved[name]]));
    }
  } catch {
    // Nothing saved, or storage unavailable.
  }
  return Object.fromEntries(LIMIT_NAMES.map((name) => [name, DEFAULT_LIMITS[name]]));
}

function saveLimits(limits) {
  try {
    localStorage.setItem(LIMITS_KEY, JSON.stringify(limits));
  } catch {
    // Remembering the limits is only a convenience.
  }
}

// The preset matching `limits`, or 'custom'.
export const presetFor = (limits) =>
  Object.keys(PRESETS).find((key) => LIMIT_NAMES.every((name) => PRESETS[key][name] === limits[name])) ?? 'custom';

export const limitsLabel = (limits) => PRESETS[presetFor(limits)]?.label ?? 'Custom';

// Angular distance between two points, for ordering only.
export function distance(a, b) {
  const rad = Math.PI / 180;
  const cos =
    Math.sin(a.lat * rad) * Math.sin(b.lat * rad) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((a.lng - b.lng) * rad);
  return Math.acos(Math.min(1, Math.max(-1, cos)));
}

// `inUse()`: whether the page still uses the findings while the panel is closed (one of its
// airports is open); without the panel and that, nothing is worked out.
export function setupWindCheck({ els, getTime, getCenter, formatTime, onSelect, onProblems, onLimitsChange, inUse = () => false }) {
  let limits = readLimits();
  let airports = null;
  let weather = new Map();
  let loading = null;
  let loadedAt = 0;
  let lastKey = '';
  let frame = 0;

  // Which airports to check first: those nearest the view, or the best connected.
  try {
    if (localStorage.getItem(ORDER_KEY) === 'connected') els.order.value = 'connected';
  } catch {
    // Storage unavailable.
  }
  els.order.addEventListener('change', () => {
    try {
      localStorage.setItem(ORDER_KEY, els.order.value);
    } catch {
      // Remembering the order is only a convenience.
    }
    // A load in progress picks the new order up at its next round.
    if (!loading && airports && weather.size < airports.length) load();
  });

  els.preset.replaceChildren(
    ...[...Object.entries(PRESETS), ['custom', { label: 'Custom' }]].map(([key, { label }]) => new Option(label, key)),
  );

  function showLimits() {
    els.preset.value = presetFor(limits);
    for (const name of LIMIT_NAMES) els[name].value = String(limits[name]);
    showLimitsSummary();
  }

  // The folded limits box says what it holds: "Regional · X 25 · T 10 · H 40 kt".
  function showLimitsSummary() {
    els.limitsSummary.textContent =
      `${limitsLabel(limits)} limits: crosswind ${limits.crosswind} kt, tailwind ${limits.tailwind} kt` +
      (els.marginal.checked ? '' : ', marginal hidden');
  }

  function setLimits(next) {
    limits = next;
    saveLimits(limits);
    showLimitsSummary();
    update();
    onLimitsChange?.();
  }

  els.preset.addEventListener('change', () => {
    const preset = PRESETS[els.preset.value];
    if (!preset) return;
    setLimits(Object.fromEntries(LIMIT_NAMES.map((name) => [name, preset[name]])));
    showLimits();
  });
  for (const name of LIMIT_NAMES) {
    els[name].addEventListener('input', () => {
      const value = Number(els[name].value);
      // Ignore half-typed values; the field keeps what was typed.
      if (els[name].value === '' || !validLimit(value)) return;
      setLimits({ ...limits, [name]: value });
      els.preset.value = presetFor(limits);
    });
  }
  els.marginal.addEventListener('change', () => {
    showLimitsSummary();
    update();
  });
  els.retry.addEventListener('click', () => load());
  els.list.addEventListener('click', (event) => {
    const ident = event.target.closest('[data-ident]')?.dataset.ident;
    const airport = ident && airports?.find((a) => a.ident === ident);
    if (airport) onSelect(airport);
  });

  const setStatus = (text) => {
    els.status.textContent = text;
  };

  // Fetch weather for all major airports, filling the list in as it arrives.
  function load() {
    if (loading) return loading;
    els.retry.hidden = true;
    setStatus('Loading airports…');
    loading = (async () => {
      try {
        airports ??= majorAirports(await loadAirports());
        const total = airports.length;
        const first = () => (els.order.value === 'connected' ? 'most connected first' : 'nearest first');
        setStatus(`Checking ${total} airports, ${first()}…`);
        const checked = new Map();
        weather = checked;
        // The free API takes a few minutes for all of them, so go in rounds, each taking the
        // unchecked airports that matter most: nearest to the middle of the view (so moving the
        // globe while it loads moves the check along with it), or with the most routes.
        for (;;) {
          const remaining = airports.filter((a) => !checked.has(a.ident));
          if (!remaining.length) break;
          const center = getCenter?.();
          if (els.order.value === 'connected') remaining.sort((a, b) => b.routes - a.routes);
          else if (center) remaining.sort((a, b) => distance(a, center) - distance(b, center));
          // As many as the API allows right away (so nearby airports show at once), up to 100.
          const room = apiBudget() - AIRPORT_RESERVE;
          const size = room >= MIN_ROUND ? Math.min(ROUND, room) : ROUND;
          await airportWeather(remaining.slice(0, size), {
            onData: (data) => {
              for (const [ident, hourly] of data) checked.set(ident, hourly);
              scheduleUpdate();
              setStatus(`Checked ${checked.size} of ${total} airports, ${first()}…`);
            },
            onWait: (waiting) => {
              if (waiting) {
                setStatus(`Checked ${checked.size} of ${total} airports. Pacing requests to the free weather API…`);
              }
            },
          });
        }
        loadedAt = Date.now();
        const note = listCopyNote(checked.values(), formatTime);
        setStatus(note ? `${total} major airports checked. ${note}` : `${total} major airports checked`);
      } catch (err) {
        console.error(err);
        setStatus(`${err.message || 'Could not load airport weather'}.`);
        els.retry.hidden = false;
      } finally {
        loading = null;
        update();
      }
    })();
    return loading;
  }

  function scheduleUpdate() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      update();
    });
  }

  // Re-evaluate every airport at the timeline's time with the current limits, while the wind
  // check is in use. Returns whether it did (and so told onProblems).
  function update() {
    if (!airports) return false;
    const hidden = els.panel.classList.contains('hidden');
    if (hidden && !inUse()) {
      lastKey = '';
      return false;
    }
    const time = getTime();
    const { problems, checked } = windProblems(airports, weather, time, limits, { marginal: els.marginal.checked });
    onProblems(problems);
    if (hidden) {
      lastKey = '';
      return true;
    }
    const nogo = problems.filter((p) => p.status === 'nogo').length;
    const caution = problems.length - nogo;
    const key = [time, checked, els.marginal.checked, ...problems.map((p) => `${p.airport.ident}${p.status}${p.best.ident}`)].join();
    if (key === lastKey) return true;
    lastKey = key;

    const parts = [`${nogo} out of limits`];
    if (els.marginal.checked) parts.push(`${caution} marginal`);
    els.summary.textContent = checked
      ? `${formatTime(time)}: ${parts.join(', ')}, of ${checked} airport${checked === 1 ? '' : 's'}`
      : `${formatTime(time)}: no airport weather yet`;

    // Keep keyboard focus on the same airport when the list is redrawn.
    const focused = els.list.contains(document.activeElement) ? document.activeElement.dataset.ident : null;
    els.list.innerHTML = problems.length
      ? problems.map(problemRowHtml).join('')
      : checked
        ? '<li class="empty">No airport has wind trouble at this time with these limits.</li>'
        : '';
    if (focused) els.list.querySelector(`[data-ident="${CSS.escape(focused)}"]`)?.focus();
    return true;
  }

  function open() {
    showLimits();
    els.panel.classList.remove('hidden');
    lastKey = '';
    if (!loading && (!airports || Date.now() - loadedAt > STALE_MS || weather.size < airports.length)) load();
    update();
  }

  function close() {
    els.panel.classList.add('hidden');
  }

  return {
    open,
    close,
    update,
    limits: () => limits,
    label: () => limitsLabel(limits),
  };
}
