import { describe, expect, it } from 'vitest';
import { toAirport } from '../src/airports.js';
import {
  EVENT_MAX_AGE_MS,
  MAX_EVENTS,
  MAX_HISTORY_AIRCRAFT,
  MAX_POINTS,
  MAX_TRACKED,
  OpsTraffic,
  compass,
  routeHint,
  runwayEnds,
  statusFact,
  summaryLine,
  totalTurn,
} from '../src/opstraffic.js';

// Schiphol as the airport list has it (OurAirports data).
const EHAM = toAirport([
  'EHAM', 'AMS', 'Amsterdam Airport Schiphol', 'Amsterdam', 'NL', 52.3086, 4.7639, -11, 1, 1,
  [
    ['18R', 183, '36L', 3, 12467, 'ASP', 198, 52.3627, 4.71193, 52.3286, 4.70884],
    ['09', 87, '27', 267, 11329, 'ASP', 148, 52.3166, 4.74635, 52.3184, 4.79689],
    ['06', 58, '24', 238, 11283, 'ASP', 148, 52.2879, 4.73402, 52.3046, 4.77752],
    ['18L', 183, '36R', 3, 11155, 'ASP', 148, 52.3213, 4.77996, 52.2908, 4.77735],
    ['18C', 183, '36C', 3, 10826, 'ASP', 148, 52.3314, 4.74003, 52.3018, 4.7375],
    ['04', 41, '22', 221, 6627, 'ASP', 148, 52.3004, 4.78348, 52.314, 4.80302],
  ],
  248,
]);
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60_000;
const FT_PER_NM = 6076.12;
const RAD = Math.PI / 180;

// A point `nm` miles from `p` along `bearing` (flat earth, as good as the tests need).
const away = (p, bearing, nm) => ({
  lat: p.lat + (nm * Math.cos(bearing * RAD)) / 60,
  lng: p.lng + (nm * Math.sin(bearing * RAD)) / (60 * Math.cos(p.lat * RAD)),
});
const bearingTo = (a, b) => {
  const x = (b.lng - a.lng) * Math.cos(a.lat * RAD);
  const y = b.lat - a.lat;
  return (((Math.atan2(x, y) / RAD) % 360) + 360) % 360;
};

// A flight second by second: [{ seconds, turn (degrees per second, right is positive), vs (feet
// per minute) }, ...] from a start. States are { lat, lng, trk, alt, vs, gs }.
function fly({ from, trk, gs, alt, plan }) {
  const out = [];
  let [x, y, h, a] = [0, 0, trk, alt];
  const at = () => ({ lat: from.lat + y / 60, lng: from.lng + x / (60 * Math.cos(from.lat * RAD)), trk: (((h % 360) + 360) % 360), alt: a, gs });
  for (const { seconds, turn = 0, vs = 0 } of plan) {
    for (let s = 0; s < seconds; s++) {
      out.push({ ...at(), vs });
      h += turn;
      x += (Math.sin(h * RAD) * gs) / 3600;
      y += (Math.cos(h * RAD) * gs) / 3600;
      a += vs / 60;
    }
  }
  return out;
}

const repeat = (n, plan) => Array.from({ length: n }, () => plan).flat();
// A racetrack at 3 degrees a second, one minute straight, one minute turning, twice.
const racetrack = (laps) => repeat(laps, [{ seconds: 60 }, { seconds: 60, turn: 3 }, { seconds: 60 }, { seconds: 60, turn: 3 }]);

// A flight as a function of the seconds since T0, for drive().
function flight(states, { id, startSec = 0, noTrack = false, ...extra }) {
  return (sec) => {
    const s = states[sec - startSec];
    if (!s) return null;
    return {
      id,
      callsign: id.toUpperCase(),
      type: 'B738',
      category: 'Large aircraft',
      lat: s.lat,
      lng: s.lng,
      altitudeFt: s.alt,
      onGround: false,
      speedKt: s.gs,
      track: noTrack ? null : s.trk,
      verticalFpm: s.vs,
      military: false,
      ...extra,
    };
  };
}

// Feeds the flights to a monitor every `every` seconds up to `seconds`, and returns the report.
function drive(monitor, flights, { seconds, every = 15, area = null, from = 0, hints = null } = {}) {
  for (let sec = from; sec <= seconds; sec += every) {
    const list = flights.map((f) => f(sec)).filter(Boolean).map((a) => ({ ...a, seen: T0 + sec * 1000 }));
    monitor.update(list, { now: T0 + sec * 1000, area, hints });
  }
  return monitor.report(T0 + seconds * 1000);
}

