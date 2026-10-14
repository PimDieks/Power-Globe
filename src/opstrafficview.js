// The Ops view's traffic part: aircraft about to land at the open airport, those holding, the
// runways the traffic uses and the movements per hour, as HTML, and the running of it (a monitor
// of src/opstraffic.js fed from the traffic module while the tab is open, what it marks on the
// map, and a click on an aircraft). It is a part for ops.js.
import { escapeHtml } from './airportview.js';
import { distanceKm, knownRoute } from './flightroute.js';
import { STATUS } from './runways.js';
import { OpsTraffic, routeHint } from './opstraffic.js';

// The area watched around the airport, in nautical miles: a little more than the range in which
// opstraffic.js takes aircraft for inbound without a route.
export const WATCH_NM = 125;
// The section is drawn again this often, for the minutes in it, whether or not the feed answered.
export const REFRESH_MS = 30_000;
// Aircraft listed before the rest are only counted, and hours shown in the bars.
export const MAX_INBOUND_SHOWN = 8;
export const MAX_HOURS_SHOWN = 12;
// Holding stacks are circled this far beyond the aircraft furthest from their middle.
const STACK_MARGIN_NM = 5;
const STACK_MIN_RADIUS_NM = 6;
const KM_PER_NM = 1.852;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const thousands = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// A height the way pilots say it: "12,400 ft", "FL350" from 18,000 ft.
export function heightText(ft) {
  if (!Number.isFinite(ft)) return '–';
  return ft >= 18_000 ? `FL${Math.round(ft / 100)}` : `${thousands(ft)} ft`;
}

export const agoText = (min) => (min < 1 ? 'just now' : `${min} min ago`);

// The inbound aircraft's route hints: for each aircraft of `list` near the airport whose route is
// already known (looked up for a selected aircraft) and fits where it is and where it heads, the
// origin and destination. Asks for nothing, and an aircraft with no route in hand has no hint.
export function routeHints(list, airport, known = knownRoute) {
  const hints = {};
  for (const ac of list) {
    if (!ac.callsign || Math.abs(ac.lat - airport.lat) > 5) continue;
    const route = known(ac.callsign);
    const hint = route && routeHint(route, ac);
    if (hint) hints[ac.id] = hint;
  }
  return hints;
}

// What goes on the map for a report: the inbound and holding aircraft, and a circle for each stack,
// and the runway ends in use (as airportmap.js labels them).
export function overlayFor(report, airport) {
  const stacks = report.holding.stacks.map((s) => ({
    lat: s.centre.lat,
    lng: s.centre.lng,
    radiusNm: Math.max(STACK_MIN_RADIUS_NM, ...s.aircraft.map((h) => distanceKm(s.centre, h.centre) / KM_PER_NM + STACK_MARGIN_NM)),
  }));
  return {
    inbound: report.inbound.list.map((a) => a.id),
    holding: report.holding.list.map((h) => h.id),
    stacks,
    runwayUse: { ident: airport.ident, ends: runwayUse(report) },
  };
}

// The runway ends in use, as { '27': { tag: 'ARR', title } }: arrivals, departures or both, seen
// in the last half hour. Nothing where the data cannot say.
export function runwayUse(report) {
  const ends = {};
  if (!report.coverage.movementsReliable) return ends;
  for (const [key, label, tag] of [['arrivals', 'Arrivals', 'ARR'], ['departures', 'Departures', 'DEP']]) {
    for (const r of report.movements[key].runways) {
      if (!r.active) continue;
      const use = (ends[r.ident] ??= { tags: [], notes: [] });
      use.tags.push(tag);
      use.notes.push(`${label.toLowerCase()}, last seen ${agoText(r.ageMin)}`);
    }
  }
  return Object.fromEntries(
    Object.entries(ends).map(([ident, u]) => [ident, { tag: u.tags.join('+'), title: `In use for ${u.notes.join('; ')}` }]),
  );
}

// ----- HTML -----

function flightButton(a, text) {
  return `<button type="button" class="ops-flight" data-aircraft="${escapeHtml(a.id)}" data-focus-key="traffic-${escapeHtml(a.id)}" title="Show on the map">${text}</button>`;
}

