// How hard the page works: how often the globe is drawn, and how long the forecast plays by itself.
// The globe could be drawn on every frame the screen shows (120 a second on some laptops) for
// as long as the page is open; it is drawn only as often as there is something to see.

// The renderer's pixel ratio is capped here: on a Retina screen 2 would draw nearly twice the
// pixels of 1.5 for a difference that is hard to see on a moving globe.
export const MAX_PIXEL_RATIO = 1.5;
export const pixelRatio = (dpr = globalThis.devicePixelRatio || 1) => Math.min(dpr, MAX_PIXEL_RATIO);

// Frames a second at most: while someone is using the page (or it is playing, following an
// aircraft or flying the camera), while the clouds loop plays by itself (its images cross-fade
// slowly, so half the rate looks as smooth), while nobody is, after a while of that, and while the
// pilot view covers the globe (which is then not drawn at all; the page only keeps the traffic up
// to date). Active mode may go a little over its rate, see frameStride.
export const MODE_FPS = { active: 60, loop: 30, idle: 20, still: 5, paused: 10 };
// Input keeps the page active for this long.
export const INPUT_ACTIVE_MS = 5000;
// After this long idle, the globe stops turning and is drawn at the 'still' rate. Idle starts when
// the page stops being active: INPUT_ACTIVE_MS after the last input, or when what kept it busy stops.
export const STILL_AFTER_MS = 2 * 60_000;
// What plays or moves by itself (a play started with the Play button, the clouds loop, following an
// aircraft) stops, or stops counting as busy, after this long without input.
export const UNATTENDED_MS = 10 * 60_000;
// Bounds for the measured time between the screen's frames (a hidden tab or a hitch gives longer).
const MIN_PERIOD_MS = 3;
const MAX_PERIOD_MS = 50;

// Whether nobody has touched the page for UNATTENDED_MS; `lastInput` in the same clock as `now`.
export const unattended = (now, lastInput) => now - lastInput >= UNATTENDED_MS;

// Whether something moves on screen by itself that should look smooth: the forecast playing, a
// camera flight, and, while someone has touched the page in the last UNATTENDED_MS (`attended`),
// following an aircraft, which otherwise goes on for as long as it is left. (The clouds loop has a
// mode of its own, see FrameBudget.mode.)
export const busyNow = ({ playing = false, flying = false, following = false, attended = true }) =>
  playing || flying || (following && attended);

// Every how many of the screen's frames to draw, on a screen whose frames are `period` ms apart, for
// `fps` frames a second: the fewest that keep the rate at or under `fps`, give or take 2% for the
// measured period's jitter (every frame at 60 Hz, also 60.1, every other at 120, every third at
// 144). With `over`, the rate may also go over `fps`, when that comes closer to it: closest by
// ratio, a rate above `fps` counting half as far off as one below it. For 60, that is every frame
// at 75 and 90 Hz, every other at 120 and 144 (72 a second) and every fourth at 240; never more
// than about 1.6 times `fps`.
export function frameStride(period, fps, over = false) {
  const k = Math.max(1, Math.ceil(1000 / fps / period / 1.02));
  if (!over || k === 1) return k;
  const below = 1000 / (k * period);
  const above = 1000 / ((k - 1) * period);
  return Math.log(above / fps) / 2 < Math.log(fps / below) ? k - 1 : k;
}

// A sleep ends this many of the screen's frames before the next one due, and at least
// WAKE_EARLY_MS, so that a timer that fires late (by up to a frame and a half, or by up to 15.6 ms
// on Windows on battery, which rounds timers up to that: more than a frame at 120 Hz) still asks
// for that frame in time. The frame it wakes for is usually the one before.
const WAKE_FRAMES_EARLY = 1.5;
const WAKE_EARLY_MS = 16;

// Which rate applies, and whether a frame is due. Times are in ms (performance.now()).
export class FrameBudget {
  constructor(now = 0) {
    // The page counts as active until this time; loading it counts as input.
    this.activeUntil = now + INPUT_ACTIVE_MS;
    this.lastInput = now;
    this.drawnAt = -Infinity;
    // The time between the screen's frames, measured as they come (see due).
    this.period = 1000 / 60;
    this.seenAt = null;
  }

  input(now) {
    this.lastInput = now;
    this.activeUntil = Math.max(this.activeUntil, now + INPUT_ACTIVE_MS);
  }

  // Something moving by itself (`busy`, see mode) keeps the page active until `now`, so the idle
  // time counts from when it stops.
  busy(now) {
    this.activeUntil = Math.max(this.activeUntil, now);
  }

  // `busy`: playing, following, a camera flight or anything else that moves on screen by itself
  // and should look smooth (this also calls busy(now)). `looping`: the clouds loop plays, which
  // keeps the page busy at the 'loop' rate unless it is active anyway. `moving`: something moves
  // on screen all the time (the wind flow), which would jump at the 'still' rate: the page stays
  // 'idle' instead. `paused`: the globe is covered and not drawn.
  mode(now, { busy = false, looping = false, moving = false, paused = false } = {}) {
    if (paused) return 'paused';
    if (busy) {
      this.busy(now);
      return 'active';
    }
    if (now < this.activeUntil) return 'active';
    if (looping) {
      this.busy(now);
      return 'loop';
    }
    return moving || !this.resting(now) ? 'idle' : 'still';
  }