// A final approach to a runway end: from 8 miles out on a 3 degree path at 140 knots, then the
// roll-out, then standing on the ground.
function approach(airport, ident, { id, touchdownSec, vsSign = 1 }) {
  const end = runwayEnds(airport).find((e) => e.ident === ident);
  const speed = 140;
  const start = touchdownSec - Math.round((8 / speed) * 3600);
  return (sec) => {
    if (sec < start) return null;
    const miles = 8 - ((sec - start) * speed) / 3600;
    const onGround = miles <= 0;
    const rolled = onGround ? Math.min(-miles, (end.lengthNm * 2) / 3) : 0;
    const p = away(end.thr, onGround ? end.heading : (end.heading + 180) % 360, onGround ? rolled : miles);
    return {
      id,
      callsign: id.toUpperCase(),
      type: 'A320',
      category: 'Large aircraft',
      ...p,
      altitudeFt: onGround ? -11 : airport.elevationFt + 50 + miles * 318,
      onGround,
      speedKt: onGround ? Math.max(0, 80 - rolled * 60) : speed,
      track: end.heading,
      verticalFpm: onGround ? 0 : -Math.round((speed / 60) * 318) * vsSign,
      military: false,
    };
  };
}

// A take-off from a runway end: standing 20 s, rolling for 30 s, then climbing out.
function takeoff(airport, ident, { id, startSec, after = [] }) {
  const end = runwayEnds(airport).find((e) => e.ident === ident);
  const out = fly({ from: away(end.thr, end.heading, 0.625), trk: end.heading, gs: 160, alt: airport.elevationFt, plan: after.length ? after : [{ seconds: 600, vs: 2500 }] });
  return (sec) => {
    const t = sec - startSec;
    if (t < 0) return null;
    const base = { id, callsign: id.toUpperCase(), type: 'A320', category: 'Large aircraft', military: false };
    if (t < 20) return { ...base, ...end.thr, altitudeFt: -11, onGround: true, speedKt: 0, track: end.heading, verticalFpm: 0 };
    if (t < 50) {
      const rolled = (0.625 * (t - 20) ** 2) / 900;
      return { ...base, ...away(end.thr, end.heading, rolled), altitudeFt: -11, onGround: true, speedKt: ((t - 20) / 30) * 150, track: end.heading, verticalFpm: 0 };
    }
    const s = out[t - 50];
    return s ? { ...base, lat: s.lat, lng: s.lng, altitudeFt: s.alt, onGround: false, speedKt: s.gs, track: s.trk, verticalFpm: s.vs } : null;
  };
}

const level = (from, brg, miles, extra = {}) => {
  const p = away(from, brg, miles);
  return { id: 'x1', callsign: 'X1', type: 'B738', category: 'Large aircraft', ...p, altitudeFt: 10_000, onGround: false, speedKt: 280, track: (brg + 180) % 360, verticalFpm: -1500, military: false, seen: T0, ...extra };
};

