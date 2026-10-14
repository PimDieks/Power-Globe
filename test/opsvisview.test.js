import { afterEach, describe, expect, it, vi } from 'vitest';
import { opsPanelHtml, OPS_PARTS } from '../src/ops.js';
import { formatClock, formatClockShort, formatTick } from '../src/opsclock.js';
import { CLOCK_CHECK_MS } from '../src/opsrunwayview.js';
import { DEFAULT_LVP_LIMITS, readLimits, saveLimits } from '../src/opsvis.js';
import { bind, hourLabel, hourReadout, unbind, visibilityPart } from '../src/opsvisview.js';
import { toObservation } from '../src/metar.js';
import { parseTaf } from '../src/taf.js';
import { visibilityOutlook } from '../src/opsvis.js';
import samples from './taf-samples.json';

const NOW = Date.parse('2026-10-14T16:20:00Z');
const fmt = (time) => time.slice(11, 16);
const at = (time) => Date.parse(`${time}Z`);
const sample = (ident) => ({ ...samples[ident].meta, fcsts: samples[ident].fcsts });

const ctx = (extra = {}) => ({
  hourly: null,
  observation: null,
  taf: null,
  time: '2026-10-14T18:00',
  now: NOW,
  formatClock: (t) => `${t.slice(11, 16)} UTC`,
  formatClockShort: fmt,
  formatTick: (t) => t.slice(11, 13),
  zone: 'UTC',
  ...extra,
});

function hourly(visibility) {
  const t0 = at('2026-10-14T16:00');
  return {
    time: visibility.map((_, i) => new Date(t0 + i * 3_600_000).toISOString().slice(0, 16)),
    visibility,
    temperature_2m: visibility.map(() => 12),
    dew_point_2m: visibility.map(() => 4),
    wind_speed_10m: visibility.map(() => 10),
  };
}
const fog = toObservation({ rawOb: 'METAR EFRO 141550Z AUTO 17004KT 0700 R21/0900N FG VV002 02/02 Q1009', obsTime: NOW / 1000 - 1800, temp: 2, dewp: 2, visib: 0.43, clouds: [{ cover: 'OVX', base: 200 }] });

const html = (extra) => opsPanelHtml([visibilityPart], ctx(extra));
const count = (text, re) => (text.match(re) ?? []).length;

describe('the low visibility part is one of the Ops parts', () => {
  it('follows the runway part and has the hooks and needs the host expects', () => {
    expect(OPS_PARTS.map((p) => p.id).slice(0, 3)).toEqual(['runway', 'visibility', 'lightning']);
    expect(typeof visibilityPart.bind).toBe('function');
    expect(typeof visibilityPart.unbind).toBe('function');
    for (const name of ['hourly', 'observation', 'taf', 'formatTick', 'zone']) expect(visibilityPart.needs).toContain(name);
  });

  it('says it could not be shown rather than failing when the TAF is missing from the context', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { taf, ...without } = ctx();
    expect(opsPanelHtml([visibilityPart], without)).toContain('could not be shown');
    spy.mockRestore();
  });
});

