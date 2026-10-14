// The Ops view's low visibility part: the METAR now, plain-language lines, a colour strip per
// source (METAR, TAF, TAF changes, model) over the next 24 hours and the limits to set, as HTML, and
// the handling of the hours (hover, keys, dragging across them, the clock). It is a part for ops.js,
// and shares nothing with the runway part but the helper that finds the hour under the pointer.
import { escapeHtml } from './airportview.js';
import { CLOCK_CHECK_MS, hourIndexAt } from './opsrunwayview.js';
import {
  DEFAULT_LVP_LIMITS,
  FOG_HUMIDITY,
  FOG_SPREAD,
  FOG_WIND_KT,
  formatAge,
  formatCeiling,
  formatVisibility,
  hourSummary,
  limitsKept,
  outlookLines,
  readLimits,
  saveLimits,
  visibilityFact,
  visibilityOutlook,
  visibilityStale,
} from './opsvis.js';

const WORD = { ok: 'above limits', caution: 'marginal', nogo: 'LVP' };

// A source's conditions in a few words: "800 m, ceiling 200 ft (LVP)".
function conditionsText(c) {
  const parts = [];
  if (typeof c.visibility === 'number') parts.push(formatVisibility(c.visibility));
  if (typeof c.ceiling === 'number') parts.push(`ceiling ${formatCeiling(c.ceiling)}`);
  const text = parts.join(', ') || 'no visibility or ceiling';
  return c.status === 'ok' || c.status === 'unknown' ? text : `${text} (${WORD[c.status]})`;
}

// One hour in full, shown under the strip when hovering over it: every source's numbers.
export function hourReadout(hour, fmt) {
  const parts = [fmt(hour.time)];
  if (hour.metar) {
    const rvr = hour.metar.byRvr ? `, RVR ${formatVisibility(hour.metar.rvrMin)}` : '';
    parts.push(`METAR ${conditionsText(hour.metar)}${rvr}`);
  }
  if (hour.taf?.prevailing) parts.push(`TAF ${conditionsText(hour.taf.prevailing)}`);
  if (hour.taf?.change) parts.push(`TAF ${hour.taf.change.label} ${conditionsText(hour.taf.change)}`);
  if (hour.model) parts.push(hour.model.visibility == null ? 'model: no visibility' : `model ${conditionsText(hour.model)}`);
  if (hour.fog) parts.push('fog risk');
  if (parts.length === 1) parts.push('no data');
  return parts.join(' · ');
}

// The label read out for one hour of the strip: "03:00, LVP likely".
export const hourLabel = (hour, fmt) => `${fmt(hour.time)}, ${hourSummary(hour)}`;

// The rows of the strip, in order: what the row is called, which sources have it, and the status
// of an hour in it ('none' is a blank cell: the row has nothing to say in that hour).
const ROWS = [
  { id: 'metar', label: 'METAR', has: (o) => Boolean(o.metar.now), status: (h, i) => h.metar?.status ?? (i === 0 ? 'unknown' : 'none') },
  { id: 'taf', label: 'TAF', has: (o) => o.taf.state === 'ok', status: (h) => h.taf?.prevailing?.status ?? 'unknown' },
  { id: 'change', label: 'TEMPO', has: (o) => o.taf.state === 'ok' && o.taf.changes, status: (h) => h.taf?.change?.status ?? 'none' },
  { id: 'model', label: 'Model', has: (o) => o.model.state === 'ok', status: (h) => h.model?.status ?? 'unknown' },
  // Not a verdict against the limits: where the hint applies, whatever the visibility says.
  { id: 'fog', label: 'Fog', has: (o) => o.hours.some((h) => h.fog), status: (h) => (h.fog ? 'fog' : 'none') },
];

const rowsOf = (outlook) => ROWS.filter((row) => row.has(outlook));

