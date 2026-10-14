import { afterEach, describe, expect, it, vi } from 'vitest';
import { toAirport } from '../src/airports.js';
import { OPS_PARTS, createOpsHost } from '../src/ops.js';
import { MAP_PROFILES } from '../src/mapprofile.js';
import { POLL_MS, TIMEOUT_MS, accessPart, bind, forgetAccess, release, unbind, unwatch, watch } from '../src/opsaccessview.js';

const EHAM = toAirport(['EHAM', 'AMS', 'Amsterdam Airport Schiphol', 'Amsterdam', 'NL', 52.3086, 4.7639, -11, 1, 1, [], 248]);
const EHRD = toAirport(['EHRD', 'RTM', 'Rotterdam The Hague Airport', 'Rotterdam', 'NL', 51.9569, 4.4372, -15, 1, 1, [], 30]);
const EGLL = toAirport(['EGLL', 'LHR', 'London Heathrow Airport', 'London', 'GB', 51.4707, -0.4599, 83, 1, 1, [], 172]);
const NOW = Date.parse('2026-10-14T19:40:00Z');

// A slow stretch of the A4: three sites in a row at 30 km/h, with a busy road.
const answer = (airport = 'EHAM', speed = 30) => ({
  available: true,
  airport,
  fetched: NOW,
  measuredAt: NOW - 60_000,
  situationsAt: NOW - 60_000,
  radiusKm: 25,
  chains: [{ road: 'A4', side: 'r', pts: [[52.3, 4.8, speed, 900], [52.3045, 4.8, speed, 900], [52.309, 4.8, speed, 900], [52.3135, 4.8, 100, 900]] }],
  situations: [],
  limits: [],
  planned: 0,
});

// Just enough of the page: a root with the section, the summary line we ask to be drawn again, the
// map profile, and timers we turn by hand.
function setup(airport = EHAM, { profile = MAP_PROFILES.access, ask } = {}) {
  const inner = { innerHTML: '' };
  const root = { querySelector: (sel) => (sel === '.ops-access' ? inner : null) };
  let current = airport;
  let shown = profile;
  const api = { getContext: () => ({ airport: current, now: NOW }), refreshSummary: vi.fn(), mapProfile: () => shown };
  const overlay = { show: vi.fn(), hide: vi.fn() };
  const timers = [];
  // Like the browser's own, which throw when called as a method of another object.
  const plain = (self) => {
    if (self !== undefined) throw new TypeError('Illegal invocation');
  };
  const setTimer = vi.fn(function (fn, ms) {
    plain(this);
    return timers.push({ fn, ms });
  });
  const clearTimer = vi.fn(function () {
    plain(this);
  });
  const aborts = [];
  const setTimeoutFn = vi.fn((fn, ms) => aborts.push({ fn, ms }));
  const asks = [];
  const fake = vi.fn((ident, signal) => {
    const call = { ident, signal };
    call.done = new Promise((resolve, reject) => Object.assign(call, { resolve, reject }));
    asks.push(call);
    return call.done;
  });
  const deps = { ask: ask ?? fake, overlay, setTimer, clearTimer, setTimeout: setTimeoutFn, clearTimeout: vi.fn() };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    api,
    root,
    inner,
    overlay,
    timers,
    aborts,
    setTimer,
    clearTimer,
    asks,
    settle,
    deps,
    bind: () => bind(root, api, deps),
    watch: () => watch(api, deps),
    move: (next) => (current = next),
    profile: (next) => (shown = next),
    tick: () => timers.at(-1).fn(),
    analyse: () => accessPart.analyse({ airport: current, now: NOW }),
  };
}

afterEach(() => {
  forgetAccess();
  vi.unstubAllGlobals();
});

