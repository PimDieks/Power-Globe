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
// wraps the sphere (or, zoomed in, just the area in view) above the colour field.
export class WindFlow {
  constructor(globe, { bounds = WORLD, count = 6000, width = 2048, height = width / 2, lineWidth = 1.3, altitude = 0.0016 } = {}) {
    this.globe = globe;
    this.altitude = altitude;
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.lineCap = 'round';
    this.ctx.lineWidth = lineWidth;

    this.lat = new Float32Array(count);
    this.lng = new Float32Array(count);
    this.age = new Float32Array(count);
    this.life = new Float32Array(count);
    this.wind = new Float32Array(2);

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

  // Advance every particle `dt` seconds. `sampleWind(lat, lng, out)` writes the wind's u and v
  // (km/h) into `out` and returns false where there is no data.
  step(dt, sampleWind) {
    const { ctx, width, height, wind } = this;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0, 0, 0, ${1 - Math.pow(1 - FADE, dt * 60)})`;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';

    const paths = BAND_ALPHA.map(() => new Path2D());
    for (let i = 0; i < this.lat.length; i++) {
      this.age[i] += dt;
      const lat = this.lat[i];
      const lng = this.lng[i];
      if (this.age[i] > this.life[i] || !sampleWind(lat, lng, wind) || Number.isNaN(wind[0]) || Number.isNaN(wind[1])) {
        this.spawn(i);
        continue;
      }
      const u = wind[0];
      const v = wind[1];
      const [nextLat, nextLng] = advect(lat, lng, u, v, dt, this.rate);
      const x0 = this.x(lng);
      const x1 = this.x(nextLng);
      const y0 = this.y(lat);
      const y1 = this.y(nextLat);
      if (Math.abs(nextLat) > 85 || Number.isNaN(x1) || Number.isNaN(y1)) {
        this.spawn(i);
        continue;
      }
      // Skip the segment that would streak across the whole map at the date line.
      if (Math.abs(x1 - x0) < width / 2) {
        const speed = Math.hypot(u, v);
        let band = 0;
        while (band < SPEED_BANDS.length && speed >= SPEED_BANDS[band]) band++;
        paths[band].moveTo(x0, y0);
        paths[band].lineTo(x1, y1);
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
