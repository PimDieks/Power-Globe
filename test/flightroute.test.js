import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROUTE_RETRY_MS,
  TRACK_CACHE_MS,
  acceptRoute,
  airportCode,
  carryAltitudes,
  clearFlightCaches,
  departureAirport,
  distanceKm,
  distanceToSegmentKm,
  greatCircle,
  joinPath,
  loadRoute,
  loadTrack,
  parseRoute,
  routeUrl,
  trackFits,
  trackFromApi,
} from '../src/flightroute.js';

const AMS = { icao: 'EHAM', code: 'AMS', name: 'Amsterdam Airport Schiphol', lat: 52.3086, lng: 4.76389 };
const LHR = { icao: 'EGLL', code: 'LHR', name: 'London Heathrow Airport', lat: 51.4706, lng: -0.461941 };
const LGW = { icao: 'EGKK', code: 'LGW', name: 'London Gatwick Airport', lat: 51.1481, lng: -0.190278 };
const BER = { icao: 'EDDB', code: 'BER', name: 'Berlin Brandenburg Airport', lat: 52.3667, lng: 13.5033 };
const LEMD = { icao: 'LEMD', code: 'MAD', name: 'Madrid Barajas Airport', lat: 40.4719, lng: -3.56264 };
const EBLG = { icao: 'EBLG', code: 'LGG', name: 'Liege Airport', lat: 50.6374, lng: 5.44322 };

const AIRPORTS = [
  { ident: 'EHAM', iata: 'AMS', name: AMS.name, lat: AMS.lat, lng: AMS.lng, large: true, scheduled: true },
  { ident: 'EHRD', iata: 'RTM', name: 'Rotterdam The Hague Airport', lat: 51.9569, lng: 4.43722, large: false, scheduled: true },
  { ident: 'EGLL', iata: 'LHR', name: LHR.name, lat: LHR.lat, lng: LHR.lng, large: true, scheduled: true },
  { ident: 'EDDB', iata: '', name: BER.name, lat: BER.lat, lng: BER.lng, large: true, scheduled: true },
];

// A route file as the database gives them.
const routeFile = (codes, airports) => ({ airport_codes: codes, _airports: airports.map((a) => ({ name: a.name, icao: a.icao, iata: a.iata ?? a.code, lat: a.lat, lon: a.lng })) });

describe('callsign path', () => {
  it('builds the route file path from the callsign: its first two characters, then the whole', () => {
    expect(routeUrl('EZY48YK')).toBe('https://vrs-standing-data.adsb.lol/routes/EZ/EZY48YK.json');
    expect(routeUrl('KLM66A')).toBe('https://vrs-standing-data.adsb.lol/routes/KL/KLM66A.json');
  });

  it('trims the padding and folds case', () => {
    expect(routeUrl('KLM66A  ')).toBe('https://vrs-standing-data.adsb.lol/routes/KL/KLM66A.json');
    expect(routeUrl(' klm66a')).toBe('https://vrs-standing-data.adsb.lol/routes/KL/KLM66A.json');
  });

  it('has none for a callsign that cannot be one', () => {
    for (const bad of ['', '   ', null, undefined, 'AB', 'KLM 66A', 'KLM/66A', 'KLM66A-1', '../etc/x', 'ABCDEFGHI']) expect(routeUrl(bad), String(bad)).toBeNull();
  });
});

