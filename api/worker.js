// Power Globe API: a small proxy, run as a Cloudflare Worker, for the open data services that do
// not accept requests straight from web pages. It fetches them server-side, caches the answers
// at the edge (so many visitors share one upstream request) and adds CORS headers.
//
//   GET /                         what is here
//   GET /flights/global           all aircraft (OpenSky Network), cached 2 min with an account, else 5 min
//   GET /flights/area?lat&lon&nm  aircraft around a point, up to 250 NM (adsb.lol, airplanes.live, adsb.fi), cached 10 s
//   GET /flights/military         military aircraft worldwide (same feeds), cached 30 s
//   GET /metar?ids=EHAM,KJFK      latest METARs (NOAA Aviation Weather Center), cached 2 min
//   GET /satellites/<group>       orbital elements as TLE (CelesTrak), cached 2 h
//   GET /forecast?<Open-Meteo query>  Open-Meteo forecasts (up to 100 places), cached 30 min
//   GET /tiles/openaip/<z>/<x>/<y>.png  aeronautical chart tiles (openAIP: airspaces, airports,
//                                 navaids), cached 1 day; needs OPENAIP_API_KEY
//
// The flight feeds limit or refuse Cloudflare's servers, whose addresses many sites share. With
// a flight relay (relay/api-relay.mjs) running on a machine of one's own, such as a Raspberry Pi at
// home, they are asked through that instead.
//
// Nothing upstream is ever asked more than its cache allows: every answer is cached at the edge
// and shared by all visitors, a backup of it is kept for 6 hours and served if the service
// fails or limits us (rather than asking again), and each visitor may make at most
// RATE_LIMIT requests a minute. A flight feed that refuses or limits us is also remembered in the
// edge cache and left alone for a while (6 hours for a refusal, a minute or as long as it asks for
// a limit; separately when asked direct and through the relay), so the other feeds answer
// meanwhile instead of it being asked again on every request.
//
// Settings (wrangler.toml [vars] or secrets): ALLOWED_ORIGINS, a comma-separated list of sites
// allowed to use it ("*" for any); OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET (optional) for an
// OpenSky account's larger allowance; OPENAIP_API_KEY (optional) for the aeronautical chart;
// FLIGHT_RELAY_URL and FLIGHT_RELAY_KEY (optional) for the flight relay: its public address and
// the secret it was started with.

const USER_AGENT = 'power-globe-api (https://github.com/PimDieks/Power-Globe)';
const DEFAULT_ORIGINS = 'https://pimdieks.github.io,http://localhost:5173,http://localhost:4173';
const SATELLITE_GROUPS = ['active', 'stations', 'starlink', 'gnss', 'weather', 'military'];
const FORECAST_PARAMS = new Set(['latitude', 'longitude', 'elevation', 'hourly', 'forecast_days', 'timezone', 'temporal_resolution', 'wind_speed_unit']);
const MAX_FORECAST_PLACES = 100;
// Answers kept to serve when a service fails or limits us.
const BACKUP_SECONDS = 6 * 3600;
// Give up on a service after this long, and remember a failure for a while so that neither the
// service nor visitors are kept waiting on it again straight away.
const UPSTREAM_TIMEOUT_MS = 10_000;
// Through the relay there is one more hop, the last of it up a home connection.
const RELAY_TIMEOUT_MS = 20_000;
const FAILURE_SECONDS = 120;
// How long a flight feed is left alone after it limits the API (unless it says for how long), and
// after it refuses the API.
const LIMITED_SECONDS = 60;
const BLOCKED_SECONDS = 6 * 3600;
// Requests a minute per visitor (counted per Worker instance, so roughly). Map tiles come many
// at a time as the view moves, so they have their own, larger allowance.
export const RATE_LIMIT = 120;
export const TILE_RATE_LIMIT = 900;
// The chart's tile levels: openAIP draws them down to level 14 (about 10 m per pixel).
export const OPENAIP_MAX_LEVEL = 14;

export const ADSB_FEEDS = [
  { name: 'adsb.lol', military: 'https://api.adsb.lol/v2/mil', area: (lat, lon, nm) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${nm}` },
  { name: 'airplanes.live', military: 'https://api.airplanes.live/v2/mil', area: (lat, lon, nm) => `https://api.airplanes.live/v2/point/${lat}/${lon}/${nm}` },
  { name: 'adsb.fi', military: 'https://opendata.adsb.fi/api/v2/mil', area: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
];

// Asked through the flight relay when there is one; the same hosts as in relay/api-relay.mjs.
export const RELAYED_HOSTS = ['opensky-network.org', 'auth.opensky-network.org', 'api.adsb.lol', 'api.airplanes.live', 'opendata.adsb.fi'];
const relayOn = (env) => Boolean(env.FLIGHT_RELAY_URL && env.FLIGHT_RELAY_KEY);

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    Object.assign(this, details);
  }
}

