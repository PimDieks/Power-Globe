import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tile engine draws with three.js; this one counts the times it is told where the camera is.
const engines = [];
vi.mock('three-slippy-map-globe', () => ({
  default: class {
    constructor() {
      this.children = [{ material: {} }];
      this.updatePov = vi.fn();
      this.clearTiles = vi.fn();
      this.add = vi.fn();
      engines.push(this);
    }
  },
}));
vi.mock('three', async (importOriginal) => ({
  ...(await importOriginal()),
  TextureLoader: class {
    load() {
      return {};
    }
  },
}));

import { setupBasemap } from '../src/map.js';

describe('the aviation chart over the map', () => {
  let basemap;
  const tellsOf = () => engines[0].updatePov.mock.calls.length;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-14T12:00:00Z'));
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1, addEventListener() {} });
    engines.length = 0;
    const globe = {
      globeTileEngineUrl: () => globe,
      globeTileEngineMaxLevel: () => globe,
      globeTileEngineClearCache() {},
      getGlobeRadius: () => 100,
      scene: () => ({ add() {}, traverse() {} }),
      lights: () => [],
      camera: () => ({}),
    };
    basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'aviation' });
    // Showing the chart asked for its tiles once.
    engines[0].updatePov.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks for tiles once the view has settled, not for every step of a zoom', async () => {
    for (let t = 0; t < 600; t += 16) {
      basemap.setAltitude(0.5 - t * 1e-4);
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(tellsOf()).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(tellsOf()).toBe(1);
  });

  it('waits for the view to settle however long a drag or zoom lasts', async () => {
    // Ten seconds of gesture, a call every frame.
    for (let t = 0; t < 10_000; t += 16) {
      basemap.setAltitude(0.01);
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(tellsOf()).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(tellsOf()).toBe(1);
  });

  describe('while the camera follows an aircraft', () => {
    // The camera controls report a change only after it has moved some distance, so at jet speed
    // calls come about every 300 ms: each one is inside the 250 ms of the last.
    const move = async (ms, every) => {
      for (let t = 0; t < ms; t += every) {
        basemap.setAltitude(0.01);
        await vi.advanceTimersByTimeAsync(every);
      }
    };

    it('asks about once a second, counted from the last time, and goes quiet when it stops', async () => {
      basemap.setFollowing(true);
      await move(10_000, 300);
      expect(tellsOf()).toBeGreaterThanOrEqual(9);
      expect(tellsOf()).toBeLessThanOrEqual(11);
      // The last call is answered too, by the update that was waiting, and then it is quiet.
      await vi.advanceTimersByTimeAsync(1000);
      const after = tellsOf();
      expect(after).toBeLessThanOrEqual(12);
      await vi.advanceTimersByTimeAsync(5000);
      expect(tellsOf()).toBe(after);
    });

    it('does the same with a call every frame', async () => {
      basemap.setFollowing(true);
      await move(10_000, 16);
      expect(tellsOf()).toBeGreaterThanOrEqual(9);
      expect(tellsOf()).toBeLessThanOrEqual(11);
    });

    it('goes back to waiting for the view to settle once following stops', async () => {
      basemap.setFollowing(true);
      await move(3000, 300);
      basemap.setFollowing(false);
      await vi.advanceTimersByTimeAsync(2000);
      const before = tellsOf();
      await move(5000, 16);
      expect(tellsOf()).toBe(before);
    });
  });
});