describe('inbound', () => {
  it('lists a straight-in arrival with an ETA from distance and ground speed, and counts by half hour', () => {
    const ops = new OpsTraffic(EHAM);
    ops.update(
      [
        level(EHAM, 100, 100, { id: 'a1', callsign: 'KLM1' }),
        level(EHAM, 40, 150, { id: 'a2', callsign: 'BAW2', altitudeFt: 36_000, speedKt: 450, verticalFpm: -2500 }),
        level(EHAM, 250, 190, { id: 'a3', callsign: 'DLH3', speedKt: 250 }),
      ],
      { now: T0 },
    );
    const { inbound } = ops.report(T0);
    expect(inbound.list.map((a) => a.callsign)).toEqual(['BAW2', 'KLM1', 'DLH3']);
    // 100 miles at 280 knots is 21 minutes and a bit.
    expect(inbound.list.map((a) => a.etaMin)).toEqual([20, 22, 46]);
    expect(inbound.within30).toBe(2);
    expect(inbound.between30and60).toBe(1);
    expect(inbound.list[1]).toMatchObject({ distanceNm: 100, altitudeFt: 10_000, type: 'B738', route: false });
  });

  it('does not list an overflight at FL350, level, even straight at the airport', () => {
    const ops = new OpsTraffic(EHAM);
    ops.update(
      [
        level(EHAM, 100, 100, { id: 'o1', altitudeFt: 35_000, speedKt: 460, verticalFpm: 0 }),
        // Crossing the area at right angles, 20 miles to the side.
        { ...level(EHAM, 150, 60, { id: 'o2', altitudeFt: 35_000, speedKt: 460, verticalFpm: 0 }), track: 20 },
        // Descending, but the other way.
        level(EHAM, 100, 100, { id: 'o3', track: 100 }),
      ],
      { now: T0 },
    );
    expect(ops.report(T0).inbound.total).toBe(0);
    expect(ops.report(T0).status).toBe('No inbound traffic seen');
  });

  it('does not list a climbing departure heading out, aircraft on the ground or helicopters', () => {
    const ops = new OpsTraffic(EHAM);
    ops.update(
      [
        level(EHAM, 90, 20, { id: 'd1', altitudeFt: 6000, verticalFpm: 2500, track: 90 }),
        level(EHAM, 90, 10, { id: 'd2', altitudeFt: 3000, verticalFpm: -700, track: 270, speedKt: 160 }),
        level(EHAM, 90, 10, { id: 'd3', altitudeFt: 3000, verticalFpm: 2500, track: 270, speedKt: 160 }),
        level(EHAM, 90, 1, { id: 'g1', onGround: true, altitudeFt: 0, verticalFpm: 0, speedKt: 5 }),
        level(EHAM, 90, 30, { id: 'h1', category: 'Helicopter', altitudeFt: 2000, speedKt: 100, verticalFpm: -300 }),
        // Too high to land from this far: it would need about 100 miles for the height.
        level(EHAM, 90, 40, { id: 'h2', altitudeFt: 30_000, verticalFpm: -800 }),
      ],
      { now: T0 },
    );
    expect(ops.report(T0).inbound.list.map((a) => a.id)).toEqual(['d2']);
  });

  it('judges aircraft with no heading by the route database, or by their last two reports', () => {
    const ops = new OpsTraffic(EHAM);
    ops.update([level(EHAM, 100, 100, { id: 'n1', track: null })], { now: T0 });
    expect(ops.report(T0).inbound.total).toBe(0);
    // The same aircraft with the route database saying it goes here.
    ops.update([level(EHAM, 100, 100, { id: 'n1', track: null, seen: T0 + 1000 })], { now: T0 + 1000, hints: { n1: { origin: 'EGLL', destination: 'EHAM' } } });
    const [a] = ops.report(T0 + 1000).inbound.list;
    expect(a).toMatchObject({ id: 'n1', route: true, origin: 'EGLL' });

    // Without a hint, two reports give the direction.
    const other = new OpsTraffic(EHAM);
    const first = level(EHAM, 100, 100, { id: 'n2', track: null });
    const second = { ...first, ...away(first, bearingTo(first, EHAM), 1), seen: T0 + 12_000 };
    other.update([first], { now: T0 });
    other.update([second], { now: T0 + 12_000 });
    expect(other.report(T0 + 12_000).inbound.list.map((x) => x.id)).toEqual(['n2']);
  });

  it('uses the route database as a hint: a flight to this airport counts, one to another does not', () => {
    const ops = new OpsTraffic(EHAM);
    ops.update(
      [
        // Level at FL370 and a long way out: only the route says it is arriving.
        level(EHAM, 100, 150, { id: 'r1', altitudeFt: 37_000, speedKt: 450, verticalFpm: 0 }),
        // Looks inbound, but its route goes elsewhere.
        level(EHAM, 100, 80, { id: 'r2' }),
      ],
      { now: T0, hints: new Map([['r1', { origin: 'KJFK', destination: 'EHAM' }], ['r2', { origin: 'EGLL', destination: 'EDDF' }]]) },
    );
    expect(ops.report(T0).inbound.list.map((a) => [a.id, a.route])).toEqual([['r1', true]]);
  });

  it('builds a hint from a route that fits the aircraft', () => {
    const route = [
      { icao: 'EGLL', code: 'LHR', lat: 51.4706, lng: -0.4619 },
      { icao: 'EHAM', code: 'AMS', lat: 52.3086, lng: 4.7639 },
    ];
    const ac = { lat: 52.0, lng: 2.2, track: 70 };
    expect(routeHint(route, ac)).toEqual({ origin: 'EGLL', destination: 'EHAM' });
    expect(routeHint(route, { ...ac, track: 250 })).toBeNull();
  });
});

