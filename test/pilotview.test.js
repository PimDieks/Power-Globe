import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimatePosition } from '../src/aircraft.js';
import {
  EYE_HEIGHT_M,
  LOD_HIGH_M,
  LOD_NEAR_GROUND_M,
  MAX_ALTITUDE_ESTIMATE_S,
  advance,
  cameraTarget,
  estimateAltitudeFt,
  eyeAltitudeM,
  formatReadout,
  hazeBand,
  pilotStep,
  setupPilotView,
  startPilot,
  viewProfile,
} from '../src/pilotview.js';

// 450 kt due east over the Netherlands at 36,000 ft, last heard from at t = 0.
const report = (overrides = {}) => ({
  id: 'abc123',
  callsign: 'KLM42',
  lat: 52,
  lng: 4,
  track: 90,
  speedKt: 450,
  altitudeFt: 36000,
  verticalFpm: 0,
  onGround: false,
  seen: 0,
  ...overrides,
});
// Great circle distance in metres.
const metres = (a, b) => {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
};
const FRAME = 16;

describe('advance', () => {
  it('goes north along a meridian', () => {
    const p = advance(52, 4, 0, 1000);
    expect(p.lng).toBeCloseTo(4, 8);
    expect(Math.abs(metres(p, { lat: 52, lng: 4 }) - 1000)).toBeLessThan(1);
    expect(p.lat).toBeGreaterThan(52);
  });

  it('goes east along a parallel, covering more longitude the further north it is', () => {
    const p = advance(52, 4, 90, 1000);
    expect(p.lat).toBeCloseTo(52, 8);
    expect(Math.abs(metres(p, { lat: 52, lng: 4 }) - 1000)).toBeLessThan(1);
    expect(advance(70, 4, 90, 1000).lng - 4).toBeGreaterThan(p.lng - 4);
  });

  it('wraps at the date line', () => {
    expect(advance(10, 179.999, 90, 1000).lng).toBeLessThan(0);
  });
});

describe('altitude', () => {
  it('carries a climb on at its vertical speed', () => {
    expect(estimateAltitudeFt(report({ altitudeFt: 5000, verticalFpm: 1200 }), 30_000)).toBeCloseTo(5600, 6);
  });

  it(`stops carrying it on after ${MAX_ALTITUDE_ESTIMATE_S} s`, () => {
    const ac = report({ altitudeFt: 5000, verticalFpm: -600 });
    expect(estimateAltitudeFt(ac, 600_000)).toBeCloseTo(5000 - 600 * (MAX_ALTITUDE_ESTIMATE_S / 60), 6);
  });

  it('keeps the reported altitude on the ground, without a vertical speed, or before the report', () => {
    expect(estimateAltitudeFt(report({ onGround: true, altitudeFt: 11, verticalFpm: 900 }), 20_000)).toBe(11);
    expect(estimateAltitudeFt(report({ verticalFpm: null }), 20_000)).toBe(36000);
    expect(estimateAltitudeFt(report({ verticalFpm: 900 }), -5000)).toBe(36000);
  });

  it('is null when the aircraft gave none', () => {
    expect(estimateAltitudeFt(report({ altitudeFt: null }), 1000)).toBeNull();
  });
});

