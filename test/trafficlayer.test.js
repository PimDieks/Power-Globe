import { describe, expect, it, vi } from 'vitest';
import { PointCloud } from '../src/trafficlayer.js';
import { aircraftRanges } from '../src/traffic.js';
import { estimatePosition } from '../src/aircraft.js';

const globe = { scene: () => ({ add() {} }) };
const ranges = (attribute) => attribute.updateRanges.map(({ start, count }) => [start, count]);

describe('a cloud of points', () => {
  it('frees the buffers it replaces when it grows', () => {
    const cloud = new PointCloud(globe, {}, { aColor: 3 }, 0);
    cloud.reserve(10);
    const dispose = vi.spyOn(cloud.geometry, 'dispose');
    cloud.reserve(100);
    expect(cloud.capacity).toBe(256);
    expect(dispose).not.toHaveBeenCalled();
    cloud.reserve(1000);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(cloud.geometry.attributes.position.array).toHaveLength(1000 * 3);
  });

  it('uploads every attribute whole by default', () => {
    const cloud = new PointCloud(globe, {}, { aColor: 3, aScale: 1 }, 0);
    cloud.reserve(500);
    const before = cloud.geometry.attributes.aScale.version;
    cloud.commit(400);
    const { position, aColor, aScale } = cloud.geometry.attributes;
    expect(ranges(position)).toEqual([[0, 1200]]);
    expect(ranges(aColor)).toEqual([[0, 1200]]);
    expect(ranges(aScale)).toEqual([[0, 400]]);
    expect(aScale.version).toBe(before + 1);
  });

  it('uploads only the attributes and points written', () => {
    const cloud = new PointCloud(globe, {}, { aColor: 3, aScale: 1 }, 0);
    cloud.reserve(500);
    const { position, aColor, aScale } = cloud.geometry.attributes;
    const colours = aColor.version;
    cloud.commit(400, { changed: ['position'], ranges: aircraftRanges(350, 100, 400) });
    expect(ranges(position)).toEqual([
      [1050, 150],
      [0, 150],
    ]);
    expect(aColor.version).toBe(colours);
    expect(ranges(aScale)).toEqual([]);
  });

  it('uploads nothing for no points, as an empty range would mean the whole buffer', () => {
    const cloud = new PointCloud(globe, {}, { aScale: 1 }, 0);
    cloud.reserve(500);
    const { position, aScale } = cloud.geometry.attributes;
    const versions = [position.version, aScale.version];
    cloud.commit(0);
    cloud.commit(0, { changed: ['position'], ranges: aircraftRanges(0, 0, 0) });
    expect([position.version, aScale.version]).toEqual(versions);
    expect(ranges(position)).toEqual([]);
    expect(cloud.count).toBe(0);
  });

  it('keeps the ranges of commits not drawn yet, up to a point', () => {
    const cloud = new PointCloud(globe, {}, {}, 0);
    cloud.reserve(5000);
    const { position } = cloud.geometry.attributes;
    cloud.commit(4000, { changed: ['position'], ranges: [[0, 2000]] });
    cloud.commit(4000, { changed: ['position'], ranges: [[2000, 2000]] });
    expect(ranges(position)).toEqual([
      [0, 6000],
      [6000, 6000],
    ]);
    // Never drawn (the pilot view covers the globe): past a few, it is uploaded whole.
    for (let k = 0; k < 20; k++) cloud.commit(4000, { changed: ['position'], ranges: [[k * 100, 100]] });
    expect(ranges(position).length).toBeLessThanOrEqual(16);
    expect(ranges(position)).toContainEqual([0, 12_000]);
  });
});

describe('the aircraft moved in a frame', () => {
  it('are one range, or two where the slice wraps round to the start', () => {
    expect(aircraftRanges(0, 0, 0)).toEqual([]);
    expect(aircraftRanges(0, 2000, 9000)).toEqual([[0, 2000]]);
    expect(aircraftRanges(7000, 2000, 9000)).toEqual([[7000, 2000]]);
    expect(aircraftRanges(8000, 2000, 9000)).toEqual([
      [8000, 1000],
      [0, 1000],
    ]);
  });

  it('have their estimates written into the object they already have', () => {
    const ac = { lat: 52, lng: 4, speedKt: 450, track: 90, seen: 0, onGround: false };
    const out = { lat: 0, lng: 0 };
    expect(estimatePosition(ac, 60_000, out)).toBe(out);
    expect(out).toEqual(estimatePosition(ac, 60_000));
    expect(estimatePosition({ ...ac, onGround: true }, 60_000, out)).toBe(out);
    expect(out).toEqual({ lat: 52, lng: 4 });
  });
});