describe('holding', () => {
  const holdFrom = away(EHAM, 45, 40);

  it('finds a racetrack, with where and for how long', () => {
    const ops = new OpsTraffic(EHAM);
    const states = fly({ from: holdFrom, trk: 225, gs: 220, alt: 8000, plan: racetrack(4) });
    const { holding, status } = drive(ops, [flight(states, { id: 'h1' })], { seconds: 14 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } });
    expect(holding.count).toBe(1);
    const [h] = holding.list;
    expect(h).toMatchObject({ id: 'h1', direction: 'NE', altitudeFt: 8000 });
    expect(h.distanceNm).toBeGreaterThan(36);
    expect(h.distanceNm).toBeLessThan(44);
    expect(h.minutes).toBeGreaterThanOrEqual(13);
    expect(holding.stacks).toHaveLength(1);
    expect(status).toContain('1 holding');
  });

  it('finds a circular pattern, and one without any reported heading', () => {
    const states = fly({ from: holdFrom, trk: 0, gs: 200, alt: 11_000, plan: [{ seconds: 900, turn: -3 }] });
    const ops = new OpsTraffic(EHAM);
    expect(drive(ops, [flight(states, { id: 'c1' })], { seconds: 12 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } }).holding.count).toBe(1);
    const blind = new OpsTraffic(EHAM);
    const racetrackStates = fly({ from: holdFrom, trk: 225, gs: 220, alt: 8000, plan: racetrack(3) });
    const report = drive(blind, [flight(racetrackStates, { id: 'b1', noTrack: true })], { seconds: 11 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } });
    expect(report.holding.count).toBe(1);
  });

  it('counts the aircraft in a stack and keeps two stacks apart', () => {
    const ops = new OpsTraffic(EHAM);
    const near = away(holdFrom, 90, 2);
    const flights = [
      flight(fly({ from: holdFrom, trk: 225, gs: 220, alt: 8000, plan: racetrack(3) }), { id: 's1' }),
      flight(fly({ from: near, trk: 225, gs: 220, alt: 9000, plan: racetrack(3) }), { id: 's2' }),
      flight(fly({ from: away(EHAM, 225, 35), trk: 90, gs: 220, alt: 7000, plan: racetrack(3) }), { id: 's3' }),
    ];
    const { holding } = drive(ops, flights, { seconds: 11 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } });
    expect(holding.count).toBe(3);
    expect(holding.stacks.map((s) => [s.direction, s.count])).toEqual([['NE', 2], ['SW', 1]]);
    expect(holding.stacks[0]).toMatchObject({ minAltitudeFt: 8000, maxAltitudeFt: 9000 });
  });

  it('does not take a turn onto final for holding', () => {
    // Downwind, base and final at 3,000 to 1,500 feet: 180 degrees in all, and the same level.
    const ops = new OpsTraffic(EHAM);
    const plan = [{ seconds: 120, vs: -300 }, { seconds: 30, turn: 3, vs: -300 }, { seconds: 100, vs: -300 }, { seconds: 30, turn: 3, vs: -300 }, { seconds: 300, vs: -300 }];
    const states = fly({ from: away(EHAM, 75, 14), trk: 90, gs: 160, alt: 6000, plan });
    const report = drive(ops, [flight(states, { id: 'f1' })], { seconds: 10 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } });
    expect(report.holding.count).toBe(0);
    // And a long level turn of 270 degrees to join, at holding height, is still under the limit.
    const joining = new OpsTraffic(EHAM);
    const wide = fly({ from: holdFrom, trk: 0, gs: 220, alt: 9000, plan: [{ seconds: 120 }, { seconds: 90, turn: 3 }, { seconds: 400 }] });
    expect(drive(joining, [flight(wide, { id: 'f2' })], { seconds: 10 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } }).holding.count).toBe(0);
  });

  it('does not take a departure turning out for holding', () => {
    const ops = new OpsTraffic(EHAM);
    const plan = [{ seconds: 100, vs: 2500 }, { seconds: 90, turn: -3, vs: 2500 }, { seconds: 400, vs: 1500 }];
    const report = drive(ops, [takeoff(EHAM, '18C', { id: 't1', startSec: 0, after: plan })], { seconds: 12 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } });
    expect(report.holding.count).toBe(0);
  });

  it('does not take a helicopter or a slow aircraft circling for holding', () => {
    const ops = new OpsTraffic(EHAM);
    const circle = fly({ from: away(EHAM, 45, 15), trk: 0, gs: 100, alt: 4000, plan: [{ seconds: 900, turn: 3 }] });
    const slow = fly({ from: away(EHAM, 120, 15), trk: 0, gs: 110, alt: 5000, plan: [{ seconds: 900, turn: 3 }] });
    const light = fly({ from: away(EHAM, 200, 15), trk: 0, gs: 110, alt: 5000, plan: [{ seconds: 900, turn: 3 }] });
    const report = drive(
      ops,
      [
        flight(circle, { id: 'heli', category: 'Helicopter' }),
        flight(slow, { id: 'slow', category: '' }),
        flight(light, { id: 'cessna', category: 'Light aircraft' }),
      ],
      { seconds: 12 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } },
    );
    expect(report.holding.count).toBe(0);
  });

  it('does not take circuits low over the airport for holding', () => {
    const ops = new OpsTraffic(EHAM);
    const states = fly({ from: away(EHAM, 0, 3), trk: 90, gs: 110, alt: 1500, plan: repeat(4, [{ seconds: 60 }, { seconds: 60, turn: 3 }, { seconds: 60 }, { seconds: 60, turn: 3 }]) });
    expect(drive(ops, [flight(states, { id: 'p1', category: 'Small aircraft' })], { seconds: 12 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } }).holding.count).toBe(0);
  });

  it('sums the turn of a track', () => {
    const states = fly({ from: holdFrom, trk: 0, gs: 200, alt: 9000, plan: [{ seconds: 120, turn: 3 }] });
    const points = states.filter((_, i) => i % 15 === 0).map((s, i) => ({ t: i * 15_000, lat: s.lat, lng: s.lng, trk: s.trk }));
    expect(Math.round(totalTurn(points))).toBeGreaterThan(300);
    // A zigzag nets nothing.
    const zig = [0, 40, 0, 40, 0, 40, 0].map((trk, i) => ({ t: i * 15_000, lat: 52, lng: 4, trk }));
    expect(totalTurn(zig)).toBe(0);
  });
});

