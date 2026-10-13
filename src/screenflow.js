import { Matrix4 } from 'three';
import { WORLD } from './field.js';
import { RATE, advect } from './flow.js';

const DEG = Math.PI / 180;
// Positions remembered per particle, one per frame: the length of its trail.
const TRAIL = 26;
// Trails are drawn in steps that fade from the head (brightest) to the tail.
const AGE_ALPHA = [0.9, 0.6, 0.35, 0.15];
// Calmer wind draws dimmer trails.
const SLOW_WIND = 12;
const SLOW_ALPHA = 0.6;

// Position on the globe's surface (scaled to `radius`), matching three-globe's coordinates.
export function toCartesian(lat, lng, radius) {
  const phi = (90 - lat) * DEG;
  const theta = (90 - lng) * DEG;
  return [radius * Math.sin(phi) * Math.cos(theta), radius * Math.cos(phi), radius * Math.sin(phi) * Math.sin(theta)];
}

// Pixel position of a world point through the column-major view-projection matrix `e`, or null
// if it is behind the camera.
export function project(e, x, y, z, width, height) {
  const w = e[3] * x + e[7] * y + e[11] * z + e[15];
  if (w <= 0) return null;
  return [
    (((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) / 2) * width,
    ((1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) / 2) * height,
  ];
}

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
    container.after(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.matrix = new Matrix4();

    this.lat = new Float32Array(count);
    this.lng = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.slow = new Uint8Array(count);
    // Ring buffer of recent positions per particle: TRAIL slots of x, y, z.
    this.trail = new Float32Array(count * TRAIL * 3);
    this.head = 0;
    this.wind = new Float32Array(2);
    this.points = new Float32Array(TRAIL * 2);
    this.shown = new Uint8Array(TRAIL);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.setBounds(WORLD);
    this.visible = false;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
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
    const [x, y, z] = toCartesian(this.lat[i], this.lng[i], this.radius);
    for (let k = 0; k < TRAIL; k++) this.trail.set([x, y, z], (i * TRAIL + k) * 3);
  }

  // Advance particles `dt` seconds through the wind from `sampleWind(lat, lng, out)` and draw.
  step(dt, sampleWind) {
    this.head = (this.head + 1) % TRAIL;
    for (let i = 0; i < this.lat.length; i++) {
      this.age[i] += dt;
      const lat = this.lat[i];
      const lng = this.lng[i];
      const ok = sampleWind(lat, lng, this.wind) && !Number.isNaN(this.wind[0]) && !Number.isNaN(this.wind[1]);
      if (!ok || this.age[i] > this.life[i] || !this.inside(lat, lng)) {
        this.spawn(i);
        continue;
      }
      const [nextLat, nextLng] = advect(lat, lng, this.wind[0], this.wind[1], dt, this.rate);
      this.lat[i] = nextLat;
      this.lng[i] = nextLng;
      this.slow[i] = Math.hypot(this.wind[0], this.wind[1]) < SLOW_WIND ? 1 : 0;
      this.trail.set(toCartesian(nextLat, nextLng, this.radius), (i * TRAIL + this.head) * 3);
    }
    this.draw();
  }

  draw() {
    const { ctx, canvas, trail, points, shown } = this;
    const camera = this.globe.camera();
    const e = this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    const { x: cx, y: cy, z: cz } = camera.position;
    const radiusSq = this.radius * this.radius;
    const steps = AGE_ALPHA.length;
    const paths = Array.from({ length: steps * 2 }, () => new Path2D());

    for (let i = 0; i < this.lat.length; i++) {
      // Project the trail from newest to oldest.
      for (let k = 0; k < TRAIL; k++) {
        const o = (i * TRAIL + ((this.head - k + TRAIL) % TRAIL)) * 3;
        const x = trail[o];
        const y = trail[o + 1];
        const z = trail[o + 2];
        const p = facesCamera(x, y, z, cx, cy, cz, radiusSq) && project(e, x, y, z, canvas.width, canvas.height);
        shown[k] = p ? 1 : 0;
        if (p) {
          points[k * 2] = p[0];
          points[k * 2 + 1] = p[1];
        }
      }
      const set = this.slow[i] ? steps : 0;
      for (let k = 0; k < TRAIL - 1; k++) {
        if (!shown[k] || !shown[k + 1]) continue;
        const path = paths[set + Math.floor((k * steps) / (TRAIL - 1))];
        path.moveTo(points[k * 2 + 2], points[k * 2 + 3]);
        path.lineTo(points[k * 2], points[k * 2 + 1]);
      }
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = this.lineWidth;
    ctx.lineCap = 'round';
    paths.forEach((path, n) => {
      const alpha = AGE_ALPHA[n % steps] * (n >= steps ? SLOW_ALPHA : 1);
      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.stroke(path);
    });
  }
}
