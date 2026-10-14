import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toAirport } from '../src/airports.js';
import { OPS_PARTS, opsPanelHtml } from '../src/ops.js';
import {
  ACCESS_AIRPORTS,
  GREEN_FROM,
  MAX_INCIDENTS,
  MAX_OBSTRUCTIONS,
  OLD_MIN,
  RED_BELOW,
  RED_MIN_FLOW,
  accessFact,
  analyseAccess,
  bandCounts,
  isCovered,
  lengthText,
  mapShapes,
  measuredStretches,
  roadText,
  situationText,
  speedBand,
} from '../src/opsaccess.js';
import { SOURCE_TEXT, accessBodyHtml, accessPart, accessSectionHtml, subsections } from '../src/opsaccessview.js';

const EHAM = toAirport(['EHAM', 'AMS', 'Amsterdam Airport Schiphol', 'Amsterdam', 'NL', 52.3086, 4.7639, -11, 1, 1, [], 248]);
const EGLL = toAirport(['EGLL', 'LHR', 'London Heathrow Airport', 'London', 'GB', 51.4707, -0.4599, 83, 1, 1, [], 172]);
const EHLE = toAirport(['EHLE', 'LEY', 'Lelystad Airport', 'Lelystad', 'NL', 52.4532, 5.5146, -13, 0, 0, [], 0]);
const NOW = Date.parse('2026-10-14T19:40:00Z');

// Points of a chain: neighbouring sites 0.5 km apart going north from `lat`, with the speeds given
// (a number, or [speed, flow]); the flow is that of a busy road unless said.
const points = (speeds, lat = 52.3, lon = 4.8, flow = 900) => speeds.map((s, i) => [lat + i * 0.0045, lon, ...(Array.isArray(s) ? s : [s, flow])]);
const chain = (road, side, speeds, over = {}) => ({ road, side, pts: points(speeds, over.lat, over.lon, over.flow) });
const jam = (over = {}) => ({ id: 'j1', type: 'jam', kind: 'queuingTraffic', road: 'A4', dir: 'S', aRoad: true, delayMin: 12, lengthM: 6000, distKm: 8.2, start: [52.2, 4.7], end: [52.15, 4.72], line: [[52.2, 4.7], [52.15, 4.72]], ...over });
const item = (type, over = {}) => ({ id: `${type}-1`, type, kind: 'other', road: 'A20', dir: 'E', aRoad: true, delayMin: null, lengthM: null, distKm: 7, start: [52.2, 4.7], end: [52.2, 4.7], line: null, ...over });
const data = (over = {}) => ({
  airport: 'EHAM',
  source: 'NDW',
  radiusKm: 25,
  fetched: NOW - 20_000,
  measuredAt: NOW - 150_000,
  situationsAt: NOW - 100_000,
  chains: [chain('A4', 'r', [100, 95, 90, 100]), chain('A9', 'l', [100, [null, 0], 85])],
  situations: [],
  limits: [],
  planned: 0,
  ...over,
});
const ok = (d = data()) => ({ state: 'ok', data: d });
const analyse = (result, airport = EHAM, now = NOW) => analyseAccess({ airport, now, result });
const fact = (d, now = NOW) => accessFact(analyse(ok(d), EHAM, now));

describe('which airports have road data', () => {
  it('is the Dutch airports with scheduled flights, as listed in the sites file the relay reads', () => {
    const file = JSON.parse(readFileSync(new URL('../public/data/ndw-sites.json', import.meta.url), 'utf8'));
    expect(Object.keys(file.airports).sort()).toEqual([...ACCESS_AIRPORTS].sort());
    expect(file.version).toBe(2);
    expect(file.sites.length).toBeGreaterThan(1000);
    // Small enough to be fetched and kept in the relay without a thought.
    expect(readFileSync(new URL('../public/data/ndw-sites.json', import.meta.url)).length).toBeLessThan(300 * 1024);
  });

  it('says only Dutch airports for now to any other', () => {
    expect(isCovered(EHAM)).toBe(true);
    expect(isCovered(EGLL)).toBe(false);
    expect(isCovered(EHLE)).toBe(false);
    expect(isCovered(undefined)).toBe(false);
    expect(analyse(null, EGLL)).toEqual({ covered: false });
    expect(accessFact(analyse(null, EGLL))).toBeNull();
    expect(accessBodyHtml(analyse(null, EGLL))).toContain('Road data only for Dutch airports for now');
  });
});

