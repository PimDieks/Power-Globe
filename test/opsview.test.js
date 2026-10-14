import { afterEach, describe, expect, it, vi } from 'vitest';
import { toAirport } from '../src/airports.js';
import { createOpsHost, opsPanelHtml } from '../src/ops.js';
import { CLOCK_CHECK_MS, bind, endLabelCells, hourIndexAt, hourLabel, runwayPart, unbind } from '../src/opsrunwayview.js';
import { runwayOutlook } from '../src/opsrunway.js';

describe('what a part needs, and binding', () => {
  it('says a part could not be shown when the context lacks what it needs', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const part = { id: 'n', title: 'N', needs: ['zone', 'thing'], analyse: vi.fn(() => ({})), html: () => '<p>fine</p>' };
    const html = opsPanelHtml([part], { zone: 'UTC' });
    expect(html).toContain('could not be shown');
    expect(part.analyse).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('thing'));
    // A need that is there but empty (no forecast yet) is fine.
    expect(opsPanelHtml([part], { zone: 'UTC', thing: null })).toContain('fine');
    spy.mockRestore();
  });

  it('binds each part once when the tab is mounted and unbinds it when it goes', () => {
    const calls = [];
    const a = { id: 'a', tab: 'weather', title: 'A', analyse: () => 1, html: () => '', bind: (root, api) => calls.push(['bind a', root, api]), unbind: (root) => calls.push(['unbind a', root]) };
    const b = { id: 'b', tab: 'weather', title: 'B', analyse: () => 1, html: () => '' };
    const c = {
      id: 'c',
      tab: 'weather',
      title: 'C',
      analyse: () => 1,
      html: () => '',
      bind: () => {
        throw new Error('nope');
      },
    };
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const root = { addEventListener: () => {}, removeEventListener: () => {} };
    const host = createOpsHost({ root, getContext: () => ({}), requestRender: () => {}, setTime: () => {}, parts: [a, b, c] });
    host.show('weather');
    host.show('weather');
    expect(calls.map((c) => c[0])).toEqual(['bind a']);
    expect(calls[0][1]).toBe(root);
    expect(Object.keys(calls[0][2]).sort()).toEqual(['getContext', 'mapProfile', 'refreshSummary', 'rerender', 'setTime']);
    host.stop();
    host.stop();
    expect(calls.map((c) => c[0])).toEqual(['bind a', 'unbind a']);
    host.show('weather');
    expect(calls).toHaveLength(3);
    spy.mockRestore();
  });
});

