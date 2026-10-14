import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANIMATION_MAX_TILES,
  AREA_DEG,
  Backoff,
  LOOP_FRAME_MS,
  LOOP_HOLD_MS,
  coarserView,
  loopFrames,
  loopStep,
  loopStatus,
  MAX_ATTEMPTS,
  TileStore,
  frameFor,
  framesFor,
  parseTimes,
  passedFrames,
  satelliteAngle,
  tileAngle,
  tileBbox,
  tileBounds,
  tileUrl,
  tilesInView,
} from '../src/meteosat.js';

const HALF = 20037508.342789244;
const MIN = 60_000;
const at = (iso) => Date.parse(iso);
const TIMES = { start: at('2024-09-23T00:00:00Z'), end: at('2026-10-14T06:30:00Z'), step: 10 * MIN };

describe('tile maths', () => {
  it('gives each tile its Web Mercator bounds', () => {
    expect(tileBbox(0, 0, 0)).toEqual([-HALF, -HALF, HALF, HALF]);
    expect(tileBbox(1, 0, 1)).toEqual([0, 0, HALF, HALF]);
    const [minX, minY, maxX, maxY] = tileBbox(8, 5, 4);
    expect(minX).toBeCloseTo(0, 6);
    expect(maxX).toBeCloseTo(HALF / 8, 6);
    expect(maxY).toBeCloseTo(HALF - (5 * HALF) / 8, 6);
    expect(maxY - minY).toBeCloseTo(HALF / 8, 6);
  });

  it('gives the edges in degrees, Mercator latitudes included', () => {
    const b = tileBounds(0, 0, 0);
    expect(b.west).toBe(-180);
    expect(b.east).toBe(180);
    expect(b.north).toBeCloseTo(85.0511, 3);
    expect(b.south).toBeCloseTo(-85.0511, 3);
    expect(tileBounds(1, 1, 1).north).toBeCloseTo(0, 9);
    expect(tileBounds(2, 1, 2).south).toBeCloseTo(0, 9);
    expect(tileBounds(2, 1, 2).north).toBeCloseTo(66.5133, 3);
  });

  it('measures angles from the point beneath the satellite', () => {
    expect(satelliteAngle(0, 0)).toBe(0);
    expect(satelliteAngle(0, 45)).toBeCloseTo(45, 9);
    expect(satelliteAngle(-30, 0)).toBeCloseTo(30, 9);
    // The tile holding that point, and one entirely north-east of it.
    expect(tileAngle(2, 1, 2)).toBe(0);
    expect(tileAngle(9, 5, 4)).toBeCloseTo(satelliteAngle(tileBounds(9, 5, 4).south, 22.5), 9);
  });

  it('takes tiles over Europe and Africa and leaves out the Americas and Asia', () => {
    const all = () => true;
    const tiles = tilesInView(3, all).map(({ x, y }) => `${x}/${y}`);
    // Level 3: 45° columns. Western Europe and Africa in, Siberia and the Pacific out.
    expect(tiles).toContain('3/2');
    expect(tiles).toContain('4/4');
    expect(tiles).not.toContain('0/3');
    expect(tiles).not.toContain('7/3');
    for (const t of tilesInView(3, all)) expect(tileAngle(t.x, t.y, 3)).toBeLessThan(AREA_DEG);
  });

  it('only takes tiles with some part in view', () => {
    // Only a small patch around Paris is in view.
    const inView = (lat, lng) => lat > 45 && lat < 52 && lng > -1 && lng < 6;
    expect(tilesInView(4, inView)).toEqual([{ x: 7, y: 5 }, { x: 8, y: 5 }]);
    expect(tilesInView(4, () => false)).toEqual([]);
  });
});

