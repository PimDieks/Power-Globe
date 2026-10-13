import { describe, expect, it } from 'vitest';
import { estimatePosition } from '../src/aircraft.js';
import {
  CLEARANCE,
  FOLLOW_ALTITUDE,
  GLIDE_MS,
  RECENTRE_MS,
  SMOOTH_S,
  cameraAltitude,
  dragged,
  followPoint,
  followStep,
  glidePose,
  shiftedLat,
  startFollow,
  stopReason,
  visibleShift,
} from '../src/follow.js';

// 450 kt due east over the Netherlands, last heard from at t = 0.
const report = (overrides = {}) => ({
  id: 'abc123',
  lat: 52,
  lng: 4,
  track: 90,
  speedKt: 450,
  altitudeFt: 36000,
  onGround: false,
  seen: 0,
  ...overrides,
});
const FRAME = 16;
// Metres between two points that are close together.
const metres = (a, b) => Math.hypot((a.lat - b.lat) * 111_320, wrapDelta(a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180));
const wrapDelta = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

describe('followPoint', () => {
  it('starts on the aircraft estimate', () => {
    const ac = report();
    const p = followPoint(null, ac, 5000);
    expect(p).toMatchObject({ ...estimatePosition(ac, 5000), at: 5000 });
  });

  it('follows a steady flight exactly, with no lag behind it', () => {
    const ac = report();
    let p = followPoint(null, ac, 1000);
    for (let t = 1000 + FRAME; t <= 10_000; t += FRAME) {
      p = followPoint(p, ac, t);
      expect(metres(p, estimatePosition(ac, t))).toBeLessThan(0.01);
    }
  });

  it('does not jump when a new report puts the aircraft elsewhere, and settles on the new estimate', () => {
    const old = report();
    // 15 s on, the next report: 400 m to the north of where the old one had it.
    const at = 15_000;
    const next = { ...report({ seen: at }), ...estimatePosition(old, at) };
    next.lat += 400 / 111_320;
    let p = followPoint(null, old, at - FRAME);
    const before = p;
    p = followPoint(p, next, at);
    // The step is the aircraft's own movement in a frame (about 4 m), not the 400 m gap.
    expect(metres(p, before)).toBeLessThan(15);
    // The gap closes smoothly: never more than a frame's share of it per frame.
    let last = p;
    let worst = 0;
    for (let t = at + FRAME; t <= at + 8000; t += FRAME) {
      p = followPoint(p, next, t);
      worst = Math.max(worst, metres(p, last));
      last = p;
    }
    expect(worst).toBeLessThan(15);
    expect(metres(p, estimatePosition(next, at + 8000))).toBeLessThan(1);
  });

  it(`closes about two thirds of a gap in ${SMOOTH_S} s`, () => {
    const ac = report({ onGround: true });
    const start = followPoint(null, { ...ac, lat: 52.01 }, 0);
    // The report now says the aircraft is 0.01 degrees south of where the point is.
    const p = followPoint(start, ac, SMOOTH_S * 1000);
    expect(p.lat - 52).toBeCloseTo(0.01 * Math.exp(-1), 6);
  });

  it('goes straight to the estimate if the page was away for a long time', () => {
    const old = report();
    const next = report({ lat: 53, lng: 6, seen: 60_000 });
    const p = followPoint(followPoint(null, old, 1000), next, 120_000);
    expect(metres(p, estimatePosition(next, 120_000))).toBeLessThan(1);
  });

  it('crosses the date line without a jump', () => {
    const ac = report({ lat: 10, lng: 179.99, seen: 0 });
    let p = followPoint(null, ac, 0);
    let last = p;
    for (let t = FRAME; t <= 20_000; t += FRAME) {
      p = followPoint(p, ac, t);
      expect(metres(p, last)).toBeLessThan(10);
      last = p;
    }
    expect(p.lng).toBeLessThan(0);
  });

  it('holds still for an aircraft on the ground', () => {
    const ac = report({ onGround: true, speedKt: 12 });
    let p = followPoint(null, ac, 0);
    for (let t = FRAME; t < 5000; t += FRAME) p = followPoint(p, ac, t);
    expect(p).toMatchObject({ lat: 52, lng: 4 });
  });
});

