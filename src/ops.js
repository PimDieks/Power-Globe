// The topic tabs of the airport panel (Weather, Traffic, Access), the summary line above them, and
// the frame the parts plug into. A part is
//
//   { id, tab, title, factLabel, needs, analyse(ctx), fact(data, ctx), html(data, ctx),
//     overlay, bind(root, api), unbind(root), watch(api), unwatch(), release(), staleAfterMs }
//
// `tab` is the tab it is shown in ('weather', 'traffic' or 'access'). `analyse` does the work once
// per render and gives `data`; `fact` gives the part's one line for the summary line ({ text, status,
// asOf } or null; `asOf` is when the data behind it was last fresh, in ms, if the part has a source
// that can fall silent) and `html` its section. `needs` lists the names the part reads from `ctx`,
// which main.js builds for the open airport (airport, hourly, error, observation, taf, limits,
// limitsLabel, time, now and the time formatters, see opsclock.js); a part whose needs are not all
// there says so instead of failing.
//
// The summary line shows every part's fact on every tab, so facts must stay fresh with their tab
// closed. A part that only works out its fact from `ctx` needs nothing more. A part with a source of
// its own (polling, a watch feed) keeps it running at its normal rate while the panel is open, in a
// light "summary mode": `watch(api)` starts it, without map overlays or the section, and `unwatch()`
// ends it. `bind(root, api)` and `unbind(root)` (all optional) are called when the part's own tab is
// shown and when it goes: `root` is the element the tab's HTML is put in, which stays the same across
// renders, so a part listens to it for what happens in its section (events are delegated), and
// starts and stops what belongs to the open tab, such as the map overlay. A part's source runs while
// it is bound or watched, so the change from one to the other does not stop it. `release()` lets go
// of the open airport at once, as another is being opened. Nothing is left running when the panel
// closes: the host ends every mode then. A field marked data-editing is not drawn over while it is
// being typed in.
//
// `overlay` names what the part draws on the map while its tab is bound ('lightning', 'trafficMarks' or
// 'roads', see mapprofile.js, which says for each tab what the map around the airport shows).
//
// `api` is { getContext(), rerender(), setTime(time, { quiet }), refreshSummary(), mapProfile() }: the
// context now, drawing the tab again, setting the timeline, drawing the summary line again (a part
// calls it when its data changed), and the map profile of the shown tab. If a fact has an `asOf` older than the part's `staleAfterMs` (ten minutes
// if not given), the summary line shows it grey, with how old it is, rather than as the present.
//
// To add a part, write one module that exports such an object and add it to OPS_PARTS below; nothing
// else changes.
import { escapeHtml } from './airportview.js';
import { runwayPart } from './opsrunwayview.js';
import { visibilityPart } from './opsvisview.js';
import { lightningPart } from './opslightningview.js';
import { trafficPart } from './opstrafficview.js';
import { factItemHtml } from './opsfact.js';
import { mapProfileFor } from './mapprofile.js';

// The parts, in the order their sections are shown and their facts are listed.
export const OPS_PARTS = [
  runwayPart,
  visibilityPart,
  lightningPart,
  trafficPart,
];

// The topic tabs after Details, in order. `empty` is what a tab says while no part is registered
// for it; a tab with neither parts nor `empty` is left out.
export const TOPIC_TABS = [
  { id: 'weather', label: 'Weather' },
  { id: 'traffic', label: 'Traffic' },
  { id: 'access', label: 'Access', empty: 'Road and public transport information, coming soon' },
];

const reported = new Set();

// The parts that name a tab that exists; one that does not is left out, with a note once.
export function registered(parts) {
  return parts.filter((part) => {
    if (TOPIC_TABS.some((tab) => tab.id === part.tab)) return true;
    if (!reported.has(part)) {
      reported.add(part);
      console.error(`Ops part "${part.id}" is in a tab that does not exist: ${part.tab}`);
    }
    return false;
  });
}

// The parts of each tab: { weather: [...], traffic: [...], access: [] }, in registry order.
export function partsByTab(parts = OPS_PARTS) {
  const groups = Object.fromEntries(TOPIC_TABS.map((tab) => [tab.id, []]));
  for (const part of registered(parts)) groups[part.tab].push(part);
  return groups;
}

// The tabs the panel has: Details, then each topic tab that has a part or a note.
export function tabsFor(parts = OPS_PARTS) {
  const groups = partsByTab(parts);
  return [{ id: 'details', label: 'Details' }, ...TOPIC_TABS.filter((tab) => groups[tab.id].length || tab.empty).map(({ id, label }) => ({ id, label }))];
}

export const DETAIL_TABS = tabsFor(OPS_PARTS);
export const isTopicTab = (id) => TOPIC_TABS.some((tab) => tab.id === id);
const TAB_KEY = 'power-globe:airport-tab';
// What an earlier version stored, and the tab it became.
const RENAMED = { ops: 'weather' };

