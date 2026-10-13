#!/usr/bin/env node
// Power Globe flight relay for the API: asks the flight feeds for the Power Globe API
// (api/worker.js) from a machine of your own, such as a Raspberry Pi at home. The feeds limit or
// refuse Cloudflare's servers, whose addresses many sites share, but answer an ordinary internet
// connection.
//
//   GET  /                               what is here (no key needed)
//   GET  /<host>/<path>?<query>          the same request to https://<host>/<path>?<query>
//   POST /auth.opensky-network.org/...   OpenSky sign-in, for an account's larger allowance
//
// Only the flight feeds are relayed, only for requests carrying the key, and each feed is asked
// at most once a second (when busier than that it answers 429, and the API serves its last
// answer). Answers come back as the feed gave them, compressed for the trip up a home connection,
// and carry an x-answered-by header naming the feed, which the relay's own answers do not, so the
// API can tell the two apart.
//
// Settings (environment): RELAY_KEY, a long random secret, the same as the API's
// FLIGHT_RELAY_KEY; PORT (default 8788); HOST (default 127.0.0.1, for a tunnel on this
// machine). Needs Node.js 18 or newer and nothing else. See "Flight relay for the API" in the
// README.

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

// The same hosts as RELAYED_HOSTS in api/worker.js.
export const RELAYED_HOSTS = ['opensky-network.org', 'auth.opensky-network.org', 'api.adsb.lol', 'api.airplanes.live', 'opendata.adsb.fi'];
const POST_HOSTS = ['auth.opensky-network.org'];
const FORWARDED_HEADERS = ['accept', 'authorization', 'content-type', 'user-agent'];
const RETURNED_HEADERS = ['content-type', 'retry-after'];
const TIMEOUT_MS = 15_000;
// Each feed is asked at most once this often, and a request waits at most this long for its turn.
const SPACING_MS = 1000;
const MAX_WAIT_MS = 5000;
const MAX_BODY_BYTES = 4096;
const COMPRESS_FROM_BYTES = 1024;

const compress = promisify(gzip);
const digest = (s) => createHash('sha256').update(s).digest();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reply = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: Buffer.from(JSON.stringify(body)), error: body.error });

const pick = (headers, names) => Object.fromEntries(names.filter((n) => typeof headers[n] === 'string').map((n) => [n, headers[n]]));

// The relay itself: ({ method, path, headers, body }) => { status, headers, body }, with headers
// named in lower case as Node gives them.
export function createRelay({ key, fetchFn = fetch, spacingMs = SPACING_MS, maxWaitMs = MAX_WAIT_MS, now = Date.now, wait = sleep } = {}) {
  if (!key || key.length < 16) throw new Error('Set RELAY_KEY to a random secret of at least 16 characters (for example: openssl rand -hex 32)');
  const keyDigest = digest(key);
  // When each feed may be asked next.
  const turns = new Map();

  return async function handle({ method, path, headers = {}, body }) {
    if (path === '/') return reply(200, { name: 'Power Globe flight relay for the API', hosts: RELAYED_HOSTS });
    const given = headers['x-relay-key'];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), keyDigest)) return reply(401, { error: 'Wrong or missing relay key' });

    const match = path.match(/^\/([a-z0-9.-]+)(\/.*)?$/i);
    const host = match?.[1].toLowerCase();
    if (!RELAYED_HOSTS.includes(host)) return reply(404, { error: 'Not a flight feed this relay asks' });
    const target = new URL(`https://${host}${match[2] ?? '/'}`);
    if (target.host !== host) return reply(404, { error: 'Not a flight feed this relay asks' });
    if (method !== 'GET' && !(method === 'POST' && POST_HOSTS.includes(host))) return reply(405, { error: 'Method not allowed' });

    const t = now();
    const turn = Math.max(t, turns.get(host) ?? 0);
    if (turn - t > maxWaitMs) return reply(429, { error: `${host} is being asked too often` }, { 'retry-after': '5' });
    turns.set(host, turn + spacingMs);
    if (turn > t) await wait(turn - t);

    let res;
    let data;
    try {
      res = await fetchFn(target.href, {
        method,
        headers: pick(headers, FORWARDED_HEADERS),
        body: method === 'POST' ? body : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      data = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      return reply(504, { error: `${host} did not answer the relay (${err.message})` });
    }
    const out = { 'x-answered-by': host, ...pick(Object.fromEntries(res.headers), RETURNED_HEADERS) };
    if (data.length >= COMPRESS_FROM_BYTES && /\bgzip\b/.test(headers['accept-encoding'] ?? '')) {
      data = await compress(data);
      out['content-encoding'] = 'gzip';
    }
    return { status: res.status, headers: out, body: data };
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function serve({ key = process.env.RELAY_KEY, port = Number(process.env.PORT) || 8788, host = process.env.HOST || '127.0.0.1' } = {}) {
  const handle = createRelay({ key });
  const server = createServer(async (req, res) => {
    const started = Date.now();
    let out;
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      out = await handle({ method: req.method, path: req.url, headers: req.headers, body });
    } catch (err) {
      out = reply(err.status ?? 500, { error: err.message });
    }
    res.writeHead(out.status, { ...out.headers, 'content-length': out.body.length });
    res.end(out.body);
    // Only what went wrong, to keep the log (and a Pi's memory card) quiet.
    if (out.status >= 400) console.log(`${out.status} ${req.method} ${req.url.replace(/\?.*/, '')} ${Date.now() - started} ms ${out.error ?? ''}`.trim());
  });
  server.listen(port, host, () => console.log(`Power Globe flight relay for the API on http://${host}:${port}`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    serve();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
