#!/usr/bin/env node
// Power Globe flight relay: the Power Globe API's flight and satellite routes, run on your own
// computer. The free flight feeds (OpenSky, adsb.lol, airplanes.live, adsb.fi) refuse requests
// from cloud servers such as Cloudflare's, but answer a home connection. The site uses the relay
// once it is set up under Live traffic ("Flight relay on this computer").
//
//   node relay/relay.mjs                      listens on http://localhost:8787
//   PORT=9000 node relay/relay.mjs            another port
//
// With an OpenSky account (more worldwide requests a day), put the API client's credentials.json
// from the OpenSky account page next to this file, or set OPENSKY_CLIENT_ID and
// OPENSKY_CLIENT_SECRET. Needs Node.js 18 or newer; nothing to install.
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { corsHeaders, route } from '../api/worker.js';

const DEFAULT_ORIGINS = 'https://pimdieks.github.io,http://localhost:5173,http://localhost:4173';
const ROUTES = /^\/(flights\/(global|area|military)|satellites\/[a-z]+)$/;
// Answers kept to serve when a feed fails or limits us, and how long a failure is remembered.
const BACKUP_MS = 6 * 3_600_000;
const FAILURE_MS = 30_000;

// Settings from the environment, and the OpenSky account from credentials.json if there is one.
export function relayEnv(env = process.env, credentialsPath = fileURLToPath(new URL('./credentials.json', import.meta.url))) {
  const out = {
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS || DEFAULT_ORIGINS,
    OPENSKY_CLIENT_ID: env.OPENSKY_CLIENT_ID,
    OPENSKY_CLIENT_SECRET: env.OPENSKY_CLIENT_SECRET,
  };
  if ((!out.OPENSKY_CLIENT_ID || !out.OPENSKY_CLIENT_SECRET) && existsSync(credentialsPath)) {
    const { clientId, clientSecret } = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    out.OPENSKY_CLIENT_ID = clientId;
    out.OPENSKY_CLIENT_SECRET = clientSecret;
  }
  return out;
}

// The request handler: answers from memory while an answer is fresh (as long as its
// Cache-Control allows), asks each feed at most once at a time, and serves the last good answer
// when a feed fails.
export function createRelay(env, fetchFn = fetch) {
  const cache = new Map();
  const pending = new Map();

  async function answer(url) {
    const key = url.pathname + url.search;
    const now = Date.now();
    const hit = cache.get(key);
    if (hit && now < hit.fresh) return hit;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      try {
        const res = await route(url, env, fetchFn);
        const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('Cache-Control') ?? '')?.[1] ?? 0);
        const entry = { status: 200, type: res.headers.get('Content-Type') ?? 'application/json', body: Buffer.from(await res.arrayBuffer()), fresh: now + maxAge * 1000, kept: now + BACKUP_MS };
        cache.set(key, entry);
        return entry;
      } catch (err) {
        if (hit && now < hit.kept) return hit;
        const entry = { status: err.status ?? 502, type: 'application/json', body: Buffer.from(JSON.stringify({ error: err.message })), fresh: now + FAILURE_MS, kept: 0 };
        if (entry.status >= 429) cache.set(key, entry);
        return entry;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, task);
    return task;
  }

  return async function handle(req, res) {
    const origin = req.headers.origin ?? '';
    const cors = corsHeaders(origin, env);
    // Chrome asks before a public site may reach a server on this computer.
    const headers = { ...cors, 'Access-Control-Allow-Private-Network': 'true' };
    if (origin && !cors['Access-Control-Allow-Origin']) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Origin not allowed');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'Access-Control-Max-Age': '86400' }).end();
      return;
    }
    const url = new URL(req.url, 'http://relay');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method !== 'GET') {
      res.writeHead(405, headers).end();
      return;
    }
    if (path === '/' || path === '/health') {
      const body = { name: 'Power Globe flight relay', opensky: env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET ? 'account' : 'anonymous' };
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      return;
    }
    if (!ROUTES.test(path)) {
      res.writeHead(404, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const entry = await answer(url);
    res.writeHead(entry.status, { ...headers, 'Content-Type': entry.type, 'Cache-Control': 'no-store' }).end(entry.body);
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = relayEnv();
  const port = Number(process.env.PORT || 8787);
  http.createServer(createRelay(env)).listen(port, 'localhost', () => {
    console.log(`Power Globe flight relay on http://localhost:${port} (OpenSky ${env.OPENSKY_CLIENT_ID ? 'account' : 'anonymous'}).`);
    console.log('On the site, open Live traffic > "Flight relay on this computer" and choose Use. Ctrl+C stops the relay.');
  });
}
