import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildGrid, buildUrl, chunk, fetchHourly, gridShape, startIndex, toForecast } from '../src/weather.js';
import { LAYERS, VARIABLES, buildLut, colorFor, normalize, describeWeatherCode } from '../src/layers.js';

describe('buildGrid', () => {
  it('covers the globe at the given step', () => {
    const grid = buildGrid(10);
    expect(grid).toHaveLength(17 * 36);
    expect(grid[0]).toEqual({ lat: -80, lng: -180 });
    expect(grid.at(-1)).toEqual({ lat: 80, lng: 170 });
  });

  it('matches gridShape', () => {
    const { rows, cols } = gridShape(10);
    expect(rows * cols).toBe(buildGrid(10).length);
    expect(buildGrid(10)[cols]).toEqual({ lat: -70, lng: -180 });
  });
});

describe('chunk', () => {
  it('splits into groups of at most `size`', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('buildUrl', () => {
  it('requests every needed hourly variable for all points', () => {
    const url = new URL(buildUrl([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }]));
    expect(url.searchParams.get('latitude')).toBe('1,3');
    expect(url.searchParams.get('longitude')).toBe('2,4');
    expect(url.searchParams.get('forecast_days')).toBe('5');
    const hourly = url.searchParams.get('hourly').split(',');
    for (const layer of LAYERS) expect(hourly).toContain(layer.variable);
    expect(hourly).toEqual(expect.arrayContaining(['weather_code', 'wind_direction_10m']));
  });
});

const fakeHourly = (n, offset = 0) => ({
  time: Array.from({ length: n }, (_, i) => `2026-10-13T${String(i).padStart(2, '0')}:00`),
  ...Object.fromEntries(VARIABLES.map((v) => [v, Array.from({ length: n }, (_, i) => i + offset + 0.04)])),
});

describe('fetchHourly', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('chunks requests and keeps point order', async () => {
    const fetchMock = vi.fn(async (url) => {
      const lats = new URL(url).searchParams.get('latitude').split(',');
      const body = lats.map((lat) => ({ hourly: fakeHourly(2, Number(lat)) }));
      return { ok: true, json: async () => (body.length === 1 ? body[0] : body) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const points = buildGrid(10).slice(0, 101);
    const result = await fetchHourly(points);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(101);
    expect(result[100].temperature_2m[0]).toBeCloseTo(points[100].lat + 0.04);
  });

  it('throws on a failed response', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429 }));
    await expect(fetchHourly([{ lat: 0, lng: 0 }])).rejects.toThrow('429');
  });
});

describe('toForecast', () => {
  it('keeps every nth hour and indexes values by [time][point]', () => {
    const points = [
      { lat: 0, lng: 0 },
      { lat: 10, lng: 0 },
    ];
    const forecast = toForecast(points, [fakeHourly(7), fakeHourly(7, 100)], 3);
    expect(forecast.times).toEqual(['2026-10-13T00:00', '2026-10-13T03:00', '2026-10-13T06:00']);
    expect(forecast.values.temperature_2m).toEqual([
      [0, 100],
      [3, 103],
      [6, 106],
    ]);
    expect(forecast.points).toBe(points);
  });

  it('keeps missing values as null', () => {
    const hourly = fakeHourly(1);
    hourly.precipitation = [null];
    expect(toForecast([{ lat: 0, lng: 0 }], [hourly], 3).values.precipitation).toEqual([[null]]);
  });
});

describe('startIndex', () => {
  const times = ['2026-10-13T00:00', '2026-10-13T03:00', '2026-10-13T06:00'];

  it('picks the last step at or before now', () => {
    expect(startIndex(times, Date.parse('2026-10-13T04:30Z'))).toBe(1);
    expect(startIndex(times, Date.parse('2026-10-13T06:00Z'))).toBe(2);
  });

  it('falls back to the first step', () => {
    expect(startIndex(times, Date.parse('2026-10-12T12:00Z'))).toBe(0);
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

  it('builds a lookup table spanning the range', () => {
    const lut = buildLut(stops, 3);
    expect([...lut]).toEqual([0, 0, 0, 128, 128, 128, 255, 255, 255]);
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