describe('image times', () => {
  const xml = `<Layer><Name>rgb_geocolour</Name>
    <Dimension name="time" default="2026-10-14T06:30:00Z" units="ISO8601" nearestValue="1">2024-09-23T00:00:00.000Z/2026-10-14T06:30:00.000Z/PT10M</Dimension></Layer>`;

  it('reads the range and step from the capabilities', () => {
    expect(parseTimes(xml)).toEqual(TIMES);
    expect(parseTimes(xml.replace('PT10M', 'PT1H'))?.step).toBe(60 * MIN);
    expect(parseTimes('<Layer/>')).toBeNull();
    expect(parseTimes(xml.replace('/PT10M', ''))).toBeNull();
  });

  it('rounds to the nearest image', () => {
    expect(frameFor(at('2026-10-14T03:04:59Z'), TIMES)).toBe(at('2026-10-14T03:00:00Z'));
    expect(frameFor(at('2026-10-14T03:05:00Z'), TIMES)).toBe(at('2026-10-14T03:10:00Z'));
    expect(frameFor(at('2026-10-14T03:00:00Z'), TIMES)).toBe(at('2026-10-14T03:00:00Z'));
  });

  it('keeps to the range the service has, which refuses times outside it', () => {
    expect(frameFor(at('2026-10-16T12:00:00Z'), TIMES)).toBe(TIMES.end);
    expect(frameFor(at('2020-01-01T00:00:00Z'), TIMES)).toBe(TIMES.start);
  });

  it('asks for the frames ahead without repeats, none at all in the forecast part', () => {
    const t = at('2026-10-14T00:00:00Z');
    expect(framesFor(t, [t + 180 * MIN, t + 360 * MIN], TIMES)).toEqual([t, t + 180 * MIN, t + 360 * MIN]);
    expect(framesFor(at('2026-10-14T09:00:00Z'), [at('2026-10-14T12:00:00Z')], TIMES)).toEqual([TIMES.end]);
    expect(framesFor(t + 360 * MIN, [t + 540 * MIN], TIMES)).toEqual([t + 360 * MIN, TIMES.end]);
  });

  it('keeps at most two passed frames, between the one on show and the wanted one', () => {
    expect(passedFrames([1, 2, 3, 4, 5], 5, 1)).toEqual([4, 3]);
    expect(passedFrames([3, 3, 2], 5, null)).toEqual([3, 2]);
    // Going back, as when the timeline starts again, nothing is in between.
    expect(passedFrames([4, 5], 1, 5)).toEqual([]);
  });

  it('builds a GetMap request for the tile and time', () => {
    const url = new URL(tileUrl(8, 5, 4, at('2026-10-14T06:30:00Z')));
    expect(url.origin + url.pathname).toBe('https://view.eumetsat.int/geoserver/ows');
    const p = url.searchParams;
    expect(p.get('request')).toBe('GetMap');
    expect(p.get('layers')).toBe('mtg_fd:rgb_geocolour');
    expect(p.get('crs')).toBe('EPSG:3857');
    expect(p.get('bbox').split(',').map(Number)).toEqual(tileBbox(8, 5, 4));
    expect(p.get('width')).toBe('512');
    expect(p.get('format')).toBe('image/jpeg');
    expect(p.get('time')).toBe('2026-10-14T06:30:00Z');
  });
});

describe('Backoff', () => {
  it('waits longer after each failure once the last pause is over, up to a limit, and not at all after a success', () => {
    const b = new Backoff({ first: 5000, max: 20_000 });
    expect(b.wait(0)).toBe(0);
    b.fail(0);
    expect(b.wait(0)).toBe(5000);
    // During the pause, failures do not lengthen it.
    b.fail(1000);
    expect(b.wait(0)).toBe(5000);
    b.fail(5000);
    expect(b.wait(5000)).toBe(10_000);
    b.fail(15_000);
    b.fail(35_000);
    expect(b.wait(35_000)).toBe(20_000);
    expect(b.wait(50_000)).toBe(5000);
    b.succeed();
    expect(b.wait(0)).toBe(0);
  });
});

