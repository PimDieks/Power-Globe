// Road traffic on the map while an airport's Ops tab is open: a small dot for each measurement site
// coloured by its speed, lines for the jams and closures, and markers for accidents and
// obstructions. A few meshes made when shown and let go of on hide, so nothing is held while the
// tab is closed. What to draw comes from mapShapes in opsaccess.js.
//
// Like the aircraft, these are drawn after the map layers and without depth testing (the map's
// tiles are pulled towards the camera, which would hide anything just above them), and are hidden
// behind the globe by the same test (see trafficlayer.js).
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { SPEED_COLORS } from './opsaccess.js';
import { BEHIND_GLOBE, behindGlobe, hideUniform } from './trafficlayer.js';

const RAD = Math.PI / 180;
const LIFT = 1.00003;
export const DOT_PX = 7;
export const MARKER_PX = 13;
const LINE_STYLES = {
  jam: { color: 0xff4a3d, width: 5, dashed: false },
  closure: { color: 0xf2f5fa, width: 3.5, dashed: true },
};
const MARKER_COLORS = { accident: '#d86bff', jam: '#ff4a3d', closure: '#f2f5fa', obstruction: '#ffc857' };

const DOT_VERTEX = /* glsl */ `
  ${BEHIND_GLOBE}
  attribute vec3 aColor;
  uniform float uSize;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = behindGlobe(position) ? vec4(2.0, 2.0, 2.0, 1.0) : clip;
    gl_PointSize = uSize;
  }
`;

// A disc in the colour of the site with a dark rim, so it reads over any map.
const DOT_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    gl_FragColor = vec4(mix(vColor, vec3(0.16, 0.19, 0.25), smoothstep(0.6, 0.72, d)), 1.0);
  }
`;

// "#rrggbb" as 0 to 1 values, as they are to appear on the screen.
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

export function setupAccessOverlay(globe) {
  const R = globe.getGlobeRadius();
  const scene = globe.scene();
  let live = null;

  const toScene = (lat, lng) => {
    const cos = Math.cos(lat * RAD);
    return [R * LIFT * cos * Math.sin(lng * RAD), R * LIFT * Math.sin(lat * RAD), R * LIFT * cos * Math.cos(lng * RAD)];
  };

  function points(items, color, size, order) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(items.length * 3);
    const colors = new Float32Array(items.length * 3);
    items.forEach((item, i) => {
      positions.set(toScene(item.lat, item.lng), i * 3);
      colors.set(rgb(color(item)), i * 3);
    });
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: size * (globe.renderer?.().getPixelRatio?.() ?? 1) }, uHideRadiusSq: hideUniform(globe) },
      vertexShader: DOT_VERTEX,
      fragmentShader: DOT_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const cloud = new THREE.Points(geometry, material);
    cloud.renderOrder = order;
    cloud.frustumCulled = false;
    cloud.raycast = () => {};
    return cloud;
  }

  function line(shape) {
    const style = LINE_STYLES[shape.kind];
    const flat = shape.points.flatMap(([lat, lng]) => toScene(lat, lng));
    const geometry = new LineGeometry();
    geometry.setPositions(flat);
    const material = new LineMaterial({ color: style.color, linewidth: style.width, dashed: style.dashed, dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false });
    const mesh = new Line2(geometry, material);
    if (style.dashed) mesh.computeLineDistances();
    mesh.renderOrder = 6;
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    const middle = flat.slice(3 * Math.floor(shape.points.length / 2), 3 * Math.floor(shape.points.length / 2) + 3);
    // Line widths are in screen pixels, which the material needs the size of the screen for; a line
    // behind the globe is given no width.
    mesh.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getSize(material.resolution);
      material.linewidth = behindGlobe(camera.position, ...middle, R) ? 0 : style.width;
    };
    return mesh;
  }

  function teardown() {
    if (!live) return;
    for (const object of live) {
      scene.remove(object);
      object.geometry.dispose();
      object.material.dispose();
    }
    live = null;
  }

  return {
    // `shapes` is { dots, lines, markers } (see mapShapes in opsaccess.js). Drawn from scratch
    // each time: a few thousand points, once a minute.
    show({ dots, lines, markers }) {
      teardown();
      live = [...lines.map(line), points(dots, (d) => SPEED_COLORS[d.band], DOT_PX, 7), points(markers, (m) => MARKER_COLORS[m.kind] ?? '#ffffff', MARKER_PX, 8)];
      for (const object of live) scene.add(object);
    },
    hide: teardown,
    dispose: teardown,
  };
}