describe('asking while the Access tab is shown', () => {
  it('asks at once for a Dutch airport and then every minute, and draws the section, the summary and the roads', async () => {
    const t = setup();
    t.bind();
    expect(t.asks.map((a) => a.ident)).toEqual(['EHAM']);
    expect(t.setTimer.mock.calls[0][1]).toBe(POLL_MS);
    expect(POLL_MS).toBe(60_000);
    t.asks[0].resolve(answer());
    await t.settle();
    expect(t.inner.innerHTML).toContain('A4');
    expect(t.api.refreshSummary).toHaveBeenCalled();
    expect(t.overlay.show).toHaveBeenCalledTimes(1);
    expect(t.overlay.show.mock.calls[0][0].segments).toHaveLength(3);
    t.tick();
    expect(t.asks).toHaveLength(2);
    t.asks[1].resolve(answer('EHAM', 95));
    await t.settle();
    expect(t.overlay.show).toHaveBeenCalledTimes(2);
  });

  it('does not ask again while an answer is awaited', () => {
    const t = setup();
    t.bind();
    t.tick();
    t.tick();
    expect(t.asks).toHaveLength(1);
  });

  it('asks nothing for an airport that has no road data, and says so', () => {
    const t = setup(EGLL);
    t.bind();
    expect(t.asks).toHaveLength(0);
    expect(t.setTimer).not.toHaveBeenCalled();
    expect(t.overlay.show).not.toHaveBeenCalled();
    expect(t.analyse()).toEqual({ covered: false });
  });

  it('draws the roads on the map only while the map profile has them on', async () => {
    const t = setup(EHAM, { profile: MAP_PROFILES.weather });
    t.bind();
    t.asks[0].resolve(answer());
    await t.settle();
    expect(t.overlay.show).not.toHaveBeenCalled();
    t.profile(MAP_PROFILES.access);
    t.tick();
    t.asks[1].resolve(answer());
    await t.settle();
    expect(t.overlay.show).toHaveBeenCalledTimes(1);
  });

  it('stops when the tab goes: no timer, nothing in flight, nothing on the map, and a late answer draws nothing', async () => {
    const t = setup();
    t.bind();
    unbind();
    expect(t.clearTimer).toHaveBeenCalledTimes(1);
    expect(t.asks[0].signal.aborted).toBe(true);
    expect(t.overlay.hide).toHaveBeenCalled();
    t.asks[0].resolve(answer());
    await t.settle();
    expect(t.inner.innerHTML).toBe('');
    expect(t.overlay.show).not.toHaveBeenCalled();
    expect(() => unbind()).not.toThrow();
  });

  it('moves to the airport that is opened, and stops at one without road data, taking the map clean', async () => {
    const t = setup();
    t.bind();
    t.asks[0].resolve(answer());
    await t.settle();
    t.move(EHRD);
    expect(t.analyse()).toEqual({ covered: true, loading: true });
    expect(t.asks.map((a) => a.ident)).toEqual(['EHAM', 'EHRD']);
    expect(t.clearTimer).toHaveBeenCalledTimes(1);
    expect(t.setTimer).toHaveBeenCalledTimes(2);
    expect(t.overlay.hide).toHaveBeenCalled();
    t.asks[1].resolve(answer('EHRD'));
    await t.settle();
    expect(t.analyse()).toMatchObject({ data: { airport: 'EHRD' } });
    t.move(EGLL);
    expect(t.analyse()).toEqual({ covered: false });
    expect(t.asks).toHaveLength(2);
    expect(t.clearTimer).toHaveBeenCalledTimes(2);
  });

  it('does not use an answer that comes after the airport was changed', async () => {
    const t = setup();
    t.bind();
    t.move(EHRD);
    t.analyse();
    t.asks[0].resolve(answer('EHAM'));
    await t.settle();
    expect(t.analyse()).toEqual({ covered: true, loading: true });
  });

  it('does not take an error for the airport that was left as an error of the new one', async () => {
    const t = setup();
    t.bind();
    t.move(EHRD);
    t.analyse();
    t.asks[0].reject(new Error('answered 502'));
    await t.settle();
    expect(t.analyse()).toEqual({ covered: true, loading: true });
    t.asks[1].resolve(answer('EHRD'));
    await t.settle();
    expect(t.analyse()).toMatchObject({ data: { airport: 'EHRD' } });
  });

  it('lets go of the airport at once when another is being opened', async () => {
    const t = setup();
    t.bind();
    t.asks[0].resolve(answer());
    await t.settle();
    release();
    expect(t.asks[0].signal.aborted).toBe(true);
    expect(t.clearTimer).toHaveBeenCalled();
    expect(t.overlay.hide).toHaveBeenCalled();
    // Opened again, it asks again.
    t.analyse();
    expect(t.asks).toHaveLength(2);
  });
});

describe('asking for the summary line with another tab shown', () => {
  it('asks and keeps the fact up to date, drawing nothing on the map or in a section', async () => {
    const t = setup();
    t.watch();
    expect(t.asks.map((a) => a.ident)).toEqual(['EHAM']);
    t.asks[0].resolve(answer());
    await t.settle();
    expect(t.api.refreshSummary).toHaveBeenCalled();
    expect(t.overlay.show).not.toHaveBeenCalled();
    expect(t.inner.innerHTML).toBe('');
    expect(t.analyse()).toMatchObject({ data: { airport: 'EHAM' }, covered: true });
  });

  it('goes on when the tab is shown, and keeps going when it goes while the summary still watches', async () => {
    const t = setup();
    t.watch();
    t.asks[0].resolve(answer());
    await t.settle();
    t.bind();
    // What the watch found is drawn at once, and nothing is asked for again.
    expect(t.asks).toHaveLength(1);
    expect(t.inner.innerHTML).toContain('A4');
    expect(t.overlay.show).toHaveBeenCalledTimes(1);
    unbind();
    expect(t.overlay.hide).toHaveBeenCalled();
    expect(t.clearTimer).not.toHaveBeenCalled();
    t.tick();
    expect(t.asks).toHaveLength(2);
    unwatch();
    expect(t.clearTimer).toHaveBeenCalledTimes(1);
  });

  it('ends with the tab if nothing else watches, and with the summary if the tab is not shown', () => {
    const t = setup();
    t.bind();
    unwatch();
    expect(t.clearTimer).not.toHaveBeenCalled();
    unbind();
    expect(t.clearTimer).toHaveBeenCalledTimes(1);
    const w = setup();
    w.watch();
    unwatch();
    expect(w.clearTimer).toHaveBeenCalledTimes(1);
  });
});