function inboundHtml(inbound) {
  if (!inbound.total) return '<p class="ops-empty">No inbound traffic seen.</p>';
  const rows = inbound.list.slice(0, MAX_INBOUND_SHOWN).map((a) => {
    const name = escapeHtml(a.callsign || a.id.toUpperCase());
    const cells =
      `<span class="ops-flight-call">${name}</span><span>${escapeHtml(a.type || '')}</span>` +
      `<span>${a.distanceNm} NM</span><span>${heightText(a.altitudeFt)}</span><span class="ops-flight-eta">about ${a.etaMin} min</span>`;
    return `<li>${flightButton(a, cells)}</li>`;
  });
  const rest = inbound.total - rows.length;
  return `<ul class="ops-flights">${rows.join('')}</ul>${rest > 0 ? `<p class="ops-more">and ${rest} more</p>` : ''}`;
}

function holdingHtml(holding, coverage) {
  if (!coverage.holdingReliable) return '<p class="ops-empty">Holding cannot be judged from this data.</p>';
  if (!holding.count) {
    return coverage.holdingReady
      ? '<p class="ops-empty">No aircraft holding.</p>'
      : '<p class="ops-empty">Still watching: holding needs a few minutes of reports to be seen, so none seen yet says little.</p>';
  }
  return `<ul class="ops-stacks">${holding.stacks
    .map((s) => {
      const heights = s.minAltitudeFt === s.maxAltitudeFt ? heightText(s.minAltitudeFt) : `${heightText(s.minAltitudeFt)} to ${heightText(s.maxAltitudeFt)}`;
      const flights = s.aircraft
        .map((h) => flightButton(h, `<span class="ops-flight-call">${escapeHtml(h.callsign || h.id.toUpperCase())}</span><span>${escapeHtml(h.type || '')}</span><span>${heightText(h.altitudeFt)}</span><span title="Seen holding for at least ${h.minutes} min">${h.minutes}+ min</span>`))
        .map((b) => `<li>${b}</li>`)
        .join('');
      return `<li><p class="ops-stack"><b>${plural(s.count, 'aircraft', 'aircraft')}</b> ${s.direction} of the airport, ${s.distanceNm} NM out, ${heights}, the longest seen holding for at least ${s.longestMinutes} min</p><ul class="ops-flights ops-flights-holding">${flights}</ul></li>`;
    })
    .join('')}</ul>`;
}

function runwaysHtml(movements, coverage) {
  if (!coverage.movementsReliable) return '<p class="ops-empty">Runway use cannot be judged from this data.</p>';
  const line = (label, m) => {
    const list = m.runways.length
      ? m.runways.map((r) => `<span class="ops-rwy${r.active ? ' ops-rwy-active' : ''}"><b>${escapeHtml(r.ident)}</b> last seen ${agoText(r.ageMin)}</span>`).join(' ')
      : 'none seen yet';
    return `<dt>${label}</dt><dd>${list}</dd>`;
  };
  return `<dl class="ops-runways">${line('Landing on', movements.arrivals)}${line('Departing from', movements.departures)}</dl>`;
}

