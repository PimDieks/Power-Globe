import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NDW_FILES,
  airportAnswer,
  compassOf,
  createNdwJob,
  createRelay,
  laneSummary,
  parseSituation,
  prepareSites,
  readElements,
  roadOf as roadOfSituation,
} from '../relay/api-relay.mjs';
import { addHeadings, dutchAirports, readSites, roadOf, splitId } from '../scripts/build-ndw-sites.mjs';
import { ACCIDENT_XML, CLOSURE_XML, JAM_XML, MEASUREMENT_XML, OBSTRUCTION_XML, SITE_XML } from './ndw-fixtures.js';

const KEY = 'relay-secret-123456';
// Shortly after the fixtures were published.
const NOW = Date.parse('2026-10-14T17:30:00Z');
const LANES = [[12, 6], [24, 18]];

const chunked = (text, size) => (function* () {
  for (let i = 0; i < text.length; i += size) yield Buffer.from(text.slice(i, i + size));
})();

describe('reading the XML a piece at a time', () => {
  const doc = `<a><roa:measurementSite id="1">one</roa:measurementSite><roa:measurementSiteName>x</roa:measurementSiteName><roa:measurementSite id="2">twö</roa:measurementSite></a>`;

  it('gives each element whole, however the download is cut into pieces', async () => {
    for (const size of [1, 2, 5, 11, 1000]) {
      const found = [];
      await readElements(chunked(doc, size), 'roa:measurementSite', (xml) => found.push(xml));
      expect(found).toEqual(['<roa:measurementSite id="1">one</roa:measurementSite>', '<roa:measurementSite id="2">twö</roa:measurementSite>']);
    }
  });

  it('does not take a longer tag name for the one it looks for, and reads multi-byte characters cut in two', async () => {
    const found = [];
    const bytes = Buffer.from(doc);
    const cut = bytes.indexOf(0xc3) + 1;
    await readElements([bytes.subarray(0, cut), bytes.subarray(cut)], 'roa:measurementSite', (xml) => found.push(xml));
    expect(found).toHaveLength(2);
    expect(found[1]).toContain('twö');
  });

  it('gives up on an element that never ends instead of holding it all', async () => {
    const endless = (function* () {
      yield '<x>';
      for (let i = 0; i < 10; i++) yield 'a'.repeat(1_000_000);
    })();
    await expect(readElements(endless, 'x', () => {})).rejects.toThrow('over');
  });
});

describe('what the lanes of a site say', () => {
  const withLane2 = (flow, speed) => MEASUREMENT_XML.replace('<com:vehicleFlowRate>300<', `<com:vehicleFlowRate>${flow}<`).replace('<com:speed>49.0<', `<com:speed>${speed}<`);

  it('takes the slowest lane that had traffic, and all the flow', () => {
    expect(laneSummary(MEASUREMENT_XML, LANES)).toEqual({ speed: 49, flow: 360 });
  });

  it('does not take a lane with no vehicles for a jam: 0 km/h or -1 with no flow is an empty lane', () => {
    expect(laneSummary(withLane2(0, '0.0'), LANES)).toEqual({ speed: 69, flow: 60 });
    expect(laneSummary(withLane2(0, '-1.0'), LANES)).toEqual({ speed: 69, flow: 60 });
    const empty = withLane2(0, '0.0').replace('<com:vehicleFlowRate>60<', '<com:vehicleFlowRate>0<').replace('<com:speed>69.0<', '<com:speed>-1.0<');
    expect(laneSummary(empty, LANES)).toEqual({ speed: null, flow: 0 });
  });

  it('does count a lane that has traffic and is slow, even at a crawl', () => {
    expect(laneSummary(withLane2(120, '3.0'), LANES)).toEqual({ speed: 3, flow: 180 });
  });

  it('has no speed where the lane has traffic but no speed was measured, and no flow where none was', () => {
    expect(laneSummary(withLane2(300, '-1.0'), LANES)).toEqual({ speed: 69, flow: 360 });
    const nothing = withLane2(-1, '-1.0').replace('<com:vehicleFlowRate>60<', '<com:vehicleFlowRate>-1<').replace('<com:speed>69.0<', '<com:speed>-1.0<');
    expect(laneSummary(nothing, LANES)).toEqual({ speed: null, flow: null });
    expect(laneSummary(MEASUREMENT_XML, [[99, 98]])).toEqual({ speed: null, flow: null });
  });
});

