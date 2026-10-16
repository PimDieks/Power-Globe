import { Matrix4 } from 'three';
import { WORLD } from './field.js';
import { RATE, advectInto } from './flow.js';
import { pixelRatio } from './pacing.js';

const DEG = Math.PI / 180;
// Particles move in steps of this long, whatever the frame rate, and remember their position after
// each: TRAIL of them make a trail, TRAIL - 1 steps (25/60, about 0.42 seconds) of motion at any
// frame rate. (Not the steps of the global flow in flow.js, which follow the frame rate.)
export const TRAIL_STEP_S = 1 / 60;
export const TRAIL = 26;
// At most this many steps a frame (a quarter second, the longest frame, see flow.js): after a long
// gap the particles pick up where they were.
export const MAX_TRAIL_STEPS = 15;

// The steps to take for a frame of `dt` seconds with `remainder` seconds left over from earlier
// frames: { steps, remainder }. Time is kept, half a step either way, up to MAX_TRAIL_STEPS.
export function trailSteps(remainder, dt) {
  const total = remainder + dt;
  const steps = Math.round(total / TRAIL_STEP_S);
  if (steps > MAX_TRAIL_STEPS) return { steps: MAX_TRAIL_STEPS, remainder: 0 };
  return { steps, remainder: total - steps * TRAIL_STEP_S };
}
// Which of a trail's `length` remembered positions to draw through, every `stride`-th from the
// newest (0) and always the oldest, so the trail keeps its length.
export function drawnPoints(length, stride) {
  const last = length - 1;
  return Array.from({ length: Math.ceil(last / stride) + 1 }, (_, j) => Math.min(j * stride, last));
}
// Trails are drawn through every other position: they are smooth curves, so this looks the same,
// and the frame rate is limited by how fast the browser draws the canvas's lines (in the GPU
// process), which grows with their number of points: every position drew about 40 frames a
// second on a 1920×1200 canvas, every other one about 50.
export const DRAWN = drawnPoints(TRAIL, 2);
// Trails are drawn in steps that fade from the head (brightest) to the tail.
const AGE_ALPHA = [0.9, 0.6, 0.35, 0.15];
// The dark halo under the trails (see draw): how much wider than them, and its colour.
const HALO_WIDTH = 2.2;
const HALO_COLOR = 'rgba(0, 8, 20, 0.16)';
// Calmer wind draws dimmer trails.
const SLOW_WIND = 12;
const SLOW_ALPHA = 0.6;

// Position on the globe's surface (scaled to `radius`), matching three-globe's coordinates, written
// into `out` from `offset`.
export function toCartesianInto(out, offset, lat, lng, radius) {
  const phi = (90 - lat) * DEG;
  const theta = (90 - lng) * DEG;
  out[offset] = radius * Math.sin(phi) * Math.cos(theta);
  out[offset + 1] = radius * Math.cos(phi);
  out[offset + 2] = radius * Math.sin(phi) * Math.sin(theta);
  return out;
}

// The same, as a new [x, y, z].
export const toCartesian = (lat, lng, radius) => toCartesianInto([0, 0, 0], 0, lat, lng, radius);

