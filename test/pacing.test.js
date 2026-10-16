import { describe, expect, it } from 'vitest';
import {
  FrameBudget,
  FrameLoop,
  FrameMeter,
  INPUT_ACTIVE_MS,
  MAX_PIXEL_RATIO,
  MODE_FPS,
  STILL_AFTER_MS,
  UNATTENDED_MS,
  busyNow,
  frameStride,
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

  it('draws every other frame of a 144 Hz screen: 72 a second is closer to 60 than 48', () => {
    expect(framesDrawn(new FrameBudget(), 'active', 144)).toBeCloseTo(72, 1);
  });

  it('draws every frame of a 75 or 90 Hz screen while active, rather than every other', () => {
    expect(framesDrawn(new FrameBudget(), 'active', 75)).toBeCloseTo(75, 1);
    expect(framesDrawn(new FrameBudget(), 'active', 90)).toBeCloseTo(90, 1);
  });

  it('draws as close to 60 frames a second as the screen allows, a little over rather than far under', () => {
    const active = (hz) => hz / frameStride(1000 / hz, MODE_FPS.active, true);
    expect([60, 75, 90, 120, 144, 240].map(active)).toEqual([60, 75, 90, 60, 72, 60]);
    // Not 100 or 82.5: those are further over than 50 and 55 are under.
    expect(active(100)).toBe(50);
    expect(active(165)).toBe(55);
    expect(active(60.1)).toBeCloseTo(60.1, 5);
    expect(active(59.9)).toBeCloseTo(59.9, 5);
    for (let hz = 30; hz <= 360; hz += 0.5) expect(active(hz)).toBeLessThan(60 * 1.6);
  });

  it('never goes over the rate when idle, still, paused or playing the clouds loop', () => {
    for (const hz of [60, 75, 90, 120, 144, 240]) {
      for (const mode of ['loop', 'idle', 'still', 'paused']) {
        expect(frameStride(1000 / hz, MODE_FPS[mode])).toBe(Math.ceil(hz / MODE_FPS[mode]));
        expect(framesDrawn(new FrameBudget(), mode, hz)).toBeLessThanOrEqual(MODE_FPS[mode] + 0.01);
      }
    }
  });

  it('copes with jittery frame times', () => {
    expect(framesDrawn(new FrameBudget(), 'active', 60, { jitter: 1.5 })).toBeCloseTo(60, 1);
    expect(framesDrawn(new FrameBudget(), 'active', 120, { jitter: 1 })).toBeCloseTo(60, 1);
    // A whole number of frames a step, however the measured period wavers.
    expect(framesDrawn(new FrameBudget(), 'still', 60, { jitter: 2 })).toBeCloseTo(5, 5);
    expect(framesDrawn(new FrameBudget(), 'idle', 120, { jitter: 2 })).toBeCloseTo(20, 5);
  });

  it('draws about 20 frames a second when idle and 5 when still', () => {
    for (const hz of [60, 75, 90, 120, 144, 240]) {
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
    // Two frames after one was drawn,
    while (!budget.due(t, 'still')) t += frame;
    for (let k = 0; k < 2; k++) expect(budget.due((t += frame), 'still')).toBe(false);
    t += frame;
    // someone drags the globe: the next frame of the screen is drawn, and every other after it.
    budget.input(t);
    const drawn = [];
    for (let k = 0; k < 6; k++, t += frame) drawn.push(budget.due(t, budget.mode(t)));
    expect(drawn).toEqual([true, false, true, false, true, false]);
  });
});

describe('the wind flow, which moves all the time', () => {
  it('keeps the page idle rather than still, at 20 frames a second', () => {
    const budget = new FrameBudget(0);
    const late = INPUT_ACTIVE_MS + STILL_AFTER_MS + 60_000;
    expect(budget.mode(late, { moving: true })).toBe('idle');
    expect(budget.mode(late)).toBe('still');
    expect(budget.mode(1000, { moving: true })).toBe('active');
  });

  it('does not keep the globe turning: the page rests after a while either way', () => {
    const budget = new FrameBudget(0);
    expect(budget.resting(INPUT_ACTIVE_MS + STILL_AFTER_MS - 1)).toBe(false);
    expect(budget.resting(INPUT_ACTIVE_MS + STILL_AFTER_MS + 1)).toBe(true);
    budget.input(10 * 60_000);
    expect(budget.resting(10 * 60_000 + 1)).toBe(false);
  });
});

