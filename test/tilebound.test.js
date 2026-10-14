import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import SlippyMap from 'three-slippy-map-globe';
import { boundTiles, settleLevels, tileLevelFor } from '../src/map.js';

// The real tile engine, as installed (with scripts/patch-tile-engine.mjs applied), with images
// that load at once: a stand-in for the page's <img>.
const R = 100;
// A small limit, so that a short flight goes past it.
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

// A camera `altitude` globe radii above the equator at `lng`, looking at the middle of the globe.
function cameraAt(lng, altitude) {
  const camera = new THREE.PerspectiveCamera(50, 1.6, 0.01, 10000);
  const r = R * (1 + altitude);
  camera.position.set(r * Math.sin((lng * Math.PI) / 180), 0, r * Math.cos((lng * Math.PI) / 180));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

// Tiles that have been drawn, by "level/x/y".
const keys = (engine) =>
  new Set(engine.children.filter((t) => t.userData.tile && t.material.map).map((t) => `${Math.round(Math.log2((2 * Math.PI) / t.geometry.parameters.phiLength))}/${t.userData.tile.x}/${t.userData.tile.y}`));

// Flies the camera along the equator from `from` to `to` degrees east, a step at a time, letting
// the tiles load at each step, and calls `after(engine, camera)` after each.
async function fly(engine, from, to, altitude, after = () => {}) {
  const steps = Math.round(Math.abs(to - from) / 0.15);
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
  });

  const makeEngine = () => {
    const engine = new SlippyMap(R, { tileUrl: (x, y, l) => `tile/${l}/${x}/${y}` });
    engine.updateMatrixWorld();
    return engine;
  };

  it('gives each tile its record, so it can be let go (scripts/patch-tile-engine.mjs)', async () => {
    const engine = makeEngine();
    await fly(engine, 0, 0.2, 0.004);
    const tiles = engine.children.filter((t) => t.material.map);
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) expect(tile.userData.tile?.obj).toBe(tile);
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
    // The share, plus the back layer and one step's new tiles.
    expect(most).toBeLessThan(MAX + 20);
  });

  it('never lets go of a tile in view, and loads tiles let go again when they come back', async () => {
    const engine = makeEngine();
    await fly(engine, 0, 0, 0.004);
    const start = keys(engine);
    await fly(engine, 0, 8, 0.004, (e, camera) => {
      const before = e.children.filter((t) => t.material.map).length;
      const inView = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const shown = e.children.filter((t) => t.userData.tile && inView.intersectsObject(t));
      boundTiles(e, camera, MAX);
      for (const tile of shown) expect(e.children).toContain(tile);
      expect(e.children.filter((t) => t.material.map).length).toBeLessThanOrEqual(before);
    });
    for (const key of start) expect(keys(engine).has(key)).toBe(false);
    await fly(engine, 8, 0, 0.004, (e, camera) => boundTiles(e, camera, MAX));
    const back = keys(engine);
    for (const key of start) expect(back.has(key)).toBe(true);
  });

  it('lets go of the coarser tiles passed on the way in, but not those beneath the view', async () => {
    const engine = makeEngine();
    // Zoom in from the whole globe to close up, a level at a time.
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
    const level = (t) => Math.round(Math.log2((2 * Math.PI) / t.geometry.parameters.phiLength));
    const coarser = () => engine.children.filter((t) => t.userData.tile && level(t) < engine.level);
    const own = engine.children.filter((t) => t.userData.tile && level(t) === engine.level);
    expect(coarser().length).toBeGreaterThan(3 * MAX);
    boundTiles(engine, camera, MAX);
    // Only the coarse tiles around the point beneath the camera are left: here four a level, as it
    // is above a corner shared by four tiles.
    expect(coarser().length).toBeLessThanOrEqual(4 * engine.level);
    expect(coarser().some((t) => level(t) === 5)).toBe(true);
    for (const tile of own) expect(engine.children).toContain(tile);
  });

  it('frees what it lets go', async () => {
    const engine = makeEngine();
    await fly(engine, 0, 3, 0.004);
    const tile = engine.children.find((t) => t.userData.tile && t.material.map);
    const record = tile.userData.tile;
    const freed = { geometry: vi.spyOn(tile.geometry, 'dispose'), material: vi.spyOn(tile.material, 'dispose'), map: vi.spyOn(tile.material.map, 'dispose') };
    const camera = cameraAt(3, 0.004);
    expect(boundTiles(engine, camera, 10)).toBeGreaterThan(0);
    expect(engine.children).not.toContain(tile);
    expect(record.obj).toBeUndefined();
    for (const spy of Object.values(freed)) expect(spy).toHaveBeenCalled();
  });

  it('leaves the tiles alone below the limit, and engines it cannot read', () => {
    const camera = cameraAt(0, 0.004);
    const engine = { children: [{ userData: {} }], remove: vi.fn() };
    expect(boundTiles(engine, camera)).toBe(0);
    expect(boundTiles({ remove: vi.fn() }, camera)).toBe(0);
    expect(boundTiles(null, camera)).toBe(0);
    expect(boundTiles(engine, {})).toBe(0);
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
