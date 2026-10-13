import * as THREE from 'three';
import { buildLut } from './layers.js';

const WIDTH = 360;
const HEIGHT = 180;

// Grid layout used throughout: values are flat and row-major, rows run south to north from
// `lat0`, columns west to east from -180, all `step` degrees apart. Longitude wraps around;
// latitude clamps to the outermost rows. Missing values yield NaN.

const gridX = (lng, { cols, step }) => ((((lng + 180) / step) % cols) + cols) % cols;
const gridY = (lat, { rows, lat0, step }) => Math.min(rows - 1, Math.max(0, (lat - lat0) / step));

// Bilinear sample: cheap, used for advecting wind particles.
export function sampleGrid(values, shape, lat, lng) {
  const { rows, cols } = shape;
  const y = gridY(lat, shape);
  const x = gridX(lng, shape);
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

// Catmull-Rom weights for the four samples around fractional offset `t`.
export function cubicWeights(t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
}

function columnTaps(lng, shape) {
  const x = gridX(lng, shape);
  const x0 = Math.floor(x);
  const cols = [-1, 0, 1, 2].map((k) => (x0 + k + shape.cols) % shape.cols);
  return { cols, weights: cubicWeights(x - x0) };
}

function rowTaps(lat, shape) {
  const y = gridY(lat, shape);
  const y0 = Math.floor(y);
  const rows = [-1, 0, 1, 2].map((k) => Math.min(shape.rows - 1, Math.max(0, y0 + k)));
  return { rows, weights: cubicWeights(y - y0) };
}

// Bicubic (Catmull-Rom) sample: smooth, without the creases bilinear leaves on a coarse grid.
export function sampleGridCubic(values, shape, lat, lng) {
  const c = columnTaps(lng, shape);
  const r = rowTaps(lat, shape);
  let sum = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      sum += r.weights[j] * c.weights[i] * (values[r.rows[j] * shape.cols + c.cols[i]] ?? NaN);
    }
  }
  return sum;
}

// Sample positions and weights for every pixel column and row of an equirectangular image,
// computed once so painting a frame is just multiply-adds.
export function samplingTables(shape, width, height) {
  const colIdx = new Int32Array(width * 4);
  const colW = new Float32Array(width * 4);
  for (let px = 0; px < width; px++) {
    const { cols, weights } = columnTaps(-180 + ((px + 0.5) * 360) / width, shape);
    colIdx.set(cols, px * 4);
    colW.set(weights, px * 4);
  }
  const rowOff = new Int32Array(height * 4);
  const rowW = new Float32Array(height * 4);
  for (let py = 0; py < height; py++) {
    const { rows, weights } = rowTaps(90 - ((py + 0.5) * 180) / height, shape);
    rowOff.set(rows.map((r) => r * shape.cols), py * 4);
    rowW.set(weights, py * 4);
  }
  return { width, height, colIdx, colW, rowOff, rowW };
}

// Paint grid `values` into RGBA pixels `out` using an RGBA lookup table over [min, max].
export function renderField(values, tables, lut, min, max, out) {
  const { width, height, colIdx, colW, rowOff, rowW } = tables;
  const top = lut.length / 4 - 1;
  const scale = top / (max - min);
  for (let py = 0; py < height; py++) {
    const r = py * 4;
    for (let px = 0; px < width; px++) {
      const c = px * 4;
      let v = 0;
      for (let j = 0; j < 4; j++) {
        const off = rowOff[r + j];
        v +=
          rowW[r + j] *
          (colW[c] * values[off + colIdx[c]] +
            colW[c + 1] * values[off + colIdx[c + 1]] +
            colW[c + 2] * values[off + colIdx[c + 2]] +
            colW[c + 3] * values[off + colIdx[c + 3]]);
      }
      const o = (py * width + px) * 4;
      if (Number.isNaN(v)) {
        out[o + 3] = 0;
        continue;
      }
      const k = Math.round(Math.min(top, Math.max(0, (v - min) * scale))) * 4;
      out[o] = lut[k];
      out[o + 1] = lut[k + 1];
      out[o + 2] = lut[k + 2];
      out[o + 3] = lut[k + 3];
    }
  }
}

// A translucent sphere just above the Earth, painted with the interpolated colour field.
// Repainting a small canvas each frame keeps animation cheap.
export class FieldOverlay {
  constructor(globe, shape) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = WIDTH;
    this.canvas.height = HEIGHT;
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(WIDTH, HEIGHT);
    this.tables = samplingTables(shape, WIDTH, HEIGHT);
    this.blended = new Float32Array(shape.rows * shape.cols);
    this.luts = new Map();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      // Bias depth towards the camera: this sphere hugs the Earth so closely that, zoomed out,
      // depth precision runs out and the Earth would poke through in specks.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(globe.getGlobeRadius() * 1.002, 96, 64), this.material);
    // three-globe rotates its globe mesh this way so equirectangular textures line up.
    this.mesh.rotation.y = -Math.PI / 2;
    // Drawn before other transparent layers (e.g. rings) so their depth writes cannot cut holes in it.
    this.mesh.renderOrder = -2;
    // Let clicks pass through to the globe underneath.
    this.mesh.raycast = () => {};
    globe.scene().add(this.mesh);
  }

  set visible(value) {
    this.mesh.visible = value;
  }

  // 0..1 multiplier on the layer's opacity, used to cross-fade between layers.
  set strength(value) {
    this.material.opacity = value * (this.layerOpacity ?? 0.6);
  }

  lutFor(layer) {
    if (!this.luts.has(layer)) this.luts.set(layer, buildLut(layer));
    return this.luts.get(layer);
  }

  // Paint the field for grid values `a` and `b` (two consecutive time steps) blended by `t`.
  render(a, b, t, layer) {
    for (let i = 0; i < this.blended.length; i++) {
      const va = a[i] ?? NaN;
      this.blended[i] = va + ((b[i] ?? NaN) - va) * t;
    }
    const { stops } = layer;
    renderField(this.blended, this.tables, this.lutFor(layer), stops[0][0], stops.at(-1)[0], this.image.data);
    this.ctx.putImageData(this.image, 0, 0);
    this.texture.needsUpdate = true;
    this.layerOpacity = layer.opacity;
  }
}