describe('the track', () => {
  it('reads the API points, oldest first, leaving out what has no position', () => {
    const track = trackFromApi({ callsign: ' KLM66A ', endTime: 40, points: [[20, 52, 4, 10000, 0], [10, 51, 3, null, 1], [15, null, 4, 5, 0], 'x', [30, 53, 5, 'a', 0]] });
    expect(track).toEqual({
      callsign: 'KLM66A',
      endTime: 40,
      points: [
        { t: 10, lat: 51, lng: 3, altitudeFt: null, onGround: true },
        { t: 20, lat: 52, lng: 4, altitudeFt: 10000, onGround: false },
        { t: 30, lat: 53, lng: 5, altitudeFt: 10000, onGround: false },
      ],
    });
    expect(trackFromApi(null)).toEqual({ points: [], endTime: null, callsign: '' });
    expect(trackFromApi({ points: 'no' }).points).toEqual([]);
  });

  it('carries the last known altitude over points that have none, unless they are on the ground', () => {
    const point = (t, altitudeFt, onGround = false) => ({ t, lat: 0, lng: 0, altitudeFt, onGround });
    const carried = carryAltitudes([point(1, null), point(2, 5000), point(3, null), point(4, null), point(5, 12000), point(6, null, true), point(7, null)]);
    expect(carried.map((p) => p.altitudeFt)).toEqual([null, 5000, 5000, 5000, 12000, null, null]);
    expect(carryAltitudes([])).toEqual([]);
  });

  it('continues with the positions seen since, but not those the track already has', () => {
    const track = [{ t: 10 }, { t: 20 }];
    const trail = [{ t: 15 }, { t: 20 }, { t: 25 }, { t: 30 }];
    expect(joinPath(track, trail).map((p) => p.t)).toEqual([10, 20, 25, 30]);
    expect(joinPath([], trail).map((p) => p.t)).toEqual([15, 20, 25, 30]);
    expect(joinPath(track, [])).toEqual(track);
  });
});

describe('whether a track is the flight the aircraft is on now', () => {
  // The track of KLM66A from Heathrow, ending at time 1200 s, about 25 km from where it is at 1300 s.
  const track = (overrides = {}) => ({ callsign: 'KLM66A', endTime: 1200, points: [{ t: 1000, lat: 51.4776, lng: -0.4469 }, { t: 1200, lat: 51.7, lng: 0.6 }], ...overrides });
  const ac = (overrides = {}) => ({ callsign: 'KLM66A', seen: 1_300_000, lat: 51.8, lng: 0.9, speedKt: 450, ...overrides });

  it('accepts a track that ends where the aircraft was a little before', () => {
    expect(trackFits(track(), ac())).toBe(true);
    expect(trackFits(track({ callsign: '' }), ac())).toBe(true);
    expect(trackFits(track(), ac({ callsign: '' }))).toBe(true);
    expect(trackFits(track({ callsign: 'klm66a ' }), ac())).toBe(true);
  });

  it('rejects the track of another callsign', () => {
    expect(trackFits(track({ callsign: 'EZY48YK' }), ac())).toBe(false);
  });

  it('rejects a track that ended more than 10 minutes before the report: the flight before this one', () => {
    expect(trackFits(track(), ac({ seen: 1_800_000, lat: 51.7, lng: 0.6 }))).toBe(true);
    expect(trackFits(track(), ac({ seen: 1_801_000, lat: 51.7, lng: 0.6 }))).toBe(false);
  });

  it('rejects a track that ends further away than the aircraft could have flown since', () => {
    // 450 kt for 100 s is about 23 km, under the 50 km that is always allowed.
    expect(trackFits(track(), ac({ lat: 52.3, lng: 0.6 }))).toBe(false);
    // Ten minutes at 450 kt is 139 km: 100 km away is within reach then, 200 km is not.
    const later = { seen: 1_800_000 };
    expect(trackFits(track(), ac({ ...later, lat: 52.6, lng: 0.6 }))).toBe(true);
    expect(trackFits(track(), ac({ ...later, lat: 53.5, lng: 0.6 }))).toBe(false);
    expect(trackFits(track(), ac({ speedKt: null, lat: 52.3, lng: 0.6 }))).toBe(false);
  });

  it('has nothing to fit without points', () => {
    expect(trackFits(track({ points: [] }), ac())).toBe(false);
    expect(trackFits(null, ac())).toBe(false);
  });
});

