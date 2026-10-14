// The Ops view of the airport panel: its tabs, and the frame the Ops parts plug into. A part is
//
//   { id, title, factLabel, needs, analyse(ctx), fact(data, ctx), html(data, ctx), bind(root, api), unbind(root) }
//
// `analyse` does the work once per render and gives `data`; `fact` gives the part's one line for the
// status strip at the top ({ text, status } or null) and `html` its section. `needs` lists the
// names the part reads from `ctx`, which main.js builds for the open airport (airport, hourly,
// error, observation, taf, limits, limitsLabel, time, now and the time formatters, see opsclock.js);
// a part whose needs are not all there says so instead of failing. `bind` and `unbind` (both
// optional) are called when the Ops tab is shown and when it goes: `root` is the element the HTML
// is put in, which stays the same across renders, so a part listens to it for what happens in its
// section (events are delegated), and starts and stops anything of its own, such as polling. A field
// marked data-editing is not drawn over while it is being typed in.
// `api` is { getContext(), rerender(), setTime(time, { quiet }) }: the context now, drawing the
// tab again, and setting the timeline. To add a part, write one module that exports such an object
// and add it to OPS_PARTS below; nothing else changes.
import { escapeHtml } from './airportview.js';
import { runwayPart } from './opsrunwayview.js';
import { visibilityPart } from './opsvisview.js';
import { lightningPart } from './opslightningview.js';
import { accessPart } from './opsaccessview.js';
import { trafficPart } from './opstrafficview.js';
import { factItemHtml } from './opsfact.js';

// The Ops parts, in the order their sections are shown and their facts are listed.
export const OPS_PARTS = [runwayPart, visibilityPart, lightningPart, trafficPart, accessPart];

export const DETAIL_TABS = [
  { id: 'details', label: 'Details' },
  { id: 'ops', label: 'Ops' },
];
const TAB_KEY = 'power-globe:airport-tab';

// The tab remembered for this browser, or the first.
export function readTab(storage) {
  try {
    const saved = (storage ?? globalThis.localStorage).getItem(TAB_KEY);
    if (DETAIL_TABS.some((tab) => tab.id === saved)) return saved;
  } catch {
    // Nothing saved, or storage unavailable.
  }
  return DETAIL_TABS[0].id;
}

export function saveTab(id, storage) {
  try {
    (storage ?? globalThis.localStorage).setItem(TAB_KEY, id);
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
  const items = facts.map(({ part, fact }) => factItemHtml(part, fact)).join('');
  return `<ul class="ops-strip" aria-label="Key facts">${items}</ul>`;
}

// The names a part needs that `ctx` does not have.
const missing = (part, ctx) => (part.needs ?? []).filter((name) => !(name in ctx));

// The whole Ops tab for `parts`: the status strip, then a section per part. A part that throws, or
// lacks something in `ctx`, leaves a note in its place and the others as they are.
export function opsPanelHtml(parts, ctx) {
  const entries = parts.map((part) => {
    const lacking = missing(part, ctx);
    if (lacking.length) {
      console.error(`Ops part "${part.id}" needs ${lacking.join(', ')} in its context`);
      return { part, fact: null, html: '<p>This part could not be shown.</p>' };
    }
    const data = attempt(part, 'analyse', () => part.analyse(ctx));
    const ok = data !== FAILED;
    const fact = ok ? attempt(part, 'fact', () => part.fact?.(data, ctx) ?? null) : FAILED;
    const html = ok ? attempt(part, 'html', () => part.html(data, ctx)) : FAILED;
    return { part, fact: fact === FAILED ? null : fact, html: html === FAILED ? '<p>This part could not be shown.</p>' : html };
  });
  const sections = entries
    .map(({ part, html }) => {
      const id = `ops-${escapeHtml(part.id)}-title`;
      return `<section class="ops-section" data-part="${escapeHtml(part.id)}" aria-labelledby="${id}"><h3 id="${id}">${escapeHtml(part.title)}</h3>${html}</section>`;
    })
    .join('');
  return `${stripHtml(entries)}${sections}`;
}

// The Ops tab in `root`: draws it, and gives the parts their `bind` and `unbind` calls. `getContext()`
// gives the context for the open airport, `requestRender()` asks for the panel to be drawn
// again, `setTime(time, { quiet })` sets the timeline to a GMT time.
export function createOpsHost({ root, getContext, requestRender, setTime, parts = OPS_PARTS }) {
  let mounted = false;
  // A field marked data-editing that has been typed in and not yet left: the tab is not drawn
  // again meanwhile (which would take what was typed away), but once, when it is left.
  let editing = false;
  let skipped = false;
  const api = { getContext, rerender: requestRender, setTime };
  const onInput = (event) => {
    if (event.target.closest?.('[data-editing]')) editing = true;
  };
  const onDone = () => {
    if (!editing) return;
    editing = false;
    if (skipped) {
      skipped = false;
      setTimeout(requestRender, 0);
    }
  };
  return {
    // Idempotent: called whenever the panel's state changes.
    mount() {
      if (mounted) return;
      mounted = true;
      root.addEventListener('input', onInput);
      root.addEventListener('change', onDone);
      root.addEventListener('focusout', onDone);
      for (const part of parts) attempt(part, 'bind', () => part.bind?.(root, api));
    },
    unmount() {
      if (!mounted) return;
      mounted = false;
      editing = false;
      skipped = false;
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onDone);
      root.removeEventListener('focusout', onDone);
      for (const part of parts) attempt(part, 'unbind', () => part.unbind?.(root));
    },
    // Draws the tab for `ctx`; focus stays on the same element (marked data-focus-key) across it.
    render(ctx) {
      if (editing && root.contains(document.activeElement)) {
        skipped = true;
        return;
      }
      const active = root.contains(document.activeElement) ? document.activeElement.closest?.('[data-focus-key]') : null;
      const key = active?.dataset.focusKey;
      root.innerHTML = opsPanelHtml(parts, ctx);
      if (key) root.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus();
    },
  };
}