describe('cameraAltitude', () => {
  it('leaves the visitor in charge of the zoom', () => {
    expect(cameraAltitude(0.2, report())).toBe(0.2);
    expect(cameraAltitude(0.0025, report({ altitudeFt: 5000 }))).toBe(0.0025);
  });

  it('stays above a high aircraft by a margin', () => {
    // A balloon at 100 000 ft is about 0.0048 globe radii up.
    const balloon = report({ altitudeFt: 100_000 });
    const height = (30_480 / 6_371_000) + CLEARANCE;
    expect(cameraAltitude(0.0025, balloon)).toBeCloseTo(height, 8);
    expect(cameraAltitude(0.0025, balloon)).toBeGreaterThan(30_480 / 6_371_000);
  });
});

describe('phone shift', () => {
  it('puts the aircraft in the middle of the part of the screen above the panel', () => {
    // 800 px high, the search box ends at 100, the panel starts at 440.
    const shift = visibleShift({ top: 100, bottom: 440, height: 800 });
    expect(shift).toBeCloseTo((400 - 270) / 800, 8);
  });

  it('keeps a window free however high the panel reaches', () => {
    expect(visibleShift({ top: 100, bottom: 120, height: 800 })).toBeCloseTo((400 - 140) / 800, 8);
  });

  it('is nothing when the free part is centred', () => {
    expect(visibleShift({ top: 0, bottom: 800, height: 800 })).toBeCloseTo(0, 8);
  });

  it('aims the camera south of the aircraft, by more the higher it is', () => {
    expect(shiftedLat(52, 0, 0.02)).toBe(52);
    expect(shiftedLat(52, 0.16, 0.02)).toBeCloseTo(52 - 0.16 * 53 * 0.02, 8);
    expect(shiftedLat(52, 0.16, 0.04)).toBeLessThan(shiftedLat(52, 0.16, 0.02));
    expect(shiftedLat(-84, 0.5, 1)).toBe(-85);
  });
});

describe('glidePose', () => {
  const from = { lat: 22, lng: -25, altitude: 2.4 };
  const to = { lat: 52, lng: 4, altitude: 0.03 };

  it('runs from the start to the end, slowly at both', () => {
    expect(glidePose(from, to, 0)).toMatchObject({ ...from, done: false });
    const end = glidePose(from, to, GLIDE_MS);
    expect(end).toMatchObject({ ...to, done: true });
    expect(glidePose(from, to, 100).lat - from.lat).toBeLessThan(0.1);
    const half = glidePose(from, to, GLIDE_MS / 2);
    expect(half.lat).toBeCloseTo(37, 6);
    // Halfway in zoom too: the geometric mean of the heights.
    expect(half.altitude).toBeCloseTo(Math.sqrt(2.4 * 0.03), 6);
  });

  it('takes the short way over the date line', () => {
    const pose = glidePose({ lat: 0, lng: 170, altitude: 0.1 }, { lat: 0, lng: -170, altitude: 0.1 }, GLIDE_MS / 2);
    expect(Math.abs(pose.lng)).toBeCloseTo(180, 6);
  });

  it('is at once with no duration', () => {
    expect(glidePose(from, to, 0, 0)).toMatchObject({ ...to, done: true });
  });
});

describe('stopReason', () => {
  const selected = { kind: 'aircraft', id: 'abc123' };

  it('carries on while the aircraft is selected and received', () => {
    expect(stopReason({ id: 'abc123', selected, report: report() })).toBeNull();
  });

  it('stops when something else is selected, or nothing', () => {
    expect(stopReason({ id: 'abc123', selected: { kind: 'aircraft', id: 'def456' }, report: report() })).toBe('deselected');
    expect(stopReason({ id: 'abc123', selected: { kind: 'satellite', index: 3 }, report: report() })).toBe('deselected');
    expect(stopReason({ id: 'abc123', selected: null, report: null })).toBe('deselected');
  });

  it('stops when the aircraft is no longer received', () => {
    expect(stopReason({ id: 'abc123', selected, report: null })).toBe('lost');
  });
});

