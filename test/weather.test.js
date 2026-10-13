import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiBudget,
  buildGrid,
  buildUrl,
  chunk,
  fetchHourly,
  gridShape,
  precipitationRate,
  resetApiBudget,
  shapePoints,
  startIndex,
  toForecast,
} from '../src/weather.js';
import { LAYERS, VARIABLES, buildLut, colorFor, normalize, describeWeatherCode } from '../src/layers.js';

describe('buildGrid', () => {
  it('covers the globe at the given step', () => {
    const grid = buildGrid(10);
    expect(grid).toHaveLength(17 * 36);
    expect(grid[0]).toEqual({ lat: -80, lng: -180 });
    expect(grid.at(-1)).toEqual({ lat: 80, lng: 170 });
  });

  it('stays under the free API limit of 600 locations at the default step', () => {
    expect(gridShape()).toEqual({ step: 12, lat0: -72, lng0: -180, rows: 13, cols: 30, wrap: true });
    expect(buildGrid()).toHaveLength(390);
  });

  it('matches gridShape', () => {
    const { rows, cols } = gridShape(10);
    expect(rows * cols).toBe(buildGrid(10).length);
    expect(buildGrid(10)[cols]).toEqual({ lat: -70, lng: -180 });
  });
});

describe('shapePoints', () => {
  it('normalizes longitudes for regions crossing the date line', () => {
    const points = shapePoints({ step: 5, lat0: 40, lng0: 170, rows: 1, cols: 3 });
    expect(points.map((p) => p.lng)).toEqual([170, 175, -180]);
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
    expect(url.searchParams.has('temporal_resolution')).toBe(false);
  });

  it('can ask for 3-hourly aggregation', () => {
    const url = new URL(buildUrl([{ lat: 1, lng: 2 }], { threeHourly: true }));
    expect(url.searchParams.get('temporal_resolution')).toBe('hourly_3');
  });
});

const fakeHourly = (n, offset = 0) => ({
  time: Array.from({ length: n }, (_, i) => `2026-10-13T${String(i).padStart(2, '0')}:00`),
  ...Object.fromEntries(VARIABLES.map((v) => [v, Array.from({ length: n }, (_, i) => i + offset + 0.04)])),
});

