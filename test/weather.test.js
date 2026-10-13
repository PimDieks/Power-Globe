import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGrid, buildUrl, chunk, fetchCurrent } from '../src/weather.js';
import { LAYERS, colorFor, normalize, describeWeatherCode } from '../src/layers.js';

describe('buildGrid', () => {
  it('covers the globe at the given step', () => {
    const grid = buildGrid(10);
    expect(grid).toHaveLength(17 * 36);
    expect(grid[0]).toEqual({ lat: -80, lng: -180 });
    expect(grid.at(-1)).toEqual({ lat: 80, lng: 170 });
  });
});

describe('chunk', () => {
  it('splits into groups of at most `size`', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('buildUrl', () => {
  it('requests every layer variable for all points', () => {
    const url = new URL(buildUrl([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]));
    expect(url.searchParams.get('latitude')).toBe('1,3');
    expect(url.searchParams.get('longitude')).toBe('2,4');
    const current = url.searchParams.get('current').split(',');
    for (const layer of LAYERS) expect(current).toContain(layer.variable);
    expect(current).toContain('weather_code');
  });
});

describe('fetchCurrent', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('chunks requests and attaches coordinates', async () => {
    const fetchMock = vi.fn(async (url) => {
      const n = new URL(url).searchParams.get('latitude').split(',').length;
      const body = Array.from({ length: n }, (_, i) => ({ current: { time: 't', temperature_2m: i } }));
      return { ok: true, json: async () => (n === 1 ? body[0] : body) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const points = buildGrid(10).slice(0, 101);
    const result = await fetchCurrent(points);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(101);
    expect(result[100]).toMatchObject({ ...points[100], temperature_2m: 0 });
  });

  it('throws on a failed response', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429 }));
    await expect(fetchCurrent([{ lat: 0, lng: 0 }])).rejects.toThrow('429');
  });
});

describe('colour scales', () => {
  const stops = [
    [0, '#000000'],
    [10, '#ffffff'],
  ];

  it('interpolates and clamps', () => {
    expect(colorFor(stops, -5)).toBe('#000000');
    expect(colorFor(stops, 5)).toBe('#808080');
    expect(colorFor(stops, 50)).toBe('#ffffff');
    expect(colorFor(stops, null)).toBe('#868e96');
  });

  it('normalizes within range', () => {
    expect(normalize(stops, 5)).toBe(0.5);
    expect(normalize(stops, 20)).toBe(1);
  });

  it('describes WMO weather codes', () => {
    expect(describeWeatherCode(0)).toBe('Clear sky');
    expect(describeWeatherCode(1234)).toBe('Unknown');
  });
});
