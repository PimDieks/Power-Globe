import { describe, expect, it } from 'vitest';
import { AircraftStore, estimatePosition, fromAdsb, fromOpenSky } from '../src/aircraft.js';
import { orbitClass, orbitPath, parseTle, periodMinutes, satellitePosition, toGeodetic, toSatrec, toScene, tleEpoch } from '../src/orbits.js';
import { aircraftDetailsHtml, ago, satelliteDetailsHtml } from '../src/trafficview.js';
import { areaRadiusNm } from '../src/traffic.js';

// The ISS in September 2008 (the classic example element set).
const ISS = `ISS (ZARYA)
1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537
`;

describe('fromOpenSky', () => {
  it('converts state vectors to feet and knots and skips ground vehicles', () => {
    const list = fromOpenSky({
      time: 1760000000,
      states: [
        ['4840d6', 'KLM1234 ', 'Kingdom of the Netherlands', 1759999990, 1759999995, 4.76, 52.31, 3048, false, 231.5, 270.5, -5.08, null, 3100, '1000', false, 0, 4],
        ['abc123', 'VEH1', 'X', 1759999990, 1759999995, 1, 1, null, true, 5, 90, null, null, null, null, false, 0, 17],
        ['def456', 'NOPOS', 'X', null, 1759999995, null, null, null, false, null, null, null, null, null, null, false, 0, 0],
      ],
    });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: '4840d6',
      callsign: 'KLM1234',
      lat: 52.31,
      lng: 4.76,
      altitudeFt: 10000,
      onGround: false,
      track: 270.5,
      verticalFpm: -1000,
      category: 'Large aircraft',
      seen: 1759999990000,
      military: false,
    });
    expect(list[0].speedKt).toBeCloseTo(450, 0);
  });
});

describe('fromAdsb', () => {
  const data = {
    now: 1760000000000,
    ac: [
      { hex: 'ae1234', flight: 'RCH123  ', r: '05-5140', t: 'C17', desc: 'BOEING C-17A Globemaster III', dbFlags: 1, alt_baro: 28000, gs: 420, track: 85, baro_rate: 0, squawk: '4521', lat: 51.5, lon: -1.2, seen_pos: 2 },
      { hex: '484506', flight: 'KLM42', r: 'PH-BXA', t: 'B738', alt_baro: 'ground', gs: 3, track: 10, lat: 52.3, lon: 4.76, seen_pos: 0.5 },
      { hex: '~2a0001', lat: 52, lon: 4, category: 'C1' },
    ],
  };

  it('reads ADS-B Exchange style feeds and marks military aircraft', () => {
    const [mil, klm, ...rest] = fromAdsb(data);
    expect(rest).toEqual([]);
    expect(mil).toMatchObject({ id: 'ae1234', callsign: 'RCH123', type: 'C17', registration: '05-5140', military: true, altitudeFt: 28000, seen: 1759999998000 });
    expect(klm).toMatchObject({ onGround: true, altitudeFt: 0, military: false });
  });

  it('treats everything in the military feed as military', () => {
    expect(fromAdsb({ ac: [data.ac[1]] }, { military: true })[0].military).toBe(true);
  });
});

describe('estimatePosition', () => {
  const ac = { lat: 0, lng: 0, track: 90, speedKt: 360, onGround: false, seen: 0 };

  it('moves an aircraft along its track', () => {
    // 360 kt for 10 minutes is 60 nautical miles: one degree of longitude at the equator.
    const p = estimatePosition(ac, 600_000);
    expect(p.lat).toBeCloseTo(0, 5);
    expect(p.lng).toBeCloseTo(1, 2);
  });

  it('does not move aircraft on the ground or guess beyond ten minutes', () => {
    expect(estimatePosition({ ...ac, onGround: true }, 600_000)).toEqual({ lat: 0, lng: 0 });
    expect(estimatePosition(ac, 3_600_000).lng).toBeCloseTo(1, 2);
  });

  it('wraps across the date line', () => {
    expect(estimatePosition({ ...ac, lng: 179.9 }, 600_000).lng).toBeCloseTo(-179.1, 2);
  });
});

describe('AircraftStore', () => {
  it('keeps the newest report and the details only some feeds have', () => {
    const store = new AircraftStore();
    store.update([{ id: 'a', seen: 100, lat: 1, lng: 1, registration: 'PH-ABC', type: 'B738', military: true }]);
    store.update([{ id: 'a', seen: 200, lat: 2, lng: 2, registration: '', type: '', military: false, country: 'NL' }]);
    store.update([{ id: 'a', seen: 150, lat: 9, lng: 9 }]);
    expect(store.byId.get('a')).toMatchObject({ lat: 2, registration: 'PH-ABC', type: 'B738', military: true, country: 'NL' });
  });

  it('filters civil and military aircraft and forgets stale ones', () => {
    const store = new AircraftStore();
    store.update([
      { id: 'c', seen: 1000, military: false },
      { id: 'm', seen: 1000, military: true },
      { id: 'old', seen: 0, military: false },
    ]);
    store.prune(1500, 1000);
    expect(store.list({ civil: true, military: false }).map((a) => a.id)).toEqual(['c']);
    expect(store.list({ civil: false, military: true }).map((a) => a.id)).toEqual(['m']);
    expect(store.size).toBe(2);
  });
});