describe('the section', () => {
  const full = () => html({ hourly: hourly(Array.from({ length: 30 }, () => 10_000)), observation: fog, taf: parseTaf(sample('EFRO')) });

  it('has the status fact, the METAR now, the lines and a row per source', () => {
    const out = full();
    expect(out).toContain('Low visibility outlook');
    expect(out).toContain('<span class="ops-fact-label">Visibility</span> <span class="ops-fact">VIS 700 m, VV 200 ft, LVP</span>');
    expect(out).toContain('class="ops-strip"');
    expect(out).toContain('<span>Vertical visibility</span><b>200 ft</b>');
    expect(out).toContain('<span>RVR</span><b>21 900 m</b>');
    expect(out).toContain('<span>Spread</span><b>0 °C (2 / 2)</b>');
    expect(out).toContain('LVP now, until');
    for (const row of ['METAR', 'TAF', 'TEMPO', 'Model']) expect(out).toContain(`<span>${row}</span>`);
    expect(count(out, /class="vis-hour"/g)).toBe(24);
    // Four rows in an hour of the strip.
    expect(out.match(/<button[^>]*vis-hour[^>]*>(.*?)<\/button>/)[1].match(/<i /g)).toHaveLength(4);
  });

  it('colours the cells by status, red hatched for LVP, and says it in words for every hour', () => {
    const out = full();
    const first = out.match(/<button[^>]*data-time="2026-10-14T16:00"[^>]*>(.*?)<\/button>/)[1];
    expect(first).toBe('<i class="ops-cell status-nogo"></i><i class="ops-cell status-nogo"></i><i class="ops-cell status-nogo"></i><i class="ops-cell status-ok"></i>');
    expect(out).toContain('aria-label="16:00, LVP expected"');
    expect(out).toContain('aria-current="time"');
    expect(count(out, /aria-current="time"/g)).toBe(1);
    expect(out).toContain('data-time="2026-10-14T18:00"');
    // One stop for Tab: the hour on the timeline.
    expect(out).toMatch(/tabindex="0" data-focus-key="vis-hour-2026-10-14T18:00"/);
    expect(count(out, /class="vis-hour" tabindex="0"/g)).toBe(1);
  });

  it('has the limits as fields with their labels above them, and the disclaimer', () => {
    const out = full();
    expect(out).toContain('<legend>Below these it is LVP or marginal (kept in this browser)</legend>');
    for (const [name, label, value] of [['lvpVisibility', 'LVP, visibility (m)', 1500], ['lvpCeiling', 'LVP, ceiling (ft)', 300], ['marginalVisibility', 'Marginal, visibility (m)', 3000], ['marginalCeiling', 'Marginal, ceiling (ft)', 500]]) {
      expect(out).toMatch(new RegExp(`<label><span>${label.replace(/[()]/g, '\\$&')}</span><input type="number"[^>]*data-limit="${name}"[^>]*value="${value}"`));
    }
    expect(out).toContain('An aid to planning, not an official assessment');
  });

  it('leaves out the TEMPO row when the TAF has no changes, and the model row when the forecast has no visibility', () => {
    const out = html({ observation: fog, taf: parseTaf(sample('LFPG')), hourly: { time: ['2026-10-14T16:00'], temperature_2m: [10] } });
    expect(out).not.toContain('<span>TEMPO</span>');
    expect(out).not.toContain('<span>Model</span>');
    expect(out).toContain('has no visibility, so there is no model row');
    expect(out).toContain('<span>TAF</span>');
  });

  it('draws the METAR row empty after the first hour, and blank where a row has nothing to say', () => {
    const out = full();
    const second = out.match(/<button[^>]*data-time="2026-10-14T17:00"[^>]*>(.*?)<\/button>/)[1];
    expect(second.startsWith('<i class="ops-cell status-none"></i>')).toBe(true);
  });

  it('marks the hours of fog risk in the model row', () => {
    const damp = hourly(Array.from({ length: 30 }, () => 10_000));
    damp.temperature_2m = damp.time.map(() => 5);
    damp.dew_point_2m = damp.time.map(() => 4.5);
    damp.wind_speed_10m = damp.time.map(() => 3);
    const out = html({ hourly: damp });
    expect(count(out, /vis-fog/g)).toBe(24);
    expect(out).toContain('Fog risk for the next 24 hours');
    expect(out).toContain('aria-label="16:00, above limits, fog risk"');
  });

  it('says what is missing, with the limits and the disclaimer, when there is nothing to draw', () => {
    const out = html();
    expect(out).toContain('<li>No METAR from this airport in the last 3 hours.</li><li>No TAF for this airport.</li>');
    expect(out).not.toContain('vis-chart');
    expect(out).toContain('data-limit="lvpVisibility"');
    expect(out).toContain('An aid to planning');
    expect(out).toContain('<span class="ops-fact">No data</span>');
  });

  it('copes with a small field that has only the model, and with an airport whose METAR failed', () => {
    const out = html({ hourly: hourly(Array.from({ length: 30 }, () => 2000)) });
    expect(out).toContain('Marginal visibility or ceiling possible for the next 24 hours (model).');
    expect(out).toContain('<span>Model</span>');
    expect(out).not.toContain('<span>METAR</span>');
    const failed = html({ observation: { error: 'blocked <b>' }, taf: { error: 'down' } });
    expect(failed).toContain('The METAR could not be loaded (blocked &lt;b&gt;).');
    expect(failed).not.toContain('<b>)');
  });
});

