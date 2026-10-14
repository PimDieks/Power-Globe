import { describe, expect, it, vi } from 'vitest';
import { flightLine } from '../src/trafficlayer.js';

// The real ribbon code, without a browser: three.js builds the buffers without drawing them.
const make = (options = { color: [1, 0.76, 0.28] }) => {
  const added = [];
  const globe = { getGlobeRadius: () => 100, scene: () => ({ add: (o) => added.push(o) }) };
  const line = flightLine(globe, options);
  return { line, added, geometry: line.mesh.geometry };
};
const path = (n) => Float32Array.from({ length: 3 * n }, (_, i) => (i % 3 === 0 ? Math.floor(i / 3) : i % 3 === 1 ? 100 : 0));
const quad = (attribute, segment) => Array.from(attribute.array.slice(4 * segment * attribute.itemSize, 4 * (segment + 1) * attribute.itemSize));

describe('the flight line ribbon', () => {
  it('is added to the scene, hidden until it has a line', () => {
    const { line, added } = make();
    expect(added).toEqual([line.mesh]);
    expect(line.mesh.visible).toBe(false);
    line.set(path(1));
    expect(line.mesh.visible).toBe(false);
    line.set(path(4));
    expect(line.mesh.visible).toBe(true);
    expect(line.mesh.geometry.drawRange.count).toBe(3 * 6);
    line.hide();
    expect(line.mesh.visible).toBe(false);
  });

  it('writes a quad for each segment, with its two ends, the distance along and which side', () => {
    const { line, geometry } = make();
    line.set(path(3));
    const a = geometry.attributes;
    // Segment 1 runs from (1, 100, 0) to (2, 100, 0).
    expect(quad(a.position, 1)).toEqual([1, 100, 0, 1, 100, 0, 2, 100, 0, 2, 100, 0]);
    expect(quad(a.aOther, 1)).toEqual([2, 100, 0, 2, 100, 0, 1, 100, 0, 1, 100, 0]);
    expect(quad(a.aSide, 1)).toEqual([-1, 1, -1, 1]);
    expect(quad(a.aEnd, 1)).toEqual([1, 1, -1, -1]);
    expect(quad(a.aDist, 1)).toEqual([1, 1, 2, 2]);
  });

  it('moves the last point by rewriting, and uploading, only the last segment', () => {
    const { line, geometry } = make();
    line.set(path(5));
    const a = geometry.attributes;
    const before = { position: Array.from(a.position.array), aDist: Array.from(a.aDist.array) };
    line.moveEnd(10, 100, 0);
    // The last of the four segments now ends at x = 10, and its far end's distance along grew with it.
    expect(quad(a.position, 3).slice(6)).toEqual([10, 100, 0, 10, 100, 0]);
    expect(quad(a.aOther, 3).slice(0, 6)).toEqual([10, 100, 0, 10, 100, 0]);
    expect(quad(a.aDist, 3)).toEqual([3, 3, 10, 10]);
    // The others are as they were.
    expect(Array.from(a.position.array.slice(0, 36))).toEqual(before.position.slice(0, 36));
    expect(Array.from(a.aDist.array.slice(0, 12))).toEqual(before.aDist.slice(0, 12));
    // Only that segment's vertices are to be uploaded, for each attribute that changed.
    for (const name of ['position', 'aOther', 'aDist']) {
      expect(a[name].updateRanges, name).toEqual([{ start: 4 * 3 * a[name].itemSize, count: 4 * a[name].itemSize }]);
      expect(a[name].version).toBeGreaterThan(0);
    }
    expect(a.aSide.updateRanges).toEqual([]);
    // Moving again replaces the range rather than piling them up.
    line.moveEnd(11, 100, 0);
    expect(a.position.updateRanges).toHaveLength(1);
  });

  it('moves the first point by rewriting only the first segment, and does nothing without a line', () => {
    const { line, geometry } = make();
    line.moveEnd(1, 2, 3);
    line.moveStart(1, 2, 3);
    line.set(path(4));
    const a = geometry.attributes;
    line.moveStart(-5, 100, 0);
    expect(quad(a.position, 0).slice(0, 6)).toEqual([-5, 100, 0, -5, 100, 0]);
    expect(quad(a.aDist, 0)).toEqual([0, 0, 6, 6]);
    expect(a.position.updateRanges).toEqual([{ start: 0, count: 4 * 3 }]);
  });

  it('uploads everything again when the whole line is set', () => {
    const { line, geometry } = make();
    line.set(path(5));
    line.moveEnd(10, 100, 0);
    line.set(path(5));
    expect(geometry.attributes.position.updateRanges).toEqual([]);
  });

  it('marks the aircraft end as the tip, the last point of one line and the first of the other', () => {
    const end = make({ color: [1, 1, 1], tip: 'end' });
    end.line.set(path(4));
    // Only the far-end vertices of the last segment.
    expect(Array.from(end.geometry.attributes.aTip.array.slice(0, 12))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    end.line.moveEnd(9, 100, 0);
    expect(quad(end.geometry.attributes.aTip, 2)).toEqual([0, 0, 1, 1]);
    const start = make({ color: [1, 1, 1], tip: 'start' });
    start.line.set(path(4));
    expect(Array.from(start.geometry.attributes.aTip.array.slice(0, 12))).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const plain = make();
    plain.line.set(path(4));
    expect(Math.max(...plain.geometry.attributes.aTip.array)).toBe(0);
  });

  it('keeps the gap and the dash for the shader, and dashes only a dashed line', () => {
    const solid = make();
    solid.line.gap = 4.4;
    solid.line.dash = 2;
    expect(solid.line.mesh.material.uniforms.uGap.value).toBe(4.4);
    expect(solid.line.mesh.material.uniforms.uDash.value).toBe(0);
    const dashed = make({ color: [1, 1, 1], dashed: true });
    dashed.line.dash = 2;
    expect(dashed.line.mesh.material.uniforms.uDash.value).toBe(2);
  });

  it('frees the buffers it replaces when the line outgrows them', () => {
    const { line, geometry } = make();
    const disposed = vi.fn();
    geometry.addEventListener('dispose', disposed);
    line.set(path(10));
    const first = geometry.attributes.position;
    const room = first.count / 4;
    line.set(path(room));
    expect(geometry.attributes.position).toBe(first);
    const freed = disposed.mock.calls.length;
    line.set(path(room + 5));
    expect(disposed.mock.calls.length).toBe(freed + 1);
    expect(geometry.attributes.position).not.toBe(first);
    expect(geometry.attributes.position.count / 4).toBeGreaterThan(room);
    expect(geometry.drawRange.count).toBe((room + 4) * 6);
  });
});
