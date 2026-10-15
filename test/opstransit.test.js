import { describe, expect, it } from 'vitest';
import { toAirport } from '../src/airports.js';
import { mergeBusPasses } from '../api/worker.js';
import {
  OLD_MIN,
  analyseBuses,
  analyseTrains,
  busesFact,
  combineAccessFacts,
  hasTransit,
  trainsFact,
} from '../src/opstransit.js';
import { BUSES_SOURCE_TEXT, NO_KEY_TEXT, TRAINS_SOURCE_TEXT, busesHtml, trainsHtml } from '../src/opstransitview.js';
import { accessBodyHtml, accessFactAll, analyseSources } from '../src/opsaccessview.js';
import { OVAPI_TPC } from './ovapi-fixtures.js';

const EHAM = toAirport(['EHAM', 'AMS', 'Amsterdam Airport Schiphol', 'Amsterdam', 'NL', 52.3086, 4.7639, -11, 1, 1, [], 248]);
const EHRD = toAirport(['EHRD', 'RTM', 'Rotterdam The Hague Airport', 'Rotterdam', 'NL', 51.9569, 4.4372, -15, 1, 1, [], 30]);
const EGLL = toAirport(['EGLL', 'LHR', 'London Heathrow Airport', 'London', 'GB', 51.4707, -0.4599, 83, 1, 1, [], 172]);
const NOW = Date.parse('2026-10-14T19:59:30Z');
const MIN = 60_000;

// ---- Trains ----

const train = (minutes, over = {}) => ({ planned: NOW + minutes * MIN, actual: NOW + minutes * MIN, delayMin: 0, destination: 'Amsterdam Centraal', track: '1', plannedTrack: '1', cancelled: false, kind: 'SPR', ...over });
const trainData = (over = {}) => ({
  available: true,
  airport: 'EHAM',
  source: 'NS',
  station: 'Schiphol Airport',
  fetched: NOW - 30_000,
  departures: [train(4), train(8), train(12), train(16)],
  disruptions: [],
  ...over,
});
const ok = (data) => ({ state: 'ok', data });
const trains = (result, airport = EHAM, now = NOW) => analyseTrains({ airport, now, result });
const buses = (result, airport = EHAM, now = NOW) => analyseBuses({ airport, now, result });

describe('which airports have train and bus data', () => {
  it('is Schiphol only, and says nothing of any other', () => {
    expect(hasTransit(EHAM)).toBe(true);
    expect(hasTransit(undefined)).toBe(false);
    for (const airport of [EHRD, EGLL, null]) {
      expect(hasTransit(airport)).toBe(false);
      expect(trains(null, airport)).toEqual({ covered: false });
      expect(buses(null, airport)).toEqual({ covered: false });
      expect(trainsFact(trains(null, airport))).toBeNull();
      expect(busesFact(buses(null, airport))).toBeNull();
    }
  });
});

describe('the trains', () => {
  it('are loading until there is a result, and say why when there are none', () => {
    expect(trains(null)).toEqual({ covered: true, loading: true });
    expect(trains({ state: 'unavailable', reason: 'needs an NS API key' })).toEqual({ covered: true, unavailable: 'needs an NS API key' });
    expect(trains({ state: 'error', error: 'answered 502' })).toEqual({ covered: true, error: 'answered 502' });
  });

  it('list the next departures, drop the ones gone, and cap the list', () => {
    const t = trains(ok(trainData({ departures: [train(-5), ...Array.from({ length: 9 }, (_, i) => train(i + 1)), train(-4, { cancelled: true })] })));
    expect(t.departures).toHaveLength(10);
    expect(t.shown).toHaveLength(6);
    expect(t.more).toBe(4);
    expect(t.cancelled).toBe(1);
  });

  it('count the delayed and cancelled ones', () => {
    const t = trains(ok(trainData({ departures: [train(2, { delayMin: 6 }), train(5, { delayMin: 12 }), train(9, { cancelled: true }), train(11)] })));
    expect(t).toMatchObject({ delayed: 2, maxDelay: 12, cancelled: 1 });
  });

  it('keep disruptions and track works apart, and know when the disruptions are not known', () => {
    const list = [{ id: '1', kind: 'disruption', title: 'No trains' }, { id: '2', kind: 'maintenance', title: 'Works' }];
    const t = trains(ok(trainData({ disruptions: list })));
    expect(t.disruptions).toHaveLength(1);
    expect(t.works).toHaveLength(1);
    expect(trains(ok(trainData({ disruptions: null }))).disruptions).toBeNull();
  });

  it('are old when the answer is, or has no time', () => {
    expect(trains(ok(trainData({ fetched: NOW - (OLD_MIN + 2) * MIN }))).old).toBe(true);
    expect(trains(ok(trainData({ fetched: NOW - 3 * MIN }))).old).toBe(false);
    expect(trains(ok(trainData({ fetched: undefined }))).old).toBe(true);
  });

  it('keep the last answer, as the last, with the stale marks and the failure of the update', () => {
    const t = trains({ state: 'ok', data: trainData({ stale: true, ageSeconds: 200 }), problem: 'it took too long' });
    expect(t).toMatchObject({ stale: true, problem: 'it took too long' });
  });
});