  // Whether nobody has used the page for STILL_AFTER_MS since it was last active: the globe stops
  // turning then, whatever the mode.
  resting(now) {
    return now - this.activeUntil >= STILL_AFTER_MS;
  }

  // Every how many of the screen's frames to draw in `mode` (see frameStride).
  stride(mode) {
    return frameStride(this.period, MODE_FPS[mode], mode === 'active');
  }

  // Whether to draw the screen's frame at `now` in `mode`; call it for every frame the page sees.
  // Frames are drawn every k-th of the screen's (see stride), k chosen from the measured time
  // between the screen's frames. `slept`: the page slept before this frame (see wakeAt), so the
  // time since the one before spans frames it did not see, and is not measured.
  due(now, mode, slept = false) {
    if (this.seenAt !== null && !slept) {
      const delta = Math.min(MAX_PERIOD_MS, Math.max(MIN_PERIOD_MS, now - this.seenAt));
      this.period += (delta - this.period) * 0.05;
    }
    this.seenAt = now;
    // Half a frame early counts as on time, as frame times jitter.
    if (now - this.drawnAt < (this.stride(mode) - 0.5) * this.period) return false;
    this.drawnAt = now;
    return true;
  }

  // When to ask for the screen's next frame, after the one at `now` in `mode` (call it after due):
  // null for the very next one, or, when the next frame due is far enough off, a time (ms) to sleep
  // until first, a little before that frame (see WAKE_FRAMES_EARLY). Changes nothing. Every mode but
  // 'active' draws few enough frames to sleep between them.
  wakeAt(now, mode) {
    if (mode === 'active') return null;
    const early = Math.max(WAKE_FRAMES_EARLY * this.period, WAKE_EARLY_MS);
    const at = this.drawnAt + this.stride(mode) * this.period - early;
    return at - now < this.period ? null : at;
  }
}

// Runs `frame(now, slept)` on the screen's frames (`now`: the frame's time; `slept`: whether the
// loop slept before it), one at a time. After each it asks for the next frame, or, when
// `sleepUntil(now)` gives a time, sleeps until then first; wake() ends a sleep at once (or, called
// during a frame, keeps the loop from sleeping after it). The next
// frame is asked for whatever happens in `frame`, so an error in it cannot stop the loop. Exactly
// one frame or one sleep is pending at any time. `raf`, `setTimer`, `clearTimer` and `clock` stand
// in for requestAnimationFrame, setTimeout, clearTimeout and performance.now.
export class FrameLoop {
  constructor(frame, sleepUntil, {
    raf = (cb) => requestAnimationFrame(cb),
    setTimer = (cb, ms) => setTimeout(cb, ms),
    clearTimer = (id) => clearTimeout(id),
    clock = () => performance.now(),
  } = {}) {
    Object.assign(this, { frame, sleepUntil, raf, setTimer, clearTimer, clock });
    this.started = false;
    this.asked = false;
    this.timer = null;
    this.slept = false;
    // Whether a frame is running, and whether wake() was called while it ran.
    this.running = false;
    this.woken = false;
    this.run = this.run.bind(this);
    this.timeUp = this.timeUp.bind(this);
  }

  // Starts the loop; once only.
  start() {
    if (this.started) return;
    this.started = true;
    this.ask();
  }

  // Ends a sleep, if the loop is asleep: the screen's next frame is asked for at once. Called during
  // a frame (by something the frame does), the loop does not sleep after it.
  wake() {
    if (this.running) {
      this.woken = true;
      return;
    }
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
    this.ask();
  }

  ask() {
    if (this.asked) return;
    this.asked = true;
    this.raf(this.run);
  }

  timeUp() {
    this.timer = null;
    this.ask();
  }

  run(now) {
    this.asked = false;
    const slept = this.slept;
    this.slept = false;
    let at = null;
    this.running = true;
    this.woken = false;
    try {
      this.frame(now, slept);
      at = this.sleepUntil(now);
    } finally {
      this.running = false;
      if (at === null || this.woken) {
        this.ask();
      } else {
        this.slept = true;
        this.timer = this.setTimer(this.timeUp, Math.max(0, at - this.clock()));
      }
    }
  }
}

// Frames drawn in the last second, for diagnostics.
export class FrameMeter {
  constructor(size = 256) {
    this.times = new Float64Array(size).fill(-Infinity);
    this.next = 0;
  }

  count(now) {
    this.times[this.next] = now;
    this.next = (this.next + 1) % this.times.length;
  }

  fps(now) {
    let n = 0;
    for (const t of this.times) if (t > now - 1000) n++;
    return n;
  }
}

// The forecast plays by itself once, from where it starts to its end; a play someone starts
// goes round and round, until nobody has touched the page for UNATTENDED_MS.

// The timeline position after moving `by` steps from `t` on a timeline whose last step is `last`:
// { t, ended }. Playing `once`, it ends at the last step; otherwise it starts again from the first.
export function playStep(t, by, last, { once = false } = {}) {
  const next = t + by;
  if (next < last) return { t: next, ended: false };
  return once ? { t: last, ended: true } : { t: 0, ended: false };
}
