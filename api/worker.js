// Power Globe API: a small proxy, run as a Cloudflare Worker, for the open data services that do
// not accept requests straight from web pages. It fetches them server-side, caches the answers
// at the edge (so many visitors share one upstream request) and adds CORS headers.
//
//   GET /                         what is here
//   GET /flights/global           all aircraft (OpenSky Network), cached 2 min with an account, else 5 min
//   GET /flights/area?lat&lon&nm  aircraft around a point, up to 250 NM (adsb.lol, adsb.fi), cached 10 s
//   GET /flights/military         military aircraft worldwide (same feeds), cached 30 s
//   GET /track?icao24=<hex>       where an aircraft has been on its current flight (OpenSky Network),
//                                 cached 1 min per aircraft, at most 13 an hour asked of OpenSky
//   GET /metar?ids=EHAM,KJFK      latest METARs (NOAA Aviation Weather Center), cached 2 min
//   GET /taf?ids=EHAM,KJFK        latest TAFs (the same source), cached 2 min
//   GET /satellites/<group>       orbital elements as TLE (CelesTrak), cached 2 h
//   GET /forecast?<Open-Meteo query>  Open-Meteo forecasts (up to 100 places), cached 30 min
//   GET /tiles/openaip/<z>/<x>/<y>.png  aeronautical chart tiles (openAIP: airspaces, airports,
//                                 navaids), cached 1 day; needs OPENAIP_API_KEY
//   GET /access/roads?airport=EHAM  road traffic around a Dutch airport (NDW open data, read by the
//                                 flight relay, which is too much for a Worker), cached 1 min; a
//                                 backup up to 10 min old is marked stale; says so when the
//                                 relay is off or its road job (NDW=1) is not switched on
//   GET /access/trains?airport=EHAM  the next trains from the airport's station and the disruptions
//                                 through it (NS Reisinformatie API; needs NS_API_KEY, else says so
//                                 without asking NS), cached 1 min (disruptions 2 min); a backup up
//                                 to 5 min old is marked stale
//   GET /access/buses?airport=EHAM  the buses due at the terminal stops in the next hour (OVapi, the
//                                 open real-time feed of the Dutch bus operators), with delays and
//                                 the cancellations the feed reports, cached 1 min; stale backup as above
//
// The flight feeds limit or refuse Cloudflare's servers, whose addresses many sites share. With
// a flight relay (relay/api-relay.mjs) running on a machine of one's own, such as a Raspberry Pi at
// home, they are asked through that instead.
//
// Nothing upstream is ever asked more than its cache allows: every answer is cached at the edge
// and shared by all visitors, a backup of it is kept for 6 hours and served if the service
// fails or limits us (rather than asking again; not for tracks, METARs or TAFs, which are only
// useful while current), and each visitor may make at most
// RATE_LIMIT requests a minute. A flight feed that refuses or limits us is also remembered in the
// edge cache and left alone for a while (6 hours for a refusal, a minute or as long as it asks for
// a limit; separately when asked direct and through the relay), so the other feeds answer
// meanwhile instead of it being asked again on every request.
//
// Settings (wrangler.toml [vars] or secrets): ALLOWED_ORIGINS, a comma-separated list of sites
// allowed to use it ("*" for any); OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET (optional) for an
// OpenSky account's larger allowance; OPENAIP_API_KEY (optional) for the aeronautical chart;
// NS_API_KEY (optional) for the train times (a key from apiportal.ns.nl);
// FLIGHT_RELAY_URL and FLIGHT_RELAY_KEY (optional) for the flight relay: its public address and
// the secret it was started with.