describe('movements and runways', () => {
  it('finds the runway ends of the airport, from its thresholds', () => {
    const ends = runwayEnds(EHAM);
    expect(ends).toHaveLength(12);
    expect(ends.find((e) => e.ident === '27')).toMatchObject({ heading: 267, thr: { lat: 52.3184, lng: 4.79689 } });
    // Without thresholds they are put half a runway from the airport.
    const bare = runwayEnds({ lat: 52, lng: 4, runways: [{ le: '09', leHeading: 90, he: '27', heHeading: 270, lengthFt: 6076.12, leEnd: null, heEnd: null }, { le: 'H1', leHeading: 0, he: '', heHeading: null }] });
    expect(bare.map((e) => e.ident)).toEqual(['09', '27']);
    expect(bare[0].thr.lng).toBeLessThan(4);
    expect(bare[1].thr.lng).toBeGreaterThan(4);
  });

  it('sees an arrival on runway 27 and a departure from 18C', () => {
    const ops = new OpsTraffic(EHAM);
    const report = drive(ops, [approach(EHAM, '27', { id: 'arr', touchdownSec: 240 }), takeoff(EHAM, '18C', { id: 'dep', startSec: 60 })], { seconds: 12 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } });
    expect(report.movements.arrivals.total).toBe(1);
    expect(report.movements.arrivals.runways[0]).toMatchObject({ ident: '27', count: 1, active: true });
    expect(report.movements.departures.total).toBe(1);
    expect(report.movements.departures.runways[0]).toMatchObject({ ident: '18C', count: 1 });
    expect(report.movements.arrivals.inUse).toEqual(['27']);
    expect(report.movements.departures.inUse).toEqual(['18C']);
    // The arrival is counted as it passes 1,000 feet, around two minutes before touchdown.
    expect(report.summary).toContain('Landing on 27');
    expect(report.summary).toContain('departing from 18C');
  });

  it('tells apart the ends of a two-runway airport and keeps when each was last seen', () => {
    const two = toAirport(['EHXX', 'XXX', 'Test', 'Test', 'NL', 52.0, 5.0, 0, 1, 1, [
      ['09', 90, '27', 270, 9000, 'ASP', 150, 52.0, 4.97, 52.0, 5.03],
      ['18', 180, '36', 0, 9000, 'ASP', 150, 52.02, 5.0, 51.98, 5.0],
    ], 0]);
    const ops = new OpsTraffic(two);
    const flights = [
      approach(two, '27', { id: 'a1', touchdownSec: 300 }),
      approach(two, '36', { id: 'a2', touchdownSec: 300 + 40 * 60 }),
      approach(two, '09', { id: 'a3', touchdownSec: 300 + 45 * 60 }),
    ];
    const report = drive(ops, flights, { seconds: 50 * 60, area: { lat: 52, lng: 5, nm: 120 } });
    const { arrivals } = report.movements;
    expect(arrivals.total).toBe(3);
    expect(arrivals.runways.map((r) => r.ident)).toEqual(['09', '36', '27']);
    expect(arrivals.runways.find((r) => r.ident === '27')).toMatchObject({ active: false, count: 1 });
    expect(arrivals.inUse).toEqual(['09', '36']);
    expect(arrivals.runways[0].ageMin).toBeLessThan(6);
  });

  it('does not count a go-around, nor an aircraft passing 1,000 feet away from the runway', () => {
    const ops = new OpsTraffic(EHAM);
    const final = approach(EHAM, '27', { id: 'ga', touchdownSec: 240 });
    // Climbs away again at 1,200 feet and goes up to 3,000.
    const goAround = (sec) => {
      const a = final(sec);
      if (!a || sec < 170) return a;
      return { ...a, altitudeFt: 1200 + (sec - 170) * 40, onGround: false, verticalFpm: 2400 };
    };
    // Descending through 1,000 feet three miles north of the runway.
    const beside = (sec) => (sec < 0 ? null : { ...approach(EHAM, '27', { id: 'side', touchdownSec: 240 })(sec), lat: 52.3184 + 3 / 60 });
    const report = drive(ops, [goAround, beside], { seconds: 6 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } });
    expect(report.movements.arrivals.total).toBe(0);
  });

  it('sees a landing and a take-off without any reported heading', () => {
    const ops = new OpsTraffic(EHAM);
    const noHeading = (f) => (sec) => {
      const a = f(sec);
      return a && { ...a, track: null };
    };
    const report = drive(ops, [noHeading(approach(EHAM, '09', { id: 'nh1', touchdownSec: 240 })), noHeading(takeoff(EHAM, '36R', { id: 'nh2', startSec: 30 }))], { seconds: 8 * 60, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } });
    expect(report.movements.arrivals.runways.map((r) => r.ident)).toEqual(['09']);
    expect(report.movements.departures.runways.map((r) => r.ident)).toEqual(['36R']);
  });

  it('counts an aircraft first seen climbing low along a runway as a departure', () => {
    const ops = new OpsTraffic(EHAM);
    const end = runwayEnds(EHAM).find((e) => e.ident === '24');
    const p = away(end.thr, end.heading, 2);
    ops.update([{ id: 'c1', callsign: 'C1', category: 'Large aircraft', ...p, altitudeFt: 900, onGround: false, speedKt: 170, track: 238, verticalFpm: 2500, seen: T0 }], { now: T0 });
    expect(ops.report(T0).movements.departures.runways[0]).toMatchObject({ ident: '24', count: 1 });
  });

  it('counts the arrivals and departures per hour, and says which hours are partial', () => {
    const ops = new OpsTraffic(EHAM);
    // Monitoring starts at 12:00; touchdowns at 12:25, 12:50, 13:05 and 13:40, a take-off at 12:30.
    const at = (h, m) => (h * 60 + m - 12 * 60) * 60;
    const flights = [
      approach(EHAM, '27', { id: 'p1', touchdownSec: at(12, 25) }),
      approach(EHAM, '27', { id: 'p2', touchdownSec: at(12, 50) }),
      approach(EHAM, '09', { id: 'p3', touchdownSec: at(13, 5) }),
      approach(EHAM, '27', { id: 'p4', touchdownSec: at(13, 40) }),
      takeoff(EHAM, '18C', { id: 'q1', startSec: at(12, 30) }),
    ];
    const report = drive(ops, flights, { seconds: at(13, 50), every: 30, area: { lat: EHAM.lat, lng: EHAM.lng, nm: 120 } });
    const { byHour, arrivals, departures } = report.movements;
    expect(byHour.map((h) => [new Date(h.hour).getUTCHours(), h.arrivals, h.departures])).toEqual([[12, 2, 1], [13, 2, 0]]);
    expect(byHour.map((h) => h.partial)).toEqual([false, true]);
    expect(arrivals.total).toBe(4);
    expect(departures.total).toBe(1);
    // The arrival of 12:50 was counted at 12:48, over an hour before 13:50.
    expect(arrivals.lastHour).toBe(2);
    expect(report.monitoredMs).toBe(110 * MIN);
    // 4 arrivals in 110 minutes.
    expect(arrivals.perHour).toBeCloseTo(2.2, 1);
    expect(report.coverage.notes.join(' ')).toContain('only cover the time this page has been open');
  });

  it('does not count time while the page was asleep as monitored', () => {
    const ops = new OpsTraffic(EHAM);
    ops.update([], { now: T0 });
    ops.update([], { now: T0 + MIN });
    ops.update([], { now: T0 + 30 * MIN });
    ops.update([], { now: T0 + 31 * MIN });
    expect(ops.report(T0 + 31 * MIN).monitoredMs).toBe(2 * MIN);
  });

  it('gives no per hour average until it has watched for half an hour', () => {
    const ops = new OpsTraffic(EHAM);
    const report = drive(ops, [approach(EHAM, '27', { id: 'pp', touchdownSec: 240 })], { seconds: 10 * 60 });
    expect(report.movements.arrivals.total).toBe(1);
    expect(report.movements.arrivals.perHour).toBeNull();
  });
});

