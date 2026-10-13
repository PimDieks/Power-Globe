import { describe, expect, it } from 'vitest';
import { sampleGrid } from '../src/field.js';
import { classifyHazard, destination, hazardRings, windStreaks } from '../src/patterns.js';

describe('sampleGrid', () => {
  // 2 rows (lat 0 and 10) x 4 columns (lng -180, -90, 0, 90).
  const shape = { rows: 2, cols: 4, lat0: 0, step: 90 };
  const tall = { rows: 2, cols: 4, lat0: 0, step: 10 };
  const values = [0, 10, 20, 30, 100, 110, 120, 130];

  it('returns grid values at grid points', () => {
    expect(sampleGrid(values, shape, 0, -180)).toBe(0);
    expect(sampleGrid(values, shape, 0, 0)).toBe(20);
  });

  it('interpolates between columns and wraps across the date line', () => {
    expect(sampleGrid(values, shape, 0, -135)).toBe(5);
    // Halfway between lng 90 (30) and lng 180 = -180 (0).
    expect(sampleGrid(values, shape, 0, 135)).toBe(15);
  });

  it('interpolates between rows and clamps beyond the outer rows', () => {
    expect(sampleGrid(values, tall, 5, -180)).toBe(50);
    expect(sampleGrid(values, tall, 60, -180)).toBe(100);
    expect(sampleGrid(values, tall, -60, -180)).toBe(0);
  });

  it('yields NaN when a neighbour is missing', () => {
    expect(sampleGrid([null, 10, 20, 30, 100, 110, 120, 130], shape, 0, -135)).toBeNaN();
  });
});

describe('destination', () => {
  it('moves north along a meridian', () => {
    const p = destination(0, 0, 0, 10);
    expect(p.lat).toBeCloseTo(10);
    expect(p.lng).toBeCloseTo(0);
  });

  it('moves east along the equator and wraps longitude', () => {
    const p = destination(0, 175, 90, 10);
    expect(p.lat).toBeCloseTo(0);
    expect(p.lng).toBeCloseTo(-175);
  });
});

describe('windStreaks', () => {
  const points = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 10 },
    { lat: 0, lng: 20 },
  ];

  it('points downwind and skips calm or missing wind', () => {
    // A northerly (from 0°) blows towards the south.
    const streaks = windStreaks(points, [20, 1, null], [0, 0, 0]);
    expect(streaks).toHaveLength(1);
    const [start, end] = streaks[0].points;
    expect(start).toBe(points[0]);
    expect(end.lat).toBeCloseTo(-4);
    expect(end.lng).toBeCloseTo(0);
  });

  it('caps the streak length', () => {
    const [streak] = windStreaks(points.slice(0, 1), [500], [270]);
    expect(streak.points[1].lng).toBeCloseTo(9);
  });
});

describe('hazards', () => {
  it('classifies severe weather', () => {
    expect(classifyHazard(95, 0)).toBe('storm');
    expect(classifyHazard(75, 0)).toBe('snow');
    expect(classifyHazard(65, 0)).toBe('rain');
    expect(classifyHazard(61, 3)).toBe('rain');
    expect(classifyHazard(61, 1)).toBeNull();
    expect(classifyHazard(0, null)).toBeNull();
  });

  it('builds rings only where there is a hazard', () => {
    const points = [
      { lat: 1, lng: 2 },
      { lat: 3, lng: 4 },
    ];
    expect(hazardRings(points, [0, 99], [0, 0])).toEqual([{ lat: 3, lng: 4, kind: 'storm' }]);
  });
});