describe('the departure airport', () => {
  const at = (lat, lng, altitudeFt, onGround = false) => ({ lat, lng, altitudeFt, onGround });
  // A track from a point that climbs.
  const climbing = (first) => [first, at(first.lat + 0.05, first.lng + 0.1, (first.altitudeFt ?? 0) + 3000)];

  it('is the airport a track starts at when it starts on the ground or low', () => {
    expect(departureAirport([at(52.3, 4.78, null, true)], AIRPORTS).ident).toBe('EHAM');
    expect(departureAirport(climbing(at(52.3, 4.78, -300)), AIRPORTS).ident).toBe('EHAM');
    expect(departureAirport(climbing(at(52.3, 4.78, 7999)), AIRPORTS).ident).toBe('EHAM');
  });

  it('is none for a track that starts high, or too far from an airport, or has no height', () => {
    expect(departureAirport(climbing(at(52.3, 4.78, 8000)), AIRPORTS)).toBeNull();
    expect(departureAirport(climbing(at(52.3, 4.78, 33000)), AIRPORTS)).toBeNull();
    expect(departureAirport([at(52.3, 4.78, null), at(52.4, 4.8, 3000)], AIRPORTS)).toBeNull();
    // About 16 km from Rotterdam and Schiphol alike... but 15 km is the limit.
    expect(departureAirport(climbing(at(52.1, 4.6, 1000)), AIRPORTS)).toBeNull();
    expect(departureAirport([at(48, 11, 0, true)], AIRPORTS)).toBeNull();
    expect(departureAirport([], AIRPORTS)).toBeNull();
    expect(departureAirport(null, AIRPORTS)).toBeNull();
  });

  it('is none for a track that starts low in the air and does not climb: it began on the way down', () => {
    const approach = [at(52.35, 4.9, 3000), at(52.33, 4.85, 2000), at(52.31, 4.78, 0, true)];
    expect(departureAirport(approach, AIRPORTS)).toBeNull();
    expect(departureAirport([at(52.35, 4.9, 3000)], AIRPORTS)).toBeNull();
    expect(departureAirport([at(52.35, 4.9, 3000), at(52.4, 5, 3200)], AIRPORTS)).toBeNull();
    expect(departureAirport([at(52.35, 4.9, 3000), at(52.4, 5, 3500)], AIRPORTS).ident).toBe('EHAM');
    // On the ground it needs no climb to follow.
    expect(departureAirport([at(52.31, 4.78, 0, true), at(52.31, 4.7, 0, true)], AIRPORTS).ident).toBe('EHAM');
  });

  it('takes the nearest airport, and is within 15 km', () => {
    expect(departureAirport([at(51.97, 4.45, 0, true)], AIRPORTS).ident).toBe('EHRD');
    expect(departureAirport(climbing(at(52.4, 4.9, 500)), AIRPORTS).ident).toBe('EHAM');
    expect(distanceKm(at(52.4, 4.9), AIRPORTS[0])).toBeLessThan(15);
  });

  it('takes a large airport, or one with scheduled flights, over a nearer small field', () => {
    const field = { ident: 'EHXX', iata: '', name: 'A small field', lat: 52.34, lng: 4.8, large: false, scheduled: false };
    const first = at(52.34, 4.8, 0, true);
    expect(departureAirport([first], [field, ...AIRPORTS]).ident).toBe('EHAM');
    expect(departureAirport([first], [field, { ...AIRPORTS[1], lat: 52.3, lng: 4.9 }]).ident).toBe('EHRD');
    // Without such an airport in reach the small field is the one.
    expect(departureAirport([first], [field]).ident).toBe('EHXX');
  });

  it('names an airport by its IATA code, else its ICAO one', () => {
    expect(airportCode(AIRPORTS[0])).toBe('AMS');
    expect(airportCode(AIRPORTS[3])).toBe('EDDB');
    expect(airportCode({ icao: 'EDDB', iata: '' })).toBe('EDDB');
  });
});

describe('the route database', () => {
  it('reads the airports of a route in order', () => {
    expect(parseRoute(routeFile('EGLL-EHAM', [AMS, LHR]))).toEqual([
      { code: 'LHR', icao: 'EGLL', name: LHR.name, lat: LHR.lat, lng: LHR.lng },
      { code: 'AMS', icao: 'EHAM', name: AMS.name, lat: AMS.lat, lng: AMS.lng },
    ]);
  });

  it('keeps the stops of a route with several, and falls back to the ICAO code without an IATA one', () => {
    const file = routeFile('EGLL-EHAM-EDDB', [LHR, AMS, { ...BER, iata: '' }]);
    const route = parseRoute(file);
    expect(route.map((a) => a.code)).toEqual(['LHR', 'AMS', 'EDDB']);
  });

  it('has no route when an airport is missing or there are fewer than two', () => {
    expect(parseRoute(routeFile('EGLL-EHAM', [LHR]))).toBeNull();
    expect(parseRoute(routeFile('EGLL', [LHR]))).toBeNull();
    expect(parseRoute({ airport_codes: '', _airports: [] })).toBeNull();
    expect(parseRoute({ airport_codes: 'EGLL-EHAM', _airports: [{ icao: 'EGLL', lat: 1, lon: 2 }, { icao: 'EHAM', lat: 'x', lon: 2 }] })).toBeNull();
    expect(parseRoute(null)).toBeNull();
  });
});

