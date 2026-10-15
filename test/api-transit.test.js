import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { ACCESS_TRANSIT_BACKUP_SECONDS, BUS_STOPS, TRAIN_STATIONS, amsterdamMs, compactDepartures, compactDisruptions, mergeBusPasses, route } from '../api/worker.js';
import { OVAPI_TPC } from './ovapi-fixtures.js';
import { NS_DEPARTURES, NS_DISRUPTIONS } from './ns-fixtures.js';

// 21:59:30 in Amsterdam (summer time), when the bus fixture was fetched.
const NOW = Date.parse('2026-10-14T19:59:30Z');
const KEY = { NS_API_KEY: 'secret-key' };
const reply = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), init);
const at = (path) => new URL(`https://api.example${path}`);
const fakeCache = () => {
  const entries = new Map();
  return { entries, match: async (request) => entries.get(request.url)?.clone(), put: async (request, response) => void entries.set(request.url, response) };
};
const nsFetch = () => vi.fn(async (url) => reply(String(url).includes('/v3/disruptions') ? NS_DISRUPTIONS : NS_DEPARTURES));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('local times of the bus feed', () => {
  it('are read as Amsterdam time, summer and winter', () => {
    expect(amsterdamMs('2026-10-14T21:52:00')).toBe(Date.parse('2026-10-14T19:52:00Z'));
    expect(amsterdamMs('2026-12-01T08:00:30')).toBe(Date.parse('2026-12-01T07:00:30Z'));
    expect(amsterdamMs('2026-10-25T00:30:00')).toBe(Date.parse('2026-10-24T22:30:00Z'));
    expect(amsterdamMs('2026-10-25T04:00:00')).toBe(Date.parse('2026-10-25T03:00:00Z'));
    expect(amsterdamMs('2026-03-29T04:00:00')).toBe(Date.parse('2026-03-29T02:00:00Z'));
    expect(amsterdamMs('2026-03-28T23:00:00')).toBe(Date.parse('2026-03-28T22:00:00Z'));
  });

  it('are null when there is none or it is not a time', () => {
    expect(amsterdamMs(undefined)).toBeNull();
    expect(amsterdamMs('soon')).toBeNull();
  });
});

