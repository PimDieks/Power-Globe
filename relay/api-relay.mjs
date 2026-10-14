#!/usr/bin/env node
// Power Globe flight relay for the API: asks the flight feeds for the Power Globe API
// (api/worker.js) from a machine of your own, such as a Raspberry Pi at home. The feeds limit or
// refuse Cloudflare's servers, whose addresses many sites share, but answer an ordinary internet
// connection.
//
//   GET  /                               what is here (no key needed)
//   GET  /<host>/<path>?<query>          the same request to https://<host>/<path>?<query>
//   POST /auth.opensky-network.org/...   OpenSky sign-in, for an account's larger allowance
//   GET  /ndw/<ICAO>                     road traffic around a Dutch airport (only with NDW=1)
//
// Only the flight feeds are relayed, only for requests carrying the key, and each feed is asked
// at most once a second (when busier than that it answers 429, and the API serves its last
// answer). Answers come back as the feed gave them, compressed for the trip up a home connection,
// and carry an x-answered-by header naming the feed, which the relay's own answers do not, so the
// API can tell the two apart.
//
// Settings (environment): RELAY_KEY, a long random secret, the same as the API's
// FLIGHT_RELAY_KEY; PORT (default 8788); HOST (default 127.0.0.1, for a tunnel on this
// machine); NDW=1 to switch on the road traffic job (see below), and NDW_SITES, where its list of
// measurement sites is (a file or an address; default the one published with the site). Needs
// Node.js 18 or newer and nothing else. See "Flight relay for the API" in the README.
//
// Road traffic: with NDW=1 the relay also reads the open data of NDW (the Dutch road traffic
// data portal) once a minute: the speed of every lane at the measurement sites near the Dutch
// airports with scheduled flights (about 70 MB of XML, which a Cloudflare Worker is too small to
// read) and the current jams, accidents and closures. It streams the files, keeps what lies
// within 25 km of each airport, and gives that small answer at /ndw/<ICAO>. Source: NDW.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable, pipeline } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createGunzip, gzip } from 'node:zlib';

// The same hosts as RELAYED_HOSTS in api/worker.js.
export const RELAYED_HOSTS = ['opensky-network.org', 'auth.opensky-network.org', 'api.adsb.lol', 'opendata.adsb.fi'];
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

// ---- Road traffic from NDW ----

const NDW_BASE = 'https://opendata.ndw.nu/';
export const NDW_FILES = { speeds: 'snelheden_en_intensiteiten_meetgegevens.xml.gz', situations: 'actueel_beeld.xml.gz' };
export const NDW_SITES_URL = 'https://raw.githubusercontent.com/PimDieks/Power-Globe/main/public/data/ndw-sites.json';
export const NDW_RADIUS_KM = 25;
const NDW_INTERVAL_MS = 60_000;
const NDW_TIMEOUT_MS = 45_000;
// An element of the XML larger than this is a broken file, not a measurement.
const NDW_MAX_ELEMENT = 4 * 1024 * 1024;
const NDW_MAX_SITUATIONS = 80;
const NDW_LINE_POINTS = 40;
// A situation takes the road of the nearest measurement site if there is one this near (km).
const NDW_ROAD_MATCH_KM = 0.6;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const RAD = Math.PI / 180;