describe('pilotStep', () => {
  it('starts on the aircraft estimate', () => {
    const ac = report();
    const pose = pilotStep(startPilot(ac), ac, 5000);
    expect(pose).toMatchObject({ ...estimatePosition(ac, 5000), altitudeFt: 36000, track: 90, speedKt: 450, onGround: false });
  });

  it('follows a steady, climbing, straight flight exactly', () => {
    const ac = report({ altitudeFt: 10_000, verticalFpm: 1800 });
    const pilot = startPilot(ac);
    pilotStep(pilot, ac, 1000);
    for (let t = 1000 + FRAME; t <= 20_000; t += FRAME) {
      const pose = pilotStep(pilot, ac, t);
      expect(metres(pose, estimatePosition(ac, t))).toBeLessThan(0.01);
      expect(pose.altitudeFt).toBeCloseTo(estimateAltitudeFt(ac, t), 4);
    }
  });

  it('does not jump when a new report puts the aircraft elsewhere, higher and on another track', () => {
    const old = report();
    const at = 15_000;
    const next = { ...report({ seen: at, altitudeFt: 36_600, track: 100 }), ...estimatePosition(old, at) };
    next.lat += 400 / 111_320;
    const pilot = startPilot(old);
    const before = pilotStep(pilot, old, at - FRAME);
    const first = pilotStep(pilot, next, at);
    // Position, altitude and track each move by about a frame's worth, not by the gap.
    expect(metres(first, before)).toBeLessThan(15);
    expect(Math.abs(first.altitudeFt - before.altitudeFt)).toBeLessThan(15);
    expect(Math.abs(first.track - before.track)).toBeLessThan(0.5);
    let last = first;
    for (let t = at + FRAME; t <= at + 10_000; t += FRAME) {
      const pose = pilotStep(pilot, next, t);
      expect(Math.abs(pose.altitudeFt - last.altitudeFt)).toBeLessThan(15);
      expect(Math.abs(pose.track - last.track)).toBeLessThan(0.5);
      last = pose;
    }
    expect(last.altitudeFt).toBeCloseTo(36_600, 0);
    expect(last.track).toBeCloseTo(100, 0);
  });

  it('turns the short way round north', () => {
    const old = report({ track: 350 });
    const next = report({ track: 10, seen: 1000 });
    const pilot = startPilot(old);
    pilotStep(pilot, old, 900);
    let last = pilotStep(pilot, next, 1000).track;
    for (let t = 1000 + FRAME; t <= 8000; t += FRAME) {
      const track = pilotStep(pilot, next, t).track;
      const step = Math.abs(((track - last + 540) % 360) - 180);
      expect(step).toBeLessThan(2);
      last = track;
    }
    expect(last).toBeCloseTo(10, 0);
  });

  it('keeps the track when the aircraft stops giving one, and uses north if it never did', () => {
    const pilot = startPilot(report());
    pilotStep(pilot, report({ track: 200 }), 0);
    expect(pilotStep(pilot, report({ track: null }), FRAME).track).toBeCloseTo(200, 3);
    expect(pilotStep(startPilot(report()), report({ track: null }), 0).track).toBe(0);
  });

  it('reports what is missing as null', () => {
    const ac = report({ altitudeFt: null, speedKt: null });
    expect(pilotStep(startPilot(ac), ac, 0)).toMatchObject({ altitudeFt: null, speedKt: null });
  });
});

describe('eyeAltitudeM', () => {
  const pose = (overrides = {}) => ({ onGround: false, altitudeFt: 3000, ...overrides });

  it('is the barometric altitude in the air', () => {
    expect(eyeAltitudeM(pose())).toBeCloseTo(914.4, 6);
  });

  it('is never lower than the eye height above the ground', () => {
    expect(eyeAltitudeM(pose({ altitudeFt: -11 }), 0)).toBe(EYE_HEIGHT_M);
    expect(eyeAltitudeM(pose({ altitudeFt: 1000 }), 400)).toBe(400 + EYE_HEIGHT_M);
    expect(eyeAltitudeM(pose({ altitudeFt: 1000 }), 100)).toBeCloseTo(304.8, 6);
  });

  it('is the eye height above the ground, whatever the altitude says, on the ground', () => {
    expect(eyeAltitudeM(pose({ onGround: true, altitudeFt: 0 }), 1600)).toBe(1600 + EYE_HEIGHT_M);
    expect(eyeAltitudeM(pose({ onGround: true, altitudeFt: 5300 }), 0)).toBe(EYE_HEIGHT_M);
  });

  it('is the eye height above the ground when the altitude is not known', () => {
    expect(eyeAltitudeM(pose({ altitudeFt: null }), 30)).toBe(30 + EYE_HEIGHT_M);
  });
});

