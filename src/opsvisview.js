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
  formatCeiling,
  formatVisibility,
  hourSummary,
  noOutlookText,
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
  { id: 'metar', label: 'METAR', has: (o) => o.metar.state === 'ok' && o.metar.now, status: (h, i) => h.metar?.status ?? (i === 0 ? 'unknown' : 'none') },
  { id: 'taf', label: 'TAF', has: (o) => o.taf.state === 'ok', status: (h) => h.taf?.prevailing?.status ?? 'unknown' },
  { id: 'change', label: 'TEMPO', has: (o) => o.taf.state === 'ok' && o.taf.changes, status: (h) => h.taf?.change?.status ?? 'none' },
  { id: 'model', label: 'Model', has: (o) => o.model.state === 'ok', status: (h) => h.model?.status ?? 'unknown' },
];

const rowsOf = (outlook) => ROWS.filter((row) => row.has(outlook));

function hoursHtml(outlook, rows, ctx) {
  const fmt = ctx.formatClockShort ?? ctx.formatClock;
  // One stop for the Tab key: the hour on the timeline, else the first.
  const stop = Math.max(0, outlook.hours.findIndex((h) => h.time === ctx.time));
  return outlook.hours
    .map((hour, i) => {
      const cells = rows.map((row) => `<i class="ops-cell status-${row.status(hour, i)}${hour.fog && row.id === 'model' ? ' vis-fog' : ''}"></i>`).join('');
      return `<button type="button" class="vis-hour" tabindex="${i === stop ? 0 : -1}" data-focus-key="vis-hour-${hour.time}" data-time="${hour.time}" data-vis-readout="${escapeHtml(hourReadout(hour, fmt))}" aria-label="${escapeHtml(hourLabel(hour, fmt))}"${hour.time === ctx.time ? ' aria-current="time"' : ''}>${cells}</button>`;
    })
    .join('');
}

// Hour labels along the top, one in four so that they fit.
const axisHtml = (outlook, formatTick) => outlook.hours.map((h, i) => `<span>${i % 4 === 0 ? escapeHtml(formatTick(h.time)) : ''}</span>`).join('');

// The METAR now: visibility and ceiling (coloured by how they fare), flight category, RVR and the
// temperature and dew point spread.
function nowHtml(outlook, ctx) {
  const now = outlook.metar.now;
  if (!now) return '';
  const tile = (label, value, status) =>
    `<div class="vis-fact${status ? ` status-${status}` : ''}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b>${status && status !== 'unknown' ? `<span class="visually-hidden"> (${WORD[status]})</span>` : ''}</div>`;
  const level = (reason) => (now.reasons.includes(reason) ? now.status : 'ok');
  const tiles = [
    tile('Visibility', formatVisibility(now.visibility), now.visibility == null ? null : level('visibility')),
    tile(now.verticalVisibility ? 'Vertical visibility' : 'Ceiling', now.ceiling == null ? 'None' : formatCeiling(now.ceiling), level('ceiling')),
    now.category && tile('Category', now.category),
    now.rvr.length && tile('RVR', now.rvr.map((g) => `${g.runway} ${g.above ? 'over ' : g.below ? 'under ' : ''}${formatVisibility(g.value)}`).join(', ')),
    now.spread != null && tile('Spread', `${Math.round(now.spread)} °C (${Math.round(now.temperature)} / ${Math.round(now.dewPoint)})`),
    now.time && tile('METAR', ctx.formatClockShort(new Date(now.time).toISOString().slice(0, 16))),
  ].filter(Boolean);
  return `<div class="vis-now" role="group" aria-label="Latest METAR">${tiles.join('')}</div>`;
}

const LIMIT_FIELDS = [
  ['lvpVisibility', 'LVP, visibility (m)', 100],
  ['lvpCeiling', 'LVP, ceiling (ft)', 50],
  ['marginalVisibility', 'Marginal, visibility (m)', 100],
  ['marginalCeiling', 'Marginal, ceiling (ft)', 50],
];

// The limits, as fields with their labels above them.
function limitsHtml(limits) {
  const fields = LIMIT_FIELDS.map(
    ([name, label, step]) =>
      `<label><span>${escapeHtml(label)}</span><input type="number" min="0" max="99999" step="${step}" inputmode="numeric" data-limit="${name}" data-focus-key="vis-limit-${name}" value="${limits[name]}" /></label>`,
  ).join('');
  return `<fieldset class="limits vis-limits"><legend>Below these it is LVP or marginal (kept in this browser)</legend><div class="limit-inputs">${fields}</div>` +
    `<button type="button" class="vis-reset" data-vis-reset data-focus-key="vis-reset">Reset to defaults</button></fieldset>`;
}

const DISCLAIMER = 'An aid to planning, not an official assessment: check the official METAR and TAF, and the procedures of your airport and operator.';

export function visibilitySectionHtml(outlook, ctx) {
  const fmt = ctx.formatClockShort ?? ctx.formatClock;
  const lines = outlookLines(outlook, fmt);
  const rows = rowsOf(outlook);
  const disclaimer = `<p class="ops-note">${DISCLAIMER}</p>`;
  const limits = limitsHtml(outlook.limits);
  const linesHtml = `<ul class="ops-lines">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`;
  if (!rows.length) return `<p>${escapeHtml(noOutlookText(outlook))}</p>${limits}${disclaimer}`;
  const shown = outlook.hours.find((h) => h.time === ctx.time) ?? outlook.hours[0];
  const readout = hourReadout(shown, fmt);
  const labels = rows.map((r) => `<span>${escapeHtml(r.label)}</span>`).join('');
  const models = outlook.model.state === 'ok';
  return `<p class="ops-zone">Local time, ${escapeHtml(ctx.zone)}</p>
    ${nowHtml(outlook, ctx)}
    ${linesHtml}
    <div class="vis-chart" role="group" aria-label="Low visibility outlook by hour" style="--hours: ${outlook.hours.length}" data-first="${outlook.hours[0].time}">
      <div class="ops-row ops-axis" aria-hidden="true"><span></span><div class="vis-track">${axisHtml(outlook, ctx.formatTick ?? ctx.formatHour)}</div></div>
      <div class="ops-row"><div class="ops-rowlabels" aria-hidden="true">${labels}</div><div class="vis-track vis-hours" role="group" aria-label="Hours, move with the left and right arrow keys">${hoursHtml(outlook, rows, ctx)}</div></div>
    </div>
    <p class="vis-readout" data-default="${escapeHtml(readout)}">${escapeHtml(readout)}</p>
    <p class="ops-note">One row per source: green above the limits, amber (dotted) marginal, red (hatched) LVP, grey no data. METAR is the latest report and covers the first hour; a lower RVR counts as its visibility. TAF is what prevails, the worst where a change falls within the hour; TEMPO is the worst TEMPO or PROB group that gives a visibility or ceiling. ${models ? `Model is visibility only, and a white bar marks fog risk (spread of ${FOG_SPREAD} °C or less, wind of ${FOG_WIND_KT} kt or less, humidity of ${FOG_HUMIDITY}% or more).` : 'The forecast for this airport has no visibility, so there is no model row and no fog hint.'} Hover over an hour, or drag across the hours, for the numbers; the timeline follows.</p>
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
  for (const [type, handler] of Object.entries(on)) root.addEventListener(type, handler);
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
  for (const [type, handler] of Object.entries(on)) root.removeEventListener(type, handler);
  root.removeEventListener('pointercancel', on.pointerup);
}

export const visibilityPart = {
  id: 'visibility',
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