describe('a field being typed in', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function setup() {
    const handlers = new Map();
    let focusInside = true;
    const root = {
      innerHTML: '',
      addEventListener: (t, f) => handlers.set(t, f),
      removeEventListener: (t) => handlers.delete(t),
      contains: () => focusInside,
      querySelector: () => null,
    };
    vi.stubGlobal('document', { activeElement: { closest: () => null } });
    vi.stubGlobal('CSS', { escape: (x) => x });
    vi.useFakeTimers();
    const requestRender = vi.fn();
    let version = 1;
    const part = { id: 'p', tab: 'weather', title: 'P', analyse: () => 1, html: () => `<p>v${version}</p>` };
    const host = createOpsHost({ root, getContext: () => ({}), requestRender, setTime: () => {}, parts: [part], setTimer: () => 1, clearTimer: () => {} });
    host.show('weather');
    const typed = () => handlers.get('input')({ target: { closest: (sel) => (sel === '[data-editing]' ? {} : null) } });
    return { root, handlers, host, requestRender, typed, bump: () => (version += 1), leave: (inside) => (focusInside = inside) };
  }

  it('is not drawn over, and is drawn once when the field is left', () => {
    const { root, handlers, host, requestRender, typed, bump } = setup();
    host.render({});
    expect(root.innerHTML).toContain('v1');
    typed();
    bump();
    root.innerHTML = 'what was typed';
    host.render({});
    host.render({});
    expect(root.innerHTML).toBe('what was typed');
    handlers.get('focusout')({});
    vi.runAllTimers();
    expect(requestRender).toHaveBeenCalledTimes(1);
    host.render({});
    expect(root.innerHTML).toContain('v2');
    // Leaving a field with nothing held back asks for nothing.
    typed();
    handlers.get('change')({});
    vi.runAllTimers();
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  it('is drawn as usual for anything else typed in, or when the focus is elsewhere', () => {
    const { root, handlers, host, typed, bump, leave } = setup();
    handlers.get('input')({ target: { closest: () => null } });
    bump();
    host.render({});
    expect(root.innerHTML).toContain('v2');
    typed();
    leave(false);
    bump();
    host.render({});
    expect(root.innerHTML).toContain('v3');
  });

  it('forgets it when the tab goes', () => {
    const { root, handlers, host, typed } = setup();
    typed();
    host.stop();
    expect(handlers.size).toBe(0);
    host.show('weather');
    host.render({});
    expect(root.innerHTML).toContain('v1');
  });
});

describe('the runway part at work in the panel', () => {
  // Just enough of the page: a root that holds listeners and finds what the handlers ask for.
  function page() {
    const handlers = new Map();
    const fire = (type, event) => handlers.get(type)?.(event);
    const hourEls = Array.from({ length: 4 }, (_, i) => {
      const el = {
        dataset: { time: `2026-10-14T1${2 + i}:00`, readout: `readout ${i}` },
        tabIndex: i === 0 ? 0 : -1,
        focus() {
          hourEls.focused = el;
          fire('focusin', { target: el });
        },
        closest: (sel) => (sel === '.ops-hour' || sel === '[data-readout]' ? el : null),
      };
      return el;
    });
    const readout = { textContent: '', dataset: { default: 'default readout' } };
    const chart = { dataset: { first: '2026-10-14T12:00' } };
    const track = { children: hourEls, getBoundingClientRect: () => ({ left: 100, width: 400 }) };
    const root = {
      addEventListener: (type, fn) => handlers.set(type, fn),
      removeEventListener: (type, fn) => handlers.get(type) === fn && handlers.delete(type),
      querySelector(sel) {
        if (sel === '.ops-readout') return readout;
        if (sel === '.ops-chart') return chart;
        if (sel === '.ops-hours') return track;
        const m = sel.match(/data-time="([^"]+)"/);
        return m ? hourEls.find((e) => e.dataset.time === m[1]) : null;
      },
      querySelectorAll: () => hourEls,
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    };
    return { root, handlers, hourEls, readout, chart, fire };
  }
  const inTrack = (segment = null) => ({ closest: (sel) => (sel === '.ops-chart .ops-track' ? {} : sel === '.ops-segment' ? segment : null) });
  const quiet = { setTimer: () => 1, clearTimer: () => {} };

  afterEach(() => unbind());

  it('sets the timeline from a drag across the hours, once per hour, and says it once at the end', () => {
    const { root, fire, readout } = page();
    const setTime = vi.fn();
    bind(root, { setTime, rerender: vi.fn() }, quiet);
    fire('pointerdown', { button: 0, pointerId: 7, clientX: 120, target: inTrack() });
    expect(root.setPointerCapture).toHaveBeenCalledWith(7);
    fire('pointermove', { clientX: 130 });
    fire('pointermove', { clientX: 260 });
    fire('pointermove', { clientX: 490 });
    expect(setTime.mock.calls.map((c) => c[0])).toEqual(['2026-10-14T12:00', '2026-10-14T13:00', '2026-10-14T15:00']);
    expect(setTime.mock.calls.every((c) => c[1]?.quiet)).toBe(true);
    expect(readout.textContent).toBe('readout 3');
    fire('pointerup', { pointerId: 7 });
    expect(setTime).toHaveBeenLastCalledWith('2026-10-14T15:00');
    // Moving without the pointer down does nothing.
    fire('pointermove', { clientX: 120 });
    expect(setTime).toHaveBeenCalledTimes(4);
  });

  it('jumps to the start of a block of the Use row when it is tapped, and ignores other presses', () => {
    const { root, fire } = page();
    const setTime = vi.fn();
    bind(root, { setTime, rerender: vi.fn() }, quiet);
    const segment = { dataset: { time: '2026-10-14T15:00', readout: 'Runway 24 favoured from 15:00' } };
    fire('pointerdown', { button: 0, pointerId: 1, clientX: 10, target: inTrack(segment) });
    expect(setTime).toHaveBeenCalledWith('2026-10-14T15:00', { quiet: true });
    fire('pointerup', { pointerId: 1 });
    setTime.mockClear();
    fire('pointerdown', { button: 0, clientX: 0, target: { closest: () => null } });
    fire('pointerdown', { button: 2, clientX: 0, target: inTrack() });
    fire('pointermove', { clientX: 300 });
    expect(setTime).not.toHaveBeenCalled();
  });

  it('sets the timeline from the keyboard (a click without a pointer), not from a mouse click already handled', () => {
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
    key('ArrowRight', 3);
    expect(hourEls.focused).toBe(hourEls[3]);
    key('Home', 3);
    expect(hourEls.focused).toBe(hourEls[0]);
    key('ArrowLeft', 0);
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

  it('is a part with the hooks the host calls', () => {
    expect(typeof runwayPart.bind).toBe('function');
    expect(typeof runwayPart.unbind).toBe('function');
    expect(runwayPart.needs).toContain('formatTick');
  });
});

describe('the hours as drawn', () => {
  it('finds the hour under a pixel, clamped to the strip', () => {
    expect(hourIndexAt(100, 100, 240, 24)).toBe(0);
    expect(hourIndexAt(109.9, 100, 240, 24)).toBe(0);
    expect(hourIndexAt(110, 100, 240, 24)).toBe(1);
    expect(hourIndexAt(339, 100, 240, 24)).toBe(23);
    expect(hourIndexAt(50, 100, 240, 24)).toBe(0);
    expect(hourIndexAt(900, 100, 240, 24)).toBe(23);
    expect(hourIndexAt(5, 0, 0, 24)).toBe(0);
  });

  const airport = toAirport(['XTST', 'TST', 'Test', 'Town', 'NL', 52, 4, 0, 1, 1, [['09', 90, '27', 270, 6000, 'ASP']]]);
  const t0 = Date.parse('2026-10-14T12:00:00Z');
  const times = Array.from({ length: 30 }, (_, i) => new Date(t0 + i * 3_600_000).toISOString().slice(0, 16));
  const outlookFor = (dir) =>
    runwayOutlook({
      airport,
      now: t0,
      limits: { crosswind: 25, tailwind: 10 },
      hourly: { time: times, wind_direction_10m: times.map((_, i) => dir(i)), wind_speed_10m: times.map(() => 12), wind_gusts_10m: times.map(() => 12) },
    });

  it('names the better end of a runway where it changes, only when the name fits', () => {
    // 12 kt from 270 for 10 hours (27 is better), then from 090 (09 is better) for the rest.
    const labels = endLabelCells(outlookFor((i) => (i < 10 ? 270 : 90)));
    expect([...labels].sort()).toEqual(['0:0', '0:10']);
    // A better end that holds for a single hour has no room for its name.
    expect(endLabelCells(outlookFor((i) => (i % 2 ? 90 : 270))).size).toBe(0);
  });

  it('labels an hour briefly for a screen reader, without the zone', () => {
    const outlook = outlookFor(() => 270);
    expect(hourLabel(outlook.hours[0], (t) => t.slice(11, 16))).toBe('12:00, favoured 27');
  });
});
