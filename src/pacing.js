// How hard the page works: how often the globe is drawn, and how long the forecast plays by itself.
// The globe could be drawn on every frame the screen shows (120 a second on some laptops) for
// as long as the page is open; it is drawn only as often as there is something to see.

// The renderer's pixel ratio is capped here: on a Retina screen 2 would draw nearly twice the
// pixels of 1.5 for a difference that is hard to see on a moving globe.
export const MAX_PIXEL_RATIO = 1.5;
export const pixelRatio = (dpr = globalThis.devicePixelRatio || 1) => Math.min(dpr, MAX_PIXEL_RATIO);

// Frames a second at most: while someone is using the page (or it is playing, following an
// aircraft or flying the camera), while nobody is, after a while of that, and while the pilot view
// covers the globe (which is then not drawn at all; the page only keeps the traffic up to date).
export const MODE_FPS = { active: 60, idle: 20, still: 5, paused: 10 };
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
// following an aircraft or the clouds loop, which otherwise go on for as long as they are left.
export const busyNow = ({ playing = false, flying = false, following = false, looping = false, attended = true }) =>
  playing || flying || ((following || looping) && attended);

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
  // and should look smooth (this also calls busy(now)). `paused`: the globe is covered and not drawn.
  mode(now, { busy = false, paused = false } = {}) {
    if (paused) return 'paused';
    if (busy) {
      this.busy(now);
      return 'active';
    }
    if (now < this.activeUntil) return 'active';
    return now - this.activeUntil < STILL_AFTER_MS ? 'idle' : 'still';
  }

  // Whether to draw the screen's frame at `now` in `mode`; call it for every frame the screen
  // shows. Frames are drawn every k-th of the screen's, k chosen from the measured frame period so
  // the rate stays at or under the mode's: every frame at 60 Hz (also 60.1), every other at 120,
  // every third at 144.
  due(now, mode) {
    if (this.seenAt !== null) {
      const delta = Math.min(MAX_PERIOD_MS, Math.max(MIN_PERIOD_MS, now - this.seenAt));
      this.period += (delta - this.period) * 0.05;
    }
    this.seenAt = now;
    const k = Math.max(1, Math.ceil(1000 / MODE_FPS[mode] / this.period - 0.1));
    // Half a frame early counts as on time, as frame times jitter.
    if (now - this.drawnAt < (k - 0.5) * this.period) return false;
    this.drawnAt = now;
    return true;
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
