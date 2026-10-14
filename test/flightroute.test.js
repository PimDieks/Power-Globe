import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ROUTE_RETRY_MS,
  TRACK_CACHE_MS,
  acceptRoute,
  airportCode,
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
  trackFromApi,
} from '../src/flightroute.js';

const AMS = { icao: 'EHAM', code: 'AMS', name: 'Amsterdam Airport Schiphol', lat: 52.3086, lng: 4.76389 };
const LHR = { icao: 'EGLL', code: 'LHR', name: 'London Heathrow Airport', lat: 51.4706, lng: -0.461941 };
const LGW = { icao: 'EGKK', code: 'LGW', name: 'London Gatwick Airport', lat: 51.1481, lng: -0.190278 };
const BER = { icao: 'EDDB', code: 'BER', name: 'Berlin Brandenburg Airport', lat: 52.3667, lng: 13.5033 };
const LEMD = { icao: 'LEMD', code: 'MAD', name: 'Madrid Barajas Airport', lat: 40.4719, lng: -3.56264 };
const EBLG = { icao: 'EBLG', code: 'LGG', name: 'Liege Airport', lat: 50.6374, lng: 5.44322 };

const AIRPORTS = [
  { ident: 'EHAM', iata: 'AMS', name: AMS.name, lat: AMS.lat, lng: AMS.lng },
  { ident: 'EHRD', iata: 'RTM', name: 'Rotterdam The Hague Airport', lat: 51.9569, lng: 4.43722 },
  { ident: 'EGLL', iata: 'LHR', name: LHR.name, lat: LHR.lat, lng: LHR.lng },
  { ident: 'EDDB', iata: '', name: BER.name, lat: BER.lat, lng: BER.lng },
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
    const points = trackFromApi({ points: [[20, 52, 4, 10000, 0], [10, 51, 3, null, 1], [15, null, 4, 5, 0], 'x', [30, 53, 5, 'a', 0]] });
    expect(points).toEqual([
      { t: 10, lat: 51, lng: 3, altitudeFt: null, onGround: true },
      { t: 20, lat: 52, lng: 4, altitudeFt: 10000, onGround: false },
      { t: 30, lat: 53, lng: 5, altitudeFt: null, onGround: false },
    ]);
    expect(trackFromApi(null)).toEqual([]);
    expect(trackFromApi({ points: 'no' })).toEqual([]);
  });

  it('continues with the positions seen since, but not those the track already has', () => {
    const track = [{ t: 10 }, { t: 20 }];
    const trail = [{ t: 15 }, { t: 20 }, { t: 25 }, { t: 30 }];
    expect(joinPath(track, trail).map((p) => p.t)).toEqual([10, 20, 25, 30]);
    expect(joinPath([], trail).map((p) => p.t)).toEqual([15, 20, 25, 30]);
    expect(joinPath(track, [])).toEqual(track);
  });
});

describe('the departure airport', () => {
  const at = (lat, lng, altitudeFt, onGround = false) => ({ lat, lng, altitudeFt, onGround });

  it('is the airport a track starts at when it starts on the ground or low', () => {
    expect(departureAirport(at(52.3, 4.78, null, true), AIRPORTS).ident).toBe('EHAM');
    expect(departureAirport(at(52.3, 4.78, -300), AIRPORTS).ident).toBe('EHAM');
    expect(departureAirport(at(52.3, 4.78, 7999), AIRPORTS).ident).toBe('EHAM');
  });

  it('is none for a track that starts high, or too far from an airport, or has no height', () => {
    expect(departureAirport(at(52.3, 4.78, 8000), AIRPORTS)).toBeNull();
    expect(departureAirport(at(52.3, 4.78, 33000), AIRPORTS)).toBeNull();
    expect(departureAirport(at(52.3, 4.78, null), AIRPORTS)).toBeNull();
    // About 16 km from Rotterdam and Schiphol alike... but 15 km is the limit.
    expect(departureAirport(at(52.1, 4.6, 1000), AIRPORTS)).toBeNull();
    expect(departureAirport(at(48, 11, 0, true), AIRPORTS)).toBeNull();
    expect(departureAirport(null, AIRPORTS)).toBeNull();
  });

  it('takes the nearest airport, and is within 15 km', () => {
    expect(departureAirport(at(51.97, 4.45, 0, true), AIRPORTS).ident).toBe('EHRD');
    expect(departureAirport(at(52.4, 4.9, 500), AIRPORTS).ident).toBe('EHAM');
    expect(distanceKm(at(52.4, 4.9), AIRPORTS[0])).toBeLessThan(15);
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
      { code: 'LHR', name: LHR.name, lat: LHR.lat, lng: LHR.lng },
      { code: 'AMS', name: AMS.name, lat: AMS.lat, lng: AMS.lng },
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

  it('accepts without a track too, but then cannot tell which way the aircraft is going', () => {
    expect(acceptRoute([LHR, AMS], { position: { lat: 51.9, lng: 1.2 } })).toEqual({ from: LHR, to: AMS });
    // Behind the first airport, still within reach of the line, going the wrong way with a track.
    const behind = { lat: 51.5, lng: -1.5 };
    expect(acceptRoute([LHR, AMS], { position: behind })).toEqual({ from: LHR, to: AMS });
    expect(acceptRoute([LHR, AMS], { position: behind, trackStart: trackFrom(LHR) })).toBeNull();
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
    const fetchFn = vi.fn(async () => answer({ points: [[1, 50, 4, 100, 0], [2, 51, 5, 200, 0]] }));
    const ask = () => loadTrack('4840d6', { fetchFn, now: () => t, proxy: 'https://api.example' });
    expect(await ask()).toHaveLength(2);
    expect(fetchFn.mock.calls[0][0]).toBe('https://api.example/track?icao24=4840d6');
    t = TRACK_CACHE_MS - 1;
    await ask();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    t = TRACK_CACHE_MS + 1;
    await ask();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('has no track, without asking again for a while, when the API cannot be had', async () => {
    let t = 0;
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const ask = () => loadTrack('4840d6', { fetchFn, now: () => t, proxy: 'https://api.example' });
    expect(await ask()).toEqual([]);
    expect(await ask()).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const refused = vi.fn(async () => answer({ error: 'x' }, { ok: false, status: 502 }));
    expect(await loadTrack('abcdef', { fetchFn: refused, proxy: 'https://api.example' })).toEqual([]);
    const none = vi.fn();
    expect(await loadTrack('123456', { fetchFn: none, proxy: '' })).toEqual([]);
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
