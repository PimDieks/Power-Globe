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
// machine); NDW=1 to switch on the road traffic job (see below), NDW_SITES, where its list of
// measurement sites is (a file or an address; default the one published with the site), and
// NDW_SITES_CACHE, where it keeps a copy of that list for when the download fails (default in the
// service's state directory, else the temporary directory). Needs
// Node.js 18 or newer and nothing else. See "Flight relay for the API" in the README.
//
// Road traffic: with NDW=1 the relay also reads the open data of NDW (the Dutch road traffic
// data portal) once a minute: the speed of every lane at the measurement sites near the Dutch
// airports with scheduled flights (about 70 MB of XML, which a Cloudflare Worker is too small to
// read) and the current jams, accidents and closures. It streams the files, keeps what lies
// within 25 km of each airport, and gives that small answer at /ndw/<ICAO>. Source: NDW.

import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
export const NDW_TIMEOUT_MS = 45_000;
// An element of the XML larger than this is a broken file, not a measurement.
const NDW_MAX_ELEMENT = 4 * 1024 * 1024;
const NDW_MAX_SITUATIONS = 60;
const NDW_MAX_LIMITS = 40;
const NDW_LINE_POINTS = 40;
// A situation takes the road of the nearest measurement site if there is one this near (km).
const NDW_ROAD_MATCH_KM = 0.6;
// A lane counts towards the speed of a site when it carries at least this many vehicles an hour:
// one slow vehicle on an otherwise empty lane is not traffic.
export const MIN_LANE_FLOW = 120;
// Fewer of the sites of the list than this share reporting in the speed file means the file or the
// list is not what it should be, and nothing is published from it.
const NDW_MIN_MATCH = 0.5;
// Obstructions older than this are not news; a public event matters this near in time; maintenance
// that ends within this long is "planned" (a count only).
const OBSTRUCTION_MAX_AGE_MS = 3 * 3600_000;
const PUBLIC_EVENT_MS = 24 * 3600_000;
const PLANNED_MS = 48 * 3600_000;
// Neighbours further apart than this (km) do not tell which way a road runs.
const CHAIN_KM = 4;
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
// `onHead(text)`, if given, gets what comes before the first element.
export async function readElements(source, tag, onElement, onHead) {
  const decoder = new StringDecoder('utf8');
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let buf = '';
  let head = '';
  let headSent = false;
  for await (const chunk of source) {
    const piece = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (!headSent && head.length < 65_536) head += piece;
    buf += piece;
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
      if (!headSent) {
        headSent = true;
        onHead?.(head);
      }
      const stop = end + close.length;
      onElement(buf.slice(start, stop));
      from = stop;
    }
    buf = buf.slice(from);
    if (buf.length > NDW_MAX_ELEMENT) throw new Error(`An element of <${tag}> is over ${NDW_MAX_ELEMENT} characters long`);
  }
}