// Arrivals and departures for each clock hour since monitoring began, as a row of paired bars.
function hoursHtml(movements, coverage, ctx) {
  const hours = movements.byHour.slice(-MAX_HOURS_SHOWN);
  const { arrivals, departures } = movements;
  if (!coverage.movementsReliable || !hours.length) return '';
  const top = Math.max(1, ...hours.map((h) => Math.max(h.arrivals, h.departures)));
  const label = (h) => ctx.formatTick(new Date(h.hour).toISOString().slice(0, 16));
  const cols = hours
    .map((h) => {
      const text = `${label(h)}: ${plural(h.arrivals, 'arrival')} and ${plural(h.departures, 'departure')}${h.partial ? ' (only part of the hour was watched)' : ''}`;
      return `<div class="ops-hourbar${h.partial ? ' ops-partial' : ''}" role="listitem" aria-label="${escapeHtml(text)}" title="${escapeHtml(text)}">` +
        `<span class="ops-bars"><i class="ops-bar ops-bar-arr" style="height: ${Math.round((h.arrivals / top) * 100)}%"></i><i class="ops-bar ops-bar-dep" style="height: ${Math.round((h.departures / top) * 100)}%"></i></span>` +
        `<span class="ops-barlabel" aria-hidden="true">${escapeHtml(label(h))}</span></div>`;
    })
    .join('');
  const rate = arrivals.perHour == null ? '' : `, about ${arrivals.perHour} arrivals and ${departures.perHour} departures an hour`;
  return `<h4>Per hour since this page was opened</h4>
    <div class="ops-hourbars" role="list" aria-label="Arrivals and departures per hour">${cols}</div>
    <p class="ops-legend"><i class="ops-bar-arr"></i> Arrivals <i class="ops-bar-dep"></i> Departures · hatched: part of the hour</p>
    <p class="ops-note">${plural(arrivals.total, 'arrival')} and ${plural(departures.total, 'departure')} seen${rate}.</p>`;
}

// The body of the section for the data of `analyse`.
export function trafficBodyHtml(data, ctx) {
  const { report } = data;
  // Beyond 100 NM only aircraft with a known route are counted, so the later half hour is a
  // minimum at best: said so, rather than a number that looks complete.
  const later = report.inbound.between30and60;
  const laterText = later
    ? `<span><b>at least ${later}</b> in 30 to 60 min</span>`
    : '<span class="ops-unknown" title="Aircraft further than 100 NM are only counted when their route is known"><b>not known</b> for 30 to 60 min</span>';
  const counts = `<p class="ops-counts"><span><b>${report.inbound.within30}</b> in 0 to 30 min</span>${laterText}</p>`;
  const notes = [...report.coverage.notes];
  if (report.holding.count) notes.push('Holding times are minimums: they count from when this page saw the aircraft start holding.');
  if (data.error) notes.unshift(`The flight feed did not answer (${data.error}).`);
  if (data.watching) notes.unshift(`Watching ${WATCH_NM} NM around the airport, asking the area feed every 15 s.`);
  if (data.watching && !data.layerOn) notes.push('Flights are switched off in the controls, so the aircraft are not marked on the map.');
  return `<p class="ops-summary">${escapeHtml(report.summary)}</p>
    <h4>Inbound, next 60 minutes</h4>
    ${counts}
    ${inboundHtml(report.inbound)}
    <h4>Holding</h4>
    ${holdingHtml(report.holding, report.coverage)}
    <h4>Runways in use</h4>
    ${runwaysHtml(report.movements, report.coverage)}
    ${hoursHtml(report.movements, report.coverage, ctx)}
    <ul class="ops-notes">${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`;
}

export const trafficSectionHtml = (data, ctx) => `<div class="ops-traffic" data-ops-traffic>${trafficBodyHtml(data, ctx)}</div>`;

// ----- running -----

// The monitor of the airport last watched, kept when the tab closes so the same airport opened
// again goes on (the time between is not counted as monitored), and the live session, if any.
let kept = null;
let session = null;

function monitorFor(airport) {
  if (kept?.ident !== airport.ident) kept = { ident: airport.ident, monitor: new OpsTraffic(airport) };
  return kept.monitor;
}

// Watches `airport`: asks for the area around it and starts (or goes on with) its monitor.
function attach(airport) {
  session.ident = airport.ident;
  session.airport = airport;
  session.monitor = monitorFor(airport);
  session.error = null;
  session.source.watchArea({ lat: airport.lat, lng: airport.lng, nm: WATCH_NM });
}

// Switches to the airport of the context if the panel moved on to another with the tab open.
function follow(ctx) {
  if (session && ctx.airport && ctx.airport.ident !== session.ident) {
    attach(ctx.airport);
    publish();
  }
}

function publish() {
  if (!session) return;
  const report = session.monitor.report(Date.now());
  session.source.setOverlay(overlayFor(report, session.airport));
}