describe('the speed of a site', () => {
  it('is green above 80 km/h, amber from 50, red below, and grey with no speed (an empty road says nothing)', () => {
    expect([GREEN_FROM, RED_BELOW, RED_MIN_FLOW]).toEqual([80, 50, 300]);
    expect([130, 80, 79, 50].map((s) => speedBand(s, 900))).toEqual(['green', 'green', 'amber', 'amber']);
    expect([49, 0].map((s) => speedBand(s, 900))).toEqual(['red', 'red']);
    expect(speedBand(null, 0)).toBe('grey');
    expect(speedBand(null)).toBe('grey');
  });

  it('is never red with fewer than 300 vehicles an hour: a few vehicles do not make a jam', () => {
    expect(speedBand(20, 299)).toBe('amber');
    expect(speedBand(20, 300)).toBe('red');
    expect(speedBand(20, null)).toBe('amber');
    expect(speedBand(95, 120)).toBe('green');
  });

  it('counts the motorway sites by colour, and leaves other roads out', () => {
    const d = data({ chains: [chain('A4', 'r', [100, 70, 30, [30, 100]]), chain('A9', 'l', [100, [null, 0]]), chain('N205', '', [10, 10])] });
    expect(bandCounts(d)).toEqual({ green: 2, amber: 2, red: 1, grey: 1 });
  });
});

describe('the words', () => {
  it('names a road with its way, or without when it is not known', () => {
    expect(roadText('A4', 'S')).toBe('A4 southbound');
    expect(roadText('A4', 'NE')).toBe('A4 north-eastbound');
    expect(roadText('N203', null)).toBe('N203');
    expect(roadText(null, 'W')).toBe('Other road westbound');
    expect(roadText(null, null)).toBe('Other road');
  });

  it('gives lengths in metres or kilometres', () => {
    expect([null, 40, 940, 1000, 5800, 12_000].map(lengthText)).toEqual([null, '40 m', '940 m', '1 km', '5.8 km', '12 km']);
  });

  it('puts a situation in a line: road, length, delay, and the distance from the airport', () => {
    expect(situationText(jam())).toBe('A4 southbound, 6 km, +12 min, 8 km from the airport');
    expect(situationText(jam({ road: null, dir: null, lengthM: null, delayMin: 0, distKm: 0.4 }))).toBe('Other road, 0 km from the airport');
  });
});