describe('TileStore', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const jobs = (keys) => keys.map((key) => ({ key, url: `u:${key}` }));
  const flush = () => vi.advanceTimersByTimeAsync(0);

  // A load that waits until told to answer.
  function pending() {
    const calls = [];
    const load = vi.fn((url) => new Promise((resolve, reject) => calls.push({ url, resolve, reject })));
    return { load, calls };
  }

  it('loads at most a few at once, most urgent first', async () => {
    vi.useFakeTimers();
    const { load, calls } = pending();
    const store = new TileStore({ load, concurrency: 2 });
    store.want(jobs(['a', 'b', 'c']));
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['u:a', 'u:b']);
    calls[0].resolve('A');
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['u:a', 'u:b', 'u:c']);
    expect(store.get('a')).toMatchObject({ state: 'done', value: 'A' });
    expect(store.get('c').state).toBe('loading');
  });

  it('drops queued tiles that are no longer wanted and asks once for each tile', async () => {
    vi.useFakeTimers();
    const { load, calls } = pending();
    const store = new TileStore({ load, concurrency: 1 });
    store.want(jobs(['a', 'b', 'c']));
    store.want(jobs(['a', 'd']));
    await flush();
    calls[0].resolve('A');
    await flush();
    store.want(jobs(['a', 'd']));
    calls[1].resolve('D');
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['u:a', 'u:d']);
  });

  it('keeps a bounded number, never dropping wanted ones or those in use', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const store = new TileStore({ load: async (url) => url, max: 3, concurrency: 10, inUse: (key) => key === 'k0', dispose });
    for (let i = 0; i < 10; i++) {
      store.want(jobs([`k${i}`]));
      await flush();
    }
    expect(store.entries.size).toBe(3);
    expect(store.get('k0')?.state).toBe('done');
    expect(store.get('k9')?.state).toBe('done');
    expect(dispose).toHaveBeenCalledTimes(7);
  });

  it('pauses after a failure and asks for the failed tile again only after the pause', async () => {
    vi.useFakeTimers();
    let fail = true;
    const load = vi.fn(async (url) => {
      if (fail) throw new Error('refused');
      return url;
    });
    const onSettle = vi.fn();
    const store = new TileStore({ load, concurrency: 1, backoff: new Backoff({ first: 5000 }), onSettle });
    store.want(jobs(['a', 'b']));
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    expect(store.get('a')).toMatchObject({ state: 'failed', failures: 1 });
    // Asking again straight away does not send anything during the pause.
    store.want(jobs(['a', 'b']));
    await vi.advanceTimersByTimeAsync(4900);
    expect(load).toHaveBeenCalledTimes(1);
    fail = false;
    // After the pause the owner is told, and asks again.
    onSettle.mockImplementation(() => store.want(jobs(['a', 'b'])));
    await vi.advanceTimersByTimeAsync(200);
    expect(load.mock.calls.map(([url]) => url)).toEqual(['u:a', 'u:a', 'u:b']);
    expect(store.get('a')).toMatchObject({ state: 'done', failures: 1 });
    expect(store.get('b').state).toBe('done');
  });

  it('sends nothing while EUMETSAT keeps failing, beyond one request per pause', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => {
      throw new Error('down');
    });
    let store;
    const onSettle = () => store.want(jobs(['a', 'b', 'c', 'd']));
    store = new TileStore({ load, concurrency: 4, backoff: new Backoff({ first: 5000, max: 120_000 }), onSettle });
    store.want(jobs(['a', 'b', 'c', 'd']));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Four at first, then one per pause as it doubles to two minutes (5, 10, 20, 40, 80, 120, 120
    // and 120 seconds fit in ten minutes).
    expect(load.mock.calls.length).toBeLessThanOrEqual(4 + 8);
  });

  it('stops asking once nothing is wanted', async () => {
    vi.useFakeTimers();
    const { load } = pending();
    const store = new TileStore({ load, concurrency: 1 });
    store.want(jobs(['a', 'b', 'c']));
    store.clear();
    await flush();
    store.want([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not lengthen the pause for failures sent together with the first', async () => {
    vi.useFakeTimers();
    const backoff = new Backoff({ first: 5000, max: 120_000 });
    const load = vi.fn(async () => {
      throw new Error('blip');
    });
    const store = new TileStore({ load, concurrency: 6, backoff });
    store.want(jobs(['a', 'b', 'c', 'd', 'e', 'f']));
    await flush();
    expect(load).toHaveBeenCalledTimes(6);
    expect(backoff.delay).toBe(5000);
    // A failure after the pause has ended does lengthen it.
    backoff.fail(Date.now() + 6000);
    expect(backoff.delay).toBe(10_000);
  });

  it('wakes at the earliest time asked for, not the first', async () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();
    const store = new TileStore({ load: async () => 'x', onSettle });
    store.wake(120_000);
    store.wake(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onSettle).toHaveBeenCalledTimes(1);
    // And a later time does not put off an earlier one.
    store.wake(5000);
    store.wake(60_000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onSettle).toHaveBeenCalledTimes(2);
  });

  it('asks again soon after a short pause even when a long one was arranged before', async () => {
    vi.useFakeTimers();
    const now = () => Date.now();
    const load = vi.fn(async (url) => url);
    const onSettle = vi.fn();
    const store = new TileStore({ load, onSettle, now });
    // A tile due again in two minutes arranges a wake-up then.
    store.entries.set('old', { state: 'failed', failures: 1, retryAt: now() + 120_000, value: null });
    store.want(jobs(['old']));
    // A back-off of five seconds after that must not wait the two minutes.
    store.backoff.fail(now());
    store.want(jobs(['old', 'new']));
    await vi.advanceTimersByTimeAsync(5000);
    expect(load.mock.calls.map(([url]) => url)).toEqual(['u:new']);
  });

  it('asks once for a tile named twice, and not again while it loads', async () => {
    vi.useFakeTimers();
    const { load, calls } = pending();
    const store = new TileStore({ load, concurrency: 6 });
    store.want(jobs(['a', 'a', 'b']));
    await flush();
    store.want(jobs(['a', 'b', 'a']));
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['u:a', 'u:b']);
    calls[0].resolve('A');
    await flush();
    store.want(jobs(['a']));
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not start a queued tile that another call started meanwhile', async () => {
    vi.useFakeTimers();
    const { load, calls } = pending();
    const store = new TileStore({ load, concurrency: 1 });
    store.want(jobs(['a', 'b']));
    await flush();
    // 'b' waits in the queue; it is then started directly and the queue still names it.
    store.start({ key: 'b', url: 'u:b' });
    await flush();
    calls[1].resolve('B');
    await flush();
    calls[0].resolve('A');
    await flush();
    expect(calls.map((c) => c.url)).toEqual(['u:a', 'u:b']);
  });

  it(`gives up on a tile after ${MAX_ATTEMPTS} failed attempts`, async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => {
      throw new Error('broken tile');
    });
    const store = new TileStore({ load, backoff: new Backoff({ first: 1000, max: 1000 }) });
    // Other tiles settling ask for it again and again.
    for (let i = 0; i < 600; i++) {
      store.want(jobs(['bad']));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(load).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(store.get('bad')).toMatchObject({ state: 'failed', failures: MAX_ATTEMPTS });
  });

  it('keeps wanted tiles beyond the bound', async () => {
    vi.useFakeTimers();
    const store = new TileStore({ load: async (url) => url, max: 2, concurrency: 10 });
    store.want(jobs(['a', 'b', 'c', 'd']));
    await flush();
    expect(store.entries.size).toBe(4);
    for (const key of ['a', 'b', 'c', 'd']) expect(store.get(key).state).toBe('done');
    // Once no longer wanted they go, down to the bound.
    store.want(jobs(['e']));
    await flush();
    expect(store.entries.size).toBe(2);
  });

  it('does not ask for a failed tile before its own pause has passed, even after a success', async () => {
    vi.useFakeTimers();
    let fail = true;
    const load = vi.fn(async (url) => {
      if (fail && url === 'u:a') throw new Error('refused');
      return url;
    });
    const store = new TileStore({ load, concurrency: 1, backoff: new Backoff({ first: 5000 }) });
    store.want(jobs(['a']));
    await flush();
    // Another tile loads after the pause, which ends the back-off.
    await vi.advanceTimersByTimeAsync(5000);
    store.entries.get('a').retryAt = Date.now() + 30_000;
    store.want(jobs(['b']));
    await flush();
    expect(store.backoff.delay).toBe(0);
    fail = false;
    store.want(jobs(['a']));
    await flush();
    expect(load.mock.calls.map(([url]) => url)).toEqual(['u:a', 'u:b']);
    await vi.advanceTimersByTimeAsync(30_000);
    store.want(jobs(['a']));
    await flush();
    expect(load.mock.calls.map(([url]) => url)).toEqual(['u:a', 'u:b', 'u:a']);
  });

  it('drops tiles beyond a lowered bound as soon as they are no longer wanted', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const store = new TileStore({ load: async (url) => url, max: 10, concurrency: 10, dispose });
    store.want(jobs(['a', 'b', 'c', 'd', 'e', 'f']));
    await flush();
    store.max = 2;
    store.evict();
    // Still wanted: all kept.
    expect(store.entries.size).toBe(6);
    // Wanted no more, with nothing new to load: down to the bound at once.
    store.want(jobs(['f']));
    expect(store.entries.size).toBe(2);
    expect(store.get('f').state).toBe('done');
    expect(dispose).toHaveBeenCalledTimes(4);
  });

  it('lets go of every loaded image when cleared, but not of those loading', async () => {
    vi.useFakeTimers();
    const dispose = vi.fn();
    const { load, calls } = pending();
    const store = new TileStore({ load, concurrency: 6, dispose });
    store.want(jobs(['a', 'b', 'c']));
    await flush();
    calls[0].resolve('A');
    calls[1].resolve('B');
    await flush();
    store.clear();
    expect([...store.entries.keys()]).toEqual(['c']);
    expect(dispose.mock.calls.map(([v]) => v).sort()).toEqual(['A', 'B']);
  });
});