describe('what keeps the page busy', () => {
  it('is playing or a camera flight, whatever the input', () => {
    expect(busyNow({ playing: true, attended: false })).toBe(true);
    expect(busyNow({ flying: true, attended: false })).toBe(true);
    expect(busyNow({})).toBe(false);
  });

  it('is following an aircraft only while someone has touched the page lately', () => {
    expect(busyNow({ following: true })).toBe(true);
    expect(busyNow({ following: true, attended: false })).toBe(false);
  });
});

describe('the clouds loop', () => {
  it('is drawn 30 times a second while nothing else makes the page active', () => {
    const budget = new FrameBudget(0);
    const t = INPUT_ACTIVE_MS + 1;
    expect(budget.mode(t, { looping: true })).toBe('loop');
    expect(framesDrawn(budget, 'loop', 60, { start: t })).toBeCloseTo(30, 1);
    expect(framesDrawn(new FrameBudget(), 'loop', 120)).toBeCloseTo(30, 1);
    expect(framesDrawn(new FrameBudget(), 'loop', 144)).toBeLessThanOrEqual(30);
  });

  it('is drawn at the full rate after input, while playing, flying or following, and not at all under the pilot view', () => {
    const budget = new FrameBudget(0);
    // Loading the page counts as input.
    expect(budget.mode(INPUT_ACTIVE_MS - 1, { looping: true })).toBe('active');
    expect(budget.mode(INPUT_ACTIVE_MS + 1, { looping: true, busy: true })).toBe('active');
    expect(budget.mode(INPUT_ACTIVE_MS + 2, { looping: true, paused: true })).toBe('paused');
    budget.input(60_000);
    expect(budget.mode(60_001, { looping: true })).toBe('active');
    expect(budget.mode(60_000 + INPUT_ACTIVE_MS + 1, { looping: true })).toBe('loop');
  });

  it('counts as busy: the page is idle, not still, just after a long loop', () => {
    const budget = new FrameBudget(0);
    expect(budget.mode(10 * 60_000, { looping: true })).toBe('loop');
    expect(budget.mode(10 * 60_000 + 1)).toBe('idle');
    expect(budget.mode(10 * 60_000 + STILL_AFTER_MS + 1)).toBe('still');
  });
});

// A screen refreshing `hz` times a second, for a FrameLoop (pass `env` to it). A frame asked for runs
// at the screen's next frame, its time off by `jitter` ms either way, or with `stale`, when asked
// for at the end of a sleep, at once with the time of the frame before. A sleep ends `late` ms after
// the time asked for. Checks that only one frame or sleep is ever pending.
function fakeScreen(hz, { late = 0, jitter = 0, stale = false, start = 10_000 } = {}) {
  const period = 1000 / hz;
  let now = start;
  let frame = null;
  let timer = null;
  let ids = 0;
  let inTimer = false;
  const vsyncAfter = (t) => start + (Math.floor((t - start) / period + 1e-9) + 1) * period;
  const env = {
    raf(cb) {
      expect(frame).toBeNull();
      if (stale && inTimer) frame = { cb, at: now, time: vsyncAfter(now) - period };
      else {
        const at = vsyncAfter(now);
        // Off one way or the other at random, but the same for every run.
        const index = Math.round((at - start) / period);
        frame = { cb, at, time: at + (((index * 2654435761) >>> 13) & 1 ? jitter : -jitter) };
      }
    },
    setTimer(cb, ms) {
      expect(timer).toBeNull();
      timer = { cb, at: now + ms + late, id: ++ids };
      return timer.id;
    },
    clearTimer(id) {
      if (timer?.id === id) timer = null;
    },
    clock: () => now,
  };
  return {
    env,
    start,
    pending: () => (frame ? 1 : 0) + (timer ? 1 : 0),
    // Runs what is pending up to `until` (ms); errors thrown by a frame are dropped, as the browser
    // would report them and go on.
    runUntil(until) {
      for (;;) {
        const next = frame && (!timer || frame.at <= timer.at) ? frame : timer;
        if (!next || next.at > until) break;
        now = next.at;
        if (next === timer) {
          timer = null;
          inTimer = true;
          next.cb();
          inTimer = false;
        } else {
          frame = null;
          try {
            next.cb(next.time);
          } catch {
            // Reported by the browser.
          }
        }
        expect(frame || timer).toBeTruthy();
      }
      now = until;
    },
  };
}