describe('what the speeds show', () => {
  const found = (chains, limits = []) => measuredStretches({ chains, limits }, EHAM);

  it('shows a jam where three neighbouring motorway sites in a row are below 50 with the flow of a jam, and says which way', () => {
    const { jams, stretches } = found([chain('A4', 'r', [100, 40, 30, 45, 100])]);
    expect(jams).toMatchObject([{ road: 'A4', dir: 'N', sites: 3, minSpeed: 30 }]);
    expect(jams[0].lengthM).toBeGreaterThan(900);
    // It is a jam, so it is not also listed as a slow stretch.
    expect(stretches).toEqual([]);
    // On the left side of the road traffic runs against the numbers.
    expect(found([chain('A4', 'l', [100, 40, 30, 45, 100])]).jams[0].dir).toBe('S');
  });

  it('is not a jam for two sites, for sites that are not neighbours, or where the flow is small', () => {
    expect(found([chain('A4', 'r', [100, 40, 30, 100])]).jams).toEqual([]);
    expect(found([chain('A4', 'r', [40, 30, 100, 45])]).jams).toEqual([]);
    const far = { road: 'A4', side: 'r', pts: [[52.3, 4.8, 40, 900], [52.31, 4.8, 30, 900], [52.4, 4.8, 45, 900]] };
    expect(found([far]).jams).toEqual([]);
    expect(found([chain('A4', 'r', [[40, 200], [30, 250], [20, 100], [100, 900]])]).jams).toEqual([]);
  });

  it('lists a red site, or three slow sites, as a stretch, and one amber site or two as nothing', () => {
    expect(found([chain('A4', 'r', [100, 40, 100])]).stretches).toMatchObject([{ road: 'A4', minSpeed: 40, sites: 1 }]);
    expect(found([chain('A4', 'r', [100, 70, 65, 75, 100])]).stretches).toMatchObject([{ minSpeed: 65, sites: 3 }]);
    expect(found([chain('A4', 'r', [100, 70, 65, 100])]).stretches).toEqual([]);
    expect(found([chain('A4', 'r', [100, 70, 100, 70, 100])]).stretches).toEqual([]);
  });

  it('joins sites round a bend into one stretch: the A10 ring is one road, not eight compass groups', () => {
    // Neighbours going north, then east, then south: one chain.
    const ring = { road: 'A10', side: 'r', pts: [[52.4, 4.8, 100, 900], [52.4, 4.83, 40, 900], [52.4, 4.86, 35, 900], [52.4, 4.89, 45, 900], [52.38, 4.89, 40, 900], [52.36, 4.89, 100, 900]] };
    const { jams } = found([ring]);
    expect(jams).toHaveLength(1);
    expect(jams[0].sites).toBe(4);
  });

  it('gives a temporary speed limit as context, and does not call traffic keeping to it slow', () => {
    const limits = [{ kmh: 70, line: [[52.3, 4.8], [52.31, 4.8]] }];
    expect(found([chain('A4', 'r', [100, 66, 66, 66, 100])], limits).stretches).toEqual([]);
    expect(found([chain('A4', 'r', [100, 66, 66, 66, 100])]).stretches).toHaveLength(1);
    expect(found([chain('A4', 'r', [100, 40, 100])], limits).stretches).toMatchObject([{ minSpeed: 40, limitKmh: 70 }]);
    expect(found([chain('A4', 'r', [100, 40, 100], { lat: 53.5 })], limits).stretches[0].limitKmh).toBeNull();
  });

  it('shows other roads only as three or more neighbouring sites below 25 km/h with the flow of a road', () => {
    const slow = (speeds, flow) => found([chain('N205', '', speeds, { flow })]).stretches;
    expect(slow([20, 22, 18, 100], 900)).toMatchObject([{ road: 'N205', provincial: true, sites: 3, minSpeed: 18 }]);
    expect(slow([20, 22, 100], 900)).toEqual([]);
    expect(slow([30, 30, 30], 900)).toEqual([]);
    expect(slow([20, 22, 18], 100)).toEqual([]);
    // Another road with sides is judged by the order of the road.
    expect(found([chain('N207', 'r', [20, 22, 18, 100])]).stretches).toHaveLength(1);
  });

  it('puts the slowest first', () => {
    const { stretches } = found([chain('A4', 'r', [100, 45, 100]), chain('A9', 'r', [100, 30, 100], { lon: 4.9 }), chain('A12', 'l', [100, 40, 100], { lon: 5 })]);
    expect(stretches.map((s) => s.road)).toEqual(['A9', 'A12', 'A4']);
  });
});