describe('the train fact', () => {
  const fact = (data) => trainsFact(trains(ok(trainData(data))));

  it('has nothing to say while loading, or without a key', () => {
    expect(trainsFact(trains(null))).toBeNull();
    expect(trainsFact(trains({ state: 'unavailable', reason: 'needs an NS API key' }))).toBeNull();
  });

  it('is grey when the data did not load or is old, never green', () => {
    expect(trainsFact(trains({ state: 'error', error: 'x' }))).toEqual({ text: 'Train data unavailable', status: 'unknown' });
    expect(fact({ fetched: NOW - 14 * MIN })).toEqual({ text: 'Train data 14 min old', status: 'unknown' });
  });

  it('says disrupted for a disruption through the station, but not for track works', () => {
    expect(fact({ disruptions: [{ kind: 'disruption', title: 'x' }] })).toMatchObject({ text: 'Trains disrupted', status: 'caution', asOf: NOW - 30_000 });
    expect(fact({ disruptions: [{ kind: 'disruption' }, { kind: 'disruption' }] }).text).toBe('Trains disrupted, 2 disruptions');
    expect(fact({ disruptions: [{ kind: 'maintenance', title: 'Works' }] })).toMatchObject({ text: 'Trains on time', status: 'ok' });
  });

  it('says cancelled and delayed trains, and on time only when the disruptions are known and there are trains', () => {
    expect(fact({ departures: [train(3, { cancelled: true }), train(5)] })).toMatchObject({ text: '1 train cancelled', status: 'caution' });
    expect(fact({ departures: [train(3, { cancelled: true }), train(4, { cancelled: true })] }).text).toBe('2 trains cancelled');
    expect(fact({ departures: [train(3, { delayMin: 11 }), train(5)] })).toMatchObject({ text: 'Trains delayed up to 11 min', status: 'caution' });
    expect(fact({ departures: [train(3, { delayMin: 6 }), train(5, { delayMin: 7 })] }).status).toBe('caution');
    expect(fact({ departures: [train(3, { delayMin: 6 }), train(5)] })).toMatchObject({ text: 'Trains on time', status: 'ok' });
    expect(fact({ disruptions: null })).toMatchObject({ text: 'Train disruptions not known', status: 'unknown' });
    expect(fact({ departures: [] })).toMatchObject({ text: 'No train departures listed', status: 'unknown' });
    expect(fact({})).toMatchObject({ text: 'Trains on time', status: 'ok' });
  });
});

// ---- Buses ----

// The real answer of the stops, as the API makes of it.
const busData = (over = {}) => ({ available: true, airport: 'EHAM', source: 'OVapi', fetched: NOW - 20_000, windowMinutes: 60, cancellations: 'reported', passes: mergeBusPasses([OVAPI_TPC], NOW), ...over });
const bus = (minutes, over = {}) => ({ line: '397', destination: 'AMS Elandsgracht', stop: 'Schiphol, Airport', planned: NOW + minutes * MIN, expected: NOW + minutes * MIN, delayMin: 0, status: 'DRIVING', live: true, cancelled: false, ...over });
// A pass the feed says is DRIVING but has not updated for hours: only its schedule is behind the time.
const stale = (minutes, over = {}) => bus(minutes, { live: false, ...over });