// A page drawing in `mode` on a fakeScreen (see there for `options`), after two seconds active,
// which measure the screen, and one to settle: the frames drawn and the times it woke a second.
function sleepyPage(hz, mode, { seconds = 20, ...options } = {}) {
  const screen = fakeScreen(hz, options);
  const budget = new FrameBudget();
  let current = 'active';
  let counting = false;
  let drawn = 0;
  let woken = 0;
  const loop = new FrameLoop(
    (now, slept) => {
      if (counting) woken++;
      if (budget.due(now, current, slept) && counting) drawn++;
    },
    (now) => budget.wakeAt(now, current),
    screen.env,
  );
  loop.start();
  screen.runUntil(screen.start + 2000);
  current = mode;
  screen.runUntil(screen.start + 3000);
  counting = true;
  screen.runUntil(screen.start + 3000 + seconds * 1000);
  return { fps: drawn / seconds, wakes: woken / seconds, budget };
}

describe('sleeping between frames', () => {
  const HZ = [60, 75, 90, 120, 144, 240];
  const SLEEPY = ['loop', 'idle', 'still', 'paused'];

  // A sleep ends a frame and a half before the frame due, and at least 16 ms: the frames of the
  // screen the page then wakes for, one for each frame drawn and those before it.
  const wakesPerFrame = (hz) => 1 + Math.ceil(Math.max(1.5, 16 / (1000 / hz)) - 0.5);

  it('draws as often as when it wakes for every frame of the screen, and wakes two to five times per frame drawn', () => {
    for (const hz of HZ) {
      for (const mode of SLEEPY) {
        for (const options of [{}, { late: 2 }, { jitter: 0.5 }, { late: 4, jitter: 0.5 }]) {
          const { fps, wakes } = sleepyPage(hz, mode, options);
          // Jitter can cost a frame now and then.
          expect(fps).toBeGreaterThanOrEqual(0.95 * framesDrawn(new FrameBudget(), mode, hz, { seconds: 20 }));
          expect(fps).toBeLessThanOrEqual(MODE_FPS[mode] * 1.02);
          expect(wakes).toBeLessThanOrEqual(wakesPerFrame(hz) * fps + 2);
        }
      }
    }
  });

  it('wakes for every frame of the screen while active', () => {
    expect(sleepyPage(120, 'active').wakes).toBeCloseTo(120, 0);
  });

  // Never over the rate, give or take the 2% frameStride allows for jitter.
  it('never goes over the rate with timers more than a frame late, and stays near it when idle', () => {
    for (const [hz, late] of [[120, 16], [144, 16], [240, 16], [60, 15.6], [60, 25]]) {
      for (const mode of SLEEPY) expect(sleepyPage(hz, mode, { late }).fps).toBeLessThanOrEqual(MODE_FPS[mode] * 1.02);
      // Up to a frame and a half late (16 ms at 90 Hz), a frame is drawn at most one of the screen's late.
      if (late <= 16) expect(sleepyPage(hz, 'idle', { late }).fps).toBeGreaterThanOrEqual(0.8 * MODE_FPS.idle);
    }
  });

  it('stays at the rate on a 120 Hz screen with timers rounded up to 15.6 ms', () => {
    for (const mode of SLEEPY) {
      const { fps } = sleepyPage(120, mode, { late: 15.6 });
      expect(fps).toBeGreaterThanOrEqual(0.95 * framesDrawn(new FrameBudget(), mode, 120, { seconds: 20 }));
    }
  });

  it('does not sleep after a frame that woke it, so what the frame started is drawn on the next', () => {
    const screen = fakeScreen(120);
    const budget = new FrameBudget(screen.start);
    let mode = 'still';
    // The mode the frame was drawn in, which the loop sleeps on, as the page's frameMode.
    let frameMode = mode;
    let wakeNext = false;
    let wokeAt = null;
    const drawn = [];
    const loop = new FrameLoop(
      (now, slept) => {
        frameMode = mode;
        const due = budget.due(now, frameMode, slept);
        if (due) drawn.push(now);
        // Right after a frame at the still rate, when the loop would sleep longest.
        if (wakeNext && due) {
          // Something in the frame (say, Play pressed from the keyboard) wants the full rate.
          wakeNext = false;
          wokeAt = now;
          mode = 'active';
          loop.wake();
        }
      },
      (now) => budget.wakeAt(now, frameMode),
      screen.env,
    );
    loop.start();
    screen.runUntil(screen.start + 5000);
    wakeNext = true;
    screen.runUntil(screen.start + 6000);
    // The screen's next frame is drawn, not the next one due at the still rate.
    const next = drawn.find((t) => t > wokeAt);
    expect(next - wokeAt).toBeLessThan(3 * (1000 / 120));
  });

  it('starts once, however often it is started', () => {
    const screen = fakeScreen(60);
    const budget = new FrameBudget();
    const loop = new FrameLoop((now, slept) => budget.due(now, 'still', slept), (now) => budget.wakeAt(now, 'still'), screen.env);
    loop.start();
    screen.runUntil(screen.start + 1000);
    loop.start();
    loop.start();
    expect(screen.pending()).toBe(1);
  });

  it('copes with a frame that runs at once with the time of the frame before, after a sleep', () => {
    for (const hz of [60, 120, 144]) {
      for (const mode of SLEEPY) {
        const { fps } = sleepyPage(hz, mode, { stale: true });
        expect(fps).toBeLessThanOrEqual(MODE_FPS[mode] * 1.02);
        expect(fps).toBeCloseTo(framesDrawn(new FrameBudget(), mode, hz, { seconds: 20 }), 0);
      }
    }
  });

  it('keeps measuring the screen while it sleeps, on the frames it wakes for', () => {
    const { budget } = sleepyPage(144, 'still', { seconds: 0 });
    expect(budget.period).toBeCloseTo(1000 / 144, 1);
    // Measured on a 60 Hz screen, then on a 144 Hz one while still.
    const moved = new FrameBudget();
    moved.period = 1000 / 60;
    const screen = fakeScreen(144);
    const loop = new FrameLoop((now, slept) => moved.due(now, 'still', slept), (now) => moved.wakeAt(now, 'still'), screen.env);
    loop.start();
    screen.runUntil(screen.start + 120_000);
    expect(moved.period).toBeCloseTo(1000 / 144, 1);
  });

  it('keeps exactly one frame or sleep pending, however often it is woken', () => {
    const screen = fakeScreen(120);
    const budget = new FrameBudget();
    const loop = new FrameLoop((now, slept) => budget.due(now, 'still', slept), (now) => budget.wakeAt(now, 'still'), screen.env);
    loop.start();
    for (let t = screen.start; t < screen.start + 5000; t += 7) {
      screen.runUntil(t);
      expect(screen.pending()).toBe(1);
      if (t % 3 === 0) loop.wake();
      if (t % 5 === 0) {
        loop.wake();
        loop.wake();
      }
      expect(screen.pending()).toBe(1);
    }
  });

  it('wakes at once for input, and draws the next frame', () => {
    const screen = fakeScreen(120);
    const budget = new FrameBudget(screen.start);
    const drawn = [];
    const loop = new FrameLoop(
      (now, slept) => budget.due(now, budget.mode(now), slept) && drawn.push(now),
      (now) => budget.wakeAt(now, budget.mode(now)),
      screen.env,
    );
    loop.start();
    const still = screen.start + INPUT_ACTIVE_MS + STILL_AFTER_MS + 10_000;
    screen.runUntil(still);
    expect(budget.mode(still)).toBe('still');
    // Someone drags the globe: the screen's next frame is drawn, and every other one after it.
    budget.input(still);
    loop.wake();
    drawn.length = 0;
    screen.runUntil(still + 100);
    expect(drawn[0] - still).toBeLessThan(1000 / 120 + 0.01);
    expect(drawn.length).toBeGreaterThanOrEqual(5);
  });

  it('goes on after a frame that throws', () => {
    const screen = fakeScreen(60);
    let calls = 0;
    const loop = new FrameLoop(
      () => {
        calls++;
        throw new Error('frame');
      },
      () => {
        throw new Error('never asked');
      },
      screen.env,
    );
    loop.start();
    screen.runUntil(screen.start + 1000);
    expect(calls).toBeGreaterThanOrEqual(59);
    // Also when working out how long to sleep throws.
    let sleeps = 0;
    const other = fakeScreen(60);
    const loop2 = new FrameLoop(
      () => {},
      () => {
        sleeps++;
        throw new Error('sleep');
      },
      other.env,
    );
    loop2.start();
    other.runUntil(other.start + 1000);
    expect(sleeps).toBeGreaterThanOrEqual(59);
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
