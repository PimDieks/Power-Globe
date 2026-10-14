import { afterEach, describe, expect, it, vi } from 'vitest';
import { toAirport } from '../src/airports.js';
import { POLL_MS, accessPart, bind, releaseAccess, unbind } from '../src/opsaccessview.js';

const EHAM = toAirport(['EHAM', 'AMS', 'Amsterdam Airport Schiphol', 'Amsterdam', 'NL', 52.3086, 4.7639, -11, 1, 1, [], 248]);
const EHRD = toAirport(['EHRD', 'RTM', 'Rotterdam The Hague Airport', 'Rotterdam', 'NL', 51.9569, 4.4372, -15, 1, 1, [], 30]);
const EGLL = toAirport(['EGLL', 'LHR', 'London Heathrow Airport', 'London', 'GB', 51.4707, -0.4599, 83, 1, 1, [], 172]);
const NOW = Date.parse('2026-10-14T17:30:00Z');

const answer = (airport = 'EHAM', speed = 30) => ({
  available: true,
  airport,
  fetched: NOW,
  measuredAt: NOW - 60_000,
  groups: [['A4', 'S']],
  sites: [[52.3, 4.8, speed, 600, 0], [52.31, 4.8, 100, 600, 0]],
  situations: [],
});

// Just enough of the page: a root with the section and the strip item, and a timer we turn by hand.
function setup(airport = EHAM, ask) {
  const inner = { innerHTML: '' };
  const item = { outerHTML: '' };
  const root = {
    querySelector: (sel) => (sel === '.ops-access' ? inner : sel === '.ops-strip li[data-part="access"]' ? item : null),
  };
  let current = airport;
  const api = { getContext: () => ({ airport: current, now: NOW }) };
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
  const asks = [];
  const fake = vi.fn((ident, signal) => {
    const call = { ident, signal };
    call.done = new Promise((resolve, reject) => Object.assign(call, { resolve, reject }));
    asks.push(call);
    return call.done;
  });
  bind(root, api, { ask: ask ?? fake, overlay, setTimer, clearTimer });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { inner, item, overlay, timers, setTimer, clearTimer, asks, settle, move: (next) => (current = next), tick: () => timers.at(-1).fn(), analyse: () => accessPart.analyse({ airport: current, now: NOW }) };
}

afterEach(() => unbind());