describe('situations', () => {
  it('reads a jam with its delay, queue length and line', () => {
    const jam = parseSituation(JAM_XML, NOW);
    expect(jam).toMatchObject({ id: 'NLRWS_0005484039', type: 'jam', kind: 'stationaryTraffic', delayMin: 17, queueM: 5800 });
    expect(jam.line).toHaveLength(19);
    expect(jam.line[0]).toEqual([51.875981, 5.210852]);
  });

  it('reads an accident at a point, with the direction it faces', () => {
    expect(parseSituation(ACCIDENT_XML, NOW)).toMatchObject({ type: 'accident', kind: 'other', bearing: 64, line: [[52.15548, 4.5321116]], delayMin: null });
  });

  it('reads a closure of a carriageway, and an obstruction', () => {
    expect(parseSituation(CLOSURE_XML, NOW)).toMatchObject({ type: 'closure', kind: 'carriagewayClosures' });
    expect(parseSituation(OBSTRUCTION_XML, NOW)).toMatchObject({ type: 'obstruction', kind: 'other' });
  });

  it('leaves out what is not in force, other kinds of closure, other kinds of situation and anything with no position', () => {
    expect(parseSituation(JAM_XML, Date.parse('2026-10-14T15:00:00Z'))).toBeNull();
    expect(parseSituation(CLOSURE_XML.replace('</com:validityTimeSpecification>', '<com:overallEndTime>2026-10-14T17:15:00Z</com:overallEndTime></com:validityTimeSpecification>'), NOW)).toBeNull();
    expect(parseSituation(CLOSURE_XML.replace('carriagewayClosures', 'lanesDeviated'), NOW)).toBeNull();
    expect(parseSituation(JAM_XML.replace('sit:AbnormalTraffic', 'sit:SpeedManagement'), NOW)).toBeNull();
    expect(parseSituation(ACCIDENT_XML.replace(/<loc:pointCoordinates>.*?<\/loc:pointCoordinates>/s, ''), NOW)).toBeNull();
  });

  it('gives a situation the road and way of the measurement site next to it that goes the same way', () => {
    const sites = [
      { lat: 52.15548, lon: 4.5321, road: 'A4', heading: 244 },
      { lat: 52.15549, lon: 4.5322, road: 'A4', heading: 64 },
      { lat: 52.2, lon: 4.6, road: 'A44', heading: 64 },
    ];
    const accident = parseSituation(ACCIDENT_XML, NOW);
    expect(roadOfSituation(accident, sites)).toEqual({ road: 'A4', dir: 'NE' });
    // Too far from any site to name the road; the way is that of the situation.
    expect(roadOfSituation({ line: [[52.5, 4.5]], bearing: 270 }, sites)).toEqual({ road: null, dir: 'W' });
    expect(compassOf(359)).toBe('N');
    expect(compassOf(181)).toBe('S');
  });
});

describe('the answer for an airport', () => {
  const file = {
    version: 1,
    radiusKm: 25,
    airports: { EHAM: [52.3086, 4.7639] },
    prefixes: ['GAD02_Amstd_', ''],
    patterns: [LANES],
    sites: [
      [0, '31_0', 52.379673, 4.901155, 'A10', 90, 0],
      [0, '31_2', 52.37943, 4.9013, 'A10', 270, 0],
      [1, 'FAR_1', 51.0, 5.0, 'A2', null, 0],
    ],
  };

  it('keeps the sites within the radius and gives each its reading and its road and way', () => {
    const prepared = prepareSites(file);
    expect(prepared.sites.map((s) => s.id)).toEqual(['GAD02_Amstd_31_0', 'GAD02_Amstd_31_2', 'FAR_1']);
    expect(prepared.airports[0].sites).toHaveLength(2);
    const readings = new Map([['GAD02_Amstd_31_0', { speed: 49, flow: 360 }]]);
    const accident = parseSituation(ACCIDENT_XML, NOW);
    const answer = airportAnswer(prepared.airports[0], prepared, readings, [accident, parseSituation(JAM_XML, NOW)], { fetched: 5 });
    expect(answer).toMatchObject({ airport: 'EHAM', source: 'NDW', radiusKm: 25, fetched: 5, groups: [['A10', 'E'], ['A10', 'W']] });
    expect(answer.sites).toEqual([[52.37967, 4.90116, 49, 360, 0], [52.37943, 4.9013, null, null, 1]]);
    // The jam is far from this airport; the accident 23 km away is within.
    expect(answer.situations.map((s) => [s.type, s.distKm])).toEqual([['accident', 23.2]]);
  });

  it('refuses a list in a form it does not know', () => {
    expect(() => prepareSites({ version: 2, sites: [], airports: {} })).toThrow('not in a form');
  });
});

