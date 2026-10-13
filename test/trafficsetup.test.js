import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTraffic } from '../src/traffic.js';

// The layers draw with three.js on a globe; these keep the numbers and nothing else.
vi.mock('../src/trafficlayer.js', async (importOriginal) => {
  const cloud = () => {
    const attrs = { position: new Float32Array(30_000), aColor: new Float32Array(30_000), aScale: new Float32Array(10_000), aHeading: new Float32Array(10_000), aNext: new Float32Array(30_000) };
    return {
      capacity: 10_000,
      count: 0,
      points: { visible: true },
      geometry: { attributes: { position: { array: attrs.position }, aNext: { array: attrs.aNext } } },
      reserve: () => attrs,
      commit(n) {
        this.count = n;
      },
      setViewport() {},
      place() {},
    };
  };
  return { ...(await importOriginal()), aircraftLayer: cloud, satelliteLayer: cloud, selectionRing: cloud, orbitLine: () => ({ show() {}, hide() {} }) };
});

const START = Date.parse('2026-10-14T12:00:00Z');
// The Power Globe API's answer for flights around a point: { source, data } with an ADS-B Exchange style list.
const feed = (aircraft) => ({ source: 'adsb.lol', data: { now: Date.now(), ac: aircraft } });
const klm = (overrides = {}) => ({ hex: '484506', flight: 'KLM42', lat: 52.3, lon: 4.76, alt_baro: 30000, gs: 450, track: 90, seen_pos: 1, ...overrides });

const element = () => ({ checked: false, value: '', hidden: false, addEventListener() {}, replaceChildren() {}, textContent: '' });

describe('traffic on the globe', () => {
  let respond;
  let areaRequests;
  let traffic;
  const view = { lat: 52, lng: 4, altitude: 0.05 };
  const elsFor = () => ({
    flights: element(),
    military: element(),
    satellites: element(),
    group: element(),
    groupRow: element(),
    status: element(),
    credits: { flights: element(), satellites: element(), adsbName: element() },
  });

  // Runs frames for `ms` of (fake) time, 100 ms apart, with the camera at `pov`.
  async function run(ms, pov = view) {
    for (let t = 0; t < ms; t += 100) {
      traffic.frame(performance.now(), pov);
      await vi.advanceTimersByTimeAsync(100);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubGlobal('document', { hidden: false, createElement: () => ({ textContent: '' }) });
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1 });
    // Flights are switched on.
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ flights: true }), setItem() {} });
    vi.stubGlobal('Option', function Option(label, value) {
      Object.assign(this, { label, value });
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    areaRequests = 0;
    respond = () => feed([klm()]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        // The area feed is asked through the API first.
        if (/\/flights\/area/.test(url)) areaRequests++;
        if (!/\/flights\/area/.test(url) && !/point|\/lat\//.test(url)) throw new TypeError('Failed to fetch');
        const answer = respond();
        if (answer instanceof Error) throw answer;
        return { ok: true, json: async () => answer };
      }),
    );
    traffic = setupTraffic({ globe: { getGlobeRadius: () => 100 }, els: elsFor(), onSelect() {}, onDeselect() {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('selectedAircraft', () => {
    it('is the latest report of the selected aircraft, and follows the aircraft across updates', async () => {
      await run(300);
      expect(traffic.selectedAircraft()).toBeNull();
      traffic.select({ kind: 'aircraft', id: '484506' });
      expect(traffic.selectedAircraft()).toMatchObject({ id: '484506', callsign: 'KLM42', lat: 52.3, lng: 4.76, altitudeFt: 30000, speedKt: 450, track: 90, onGround: false });
      // The next report moves it, and a new object replaces the old one in the store.
      respond = () => feed([klm({ lat: 52.31, lon: 4.85, track: 95 })]);
      await run(16_000);
      expect(traffic.selectedAircraft()).toMatchObject({ lat: 52.31, lng: 4.85, track: 95 });
    });

    it('is null for no selection, for a satellite and after deselecting', async () => {
      await run(300);
      expect(traffic.selectedAircraft()).toBeNull();
      traffic.select({ kind: 'aircraft', id: '484506' });
      traffic.deselect();
      expect(traffic.selectedAircraft()).toBeNull();
    });

    it('is null once the aircraft is no longer received, while it stays selected', async () => {
      await run(300);
      traffic.select({ kind: 'aircraft', id: '484506' });
      expect(traffic.selectedAircraft()).not.toBeNull();
      // Eight minutes on, only another aircraft is heard from (a report older than seven minutes is dropped).
      respond = () => feed([klm({ hex: 'abcdef', flight: 'OTHER', lat: 51, lon: 3 })]);
      await run(8 * 60_000);
      expect(traffic.selected).toMatchObject({ kind: 'aircraft', id: '484506' });
      expect(traffic.selectedAircraft()).toBeNull();
      expect(traffic.detailsHtml()).toContain('No longer received.');
    });
  });

  describe('flights around the view', () => {
    it('asks again at once when the view has moved on, after an answer', async () => {
      await run(300);
      expect(areaRequests).toBe(1);
      // About 100 nautical miles away, far more than half of the radius of a view this high.
      await run(500, { ...view, lat: 53.7 });
      expect(areaRequests).toBe(2);
    });

    it('waits for the retry time after a failure, however far the view moves', async () => {
      await run(300);
      expect(areaRequests).toBe(1);
      // The feed stops answering.
      respond = () => new Error('Power Globe API: answered 502');
      await run(15_000);
      expect(areaRequests).toBe(2);
      // Moving the view on, many times over, does not ask again before the minute is up.
      for (let lat = 54; lat < 58; lat += 0.5) await run(1000, { ...view, lat });
      expect(areaRequests).toBe(2);
      // When it is up, it asks once, for where the view is then.
      await run(60_000, { ...view, lat: 58 });
      expect(areaRequests).toBe(3);
    });

    it('asks at once again after the feed has come back', async () => {
      await run(300);
      respond = () => new Error('Power Globe API: answered 502');
      await run(15_000);
      expect(areaRequests).toBe(2);
      respond = () => feed([klm()]);
      await run(60_000);
      expect(areaRequests).toBe(3);
      await run(500, { ...view, lat: 56 });
      expect(areaRequests).toBe(4);
    });
  });
});
