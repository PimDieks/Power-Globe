import * as THREE from 'three';
import { buildLut } from './layers.js';

// Grids are flat, row-major arrays described by a shape (see gridShape in weather.js): rows run
// south to north from `lat0`, columns east from `lng0`, all `step` degrees apart. A global grid
// wraps around in longitude; a regional one clamps at its edges. Latitude always clamps.
// Missing values yield NaN.

export const WORLD = { south: -90, north: 90, west: -180, span: 360 };

// Column position of `lng` within the grid (may exceed cols - 1 for a regional grid).
function gridX(lng, { lng0, step, cols, wrap }) {
  const x = ((((lng - lng0) % 360) + 360) % 360) / step;
  return wrap ? x % cols : x;
}

const gridY = (lat, { rows, lat0, step }) => Math.min(rows - 1, Math.max(0, (lat - lat0) / step));

const colIndex = (c, { cols, wrap }) => (wrap ? (c + cols) % cols : Math.min(cols - 1, Math.max(0, c)));

// Whether a regional grid has data at this point (a global grid always does).
export function covers(shape, lat, lng) {
  if (shape.wrap) return true;
  const y = (lat - shape.lat0) / shape.step;
  const x = gridX(lng, shape);
  return y >= 0 && y <= shape.rows - 1 && x <= shape.cols - 1;
}

// Bilinear sample: cheap, used for advecting wind particles.
export function sampleGrid(values, shape, lat, lng) {
  const { rows, cols } = shape;
  const y = gridY(lat, shape);
  const x = shape.wrap ? gridX(lng, shape) : Math.min(cols - 1, gridX(lng, shape));
  const y0 = Math.floor(y);
  const y1 = Math.min(y0 + 1, rows - 1);
  const x0 = Math.floor(x);
  const x1 = colIndex(x0 + 1, shape);
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
  const x = shape.wrap ? gridX(lng, shape) : Math.min(shape.cols - 1, gridX(lng, shape));
  const x0 = Math.floor(x);
  const cols = [-1, 0, 1, 2].map((k) => colIndex(x0 + k, shape));
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

const smoothstep = (t) => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

// Sample positions and weights for every pixel column and row of an image covering `bounds`
// (equirectangular), computed once so painting a frame is just multiply-adds. `feather`
// fades the image out towards its edges, as a fraction of its size, so a regional patch
// blends into whatever is underneath.
export function samplingTables(shape, width, height, bounds = WORLD, feather = 0) {
  const colIdx = new Int32Array(width * 4);
  const colW = new Float32Array(width * 4);
  const colFade = new Float32Array(width);
  for (let px = 0; px < width; px++) {
    const { cols, weights } = columnTaps(bounds.west + ((px + 0.5) * bounds.span) / width, shape);
    colIdx.set(cols, px * 4);
    colW.set(weights, px * 4);
    colFade[px] = feather ? smoothstep(Math.min(px + 0.5, width - px - 0.5) / width / feather) : 1;
  }
  const rowOff = new Int32Array(height * 4);
  const rowW = new Float32Array(height * 4);
  const rowFade = new Float32Array(height);
  for (let py = 0; py < height; py++) {
    const lat = bounds.north - ((py + 0.5) * (bounds.north - bounds.south)) / height;
    const { rows, weights } = rowTaps(lat, shape);
    rowOff.set(rows.map((r) => r * shape.cols), py * 4);
    rowW.set(weights, py * 4);
    rowFade[py] = feather ? smoothstep(Math.min(py + 0.5, height - py - 0.5) / height / feather) : 1;
  }
  // Fixed per-pixel noise of up to half a colour step, so gentle gradients dither smoothly
  // instead of showing bands. Fixed (not random per frame) so it does not shimmer.
  const dither = new Float32Array(width * height);
  for (let i = 0; i < dither.length; i++) {
    const h = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    dither[i] = h - Math.floor(h) - 0.5;
  }
  return { width, height, colIdx, colW, colFade, rowOff, rowW, rowFade, dither };
}

// Paint grid `values` into RGBA pixels `out` using an RGBA lookup table over [min, max].
export function renderField(values, tables, lut, min, max, out) {
  const { width, height, colIdx, colW, colFade, rowOff, rowW, rowFade, dither } = tables;
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
      const k = Math.round(Math.min(top, Math.max(0, (v - min) * scale + dither[py * width + px]))) * 4;
      out[o] = lut[k];
      out[o + 1] = lut[k + 1];
      out[o + 2] = lut[k + 2];
      out[o + 3] = lut[k + 3] * colFade[px] * rowFade[py];
    }
  }
}

// A curved patch of the sphere covering `bounds`, `altitude` above the surface, with UVs
// laid out like an equirectangular image of that area (u east, v north).
export function patchGeometry(globe, bounds, altitude) {
  const latSpan = bounds.north - bounds.south;
  const segX = Math.min(180, Math.max(8, Math.ceil(bounds.span / 2)));
  const segY = Math.min(90, Math.max(8, Math.ceil(latSpan / 2)));
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= segY; j++) {
    const lat = bounds.south + (latSpan * j) / segY;
    for (let i = 0; i <= segX; i++) {
      const { x, y, z } = globe.getCoords(lat, bounds.west + (bounds.span * i) / segX, altitude);
      positions.push(x, y, z);
      uvs.push(i / segX, j / segY);
    }
  }
  for (let j = 0; j < segY; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * (segX + 1) + i;
      const b = a + 1;
      const c = a + segX + 1;
      const d = c + 1;
      // Counter-clockwise seen from outside (east x north points outwards).
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

// A translucent layer just above the Earth, painted with the interpolated colour field.
// Repainting a small canvas each frame keeps animation cheap. The global field covers the
// whole sphere; a regional one shows finer data for the area being looked at.
export class FieldOverlay {
  constructor(globe, { shape, bounds = WORLD, width = 360, height = 180, altitude = 0.002, depthBias = 2, feather = 0, renderOrder = -3 }) {
    this.globe = globe;
    this.altitude = altitude;
    this.feather = feather;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(width, height);
    this.luts = new Map();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      // Bias depth towards the camera: the layer hugs the Earth so closely that, zoomed out,
      // depth precision runs out and the Earth would poke through in specks.
      polygonOffset: true,
      polygonOffsetFactor: -depthBias,
      polygonOffsetUnits: -depthBias,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    // Drawn before other transparent layers (e.g. rings) so their depth writes cannot cut holes in it.
    this.mesh.renderOrder = renderOrder;
    // Let clicks pass through to the globe underneath.
    this.mesh.raycast = () => {};
    globe.scene().add(this.mesh);
    this.setRegion(shape, bounds);
  }

  setRegion(shape, bounds) {
    this.shape = shape;
    this.blended = new Float32Array(shape.rows * shape.cols);
    this.tables = samplingTables(shape, this.canvas.width, this.canvas.height, bounds, this.feather);
    this.mesh.geometry.dispose();
    this.mesh.geometry = patchGeometry(this.globe, bounds, this.altitude);
  }

  set visible(value) {
    this.mesh.visible = value;
  }

  get visible() {
    return this.mesh.visible;
  }

  // 0..1 multiplier on the layer's opacity, used to cross-fade.
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