describe('the sites near the airports (build-ndw-sites)', () => {
  let dir;
  afterEach(() => dir && rm(dir, { recursive: true, force: true }));

  const moved = (lat, lon, id) => SITE_XML.replace('id="GAD02_Amstd_31_0"', `id="${id}"`).replace('<loc:latitude>52.379673', `<loc:latitude>${lat}`).replace('<loc:longitude>4.901155', `<loc:longitude>${lon}`);

  it('streams the list and keeps the sites within 25 km of an airport, with their lanes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ndw-'));
    const noSpeed = moved(52.31, 4.77, 'NEAR_NOSPEED').replace(/<roa:measurementSpecificCharacteristics index="(12|24)">.*?<\/roa:measurementSpecificCharacteristics><\/roa:measurementSpecificCharacteristics>/gs, '');
    const list = join(dir, 'list.xml');
    await writeFile(list, `<x>${SITE_XML}${moved(52.31, 4.77, 'NEAR_1')}${moved(51.0, 5.0, 'FAR_1')}${noSpeed}</x>`);
    const { sites, total } = await readSites(list, { EHAM: [52.3086, 4.7639] });
    expect(total).toBe(4);
    expect(sites.map((s) => s.id)).toEqual(['GAD02_Amstd_31_0', 'NEAR_1']);
    expect(sites[0]).toMatchObject({ name: 'Michiel de Ruijtertunnel Richting West', lanes: [[12, 6], [24, 18]] });
    // The site that has flow but no speed is left out: speed only counts where there is flow.
  });

  it('names a road from the id or the name, and the side the numbers run', () => {
    expect(roadOf('RWS01_MONIBAS_0041hrl0322ra', '0041hrl0322ra')).toEqual({ road: 'A4', side: 'l', position: 322, connecting: false });
    expect(roadOf('RWS01_MONIBAS_0100vwp0308ra', '0100vwp0308ra')).toMatchObject({ road: 'A10', connecting: true });
    expect(roadOf('GEO0B_Z_RWSTIN284', '200hrr001460')).toMatchObject({ road: 'N200', side: 'r' });
    expect(roadOf('PZH01_MST_0835_01', 'N463 km 2.736 Li')).toEqual({ road: 'N463', side: 'l', position: 2.736, connecting: false });
    expect(roadOf('PNH02_PNHTI515r', 'N203 Provincialeweg, Lage / Hogedijk')).toMatchObject({ road: 'N203', side: null });
    expect(roadOf('RWS01_MONICA_00D001010049D007000B', '00D001010049D007000B')).toBeNull();
    expect(splitId('RWS01_MONIBAS_0041hrl0322ra')).toEqual(['RWS01_MONIBAS_', '0041hrl0322ra']);
    expect(splitId('NOUNDERSCORE')).toEqual(['', 'NOUNDERSCORE']);
  });

  it('gives each site a direction from its neighbours: along the numbers on the right, against them on the left', () => {
    // A road running south as its numbers rise, with a carriageway each way.
    const site = (side, position, lat) => ({ road: 'A4', side, position, lat, lon: 4.75, connecting: false });
    const sites = addHeadings([site('r', 10, 52.4), site('r', 20, 52.39), site('r', 30, 52.38), site('l', 10, 52.4), site('l', 20, 52.39), site('l', 30, 52.38)]);
    expect(sites.slice(0, 3).map((s) => s.heading)).toEqual([180, 180, 180]);
    expect(sites.slice(3).map((s) => s.heading)).toEqual([0, 0, 0]);
    // A site with no neighbour near, or on a road without sides, has no direction.
    const alone = addHeadings([site('r', 10, 52.4), { road: 'N203', side: null, position: null, lat: 52.1, lon: 4.5, connecting: false }, site('r', 20, 51.0)]);
    expect(alone.map((s) => s.heading)).toEqual([undefined, undefined, undefined]);
  });

  it('takes the Dutch airports with scheduled flights from the airport list, busiest first', () => {
    const row = (ident, country, lat, scheduled, routes) => [ident, '', ident, '', country, lat, 5, 0, 1, scheduled, [], routes];
    const airports = [row('EHEH', 'NL', 51.4, 1, 63), row('EHAM', 'NL', 52.3, 1, 248), row('EHLE', 'NL', 52.4, 0, 0), row('EBBR', 'BE', 50.9, 1, 200)];
    expect(dutchAirports({ airports })).toEqual({ EHAM: [52.3, 5], EHEH: [51.4, 5] });
  });
});