// The tab remembered for this browser, or the first. The old "ops" is now "weather".
export function readTab(storage) {
  try {
    const store = storage ?? globalThis.localStorage;
    let saved = store.getItem(TAB_KEY);
    if (Object.hasOwn(RENAMED, saved)) {
      saved = RENAMED[saved];
      saveTab(saved, store);
    }
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

// The names a part needs that `ctx` does not have.
const missing = (part, ctx) => (part.needs ?? []).filter((name) => !(name in ctx));

// What `part` makes of `ctx`: { part, data, fact }, or { part, failed: true, fact: null } when it
// throws or lacks something in `ctx`.
export function analysePart(part, ctx) {
  const lacking = missing(part, ctx);
  if (lacking.length) {
    console.error(`Ops part "${part.id}" needs ${lacking.join(', ')} in its context`);
    return { part, failed: true, fact: null };
  }
  const data = attempt(part, 'analyse', () => part.analyse(ctx));
  if (data === FAILED) return { part, failed: true, fact: null };
  const fact = attempt(part, 'fact', () => part.fact?.(data, ctx) ?? null);
  return { part, data, fact: fact === FAILED ? null : fact };
}

// ----- the summary line -----

export const STALE_AFTER_MS = 10 * 60_000;

// A fact as the summary line shows it. A fact with an `asOf` older than the part's `staleAfterMs`
// is no longer the present: it turns grey, never green or amber, and says how old it is. A fact
// without `asOf` comes from the context alone and is as fresh as the context.
export function summaryFact(part, fact, now) {
  if (!Number.isFinite(fact.asOf)) return fact;
  const age = now - fact.asOf;
  if (age <= (part.staleAfterMs ?? STALE_AFTER_MS)) return fact;
  const minutes = Math.max(1, Math.round(age / 60_000));
  return { ...fact, status: 'unknown', text: `${fact.text}, ${minutes} min old`, stale: true };
}

// The summary line: one button per part that has a fact, in registry order.
export function summaryHtml(entries, now = Date.now()) {
  const items = entries
    .filter((e) => e.fact?.text)
    .map(({ part, fact }) => factItemHtml(part, summaryFact(part, fact, now), TOPIC_TABS.find((tab) => tab.id === part.tab).label))
    .join('');
  return items ? `<ul class="ops-facts" aria-label="Key facts">${items}</ul>` : '';
}

// ----- the sections -----

const FAILED_HTML = '<p>This part could not be shown.</p>';

// The sections of a tab, one per entry (see analysePart). A part that throws leaves a note in its
// place and the others as they are.
export function sectionsHtml(entries, ctx) {
  return entries
    .map(({ part, data, failed }) => {
      const html = failed ? FAILED_HTML : attempt(part, 'html', () => part.html(data, ctx));
      const id = `ops-${escapeHtml(part.id)}-title`;
      return `<section class="ops-section" data-part="${escapeHtml(part.id)}" aria-labelledby="${id}"><h3 id="${id}" tabindex="-1">${escapeHtml(part.title)}</h3>${html === FAILED ? FAILED_HTML : html}</section>`;
    })
    .join('');
}

// The sections for `parts`, worked out from `ctx`.
export const opsPanelHtml = (parts, ctx) => sectionsHtml(parts.map((part) => analysePart(part, ctx)), ctx);

// ----- the host -----

// How often the summary line is worked out again whatever the parts say, for the facts that change
// with the clock (a runway change at the next hour, a report growing old).
export const SUMMARY_REFRESH_MS = 60_000;

// The tabs in `root` and the summary line in `summaryRoot`: draws them, and gives the parts their
// `bind`, `watch` and the calls that end them. `getContext()` gives the context for the open airport,
// `requestRender()` asks for the panel to be drawn again, `setTime(time, { quiet })` sets the
// timeline to a GMT time, `selectTab(id)` shows a tab, `onProfile(profile)` is told the map profile of the
// tab shown (and null when the panel closes).
export function createOpsHost({ root, summaryRoot, getContext, requestRender, setTime, selectTab, onProfile = () => {}, parts = OPS_PARTS, setTimer = setInterval, clearTimer = clearInterval }) {
  const known = registered(parts);
  const groups = partsByTab(known);
  let mounted = false;
  let tab = null;
  // Whether the panel has been drawn for the airport open now: before that there is no summary.
  let drawn = false;
  let timer = null;
  // What each part is doing, by id: 'bind' for its tab being shown, 'watch' for summary mode.
  const modes = new Map();
  // A field marked data-editing that has been typed in and not yet left: the tab is not drawn
  // again meanwhile (which would take what was typed away), but once, when it is left.
  let editing = false;
  let skipped = false;

  const draw = (el, html) => {
    if (!el || el.innerHTML === html) return;
    const active = el.contains(document.activeElement) ? document.activeElement.closest?.('[data-focus-key]') : null;
    const key = active?.dataset.focusKey;
    el.innerHTML = html;
    if (key) el.querySelector(`[data-focus-key="${CSS.escape(key)}"]`)?.focus();
  };

  const drawSummary = (ctx) => {
    const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
    draw(summaryRoot, summaryHtml(known.map((part) => analysePart(part, ctx)), now));
  };

  const refreshSummary = () => {
    if (!mounted || !drawn) return;
    let ctx;
    try {
      ctx = getContext();
    } catch {
      return;
    }
    drawSummary(ctx);
  };

  const api = { getContext, rerender: requestRender, setTime, refreshSummary, mapProfile: () => (tab ? mapProfileFor(tab) : null) };

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

  // Shows the tab of the part whose fact was pressed, with its section in view.
  const onSummaryClick = (event) => {
    const id = event.target.closest?.('[data-part]')?.dataset.part;
    const part = known.find((p) => p.id === id);
    if (!part) return;
    selectTab(part.tab);
    const section = root.querySelector(`.ops-section[data-part="${CSS.escape(id)}"]`);
    if (!section) return;
    const calm = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section.scrollIntoView?.({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
    section.querySelector('h3')?.focus({ preventScroll: true });
  };

  // Gives every part the mode its tab calls for: its own tab being shown binds it, any other tab
  // keeps a part with a summary mode watching. The new mode starts before the old one ends.
  function applyModes() {
    for (const part of known) {
      const want = part.tab === tab ? 'bind' : part.watch ? 'watch' : null;
      const have = modes.get(part.id) ?? null;
      if (want === have) continue;
      if (want === 'bind') attempt(part, 'bind', () => part.bind?.(root, api));
      else if (want === 'watch') attempt(part, 'watch', () => part.watch(api));
      if (have === 'bind') attempt(part, 'unbind', () => part.unbind?.(root));
      else if (have === 'watch') attempt(part, 'unwatch', () => part.unwatch?.());
      modes.set(part.id, want);
    }
  }

  function endModes() {
    for (const part of known) {
      const have = modes.get(part.id);
      if (have === 'bind') attempt(part, 'unbind', () => part.unbind?.(root));
      else if (have === 'watch') attempt(part, 'unwatch', () => part.unwatch?.());
    }
    modes.clear();
  }

  return {
    // Called whenever the panel's state changes while it shows an airport, with the tab shown.
    // Idempotent; the parts change mode only when the tab does.
    show(id) {
      if (!mounted) {
        mounted = true;
        root.addEventListener('input', onInput);
        root.addEventListener('change', onDone);
        root.addEventListener('focusout', onDone);
        summaryRoot?.addEventListener('click', onSummaryClick);
        timer = setTimer(refreshSummary, SUMMARY_REFRESH_MS);
      }
      const changed = tab !== id;
      tab = id;
      applyModes();
      // The airport map follows the tab (see mapprofile.js).
      if (changed) onProfile(mapProfileFor(id));
    },
    // The panel closed, or shows something else: nothing of the parts runs on, and the summary goes.
    stop() {
      if (!mounted) return;
      mounted = false;
      editing = false;
      skipped = false;
      drawn = false;
      tab = null;
      clearTimer(timer);
      timer = null;
      root.removeEventListener('input', onInput);
      root.removeEventListener('change', onDone);
      root.removeEventListener('focusout', onDone);
      summaryRoot?.removeEventListener('click', onSummaryClick);
      endModes();
      onProfile(null);
      if (summaryRoot) summaryRoot.innerHTML = '';
    },
    // Another airport is being opened: the old one is let go of at once and its summary goes, without
    // waiting for the new one to be drawn.
    release() {
      drawn = false;
      if (summaryRoot) summaryRoot.innerHTML = '';
      for (const part of known) attempt(part, 'release', () => part.release?.());
    },
    refreshSummary,
    // Draws the summary line for `ctx`, and the tab if it is a topic tab; focus stays on the same
    // element (marked data-focus-key) across it.
    render(ctx) {
      drawn = true;
      const entries = known.map((part) => analysePart(part, ctx));
      draw(summaryRoot, summaryHtml(entries, Number.isFinite(ctx.now) ? ctx.now : Date.now()));
      if (!isTopicTab(tab)) return;
      if (editing && root.contains(document.activeElement)) {
        skipped = true;
        return;
      }
      const shown = entries.filter((entry) => groups[tab].includes(entry.part));
      const note = TOPIC_TABS.find((t) => t.id === tab).empty;
      draw(root, shown.length ? sectionsHtml(shown, ctx) : `<p class="ops-empty">${escapeHtml(note ?? '')}</p>`);
    },
  };
}