describe('the airport as the part analyses it', () => {
  it('is loading until the first answer, then ranks what the answer says', () => {
    expect(analyse(null)).toEqual({ covered: true, loading: true });
    const a = analyse(ok(data({ situations: [item('obstruction'), item('closure'), item('accident'), jam()] })));
    expect(a).toMatchObject({ covered: true, ageMin: 3, old: false, speedOk: true, stale: false, problem: null });
    expect(a.listed.map((s) => s.type)).toEqual(['jam', 'accident', 'closure', 'obstruction']);
  });

  it('ranks jams by delay then length, accidents, motorway closures, then motorway vehicles, and caps the list', () => {
    const many = [
      item('obstruction', { id: 'o' }),
      item('closure', { id: 'c' }),
      item('accident', { id: 'a2', distKm: 9 }),
      item('accident', { id: 'a1', distKm: 3 }),
      jam({ id: 'short', delayMin: 12, lengthM: 2000 }),
      jam({ id: 'long', delayMin: 12, lengthM: 6000 }),
      jam({ id: 'worst', delayMin: 30 }),
    ];
    const a = analyse(ok(data({ situations: many })));
    expect(a.listed.map((s) => s.id)).toEqual(['worst', 'long', 'short', 'a1', 'a2', 'c', 'o']);
    const lots = analyse(ok(data({ situations: Array.from({ length: 12 }, (_, i) => item('closure', { id: `c${i}`, distKm: i })) })));
    expect(lots.listed).toHaveLength(MAX_INCIDENTS);
    expect(lots.more).toBe(4);
  });

  it('lists only the nearest few vehicles on the road, and counts the rest', () => {
    const cars = Array.from({ length: 7 }, (_, i) => item('obstruction', { id: `o${i}`, distKm: 10 - i }));
    const a = analyse(ok(data({ situations: [...cars, item('accident', { id: 'a' })] })));
    expect(MAX_OBSTRUCTIONS).toBe(4);
    expect(a.listed.map((s) => s.id)).toEqual(['a', 'o6', 'o5', 'o4', 'o3']);
    expect(a.more).toBe(3);
  });

  it('counts, and does not list, what is not on a motorway, and the roadworks that end soon', () => {
    const a = analyse(ok(data({ planned: 3, situations: [item('closure', { aRoad: false, road: 'N205' }), item('closure', { aRoad: false, road: null }), item('obstruction', { aRoad: false }), item('accident', { aRoad: false, road: null })] })));
    expect(a.others).toEqual({ closures: 2, obstructions: 1, planned: 3 });
    // An accident is listed wherever it is.
    expect(a.listed.map((s) => s.type)).toEqual(['accident']);
  });

  it('shows a jam the speeds show where NDW has none, and not twice where it has', () => {
    const slowRoad = data({ chains: [chain('A4', 'r', [100, 40, 30, 45, 100])] });
    const a = analyse(ok(slowRoad));
    expect(a.jams).toMatchObject([{ road: 'A4', dir: 'N', measured: true, delayMin: null }]);
    // NDW's own jam on the same stretch stands for it.
    const both = analyse(ok({ ...slowRoad, situations: [jam({ line: [[52.3045, 4.8], [52.31, 4.8]], start: [52.3045, 4.8], end: [52.31, 4.8] })] }));
    expect(both.jams).toHaveLength(1);
    expect(both.jams[0].measured).toBeUndefined();
  });

  it('says there is no speed data when the file has no time, is old, or has nothing but grey', () => {
    expect(OLD_MIN).toBe(15);
    expect(analyse(ok(), EHAM, NOW + 11 * 60_000).speedOk).toBe(true);
    expect(analyse(ok(), EHAM, NOW + 14 * 60_000)).toMatchObject({ speedOk: false, old: true });
    expect(analyse(ok(data({ measuredAt: null }))).speedOk).toBe(false);
    expect(analyse(ok(data({ chains: [chain('A4', 'r', [[null, 0], [null, 0]])] }))).speedOk).toBe(false);
    expect(analyse(ok(data({ chains: [chain('N205', '', [100, 100])] }))).speedOk).toBe(false);
    expect(analyse(ok(data({ stale: true, ageSeconds: 300 }))).stale).toBe(true);
  });

  it('says why there is no data', () => {
    expect(analyse({ state: 'unavailable', reason: 'The relay is off' }).unavailable).toBe('The relay is off');
    expect(analyse({ state: 'error', error: 'it took too long' }).error).toBe('it took too long');
  });
});

