import * as THREE from 'three';
import { WORLD, patchGeometry } from './field.js';

const DEG = Math.PI / 180;
// How far particles travel: degrees per second for each km/h of wind, at full-globe scale.
export const RATE = 0.22;
// Share of trail brightness lost per frame at 60 fps; lower means longer trails.
const FADE = 0.035;
// Faster wind draws brighter trails.
const SPEED_BANDS = [8, 20, 38];
const BAND_ALPHA = [0.16, 0.32, 0.55, 0.85];
// Trails fade on an 8-bit canvas, so they never quite reach zero: with FADE, alpha gets stuck
// below about 14/255. The layer's shader treats anything that faint as fully transparent.
const RESIDUE = 0.06;
// The canvas the trails are painted on: on a large screen 1448 × 724, 4 MB to send to the graphics
// card for each step, half of 2048 × 1024 and hard to tell from it on the globe (1024 × 512 looked
// smeared); on a small one, where the globe covers fewer pixels, 1024 × 512 (2 MB). Zoomed in, the
// screen-sized layer (see screenflow.js) takes over.
export const WIDTH = 1448;
export const SMALL_WIDTH = 1024;
// The particles move, and the canvas goes to the graphics card, at most this often a second: more
// would not show, as each upload is all a frame can see of them. A step a little early counts, as
// frame times jitter.
export const STEPS_PER_SECOND = 30;
// While nobody is using the page (the loop, idle and still modes in pacing.js) at most this often:
// every frame the globe is drawn when idle, 20 a second (about 80 MB a second at 1448 × 724), so
// the wind moves on every frame, and every other one while the clouds loop plays (30 a second).
export const RESTING_STEPS_PER_SECOND = 20;
const EARLY_S = 0.004;
// The longest step: a frame of the page's slowest rate (5 a second, see pacing.js), so particles
// keep their speed then.
export const MAX_STEP_S = 0.25;
// A step is moved and drawn in parts of at most this long, each its own short segment, so that the
// trails curve with the wind however often they are stepped; at most MAX_SUBSTEPS of them.
export const SUBSTEP_S = 1 / 30;
export const MAX_SUBSTEPS = Math.ceil(MAX_STEP_S / SUBSTEP_S);

// The parts a step of `dt` seconds is moved in (see SUBSTEP_S).
export const substeps = (dt) => Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(dt / SUBSTEP_S - 0.01)));

// Motion waiting to be stepped: `pending` seconds plus a frame of `dt`, at most `perSecond` steps a
// second. Returns { pending, step }: the seconds to step now (0 while fewer than a step's worth are
// waiting) and what is left waiting.
export function takeStep(pending, dt, perSecond = STEPS_PER_SECOND) {
  const total = pending + dt;
  if (total < 1 / perSecond - EARLY_S) return { pending: total, step: 0 };
  return { pending: 0, step: Math.min(MAX_STEP_S, total) };
}

// Eastward (u) and northward (v) components of wind blowing *from* `direction` degrees.
export function windComponents(speed, direction) {
  if (speed == null || direction == null) return [NaN, NaN];
  return [-speed * Math.sin(direction * DEG), -speed * Math.cos(direction * DEG)];
}

// u/v grids for every forecast step.
export function windGrids(speedSteps, directionSteps) {
  return speedSteps.map((speeds, s) => {
    const u = new Float32Array(speeds.length);
    const v = new Float32Array(speeds.length);
    speeds.forEach((speed, i) => {
      [u[i], v[i]] = windComponents(speed, directionSteps[s][i]);
    });
    return { u, v };
  });
}

// Move a point `seconds` along wind (u, v in km/h), writing [lat, lng] into `out`. Longitude steps
// widen towards the poles so motion looks even across the sphere.
export function advectInto(out, lat, lng, u, v, seconds, rate = RATE) {
  const k = seconds * rate;
  const cos = Math.max(0.15, Math.cos(lat * DEG));
  const nextLng = lng + (u * k) / cos;
  out[0] = lat + v * k;
  out[1] = ((((nextLng + 180) % 360) + 360) % 360) - 180;
  return out;
}

// The same, as a new [lat, lng].
export const advect = (lat, lng, u, v, seconds, rate = RATE) => advectInto([0, 0], lat, lng, u, v, seconds, rate);