// The speed and flow of a site from its `<roa:siteMeasurements>` element and its lanes (the
// [speed index, flow index] pairs): speed is the average of the lanes with at least MIN_LANE_FLOW
// vehicles an hour, weighted by their flow, and flow the vehicles an hour over all lanes. A lane
// with no vehicles reports no speed (0 km/h or -1), which is an empty lane and not a jam, and one
// with a vehicle or two says nothing of the road, so speed is null where no lane has traffic, and
// flow is null when there is no flow data at all.
export function laneSummary(xml, lanes) {
  let weighted = 0;
  let weight = 0;
  let flow = null;
  for (const [speedIndex, flowIndex] of lanes) {
    const f = quantity(xml, flowIndex, 'com:vehicleFlowRate');
    if (f != null && f >= 0) flow = (flow ?? 0) + f;
    if (!(f >= MIN_LANE_FLOW)) continue;
    const s = quantity(xml, speedIndex, 'com:speed');
    if (s != null && s >= 0) {
      weighted += s * f;
      weight += f;
    }
  }
  return { speed: weight > 0 ? Math.round(weighted / weight) : null, flow: flow == null ? null : Math.round(flow) };
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

// Gives each site on a road with sides its direction of travel in degrees: along the line to its
// neighbours on the same side of the same road (the hectometre order), reversed on the left side,
// where traffic runs towards lower numbers. Sites without such neighbours keep no heading.
export function addHeadings(sites) {
  const chains = new Map();
  for (const s of sites) {
    if (!s.side || s.position == null) continue;
    const key = `${s.road}${s.side}`;
    if (!chains.has(key)) chains.set(key, []);
    chains.get(key).push(s);
  }
  for (const chain of chains.values()) {
    chain.sort((a, b) => a.position - b.position);
    chain.forEach((s, i) => {
      // The nearest sites before and after it that are a real step away (sites of one place
      // report the same position), and not far.
      const near = (list) => list.find((o) => distanceKm(s.lat, s.lon, o.lat, o.lon) >= 0.05 && distanceKm(s.lat, s.lon, o.lat, o.lon) <= CHAIN_KM);
      const before = near(chain.slice(0, i).reverse());
      const after = near(chain.slice(i + 1));
      if (!before && !after) return;
      const up = bearingDeg((before ?? s).lat, (before ?? s).lon, (after ?? s).lat, (after ?? s).lon);
      s.heading = Math.round(s.side === 'r' ? up : (up + 180) % 360);
    });
  }
  return sites;
}

// One row of the site list as a site, or null when it is not a usable row.
function siteOf(row, file) {
  if (!Array.isArray(row) || row.length < 9) return null;
  const [prefix, rest, lat, lon, road, side, position, version, pattern] = row;
  const lanes = file.patterns[pattern];
  if (typeof file.prefixes[prefix] !== 'string' || typeof rest !== 'string' || typeof road !== 'string' || !road) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (!Array.isArray(lanes) || !lanes.length || !lanes.every((l) => Array.isArray(l) && l.length === 2 && l.every(Number.isInteger))) return null;
  return { id: file.prefixes[prefix] + rest, lat, lon, road, side: side || '', position: Number.isFinite(position) ? position : null, version: String(version), lanes };
}

// The measurement site list (public/data/ndw-sites.json, see scripts/build-ndw-sites.mjs) made
// ready: each site with its lanes and direction, and for each airport the sites within the radius.
// Rows that are not usable are left out; too many of them mean the file is not the right one.
export function prepareSites(file) {
  if (file?.version !== 2 || !Array.isArray(file.sites) || !Array.isArray(file.prefixes) || !Array.isArray(file.patterns) || !file.airports) {
    throw new Error('The NDW site list is not in a form this relay knows');
  }
  const sites = file.sites.map((row) => siteOf(row, file)).filter(Boolean);
  if (!sites.length || sites.length < file.sites.length * 0.9) throw new Error(`The NDW site list has only ${sites.length} usable rows of ${file.sites.length}`);
  addHeadings(sites);
  const radiusKm = file.radiusKm ?? NDW_RADIUS_KM;
  const airports = Object.entries(file.airports).map(([icao, [lat, lon]]) => ({
    icao,
    lat,
    lon,
    sites: sites.filter((s) => distanceKm(lat, lon, s.lat, s.lon) <= radiusKm),
  }));
  return { sites, byId: new Map(sites.map((s) => [s.id, s])), airports, radiusKm };
}

const DELAY_MIN = (seconds) => (Number.isFinite(seconds) ? Math.round(seconds / 60) : null);
const CLOSURES = new Set(['roadClosed', 'carriagewayClosures', 'laneClosures']);
// Roadworks: approved, implemented and running for weeks, which would drown everything else.
const MAINTENANCE = new Set(['roadMaintenance', 'constructionWork']);
const IN_FORCE = new Set(['implemented', 'beingImplemented']);

const text = (xml, name) => new RegExp(`<${name}>([^<]*)<`).exec(xml)?.[1];

// Each `<sit:situationRecord>` of a situation: one situation holds several, such as a speed limit
// and the lane closures that go with it.
function* recordsOf(xml) {
  const close = '</sit:situationRecord>';
  for (let at = xml.indexOf('<sit:situationRecord '); at >= 0; at = xml.indexOf('<sit:situationRecord ', at + 1)) {
    const end = xml.indexOf(close, at);
    if (end < 0) return;
    yield xml.slice(at, end + close.length);
  }
}

// The records of a situation (`<sit:situation>` element of actueel_beeld) that matter, each as
// { id, situation, type, kind, cause, status, delayMin, queueM, bearing, from, until, limitKmh, line }:
//   jam          AbnormalTraffic
//   accident     an Accident, or a closure whose cause is an accident
//   closure      a closure of a road, carriageway or lane for another cause than roadworks (and a
//                public event only within a day of its start)
//   maintenance  a closure for roadworks that is in force, only to be counted when it ends soon
//   obstruction  a vehicle or object on the road that started within three hours
//   limit        a temporary speed limit in force
// Records not in force at `now` (ms), or approved but not yet implemented, or with no position,
// are left out.
export function parseSituation(xml, now = Date.now()) {
  const situation = /<sit:situation id="([^"]+)"/.exec(xml)?.[1] ?? null;
  const found = [];
  for (const rec of recordsOf(xml)) {
    const recordType = /xsi:type="sit:(\w+)"/.exec(rec)?.[1];
    const cause = text(rec, 'sit:causeType') ?? null;
    const status = text(rec, 'sit:operatorActionStatus') ?? null;
    const from = Date.parse(text(rec, 'com:overallStartTime'));
    const until = Date.parse(text(rec, 'com:overallEndTime'));
    if (from > now + 60_000 || until < now) continue;
    let type = null;
    let kind = text(rec, 'sit:abnormalTrafficType') ?? text(rec, 'sit:accidentType') ?? text(rec, 'sit:vehicleObstructionType') ?? text(rec, 'sit:obstructionType') ?? null;
    let limitKmh = null;
    if (recordType === 'AbnormalTraffic') type = 'jam';
    else if (recordType === 'Accident') type = 'accident';
    else if (recordType === 'RoadOrCarriagewayOrLaneManagement') {
      kind = text(rec, 'sit:roadOrCarriagewayOrLaneManagementType');
      if (!CLOSURES.has(kind) || (status && !IN_FORCE.has(status))) continue;
      if (cause === 'accident') type = 'accident';
      else if (MAINTENANCE.has(cause)) type = 'maintenance';
      else if (cause === 'publicEvent' && !(from >= now - PUBLIC_EVENT_MS)) continue;
      else type = 'closure';
    } else if (recordType === 'VehicleObstruction' || recordType === 'GeneralObstruction') {
      if (from < now - OBSTRUCTION_MAX_AGE_MS) continue;
      type = 'obstruction';
    } else if (recordType === 'SpeedManagement') {
      limitKmh = Number(text(rec, 'sit:temporarySpeedLimit'));
      if (!Number.isFinite(limitKmh) || !IN_FORCE.has(status)) continue;
      type = 'limit';
    }
    if (!type) continue;
    let line = null;
    const posList = /<loc:posList>([^<]*)</.exec(rec)?.[1];
    if (posList) {
      const numbers = posList.trim().split(/\s+/).map(Number);
      line = [];
      for (let i = 0; i + 1 < numbers.length; i += 2) line.push([numbers[i], numbers[i + 1]]);
    } else if (text(rec, 'loc:latitude') != null) {
      line = [[Number(text(rec, 'loc:latitude')), Number(text(rec, 'loc:longitude'))]];
    }
    if (!line?.length || line.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) continue;
    const bearing = Number(text(rec, 'loc:bearing'));
    const queue = Number(text(rec, 'sit:queueLength'));
    found.push({
      id: /<sit:situationRecord [^>]*\bid="([^"]+)"/.exec(rec)?.[1] ?? situation,
      situation,
      type,
      kind,
      cause,
      status,
      delayMin: type === 'jam' ? DELAY_MIN(Number(text(rec, 'sit:delayTimeValue'))) : null,
      queueM: Number.isFinite(queue) && queue > 0 ? Math.round(queue) : null,
      bearing: text(rec, 'loc:bearing') != null && Number.isFinite(bearing) ? bearing : null,
      from: Number.isFinite(from) ? from : null,
      until: Number.isFinite(until) ? until : null,
      limitKmh,
      line,
    });
  }
  return found;
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
const isARoad = (road) => typeof road === 'string' && road.startsWith('A');

