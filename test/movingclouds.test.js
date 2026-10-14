import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('three', async (importOriginal) => ({
  ...(await importOriginal()),
  TextureLoader: class {
    load() {
      return {};
    }
  },
}));

import { setupBasemap } from '../src/map.js';
import { CAPABILITIES_URL } from '../src/meteosat.js';

const CAPABILITIES = `<Dimension name="time" units="ISO8601">2024-09-23T00:00:00.000Z/2026-10-14T06:30:00.000Z/PT10M</Dimension>`;

describe('the moving clouds of the Clouds view', () => {
  let fetch;
  const globe = {
    globeTileEngineUrl: () => globe,
    globeTileEngineMaxLevel: () => globe,
    globeTileEngineClearCache() {},
    getGlobeRadius: () => 100,
    scene: () => ({ add() {}, traverse() {} }),
    lights: () => [],
    camera: () => ({}),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1, addEventListener() {} });
    fetch = vi.fn(async () => ({ ok: true, text: async () => CAPABILITIES }));
    vi.stubGlobal('fetch', fetch);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks EUMETSAT nothing while another view is shown', async () => {
    const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'satellite' });
    basemap.setTime(Date.parse('2026-10-14T03:00:00Z'));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the image times when shown, every 10 minutes while shown, and stops after', async () => {
    const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'satellite' });
    basemap.setStyle('clouds');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(CAPABILITIES_URL);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    basemap.setStyle('streets');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('says how old the clouds are only when it shows some', async () => {
    const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
    basemap.setTime(Date.parse('2026-10-14T12:00:00Z'));
    await vi.advanceTimersByTimeAsync(0);
    // The times are known, but no tile has loaded (this globe has no tile engine to follow).
    expect(basemap.cloudsAsOf()).toBeNull();
  });
});
