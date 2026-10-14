import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { MAX_TRACK_POINTS, TRACKS_PER_HOUR, TRACKS_PER_HOUR_ANONYMOUS, TRACK_RATE_LIMIT, compactTrack, corsHeaders, route } from '../api/worker.js';
import { ceilingFt, flightCategory, toObservation, visibilityMiles } from '../src/metar.js';
import { bearingBetween, destination, placeLabels, runwayEnds, runwayStatus } from '../src/runwaymap.js';
import { conditionsAt, snapshotSeries, toAirport } from '../src/airports.js';
import { assessVariable, observationHtml } from '../src/airportview.js';
import { airportsInView, metresPerPixel } from '../src/airportmap.js';
import { SNAPSHOT_TIMEOUT_MS, fetchSnapshot, withTimeout } from '../src/api.js';

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
    expect(body.source).toBe('adsb.fi');
    expect(body.data.ac).toHaveLength(1);
    expect(fetchFn.mock.calls[1][0]).toBe('https://opendata.adsb.fi/api/v2/lat/52.25/lon/4.75/dist/50');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=10');
  });

  it('asks the flight feeds through the relay when there is one, and nothing else', async () => {
    const env = { FLIGHT_RELAY_URL: 'https://relay.example/', FLIGHT_RELAY_KEY: 'relay-secret-123456' };
    const fetchFn = vi.fn(async (url) => (url.includes('aviationweather') ? reply('[]') : reply({ ac: [] })));
    const area = await (await route(new URL('https://api.example/flights/area?lat=52.31&lon=4.76&nm=40'), env, fetchFn)).json();
    expect(area.source).toBe('adsb.lol');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://relay.example/api.adsb.lol/v2/point/52.25/4.75/50');
    expect(init.headers['X-Relay-Key']).toBe('relay-secret-123456');
    await route(new URL('https://api.example/metar?ids=EHAM'), env, fetchFn);
    expect(fetchFn.mock.calls[1][0]).toMatch(/^https:\/\/aviationweather\.gov\//);
    expect(fetchFn.mock.calls[1][1].headers['X-Relay-Key']).toBeUndefined();
    expect((await (await route(new URL('https://api.example/'), env, fetchFn)).json()).relay).toBe('on');
    expect((await (await route(new URL('https://api.example/'), {}, fetchFn)).json()).relay).toBe('off');

    const down = vi.fn(async () => reply('Bad gateway', { status: 502 }));
    await expect(route(new URL('https://api.example/flights/military'), env, down)).rejects.toThrow('api.adsb.lol answered 502 through the relay');
  });

  it('passes the worldwide answer on as OpenSky gave it', async () => {
    const res = await route(new URL('https://api.example/flights/global'), {}, async () => reply('{"time":1,"states":[["abc"]]}'));
    expect(await res.json()).toMatchObject({ source: 'OpenSky Network', data: { time: 1, states: [['abc']] } });
    await expect(route(new URL('https://api.example/flights/global'), {}, async () => reply('<html>busy</html>'))).rejects.toMatchObject({ status: 502 });
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
    expect(conditionsAt(series, '2026-10-13T11:00')).toBeNull();
  });

  it('holds the last step for the hours of its own step', () => {
    const series = snapshot.get('EHAM');
    expect(conditionsAt(series, '2026-10-13T18:00').speed).toBe(15);
    expect(conditionsAt(series, '2026-10-13T20:00').speed).toBe(15);
    expect(conditionsAt(series, '2026-10-13T21:00')).toBeNull();
  });

  it('holds the last hour of an hourly series for that hour only', () => {
    const hourly = snapshotSeries({
      built: '2026-10-13T12:00:00Z',
      times: ['2026-10-13T12:00', '2026-10-13T13:00'],
      airports: { EHAM: [[12, 13], [9, 9], [18, 22], [250, 260], [30, 35]] },
    }).get('EHAM');
    expect(conditionsAt(hourly, '2026-10-13T13:00').speed).toBe(22);
    expect(conditionsAt(hourly, '2026-10-13T13:30').speed).toBe(22);
    expect(conditionsAt(hourly, '2026-10-13T14:00')).toBeNull();
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

describe('never loading for ever', () => {
  it('gives up with a reason when something does not settle in time', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise(() => {});
      const late = withTimeout(never, 45_000, 'no answer in time');
      const caught = expect(late).rejects.toThrow('no answer in time');
      await vi.advanceTimersByTimeAsync(45_000);
      await caught;
      // Without a timer left behind when it settles first.
      expect(await withTimeout(Promise.resolve('conditions'), 45_000, 'no answer in time')).toBe('conditions');
      await expect(withTimeout(Promise.reject(new Error('refused')), 45_000, 'no answer in time')).rejects.toThrow('refused');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the site's own data", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('gives up on a download that does not finish, and says there is no copy', async () => {
    // The timeout is a real one (AbortSignal.timeout), so stand in for it to see what it does.
    const timeout = new AbortController();
    const spy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    vi.stubGlobal('fetch', (url, init) => new Promise((resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason))));
    const download = fetchSnapshot('api/airport-weather.json');
    expect(spy).toHaveBeenCalledWith(SNAPSHOT_TIMEOUT_MS);
    timeout.abort(new DOMException('The operation timed out', 'TimeoutError'));
    expect(await download).toBeNull();
  });

  it('gives the file when it is there, and null when it is not', async () => {
    vi.stubGlobal('fetch', async (url) => (url.endsWith('/there.json') ? { ok: true, json: async () => ({ built: 'now' }) } : { ok: false, status: 404 }));
    expect(await fetchSnapshot('api/there.json')).toEqual({ built: 'now' });
    expect(await fetchSnapshot('api/missing.json')).toBeNull();
  });
});

describe('leaving a flight feed alone after it refuses or limits the API', () => {
  const LOL = 'api.adsb.lol';
  const FI = 'opendata.adsb.fi';
  const AREA = new URL('https://api.example/flights/area?lat=52&lon=4&nm=50');
  const RELAY = { FLIGHT_RELAY_URL: 'https://relay.example/', FLIGHT_RELAY_KEY: 'relay-secret-123456' };
  const START = Date.parse('2026-10-13T12:00:00Z');
  const marked = (host) => ({ 'X-Answered-By': host });
  const flights = () => reply({ ac: [{ hex: 'abc' }] });
  const flightsFrom = (host) => () => reply({ ac: [{ hex: 'abc' }] }, { headers: marked(host) });
  const status = (code, headers) => () => reply('no', { status: code, headers });

  // A stand-in for the edge cache that never lets an entry expire by itself.
  const fakeCache = () => {
    const entries = new Map();
    return { entries, match: async (request) => entries.get(request.url)?.clone(), put: async (request, response) => void entries.set(request.url, response) };
  };
  const maxAge = (cache, feed, via = 'direct') => cache.entries.get(`https://api.example/__feeds/${via}/${feed}`)?.headers.get('Cache-Control');

  // A fetch that answers as each feed is told to, and notes which hosts were asked.
  const feedsAnswering = (answers) => {
    const asked = [];
    const fetchFn = vi.fn(async (url) => {
      const { host, pathname } = new URL(url);
      const feed = host === 'relay.example' ? pathname.split('/')[1] : host;
      asked.push(feed);
      return answers[feed]();
    });
    const hosts = () => asked.splice(0);
    return { fetchFn, hosts };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('leaves a feed that refuses for 6 hours and one that limits for a minute, while another answers', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(429), [FI]: flights });
    const ask = () => route(AREA, {}, fetchFn, cache);
    expect((await (await ask()).json()).source).toBe('adsb.fi');
    expect(hosts()).toEqual([LOL, FI]);
    expect(maxAge(cache, 'adsb.lol')).toBe('public, max-age=60');
    expect(maxAge(cache, 'adsb.fi')).toBeUndefined();

    await ask();
    expect(hosts()).toEqual([FI]);
    vi.setSystemTime(START + 61_000);
    await ask();
    expect(hosts()).toEqual([LOL, FI]);

    // A feed that refuses is left alone for 6 hours.
    const refusing = fakeCache();
    const refused = feedsAnswering({ [LOL]: status(403), [FI]: flights });
    await route(AREA, {}, refused.fetchFn, refusing);
    expect(refused.hosts()).toEqual([LOL, FI]);
    expect(maxAge(refusing, 'adsb.lol')).toBe('public, max-age=21600');
    await route(AREA, {}, refused.fetchFn, refusing);
    expect(refused.hosts()).toEqual([FI]);
    vi.setSystemTime(START + 61_000 + 6 * 3600_000 + 1000);
    await route(AREA, {}, refused.fetchFn, refusing);
    expect(refused.hosts()).toEqual([LOL, FI]);
  });

  it('leaves a limiting feed alone for as long as it asks, between 5 seconds and 15 minutes', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(429, { 'Retry-After': '300' }), [FI]: flights });
    const ask = () => route(AREA, {}, fetchFn, cache);
    await ask();
    expect(hosts()).toEqual([LOL, FI]);
    expect(maxAge(cache, 'adsb.lol')).toBe('public, max-age=300');
    vi.setSystemTime(START + 120_000);
    await ask();
    expect(hosts()).toEqual([FI]);
    vi.setSystemTime(START + 301_000);
    await ask();
    expect(hosts()).toEqual([LOL, FI]);

    for (const [asked, kept] of [['86400', 900], ['1', 5]]) {
      const other = fakeCache();
      const limited = feedsAnswering({ [LOL]: status(429, { 'Retry-After': asked }), [FI]: flights });
      await route(AREA, {}, limited.fetchFn, other);
      expect(maxAge(other, 'adsb.lol')).toBe(`public, max-age=${kept}`);
    }
  });

  it('leaves a feed that refuses or limits alone through the relay as well, as the owner\'s relay passes it on', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(403, marked(LOL)), [FI]: flightsFrom(FI) });
    const ask = () => route(AREA, RELAY, fetchFn, cache);
    expect((await (await ask()).json()).source).toBe('adsb.fi');
    expect(hosts()).toEqual([LOL, FI]);
    expect(maxAge(cache, 'adsb.lol', 'relay')).toBe('public, max-age=21600');
    await ask();
    expect(hosts()).toEqual([FI]);

    const limited = fakeCache();
    const limiting = feedsAnswering({ [LOL]: status(429, marked(LOL)), [FI]: flightsFrom(FI) });
    await route(AREA, RELAY, limiting.fetchFn, limited);
    expect(limiting.hosts()).toEqual([LOL, FI]);
    expect(maxAge(limited, 'adsb.lol', 'relay')).toBe('public, max-age=60');
  });

  it('leaves a feed the relay does not ask alone for a minute, but not one the relay cannot sign in to', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(404), [FI]: flightsFrom(FI) });
    const ask = () => route(AREA, RELAY, fetchFn, cache);
    expect((await (await ask()).json()).source).toBe('adsb.fi');
    expect(hosts()).toEqual([LOL, FI]);
    expect(maxAge(cache, 'adsb.lol', 'relay')).toBe('public, max-age=60');
    await ask();
    expect(hosts()).toEqual([FI]);
    vi.setSystemTime(START + 61_000);
    await ask();
    expect(hosts()).toEqual([LOL, FI]);

    // The relay's own 401 means its key does not match, which says nothing about the feeds.
    const wrongKey = fakeCache();
    const refused = feedsAnswering({ [LOL]: status(401), [FI]: status(401) });
    await expect(route(AREA, RELAY, refused.fetchFn, wrongKey)).rejects.toMatchObject({ status: 502 });
    await expect(route(AREA, RELAY, refused.fetchFn, wrongKey)).rejects.toMatchObject({ status: 502 });
    expect(refused.hosts()).toEqual([LOL, FI, LOL, FI]);
    expect(wrongKey.entries.size).toBe(0);
  });

  it('goes by what the relay marked: a feed\'s own 401 or 403 is remembered, its own 404 or an unmarked 403 is not', async () => {
    for (const [code, headers, remembered] of [[401, marked(LOL), true], [403, marked(LOL), true], [404, marked(LOL), false], [403, undefined, false]]) {
      const cache = fakeCache();
      const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(code, headers), [FI]: flightsFrom(FI) });
      await route(AREA, RELAY, fetchFn, cache);
      expect(hosts()).toEqual([LOL, FI]);
      await route(AREA, RELAY, fetchFn, cache);
      expect(hosts(), `a ${headers ? 'marked' : 'unmarked'} ${code}`).toEqual(remembered ? [FI] : [LOL, FI]);
    }
  });

  it('keeps what direct requests were refused apart from what the relay will be asked', async () => {
    const cache = fakeCache();
    const answers = { [LOL]: status(403), [FI]: flights };
    const { fetchFn, hosts } = feedsAnswering(answers);
    expect((await (await route(AREA, {}, fetchFn, cache)).json()).source).toBe('adsb.fi');
    expect(hosts()).toEqual([LOL, FI]);
    expect(maxAge(cache, 'adsb.lol')).toBe('public, max-age=21600');

    answers[LOL] = flightsFrom(LOL);
    expect((await (await route(AREA, RELAY, fetchFn, cache)).json()).source).toBe('adsb.lol');
    expect(hosts()).toEqual([LOL]);
    expect(fetchFn.mock.lastCall[0]).toMatch(/^https:\/\/relay\.example\/api\.adsb\.lol\//);
  });

  it('asks again after a feed\'s own 404 or trouble, and leaves it alone after a 401 when asked direct', async () => {
    for (const [code, remembered] of [[401, true], [404, false], [503, false]]) {
      const cache = fakeCache();
      const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(code), [FI]: flights });
      await route(AREA, {}, fetchFn, cache);
      expect(hosts()).toEqual([LOL, FI]);
      await route(AREA, {}, fetchFn, cache);
      expect(hosts(), `a direct ${code}`).toEqual(remembered ? [FI] : [LOL, FI]);
    }
  });

  it('says which feeds are being left alone, without asking any, when none can be asked', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(403), [FI]: status(403) });
    await expect(route(AREA, {}, fetchFn, cache)).rejects.toMatchObject({ status: 502 });
    expect(hosts()).toEqual([LOL, FI]);
    const err = await route(AREA, {}, fetchFn, cache).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toBe(
      'adsb.lol is not asked for now (api.adsb.lol answered 403); adsb.fi is not asked for now (opendata.adsb.fi answered 403)',
    );
    expect(hosts()).toEqual([]);
  });

  it('remembers nothing without a cache, and carries on when the cache fails', async () => {
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(403), [FI]: flights });
    await route(AREA, {}, fetchFn);
    await route(AREA, {}, fetchFn);
    expect(hosts()).toEqual([LOL, FI, LOL, FI]);

    const broken = { match: async () => Promise.reject(new Error('no cache')), put: async () => Promise.reject(new Error('no cache')) };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await (await route(AREA, {}, fetchFn, broken)).json()).source).toBe('adsb.fi');
    expect(hosts()).toEqual([LOL, FI]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('is shared by the requests the handler answers', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(429), [FI]: flights });
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', fetchFn);
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    for (const area of ['lat=52&lon=4&nm=50', 'lat=40&lon=-74&nm=50']) {
      const res = await worker.fetch(new Request(`https://api.example/flights/area?${area}`), {}, ctx);
      expect(res.status).toBe(200);
      expect((await res.json()).source).toBe('adsb.fi');
      await Promise.all(pending);
    }
    expect(hosts()).toEqual([LOL, FI, FI]);
  });
});

