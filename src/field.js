import * as THREE from 'three';
import { buildLut } from './layers.js';

const WIDTH = 360;
const HEIGHT = 180;

// Bilinear sample of grid `values` (flat, row-major, rows south to north from `lat0`,
// columns west to east from -180, all `step` degrees apart). Longitude wraps around;
// latitude clamps to the outermost rows. Missing values yield NaN.
export function sampleGrid(values, { rows, cols, lat0, step }, lat, lng) {
  const y = Math.min(rows - 1, Math.max(0, (lat - lat0) / step));
  const x = ((((lng + 180) / step) % cols) + cols) % cols;
  const y0 = Math.floor(y);
  const y1 = Math.min(y0 + 1, rows - 1);
  const x0 = Math.floor(x);
  const x1 = (x0 + 1) % cols;
  const fy = y - y0;
  const fx = x - x0;
  const v = (r, c) => values[r * cols + c] ?? NaN;
  const south = v(y0, x0) * (1 - fx) + v(y0, x1) * fx;
  const north = v(y1, x0) * (1 - fx) + v(y1, x1) * fx;
  return south * (1 - fy) + north * fy;
}

// A translucent sphere just above the Earth, painted with a smooth colour field interpolated
// from the forecast grid. Repainting a small canvas each frame keeps animation cheap.
export class FieldOverlay {
  constructor(globe, shape) {
    this.shape = shape;
    this.canvas = document.createElement('canvas');
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(WIDTH, HEIGHT);
    this.blended = new Float32Array(shape.rows * shape.cols);
    this.luts = new Map();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(globe.getGlobeRadius() * 1.002, 96, 64), material);
    // three-globe rotates its globe mesh this way so equirectangular textures line up.
    this.mesh.rotation.y = -Math.PI / 2;
    // Let clicks pass through to the globe underneath.
    this.mesh.raycast = () => {};
    globe.scene().add(this.mesh);
  }

  set visible(value) {
    this.mesh.visible = value;
  }

  lutFor(stops) {
    if (!this.luts.has(stops)) this.luts.set(stops, buildLut(stops));
    return this.luts.get(stops);
  }

  // Paint the field for grid values `a` and `b` (two consecutive time steps) blended by `t`.
  render(a, b, t, stops) {
    const lut = this.lutFor(stops);
    const size = lut.length / 3;
    const min = stops[0][0];
    const range = stops[stops.length - 1][0] - min;
    for (let i = 0; i < this.blended.length; i++) {
      this.blended[i] = (a[i] ?? NaN) + ((b[i] ?? NaN) - (a[i] ?? NaN)) * t;
    }
    const data = this.image.data;
    for (let py = 0; py < HEIGHT; py++) {
      const lat = 90 - ((py + 0.5) * 180) / HEIGHT;
      for (let px = 0; px < WIDTH; px++) {
        const lng = -180 + ((px + 0.5) * 360) / WIDTH;
        const value = sampleGrid(this.blended, this.shape, lat, lng);
        const o = (py * WIDTH + px) * 4;
        if (Number.isNaN(value)) {
          data[o + 3] = 0;
          continue;
        }
        const k = Math.round(Math.min(1, Math.max(0, (value - min) / range)) * (size - 1)) * 3;
        data[o] = lut[k];
        data[o + 1] = lut[k + 1];
        data[o + 2] = lut[k + 2];
        data[o + 3] = 255;
      }
    }
    this.ctx.putImageData(this.image, 0, 0);
    this.texture.needsUpdate = true;
  }
}