describe('fetchHourly', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiBudget();
  });

  it('counts requested locations against the free API limits', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ hourly: fakeHourly(1) }) }));
    const now = Date.now();
    expect(apiBudget(now)).toBe(600);
    await fetchHourly(buildGrid(10).slice(0, 150));
    expect(apiBudget(now)).toBe(450);
    // The per-minute allowance recovers; the hourly one (5,000) is far from used up.
    expect(apiBudget(now + 61_000)).toBe(600);
  });

  it('never has more than one request in flight', async () => {
    let inFlight = 0;
    let most = 0;
    vi.stubGlobal('fetch', async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { ok: true, json: async () => ({ hourly: fakeHourly(1) }) };
    });
    await Promise.all([
      fetchHourly(buildGrid(10).slice(0, 250)),
      fetchHourly([{ lat: 1, lng: 2 }]),
      fetchHourly([{ lat: 3, lng: 4 }]),
    ]);
    expect(most).toBe(1);
  });

  it('retries when the API is busy with another request, without pausing', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', async () =>
      ++calls === 1
        ? { ok: false, status: 429, json: async () => ({ reason: 'Too many concurrent requests' }) }
        : { ok: true, json: async () => ({ hourly: fakeHourly(1) }) },
    );
    const result = fetchHourly([{ lat: 0, lng: 0 }]);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(result).resolves.toHaveLength(1);
    expect(calls).toBe(2);
    expect(apiBudget()).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it('pauses after the API reports a rate limit', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 429,
      json: async () => ({ reason: 'Minutely API request limit exceeded' }),
    }));
    await expect(fetchHourly([{ lat: 0, lng: 0 }])).rejects.toThrow('429');
    expect(apiBudget()).toBe(0);
    expect(apiBudget(Date.now() + 61_000)).toBeGreaterThan(0);
  });

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

  it('reports progress per chunk', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ hourly: fakeHourly(1) }) }));
    const progress = [];
    await fetchHourly(buildGrid(10).slice(0, 250), { onProgress: (done, total) => progress.push([done, total]) });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('surfaces the API reason on a failed response', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: true, reason: 'Minutely API request limit exceeded' }),
    }));
    await expect(fetchHourly([{ lat: 0, lng: 0 }])).rejects.toThrow(
      'Open-Meteo: Minutely API request limit exceeded (429)',
    );
  });

  it('reports network failures instead of hanging', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    await expect(fetchHourly([{ lat: 0, lng: 0 }])).rejects.toThrow('did not respond in time');
  });

  it('falls back to hourly data if 3-hourly aggregation is rejected', async () => {
    const fetchMock = vi.fn(async (url) =>
      url.includes('temporal_resolution')
        ? { ok: false, status: 400, json: async () => ({ error: true, reason: 'unknown parameter' }) }
        : { ok: true, json: async () => ({ hourly: fakeHourly(1) }) },
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchHourly([{ lat: 0, lng: 0 }], { threeHourly: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
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

  it('keeps every step of data the API already aggregated to 3 hours', () => {
    const hourly = {
      ...fakeHourly(3),
      time: ['2026-10-13T00:00', '2026-10-13T03:00', '2026-10-13T06:00'],
    };
    expect(toForecast([{ lat: 0, lng: 0 }], [hourly], 3).values.temperature_2m).toEqual([[0], [1], [2]]);
  });

  it('keeps missing values as null', () => {
    const hourly = fakeHourly(1);
    hourly.precipitation = [null];
    expect(toForecast([{ lat: 0, lng: 0 }], [hourly], 3).values.precipitation).toEqual([[null]]);
    const threeHourly = { ...fakeHourly(2), time: ['2026-10-13T00:00', '2026-10-13T03:00'] };
    threeHourly.precipitation = [null, 6];
    expect(toForecast([{ lat: 0, lng: 0 }], [threeHourly], 3).values.precipitation).toEqual([[null], [2]]);
  });
});

describe('precipitation as a rate', () => {
  // Hourly totals (mm) from 00:00 to 06:00.
  const hourlyRain = [0, 1, 2, 3, 0, 0, 6];

  it('averages the 3 hours up to the time shown', () => {
    expect(precipitationRate(hourlyRain, 3)).toBe(2);
    expect(precipitationRate(hourlyRain, 6)).toBe(2);
    // At the start of the series only the hours available count.
    expect(precipitationRate(hourlyRain, 0)).toBe(0);
    expect(precipitationRate([null, null], 1)).toBeNull();
  });

  it('gives the same number on the map whether the API sent hourly or 3-hour data', () => {
    const point = [{ lat: 0, lng: 0 }];
    const hourly = { ...fakeHourly(7), precipitation: hourlyRain };
    // What Open-Meteo returns aggregated to 3 hours: totals of the 3 hours up to each time.
    const threeHourly = {
      ...fakeHourly(3),
      time: ['2026-10-13T00:00', '2026-10-13T03:00', '2026-10-13T06:00'],
      precipitation: [0, 6, 6],
    };
    const fromHourly = toForecast(point, [hourly], 3).values.precipitation;
    const fromThreeHourly = toForecast(point, [threeHourly], 3).values.precipitation;
    expect(fromHourly.slice(1)).toEqual([[2], [2]]);
    expect(fromThreeHourly.slice(1)).toEqual(fromHourly.slice(1));
    // And the details panel, which uses the hourly series, agrees.
    expect(precipitationRate(hourlyRain, 3)).toBe(fromThreeHourly[1][0]);
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

  it('builds an RGBA lookup table spanning the range', () => {
    const lut = buildLut({ stops }, 3);
    expect([...lut]).toEqual([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
  });

  it('fades the lookup table in across the fade range', () => {
    const alpha = [...buildLut({ stops, fade: [0, 10] }, 3)].filter((_, i) => i % 4 === 3);
    expect(alpha).toEqual([0, 128, 255]);
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

describe('limitPause', () => {
  it('waits for the next day after the daily limit, an hour after the hourly one', async () => {
    const { limitPause } = await import('../src/weather.js');
    const now = Date.UTC(2026, 9, 13, 18, 0);
    expect(limitPause('Daily API request limit exceeded. Please try again tomorrow.', now)).toBe(6 * 3_600_000);
    expect(limitPause('Hourly API request limit exceeded.', now)).toBe(3_600_000);
    expect(limitPause('Minutely API request limit exceeded.', now)).toBe(60_000);
  });
});
