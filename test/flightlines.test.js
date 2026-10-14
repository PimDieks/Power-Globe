import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupFlightLines } from '../src/flightlines.js';

// The lines draw with three.js; these keep what they were given.
const drawn = vi.hoisted(() => ({ lines: [] }));
vi.mock('../src/trafficlayer.js', () => ({
  flightLine: (globe, options) => {
    const line = {
      options,
      flat: null,
      visible: false,
      sets: 0,
      ends: [],
      starts: [],
      set(flat) {
        this.flat = Array.from(flat);
        this.sets++;
        this.visible = true;
      },
      moveEnd(x, y, z) {
        this.ends.push([x, y, z]);
      },
      moveStart(x, y, z) {
        this.starts.push([x, y, z]);
      },
      hide() {
        this.visible = false;
      },
      setViewport() {},
      set dash(v) {
        this.dashed = v;
      },
      set gap(v) {
        this.gapped = v;
      },
    };
    drawn.lines.push(line);
    return line;
  },
}));

const AMS = { ident: 'EHAM', iata: 'AMS', name: 'Amsterdam Airport Schiphol', lat: 52.3086, lng: 4.76389, large: true, scheduled: true };
const LHR = { ident: 'EGLL', iata: 'LHR', name: 'London Heathrow Airport', lat: 51.4706, lng: -0.461941, large: true, scheduled: true };
const ROUTE = [
  { code: 'LHR', icao: 'EGLL', name: LHR.name, lat: LHR.lat, lng: LHR.lng },
  { code: 'AMS', icao: 'EHAM', name: AMS.name, lat: AMS.lat, lng: AMS.lng },
];
// The track of KLM66A from Heathrow as the page gets it from the API (see trackFromApi).
const point = (t, lat, lng, altitudeFt, onGround = false) => ({ t, lat, lng, altitudeFt, onGround });
const flown = (overrides = {}) => ({
  callsign: 'KLM66A',
  endTime: 1200,
  points: [point(1000, 51.4776, -0.4469, -300), point(1100, 51.55, 0.1, 12000), point(1200, 51.7, 0.6, 20000)],
  ...overrides,
});
// A report like the aircraft store's, over the sea between London and Amsterdam, 100 s after the track.
const report = (overrides = {}) => ({ id: '486898', callsign: 'KLM66A', seen: 1_300_000, lat: 51.9, lng: 1.2, altitudeFt: 24000, speedKt: 450, track: 78, onGround: false, ...overrides });

// Scene points as lat, lng and altitude, so that a test can read them.
const scenePoint = (lat, lng, altitude, out, i) => {
  out[3 * i] = lat;
  out[3 * i + 1] = lng;
  out[3 * i + 2] = altitude;
};