export function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin((lon2 - lon1) * RAD) * Math.cos(lat2 * RAD);
  const x = Math.cos(lat1 * RAD) * Math.sin(lat2 * RAD) - Math.sin(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

export const compassOf = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const round = (v, digits) => Math.round(v * 10 ** digits) / 10 ** digits;

// Calls `onElement(xml)` with each `<tag ...>...</tag>` of the XML in `source` (an iterable of
// buffers or strings, such as a decompressed download), one at a time, so that only the element
// being read and the chunk it arrives in are in memory. Elements of this tag must not nest.
export async function readElements(source, tag, onElement) {
  const decoder = new StringDecoder('utf8');
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let buf = '';
  for await (const chunk of source) {
    buf += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let from = 0;
    for (;;) {
      let start = buf.indexOf(open, from);
      // `<roa:measurementSiteName` is not `<roa:measurementSite`: the tag must end after its name.
      while (start >= 0 && start + open.length < buf.length && !' >'.includes(buf[start + open.length])) start = buf.indexOf(open, start + 1);
      if (start < 0) {
        from = Math.max(from, buf.length - open.length);
        break;
      }
      const end = buf.indexOf(close, start);
      if (end < 0) {
        from = start;
        break;
      }
      const stop = end + close.length;
      onElement(buf.slice(start, stop));
      from = stop;
    }
    buf = buf.slice(from);
    if (buf.length > NDW_MAX_ELEMENT) throw new Error(`An element of <${tag}> is over ${NDW_MAX_ELEMENT} characters long`);
  }
}

// The lanes of a site as { speed, flow }: speed is the slowest of the lanes that have traffic
// (flow above 0, speed reported), flow the vehicles an hour over all lanes. A lane with no
// vehicles reports no speed (0 km/h or -1), which is an empty lane and not a jam, so speed is
// null when no lane has traffic, and flow is null when there is no flow data at all.
// `xml` is the `<roa:siteMeasurements>` element; `lanes` the [speed index, flow index] pairs.
export function laneSummary(xml, lanes) {
  let speed = null;
  let flow = null;
  for (const [speedIndex, flowIndex] of lanes) {
    const f = quantity(xml, flowIndex, 'com:vehicleFlowRate');
    const s = quantity(xml, speedIndex, 'com:speed');
    if (f != null && f >= 0) flow = (flow ?? 0) + f;
    if (f > 0 && s != null && s >= 0) speed = speed == null ? s : Math.min(speed, s);
  }
  return { speed: speed == null ? null : Math.round(speed), flow: flow == null ? null : Math.round(flow) };
}

function quantity(xml, index, name) {
  const at = xml.indexOf(`<roa:physicalQuantity index="${index}">`);
  if (at < 0) return null;
  const end = xml.indexOf('</roa:physicalQuantity>', at);
  const open = xml.indexOf(`<${name}>`, at);
  if (open < 0 || (end >= 0 && open > end)) return null;
  const value = Number.parseFloat(xml.slice(open + name.length + 2, open + name.length + 14));
  return Number.isFinite(value) ? value : null;
}

// The measurement site list (public/data/ndw-sites.json, see scripts/build-ndw-sites.mjs) made
// ready: each site with its lanes, and for each airport the sites within the radius.
export function prepareSites(file) {
  if (file?.version !== 1 || !Array.isArray(file.sites) || !file.airports) throw new Error('The NDW site list is not in a form this relay knows');
  const sites = file.sites.map(([prefix, rest, lat, lon, road, heading, pattern]) => ({ id: file.prefixes[prefix] + rest, lat, lon, road, heading, lanes: file.patterns[pattern] }));
  const airports = Object.entries(file.airports).map(([icao, [lat, lon]]) => ({
    icao,
    lat,
    lon,
    sites: sites.filter((s) => distanceKm(lat, lon, s.lat, s.lon) <= (file.radiusKm ?? NDW_RADIUS_KM)),
  }));
  return { sites, byId: new Map(sites.map((s) => [s.id, s])), airports, radiusKm: file.radiusKm ?? NDW_RADIUS_KM };
}

const DELAY_MIN = (seconds) => (Number.isFinite(seconds) ? Math.round(seconds / 60) : null);
const SITUATION_TYPES = {
  AbnormalTraffic: 'jam',
  Accident: 'accident',
  RoadOrCarriagewayOrLaneManagement: 'closure',
  GeneralObstruction: 'obstruction',
  VehicleObstruction: 'obstruction',
};
const CLOSURES = new Set(['roadClosed', 'carriagewayClosures', 'laneClosures']);

const text = (xml, name) => new RegExp(`<${name}>([^<]*)<`).exec(xml)?.[1];

// A situation (`<sit:situation>` element of actueel_beeld) as { id, type, kind, delayMin, lengthM,
// line: [[lat, lon], ...] } or null when it is none of a jam, accident, closure or obstruction, is
// not in force at `now` (ms), or has no position. Only the first record and the first location of
// a situation are read.
export function parseSituation(xml, now = Date.now()) {
  const recordType = /<sit:situationRecord xsi:type="sit:(\w+)"/.exec(xml)?.[1];
  const type = SITUATION_TYPES[recordType];
  if (!type) return null;
  let kind = text(xml, 'sit:abnormalTrafficType') ?? text(xml, 'sit:accidentType') ?? text(xml, 'sit:vehicleObstructionType') ?? text(xml, 'sit:obstructionType') ?? null;
  if (type === 'closure') {
    kind = text(xml, 'sit:roadOrCarriagewayOrLaneManagementType');
    if (!CLOSURES.has(kind)) return null;
  }
  const from = Date.parse(text(xml, 'com:overallStartTime'));
  const until = Date.parse(text(xml, 'com:overallEndTime'));
  if (from > now + 60_000 || until < now) return null;
  let line = null;
  const posList = /<loc:posList>([^<]*)</.exec(xml)?.[1];
  if (posList) {
    const numbers = posList.trim().split(/\s+/).map(Number);
    line = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) line.push([numbers[i], numbers[i + 1]]);
  } else {
    const lat = Number(text(xml, 'loc:latitude'));
    const lon = Number(text(xml, 'loc:longitude'));
    if (Number.isFinite(lat) && Number.isFinite(lon) && text(xml, 'loc:latitude') != null) line = [[lat, lon]];
  }
  if (!line?.length || line.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) return null;
  const bearing = Number(text(xml, 'loc:bearing'));
  const queue = Number(text(xml, 'sit:queueLength'));
  return {
    id: /<sit:situation id="([^"]+)"/.exec(xml)?.[1] ?? null,
    type,
    kind,
    delayMin: type === 'jam' ? DELAY_MIN(Number(text(xml, 'sit:delayTimeValue'))) : null,
    queueM: Number.isFinite(queue) && queue > 0 ? Math.round(queue) : null,
    bearing: text(xml, 'loc:bearing') != null && Number.isFinite(bearing) ? bearing : null,
    line,
  };
}

