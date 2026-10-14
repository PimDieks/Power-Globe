// Road traffic on the map while an airport's Access tab is open: the motorways as lines coloured by
// speed (a segment between each two neighbouring measurement sites, coloured by the slower end),
// lines for the jams and closures, and markers for accidents and obstructions. A few meshes made
// when shown and let go of on hide, so nothing is held while the tab is closed. What to draw comes
// from mapShapes in opsaccess.js.
//
// Like the aircraft, these are drawn after the map layers and without depth testing (the map's
// tiles are pulled towards the camera, which would hide anything just above them), and are hidden
// behind the globe by the same test (see trafficlayer.js).
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { SPEED_COLORS } from './opsaccess.js';
import { BEHIND_GLOBE, behindGlobe, hideUniform } from './trafficlayer.js';

const RAD = Math.PI / 180;
const LIFT = 1.00003;
export const ROAD_PX = 4;
export const MARKER_PX = 13;
const LINE_STYLES = {
  jam: { color: 0xff4a3d, width: 7, dashed: false },
  closure: { color: 0xf2f5fa, width: 4, dashed: true },
};
// Dashes are in scene units, where the globe is 100 across: a dash of about 250 m and a gap of 190 m.
export const DASH = { dashSize: 0.004, gapSize: 0.003 };
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

// A disc in the colour of the marker with a dark rim, so it reads over any map.
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

  // Line widths are in screen pixels, which the material needs the size of the screen for; a line
  // behind the globe (judged by `middle`, one of its points) is given no width.
  const widthAware = (mesh, material, width, middle) => {
    mesh.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getSize(material.resolution);
      material.linewidth = behindGlobe(camera.position, ...middle, R) ? 0 : width;
    };
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    return mesh;
  };

  function markersCloud(items) {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(items.length * 3);
    const colors = new Float32Array(items.length * 3);
    items.forEach((item, i) => {
      positions.set(toScene(item.lat, item.lng), i * 3);
      colors.set(rgb(MARKER_COLORS[item.kind] ?? '#ffffff'), i * 3);
    });
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    const material = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: MARKER_PX * (globe.renderer?.().getPixelRatio?.() ?? 1) }, uHideRadiusSq: hideUniform(globe) },
      vertexShader: DOT_VERTEX,
      fragmentShader: DOT_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const cloud = new THREE.Points(geometry, material);
    cloud.renderOrder = 8;
    cloud.frustumCulled = false;
    cloud.raycast = () => {};
    return cloud;
  }

  // All the motorway segments in one mesh, each in its own colour.
  function roads(segments) {
    const positions = [];
    const colors = [];
    const tint = new THREE.Color();
    for (const { a, b, band } of segments) {
      positions.push(...toScene(...a), ...toScene(...b));
      tint.set(SPEED_COLORS[band]);
      colors.push(tint.r, tint.g, tint.b, tint.r, tint.g, tint.b);
    }
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(positions);
    geometry.setColors(colors);
    const material = new LineMaterial({ vertexColors: true, linewidth: ROAD_PX, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false });
    const mesh = new LineSegments2(geometry, material);
    mesh.renderOrder = 5;
    // The airport is within 25 km of all of them, so any one tells whether they are behind the globe.
    return widthAware(mesh, material, ROAD_PX, positions.slice(0, 3));
  }

  function line(shape) {
    const style = LINE_STYLES[shape.kind];
    const flat = shape.points.flatMap(([lat, lng]) => toScene(lat, lng));
    const geometry = new LineGeometry();
    geometry.setPositions(flat);
    const material = new LineMaterial({ color: style.color, linewidth: style.width, dashed: style.dashed, ...DASH, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false });
    const mesh = new Line2(geometry, material);
    if (style.dashed) mesh.computeLineDistances();
    mesh.renderOrder = 6;
    const at = 3 * Math.floor(shape.points.length / 2);
    return widthAware(mesh, material, style.width, flat.slice(at, at + 3));
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
    // `shapes` is { segments, lines, markers } (see mapShapes in opsaccess.js). Drawn from scratch
    // each time: a thousand segments, once a minute.
    show({ segments, lines, markers }) {
      teardown();
      live = [...(segments.length ? [roads(segments)] : []), ...lines.map(line), ...(markers.length ? [markersCloud(markers)] : [])];
      for (const object of live) scene.add(object);
    },
    hide: teardown,
    dispose: teardown,
  };
}
