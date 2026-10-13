import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { corsHeaders, route } from '../api/worker.js';
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

describe('leaving a flight feed alone after it refuses or limits the API', () => {
  const LOL = 'api.adsb.lol';
  const LIVE = 'api.airplanes.live';
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
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(429), [LIVE]: status(403), [FI]: flights });
    const ask = () => route(AREA, {}, fetchFn, cache);
    expect((await (await ask()).json()).source).toBe('adsb.fi');
    expect(hosts()).toEqual([LOL, LIVE, FI]);
    expect(maxAge(cache, 'adsb.lol')).toBe('public, max-age=60');
    expect(maxAge(cache, 'airplanes.live')).toBe('public, max-age=21600');

    await ask();
    expect(hosts()).toEqual([FI]);
    vi.setSystemTime(START + 61_000);
    await ask();
    expect(hosts()).toEqual([LOL, FI]);
    vi.setSystemTime(START + 6 * 3600_000 + 1000);
    await ask();
    expect(hosts()).toEqual([LOL, LIVE, FI]);
  });

  it('leaves a limiting feed alone for as long as it asks, between 5 seconds and 15 minutes', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(429, { 'Retry-After': '300' }), [LIVE]: flights, [FI]: flights });
    const ask = () => route(AREA, {}, fetchFn, cache);
    await ask();
    expect(hosts()).toEqual([LOL, LIVE]);
    expect(maxAge(cache, 'adsb.lol')).toBe('public, max-age=300');
    vi.setSystemTime(START + 120_000);
    await ask();
    expect(hosts()).toEqual([LIVE]);
    vi.setSystemTime(START + 301_000);
    await ask();
    expect(hosts()).toEqual([LOL, LIVE]);

    for (const [asked, kept] of [['86400', 900], ['1', 5]]) {
      const other = fakeCache();
      const limited = feedsAnswering({ [LOL]: status(429, { 'Retry-After': asked }), [LIVE]: flights, [FI]: flights });
      await route(AREA, {}, limited.fetchFn, other);
      expect(maxAge(other, 'adsb.lol')).toBe(`public, max-age=${kept}`);
    }
  });

  it('leaves a feed that refuses or limits alone through the relay as well, as the owner\'s relay passes it on', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(429, marked(LOL)), [LIVE]: status(403, marked(LIVE)), [FI]: flightsFrom(FI) });
    const ask = () => route(AREA, RELAY, fetchFn, cache);
    expect((await (await ask()).json()).source).toBe('adsb.fi');
    expect(hosts()).toEqual([LOL, LIVE, FI]);
    expect(maxAge(cache, 'adsb.lol', 'relay')).toBe('public, max-age=60');
    expect(maxAge(cache, 'airplanes.live', 'relay')).toBe('public, max-age=21600');
    await ask();
    expect(hosts()).toEqual([FI]);
  });

  it('leaves a feed the relay does not ask alone for a minute, but not one the relay cannot sign in to', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(429, marked(LOL)), [LIVE]: status(404), [FI]: flightsFrom(FI) });
    const ask = () => route(AREA, RELAY, fetchFn, cache);
    expect((await (await ask()).json()).source).toBe('adsb.fi');
    expect(hosts()).toEqual([LOL, LIVE, FI]);
    expect(maxAge(cache, 'airplanes.live', 'relay')).toBe('public, max-age=60');
    await ask();
    expect(hosts()).toEqual([FI]);
    vi.setSystemTime(START + 61_000);
    await ask();
    expect(hosts()).toEqual([LOL, LIVE, FI]);

    // The relay's own 401 means its key does not match, which says nothing about the feeds.
    const wrongKey = fakeCache();
    const refused = feedsAnswering({ [LOL]: status(401), [LIVE]: status(401), [FI]: status(401) });
    await expect(route(AREA, RELAY, refused.fetchFn, wrongKey)).rejects.toMatchObject({ status: 502 });
    await expect(route(AREA, RELAY, refused.fetchFn, wrongKey)).rejects.toMatchObject({ status: 502 });
    expect(refused.hosts()).toEqual([LOL, LIVE, FI, LOL, LIVE, FI]);
    expect(wrongKey.entries.size).toBe(0);
  });

  it('goes by what the relay marked: a feed\'s own 401 or 403 is remembered, its own 404 or an unmarked 403 is not', async () => {
    for (const [code, headers, remembered] of [[401, marked(LOL), true], [403, marked(LOL), true], [404, marked(LOL), false], [403, undefined, false]]) {
      const cache = fakeCache();
      const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(code, headers), [LIVE]: flightsFrom(LIVE), [FI]: flights });
      await route(AREA, RELAY, fetchFn, cache);
      expect(hosts()).toEqual([LOL, LIVE]);
      await route(AREA, RELAY, fetchFn, cache);
      expect(hosts(), `a ${headers ? 'marked' : 'unmarked'} ${code}`).toEqual(remembered ? [LIVE] : [LOL, LIVE]);
    }
  });

  it('keeps what direct requests were refused apart from what the relay will be asked', async () => {
    const cache = fakeCache();
    const answers = { [LOL]: status(403), [LIVE]: flights, [FI]: flights };
    const { fetchFn, hosts } = feedsAnswering(answers);
    expect((await (await route(AREA, {}, fetchFn, cache)).json()).source).toBe('airplanes.live');
    expect(hosts()).toEqual([LOL, LIVE]);
    expect(maxAge(cache, 'adsb.lol')).toBe('public, max-age=21600');

    answers[LOL] = flightsFrom(LOL);
    expect((await (await route(AREA, RELAY, fetchFn, cache)).json()).source).toBe('adsb.lol');
    expect(hosts()).toEqual([LOL]);
    expect(fetchFn.mock.lastCall[0]).toMatch(/^https:\/\/relay\.example\/api\.adsb\.lol\//);
  });

  it('asks again after a feed\'s own 404 or trouble, and leaves it alone after a 401 when asked direct', async () => {
    for (const [code, remembered] of [[401, true], [404, false], [503, false]]) {
      const cache = fakeCache();
      const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(code), [LIVE]: flights, [FI]: flights });
      await route(AREA, {}, fetchFn, cache);
      expect(hosts()).toEqual([LOL, LIVE]);
      await route(AREA, {}, fetchFn, cache);
      expect(hosts(), `a direct ${code}`).toEqual(remembered ? [LIVE] : [LOL, LIVE]);
    }
  });

  it('says which feeds are being left alone, without asking any, when none can be asked', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(403), [LIVE]: status(403), [FI]: status(403) });
    await expect(route(AREA, {}, fetchFn, cache)).rejects.toMatchObject({ status: 502 });
    expect(hosts()).toEqual([LOL, LIVE, FI]);
    const err = await route(AREA, {}, fetchFn, cache).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toBe(
      'adsb.lol is not asked for now (api.adsb.lol answered 403); airplanes.live is not asked for now (api.airplanes.live answered 403); adsb.fi is not asked for now (opendata.adsb.fi answered 403)',
    );
    expect(hosts()).toEqual([]);
  });

  it('remembers nothing without a cache, and carries on when the cache fails', async () => {
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(403), [LIVE]: flights, [FI]: flights });
    await route(AREA, {}, fetchFn);
    await route(AREA, {}, fetchFn);
    expect(hosts()).toEqual([LOL, LIVE, LOL, LIVE]);

    const broken = { match: async () => Promise.reject(new Error('no cache')), put: async () => Promise.reject(new Error('no cache')) };
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await (await route(AREA, {}, fetchFn, broken)).json()).source).toBe('airplanes.live');
    expect(hosts()).toEqual([LOL, LIVE]);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('is shared by the requests the handler answers', async () => {
    const cache = fakeCache();
    const { fetchFn, hosts } = feedsAnswering({ [LOL]: status(429), [LIVE]: status(403), [FI]: flights });
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
    expect(hosts()).toEqual([LOL, LIVE, FI, FI]);
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