const USER_AGENT = 'power-globe-api (https://github.com/PimDieks/Power-Globe)';
const DEFAULT_ORIGINS = 'https://pimdieks.github.io,http://localhost:5173,http://localhost:4173';
const SATELLITE_GROUPS = ['active', 'stations', 'starlink', 'gnss', 'weather', 'military'];
const FORECAST_PARAMS = new Set(['latitude', 'longitude', 'elevation', 'hourly', 'forecast_days', 'timezone', 'temporal_resolution', 'wind_speed_unit']);
const MAX_FORECAST_PLACES = 100;
// A track is thinned to about this many points. OpenSky gives 90 to 165 for a long flight.
export const MAX_TRACK_POINTS = 300;
const TRACK_SECONDS = 60;
const FT_PER_M = 3.28084;
// A track costs 4 OpenSky credits, and the worldwide flights use most of the same account's
// daily budget. So tracks are asked for at most TRACKS_PER_HOUR times an hour (counted in the edge
// cache, so per Cloudflare location, and approximately): an account has 4,000 credits a day,
// 1,000 tracks, and a third of that is about 333 a day, 13 an hour (24 x 13 x 4 = 1,248
// credits); anonymous use has 400 credits, a third of which is 33 tracks a day, 1 an hour.
// Beyond that /track answers "not now" until the hour is over. Each visitor may also ask for
// at most TRACK_RATE_LIMIT tracks a minute, far under the limit for other requests.
export const TRACKS_PER_HOUR = 13;
export const TRACKS_PER_HOUR_ANONYMOUS = 1;
export const TRACK_RATE_LIMIT = 10;
// Answers kept to serve when a service fails or limits us.
const BACKUP_SECONDS = 6 * 3600;
// Road traffic is only worth showing while it is recent.
export const ACCESS_BACKUP_SECONDS = 600;
const ACCESS_SECONDS = 60;
// Train and bus times are worth even less once old.
export const ACCESS_TRANSIT_BACKUP_SECONDS = 300;
const DISRUPTIONS_SECONDS = 120;
// The airports the relay reads road traffic for (the Dutch ones with scheduled flights, as in
// public/data/ndw-sites.json); asking for any other is refused here, not passed on.
export const ACCESS_AIRPORTS = ['EHAM', 'EHEH', 'EHRD', 'EHBK', 'EHGG'];
// The stations the train times are asked for: a Dutch airport with a railway station of its own.
// Schiphol is the only one (Eindhoven, Rotterdam The Hague, Maastricht Aachen and Groningen Airport
// Eelde have none). `uic` is the station's UIC code, as the disruptions name their stations.
export const TRAIN_STATIONS = { EHAM: { code: 'ASB', uic: '8400058', name: 'Schiphol Airport' } };
// The bus stops OVapi is asked about, per airport: stop areas (/stopareacode) and single stops
// (/tpc, by timing point code). The stop area "schns" (Schiphol, Airport) holds only one stop, 57330760,
// which has no passes; the terminal's bus bays are separate stops that belong to no stop area, so they
// are asked for by code (checked on 2026-10-14): the "Schiphol, Airport" bays 57330221, 57330222,
// 57330224, 57330620, 57330630, 57330730 and 57332107, and the "Schiphol Airport/Plaza" stops
// 57330740 and 57332108. The stop areas of Uiverweg (schuvw), Marechaussee (schjkm) and Anchoragelaan
// (schang) are offices and car parks away from the terminal, so they are left out, and so is the
// car park shuttle at "Schiphol, Plaza" (57339004).
export const BUS_STOPS = {
  EHAM: { areas: [], stops: ['57330760', '57330221', '57330222', '57330224', '57330620', '57330630', '57330730', '57330740', '57332107', '57332108'] },
};
export const BUS_WINDOW_MINUTES = 60;
// A busy hour at Schiphol's terminal has about 70 departures; the cap only guards against a runaway answer.
const MAX_BUS_PASSES = 120;
// A pass is live only when the feed updated it this recently. OVapi keeps TripStopStatus DRIVING on
// buses it has heard nothing from for hours, and their expected times are then just the schedule.
export const BUS_LIVE_MAX_AGE_MS = 15 * 60_000;
const MAX_TRAINS = 12;
const MAX_DISRUPTIONS = 6;
const OVAPI = 'http://v0.ovapi.nl';
const NS_API = 'https://gateway.apiportal.ns.nl/reisinformatie-api/api';
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
  { name: 'adsb.fi', military: 'https://opendata.adsb.fi/api/v2/mil', area: (lat, lon, nm) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${nm}` },
];

// Asked through the flight relay when there is one; the same hosts as in relay/api-relay.mjs.
export const RELAYED_HOSTS = ['opensky-network.org', 'auth.opensky-network.org', 'api.adsb.lol', 'opendata.adsb.fi'];
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

// What is remembered of a feed being left alone ({ until, message }), if it is. A cache that
// fails counts as no memory.
async function memoryOf(cache, key) {
  try {
    const res = await cache?.match(key);
    const memory = res && (await res.json());
    return memory?.until > Date.now() ? memory : undefined;
  } catch {
    return undefined;
  }
}

// Why the feed is being left alone, if it is.
async function leftAlone(cache, key) {
  return (await memoryOf(cache, key))?.message;
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

// OpenSky's /tracks/all answer ({ icao24, callsign, startTime, endTime, path: [[time, lat, lon,
// baro altitude in metres, track, on ground], ...] }) as the points the page draws: [time in
// seconds, lat, lon, altitude in feet or null, 1 on the ground else 0], thinned evenly (keeping the
// first and last) to at most `max`. Points without a position (gaps) are left out.
export function compactTrack(data, max = MAX_TRACK_POINTS) {
  const path = (Array.isArray(data?.path) ? data.path : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]));
  const picked = path.length <= max ? path : Array.from({ length: max }, (_, i) => path[Math.round((i * (path.length - 1)) / (max - 1))]);
  return picked.map(([t, lat, lon, altitude, , onGround]) => [
    t,
    Math.round(lat * 1e4) / 1e4,
    Math.round(lon * 1e4) / 1e4,
    Number.isFinite(altitude) ? Math.round(altitude * FT_PER_M) : null,
    onGround ? 1 : 0,
  ]);
}

// An aircraft's track on its current flight, asked of OpenSky (through the relay, like the
// flights). OpenSky answers 404 for an aircraft with no current flight, which is an answer
// here (no points), not a failure. Like a flight feed, OpenSky is left alone for a while after it
// refuses or limits us.
async function track(icao24, fetchFn, env, cache, origin) {
  const key = feedKey(origin, env, { name: 'opensky-tracks' });
  const memory = await memoryOf(cache, key);
  // The answer is remembered no longer than the feed is left alone.
  if (memory) throw new HttpError(502, `OpenSky is not asked for now (${memory.message})`, { cacheSeconds: Math.ceil((memory.until - Date.now()) / 1000) });
  await takeTrackTurn(cache, origin, env);
  let data = null;
  try {
    const res = await upstream(fetchFn, `https://opensky-network.org/api/tracks/all?icao24=${icao24}&time=0`, { headers: await openskyHeaders(fetchFn, env) }, env);
    data = await res.json();
  } catch (err) {
    // The relay's own 404 means it does not ask OpenSky; only OpenSky's is "no flight".
    if (err.answered !== 404 || err.byRelay) {
      const seconds = coolOff(err);
      if (seconds > 0) await leaveAlone(cache, key, seconds, err.message);
      throw err;
    }
  }
  const points = compactTrack(data);
  const endTime = Number(data?.endTime);
  return json(
    { source: 'OpenSky Network', icao24, callsign: String(data?.callsign ?? '').trim(), startTime: points[0]?.[0] ?? null, endTime: points.length && Number.isFinite(endTime) ? endTime : null, points },
    TRACK_SECONDS,
  );
}