describe('formatReadout', () => {
  it('shows altitude with a thousands separator, speed and a three digit track', () => {
    expect(formatReadout({ onGround: false, altitudeFt: 38_000.4, speedKt: 449.6, track: 167.2 }, 'en-US')).toEqual({ alt: '38,000', altUnit: 'ft', gs: '450', trk: '167' });
  });

  it('pads the track and wraps it at 360', () => {
    expect(formatReadout({ onGround: false, altitudeFt: 900, speedKt: 90, track: 7 }, 'en-US').trk).toBe('007');
    expect(formatReadout({ onGround: false, altitudeFt: 900, speedKt: 90, track: 359.6 }, 'en-US').trk).toBe('000');
  });

  it('shows GND on the ground, and a dash for what is not known', () => {
    expect(formatReadout({ onGround: true, altitudeFt: 0, speedKt: 12, track: 3 }, 'en-US')).toEqual({ alt: 'GND', altUnit: '', gs: '12', trk: '003' });
    expect(formatReadout({ onGround: false, altitudeFt: null, speedKt: null, track: 90 }, 'en-US')).toEqual({ alt: '–', altUnit: '', gs: '–', trk: '090' });
  });

  it('keeps a negative altitude', () => {
    expect(formatReadout({ onGround: false, altitudeFt: -11, speedKt: 100, track: 90 }, 'en-US').alt).toBe('-11');
  });
});

describe('viewProfile', () => {
  it('is the prototype case at each of its heights', () => {
    expect(viewProfile(5)).toMatchObject({ lookDown: 0.5, vfov: 50, visKm: expect.closeTo(8, 6) });
    expect(viewProfile(915)).toMatchObject({ lookDown: 4, vfov: 50, visKm: expect.closeTo(45, 6) });
    expect(viewProfile(11_600)).toMatchObject({ lookDown: 5, vfov: 52, visKm: expect.closeTo(220, 6) });
    expect(viewProfile(915).sky['sky-color']).toBe('#3b78bd');
    expect(viewProfile(11_600).sky['horizon-color']).toBe('#cfdfee');
  });

  it('holds the nearest case below and above them', () => {
    expect(viewProfile(0)).toEqual(viewProfile(5));
    expect(viewProfile(-50)).toEqual(viewProfile(5));
    expect(viewProfile(40_000)).toEqual(viewProfile(11_600));
  });

  it('blends in between, never going backwards with height', () => {
    let last = viewProfile(5);
    for (let h = 5; h <= 12_000; h *= 1.05) {
      const p = viewProfile(h);
      expect(p.lookDown).toBeGreaterThanOrEqual(last.lookDown);
      expect(p.visKm).toBeGreaterThanOrEqual(last.visKm - 1e-9);
      expect(p.key).toBeGreaterThanOrEqual(last.key);
      last = p;
    }
    const mid = viewProfile(70);
    expect(mid.lookDown).toBeGreaterThan(0.5);
    expect(mid.lookDown).toBeLessThan(4);
  });

  it('changes in steps, so the sky is not set again every frame', () => {
    const keys = new Set();
    for (let h = 5; h <= 12_000; h *= 1.01) keys.add(viewProfile(h).key);
    expect(keys.size).toBeLessThanOrEqual(25);
  });

  it('asks for finer tiles low down than from far up', () => {
    expect(viewProfile(LOD_NEAR_GROUND_M - 1).lod).not.toEqual(viewProfile(LOD_NEAR_GROUND_M + 1).lod);
    expect(viewProfile(LOD_HIGH_M - 1).lod).not.toEqual(viewProfile(LOD_HIGH_M + 1).lod);
  });
});

