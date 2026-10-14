// One fact of the summary line at the top of the airport panel, as HTML: a button that shows the
// part it comes from, in its tab. It carries its part's id, so that the page can scroll to the
// part's section.
import { escapeHtml } from './airportview.js';
import { STATUS } from './runways.js';

// A fact worked out from a forecast or a METAR is the present only for so long after it was fetched.
export const FORECAST_STALE_MS = 3 * 3_600_000;

// The oldest of the fetch times given (ms, any of them may be missing), or undefined if there is none.
export function oldestStamp(...stamps) {
  const known = stamps.filter(Number.isFinite);
  return known.length ? Math.min(...known) : undefined;
}

export function factItemHtml(part, fact, tabLabel) {
  const status = STATUS[fact.status] ? fact.status : 'unknown';
  const id = escapeHtml(part.id);
  // What a screen reader says of the status: old data and facts nobody watches yet are not "No data".
  const state = fact.stale ? 'old data' : fact.notWatched ? 'not watched yet' : STATUS[status].label;
  return `<li><button type="button" class="ops-fact-button status-${status}" data-part="${id}" data-focus-key="fact-${id}">` +
    `<span class="status-icon" aria-hidden="true">${STATUS[status].icon}</span>` +
    `<span class="ops-fact-label">${escapeHtml(part.factLabel ?? part.title)}</span> <span class="ops-fact">${escapeHtml(fact.text)}</span>` +
    `<span class="visually-hidden"> (${state}). Shows ${escapeHtml(part.title.toLowerCase())} in the ${escapeHtml(tabLabel)} tab.</span></button></li>`;
}