// Draws the section and the part's fact in the status strip again, in place, so nothing else in
// the tab is touched (the runway outlook may be being used).
function refreshView() {
  if (!session) return;
  const { root, api } = session;
  const section = root.querySelector('[data-ops-traffic]');
  let ctx;
  try {
    ctx = api.getContext();
  } catch {
    return;
  }
  follow(ctx);
  const data = analyse(ctx);
  if (section) {
    // Focus stays on the same aircraft across the redraw.
    const active = globalThis.document?.activeElement;
    const focused = active && root.contains?.(active) ? active.dataset?.focusKey : null;
    section.innerHTML = trafficBodyHtml(data, ctx);
    if (focused) root.querySelector(`[data-focus-key="${focused.replace(/["\\]/g, '\\$&')}"]`)?.focus();
  }
  const li = root.querySelector('.ops-strip li[data-part="traffic"]');
  const fact = trafficFact(data);
  if (li && fact) {
    const status = STATUS[fact.status] ? fact.status : 'unknown';
    li.className = `status-${status}`;
    li.querySelector('.ops-fact').textContent = fact.text;
    li.querySelector('.status-icon').textContent = STATUS[status].icon;
    li.querySelector('.visually-hidden').textContent = ` (${STATUS[status].label})`;
  }
}

function onFeed(event) {
  if (!session) return;
  let ctx;
  try {
    ctx = session.api.getContext();
  } catch {
    return;
  }
  follow(ctx);
  if (event.error) session.error = event.error;
  else {
    session.error = null;
    const list = session.source.aircraft();
    session.monitor.update(list, { now: Date.now(), area: event.area, hints: routeHints(list, session.airport), qnhHpa: ctx.observation?.qnh });
  }
  publish();
  refreshView();
}

// Starts watching the open airport; called when the Ops tab is shown.
export function bind(root, api, { setTimer = setInterval, clearTimer = clearInterval } = {}) {
  unbind();
  const source = api.getContext().trafficSource;
  if (!source) return;
  const onClick = (event) => {
    const id = event.target.closest?.('[data-aircraft]')?.dataset.aircraft;
    if (id) source.select(id);
  };
  root.addEventListener('click', onClick);
  session = { root, api, source, onClick, ident: null, airport: null, monitor: null, error: null, timer: null, unsubscribe: null, clearTimer };
  attach(api.getContext().airport);
  session.unsubscribe = source.subscribe(onFeed);
  session.timer = setTimer(refreshView, REFRESH_MS);
}

// Stops watching, and takes everything off the map.
export function unbind() {
  if (!session) return;
  const { root, source, onClick, timer, unsubscribe, clearTimer } = session;
  session = null;
  unsubscribe?.();
  clearTimer(timer);
  root.removeEventListener('click', onClick);
  source.watchArea(null);
  source.setOverlay(null);
}

// ----- the part -----

function analyse(ctx) {
  follow(ctx);
  const monitor = session?.ident === ctx.airport.ident ? session.monitor : kept?.ident === ctx.airport.ident ? kept.monitor : new OpsTraffic(ctx.airport);
  return {
    report: monitor.report(ctx.now),
    started: monitor.since != null,
    error: session?.error ?? null,
    watching: Boolean(session),
    layerOn: ctx.trafficSource?.layerOn?.() ?? true,
  };
}

// The part's line for the status strip: holding makes it "marginal", for a duty manager to look at.
function trafficFact(data) {
  if (!data.started) return { text: data.error ? 'Flight data unavailable' : 'Waiting for flight data', status: 'unknown' };
  const { report } = data;
  return { text: report.status, status: report.coverage.holdingReliable && report.holding.count ? 'caution' : 'ok' };
}

export const trafficPart = {
  id: 'traffic',
  title: 'Traffic',
  factLabel: 'Traffic',
  needs: ['airport', 'now', 'formatTick', 'trafficSource'],
  analyse,
  fact: trafficFact,
  html: trafficSectionHtml,
  bind,
  unbind,
};

// For tests: forget the monitor kept for the last airport.
export const forgetTraffic = () => {
  unbind();
  kept = null;
};
