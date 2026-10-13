// What the airport panels show: ground conditions, runway wind components and the wind check
// list, as HTML. Pure functions of the data, so they can be tested without a browser.
import { conditionsAt } from './airports.js';
import { STATUS, assessAirport, assessRunwayEnd, describeReasons, formatWind } from './runways.js';
import { FLIGHT_CATEGORIES } from './metar.js';

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

// Variable wind can come from any direction, so judge every runway as if it were all crosswind
// and all tailwind at once.
export function assessVariable(airport, wind, limits) {
  const cross = assessRunwayEnd(0, { ...wind, direction: 90 }, limits);
  const tail = assessRunwayEnd(0, { ...wind, direction: 180 }, limits);
  const worst = STATUS[tail.status].rank > STATUS[cross.status].rank ? tail : cross;
  return { status: worst.status, reasons: [...new Set([...cross.reasons, ...tail.reasons])] };
}

const minutesAgo = (t, now) => Math.max(0, Math.round((now - t) / 60_000));

// The latest METAR: what is observed now, and whether the runways can be used in that wind.
export function observationHtml(airport, observation, limits, now = Date.now()) {
  if (observation === undefined) return '<section class="observation"><h3>Observed now</h3><p>Loading the latest METAR…</p></section>';
  if (observation?.error) {
    return `<section class="observation"><h3>Observed now</h3><p>The official observation (METAR) could not be loaded here (${escapeHtml(observation.error)}).</p></section>`;
  }
  if (!observation) return '<section class="observation"><h3>Observed now</h3><p>No METAR from this airport in the last three hours.</p></section>';
  const o = observation;
  const age = o.time ? `${minutesAgo(o.time, now)} min ago` : '';
  let verdict;
  if (o.speed == null) verdict = { status: 'unknown', text: 'No wind reported' };
  else if (o.variable || o.direction == null) {
    const v = assessVariable(airport, o, limits);
    verdict = {
      status: v.status,
      text: `Variable ${Math.round(o.speed)} kt${o.gust ? ` gusting ${Math.round(o.gust)}` : ''}: ${
        v.status === 'ok' ? 'within limits on every runway' : `${describeReasons(v).toLowerCase()} could exceed the limit`
      }`,
    };
  } else {
    const result = assessAirport(airport, o, limits);
    verdict = { status: result.status, text: `${formatWind(o)}: ${verdictText(result)}` };
  }
  const category = FLIGHT_CATEGORIES[o.category];
  const details = [
    o.visibility != null ? `visibility ${o.visibility >= 10 ? '10+' : o.visibility} mi` : '',
    o.ceiling != null ? `ceiling ${o.ceiling.toLocaleString()} ft` : 'no ceiling',
    o.temperature != null ? `${o.temperature} °C / dew point ${o.dewPoint ?? '–'} °C` : '',
  ].filter(Boolean);
  return `<section class="observation">
      <h3>Observed now <span class="observation-age">METAR, ${escapeHtml(age)}</span></h3>
      <div class="verdict status-${verdict.status}">
        <span class="status-icon" aria-hidden="true">${STATUS[verdict.status].icon}</span>
        <span><b>${STATUS[verdict.status].label}</b><br />${escapeHtml(verdict.text)}</span>
      </div>
      ${
        category
          ? `<p><span class="badge category-${o.category.toLowerCase()}" title="${escapeHtml(category.description)}">${category.label}</span>${escapeHtml(details.join(' · '))}</p>`
          : ''
      }
      <p class="raw-metar"><code>${escapeHtml(o.raw)}</code></p>
    </section>`;
}

// The airport details panel at `time`: the latest observation, then the forecast: conditions,
// verdict, every runway end and the outlook. `error` says why there is no forecast, if so.
export function airportDetailsHtml({ airport, hourly, time, limits, limitsLabel, formatTime, formatHour, observation, error }) {
  const now = conditionsAt(hourly, time);
  const routes = airport.routes ? ` · routes to ${airport.routes} airports` : '';
  const head = `<p class="airport-place">${escapeHtml(airportPlace(airport))} · ${Math.round(airport.elevationFt)} ft${routes}</p>${observationHtml(airport, observation, limits)}<h3>Forecast</h3>`;
  if (!hourly && error) {
    return `${head}<p>The forecast could not be loaded here (${escapeHtml(error)}).</p>`;
  }
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
