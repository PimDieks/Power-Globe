// The Ops view's runway and wind outlook section, as HTML: plain-language lines, the favoured
// runway through the hours and a colour strip per runway end. It is a part for ops.js.
import { componentsText, escapeHtml } from './airportview.js';
import { STATUS, formatWind } from './runways.js';
import { favouredRuns, noOutlookText, outlookLines, runwayFact, runwayOutlook } from './opsrunway.js';

// One hour in words, for hovering over it and for screen readers.
export function hourReadout(hour, formatClock) {
  const when = formatClock(hour.time);
  if (hour.state === 'missing') return `${when}: no forecast`;
  const parts = [when, formatWind(hour.wind)];
  if (hour.state === 'calm') parts.push('any runway');
  else if (hour.state === 'none') parts.push('no runway within limits');
  else {
    const end = hour.ends.find((e) => e.ident === hour.favoured);
    parts.push(`favoured ${hour.favoured}, ${componentsText(end)}`);
  }
  const named = (status) => hour.ends.filter((e) => e.status === status).map((e) => e.ident);
  if (hour.state !== 'none') {
    if (named('nogo').length) parts.push(`over limit: ${named('nogo').join(', ')}`);
    if (named('caution').length) parts.push(`marginal: ${named('caution').join(', ')}`);
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

// The favoured runway as a row of blocks, one per stretch of hours it holds.
function segmentsHtml(outlook, formatClock) {
  const runs = favouredRuns(outlook);
  return runs
    .map((run, i) => {
      const cells = (runs[i + 1]?.start ?? outlook.hours.length) - run.start;
      const label = { favoured: run.favoured, calm: 'any', none: 'none', missing: '' }[run.state];
      const status = run.state === 'favoured' ? worstStatus(outlook.hours, run.start, run.start + cells, run.favoured) : run.state === 'calm' ? 'ok' : run.state === 'none' ? 'nogo' : 'unknown';
      const text = { favoured: `Runway ${run.favoured} favoured`, calm: 'Calm, any runway', none: 'No runway within limits', missing: 'No forecast' }[run.state];
      // A label that would not fit in the block is left to the hover text.
      const fits = cells >= Math.max(2, label.length) ? label : '';
      return `<button type="button" class="ops-segment status-${status}" style="grid-column: span ${cells}" data-time="${run.from}" data-readout="${escapeHtml(`${text} from ${formatClock(run.from)}`)}" aria-label="${escapeHtml(`${text} from ${formatClock(run.from)}`)}">${escapeHtml(fits)}</button>`;
    })
    .join('');
}

function hoursHtml(outlook, ctx) {
  const { formatClock, time } = ctx;
  return outlook.hours
    .map((hour) => {
      const text = hourReadout(hour, formatClock);
      const cells = hour.ends
        .map((e) => `<i class="ops-cell status-${e.status}${e.ident === hour.favoured ? ' ops-fav' : ''}"></i>`)
        .join('');
      return `<button type="button" class="ops-hour" data-time="${hour.time}" data-readout="${escapeHtml(text)}" aria-label="${escapeHtml(text)}"${hour.time === time ? ' aria-current="time"' : ''}>${cells}</button>`;
    })
    .join('');
}

// Hour labels along the top, one in four so that they fit.
function axisHtml(outlook, formatTick) {
  return outlook.hours.map((h, i) => `<span>${i % 4 === 0 ? escapeHtml(formatTick(h.time)) : ''}</span>`).join('');
}

export function runwaySectionHtml(outlook, ctx) {
  if (outlook.reason) return `<p>${escapeHtml(noOutlookText(outlook, ctx.error))}</p>`;
  const lines = outlookLines(outlook, ctx.formatClockShort ?? ctx.formatClock);
  const shown = outlook.hours.find((h) => h.time === ctx.time) ?? outlook.hours[0];
  const readout = hourReadout(shown, ctx.formatClock);
  const labels = outlook.ends.map((e) => `<span>${escapeHtml(e.ident)}</span>`).join('');
  const n = outlook.hours.length;
  return `<p class="ops-zone">Local time, ${escapeHtml(ctx.zone)}</p>
    <ul class="ops-lines">${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>
    <div class="ops-chart" role="group" aria-label="Runway outlook by hour" style="--hours: ${n}">
      <div class="ops-row ops-axis" aria-hidden="true"><span></span><div class="ops-track">${axisHtml(outlook, ctx.formatTick ?? ctx.formatHour)}</div></div>
      <div class="ops-row"><span class="ops-rowlabel">Use</span><div class="ops-track">${segmentsHtml(outlook, ctx.formatClock)}</div></div>
      <div class="ops-row"><div class="ops-rowlabels" aria-hidden="true">${labels}</div><div class="ops-track ops-hours">${hoursHtml(outlook, ctx)}</div></div>
    </div>
    <p class="ops-readout" data-default="${escapeHtml(readout)}">${escapeHtml(readout)}</p>
    <p class="ops-note">Green within limits, amber marginal (over 80% of a limit), red hatched over a limit, gusts included. A dot marks the favoured end. Hover or tap an hour for the wind; tapping moves the timeline there.</p>`;
}

export const runwayPart = {
  id: 'runway',
  title: 'Runway and wind outlook',
  factLabel: 'Runway',
  analyse: (ctx) => runwayOutlook({ airport: ctx.airport, hourly: ctx.hourly, now: ctx.now, limits: ctx.limits }),
  fact: (outlook, ctx) =>
    outlook.reason ? { text: outlook.reason === 'noRunways' ? 'No runway data' : 'No forecast', status: 'unknown' } : runwayFact(outlook, ctx.formatClock),
  html: runwaySectionHtml,
};