describe('geometry', () => {
  it('measures the distance between points in kilometres', () => {
    expect(distanceKm(LHR, AMS)).toBeCloseTo(370, -1);
    expect(distanceKm(LHR, LHR)).toBe(0);
  });

  it('measures the distance to a segment across it, or to its nearer end', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0, lng: 10 };
    expect(distanceToSegmentKm({ lat: 1, lng: 5 }, a, b)).toBeCloseTo(111.2, 0);
    expect(distanceToSegmentKm({ lat: 0, lng: 5 }, a, b)).toBeCloseTo(0, 3);
    expect(distanceToSegmentKm({ lat: 0, lng: -2 }, a, b)).toBeCloseTo(222.4, 0);
    expect(distanceToSegmentKm({ lat: 1, lng: 12 }, a, b)).toBeCloseTo(distanceKm({ lat: 1, lng: 12 }, b), 3);
    expect(distanceToSegmentKm(a, a, b)).toBeCloseTo(0, 6);
  });

  it('draws a great circle between two airports, in equal steps', () => {
    const points = greatCircle(LHR, AMS, 8);
    expect(points).toHaveLength(9);
    expect(points[0].f).toBe(0);
    expect(points[0].lat).toBeCloseTo(LHR.lat, 6);
    expect(points[0].lng).toBeCloseTo(LHR.lng, 6);
    expect(points[8].lat).toBeCloseTo(AMS.lat, 6);
    expect(points[8].lng).toBeCloseTo(AMS.lng, 6);
    expect(distanceKm(points[3], points[4])).toBeCloseTo(distanceKm(LHR, AMS) / 8, 3);
    expect(greatCircle(AMS, AMS, 2).map((p) => p.lat)).toEqual([AMS.lat, AMS.lat, AMS.lat]);
  });
});

