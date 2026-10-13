import { describe, expect, it, vi } from 'vitest';
import { corsHeaders, route } from '../api/worker.js';
import { ceilingFt, flightCategory, toObservation, visibilityMiles } from '../src/metar.js';
import { bearingBetween, destination, runwayEnds, runwayStatus } from '../src/runwaymap.js';
import { conditionsAt, snapshotSeries, toAirport } from '../src/airports.js';
import { assessVariable, observationHtml } from '../src/airportview.js';
import { airportsInView, metresPerPixel } from '../src/airportmap.js';

const LIMITS = { crosswind: 25, tailwind: 10 };
const SCHIPHOL = toAirport([
  'EHAM', 'AMS', 'Amsterdam Airport Schiphol', 'Amsterdam', 'NL', 52.3086, 4.7639, -11, 1, 1,
  [['18R', 183, '36L', 3, 12467, 'ASP', 198, 52.3627, 4.71193, 52.3286, 4.70884], ['09', 87, '27', 267, 11329, 'ASP', 148]],
]);

const reply = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), init);

describe('Power Globe API (worker)', () => {
  it('serves flights in an area from the first ADS-B feed that answers, snapped for caching', async () => {
    const fetchFn = vi.fn(async (url) => (url.includes('adsb.lol') ? reply('down', { status: 503 }) : reply({ ac: [{ hex: 'abc' }] })));
    const res = await route(new URL('https://api.example/flights/area?lat=52.31&lon=4.76&nm=40'), {}, fetchFn);
    const body = await res.json();
    expect(body.source).toBe('airplanes.live');
    expect(body.data.ac).toHaveLength(1);
    expect(fetchFn.mock.calls[1][0]).toBe('https://api.airplanes.live/v2/point/52.25/4.75/50');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=10');
  });

  it('serves METARs and satellites, and checks what it is asked', async () => {
    const fetchFn = vi.fn(async (url) => (url.includes('aviationweather') ? reply('[{"icaoId":"EHAM"}]') : reply('ISS\n1 25544U\n2 25544\n')));
    expect(await (await route(new URL('https://api.example/metar?ids=eham'), {}, fetchFn)).json()).toEqual([{ icaoId: 'EHAM' }]);
    expect(fetchFn.mock.calls[0][0]).toContain('ids=EHAM');
    expect(await (await route(new URL('https://api.example/satellites/stations'), {}, fetchFn)).text()).toContain('25544');
    await expect(route(new URL('https://api.example/metar?ids=EHAM;DROP'), {}, fetchFn)).rejects.toMatchObject({ status: 400 });
    await expect(route(new URL('https://api.example/satellites/secret'), {}, fetchFn)).rejects.toMatchObject({ status: 404 });
    await expect(route(new URL('https://api.example/flights/area?lat=99&lon=0&nm=10'), {}, fetchFn)).rejects.toMatchObject({ status: 400 });
  });

  it('lets only the listed sites use it', () => {
    expect(corsHeaders('https://pimdieks.github.io')['Access-Control-Allow-Origin']).toBe('https://pimdieks.github.io');
    expect(corsHeaders('https://elsewhere.example')).toEqual({});
    expect(corsHeaders('https://elsewhere.example', { ALLOWED_ORIGINS: '*' })['Access-Control-Allow-Origin']).toBe('*');
  });
});

describe('METAR', () => {
  it('reads visibility, ceiling and flight category', () => {
    expect(visibilityMiles('10+')).toBe(10);
    expect(visibilityMiles('1 1/2')).toBe(1.5);
    expect(visibilityMiles('3/4')).toBe(0.75);
    expect(ceilingFt([{ cover: 'FEW', base: 800 }, { cover: 'BKN', base: 1200 }, { cover: 'OVC', base: 3000 }])).toBe(1200);
    expect(ceilingFt([{ cover: 'SCT', base: 500 }])).toBeNull();
    expect(flightCategory(null, 10)).toBe('VFR');
    expect(flightCategory(2500, 10)).toBe('MVFR');
    expect(flightCategory(800, 10)).toBe('IFR');
    expect(flightCategory(null, 0.5)).toBe('LIFR');
  });

  it('turns an Aviation Weather Center report into an observation', () => {
    const o = toObservation({ rawOb: 'EHAM 131425Z 25018G31KT 9999 BKN012 12/09 Q1008', obsTime: 1760365500, temp: 12, dewp: 9, wdir: 250, wspd: 18, wgst: 31, visib: '6+', clouds: [{ cover: 'BKN', base: 1200 }] });
    expect(o).toMatchObject({ direction: 250, speed: 18, gust: 31, ceiling: 1200, visibility: 6, category: 'MVFR', variable: false });
    expect(toObservation({ wdir: 'VRB', wspd: 3 })).toMatchObject({ direction: null, variable: true });
  });

  it('judges the runways in the observed wind', () => {
    const html = observationHtml(SCHIPHOL, toObservation({ rawOb: 'EHAM ...', obsTime: 1_760_000_000, wdir: 270, wspd: 20, wgst: 28, visib: 10, fltCat: 'VFR' }), LIMITS, 1_760_000_000_000 + 30 * 60_000);
    expect(html).toContain('30 min ago');
    expect(html).toContain('Within limits');
    expect(html).toContain('VFR');
    expect(observationHtml(SCHIPHOL, { error: 'blocked' }, LIMITS)).toContain('could not be loaded');
    expect(assessVariable(SCHIPHOL, { speed: 12, gust: null }, LIMITS).status).toBe('nogo');
  });
});

