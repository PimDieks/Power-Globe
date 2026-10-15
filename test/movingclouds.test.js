import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

// Tile images: each load is recorded, and answers at once unless its time is held back.
const images = { loads: [], held: new Set(), failing: new Set() };
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
      load(url, onLoad, onProgress, onError) {
        const params = new URL(url).searchParams;
        const time = params.get('time');
        // The tile level, from the width of its box.
        const [minX, , maxX] = params.get('bbox').split(',').map(Number);
        const level = Math.round(Math.log2(40075016.68 / (maxX - minX)));
        const image = { src: url, width: 512, height: 512 };
        const answer = () => onLoad(image);
        images.loads.push({ url, time, level, image, answer });
        if (images.failing.has(time)) setTimeout(() => onError(new Error('refused')), 10);
        else if (!images.held.has(time)) setTimeout(answer, 10);
        return image;
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
    images.failing.clear();
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

  describe('the clouds loop', () => {
    afterEach(() => {
      engine.level = 3;
    });

    it('loads the last 12 hours for the tiles in view, then plays, and stops with the view', async () => {
      const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
      basemap.setTime(at('2026-10-14T07:00:00Z'));
      await vi.advanceTimersByTimeAsync(2000);
      images.loads.length = 0;
      expect(basemap.cloudsLoop()).toBeNull();
      expect(basemap.startCloudsLoop()).toBe(true);
      expect(basemap.cloudsLoop().status).toBe('loading');
      await vi.advanceTimersByTimeAsync(2000);
      const loop = basemap.cloudsLoop();
      expect(loop.status).toBe('playing');
      expect(loop.progress).toBe(1);
      // 25 images, each for the few tiles in view, and nothing else (the newest was on show).
      expect(timesLoaded()).toHaveLength(24);
      expect(timesLoaded()[0]).toBe('2026-10-13T18:30:00Z');
      const perImage = images.loads.length / 24;
      expect(Number.isInteger(perImage)).toBe(true);
      expect(perImage).toBeLessThanOrEqual(8);
      // The loop's images are its own: no note about how old the timeline's clouds are.
      expect(basemap.cloudsAsOf()).toBeNull();
      // Zoomed in past the clouds' detail, the loop stops.
      engine.level = 9;
      basemap.setAltitude(0.05);
      await vi.advanceTimersByTimeAsync(1000);
      expect(basemap.cloudsLoop()).toBeNull();
    });

    it('stops when the view changes, and asks nothing more after', async () => {
      const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
      await vi.advanceTimersByTimeAsync(2000);
      basemap.startCloudsLoop();
      await vi.advanceTimersByTimeAsync(0);
      basemap.setStyle('satellite');
      expect(basemap.cloudsLoop()).toBeNull();
      const asked = images.loads.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(images.loads.length).toBe(asked);
      expect(basemap.startCloudsLoop()).toBe(false);
    });

    it('steps one image at a time when asked to, and ends after the newest', async () => {
      const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
      await vi.advanceTimersByTimeAsync(2000);
      basemap.startCloudsLoop({ manual: true });
      await vi.advanceTimersByTimeAsync(2000);
      expect(basemap.cloudsLoop()).toMatchObject({ status: 'playing', frame: at('2026-10-13T18:30:00Z'), last: false });
      // Nothing moves by itself.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(basemap.cloudsLoop().frame).toBe(at('2026-10-13T18:30:00Z'));
      basemap.advanceCloudsLoop();
      expect(basemap.cloudsLoop().frame).toBe(at('2026-10-13T19:00:00Z'));
      for (let i = 0; i < 23; i++) basemap.advanceCloudsLoop();
      expect(basemap.cloudsLoop()).toMatchObject({ frame: at('2026-10-14T06:30:00Z'), last: true });
      basemap.advanceCloudsLoop();
      expect(basemap.cloudsLoop()).toBeNull();
    });

    it('plays without images that do not come', async () => {
      const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
      await vi.advanceTimersByTimeAsync(2000);
      images.held.add('2026-10-13T18:30:00Z');
      basemap.startCloudsLoop();
      // Those requests hang (until they count as failed), the rest load meanwhile, and the loop
      // plays without the missing image.
      await vi.advanceTimersByTimeAsync(2000);
      expect(basemap.cloudsLoop().status).toBe('playing');
      expect(basemap.cloudsLoop().progress).toBeLessThan(1);
      expect(basemap.cloudsLoop().frame).toBe(at('2026-10-13T19:00:00Z'));
      basemap.stopCloudsLoop();
      expect(basemap.cloudsLoop()).toBeNull();
    });
  });

  describe('as reviewed', () => {
    // Europe from about 0.7 globe radii up, where the map shows tile level 5.
    const near = new THREE.PerspectiveCamera(50, 1.4, 0.05, 125000);
    near.position.setFromSphericalCoords(170, (40 * Math.PI) / 180, (8 * Math.PI) / 180);
    const initTexture = vi.fn();
    const europe = { ...globe, camera: () => near, renderer: () => ({ initTexture }) };
    const levels = () => [...new Set(images.loads.map((l) => l.level))];

    beforeEach(() => {
      engine.level = 5;
      initTexture.mockClear();
    });
    afterEach(() => {
      engine.level = 3;
    });

    it('keeps the full detail while the timeline plays, and the coarser tiles for the loop', async () => {
      const basemap = setupBasemap(europe, 'backdrop.jpg', { initial: 'clouds' });
      basemap.setTime(at('2026-10-14T03:00:00Z'), [at('2026-10-14T04:00:00Z'), at('2026-10-14T05:00:00Z')], true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(levels()).toEqual([4]);
      const perImage = images.loads.length / timesLoaded().length;
      expect(perImage).toBeGreaterThan(8);
      images.loads.length = 0;
      basemap.setTime(at('2026-10-14T03:00:00Z'));
      basemap.startCloudsLoop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(levels()).toEqual([3]);
      expect(images.loads.length / 25).toBeLessThanOrEqual(8);
    });

    it('counts an image with no answer after 20 seconds as failed, stops it, and lets it go when it comes late', async () => {
      const basemap = setupBasemap(europe, 'backdrop.jpg', { initial: 'clouds' });
      images.held.add('2026-10-14T03:00:00Z');
      basemap.setTime(at('2026-10-14T03:00:00Z'));
      await vi.advanceTimersByTimeAsync(2000);
      const first = images.loads.filter((l) => l.time === '2026-10-14T03:00:00Z');
      expect(first.length).toBeGreaterThan(0);
      expect(first.every((l) => l.image.src)).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      // Each download was stopped, and the tiles are asked for again after the pause.
      expect(first.every((l) => l.image.src === '')).toBe(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(images.loads.filter((l) => l.time === '2026-10-14T03:00:00Z').length).toBeGreaterThan(first.length);
      // A late answer makes no texture and sends nothing to the graphics card.
      const uploads = initTexture.mock.calls.length;
      for (const load of first) load.answer();
      expect(initTexture.mock.calls.length).toBe(uploads);
    });

    it('keeps the loop going when the first frame comes with an earlier time than its start', async () => {
      vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now() - 50), 16));
      vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
      const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
      await vi.advanceTimersByTimeAsync(2000);
      basemap.startCloudsLoop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(basemap.cloudsLoop().status).toBe('playing');
      const shown = new Set();
      for (let i = 0; i < 40; i++) {
        await vi.advanceTimersByTimeAsync(100);
        shown.add(basemap.cloudsLoop().frame);
      }
      expect(shown.size).toBeGreaterThan(5);
    });

    it('keeps the loop going after a frame that went wrong', async () => {
      vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(() => cb(performance.now()), 16));
      vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id));
      const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
      await vi.advanceTimersByTimeAsync(2000);
      basemap.startCloudsLoop();
      await vi.advanceTimersByTimeAsync(2000);
      // One frame fails while it lets the graphics card forget an image.
      const dispose = vi.spyOn(THREE.Texture.prototype, 'dispose').mockImplementationOnce(() => {
        throw new Error('lost context');
      });
      const shown = new Set();
      for (let i = 0; i < 40; i++) {
        try {
          await vi.advanceTimersByTimeAsync(100);
        } catch {
          // The failed frame.
        }
        shown.add(basemap.cloudsLoop().frame);
      }
      dispose.mockRestore();
      expect(shown.size).toBeGreaterThan(5);
    });

    it('ends the loop when the timeline plays', async () => {
      const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
      await vi.advanceTimersByTimeAsync(2000);
      basemap.startCloudsLoop();
      await vi.advanceTimersByTimeAsync(2000);
      expect(basemap.cloudsLoop().status).toBe('playing');
      basemap.setTime(at('2026-10-14T05:00:00Z'), [at('2026-10-14T06:00:00Z')], true);
      expect(basemap.cloudsLoop()).toBeNull();
    });

    it('gives up on a loop whose images keep failing, says so, then shows the time again', async () => {
      const basemap = setupBasemap(globe, 'backdrop.jpg', { initial: 'clouds' });
      await vi.advanceTimersByTimeAsync(2000);
      for (let t = at('2026-10-13T18:30:00Z'); t < at('2026-10-14T06:30:00Z'); t += 30 * 60_000) {
        images.failing.add(new Date(t).toISOString().replace('.000Z', 'Z'));
      }
      expect(basemap.startCloudsLoop()).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(basemap.cloudsLoop().status).toBe('loading');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(basemap.cloudsLoop().status).toBe('failed');
      await vi.advanceTimersByTimeAsync(7000);
      expect(basemap.cloudsLoop()).toBeNull();
    });
  });
});