describe('the buses', () => {
  it('are loading until there is a result, and say why when there are none', () => {
    expect(buses(null)).toEqual({ covered: true, loading: true });
    expect(buses({ state: 'error', error: 'answered 502' })).toEqual({ covered: true, error: 'answered 502' });
  });

  it('group the real passes by line and destination, in the order of the next bus, a few buses each', () => {
    const b = buses(ok(busData()));
    expect(b.lines.length).toBeGreaterThan(3);
    const firsts = b.lines.map((l) => l.next[0].expected);
    expect(firsts).toEqual([...firsts].sort((x, y) => x - y));
    for (const line of b.lines) {
      expect(line.next.length).toBeLessThanOrEqual(3);
      expect(line.next.every((p) => !p.cancelled && p.line === line.line && p.destination === line.destination)).toBe(true);
    }
    expect(b.running + b.cancelledReported).toBe(b.passes.length);
  });

  it('leave cancelled buses out of the times and count them as reported', () => {
    const b = buses(ok(busData({ passes: [bus(2), bus(5, { cancelled: true, status: 'CANCEL' }), bus(9)] })));
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].next.map((p) => p.expected)).toEqual([NOW + 2 * MIN, NOW + 9 * MIN]);
    expect(b.lines[0].cancelledReported).toBe(1);
    expect(b).toMatchObject({ running: 2, cancelledReported: 1 });
  });

  it('count late and live buses', () => {
    const b = buses(ok(busData({ passes: [bus(2, { delayMin: 6 }), bus(4, { status: 'PLANNED', live: false }), bus(6, { status: 'PLANNED', live: false, delayMin: 2 }), bus(8, { status: 'ARRIVED' })] })));
    expect(b).toMatchObject({ running: 4, late: 1, maxDelay: 6, live: 2 });
  });

  it('do not count a DRIVING bus without a recent update as live, nor its delay as one', () => {
    const b = buses(ok(busData({ passes: [stale(2, { delayMin: 12 }), stale(4), bus(6), bus(8, { delayMin: 6 })] })));
    expect(b).toMatchObject({ running: 4, live: 2, late: 1, maxDelay: 6 });
    // Without the flag, as an older answer of the Worker has it, nothing is live.
    const old = buses(ok(busData({ passes: [bus(2, { live: undefined }), bus(4, { live: undefined })] })));
    expect(old.live).toBe(0);
  });

  it('say when the list of the Worker ends before the hour does', () => {
    expect(buses(ok(busData({ passes: [bus(2), bus(40)] }))).capped).toBe(false);
    const b = buses(ok(busData({ passes: [bus(2), bus(40)], capped: true })));
    expect(b).toMatchObject({ capped: true, cappedTo: NOW + 40 * MIN });
  });

  it('drop buses that have gone, and ones past the window, as the clock moves on', () => {
    const data = busData({ passes: [bus(-3), bus(2), bus(70)] });
    expect(buses(ok(data)).running).toBe(1);
    // Twelve minutes on, the first has gone and the third has come within the hour.
    expect(buses(ok(data), EHAM, NOW + 12 * MIN).running).toBe(1);
    expect(buses(ok(data), EHAM, NOW + 12 * MIN).lines[0].next[0].expected).toBe(NOW + 70 * MIN);
  });

  it('cap the lines', () => {
    const passes = Array.from({ length: 12 }, (_, i) => bus(i + 1, { line: String(100 + i) }));
    const b = buses(ok(busData({ passes })));
    expect(b.lines).toHaveLength(8);
    expect(b.moreLines).toBe(4);
  });
});