const lineLengthM = (line) => {
  let km = 0;
  for (let i = 1; i < line.length; i++) km += distanceKm(line[i - 1][0], line[i - 1][1], line[i][0], line[i][1]);
  return Math.round(km * 1000);
};

// At most `max` points of the line, evenly, keeping the first and last.
function thin(line, max = NDW_LINE_POINTS) {
  const points = line.length <= max ? line : Array.from({ length: max }, (_, i) => line[Math.round((i * (line.length - 1)) / (max - 1))]);
  return points.map(([lat, lon]) => [round(lat, 5), round(lon, 5)]);
}

// The road and direction of a situation: those of the nearest measurement site to its start, among
// the sites heading the way the situation does where both are known.
export function roadOf(situation, sites) {
  const [lat, lon] = situation.line[0];
  const last = situation.line.at(-1);
  const heading = lineLengthM(situation.line) > 150 ? bearingDeg(lat, lon, last[0], last[1]) : situation.bearing;
  let best = null;
  let bestKm = NDW_ROAD_MATCH_KM;
  for (const s of sites) {
    if (Math.abs(s.lat - lat) > 0.01 || Math.abs(s.lon - lon) > 0.02) continue;
    const km = distanceKm(lat, lon, s.lat, s.lon);
    const alike = heading == null || s.heading == null || angleBetween(heading, s.heading) <= 60;
    if (km < bestKm && alike) {
      best = s;
      bestKm = km;
    }
  }
  return best ? { road: best.road, dir: best.heading == null ? null : compassOf(best.heading) } : { road: null, dir: heading == null ? null : compassOf(heading) };
}

const TYPE_ORDER = { jam: 0, accident: 1, closure: 2, obstruction: 3 };