describe('the road job', () => {
  const siteList = {
    version: 1,
    radiusKm: 25,
    airports: { EHAM: [52.3086, 4.7639], EHZZ: [51.87, 5.21], EHGG: [53.1191, 6.5777] },
    prefixes: ['GAD02_Amstd_'],
    patterns: [LANES],
    sites: [[0, '31_0', 52.379673, 4.901155, 'A10', 90, 0]],
  };
  const speeds = `<mc>${MEASUREMENT_XML}<roa:siteMeasurements><roa:measurementSiteReference targetClass="roa:MeasurementSite" id="OTHER" version="1"/></roa:siteMeasurements></mc>`;
  const situations = `<mc>${JAM_XML}${ACCIDENT_XML}${CLOSURE_XML}${OBSTRUCTION_XML}</mc>`;

  function feeds({ lastModified = 'Wed, 14 Oct 2026 17:29:00 GMT', failing = [] } = {}) {
    const bodies = { [NDW_FILES.speeds]: speeds, [NDW_FILES.situations]: situations };
    return vi.fn(async (url, init = {}) => {
      if (url === 'https://sites.example/ndw-sites.json') return new Response(JSON.stringify(siteList));
      const name = url.split('/').at(-1);
      if (failing.includes(name)) return new Response('busy', { status: 503 });
      if (init.headers?.['if-modified-since'] === lastModified) return new Response(null, { status: 304 });
      return new Response(gzipSync(bodies[name]), { headers: { 'last-modified': lastModified } });
    });
  }
  const make = (fetchFn, log = vi.fn()) => createNdwJob({ sitesSource: 'https://sites.example/ndw-sites.json', fetchFn, now: () => NOW, log });

  it('reads the files, keeps what is near each airport and answers for it', async () => {
    const log = vi.fn();
    const job = make(feeds(), log);
    expect(job.get('EHAM')).toBeNull();
    await job.refresh();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 measurement sites for EHAM, EHZZ, EHGG'));
    const eham = job.get('EHAM');
    expect(eham).toMatchObject({ airport: 'EHAM', source: 'NDW', fetched: NOW, measuredAt: Date.parse('2026-10-14T17:22:00Z'), situationsAt: Date.parse('2026-10-14T17:29:00Z') });
    expect(eham.sites).toEqual([[52.37967, 4.90116, 49, 360, 0]]);
    expect(eham.situations.map((s) => s.type)).toEqual(['accident']);
    const zz = job.get('EHZZ');
    expect(zz.situations[0]).toMatchObject({ type: 'jam', delayMin: 17, lengthM: 5800 });
    expect(zz.sites).toEqual([]);
    expect(job.get('EHGG').situations.map((s) => s.type)).toEqual(['closure']);
    expect(job.get('EHLE')).toBeNull();
    expect(job.airports()).toEqual(['EHAM', 'EHZZ', 'EHGG']);
  });

  it('asks again only for what changed: the files are asked for with If-Modified-Since', async () => {
    const fetchFn = feeds();
    const job = make(fetchFn);
    await job.refresh();
    const before = job.get('EHAM');
    await job.refresh();
    const asks = fetchFn.mock.calls.filter(([url]) => url.includes('opendata.ndw.nu'));
    expect(asks).toHaveLength(4);
    expect(asks[0][1].headers['if-modified-since']).toBeUndefined();
    expect(asks[2][1].headers['if-modified-since']).toBe('Wed, 14 Oct 2026 17:29:00 GMT');
    expect(job.get('EHAM')).toBe(before);
  });

  it('says what failed in each file, and how many times in a row', async () => {
    const log = vi.fn();
    const job = make(feeds({ failing: [NDW_FILES.speeds, NDW_FILES.situations] }), log);
    await job.refresh();
    expect(job.get('EHAM')).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/NDW: speeds: .*answered 503; situations: .*answered 503 \(failure 1 in a row/));
    await job.refresh();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('failure 2 in a row'));
  });

  it('keeps the last answer when a later read fails', async () => {
    const log = vi.fn();
    let broken = false;
    const base = feeds();
    const fetchFn = vi.fn(async (url, init) => (broken && url.includes('opendata') ? new Response('busy', { status: 503 }) : base(url, init)));
    const job = make(fetchFn, log);
    await job.refresh();
    const answer = job.get('EHAM');
    broken = true;
    await job.refresh();
    expect(job.get('EHAM')).toBe(answer);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('the last answer stays'));
  });

  it('says so when the list of sites cannot be had, and tries again next time', async () => {
    const log = vi.fn();
    const job = createNdwJob({ sitesSource: 'https://sites.example/ndw-sites.json', fetchFn: async () => new Response('gone', { status: 404 }), log });
    await job.refresh();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NDW: https://sites.example/ndw-sites.json answered 404'));
    expect(job.ready()).toBe(false);
  });

  it('reads the list of sites from a file when it is given one', async () => {
    const read = vi.fn(async () => JSON.stringify(siteList));
    const job = createNdwJob({ sitesSource: '/data/ndw-sites.json', read, fetchFn: feeds(), now: () => NOW, log: () => {} });
    await job.refresh();
    expect(read).toHaveBeenCalledWith('/data/ndw-sites.json', 'utf8');
    expect(job.get('EHAM')).not.toBeNull();
  });
});

