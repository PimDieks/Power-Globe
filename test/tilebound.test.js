import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import SlippyMap from 'three-slippy-map-globe';
import { boundTiles, settleLevels, tileLevelFor } from '../src/map.js';

// The tile engine is the site's copy (vite.config.js points the import at it), with images that
// load at once standing in for the page's <img>.
const R = 100;
// A small limit lets a short flight go past it.
const MAX = 20;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeImage() {
  const listeners = {};
  return {
    width: 256,
    height: 256,
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    removeEventListener() {},
    set src(url) {
      setTimeout(() => listeners.load?.call(this, {}), 0);
    },
  };
}

// Returns a camera `altitude` globe radii above the equator at `lng`, looking at the middle of the
// globe.
function cameraAt(lng, altitude) {
  const camera = new THREE.PerspectiveCamera(50, 1.6, 0.01, 10000);
  const r = R * (1 + altitude);
  camera.position.set(r * Math.sin((lng * Math.PI) / 180), 0, r * Math.cos((lng * Math.PI) / 180));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

const level = (t) => Math.round(Math.log2((2 * Math.PI) / t.geometry.parameters.phiLength));
const loaded = (engine) => engine.children.filter((t) => t.material.map && t.geometry.parameters.phiLength);
// Returns the tiles that have been drawn, by level and position.
const keys = (engine) =>
  new Set(loaded(engine).map((t) => `${level(t)}/${t.geometry.parameters.phiStart.toFixed(5)}/${t.geometry.parameters.thetaStart.toFixed(5)}`));

// Flies the camera along the equator from `from` to `to` degrees east, a step at a time, letting
// the tiles load at each step, and calls `after(engine, camera)` after each.
async function fly(engine, from, to, altitude, after = () => {}) {
  const steps = Math.max(1, Math.round(Math.abs(to - from) / 0.15));
  for (let i = 0; i <= steps; i++) {
    const camera = cameraAt(from + ((to - from) * i) / steps, altitude);
    engine.updatePov(camera);
    await tick();
    await tick();
    engine.updateMatrixWorld();
    after(engine, camera);
  }
}

describe('letting go of map tiles out of view', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElementNS: () => fakeImage() });
    THREE.Cache.enabled = false;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const makeEngine = () => {
    const engine = new SlippyMap(R, { tileUrl: (x, y, l) => `tile/${l}/${x}/${y}` });
    engine.updateMatrixWorld();
    return engine;
  };

  it('uses the copy of the engine that can let go of a tile', async () => {
    const engine = makeEngine();
    await fly(engine, 0, 0.2, 0.004);
    const tiles = loaded(engine);
    expect(tiles.length).toBeGreaterThan(0);
    expect(engine.evictTile(tiles[0])).toBe(true);
    expect(engine.evictTile(tiles[0])).toBe(false);
    expect(engine.children).not.toContain(tiles[0]);
  });

  it('without it, the engine keeps every tile flown over', async () => {
    const engine = makeEngine();
    await fly(engine, 0, 8, 0.004);
    expect(engine.children.length).toBeGreaterThan(3 * MAX);
  });

  it('keeps no more than its share of tiles while following a flight', async () => {
    const engine = makeEngine();
    let most = 0;
    await fly(engine, 0, 8, 0.004, (e, camera) => {
      boundTiles(e, camera, MAX);
      most = Math.max(most, e.children.length);
    });
    // The share is the limit, plus the back layer and one step's new tiles.
    expect(most).toBeLessThan(MAX + 20);
  });

  it('never lets go of a tile in view, and loads tiles let go again when they come back', async () => {
    const engine = makeEngine();
    await fly(engine, -0.15, 0, 0.004);
    const start = keys(engine);
    expect(start.size).toBeGreaterThan(0);
    await fly(engine, 0, 8, 0.004, (e, camera) => {
      const before = loaded(e).length;
      const inView = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const shown = loaded(e).filter((t) => inView.intersectsObject(t));
      boundTiles(e, camera, MAX);
      for (const tile of shown) expect(e.children).toContain(tile);
      expect(loaded(e).length).toBeLessThanOrEqual(before);
    });
    for (const key of start) expect(keys(engine).has(key)).toBe(false);
    await fly(engine, 8, -0.15, 0.004, (e, camera) => boundTiles(e, camera, MAX));
    const back = keys(engine);
    for (const key of start) expect(back.has(key)).toBe(true);
  });

  it('lets go of the coarser tiles passed on the way in, but not those beneath the view', async () => {
    const engine = makeEngine();
    // The camera zooms in from the whole globe to close up, a level at a time.
    for (let altitude = 2.4; altitude > 0.004; altitude /= 1.6) {
      engine.updatePov(cameraAt(0, altitude));
      await tick();
      await tick();
    }
    const camera = cameraAt(0, 0.004);
    engine.updatePov(camera);
    await tick();
    await tick();
    engine.updateMatrixWorld();
    const coarser = () => loaded(engine).filter((t) => level(t) < engine.level);
    const own = loaded(engine).filter((t) => level(t) === engine.level);
    const before = coarser().length;
    expect(before).toBeGreaterThan(3 * MAX);
    boundTiles(engine, camera, MAX);
    // The farthest go first: of the coarsest levels only the tiles around the point beneath the
    // camera are left, four a level, as it is above a corner shared by four tiles.
    expect(coarser().length).toBeLessThan(before / 3);
    for (const l of [2, 3, 4, 5]) expect(coarser().filter((t) => level(t) === l).length).toBe(4);
    for (const tile of own) expect(engine.children).toContain(tile);
  });

  it('keeps one and a half times the tiles in view when that is more than the limit', async () => {
    const engine = makeEngine();
    await fly(engine, 0, 4, 0.004);
    const camera = cameraAt(4, 0.004);
    const inView = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const shown = loaded(engine).filter((t) => inView.intersectsObject(t)).length;
    boundTiles(engine, camera, 1);
    expect(loaded(engine).length).toBeGreaterThanOrEqual(Math.ceil(1.5 * shown) - 1);
    expect(loaded(engine).length).toBeLessThan(3 * shown);
  });

  it('frees what it lets go', async () => {
    const engine = makeEngine();
    await fly(engine, 0, 3, 0.004);
    const tile = loaded(engine)[0];
    const freed = { geometry: vi.spyOn(tile.geometry, 'dispose'), material: vi.spyOn(tile.material, 'dispose'), map: vi.spyOn(tile.material.map, 'dispose') };
    const camera = cameraAt(3, 0.004);
    expect(boundTiles(engine, camera, 10)).toBeGreaterThan(0);
    expect(engine.children).not.toContain(tile);
    for (const spy of Object.values(freed)) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('leaves the tiles alone below the limit', () => {
    const camera = cameraAt(0, 0.004);
    const engine = { children: [{}], evictTile: vi.fn() };
    expect(boundTiles(engine, camera)).toBe(0);
    expect(boundTiles({ evictTile: vi.fn() }, camera)).toBe(0);
    expect(boundTiles(null, camera)).toBe(0);
    expect(boundTiles(engine, {})).toBe(0);
  });

  it('says so once when the engine cannot let go of tiles', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const engine = { children: Array(5).fill({}) };
    expect(boundTiles(engine, cameraAt(0, 0.004), 2)).toBe(0);
    expect(boundTiles(engine, cameraAt(0, 0.004), 2)).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('waiting for the zoom to pause before loading another level', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // An engine as three-globe drives it: told of the camera every frame, it picks its level.
  function engineAndGlobe() {
    const engine = { thresholds: [...Array(30)].map((_, i) => 8 / 2 ** i), maxLevel: 17, minLevel: 0, levels: [] };
    engine.level = tileLevelFor(engine, cameraAt(0, 2.4), R);
    engine.updatePov = vi.fn((camera) => {
      engine.level = tileLevelFor(engine, camera, R);
      engine.levels.push(engine.level);
    });
    let camera = cameraAt(0, 2.4);
    const globe = { camera: () => camera, getGlobeRadius: () => R };
    return { engine, globe, setCamera: (c) => (camera = c) };
  }

  // Zooms from `from` to `to` globe radii up over `ms`, telling the engine every frame.
  async function zoom(engine, setCamera, from, to, ms) {
    for (let t = 0; t <= ms; t += 16) {
      const camera = cameraAt(0, from * (to / from) ** (t / ms));
      setCamera(camera);
      engine.updatePov(camera);
      await vi.advanceTimersByTimeAsync(16);
    }
  }

  it('loads few of the levels a zoom out passes, and the right one once it pauses', async () => {
    const { engine, globe, setCamera } = engineAndGlobe();
    engine.level = 12;
    const unsettled = new Set();
    const plain = engine.updatePov;
    await zoom({ updatePov: (c) => unsettled.add(tileLevelFor(engine, c, R)) }, setCamera, 0.004, 2.5, 2000);
    settleLevels(engine, globe);
    await zoom(engine, setCamera, 0.004, 2.5, 2000);
    await vi.advanceTimersByTimeAsync(300);
    const loaded = new Set(plain.mock.calls.map(([c]) => tileLevelFor(engine, c, R)));
    expect(unsettled.size).toBeGreaterThanOrEqual(9);
    expect(loaded.size).toBeLessThanOrEqual(6);
    expect(engine.level).toBe(tileLevelFor(engine, cameraAt(0, 2.5), R));
  });

  it('passes on every move within a level at once', async () => {
    const { engine, globe } = engineAndGlobe();
    settleLevels(engine, globe);
    for (let lng = 0; lng < 10; lng++) engine.updatePov(cameraAt(lng, 2.4));
    expect(engine.levels).toEqual(Array(10).fill(engine.level));
  });
});