describe('orbits', () => {
  const [tle] = parseTle(ISS);
  const satrec = toSatrec(tle);

  it('parses element sets', () => {
    expect(tle.name).toBe('ISS (ZARYA)');
    expect(parseTle(`${ISS}junk\n${ISS}`)).toHaveLength(2);
    expect(toSatrec({ line1: '1 bad', line2: '2 bad' })).toBeNull();
  });

  it('puts the ISS in low orbit at its 2008 altitude and speed', () => {
    const epoch = tleEpoch(tle.line1);
    expect(epoch.toISOString()).toBe('2008-09-20T12:25:40.104Z');
    const p = satellitePosition(satrec, epoch);
    const geo = toGeodetic(p);
    expect(geo.altitudeKm).toBeGreaterThan(320);
    expect(geo.altitudeKm).toBeLessThan(380);
    expect(Math.abs(geo.lat)).toBeLessThanOrEqual(51.7);
    expect(p.speed).toBeCloseTo(7.7, 0);
    expect(periodMinutes(satrec)).toBeCloseTo(91.6, 0);
    expect(orbitClass(satrec)).toBe('leo');
  });

  it('draws one orbit ahead', () => {
    const path = orbitPath(satrec, tleEpoch(tle.line1), 90);
    expect(path).toHaveLength(91);
  });

  it('maps Earth-fixed positions onto the globe the way three-globe does', () => {
    // 0°N 90°E: Earth-fixed +y. three-globe: x = r cos(lat) sin(lng), y = r sin(lat), z = r cos(lat) cos(lng).
    expect(toScene({ x: 0, y: 1, z: 0 }, 100)).toEqual({ x: 100, y: 0, z: 0 });
    expect(toScene({ x: 0, y: 0, z: 1 }, 100)).toEqual({ x: 0, y: 100, z: 0 });
    expect(toScene({ x: 1, y: 0, z: 0 }, 100)).toEqual({ x: 0, y: 0, z: 100 });
  });
});

describe('live traffic', () => {
  it('fetches the area in view, up to 250 nautical miles around', () => {
    expect(areaRadiusNm(0.6)).toBe(250);
    expect(areaRadiusNm(0.05)).toBe(Math.round(((70 * 0.05 + 0.2) / 2) * 1.3 * 60));
    expect(areaRadiusNm(0.001)).toBeGreaterThanOrEqual(10);
  });

  it('describes an aircraft', () => {
    const html = aircraftDetailsHtml(
      { id: 'ae1234', callsign: 'RCH123', military: true, altitudeFt: 28010, speedKt: 420.4, track: 85, verticalFpm: -1530, squawk: '7700', type: 'C17', registration: '05-5140', seen: 0, source: 'adsb.lol' },
      { position: { lat: 51.5, lng: -1.2 }, now: 12_000, locale: 'en-US' },
    );
    expect(html).toContain('Military');
    expect(html).toContain('Emergency');
    expect(html).toContain('28,000 ft');
    expect(html).toContain('420 kt');
    expect(html).toContain('085°');
    expect(html).toContain('Descending 1,550 ft/min');
    expect(html).toContain('12 s ago via adsb.lol');
    expect(html).toContain('AE1234');
  });

  it('describes a satellite', () => {
    const [tle] = parseTle(ISS);
    const html = satelliteDetailsHtml(tle, {
      position: { lat: 10, lng: 20, altitudeKm: 352.4 },
      speed: 7.7,
      period: 91.6,
      inclination: 51.64,
      orbit: 'leo',
      epoch: new Date(0),
      now: 7_200_000,
      locale: 'en-US',
    });
    expect(html).toContain('352 km');
    expect(html).toContain('7.70 km/s');
    expect(html).toContain('27,720 km/h');
    expect(html).toContain('Low Earth orbit');
    expect(html).toContain('92 min');
    expect(html).toContain('51.6°');
    expect(html).toContain('25544');
    expect(html).toContain('2 h ago');
  });

  it('says how long ago', () => {
    expect(ago(5_000)).toBe('5 s ago');
    expect(ago(150_000)).toBe('3 min ago');
  });
});

describe('Earth views', () => {
  it('offers five maps of the Earth, each with tiles and a credit', async () => {
    const { BASEMAPS } = await import('../src/map.js');
    expect(Object.keys(BASEMAPS)).toEqual(['satellite', 'streets', 'topo', 'clouds', 'aviation']);
    for (const map of Object.values(BASEMAPS)) {
      expect(map.url(1, 2, 3)).toMatch(/^https:\/\/.+\/3\/2\/1(\.png|\.jpg)?$/);
      expect(map.credit).toBeTruthy();
      expect(map.maxLevel).toBeGreaterThan(0);
    }
  });

  it('shows the clouds of the last whole day, and the satellite imagery closer in', async () => {
    const { BASEMAPS, cloudsDay } = await import('../src/map.js');
    expect(cloudsDay(Date.parse('2026-10-13T00:30:00Z'))).toBe('2026-10-12');
    expect(BASEMAPS.clouds.url(4, 2, 3)).toContain(`/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${cloudsDay()}/`);
    expect(BASEMAPS.clouds.url(4, 2, 12)).toBe(BASEMAPS.satellite.url(4, 2, 12));
    expect(BASEMAPS.clouds.credit).toContain(cloudsDay());
  });

  it('draws the aviation chart through the Power Globe API, so its key stays there', async () => {
    const { BASEMAPS } = await import('../src/map.js');
    expect(BASEMAPS.aviation.chart.url(131, 84, 8)).toBe('https://power-globe-api.pimdieks.workers.dev/tiles/openaip/8/131/84.png');
    expect(BASEMAPS.aviation.credit).toContain('openAIP');
  });
});
