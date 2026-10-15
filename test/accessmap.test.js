import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { MARKER_PX, setupAccessOverlay, signature } from '../src/accessmap.js';

// A globe with a real three.js scene; nothing is drawn, so no WebGL is needed.
function globe() {
  const scene = new THREE.Scene();
  return { scene: () => scene, getGlobeRadius: () => 100, renderer: () => ({ getPixelRatio: () => 1.5 }) };
}

const segment = (lat, band = 'green') => ({ a: [lat, 4.7], b: [lat + 0.01, 4.71], band });
const shapes = ({ speed = 'green', jam = true } = {}) => ({
  segments: [segment(52.3, speed), segment(52.31), segment(52.32)],
  lines: [...(jam ? [{ kind: 'jam', points: [[52.3, 4.7], [52.31, 4.72], [52.32, 4.74]] }] : []), { kind: 'closure', points: [[52.2, 4.6], [52.21, 4.61]] }, { kind: 'closure', points: [[52.4, 4.8], [52.41, 4.81]] }],
  markers: [{ kind: 'accident', lat: 52.35, lng: 4.75 }],
});

// What is on the map, and a count of disposals by kind (geometry or material).
function watch(g) {
  const disposed = { geometry: 0, material: 0 };
  const objects = () => g.scene().children;
  const track = () => {
    for (const o of objects()) {
      for (const [kind, thing] of [['geometry', o.geometry], ['material', o.material]]) {
        if (thing.userData.watched) continue;
        thing.userData.watched = true;
        thing.addEventListener('dispose', () => disposed[kind]++);
      }
    }
  };
  return { objects, disposed, track };
}

describe('the roads on the map (Access tab)', () => {
  it('gives the same signature for the same shapes, and another when anything changes', () => {
    expect(signature(shapes())).toBe(signature(shapes()));
    expect(signature(shapes({ speed: 'red' }))).not.toBe(signature(shapes()));
    expect(signature(shapes({ jam: false }))).not.toBe(signature(shapes()));
  });

  it('leaves the map as it is when shown the same shapes again', () => {
    const g = globe();
    const overlay = setupAccessOverlay(g);
    const w = watch(g);
    overlay.show(shapes());
    w.track();
    const first = [...w.objects()];
    // Roads, a jam, two closures and the markers.
    expect(first).toHaveLength(5);
    // The trains and the buses come in: the roads' shapes are the same.
    overlay.show(shapes());
    overlay.show(shapes());
    expect(w.objects()).toEqual(first);
    expect(w.disposed).toEqual({ geometry: 0, material: 0 });
  });

  it('draws new shapes in the materials it has, one per style, and frees only the old geometry', () => {
    const g = globe();
    const overlay = setupAccessOverlay(g);
    const w = watch(g);
    overlay.show(shapes());
    w.track();
    const materials = new Set(w.objects().map((o) => o.material));
    // The two closures share one material.
    expect(materials.size).toBe(4);
    overlay.show(shapes({ speed: 'red' }));
    w.track();
    expect(w.objects()).toHaveLength(5);
    expect(w.disposed).toEqual({ geometry: 5, material: 0 });
    expect(new Set(w.objects().map((o) => o.material))).toEqual(materials);
    // The jam is gone: its line goes, its material stays until the overlay is hidden.
    overlay.show(shapes({ jam: false }));
    w.track();
    expect(w.objects()).toHaveLength(4);
    expect(w.disposed).toEqual({ geometry: 10, material: 0 });
  });

  it('lets go of everything, materials too, on hide, and starts afresh after', () => {
    const g = globe();
    const overlay = setupAccessOverlay(g);
    const w = watch(g);
    overlay.show(shapes());
    w.track();
    const before = new Set(w.objects().map((o) => o.material));
    overlay.hide();
    expect(w.objects()).toHaveLength(0);
    expect(w.disposed).toEqual({ geometry: 5, material: 4 });
    // The same shapes after a hide are drawn again, in new materials.
    overlay.show(shapes());
    expect(w.objects()).toHaveLength(5);
    expect(w.objects().some((o) => before.has(o.material))).toBe(false);
    overlay.dispose();
    expect(w.objects()).toHaveLength(0);
  });

  it('sizes the markers by the pixel ratio when drawn, also after it changes with the same shapes on the map', () => {
    const g = globe();
    const overlay = setupAccessOverlay(g);
    overlay.show(shapes());
    const markers = g.scene().children.find((o) => o.isPoints);
    const size = () => markers.material.uniforms.uSize.value;
    markers.onBeforeRender({ getPixelRatio: () => 1.5 });
    expect(size()).toBe(MARKER_PX * 1.5);
    // The window moves to a screen with another ratio; the shapes have not changed.
    overlay.show(shapes());
    expect(g.scene().children.find((o) => o.isPoints)).toBe(markers);
    markers.material.uniformsNeedUpdate = false;
    markers.onBeforeRender({ getPixelRatio: () => 1 });
    expect(size()).toBe(MARKER_PX);
    expect(markers.material.uniformsNeedUpdate).toBe(true);
  });

  it('sends a shared line material its width again for each line it draws', () => {
    const g = globe();
    const overlay = setupAccessOverlay(g);
    overlay.show(shapes());
    const closures = g.scene().children.filter((o) => o.material.dashed);
    expect(closures).toHaveLength(2);
    expect(closures[0].material).toBe(closures[1].material);
    const renderer = { getSize: (v) => v.set(1000, 800) };
    // A camera far out on the airport's side of the globe: the lines are in front.
    const camera = { position: new THREE.Vector3(0, 300, 300) };
    for (const line of closures) {
      line.material.uniformsNeedUpdate = false;
      line.onBeforeRender(renderer, g.scene(), camera);
      expect(line.material.uniformsNeedUpdate).toBe(true);
      expect(line.material.linewidth).toBe(4);
    }
  });
});
