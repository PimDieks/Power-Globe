import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTraffic } from '../src/traffic.js';
import { clearFlightCaches } from '../src/flightroute.js';

// The lines drawn for the selected aircraft, solid first, then dashed.
const drawn = vi.hoisted(() => ({ lines: [] }));

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
  const line = () => {
    const made = { visible: false, set() { this.visible = true; }, moveEnd() {}, hide() { this.visible = false; }, setViewport() {}, set dash(v) {} };
    drawn.lines.push(made);
    return made;
  };
  return { ...(await importOriginal()), aircraftLayer: cloud, satelliteLayer: cloud, selectionRing: cloud, orbitLine: () => ({ show() {}, hide() {} }), flightLine: line };
});

const START = Date.parse('2026-10-14T12:00:00Z');
// The Power Globe API's answer for flights around a point: { source, data } with an ADS-B Exchange style list.
const feed = (aircraft) => ({ source: 'adsb.lol', data: { now: Date.now(), ac: aircraft } });
const klm = (overrides = {}) => ({ hex: '484506', flight: 'KLM42', lat: 52.3, lon: 4.76, alt_baro: 30000, gs: 450, track: 90, seen_pos: 1, ...overrides });

const element = () => ({ checked: false, value: '', hidden: false, addEventListener(type, fn) {
    this.listener = fn;
  }, replaceChildren() {}, textContent: '' });

describe('traffic on the globe', () => {
  let respond;
  let areaRequests;
  let traffic;
  let els;
  let deselected;
  let stored;
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

  // Sets up the traffic module with the layers saved in `stored`.
  function start() {
    els = elsFor();
    deselected = 0;
    traffic = setupTraffic({ globe: { getGlobeRadius: () => 100 }, els, onSelect() {}, onDeselect: () => deselected++ });
  }
  // Switches a layer toggle, as a visitor does.
  function toggle(name, checked) {
    els[name].checked = checked;
    els[name].listener();
  }

  beforeEach(() => {
    clearFlightCaches();
    drawn.lines.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(START);
    vi.stubGlobal('document', { hidden: false, createElement: () => ({ textContent: '' }) });
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1 });
    // Flights are switched on.
    stored = { flights: true };
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(stored), setItem() {} });
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
    start();
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

  describe('the lines of the selected aircraft', () => {
    const KLM66A = { hex: 'aa0001', flight: 'KLM66A', lat: 51.9, lon: 1.2, alt_baro: 24000, gs: 450, track: 60, seen_pos: 1 };
    const route = { airport_codes: 'EGLL-EHAM', _airports: [{ icao: 'EGLL', iata: 'LHR', name: 'London Heathrow Airport', lat: 51.4706, lon: -0.461941 }, { icao: 'EHAM', iata: 'AMS', name: 'Amsterdam Airport Schiphol', lat: 52.3086, lon: 4.76389 }] };
    let asked;

    // Answers the feed as the other tests do, and tracks, routes and airports as the services do.
    function services({ track = { points: [[1, 51.4776, -0.4469, -300, 0], [2, 51.6, 0.4, 15000, 0]] } } = {}) {
      const feedFetch = globalThis.fetch;
      asked = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url) => {
          if (url.includes('/track?')) {
            asked.push(url);
            return { ok: true, json: async () => track };
          }
          if (url.includes('vrs-standing-data')) {
            asked.push(url);
            return { ok: true, status: 200, json: async () => route };
          }
          if (url.includes('airports.json')) {
            return { ok: true, json: async () => ({ airports: [['EGLL', 'LHR', 'London Heathrow Airport', 'London', 'GB', 51.4706, -0.461941, 83, 1, 1, []]] }) };
          }
          return feedFetch(url);
        }),
      );
    }

    it('asks for nothing, and draws nothing, while no aircraft is selected', async () => {
      respond = () => feed([KLM66A]);
      services();
      await run(1500);
      expect(asked).toEqual([]);
      expect(drawn.lines.every((line) => !line.visible)).toBe(true);
    });

    it('draws the lines when an aircraft is selected, asks for its track and route once, and removes them on deselecting', async () => {
      respond = () => feed([KLM66A]);
      services();
      await run(300);
      traffic.select({ kind: 'aircraft', id: 'aa0001' });
      await run(1500);
      expect(asked).toEqual(['https://power-globe-api.pimdieks.workers.dev/track?icao24=aa0001', 'https://vrs-standing-data.adsb.lol/routes/KL/KLM66A.json']);
      const [past, ahead] = drawn.lines;
      expect(past.visible).toBe(true);
      expect(ahead.visible).toBe(true);
      expect(traffic.flightInfo()).toMatchObject({ trackState: 'ok', from: { code: 'LHR' }, to: { code: 'AMS' } });
      expect(traffic.detailsHtml()).toContain('Amsterdam Airport Schiphol (AMS)');
      traffic.deselect();
      expect(past.visible).toBe(false);
      expect(ahead.visible).toBe(false);
      expect(traffic.flightInfo()).toBeNull();
      // Selected again soon after, it is not asked for again.
      traffic.select({ kind: 'aircraft', id: 'aa0001' });
      await run(1500);
      expect(asked).toHaveLength(2);
      expect(past.visible).toBe(true);
    });

    it('draws what it has seen of an aircraft whose track cannot be had', async () => {
      respond = () => feed([{ ...KLM66A, hex: 'aa0002', flight: 'GLWLKR' }]);
      services({ track: { points: [] } });
      await run(300);
      traffic.select({ kind: 'aircraft', id: 'aa0002' });
      await run(1500);
      expect(drawn.lines[0].visible).toBe(true);
      expect(traffic.detailsHtml()).toContain('Track not available');
    });
  });

  describe('the layers an aircraft belongs to', () => {
    const mil = { hex: 'ae1234', flight: 'RCH123', lat: 52.4, lon: 4.8, alt_baro: 28000, gs: 420, track: 85, seen_pos: 1, dbFlags: 1 };

    it('drops the selected civil aircraft when Flights is switched off, though Military flights is on', async () => {
      stored = { flights: true, military: true };
      start();
      await run(300);
      traffic.select({ kind: 'aircraft', id: '484506' });
      toggle('military', false);
      expect(deselected).toBe(0);
      toggle('military', true);
      toggle('flights', false);
      expect(deselected).toBe(1);
      expect(traffic.selected).toBeNull();
    });

    it('drops the selected military aircraft when Military flights is switched off, though Flights is on', async () => {
      stored = { flights: true, military: true };
      respond = () => feed([klm(), mil]);
      start();
      await run(300);
      traffic.select({ kind: 'aircraft', id: 'ae1234' });
      expect(traffic.selectedAircraft()).toMatchObject({ military: true });
      toggle('flights', false);
      expect(deselected).toBe(0);
      toggle('flights', true);
      toggle('military', false);
      expect(deselected).toBe(1);
      expect(traffic.selected).toBeNull();
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
