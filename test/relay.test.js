import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay, relayEnv } from '../relay/relay.mjs';
import { relayHealth } from '../src/relay.js';

// A minimal stand-in for Node's request and response.
async function call(handle, path, { method = 'GET', origin = 'https://pimdieks.github.io' } = {}) {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      return this;
    },
    end(body = '') {
      this.body = String(body);
      return this;
    },
  };
  await handle({ method, url: path, headers: origin ? { origin } : {} }, res);
  return res;
}

const ok = (body) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

describe('Flight relay', () => {
  it('says what it is, with CORS for the site and leave for a public site to reach it', async () => {
    const handle = createRelay(relayEnv({}, '/nonexistent'), vi.fn());
    const res = await call(handle, '/health');
    expect(JSON.parse(res.body)).toEqual({ name: 'Power Globe flight relay', opensky: 'anonymous' });
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://pimdieks.github.io');
    const pre = await call(handle, '/flights/global', { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
    expect(pre.headers['Access-Control-Allow-Private-Network']).toBe('true');
    expect((await call(handle, '/health', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call(handle, '/forecast?latitude=1')).status).toBe(404);
  });

  it('asks a feed once while its answer is fresh, and serves the last good answer when it fails', async () => {
    let fail = false;
    const fetchFn = vi.fn(async () => (fail ? new Response('busy', { status: 429 }) : ok({ ac: [{ hex: 'abc' }] })));
    const handle = createRelay(relayEnv({}, '/nonexistent'), fetchFn);
    const first = await call(handle, '/flights/area?lat=52.3&lon=4.76&nm=50');
    expect(first.status).toBe(200);
    expect(JSON.parse(first.body)).toMatchObject({ source: 'adsb.lol', data: { ac: [{ hex: 'abc' }] } });
    await call(handle, '/flights/area?lat=52.3&lon=4.76&nm=50');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ['Date'] });
    fail = true;
    const later = await call(handle, '/flights/area?lat=52.3&lon=4.76&nm=50');
    vi.useRealTimers();
    expect(later.status).toBe(200);
    expect(JSON.parse(later.body).data.ac[0].hex).toBe('abc');
  });

  it("reads the OpenSky account from the account page's credentials.json", () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-'));
    const file = join(dir, 'credentials.json');
    writeFileSync(file, JSON.stringify({ clientId: 'id', clientSecret: 'secret' }));
    expect(relayEnv({}, file)).toMatchObject({ OPENSKY_CLIENT_ID: 'id', OPENSKY_CLIENT_SECRET: 'secret' });
    expect(relayEnv({ OPENSKY_CLIENT_ID: 'a', OPENSKY_CLIENT_SECRET: 'b' }, file)).toMatchObject({ OPENSKY_CLIENT_ID: 'a' });
  });

  it('is recognised by the site only when it answers as the relay', async () => {
    await expect(relayHealth('http://localhost:8787', async () => ok({ name: 'Power Globe flight relay', opensky: 'account' }))).resolves.toMatchObject({ opensky: 'account' });
    await expect(relayHealth('http://localhost:8787', async () => ok({ name: 'something else' }))).rejects.toThrow('not a Power Globe flight relay');
    await expect(relayHealth('http://localhost:8787', async () => new Response('', { status: 404 }))).rejects.toThrow('answered 404');
  });
});
