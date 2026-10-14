import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// Tile images: each load is recorded, and answers at once unless its time is held back.
const images = { loads: [], held: new Set() };
vi.mock('three', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    TextureLoader: class {
      load() {
        return {};
      }
    },
    ImageLoader: class {
      load(url, onLoad) {
        const time = new URL(url).searchParams.get('time');
        const answer = () => onLoad({ width: 512, height: 512 });
        images.loads.push({ url, time, answer });
        if (!images.held.has(time)) setTimeout(answer, 10);
      }
    },
  };
});

import { setupBasemap } from '../src/map.js';
import { CAPABILITIES_URL } from '../src/meteosat.js';

const capabilities = (end) => `<Dimension name="time" units="ISO8601">2024-09-23T00:00:00.000Z/${end}/PT10M</Dimension>`;
const at = (iso) => Date.parse(iso);

describe('the moving clouds of the Clouds view', () => {
  let fetch;
  let newest;
  // The map's own tile engine as the layer sees it: at tile level 3 (whole globe in view).
  const engine = { thresholds: [], tileUrl: null, level: 3, add() {} };
  const camera = new THREE.PerspectiveCamera(50, 1.4, 0.05, 125000);
  camera.position.setFromSphericalCoords(300, (60 * Math.PI) / 180, (10 * Math.PI) / 180);
  const globe = {
    globeTileEngineUrl: () => globe,
    globeTileEngineMaxLevel: () => globe,
    globeTileEngineClearCache() {},
    getGlobeRadius: () => 100,
    scene: () => ({ add() {}, traverse: (visit) => visit(engine) }),
    lights: () => [],
    camera: () => camera,
  };
  const bare = { ...globe, scene: () => ({ add() {}, traverse() {} }), camera: () => ({}) };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at('2026-10-14T07:00:00Z'));
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1, addEventListener() {} });
    newest = '2026-10-14T06:30:00.000Z';
    fetch = vi.fn(async () => ({ ok: true, text: async () => capabilities(newest) }));
    vi.stubGlobal('fetch', fetch);
    images.loads.length = 0;
    images.held.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const timesLoaded = () => [...new Set(images.loads.map((l) => l.time))];

  it('asks EUMETSAT nothing while another view is shown', async () => {
    const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'satellite' });
    basemap.setTime(at('2026-10-14T03:00:00Z'));
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(images.loads).toEqual([]);
  });

  it('reads the image times when shown, every 10 minutes while shown, and stops after', async () => {
    const basemap = setupBasemap(bare, 'backdrop.jpg', { initial: 'satellite' });
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

  it('shows the image for the timeline time, and credits EUMETSAT while it does', async () => {
    const credits = [];
    const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds', onCredit: (html) => credits.push(html) });
    expect(credits.at(-1)).not.toContain('EUMETSAT');
    basemap.setTime(at('2026-10-14T03:00:00Z'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(images.loads.length).toBeGreaterThan(0);
    expect(timesLoaded()).toEqual(['2026-10-14T03:00:00Z']);
    expect(basemap.cloudsShown()).toBe(at('2026-10-14T03:00:00Z'));
    expect(credits.at(-1).replace(/<[^>]+>/g, '')).toMatch(/^Contains modified EUMETSAT Meteosat data 2026\. /);
    basemap.setStyle('satellite');
    expect(credits.at(-1)).not.toContain('EUMETSAT');
  });

  it('shows the time on the timeline when it comes back, not the one it showed before', async () => {
    const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
    basemap.setTime(at('2026-10-14T00:00:00Z'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(basemap.cloudsShown()).toBe(at('2026-10-14T00:00:00Z'));
    basemap.setStyle('satellite');
    // Played on to 03:00 meanwhile, passing 00:00 as one ahead.
    basemap.setTime(at('2026-10-14T00:00:00Z'), [at('2026-10-14T03:00:00Z')]);
    basemap.setTime(at('2026-10-14T03:00:00Z'));
    images.held.add('2026-10-14T03:00:00Z');
    const shown = [];
    basemap.setStyle('clouds');
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(50);
      shown.push(basemap.cloudsShown());
    }
    // While 03:00 loads nothing is shown, rather than the 00:00 clouds from before.
    expect(shown.every((s) => s === null)).toBe(true);
    for (const load of images.loads.filter((l) => l.time === '2026-10-14T03:00:00Z')) load.answer();
    await vi.advanceTimersByTimeAsync(100);
    expect(basemap.cloudsShown()).toBe(at('2026-10-14T03:00:00Z'));
  });

  it('lets go of the images when switched away, and asks again on return', async () => {
    const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
    basemap.setTime(at('2026-10-14T03:00:00Z'));
    await vi.advanceTimersByTimeAsync(2000);
    const first = images.loads.length;
    expect(first).toBeGreaterThan(0);
    const disposed = vi.spyOn(THREE.Texture.prototype, 'dispose');
    basemap.setStyle('satellite');
    // Every tile's image goes, not only the copies on the graphics card of those on show.
    expect(disposed.mock.calls.length).toBeGreaterThanOrEqual(2 * first);
    basemap.setStyle('clouds');
    await vi.advanceTimersByTimeAsync(2000);
    expect(images.loads.length).toBe(2 * first);
    disposed.mockRestore();
  });

  it('says how old the clouds are while the timeline is later than the image on show', async () => {
    const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
    basemap.setTime(at('2026-10-14T12:00:00Z'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(basemap.cloudsAsOf()).toBe(at('2026-10-14T06:30:00Z'));
    // A newer image appears; while it loads the older one stays, and so does the note.
    newest = '2026-10-14T06:40:00.000Z';
    images.held.add('2026-10-14T06:40:00Z');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(timesLoaded()).toContain('2026-10-14T06:40:00Z');
    expect(basemap.cloudsShown()).toBe(at('2026-10-14T06:30:00Z'));
    expect(basemap.cloudsAsOf()).toBe(at('2026-10-14T06:30:00Z'));
    // At the time of the image on show there is nothing to say.
    basemap.setTime(at('2026-10-14T06:30:00Z'));
    expect(basemap.cloudsAsOf()).toBeNull();
  });

  it('says nothing about the clouds when none are shown', async () => {
    const basemap = setupBasemap(bare, 'backdrop.jpg', { initial: 'clouds' });
    basemap.setTime(at('2026-10-14T12:00:00Z'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(basemap.cloudsAsOf()).toBeNull();
  });
});