// Counts a track asked of OpenSky against this hour's allowance, or refuses it when that is used.
// The count lives in the edge cache until the hour is over; without a cache there is no ceiling.
async function takeTrackTurn(cache, origin, env) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = new Request(`${origin}/__tracks/${hour}`);
  const seconds = Math.max(1, Math.ceil(((hour + 1) * 3_600_000 - Date.now()) / 1000));
  let used = 0;
  try {
    const res = await cache?.match(key);
    used = Number((res && (await res.json()))?.count) || 0;
  } catch {
    used = 0;
  }
  if (used >= (openskyAccount(env) ? TRACKS_PER_HOUR : TRACKS_PER_HOUR_ANONYMOUS)) {
    throw new HttpError(503, 'Tracks are not available for now (the hourly limit is reached)', { cacheSeconds: seconds });
  }
  try {
    await cache?.put(key, new Response(JSON.stringify({ count: used + 1 }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${seconds}` } }));
  } catch (err) {
    console.error('Could not count a track', err);
  }
}

const unavailable = (airport, reason) =>
  new Response(JSON.stringify({ available: false, airport, reason }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ACCESS_SECONDS}`, 'X-Power-Globe-Unavailable': '1' },
  });

// Road traffic near a Dutch airport, from the road job of the flight relay (NDW data: speeds at
// measurement sites and the jams, accidents and closures, within 25 km). Its answer is passed on
// unread, with "available" added: reading and rewriting it would take longer than the free plan's
// 10 ms of processing time. That the relay is off, or has no road job, is an answer, not a failure.
async function accessRoads(url, fetchFn, env) {
  const airport = (url.searchParams.get('airport') ?? '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(airport)) throw new HttpError(400, 'airport: a 4-letter ICAO code');
  if (!ACCESS_AIRPORTS.includes(airport)) throw new HttpError(404, `No road data for ${airport}`);
  if (!relayOn(env)) return unavailable(airport, 'The API has no flight relay, which the road data comes through');
  let res;
  let text;
  try {
    res = await fetchFn(`${env.FLIGHT_RELAY_URL.replace(/\/+$/, '')}/ndw/${airport}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'X-Relay-Key': env.FLIGHT_RELAY_KEY },
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    throw new HttpError(502, `The relay is unreachable (${err.message})`);
  }
  if (res.ok) {
    if (!text.startsWith('{') || text.length < 3) throw new HttpError(502, 'The relay answered without road data');
    return new Response(`{"available":true,${text.slice(1)}`, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ACCESS_SECONDS}` } });
  }
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: not an answer of the road job.
  }
  if (res.status === 503 && body.ndw === 'off') return unavailable(airport, "The relay's road job is switched off (NDW=1 in its settings)");
  if (res.status === 404 && body.ndw === 'on') return unavailable(airport, `No road data for ${airport}`);
  if (res.status === 404 && !body.ndw) return unavailable(airport, 'The relay does not have the road job yet; update it');
  throw new HttpError(502, `The relay answered ${res.status}${body.error ? ` (${body.error})` : ''}`);
}

