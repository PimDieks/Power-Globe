import { describe, expect, it } from 'vitest';
import { needsNewRegion, regionFor, viewBounds } from '../src/detail.js';
import { labelTier } from '../src/cities.js';
import { shapePoints } from '../src/weather.js';

describe('viewBounds', () => {
  it('shrinks as the camera zooms in and widens towards the poles', () => {
    const far = viewBounds({ lat: 0, lng: 0, altitude: 1 });
    const near = viewBounds({ lat: 0, lng: 0, altitude: 0.2 });
    expect(near.north - near.south).toBeLessThan(far.north - far.south);
    expect(viewBounds({ lat: 60, lng: 0, altitude: 0.2 }).span).toBeGreaterThan(near.span);
  });

  it('is centred on the view and stays clear of the poles', () => {
    const b = viewBounds({ lat: 80, lng: 10, altitude: 0.5 });
    expect(b.north).toBe(85);
    expect(b.west + b.span / 2).toBeCloseTo(10);
  });
});

describe('regionFor', () => {
  it('keeps requests within the location budget', () => {
    for (const altitude of [0.05, 0.2, 0.5, 1]) {
      for (const lat of [0, 52, -70]) {
        const { shape } = regionFor(viewBounds({ lat, lng: 5, altitude }, 1.8));
        expect(shape.rows * shape.cols).toBeLessThanOrEqual(150);
        expect(shapePoints(shape)).toHaveLength(shape.rows * shape.cols);
      }
    }
  });

  it('covers the requested area with a grid snapped to its step', () => {
    const want = viewBounds({ lat: 52.4, lng: 4.9, altitude: 0.3 });
    const { shape, bounds } = regionFor(want);
    expect(bounds.south).toBeLessThanOrEqual(want.south);
    expect(bounds.north).toBeGreaterThanOrEqual(want.north);
    expect(bounds.west).toBeLessThanOrEqual(want.west);
    expect(bounds.west + bounds.span).toBeGreaterThanOrEqual(want.west + want.span);
    expect(shape.lat0 % shape.step).toBeCloseTo(0);
    expect(shape.wrap).toBe(false);
  });

  it('gets finer as the view zooms in', () => {
    const far = regionFor(viewBounds({ lat: 52, lng: 5, altitude: 1 }));
    const near = regionFor(viewBounds({ lat: 52, lng: 5, altitude: 0.1 }));
    expect(near.shape.step).toBeLessThan(far.shape.step);
  });
});

describe('needsNewRegion', () => {
  const pov = { lat: 52, lng: 5, altitude: 0.4 };
  const region = regionFor(viewBounds(pov));

  it('keeps the region for small moves', () => {
    expect(needsNewRegion(null, pov)).toBe(true);
    expect(needsNewRegion(region, pov)).toBe(false);
    expect(needsNewRegion(region, { ...pov, lng: 6 })).toBe(false);
  });

  it('follows the view when it pans away or zooms a lot', () => {
    expect(needsNewRegion(region, { ...pov, lng: 30 })).toBe(true);
    expect(needsNewRegion(region, { ...pov, altitude: 0.1 })).toBe(true);
    expect(needsNewRegion(region, { ...pov, altitude: 0.9 })).toBe(true);
  });
});

describe('labelTier', () => {
  it('labels more cities as the view zooms in', () => {
    expect(labelTier(2.4)).toBe(0);
    expect(labelTier(1.2)).toBe(1);
    expect(labelTier(0.6)).toBe(2);
    expect(labelTier(0.2)).toBe(3);
  });
});
