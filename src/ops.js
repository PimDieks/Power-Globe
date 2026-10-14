// The Ops view of the airport panel: its tabs, and the frame the Ops parts plug into. A part is
//
//   { id, title, factLabel, analyse(ctx) → data, fact(data, ctx) → { text, status } | null, html(data, ctx) → string }
//
// `analyse` does the work once per render, `fact` gives the part's one line for the status strip
// at the top and `html` its section. To add a part, write one module that exports such an object
// and add it to OPS_PARTS below; nothing else changes. `ctx` is what main.js knows about the open
// airport (airport, hourly, error, observation, limits, time, now and the time formatters).
import { escapeHtml } from './airportview.js';
import { STATUS } from './runways.js';
import { runwayPart } from './opsrunwayview.js';

// The Ops parts, in the order their sections are shown and their facts are listed.
export const OPS_PARTS = [runwayPart];

export const DETAIL_TABS = [
  { id: 'details', label: 'Details' },
  { id: 'ops', label: 'Ops' },
];
const TAB_KEY = 'power-globe:airport-tab';

// The tab remembered for this browser, or the first.
export function readTab(storage = globalThis.localStorage) {
  try {
    const saved = storage.getItem(TAB_KEY);
    if (DETAIL_TABS.some((tab) => tab.id === saved)) return saved;
  } catch {
    // Nothing saved, or storage unavailable.
  }
  return DETAIL_TABS[0].id;
}

export function saveTab(id, storage = globalThis.localStorage) {
  try {
    storage.setItem(TAB_KEY, id);
  } catch {
    // Remembering the tab is only a convenience.
  }
}

// The tab to move to for an arrow key, Home or End pressed on tab `index` of `count`, or null for
// any other key. The arrows wrap around.
export function tabAfterKey(key, index, count) {
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

const FAILED = Symbol('failed');

// Runs `fn`, and says where it failed rather than losing the other parts with it.
function attempt(part, step, fn) {
  try {
    return fn();
  } catch (err) {
    console.error(`Ops part "${part.id}" failed in ${step}`, err);
    return FAILED;
  }
}

// The status strip: one line of key facts, one per part that has one.
export function stripHtml(entries) {
  const facts = entries.filter((e) => e.fact?.text);
  if (!facts.length) return '';
  const items = facts
    .map(({ part, fact }) => {
      const status = STATUS[fact.status] ? fact.status : 'unknown';
      return `<li class="status-${status}"><span class="status-icon" aria-hidden="true">${STATUS[status].icon}</span>` +
        `<span class="ops-fact-label">${escapeHtml(part.factLabel ?? part.title)}</span> <span class="ops-fact">${escapeHtml(fact.text)}</span>` +
        `<span class="visually-hidden"> (${STATUS[status].label})</span></li>`;
    })
    .join('');
  return `<ul class="ops-strip" aria-label="Key facts">${items}</ul>`;
}

// The whole Ops tab for `parts`: the status strip, then a section per part. A part that throws
// leaves a note in its place and the others as they are.
export function opsPanelHtml(parts, ctx) {
  const entries = parts.map((part) => {
    const data = attempt(part, 'analyse', () => part.analyse(ctx));
    const ok = data !== FAILED;
    const fact = ok ? attempt(part, 'fact', () => part.fact?.(data, ctx) ?? null) : FAILED;
    const html = ok ? attempt(part, 'html', () => part.html(data, ctx)) : FAILED;
    return { part, fact: fact === FAILED ? null : fact, html: html === FAILED ? '<p>This part could not be shown.</p>' : html };
  });
  const sections = entries
    .map(({ part, html }) => {
      const id = `ops-${escapeHtml(part.id)}-title`;
      return `<section class="ops-section" aria-labelledby="${id}"><h3 id="${id}">${escapeHtml(part.title)}</h3>${html}</section>`;
    })
    .join('');
  return `${stripHtml(entries)}${sections}`;
}
