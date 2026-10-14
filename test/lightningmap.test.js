import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CANVAS_PX, OVERLAY_RINGS_KM, setupLightningOverlay } from '../src/lightningmap.js';
import { makeGeometry } from '../src/lightning.js';

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
  const globe = { getGlobeRadius: () => 100, scene: () => ({ add: (m) => added.push(m), remove: (m) => added.splice(added.indexOf(m), 1) }) };
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
  afterEach(() => vi.unstubAllGlobals());

  const geometry = makeGeometry(52.31, 4.76);
  const image = { width: 160, height: 160, data: new Uint8ClampedArray(160 * 160 * 4) };

  it('adds one hidden mesh over the weather and under the runways', () => {
    setupLightningOverlay(globe);
    expect(added).toHaveLength(1);
    expect(added[0].visible).toBe(false);
    expect(added[0].renderOrder).toBe(4);
  });

  it('lays the window on the globe at its corners, north up', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image: null });
    expect(added[0].visible).toBe(true);
    const p = added[0].geometry.attributes.position.array;
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
    const uv = added[0].geometry.attributes.uv.array;
    expect(uv[(13 * 13 - 1) * 2 + 1]).toBe(1);
    expect(uv[0]).toBe(0);
  });

  it('draws the 5, 10 and 20 km rings, and the image scaled up without smoothing', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image });
    const main = canvases[0];
    const arcs = main.calls.filter((c) => c[0] === 'arc');
    // One circle for each, stroked as a dark edge and a light line.
    expect(arcs.map((a) => a[3])).toEqual(OVERLAY_RINGS_KM.map((km) => (km / (2 * geometry.halfKm)) * CANVAS_PX));
    expect(arcs[0].slice(1, 3)).toEqual([CANVAS_PX / 2, CANVAS_PX / 2]);
    expect(main.calls.some((c) => c[0] === 'drawImage' && c[2] === 0 && c[4] === CANVAS_PX)).toBe(true);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].data).toBe(image.data);
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

  it('draws rings only before the first image is in', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image: null });
    expect(drawn).toHaveLength(0);
    expect(canvases[0].calls.filter((c) => c[0] === 'arc')).toHaveLength(OVERLAY_RINGS_KM.length);
  });

  it('hides, and draws afresh after being hidden', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image });
    overlay.hide();
    expect(added[0].visible).toBe(false);
    const before = canvases[0].calls.length;
    overlay.show({ geometry, image });
    expect(added[0].visible).toBe(true);
    expect(canvases[0].calls.length).toBeGreaterThan(before);
  });

  it('moves the window when the airport changes, reusing the same mesh and buffers', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.show({ geometry, image });
    const mesh = added[0];
    const buffer = mesh.geometry.attributes.position.array;
    const other = makeGeometry(40.64, -73.78);
    overlay.show({ geometry: other, image });
    expect(added).toHaveLength(1);
    expect(added[0]).toBe(mesh);
    expect(mesh.geometry.attributes.position.array).toBe(buffer);
    const p = buffer;
    expect(Math.asin(p[1] / Math.hypot(p[0], p[1], p[2])) / RAD).toBeCloseTo(other.bbox.south, 4);
  });

  it('takes the mesh away when disposed', () => {
    const overlay = setupLightningOverlay(globe);
    overlay.dispose();
    expect(added).toHaveLength(0);
  });
});