describe('asking while the Ops tab is open', () => {
  it('asks at once for a Dutch airport and then every minute, and draws the section, the fact and the map', async () => {
    const { asks, inner, item, overlay, setTimer, settle, tick } = setup();
    expect(asks.map((a) => a.ident)).toEqual(['EHAM']);
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(setTimer.mock.calls[0][1]).toBe(POLL_MS);
    expect(POLL_MS).toBe(60_000);
    asks[0].resolve(answer());
    await settle();
    expect(inner.innerHTML).toContain('A4 southbound');
    expect(item.outerHTML).toContain('A4 southbound slow, 30 km/h');
    expect(overlay.show).toHaveBeenCalledTimes(1);
    expect(overlay.show.mock.calls[0][0].dots).toHaveLength(2);
    tick();
    expect(asks).toHaveLength(2);
    asks[1].resolve(answer('EHAM', 90));
    await settle();
    expect(item.outerHTML).toContain('Roads flowing');
    expect(overlay.show).toHaveBeenCalledTimes(2);
  });

  it('does not ask again while an answer is awaited', () => {
    const { asks, tick } = setup();
    tick();
    tick();
    expect(asks).toHaveLength(1);
  });

  it('asks nothing for an airport that has no road data, and says so', () => {
    const { asks, setTimer, overlay, analyse } = setup(EGLL);
    expect(asks).toHaveLength(0);
    expect(setTimer).not.toHaveBeenCalled();
    expect(overlay.show).not.toHaveBeenCalled();
    expect(analyse()).toEqual({ covered: false });
  });

  it('stops when the tab goes: no timer, nothing in flight, nothing on the map, and a late answer draws nothing', async () => {
    const { asks, clearTimer, overlay, inner, settle } = setup();
    unbind();
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(asks[0].signal.aborted).toBe(true);
    expect(overlay.hide).toHaveBeenCalled();
    asks[0].resolve(answer());
    await settle();
    expect(inner.innerHTML).toBe('');
    expect(overlay.show).not.toHaveBeenCalled();
    // Unbinding twice, or without having bound, is harmless.
    expect(() => unbind()).not.toThrow();
  });

  it('moves to the airport that is opened, and stops at one without road data, taking the map clean', async () => {
    const { asks, setTimer, clearTimer, overlay, move, analyse, settle } = setup();
    asks[0].resolve(answer());
    await settle();
    move(EHRD);
    expect(analyse()).toEqual({ covered: true, loading: true });
    expect(asks.map((a) => a.ident)).toEqual(['EHAM', 'EHRD']);
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(setTimer).toHaveBeenCalledTimes(2);
    expect(overlay.hide).toHaveBeenCalled();
    // The answer for the airport left is not drawn for the new one.
    asks[1].resolve(answer('EHRD'));
    await settle();
    expect(analyse()).toMatchObject({ data: { airport: 'EHRD' } });
    move(EGLL);
    expect(analyse()).toEqual({ covered: false });
    expect(asks).toHaveLength(2);
    expect(clearTimer).toHaveBeenCalledTimes(2);
    expect(overlay.hide).toHaveBeenCalled();
  });

  it('does not use an answer that comes after the airport was changed', async () => {
    const { asks, move, analyse, settle } = setup();
    move(EHRD);
    analyse();
    asks[0].resolve(answer('EHAM'));
    await settle();
    expect(analyse()).toEqual({ covered: true, loading: true });
  });

  it('lets go of the airport at once when another is being opened', async () => {
    const { asks, clearTimer, overlay, settle, analyse } = setup();
    asks[0].resolve(answer());
    await settle();
    releaseAccess();
    expect(asks[0].signal.aborted).toBe(true);
    expect(clearTimer).toHaveBeenCalled();
    expect(overlay.hide).toHaveBeenCalled();
    // Opened again, it asks again.
    analyse();
    expect(asks).toHaveLength(2);
  });
});

describe('when the API cannot give the data', () => {
  it('shows what the API says of an airport it has nothing for, and takes the map clean', async () => {
    const { asks, inner, item, overlay, settle } = setup();
    asks[0].resolve({ available: false, airport: 'EHAM', reason: "The relay's road job is switched off (NDW=1 in its settings)" });
    await settle();
    expect(inner.innerHTML).toContain("road job is switched off");
    expect(item.outerHTML).toContain('No road data');
    expect(overlay.show).not.toHaveBeenCalled();
    expect(overlay.hide).toHaveBeenCalled();
  });

  it('says a first failure, and on later ones keeps the last answer as the last', async () => {
    const { asks, inner, item, overlay, settle, tick } = setup();
    asks[0].reject(new Error('The relay is unreachable (down)'));
    await settle();
    expect(inner.innerHTML).toContain('did not load (The relay is unreachable (down))');
    expect(item.outerHTML).toContain('Road data unavailable');
    tick();
    asks[1].resolve(answer());
    await settle();
    expect(item.outerHTML).toContain('A4 southbound slow');
    tick();
    asks[2].reject(new Error('answered 502'));
    await settle();
    expect(inner.innerHTML).toContain('The last update failed (answered 502)');
    expect(item.outerHTML).toContain('A4 southbound slow');
    expect(overlay.show).toHaveBeenCalledTimes(2);
  });

  it('gives up on an answer that takes too long', async () => {
    vi.useFakeTimers();
    try {
      const { asks, inner } = setup();
      vi.advanceTimersByTime(15_000);
      expect(asks[0].signal.aborted).toBe(true);
      asks[0].reject(new Error('aborted'));
      await vi.advanceTimersByTimeAsync(0);
      expect(inner.innerHTML).toContain('it took too long');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not draw old data on the map, as the roads now', async () => {
    const { asks, overlay, settle } = setup();
    asks[0].resolve({ ...answer(), measuredAt: NOW - 30 * 60_000 });
    await settle();
    expect(overlay.show).not.toHaveBeenCalled();
    expect(overlay.hide).toHaveBeenCalled();
  });
});
