import { describe, expect, it, vi } from 'vitest';
import { corsHeaders, route } from '../api/worker.js';
import { ceilingFt, flightCategory, toObservation, visibilityMiles } from '../src/metar.js';
import { bearingBetween, destination, placeLabels, runwayEnds, runwayStatus } from '../src/runwaymap.js';
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
  it('serves openAIP chart tiles with the key it holds, and refuses tiles that do not exist', async () => {
    const fetchFn = vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'Content-Type': 'image/png' } }));
    const env = { OPENAIP_API_KEY: 'k3y' };
    const res = await route(new URL('https://api.example/tiles/openaip/8/131/84.png'), env, fetchFn);
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.tiles.openaip.net/api/data/openaip/8/131/84.png?apiKey=k3y');
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
    await expect(route(new URL('https://api.example/tiles/openaip/15/0/0.png'), env, fetchFn)).rejects.toMatchObject({ status: 404 });
    await expect(route(new URL('https://api.example/tiles/openaip/2/4/0.png'), env, fetchFn)).rejects.toMatchObject({ status: 404 });
    await expect(route(new URL('https://api.example/tiles/openaip/2/1/1.png'), {}, fetchFn)).rejects.toMatchObject({ status: 503 });
  });

  it('signs in to OpenSky with an account, shares answers for 2 minutes, and falls back to anonymous', async () => {
    const env = { OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 'secret' };
    const fetchFn = vi.fn(async (url, init) =>
      url.includes('auth.opensky') ? reply({ access_token: 'tok', expires_in: 1800 }) : reply({ time: 1, states: [], seen: init?.headers?.Authorization ?? null }),
    );
    const res = await route(new URL('https://api.example/flights/global'), env, fetchFn);
    expect((await res.json()).data.seen).toBe('Bearer tok');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=120');
    const token = fetchFn.mock.calls.find(([url]) => url.includes('auth.opensky'))[1];
    expect(String(token.body)).toBe('grant_type=client_credentials&client_id=id&client_secret=secret');
    expect((await (await route(new URL('https://api.example/'), env, fetchFn)).json()).opensky).toBe('account');

    const anonymous = await route(new URL('https://api.example/flights/global'), {}, fetchFn);
    expect((await anonymous.json()).data.seen).toBeNull();
    expect(anonymous.headers.get('Cache-Control')).toBe('public, max-age=300');
  });

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

describe('keeping the services from being overloaded', () => {
  it('passes Open-Meteo requests through only with known parameters and up to 100 places', async () => {
    const fetchFn = vi.fn(async () => reply({ hourly: {} }));
    const ok = await route(new URL('https://api.example/forecast?latitude=52,53&longitude=4,5&hourly=temperature_2m&timezone=GMT'), {}, fetchFn);
    expect(ok.headers.get('Cache-Control')).toBe('public, max-age=1800');
    expect(fetchFn.mock.calls[0][0]).toContain('api.open-meteo.com/v1/forecast?latitude=52%2C53');
    await expect(route(new URL('https://api.example/forecast?latitude=1&apikey=x'), {}, fetchFn)).rejects.toMatchObject({ status: 400 });
    const many = Array.from({ length: 101 }, () => '1').join(',');
    await expect(route(new URL(`https://api.example/forecast?latitude=${many}&longitude=${many}`), {}, fetchFn)).rejects.toMatchObject({ status: 400 });
  });

  it('limits each visitor to a sensible number of requests a minute', async () => {
    const { overLimit, RATE_LIMIT } = await import('../api/worker.js');
    const ip = `test-${Math.random()}`;
    for (let i = 0; i < RATE_LIMIT; i++) expect(overLimit(ip, 1000)).toBe(false);
    expect(overLimit(ip, 1000)).toBe(true);
    expect(overLimit(ip, 62_000)).toBe(false);
  });
});

describe('airport labels on the map', () => {
  it('names airports by the distinctive part of their name', async () => {
    const { shortName } = await import('../src/airportmap.js');
    expect(shortName({ name: 'Amsterdam Airport Schiphol', city: 'Amsterdam' })).toBe('Schiphol');
    expect(shortName({ name: 'Frankfurt am Main Airport', city: 'Frankfurt am Main' })).toBe('Frankfurt am Main');
    expect(shortName({ name: 'London Heathrow Airport', city: 'London' })).toBe('Heathrow');
    expect(shortName({ name: 'Dallas Fort Worth International Airport', city: 'Dallas-Fort Worth' })).toBe('Dallas Fort Worth');
  });

  it('labels the big airports first and smaller ones closer in', async () => {
    const { airportLabelTier } = await import('../src/airportmap.js');
    const big = { large: true, scheduled: true, routes: 200 };
    const regional = { large: false, scheduled: true, routes: 12 };
    const field = { large: false, scheduled: false, routes: 0 };
    expect([big, regional, field].map((a) => airportLabelTier(a, 0.4))).toEqual([true, false, false]);
    expect([big, regional, field].map((a) => airportLabelTier(a, 0.15))).toEqual([true, true, false]);
    expect([big, regional, field].map((a) => airportLabelTier(a, 0.05))).toEqual([true, true, true]);
  });

  it('leaves out an optional label with no free spot, and keeps clear of taken places', () => {
    const label = (x) => ({ anchor: { x, y: 0 }, direction: { x: 0, y: 1 }, w: 10, h: 10, distances: [-5, 2], optional: true });
    const [first, second] = placeLabels([label(0), label(1)], [], 1);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const [moved] = placeLabels([{ ...label(0), distances: [-5, 2, 20] }], [], 1, { taken: [{ x0: -10, x1: 10, y0: -10, y1: 8 }] });
    expect(moved.y).toBeGreaterThan(8);
  });
});