describe('animation tiles', () => {
  it('takes the finest level with at most a few tiles in view', () => {
    // Europe at about 0.7 globe radii up: much of a quarter of the globe.
    const inView = (lat, lng) => lat > 25 && lat < 70 && lng > -20 && lng < 40;
    const still = tilesInView(4, inView).length;
    const coarse = coarserView(4, inView);
    expect(still).toBeGreaterThan(ANIMATION_MAX_TILES);
    expect(coarse.tiles.length).toBeLessThanOrEqual(ANIMATION_MAX_TILES);
    expect(coarse.level).toBe(3);
    expect(coarse.tiles).toEqual(tilesInView(3, inView));
    // Few enough already: the same tiles.
    expect(coarserView(2, inView)).toEqual({ level: 2, tiles: tilesInView(2, inView) });
    expect(coarserView(1, () => true, 0).level).toBe(0);
  });
});

describe('the clouds loop', () => {
  it('takes the last 12 hours every half hour, oldest first, from the newest half hour', () => {
    const frames = loopFrames(TIMES);
    expect(frames).toHaveLength(25);
    expect(frames.at(-1)).toBe(at('2026-10-14T06:30:00Z'));
    expect(frames[0]).toBe(at('2026-10-13T18:30:00Z'));
    expect(frames[1] - frames[0]).toBe(30 * MIN);
    // A newest image off the half hour: the loop ends on the half hour before it.
    expect(loopFrames({ ...TIMES, end: at('2026-10-14T06:50:00Z') }).at(-1)).toBe(at('2026-10-14T06:30:00Z'));
    // Never before the first image there is.
    expect(loopFrames({ start: at('2026-10-14T03:00:00Z'), end: at('2026-10-14T06:30:00Z'), step: 10 * MIN })).toHaveLength(8);
  });

  it('fades each image into the next, holds the newest, and starts again', () => {
    let at = { index: 0, since: 1000 };
    expect(loopStep(at, 1000, 25)).toEqual({ index: 0, since: 1000, next: 1, mix: 0 });
    expect(loopStep(at, 1000 + LOOP_FRAME_MS / 2, 25)).toEqual({ index: 0, since: 1000, next: 1, mix: 0.5 });
    at = loopStep(at, 1000 + LOOP_FRAME_MS, 25);
    expect(at).toEqual({ index: 1, since: 1000 + LOOP_FRAME_MS, next: 2, mix: 0 });
    // The newest stays, then the loop jumps back to the oldest.
    const newest = { index: 24, since: 0 };
    expect(loopStep(newest, LOOP_FRAME_MS, 25)).toEqual({ index: 24, since: 0, next: 24, mix: 0 });
    expect(loopStep(newest, LOOP_HOLD_MS, 25)).toEqual({ index: 0, since: LOOP_HOLD_MS, next: 1, mix: 0 });
    // More images arrived meanwhile: what was the newest goes on to the next.
    expect(loopStep({ index: 19, since: 0 }, LOOP_FRAME_MS, 25).index).toBe(20);
    expect(loopStep({ index: 0, since: 0 }, 5000, 1)).toEqual({ index: 0, since: 5000, next: 0, mix: 0 });
  });

  it('never goes backwards when a frame comes with an earlier time than the last change', () => {
    expect(loopStep({ index: 3, since: 1000 }, 950, 25)).toEqual({ index: 3, since: 1000, next: 4, mix: 0 });
  });

  it('starts once nearly all images are there, and gives up only when there are not two', () => {
    expect(loopStatus({ frames: 25, complete: 19, settled: false })).toBe('loading');
    expect(loopStatus({ frames: 25, complete: 20, settled: false })).toBe('ready');
    expect(loopStatus({ frames: 25, complete: 5, settled: true })).toBe('ready');
    expect(loopStatus({ frames: 25, complete: 1, settled: true })).toBe('failed');
    expect(loopStatus({ frames: 2, complete: 1, settled: false })).toBe('loading');
  });
});