// What goes to the page for an airport: its measurement sites as [lat, lon, speed, flow, group]
// (group: an index into `groups`, the [road, direction] pairs) and the situations near it.
// `readings` maps a site id to { speed, flow }; `situations` are parsed situations.
export function airportAnswer(airport, prepared, readings, situations, meta) {
  const groups = [];
  const groupIndex = new Map();
  const sites = airport.sites.map((s) => {
    const key = `${s.road}|${s.heading == null ? '' : compassOf(s.heading)}`;
    if (!groupIndex.has(key)) groupIndex.set(key, groups.push([s.road, s.heading == null ? null : compassOf(s.heading)]) - 1);
    const r = readings.get(s.id);
    return [round(s.lat, 5), round(s.lon, 5), r?.speed ?? null, r?.flow ?? null, groupIndex.get(key)];
  });
  const near = [];
  for (const situation of situations) {
    const distances = situation.line.map(([lat, lon]) => distanceKm(airport.lat, airport.lon, lat, lon));
    const km = Math.min(...distances);
    if (km > prepared.radiusKm) continue;
    const lengthM = situation.queueM ?? (situation.line.length > 1 ? lineLengthM(situation.line) : null);
    const last = situation.line.at(-1);
    near.push({
      id: situation.id,
      type: situation.type,
      kind: situation.kind,
      ...roadOf(situation, airport.sites),
      delayMin: situation.delayMin,
      lengthM,
      distKm: round(km, 1),
      start: [round(situation.line[0][0], 5), round(situation.line[0][1], 5)],
      end: [round(last[0], 5), round(last[1], 5)],
      line: situation.type === 'obstruction' || situation.line.length < 2 ? null : thin(situation.line),
    });
  }
  near.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.distKm - b.distKm);
  return { airport: airport.icao, source: 'NDW', radiusKm: prepared.radiusKm, ...meta, groups, sites, situations: near.slice(0, NDW_MAX_SITUATIONS) };
}

async function openXml(fetchFn, name, since) {
  const res = await fetchFn(NDW_BASE + name, {
    headers: { 'user-agent': 'power-globe-api-relay (https://github.com/PimDieks/Power-Globe)', ...(since && { 'if-modified-since': since }) },
    signal: AbortSignal.timeout(NDW_TIMEOUT_MS),
  });
  if (res.status === 304) return { unchanged: true };
  if (!res.ok) throw new Error(`${name} answered ${res.status}`);
  return { lastModified: res.headers.get('last-modified'), xml: pipeline(Readable.fromWeb(res.body), createGunzip(), () => {}) };
}

