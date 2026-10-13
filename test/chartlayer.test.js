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

  it('keeps asking about once a second while the view never settles, and once more when it stops', async () => {
    // Ten seconds of a camera that moves every frame, as when following an aircraft.
    for (let t = 0; t < 10_000; t += 16) {
      basemap.setAltitude(0.01);
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(tellsOf()).toBeGreaterThanOrEqual(7);
    expect(tellsOf()).toBeLessThanOrEqual(10);
    const during = tellsOf();
    await vi.advanceTimersByTimeAsync(300);
    expect(tellsOf()).toBe(during + 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(tellsOf()).toBe(during + 1);
  });
});