describe('the fact for the summary', () => {
  it('says the worst jam: its road, length and delay', () => {
    expect(fact(data({ situations: [jam()] }))).toMatchObject({ text: 'A4 jam 6 km, +12 min', status: 'caution' });
    const two = data({ situations: [jam({ id: 'j2', road: 'A9', delayMin: 25, lengthM: 9500 }), jam()] });
    expect(fact(two)).toMatchObject({ text: 'A9 jam 9.5 km, +25 min, 1 more', status: 'caution' });
    expect(fact(data({ situations: [jam({ road: null, lengthM: null, delayMin: null })] })).text).toBe('Jam');
  });

  it('says a jam the speeds show, with no delay', () => {
    expect(fact(data({ chains: [chain('A4', 'r', [100, 40, 30, 45, 100])] })).text).toMatch(/^A4 jam \d(\.\d)? km$/);
  });

  it('says an accident, and an accident closure, before any closure', () => {
    expect(fact(data({ situations: [item('closure'), item('accident', { road: 'A4', distKm: 12.4 })] })).text).toBe('Accident on A4, 12 km out');
    expect(fact(data({ situations: [item('accident', { road: 'A20', kind: 'carriagewayClosures', distKm: 7.2 })] })).text).toBe('Accident closure on A20, 7 km out');
    expect(fact(data({ situations: [item('accident', { road: null, distKm: 8 })] })).text).toBe('Accident, 8 km out');
  });

  it('says a motorway closure, then a vehicle on a motorway', () => {
    expect(fact(data({ situations: [item('obstruction'), item('closure', { kind: 'carriagewayClosures' })] })).text).toBe('A20 carriageway closed, 7 km out');
    expect(fact(data({ situations: [item('obstruction', { road: 'A2', distKm: 18.2 })] })).text).toBe('Vehicle on A2, 18 km out');
  });

  it('does not take the fact from anything below the four ranks: roadworks, other roads, slow provincial roads, one slow site', () => {
    const quiet = data({
      chains: [chain('A4', 'r', [100, 40, 100]), chain('N205', '', [10, 10, 10])],
      planned: 5,
      situations: [item('closure', { aRoad: false }), item('obstruction', { aRoad: false })],
    });
    expect(fact(quiet)).toMatchObject({ text: 'Roads flowing', status: 'ok' });
  });

  it('says the roads flow only where the speed data is fresh and has something to say; closures do not change that', () => {
    expect(fact(data())).toMatchObject({ text: 'Roads flowing', status: 'ok' });
    expect(fact(data(), NOW + 20 * 60_000)).toEqual({ text: 'No speed data', status: 'unknown' });
    expect(fact(data({ measuredAt: null }))).toEqual({ text: 'No speed data', status: 'unknown' });
    expect(fact(data({ chains: [chain('A4', 'r', [[null, 0]])] }))).toEqual({ text: 'No speed data', status: 'unknown' });
    // An incident is still said without speed data.
    expect(fact(data({ measuredAt: null, situations: [item('accident')] })).text).toBe('Accident on A20, 7 km out');
  });

  it('gives the time the fact is of, so that the summary greys it when it gets old', () => {
    expect(fact(data({ situations: [jam()] })).asOf).toBe(NOW - 100_000);
    expect(fact(data()).asOf).toBe(NOW - 150_000);
    expect(accessPart.staleAfterMs).toBe(15 * 60_000);
  });

  it('is grey where there is no data', () => {
    expect(accessFact(analyse(null))).toEqual({ text: 'Loading road data', status: 'unknown' });
    expect(accessFact(analyse({ state: 'unavailable', reason: 'x' }))).toEqual({ text: 'No road data', status: 'unknown' });
    expect(accessFact(analyse({ state: 'error', error: 'x' }))).toEqual({ text: 'Road data unavailable', status: 'unknown' });
  });
});