describe('the page being hidden', () => {
  function hiddenPage() {
    const listeners = new Map();
    const doc = { hidden: false, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type) };
    vi.stubGlobal('document', doc);
    return { doc, show: () => listeners.get('visibilitychange')?.(), hasListener: () => listeners.has('visibilitychange') };
  }

  it('asks nothing while it is hidden, and asks at once when it is shown again', async () => {
    const page = hiddenPage();
    const t = setup();
    t.bind();
    t.asks[0].resolve(answer());
    await t.settle();
    page.doc.hidden = true;
    page.show();
    t.tick();
    t.tick();
    expect(t.asks).toHaveLength(1);
    page.doc.hidden = false;
    page.show();
    expect(t.asks).toHaveLength(2);
  });

  it('starts hidden without asking, and asks when it is first shown', () => {
    const page = hiddenPage();
    page.doc.hidden = true;
    const t = setup();
    t.bind();
    expect(t.asks).toHaveLength(0);
    page.doc.hidden = false;
    page.show();
    expect(t.asks).toHaveLength(1);
  });

  it('stops listening when the part ends', () => {
    const page = hiddenPage();
    const t = setup();
    t.bind();
    expect(page.hasListener()).toBe(true);
    unbind();
    expect(page.hasListener()).toBe(false);
  });
});

describe('when the API cannot give the data', () => {
  it('shows what the API says of an airport it has nothing for, and takes the map clean', async () => {
    const t = setup();
    t.bind();
    t.asks[0].resolve({ available: false, airport: 'EHAM', reason: "The relay's road job is switched off (NDW=1 in its settings)" });
    await t.settle();
    expect(t.inner.innerHTML).toContain('road job is switched off');
    expect(t.api.refreshSummary).toHaveBeenCalled();
    expect(t.overlay.show).not.toHaveBeenCalled();
    expect(t.overlay.hide).toHaveBeenCalled();
  });

  it('says a first failure, and on later ones keeps the last answer as the last', async () => {
    const t = setup();
    t.bind();
    t.asks[0].reject(new Error('The relay is unreachable (down)'));
    await t.settle();
    expect(t.inner.innerHTML).toContain('did not load (The relay is unreachable (down))');
    t.tick();
    t.asks[1].resolve(answer());
    await t.settle();
    expect(t.inner.innerHTML).toContain('A4');
    t.tick();
    t.asks[2].reject(new Error('answered 502'));
    await t.settle();
    expect(t.inner.innerHTML).toContain('The last update failed (answered 502)');
    expect(t.overlay.show).toHaveBeenCalledTimes(2);
  });

  it('gives up on an answer that takes more than 15 seconds', async () => {
    expect(TIMEOUT_MS).toBe(15_000);
    const t = setup();
    t.bind();
    expect(t.aborts[0].ms).toBe(15_000);
    t.aborts[0].fn();
    expect(t.asks[0].signal.aborted).toBe(true);
    t.asks[0].reject(new Error('aborted'));
    await t.settle();
    expect(t.inner.innerHTML).toContain('it took too long');
  });

  it('does not draw old data on the map, as the roads now', async () => {
    const t = setup();
    t.bind();
    t.asks[0].resolve({ ...answer(), measuredAt: NOW - 30 * 60_000 });
    await t.settle();
    expect(t.overlay.show).not.toHaveBeenCalled();
    expect(t.overlay.hide).toHaveBeenCalled();
    expect(t.inner.innerHTML).toContain('There is no recent speed data');
  });
});

describe('in the panel', () => {
  it('is bound when the Access tab is shown and watched when another is', () => {
    const modes = [];
    const part = { ...accessPart, bind: () => modes.push('bind'), unbind: () => modes.push('unbind'), watch: () => modes.push('watch'), unwatch: () => modes.push('unwatch') };
    const root = { addEventListener() {}, removeEventListener() {}, contains: () => false };
    const host = createOpsHost({ root, summaryRoot: null, getContext: () => ({}), requestRender() {}, setTime() {}, selectTab() {}, parts: [part], setTimer: () => 1, clearTimer() {} });
    host.show('access');
    host.show('weather');
    host.stop();
    expect(OPS_PARTS.find((p) => p.id === 'access')).toBe(accessPart);
    expect(modes).toEqual(['bind', 'watch', 'unbind', 'unwatch']);
  });
});