describe('the section, in the details of what is shown', () => {
  const report = (extra = {}) => toObservation({ rawOb: 'METAR LTFM 141550Z 01035KT 2400 R34L/0700N SHRA BKN006', obsTime: NOW / 1000 - 600, temp: 15, dewp: 14, visib: 1.49, clouds: [{ cover: 'BKN', base: 600 }], ...extra });
  const tile = (out, label) => out.match(new RegExp(`<div class="vis-fact([^"]*)"><span>${label}</span><b>([^<]*)</b>`));

  it('colours the visibility tile by the visibility and the RVR tile by the RVR', () => {
    const out = html({ observation: report() });
    expect(tile(out, 'Visibility').slice(1)).toEqual([' status-caution', '2,400 m']);
    expect(tile(out, 'RVR').slice(1)).toEqual([' status-nogo', '34L 700 m']);
    expect(tile(out, 'Ceiling').slice(1)).toEqual([' status-ok', '600 ft']);
  });

  it('shows an old METAR dimmed, with its age, and does not call it now', () => {
    const out = html({ observation: report({ obsTime: NOW / 1000 - 3 * 3600 }), taf: parseTaf(sample('LFPG')) });
    expect(out).toContain('class="vis-now vis-stale"');
    expect(out).toContain('too old to be now</span><b>13:20, 3 h 00 min old</b>');
    expect(out).toContain('The latest METAR is 3 h 00 min old (13:20), so it is not taken for now.');
    expect(out).not.toContain('<span>METAR</span><span>TAF</span>');
    expect(out).not.toContain('LVP now');
    expect(out).toContain('Visibility');
  });

  it('draws fog in its own row, whatever the forecast says of visibility', () => {
    const damp = hourly(Array.from({ length: 30 }, () => 10_000));
    damp.temperature_2m = damp.time.map(() => 5);
    damp.dew_point_2m = damp.time.map(() => 4.5);
    damp.wind_speed_10m = damp.time.map(() => 3);
    const withVis = html({ hourly: damp });
    expect(withVis).toContain('<span>Fog</span>');
    expect(count(withVis, /vis-fogrisk/g)).toBe(24);
    const { visibility, ...noVis } = damp;
    const out = html({ hourly: noVis, taf: parseTaf(sample('LFPG')) });
    expect(out).toContain('<span>Fog</span>');
    expect(out).not.toContain('<span>Model</span>');
    expect(html({ hourly: hourly(Array.from({ length: 30 }, () => 10_000)) })).not.toContain('<span>Fog</span>');
  });

  it('puts the explanation behind a closed disclosure, and keeps the limits and the disclaimer in view', () => {
    const out = html({ observation: fog, taf: parseTaf(sample('EFRO')) });
    expect(out).toMatch(/<details class="vis-help"><summary>How to read this<\/summary>/);
    expect(out).not.toContain('<details class="vis-help" open');
    // What the strips mean is inside it; the limits and the disclaimer are after it.
    const [inside, after] = out.split('</details>');
    expect(inside).toContain('green above the limits');
    expect(after).toContain('data-limit="lvpVisibility"');
    expect(after).toContain('An aid to planning');
    expect(after).not.toContain('green above the limits');
  });

  it('keeps the disclosure open across drawing again once it has been opened', () => {
    const { root, fire } = (() => {
      const handlers = new Map();
      return { root: { addEventListener: (t, f) => handlers.set(t, f), removeEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [] }, fire: (t, e) => handlers.get(t)?.(e) };
    })();
    bind(root, { setTime: vi.fn(), rerender: vi.fn() }, { setTimer: () => 1, clearTimer: () => {} });
    fire('toggle', { target: { classList: { contains: () => true }, open: true } });
    expect(html({ observation: fog, taf: parseTaf(sample('EFRO')) })).toContain('<details class="vis-help" open>');
    fire('toggle', { target: { classList: { contains: () => false }, open: false } });
    expect(html({ observation: fog, taf: parseTaf(sample('EFRO')) })).toContain('<details class="vis-help" open>');
    fire('toggle', { target: { classList: { contains: () => true }, open: false } });
    expect(html({ observation: fog, taf: parseTaf(sample('EFRO')) })).not.toContain('<details class="vis-help" open>');
    unbind();
  });

  it('marks the limit fields so the section is not drawn again while one is typed in, and says when limits are not kept', () => {
    const out = html({ observation: fog });
    expect(count(out, /data-editing/g)).toBe(4);
    expect(out).not.toContain('could not be kept');
    const broken = { getItem: () => null, setItem: () => { throw new Error('full'); } };
    saveLimits({ lvpVisibility: 2000, marginalVisibility: 1000 }, broken);
    const warned = html({ observation: fog });
    expect(warned).toContain('These limits could not be kept in this browser. They apply until the page is closed.');
    // What was typed is shown as typed; judged with marginal no stricter than LVP, and it says so.
    expect(warned).toMatch(/data-limit="marginalVisibility"[^>]*value="1000"/);
    expect(warned).toContain('Marginal limits below the LVP ones are judged as the LVP ones.');
    saveLimits(DEFAULT_LVP_LIMITS, { getItem: () => null, setItem: () => {} });
  });
});