// What goes to the page for an airport: the measurement sites as chains, one per road and side of
// the road in the order of the road, each point as [lat, lon, speed, flow]; the situations near it
// (jams, accidents, closures, obstructions) ranked the way the page lists them; the temporary
// speed limits; and how many roadworks end soon on a motorway. `readings` maps a site id to
// { speed, flow }; `items` are parsed records (see parseSituation).
export function airportAnswer(airport, prepared, readings, items, meta, now = Date.now()) {
  const chains = new Map();
  for (const s of airport.sites) {
    const key = `${s.road}|${s.side}`;
    if (!chains.has(key)) chains.set(key, { road: s.road, side: s.side, sites: [] });
    chains.get(key).sites.push(s);
  }
  const out = [];
  for (const chain of chains.values()) {
    if (chain.side) chain.sites.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    out.push({
      road: chain.road,
      side: chain.side,
      pts: chain.sites.map((s) => {
        const r = readings.get(s.id);
        return [round(s.lat, 5), round(s.lon, 5), r?.speed ?? null, r?.flow ?? null];
      }),
    });
  }
  const near = [];
  const limits = [];
  const planned = new Set();
  for (const item of items) {
    const km = Math.min(...item.line.map(([lat, lon]) => distanceKm(airport.lat, airport.lon, lat, lon)));
    if (km > prepared.radiusKm) continue;
    const where = roadOf(item, airport.sites);
    if (item.type === 'maintenance') {
      if (isARoad(where.road) && item.status === 'implemented' && item.until != null && item.until <= now + PLANNED_MS) planned.add(item.situation);
      continue;
    }
    if (item.type === 'limit') {
      if (limits.length < NDW_MAX_LIMITS) limits.push({ kmh: item.limitKmh, ...where, distKm: round(km, 1), line: thin(item.line, 12) });
      continue;
    }
    const last = item.line.at(-1);
    near.push({
      id: item.id,
      type: item.type,
      kind: item.kind,
      cause: item.cause,
      ...where,
      aRoad: isARoad(where.road),
      delayMin: item.delayMin,
      lengthM: item.queueM ?? (item.line.length > 1 ? lineLengthM(item.line) : null),
      distKm: round(km, 1),
      startedAt: item.from,
      start: [round(item.line[0][0], 5), round(item.line[0][1], 5)],
      end: [round(last[0], 5), round(last[1], 5)],
      line: item.type === 'obstruction' || item.line.length < 2 ? null : thin(item.line),
    });
  }
  // The same vehicle reported twice (by two sources) is listed once.
  const seen = [];
  for (let i = 0; i < near.length; i++) {
    const s = near[i];
    if (s.type !== 'obstruction') continue;
    if (seen.some((o) => o.road === s.road && o.dir === s.dir && distanceKm(o.start[0], o.start[1], s.start[0], s.start[1]) < 0.3)) near.splice(i--, 1);
    else seen.push(s);
  }
  // Jams by delay then length, the rest on motorways first, then the nearest.
  near.sort(
    (a, b) =>
      TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
      (a.type === 'jam' ? (b.delayMin ?? 0) - (a.delayMin ?? 0) || (b.lengthM ?? 0) - (a.lengthM ?? 0) : Number(b.aRoad) - Number(a.aRoad)) ||
      a.distKm - b.distKm,
  );
  return { airport: airport.icao, source: 'NDW', radiusKm: prepared.radiusKm, ...meta, chains: out, situations: near.slice(0, NDW_MAX_SITUATIONS), limits, planned: planned.size };
}

