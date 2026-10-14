import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { ACCESS_AIRPORTS, ACCESS_BACKUP_SECONDS, route } from '../api/worker.js';
import { ACCESS_AIRPORTS as PAGE_AIRPORTS } from '../src/opsaccess.js';

const RELAY = { FLIGHT_RELAY_URL: 'https://relay.example/', FLIGHT_RELAY_KEY: 'k3y' };
const NOW = Date.parse('2026-10-14T17:30:00Z');
const answer = (extra = {}) => JSON.stringify({ airport: 'EHAM', source: 'NDW', fetched: NOW - 20_000, measuredAt: NOW - 90_000, groups: [], sites: [], situations: [], ...extra });
const reply = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
const roads = (query = 'airport=EHAM') => new URL(`https://api.example/access/roads?${query}`);

describe('GET /access/roads', () => {
  it('asks the relay for the airport with its key, and passes the answer on as available', async () => {
    const fetchFn = vi.fn(async () => reply(answer()));
    const res = await route(roads('airport=eham'), RELAY, fetchFn);
    expect(fetchFn.mock.calls[0][0]).toBe('https://relay.example/ndw/EHAM');
    expect(fetchFn.mock.calls[0][1].headers['X-Relay-Key']).toBe('k3y');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await res.json()).toMatchObject({ available: true, airport: 'EHAM', source: 'NDW', fetched: NOW - 20_000 });
  });

  it('wants an ICAO code', async () => {
    for (const query of ['', 'airport=', 'airport=EH', 'airport=EHAM1', 'airport=../x']) {
      await expect(route(roads(query), RELAY, vi.fn())).rejects.toMatchObject({ status: 400 });
    }
  });

  it('asks the relay only for the airports it reads, as the page does, and refuses the rest', async () => {
    expect(ACCESS_AIRPORTS).toEqual(PAGE_AIRPORTS);
    const fetchFn = vi.fn(async () => reply(answer()));
    await expect(route(roads('airport=EHLE'), RELAY, fetchFn)).rejects.toMatchObject({ status: 404 });
    await expect(route(roads('airport=EGLL'), RELAY, fetchFn)).rejects.toMatchObject({ status: 404 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('says not available, as an answer, when there is no relay', async () => {
    const fetchFn = vi.fn();
    for (const env of [{}, { FLIGHT_RELAY_URL: 'https://relay.example' }]) {
      const res = await route(roads(), env, fetchFn);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ available: false, airport: 'EHAM', reason: expect.stringContaining('no flight relay') });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('says not available when the relay has no road job, or has not been updated to have one, or has no data for the airport', async () => {
    const cases = [
      [reply({ error: 'The road traffic job is not switched on in this relay (NDW=1)', ndw: 'off' }, { status: 503 }), 'switched off'],
      [reply({ error: 'Not a flight feed this relay asks' }, { status: 404 }), 'update it'],
      [reply({ error: 'No road traffic data for EHLE', ndw: 'on' }, { status: 404 }), 'No road data for EHAM'],
    ];
    for (const [response, words] of cases) {
      const res = await route(roads(), RELAY, async () => response);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ available: false, reason: expect.stringContaining(words) });
    }
  });

  it('fails, so that a backup can be served, when the relay is down or has not read yet', async () => {
    await expect(route(roads(), RELAY, async () => reply({ error: 'The road traffic job has not read its first data yet', ndw: 'on' }, { status: 503 }))).rejects.toMatchObject({ status: 502, message: expect.stringContaining('first data') });
    await expect(route(roads(), RELAY, async () => reply('nope', { status: 401 }))).rejects.toMatchObject({ status: 502 });
    await expect(route(roads(), RELAY, async () => Promise.reject(new Error('timed out')))).rejects.toMatchObject({ status: 502, message: expect.stringContaining('unreachable') });
    await expect(route(roads(), RELAY, async () => reply('<html>', { status: 200 }))).rejects.toMatchObject({ status: 502 });
  });
});

describe('road traffic in the edge cache', () => {
  const fakeCache = () => {
    const entries = new Map();
    return { entries, match: async (request) => entries.get(request.url)?.clone(), put: async (request, response) => void entries.set(request.url, response) };
  };
  const call = async (cache, query, pending) => {
    vi.stubGlobal('caches', { default: cache });
    const res = await worker.fetch(new Request(`https://api.example/access/roads?${query}`), RELAY, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return res;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shares one answer for 60 seconds per airport, whatever the case or the other parameters', async () => {
    const cache = fakeCache();
    const fetchFn = vi.fn(async () => reply(answer()));
    vi.stubGlobal('fetch', fetchFn);
    const pending = [];
    for (const query of ['airport=EHAM', 'airport=eham', 'airport=EHAM&x=1', 'x=2&airport=eham&_=77']) {
      const res = await call(cache, query, pending);
      expect(res.status).toBe(200);
      expect((await res.json()).available).toBe(true);
    }
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect([...cache.entries.keys()].filter((k) => !k.includes('__backup'))).toEqual(['https://api.example/access/roads?airport=EHAM']);
    await call(cache, 'airport=EHRD', pending);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('serves the last answer as stale, with its age, when the relay fails; for 10 minutes at most', async () => {
    const cache = fakeCache();
    const pending = [];
    vi.stubGlobal('fetch', vi.fn(async () => reply(answer())));
    await call(cache, 'airport=EHAM', pending);
    expect([...cache.entries.keys()].filter((k) => k.includes('__backup'))).toEqual(['https://api.example/__backup/access/roads?airport=EHAM']);
    // A minute and a half later the short-lived answer is gone and the relay is down.
    cache.entries.delete('https://api.example/access/roads?airport=EHAM');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
    vi.setSystemTime(NOW + 80_000);
    const stale = await call(cache, 'airport=eham&z=1', pending);
    expect(stale.status).toBe(200);
    expect(stale.headers.get('X-Power-Globe-Backup')).toBe('1');
    expect(await stale.json()).toMatchObject({ stale: true, ageSeconds: 100, available: true, airport: 'EHAM' });
    // The stale answer is kept for the half minute it says, so the relay is not asked again by every visitor.
    const relay = vi.fn(async () => Promise.reject(new Error('still down')));
    vi.stubGlobal('fetch', relay);
    const again = await call(cache, 'airport=EHAM', pending);
    expect((await again.json()).stale).toBe(true);
    expect(relay).not.toHaveBeenCalled();
    // Too old to be of use.
    cache.entries.delete('https://api.example/access/roads?airport=EHAM');
    vi.setSystemTime(NOW - 20_000 + (ACCESS_BACKUP_SECONDS + 5) * 1000);
    const old = await call(cache, 'airport=EHAM', pending);
    expect(old.status).toBe(502);
    expect(old.headers.get('X-Power-Globe-Backup')).toBeNull();
    expect((await old.json()).error).toContain('unreachable');
    // A failure is not remembered longer than the page's poll.
    expect(old.headers.get('Cache-Control')).toBe('public, max-age=60');
  });

  it('says not available without keeping it as a backup to serve later, and does not show its marker', async () => {
    const cache = fakeCache();
    const pending = [];
    vi.stubGlobal('fetch', vi.fn(async () => reply({ error: 'off', ndw: 'off' }, { status: 503 })));
    const res = await call(cache, 'airport=EHAM', pending);
    expect(await res.json()).toMatchObject({ available: false });
    expect(res.headers.has('X-Power-Globe-Unavailable')).toBe(false);
    expect([...cache.entries.keys()].some((k) => k.includes('__backup'))).toBe(false);
    expect([...cache.entries.keys()]).toEqual(['https://api.example/access/roads?airport=EHAM']);
  });
});
