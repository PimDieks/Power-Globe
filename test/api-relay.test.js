import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { RELAYED_HOSTS as WORKER_HOSTS } from '../api/worker.js';
import { RELAYED_HOSTS, createRelay } from '../relay/api-relay.mjs';

const KEY = 'relay-secret-123456';
const reply = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
const get = (path, headers = {}) => ({ method: 'GET', path, headers: { 'x-relay-key': KEY, ...headers } });

describe('flight relay for the API', () => {
  it('relays the same feeds the API sends it', () => {
    expect(RELAYED_HOSTS).toEqual(WORKER_HOSTS);
  });

  it('will not start without a proper key, and answers only requests that carry it', async () => {
    expect(() => createRelay({ key: '' })).toThrow('RELAY_KEY');
    expect(() => createRelay({ key: 'short' })).toThrow('RELAY_KEY');
    const fetchFn = vi.fn(async () => reply({ ac: [] }));
    const relay = createRelay({ key: KEY, fetchFn });
    expect((await relay({ method: 'GET', path: '/' })).status).toBe(200);
    expect((await relay({ method: 'GET', path: '/api.adsb.lol/v2/mil', headers: {} })).status).toBe(401);
    expect((await relay(get('/api.adsb.lol/v2/mil', { 'x-relay-key': 'relay-secret-12345X' }))).status).toBe(401);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('asks only the flight feeds, and only what they are asked for', async () => {
    const fetchFn = vi.fn(async () => reply({ ac: [] }));
    const relay = createRelay({ key: KEY, fetchFn, spacingMs: 0 });
    for (const path of ['/evil.example/x', '/api.adsb.lol.evil.example/v2/mil', '/api.adsb.lol@evil.example/v2/mil', '/api.adsb.lol:8080/v2/mil']) {
      expect((await relay(get(path))).status).toBe(404);
    }
    expect((await relay(get('/api.adsb.lol//evil.example/v2/mil'))).status).toBe(200);
    expect(new URL(fetchFn.mock.calls[0][0]).host).toBe('api.adsb.lol');
    expect((await relay({ ...get('/api.adsb.lol/v2/mil'), method: 'POST' })).status).toBe(405);
    expect((await relay({ ...get('/auth.opensky-network.org/token', { 'content-type': 'application/x-www-form-urlencoded' }), method: 'POST', body: 'grant_type=x' })).status).toBe(200);
    const [, init] = fetchFn.mock.calls[1];
    expect(init).toMatchObject({ method: 'POST', body: 'grant_type=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(init.headers['x-relay-key']).toBeUndefined();
  });

  it('passes the answer back as the feed gave it, compressed when it can be', async () => {
    const big = { ac: Array.from({ length: 100 }, (_, i) => ({ hex: `a${i}` })) };
    const fetchFn = vi.fn(async (url) => (url.includes('opensky') ? reply('slow down', { status: 429, headers: { 'Retry-After': '30' } }) : reply(big, { headers: { 'Content-Type': 'application/json' } })));
    const relay = createRelay({ key: KEY, fetchFn, spacingMs: 0 });
    const res = await relay(get('/api.adsb.lol/v2/point/52.25/4.75/50', { authorization: 'Bearer t', 'accept-encoding': 'gzip, br', cookie: 'x' }));
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.adsb.lol/v2/point/52.25/4.75/50');
    expect(fetchFn.mock.calls[0][1].headers).toEqual({ authorization: 'Bearer t' });
    expect(res.headers).toMatchObject({ 'content-type': 'application/json', 'content-encoding': 'gzip' });
    expect(JSON.parse(gunzipSync(res.body))).toEqual(big);
    const limited = await relay(get('/opensky-network.org/api/states/all?extended=1'));
    expect(limited).toMatchObject({ status: 429, headers: { 'retry-after': '30' } });
    expect(limited.body.toString()).toBe('slow down');
    const down = createRelay({ key: KEY, fetchFn: async () => Promise.reject(new Error('timed out')) });
    expect((await down(get('/api.adsb.lol/v2/mil'))).status).toBe(504);
  });

  it('marks the answers it passes on with the feed that gave them, and not its own', async () => {
    const fetchFn = vi.fn(async (url) => (url.includes('opensky') ? reply('slow down', { status: 429 }) : reply({ ac: [] })));
    const relay = createRelay({ key: KEY, fetchFn, now: () => 0, wait: async () => {}, maxWaitMs: 0 });
    const passed = [await relay(get('/api.adsb.lol/v2/mil')), await relay(get('/opensky-network.org/api/states/all'))];
    expect(passed.map((r) => r.status)).toEqual([200, 429]);
    expect(passed.map((r) => r.headers['x-answered-by'])).toEqual(['api.adsb.lol', 'opensky-network.org']);

    const down = createRelay({ key: KEY, fetchFn: async () => Promise.reject(new Error('timed out')) });
    const own = [
      await relay({ method: 'GET', path: '/api.adsb.lol/v2/mil', headers: {} }),
      await relay(get('/evil.example/x')),
      await relay({ ...get('/api.adsb.lol/v2/mil'), method: 'POST' }),
      await relay(get('/api.adsb.lol/v2/mil')),
      await down(get('/api.adsb.lol/v2/mil')),
    ];
    expect(own.map((r) => r.status)).toEqual([401, 404, 405, 429, 504]);
    for (const r of own) expect(r.headers).not.toHaveProperty('x-answered-by');
  });

  it('asks each feed at most once a second, and turns requests away rather than queue them long', async () => {
    let clock = 0;
    const wait = vi.fn(async () => {});
    const relay = createRelay({ key: KEY, fetchFn: async () => reply({ ac: [] }), now: () => clock, wait, maxWaitMs: 2000 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await relay(get('/api.adsb.lol/v2/mil'))).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(wait.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000]);
    // Another feed has its own turn.
    expect((await relay(get('/opendata.adsb.fi/api/v2/mil'))).status).toBe(200);
    clock = 3000;
    expect((await relay(get('/api.adsb.lol/v2/mil'))).status).toBe(200);
  });
});