describe('what goes on the map', () => {
  const shapes = (d) => mapShapes(analyse(ok(d)));

  it('draws each motorway as segments between neighbouring sites, coloured by the slower end', () => {
    const { segments } = shapes(data({ chains: [chain('A4', 'r', [100, 70, 40, [null, 0]])] }));
    expect(segments.map((s) => s.band)).toEqual(['amber', 'red', 'red']);
    expect(segments[0].a).toEqual([52.3, 4.8]);
  });

  it('does not join sites that are not neighbours, and draws no sites as dots', () => {
    const far = { road: 'A4', side: 'r', pts: [[52.3, 4.8, 100, 900], [52.4, 4.8, 100, 900]] };
    const out = shapes(data({ chains: [far, chain('A9', 'l', [90])] }));
    expect(out.segments).toEqual([]);
    expect(out).not.toHaveProperty('dots');
  });

  it('leaves other roads off the map unless they are in a listed slow stretch', () => {
    expect(shapes(data({ chains: [chain('N205', '', [100, 100, 100]), chain('N207', 'r', [100, 90, 100])] })).segments).toEqual([]);
    const slow = shapes(data({ chains: [chain('N207', 'r', [20, 22, 18, 100])] })).segments;
    expect(slow.map((s) => s.band)).toEqual(['red', 'red']);
  });

  it('has a line for jams and closures that have geometry, and a marker for the rest', () => {
    const d = data({ situations: [jam(), item('closure', { line: [[52.2, 4.7], [52.21, 4.7]] }), item('accident', { start: [52.1, 4.5] }), item('obstruction'), item('closure', { aRoad: false, line: [[52, 4], [52.1, 4]] })] });
    const out = shapes(d);
    expect(out.lines.map((l) => l.kind)).toEqual(['jam', 'closure']);
    expect(out.markers.map((m) => m.kind)).toEqual(['accident', 'obstruction']);
    expect(out.markers[0]).toEqual({ kind: 'accident', lat: 52.1, lng: 4.5 });
  });
});

