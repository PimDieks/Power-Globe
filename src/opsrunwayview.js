// The Ops view's runway and wind outlook part: plain-language lines, the favoured runway through
// the hours and a colour strip per runway, as HTML, and the handling of the hours (hover, keys,
// dragging across them, the clock). It is a part for ops.js.
import { componentsText, escapeHtml, limitsText } from './airportview.js';
import { FORECAST_STALE_MS } from './opsfact.js';
import { STATUS, formatWind } from './runways.js';
import { favouredRuns, noOutlookText, outlookLines, outlookStale, runwayFact, runwayOutlook } from './opsrunway.js';

// How often the clock is checked for a new hour.
export const CLOCK_CHECK_MS = 60_000;

const named = (hour, status) => hour.runways.filter((r) => r.status === status).map((r) => r.label);

// What an hour has to say about the runway, short enough to be read out for every hour.
function hourSummary(hour) {
  if (hour.state === 'missing') return 'no forecast';
  if (hour.state === 'calm') return 'calm, any runway';
  if (hour.state === 'none') return 'no runway within limits';
  const over = named(hour, 'nogo').length;
  return `favoured ${hour.favoured}${over ? `, ${over} over limit` : ''}`;
}

// The label read out for one hour of the strip: "17:00, favoured 22".
export const hourLabel = (hour, fmt) => `${fmt(hour.time)}, ${hourSummary(hour)}`;

// One hour in full, shown under the strip when hovering over it: the wind and the numbers.
export function hourReadout(hour, fmt) {
  const when = fmt(hour.time);
  if (hour.state === 'missing') return `${when}: no forecast`;
  const parts = [when, formatWind(hour.wind)];
  if (hour.state === 'calm') parts.push('any runway');
  else if (hour.state === 'none') parts.push('no runway within limits');
  else parts.push(`favoured ${hour.favoured}, ${componentsText(hour.ends.find((e) => e.ident === hour.favoured))}`);
  if (hour.state !== 'none') {
    if (named(hour, 'nogo').length) parts.push(`over limit: ${named(hour, 'nogo').join(', ')}`);
    if (named(hour, 'caution').length) parts.push(`marginal: ${named(hour, 'caution').join(', ')}`);
  }
  return parts.join(' · ');
}

// The worst status the end `ident` has in hours start up to end.
function worstStatus(hours, start, end, ident) {
  let worst = 'ok';
  for (const h of hours.slice(start, end)) {
    const status = h.ends.find((e) => e.ident === ident)?.status ?? 'ok';
    if (STATUS[status].rank > STATUS[worst].rank) worst = status;
  }
  return worst;
}

// The favoured runway as a row of blocks, one per stretch of hours it holds. They are for the
// pointer: the hours below say the same to a keyboard or a screen reader.
function segmentsHtml(outlook, fmt) {
  const runs = favouredRuns(outlook);
  return runs
    .map((run, i) => {
      const cells = (runs[i + 1]?.start ?? outlook.hours.length) - run.start;
      const label = { favoured: run.favoured, calm: 'any', none: 'none', missing: '' }[run.state];
      const status = run.state === 'favoured' ? worstStatus(outlook.hours, run.start, run.start + cells, run.favoured) : { calm: 'ok', none: 'nogo', missing: 'unknown' }[run.state];
      const text = { favoured: `Runway ${run.favoured} favoured`, calm: 'Calm, any runway', none: 'No runway within limits', missing: 'No forecast' }[run.state];
      // A label that would not fit in the block is left to the hover text.
      const fits = cells >= Math.max(2, label.length) ? label : '';
      return `<span class="ops-segment status-${status}" style="grid-column: span ${cells}" data-time="${run.from}" data-readout="${escapeHtml(`${text} from ${fmt(run.from)}`)}">${escapeHtml(fits)}</span>`;
    })
    .join('');
}