function hoursHtml(outlook, rows, ctx) {
  const fmt = ctx.formatClockShort ?? ctx.formatClock;
  // One stop for the Tab key: the hour on the timeline, else the first.
  const stop = Math.max(0, outlook.hours.findIndex((h) => h.time === ctx.time));
  return outlook.hours
    .map((hour, i) => {
      const cells = rows.map((row) => `<i class="ops-cell ${row.id === 'fog' && hour.fog ? 'vis-fogrisk' : `status-${row.status(hour, i)}`}"></i>`).join('');
      return `<button type="button" class="vis-hour" tabindex="${i === stop ? 0 : -1}" data-focus-key="vis-hour-${hour.time}" data-time="${hour.time}" data-vis-readout="${escapeHtml(hourReadout(hour, fmt))}" aria-label="${escapeHtml(hourLabel(hour, fmt))}"${hour.time === ctx.time ? ' aria-current="time"' : ''}>${cells}</button>`;
    })
    .join('');
}

// Hour labels along the top, one in four so that they fit.
const axisHtml = (outlook, formatTick) => outlook.hours.map((h, i) => `<span>${i % 4 === 0 ? escapeHtml(formatTick(h.time)) : ''}</span>`).join('');

// The latest METAR: visibility and ceiling (each coloured by how it fares by itself), flight
// category, RVR (coloured by its own status) and the temperature and dew point spread. One that is
// too old is shown dimmed with its age, and is not called now.
function nowHtml(outlook, ctx) {
  const latest = outlook.metar.latest;
  if (!latest) return '';
  const stale = outlook.metar.state === 'stale';
  const tile = (label, value, status) =>
    `<div class="vis-fact${status && status !== 'unknown' ? ` status-${status}` : ''}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>${status && status !== 'unknown' ? `<span class="visually-hidden"> (${WORD[status]})</span>` : ''}</div>`;
  const observed = latest.time ? ctx.formatClockShort(new Date(latest.time).toISOString().slice(0, 16)) : null;
  const tiles = [
    tile('Visibility', formatVisibility(latest.visibility), latest.visibility == null ? null : latest.visibilityStatus),
    tile(latest.verticalVisibility ? 'Vertical visibility' : 'Ceiling', latest.ceiling == null ? 'None' : formatCeiling(latest.ceiling), latest.ceilingStatus),
    latest.category && tile('Category', latest.category),
    latest.rvr.length && tile('RVR', latest.rvr.map((g) => `${g.runway} ${g.above ? 'over ' : g.below ? 'under ' : ''}${formatVisibility(g.value)}`).join(', '), latest.rvrStatus),
    latest.spread != null && tile('Spread', `${Math.round(latest.spread)} °C (${Math.round(latest.temperature)} / ${Math.round(latest.dewPoint)})`),
    observed && tile(stale ? 'METAR, too old to be now' : 'METAR', stale ? `${observed}, ${formatAge(outlook.metar.age)} old` : observed),
  ].filter(Boolean);
  return `<div class="vis-now${stale ? ' vis-stale' : ''}" role="group" aria-label="${stale ? 'Latest METAR, too old to be taken for now' : 'Latest METAR'}">${tiles.join('')}</div>`;
}

const LIMIT_FIELDS = [
  ['lvpVisibility', 'LVP, visibility (m)', 100],
  ['lvpCeiling', 'LVP, ceiling (ft)', 50],
  ['marginalVisibility', 'Marginal, visibility (m)', 100],
  ['marginalCeiling', 'Marginal, ceiling (ft)', 50],
];

// The limits, as fields with their labels above them. While one is being typed in, the section is
// not drawn again (data-editing, see ops.js), so what is typed is not lost.
function limitsHtml(outlook) {
  const { limits } = outlook;
  const fields = LIMIT_FIELDS.map(
    ([name, label, step]) =>
      `<label><span>${escapeHtml(label)}</span><input type="number" min="0" max="99999" step="${step}" inputmode="numeric" data-limit="${name}" data-editing data-focus-key="vis-limit-${name}" value="${limits[name]}" /></label>`,
  ).join('');
  const notes = [
    outlook.clamped && '<p class="ops-note" role="status">Marginal limits below the LVP ones are judged as the LVP ones.</p>',
    !limitsKept() && '<p class="ops-note vis-warn" role="status">These limits could not be kept in this browser. They apply until the page is closed.</p>',
  ].filter(Boolean);
  return `<fieldset class="limits vis-limits"><legend>Below these it is LVP or marginal (kept in this browser)</legend><div class="limit-inputs">${fields}</div>${notes.join('')}` +
    `<button type="button" class="vis-reset" data-vis-reset data-focus-key="vis-reset">Reset to defaults</button></fieldset>`;
}