describe('the section', () => {
  const html = (d, now = NOW) => accessBodyHtml(analyse(ok(d), EHAM, now));
  const busy = data({
    chains: [chain('A4', 'r', [100, 40, 100])],
    limits: [{ kmh: 70, line: [[52.3045, 4.8]] }],
    planned: 2,
    situations: [jam(), item('accident', { kind: 'other', road: 'A9', dir: 'E', distKm: 12.6 }), item('obstruction', { kind: 'brokenDownVehicle', road: 'A2' }), item('closure', { aRoad: false }), item('obstruction', { aRoad: false })],
  });

  it('lists the ranked items with road, way, length, delay and distance, then the slowest stretches', () => {
    const out = html(busy);
    expect(out).toContain('Jam</span> <span class="access-what">A4 southbound, 6 km, +12 min, 8 km from the airport');
    expect(out).toContain('queuing traffic');
    expect(out).toContain('Accident</span> <span class="access-what">A9 eastbound, 13 km from the airport');
    expect(out).toContain('broken down vehicle');
    expect(out).toContain('<b>A4</b> 40 km/h at the slowest, 2 km from the airport, a temporary limit of 70 km/h is in force');
    expect(out).toContain('Jams and incidents within 25 km');
  });

  it('counts what is left out, and the roadworks that end soon, without listing them', () => {
    const out = html(busy);
    expect(out).toContain('and 1 closure on other roads, 1 vehicle or object on other roads');
    expect(out).toContain('2 roadworks closures on a motorway ends within 48 hours');
    expect(out).not.toContain('access-closure');
  });

  it('marks a jam the speeds show, and a stretch that is not on a motorway', () => {
    const out = html(data({ chains: [chain('A4', 'r', [100, 40, 30, 45, 100]), chain('N205', '', [20, 22, 18])] }));
    expect(out).toContain('measured from the speeds on the road');
    expect(out).toContain('(not a motorway)');
  });

  it('shows the counts by speed and says what a speed is, with the age of the data and the source', () => {
    const out = html(data());
    expect(out).toContain('6 80+ km/h');
    expect(out).toContain('1 too little traffic or no data');
    expect(out).toContain('Speed data from 3 minutes ago. Source: NDW (opendata.ndw.nu).');
    expect(SOURCE_TEXT).toBe('Source: NDW (opendata.ndw.nu)');
    expect(accessBodyHtml(analyse({ state: 'unavailable', reason: 'The relay is off' }))).toContain(SOURCE_TEXT);
  });

  it('says there is nothing to list when there is nothing, and how many more than it lists', () => {
    const quiet = html(data());
    expect(quiet).toContain('No jams, accidents, closures or vehicles on the road reported on the motorways near the airport.');
    expect(quiet).toContain('No slow stretches');
    const many = data({ situations: Array.from({ length: 12 }, (_, i) => item('closure', { id: `c${i}`, distKm: i })) });
    const out = html(many);
    expect(out.match(/class="access-closure"/g)).toHaveLength(8);
    expect(out).toContain('and 4 more');
  });

  it('says there is no speed data, rather than showing the roads green, when there is none', () => {
    const none = accessBodyHtml(analyse(ok(data({ measuredAt: null }))));
    expect(none).toContain('There is no speed data, so nothing can be said of how fast the roads flow.');
    expect(none).not.toContain('80+ km/h');
    expect(html(data(), NOW + 20 * 60_000)).toContain('There is no recent speed data (the newest is 23 min old)');
    expect(html(data({ chains: [chain('A4', 'r', [[null, 0]])] }))).toContain('has nothing to say yet');
  });

  it('warns that stale or failed data is not the roads now', () => {
    expect(html(data({ stale: true }))).toContain('showing its last answer');
    expect(accessBodyHtml(analyse({ state: 'ok', data: data(), problem: 'it took too long' }))).toContain('The last update failed (it took too long)');
  });

  it('says what is wrong when there is no data, and escapes it', () => {
    expect(accessBodyHtml(analyse(null))).toContain('Loading road data');
    expect(accessBodyHtml(analyse({ state: 'error', error: '<b>x</b>' }))).toContain('did not load (&lt;b&gt;x&lt;/b&gt;)');
    expect(accessBodyHtml(analyse({ state: 'unavailable', reason: 'The API has no flight relay' }))).toContain('No road data right now. The API has no flight relay.');
  });

  it('keeps a place for trains and buses after the roads', () => {
    expect(subsections.map((s) => s.id)).toEqual(['roads']);
    expect(html(data())).toContain('data-access="roads"');
  });
});

describe('the part among the others', () => {
  it('is registered in the Access tab, with the roads overlay, after the traffic part', () => {
    const ids = OPS_PARTS.map((p) => p.id);
    expect(ids.indexOf('access')).toBe(ids.indexOf('traffic') + 1);
    expect(accessPart).toMatchObject({ tab: 'access', overlay: 'roads', title: 'Access' });
    for (const hook of ['bind', 'unbind', 'watch', 'unwatch', 'release']) expect(typeof accessPart[hook]).toBe('function');
    const out = opsPanelHtml([accessPart], { airport: EHAM, now: NOW });
    expect(out).toContain('data-part="access"');
    expect(out).toContain('>Access</h3>');
    expect(out).toContain('Loading road data');
    expect(accessSectionHtml({ covered: false })).toContain('data-ops-access');
  });

  it('adds no fact for an airport without road data', () => {
    const out = opsPanelHtml([accessPart], { airport: EGLL, now: NOW });
    expect(out).toContain('Road data only for Dutch airports for now');
    expect(accessPart.fact(accessPart.analyse({ airport: EGLL, now: NOW }))).toBeNull();
  });
});
