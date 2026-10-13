// What the airport panels show: ground conditions, runway wind components and the wind check
// list, as HTML. Pure functions of the data, so they can be tested without a browser.
import { conditionsAt } from './airports.js';
import { STATUS, assessAirport, describeReasons, formatWind } from './runways.js';

// Hours ahead covered by the outlook strip, and its step.
export const OUTLOOK_HOURS = 24;
export const OUTLOOK_STEP = 3;
// Temperature minus dew point at or below which fog and low cloud become likely.
const FOG_SPREAD = 2;

export const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

let regionNames;
// "NL" → "Netherlands", in the reader's language where the browser knows it.
export function countryName(code) {
  try {
    regionNames ??= new Intl.DisplayNames([globalThis.navigator?.language ?? 'en', 'en'], { type: 'region' });
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export const airportCodes = (a) => (a.iata ? `${a.ident} · ${a.iata}` : a.ident);

// One line about where the airport is: "EHAM · AMS · Amsterdam, Netherlands".
export const airportPlace = (a) => [airportCodes(a), [a.city, countryName(a.country)].filter(Boolean).join(', ')].join(' · ');

// GMT time `hours` after `time`, in Open-Meteo's format ("2026-10-13T15:00").
export const addHours = (time, hours) => new Date(Date.parse(`${time}Z`) + hours * 3_600_000).toISOString().slice(0, 16);

const kt = (v) => `${Math.round(v)}`;
// The gust value in brackets when gusts make a real difference to a component.
const withPeak = (mean, peak) => (peak - mean >= 3 ? `${kt(mean)} (${kt(peak)})` : kt(mean));

// Headwind or tailwind on a runway end: "H 12 (18)" or "T 5".
export function alongText(end) {
  if (end.tailwind > end.headwind) return `T ${withPeak(end.tailwind, end.peak.tailwind)}`;
  return `H ${withPeak(end.headwind, end.peak.headwind)}`;
}

// Crosswind and the side it comes from: "14 (22) R".
export const acrossText = (end) => `${withPeak(end.crosswind, end.peak.crosswind)} ${end.crosswindSide}`;

// The worst components of a runway end, in words: "crosswind 31 kt, headwind 12 kt".
export function componentsText(end) {
  const parts = [`crosswind ${kt(end.peak.crosswind)} kt`];
  if (end.peak.tailwind > end.peak.headwind) parts.push(`tailwind ${kt(end.peak.tailwind)} kt`);
  else parts.push(`headwind ${kt(end.peak.headwind)} kt`);
  return parts.join(', ');
}

// How the airport fares at one time, in a sentence.
export function verdictText({ status, best, ends }) {
  if (status === 'unknown' || !best) return 'No wind data for this time';
  if (status === 'nogo') {
    return `Out of limits on every runway. Best is ${best.ident}: ${componentsText(best)}`;
  }
  if (status === 'caution') return `Marginal. Best is runway ${best.ident}: ${componentsText(best)}`;
  const usable = ends.filter((e) => e.status === 'ok').map((e) => e.ident);
  return `Within limits on runway ${usable.join(', ')}`;
}

export const limitsText = (limits) =>
  `crosswind ${limits.crosswind} kt, tailwind ${limits.tailwind} kt`;

// The airport details panel at `time`: conditions, verdict, every runway end and the outlook.
export function airportDetailsHtml({ airport, hourly, time, limits, limitsLabel, formatTime, formatHour }) {
  const now = conditionsAt(hourly, time);
  const routes = airport.routes ? ` · routes to ${airport.routes} airports` : '';
  const head = `<p class="airport-place">${escapeHtml(airportPlace(airport))} · ${Math.round(airport.elevationFt)} ft${routes}</p>`;
  if (!now) {
    return `${head}<p>No forecast for ${escapeHtml(formatTime(time))} here yet.</p>`;
  }
  const result = assessAirport(airport, now, limits);
  const status = STATUS[result.status];
  const spread = now.temperature != null && now.dewPoint != null ? now.temperature - now.dewPoint : null;
  const fog = spread != null && spread <= FOG_SPREAD ? ' · fog or low cloud likely' : '';
  const value = (v, unit) => (v == null ? '–' : `${Math.round(v)} ${unit}`);

  const rows = result.ends
    .map(
      (end) => `<tr class="status-${end.status}">
        <th scope="row">${escapeHtml(end.ident)}</th>
        <td>${alongText(end)}</td>
        <td>${acrossText(end)}</td>
        <td><span class="status-icon" aria-hidden="true">${STATUS[end.status].icon}</span>
          ${escapeHtml(end.status === 'ok' ? STATUS.ok.short : describeReasons(end))}
          <span class="visually-hidden">(${STATUS[end.status].label})</span></td>
      </tr>`,
    )
    .join('');

  const outlook = [];
  for (let h = OUTLOOK_STEP; h <= OUTLOOK_HOURS; h += OUTLOOK_STEP) {
    const t = addHours(time, h);
    const c = conditionsAt(hourly, t);
    if (!c) break;
    const s = assessAirport(airport, c, limits).status;
    outlook.push(
      `<li class="status-${s}"><span class="outlook-hour">${escapeHtml(formatHour(t))}</span>` +
        `<span class="status-icon" aria-hidden="true">${STATUS[s].icon}</span>` +
        `<span class="visually-hidden">${STATUS[s].label}, wind ${escapeHtml(formatWind(c))}</span></li>`,
    );
  }

  return `${head}
    <p>${escapeHtml(formatTime(time))} · model forecast, not an official observation (METAR)</p>
    <div class="verdict status-${result.status}">
      <span class="status-icon" aria-hidden="true">${status.icon}</span>
      <span><b>${status.label}</b><br />${escapeHtml(verdictText(result))}</span>
    </div>
    <dl>
      <dt>Wind</dt><dd>${escapeHtml(formatWind(now))}</dd>
      <dt>Wind speed</dt><dd>${value(now.speed, 'kt')}</dd>
      <dt>Gusts</dt><dd>${value(now.gust, 'kt')}</dd>
      <dt>Temperature</dt><dd>${value(now.temperature, '°C')}</dd>
      <dt>Dew point</dt><dd>${value(now.dewPoint, '°C')}</dd>
    </dl>
    ${spread != null ? `<p class="spread">Spread ${Math.round(spread)} °C${fog}</p>` : ''}
    <table class="runways">
      <caption class="visually-hidden">Wind on each runway, in knots; gusts in brackets</caption>
      <thead><tr><th scope="col">Runway</th><th scope="col">Head / tail</th><th scope="col">Cross</th><th scope="col">Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="table-note">kt; gusts in brackets. H headwind, T tailwind, L/R crosswind from the left or right.</p>
    ${
      outlook.length
        ? `<h3 id="outlook-title">Next ${OUTLOOK_HOURS} hours, best runway</h3><ol class="outlook" aria-labelledby="outlook-title">${outlook.join('')}</ol>`
        : ''
    }
    <p class="limits-note">Limits (${escapeHtml(limitsLabel)}): ${limitsText(limits)}, gusts included. Change them under Wind check.</p>`;
}

// Airports whose runways are all marginal or out of limits at `time`, worst first.
export function windProblems(airports, weather, time, limits, { marginal = true } = {}) {
  const problems = [];
  let checked = 0;
  for (const airport of airports) {
    const conditions = conditionsAt(weather.get(airport.ident), time);
    if (!conditions) continue;
    checked++;
    const result = assessAirport(airport, conditions, limits);
    if (result.status === 'nogo' || (marginal && result.status === 'caution')) {
      problems.push({ airport, conditions, ...result });
    }
  }
  problems.sort((a, b) => STATUS[b.status].rank - STATUS[a.status].rank || b.best.load - a.best.load);
  return { problems, checked };
}

// One row of the wind check list, a button that opens the airport.
export function problemRowHtml({ airport, conditions, status, best }) {
  return `<li><button type="button" class="problem status-${status}" data-ident="${escapeHtml(airport.ident)}">
      <span class="status-icon" aria-hidden="true">${STATUS[status].icon}</span>
      <span class="problem-text">
        <span class="problem-name"><span class="visually-hidden">${STATUS[status].label}: </span><b>${escapeHtml(airportCodes(airport))}</b> ${escapeHtml(airport.name)}</span>
        <span class="problem-detail">${escapeHtml(countryName(airport.country))} · ${escapeHtml(formatWind(conditions))}</span>
        <span class="problem-detail">Best ${escapeHtml(best.ident)}: ${componentsText(best)} · ${escapeHtml(describeReasons(best))} ${status === 'nogo' ? 'over' : 'near'} the limit</span>
      </span>
    </button></li>`;
}
