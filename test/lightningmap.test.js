import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_PX, LABEL_PX, OVERLAY_RINGS_KM, paintIntensity, setupLightningOverlay } from '../src/lightningmap.js';
import { MAX_COUNT, RAMP, RING_KM, makeGeometry } from '../src/lightning.js';

const RAD = Math.PI / 180;

// A canvas that records what is drawn on it.
function fakeCanvas() {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const ctx = new Proxy(
    { save: record('save'), restore: record('restore') },
    {
      get: (target, key) => target[key] ?? record(String(key)),
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    },
  );
  return { width: 0, height: 0, calls, getContext: () => ctx };
}

describe('the lightning overlay on the globe', () => {
  const canvases = [];
  const added = [];
  const scene = { add: (m) => added.push(m), remove: (m) => added.splice(added.indexOf(m), 1) };
  const globe = {
    getGlobeRadius: () => 100,
    scene: () => scene,
    renderer: () => ({ domElement: { clientHeight: 800 } }),
    camera: () => ({ projectionMatrix: { elements: Array.from({ length: 16 }, (_, i) => (i === 5 ? 2.14 : 0)) } }),
  };
  let drawn;

  beforeEach(() => {
    canvases.length = 0;
    added.length = 0;
    vi.stubGlobal('document', {
      createElement: () => {
        const c = fakeCanvas();
        canvases.push(c);
        return c;
      },
    });
    drawn = [];
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(data, width, height) {
          Object.assign(this, { data, width, height });
          drawn.push(this);
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const geometry = makeGeometry(52.31, 4.76);
  // A decoded image of 4 pixels: weak, strong, nothing, and a pixel that is clear.
  const pixel = (n) => RAMP[n - 1].slice(1);
  const image = (() => {
    const data = new Uint8ClampedArray(2 * 2 * 4);
    data.set([...pixel(1), 255], 0);
    data.set([...pixel(20), 255], 4);
    data.set([0, 0, 0, 0], 8);
    data.set([...pixel(10), 255], 12);
    return { width: 2, height: 2, data };
  })();
  const meshes = () => added.filter((o) => o.isMesh);
  const sprites = () => added.filter((o) => o.isSprite);

  it('makes nothing until it is shown', () => {
    setupLightningOverlay(globe);
    expect(added).toHaveLength(0);
    expect(canvases).toHaveLength(0);
  });

  it('adds one mesh over the weather and under the runways, and a label for each ring', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image: null });
    expect(meshes()).toHaveLength(1);
    expect(meshes()[0].visible).toBe(true);
    expect(meshes()[0].renderOrder).toBe(4);
    expect(sprites()).toHaveLength(4);
  });

  it('lays the window on the globe at its corners, north up', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image: null });
    const p = meshes()[0].geometry.attributes.position.array;
    const at = (i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
    const toLatLng = ([x, y, z]) => [Math.asin(y / Math.hypot(x, y, z)) / RAD, Math.atan2(x, z) / RAD];
    // The first vertex is the south-west corner, the last the north-east.
    const [slat, slng] = toLatLng(at(0));
    const [nlat, nlng] = toLatLng(at(13 * 13 - 1));
    expect(slat).toBeCloseTo(geometry.bbox.south, 4);
    expect(slng).toBeCloseTo(geometry.bbox.west, 4);
    expect(nlat).toBeCloseTo(geometry.bbox.north, 4);
    expect(nlng).toBeCloseTo(geometry.bbox.east, 4);
    // Just above the surface.
    expect(Math.hypot(...at(0))).toBeGreaterThan(100);
    expect(Math.hypot(...at(0))).toBeLessThan(100.1);
    // The texture's top is north: the last row of vertices has v = 1.
    const uv = meshes()[0].geometry.attributes.uv.array;
    expect(uv[(13 * 13 - 1) * 2 + 1]).toBe(1);
    expect(uv[0]).toBe(0);
  });

  it('draws all four rings, 5, 10, 20 and 30 km, around the middle of the window', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image });
    expect(OVERLAY_RINGS_KM).toEqual([5, 10, 20, 30]);
    expect(OVERLAY_RINGS_KM).toEqual(RING_KM);
    const arcs = canvases[0].calls.filter((c) => c[0] === 'arc');
    expect(arcs.map((a) => a[3])).toEqual(OVERLAY_RINGS_KM.map((km) => (km / (2 * geometry.halfKm)) * CANVAS_PX));
    expect(arcs[0].slice(1, 3)).toEqual([CANVAS_PX / 2, CANVAS_PX / 2]);
    // The 30 km ring is half the window across, inside the picture.
    expect(arcs[3][3]).toBeLessThan(CANVAS_PX / 2);
  });

  it('labels each ring on the ring, to the north, small and the same size on the screen', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image: null });
    const list = sprites();
    expect(list.map((s) => s.userData.km)).toEqual([5, 10, 20, 30]);
    for (const sprite of list) {
      const { x, y, z } = sprite.position;
      const lat = Math.asin(y / Math.hypot(x, y, z)) / RAD;
      const lng = Math.atan2(x, z) / RAD;
      expect(lat).toBeCloseTo(geometry.lat + sprite.userData.km / 111.195, 4);
      expect(lng).toBeCloseTo(geometry.lon, 4);
      // About the size of the map's own labels: 20 screen pixels of an 800 pixel high view, of which the text is 12.
      expect(sprite.material.sizeAttenuation).toBe(false);
      expect(sprite.scale.y * 2.14 * (800 / 2)).toBeCloseTo(LABEL_PX, 5);
      expect(sprite.scale.x).toBeGreaterThan(sprite.scale.y);
      expect(sprite.material.map.image.calls.some((c) => c[0] === 'fillText' && c[1] === `${sprite.userData.km} km`)).toBe(true);
    }
    expect(LABEL_PX).toBeLessThanOrEqual(24);
  });

  it('works out the label size without a renderer, too', () => {
    const bare = { getGlobeRadius: () => 100, scene: () => scene };
    const overlay = setupLightningOverlay(bare);
    overlay.show({ geometry, image: null });
    expect(sprites()[0].scale.y).toBeGreaterThan(0);
    expect(sprites()[0].scale.y).toBeLessThan(0.05);
  });

  it('draws the image in warm colours: orange where weak, dark red where strong, clear where none', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image });
    expect(drawn).toHaveLength(1);
    const px = (i) => [...drawn[0].data.slice(i * 4, i * 4 + 4)];
    const weak = px(0);
    const strong = px(1);
    const none = px(2);
    expect(none[3]).toBe(0);
    // Orange: red high, green in the middle, no blue.
    expect(weak[0]).toBe(255);
    expect(weak[1]).toBeGreaterThan(100);
    expect(weak[2]).toBe(0);
    // Dark red: less red, no green, a little blue, more opaque.
    expect(strong[0]).toBeLessThan(weak[0]);
    expect(strong[1]).toBe(0);
    expect(strong[3]).toBeGreaterThan(weak[3]);
    // Everything that is drawn is clearly visible, and nothing is the pale yellow of the legend.
    for (const p of [weak, strong, px(3)]) {
      expect(p[3]).toBeGreaterThan(100);
      expect(p[2]).toBeLessThan(40);
    }
    // The image is scaled up without smoothing, and the window is all of the canvas.
    const main = canvases.find((c) => c.calls.some((x) => x[0] === 'drawImage'));
    expect(main.calls.some((c) => c[0] === 'drawImage' && c[2] === 0 && c[4] === CANVAS_PX)).toBe(true);
  });

  it('colours every intensity between the weakest and the strongest in order', () => {
    const out = new Uint8ClampedArray(4);
    const colours = [];
    for (let count = 1; count <= MAX_COUNT; count++) {
      paintIntensity(out, 0, count);
      colours.push([...out]);
    }
    for (let i = 1; i < colours.length; i++) {
      expect(colours[i][1]).toBeLessThanOrEqual(colours[i - 1][1]);
      expect(colours[i][3]).toBeGreaterThanOrEqual(colours[i - 1][3]);
    }
    expect(colours.at(-1)[3]).toBeLessThanOrEqual(255);
  });

  it('does nothing again for the same airport and image, and paints for a new image', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image });
    const count = () => canvases[0].calls.length;
    const before = count();
    overlay.show({ geometry, image });
    expect(count()).toBe(before);
    expect(drawn).toHaveLength(1);
    overlay.show({ geometry, image: { ...image } });
    expect(count()).toBeGreaterThan(before);
    expect(drawn).toHaveLength(2);
  });

  it('draws the rings only before the first image is in', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image: null });
    expect(drawn).toHaveLength(0);
    expect(canvases[0].calls.filter((c) => c[0] === 'arc')).toHaveLength(OVERLAY_RINGS_KM.length);
  });

  it('lets go of the mesh, labels, canvases and textures on hide', () => {
    const dispose = vi.spyOn(THREE.Texture.prototype, 'dispose');
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image });
    const sizes = canvases.map((c) => [c.width, c.height]);
    expect(sizes.some(([w]) => w === CANVAS_PX)).toBe(true);
    overlay.hide();
    expect(added).toHaveLength(0);
    // One texture for the picture and one for each label.
    expect(dispose).toHaveBeenCalledTimes(5);
    expect(canvases.every((c) => c.width === 0 && c.height === 0)).toBe(true);
    // Hiding again, or when nothing was shown, is nothing.
    overlay.hide();
    expect(dispose).toHaveBeenCalledTimes(5);
    expect(() => setupLightningOverlay(globe).hide()).not.toThrow();
  });

  it('makes it all again at the next show, drawn afresh', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image });
    overlay.hide();
    const made = canvases.length;
    overlay.show({ geometry, image });
    expect(canvases.length).toBeGreaterThan(made);
    expect(meshes()).toHaveLength(1);
    expect(sprites()).toHaveLength(4);
    expect(meshes()[0].visible).toBe(true);
    expect(drawn).toHaveLength(2);
  });

  it('moves the window when the airport changes, reusing the same mesh and buffers', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image });
    const mesh = meshes()[0];
    const buffer = mesh.geometry.attributes.position.array;
    const other = makeGeometry(40.64, -73.78);
    overlay.show({ geometry: other, image });
    expect(meshes()).toHaveLength(1);
    expect(meshes()[0]).toBe(mesh);
    expect(mesh.geometry.attributes.position.array).toBe(buffer);
    expect(Math.asin(buffer[1] / Math.hypot(buffer[0], buffer[1], buffer[2])) / RAD).toBeCloseTo(other.bbox.south, 4);
    // The labels moved with it.
    const { x, y, z } = sprites()[0].position;
    expect(Math.asin(y / Math.hypot(x, y, z)) / RAD).toBeCloseTo(other.lat + 5 / 111.195, 4);
  });

  it('takes everything away when disposed', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image });
    overlay.dispose();
    expect(added).toHaveLength(0);
  });
});