describe('the bus fact', () => {
  const fact = (passes, over = {}) => busesFact(buses(ok(busData({ passes, ...over }))));
  const run = (n, over = {}) => Array.from({ length: n }, (_, i) => bus(i + 1, over));
  const SCHEDULED = 'Bus times mostly scheduled, little live data';

  it('has nothing to say while loading, grey when it failed or is old', () => {
    expect(busesFact(buses(null))).toBeNull();
    expect(busesFact(buses({ state: 'error', error: 'x' }))).toEqual({ text: 'Bus data unavailable', status: 'unknown' });
    expect(fact(run(5), { fetched: NOW - 12 * MIN })).toEqual({ text: 'Bus data 12 min old', status: 'unknown' });
  });

  it('is on time, green, only with live times from enough buses', () => {
    expect(fact(run(5))).toMatchObject({ text: 'Buses on time', status: 'ok', asOf: NOW - 20_000 });
    expect(fact(run(5, { status: 'PLANNED', live: false }))).toMatchObject({ text: SCHEDULED, status: 'unknown' });
    expect(fact([bus(2), bus(4, { status: 'PLANNED', live: false })])).toMatchObject({ text: SCHEDULED, status: 'unknown' });
    expect(fact([])).toMatchObject({ text: 'No buses listed', status: 'unknown' });
  });

  it('is not green when most of the DRIVING buses have had no update for hours', () => {
    // 29 of 39 were like that in a live audit: the feed says DRIVING, but the times are the schedule.
    const passes = [...Array.from({ length: 29 }, (_, i) => stale(i + 1)), ...Array.from({ length: 10 }, (_, i) => bus(i + 30))];
    expect(fact(passes)).toMatchObject({ text: SCHEDULED, status: 'unknown', asOf: NOW - 20_000 });
    expect(fact(run(5, { live: false }))).toMatchObject({ text: SCHEDULED, status: 'unknown' });
    // Two live buses are too few, and half live is enough.
    expect(fact([bus(1), bus(2), ...Array.from({ length: 3 }, (_, i) => stale(i + 3))]).text).toBe(SCHEDULED);
    expect(fact([bus(1), bus(2), bus(3), stale(4), stale(5), stale(6)])).toMatchObject({ text: 'Buses on time', status: 'ok' });
  });

  it('takes the share of the buses due in the next 20 minutes, which a healthy feed tracks', () => {
    // Later buses have not started and are only scheduled, which is as it should be.
    const healthy = [...run(5), ...Array.from({ length: 30 }, (_, i) => bus(i + 21, { status: 'PLANNED', live: false }))];
    expect(fact(healthy)).toMatchObject({ text: 'Buses on time', status: 'ok' });
    // Nothing due soon: the share of all of them.
    expect(fact([bus(30), bus(31), bus(32), stale(33)]).status).toBe('ok');
    expect(fact([bus(30), bus(31), bus(32), stale(33), stale(34), stale(35), stale(36)]).text).toBe(SCHEDULED);
  });

  it('decides what is live from the update time and its own clock, as a cached answer ages', () => {
    const passes = [
      bus(20, { updated: NOW - 5 * MIN }),
      bus(22, { updated: NOW - 16 * MIN }),
      bus(24, { updated: NOW + 1 * MIN }),
      bus(26, { updated: NOW + 5 * MIN }),
      bus(28, { updated: NOW - MIN, status: 'PLANNED' }),
      // Without an update time, the flag of the Worker stands.
      bus(30),
      bus(32, { live: false }),
    ];
    const live = (now) => buses(ok(busData({ passes })), EHAM, now).passes.map((p) => p.live);
    expect(live(NOW)).toEqual([true, false, true, false, false, true, false]);
    // Eleven minutes on, the first is 16 minutes old and the third 10, and the fourth is no longer ahead.
    expect(live(NOW + 11 * MIN)).toEqual([false, false, true, true, false, true, false]);
  });

  it('is delayed when several are, or two are very late', () => {
    expect(fact([bus(1, { delayMin: 6 }), bus(2, { delayMin: 7 }), bus(3, { delayMin: 9 }), bus(4), bus(5)])).toMatchObject({ text: 'Buses delayed, up to 9 min', status: 'caution' });
    expect(fact([bus(1, { delayMin: 16 }), bus(2, { delayMin: 20 }), ...run(8)])).toMatchObject({ status: 'caution' });
    // One late bus among many is not a delay, and a few late among very many is not either.
    expect(fact([bus(1, { delayMin: 9 }), ...run(6)]).status).toBe('ok');
    expect(fact([bus(1, { delayMin: 6 }), bus(2, { delayMin: 6 }), bus(3, { delayMin: 6 }), ...run(12)]).status).toBe('ok');
  });

  it('does not let reported cancellations change it', () => {
    const cancelled = run(6, { cancelled: true, status: 'CANCEL' });
    expect(fact([...run(5), ...cancelled])).toMatchObject({ text: 'Buses on time', status: 'ok' });
    expect(fact(cancelled)).toMatchObject({ text: 'No buses listed', status: 'unknown' });
  });

  it('gives a real answer a fact that is not green by default', () => {
    const f = busesFact(buses(ok(busData())));
    expect(['ok', 'caution', 'unknown']).toContain(f.status);
    expect(f.text).toMatch(/^(Buses|Bus times|No)/);
  });
});

// ---- Together ----