describe('dragged', () => {
  it('tells a drag from a tap by how far the pointer went', () => {
    expect(dragged({ x: 10, y: 10 }, { x: 13, y: 12 })).toBe(false);
    expect(dragged({ x: 10, y: 10 }, { x: 10, y: 17 })).toBe(true);
  });
});

describe('followStep', () => {
  const pov = { lat: 22, lng: -25, altitude: 2.4 };

  it('glides in from where the camera is and then follows from the height the visitor leaves it at', () => {
    const ac = report();
    const f = startFollow(ac, pov, 0);
    expect(f.glide.altitude).toBe(FOLLOW_ALTITUDE);
    expect(followStep(f, { report: ac, pov, now: 0 })).toMatchObject({ lat: 22, lng: -25, altitude: 2.4 });
    const mid = followStep(f, { report: ac, pov, now: GLIDE_MS / 2 });
    expect(mid.altitude).toBeLessThan(2.4);
    expect(mid.altitude).toBeGreaterThan(FOLLOW_ALTITUDE);
    const end = followStep(f, { report: ac, pov, now: GLIDE_MS });
    const there = estimatePosition(ac, GLIDE_MS);
    expect(end).toMatchObject({ altitude: FOLLOW_ALTITUDE });
    expect(end.lat).toBeCloseTo(there.lat, 6);
    expect(end.lng).toBeCloseTo(there.lng, 6);
    expect(f.glide).toBeNull();
    // After the glide the visitor zooms: the height is theirs.
    const zoomed = followStep(f, { report: ac, pov: { ...pov, altitude: 0.005 }, now: GLIDE_MS + FRAME });
    expect(zoomed.altitude).toBe(0.005);
    expect(zoomed.lat).toBeCloseTo(estimatePosition(ac, GLIDE_MS + FRAME).lat, 6);
  });

  it('does not back out from a closer view', () => {
    const f = startFollow(report(), { lat: 52, lng: 4, altitude: 0.004 }, 0);
    expect(f.glide.altitude).toBe(0.004);
  });

  it('puts the aircraft in the free part of the screen on a phone', () => {
    const ac = report({ onGround: true });
    const close = { lat: 52, lng: 4, altitude: 0.01 };
    const f = startFollow(ac, close, 0);
    followStep(f, { report: ac, pov: close, now: GLIDE_MS + 1, shift: 0.16 });
    const pose = followStep(f, { report: ac, pov: close, now: GLIDE_MS + 2, shift: 0.16 });
    expect(pose.lat).toBeCloseTo(52 - 0.16 * 53 * 0.01, 4);
    expect(pose.lng).toBeCloseTo(4, 6);
  });

  it('centres at once and then only every few seconds with reduced motion', () => {
    const ac = report();
    const f = startFollow(ac, pov, 1000, { reduced: true });
    const first = followStep(f, { report: ac, pov, now: 1000 });
    expect(first.altitude).toBe(FOLLOW_ALTITUDE);
    expect(first.lat).toBeCloseTo(estimatePosition(ac, 1000).lat, 6);
    expect(followStep(f, { report: ac, pov: { ...pov, altitude: FOLLOW_ALTITUDE }, now: 1000 + FRAME })).toBeNull();
    expect(followStep(f, { report: ac, pov: { ...pov, altitude: FOLLOW_ALTITUDE }, now: 1000 + RECENTRE_MS - 1 })).toBeNull();
    const again = followStep(f, { report: ac, pov: { ...pov, altitude: FOLLOW_ALTITUDE }, now: 1000 + RECENTRE_MS });
    expect(again.lng).toBeCloseTo(estimatePosition(ac, 1000 + RECENTRE_MS).lng, 6);
  });

  it('lifts the camera over a high aircraft', () => {
    const balloon = report({ altitudeFt: 100_000, speedKt: 5 });
    const f = startFollow(balloon, { lat: 52, lng: 4, altitude: 0.0025 }, 0);
    const pose = followStep(f, { report: balloon, pov: { lat: 52, lng: 4, altitude: 0.0025 }, now: GLIDE_MS });
    expect(pose.altitude).toBeGreaterThan(30_480 / 6_371_000);
  });
});
