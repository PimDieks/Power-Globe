import * as THREE from 'three';
import { sampleGrid } from './field.js';

const DEG = Math.PI / 180;
// How far particles travel: degrees per second for each km/h of wind.
const RATE = 0.22;
// Share of trail brightness lost per frame at 60 fps; lower means longer trails.
const FADE = 0.035;
// Faster wind draws brighter trails.
const SPEED_BANDS = [8, 20, 38];
const BAND_ALPHA = [0.16, 0.32, 0.55, 0.85];

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

// Move a point `seconds` along wind (u, v in km/h). Longitude steps widen towards the
// poles so motion looks even across the sphere.
export function advect(lat, lng, u, v, seconds, rate = RATE) {
  const k = seconds * rate;
  const cos = Math.max(0.15, Math.cos(lat * DEG));
  const nextLng = lng + (u * k) / cos;
  return [lat + v * k, ((((nextLng + 180) % 360) + 360) % 360) - 180];
}

// Glowing particles drifting with the wind, painted with fading trails onto a canvas that
// wraps a sphere just above the colour field.
export class WindFlow {
  constructor(globe, shape, { count = 6000, width = 2048 } = {}) {
    this.shape = shape;
    this.width = width;
    this.height = width / 2;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.lineCap = 'round';
    this.ctx.lineWidth = Math.max(1, (1.3 * width) / 2048);

    this.u = new Float32Array(shape.rows * shape.cols);
    this.v = new Float32Array(shape.rows * shape.cols);
    this.lat = new Float32Array(count);
    this.lng = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    for (let i = 0; i < count; i++) this.spawn(i, true);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
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
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(globe.getGlobeRadius() * 1.004, 128, 96), material);
    this.mesh.rotation.y = -Math.PI / 2;
    this.mesh.renderOrder = -1;
    this.mesh.raycast = () => {};
    globe.scene().add(this.mesh);
  }

  set visible(value) {
    this.mesh.visible = value;
    if (!value) this.ctx.clearRect(0, 0, this.width, this.height);
  }

  get visible() {
    return this.mesh.visible;
  }

  // Respawn particle `i` somewhere random, spread evenly over the sphere's area.
  spawn(i, randomAge = false) {
    this.lat[i] = Math.asin(Math.random() * 2 - 1) / DEG;
    this.lng[i] = Math.random() * 360 - 180;
    this.life[i] = 2 + Math.random() * 4;
    this.age[i] = randomAge ? Math.random() * this.life[i] : 0;
  }

  // Wind for the current moment: steps `a` and `b` blended by `t`.
  setWind(a, b, t) {
    for (let i = 0; i < this.u.length; i++) {
      this.u[i] = a.u[i] + (b.u[i] - a.u[i]) * t;
      this.v[i] = a.v[i] + (b.v[i] - a.v[i]) * t;
    }
  }

  step(dt) {
    const { ctx, width, height, shape } = this;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0, 0, 0, ${1 - Math.pow(1 - FADE, dt * 60)})`;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';

    const paths = BAND_ALPHA.map(() => new Path2D());
    for (let i = 0; i < this.lat.length; i++) {
      this.age[i] += dt;
      const lat = this.lat[i];
      const lng = this.lng[i];
      const u = sampleGrid(this.u, shape, lat, lng);
      const v = sampleGrid(this.v, shape, lat, lng);
      if (this.age[i] > this.life[i] || Number.isNaN(u) || Number.isNaN(v)) {
        this.spawn(i);
        continue;
      }
      const [nextLat, nextLng] = advect(lat, lng, u, v, dt);
      if (Math.abs(nextLat) > 85) {
        this.spawn(i);
        continue;
      }
      const x0 = ((lng + 180) / 360) * width;
      const x1 = ((nextLng + 180) / 360) * width;
      // Skip the segment that would streak across the whole map at the date line.
      if (Math.abs(x1 - x0) < width / 2) {
        const speed = Math.hypot(u, v);
        let band = 0;
        while (band < SPEED_BANDS.length && speed >= SPEED_BANDS[band]) band++;
        paths[band].moveTo(x0, ((90 - lat) / 180) * height);
        paths[band].lineTo(x1, ((90 - nextLat) / 180) * height);
      }
      this.lat[i] = nextLat;
      this.lng[i] = nextLng;
    }
    paths.forEach((path, band) => {
      ctx.strokeStyle = `rgba(255, 255, 255, ${BAND_ALPHA[band]})`;
      ctx.stroke(path);
    });
    this.texture.needsUpdate = true;
  }
}