describe('the one fact for the summary', () => {
  const roads = { text: 'Roads flowing', status: 'ok', asOf: NOW - 90_000 };
  const jam = { text: 'A4 jam 6 km, +12 min', status: 'caution', asOf: NOW - 60_000 };

  it('says what needs attention first and nothing else', () => {
    const disrupted = { text: 'Trains disrupted', status: 'caution', asOf: NOW - 30_000 };
    expect(combineAccessFacts([roads, disrupted, { text: 'Buses on time', status: 'ok', asOf: NOW }])).toEqual({ text: 'Trains disrupted', status: 'caution', asOf: NOW - 30_000 });
    expect(combineAccessFacts([jam, disrupted, roads])).toEqual({ text: 'A4 jam 6 km, +12 min; Trains disrupted', status: 'caution', asOf: NOW - 60_000 });
  });

  it('is green only when everything that has data is fine, and names it', () => {
    expect(combineAccessFacts([roads, null, { text: 'Buses on time', status: 'ok', asOf: NOW }])).toEqual({ text: 'Roads flowing; Buses on time', status: 'ok', asOf: NOW - 90_000 });
    expect(combineAccessFacts([roads])).toEqual(roads);
  });

  it('is grey, with what is known, when a source failed or has old data: never green from missing data', () => {
    const lost = { text: 'Bus data unavailable', status: 'unknown' };
    expect(combineAccessFacts([roads, null, lost])).toEqual({ text: 'Bus data unavailable; Roads flowing', status: 'unknown', asOf: NOW - 90_000 });
    expect(combineAccessFacts([{ text: 'Loading road data', status: 'unknown' }, null, null])).toEqual({ text: 'Loading road data', status: 'unknown' });
  });

  it('is nothing when no source has anything to say', () => {
    expect(combineAccessFacts([null, null, undefined])).toBeNull();
    expect(combineAccessFacts([])).toBeNull();
  });

  it('is the roads fact alone where the airport has no train or bus data', () => {
    const data = analyseSources({ airport: EHRD, now: NOW, results: { roads: { state: 'unavailable', reason: 'x' } } });
    expect(data.trains).toEqual({ covered: false });
    expect(accessFactAll(data)).toEqual({ text: 'No road data', status: 'unknown' });
    expect(accessFactAll({ covered: false })).toBeNull();
  });

  it('puts the trains and buses with the roads for Schiphol, and the train key missing is quiet', () => {
    const data = analyseSources({
      airport: EHAM,
      now: NOW,
      results: { roads: { state: 'unavailable', reason: 'The relay is off' }, trains: { state: 'unavailable', reason: 'needs an NS API key' }, buses: ok(busData({ passes: Array.from({ length: 5 }, (_, i) => bus(i + 1)) })) },
    });
    expect(accessFactAll(data)).toEqual({ text: 'No road data; Buses on time', status: 'unknown', asOf: NOW - 20_000 });
  });
});

// ---- The sections ----