// Where a runway's row names the better end: where it changes, if the run is long enough to hold
// the name. A set of "row:hour" keys.
export function endLabelCells(outlook) {
  const keys = new Set();
  outlook.runwayRows.forEach((row, r) => {
    const usable = (h) => h.runways[r].status === 'ok' || h.runways[r].status === 'caution';
    let start = 0;
    const flush = (end) => {
      const best = outlook.hours[start].runways[r].best ?? '';
      if (usable(outlook.hours[start]) && end - start >= Math.max(2, best.length)) keys.add(`${r}:${start}`);
    };
    outlook.hours.forEach((h, i) => {
      if (i > 0 && (h.runways[r].best !== outlook.hours[start].runways[r].best || usable(h) !== usable(outlook.hours[start]))) {
        flush(i);
        start = i;
      }
    });
    flush(outlook.hours.length);
  });
  return keys;
}

function hoursHtml(outlook, ctx) {
  const labels = endLabelCells(outlook);
  const fmt = ctx.formatClockShort ?? ctx.formatClock;
  // One stop for the Tab key: the hour on the timeline, else the first.
  const stop = Math.max(0, outlook.hours.findIndex((h) => h.time === ctx.time));
  return outlook.hours
    .map((hour, i) => {
      const cells = hour.runways
        .map((r, k) => {
          const ring = hour.favoured && r.idents.includes(hour.favoured) ? ' ops-fav' : '';
          const end = labels.has(`${k}:${i}`) ? ` ops-end" data-end="${escapeHtml(r.best)}` : '';
          return `<i class="ops-cell status-${r.status}${ring}${end}"></i>`;
        })
        .join('');
      return `<button type="button" class="ops-hour" tabindex="${i === stop ? 0 : -1}" data-focus-key="runway-hour-${hour.time}" data-time="${hour.time}" data-readout="${escapeHtml(hourReadout(hour, fmt))}" aria-label="${escapeHtml(hourLabel(hour, fmt))}"${hour.time === ctx.time ? ' aria-current="time"' : ''}>${cells}</button>`;
    })
    .join('');
}

// Hour labels along the top, one in four so that they fit.
function axisHtml(outlook, formatTick) {
  return outlook.hours.map((h, i) => `<span>${i % 4 === 0 ? escapeHtml(formatTick(h.time)) : ''}</span>`).join('');
}

export function runwaySectionHtml(outlook, ctx) {
  if (outlook.reason) return `<p>${escapeHtml(noOutlookText(outlook, ctx.error))}</p>`;
  const fmt = ctx.formatClockShort ?? ctx.formatClock;
  const lines = outlookLines(outlook, fmt);
  const shown = outlook.hours.find((h) => h.time === ctx.time) ?? outlook.hours[0];
  const readout = hourReadout(shown, fmt);
  const labels = outlook.runwayRows.map((r) => `<span>${escapeHtml(r.label)}</span>`).join('');
  return `<p class="ops-zone">Local time, ${escapeHtml(ctx.zone)}</p>
    <ul class="ops-lines">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    <div class="ops-chart" role="group" aria-label="Runway outlook by hour" style="--hours: ${outlook.hours.length}" data-first="${outlook.hours[0].time}">
      <div class="ops-row ops-axis" aria-hidden="true"><span></span><div class="ops-track">${axisHtml(outlook, ctx.formatTick ?? ctx.formatHour)}</div></div>
      <div class="ops-row" aria-hidden="true"><span class="ops-rowlabel">Use</span><div class="ops-track">${segmentsHtml(outlook, fmt)}</div></div>
      <div class="ops-row"><div class="ops-rowlabels" aria-hidden="true">${labels}</div><div class="ops-track ops-hours" role="group" aria-label="Hours, move with the left and right arrow keys">${hoursHtml(outlook, ctx)}</div></div>
    </div>
    <p class="ops-readout" data-default="${escapeHtml(readout)}">${escapeHtml(readout)}</p>
    <p class="ops-note">One row per runway, coloured by its better end: green within limits, amber marginal (over 80% of a limit), red hatched over a limit, gusts included. A ring marks the favoured end. Hover over an hour, or drag across the hours, for the wind; the timeline follows.</p>
    <p class="ops-limits">Limits (${escapeHtml(ctx.limitsLabel)}): ${escapeHtml(limitsText(ctx.limits))}. Set them in the wind check.</p>`;
}