// A download of one of NDW's files, read as the decompressed XML, within NDW_TIMEOUT_MS from the
// start to the end of the body. `read(xml)` gets the XML as a stream and gives the result;
// `lastModified` is passed on for the next If-Modified-Since. Answers that are not the file are
// cancelled so the connection is let go of.
async function readFeed(fetchFn, name, since, read, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(NDW_BASE + name, {
      headers: { 'user-agent': 'power-globe-api-relay (https://github.com/PimDieks/Power-Globe)', ...(since && { 'if-modified-since': since }) },
      signal: controller.signal,
    });
    if (res.status === 304) {
      await res.body?.cancel?.().catch?.(() => {});
      return { unchanged: true };
    }
    if (!res.ok) {
      await res.body?.cancel?.().catch?.(() => {});
      throw new Error(`${name} answered ${res.status}`);
    }
    const reader = res.body.getReader();
    const first = await reader.read();
    // A gzip file begins 1f 8b; anything else (an error page with a 200) is not the file.
    if (first.done || first.value?.[0] !== 0x1f || first.value?.[1] !== 0x8b) {
      await reader.cancel().catch?.(() => {});
      throw new Error(`${name} did not come as a gzip file`);
    }
    async function* chunks() {
      yield first.value;
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    }
    const xml = pipeline(Readable.from(chunks(), { objectMode: false }), createGunzip(), () => {});
    return { lastModified: res.headers.get('last-modified'), result: await read(xml) };
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`${name} took more than ${Math.round(timeoutMs / 1000)} s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// The road traffic job: every minute asks NDW for the live speeds and the current situations (only
// when the files changed), and keeps the answer for each airport. `sitesSource` is a file path or
// an address (a copy of what is downloaded is kept at `cachePath`, for when the download fails);
// `get(icao)` gives the newest answer as an object, or null. Nothing is published until both files
// have been read once, so that an answer never says "roads flowing" for want of data.
export function createNdwJob({
  sitesSource = NDW_SITES_URL,
  cachePath = null,
  fetchFn = fetch,
  read = readFile,
  write = writeFile,
  now = Date.now,
  log = console.log,
  intervalMs = NDW_INTERVAL_MS,
  timeoutMs = NDW_TIMEOUT_MS,
} = {}) {
  let prepared = null;
  let timer = null;
  let running = false;
  const state = { speeds: { since: null, at: null, measuredAt: null, readings: new Map() }, situations: { since: null, at: null, madeAt: null, list: [] } };
  const answers = new Map();
  // The failures in a row, if the last read failed: logged once when they start and once when they end.
  let outage = null;
  let drift = 0;

  async function loadSites() {
    let raw;
    if (/^https?:\/\//.test(sitesSource)) {
      try {
        raw = await fetchFn(sitesSource, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => {
          if (!r.ok) throw new Error(`${sitesSource} answered ${r.status}`);
          return r.text();
        });
        prepared = prepareSites(JSON.parse(raw));
        if (cachePath) await write(cachePath, raw).catch((err) => log(`NDW: could not keep a copy of the site list (${err.message})`));
      } catch (err) {
        if (!cachePath) throw err;
        prepared = prepareSites(JSON.parse(await read(cachePath, 'utf8').catch(() => Promise.reject(err))));
        log(`NDW: ${err.message}; using the copy of the site list kept at ${cachePath}`);
      }
    } else prepared = prepareSites(JSON.parse(await read(sitesSource, 'utf8')));
    log(`NDW: ${prepared.sites.length} measurement sites for ${prepared.airports.map((a) => a.icao).join(', ')}`);
  }

  async function readSpeeds() {
    const got = await readFeed(
      fetchFn,
      NDW_FILES.speeds,
      state.speeds.since,
      async (xml) => {
        const readings = new Map();
        let publishedAt = null;
        let mismatched = 0;
        await readElements(
          xml,
          'roa:siteMeasurements',
          (el) => {
            const head = el.slice(0, 400);
            const id = /measurementSiteReference[^>]*\sid="([^"]+)"/.exec(head)?.[1];
            const site = prepared.byId.get(id);
            if (!site) return;
            // A site whose version changed may have other lanes than the list says: no reading.
            if (/measurementSiteReference[^>]*\sversion="([^"]*)"/.exec(head)?.[1] !== site.version) {
              mismatched++;
              return;
            }
            readings.set(id, laneSummary(el, site.lanes));
          },
          (headText) => {
            publishedAt = Date.parse(text(headText, 'com:publicationTime'));
          },
        );
        return { readings, publishedAt, mismatched };
      },
      timeoutMs,
    );
    if (got.unchanged) return false;
    const { readings, publishedAt, mismatched } = got.result;
    if (readings.size < prepared.sites.length * NDW_MIN_MATCH) {
      throw new Error(`the speed file has readings for only ${readings.size} of the ${prepared.sites.length} sites${mismatched ? ` (${mismatched} changed version)` : ''}`);
    }
    if (mismatched !== drift) {
      drift = mismatched;
      if (mismatched) log(`NDW: ${mismatched} sites have a new version in the speed file and are not read until the site list is rebuilt`);
    }
    state.speeds = { since: got.lastModified, at: now(), measuredAt: Number.isFinite(publishedAt) ? publishedAt : null, readings };
    return true;
  }

  async function readSituations() {
    const t = now();
    const got = await readFeed(
      fetchFn,
      NDW_FILES.situations,
      state.situations.since,
      async (xml) => {
        const list = [];
        await readElements(xml, 'sit:situation', (el) => {
          for (const item of parseSituation(el, t)) {
            if (prepared.airports.some((a) => item.line.some(([lat, lon]) => distanceKm(a.lat, a.lon, lat, lon) <= prepared.radiusKm))) list.push(item);
          }
        });
        return list;
      },
      timeoutMs,
    );
    if (got.unchanged) return false;
    state.situations = { since: got.lastModified, at: t, madeAt: Date.parse(got.lastModified) || t, list: got.result };
    return true;
  }

  function publish() {
    // Both files are needed: speeds without situations, or the other way round, would tell half the story.
    if (state.speeds.at == null || state.situations.at == null) return;
    const t = now();
    for (const airport of prepared.airports) {
      answers.set(
        airport.icao,
        airportAnswer(
          airport,
          prepared,
          state.speeds.readings,
          state.situations.list,
          { fetched: Math.max(state.speeds.at, state.situations.at), measuredAt: state.speeds.measuredAt, situationsAt: state.situations.madeAt },
          t,
        ),
      );
    }
  }

  function noteFailure(message) {
    if (!outage) {
      outage = { failures: 0 };
      log(`NDW: ${message} (the last answer stays; further failures are not logged until it reads again)`);
    }
    outage.failures++;
  }

  async function refresh() {
    if (running) return;
    running = true;
    try {
      if (!prepared) await loadSites();
      const results = await Promise.allSettled([readSpeeds(), readSituations()]);
      const failed = results.map((r, i) => (r.status === 'rejected' ? `${['speeds', 'situations'][i]}: ${r.reason?.message ?? r.reason}` : null)).filter(Boolean);
      if (results.some((r) => r.status === 'fulfilled' && r.value)) publish();
      if (failed.length) noteFailure(failed.join('; '));
      else if (outage) {
        log(`NDW: reading again after ${outage.failures} failed ${outage.failures === 1 ? 'minute' : 'minutes'}`);
        outage = null;
      }
    } catch (err) {
      noteFailure(err.message);
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

// Where a copy of the site list is kept, for when its download fails: NDW_SITES_CACHE, else the
// service's state directory (systemd's StateDirectory=), else the temporary directory.
const ndwCachePath = () => process.env.NDW_SITES_CACHE || join(process.env.STATE_DIRECTORY || tmpdir(), 'power-globe-ndw-sites.json');

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
  ndw = /^(1|true|on|yes)$/i.test(process.env.NDW ?? '') ? createNdwJob({ sitesSource: process.env.NDW_SITES || NDW_SITES_URL, cachePath: ndwCachePath() }) : null,
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
