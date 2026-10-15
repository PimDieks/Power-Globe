import { describe, expect, it } from 'vitest';
import {
  FrameBudget,
  FrameMeter,
  INPUT_ACTIVE_MS,
  MAX_PIXEL_RATIO,
  STILL_AFTER_MS,
  UNATTENDED_MS,
  busyNow,
  pixelRatio,
  playStep,
  unattended,
} from '../src/pacing.js';

// Frames drawn a second on a screen refreshing `hz` times a second, in `mode`, over `seconds`
// (after a second to settle), with frame times off by up to `jitter` ms either way.
function framesDrawn(budget, mode, hz, { seconds = 60, jitter = 0, start = 10_000 } = {}) {
  let drawn = 0;
  const frames = Math.round(hz * (seconds + 1));
  const settle = Math.round(hz);
  for (let k = 0; k < frames; k++) {
    const t = start + (k * 1000) / hz + (k % 2 ? jitter : -jitter);
    if (budget.due(t, mode) && k >= settle) drawn++;
  }
  return drawn / seconds;
}

describe('the frame budget', () => {
  it('is active for a while after loading and after input, then idle, then still', () => {
    const budget = new FrameBudget(0);
    expect(budget.mode(INPUT_ACTIVE_MS - 1)).toBe('active');
    expect(budget.mode(INPUT_ACTIVE_MS + 1)).toBe('idle');
    budget.input(60_000);
    expect(budget.mode(60_000 + INPUT_ACTIVE_MS - 1)).toBe('active');
    expect(budget.mode(60_000 + INPUT_ACTIVE_MS + STILL_AFTER_MS - 1)).toBe('idle');
    expect(budget.mode(60_000 + INPUT_ACTIVE_MS + STILL_AFTER_MS + 1)).toBe('still');
  });

  it('stays active while something moves by itself, and counts idle time from when it stops', () => {
    const budget = new FrameBudget(0);
    expect(budget.mode(10 * 60_000, { busy: true })).toBe('active');
    // Just after a long play, the page is idle, not still.
    expect(budget.mode(10 * 60_000 + 1)).toBe('idle');
    expect(budget.mode(10 * 60_000 + STILL_AFTER_MS + 1)).toBe('still');
  });

  it('is paused while the globe is covered, whatever else is going on', () => {
    const budget = new FrameBudget(0);
    expect(budget.mode(0, { busy: true, paused: true })).toBe('paused');
  });

  it('draws every frame of a 60 Hz screen, also one a little faster or slower', () => {
    for (const hz of [59.9, 60, 60.1]) expect(framesDrawn(new FrameBudget(), 'active', hz)).toBeCloseTo(hz, 1);
  });

  it('draws every other frame of a 120 Hz screen', () => {
    expect(framesDrawn(new FrameBudget(), 'active', 120)).toBeCloseTo(60, 1);
    expect(framesDrawn(new FrameBudget(), 'active', 120.2)).toBeLessThanOrEqual(60.1);
  });

  it('draws no more than 60 frames a second on a 144 Hz screen', () => {
    const fps = framesDrawn(new FrameBudget(), 'active', 144);
    expect(fps).toBeLessThanOrEqual(60);
    expect(fps).toBeGreaterThanOrEqual(45);
  });

  it('copes with jittery frame times', () => {
    expect(framesDrawn(new FrameBudget(), 'active', 60, { jitter: 1.5 })).toBeCloseTo(60, 1);
    expect(framesDrawn(new FrameBudget(), 'active', 120, { jitter: 1 })).toBeCloseTo(60, 1);
  });

  it('draws about 20 frames a second when idle and 5 when still', () => {
    for (const hz of [60, 120, 144]) {
      expect(framesDrawn(new FrameBudget(), 'idle', hz)).toBeGreaterThanOrEqual(18);
      expect(framesDrawn(new FrameBudget(), 'idle', hz)).toBeLessThanOrEqual(20.01);
      expect(framesDrawn(new FrameBudget(), 'still', hz)).toBeGreaterThanOrEqual(4.8);
      expect(framesDrawn(new FrameBudget(), 'still', hz)).toBeLessThanOrEqual(5.01);
    }
  });

  it('draws the very next frame when input wakes a still page', () => {
    const budget = new FrameBudget(0);
    const frame = 1000 / 120;
    let t = 10 * 60_000;
    // A still page on a 120 Hz screen.
    for (let k = 0; k < 240; k++, t += frame) budget.due(t, budget.mode(t));
    expect(budget.mode(t)).toBe('still');
    // Someone drags the globe: the next frame of the screen is drawn, and every other after it.
    budget.input(t);
    const drawn = [];
    for (let k = 0; k < 6; k++, t += frame) drawn.push(budget.due(t, budget.mode(t)));
    expect(drawn).toEqual([true, false, true, false, true, false]);
  });
});

describe('what keeps the page busy', () => {
  it('is playing or a camera flight, whatever the input', () => {
    expect(busyNow({ playing: true, attended: false })).toBe(true);
    expect(busyNow({ flying: true, attended: false })).toBe(true);
    expect(busyNow({})).toBe(false);
  });

  it('is following an aircraft or the clouds loop only while someone has touched the page lately', () => {
    expect(busyNow({ following: true })).toBe(true);
    expect(busyNow({ looping: true })).toBe(true);
    expect(busyNow({ following: true, attended: false })).toBe(false);
    expect(busyNow({ looping: true, attended: false })).toBe(false);
  });
});

describe('the frame meter', () => {
  it('counts the frames drawn in the last second', () => {
    const meter = new FrameMeter();
    for (let t = 0; t < 3000; t += 50) meter.count(t);
    expect(meter.fps(3000)).toBe(19);
    expect(meter.fps(10_000)).toBe(0);
  });
});

describe('the pixel ratio', () => {
  it('is the screen’s, up to 1.5', () => {
    expect(pixelRatio(1)).toBe(1);
    expect(pixelRatio(2)).toBe(MAX_PIXEL_RATIO);
    expect(pixelRatio(3)).toBe(1.5);
  });
});

describe('playing the forecast', () => {
  it('goes round and round when started with the Play button', () => {
    expect(playStep(10, 0.5, 120)).toEqual({ t: 10.5, ended: false });
    expect(playStep(119.8, 0.5, 120)).toEqual({ t: 0, ended: false });
  });

  it('plays once when the page starts it, ending on the last step', () => {
    let t = 30;
    let steps = 0;
    for (;;) {
      const next = playStep(t, 0.05 * 3, 120, { once: true });
      t = next.t;
      steps++;
      if (next.ended) break;
      expect(steps).toBeLessThan(10_000);
    }
    expect(t).toBe(120);
    // About (120 - 30) / 3 seconds at 20 frames a second.
    expect(steps).toBeCloseTo(600, -1);
  });

  it('counts the page as left alone after ten minutes without input', () => {
    expect(unattended(UNATTENDED_MS - 1, 0)).toBe(false);
    expect(unattended(UNATTENDED_MS, 0)).toBe(true);
  });
});