// Pixel position of a world point through the column-major view-projection matrix `e`, written
// into `out` from `offset`: false (and nothing written) if it is behind the camera.
export function projectInto(out, offset, e, x, y, z, width, height) {
  const w = e[3] * x + e[7] * y + e[11] * z + e[15];
  if (w <= 0) return false;
  out[offset] = (((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) / 2) * width;
  out[offset + 1] = ((1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) / 2) * height;
  return true;
}

// The same, as a new [x, y], or null.
export const project = (e, x, y, z, width, height) => {
  const out = [0, 0];
  return projectInto(out, 0, e, x, y, z, width, height) ? out : null;
};

// Whether a point on the sphere faces a camera at (cx, cy, cz), rather than being over the horizon.
export const facesCamera = (x, y, z, cx, cy, cz, radiusSq) => x * cx + y * cy + z * cz > radiusSq;

// Wind particles for the zoomed-in view, drawn straight onto a screen-sized canvas over the
// globe rather than onto a texture on it, so trails stay crisp however far in you zoom. Each
// frame the trails are re-projected from their positions on the globe, so they stay attached
// to the map while it moves and leave no residue behind.
export class ScreenFlow {
  constructor(globe, container, { count = 2000, altitude = 0.0005 } = {}) {
    this.globe = globe;
    this.radius = globe.getGlobeRadius() * (1 + altitude);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'flow-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    container.after(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.matrix = new Matrix4();
    // Paths for the trails (a stand-in in tests).
    this.newPath = () => new Path2D();

    this.lat = new Float32Array(count);
    this.lng = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.slow = new Uint8Array(count);
    // Ring buffer of recent positions per particle: TRAIL slots of x, y, z.
    this.trail = new Float32Array(count * TRAIL * 3);
    this.head = 0;
    // Seconds of motion not stepped yet, or stepped ahead (see trailSteps).
    this.remainder = 0;
    this.wind = new Float32Array(2);
    this.next = new Float64Array(2);
    this.points = new Float32Array(DRAWN.length * 2);
    this.shown = new Uint8Array(DRAWN.length);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.setBounds(WORLD);
    this.visible = false;
  }

  resize() {
    // No sharper than the globe under it (see pacing.js).
    const dpr = pixelRatio();
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
    this.lineWidth = 1.4 * dpr;
  }

  set visible(value) {
    this.canvas.style.display = value ? '' : 'none';
    if (!value) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  get visible() {
    return this.canvas.style.display !== 'none';
  }

  // Area to keep particles in. Particles already inside stay put, so moving the view does
  // not reset the whole picture; the rest respawn inside the new area as they expire.
  setBounds(bounds) {
    this.bounds = bounds;
    this.rate = RATE * Math.min(1, (bounds.north - bounds.south) / 90);
    this.sinSouth = Math.sin(bounds.south * DEG);
    this.sinNorth = Math.sin(bounds.north * DEG);
    for (let i = 0; i < this.lat.length; i++) {
      if (!this.inside(this.lat[i], this.lng[i])) this.spawn(i, true);
    }
  }

  inside(lat, lng) {
    const { south, north, west, span } = this.bounds;
    return lat >= south && lat <= north && (((lng - west) % 360) + 360) % 360 <= span;
  }

  spawn(i, randomAge = false) {
    const { west, span } = this.bounds;
    this.lat[i] = Math.asin(this.sinSouth + Math.random() * (this.sinNorth - this.sinSouth)) / DEG;
    this.lng[i] = ((((west + Math.random() * span + 180) % 360) + 360) % 360) - 180;
    this.life[i] = 2 + Math.random() * 4;
    this.age[i] = randomAge ? Math.random() * this.life[i] : 0;
    // Start with the whole trail at the spawn point, so it grows out from there.
    const { trail } = this;
    const o = i * TRAIL * 3;
    toCartesianInto(trail, o, this.lat[i], this.lng[i], this.radius);
    for (let k = 1; k < TRAIL; k++) trail.copyWithin(o + k * 3, o, o + 3);
  }

  // The seconds to step after a frame of `dt`: all of them, as the trails are drawn again from
  // the camera on every frame the globe is drawn.
  take(dt) {
    return dt;
  }

  // Advance particles `dt` seconds through the wind from `sampleWind(lat, lng, out)`, in steps of
  // TRAIL_STEP_S, and draw.
  step(dt, sampleWind) {
    const { steps, remainder } = trailSteps(this.remainder, dt);
    this.remainder = remainder;
    for (let k = 0; k < steps; k++) this.trailStep(sampleWind);
    this.draw();
  }

  trailStep(sampleWind) {
    const { wind, next } = this;
    this.head = (this.head + 1) % TRAIL;
    for (let i = 0; i < this.lat.length; i++) {
      this.age[i] += TRAIL_STEP_S;
      const lat = this.lat[i];
      const lng = this.lng[i];
      const ok = sampleWind(lat, lng, wind) && !Number.isNaN(wind[0]) && !Number.isNaN(wind[1]);
      if (!ok || this.age[i] > this.life[i] || !this.inside(lat, lng)) {
        this.spawn(i);
        continue;
      }
      advectInto(next, lat, lng, wind[0], wind[1], TRAIL_STEP_S, this.rate);
      this.lat[i] = next[0];
      this.lng[i] = next[1];
      this.slow[i] = Math.hypot(wind[0], wind[1]) < SLOW_WIND ? 1 : 0;
      toCartesianInto(this.trail, (i * TRAIL + this.head) * 3, next[0], next[1], this.radius);
    }
  }

  draw() {
    const { ctx, canvas, trail, points, shown } = this;
    const camera = this.globe.camera();
    const e = this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const { x: cx, y: cy, z: cz } = camera.position;
    const radiusSq = this.radius * this.radius;
    const steps = AGE_ALPHA.length;
    const paths = Array.from({ length: steps * 2 }, () => this.newPath());

    for (let i = 0; i < this.lat.length; i++) {
      // Project the trail's drawn positions from newest to oldest.
      for (let j = 0; j < DRAWN.length; j++) {
        const o = (i * TRAIL + ((this.head - DRAWN[j] + TRAIL) % TRAIL)) * 3;
        const x = trail[o];
        const y = trail[o + 1];
        const z = trail[o + 2];
        shown[j] = facesCamera(x, y, z, cx, cy, cz, radiusSq) && projectInto(points, j * 2, e, x, y, z, canvas.width, canvas.height) ? 1 : 0;
      }
      // Each part of the trail in one fading step is one line through its points: a separate
      // segment for every pair of points made the trails several times slower to draw.
      const set = this.slow[i] ? steps : 0;
      let open = -1;
      for (let j = 0; j < DRAWN.length - 1; j++) {
        if (!shown[j] || !shown[j + 1]) {
          open = -1;
          continue;
        }
        const part = Math.floor((DRAWN[j] * steps) / (TRAIL - 1));
        const path = paths[set + part];
        if (open !== part) {
          path.moveTo(points[j * 2], points[j * 2 + 1]);
          open = part;
        }
        path.lineTo(points[j * 2 + 2], points[j * 2 + 3]);
      }
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A soft dark halo under the white trails, so they stay visible over bright imagery and clouds:
    // one wider stroke of all of them together, in one colour (a stroke for each fading step, as
    // the trails are drawn, made the frame rate half as high).
    const halo = this.newPath();
    for (const path of paths) halo.addPath(path);
    ctx.lineWidth = this.lineWidth * HALO_WIDTH;
    ctx.strokeStyle = HALO_COLOR;
    ctx.stroke(halo);
    ctx.lineWidth = this.lineWidth;
    paths.forEach((path, n) => {
      const alpha = AGE_ALPHA[n % steps] * (n >= steps ? SLOW_ALPHA : 1);
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.stroke(path);
    });
  }
}