describe('whether a route fits the aircraft', () => {
  const trackFrom = (airport) => ({ lat: airport.lat, lng: airport.lng, altitudeFt: 0, onGround: true });

  it('accepts a flight on its way along the route, with the track starting at its first airport', () => {
    const position = { lat: 51.9, lng: 1.2 };
    expect(acceptRoute([LHR, AMS], { position, trackStart: trackFrom(LHR) })).toEqual({ from: LHR, to: AMS });
  });

  it('accepts without a track when the aircraft is heading toward the destination', () => {
    const position = { lat: 51.9, lng: 1.2 };
    // The bearing from there to Amsterdam is about 78 degrees, so 18 to 138 is within 60 of it.
    expect(acceptRoute([LHR, AMS], { position })).toEqual({ from: LHR, to: AMS });
    expect(acceptRoute([LHR, AMS], { position, heading: 78 })).toEqual({ from: LHR, to: AMS });
    expect(acceptRoute([LHR, AMS], { position, heading: 20 })).toEqual({ from: LHR, to: AMS });
    expect(acceptRoute([LHR, AMS], { position, heading: 135 })).toEqual({ from: LHR, to: AMS });
  });

  it('rejects, without a track, a route flown the other way: the aircraft is heading away from the destination', () => {
    // The same flight number the other way round, Amsterdam to Heathrow, with the aircraft on the line.
    const position = { lat: 51.9, lng: 1.2 };
    expect(acceptRoute([LHR, AMS], { position, heading: 258 })).toBeNull();
    expect(acceptRoute([LHR, AMS], { position, heading: 180 })).toBeNull();
    expect(acceptRoute([LHR, AMS], { position, heading: 355 })).toBeNull();
    expect(acceptRoute([LHR, AMS], { position, heading: 15 })).toBeNull();
    expect(acceptRoute([LHR, AMS], { position, heading: 141 })).toBeNull();
    // The angle wraps through north: 350 and 10 degrees are 20 apart.
    const north = [{ code: 'A', lat: 0, lng: 0 }, { code: 'B', lat: 10, lng: 1 }];
    expect(acceptRoute(north, { position: { lat: 5, lng: 0.5 }, heading: 350 })).toEqual({ from: north[0], to: north[1] });
    expect(acceptRoute(north, { position: { lat: 5, lng: 0.5 }, heading: 300 })).toBeNull();
    // A track decides it by where the flight began instead, and an unknown heading asks nothing.
    expect(acceptRoute([LHR, AMS], { position, heading: 258, trackStart: trackFrom(LHR) })).toEqual({ from: LHR, to: AMS });
    expect(acceptRoute([LHR, AMS], { position, heading: null })).toEqual({ from: LHR, to: AMS });
    // Behind the first airport, within reach of the line, going the wrong way with a track.
    const behind = { lat: 51.5, lng: -1.5 };
    expect(acceptRoute([LHR, AMS], { position: behind, trackStart: trackFrom(LHR) })).toBeNull();
    expect(acceptRoute([LHR, AMS], { position: behind, heading: 270 })).toBeNull();
    expect(acceptRoute([LHR, AMS], { position: behind, heading: 80 })).toEqual({ from: LHR, to: AMS });
  });

  it('rejects a cargo flight whose database route is on the other side of Europe', () => {
    // The database says Liege to Madrid; this aircraft is over Poland, having taken off at Berlin.
    const overPoland = { lat: 52.2, lng: 21 };
    expect(acceptRoute([EBLG, LEMD], { position: overPoland })).toBeNull();
    expect(acceptRoute([EBLG, LEMD], { position: overPoland, trackStart: trackFrom(BER) })).toBeNull();
  });

  it('rejects a route whose first airport is not where the track starts', () => {
    // On the line from London to Amsterdam, but it took off from Berlin.
    expect(acceptRoute([LHR, AMS], { position: { lat: 51.9, lng: 1.2 }, trackStart: trackFrom(BER) })).toBeNull();
    // 60 km from the airport is still where it started; 70 km is not.
    const north = (km) => ({ lat: LHR.lat + km / 111.2, lng: LHR.lng, altitudeFt: 0, onGround: false });
    expect(acceptRoute([LHR, AMS], { position: { lat: 51.9, lng: 1.2 }, trackStart: north(55) })).not.toBeNull();
    expect(acceptRoute([LHR, AMS], { position: { lat: 51.9, lng: 1.2 }, trackStart: north(70) })).toBeNull();
  });

  it('allows the aircraft to be off the line by 50 NM, or a fifth of a long route', () => {
    // A point on the line, moved sideways (at right angles to it) by some kilometres.
    const sideways = (from, to, km) => {
      const mid = greatCircle(from, to, 2)[1];
      const bearing = Math.atan2(to.lng - from.lng, to.lat - from.lat) + Math.PI / 2;
      return { lat: mid.lat + (km / 111.2) * Math.cos(bearing), lng: mid.lng + ((km / 111.2) * Math.sin(bearing)) / Math.cos((mid.lat * Math.PI) / 180) };
    };
    // Heathrow to Amsterdam is 370 km, so the limit is 50 NM = 92.6 km.
    expect(acceptRoute([LHR, AMS], { position: sideways(LHR, AMS, 80) })).not.toBeNull();
    expect(acceptRoute([LHR, AMS], { position: sideways(LHR, AMS, 110) })).toBeNull();
    // Amsterdam to Madrid is about 1,480 km: a fifth of it, 296 km, is the limit.
    expect(acceptRoute([AMS, LEMD], { position: sideways(AMS, LEMD, 250) })).not.toBeNull();
    expect(acceptRoute([AMS, LEMD], { position: sideways(AMS, LEMD, 330) })).toBeNull();
  });

  it('uses the leg of a route with stops that holds the aircraft, or none', () => {
    const route = [LGW, AMS, BER];
    const onFirst = { lat: 51.6, lng: 2.4 };
    const onSecond = { lat: 52.5, lng: 9.5 };
    expect(acceptRoute(route, { position: onFirst, trackStart: trackFrom(LGW) })).toEqual({ from: LGW, to: AMS });
    expect(acceptRoute(route, { position: onSecond, trackStart: trackFrom(AMS) })).toEqual({ from: AMS, to: BER });
    expect(acceptRoute(route, { position: onSecond, trackStart: trackFrom(LGW) })).toBeNull();
    expect(acceptRoute(route, { position: { lat: 40.5, lng: -3.5 } })).toBeNull();
  });

  it('has nothing to accept without a usable route', () => {
    expect(acceptRoute(null, { position: { lat: 1, lng: 1 } })).toBeNull();
    expect(acceptRoute([LHR], { position: { lat: 51, lng: 0 } })).toBeNull();
    expect(acceptRoute([AMS, AMS], { position: AMS })).toBeNull();
  });
});