// The index of the hour at pixel `x` of a strip starting at `left`, `width` wide, of `count` hours.
export function hourIndexAt(x, left, width, count) {
  if (!(width > 0) || !(count > 0)) return 0;
  return Math.min(count - 1, Math.max(0, Math.floor(((x - left) / width) * count)));
}

// What the panel does with the hours: show the numbers of the hour under the pointer or focus,
// set the timeline from a tap, a drag or Enter, move between the hours with the arrow keys, and
// draw again when a new hour begins. `unbind` takes it all away.
let bound = null;

export function bind(root, api, { setTimer = setInterval, clearTimer = clearInterval, now = Date.now } = {}) {
  unbind();
  let scrubbing = false;
  let lastTime = null;
  const readout = () => root.querySelector('.ops-readout');
  const show = (text) => {
    const el = readout();
    if (el) el.textContent = text ?? el.dataset.default;
  };
  const hours = () => [...(root.querySelectorAll?.('.ops-hour') ?? [])];

  const timeAt = (event) => {
    const track = root.querySelector('.ops-hours');
    if (!track) return null;
    const box = track.getBoundingClientRect();
    return track.children[hourIndexAt(event.clientX, box.left, box.width, track.children.length)]?.dataset.time ?? null;
  };
  const choose = (time, readoutText) => {
    if (!time || time === lastTime) return;
    lastTime = time;
    api.setTime(time, { quiet: true });
    show(readoutText ?? root.querySelector(`.ops-hour[data-time="${time}"]`)?.dataset.readout);
  };

  const on = {
    pointerdown(event) {
      if (event.button > 0 || !event.target.closest?.('.ops-chart .ops-track')) return;
      scrubbing = true;
      lastTime = null;
      root.setPointerCapture?.(event.pointerId);
      const segment = event.target.closest('.ops-segment');
      choose(segment ? segment.dataset.time : timeAt(event), segment?.dataset.readout);
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
    // Enter or Space on an hour; a mouse or a finger has already done its part.
    click(event) {
      const time = event.detail === 0 && event.target.closest?.('.ops-hour')?.dataset.time;
      if (time) api.setTime(time);
    },
    pointerover(event) {
      if (!scrubbing) show(event.target.closest?.('[data-readout]')?.dataset.readout);
    },
    pointerout() {
      if (!scrubbing) show();
    },
    focusin(event) {
      const hour = event.target.closest?.('.ops-hour');
      if (!hour) return;
      for (const other of hours()) other.tabIndex = other === hour ? 0 : -1;
      show(hour.dataset.readout);
    },
    focusout() {
      show();
    },
    keydown(event) {
      const hour = event.target.closest?.('.ops-hour');
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
    const first = root.querySelector('.ops-chart')?.dataset.first;
    if (first && outlookStale(first, now())) api.rerender();
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

export const runwayPart = {
  id: 'runway',
  tab: 'weather',
  title: 'Runway and wind outlook',
  factLabel: 'Runway',
  // What the part reads from the context.
  needs: ['airport', 'hourly', 'limits', 'limitsLabel', 'time', 'now', 'formatClock', 'formatClockShort', 'formatTick', 'zone'],
  analyse: (ctx) => runwayOutlook({ airport: ctx.airport, hourly: ctx.hourly, now: ctx.now, limits: ctx.limits }),
  // Worked out from the forecast, which is fetched once when the airport is opened.
  staleAfterMs: FORECAST_STALE_MS,
  fact: (outlook, ctx) =>
    outlook.reason ? { text: outlook.reason === 'noRunways' ? 'No runway data' : 'No forecast', status: 'unknown' } : { ...runwayFact(outlook, ctx.formatClock), asOf: ctx.hourlyAsOf },
  html: runwaySectionHtml,
  bind,
  unbind,
};
