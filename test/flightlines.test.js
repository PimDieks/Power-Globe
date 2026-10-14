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
      set(flat) {
        this.flat = Array.from(flat);
        this.sets++;
        this.visible = true;
      },
      moveEnd(x, y, z) {
        this.ends.push([x, y, z]);
      },
      hide() {
        this.visible = false;
      },
      setViewport() {},
      set dash(v) {
        this.dashed = v;
      },
    };
    drawn.lines.push(line);
    return line;
  },
}));

const AMS = { ident: 'EHAM', iata: 'AMS', name: 'Amsterdam Airport Schiphol', lat: 52.3086, lng: 4.76389 };
const LHR = { ident: 'EGLL', iata: 'LHR', name: 'London Heathrow Airport', lat: 51.4706, lng: -0.461941 };
const ROUTE = [
  { code: 'LHR', name: LHR.name, lat: LHR.lat, lng: LHR.lng },
  { code: 'AMS', name: AMS.name, lat: AMS.lat, lng: AMS.lng },
];
const TRACK = [
  { t: 1000, lat: 51.4776, lng: -0.4469, altitudeFt: -300, onGround: false },
  { t: 1100, lat: 51.55, lng: 0.1, altitudeFt: 12000, onGround: false },
  { t: 1200, lat: 51.7, lng: 0.6, altitudeFt: 20000, onGround: false },
];
// A report like the aircraft store's, over the sea between London and Amsterdam.
const report = (overrides = {}) => ({ id: '486898', callsign: 'KLM66A', seen: 1_300_000, lat: 51.9, lng: 1.2, altitudeFt: 24000, onGround: false, ...overrides });

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
  const near = (values) => values.map((v) => Math.round(v * 1e4) / 1e4);
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    drawn.lines.length = 0;
    labels = [];
    deps = {
      loadTrack: vi.fn(async () => TRACK),
      loadRoute: vi.fn(async () => ROUTE),
      loadAirports: vi.fn(async () => [AMS, LHR]),
    };
    lines = setupFlightLines({ globe: { getGlobeRadius: () => 100, scene: () => ({ add() {} }) }, scenePoint, onLabels: (list) => labels.push(list), ...deps });
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
    expect(deps.loadTrack).toHaveBeenCalledWith('486898');
    const now = report();
    lines.frame(now, now, 0.05);
    await settle();
    lines.frame(now, now, 0.05);
    // The track, the aircraft's report and the aircraft's own position as the end.
    expect(past.flat).toHaveLength(5 * 3);
    expect(near(past.flat.slice(0, 3))).toEqual([51.4776, -0.4469, 0]);
    expect(near([past.flat.at(-3)])).toEqual([51.9]);
    expect(past.flat.slice(3, 6)[2]).toBeGreaterThan(0);
    // Taken off from Heathrow, going to Amsterdam.
    expect(lines.info()).toEqual({ trackState: 'ok', from: { code: 'LHR', name: LHR.name }, to: { code: 'AMS', name: AMS.name } });
    expect(labels.at(-1)).toEqual([
      { lat: LHR.lat, lng: LHR.lng, text: 'LHR', title: LHR.name, kind: 'from' },
      { lat: AMS.lat, lng: AMS.lng, text: 'AMS', title: AMS.name, kind: 'to' },
    ]);
    // From the aircraft to the airport, sinking to the ground there.
    expect(ahead.visible).toBe(true);
    expect(near(ahead.flat.slice(0, 2))).toEqual([51.9, 1.2]);
    expect(ahead.flat.slice(2, 3)[0]).toBeGreaterThan(0);
    expect(ahead.flat.slice(-3)[2]).toBe(0);
    expect(near(ahead.flat.slice(-3, -1))).toEqual(near([AMS.lat, AMS.lng]));
    expect(ahead.options.dashed).toBe(true);
  });

  it('draws only where it has been when the route does not fit, and names no destination', async () => {
    // A cargo flight whose route in the database is Liege to Madrid.
    deps.loadRoute.mockResolvedValue([
      { code: 'LGG', name: 'Liege Airport', lat: 50.6374, lng: 5.44322 },
      { code: 'MAD', name: 'Madrid Barajas Airport', lat: 40.4719, lng: -3.56264 },
    ]);
    lines.start('486898');
    const now = report();
    lines.frame(now, now, 0.05);
    await settle();
    expect(past.visible).toBe(true);
    expect(ahead.visible).toBe(false);
    expect(lines.info().to).toBeNull();
    expect(lines.info().from.code).toBe('LHR');
    expect(labels.at(-1).map((l) => l.kind)).toEqual(['from']);
  });

  it('draws no destination for an aircraft with no route in the database', async () => {
    deps.loadRoute.mockResolvedValue(null);
    lines.start('486898');
    const now = report({ callsign: 'GLWLKR' });
    lines.frame(now, now, 0.05);
    await settle();
    expect(ahead.visible).toBe(false);
    expect(lines.info().to).toBeNull();
    // An aircraft with no callsign has no route to look up.
    lines.stop();
    deps.loadRoute.mockClear();
    lines.start('abcdef');
    lines.frame(report({ id: 'abcdef', callsign: '' }), null, 0.05);
    await settle();
    expect(deps.loadRoute).not.toHaveBeenCalled();
    expect(past.visible).toBe(true);
  });

  it('draws the path seen since selection when there is no track, and says so', async () => {
    deps.loadTrack.mockResolvedValue([]);
    lines.start('486898');
    lines.frame(report(), report(), 0.05);
    await settle();
    expect(lines.info()).toMatchObject({ trackState: 'none', from: null });
    expect(past.flat).toHaveLength(2 * 3);
    // The next report extends it.
    lines.frame(report({ seen: 1_315_000, lat: 51.95, lng: 1.4 }), report({ seen: 1_315_000, lat: 51.95, lng: 1.4 }), 0.05);
    expect(past.flat).toHaveLength(3 * 3);
    expect(near(past.flat.slice(3, 5))).toEqual([51.95, 1.4]);
    // Without a track the route is judged by where the aircraft is alone, and fits.
    expect(lines.info().to.code).toBe('AMS');
  });

  it('leaves out a departure that is not near an airport, or from a track that starts high', async () => {
    deps.loadTrack.mockResolvedValue(TRACK.map((p) => ({ ...p, lat: p.lat + 3 })));
    lines.start('486898');
    lines.frame(report(), report(), 0.05);
    await settle();
    expect(lines.info().from).toBeNull();
    expect(past.visible).toBe(true);
    lines.stop();
    deps.loadTrack.mockResolvedValue([{ ...TRACK[0], altitudeFt: 30000 }, ...TRACK.slice(1)]);
    lines.start('486899');
    lines.frame(report({ id: '486899' }), report(), 0.05);
    await settle();
    expect(lines.info().from).toBeNull();
  });

  it('changes its geometry only when a report comes in, moving just the aircraft\'s end between', async () => {
    lines.start('486898');
    lines.frame(report(), report(), 0.05);
    await settle();
    lines.frame(report(), report(), 0.05);
    const sets = [past.sets, ahead.sets];
    const ends = past.ends.length;
    for (let k = 1; k <= 5; k++) lines.frame(report(), { lat: 51.9 + k * 0.001, lng: 1.2 }, 0.05);
    expect([past.sets, ahead.sets]).toEqual(sets);
    expect(past.ends.length).toBe(ends + 5);
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
    giveTrack(TRACK);
    await settle();
    expect(past.visible).toBe(false);
    expect(labels.at(-1)).toEqual([]);
    // And after the next selection nothing of the first is left.
    deps.loadTrack.mockResolvedValue([]);
    lines.start('abcdef');
    lines.frame(report({ id: 'abcdef', lat: 10, lng: 10, callsign: '' }), null, 0.05);
    await settle();
    expect(near(past.flat.slice(0, 2))).toEqual([10, 10]);
  });

  it('keeps what it has when the same aircraft is selected again', async () => {
    lines.start('486898');
    lines.frame(report(), report(), 0.05);
    await settle();
    lines.start('486898');
    expect(deps.loadTrack).toHaveBeenCalledTimes(1);
    expect(past.visible).toBe(true);
  });

  it('draws an aircraft that has landed at its destination without a line on to it', async () => {
    const landed = report({ lat: AMS.lat + 0.01, lng: AMS.lng, altitudeFt: 0, onGround: true, seen: 1_400_000 });
    lines.start('486898');
    lines.frame(landed, landed, 0.05);
    await settle();
    expect(lines.info().to.code).toBe('AMS');
    expect(ahead.visible).toBe(false);
  });
});