describe('aircraft tracks', () => {
  const TRACK = new URL('https://api.example/track?icao24=486898');
  const RELAY = { FLIGHT_RELAY_URL: 'https://relay.example/', FLIGHT_RELAY_KEY: 'relay-secret-123456' };
  const ACCOUNT = { OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 'secret' };
  const opensky = {
    icao24: '486898',
    callsign: 'KLM66A  ',
    startTime: 1000,
    endTime: 1300,
    path: [
      [1000, 51.4776, -0.4469, -304, 269, false],
      [1100, 51.5, -0.6, 3048.4, 300, false],
      [1200, null, null, 6000, 300, false],
      [1300, 51.7, -1.1, null, 310, true],
    ],
  };
  const fakeCache = () => {
    const entries = new Map();
    return { entries, match: async (request) => entries.get(request.url)?.clone(), put: async (request, response) => void entries.set(request.url, response) };
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('turns the OpenSky track into compact points, in feet, without the gaps, cached for a minute', async () => {
    const fetchFn = vi.fn(async () => reply(opensky));
    const res = await route(TRACK, {}, fetchFn);
    expect(fetchFn.mock.calls[0][0]).toBe('https://opensky-network.org/api/tracks/all?icao24=486898&time=0');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await res.json()).toEqual({
      source: 'OpenSky Network',
      icao24: '486898',
      callsign: 'KLM66A',
      startTime: 1000,
      endTime: 1300,
      points: [
        [1000, 51.4776, -0.4469, -997, 0],
        [1100, 51.5, -0.6, 10001, 0],
        [1300, 51.7, -1.1, null, 1],
      ],
    });
  });

  it('thins a long track evenly down to at most 300 points, keeping the first and the last', () => {
    const path = Array.from({ length: 1000 }, (_, i) => [i, 50 + i / 1000, 4, 1000, 0, false]);
    const points = compactTrack({ path });
    expect(points).toHaveLength(MAX_TRACK_POINTS);
    expect(points[0][0]).toBe(0);
    expect(points.at(-1)[0]).toBe(999);
    expect(points.map((p) => p[0])).toEqual([...points.map((p) => p[0])].sort((a, b) => a - b));
    expect(compactTrack({ path: path.slice(0, 120) })).toHaveLength(120);
    expect(compactTrack({ path: path.slice(0, 20) }, 5).map((p) => p[0])).toEqual([0, 5, 10, 14, 19]);
    expect(compactTrack({})).toEqual([]);
    expect(compactTrack({ path: [[1, 'x', 2]] })).toEqual([]);
  });

  it('wants a six-digit hexadecimal address, in either case', async () => {
    const fetchFn = vi.fn(async () => reply(opensky));
    for (const bad of ['', '12345', '1234567', 'zzzzzz', '48689g', '486898/../x']) {
      await expect(route(new URL(`https://api.example/track?icao24=${encodeURIComponent(bad)}`), {}, fetchFn)).rejects.toMatchObject({ status: 400 });
    }
    await expect(route(new URL('https://api.example/track'), {}, fetchFn)).rejects.toMatchObject({ status: 400 });
    expect(fetchFn).not.toHaveBeenCalled();
    await route(new URL('https://api.example/track?icao24=48689A'), {}, fetchFn);
    expect(fetchFn.mock.calls[0][0]).toContain('icao24=48689a&');
  });

  it('answers "no track" for an aircraft OpenSky has no current flight for, and cools off for nothing', async () => {
    const cache = fakeCache();
    const fetchFn = vi.fn(async (url) => (url.includes('auth.opensky') ? reply({ access_token: 'tok', expires_in: 1800 }) : reply('{}', { status: 404 })));
    const res = await route(TRACK, ACCOUNT, fetchFn, cache);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ icao24: '486898', startTime: null, endTime: null, points: [] });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    await route(TRACK, ACCOUNT, fetchFn, cache);
    expect(fetchFn.mock.calls.filter(([url]) => url.includes('tracks/all'))).toHaveLength(2);
    expect([...cache.entries.keys()].some((k) => k.includes('__feeds'))).toBe(false);
  });

  it('signs in with the OpenSky account and asks through the relay like the flights', async () => {
    const env = { ...RELAY, OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 'secret' };
    const fetchFn = vi.fn(async (url) => (url.includes('auth.opensky') ? reply({ access_token: 'tok', expires_in: 1800 }) : reply(opensky)));
    await route(TRACK, env, fetchFn);
    const [url, init] = fetchFn.mock.lastCall;
    expect(url).toBe('https://relay.example/opensky-network.org/api/tracks/all?icao24=486898&time=0');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['X-Relay-Key']).toBe('relay-secret-123456');
  });

  it('leaves OpenSky alone after it refuses or limits the API, and treats a 404 from the relay itself as a failure', async () => {
    for (const [code, headers, kept] of [[429, undefined, 60], [429, { 'Retry-After': '300' }, 300], [403, undefined, 21600]]) {
      const cache = fakeCache();
      const fetchFn = vi.fn(async () => reply('no', { status: code, headers }));
      await expect(route(TRACK, {}, fetchFn, cache)).rejects.toMatchObject({ status: code === 429 ? 429 : 502 });
      expect(cache.entries.get('https://api.example/__feeds/direct/opensky-tracks').headers.get('Cache-Control')).toBe(`public, max-age=${kept}`);
      await expect(route(TRACK, {}, fetchFn, cache)).rejects.toThrow('OpenSky is not asked for now');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
    const cache = fakeCache();
    const fetchFn = vi.fn(async () => reply('no', { status: 404 }));
    await expect(route(TRACK, RELAY, fetchFn, cache)).rejects.toMatchObject({ status: 502 });
    expect(cache.entries.get('https://api.example/__feeds/relay/opensky-tracks').headers.get('Cache-Control')).toBe('public, max-age=60');
    const marked = vi.fn(async () => reply('{}', { status: 404, headers: { 'X-Answered-By': 'opensky-network.org' } }));
    expect((await route(TRACK, RELAY, marked)).status).toBe(200);
  });

  it('is shared between visitors for a minute, and never answers with an old track when OpenSky fails', async () => {
    const cache = fakeCache();
    let fail = false;
    const fetchFn = vi.fn(async (url) => (url.includes('auth.opensky') ? reply({ access_token: 'tok', expires_in: 1800 }) : fail ? reply('down', { status: 503 }) : reply(opensky)));
    vi.stubGlobal('caches', { default: cache });
    vi.stubGlobal('fetch', fetchFn);
    const pending = [];
    const ctx = { waitUntil: (promise) => pending.push(promise) };
    const ask = async (hex) => {
      const res = await worker.fetch(new Request(`https://api.example/track?icao24=${hex}`), ACCOUNT, ctx);
      await Promise.all(pending);
      return res;
    };
    expect((await ask('486898')).status).toBe(200);
    expect((await ask('486898')).status).toBe(200);
    expect(fetchFn.mock.calls.filter(([url]) => url.includes('tracks/all'))).toHaveLength(1);
    expect([...cache.entries.keys()].some((k) => k.includes('__backup'))).toBe(false);
    fail = true;
    const res = await ask('4b1805');
    expect(res.status).toBe(502);
    expect(res.headers.get('X-Power-Globe-Backup')).toBeNull();
  });

  describe('keeping the OpenSky credits', () => {
    const START = Date.parse('2026-10-14T12:10:00Z');
    let cache;
    let fetchFn;
    let pending;
    const trackCalls = () => fetchFn.mock.calls.filter(([url]) => url.includes('tracks/all')).length;
    // A request for a track as a visitor at `ip` makes it.
    const ask = async (query, { ip = '203.0.113.1', env = ACCOUNT } = {}) => {
      const request = new Request(`https://api.example/track?${query}`, { headers: { 'CF-Connecting-IP': ip } });
      const res = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p) });
      await Promise.all(pending);
      return res;
    };
    const hex = (n) => (0x400000 + n).toString(16);

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(START);
      cache = fakeCache();
      pending = [];
      fetchFn = vi.fn(async (url) => (url.includes('auth.opensky') ? reply({ access_token: 'tok', expires_in: 1800 }) : reply(opensky)));
      vi.stubGlobal('caches', { default: cache });
      vi.stubGlobal('fetch', fetchFn);
    });
    afterEach(() => vi.useRealTimers());

    it('keeps one cached answer per aircraft, whatever else the request says', async () => {
      let n = 0;
      for (const query of ['icao24=4b1805', 'icao24=4b1805&x=1', 'icao24=4b1805&_=1791965500', 'icao24=4B1805', 'icao24=4b1805&icao24=ffffff', 'x=2&icao24=4b1805']) {
        expect((await ask(query, { ip: `198.51.100.${n++}` })).status).toBe(200);
      }
      expect(trackCalls()).toBe(1);
      expect([...cache.entries.keys()].filter((k) => k.includes('/track'))).toEqual(['https://api.example/track?icao24=4b1805']);
      // A path with a trailing slash is the same route.
      const res = await worker.fetch(new Request('https://api.example/track/?icao24=4B1805'), ACCOUNT, { waitUntil() {} });
      expect(res.status).toBe(200);
      expect(trackCalls()).toBe(1);
    });

    it('lets a visitor ask for only a few tracks a minute', async () => {
      for (let i = 0; i < TRACK_RATE_LIMIT; i++) expect((await ask(`icao24=${hex(i)}`, { ip: '203.0.113.9' })).status).toBe(200);
      const res = await ask(`icao24=${hex(99)}`, { ip: '203.0.113.9' });
      expect(res.status).toBe(429);
      expect(trackCalls()).toBe(TRACK_RATE_LIMIT);
      // Answers from the cache cost no turn, and another visitor is not held up by this one.
      expect((await ask(`icao24=${hex(1)}`, { ip: '203.0.113.9' })).status).toBe(200);
      expect((await ask(`icao24=${hex(98)}`, { ip: '203.0.113.10' })).status).toBe(200);
    });

    it('asks OpenSky for at most 13 tracks an hour, then says "not now" until the hour is over', async () => {
      expect(TRACKS_PER_HOUR).toBe(13);
      for (let i = 0; i < TRACKS_PER_HOUR; i++) expect((await ask(`icao24=${hex(i)}`, { ip: `198.51.100.${i}` })).status).toBe(200);
      expect(trackCalls()).toBe(TRACKS_PER_HOUR);
      const refused = await ask(`icao24=${hex(50)}`, { ip: '198.51.100.99' });
      expect(refused.status).toBe(503);
      expect((await refused.json()).error).toContain('hourly limit');
      expect(trackCalls()).toBe(TRACKS_PER_HOUR);
      // Aircraft already answered still are, and the refusal is not kept beyond the failure time.
      expect((await ask(`icao24=${hex(2)}`, { ip: '198.51.100.98' })).status).toBe(200);
      const kept = cache.entries.get(`https://api.example/track?icao24=${hex(50)}`).headers.get('Cache-Control');
      expect(Number(kept.match(/max-age=(\d+)/)[1])).toBeLessThanOrEqual(120);
      // The next hour starts again.
      vi.setSystemTime(Math.ceil(START / 3_600_000) * 3_600_000 + 1000);
      expect((await ask(`icao24=${hex(51)}`, { ip: '198.51.100.97' })).status).toBe(200);
      expect(trackCalls()).toBe(TRACKS_PER_HOUR + 1);
    });

    it('is stricter without an OpenSky account, whose allowance is a tenth of that', async () => {
      expect(TRACKS_PER_HOUR_ANONYMOUS).toBe(1);
      expect((await ask(`icao24=${hex(1)}`, { env: {} })).status).toBe(200);
      expect((await ask(`icao24=${hex(2)}`, { env: {} })).status).toBe(503);
      expect(trackCalls()).toBe(1);
    });

    it('remembers "not asked for now" no longer than OpenSky is left alone', async () => {
      fetchFn.mockImplementation(async (url) => (url.includes('auth.opensky') ? reply({ access_token: 'tok', expires_in: 1800 }) : reply('slow down', { status: 429, headers: { 'Retry-After': '10' } })));
      expect((await ask(`icao24=${hex(1)}`)).status).toBe(429);
      vi.setSystemTime(START + 6000);
      const res = await ask(`icao24=${hex(2)}`);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toContain('not asked for now');
      expect(cache.entries.get(`https://api.example/track?icao24=${hex(2)}`).headers.get('Cache-Control')).toBe('public, max-age=4');
    });
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

  it('flies to an airport at the search altitude, but never back out from a closer view', async () => {
    const { AIRPORT_ALTITUDE, airportFlightAltitude } = await import('../src/airportmap.js');
    expect(airportFlightAltitude(0.02)).toBe(AIRPORT_ALTITUDE);
    expect(airportFlightAltitude(2.4)).toBe(AIRPORT_ALTITUDE);
    expect(airportFlightAltitude(0.003)).toBe(0.003);
    expect(airportFlightAltitude(AIRPORT_ALTITUDE)).toBe(AIRPORT_ALTITUDE);
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
