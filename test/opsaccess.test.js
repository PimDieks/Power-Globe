import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toAirport } from '../src/airports.js';
import { OPS_PARTS, opsPanelHtml } from '../src/ops.js';
import {
  ACCESS_AIRPORTS,
  GREEN_FROM,
  OLD_MIN,
  RED_BELOW,
  accessFact,
  analyseAccess,
  bandCounts,
  isCovered,
  lengthText,
  mapShapes,
  roadText,
  situationText,
  slowStretches,
  speedBand,
} from '../src/opsaccess.js';
import { SOURCE_TEXT, accessBodyHtml, accessPart, accessSectionHtml, subsections } from '../src/opsaccessview.js';

const EHAM = toAirport(['EHAM', 'AMS', 'Amsterdam Airport Schiphol', 'Amsterdam', 'NL', 52.3086, 4.7639, -11, 1, 1, [], 248]);
const EGLL = toAirport(['EGLL', 'LHR', 'London Heathrow Airport', 'London', 'GB', 51.4707, -0.4599, 83, 1, 1, [], 172]);
const EHLE = toAirport(['EHLE', 'LEY', 'Lelystad Airport', 'Lelystad', 'NL', 52.4532, 5.5146, -13, 0, 0, [], 0]);
const NOW = Date.parse('2026-10-14T17:30:00Z');

// A site of the data: [lat, lon, speed, flow, group].
const site = (lat, speed, group = 0, lon = 4.8, flow = 600) => [lat, lon, speed, flow, group];
const jam = (over = {}) => ({ id: 'j1', type: 'jam', kind: 'queuingTraffic', road: 'A4', dir: 'S', delayMin: 12, lengthM: 6000, distKm: 8.2, start: [52.2, 4.7], end: [52.15, 4.72], line: [[52.2, 4.7], [52.15, 4.72]], ...over });
const data = (over = {}) => ({
  airport: 'EHAM',
  source: 'NDW',
  radiusKm: 25,
  fetched: NOW - 20_000,
  measuredAt: NOW - 90_000,
  groups: [['A4', 'S'], ['A9', 'E']],
  sites: [site(52.3, 100), site(52.31, 95), site(52.32, null, 1), site(52.33, 30), site(52.335, 20), site(52.34, 70, 1)],
  situations: [],
  ...over,
});
const ok = (d = data()) => ({ state: 'ok', data: d });
const analyse = (result, airport = EHAM, now = NOW) => analyseAccess({ airport, now, result });

