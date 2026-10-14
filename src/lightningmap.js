// Lightning on the map while an airport's Ops tab is open: rings at 5, 10, 20 and 30 km around the
// airport, and the newest lightning image in its place on the globe, in warm colours that are clear
// where there is lightning and see-through where there is none. One mesh, one canvas and one
// texture, drawn into again when the image changes, so nothing is allocated while the map is drawn.
// All of it is made when first shown and let go of on hide.
import * as THREE from 'three';
import { MAX_COUNT, RING_KM, countsFromImage } from './lightning.js';

const RAD = Math.PI / 180;
const KM_PER_DEG = 111.195;
export const OVERLAY_RINGS_KM = RING_KM;
// The picture is drawn on a canvas this many pixels square, covering the window of the images.
export const CANVAS_PX = 1024;
// The window is laid on the globe as a grid of this many squares each way, to follow its curve.
const GRID = 12;
// The ring labels are this many screen pixels tall, which makes their text about the size of the map's own labels (12 px).
export const LABEL_PX = 20;
// A label is drawn at twice that, for sharp text, on a canvas this wide and tall.
const LABEL_W = 88;
const LABEL_H = 36;

// The colour of an intensity (1 to MAX_COUNT): orange where weak to dark red where strong, more
// opaque with it. Writes four bytes at `at`.
export function paintIntensity(out, at, count) {
  const t = Math.min(1, (count - 1) / (MAX_COUNT - 1));
  out[at] = 255 - 55 * t;
  out[at + 1] = 150 * (1 - t);
  out[at + 2] = 20 * t;
  out[at + 3] = 110 + 120 * t;
}

export function setupLightningOverlay(globe) {
  const R = globe.getGlobeRadius();
  const scene = globe.scene();
  let live = null;

  function label(km) {
    const canvas = document.createElement('canvas');
    canvas.width = LABEL_W;
    canvas.height = LABEL_H;
    const ctx = canvas.getContext('2d');
    ctx.font = '700 22px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(5, 8, 15, 0.85)';
    ctx.strokeText(`${km} km`, LABEL_W / 2, LABEL_H / 2);
    ctx.fillStyle = '#fff';
    ctx.fillText(`${km} km`, LABEL_W / 2, LABEL_H / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, sizeAttenuation: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6, toneMapped: false }));
    sprite.renderOrder = 4;
    sprite.raycast = () => {};
    sprite.userData.km = km;
    return sprite;
  }

  function build() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = CANVAS_PX;
    const ctx = canvas.getContext('2d');
    // The image as it came, coloured, before it is scaled up without smoothing, so its pixels stay as they are.
    const stage = document.createElement('canvas');
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const positions = new Float32Array((GRID + 1) ** 2 * 3);
    const uvs = new Float32Array((GRID + 1) ** 2 * 2);
    const indices = [];
    for (let i = 0; i < GRID; i++) {
      for (let j = 0; j < GRID; j++) {
        const a = i * (GRID + 1) + j;
        indices.push(a, a + 1, a + GRID + 1, a + 1, a + GRID + 2, a + GRID + 1);
      }
    }
    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) uvs.set([j / GRID, i / GRID], (i * (GRID + 1) + j) * 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false }),
    );
    // Over the weather layers, under the runways and aircraft.
    mesh.renderOrder = 4;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    scene.add(mesh);
    const labels = OVERLAY_RINGS_KM.map(label);
    for (const sprite of labels) scene.add(sprite);
    return { canvas, ctx, stage, stageCtx: stage.getContext('2d'), texture, positions, geometry, mesh, labels, drawn: { geometry: null, image: null } };
  }

  function teardown() {
    if (!live) return;
    scene.remove(live.mesh);
    live.geometry.dispose();
    live.mesh.material.dispose();
    live.texture.dispose();
    for (const sprite of live.labels) {
      scene.remove(sprite);
      sprite.material.map.dispose();
      sprite.material.dispose();
    }
    // The canvases give their memory back with their size.
    for (const canvas of [live.canvas, live.stage, ...live.labels.map((s) => s.material.map.image)]) {
      canvas.width = 0;
      canvas.height = 0;
    }
    live = null;
  }

  // The window's corners on the globe: row i from the south edge, column j from the west edge.
  function place({ south, west, north, east }) {
    const r = R * 1.0002;
    for (let i = 0; i <= GRID; i++) {
      const lat = (south + ((north - south) * i) / GRID) * RAD;
      for (let j = 0; j <= GRID; j++) {
        const lng = (west + ((east - west) * j) / GRID) * RAD;
        live.positions.set([r * Math.cos(lat) * Math.sin(lng), r * Math.sin(lat), r * Math.cos(lat) * Math.cos(lng)], (i * (GRID + 1) + j) * 3);
      }
    }
    live.geometry.attributes.position.needsUpdate = true;
  }

  // Each label sits on its ring, at the north. They are the same size on the screen whatever the
  // zoom, as sized when the airport is shown.
  function placeLabels(g) {
    const height = globe.renderer?.().domElement?.clientHeight || 800;
    const p11 = globe.camera?.().projectionMatrix?.elements[5] || 2.14;
    const scaleY = LABEL_PX / ((height / 2) * p11);
    const r = R * 1.0004;
    for (const sprite of live.labels) {
      const lat = (g.lat + sprite.userData.km / KM_PER_DEG) * RAD;
      const lng = g.lon * RAD;
      sprite.position.set(r * Math.cos(lat) * Math.sin(lng), r * Math.sin(lat), r * Math.cos(lat) * Math.cos(lng));
      sprite.scale.set(scaleY * (LABEL_W / LABEL_H), scaleY, 1);
    }
  }

  function paint(g, image) {
    const { ctx, stage, stageCtx } = live;
    ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    if (image) {
      if (stage.width !== image.width || stage.height !== image.height) {
        stage.width = image.width;
        stage.height = image.height;
      }
      const counts = countsFromImage(image);
      const pixels = new Uint8ClampedArray(counts.length * 4);
      for (let i = 0; i < counts.length; i++) if (counts[i]) paintIntensity(pixels, i * 4, counts[i]);
      stageCtx.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(stage, 0, 0, CANVAS_PX, CANVAS_PX);
      ctx.restore();
    }
    // The window is 2 * halfKm across and the rings are circles around its middle.
    const mid = CANVAS_PX / 2;
    for (const km of OVERLAY_RINGS_KM) {
      ctx.beginPath();
      ctx.arc(mid, mid, (km / (2 * g.halfKm)) * CANVAS_PX, 0, 2 * Math.PI);
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = 'rgba(5, 8, 15, 0.7)';
      ctx.stroke();
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.stroke();
    }
    live.texture.needsUpdate = true;
  }

  return {
    // `geometry` is the airport's window (see makeGeometry in lightning.js), `image` the newest
    // decoded lightning image ({ width, height, data }) or null.
    show({ geometry: g, image }) {
      live ??= build();
      if (live.drawn.geometry !== g) {
        place(g.bbox);
        placeLabels(g);
      }
      if (live.drawn.geometry !== g || live.drawn.image !== image) paint(g, image);
      live.drawn = { geometry: g, image };
      live.mesh.visible = true;
    },
    // Takes the mesh, the canvases and the texture away; they are made again at the next show.
    hide: teardown,
    dispose: teardown,
  };
}