// Glowing particles drifting with the wind, painted with fading trails onto a canvas that
// wraps the sphere (or, zoomed in, just the area in view) above the colour field.
export class WindFlow {
  constructor(globe, { bounds = WORLD, count = 6000, width = WIDTH, height = width / 2, lineWidth = 1, altitude = 0.0016 } = {}) {
    this.globe = globe;
    this.altitude = altitude;
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.lineWidth = lineWidth;

    this.lat = new Float32Array(count);
    this.lng = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.wind = new Float32Array(2);
    this.next = new Float64Array(2);
    // Each particle's path in the step being drawn: up to MAX_SUBSTEPS + 1 points (x, y), how many,
    // and its speed band.
    this.points = new Float32Array(count * (MAX_SUBSTEPS + 1) * 2);
    this.drawn = new Uint8Array(count);
    this.band = new Uint8Array(count);
    // Seconds of motion not stepped yet (see STEPS_PER_SECOND).
    this.pending = 0;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // No mipmaps: they would be made again on the graphics card for every upload.
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.anisotropy = Math.min(4, globe.renderer().capabilities.getMaxAnisotropy());
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        diffuseColor.a = clamp((diffuseColor.a - ${RESIDUE}) / ${1 - RESIDUE}, 0.0, 1.0);`,
      );
    };
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.renderOrder = -1;
    this.mesh.raycast = () => {};
    globe.scene().add(this.mesh);
    this.setBounds(bounds);
  }

  // Move the layer to cover `bounds`. Particle speed scales with the area so that motion
  // looks the same on screen at any zoom.
  setBounds(bounds) {
    this.bounds = bounds;
    this.rate = RATE * Math.min(1, (bounds.north - bounds.south) / 90);
    this.sinSouth = Math.sin(bounds.south * DEG);
    this.sinNorth = Math.sin(bounds.north * DEG);
    this.mesh.geometry.dispose();
    this.mesh.geometry = patchGeometry(this.globe, bounds, this.altitude);
    this.ctx.clearRect(0, 0, this.width, this.height);
    for (let i = 0; i < this.lat.length; i++) this.spawn(i, true);
  }

  set visible(value) {
    this.mesh.visible = value;
    if (!value) this.ctx.clearRect(0, 0, this.width, this.height);
  }

  get visible() {
    return this.mesh.visible;
  }

  // Respawn particle `i` somewhere random in the area, spread evenly over the sphere's surface.
  spawn(i, randomAge = false) {
    const { west, span } = this.bounds;
    this.lat[i] = Math.asin(this.sinSouth + Math.random() * (this.sinNorth - this.sinSouth)) / DEG;
    this.lng[i] = ((((west + Math.random() * span + 180) % 360) + 360) % 360) - 180;
    this.life[i] = 2 + Math.random() * 4;
    this.age[i] = randomAge ? Math.random() * this.life[i] : 0;
  }

  // Pixel x of `lng` in this layer's canvas, or NaN outside its bounds.
  x(lng) {
    const { west, span } = this.bounds;
    const rel = (((lng - west) % 360) + 360) % 360;
    return rel > span ? NaN : (rel / span) * this.width;
  }

  // Pixel y of `lat` in this layer's canvas, or NaN outside its bounds.
  y(lat) {
    const { south, north } = this.bounds;
    return lat < south || lat > north ? NaN : ((north - lat) / (north - south)) * this.height;
  }

  // The seconds to step after a frame of `dt`, or 0 if no step is due: at most `perSecond` steps
  // are taken, shorter frames adding up until one is due.
  take(dt, perSecond = STEPS_PER_SECOND) {
    const { pending, step } = takeStep(this.pending, dt, perSecond);
    this.pending = pending;
    return step;
  }

  // Advance every particle `dt` seconds (see take), in substeps (see SUBSTEP_S), and draw the path
  // each took. `sampleWind(lat, lng, out)` writes the wind's u and v (km/h) into `out` and returns
  // false where there is no data.
  step(dt, sampleWind) {
    const { ctx, width, height, wind, next, points, drawn, band } = this;
    // Trails fade with time, however long the step.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.globalAlpha = 1 - Math.pow(1 - FADE, dt * 60);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';

    const n = substeps(dt);
    const sub = dt / n;
    const stride = (MAX_SUBSTEPS + 1) * 2;
    for (let i = 0; i < this.lat.length; i++) {
      let lat = this.lat[i];
      let lng = this.lng[i];
      const o = i * stride;
      let m = 0;
      let x0 = this.x(lng);
      let y0 = this.y(lat);
      if (!Number.isNaN(x0) && !Number.isNaN(y0)) {
        points[o] = x0;
        points[o + 1] = y0;
        m = 1;
      }
      let spawned = false;
      for (let k = 0; k < n; k++) {
        this.age[i] += sub;
        if (this.age[i] > this.life[i] || !sampleWind(lat, lng, wind) || Number.isNaN(wind[0]) || Number.isNaN(wind[1])) {
          spawned = true;
          break;
        }
        if (k === 0) {
          const speed = Math.hypot(wind[0], wind[1]);
          let b = 0;
          while (b < SPEED_BANDS.length && speed >= SPEED_BANDS[b]) b++;
          band[i] = b;
        }
        advectInto(next, lat, lng, wind[0], wind[1], sub, this.rate);
        const x1 = this.x(next[1]);
        const y1 = this.y(next[0]);
        if (Math.abs(next[0]) > 85 || Number.isNaN(x1) || Number.isNaN(y1)) {
          spawned = true;
          break;
        }
        lat = next[0];
        lng = next[1];
        // The path ends where it would streak across the whole map at the date line.
        if (m > 0 && Math.abs(x1 - x0) >= width / 2) m = -m;
        if (m > 0) {
          points[o + m * 2] = x1;
          points[o + m * 2 + 1] = y1;
          m++;
        }
        x0 = x1;
        y0 = y1;
      }
      drawn[i] = Math.abs(m);
      if (spawned) this.spawn(i);
      else {
        this.lat[i] = lat;
        this.lng[i] = lng;
      }
    }

    // One path per speed band, so a particle's segments join smoothly.
    ctx.strokeStyle = '#fff';
    for (let b = 0; b < BAND_ALPHA.length; b++) {
      ctx.globalAlpha = BAND_ALPHA[b];
      ctx.beginPath();
      for (let i = 0; i < this.lat.length; i++) {
        if (band[i] !== b || drawn[i] < 2) continue;
        const o = i * stride;
        ctx.moveTo(points[o], points[o + 1]);
        for (let k = 1; k < drawn[i]; k++) ctx.lineTo(points[o + k * 2], points[o + k * 2 + 1]);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.texture.needsUpdate = true;
  }
}