// ---- Trains and buses ----

const airportOf = (url, table, what) => {
  const airport = (url.searchParams.get('airport') ?? '').toUpperCase();
  if (!/^[A-Z]{4}$/.test(airport)) throw new HttpError(400, 'airport: a 4-letter ICAO code');
  if (!Object.hasOwn(table, airport)) throw new HttpError(404, `No ${what} data for ${airport}`);
  return airport;
};

// Daylight saving time in the Netherlands runs from the last Sunday of March to the last Sunday of
// October, both at 01:00 UTC.
const HOUR = 3_600_000;
const lastSundayUtc = (year, month) => {
  const d = new Date(Date.UTC(year, month + 1, 0, 1));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
};
const amsterdamOffset = (utcMs) => {
  const year = new Date(utcMs).getUTCFullYear();
  return utcMs >= lastSundayUtc(year, 2) && utcMs < lastSundayUtc(year, 9) ? 2 * HOUR : HOUR;
};

// A time as the Dutch bus feed writes it, local time without a zone ("2026-10-14T21:52:00"), in ms
// since 1970, or null.
export function amsterdamMs(text) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?/.exec(text ?? '');
  if (!m) return null;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  const summer = wall - 2 * HOUR;
  return amsterdamOffset(summer) === 2 * HOUR ? summer : wall - HOUR;
}

// A time with a zone offset, as NS writes it ("2026-10-14T22:05:00+0200"), in ms, or null.
const zonedMs = (text) => {
  const ms = Date.parse(String(text ?? '').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  return Number.isFinite(ms) ? ms : null;
};

// Keeps what matters of NS's departures: { planned, actual, delayMin, destination, track,
// plannedTrack, cancelled, kind } in time order. Written for the documented shape
// ({ payload: { departures: [...] } }) and tolerant of what it lacks. Null when the body has no list.
export function compactDepartures(body, now = Date.now()) {
  const list = body?.payload?.departures ?? body?.departures;
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const d of list) {
    const planned = zonedMs(d?.plannedDateTime);
    if (planned == null) continue;
    const actual = zonedMs(d.actualDateTime) ?? planned;
    const cancelled = d.cancelled === true;
    // A train that left more than a minute ago is no longer a departure.
    if (!cancelled && Math.max(planned, actual) < now - 60_000) continue;
    out.push({
      planned,
      actual,
      delayMin: cancelled ? 0 : Math.max(0, Math.round((actual - planned) / 60_000)),
      destination: String(d.direction ?? '').slice(0, 60) || null,
      track: d.actualTrack ?? d.plannedTrack ?? null,
      plannedTrack: d.plannedTrack ?? null,
      cancelled,
      kind: d.product?.shortCategoryName ?? d.product?.categoryCode ?? null,
    });
  }
  out.sort((a, b) => a.planned - b.planned);
  return out.slice(0, MAX_TRAINS);
}

