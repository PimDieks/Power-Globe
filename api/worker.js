// Power Globe API: a small proxy, run as a Cloudflare Worker, for the open data services that do
// not accept requests straight from web pages. It fetches them server-side, caches the answers
// at the edge (so many visitors share one upstream request) and adds CORS headers.
//
//   GET /                         what is here
//   GET /flights/global           all aircraft (OpenSky Network), cached 60 s
//   GET /flights/area?lat&lon&nm  aircraft around a point, up to 250 NM (adsb.lol, airplanes.live, adsb.fi), cached 10 s
//   GET /flights/military         military aircraft worldwide (same feeds), cached 30 s
//   GET /metar?ids=EHAM,KJFK      latest METARs (NOAA Aviation Weather Center), cached 2 min
//   GET /satellites/<group>       orbital elements as TLE (CelesTrak), cached 2 h
//   GET /forecast?<Open-Meteo query>  Open-Meteo forecasts (up to 100 places), cached 30 min
//
// Nothing upstream is ever asked more than its cache allows: every answer is cached at the edge
// and shared by all visitors, a backup of it is kept for 6 hours and served if the service
// fails or limits us (rather than asking again), and each visitor may make at most
// RATE_LIMIT requests a minute.
//
// Settings (wrangler.toml [vars] or secrets): ALLOWED_ORIGINS, a comma-separated list of sites
// allowed to use it ("*" for any); OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET (optional) for an
// OpenSky account's larger allowance.

const USER_AGENT = 'power-globe-api (https://github.com/PimDieks/Power-Globe)';
const DEFAULT_ORIGINS = 'https://pimdieks.github.io,http://localhost:5173,http://localhost:4173';
const SATELLITE_GROUPS = ['active', 'stations', 'starlink', 'gnss', 'weather', 'military'];
const FORECAST_PARAMS = new Set(['latitude', 'longitude', 'elevation', 'hourly', 'forecast_days', 'timezone', 'temporal_resolution', 'wind_speed_unit']);
const MAX_FORECAST_PLACES = 100;
// Answers kept to serve when a service fails or limits us.
const BACKUP_SECONDS = 6 * 3600;
// Requests a minute per visitor (counted per Worker instance, so roughly).
export const RATE_LIMIT = 120;

