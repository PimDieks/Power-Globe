// The Access part's trains and buses as HTML: two sub-sections for `subsections` in
// opsaccessview.js, each a function of the analysis (see opstransit.js). Times are Amsterdam time,
// where the airport and its trains and buses are.
import { escapeHtml } from './airportview.js';
import { LATE_MIN, OLD_MIN, enoughLive } from './opstransit.js';

export const TRAINS_SOURCE_TEXT = 'Source: NS (apiportal.ns.nl)';
export const BUSES_SOURCE_TEXT = 'Source: OVapi (NDOV, the open real-time bus feed)';
export const NO_KEY_TEXT = 'Train information needs an NS API key (set NS_API_KEY for the API).';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' });
const title = (text) => `<h4 class="access-title">${text}</h4>`;

// What to say above the data when it is not the present.
function warnings(t, what) {
  const out = [];
  if (t.old) out.push(`The newest ${what} data is ${t.ageMin} min old (more than ${OLD_MIN}), so it is not given as how things are now.`);
  else if (t.stale) out.push(`The API could not reach its ${what} source and is showing its last answer, ${t.ageMin} min old.`);
  if (t.problem) out.push(`The last update failed (${t.problem}); this is the last answer.`);
  return out.map((w) => `<p class="access-old"><b>${escapeHtml(w)}</b></p>`).join('');
}

// The states with no data: loading, unavailable, failed. Null when there is data.
function noData(t, { loading, unavailable, error, source }) {
  if (t.loading) return `<p>${loading}</p>`;
  if (t.unavailable) return unavailable(t.unavailable);
  if (t.error) return `<p class="ops-empty">${error} did not load (${escapeHtml(t.error)}). It tries again by itself.</p><p class="ops-note">${source}.</p>`;
  return null;
}

// ---- Trains ----

function disruptionsHtml(t) {
  if (!t.disruptions) return '<p class="access-old"><b>The disruptions could not be read, so nothing is said of them.</b></p>';
  const rows = [
    ...t.disruptions.map((d) => ['access-jam', 'Disruption', d]),
    ...t.works.map((d) => ['access-closure', 'Works', d]),
  ].map(([cls, label, d]) => {
    const until = Number.isFinite(d.end) ? `until ${clock(d.end)}` : null;
    const note = [d.cause, until].filter(Boolean).join(', ');
    return `<li class="${cls}"><span class="access-badge">${label}</span> <span class="access-what">${escapeHtml(d.title)}</span>${note ? ` <span class="ops-note">${escapeHtml(note)}</span>` : ''}</li>`;
  });
  if (!rows.length) return '<p class="ops-empty">No disruptions reported on the lines through the station.</p>';
  return `<ul class="access-list">${rows.join('')}</ul>`;
}

function departuresHtml(t) {
  if (!t.shown.length) return '<p class="ops-empty">No train departures listed.</p>';
  const rows = t.shown.map((d) => {
    const late = !d.cancelled && d.delayMin > 0;
    const track = d.track ? `track ${escapeHtml(d.track)}${d.plannedTrack && d.plannedTrack !== d.track ? ` (was ${escapeHtml(d.plannedTrack)})` : ''}` : null;
    const notes = [d.kind ? escapeHtml(d.kind) : null, track, late ? `<b class="access-late">+${d.delayMin} min</b>` : null].filter(Boolean).join(', ');
    const time = d.cancelled ? `<s>${clock(d.planned)}</s>` : clock(late ? d.actual : d.planned);
    return `<li class="access-train${d.cancelled ? ' access-cancelled' : ''}"><span class="access-time">${time}</span> <span class="access-what"><b>${escapeHtml(d.destination ?? 'Unknown destination')}</b>${notes ? `, ${notes}` : ''}${d.cancelled ? ' <span class="access-badge">Cancelled</span>' : ''}</span></li>`;
  });
  return `<ul class="access-list access-trains">${rows.join('')}</ul>${t.more ? `<p class="ops-more">and ${plural(t.more, 'more train')}</p>` : ''}`;
}