// The current disruptions that touch `station` ({ code, uic, name }): { id, kind, title, start, end,
// cause } with kind 'disruption' or 'maintenance'. One touches it when a station of one of its
// sections is the station (by station code or UIC code) or its title names the station. Null when
// the body is not a list of disruptions.
export function compactDisruptions(body, station) {
  const list = Array.isArray(body) ? body : body?.payload?.disruptions ?? body?.payload ?? body?.disruptions;
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const d of list) {
    if (!d || d.isActive === false) continue;
    const stations = (d.publicationSections ?? []).flatMap((p) => [...(p?.section?.stations ?? []), ...(p?.consequence?.section?.stations ?? [])]);
    const touches =
      stations.some((x) => String(x?.stationCode ?? '').toUpperCase() === station.code || String(x?.uicCode ?? '') === station.uic) ||
      String(d.title ?? '').toLowerCase().includes(station.name.toLowerCase());
    if (!touches) continue;
    out.push({
      id: String(d.id ?? ''),
      kind: d.type === 'MAINTENANCE' ? 'maintenance' : 'disruption',
      title: String(d.title ?? d.topic ?? 'Disruption').slice(0, 120),
      start: zonedMs(d.start),
      end: zonedMs(d.end),
      cause: d.timespans?.[0]?.cause?.label ?? null,
    });
  }
  out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'disruption' ? -1 : 1));
  return out.slice(0, MAX_DISRUPTIONS);
}

