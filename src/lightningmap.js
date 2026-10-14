// Lightning on the map while an airport's Ops tab is open: rings at 5, 10 and 20 km around the
// airport, and the newest lightning image as a translucent picture in its place on the globe. One
// mesh, one canvas and one texture, made once and drawn into again when the image changes, so
// nothing is allocated while the map is drawn.
import * as THREE from 'three';

const RAD = Math.PI / 180;
export const OVERLAY_RINGS_KM = [5, 10, 20];
// The picture is drawn on a canvas this many pixels square, covering the window of the images.
export const CANVAS_PX = 1024;
// The window is laid on the globe as a grid of this many squares each way, to follow its curve.
const GRID = 12;
// The image is shown this opaque: the map stays readable under it.
const IMAGE_ALPHA = 0.55;

export function setupLightningOverlay(globe) {
  const R = globe.getGlobeRadius();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CANVAS_PX;
  const ctx = canvas.getContext('2d');
  // The image as it came, before it is scaled up without smoothing, so its pixels stay as they are.
  const stage = document.createElement('canvas');
  const stageCtx = stage.getContext('2d');
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
  mesh.visible = false;
  globe.scene().add(mesh);

  // What is drawn now, so that the same again costs nothing.
  let drawn = { geometry: null, image: null };

  // The window's corners on the globe: row i from the south edge, column j from the west edge.
  function place({ south, west, north, east }) {
    const r = R * 1.0002;
    for (let i = 0; i <= GRID; i++) {
      const lat = (south + ((north - south) * i) / GRID) * RAD;
      for (let j = 0; j <= GRID; j++) {
        const lng = (west + ((east - west) * j) / GRID) * RAD;
        positions.set([r * Math.cos(lat) * Math.sin(lng), r * Math.sin(lat), r * Math.cos(lat) * Math.cos(lng)], (i * (GRID + 1) + j) * 3);
      }
    }
    geometry.attributes.position.needsUpdate = true;
  }

  function paint(g, image) {
    ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    if (image) {
      if (stage.width !== image.width || stage.height !== image.height) {
        stage.width = image.width;
        stage.height = image.height;
      }
      stageCtx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
      ctx.save();
      ctx.globalAlpha = IMAGE_ALPHA;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(stage, 0, 0, CANVAS_PX, CANVAS_PX);
      ctx.restore();
    }
    // The window is 2 * halfKm across and the rings are circles around its middle.
    const mid = CANVAS_PX / 2;
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const km of OVERLAY_RINGS_KM) {
      const radius = (km / (2 * g.halfKm)) * CANVAS_PX;
      ctx.beginPath();
      ctx.arc(mid, mid, radius, 0, 2 * Math.PI);
      ctx.lineWidth = 3.2;
      ctx.strokeStyle = 'rgba(5, 8, 15, 0.7)';
      ctx.stroke();
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.stroke();
      ctx.lineWidth = 2.6;
      ctx.strokeStyle = 'rgba(5, 8, 15, 0.8)';
      ctx.strokeText(`${km} km`, mid, mid - radius - 5);
      ctx.fillStyle = '#fff';
      ctx.fillText(`${km} km`, mid, mid - radius - 5);
    }
    texture.needsUpdate = true;
  }

  return {
    // `geometry` is the airport's window (see makeGeometry in lightning.js), `image` the newest
    // decoded lightning image ({ width, height, data }) or null.
    show({ geometry: g, image }) {
      if (drawn.geometry !== g) place(g.bbox);
      if (drawn.geometry !== g || drawn.image !== image) paint(g, image);
      drawn = { geometry: g, image };
      mesh.visible = true;
    },
    hide() {
      mesh.visible = false;
      drawn = { geometry: null, image: null };
    },
    // For when the page is torn down.
    dispose() {
      globe.scene().remove(mesh);
      geometry.dispose();
      mesh.material.dispose();
      texture.dispose();
    },
  };
}
