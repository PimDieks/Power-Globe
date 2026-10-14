// One fact of the Ops status strip, as HTML. It carries its part's id, so that a part can draw its
// own again.
import { escapeHtml } from './airportview.js';
import { STATUS } from './runways.js';

export function factItemHtml(part, fact) {
  const status = STATUS[fact.status] ? fact.status : 'unknown';
  return `<li class="status-${status}" data-part="${escapeHtml(part.id)}"><span class="status-icon" aria-hidden="true">${STATUS[status].icon}</span>` +
    `<span class="ops-fact-label">${escapeHtml(part.factLabel ?? part.title)}</span> <span class="ops-fact">${escapeHtml(fact.text)}</span>` +
    `<span class="visually-hidden"> (${STATUS[status].label})</span></li>`;
}