describe('data limits', () => {
  const slow = (ops, area) => {
    // Aircraft near the airport reported once every five minutes, as the worldwide feed does.
    const states = fly({ from: away(EHAM, 45, 40), trk: 225, gs: 220, alt: 8000, plan: racetrack(5) });
    return drive(ops, [flight(states, { id: 'w1' })], { seconds: 20 * 60, every: 300, area });
  };

  it('says holding cannot be seen from the five minute feed', () => {
    const report = slow(new OpsTraffic(EHAM), null);
    expect(report.coverage.holdingReliable).toBe(false);
    expect(report.coverage.notes.join(' ')).toContain('worldwide feed');
    expect(report.holding.count).toBe(0);
    expect(report.status).not.toContain('holding');
    expect(report.summary).toContain('Holding cannot be judged');
  });

  it('says so when the area feed is centred away from the airport', () => {
    const report = slow(new OpsTraffic(EHAM), { lat: 48, lng: 4, nm: 250 });
    expect(report.coverage.holdingReliable).toBe(false);
    expect(report.coverage.notes.join(' ')).toContain('not centred');
    const centred = new OpsTraffic(EHAM);
    const states = fly({ from: away(EHAM, 45, 40), trk: 225, gs: 220, alt: 8000, plan: racetrack(1) });
    const ok = drive(centred, [flight(states, { id: 'w2' })], { seconds: 240, area: { lat: 52.25, lng: 4.75, nm: 125 } });
    expect(ok.coverage.holdingReliable).toBe(true);
    expect(ok.coverage.inboundNm).toBeLessThan(200);
    expect(ok.coverage.notes.join(' ')).toContain('covers only');
    // An area of 200 miles snapped to the grid, a few miles off, is as good as centred.
    const snapped = new OpsTraffic(EHAM);
    snapped.update([], { now: T0, area: { lat: 52.25, lng: 4.75, nm: 200 } });
    expect(snapped.report(T0).coverage.notes.join(' ')).not.toContain('covers only');
  });
});