describe('runways on the map', () => {
  it('uses the thresholds from the data, else lays the runway out from the airport', () => {
    expect(runwayEnds(SCHIPHOL, SCHIPHOL.runways[0])).toEqual([
      { lat: 52.3627, lng: 4.71193 },
      { lat: 52.3286, lng: 4.70884 },
    ]);
    const [a, b] = runwayEnds(SCHIPHOL, SCHIPHOL.runways[1]);
    expect(bearingBetween(a, b)).toBeCloseTo(87, 0);
    // 11,329 ft is about 3.45 km.
    const km = Math.hypot((b.lat - a.lat) * 111.2, (b.lng - a.lng) * 111.2 * Math.cos(52.3 * (Math.PI / 180)));
    expect(km).toBeCloseTo(3.45, 1);
  });

  it('goes where it is pointed', () => {
    const p = destination({ lat: 0, lng: 0 }, 90, 111_195);
    expect(p.lat).toBeCloseTo(0, 6);
    expect(p.lng).toBeCloseTo(1, 3);
  });

  it('colours a runway by its better direction', () => {
    const rw = SCHIPHOL.runways[1];
    expect(runwayStatus(rw, new Map([['09', 'nogo'], ['27', 'ok']]))).toBe('ok');
    expect(runwayStatus(rw, new Map([['09', 'nogo'], ['27', 'caution']]))).toBe('caution');
    expect(runwayStatus(rw, new Map())).toBe('unknown');
  });

  it('finds the airports in view, nearest first', () => {
    const near = { ...SCHIPHOL, ident: 'NEAR', lat: 52.31, lng: 4.77 };
    const far = { ...SCHIPHOL, ident: 'FAR', lat: 40, lng: -74 };
    expect(airportsInView([far, SCHIPHOL, near], { lat: 52.31, lng: 4.77, altitude: 0.02 }, 1.5).map((a) => a.ident)).toEqual(['NEAR', 'EHAM']);
    // About 30 m per pixel at 25 km up on an 800 px tall screen.
    expect(metresPerPixel(0.004, 800)).toBeCloseTo(29.7, 0);
  });
});

describe('the site\'s own airport weather', () => {
  const snapshot = snapshotSeries({
    built: '2026-10-13T12:00:00Z',
    times: ['2026-10-13T12:00', '2026-10-13T15:00', '2026-10-13T18:00'],
    variables: ['temperature_2m', 'dew_point_2m', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m'],
    airports: { EHAM: [[12, 13, 11], [9, 9, 8], [18, 22, 15], [250, 260, 270], [30, 35, 25]] },
  });

  it('gives series like Open-Meteo\'s', () => {
    const series = snapshot.get('EHAM');
    expect(series.wind_gusts_10m).toEqual([30, 35, 25]);
    expect(snapshot.get('XXXX')).toBeNull();
    expect(snapshot.built).toBe(Date.parse('2026-10-13T12:00:00Z'));
  });

  it('finds the conditions for times between its three-hourly steps', () => {
    const series = snapshot.get('EHAM');
    expect(conditionsAt(series, '2026-10-13T15:00').speed).toBe(22);
    expect(conditionsAt(series, '2026-10-13T16:00').speed).toBe(22);
    expect(conditionsAt(series, '2026-10-13T19:00')).toBeNull();
    expect(conditionsAt(series, '2026-10-13T11:00')).toBeNull();
  });
});