export const ADSB_FEEDS = [
  { name: 'adsb.lol', military: 'https://api.adsb.lol/v2/mil', area: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
  { name: 'airplanes.live', military: 'https://api.airplanes.live/v2/mil', area: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
  { name: 'adsb.fi', military: 'https://opendata.adsb.fi/api/v2/mil', area: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function upstream(fetchFn, url, init = {}) {
  const res = await fetchFn(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...init.headers }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new HttpError(res.status === 429 ? 429 : 502, `${new URL(url).host} answered ${res.status}`);
  return res;
}

// The first ADS-B feed that answers.
async function fromFeeds(fetchFn, urlFor) {
  let last;
  for (const feed of ADSB_FEEDS) {
    try {
      const res = await upstream(fetchFn, urlFor(feed));
      return { source: feed.name, data: await res.json() };
    } catch (err) {
      last = err;
    }
  }
  throw last ?? new HttpError(502, 'No ADS-B feed answered');
}

let openskyToken = null;
// An OpenSky OAuth2 token when an account is configured, else anonymous access.
async function openskyHeaders(fetchFn, env) {
  if (!env.OPENSKY_CLIENT_ID || !env.OPENSKY_CLIENT_SECRET) return {};
  if (!openskyToken || openskyToken.expires < Date.now() + 30_000) {
    const res = await upstream(fetchFn, 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET }),
    });
    const { access_token, expires_in } = await res.json();
    openskyToken = { value: access_token, expires: Date.now() + expires_in * 1000 };
  }
  return { Authorization: `Bearer ${openskyToken.value}` };
}

const json = (body, maxAge) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` } });

const number = (v, min, max) => {
  const n = Number(v);
  if (v == null || v === '' || Number.isNaN(n) || n < min || n > max) throw new HttpError(400, 'Bad request');
  return n;
};

// Answers a request (without CORS headers or caching, see the fetch handler).
export async function route(url, env = {}, fetchFn = fetch) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') {
    return json({ name: 'Power Globe API', routes: ['/flights/global', '/flights/area?lat=&lon=&nm=', '/flights/military', '/metar?ids=', '/satellites/<group>'] }, 3600);
  }
  if (path === '/flights/global') {
    const res = await upstream(fetchFn, 'https://opensky-network.org/api/states/all?extended=1', { headers: await openskyHeaders(fetchFn, env) });
    return json({ source: 'OpenSky Network', fetched: Date.now(), data: await res.json() }, 60);
  }
  if (path === '/flights/area') {
    // Snapped so nearby views share cached answers.
    const lat = Math.round(number(url.searchParams.get('lat'), -90, 90) * 4) / 4;
    const lon = Math.round(number(url.searchParams.get('lon'), -180, 180) * 4) / 4;
    const nm = Math.min(250, Math.ceil(number(url.searchParams.get('nm'), 1, 1000) / 25) * 25);
    return json({ fetched: Date.now(), ...(await fromFeeds(fetchFn, (f) => f.area(lat, lon, nm))) }, 10);
  }
  if (path === '/flights/military') {
    return json({ fetched: Date.now(), ...(await fromFeeds(fetchFn, (f) => f.military)) }, 30);
  }
  if (path === '/metar') {
    const ids = (url.searchParams.get('ids') ?? '').toUpperCase();
    if (!/^[A-Z0-9]{3,4}(,[A-Z0-9]{3,4}){0,19}$/.test(ids)) throw new HttpError(400, 'ids: up to 20 ICAO codes, comma-separated');
    const res = await upstream(fetchFn, `https://aviationweather.gov/api/data/metar?ids=${ids}&format=json&hours=3`);
    const text = await res.text();
    return new Response(text.trim() ? text : '[]', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' } });
  }
  if (path === '/forecast') {
    const params = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (!FORECAST_PARAMS.has(key) || value.length > 4000) throw new HttpError(400, `Unsupported parameter: ${key}`);
      params.set(key, value);
    }
    const places = (params.get('latitude') ?? '').split(',').filter(Boolean).length;
    if (!places || places > MAX_FORECAST_PLACES) throw new HttpError(400, `latitude: 1 to ${MAX_FORECAST_PLACES} places`);
    const res = await upstream(fetchFn, `https://api.open-meteo.com/v1/forecast?${params}`);
    return new Response(await res.text(), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=1800' } });
  }
  const satellites = path.match(/^\/satellites\/([a-z]+)$/);
  if (satellites) {
    if (!SATELLITE_GROUPS.includes(satellites[1])) throw new HttpError(404, 'Unknown satellite group');
    const res = await upstream(fetchFn, `https://celestrak.org/NORAD/elements/gp.php?GROUP=${satellites[1]}&FORMAT=tle`);
    const text = await res.text();
    if (!/^1 /m.test(text)) throw new HttpError(502, `CelesTrak: ${text.trim().slice(0, 80)}`);
    return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=7200' } });
  }
  throw new HttpError(404, 'Not found');
}

const visitors = new Map();
// Whether a visitor has made too many requests this minute.
export function overLimit(ip, now = Date.now(), limit = RATE_LIMIT) {
  if (visitors.size > 10_000) visitors.clear();
  const v = visitors.get(ip);
  if (!v || now - v.start > 60_000) {
    visitors.set(ip, { start: now, count: 1 });
    return false;
  }
  v.count++;
  return v.count > limit;
}

export function corsHeaders(origin, env = {}) {
  const allowed = (env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(',').map((s) => s.trim());
  const allow = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : null;
  return allow ? { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' } : {};
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') ?? '';
    const cors = corsHeaders(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Max-Age': '86400' } });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    if (origin && !cors['Access-Control-Allow-Origin']) return new Response('Origin not allowed', { status: 403 });

    const url = new URL(request.url);
    const cache = globalThis.caches?.default;
    const key = new Request(url.toString(), { method: 'GET' });
    const backupKey = new Request(`${url.origin}/__backup${url.pathname}${url.search}`, { method: 'GET' });
    let res = await cache?.match(key);
    if (!res) {
      if (overLimit(request.headers.get('CF-Connecting-IP') ?? 'unknown')) {
        return new Response(JSON.stringify({ error: 'Too many requests; slow down' }), { status: 429, headers: { ...cors, 'Content-Type': 'application/json', 'Retry-After': '60' } });
      }
      try {
        res = await route(url, env);
        if (cache) {
          const backup = new Response(res.clone().body, res);
          backup.headers.set('Cache-Control', `public, max-age=${BACKUP_SECONDS}`);
          ctx?.waitUntil(Promise.all([cache.put(key, res.clone()), cache.put(backupKey, backup)]));
        }
      } catch (err) {
        // Serve the last good answer rather than asking a failing or limiting service again.
        res = await cache?.match(backupKey);
        if (res) {
          res = new Response(res.body, res);
          res.headers.set('X-Power-Globe-Backup', '1');
          res.headers.set('Cache-Control', 'public, max-age=60');
        } else {
          res = new Response(JSON.stringify({ error: err.message }), { status: err.status ?? 502, headers: { 'Content-Type': 'application/json' } });
        }
      }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