describe('map tiles in a style of their own', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1, addEventListener() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  const setup = (initial) => {
    const camera = new THREE.PerspectiveCamera(50, 1.4, 0.05, 125000);
    camera.position.set(0, 0, 300);
    // The engine's own updatePov, before settleLevels wraps it.
    const updatePov = vi.fn();
    const engine = { thresholds: [8, 4, 2], tileUrl: null, level: 2, children: [], add: vi.fn(), updatePov };
    const globe = {
      globeTileEngineUrl: () => globe,
      globeTileEngineMaxLevel: () => globe,
      globeTileEngineClearCache: vi.fn(),
      getGlobeRadius: () => 100,
      scene: () => ({ add() {}, traverse: (visit) => visit(engine) }),
      lights: () => [],
      camera: () => camera,
    };
    const basemap = setupBasemap(globe, 'backdrop.jpg', { initial });
    basemap.setAltitude(2.5);
    const tile = new THREE.Mesh(new THREE.SphereGeometry(100), new THREE.MeshLambertMaterial({ map: new THREE.Texture() }));
    engine.add(tile);
    return { globe, updatePov, camera, tile };
  };

  it('recolours the Dark map, loading the tiles in view again once it can', () => {
    const { globe, updatePov, camera, tile } = setup('dark');
    // Tiles loaded before the engine was found go, and the view loads again at once.
    expect(globe.globeTileEngineClearCache).toHaveBeenCalledTimes(1);
    expect(updatePov).toHaveBeenCalledWith(camera);
    expect(tile.material.customProgramCacheKey()).toBe('palette-night');
    expect(tile.material.dithering).toBe(true);
    const shader = { fragmentShader: 'void main() {\n#include <map_fragment>\n}' };
    tile.material.onBeforeCompile(shader);
    expect(shader.fragmentShader).toContain('diffuseColor.rgb = pow(col, vec3(2.2));');
  });

  it('leaves the satellite tiles as they come', () => {
    const { globe, updatePov, tile } = setup('satellite');
    expect(globe.globeTileEngineClearCache).not.toHaveBeenCalled();
    expect(updatePov).not.toHaveBeenCalled();
    expect(tile.material.customProgramCacheKey()).not.toContain('palette');
    expect(tile.material.dithering).toBe(false);
  });
});