describe('cameraTarget', () => {
  const at = { lat: 52, lng: 4, track: 90 };

  it('aims at the ground ahead, down by the angle, when that is near enough', () => {
    const t = cameraTarget({ ...at, eyeM: 914.4, groundM: 0 }, 4);
    expect(t.distanceM).toBeCloseTo(914.4 / Math.sin((4 * Math.PI) / 180), 3);
    expect(t.altM).toBeCloseTo(0, 6);
    expect(t.lat).toBeCloseTo(52, 6);
    expect(Math.abs(metres(t, at) - t.distanceM * Math.cos((4 * Math.PI) / 180))).toBeLessThan(2);
    expect(t.lng).toBeGreaterThan(4);
  });

  it('measures from the ground under the aircraft', () => {
    const t = cameraTarget({ ...at, eyeM: 1914.4, groundM: 1000 }, 4);
    expect(t.altM).toBeCloseTo(1000, 6);
  });

  it('keeps the aimed point within 20 times the height, so the near plane stays clear of the ground', () => {
    const t = cameraTarget({ ...at, eyeM: 5, groundM: 0 }, 0.5);
    expect(t.distanceM).toBeCloseTo(100, 6);
    expect(t.altM).toBeLessThan(5);
    expect(t.altM).toBeGreaterThan(4);
  });

  it('looks along the track whichever way that is', () => {
    const north = cameraTarget({ ...at, track: 0, eyeM: 1000, groundM: 0 }, 4);
    expect(north.lng).toBeCloseTo(4, 6);
    expect(north.lat).toBeGreaterThan(52);
    const west = cameraTarget({ ...at, track: 270, eyeM: 1000, groundM: 0 }, 4);
    expect(west.lng).toBeLessThan(4);
  });

  it('has a distance of at least 20 m and copes with an eye at the ground', () => {
    const t = cameraTarget({ ...at, eyeM: 0, groundM: 0 }, 0);
    expect(t.distanceM).toBeGreaterThanOrEqual(20);
    expect(Number.isFinite(t.altM)).toBe(true);
  });
});

describe('hazeBand', () => {
  const view = { height: 900, aglM: 915, lookDown: 4, vfov: 50, visKm: 45, color: '#cfdfee' };
  const alphas = (band) => [...band.background.matchAll(/rgba\(\d+,\d+,\d+,([\d.]+)\)/g)].map((m) => Number(m[1]));

  it('is thickest at the horizon and thins towards the bottom, never beyond 1', () => {
    const band = hazeBand(view);
    const a = alphas(band);
    expect(a.length).toBe(29);
    expect(a[0]).toBeGreaterThan(0.7);
    expect(a.at(-1)).toBeLessThan(0.1);
    for (let i = 1; i < a.length; i++) expect(a[i]).toBeLessThanOrEqual(a[i - 1] + 1e-9);
    expect(Math.max(...a)).toBeLessThanOrEqual(1);
  });

  it('covers the picture from just above the horizon to the bottom', () => {
    const band = hazeBand(view);
    expect(band.top).toBeGreaterThan(0);
    expect(band.top + band.height).toBeCloseTo(900, 6);
  });

  it('is thinner where one sees further', () => {
    const near = alphas(hazeBand({ ...view, visKm: 8 }));
    const far = alphas(hazeBand({ ...view, visKm: 220 }));
    expect(far[10]).toBeLessThan(near[10]);
  });

  it('is left out with no picture to draw on', () => {
    expect(hazeBand({ ...view, height: 0 })).toBeNull();
  });
});

