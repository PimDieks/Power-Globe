import { afterEach, describe, expect, it, vi } from 'vitest';
import { toAirport } from '../src/airports.js';
import { OPS_PARTS, createOpsHost } from '../src/ops.js';
import { MAP_PROFILES } from '../src/mapprofile.js';
import { mergeBusPasses } from '../api/worker.js';
import { OVAPI_TPC } from './ovapi-fixtures.js';
import { POLL_MS, RECHECK_MS, TIMEOUT_MS, accessPart, bind, forgetAccess, release, unbind, unwatch, watch } from '../src/opsaccessview.js';

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
  // The asks of each source; `asks` is those for the roads, which most of these tests are about.
  const bySource = { roads: [], trains: [], buses: [] };
  const fake = vi.fn((ident, signal, source) => {
    const call = { ident, signal, source };
    call.done = new Promise((resolve, reject) => Object.assign(call, { resolve, reject }));
    bySource[source].push(call);
    return call.done;
  });
  let clock = NOW;
  const deps = { ask: ask ?? fake, overlay, setTimer, clearTimer, setTimeout: setTimeoutFn, clearTimeout: vi.fn(), now: () => clock };
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
    asks: bySource.roads,
    trainAsks: bySource.trains,
    busAsks: bySource.buses,
    settle,
    deps,
    bind: () => bind(root, api, deps),
    watch: () => watch(api, deps),
    move: (next) => (current = next),
    advance: (ms) => (clock += ms),
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
    expect(t.analyse()).toMatchObject({ covered: true, loading: true });
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
    expect(t.analyse()).toMatchObject({ covered: true, loading: true });
  });

  it('does not take an error for the airport that was left as an error of the new one', async () => {
    const t = setup();
    t.bind();
    t.move(EHRD);
    t.analyse();
    t.asks[0].reject(new Error('answered 502'));
    await t.settle();
    expect(t.analyse()).toMatchObject({ covered: true, loading: true });
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
    // What was still being waited for is given up on.
    expect(t.trainAsks[0].signal.aborted).toBe(true);
    expect(t.busAsks[0].signal.aborted).toBe(true);
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

// What the API gives for the trains and the buses.
const busAnswer = () => ({ available: true, airport: 'EHAM', source: 'OVapi', fetched: NOW - 15_000, windowMinutes: 60, cancellations: 'reported', passes: mergeBusPasses([OVAPI_TPC], Date.parse('2026-10-14T19:59:30Z')) });
const trainAnswer = (over = {}) => ({
  available: true,
  airport: 'EHAM',
  source: 'NS',
  station: 'Schiphol Airport',
  fetched: NOW - 15_000,
  departures: [{ planned: NOW + 240_000, actual: NOW + 240_000, delayMin: 0, destination: 'Amsterdam Centraal', track: '1', plannedTrack: '1', cancelled: false, kind: 'SPR' }],
  disruptions: [],
  ...over,
});
const NO_KEY = { available: false, airport: 'EHAM', reason: 'needs an NS API key' };
const counts = (t) => [t.asks.length, t.trainAsks.length, t.busAsks.length];

describe('trains and buses', () => {
  it('are asked for next to the roads at Schiphol, and the roads alone at another Dutch airport', () => {
    const t = setup();
    t.bind();
    expect(counts(t)).toEqual([1, 1, 1]);
    expect(t.setTimer).toHaveBeenCalledTimes(1);
    forgetAccess();
    const rd = setup(EHRD);
    rd.bind();
    expect(counts(rd)).toEqual([1, 0, 0]);
    forgetAccess();
    const uk = setup(EGLL);
    uk.bind();
    expect(counts(uk)).toEqual([0, 0, 0]);
  });

  it('are asked for again every minute, none of them while an answer is awaited', async () => {
    const t = setup();
    t.bind();
    t.tick();
    expect(counts(t)).toEqual([1, 1, 1]);
    t.busAsks[0].resolve(busAnswer());
    await t.settle();
    t.tick();
    expect(counts(t)).toEqual([1, 1, 2]);
  });

  it('are drawn in the section as each answer comes, whatever the order, with the summary asked to redraw', async () => {
    const t = setup();
    t.bind();
    t.busAsks[0].resolve(busAnswer());
    await t.settle();
    expect(t.inner.innerHTML).toContain('Haarlem Station');
    expect(t.inner.innerHTML).toContain('Loading road data');
    expect(t.api.refreshSummary).toHaveBeenCalled();
    t.trainAsks[0].resolve(trainAnswer());
    await t.settle();
    expect(t.inner.innerHTML).toContain('Amsterdam Centraal');
    t.asks[0].resolve(answer());
    await t.settle();
    expect(t.inner.innerHTML).toContain('A4');
    expect(t.analyse()).toMatchObject({ trains: { departures: [expect.anything()] }, buses: { running: expect.any(Number) } });
  });

  it('say a missing NS key calmly, and are not asked for again for ten minutes', async () => {
    const t = setup();
    t.bind();
    t.trainAsks[0].resolve(NO_KEY);
    await t.settle();
    expect(t.inner.innerHTML).toContain('Train information needs an NS API key (set NS_API_KEY for the API).');
    t.advance(60_000);
    t.tick();
    expect(t.trainAsks).toHaveLength(1);
    t.advance(RECHECK_MS);
    t.tick();
    expect(t.trainAsks).toHaveLength(2);
  });

  it('fail on their own: a source that errors leaves the others as they were', async () => {
    const t = setup();
    t.bind();
    t.asks[0].resolve(answer());
    t.busAsks[0].resolve(busAnswer());
    t.trainAsks[0].reject(new Error('NS answered 401'));
    await t.settle();
    const html = t.inner.innerHTML;
    expect(html).toContain('Train times did not load (NS answered 401)');
    expect(html).toContain('A4');
    expect(html).toContain('Haarlem Station');
    // On the next poll the buses fail, and keep their last answer as the last.
    t.tick();
    t.busAsks[1].reject(new Error('answered 502'));
    await t.settle();
    expect(t.inner.innerHTML).toContain('The last update failed (answered 502)');
    expect(t.inner.innerHTML).toContain('Haarlem Station');
  });

  it('give up on an answer that takes more than 15 seconds, each on its own', () => {
    const t = setup();
    t.bind();
    expect(t.aborts.map((a) => a.ms)).toEqual([15_000, 15_000, 15_000]);
    t.aborts[1].fn();
    expect(t.trainAsks[0].signal.aborted).toBe(true);
    expect(t.busAsks[0].signal.aborted).toBe(false);
    expect(t.asks[0].signal.aborted).toBe(false);
  });

  it('are asked in the call the page makes: the route, the airport and a signal', async () => {
    const calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        calls.push(String(url));
        expect(init.signal).toBeDefined();
        return new Response(JSON.stringify({ available: false, reason: 'x' }));
      }),
    );
    const t = setup();
    // The real ask, through the API address the page is built with.
    const real = { ...t.deps };
    delete real.ask;
    watch(t.api, real);
    await t.settle();
    expect(calls.map((u) => u.replace(/^.*\/access\//, ''))).toEqual(['roads?airport=EHAM', 'trains?airport=EHAM', 'buses?airport=EHAM']);
  });

  it('stop with the roads: nothing in flight, and late answers draw nothing', async () => {
    const t = setup();
    t.bind();
    unbind();
    for (const list of [t.asks, t.trainAsks, t.busAsks]) expect(list[0].signal.aborted).toBe(true);
    t.busAsks[0].resolve(busAnswer());
    t.trainAsks[0].resolve(trainAnswer());
    await t.settle();
    expect(t.inner.innerHTML).toBe('');
    expect(t.api.refreshSummary).not.toHaveBeenCalled();
  });

  it('do not take the answers of the airport that was left for the new one', async () => {
    const t = setup();
    t.bind();
    t.move(EHRD);
    t.analyse();
    t.busAsks[0].resolve(busAnswer());
    t.trainAsks[0].resolve(trainAnswer());
    await t.settle();
    expect(t.analyse().buses).toEqual({ covered: false });
    // Back at Schiphol it asks again, from nothing.
    t.move(EHAM);
    expect(t.analyse()).toMatchObject({ trains: { loading: true }, buses: { loading: true } });
    expect(t.busAsks).toHaveLength(2);
  });

  it('wait while the page is hidden, and are all asked for at once when it is shown', () => {
    const listeners = new Map();
    const doc = { hidden: true, addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: (type) => listeners.delete(type) };
    vi.stubGlobal('document', doc);
    const t = setup();
    t.bind();
    t.tick();
    expect(counts(t)).toEqual([0, 0, 0]);
    doc.hidden = false;
    listeners.get('visibilitychange')();
    expect(counts(t)).toEqual([1, 1, 1]);
  });

  it('give the summary one fact from the roads, trains and buses, kept up to date with another tab shown', async () => {
    const t = setup();
    t.watch();
    expect(counts(t)).toEqual([1, 1, 1]);
    expect(t.overlay.show).not.toHaveBeenCalled();
    t.asks[0].resolve(answer('EHAM', 95));
    t.trainAsks[0].resolve(NO_KEY);
    t.busAsks[0].resolve(busAnswer());
    await t.settle();
    // Roads flowing is not given as the whole story: the buses are in it too, and the missing key is quiet.
    const fact = accessPart.fact(t.analyse());
    expect(fact.text).toMatch(/^Roads flowing; Bus|^Bus|Roads flowing/);
    expect(accessPart.factLabel).toBe('Access');
    // A slow stretch of the A4 comes first, and nothing is green over it.
    t.tick();
    t.asks[1].resolve(answer('EHAM', 30));
    await t.settle();
    expect(accessPart.fact(t.analyse())).toMatchObject({ status: 'caution' });
  });
});