export function trainsHtml(data) {
  const t = data.trains;
  if (!t) return '';
  if (!t.covered) return `${title('Trains and buses')}<p class="ops-empty">No train or bus data for this airport yet.</p>`;
  const none = noData(t, {
    loading: 'Loading train times from NS…',
    unavailable: (reason) =>
      /NS API key/i.test(reason) ? `<p class="ops-empty">${NO_KEY_TEXT}</p>` : `<p class="ops-empty">No train information right now. ${escapeHtml(reason)}.</p><p class="ops-note">${TRAINS_SOURCE_TEXT}.</p>`,
    error: 'Train times',
    source: TRAINS_SOURCE_TEXT,
  });
  if (none) return `${title('Trains')}${none}`;
  return `${title('Trains')}${warnings(t, 'train')}
    ${disruptionsHtml(t)}
    <h5>Next departures from ${escapeHtml(t.data.station ?? 'the station')}</h5>
    ${departuresHtml(t)}
    <p class="ops-note">Times are Amsterdam time: the actual departure time where a train is late, with the delay in minutes. ${TRAINS_SOURCE_TEXT}.</p>`;
}

// ---- Buses ----

function busTimes(line) {
  return line.next
    .map((p) => {
      // Without a recent update the times are the schedule, whatever the status says.
      const live = p.live === true;
      const late = live && p.delayMin >= LATE_MIN;
      const delayed = live && p.delayMin > 0;
      const shown = clock(delayed ? p.expected : p.planned);
      const text = delayed ? `${shown} <span class="${late ? 'access-late' : 'ops-note'}">+${p.delayMin}</span>` : shown;
      return `<span class="${live ? 'access-live' : 'access-sched'}">${text}</span>`;
    })
    .join(', ');
}

function busSummary(b) {
  // A capped list ends before the hour does, so it is not the count of the hour.
  const head = b.capped ? `Showing ${b.running === 1 ? '1 bus' : `the first ${b.running} buses`} (to ${clock(b.cappedTo)})` : `${plural(b.running, 'bus', 'buses')} due in the next hour`;
  // Lateness is only known of the buses with live times, so it is said of them alone unless all are live.
  const all = b.live === b.running;
  if (b.late) return `${head}${all ? `, ${b.late} ${b.late === 1 ? 'is' : 'are'}` : `; ${b.live} with live times, ${b.late} of them`} ${LATE_MIN} minutes or more late, up to ${b.maxDelay} min`;
  if (enoughLive(b)) return `${head}${all ? ', none late' : `; ${b.live} with live times, none of them late`}`;
  return `${head}, too few with live times to say whether they are late`;
}

export function busesHtml(data) {
  const b = data.buses;
  if (!b?.covered) return '';
  const none = noData(b, {
    loading: 'Loading bus times from OVapi…',
    unavailable: (reason) => `<p class="ops-empty">No bus information right now. ${escapeHtml(reason)}.</p><p class="ops-note">${BUSES_SOURCE_TEXT}.</p>`,
    error: 'Bus times',
    source: BUSES_SOURCE_TEXT,
  });
  if (none) return `${title('Buses')}${none}`;
  const rows = b.lines.map(
    (line) =>
      `<li class="access-bus"><span class="access-badge access-line">${escapeHtml(line.line)}</span> <span class="access-what"><b>${escapeHtml(line.destination ?? 'Unknown destination')}</b></span> <span class="ops-note access-times">${busTimes(line)}</span></li>`,
  );
  const cancelled = b.cancelledReported
    ? `<p class="ops-note">The bus feed reports ${plural(b.cancelledReported, 'bus', 'buses')} as cancelled in this hour (${b.cancelledLines.length === 1 ? 'line' : 'lines'} ${b.cancelledLines.map(escapeHtml).join(', ')}). Its cancellation flags are often wrong (buses flagged cancelled turn up running), so they are left out of the times above and of the summary.</p>`
    : '';
  const body = b.lines.length ? `<ul class="access-list access-buses">${rows.join('')}</ul>${b.moreLines ? `<p class="ops-more">and ${plural(b.moreLines, 'more line')}</p>` : ''}` : '<p class="ops-empty">No buses listed for the terminal in the next hour.</p>';
  return `${title('Buses')}${warnings(b, 'bus')}
    ${b.running || b.lines.length ? `<p>${busSummary(b)}.</p>` : ''}
    ${body}
    ${cancelled}
    <p class="ops-note">Buses at the terminal stops, next departures per line. Times are Amsterdam time: the expected time where the feed has real-time information (in bold), the scheduled one otherwise (grey), with the delay in minutes. A time counts as real-time only for a bus that is driving or arrived and was updated by the feed in the last 15 minutes. ${BUSES_SOURCE_TEXT}.</p>`;
}