const DISCLAIMER = 'An aid to planning, not an official assessment: check the official METAR and TAF, and the procedures of your airport and operator.';

// Whether "How to read this" is open, kept across the section being drawn again.
let helpOpen = false;

export function visibilitySectionHtml(outlook, ctx) {
  const fmt = ctx.formatClockShort ?? ctx.formatClock;
  const lines = outlookLines(outlook, fmt);
  const rows = rowsOf(outlook);
  const disclaimer = `<p class="ops-note">${DISCLAIMER}</p>`;
  const limits = limitsHtml(outlook);
  const linesHtml = `<ul class="ops-lines">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
  if (!rows.length) return `${nowHtml(outlook, ctx)}${linesHtml}${limits}${disclaimer}`;
  const shown = outlook.hours.find((h) => h.time === ctx.time) ?? outlook.hours[0];
  const readout = hourReadout(shown, fmt);
  const labels = rows.map((r) => `<span>${escapeHtml(r.label)}</span>`).join('');
  const models = outlook.model.state === 'ok';
  const help = `<details class="vis-help"${helpOpen ? ' open' : ''}><summary>How to read this</summary>
      <p>One row per source: green above the limits, amber (dotted) marginal, red (hatched) LVP, grey no data. METAR is the latest report and covers the first hour; a lower RVR counts as its visibility. TAF is what prevails, the worst where a change falls within the hour; TEMPO is the worst TEMPO or PROB group that gives a visibility or ceiling. ${models ? 'Model is the forecast visibility only, with no ceiling.' : 'The forecast for this airport has no visibility, so there is no model row.'} Fog is a hint, not a verdict: a spread of ${FOG_SPREAD} °C or less, wind of ${FOG_WIND_KT} kt or less and humidity of ${FOG_HUMIDITY}% or more in the forecast. Hover over an hour, or drag across the hours, for the numbers; the timeline follows.</p></details>`;
  return `<p class="ops-zone">Local time, ${escapeHtml(ctx.zone)}</p>
    ${nowHtml(outlook, ctx)}
    ${linesHtml}
    <div class="vis-chart" role="group" aria-label="Low visibility outlook by hour" style="--hours: ${outlook.hours.length}" data-first="${outlook.hours[0].time}">
      <div class="ops-row ops-axis" aria-hidden="true"><span></span><div class="vis-track">${axisHtml(outlook, ctx.formatTick ?? ctx.formatHour)}</div></div>
      <div class="ops-row"><div class="ops-rowlabels" aria-hidden="true">${labels}</div><div class="vis-track vis-hours" role="group" aria-label="Hours, move with the left and right arrow keys">${hoursHtml(outlook, rows, ctx)}</div></div>
    </div>
    <p class="vis-readout" data-default="${escapeHtml(readout)}">${escapeHtml(readout)}</p>
    ${help}
    ${limits}${disclaimer}`;
}

// What the panel does with the hours: show the numbers of the hour under the pointer or focus, set
// the timeline from a tap, a drag or Enter, move between the hours with the arrow keys, keep the
// limits that are set and draw again when a new hour begins. `unbind` takes it all away.
let bound = null;

export function bind(root, api, { setTimer = setInterval, clearTimer = clearInterval, now = Date.now, storage } = {}) {
  unbind();
  let scrubbing = false;
  let lastTime = null;
  const readout = () => root.querySelector('.vis-readout');
  const show = (text) => {
    const el = readout();
    if (el) el.textContent = text ?? el.dataset.default;
  };
  const hours = () => [...(root.querySelectorAll?.('.vis-hour') ?? [])];

  const timeAt = (event) => {
    const track = root.querySelector('.vis-hours');
    if (!track) return null;
    const box = track.getBoundingClientRect();
    return track.children[hourIndexAt(event.clientX, box.left, box.width, track.children.length)]?.dataset.time ?? null;
  };
  const choose = (time) => {
    if (!time || time === lastTime) return;
    lastTime = time;
    api.setTime(time, { quiet: true });
    show(root.querySelector(`.vis-hour[data-time="${time}"]`)?.dataset.visReadout);
  };

  const on = {
    pointerdown(event) {
      if (event.button > 0 || !event.target.closest?.('.vis-chart .vis-hours')) return;
      scrubbing = true;
      lastTime = null;
      root.setPointerCapture?.(event.pointerId);
      choose(timeAt(event));
    },
    pointermove(event) {
      if (scrubbing) choose(timeAt(event));
    },
    pointerup(event) {
      if (!scrubbing) return;
      scrubbing = false;
      root.releasePointerCapture?.(event.pointerId);
      // Said once, when the pointer is up.
      if (lastTime) api.setTime(lastTime);
    },
    click(event) {
      // Enter or Space on an hour; a mouse or a finger has already done its part.
      const time = event.detail === 0 && event.target.closest?.('.vis-hour')?.dataset.time;
      if (time) api.setTime(time);
      if (event.target.closest?.('[data-vis-reset]')) {
        saveLimits(DEFAULT_LVP_LIMITS, storage);
        api.rerender();
      }
    },
    // A limit set: kept, and the outlook judged again.
    change(event) {
      if (!event.target.closest?.('[data-limit]')) return;
      const set = {};
      for (const input of root.querySelectorAll('[data-limit]')) set[input.dataset.limit] = input.value;
      saveLimits(set, storage);
      // After the focus has moved on (Tab) so that the field it reached keeps it when the section is drawn again.
      setTimeout(api.rerender, 0);
    },
    pointerover(event) {
      if (!scrubbing) show(event.target.closest?.('[data-vis-readout]')?.dataset.visReadout);
    },
    pointerout() {
      if (!scrubbing) show();
    },
    focusin(event) {
      const hour = event.target.closest?.('.vis-hour');
      if (!hour) return;
      for (const other of hours()) other.tabIndex = other === hour ? 0 : -1;
      show(hour.dataset.visReadout);
    },
    focusout() {
      show();
    },
    keydown(event) {
      const hour = event.target.closest?.('.vis-hour');
      if (!hour) return;
      const list = hours();
      const at = list.indexOf(hour);
      const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: list.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      list[Math.min(list.length - 1, Math.max(0, next))]?.focus();
    },
  };
  // `toggle` does not bubble, so it is listened to on the way down.
  on.toggle = (event) => {
    if (event.target.classList?.contains('vis-help')) helpOpen = Boolean(event.target.open);
  };
  for (const [type, handler] of Object.entries(on)) root.addEventListener(type, handler, type === 'toggle');
  root.addEventListener('pointercancel', on.pointerup);

  const timer = setTimer(() => {
    const first = root.querySelector('.vis-chart')?.dataset.first;
    if (first && visibilityStale(first, now())) api.rerender();
  }, CLOCK_CHECK_MS);
  bound = { root, on, timer, clearTimer };
}

export function unbind() {
  if (!bound) return;
  const { root, on, timer, clearTimer } = bound;
  bound = null;
  clearTimer(timer);
  for (const [type, handler] of Object.entries(on)) root.removeEventListener(type, handler, type === 'toggle');
  root.removeEventListener('pointercancel', on.pointerup);
}

export const visibilityPart = {
  id: 'visibility',
  tab: 'weather',
  title: 'Low visibility outlook',
  factLabel: 'Visibility',
  // What the part reads from the context.
  needs: ['hourly', 'observation', 'taf', 'time', 'now', 'formatClock', 'formatClockShort', 'formatTick', 'zone'],
  analyse: (ctx) => visibilityOutlook({ hourly: ctx.hourly, observation: ctx.observation, taf: ctx.taf, now: ctx.now, limits: readLimits() }),
  fact: (outlook, ctx) => visibilityFact(outlook, ctx.formatClock),
  html: visibilitySectionHtml,
  bind,
  unbind,
};