// The overlay, with the page, the traffic layer and the map made up.
describe('the overlay', () => {
  const element = (extra = {}) => {
    const attrs = {};
    const listeners = {};
    return {
      hidden: false,
      disabled: false,
      inert: false,
      textContent: '',
      focused: 0,
      focus() {
        this.focused++;
      },
      setAttribute: (k, v) => (attrs[k] = String(v)),
      getAttribute: (k) => attrs[k] ?? null,
      addEventListener: (type, fn) => (listeners[type] = fn),
      click() {
        listeners.click?.();
      },
      ...extra,
    };
  };

  let store;
  let selected;
  let traffic;
  let els;
  let calls;
  let maps;
  let announced;
  let view;

  const fakeMap = () => {
    const map = {
      destroyed: 0,
      placed: [],
      terrain: [],
      elevation: null,
      place: (v) => map.placed.push(v),
      setTerrain: (on) => map.terrain.push(on),
      groundElevation: () => map.elevation,
      destroy: () => map.destroyed++,
    };
    maps.push(map);
    return map;
  };

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    store = new Map([['abc123', report({ seen: Date.now() })]]);
    selected = { kind: 'aircraft', id: 'abc123' };
    traffic = {
      get selected() {
        return selected;
      },
      selectedAircraft: () => (selected?.kind === 'aircraft' ? (store.get(selected.id) ?? null) : null),
      title: () => 'KLM42',
    };
    els = {
      root: element({ hidden: true }),
      map: element(),
      title: element(),
      status: element(),
      terrain: element(),
      terrainCredit: element(),
      close: element(),
      button: element(),
      detailsClose: element(),
      hud: { alt: element(), altUnit: element(), gs: element(), trk: element() },
    };
    calls = [];
    maps = [];
    announced = [];
    const page = [element(), element()];
    view = setupPilotView({
      els,
      traffic,
      background: () => page,
      onOpen: () => calls.push('open'),
      onClose: () => calls.push('close'),
      announce: (m) => announced.push(m),
      loadMap: async () => ({ createPilotMap: async () => fakeMap() }),
    });
    view.page = page;
  });

  afterEach(() => vi.unstubAllGlobals());

  const opened = async () => {
    view.open();
    await vi.waitFor(() => expect(view.map).not.toBeNull());
  };

  it('opens over the page, which becomes inert, and takes focus', async () => {
    await opened();
    expect(view.isOpen).toBe(true);
    expect(els.root.hidden).toBe(false);
    expect(els.title.textContent).toBe('KLM42');
    expect(view.page.every((el) => el.inert)).toBe(true);
    expect(els.close.focused).toBe(1);
    expect(calls).toEqual(['open']);
  });

  it('does not open without an aircraft that is received, nor twice', async () => {
    store.clear();
    view.open();
    expect(view.isOpen).toBe(false);
    store.set('abc123', report({ seen: Date.now() }));
    await opened();
    view.open();
    expect(calls).toEqual(['open']);
  });

  it('closes with the close button, freeing the map and giving the page back', async () => {
    await opened();
    els.close.click();
    expect(view.isOpen).toBe(false);
    expect(els.root.hidden).toBe(true);
    expect(maps[0].destroyed).toBe(1);
    expect(view.page.every((el) => !el.inert)).toBe(true);
    expect(calls).toEqual(['open', 'close']);
  });

  it('closes when asked to (Escape), once only', async () => {
    await opened();
    view.close();
    view.close();
    expect(maps[0].destroyed).toBe(1);
    expect(calls).toEqual(['open', 'close']);
  });

  it('puts the focus back on the button that opened it', async () => {
    await opened();
    view.close();
    expect(els.button.focused).toBe(1);
  });

  it('closes by itself, and says so, when the aircraft is no longer received', async () => {
    await opened();
    view.frame(Date.now(), 0);
    expect(view.isOpen).toBe(true);
    store.clear();
    view.frame(Date.now(), 0);
    expect(view.isOpen).toBe(false);
    expect(announced.at(-1)).toBe('KLM42 is no longer received. Closed the pilot view.');
    expect(maps[0].destroyed).toBe(1);
    expect(calls).toEqual(['open', 'close']);
    // Its button is off now, so the focus goes to the panel's close button.
    view.sync();
    expect(els.detailsClose.focused).toBe(1);
  });

  it('closes, quietly, when another aircraft or nothing is selected', async () => {
    await opened();
    const said = announced.length;
    selected = { kind: 'aircraft', id: 'other' };
    view.frame(Date.now(), 0);
    expect(view.isOpen).toBe(false);
    expect(announced.length).toBe(said);
  });

  it('closes when a satellite is selected', async () => {
    await opened();
    selected = { kind: 'satellite', index: 3 };
    view.frame(Date.now(), 0);
    expect(view.isOpen).toBe(false);
  });

  it('puts the camera at the aircraft each frame, over the ground it measured', async () => {
    await opened();
    maps[0].elevation = 120;
    view.frame(Date.now(), 0);
    const placed = maps[0].placed.at(-1);
    expect(placed).toMatchObject({ track: 90, groundM: 120 });
    expect(placed.eyeM).toBeCloseTo(36000 * 0.3048, 0);
    expect(placed.lat).toBeCloseTo(52, 1);
    expect(placed.profile.lookDown).toBe(5);
  });

  it('puts the eye of an aircraft on the ground a little above the ground', async () => {
    store.set('abc123', report({ onGround: true, altitudeFt: 0, speedKt: 12, seen: Date.now() }));
    await opened();
    maps[0].elevation = 1600;
    view.frame(Date.now(), 0);
    expect(maps[0].placed.at(-1).eyeM).toBe(1600 + EYE_HEIGHT_M);
    expect(maps[0].placed.at(-1).profile.lookDown).toBe(0.5);
  });

  it('fills in the readout, a tenth of a second at a time', async () => {
    await opened();
    view.frame(Date.now(), 1000);
    expect(els.hud.alt.textContent).toBe((36000).toLocaleString());
    expect(els.hud.gs.textContent).toBe('450');
    expect(els.hud.trk.textContent).toBe('090');
    els.hud.gs.textContent = 'x';
    view.frame(Date.now(), 1050);
    expect(els.hud.gs.textContent).toBe('x');
    view.frame(Date.now(), 1110);
    expect(els.hud.gs.textContent).toBe('450');
  });

  it('frees a map that was still loading when the view was closed', async () => {
    let finish;
    view = setupPilotView({
      els,
      traffic,
      background: () => [],
      onOpen() {},
      onClose() {},
      announce() {},
      loadMap: () => new Promise((resolve) => (finish = () => resolve({ createPilotMap: async () => fakeMap() }))),
    });
    view.open();
    view.close();
    finish();
    await vi.waitFor(() => expect(maps.length).toBe(1));
    expect(maps[0].destroyed).toBe(1);
    expect(view.map).toBeNull();
  });

  it('closes, and says so, when the map cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    view = setupPilotView({
      els,
      traffic,
      background: () => [],
      onOpen() {},
      onClose() {},
      announce: (m) => announced.push(m),
      loadMap: async () => {
        throw new Error('offline');
      },
    });
    view.open();
    await vi.waitFor(() => expect(view.isOpen).toBe(false));
    expect(announced.at(-1)).toBe('The pilot view could not be loaded. Closed the pilot view.');
  });

  it('turns the terrain on and off', async () => {
    await opened();
    els.terrain.click();
    expect(els.terrain.getAttribute('aria-pressed')).toBe('false');
    expect(els.terrainCredit.hidden).toBe(true);
    els.terrain.click();
    expect(maps[0].terrain).toEqual([false, true]);
    expect(els.terrainCredit.hidden).toBe(false);
  });

  it('has its button in the panel for an aircraft only, off while it is not received', () => {
    view.sync();
    expect(els.button).toMatchObject({ hidden: false, disabled: false });
    store.clear();
    view.sync();
    expect(els.button).toMatchObject({ hidden: false, disabled: true });
    selected = { kind: 'satellite', index: 1 };
    view.sync();
    expect(els.button.hidden).toBe(true);
  });
});