describe('/ndw/<ICAO> in the relay', () => {
  const get = (path, headers = {}) => ({ method: 'GET', path, headers: { 'x-relay-key': KEY, ...headers } });
  const jobWith = (answers, airports = Object.keys(answers)) => ({ get: (icao) => answers[icao] ?? null, ready: () => true, airports: () => airports });

  it('needs the relay key like every other path', async () => {
    const relay = createRelay({ key: KEY, ndw: jobWith({ EHAM: { airport: 'EHAM' } }) });
    expect((await relay({ method: 'GET', path: '/ndw/EHAM', headers: {} })).status).toBe(401);
    expect((await relay(get('/ndw/EHAM'))).status).toBe(200);
  });

  it('says the job is off when it is not switched on, and has not read yet when it has no data', async () => {
    const off = await createRelay({ key: KEY })(get('/ndw/EHAM'));
    expect(off.status).toBe(503);
    expect(JSON.parse(off.body)).toMatchObject({ ndw: 'off' });
    const warming = await createRelay({ key: KEY, ndw: { get: () => null, ready: () => false, airports: () => [] } })(get('/ndw/EHAM'));
    expect(warming.status).toBe(503);
    expect(JSON.parse(warming.body)).toMatchObject({ ndw: 'on' });
  });

  it('gives 404 for an airport it has no sites for, and the answer for one it has, compressed when asked', async () => {
    const answer = { airport: 'EHAM', sites: Array.from({ length: 300 }, (_, i) => [52 + i / 1000, 4, 80, 600, 0]) };
    const relay = createRelay({ key: KEY, ndw: jobWith({ EHAM: answer }) });
    expect((await relay(get('/ndw/EHLE'))).status).toBe(404);
    const res = await relay(get('/ndw/eham', { 'accept-encoding': 'gzip' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(res.body))).toEqual(answer);
    expect(res.headers['x-answered-by']).toBeUndefined();
  });

  it('does not touch the flight feeds', async () => {
    const fetchFn = vi.fn(async () => new Response('{"ac":[]}'));
    const relay = createRelay({ key: KEY, fetchFn, spacingMs: 0, ndw: jobWith({}) });
    expect((await relay(get('/api.adsb.lol/v2/mil'))).status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