describe('which airports have road data', () => {
  it('is the Dutch airports with scheduled flights, as listed in the sites file the relay reads', () => {
    const file = JSON.parse(readFileSync(new URL('../public/data/ndw-sites.json', import.meta.url), 'utf8'));
    expect(Object.keys(file.airports).sort()).toEqual([...ACCESS_AIRPORTS].sort());
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
    expect(GREEN_FROM).toBe(80);
    expect(RED_BELOW).toBe(50);
    expect([130, 80, 79, 50, 49, 0].map(speedBand)).toEqual(['green', 'green', 'amber', 'amber', 'red', 'red']);
    expect(speedBand(null)).toBe('grey');
    expect(bandCounts(data().sites)).toEqual({ green: 2, amber: 1, red: 2, grey: 1 });
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

describe('slow stretches', () => {
  it('joins slow sites of one road and way that lie close, slowest first, and counts a red one on its own', () => {
    const d = data();
    expect(slowStretches(d, EHAM)).toEqual([{ road: 'A4', dir: 'S', minSpeed: 20, sites: 2, km: expect.any(Number) }]);
    expect(slowStretches(d, EHAM)[0].km).toBeCloseTo(3.4, 0);
  });

  it('does not count one amber site, or two, as a jam, but three', () => {
    const slow = (n) => data({ sites: Array.from({ length: n }, (_, i) => site(52.3 + i * 0.005, 65)) });
    expect(slowStretches(slow(1), EHAM)).toEqual([]);
    expect(slowStretches(slow(2), EHAM)).toEqual([]);
    expect(slowStretches(slow(3), EHAM)).toHaveLength(1);
  });

  it('keeps stretches on other roads, other ways or further apart separate', () => {
    const d = data({ sites: [site(52.3, 30), site(52.3, 35, 1), site(52.4, 40), site(52.5, 45, 0, 4.8)] });
    const found = slowStretches(d, EHAM);
    expect(found.map((s) => [s.road, s.minSpeed])).toEqual([['A4', 30], ['A9', 35], ['A4', 40], ['A4', 45]]);
  });

  it('shows no stretch where all flows, or where lanes are empty', () => {
    expect(slowStretches(data({ sites: [site(52.3, 100), site(52.31, null)] }), EHAM)).toEqual([]);
  });
});

describe('the airport as the part analyses it', () => {
  it('is loading until the first answer, then what the answer says', () => {
    expect(analyse(null)).toEqual({ covered: true, loading: true });
    const a = analyse(ok(data({ situations: [jam(), jam({ id: 'a1', type: 'accident' }), jam({ id: 'c1', type: 'closure' }), jam({ id: 'o1', type: 'obstruction' })] })));
    expect(a).toMatchObject({ covered: true, ageMin: 2, old: false, stale: false, problem: null });
    expect([a.jams, a.accidents, a.closures, a.obstructions].map((l) => l.length)).toEqual([1, 1, 1, 1]);
    expect(a.counts).toEqual({ green: 2, amber: 1, red: 2, grey: 1 });
  });

  it('says why there is no data', () => {
    expect(analyse({ state: 'unavailable', reason: 'The relay is off' }).unavailable).toBe('The relay is off');
    expect(analyse({ state: 'error', error: 'it took too long' }).error).toBe('it took too long');
  });

  it('counts data older than fifteen minutes as old, and an answer the API gave from its backup as stale', () => {
    expect(OLD_MIN).toBe(15);
    expect(analyse(ok(), EHAM, NOW + 13 * 60_000).old).toBe(false);
    expect(analyse(ok(), EHAM, NOW + 14 * 60_000).old).toBe(true);
    expect(analyse(ok(data({ stale: true, ageSeconds: 300 }))).stale).toBe(true);
  });
});

describe('the fact for the status strip', () => {
  const fact = (d, result) => accessFact(analyse(result ?? ok(d)));

  it('says the worst jam: its road, length and delay', () => {
    expect(fact(data({ situations: [jam()] }))).toEqual({ text: 'A4 jam 6 km, +12 min', status: 'caution' });
    const two = data({ situations: [jam({ id: 'j2', road: 'A9', delayMin: 25, lengthM: 9500 }), jam()] });
    expect(fact(two)).toEqual({ text: 'A9 jam 9.5 km, +25 min, 1 more', status: 'caution' });
    expect(fact(data({ situations: [jam({ road: null, lengthM: null, delayMin: null })] })).text).toBe('Jam');
  });

  it('says a slow stretch when there is no jam, an accident when neither', () => {
    expect(fact(data())).toEqual({ text: 'A4 southbound slow, 20 km/h', status: 'caution' });
    const quiet = data({ sites: [site(52.3, 100)], situations: [jam({ type: 'accident', road: 'A4', distKm: 12.4 })] });
    expect(fact(quiet)).toEqual({ text: 'Accident on A4, 12 km out', status: 'caution' });
  });

  it('says the roads flow when nothing is wrong, and counts closures', () => {
    const flowing = data({ sites: [site(52.3, 100), site(52.4, 90)] });
    expect(fact(flowing)).toEqual({ text: 'Roads flowing', status: 'ok' });
    expect(fact({ ...flowing, situations: [jam({ type: 'closure' }), jam({ type: 'closure', id: 'c2' })] }).text).toBe('Roads flowing, 2 closures');
    expect(fact({ ...flowing, situations: [jam({ type: 'closure' })] }).text).toBe('Roads flowing, 1 closure');
  });

  it('is grey, and does not say the roads flow, when there is no data, or it is old', () => {
    expect(accessFact(analyse(null))).toEqual({ text: 'Loading road data', status: 'unknown' });
    expect(accessFact(analyse({ state: 'unavailable', reason: 'x' }))).toEqual({ text: 'No road data', status: 'unknown' });
    expect(accessFact(analyse({ state: 'error', error: 'x' }))).toEqual({ text: 'Road data unavailable', status: 'unknown' });
    expect(accessFact(analyse(ok(), EHAM, NOW + 20 * 60_000))).toEqual({ text: 'Road data 22 min old', status: 'unknown' });
    expect(accessFact(analyse(ok(data({ stale: true }))))).toMatchObject({ status: 'unknown' });
  });
});

describe('what goes on the map', () => {
  it('has a dot for each site by its speed, a line for jams and closures, and a marker for the rest', () => {
    const d = data({ situations: [jam(), jam({ id: 'c1', type: 'closure', line: null }), jam({ id: 'a1', type: 'accident', line: null, start: [52.1, 4.5] }), jam({ id: 'o1', type: 'obstruction', line: null })] });
    const shapes = mapShapes(d);
    expect(shapes.dots.map((s) => s.band)).toEqual(['green', 'green', 'grey', 'red', 'red', 'amber']);
    expect(shapes.dots[0]).toEqual({ lat: 52.3, lng: 4.8, band: 'green' });
    expect(shapes.lines).toEqual([{ kind: 'jam', points: [[52.2, 4.7], [52.15, 4.72]] }]);
    expect(shapes.markers.map((m) => m.kind)).toEqual(['closure', 'accident', 'obstruction']);
    expect(shapes.markers[1]).toEqual({ kind: 'accident', lat: 52.1, lng: 4.5 });
  });
});

describe('the section', () => {
  const html = (d) => accessBodyHtml(analyse(ok(d)));

  it('lists jams and incidents with road, way, length, delay and distance, then the slowest stretches', () => {
    const out = html(data({ situations: [jam(), jam({ id: 'a1', type: 'accident', kind: 'other', road: 'A9', dir: 'E', lengthM: null, delayMin: null, distKm: 12.6 })] }));
    expect(out).toContain('Jam</span> <span class="access-what">A4 southbound, 6 km, +12 min, 8 km from the airport');
    expect(out).toContain('Accident</span> <span class="access-what">A9 eastbound, 13 km from the airport');
    expect(out).toContain('queuing traffic');
    expect(out).toContain('<b>A4 southbound</b> 20 km/h at the slowest, over 2 measuring points, 3 km from the airport');
    expect(out).toContain('Jams and incidents within 25 km');
    expect(out).toContain('2 80+ km/h');
    expect(out).toContain('2 under 50');
  });

  it('shows when the data is from and where it comes from', () => {
    expect(html(data())).toContain('Data from 2 minutes ago. Source: NDW (opendata.ndw.nu).');
    expect(SOURCE_TEXT).toBe('Source: NDW (opendata.ndw.nu)');
    expect(accessBodyHtml(analyse({ state: 'unavailable', reason: 'The relay is off' }))).toContain(SOURCE_TEXT);
  });

  it('says there is nothing to list when there is nothing, and how many more than it lists', () => {
    expect(html(data({ sites: [site(52.3, 100)] }))).toContain('No jams, accidents or closures reported near the airport.');
    expect(html(data({ sites: [site(52.3, 100)] }))).toContain('No slow stretches');
    const many = data({ situations: Array.from({ length: 12 }, (_, i) => jam({ id: `c${i}`, type: 'closure', distKm: i })).concat([jam({ id: 'o', type: 'obstruction' }), jam({ id: 'o2', type: 'obstruction' })]) });
    const out = html(many);
    expect(out.match(/class="access-closure"/g)).toHaveLength(8);
    expect(out).toContain('and 4 more, 2 vehicles or objects on the road');
  });

  it('warns that old, stale or failed data is not the roads now', () => {
    expect(accessBodyHtml(analyse(ok(), EHAM, NOW + 20 * 60_000))).toContain('22 min old and says little of the roads now');
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
  it('comes after the traffic part, with its fact in the strip and a section of its own', () => {
    const ids = OPS_PARTS.map((p) => p.id);
    expect(ids.indexOf('access')).toBe(ids.indexOf('traffic') + 1);
    const out = opsPanelHtml([accessPart], { airport: EHAM, now: NOW });
    expect(out).toContain('data-part="access"');
    expect(out).toContain('<h3 id="ops-access-title">Access</h3>');
    expect(out).toContain('Loading road data');
    expect(accessSectionHtml({ covered: false })).toContain('data-ops-access');
  });

  it('adds nothing to the strip for an airport without road data', () => {
    const out = opsPanelHtml([accessPart], { airport: EGLL, now: NOW });
    expect(out).not.toContain('ops-strip');
    expect(out).toContain('Road data only for Dutch airports for now');
  });
});
