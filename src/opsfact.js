// One fact of the summary line at the top of the airport panel, as HTML: a button that shows the
// part it comes from, in its tab. It carries its part's id, so that the page can scroll to the
// part's section.
import { escapeHtml } from './airportview.js';
import { STATUS } from './runways.js';

export function factItemHtml(part, fact, tabLabel) {
  const status = STATUS[fact.status] ? fact.status : 'unknown';
  const id = escapeHtml(part.id);
  return `<li><button type="button" class="ops-fact-button status-${status}" data-part="${id}" data-focus-key="fact-${id}">` +
    `<span class="status-icon" aria-hidden="true">${STATUS[status].icon}</span>` +
    `<span class="ops-fact-label">${escapeHtml(part.factLabel ?? part.title)}</span> <span class="ops-fact">${escapeHtml(fact.text)}</span>` +
    `<span class="visually-hidden"> (${STATUS[status].label}). Shows ${escapeHtml(part.title.toLowerCase())} in the ${escapeHtml(tabLabel)} tab.</span></button></li>`;
}