// The road traffic job: every minute asks NDW for the live speeds and the current situations (only
// when the files changed), and keeps the answer for each airport. `sitesSource` is a file path or
// an address; `get(icao)` gives the newest answer as an object, or null.
export function createNdwJob({ sitesSource = NDW_SITES_URL, fetchFn = fetch, read = readFile, now = Date.now, log = console.log, intervalMs = NDW_INTERVAL_MS } = {}) {
  let prepared = null;
  let timer = null;
  let running = false;
  const state = { speeds: { since: null, at: null, measuredAt: null, readings: new Map() }, situations: { since: null, at: null, madeAt: null, list: [] } };
  const answers = new Map();
  let failures = 0;

  async function loadSites() {
    const raw = /^https?:\/\//.test(sitesSource)
      ? await fetchFn(sitesSource, { signal: AbortSignal.timeout(NDW_TIMEOUT_MS) }).then((r) => {
          if (!r.ok) throw new Error(`${sitesSource} answered ${r.status}`);
          return r.text();
        })
      : await read(sitesSource, 'utf8');
    prepared = prepareSites(JSON.parse(raw));
    log(`NDW: ${prepared.sites.length} measurement sites for ${prepared.airports.map((a) => a.icao).join(', ')}`);
  }

  async function readSpeeds() {
    const got = await openXml(fetchFn, NDW_FILES.speeds, state.speeds.since);
    if (got.unchanged) return false;
    const readings = new Map();
    let measuredAt = 0;
    await readElements(got.xml, 'roa:siteMeasurements', (xml) => {
      const id = /measurementSiteReference[^>]*\sid="([^"]+)"/.exec(xml.slice(0, 400))?.[1];
      const site = prepared.byId.get(id);
      if (!site) return;
      readings.set(id, laneSummary(xml, site.lanes));
      const time = Date.parse(text(xml, 'roa:timeValue'));
      if (time > measuredAt) measuredAt = time;
    });
    state.speeds = { since: got.lastModified, at: now(), measuredAt: measuredAt || null, readings };
    return true;
  }

  async function readSituations() {
    const got = await openXml(fetchFn, NDW_FILES.situations, state.situations.since);
    if (got.unchanged) return false;
    const list = [];
    const t = now();
    await readElements(got.xml, 'sit:situation', (xml) => {
      const situation = parseSituation(xml, t);
      if (situation && prepared.airports.some((a) => situation.line.some(([lat, lon]) => distanceKm(a.lat, a.lon, lat, lon) <= prepared.radiusKm))) list.push(situation);
    });
    state.situations = { since: got.lastModified, at: t, madeAt: Date.parse(got.lastModified) || t, list };
    return true;
  }

  function publish() {
    if (state.speeds.at == null && state.situations.at == null) return;
    for (const airport of prepared.airports) {
      answers.set(
        airport.icao,
        airportAnswer(airport, prepared, state.speeds.readings, state.situations.list, {
          fetched: Math.max(state.speeds.at ?? 0, state.situations.at ?? 0),
          measuredAt: state.speeds.measuredAt ?? null,
          situationsAt: state.situations.madeAt ?? null,
        }),
      );
    }
  }

  async function refresh() {
    if (running) return;
    running = true;
    try {
      if (!prepared) await loadSites();
      const results = await Promise.allSettled([readSpeeds(), readSituations()]);
      const failed = results.map((r, i) => (r.status === 'rejected' ? `${['speeds', 'situations'][i]}: ${r.reason?.message ?? r.reason}` : null)).filter(Boolean);
      if (results.some((r) => r.status === 'fulfilled' && r.value)) publish();
      if (failed.length) {
        failures++;
        log(`NDW: ${failed.join('; ')} (failure ${failures} in a row; the last answer stays)`);
      } else failures = 0;
    } catch (err) {
      failures++;
      log(`NDW: ${err.message} (failure ${failures} in a row)`);
    } finally {
      running = false;
    }
  }

  return {
    refresh,
    start() {
      refresh();
      timer = setInterval(refresh, intervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
    airports: () => prepared?.airports.map((a) => a.icao) ?? [],
    ready: () => prepared != null,
    get: (icao) => answers.get(icao) ?? null,
  };
}

// The answer for /ndw/<ICAO>: the newest road traffic answer for the airport. 503 means not yet
// (the job is off, or has not read the files yet), 404 an airport it has no sites for.
async function ndwReply(ndw, icao, headers) {
  if (!ndw) return reply(503, { error: 'The road traffic job is not switched on in this relay (NDW=1)', ndw: 'off' });
  const answer = ndw.get(icao);
  if (!answer) {
    if (ndw.ready() && !ndw.airports().includes(icao)) return reply(404, { error: `No road traffic data for ${icao}`, ndw: 'on' });
    return reply(503, { error: 'The road traffic job has not read its first data yet', ndw: 'on' });
  }
  const out = reply(200, answer);
  if (out.body.length >= COMPRESS_FROM_BYTES && /\bgzip\b/.test(headers['accept-encoding'] ?? '')) {
    out.body = await compress(out.body);
    out.headers['content-encoding'] = 'gzip';
  }
  return out;
}

// The relay itself: ({ method, path, headers, body }) => { status, headers, body }, with headers
// named in lower case as Node gives them.
export function createRelay({ key, fetchFn = fetch, spacingMs = SPACING_MS, maxWaitMs = MAX_WAIT_MS, now = Date.now, wait = sleep, ndw = null } = {}) {
  if (!key || key.length < 16) throw new Error('Set RELAY_KEY to a random secret of at least 16 characters (for example: openssl rand -hex 32)');
  const keyDigest = digest(key);
  // When each feed may be asked next.
  const turns = new Map();

  return async function handle({ method, path, headers = {}, body }) {
    if (path === '/') return reply(200, { name: 'Power Globe flight relay for the API', hosts: RELAYED_HOSTS });
    const given = headers['x-relay-key'];
    if (typeof given !== 'string' || !timingSafeEqual(digest(given), keyDigest)) return reply(401, { error: 'Wrong or missing relay key' });

    const road = path.match(/^\/ndw\/([a-z0-9]{4})\/?$/i);
    if (road) return ndwReply(ndw, road[1].toUpperCase(), headers);

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

export function serve({
  key = process.env.RELAY_KEY,
  port = Number(process.env.PORT) || 8788,
  host = process.env.HOST || '127.0.0.1',
  ndw = /^(1|true|on|yes)$/i.test(process.env.NDW ?? '') ? createNdwJob({ sitesSource: process.env.NDW_SITES || NDW_SITES_URL }) : null,
} = {}) {
  const handle = createRelay({ key, ndw });
  ndw?.start();
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
  server.listen(port, host, () => console.log(`Power Globe flight relay for the API on http://${host}:${port}${ndw ? ', with the road traffic job (NDW)' : ''}`));
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
