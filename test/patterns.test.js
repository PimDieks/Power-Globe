import { describe, expect, it } from 'vitest';
import { cubicWeights, renderField, sampleGrid, sampleGridCubic, samplingTables } from '../src/field.js';
import { advect, windComponents, windGrids } from '../src/flow.js';
import { classifyHazard, hazardRings } from '../src/patterns.js';

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

describe('bicubic field', () => {
  const shape = { rows: 4, cols: 8, lat0: -60, step: 40 };
  const values = Float32Array.from({ length: 32 }, (_, i) => Math.sin(i) * 20);

  it('has weights that sum to one and hit grid points exactly', () => {
    for (const t of [0, 0.25, 0.5, 0.9]) {
      expect(cubicWeights(t).reduce((a, b) => a + b)).toBeCloseTo(1);
    }
    expect(cubicWeights(0)).toEqual([0, 1, 0, 0]);
    expect(sampleGridCubic(values, shape, -20, -140)).toBeCloseTo(values[1 * 8 + 1], 5);
  });

  it('renders the same values as point sampling', () => {
    const lut = new Uint8ClampedArray(256 * 4).map((_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4)));
    const width = 16;
    const height = 8;
    const out = new Uint8ClampedArray(width * height * 4);
    renderField(values, samplingTables(shape, width, height), lut, -20, 20, out);
    for (const [px, py] of [
      [0, 0],
      [5, 3],
      [15, 7],
    ]) {
      const v = sampleGridCubic(values, shape, 90 - ((py + 0.5) * 180) / height, -180 + ((px + 0.5) * 360) / width);
      const expected = Math.round(Math.min(255, Math.max(0, ((v + 20) * 255) / 40)));
      expect(out[(py * width + px) * 4]).toBe(expected);
    }
  });

  it('leaves pixels transparent where data is missing', () => {
    const lut = new Uint8ClampedArray(4 * 4).fill(255);
    const out = new Uint8ClampedArray(4 * 2 * 4).fill(255);
    renderField(new Float32Array(32).fill(NaN), samplingTables(shape, 4, 2), lut, 0, 1, out);
    expect(out[3]).toBe(0);
  });
});

describe('wind', () => {
  it('converts meteorological direction into flow components', () => {
    // A northerly (from 0°) blows towards the south.
    const [u, v] = windComponents(10, 0);
    expect(u).toBeCloseTo(0);
    expect(v).toBeCloseTo(-10);
    // A westerly (from 270°) blows towards the east.
    expect(windComponents(10, 270)[0]).toBeCloseTo(10);
    expect(windComponents(null, 0)).toEqual([NaN, NaN]);
  });

  it('builds u/v grids per step', () => {
    const [step] = windGrids([[10, 20]], [[270, 180]]);
    expect(step.u[0]).toBeCloseTo(10);
    expect(step.v[1]).toBeCloseTo(20);
  });

  it('advects particles and wraps longitude', () => {
    const [lat, lng] = advect(0, 179, 10, 0, 1, 0.2);
    expect(lat).toBeCloseTo(0);
    expect(lng).toBeCloseTo(-179);
  });

  it('moves faster in longitude near the poles so motion looks even', () => {
    const [, nearEquator] = advect(0, 0, 10, 0, 1, 0.1);
    const [, nearPole] = advect(60, 0, 10, 0, 1, 0.1);
    expect(nearPole).toBeCloseTo(nearEquator * 2);
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
