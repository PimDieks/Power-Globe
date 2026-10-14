import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MIN_LANE_FLOW,
  NDW_FILES,
  NDW_TIMEOUT_MS,
  addHeadings,
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
import { MOTORWAYS, dutchAirports, readSites, roadOf, splitId } from '../scripts/build-ndw-sites.mjs';
import {
  ACCIDENT_CLOSURE_XML,
  ACCIDENT_XML,
  CLOSURE_XML,
  EVENT_XML,
  JAM_XML,
  MAINTENANCE_XML,
  MEASUREMENT_XML,
  MULTI_XML,
  OBSTRUCTION_XML,
  SITE_XML,
} from './ndw-fixtures.js';

const KEY = 'relay-secret-123456';
// Shortly after the fixtures were published.
const NOW = Date.parse('2026-10-14T19:40:00Z');
const HOUR = 3600_000;
const LANES = [[12, 6], [24, 18]];

const chunked = (text, size) => (function* () {
  for (let i = 0; i < text.length; i += size) yield Buffer.from(text.slice(i, i + size));
})();

describe('reading the XML a piece at a time', () => {
  const doc = `<a><head>h</head><roa:measurementSite id="1">one</roa:measurementSite><roa:measurementSiteName>x</roa:measurementSiteName><roa:measurementSite id="2">twö</roa:measurementSite></a>`;

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

  it('gives what comes before the first element, once, to read the publication time from', async () => {
    const heads = [];
    await readElements(chunked(doc, 3), 'roa:measurementSite', () => {}, (head) => heads.push(head));
    expect(heads).toHaveLength(1);
    expect(heads[0]).toContain('<head>h</head>');
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
  // Lane 1 of the fixture has 60 vehicles an hour at 69 km/h, lane 2 300 at 49.
  const lane = (xml, n, flow, speed) => {
    const [flowIndex, speedIndex] = n === 1 ? [6, 12] : [18, 24];
    const quantity = (index, name, value) => (text) => text.replace(new RegExp(`(<roa:physicalQuantity index="${index}">.*?<${name}>)[^<]*`, 's'), `$1${value}`);
    return quantity(speedIndex, 'com:speed', speed)(quantity(flowIndex, 'com:vehicleFlowRate', flow)(xml));
  };

  it('counts only lanes with the traffic of a road, and weighs the speeds by the flow', () => {
    expect(MIN_LANE_FLOW).toBe(120);
    // The slow lane 1 has 60 vehicles an hour: too few to say anything of the road.
    expect(laneSummary(MEASUREMENT_XML, LANES)).toEqual({ speed: 49, flow: 360 });
    const busy = lane(lane(MEASUREMENT_XML, 1, 600, '100.0'), 2, 200, '40.0');
    expect(laneSummary(busy, LANES)).toEqual({ speed: 85, flow: 800 });
  });

  it('is not led astray by a lane with a vehicle or two at 0 km/h', () => {
    const lone = lane(lane(MEASUREMENT_XML, 1, 12, '0.0'), 2, 900, '95.0');
    expect(laneSummary(lone, LANES)).toEqual({ speed: 95, flow: 912 });
  });

  it('does not take a lane with no vehicles for a jam: 0 km/h or -1 with no flow is an empty lane', () => {
    expect(laneSummary(lane(MEASUREMENT_XML, 2, 0, '0.0'), LANES)).toEqual({ speed: null, flow: 60 });
    const empty = lane(lane(MEASUREMENT_XML, 1, 0, '-1.0'), 2, 0, '0.0');
    expect(laneSummary(empty, LANES)).toEqual({ speed: null, flow: 0 });
  });

  it('does count lanes that have traffic and are slow, even at a crawl', () => {
    expect(laneSummary(lane(MEASUREMENT_XML, 2, 200, '3.0'), LANES)).toEqual({ speed: 3, flow: 260 });
  });

  it('has no speed where no speed was measured, and no flow where none was', () => {
    expect(laneSummary(lane(MEASUREMENT_XML, 2, 300, '-1.0'), LANES)).toEqual({ speed: null, flow: 360 });
    const nothing = lane(lane(MEASUREMENT_XML, 1, -1, '-1.0'), 2, -1, '-1.0');
    expect(laneSummary(nothing, LANES)).toEqual({ speed: null, flow: null });
    expect(laneSummary(MEASUREMENT_XML, [[99, 98]])).toEqual({ speed: null, flow: null });
  });
});

describe('situations', () => {
  const only = (xml, now = NOW) => parseSituation(xml, now);

  it('reads a jam with its delay and queue length, whatever its cause', () => {
    const [jam] = only(JAM_XML);
    expect(jam).toMatchObject({ type: 'jam', kind: 'stationaryTraffic', cause: 'earlierIncident', queueM: expect.any(Number), delayMin: expect.any(Number) });
    expect(jam.delayMin).toBeGreaterThan(0);
    expect(jam.line.length).toBeGreaterThan(1);
  });

  it('reads an accident at a point, with the direction it faces', () => {
    expect(only(ACCIDENT_XML)).toMatchObject([{ type: 'accident', kind: 'other', line: [[51.89863, 4.5010505]], delayMin: null }]);
    expect(only(ACCIDENT_XML)[0].bearing).toEqual(expect.any(Number));
  });

  it('takes a closure for an accident as an accident, so it raises the fact like one', () => {
    expect(only(ACCIDENT_CLOSURE_XML)).toMatchObject([{ type: 'accident', cause: 'accident', status: 'implemented' }]);
  });

  it('keeps a closure for another cause as a closure, and an obstruction that began recently', () => {
    expect(only(CLOSURE_XML).map((r) => [r.type, r.cause])).toEqual(expect.arrayContaining([['closure', 'other']]));
    expect(only(OBSTRUCTION_XML)).toMatchObject([{ type: 'obstruction' }]);
  });

  it('reads every record of a situation: the speed limit that comes first, and the roadworks closures after it', () => {
    const records = only(MULTI_XML);
    // The third record deviates lanes, which is not a closure.
    expect(records.map((r) => r.type)).toEqual(['limit', 'maintenance']);
    expect(records[0]).toMatchObject({ limitKmh: 70, status: 'implemented' });
    expect(records[1]).toMatchObject({ cause: 'roadMaintenance', kind: 'laneClosures' });
    expect(new Set(records.map((r) => r.situation)).size).toBe(1);
    expect(new Set(records.map((r) => r.id)).size).toBe(2);
  });

  it('marks roadworks, to be counted when they end soon, and not as closures', () => {
    expect(only(MAINTENANCE_XML)).toMatchObject([{ type: 'maintenance', status: 'implemented', until: Date.parse('2026-11-29T11:00:00Z') }]);
  });

  it('leaves out what is not in force: not started, ended, approved but not implemented', () => {
    expect(only(JAM_XML, Date.parse('2026-10-14T10:00:00Z'))).toEqual([]);
    expect(only(MAINTENANCE_XML, Date.parse('2026-12-01T00:00:00Z'))).toEqual([]);
    // The public event closure is approved, not yet implemented.
    expect(only(EVENT_XML)).toEqual([]);
    expect(only(CLOSURE_XML.replaceAll('implemented', 'approved'))).toEqual([]);
  });

  it('keeps a closure for a public event only within a day of its start', () => {
    const implemented = EVENT_XML.replaceAll('approved', 'implemented');
    const at = (iso) => EVENT_XML.includes('2026-10-14T04:05:15') && implemented.replaceAll('2026-10-14T04:05:15.122095288Z', iso);
    expect(only(at('2026-10-14T04:05:15.122095288Z'))).toMatchObject([{ type: 'closure', cause: 'publicEvent' }]);
    expect(only(at('2026-10-13T04:05:15.122095288Z'))).toEqual([]);
  });

  it('leaves out obstructions that began over three hours ago', () => {
    expect(only(OBSTRUCTION_XML, NOW + 3 * HOUR)).toEqual([]);
  });

  it('leaves out other kinds of closure, other kinds of situation and anything with no position', () => {
    expect(only(CLOSURE_XML.replaceAll('carriagewayClosures', 'lanesDeviated').replaceAll('laneClosures', 'lanesDeviated'))).toEqual([]);
    expect(only(JAM_XML.replace('sit:AbnormalTraffic', 'sit:ReroutingManagement'))).toEqual([]);
    expect(only(ACCIDENT_XML.replace(/<loc:pointCoordinates>.*?<\/loc:pointCoordinates>/s, ''))).toEqual([]);
  });

  it('gives a situation the road and way of the measurement site next to it that goes the same way', () => {
    const sites = [
      { lat: 51.89863, lon: 4.50105, road: 'A20', heading: 244 },
      { lat: 51.89864, lon: 4.50106, road: 'A20', heading: 64 },
      { lat: 51.95, lon: 4.6, road: 'A44', heading: 64 },
    ];
    const [accident] = only(ACCIDENT_XML);
    expect(roadOfSituation({ ...accident, bearing: 64 }, sites)).toEqual({ road: 'A20', dir: 'NE' });
    // Too far from any site to name the road; the way is that of the situation.
    expect(roadOfSituation({ line: [[52.5, 4.5]], bearing: 270 }, sites)).toEqual({ road: null, dir: 'W' });
    expect(compassOf(359)).toBe('N');
    expect(compassOf(181)).toBe('S');
  });
});

describe('the site list', () => {
  const row = (extra = {}) => [0, '31_0', 52.379673, 4.901155, 'A10', 'r', 100, '19', 0, ...Object.values(extra)];
  const file = (sites) => ({ version: 2, radiusKm: 25, airports: { EHAM: [52.3086, 4.7639] }, prefixes: ['GAD02_Amstd_'], patterns: [LANES], sites });

  it('keeps the sites within the radius, with the full id, side, position and version', () => {
    const prepared = prepareSites(file([row(), [0, 'FAR', 51.0, 5.0, 'A2', 'l', 5, '2', 0]]));
    expect(prepared.sites.map((s) => s.id)).toEqual(['GAD02_Amstd_31_0', 'GAD02_Amstd_FAR']);
    expect(prepared.airports[0].sites).toHaveLength(1);
    expect(prepared.byId.get('GAD02_Amstd_31_0')).toMatchObject({ road: 'A10', side: 'r', position: 100, version: '19', lanes: LANES });
  });

  it('leaves out rows that are not usable, and refuses a file that has too many of them', () => {
    const good = Array.from({ length: 20 }, (_, i) => [0, `S${i}`, 52.3 + i / 1000, 4.9, 'A10', 'r', i, '1', 0]);
    expect(prepareSites(file([...good, [0, 'BAD', 'x', 4.9, 'A10', 'r', 1, '1', 0]])).sites).toHaveLength(20);
    const bad = [[0, 'A', 52, 4, 'A10', 'r', 1, '1', 9], [9, 'B', 52, 4, 'A10', 'r', 1, '1', 0], [0, 'C', 99, 4, 'A10', 'r', 1, '1', 0], null, [0, 'E', 52, 4, '', 'r', 1, '1', 0]];
    expect(() => prepareSites(file([...good.slice(0, 5), ...bad]))).toThrow('usable rows');
    expect(() => prepareSites({ ...file([row()]), version: 1 })).toThrow('not in a form');
    expect(() => prepareSites({ ...file([row()]), patterns: [[[1, 'x']]] })).toThrow('usable rows');
  });

  it('gives each site a direction from its neighbours: along the numbers on the right, against them on the left', () => {
    // A road running south as its numbers rise, with a carriageway each way.
    const site = (side, position, lat) => ({ road: 'A4', side, position, lat, lon: 4.75 });
    const sites = addHeadings([site('r', 10, 52.4), site('r', 20, 52.39), site('r', 30, 52.38), site('l', 10, 52.4), site('l', 20, 52.39), site('l', 30, 52.38)]);
    expect(sites.slice(0, 3).map((s) => s.heading)).toEqual([180, 180, 180]);
    expect(sites.slice(3).map((s) => s.heading)).toEqual([0, 0, 0]);
    const alone = addHeadings([site('r', 10, 52.4), { road: 'N203', side: '', position: null, lat: 52.1, lon: 4.5 }, site('r', 20, 51.0)]);
    expect(alone.map((s) => s.heading)).toEqual([undefined, undefined, undefined]);
  });
});

describe('the answer for an airport', () => {
  const site = (id, lat, lon, road, side, position, heading) => ({ id, lat, lon, road, side, position, heading, version: '1', lanes: LANES });
  const sites = [
    site('a1', 51.9, 4.5, 'A20', 'r', 30, 64),
    site('a2', 51.91, 4.51, 'A20', 'r', 20, 64),
    site('a3', 51.92, 4.52, 'A20', 'r', 10, 64),
    site('l1', 51.9, 4.5, 'A20', 'l', 20, 244),
    site('n1', 51.95, 4.4, 'N209', '', null, null),
  ];
  const airport = { icao: 'EHRD', lat: 51.9569, lon: 4.4372, sites };
  const prepared = { radiusKm: 25 };
  const readings = new Map([['a1', { speed: 60, flow: 900 }], ['a2', { speed: 90, flow: 1200 }], ['n1', { speed: null, flow: 0 }]]);
  const answer = (items) => airportAnswer(airport, prepared, readings, items, { fetched: 5 }, NOW);

  it('gives the sites as one chain for each road and side, in the order of the road, each as lat, lon, speed, flow', () => {
    const { chains } = answer([]);
    expect(chains.map((c) => [c.road, c.side, c.pts.length])).toEqual([['A20', 'r', 3], ['A20', 'l', 1], ['N209', '', 1]]);
    // Sorted by position along the road: the last site comes first.
    expect(chains[0].pts).toEqual([[51.92, 4.52, null, null], [51.91, 4.51, 90, 1200], [51.9, 4.5, 60, 900]]);
  });

  it('ranks jams by delay then length, then the rest: motorways first, then the nearest', () => {
    const [jam] = parseSituation(JAM_XML, NOW);
    const [accident] = parseSituation(ACCIDENT_XML, NOW);
    const [closure] = parseSituation(CLOSURE_XML, NOW);
    const near = (item, lat, lon) => ({ ...item, line: item.line.map(() => [lat, lon]) });
    const out = answer([near(closure, 51.9, 4.5), near(accident, 51.92, 4.52), near({ ...jam, delayMin: 3 }, 51.93, 4.5), near({ ...jam, id: 'worse', delayMin: 12 }, 51.94, 4.5)]);
    expect(out.situations.map((s) => [s.type, s.id === 'worse' ? 'worse' : s.delayMin])).toEqual([['jam', 'worse'], ['jam', 3], ['accident', null], ['closure', null]]);
    expect(out.situations[3]).toMatchObject({ road: 'A20', aRoad: true });
  });

  it('counts roadworks on a motorway that end within 48 hours as planned, and lists none of them', () => {
    const [works] = parseSituation(MAINTENANCE_XML, NOW);
    const at = (until, lat = 51.9) => ({ ...works, until, line: [[lat, 4.5]] });
    const out = answer([at(NOW + 20 * HOUR), at(NOW + 20 * HOUR), { ...at(NOW + 20 * HOUR), situation: 'other' }, at(NOW + 60 * HOUR), at(NOW + 5 * HOUR, 52.2)]);
    // Two of the three that end soon belong to one situation; the one at 52.2 has no motorway site next to it.
    expect(out.planned).toBe(2);
    expect(out.situations).toEqual([]);
  });

  it('keeps the temporary speed limits as context', () => {
    const [limit] = parseSituation(MULTI_XML, NOW);
    const out = answer([{ ...limit, line: [[51.9, 4.5], [51.91, 4.51]] }]);
    expect(out.limits).toMatchObject([{ kmh: 70, road: 'A20' }]);
  });

  it('lists a vehicle reported twice once', () => {
    const [vehicle] = parseSituation(OBSTRUCTION_XML, NOW);
    const out = answer([{ ...vehicle, id: 'x1', line: [[51.9, 4.5]] }, { ...vehicle, id: 'x2', line: [[51.9005, 4.5005]] }, { ...vehicle, id: 'x3', line: [[51.92, 4.52]] }]);
    expect(out.situations.map((s) => s.id).sort()).toEqual(['x1', 'x3']);
  });

  it('leaves out what is beyond the radius', () => {
    const [accident] = parseSituation(ACCIDENT_XML, NOW);
    expect(answer([{ ...accident, line: [[53.5, 6.5]] }]).situations).toEqual([]);
  });
});

describe('the sites near the airports (build-ndw-sites)', () => {
  let dir;
  afterEach(() => dir && rm(dir, { recursive: true, force: true }));

  const moved = (lat, lon, id) => SITE_XML.replace('id="GAD02_Amstd_31_0"', `id="${id}"`).replace('<loc:latitude>52.379673', `<loc:latitude>${lat}`).replace('<loc:longitude>4.901155', `<loc:longitude>${lon}`);

  it('streams the list and keeps the sites within 25 km of an airport, with their lanes and version', async () => {
    dir = await mkdtemp(join(tmpdir(), 'ndw-'));
    const noSpeed = moved(52.31, 4.77, 'NEAR_NOSPEED').replace(/<roa:measurementSpecificCharacteristics index="(12|24)">.*?<\/roa:measurementSpecificCharacteristics><\/roa:measurementSpecificCharacteristics>/gs, '');
    const list = join(dir, 'list.xml');
    await writeFile(list, `<x>${SITE_XML}${moved(52.31, 4.77, 'NEAR_1')}${moved(51.0, 5.0, 'FAR_1')}${noSpeed}</x>`);
    const { sites, total } = await readSites(list, { EHAM: [52.3086, 4.7639] });
    expect(total).toBe(4);
    expect(sites.map((s) => s.id)).toEqual(['GAD02_Amstd_31_0', 'NEAR_1']);
    expect(sites[0]).toMatchObject({ name: 'Michiel de Ruijtertunnel Richting West', version: '19', lanes: [[12, 6], [24, 18]] });
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

  it('calls a number an A road only if it is a motorway of the Netherlands: N46, N3 and N11 are not', () => {
    const road = (n) => roadOf(`RWS01_MONIBAS_${String(n).padStart(3, '0')}1hrl0100ra`, '').road;
    expect([4, 20, 79, 77].map(road)).toEqual(['A4', 'A20', 'A79', 'A77']);
    expect([46, 3, 11, 31].map(road)).toEqual(['N46', 'N3', 'N11', 'A31']);
    expect(MOTORWAYS.has(46)).toBe(false);
    expect(MOTORWAYS.has(1) && MOTORWAYS.has(79)).toBe(true);
  });

  it('takes the Dutch airports with scheduled flights from the airport list, busiest first', () => {
    const row = (ident, country, lat, scheduled, routes) => [ident, '', ident, '', country, lat, 5, 0, 1, scheduled, [], routes];
    const airports = [row('EHEH', 'NL', 51.4, 1, 63), row('EHAM', 'NL', 52.3, 1, 248), row('EHLE', 'NL', 52.4, 0, 0), row('EBBR', 'BE', 50.9, 1, 200)];
    expect(dutchAirports({ airports })).toEqual({ EHAM: [52.3, 5], EHEH: [51.4, 5] });
  });
});

describe('the road job', () => {
  const siteList = {
    version: 2,
    radiusKm: 25,
    airports: { EHAM: [52.3086, 4.7639], EHRD: [51.9569, 4.4372] },
    prefixes: ['GAD02_Amstd_'],
    patterns: [LANES],
    sites: [
      [0, '31_0', 52.379673, 4.901155, 'A10', 'r', 100, '19', 0],
      [0, '31_2', 52.37943, 4.9013, 'A10', 'l', 100, '19', 0],
      [0, 'FAR_1', 51.0, 5.0, 'A2', 'l', 5, '2', 0],
    ],
  };
  const second = MEASUREMENT_XML.replace('id="GAD02_Amstd_31_0"', 'id="GAD02_Amstd_31_2"');
  const speedsDoc = (body = MEASUREMENT_XML + second) =>
    `<mc><com:publicationTime>2026-10-14T19:33:00.001Z</com:publicationTime>${body}<roa:siteMeasurements><roa:measurementSiteReference targetClass="roa:MeasurementSite" id="OTHER" version="1"/></roa:siteMeasurements></mc>`;
  const situationsDoc = `<mc>${ACCIDENT_XML}${MULTI_XML}${MAINTENANCE_XML}</mc>`;
  const SITES = 'https://sites.example/ndw-sites.json';

  // A fetch that serves the site list and both files, with If-Modified-Since honoured.
  function feeds({ lastModified = 'Wed, 14 Oct 2026 19:34:00 GMT', failing = [], bodies = {}, plain = [] } = {}) {
    const docs = { [NDW_FILES.speeds]: speedsDoc(), [NDW_FILES.situations]: situationsDoc, ...bodies };
    return vi.fn(async (url, init = {}) => {
      if (url === SITES) return new Response(JSON.stringify(siteList));
      const name = url.split('/').at(-1);
      if (failing.includes(name)) return new Response('busy', { status: 503 });
      if (init.headers?.['if-modified-since'] === lastModified) return new Response(null, { status: 304 });
      return new Response(plain.includes(name) ? docs[name] : gzipSync(docs[name]), { headers: { 'last-modified': lastModified } });
    });
  }
  const make = (fetchFn, over = {}) => createNdwJob({ sitesSource: SITES, fetchFn, now: () => NOW, log: vi.fn(), ...over });

  it('reads the files, keeps what is near each airport and answers for it', async () => {
    const log = vi.fn();
    const job = make(feeds(), { log });
    expect(job.get('EHAM')).toBeNull();
    await job.refresh();
    expect(log).toHaveBeenCalledWith('NDW: 3 measurement sites for EHAM, EHRD');
    const eham = job.get('EHAM');
    expect(eham).toMatchObject({ airport: 'EHAM', source: 'NDW', fetched: NOW, situationsAt: Date.parse('2026-10-14T19:34:00Z') });
    expect(eham.chains.map((c) => [c.road, c.side])).toEqual([['A10', 'r'], ['A10', 'l']]);
    expect(eham.chains[0].pts).toEqual([[52.37967, 4.90116, 49, 360]]);
    expect(eham.planned).toBe(0);
    expect(job.get('EHRD').situations.map((s) => s.type)).toEqual(['accident']);
    expect(job.get('EHRD').limits.length + job.get('EHAM').limits.length).toBeGreaterThanOrEqual(0);
    expect(job.get('EHLE')).toBeNull();
    expect(job.airports()).toEqual(['EHAM', 'EHRD']);
  });

  it('dates the speeds by the time the file was published, not by the newest reading in it', async () => {
    const job = make(feeds());
    await job.refresh();
    // The readings in the fixture are of 19:22 and the file was published at 19:33.
    expect(job.get('EHAM').measuredAt).toBe(Date.parse('2026-10-14T19:33:00.001Z'));
    const undated = make(feeds({ bodies: { [NDW_FILES.speeds]: speedsDoc().replace('<com:publicationTime>', '<com:x>') } }));
    await undated.refresh();
    expect(undated.get('EHAM').measuredAt).toBeNull();
  });

  it('publishes nothing until both files have been read once', async () => {
    let failing = [NDW_FILES.situations];
    const base = vi.fn(async (url, init) => feeds({ failing })(url, init));
    const job = make(base);
    await job.refresh();
    expect(job.get('EHAM')).toBeNull();
    expect(job.ready()).toBe(true);
    failing = [];
    await job.refresh();
    expect(job.get('EHAM')).not.toBeNull();
    // And the other way round.
    failing = [NDW_FILES.speeds];
    const other = make(base);
    await other.refresh();
    expect(other.get('EHAM')).toBeNull();
  });

  it('treats a speed file that has the sites of the list for hardly any of them as a failure, and publishes nothing from it', async () => {
    const log = vi.fn();
    const job = make(feeds({ bodies: { [NDW_FILES.speeds]: speedsDoc('') } }), { log });
    await job.refresh();
    expect(job.get('EHAM')).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('readings for only 0 of the 3 sites'));
  });

  it('ignores a reading of a site whose version differs from the list: its lanes may have changed', async () => {
    const log = vi.fn();
    const far = MEASUREMENT_XML.replace('id="GAD02_Amstd_31_0" version="19"', 'id="GAD02_Amstd_FAR_1" version="2"');
    const drifted = speedsDoc(MEASUREMENT_XML.replace('version="19"', 'version="20"') + second + far);
    const job = make(feeds({ bodies: { [NDW_FILES.speeds]: drifted } }), { log });
    await job.refresh();
    const eham = job.get('EHAM');
    expect(eham.chains[0].pts[0].slice(2)).toEqual([null, null]);
    expect(eham.chains[1].pts[0].slice(2)).toEqual([49, 360]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1 sites have a new version'));
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
    expect(asks[2][1].headers['if-modified-since']).toBe('Wed, 14 Oct 2026 19:34:00 GMT');
    expect(job.get('EHAM')).toBe(before);
  });

  it('does not read twice at once: a refresh while one is running does nothing', async () => {
    const fetchFn = feeds();
    const job = make(fetchFn);
    await Promise.all([job.refresh(), job.refresh(), job.refresh()]);
    expect(fetchFn.mock.calls.filter(([url]) => url.includes(NDW_FILES.speeds))).toHaveLength(1);
  });

  it('gives up on a file that takes longer than 45 seconds, and says so', async () => {
    vi.useFakeTimers();
    try {
      expect(NDW_TIMEOUT_MS).toBe(45_000);
      const log = vi.fn();
      const hang = vi.fn((url, init = {}) => {
        if (url === SITES) return Promise.resolve(new Response(JSON.stringify(siteList)));
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      });
      const job = make(hang, { log });
      const done = job.refresh();
      await vi.advanceTimersByTimeAsync(44_000);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('took more than'));
      await vi.advanceTimersByTimeAsync(2_000);
      await done;
      expect(log).toHaveBeenCalledWith(expect.stringContaining('speeds: ' + NDW_FILES.speeds + ' took more than 45 s'));
      // A hung download does not leave the job stuck: the next refresh goes ahead.
      await vi.advanceTimersByTimeAsync(0);
      const next = job.refresh();
      await vi.advanceTimersByTimeAsync(46_000);
      await next;
      expect(hang.mock.calls.filter(([url]) => url.includes(NDW_FILES.speeds))).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses an answer that is not gzip, and lets go of the bodies of answers it does not use', async () => {
    const log = vi.fn();
    const job = make(feeds({ plain: [NDW_FILES.speeds] }), { log });
    await job.refresh();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('did not come as a gzip file'));
    const cancel = vi.fn(async () => {});
    const refused = vi.fn(async (url) => (url === SITES ? new Response(JSON.stringify(siteList)) : { status: 503, ok: false, body: { cancel }, headers: new Headers() }));
    await make(refused).refresh();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('logs an outage once, when it starts, and once when it ends, not every minute', async () => {
    const log = vi.fn();
    let failing = [NDW_FILES.speeds];
    const fetchFn = vi.fn(async (url, init) => feeds({ failing })(url, init));
    const job = make(fetchFn, { log });
    for (let i = 0; i < 4; i++) await job.refresh();
    expect(log.mock.calls.filter(([m]) => m.includes('answered 503'))).toHaveLength(1);
    failing = [];
    await job.refresh();
    expect(log).toHaveBeenCalledWith('NDW: reading again after 4 failed minutes');
    await job.refresh();
    expect(log.mock.calls.filter(([m]) => m.includes('reading again'))).toHaveLength(1);
  });

  it('keeps the last answer when a later read fails', async () => {
    let broken = false;
    const base = feeds();
    const job = make(vi.fn(async (url, init) => (broken && url.includes('opendata') ? new Response('busy', { status: 503 }) : base(url, init))));
    await job.refresh();
    const answer = job.get('EHAM');
    broken = true;
    await job.refresh();
    expect(job.get('EHAM')).toBe(answer);
  });

  it('keeps a copy of the site list on disk, and uses it when the download fails', async () => {
    const write = vi.fn(async () => {});
    const job = make(feeds(), { cachePath: '/state/ndw-sites.json', write });
    await job.refresh();
    expect(write).toHaveBeenCalledWith('/state/ndw-sites.json', JSON.stringify(siteList));
    const log = vi.fn();
    const down = vi.fn(async (url, init) => (url === SITES ? new Response('gone', { status: 404 }) : feeds()(url, init)));
    const read = vi.fn(async () => JSON.stringify(siteList));
    const fallback = make(down, { cachePath: '/state/ndw-sites.json', read, log });
    await fallback.refresh();
    expect(read).toHaveBeenCalledWith('/state/ndw-sites.json', 'utf8');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('using the copy of the site list kept at /state/ndw-sites.json'));
    expect(fallback.get('EHAM')).not.toBeNull();
  });

  it('says so when the list of sites cannot be had at all, and tries again next time', async () => {
    const log = vi.fn();
    const job = createNdwJob({ sitesSource: SITES, cachePath: '/none', read: async () => Promise.reject(new Error('no such file')), fetchFn: async () => new Response('gone', { status: 404 }), log });
    await job.refresh();
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`NDW: ${SITES} answered 404`));
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
    const answer = { airport: 'EHAM', chains: [{ road: 'A4', side: 'r', pts: Array.from({ length: 300 }, (_, i) => [52 + i / 1000, 4, 80, 600]) }] };
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