describe('the trains in the section', () => {
  const html = (result) => trainsHtml(analyseSources({ airport: EHAM, now: NOW, results: { roads: { state: 'unavailable', reason: 'x' }, trains: result } }));

  it('say that a key is needed, calmly, and do not call it an error', () => {
    const out = html({ state: 'unavailable', reason: 'needs an NS API key' });
    expect(out).toContain('Train information needs an NS API key (set NS_API_KEY for the API).');
    expect(NO_KEY_TEXT).toBe('Train information needs an NS API key (set NS_API_KEY for the API).');
    expect(out).not.toContain('access-old');
    expect(html({ state: 'unavailable', reason: 'The NS is off' })).toContain('No train information right now. The NS is off.');
  });

  it('say they are loading, and that they did not load, with the source', () => {
    expect(html(null)).toContain('Loading train times');
    const failed = html({ state: 'error', error: '<b>x</b>' });
    expect(failed).toContain('did not load (&lt;b&gt;x&lt;/b&gt;)');
    expect(failed).toContain(TRAINS_SOURCE_TEXT);
  });

  it('list the departures with time, destination, track, delay and cancellation, and the source', () => {
    const out = html(ok(trainData({ departures: [train(4), train(8, { delayMin: 4, track: '5', plannedTrack: '4', destination: 'Eindhoven Centraal', kind: 'IC' }), train(12, { cancelled: true, destination: 'Utrecht Centraal' })] })));
    expect(out).toContain('<b>Amsterdam Centraal</b>');
    expect(out).toContain('22:03');
    expect(out).toContain('track 5 (was 4)');
    expect(out).toContain('+4 min');
    expect(out).toContain('<s>22:11</s>');
    expect(out).toContain('Cancelled');
    expect(out).toContain('Next departures from Schiphol Airport');
    expect(out).toContain(TRAINS_SOURCE_TEXT);
  });

  it('say what is disrupted, and what is not known', () => {
    const disrupted = html(ok(trainData({ disruptions: [{ kind: 'disruption', title: 'Amsterdam Zuid - Schiphol Airport: no trains', cause: 'a broken-down train', end: NOW + 90 * MIN }, { kind: 'maintenance', title: 'Works <b>' }] })));
    expect(disrupted).toContain('Amsterdam Zuid - Schiphol Airport: no trains');
    expect(disrupted).toContain('a broken-down train, until 23:29');
    expect(disrupted).toContain('Works &lt;b&gt;');
    expect(html(ok(trainData()))).toContain('No disruptions reported');
    const unknown = html(ok(trainData({ disruptions: null })));
    expect(unknown).toContain('The disruptions could not be read');
    expect(unknown).not.toContain('No disruptions reported');
  });

  it('say when the data is old or the last answer, and never show old data as the present', () => {
    expect(html(ok(trainData({ fetched: NOW - 20 * MIN })))).toContain('The newest train data is 20 min old');
    expect(html(ok(trainData({ stale: true, fetched: NOW - 200_000 })))).toContain('showing its last answer, 3 min old');
    expect(html({ state: 'ok', data: trainData(), problem: 'it took too long' })).toContain('The last update failed (it took too long)');
  });

  it('say there is nothing yet for an airport without trains, and nothing where there is no analysis', () => {
    const rd = analyseSources({ airport: EHRD, now: NOW, results: {} });
    expect(trainsHtml(rd)).toContain('No train or bus data for this airport yet.');
    expect(busesHtml(rd)).toBe('');
    expect(trainsHtml({})).toBe('');
    expect(busesHtml({})).toBe('');
  });
});

