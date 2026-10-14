import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AREA_DEG,
  Backoff,
  TileStore,
  coversTile,
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

  it('hands the map over to close up imagery only where the images cover the tile', () => {
    expect(coversTile(129, 88, 8)).toBe(true); // Paris
    expect(coversTile(255, 64, 8)).toBe(false); // Kazakhstan
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
  it('waits longer after each failure, up to a limit, and not at all after a success', () => {
    const b = new Backoff({ first: 5000, max: 20_000 });
    expect(b.wait(0)).toBe(0);
    b.fail(0);
    expect(b.wait(0)).toBe(5000);
    b.fail(0);
    expect(b.wait(0)).toBe(10_000);
    b.fail(0);
    b.fail(0);
    expect(b.wait(0)).toBe(20_000);
    expect(b.wait(15_000)).toBe(5000);
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
});