describe('the lines of the selected aircraft', () => {
  let lines;
  let past;
  let ahead;
  let labels;
  let deps;
  let clock;
  const near = (values) => values.map((v) => Math.round(v * 1e4) / 1e4);
  const settle = () => vi.advanceTimersByTimeAsync(0);
  // Shows an aircraft's report (as the page's frame does) and lets what was asked for come in.
  const show = async (ac, estimate = ac) => {
    lines.frame(ac, estimate, 0.05);
    await settle();
    lines.frame(ac, estimate, 0.05);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    drawn.lines.length = 0;
    labels = [];
    clock = 0;
    deps = {
      loadTrack: vi.fn(async () => flown()),
      loadRoute: vi.fn(async () => ROUTE),
      loadAirports: vi.fn(async () => [AMS, LHR]),
    };
    lines = setupFlightLines({ globe: { getGlobeRadius: () => 100, scene: () => ({ add() {} }) }, scenePoint, onLabels: (list) => labels.push(list), now: () => clock, ...deps });
    [past, ahead] = drawn.lines;
    vi.stubGlobal('window', { innerHeight: 800 });
  });

  it('asks for nothing and draws nothing until an aircraft is selected', async () => {
    lines.frame(report(), report(), 0.05);
    await settle();
    expect(deps.loadTrack).not.toHaveBeenCalled();
    expect(deps.loadRoute).not.toHaveBeenCalled();
    expect(deps.loadAirports).not.toHaveBeenCalled();
    expect(past.sets).toBe(0);
    expect(lines.info()).toBeNull();
  });

  it('draws the track from the departure airport to the aircraft, and the way on to the destination', async () => {
    lines.start('486898');
    expect(deps.loadTrack).toHaveBeenCalledWith('486898', { fresh: false });
    await show(report());
    // The track, the aircraft's report and the aircraft's own position as the end.
    expect(past.flat).toHaveLength(5 * 3);
    expect(near(past.flat.slice(0, 3))).toEqual([51.4776, -0.4469, 0]);
    expect(near([past.flat.at(-3)])).toEqual([51.9]);
    expect(past.flat.slice(3, 6)[2]).toBeGreaterThan(0);
    // Taken off from Heathrow, going to Amsterdam.
    expect(lines.info()).toEqual({ trackState: 'ok', from: { code: 'LHR', name: LHR.name }, to: { code: 'AMS', name: AMS.name } });
    expect(labels.at(-1)).toEqual([
      { lat: LHR.lat, lng: LHR.lng, text: 'LHR', title: LHR.name, ident: 'EGLL', kind: 'from' },
      { lat: AMS.lat, lng: AMS.lng, text: 'AMS', title: AMS.name, ident: 'EHAM', kind: 'to' },
    ]);
    // From the aircraft to the airport, sinking to the ground there.
    expect(ahead.visible).toBe(true);
    expect(near(ahead.flat.slice(0, 2))).toEqual([51.9, 1.2]);
    expect(ahead.flat.slice(2, 3)[0]).toBeGreaterThan(0);
    expect(ahead.flat.slice(-3)[2]).toBe(0);
    expect(near(ahead.flat.slice(-3, -1))).toEqual(near([AMS.lat, AMS.lng]));
    expect(ahead.options.dashed).toBe(true);
  });

  it('keeps clear of the aircraft by the radius of its sprite, at the end of the solid line and the start of the dashed', () => {
    expect(past.options.tip).toBe('end');
    expect(ahead.options.tip).toBe('start');
    lines.setSprite(4.4);
    expect([past.gapped, ahead.gapped]).toEqual([4.4, 4.4]);
  });

  it('draws only where it has been when the route does not fit, and names no destination', async () => {
    // A cargo flight whose route in the database is Liege to Madrid.
    deps.loadRoute.mockResolvedValue([
      { code: 'LGG', name: 'Liege Airport', lat: 50.6374, lng: 5.44322 },
      { code: 'MAD', name: 'Madrid Barajas Airport', lat: 40.4719, lng: -3.56264 },
    ]);
    lines.start('486898');
    await show(report());
    expect(past.visible).toBe(true);
    expect(ahead.visible).toBe(false);
    expect(lines.info().to).toBeNull();
    expect(lines.info().from.code).toBe('LHR');
    expect(labels.at(-1).map((l) => l.kind)).toEqual(['from']);
  });

  it('draws no destination for an aircraft with no route in the database', async () => {
    deps.loadRoute.mockResolvedValue(null);
    lines.start('486898');
    await show(report({ callsign: 'GLWLKR' }));
    expect(ahead.visible).toBe(false);
    expect(lines.info().to).toBeNull();
    // An aircraft with no callsign has no route to look up.
    lines.stop();
    deps.loadRoute.mockClear();
    lines.start('abcdef');
    await show(report({ id: 'abcdef', callsign: '' }), null);
    expect(deps.loadRoute).not.toHaveBeenCalled();
    expect(past.visible).toBe(true);
  });

  it('draws the path seen since selection when there is no track, and says so', async () => {
    deps.loadTrack.mockResolvedValue({ points: [], endTime: null, callsign: '' });
    lines.start('486898');
    await show(report());
    expect(lines.info()).toMatchObject({ trackState: 'none', from: null });
    expect(past.flat).toHaveLength(2 * 3);
    // The next report extends it.
    lines.frame(report({ seen: 1_315_000, lat: 51.95, lng: 1.4 }), report({ seen: 1_315_000, lat: 51.95, lng: 1.4 }), 0.05);
    expect(past.flat).toHaveLength(3 * 3);
    expect(near(past.flat.slice(3, 5))).toEqual([51.95, 1.4]);
    // Without a track the route is judged by where the aircraft is, and where it is heading.
    expect(lines.info().to.code).toBe('AMS');
  });

  it('does not draw a route flown the other way when there is no track', async () => {
    deps.loadTrack.mockResolvedValue({ points: [], endTime: null, callsign: '' });
    lines.start('486898');
    // Amsterdam to Heathrow under the Heathrow to Amsterdam callsign: heading south west.
    await show(report({ track: 258 }));
    expect(lines.info().to).toBeNull();
    expect(ahead.visible).toBe(false);
  });

  it('asks for the airport list only for a track that began low, and leaves out a departure not near an airport', async () => {
    deps.loadTrack.mockResolvedValue(flown({ points: flown().points.map((p) => ({ ...p, lat: p.lat + 3 })) }));
    lines.start('486898');
    await show(report({ lat: 54.9 }));
    expect(deps.loadAirports).toHaveBeenCalledTimes(1);
    expect(lines.info().from).toBeNull();
    expect(past.visible).toBe(true);
    // A track that began high, or none, needs no list.
    for (const track of [flown({ points: [point(1000, 51.4776, -0.4469, 30000), ...flown().points.slice(1)] }), { points: [], endTime: null, callsign: '' }]) {
      lines.stop();
      deps.loadAirports.mockClear();
      deps.loadTrack.mockResolvedValue(track);
      lines.start('486899');
      await show(report({ id: '486899' }));
      expect(deps.loadAirports).not.toHaveBeenCalled();
      expect(lines.info().from).toBeNull();
    }
  });

  it('names no departure for a track that began on approach', async () => {
    // From 3,000 ft over Schiphol, going down: Amsterdam is where it lands.
    deps.loadTrack.mockResolvedValue(flown({ points: [point(1000, 52.33, 4.85, 3000), point(1100, 52.31, 4.78, 1200), point(1200, 52.3, 4.76, 0, true)] }));
    lines.start('486898');
    await show(report({ lat: 52.3, lng: 4.77, altitudeFt: 0, onGround: true, seen: 1_250_000 }));
    expect(lines.info().from).toBeNull();
  });

  it('draws a missing altitude as the last known, not a drop to the ground', async () => {
    deps.loadTrack.mockResolvedValue({ points: [], endTime: null, callsign: '' });
    lines.start('486898');
    await show(report());
    lines.frame(report({ seen: 1_315_000, lat: 51.95, lng: 1.4, altitudeFt: null }), null, 0.05);
    lines.frame(report({ seen: 1_330_000, lat: 52, lng: 1.6, altitudeFt: null }), null, 0.05);
    const heights = [past.flat[2], past.flat[5], past.flat[8]];
    expect(heights[0]).toBeGreaterThan(0);
    expect(heights[1]).toBe(heights[0]);
    expect(heights[2]).toBe(heights[0]);
    // On the ground it is at the ground.
    lines.frame(report({ seen: 1_345_000, lat: 52.05, lng: 1.8, altitudeFt: null, onGround: true }), null, 0.05);
    expect(past.flat[11]).toBe(0);
  });

  it('draws nothing for an aircraft with an address that is not an ICAO one, and asks no track for it', async () => {
    lines.start('486898', { nonIcao: true });
    await show(report());
    expect(deps.loadTrack).not.toHaveBeenCalled();
    expect(lines.info().trackState).toBe('none');
    expect(past.visible).toBe(true);
    lines.stop();
    lines.start('xyz', {});
    expect(deps.loadTrack).not.toHaveBeenCalled();
  });

  describe('a track that is not this flight', () => {
    const none = async (track, ac = report()) => {
      deps.loadTrack.mockResolvedValue(track);
      lines.start('486898');
      await show(ac);
      expect(lines.info().trackState).toBe('none');
      expect(lines.info().from).toBeNull();
      // Its first point is not where the line starts.
      expect(near(past.flat.slice(0, 2))).toEqual([ac.lat, ac.lng]);
    };

    it('is dropped when it is the flight before: it ended long before the aircraft was last heard', async () => {
      await none(flown({ endTime: 200, points: flown().points.map((p) => ({ ...p, t: p.t - 1000 })) }));
    });

    it('is dropped when it is the track of another callsign', async () => {
      await none(flown({ callsign: 'EZY48YK' }));
    });

    it('is dropped when it ends far from the aircraft', async () => {
      await none(flown({ points: flown().points.map((p) => ({ ...p, lat: p.lat + 2 })) }));
    });

    it('is used when it ends where the aircraft was a little before, even if the callsign is not known', async () => {
      deps.loadTrack.mockResolvedValue(flown({ callsign: '' }));
      lines.start('486898');
      await show(report());
      expect(lines.info().trackState).toBe('ok');
    });
  });

  it('changes its geometry only when a report comes in, moving just the aircraft\'s end between', async () => {
    lines.start('486898');
    await show(report());
    const sets = [past.sets, ahead.sets];
    const ends = past.ends.length;
    for (let k = 1; k <= 5; k++) lines.frame(report(), { lat: 51.9 + k * 0.001, lng: 1.2 }, 0.05);
    expect([past.sets, ahead.sets]).toEqual(sets);
    expect(past.ends.length).toBe(ends + 5);
    // The dashed line starts at the aircraft too, and moves with it.
    expect(ahead.starts.length).toBeGreaterThanOrEqual(5);
    // The same estimate again moves nothing.
    lines.frame(report(), { lat: 51.905, lng: 1.2 }, 0.05);
    expect(past.ends.length).toBe(ends + 5);
    // A new report draws the lines again.
    lines.frame(report({ seen: 1_315_000, lat: 51.95 }), { lat: 51.95, lng: 1.2 }, 0.05);
    expect(past.sets).toBe(sets[0] + 1);
    expect(ahead.sets).toBe(sets[1] + 1);
  });

  it('removes everything when the aircraft is deselected, and ignores answers that come late', async () => {
    let giveTrack;
    deps.loadTrack.mockReturnValue(new Promise((resolve) => (giveTrack = resolve)));
    lines.start('486898');
    lines.frame(report(), report(), 0.05);
    expect(past.visible).toBe(true);
    lines.stop();
    expect(past.visible).toBe(false);
    expect(ahead.visible).toBe(false);
    expect(labels.at(-1)).toEqual([]);
    expect(lines.info()).toBeNull();
    giveTrack(flown());
    await settle();
    expect(past.visible).toBe(false);
    expect(labels.at(-1)).toEqual([]);
    // And after the next selection nothing of the first is left.
    deps.loadTrack.mockResolvedValue({ points: [], endTime: null, callsign: '' });
    lines.start('abcdef');
    await show(report({ id: 'abcdef', lat: 10, lng: 10, callsign: '' }), null);
    expect(near(past.flat.slice(0, 2))).toEqual([10, 10]);
  });

  it('keeps what it has when the same aircraft is selected again', async () => {
    lines.start('486898');
    await show(report());
    lines.start('486898');
    expect(deps.loadTrack).toHaveBeenCalledTimes(1);
    expect(past.visible).toBe(true);
  });

  it('draws an aircraft that has landed at its destination without a line on to it', async () => {
    deps.loadTrack.mockResolvedValue(flown({ points: [point(1000, 51.4776, -0.4469, -300), point(1100, 52.0, 3.0, 12000), point(1200, 52.3, 4.7, 0, true)] }));
    const landed = report({ lat: AMS.lat + 0.01, lng: AMS.lng, altitudeFt: 0, onGround: true, seen: 1_250_000 });
    lines.start('486898');
    await show(landed);
    expect(lines.info().to.code).toBe('AMS');
    expect(ahead.visible).toBe(false);
  });

  describe('a flight that is not the one being drawn any more', () => {
    it('looks up the route when the callsign arrives late', async () => {
      lines.start('486898');
      await show(report({ callsign: '' }));
      expect(deps.loadRoute).not.toHaveBeenCalled();
      expect(lines.info().to).toBeNull();
      await show(report({ callsign: 'KLM66A', seen: 1_315_000 }));
      expect(deps.loadRoute).toHaveBeenCalledWith('KLM66A');
      expect(lines.info().to.code).toBe('AMS');
      expect(ahead.visible).toBe(true);
      // The track was not asked for again.
      expect(deps.loadTrack).toHaveBeenCalledTimes(1);
    });

    it('starts afresh when the callsign changes: a new flight, with its own track and route', async () => {
      lines.start('486898');
      await show(report());
      expect(lines.info().to.code).toBe('AMS');
      // The aircraft goes on as another flight, to Berlin.
      const berlin = [{ code: 'AMS', icao: 'EHAM', name: AMS.name, lat: AMS.lat, lng: AMS.lng }, { code: 'BER', icao: 'EDDB', name: 'Berlin Brandenburg Airport', lat: 52.3667, lng: 13.5033 }];
      deps.loadRoute.mockResolvedValue(berlin);
      deps.loadTrack.mockResolvedValue({ points: [], endTime: null, callsign: '' });
      lines.frame(report({ callsign: 'KLM1930', seen: 1_400_000, lat: 52.3, lng: 4.8, onGround: true, altitudeFt: 0 }), null, 0.05);
      expect(deps.loadTrack).toHaveBeenLastCalledWith('486898', { fresh: true });
      expect(deps.loadRoute).toHaveBeenLastCalledWith('KLM1930');
      expect(lines.info()).toMatchObject({ trackState: 'loading', from: null, to: null });
      expect(labels.at(-1)).toEqual([]);
      await settle();
      lines.frame(report({ callsign: 'KLM1930', seen: 1_400_000, lat: 52.3, lng: 4.8, onGround: true, altitudeFt: 0 }), null, 0.05);
      expect(lines.info().to.code).toBe('BER');
    });

    it('starts afresh when the aircraft takes off again after being on the ground, so no line goes back to where it left', async () => {
      // It arrived at Amsterdam as the flight from Heathrow, and stood there.
      const landed = (overrides = {}) => report({ lat: AMS.lat + 0.01, lng: AMS.lng, altitudeFt: 0, onGround: true, track: 90, seen: 1_250_000, ...overrides });
      deps.loadTrack.mockResolvedValue(flown({ points: [point(1000, 51.4776, -0.4469, -300), point(1100, 52.0, 3.0, 12000), point(1200, 52.3, 4.7, 0, true)] }));
      lines.start('486898');
      await show(landed());
      expect(lines.info().to.code).toBe('AMS');
      // Minutes later, still with the callsign it had, it takes off and heads away.
      clock = 5 * 60_000;
      deps.loadTrack.mockResolvedValue({ points: [point(1560, 52.3, 4.75, 0, true), point(1600, 52.2, 4.2, 3000)], endTime: 1600, callsign: 'KLM66A' });
      const flying = report({ lat: 52.2, lng: 4.2, altitudeFt: 3000, track: 260, speedKt: 200, seen: 1_620_000 });
      lines.frame(flying, null, 0.05);
      expect(deps.loadTrack).toHaveBeenLastCalledWith('486898', { fresh: true });
      await settle();
      lines.frame(flying, null, 0.05);
      // The route is asked for again, and does not fit: the flight began at Amsterdam, not Heathrow.
      expect(deps.loadRoute).toHaveBeenCalledTimes(2);
      expect(lines.info().to).toBeNull();
      expect(ahead.visible).toBe(false);
      expect(labels.at(-1).map((l) => l.kind)).toEqual(['from']);
      expect(lines.info().from.code).toBe('AMS');
    });

    it('does not start afresh for an aircraft that is on the ground for a moment as it lands', async () => {
      lines.start('486898');
      await show(report({ lat: 52.3, lng: 4.7, altitudeFt: 0, onGround: true, seen: 1_300_000 }));
      clock = 10_000;
      lines.frame(report({ lat: 52.3, lng: 4.7, altitudeFt: 30, onGround: false, seen: 1_310_000 }), null, 0.05);
      expect(deps.loadTrack).toHaveBeenCalledTimes(1);
    });
  });
});