describe('what an hour says', () => {
  const o = visibilityOutlook({ now: NOW, observation: fog, taf: parseTaf(sample('EFRO')), hourly: hourly(Array.from({ length: 30 }, () => 800)) });

  it('lists every source with its numbers', () => {
    expect(hourReadout(o.hours[0], fmt)).toBe('16:00 · METAR 700 m, ceiling 200 ft (LVP) · TAF 300 m, ceiling 100 ft (LVP) · TAF TEMPO 1,200 m, ceiling 200 ft (LVP) · model 800 m (LVP)');
    expect(hourLabel(o.hours[0], fmt)).toBe('16:00, LVP expected');
  });

  it('says RVR when it is the RVR that counts, and no data when there is none', () => {
    const rvr = visibilityOutlook({ now: NOW, observation: toObservation({ rawOb: 'METAR LTFM 2400 R34L/0700N', visib: 1.49, obsTime: NOW / 1000 }) });
    expect(hourReadout(rvr.hours[0], fmt)).toContain('METAR 2,400 m (LVP), RVR 700 m');
    expect(hourReadout(rvr.hours[3], fmt)).toBe('19:00 · no data');
  });
});

describe('the part at work in the panel', () => {
  // Just enough of the page: a root that holds listeners and finds what the handlers ask for.
  function page() {
    const handlers = new Map();
    const fire = (type, event) => handlers.get(type)?.(event);
    const hourEls = Array.from({ length: 4 }, (_, i) => {
      const el = {
        dataset: { time: `2026-10-14T1${2 + i}:00`, visReadout: `readout ${i}` },
        tabIndex: i === 0 ? 0 : -1,
        focus() {
          hourEls.focused = el;
          fire('focusin', { target: el });
        },
        closest: (sel) => (sel === '.vis-hour' || sel === '[data-vis-readout]' ? el : null),
      };
      return el;
    });
    const inputs = ['lvpVisibility', 'lvpCeiling', 'marginalVisibility', 'marginalCeiling'].map((name, i) => ({ dataset: { limit: name }, value: ['800', '', '2000', '400'][i] }));
    const readout = { textContent: '', dataset: { default: 'default readout' } };
    const chart = { dataset: { first: '2026-10-14T12:00' } };
    const track = { children: hourEls, getBoundingClientRect: () => ({ left: 100, width: 400 }) };
    const root = {
      addEventListener: (type, fn) => handlers.set(type, fn),
      removeEventListener: (type, fn) => handlers.get(type) === fn && handlers.delete(type),
      querySelector(sel) {
        if (sel === '.vis-readout') return readout;
        if (sel === '.vis-chart') return chart;
        if (sel === '.vis-hours') return track;
        const m = sel.match(/data-time="([^"]+)"/);
        return m ? hourEls.find((e) => e.dataset.time === m[1]) : null;
      },
      querySelectorAll: (sel) => (sel === '[data-limit]' ? inputs : hourEls),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    };
    return { root, handlers, hourEls, readout, fire };
  }
  const inTrack = { closest: (sel) => (sel === '.vis-chart .vis-hours' ? {} : null) };
  const quiet = { setTimer: () => 1, clearTimer: () => {} };

  afterEach(() => unbind());

  it('sets the timeline from a drag across the hours, once per hour, and says it once at the end', () => {
    const { root, fire, readout } = page();
    const setTime = vi.fn();
    bind(root, { setTime, rerender: vi.fn() }, quiet);
    fire('pointerdown', { button: 0, pointerId: 7, clientX: 120, target: inTrack });
    fire('pointermove', { clientX: 130 });
    fire('pointermove', { clientX: 260 });
    fire('pointermove', { clientX: 490 });
    expect(setTime.mock.calls.map((c) => c[0])).toEqual(['2026-10-14T12:00', '2026-10-14T13:00', '2026-10-14T15:00']);
    expect(setTime.mock.calls.every((c) => c[1]?.quiet)).toBe(true);
    expect(readout.textContent).toBe('readout 3');
    fire('pointerup', { pointerId: 7 });
    expect(setTime).toHaveBeenLastCalledWith('2026-10-14T15:00');
    fire('pointermove', { clientX: 120 });
    expect(setTime).toHaveBeenCalledTimes(4);
  });

  it('ignores presses outside its strip, and other mouse buttons', () => {
    const { root, fire } = page();
    const setTime = vi.fn();
    bind(root, { setTime, rerender: vi.fn() }, quiet);
    fire('pointerdown', { button: 0, clientX: 0, target: { closest: () => null } });
    fire('pointerdown', { button: 2, clientX: 0, target: inTrack });
    fire('pointermove', { clientX: 300 });
    // The runway part's strip is not this one.
    fire('pointerdown', { button: 0, clientX: 0, target: { closest: (sel) => (sel === '.ops-chart .ops-track' ? {} : null) } });
    expect(setTime).not.toHaveBeenCalled();
  });

  it('sets the timeline from the keyboard, not from a mouse click already handled', () => {
    const { root, fire, hourEls } = page();
    const setTime = vi.fn();
    bind(root, { setTime, rerender: vi.fn() }, quiet);
    fire('click', { detail: 0, target: hourEls[2] });
    expect(setTime).toHaveBeenCalledWith('2026-10-14T14:00');
    setTime.mockClear();
    fire('click', { detail: 1, target: hourEls[2] });
    expect(setTime).not.toHaveBeenCalled();
  });

  it('moves between the hours with the arrow keys, keeping one stop for Tab', () => {
    const { root, fire, hourEls, readout } = page();
    bind(root, { setTime: vi.fn(), rerender: vi.fn() }, quiet);
    const key = (name, from) => {
      const event = { key: name, target: hourEls[from], preventDefault: vi.fn() };
      fire('keydown', event);
      return event;
    };
    expect(key('ArrowRight', 0).preventDefault).toHaveBeenCalled();
    expect(hourEls.focused).toBe(hourEls[1]);
    expect(hourEls.map((e) => e.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(readout.textContent).toBe('readout 1');
    key('End', 1);
    expect(hourEls.focused).toBe(hourEls[3]);
    key('Home', 3);
    expect(hourEls.focused).toBe(hourEls[0]);
    expect(key('a', 0).preventDefault).not.toHaveBeenCalled();
  });

  it('shows the hour under the pointer and goes back to the timeline hour', () => {
    const { root, fire, hourEls, readout } = page();
    bind(root, { setTime: vi.fn(), rerender: vi.fn() }, quiet);
    fire('pointerover', { target: hourEls[2] });
    expect(readout.textContent).toBe('readout 2');
    fire('pointerout', {});
    expect(readout.textContent).toBe('default readout');
  });

  it('keeps the limits when one is changed, and draws the panel again', () => {
    const { root, fire } = page();
    const rerender = vi.fn();
    const data = {};
    const storage = { getItem: (k) => data[k] ?? null, setItem: (k, v) => (data[k] = v) };
    bind(root, { setTime: vi.fn(), rerender }, { ...quiet, storage });
    fire('change', { target: { closest: () => null } });
    expect(rerender).not.toHaveBeenCalled();
    vi.useFakeTimers();
    fire('change', { target: { closest: (sel) => (sel === '[data-limit]' ? {} : null) } });
    // An empty field is the default.
    expect(readLimits(storage)).toEqual({ lvpVisibility: 800, lvpCeiling: 300, marginalVisibility: 2000, marginalCeiling: 400 });
    // Drawn again once the focus has moved on.
    expect(rerender).not.toHaveBeenCalled();
    vi.runAllTimers();
    vi.useRealTimers();
    expect(rerender).toHaveBeenCalledTimes(1);
  });

  it('puts the defaults back with the reset button', () => {
    const { root, fire } = page();
    const rerender = vi.fn();
    const data = { 'power-globe:ops-visibility-limits': JSON.stringify({ lvpVisibility: 800 }) };
    const storage = { getItem: (k) => data[k] ?? null, setItem: (k, v) => (data[k] = v) };
    bind(root, { setTime: vi.fn(), rerender }, { ...quiet, storage });
    expect(readLimits(storage).lvpVisibility).toBe(800);
    fire('click', { detail: 1, target: { closest: (sel) => (sel === '[data-vis-reset]' ? {} : null) } });
    expect(readLimits(storage)).toEqual(DEFAULT_LVP_LIMITS);
    expect(rerender).toHaveBeenCalledTimes(1);
  });

  it('draws the panel again when a new hour begins, and stops checking when unbound', () => {
    vi.useFakeTimers();
    try {
      const { root, handlers } = page();
      const rerender = vi.fn();
      let clock = Date.parse('2026-10-14T12:30:00Z');
      bind(root, { setTime: vi.fn(), rerender }, { now: () => clock });
      vi.advanceTimersByTime(CLOCK_CHECK_MS);
      expect(rerender).not.toHaveBeenCalled();
      clock = Date.parse('2026-10-14T13:00:30Z');
      vi.advanceTimersByTime(CLOCK_CHECK_MS);
      expect(rerender).toHaveBeenCalledTimes(1);
      unbind();
      expect(handlers.size).toBe(0);
      vi.advanceTimersByTime(CLOCK_CHECK_MS * 5);
      expect(rerender).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('times in the section', () => {
  it('are written by the formatters of the context (local time with the zone for the fact)', () => {
    const out = html({ observation: fog, taf: parseTaf(sample('EFRO')), formatClock, formatClockShort, formatTick });
    expect(out).toContain('ops-fact');
    expect(out).toContain('Local time, UTC');
  });
});