describe('GET /access/trains', () => {
  it('says it needs an NS API key, as an answer, without asking NS', async () => {
    const fetchFn = vi.fn();
    for (const env of [{}, { NS_API_KEY: '' }]) {
      const res = await route(at('/access/trains?airport=EHAM'), env, fetchFn);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ available: false, airport: 'EHAM', reason: 'needs an NS API key' });
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('wants an ICAO code, and has a station for Schiphol only', async () => {
    expect(Object.keys(TRAIN_STATIONS)).toEqual(['EHAM']);
    const fetchFn = vi.fn();
    for (const query of ['', 'airport=EH', 'airport=../x']) await expect(route(at(`/access/trains?${query}`), KEY, fetchFn)).rejects.toMatchObject({ status: 400 });
    for (const airport of ['EHRD', 'EHEH', 'EGLL']) await expect(route(at(`/access/trains?airport=${airport}`), KEY, fetchFn)).rejects.toMatchObject({ status: 404 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('asks NS for the station with the key in the header, and keeps what matters', async () => {
    const fetchFn = nsFetch();
    const res = await route(at('/access/trains?airport=eham'), KEY, fetchFn);
    const urls = fetchFn.mock.calls.map((c) => c[0]);
    expect(urls.find((u) => u.includes('/v2/departures'))).toContain('station=ASB');
    expect(urls.some((u) => u.startsWith('https://gateway.apiportal.ns.nl/reisinformatie-api/api/v3/disruptions'))).toBe(true);
    for (const call of fetchFn.mock.calls) expect(call[1].headers['Ocp-Apim-Subscription-Key']).toBe('secret-key');
    expect(urls.join(' ')).not.toContain('secret-key');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const body = await res.json();
    expect(body).toMatchObject({ available: true, airport: 'EHAM', source: 'NS', fetched: NOW });
    // The train that left half an hour ago is gone; the cancelled one stays.
    expect(body.departures.map((d) => d.destination)).toEqual(['Amsterdam Centraal', 'Eindhoven Centraal', 'Utrecht Centraal']);
    expect(body.departures[0]).toEqual({ planned: Date.parse('2026-10-14T20:04:00Z'), actual: Date.parse('2026-10-14T20:04:00Z'), delayMin: 0, destination: 'Amsterdam Centraal', track: '1', plannedTrack: '1', cancelled: false, kind: 'SPR' });
    expect(body.departures[1]).toMatchObject({ delayMin: 4, track: '5', plannedTrack: '4', kind: 'IC' });
    expect(body.departures[2]).toMatchObject({ cancelled: true, delayMin: 0, track: '3' });
    // The disruption through the station, and the works at it; not the other line's, not the ended one.
    expect(body.disruptions.map((d) => [d.id, d.kind])).toEqual([['11111', 'disruption'], ['33333', 'maintenance']]);
    expect(body.disruptions[0]).toMatchObject({ title: 'Amsterdam Zuid - Schiphol Airport: no trains', cause: 'a broken-down train', end: Date.parse('2026-10-14T21:30:00Z') });
  });

  it('keeps the disruptions for two minutes apart from the departures', async () => {
    const cache = fakeCache();
    const fetchFn = nsFetch();
    await route(at('/access/trains?airport=EHAM'), KEY, fetchFn, cache);
    const kept = [...cache.entries.values()];
    expect(kept).toHaveLength(1);
    expect(kept[0].headers.get('Cache-Control')).toBe('public, max-age=120');
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const again = await route(at('/access/trains?airport=EHAM'), KEY, fetchFn, cache);
    // Only the departures were asked for again.
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect((await again.json()).disruptions).toHaveLength(2);
  });

  it('gives disruptions as null, not as none, when they cannot be had, and still gives the departures', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = vi.fn(async (url) => (String(url).includes('/v3/disruptions') ? reply('no', { status: 500 }) : reply(NS_DEPARTURES)));
    const body = await (await route(at('/access/trains?airport=EHAM'), KEY, fetchFn)).json();
    expect(body.disruptions).toBeNull();
    expect(body.departures).toHaveLength(3);
    const weird = vi.fn(async (url) => reply(String(url).includes('/v3/disruptions') ? { unexpected: true } : NS_DEPARTURES));
    expect((await (await route(at('/access/trains?airport=EHAM'), KEY, weird)).json()).disruptions).toBeNull();
  });

  it('fails, so that a backup can be served, when NS refuses or answers something else', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(route(at('/access/trains?airport=EHAM'), KEY, async () => reply('denied', { status: 401 }))).rejects.toMatchObject({ status: 502, message: expect.stringContaining('answered 401') });
    await expect(route(at('/access/trains?airport=EHAM'), KEY, async (url) => reply(String(url).includes('disruptions') ? [] : { payload: {} }))).rejects.toMatchObject({ status: 502, message: expect.stringContaining('without departures') });
    await expect(route(at('/access/trains?airport=EHAM'), KEY, async () => Promise.reject(new Error('down')))).rejects.toMatchObject({ status: 502 });
  });

  it('reads departures and disruptions defensively', () => {
    expect(compactDepartures(null)).toBeNull();
    expect(compactDepartures({ payload: { departures: 'x' } })).toBeNull();
    expect(compactDepartures({ payload: { departures: [{}, { plannedDateTime: 'x' }, null] } }, NOW)).toEqual([]);
    const bare = compactDepartures({ departures: [{ plannedDateTime: '2026-10-14T22:30:00+02:00' }] }, NOW);
    expect(bare).toEqual([{ planned: Date.parse('2026-10-14T20:30:00Z'), actual: Date.parse('2026-10-14T20:30:00Z'), delayMin: 0, destination: null, track: null, plannedTrack: null, cancelled: false, kind: null }]);
    const station = TRAIN_STATIONS.EHAM;
    expect(compactDisruptions({}, station)).toBeNull();
    expect(compactDisruptions([null, {}, { title: 'Only a title' }], station)).toEqual([]);
    expect(compactDisruptions({ payload: NS_DISRUPTIONS }, station)).toHaveLength(2);
    // A disruption that does not say whether it is active is taken as active.
    expect(compactDisruptions([{ id: 'x', type: 'DISRUPTION', title: 'Schiphol Airport closed', publicationSections: [] }], station)).toHaveLength(1);
  });
});

// A pass in the shape of OVapi's.
const pass = (over = {}) => ({
  LinePublicNumber: '397',
  DestinationName50: 'AMS Elandsgracht',
  OperatorCode: 'CXX',
  DataOwnerCode: 'NL',
  LinePlanningNumber: 'M397',
  OperationDate: '2026-10-14',
  JourneyNumber: 9137,
  TripStopStatus: 'DRIVING',
  JourneyStopType: 'INTERMEDIATE',
  TargetDepartureTime: '2026-10-14T22:07:00',
  ExpectedDepartureTime: '2026-10-14T22:09:00',
  UserStopCode: '57330020',
  ...over,
});
const stopWith = (code, passes) => ({ [code]: { Stop: { TimingPointCode: code, TimingPointName: 'Schiphol, Airport' }, Passes: Object.fromEntries(passes.map((p, i) => [`k${i}`, p])) } });

describe('merging the passes of the bus stops', () => {
  it('reads a real answer: the next hour in expected order, in UTC, with delays', () => {
    const list = mergeBusPasses([OVAPI_TPC], NOW);
    expect(list.length).toBeGreaterThan(15);
    expect(list.map((p) => p.expected)).toEqual([...list.map((p) => p.expected)].sort((a, b) => a - b));
    for (const p of list) {
      expect(p.expected).toBeGreaterThanOrEqual(NOW - 60_000);
      expect(Math.min(p.planned, p.expected)).toBeLessThanOrEqual(NOW + 3_600_000);
      expect(p.delayMin).toBeGreaterThanOrEqual(0);
      expect(p.line).toMatch(/^\d+$/);
    }
    expect(list.some((p) => p.delayMin > 0)).toBe(true);
    expect(list.every((p) => p.status !== 'PASSED')).toBe(true);
  });

  it('computes the delay from scheduled against expected, in whole minutes, and never below zero', () => {
    const list = mergeBusPasses(
      [
        stopWith('a', [
          pass({ TargetDepartureTime: '2026-10-14T22:07:00', ExpectedDepartureTime: '2026-10-14T22:12:40', JourneyNumber: 1 }),
          pass({ TargetDepartureTime: '2026-10-14T22:10:00', ExpectedDepartureTime: '2026-10-14T22:08:00', JourneyNumber: 2 }),
          pass({ TargetDepartureTime: '2026-10-14T22:15:00', ExpectedDepartureTime: '2026-10-14T22:15:20', JourneyNumber: 3 }),
        ]),
      ],
      NOW,
    );
    const [late, early, near] = list.sort((a, b) => a.planned - b.planned).map((p) => p);
    expect([late.delayMin, early.delayMin, near.delayMin]).toEqual([6, 0, 0]);
    expect(late.planned).toBe(Date.parse('2026-10-14T20:07:00Z'));
    expect(late.expected).toBe(Date.parse('2026-10-14T20:12:40Z'));
  });

  it('takes the arrival times when a pass has no departure times', () => {
    const [p] = mergeBusPasses([stopWith('a', [pass({ TargetDepartureTime: undefined, ExpectedDepartureTime: undefined, TargetArrivalTime: '2026-10-14T22:07:00', ExpectedArrivalTime: '2026-10-14T22:10:00' })])], NOW);
    expect(p.delayMin).toBe(3);
  });

  it('counts a cancellation only when the trip is not also reported running, at this stop or another', () => {
    const body = {
      ...stopWith('a', [
        pass({ JourneyNumber: 1, TripStopStatus: 'CANCEL' }),
        pass({ JourneyNumber: 2, TripStopStatus: 'CANCEL', UserStopCode: 'x2' }),
        pass({ JourneyNumber: 3, TripStopStatus: 'CANCEL', UserStopCode: 'x3' }),
        pass({ JourneyNumber: 3, TripStopStatus: 'DRIVING', UserStopCode: 'x4' }),
      ]),
      ...stopWith('b', [pass({ JourneyNumber: 2, TripStopStatus: 'ARRIVED', UserStopCode: 'elsewhere' })]),
    };
    const list = mergeBusPasses([body], NOW);
    const flagged = list.filter((p) => p.status === 'CANCEL');
    expect(flagged).toHaveLength(3);
    // Trip 1 runs nowhere else: cancelled as far as is reported. Trips 2 and 3 are also reported arrived or
    // driving, so the flag is not believed.
    expect(flagged.filter((p) => p.cancelled)).toHaveLength(1);
    expect(flagged.filter((p) => p.contradicted)).toHaveLength(2);
  });

  it('does not take a cancelled bus for a late one', () => {
    const [p] = mergeBusPasses([stopWith('a', [pass({ TripStopStatus: 'CANCEL', ExpectedDepartureTime: '2026-10-14T22:30:00' })])], NOW);
    expect(p).toMatchObject({ delayMin: 0, cancelled: true });
  });

  it('leaves out buses that end their trip there, ones already gone, ones past the hour, and doubles', () => {
    const list = mergeBusPasses(
      [
        stopWith('a', [
          pass({ JourneyNumber: 1, JourneyStopType: 'LAST' }),
          pass({ JourneyNumber: 2, TripStopStatus: 'PASSED' }),
          pass({ JourneyNumber: 3, TargetDepartureTime: '2026-10-14T21:40:00', ExpectedDepartureTime: '2026-10-14T21:42:00' }),
          pass({ JourneyNumber: 4, TargetDepartureTime: '2026-10-14T23:30:00', ExpectedDepartureTime: '2026-10-14T23:30:00' }),
          pass({ JourneyNumber: 5 }),
        ]),
        stopWith('a', [pass({ JourneyNumber: 5 })]),
      ],
      NOW,
    );
    expect(list).toHaveLength(1);
  });

  it('counts a pass as live only when the feed updated it in the last 15 minutes', () => {
    // The destination names the pass, as the list is in the order of the times.
    const p = (n, over) => pass({ JourneyNumber: n, DestinationName50: `trip ${n}`, ...over });
    const list = mergeBusPasses(
      [
        stopWith('a', [
          // DRIVING since last night, with nothing heard from the bus for hours: schedule only.
          p(1, { LastUpdateTimeStamp: '2026-10-13T23:41:12' }),
          p(2, { LastUpdateTimeStamp: '2026-10-14T21:58:40' }),
          p(3, { LastUpdateTimeStamp: '2026-10-14T21:45:00' }),
          p(4, { LastUpdateTimeStamp: '2026-10-14T21:44:00' }),
          p(5, { TripStopStatus: 'ARRIVED', LastUpdateTimeStamp: '2026-10-14T21:59:00' }),
          p(6, { TripStopStatus: 'PLANNED', LastUpdateTimeStamp: '2026-10-14T21:59:00' }),
          p(7, { TripStopStatus: 'CANCEL', LastUpdateTimeStamp: '2026-10-14T21:59:00' }),
          p(8),
        ]),
      ],
      NOW,
    );
    const live = Object.fromEntries(list.map((x) => [x.destination, x.live]));
    expect(list).toHaveLength(8);
    expect(live).toEqual({ 'trip 1': false, 'trip 2': true, 'trip 3': true, 'trip 4': false, 'trip 5': true, 'trip 6': false, 'trip 7': false, 'trip 8': false });
  });

  it('reads stop areas too, and survives passes without times', () => {
    const area = { schuvw: stopWith('57330070', [pass({ JourneyNumber: 9 }), pass({ JourneyNumber: 10, TargetDepartureTime: undefined, TargetArrivalTime: undefined })]) };
    expect(mergeBusPasses([area, null, {}], NOW)).toHaveLength(1);
  });
});

describe('GET /access/buses', () => {
  it('asks OVapi for the terminal stops of the airport, over http, and answers the next hour', async () => {
    const fetchFn = vi.fn(async () => reply(OVAPI_TPC));
    const res = await route(at('/access/buses?airport=eham'), {}, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`http://v0.ovapi.nl/tpc/${BUS_STOPS.EHAM.stops.join(',')}`);
    expect(init.headers['User-Agent']).toContain('power-globe-api');
    expect(init.headers['Accept-Encoding']).toBe('gzip');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    const body = await res.json();
    expect(body).toMatchObject({ available: true, airport: 'EHAM', source: 'OVapi', fetched: NOW, windowMinutes: 60, partial: false, capped: false, cancellations: 'reported' });
    expect(body.passes.length).toBeGreaterThan(15);
    expect(body.cancellationsReported).toBe(body.passes.filter((p) => p.cancelled).length);
  });

  it('answers a whole busy hour, more than the old cap of 60, and says when the cap cut it short', async () => {
    const hour = (n) => stopWith('a', Array.from({ length: n }, (_, i) => pass({ JourneyNumber: i, TargetDepartureTime: `2026-10-14T22:${String(i % 59).padStart(2, '0')}:00`, ExpectedDepartureTime: `2026-10-14T22:${String(i % 59).padStart(2, '0')}:00` })));
    const ask = async (n) => (await route(at('/access/buses?airport=EHAM'), {}, async () => reply(hour(n)))).json();
    const busy = await ask(100);
    expect(busy.passes).toHaveLength(100);
    expect(busy.capped).toBe(false);
    const runaway = await ask(130);
    expect(runaway.passes).toHaveLength(120);
    expect(runaway.capped).toBe(true);
    // The list is the earliest 120, and ends before the window does.
    expect(runaway.passes.at(-1).expected).toBeLessThan(NOW + 3_600_000 - 60_000);
    expect(runaway.passes.map((x) => x.expected)).toEqual([...runaway.passes.map((x) => x.expected)].sort((a, b) => a - b));
    // Exactly the cap is not a cut.
    expect((await ask(120)).capped).toBe(false);
  });

  it('keeps the stop table to the terminal: no stop area away from it, and the empty one only as a stop', () => {
    expect(BUS_STOPS.EHAM.areas).toEqual([]);
    expect(BUS_STOPS.EHAM.stops).toContain('57330760');
    expect(Object.keys(OVAPI_TPC).sort()).toEqual([...BUS_STOPS.EHAM.stops].sort());
  });

  it('asks a stop area as well where the table has one, and answers if one of two requests fails', async () => {
    const was = BUS_STOPS.EHAM.areas;
    BUS_STOPS.EHAM.areas = ['schns'];
    try {
      const fetchFn = vi.fn(async (url) => (String(url).includes('/stopareacode/') ? reply('no', { status: 500 }) : reply(OVAPI_TPC)));
      const body = await (await route(at('/access/buses?airport=EHAM'), {}, fetchFn)).json();
      expect(fetchFn.mock.calls.map((c) => c[0])).toContain('http://v0.ovapi.nl/stopareacode/schns');
      expect(body.partial).toBe(true);
      expect(body.passes.length).toBeGreaterThan(15);
    } finally {
      BUS_STOPS.EHAM.areas = was;
    }
  });

  it('allows only the airports of the table, and wants an ICAO code', async () => {
    const fetchFn = vi.fn();
    for (const airport of ['EHRD', 'EGLL']) await expect(route(at(`/access/buses?airport=${airport}`), {}, fetchFn)).rejects.toMatchObject({ status: 404 });
    for (const query of ['', 'airport=E', 'airport=EHAM1']) await expect(route(at(`/access/buses?${query}`), {}, fetchFn)).rejects.toMatchObject({ status: 400 });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('fails when OVapi does, so that a backup can be served', async () => {
    await expect(route(at('/access/buses?airport=EHAM'), {}, async () => reply('x', { status: 503 }))).rejects.toMatchObject({ status: 502, message: expect.stringContaining('answered 503') });
    await expect(route(at('/access/buses?airport=EHAM'), {}, async () => Promise.reject(new Error('certificate')))).rejects.toMatchObject({ status: 502 });
    await expect(route(at('/access/buses?airport=EHAM'), {}, async () => reply('<html>', { status: 200 }))).rejects.toMatchObject({ status: 502 });
  });

  it('answers with no passes, not an error, when the stops have none', async () => {
    const body = await (await route(at('/access/buses?airport=EHAM'), {}, async () => reply({}))).json();
    expect(body).toMatchObject({ available: true, passes: [], cancellationsReported: 0 });
  });
});

describe('trains and buses in the edge cache', () => {
  const call = async (cache, path, env, pending) => {
    vi.stubGlobal('caches', { default: cache });
    const res = await worker.fetch(new Request(`https://api.example${path}`), env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return res;
  };

  it('shares one bus answer for 60 seconds per airport, whatever the case or other parameters', async () => {
    const cache = fakeCache();
    const fetchFn = vi.fn(async () => reply(OVAPI_TPC));
    vi.stubGlobal('fetch', fetchFn);
    const pending = [];
    for (const q of ['airport=EHAM', 'airport=eham', 'airport=EHAM&x=1', 'x=2&airport=eham&_=7']) expect((await call(cache, `/access/buses?${q}`, {}, pending)).status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect([...cache.entries.keys()].filter((k) => !k.includes('__backup'))).toEqual(['https://api.example/access/buses?airport=EHAM']);
  });

  it('serves the last bus answer as stale with its age when OVapi fails, for 5 minutes at most', async () => {
    expect(ACCESS_TRANSIT_BACKUP_SECONDS).toBe(300);
    const cache = fakeCache();
    const pending = [];
    vi.stubGlobal('fetch', vi.fn(async () => reply(OVAPI_TPC)));
    await call(cache, '/access/buses?airport=EHAM', {}, pending);
    expect([...cache.entries.keys()]).toContain('https://api.example/__backup/access/buses?airport=EHAM');
    cache.entries.delete('https://api.example/access/buses?airport=EHAM');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('down'))));
    vi.setSystemTime(NOW + 100_000);
    const stale = await call(cache, '/access/buses?airport=EHAM', {}, pending);
    expect(stale.status).toBe(200);
    expect(stale.headers.get('X-Power-Globe-Backup')).toBe('1');
    expect(await stale.json()).toMatchObject({ stale: true, ageSeconds: 100, available: true, airport: 'EHAM' });
    cache.entries.delete('https://api.example/access/buses?airport=EHAM');
    vi.setSystemTime(NOW + (ACCESS_TRANSIT_BACKUP_SECONDS + 5) * 1000);
    const old = await call(cache, '/access/buses?airport=EHAM', {}, pending);
    expect(old.status).toBe(502);
    expect(old.headers.get('X-Power-Globe-Backup')).toBeNull();
  });

  it('does the same for trains, and says no key without keeping it as a backup', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cache = fakeCache();
    const pending = [];
    const fetchFn = nsFetch();
    vi.stubGlobal('fetch', fetchFn);
    await call(cache, '/access/trains?airport=EHAM', KEY, pending);
    await call(cache, '/access/trains?airport=eham', KEY, pending);
    // One departures request and one disruptions request, for two visitors.
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect([...cache.entries.keys()]).toContain('https://api.example/__backup/access/trains?airport=EHAM');
    cache.entries.delete('https://api.example/access/trains?airport=EHAM');
    vi.stubGlobal('fetch', vi.fn(async () => reply('denied', { status: 401 })));
    vi.setSystemTime(NOW + 70_000);
    const stale = await call(cache, '/access/trains?airport=EHAM', KEY, pending);
    expect(await stale.json()).toMatchObject({ stale: true, ageSeconds: 70, source: 'NS' });

    const bare = fakeCache();
    const asked = vi.fn();
    vi.stubGlobal('fetch', asked);
    const res = await call(bare, '/access/trains?airport=EHAM', {}, []);
    expect(await res.json()).toMatchObject({ available: false, reason: 'needs an NS API key' });
    expect(res.headers.has('X-Power-Globe-Unavailable')).toBe(false);
    expect([...bare.entries.keys()]).toEqual(['https://api.example/access/trains?airport=EHAM']);
    expect(asked).not.toHaveBeenCalled();
  });

  it('lists the routes and whether the NS key is set', async () => {
    const info = await (await route(at('/'), KEY, vi.fn())).json();
    expect(info.routes).toEqual(expect.arrayContaining(['/access/trains?airport=', '/access/buses?airport=']));
    expect(info.trains).toBe('NS key set');
    expect((await (await route(at('/'), {}, vi.fn())).json()).trains).toBe('no key');
  });
});