// Disruptions change slowly, so they are kept for two minutes in the edge cache, apart from the
// departures. Null when they cannot be had (the departures are still of use).
async function disruptionsFor(station, fetchFn, env, cache, origin) {
  const key = new Request(`${origin}/__feeds/ns/disruptions/${station.code}`);
  try {
    const kept = await cache?.match(key);
    if (kept) return (await kept.json()).list ?? null;
  } catch {
    // Not kept, or unreadable: ask again.
  }
  let list;
  try {
    const res = await upstream(fetchFn, `${NS_API}/v3/disruptions?isActive=true`, { headers: { 'Ocp-Apim-Subscription-Key': env.NS_API_KEY } });
    list = compactDisruptions(await res.json(), station);
  } catch (err) {
    console.error('NS disruptions failed', err.message);
    return null;
  }
  if (list) {
    try {
      await cache?.put(key, new Response(JSON.stringify({ list }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${DISRUPTIONS_SECONDS}` } }));
    } catch (err) {
      console.error('Could not keep the disruptions', err);
    }
  }
  return list;
}

// The next trains from an airport's station, and the disruptions through it. Without NS_API_KEY it
// says so and asks nobody.
async function accessTrains(url, fetchFn, env, cache) {
  const airport = airportOf(url, TRAIN_STATIONS, 'train');
  if (!env.NS_API_KEY) return unavailable(airport, 'needs an NS API key');
  const station = TRAIN_STATIONS[airport];
  const [res, disruptions] = await Promise.all([
    upstream(fetchFn, `${NS_API}/v2/departures?station=${station.code}&maxJourneys=${MAX_TRAINS + 6}&lang=en`, { headers: { 'Ocp-Apim-Subscription-Key': env.NS_API_KEY } }),
    disruptionsFor(station, fetchFn, env, cache, url.origin),
  ]);
  const now = Date.now();
  const departures = compactDepartures(await res.json().catch(() => null), now);
  if (!departures) throw new HttpError(502, 'NS answered without departures');
  return new Response(JSON.stringify({ available: true, airport, source: 'NS', station: station.name, fetched: now, departures, disruptions }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ACCESS_SECONDS}` },
  });
}

// Every stop of an OVapi answer, whether it came from /tpc ({ code: { Stop, Passes } }) or from
// /stopareacode ({ area: { code: { Stop, Passes } } }).
function* ovapiStops(body) {
  for (const value of Object.values(body ?? {})) {
    if (!value || typeof value !== 'object') continue;
    if (value.Passes && typeof value.Passes === 'object') yield value;
    else yield* ovapiStops(value);
  }
}

const RUNNING = new Set(['DRIVING', 'ARRIVED', 'PASSED']);
const LIVE_STATUS = new Set(['DRIVING', 'ARRIVED']);

// The buses due in the next `windowMinutes` at the stops of one or more OVapi answers, merged:
// { line, destination, operator, stop, planned, expected, delayMin, status, live, cancelled, contradicted }
// by expected time, at most `limit` of them. `live` is true when the pass is reported DRIVING or ARRIVED
// and the feed updated it (LastUpdateTimeStamp) within BUS_LIVE_MAX_AGE_MS of `now`; any other pass has
// only its schedule behind its times. The delay is expected against scheduled in minutes, never below 0 (a bus ahead of
// time is on time). A pass the feed marks CANCEL is a cancellation only when its trip is not also
// reported DRIVING, ARRIVED or PASSED at any stop (the feed keeps CANCEL on trips that run); one that
// is contradicted that way is `contradicted` and not `cancelled`. Buses that end their trip at the
// stop are arrivals and are left out.
export function mergeBusPasses(bodies, now = Date.now(), windowMinutes = BUS_WINDOW_MINUTES, limit = MAX_BUS_PASSES) {
  const found = [];
  const seen = new Set();
  const running = new Set();
  const tripOf = (p) => [p.DataOwnerCode, p.LinePlanningNumber ?? p.LinePublicNumber, p.OperationDate ?? p.LocalServiceLevelCode, p.JourneyNumber].join(':');
  for (const body of bodies) {
    for (const stop of ovapiStops(body)) {
      for (const p of Object.values(stop.Passes)) {
        const trip = tripOf(p);
        if (RUNNING.has(p.TripStopStatus)) running.add(trip);
        // Arrivals that end the trip here, and buses that are gone, are not departures.
        if (p.JourneyStopType === 'LAST' || p.TripStopStatus === 'PASSED') continue;
        const planned = amsterdamMs(p.TargetDepartureTime ?? p.TargetArrivalTime);
        if (planned == null) continue;
        const expected = amsterdamMs(p.ExpectedDepartureTime ?? p.ExpectedArrivalTime) ?? planned;
        const stopCode = p.UserStopCode ?? p.TimingPointCode ?? stop.Stop?.TimingPointCode;
        const id = `${trip}@${stopCode}`;
        if (seen.has(id)) continue;
        seen.add(id);
        found.push({ p, trip, planned, expected, stopName: stop.Stop?.TimingPointName ?? p.TimingPointName ?? null });
      }
    }
  }
  const until = now + windowMinutes * 60_000;
  return found
    .filter((x) => x.expected >= now - 60_000 && Math.min(x.planned, x.expected) <= until)
    .sort((a, b) => a.expected - b.expected || a.planned - b.planned)
    .slice(0, limit)
    .map(({ p, trip, planned, expected, stopName }) => {
      const flagged = p.TripStopStatus === 'CANCEL';
      const updated = amsterdamMs(p.LastUpdateTimeStamp);
      return {
        line: String(p.LinePublicNumber ?? ''),
        destination: String(p.DestinationName50 ?? '').slice(0, 50) || null,
        operator: p.OperatorCode ?? p.DataOwnerCode ?? null,
        stop: stopName,
        planned,
        expected,
        delayMin: flagged ? 0 : Math.max(0, Math.round((expected - planned) / 60_000)),
        status: p.TripStopStatus ?? 'UNKNOWN',
        live: LIVE_STATUS.has(p.TripStopStatus) && updated != null && now - updated <= BUS_LIVE_MAX_AGE_MS,
        cancelled: flagged && !running.has(trip),
        contradicted: flagged && running.has(trip),
      };
    });
}

// Buses at the terminal stops of an airport in the next hour (OVapi): one request for the single
// stops and one for each stop area, asked together. The answer fails (so that a backup is served)
// only when none of them answered.
async function accessBuses(url, fetchFn) {
  const airport = airportOf(url, BUS_STOPS, 'bus');
  const { areas, stops } = BUS_STOPS[airport];
  const urls = [...(stops.length ? [`${OVAPI}/tpc/${stops.join(',')}`] : []), ...areas.map((a) => `${OVAPI}/stopareacode/${a}`)];
  const settled = await Promise.allSettled(urls.map((u) => upstream(fetchFn, u, { headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip' } }).then((r) => r.json())));
  const bodies = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!bodies.length) throw new HttpError(502, settled.find((r) => r.status === 'rejected')?.reason?.message ?? 'OVapi answered without stops');
  const now = Date.now();
  // Asked for one more than the cap, to know whether the cap cut the hour short.
  const found = mergeBusPasses(bodies, now, BUS_WINDOW_MINUTES, MAX_BUS_PASSES + 1);
  const passes = found.slice(0, MAX_BUS_PASSES);
  return new Response(
    JSON.stringify({
      available: true,
      airport,
      source: 'OVapi',
      fetched: now,
      windowMinutes: BUS_WINDOW_MINUTES,
      partial: bodies.length < urls.length,
      // True when more buses were due in the window than `passes` holds: the list then ends before the hour does.
      capped: found.length > MAX_BUS_PASSES,
      // The feed's cancellations are often wrong: they are reported, not known.
      cancellations: 'reported',
      cancellationsReported: passes.filter((x) => x.cancelled).length,
      passes,
    }),
    { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ACCESS_SECONDS}` } },
  );
}

// A backup of an access answer as a stale answer with its age, or undefined once it is older than
// `maxSeconds`. Done on the text: parsing it would cost more than the free plan allows.
async function staleAccess(backup, now = Date.now(), maxSeconds = ACCESS_BACKUP_SECONDS) {
  if (!backup) return undefined;
  const text = await backup.text();
  const age = now - Number(/"fetched":(\d+)/.exec(text)?.[1]);
  if (!(age >= 0) || age > maxSeconds * 1000 || !text.startsWith('{')) return undefined;
  return new Response(`{"stale":true,"ageSeconds":${Math.round(age / 1000)},${text.slice(1)}`, {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30', 'X-Power-Globe-Backup': '1' },
  });
}

// Where an answer is kept in the edge cache. A track is kept per aircraft, whatever else the
// request carries (the case of the address, other parameters), so that none of those can ask
// OpenSky again for the same aircraft.
const accessKind = (path) => ({ '/access/roads': 'roads', '/access/trains': 'trains', '/access/buses': 'buses' })[path.replace(/\/+$/, '')] ?? null;

function cacheUrl(url) {
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/track') {
    const icao24 = (url.searchParams.get('icao24') ?? '').toLowerCase();
    if (/^[0-9a-f]{6}$/.test(icao24)) return `${url.origin}/track?icao24=${icao24}`;
  }
  // The same goes for METARs and TAFs: only the airports count, not their case or other parameters.
  if (path === '/metar' || path === '/taf') {
    return `${url.origin}${path}?ids=${(url.searchParams.get('ids') ?? '').toUpperCase()}`;
  }
  if (accessKind(path)) return `${url.origin}${path}?airport=${(url.searchParams.get('airport') ?? '').toUpperCase()}`;
  return url.toString();
}

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
        routes: ['/flights/global', '/flights/area?lat=&lon=&nm=', '/flights/military', '/track?icao24=', '/metar?ids=', '/taf?ids=', '/access/roads?airport=', '/access/trains?airport=', '/access/buses?airport=', '/satellites/<group>', '/forecast?', '/tiles/openaip/<z>/<x>/<y>.png'],
        opensky: openskyAccount(env) ? 'account' : 'anonymous',
        chart: env.OPENAIP_API_KEY ? 'openAIP' : 'no key',
        relay: relayOn(env) ? 'on' : 'off',
        trains: env.NS_API_KEY ? 'NS key set' : 'no key',
      },
      300,
    );
  }
  if (path === '/access/roads') return accessRoads(url, fetchFn, env);
  if (path === '/access/trains') return accessTrains(url, fetchFn, env, cache);
  if (path === '/access/buses') return accessBuses(url, fetchFn);
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
  if (path === '/track') {
    const icao24 = (url.searchParams.get('icao24') ?? '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(icao24)) throw new HttpError(400, 'icao24: 6 hexadecimal characters');
    return track(icao24, fetchFn, env, cache, url.origin);
  }
  if (path === '/metar') {
    const ids = (url.searchParams.get('ids') ?? '').toUpperCase();
    if (!/^[A-Z0-9]{3,4}(,[A-Z0-9]{3,4}){0,19}$/.test(ids)) throw new HttpError(400, 'ids: up to 20 ICAO codes, comma-separated');
    const res = await upstream(fetchFn, `https://aviationweather.gov/api/data/metar?ids=${ids}&format=json&hours=3`);
    const text = await res.text();
    return new Response(text.trim() ? text : '[]', { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' } });
  }
  if (path === '/taf') {
    const ids = (url.searchParams.get('ids') ?? '').toUpperCase();
    if (!/^[A-Z0-9]{3,4}(,[A-Z0-9]{3,4}){0,19}$/.test(ids)) throw new HttpError(400, 'ids: up to 20 ICAO codes, comma-separated');
    const res = await upstream(fetchFn, `https://aviationweather.gov/api/data/taf?ids=${ids}&format=json`);
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
    const key = new Request(cacheUrl(url), { method: 'GET' });
    const kind = accessKind(url.pathname);
    const isAccess = kind !== null;
    const accessBackupSeconds = kind === 'roads' ? ACCESS_BACKUP_SECONDS : ACCESS_TRANSIT_BACKUP_SECONDS;
    const backupKey = new Request(isAccess ? `${new URL(cacheUrl(url)).origin}/__backup/access/${kind}${new URL(cacheUrl(url)).search}` : `${url.origin}/__backup${url.pathname}${url.search}`, { method: 'GET' });
    const isTrack = url.pathname.replace(/\/+$/, '') === '/track';
    // An old track would draw a flight that is long over, and an old METAR or TAF would pass for the
    // current one (a TAF that has been replaced most of all), so these have no backup copy.
    const backedUp = !isTrack && !['/metar', '/taf'].includes(url.pathname.replace(/\/+$/, ''));
    let res = await cache?.match(key);
    if (!res) {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const limited = url.pathname.startsWith('/tiles/')
        ? overLimit(`tiles:${ip}`, Date.now(), TILE_RATE_LIMIT)
        : isTrack
          ? overLimit(`track:${ip}`, Date.now(), TRACK_RATE_LIMIT)
          : overLimit(ip);
      if (limited) {
        return new Response(JSON.stringify({ error: 'Too many requests; slow down' }), { status: 429, headers: { ...cors, 'Content-Type': 'application/json', 'Retry-After': '60' } });
      }
      try {
        res = await route(url, env, fetch, cache);
        if (cache && !backedUp) {
          ctx?.waitUntil(cache.put(key, res.clone()));
        } else if (cache && res.headers.has('X-Power-Globe-Unavailable')) {
          // Nothing to fall back on later: there was no road data.
          ctx?.waitUntil(cache.put(key, res.clone()));
        } else if (cache) {
          const backup = new Response(res.clone().body, res);
          backup.headers.set('Cache-Control', `public, max-age=${isAccess ? accessBackupSeconds : BACKUP_SECONDS}`);
          ctx?.waitUntil(Promise.all([cache.put(key, res.clone()), cache.put(backupKey, backup)]));
        }
      } catch (err) {
        // Serve the last good answer rather than asking a failing or limiting service again.
        // Road traffic is marked stale with its age, and not served at all once it is too old.
        res = isAccess ? await staleAccess(await cache?.match(backupKey), Date.now(), accessBackupSeconds) : backedUp ? await cache?.match(backupKey) : undefined;
        if (res && !isAccess) {
          res = new Response(res.body, res);
          res.headers.set('X-Power-Globe-Backup', '1');
          res.headers.set('Cache-Control', 'public, max-age=60');
        } else if (res) {
          // The stale road answer is kept for the half minute it says, so that a relay that is down is
          // not asked again by every visitor.
          if (cache) ctx?.waitUntil(cache.put(key, res.clone()));
        } else {
          res = new Response(JSON.stringify({ error: err.message }), {
            status: err.status ?? 502,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${Math.max(1, Math.min(isAccess ? ACCESS_SECONDS : FAILURE_SECONDS, err.cacheSeconds ?? FAILURE_SECONDS))}` },
          });
          // Bad requests are the visitor's; failures upstream are remembered briefly.
          if (cache && (err.status ?? 502) >= 429) ctx?.waitUntil(cache.put(key, res.clone()));
        }
      }
    }
    const out = new Response(res.body, res);
    out.headers.delete('X-Power-Globe-Unavailable');
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};
