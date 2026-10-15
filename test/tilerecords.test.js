import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import SlippyMap from 'three-slippy-map-globe';
import { boundTiles } from '../src/map.js';

// The site's copy of the tile engine (vite.config.js points the import at it), with images that
// load, or fail to, at once, standing in for the page's <img>.
const R = 100;
const MAX = 20;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let failing = () => false;
let requested = [];
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
      requested.push(url);
      setTimeout(() => (failing(url) ? listeners.error : listeners.load)?.call(this, {}), 0);
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

const makeEngine = () => {
  const engine = new SlippyMap(R, { tileUrl: (x, y, l) => `tile/${l}/${x}/${y}` });
  engine.updateMatrixWorld();
  return engine;
};

// Tells the engine of the camera and lets the tiles it asks for load (or fail).
async function look(engine, camera) {
  engine.updatePov(camera);
  await tick();
  await tick();
  engine.updateMatrixWorld();
}

beforeEach(() => {
  vi.stubGlobal('document', { createElementNS: () => fakeImage() });
  THREE.Cache.enabled = false;
  failing = () => false;
  requested = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the records the tile engine keeps of its tiles', () => {
  it('stay few on a long flight, as the tiles let go have their records let go too', async () => {
    const engine = makeEngine();
    let most = 0;
    // A level 11 tile is about 0.18 degrees wide, and the engine keeps a record of about five of
    // them each way around the camera: this flight passes some 2,800.
    for (let lng = 0; lng <= 100; lng += 0.5) {
      const camera = cameraAt(lng, 0.004);
      await look(engine, camera);
      boundTiles(engine, camera, MAX);
      most = Math.max(most, engine.countTileRecords());
    }
    expect(engine.level).toBe(11);
    expect(most).toBeLessThan(1100);
    // Where the flight comes back to, the tiles are asked for and shown again.
    const before = requested.length;
    await look(engine, cameraAt(0, 0.004));
    expect(requested.length).toBeGreaterThan(before);
    expect(requested.slice(before).every((url) => url.startsWith('tile/11/'))).toBe(true);
    expect(engine.children.filter((t) => t.material.map).length).toBeGreaterThan(0);
  }, 60_000);

  it('of a level zoomed out of are let go with its tiles', async () => {
    const engine = makeEngine();
    for (let lng = 0; lng <= 10; lng += 0.5) await look(engine, cameraAt(lng, 0.004));
    const close = engine.countTileRecords();
    // Level 11 to level 6, which has a record of every tile on the globe (4,096) from the start.
    await look(engine, cameraAt(10, 0.15));
    expect(engine.level).toBe(6);
    const far = engine.countTileRecords();
    await look(engine, cameraAt(10, 0.004));
    await look(engine, cameraAt(10, 0.15));
    expect(close).toBeGreaterThan(200);
    // Levels 0 and 6, and no more than a few tiles of level 11 still loading.
    expect(far).toBeLessThan(1 + 4096 + 30);
    expect(engine.countTileRecords()).toBeLessThan(1 + 4096 + 30);
  });
});

describe('a tile whose image cannot be had', () => {
  it('gives up its mesh and is asked for again after a pause, not on every frame', async () => {
    const disposed = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const engine = makeEngine();
    const camera = cameraAt(0, 0.004);
    failing = () => true;
    await look(engine, camera);
    const failed = requested.length;
    expect(failed).toBeGreaterThan(0);
    // Every mesh made for it is freed, and none is shown.
    expect(disposed.mock.calls.length).toBe(failed);
    expect(engine.children.filter((t) => t.material.map)).toHaveLength(0);

    // Frames straight after: nothing is asked for again.
    for (let i = 0; i < 5; i++) await look(engine, camera);
    expect(requested.length).toBe(failed);

    // A while later, the tiles are asked for again, and this time they come.
    failing = () => false;
    const later = Date.now() + 6000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await look(engine, camera);
    expect(requested.length).toBe(2 * failed);
    expect(engine.children.filter((t) => t.material.map)).toHaveLength(failed);
  });

  it('keeps its pause when the view goes to another level and back', async () => {
    const engine = makeEngine();
    failing = (url) => url.startsWith('tile/11/');
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);
    await look(engine, cameraAt(0, 0.004));
    const failed = requested.length;
    expect(failed).toBeGreaterThan(0);
    // Out to level 10 and back, within the pause: the failed tiles are not asked for again.
    for (let i = 0; i < 3; i++) {
      await look(engine, cameraAt(0, 0.01));
      expect(engine.level).toBe(10);
      await look(engine, cameraAt(0, 0.004));
      expect(engine.level).toBe(11);
    }
    expect(requested.filter((url) => url.startsWith('tile/11/'))).toHaveLength(failed);
    // And the pause still doubles: asked again after five seconds, then not until ten more.
    t += 6000;
    await look(engine, cameraAt(0, 0.004));
    expect(requested.filter((url) => url.startsWith('tile/11/'))).toHaveLength(2 * failed);
    await look(engine, cameraAt(0, 0.01));
    await look(engine, cameraAt(0, 0.004));
    t += 6000;
    await look(engine, cameraAt(0, 0.004));
    expect(requested.filter((url) => url.startsWith('tile/11/'))).toHaveLength(2 * failed);
    t += 5000;
    await look(engine, cameraAt(0, 0.004));
    expect(requested.filter((url) => url.startsWith('tile/11/'))).toHaveLength(3 * failed);
  });

  it('waits longer each time it fails again', async () => {
    const engine = makeEngine();
    const camera = cameraAt(0, 0.004);
    failing = () => true;
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);
    await look(engine, camera);
    const once = requested.length;
    t += 6000;
    await look(engine, camera);
    expect(requested.length).toBe(2 * once);
    // The second failure waits ten seconds.
    t += 6000;
    await look(engine, camera);
    expect(requested.length).toBe(2 * once);
    t += 5000;
    await look(engine, camera);
    expect(requested.length).toBe(3 * once);
  });
});