describe('asking for tracks and routes', () => {
  beforeEach(() => clearFlightCaches());
  const answer = (body, init) => ({ ok: true, status: 200, json: async () => body, ...init });

  it('asks the API for a track once for a while, whatever it answers', async () => {
    let t = 0;
    const fetchFn = vi.fn(async () => answer({ callsign: 'KLM66A', endTime: 2, points: [[1, 50, 4, 100, 0], [2, 51, 5, 200, 0]] }));
    const ask = (options = {}) => loadTrack('4840d6', { fetchFn, now: () => t, proxy: 'https://api.example', ...options });
    const track = await ask();
    expect(track.points).toHaveLength(2);
    expect(track).toMatchObject({ callsign: 'KLM66A', endTime: 2 });
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.example/track?icao24=4840d6');
    t = TRACK_CACHE_MS - 1;
    await ask();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // A fresh one is asked for when the aircraft has taken off again.
    await ask({ fresh: true });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    t = 2 * TRACK_CACHE_MS;
    await ask();
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('forgets the tracks it has kept for too long, and does not ask for an address that is not an ICAO one', async () => {
    let t = 0;
    const fetchFn = vi.fn(async () => answer({ points: [[1, 50, 4, 100, 0]] }));
    const options = { fetchFn, now: () => t, proxy: 'https://api.example' };
    for (const id of ['400001', '400002', '400003']) await loadTrack(id, options);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    t = TRACK_CACHE_MS + 1;
    await loadTrack('400004', options);
    // The old ones are gone: asking for one asks again.
    await loadTrack('400001', options);
    expect(fetchFn).toHaveBeenCalledTimes(5);
    for (const id of ['', 'abc', '1234567', 'zzzzzz', '4840D6', '4840d6/x']) {
      expect((await loadTrack(id, options)).points, id).toEqual([]);
    }
    expect(fetchFn).toHaveBeenCalledTimes(5);
  });

  it('has no track, without asking again for a while, when the API cannot be had', async () => {
    let t = 0;
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const ask = () => loadTrack('4840d6', { fetchFn, now: () => t, proxy: 'https://api.example' });
    expect((await ask()).points).toEqual([]);
    expect((await ask()).points).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const refused = vi.fn(async () => answer({ error: 'x' }, { ok: false, status: 502 }));
    expect((await loadTrack('abcdef', { fetchFn: refused, proxy: 'https://api.example' })).points).toEqual([]);
    const none = vi.fn();
    expect((await loadTrack('123456', { fetchFn: none, proxy: '' })).points).toEqual([]);
    expect(none).not.toHaveBeenCalled();
  });

  it('asks the database for a route once for the session, and a missing route is an answer too', async () => {
    const fetchFn = vi.fn(async (url) => (url.includes('KLM66A') ? answer(routeFile('EGLL-EHAM', [LHR, AMS])) : answer(null, { ok: false, status: 404 })));
    expect((await loadRoute('KLM66A ', { fetchFn })).map((a) => a.code)).toEqual(['LHR', 'AMS']);
    expect(fetchFn.mock.calls[0][0]).toBe('https://vrs-standing-data.adsb.lol/routes/KL/KLM66A.json');
    expect(await loadRoute('KLM66A', { fetchFn })).not.toBeNull();
    expect(await loadRoute('GLWLKR', { fetchFn })).toBeNull();
    expect(await loadRoute('GLWLKR', { fetchFn, now: () => Date.now() + 10 * ROUTE_RETRY_MS })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('asks again after a lookup that failed, and does not ask for a callsign that cannot have a route', async () => {
    let t = 0;
    let fail = true;
    const fetchFn = vi.fn(async () => {
      if (fail) throw new TypeError('Failed to fetch');
      return answer(routeFile('EGLL-EHAM', [LHR, AMS]));
    });
    const ask = () => loadRoute('KLM66A', { fetchFn, now: () => t });
    expect(await ask()).toBeNull();
    expect(await ask()).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    fail = false;
    t = ROUTE_RETRY_MS + 1;
    expect(await ask()).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await loadRoute('', { fetchFn })).toBeNull();
    expect(await loadRoute('A B', { fetchFn })).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