describe('the buses in the section', () => {
  const html = (result) => busesHtml(analyseSources({ airport: EHAM, now: NOW, results: { roads: { state: 'unavailable', reason: 'x' }, buses: result } }));

  it('say they are loading and that they did not load', () => {
    expect(html(null)).toContain('Loading bus times');
    expect(html({ state: 'error', error: 'answered 502' })).toContain('Bus times did not load (answered 502)');
  });

  it('list the next buses per line with the delay, and what the times mean', () => {
    const out = html(ok(busData()));
    expect(out).toContain('<span class="access-badge access-line">300</span>');
    expect(out).toContain('Haarlem Station');
    expect(out).toContain('Times are Amsterdam time');
    expect(out).toContain(BUSES_SOURCE_TEXT);
    expect(out).toMatch(/\d+ buses due in the next hour/);
  });

  it('show an expected time with its delay in minutes, and a scheduled one as scheduled', () => {
    const out = html(ok(busData({ passes: [bus(3, { delayMin: 7, planned: NOW + 3 * MIN - 7 * MIN }), bus(10, { status: 'PLANNED', live: false }), bus(12)] })));
    expect(out).toContain('22:02 <span class="access-late">+7</span>');
    expect(out).toContain('<span class="access-sched">22:09</span>');
    expect(out).toContain('3 buses due in the next hour; 2 with live times, 1 of them 5 minutes or more late, up to 7 min');
  });

  it('word cancellations as reported, and keep them out of the times', () => {
    const out = html(ok(busData({ passes: [bus(2), bus(4), bus(6, { cancelled: true, status: 'CANCEL', line: '300', destination: 'Haarlem Station' })] })));
    expect(out).toContain('The bus feed reports 1 bus as cancelled in this hour (line 300)');
    expect(out).toContain('often wrong');
    // The line with nothing but a reported cancellation has no row of times.
    expect(out).not.toContain('Haarlem Station');
    const two = html(ok(busData({ passes: [bus(2), bus(4), bus(6, { cancelled: true, status: 'CANCEL', line: '300' }), bus(8, { cancelled: true, status: 'CANCEL', line: '181' })] })));
    expect(two).toContain('reports 2 buses as cancelled in this hour (lines 181, 300)');
    expect(html(ok(busData({ passes: [bus(2), bus(4)] })))).not.toContain('reports');
  });

  it('do not claim they are on time without live times', () => {
    const out = html(ok(busData({ passes: [bus(2, { status: 'PLANNED', live: false }), bus(4, { status: 'PLANNED', live: false })] })));
    expect(out).toContain('too few with live times to say whether they are late');
    expect(out).not.toContain('none late');
  });

  it('show a DRIVING bus without a recent update as scheduled, with no delay', () => {
    const out = html(ok(busData({ passes: [stale(3, { delayMin: 9, planned: NOW + 3 * MIN - 9 * MIN }), bus(10), bus(12), bus(14)] })));
    expect(out).toContain('<span class="access-sched">21:53</span>');
    expect(out).not.toContain('+9');
    expect(out).toContain('<span class="access-live">22:09</span>');
    expect(out).toContain('4 buses due in the next hour; 3 with live times, none of them late');
  });

  it('say lateness of the live buses only, even when too few are live to call the rest on time', () => {
    const out = html(ok(busData({ passes: [bus(2, { delayMin: 6 }), stale(4), stale(6), stale(8)] })));
    expect(out).toContain('4 buses due in the next hour; 1 with live times, 1 of them 5 minutes or more late, up to 6 min.');
    expect(busesFact(buses(ok(busData({ passes: [bus(2, { delayMin: 6 }), stale(4), stale(6), stale(8)] }))))).toMatchObject({ text: 'Bus times mostly scheduled, little live data' });
  });

  it('say 1 bus, not the first 1, when the cut-short list holds one', () => {
    expect(html(ok(busData({ passes: [bus(5)], capped: true })))).toContain('Showing 1 bus (to 22:04), too few with live times');
  });

  it('do not say how many are due in the next hour when the list was cut short', () => {
    const passes = Array.from({ length: 6 }, (_, i) => bus(i * 8 + 1));
    const out = html(ok(busData({ passes, capped: true })));
    expect(out).toContain('Showing the first 6 buses (to 22:40), none late.');
    expect(out).not.toMatch(/buses due in the next hour/);
    expect(html(ok(busData({ passes })))).toContain('6 buses due in the next hour, none late');
  });

  it('say none are listed when there are none, and mark old data', () => {
    expect(html(ok(busData({ passes: [] })))).toContain('No buses listed for the terminal in the next hour.');
    expect(html(ok(busData({ fetched: NOW - 15 * MIN })))).toContain('The newest bus data is 15 min old');
  });
});

describe('the whole section', () => {
  it('has the roads, trains and buses in that order, each with its heading', () => {
    const data = analyseSources({ airport: EHAM, now: NOW, results: { roads: null, trains: { state: 'unavailable', reason: 'needs an NS API key' }, buses: ok(busData()) } });
    const body = accessBodyHtml(data);
    const order = ['data-access="roads"', 'data-access="trains"', 'data-access="buses"'].map((m) => body.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(body).toContain('<h4 class="access-title">Roads</h4>');
    expect(body).toContain('Loading road data');
    expect(body).toContain('Train information needs an NS API key');
    expect(body).toContain('Haarlem Station');
  });

  it('keeps the trains and buses when the road data fails, and the roads when theirs do', () => {
    const roadsFailed = accessBodyHtml(analyseSources({ airport: EHAM, now: NOW, results: { roads: { state: 'error', error: 'down' }, buses: ok(busData()) } }));
    expect(roadsFailed).toContain('Road data did not load (down)');
    expect(roadsFailed).toContain('Haarlem Station');
    const busesFailed = accessBodyHtml(analyseSources({ airport: EHAM, now: NOW, results: { buses: { state: 'error', error: 'down' } } }));
    expect(busesFailed).toContain('Loading road data');
    expect(busesFailed).toContain('Bus times did not load (down)');
  });

  it('says only the roads for another Dutch airport, with the line that there is no transit data yet', () => {
    const body = accessBodyHtml(analyseSources({ airport: EHRD, now: NOW, results: {} }));
    expect(body).toContain('data-access="roads"');
    expect(body).toContain('No train or bus data for this airport yet.');
    expect(body).not.toContain('data-access="buses"');
    expect(accessBodyHtml({ covered: false })).toContain('Road data only for Dutch airports for now');
  });
});
