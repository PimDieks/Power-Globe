// Lightning on the map while an airport's Weather tab is open: rings at 5, 10, 20 and 30 km around
// the airport, and the newest lightning image in its place on the globe, in warm colours that are
// clear where there is lightning and see-through where there is none. The image is one mesh with one
// canvas and one texture, drawn into again when the image changes, so nothing is allocated while the
// map is drawn. The rings are real geometry, ribbons a few screen pixels wide like the flight lines,
// so they stay sharp at any zoom (a texture over the whole window is soft at airport zoom). All of
// it is made when first shown and let go of on hide.
import * as THREE from 'three';
import { MAX_COUNT, RING_KM, countsFromImage } from './lightning.js';
import { destination } from './runwaymap.js';
import { flightLine } from './trafficlayer.js';

const RAD = Math.PI / 180;
const KM_PER_DEG = 111.195;
export const OVERLAY_RINGS_KM = RING_KM;
// The picture is drawn on a canvas this many pixels square, covering the window of the images.
export const CANVAS_PX = 1024;
// A ring is drawn as this many straight segments, which is smooth at any zoom the airport map has.
export const RING_SEGMENTS = 128;
// The width of a ring on the screen, in pixels: a white core with a dark edge.
export const RING_PX = 4;
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
    // Over the rings, which a label sits on.
    sprite.renderOrder = 4.6;
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
    // Over the lightning image, under the runways and aircraft.
    const rings = OVERLAY_RINGS_KM.map(() => flightLine(globe, { color: [1, 1, 1], width: RING_PX, alpha: 0.95, renderOrder: 4.5 }));
    return { canvas, ctx, stage, stageCtx: stage.getContext('2d'), texture, positions, geometry, mesh, labels, rings, drawn: { geometry: null, image: null } };
  }

  function teardown() {
    if (!live) return;
    scene.remove(live.mesh);
    live.geometry.dispose();
    live.mesh.material.dispose();
    live.texture.dispose();
    for (const ring of live.rings) {
      scene.remove(ring.mesh);
      ring.mesh.geometry.dispose();
      ring.mesh.material.dispose();
    }
    globalThis.window?.removeEventListener?.('resize', fitRings);
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

  // The rings' width is in screen pixels, so they need the size of the screen.
  function fitRings() {
    const w = globalThis.window;
    for (const ring of live?.rings ?? []) ring.setViewport(w?.innerWidth || 1, w?.innerHeight || 1);
  }

  // Each ring is a circle of its radius around the airport, on the globe.
  function placeRings(g) {
    const r = R * 1.0002;
    live.rings.forEach((ring, k) => {
      const flat = [];
      for (let i = 0; i <= RING_SEGMENTS; i++) {
        const p = destination({ lat: g.lat, lng: g.lon }, (360 * i) / RING_SEGMENTS, OVERLAY_RINGS_KM[k] * 1000);
        const lat = p.lat * RAD;
        const lng = p.lng * RAD;
        flat.push(r * Math.cos(lat) * Math.sin(lng), r * Math.sin(lat), r * Math.cos(lat) * Math.cos(lng));
      }
      ring.set(flat);
    });
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
    live.texture.needsUpdate = true;
  }

  return {
    // `geometry` is the airport's window (see makeGeometry in lightning.js), `image` the newest
    // decoded lightning image ({ width, height, data }) or null.
    show({ geometry: g, image }) {
      if (!live) {
        live = build();
        globalThis.window?.addEventListener?.('resize', fitRings);
      }
      fitRings();
      if (live.drawn.geometry !== g) {
        place(g.bbox);
        placeRings(g);
        placeLabels(g);
      }
      for (const ring of live.rings) ring.mesh.visible = true;
      if (live.drawn.geometry !== g || live.drawn.image !== image) paint(g, image);
      live.drawn = { geometry: g, image };
      live.mesh.visible = true;
    },
    // Takes the mesh, the rings, the canvases and the texture away; they are made again at the next show.
    hide: teardown,
    dispose: teardown,
  };
}