describe('status and summary', () => {
  const report = (over = {}) => ({
    inbound: { within30: 12, between30and60: 8, total: 20 },
    holding: { count: 2, stacks: [{ count: 2, direction: 'NE', distanceNm: 38, longestMinutes: 14 }] },
    movements: { arrivals: { inUse: ['27'] }, departures: { inUse: ['24', '18C'] } },
    coverage: { holdingReliable: true, movementsReliable: true },
    ...over,
  });

  it('writes the status fact', () => {
    expect(statusFact(report())).toBe('12 inbound in 30 min · 2 holding');
    expect(statusFact(report({ holding: { count: 0, stacks: [] } }))).toBe('12 inbound in 30 min');
    expect(statusFact(report({ inbound: { within30: 0, between30and60: 3, total: 3 } }))).toBe('3 inbound in 60 min · 2 holding');
    expect(statusFact(report({ inbound: { within30: 0, between30and60: 0, total: 0 } }))).toBe('No inbound traffic seen · 2 holding');
    expect(statusFact(report({ coverage: { holdingReliable: false } }))).toBe('12 inbound in 30 min');
  });

  it('writes the summary line', () => {
    expect(summaryLine(report())).toBe('About 12 inbound in the next 30 min, and 8 more in 30 to 60 min. 2 holding, 2 NE 38 NM out, the longest about 14 min. Landing on 27, departing from 24 and 18C (as seen).');
    expect(summaryLine(report({ inbound: { within30: 0, between30and60: 0, total: 0 }, holding: { count: 0, stacks: [] }, movements: { arrivals: { inUse: [] }, departures: { inUse: [] } } }))).toBe(
      'No inbound traffic seen. No aircraft holding. No runway use seen yet.',
    );
  });

  it('names compass directions', () => {
    expect([0, 44, 90, 200, 359].map(compass)).toEqual(['N', 'NE', 'E', 'S', 'N']);
  });
});

