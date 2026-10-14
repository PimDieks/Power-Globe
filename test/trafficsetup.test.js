import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTraffic, snapArea } from '../src/traffic.js';
import { clearFlightCaches } from '../src/flightroute.js';

// The lines drawn for the selected aircraft, solid first, then dashed.
const drawn = vi.hoisted(() => ({ lines: [], clouds: [] }));

// The layers draw with three.js on a globe; these keep the numbers and nothing else.
vi.mock('../src/trafficlayer.js', async (importOriginal) => {
  const cloud = () => {
    const attrs = { position: new Float32Array(30_000), aColor: new Float32Array(30_000), aScale: new Float32Array(10_000), aHeading: new Float32Array(10_000), aNext: new Float32Array(30_000) };
    const made = {
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
    made.attrs = attrs;
    drawn.clouds.push(made);
    return made;
  };
  const line = () => {
    const made = { visible: false, set(flat) { this.flat = flat; this.visible = true; }, moveEnd() {}, moveStart() {}, hide() { this.visible = false; }, setViewport() {}, set dash(v) {}, set gap(v) {} };
    drawn.lines.push(made);
    return made;
  };
  return { ...(await importOriginal()), aircraftLayer: cloud, satelliteLayer: cloud, selectionRing: cloud, markerLayer: cloud, orbitLine: () => ({ show() {}, hide() {} }), flightLine: line };
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
    drawn.clouds.length = 0;
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
    // The track of this flight from Heathrow up to a little behind the aircraft, as OpenSky would give it now.
    const flown = () => {
      const now = Date.now() / 1000;
      return { callsign: 'KLM66A', endTime: now - 120, points: [[now - 900, 51.4776, -0.4469, -300, 0], [now - 120, 51.85, 1.0, 15000, 0]] };
    };

    // Answers the feed as the other tests do, and tracks, routes and airports as the services do.
    function services({ track = flown() } = {}) {
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

  describe('the area watched for the Ops tab', () => {
    const EHAM = { lat: 52.3086, lng: 4.7639, nm: 200 };
    const watched = () => fetch.mock.calls.map((c) => c[0]).filter((u) => /lat=52.25&lon=4.75&nm=200/.test(u));

    it('rounds the area as the API does', () => {
      expect(snapArea({ lat: 52.3086, lng: 4.7639, nm: 200 })).toEqual({ lat: 52.25, lng: 4.75, nm: 200 });
      expect(snapArea({ lat: 51.47, lng: -0.46, nm: 120 })).toEqual({ lat: 51.5, lng: -0.5, nm: 125 });
      expect(snapArea({ lat: 10, lng: 10, nm: 900 }).nm).toBe(250);
    });

    it('asks for the area at once and every 15 seconds, whatever the view and the layers, and says so to the listener', async () => {
      stored = { flights: false };
      start();
      const heard = [];
      traffic.subscribe((e) => heard.push(e));
      expect(traffic.layerOn()).toBe(false);
      traffic.watchArea(EHAM);
      await run(300);
      expect(watched()).toHaveLength(1);
      expect(heard).toEqual([{ area: { lat: 52.25, lng: 4.75, nm: 200 }, name: 'adsb.lol' }]);
      // The aircraft are in, though not drawn.
      expect(traffic.aircraft().map((a) => a.id)).toEqual(['484506']);
      expect(traffic.has('484506')).toBe(true);
      await run(30_000, { lat: 0, lng: 0, altitude: 2 });
      expect(watched()).toHaveLength(3);
    });

    it('asks nothing for the view while only watching, stops on null, and keeps the same area asked once', async () => {
      stored = { flights: false };
      start();
      traffic.watchArea(EHAM);
      traffic.watchArea({ ...EHAM, lat: 52.3 });
      await run(300);
      expect(areaRequests).toBe(1);
      traffic.watchArea(null);
      await run(60_000);
      expect(areaRequests).toBe(1);
    });

    it('tells a listener when the feed fails, waits a minute, and stops telling it after unsubscribing', async () => {
      start();
      const heard = [];
      const stop = traffic.subscribe((e) => heard.push(e));
      respond = () => new Error('Power Globe API: answered 502');
      traffic.watchArea(EHAM);
      await run(300);
      expect(heard).toHaveLength(1);
      expect(heard[0].error).toContain('502');
      const before = watched().length;
      await run(30_000);
      expect(watched()).toHaveLength(before);
      stop();
      await run(40_000);
      expect(heard).toHaveLength(1);
    });

    it('does not report an answer for an area that is no longer watched (the stale-answer guard)', async () => {
      stored = { flights: false };
      start();
      const heard = [];
      traffic.subscribe((e) => heard.push(e));
      let moved = false;
      fetch.mockImplementation(async (url) => {
        // The watch is pointed elsewhere while its first request is under way.
        if (!moved && /lat=52.25&lon=4.75&nm=200/.test(url)) {
          moved = true;
          traffic.watchArea({ lat: 40, lng: -3, nm: 100 });
        }
        return { ok: true, json: async () => feed([klm()]) };
      });
      traffic.watchArea(EHAM);
      await run(300);
      expect(moved).toBe(true);
      expect(heard.map((e) => e.area?.lat)).not.toContain(52.25);
      expect(heard.map((e) => e.area?.lat)).toContain(40);
    });

    it('does not take a listener that throws for a failure of the feed, nor stop the others', async () => {
      stored = { flights: false };
      start();
      const heard = [];
      traffic.subscribe(() => {
        throw new Error('a bug in a listener');
      });
      traffic.subscribe((e) => heard.push(e));
      traffic.watchArea(EHAM);
      await run(300);
      expect(heard).toHaveLength(1);
      expect(heard[0].error).toBeUndefined();
      expect(heard[0].area).toEqual({ lat: 52.25, lng: 4.75, nm: 200 });
      // And it was asked for again in 15 seconds, not after the minute of a failure.
      await run(16_000);
      expect(heard).toHaveLength(2);
      expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'a bug in a listener' }));
    });

    it('asks nothing of its own while the area around the view, answered lately, covers it, and passes that answer on', async () => {
      const heard = [];
      const pov = { lat: 52.3, lng: 4.76, altitude: 0.05 };
      traffic.subscribe((e) => heard.push(e));
      await run(300, pov);
      // The view's area (150 NM after the API's rounding) holds the watch's 125.
      traffic.watchArea({ lat: 52.3086, lng: 4.7639, nm: 125 });
      await run(40_000, pov);
      const urls = fetch.mock.calls.map((c) => c[0]);
      expect(urls.some((u) => /nm=125/.test(u))).toBe(false);
      expect(heard.length).toBeGreaterThanOrEqual(2);
      expect(heard[0].area).toEqual({ lat: 52.25, lng: 4.75, nm: 150 });
    });

    it('asks for itself again once the view stops answering, or no longer covers the area', async () => {
      const pov = { lat: 52.3, lng: 4.76, altitude: 0.05 };
      await run(300, pov);
      traffic.watchArea({ lat: 52.3086, lng: 4.7639, nm: 125 });
      respond = () => new Error('Power Globe API: answered 502');
      await run(40_000, pov);
      expect(fetch.mock.calls.some((c) => /nm=125/.test(c[0]))).toBe(true);
    });

    it('adds at most one direct call to a provider a minute when the API will not answer', async () => {
      stored = { flights: false };
      start();
      const direct = [];
      fetch.mockImplementation(async (url) => {
        if (/power-globe-api/.test(url)) return { ok: false, status: 429, json: async () => ({ error: 'cooling off' }) };
        direct.push(Date.now());
        return { ok: true, json: async () => feed([klm()]) };
      });
      traffic.watchArea(EHAM);
      await run(3 * 60_000);
      expect(direct.length).toBeGreaterThanOrEqual(2);
      expect(direct.length).toBeLessThanOrEqual(4);
      for (let i = 1; i < direct.length; i++) expect(direct[i] - direct[i - 1]).toBeGreaterThanOrEqual(60_000);
    });

    it('tints the inbound aircraft and the holding ones, rings only the holding ones, and takes it all off', async () => {
      await run(300);
      const [planes, , , marks] = drawn.clouds;
      const color = (i) => [...planes.attrs.aColor.slice(3 * i, 3 * i + 3)].map((v) => Math.round(v * 100) / 100);
      expect(color(0)).toEqual([0.97, 0.95, 0.9]);
      traffic.setOverlay({ inbound: ['484506'], holding: [], stacks: [] });
      await run(300);
      expect(color(0)).toEqual([0.5, 0.82, 1]);
      expect(marks.count).toBe(0);
      traffic.setOverlay({ inbound: [], holding: ['484506'], stacks: [{ lat: 52.3, lng: 4.9, radiusNm: 8 }] });
      await run(300);
      expect(color(0)).toEqual([1, 0.62, 0.3]);
      expect(marks.count).toBe(1);
      // The ring is at the aircraft.
      expect([...marks.attrs.position.slice(0, 3)]).toEqual([...planes.attrs.position.slice(0, 3)]);
      // The stack is a closed circle of 49 points on the ground, about 8 miles round the middle.
      const circle = drawn.lines.at(-1);
      expect(circle.visible).toBe(true);
      expect(circle.flat).toHaveLength(49 * 3);
      expect([...circle.flat.slice(0, 3)]).toEqual([...circle.flat.slice(-3)]);
      traffic.setOverlay(null);
      await run(300);
      expect(color(0)).toEqual([0.97, 0.95, 0.9]);
      expect(marks.visible).toBe(false);
      expect(circle.visible).toBe(false);
    });

    it('draws nothing per frame once the rings are placed (no new buffers)', async () => {
      await run(300);
      const [, , , marks] = drawn.clouds;
      traffic.setOverlay({ inbound: [], holding: ['484506'], stacks: [] });
      await run(300);
      const position = marks.attrs.position;
      let reserved = 0;
      const reserve = marks.reserve;
      marks.reserve = (n) => {
        reserved++;
        return reserve(n);
      };
      await run(500);
      expect(marks.attrs.position).toBe(position);
      expect(reserved).toBeGreaterThan(0);
    });
  });
});