async function upstream(fetchFn, url, init = {}, env = {}) {
  const { host, pathname, search } = new URL(url);
  const relayed = relayOn(env) && RELAYED_HOSTS.includes(host);
  const target = relayed ? `${env.FLIGHT_RELAY_URL.replace(/\/+$/, '')}/${host}${pathname}${search}` : url;
  const via = relayed ? ' through the relay' : '';
  let res;
  try {
    res = await fetchFn(target, {
      ...init,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*', ...init.headers, ...(relayed && { 'X-Relay-Key': env.FLIGHT_RELAY_KEY }) },
      signal: AbortSignal.timeout(relayed ? RELAY_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    throw new HttpError(502, `${host} unreachable${via} (${err.message})`);
  }
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('Retry-After'));
    // The relay marks the answers it passes on, so one without the mark is the relay's own.
    throw new HttpError(res.status === 429 ? 429 : 502, `${host} answered ${res.status}${via}`, {
      answered: res.status,
      retryAfter: retryAfter > 0 ? retryAfter : undefined,
      byRelay: relayed && !res.headers.has('X-Answered-By'),
    });
  }
  return res;
}

// How many seconds a feed is left alone after this failure, 0 for none. An answer through the
// relay without its mark is the relay's own and says nothing about the feed, except its 404, which
// means it does not ask this feed (a minute, so a corrected relay list applies soon). Only a
// feed's own 401 or 403 is a refusal worth 6 hours.
function coolOff(err) {
  if (err.answered === 429) return err.retryAfter ? Math.ceil(Math.min(900, Math.max(5, err.retryAfter))) : LIMITED_SECONDS;
  if (err.byRelay) return err.answered === 404 ? LIMITED_SECONDS : 0;
  return err.answered === 401 || err.answered === 403 ? BLOCKED_SECONDS : 0;
}

// The edge cache keeps one small entry per feed that is being left alone: until when, and why. A
// refusal is about the connection that asked, so asking direct and through the relay have their own.
const feedKey = (origin, env, feed) => new Request(`${origin}/__feeds/${relayOn(env) ? 'relay' : 'direct'}/${feed.name}`);

// Why the feed is being left alone, if it is. A cache that fails counts as no memory.
async function leftAlone(cache, key) {
  try {
    const res = await cache?.match(key);
    const memory = res && (await res.json());
    return memory?.until > Date.now() ? memory.message : undefined;
  } catch {
    return undefined;
  }
}

async function leaveAlone(cache, key, seconds, message) {
  try {
    const body = JSON.stringify({ until: Date.now() + seconds * 1000, message });
    await cache?.put(key, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${seconds}` } }));
  } catch (err) {
    console.error(`Could not remember a failed feed (${key.url})`, err);
  }
}

// The first ADS-B feed that answers, skipping those being left alone; if none does, an error
// saying what each one answered.
async function fromFeeds(fetchFn, urlFor, env, cache, origin) {
  const failures = [];
  for (const feed of ADSB_FEEDS) {
    const key = feedKey(origin, env, feed);
    const reason = await leftAlone(cache, key);
    if (reason) {
      failures.push(`${feed.name} is not asked for now (${reason})`);
      continue;
    }
    try {
      const res = await upstream(fetchFn, urlFor(feed), {}, env);
      return { source: feed.name, data: await res.json() };
    } catch (err) {
      failures.push(err.message);
      const seconds = coolOff(err);
      if (seconds > 0) await leaveAlone(cache, key, seconds, err.message);
    }
  }
  throw new HttpError(502, failures.join('; ') || 'No ADS-B feed answered');
}

let openskyToken = null;
// An OpenSky OAuth2 token when an account is configured, else anonymous access (also when the
// account's token cannot be had, so flights still load on the anonymous allowance).
async function openskyHeaders(fetchFn, env) {
  if (!openskyAccount(env)) return {};
  if (!openskyToken || openskyToken.expires < Date.now() + 30_000) {
    try {
      const res = await upstream(fetchFn, 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.OPENSKY_CLIENT_ID, client_secret: env.OPENSKY_CLIENT_SECRET }),
      }, env);
      const { access_token, expires_in } = await res.json();
      openskyToken = { value: access_token, expires: Date.now() + expires_in * 1000 };
    } catch (err) {
      console.error('OpenSky sign-in failed; asking anonymously', err);
      return {};
    }
  }
  return { Authorization: `Bearer ${openskyToken.value}` };
}

const openskyAccount = (env) => Boolean(env.OPENSKY_CLIENT_ID && env.OPENSKY_CLIENT_SECRET);
// How long a worldwide answer is shared. Each costs 4 OpenSky credits: an account has 4,000 a
// day (one answer every 2 minutes uses under 3,000), anonymous use 400 (every 5 minutes, about
// a third of a day).
const openskySeconds = (env) => (openskyAccount(env) ? 120 : 300);

const json = (body, maxAge) =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}` } });

const number = (v, min, max) => {
  const n = Number(v);
  if (v == null || v === '' || Number.isNaN(n) || n < min || n > max) throw new HttpError(400, 'Bad request');
  return n;
};

// Answers a request (without CORS headers or caching, see the fetch handler). The cache is only
// used to remember which flight feeds are being left alone.
export async function route(url, env = {}, fetchFn = fetch, cache) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') {
    return json(
      {
        name: 'Power Globe API',
        routes: ['/flights/global', '/flights/area?lat=&lon=&nm=', '/flights/military', '/metar?ids=', '/satellites/<group>', '/forecast?', '/tiles/openaip/<z>/<x>/<y>.png'],
        opensky: openskyAccount(env) ? 'account' : 'anonymous',
        chart: env.OPENAIP_API_KEY ? 'openAIP' : 'no key',
        relay: relayOn(env) ? 'on' : 'off',
      },
      300,
    );
  }
  if (path === '/flights/global') {
    const res = await upstream(fetchFn, 'https://opensky-network.org/api/states/all?extended=1', { headers: await openskyHeaders(fetchFn, env) }, env);
    // Passed on unread: reading and rewriting the worldwide answer (over 1 MB) takes longer than
    // the free plan's 10 ms of processing time per request.
    const data = (await res.text()).trim();
    if (!data.startsWith('{')) throw new HttpError(502, 'OpenSky answered without flights');
    return new Response(`{"source":"OpenSky Network","fetched":${Date.now()},"data":${data}}`, {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${openskySeconds(env)}` },
    });
  }
  if (path === '/flights/area') {
    // Snapped so nearby views share cached answers.
    const lat = Math.round(number(url.searchParams.get('lat'), -90, 90) * 4) / 4;
    const lon = Math.round(number(url.searchParams.get('lon'), -180, 180) * 4) / 4;
    const nm = Math.min(250, Math.ceil(number(url.searchParams.get('nm'), 1, 1000) / 25) * 25);
    return json({ fetched: Date.now(), ...(await fromFeeds(fetchFn, (f) => f.area(lat, lon, nm), env, cache, url.origin)) }, 10);
  }
  if (path === '/flights/military') {
    return json({ fetched: Date.now(), ...(await fromFeeds(fetchFn, (f) => f.military, env, cache, url.origin)) }, 30);
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
  const tile = path.match(/^\/tiles\/openaip\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (tile) {
    const [z, x, y] = tile.slice(1).map(Number);
    if (z > OPENAIP_MAX_LEVEL || x >= 2 ** z || y >= 2 ** z) throw new HttpError(404, 'No such tile');
    if (!env.OPENAIP_API_KEY) throw new HttpError(503, 'The chart needs an openAIP API key (OPENAIP_API_KEY)');
    const res = await upstream(fetchFn, `https://api.tiles.openaip.net/api/data/openaip/${z}/${x}/${y}.png?apiKey=${encodeURIComponent(env.OPENAIP_API_KEY)}`, {
      headers: { Accept: 'image/png' },
    });
    return new Response(res.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
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
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (url.pathname.startsWith('/tiles/') ? overLimit(`tiles:${ip}`, Date.now(), TILE_RATE_LIMIT) : overLimit(ip)) {
        return new Response(JSON.stringify({ error: 'Too many requests; slow down' }), { status: 429, headers: { ...cors, 'Content-Type': 'application/json', 'Retry-After': '60' } });
      }
      try {
        res = await route(url, env, fetch, cache);
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
          res = new Response(JSON.stringify({ error: err.message }), {
            status: err.status ?? 502,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${FAILURE_SECONDS}` },
          });
          // Bad requests are the visitor's; failures upstream are remembered briefly.
          if (cache && (err.status ?? 502) >= 429) ctx?.waitUntil(cache.put(key, res.clone()));
        }
      }
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