describe('memory', () => {
  it('keeps no history beyond the cap for the aircraft near the airport, and none for those far away', () => {
    const ops = new OpsTraffic(EHAM);
    const list = [];
    for (let i = 0; i < 2500; i++) list.push({ id: `n${i}`, lat: 52.3 + ((i % 50) - 25) / 120, lng: 4.7 + (Math.floor(i / 50) - 25) / 80, altitudeFt: 9000, onGround: false, speedKt: 250, track: 90, seen: T0 });
    for (let i = 0; i < 500; i++) list.push({ id: `far${i}`, lat: 40 + i / 100, lng: 20, altitudeFt: 9000, onGround: false, speedKt: 250, track: 90, seen: T0 });
    ops.update(list, { now: T0 });
    const stats = ops.stats();
    expect(stats.tracked).toBeLessThanOrEqual(MAX_TRACKED);
    expect(stats.tracked).toBe(MAX_TRACKED);
    expect(stats.withHistory).toBeLessThanOrEqual(MAX_HISTORY_AIRCRAFT);
    // Those beyond 220 miles are not held at all.
    const few = new OpsTraffic(EHAM);
    few.update(list.slice(0, 100).concat(list.slice(2500)), { now: T0 });
    expect(few.stats().tracked).toBe(100);
  });

  it('caps the track of one aircraft in points and in age', () => {
    const ops = new OpsTraffic(EHAM);
    const base = { id: 'one', lat: 52.5, lng: 4.9, altitudeFt: 9000, onGround: false, speedKt: 250, track: 90 };
    for (let s = 0; s <= 3 * 3600; s += 15) ops.update([{ ...base, lng: 4.9 + s / 1e6, seen: T0 + s * 1000 }], { now: T0 + s * 1000 });
    expect(ops.stats().points).toBeLessThanOrEqual(MAX_POINTS);
    expect(ops.stats().points).toBe(MAX_POINTS);
    // An aircraft that is only seen once in a while keeps no more than half an hour.
    const sparse = new OpsTraffic(EHAM);
    for (let s = 0; s <= 3600; s += 300) sparse.update([{ ...base, lng: 4.9 + s / 1e6, seen: T0 + s * 1000 }], { now: T0 + s * 1000 });
    expect(sparse.stats().points).toBe(7);
  });

  it('forgets an aircraft not heard from for ten minutes, and what it was told about it', () => {
    const ops = new OpsTraffic(EHAM);
    ops.update([level(EHAM, 100, 100, { id: 'gone' })], { now: T0, hints: { gone: { destination: 'EHAM' } } });
    expect(ops.stats().tracked).toBe(1);
    ops.update([], { now: T0 + 9 * MIN });
    expect(ops.stats().tracked).toBe(1);
    ops.update([], { now: T0 + 10 * MIN + 1 });
    expect(ops.stats().tracked).toBe(0);
    // A report that is itself too old is not taken in.
    ops.update([level(EHAM, 100, 100, { id: 'old', seen: T0 - 11 * MIN })], { now: T0 + 11 * MIN });
    expect(ops.stats().tracked).toBe(0);
  });

  it('caps the movements it remembers, and drops those older than a day', () => {
    const ops = new OpsTraffic(EHAM);
    const end = runwayEnds(EHAM).find((e) => e.ident === '27');
    const p = away(end.thr, 87, 2.5);
    const landing = (i, seen) => ({ id: `l${i}`, callsign: `L${i}`, category: 'Large aircraft', ...p, altitudeFt: 850, onGround: false, speedKt: 140, track: 267, verticalFpm: -700, seen });
    ops.update(Array.from({ length: MAX_EVENTS + 200 }, (_, i) => landing(i, T0)), { now: T0 });
    expect(ops.stats().events).toBe(MAX_EVENTS);
    const later = T0 + EVENT_MAX_AGE_MS + MIN;
    ops.update([], { now: later });
    expect(ops.stats().events).toBe(0);
  });

  it('starts again on reset', () => {
    const ops = new OpsTraffic(EHAM);
    drive(ops, [approach(EHAM, '27', { id: 'z', touchdownSec: 240 })], { seconds: 300 });
    ops.reset();
    expect(ops.stats()).toEqual({ tracked: 0, withHistory: 0, points: 0, events: 0, steps: 0 });
    expect(ops.report(T0).movements.arrivals.total).toBe(0);
  });
});
