// Drawing live traffic on the globe: thousands of aircraft and satellites as GPU point sprites,
// so they stay cheap to move every frame.
import * as THREE from 'three';
import { AIRCRAFT_CLASSES } from './aircraftclass.js';
import { ICON_SIZE, drawAircraftIcon } from './aircrafticons.js';

// Aircraft are drawn at their true height, so one on the ground is at the surface, below the
// layers that sit just above it (the chart, weather, paths, runways). They and the selection
// ring are therefore drawn after those layers and without depth testing, and are hidden behind
// the globe by this test instead: a point is behind it when the line of sight to the camera
// passes through a sphere this share of the globe's radius first. A little under 1, so a point
// right on the surface does not hide itself.
export const HIDE_RADIUS = 0.999;

// Whether (x, y, z) is behind the globe as seen from `cam`, for a globe of the given radius.
export function behindGlobe(cam, x, y, z, radius) {
  const dx = x - cam.x;
  const dy = y - cam.y;
  const dz = z - cam.z;
  const a = dx * dx + dy * dy + dz * dz;
  const b = 2 * (cam.x * dx + cam.y * dy + cam.z * dz);
  const c = cam.x * cam.x + cam.y * cam.y + cam.z * cam.z - (radius * HIDE_RADIUS) ** 2;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return false;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 && t < 1;
}

// The same test in the vertex shader, for a globe of radius sqrt(uHideRadiusSq).
export const BEHIND_GLOBE = /* glsl */ `
  uniform float uHideRadiusSq;
  bool behindGlobe(vec3 p) {
    vec3 d = p - cameraPosition;
    float a = dot(d, d);
    float b = 2.0 * dot(cameraPosition, d);
    float c = dot(cameraPosition, cameraPosition) - uHideRadiusSq;
    float disc = b * b - 4.0 * a * c;
    float t = (-b - sqrt(max(disc, 0.0))) / (2.0 * a);
    return disc > 0.0 && t > 0.0 && t < 1.0;
  }
`;
export const hideUniform = (globe) => ({ value: (globe.getGlobeRadius() * HIDE_RADIUS) ** 2 });

// The aircraft icons, one layer per class in the order of AIRCRAFT_CLASSES. Layers of an array
// texture keep their own mipmaps, so small icons stay smooth and never pick up a neighbour.
function iconTexture() {
  const n = AIRCRAFT_CLASSES.length;
  const layer = ICON_SIZE * ICON_SIZE * 4;
  const data = new Uint8Array(layer * n);
  AIRCRAFT_CLASSES.forEach((cls, i) => {
    const canvas = drawAircraftIcon(cls);
    data.set(canvas.getContext('2d').getImageData(0, 0, ICON_SIZE, ICON_SIZE).data, i * layer);
  });
  // Row 0 of the canvas at v = 0, like gl_PointCoord.
  const texture = new THREE.DataArrayTexture(data, ICON_SIZE, ICON_SIZE, n);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const AIRCRAFT_VERTEX = /* glsl */ `
  ${BEHIND_GLOBE}
  attribute vec3 aColor;
  attribute float aHeading;
  attribute float aScale;
  attribute float aClass;
  attribute float aGround;
  uniform float uSize;
  uniform vec2 uViewport;
  uniform float uGroundScale;
  varying vec3 vColor;
  varying float vAngle;
  varying float vClass;
  varying float vGround;
  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // The aircraft's track as a direction on screen: north and east at its position on the
    // globe (the North Pole is +y), turned by the track, then projected.
    vec3 n = normalize(position);
    vec3 north = vec3(0.0, 1.0, 0.0) - n * n.y;
    north = length(north) > 1e-4 ? normalize(north) : vec3(0.0, 0.0, -1.0);
    vec3 east = cross(north, n);
    vec3 dir = cos(aHeading) * north + sin(aHeading) * east;
    vec4 ahead = projectionMatrix * modelViewMatrix * vec4(position + dir * 0.05, 1.0);
    vec2 d = (ahead.xy / ahead.w - clip.xy / clip.w) * uViewport;
    vAngle = atan(d.y, d.x);
    vColor = aColor;
    vClass = aClass;
    vGround = aGround;
    gl_Position = behindGlobe(position) ? vec4(2.0, 2.0, 2.0, 1.0) : clip;
    // Aircraft on the ground shrink only when the camera is far out (uGroundScale, see groundScale).
    gl_PointSize = uSize * aScale * mix(1.0, uGroundScale, aGround);
  }
`;

const AIRCRAFT_FRAGMENT = /* glsl */ `
  uniform highp sampler2DArray uIcons;
  varying vec3 vColor;
  varying float vAngle;
  varying float vClass;
  varying float vGround;
  void main() {
    // Turn the nose-up glyph to the track's direction on screen.
    vec2 s = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);
    float a = 1.5707963 - vAngle;
    vec2 t = vec2(s.x * cos(a) - s.y * sin(a), s.x * sin(a) + s.y * cos(a));
    vec2 uv = vec2(t.x + 0.5, 0.5 - t.y);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
    // The icon for this aircraft's class (see iconTexture).
    vec4 g = texture(uIcons, vec3(uv, floor(vClass + 0.5)));
    if (g.a < 0.04) discard;
    // On the ground the dark edge and shadow are made firmer, so the sprite holds on a grey apron.
    float alpha = vGround > 0.5 ? min(1.0, g.a * 1.5) : g.a;
    gl_FragColor = vec4(g.rgb * vColor, alpha);
  }
`;

// Satellites move between two computed positions a second apart, blended on the GPU.
const SATELLITE_VERTEX = /* glsl */ `
  attribute vec3 aNext;
  attribute vec3 aColor;
  attribute float aScale;
  uniform float uSize;
  uniform float uMix;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(mix(position, aNext, uMix), 1.0);
    gl_PointSize = uSize * aScale;
  }
`;

// A bright core with a soft glow, like a star.
const DOT_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    if (d > 1.0) discard;
    float core = smoothstep(0.55, 0.25, d);
    float glow = (1.0 - d) * 0.45;
    gl_FragColor = vec4(mix(vColor, vec3(1.0), core * 0.5), max(core, glow));
  }
`;

const RING_VERTEX = /* glsl */ `
  ${BEHIND_GLOBE}
  attribute vec3 aColor;
  attribute float aScale;
  uniform float uSize;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = behindGlobe(position) ? vec4(2.0, 2.0, 2.0, 1.0) : clip;
    gl_PointSize = uSize * aScale;
  }
`;

// A ring around the selected aircraft or satellite.
const RING_FRAGMENT = /* glsl */ `
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float ring = smoothstep(0.62, 0.72, d) * smoothstep(0.98, 0.88, d);
    float halo = smoothstep(0.58, 0.68, d) * smoothstep(1.0, 0.95, d);
    if (halo < 0.01) discard;
    gl_FragColor = vec4(mix(vec3(0.0), vColor, ring / max(halo, 0.001)), halo);
  }
`;

// A growable set of points with per-point attributes, drawn after the weather layers.
class PointCloud {
  constructor(globe, material, attributes, renderOrder) {
    this.globe = globe;
    this.attributeSizes = { position: 3, ...attributes };
    this.geometry = new THREE.BufferGeometry();
    this.points = new THREE.Points(this.geometry, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = renderOrder;
    this.points.raycast = () => {};
    this.capacity = 0;
    this.count = 0;
    globe.scene().add(this.points);
  }

  // Room for `n` points; returns the attribute arrays to fill.
  reserve(n) {
    if (n > this.capacity || !this.capacity) {
      this.capacity = Math.max(n, Math.ceil(this.capacity * 1.5), 256);
      for (const [name, size] of Object.entries(this.attributeSizes)) {
        const attribute = new THREE.BufferAttribute(new Float32Array(this.capacity * size), size);
        attribute.setUsage(THREE.DynamicDrawUsage);
        this.geometry.setAttribute(name, attribute);
      }
    }
    return Object.fromEntries(Object.keys(this.attributeSizes).map((name) => [name, this.geometry.attributes[name].array]));
  }

  // Draw the first `n` points after their attributes were filled in.
  commit(n) {
    this.count = n;
    this.geometry.setDrawRange(0, n);
    for (const name of Object.keys(this.attributeSizes)) {
      const attribute = this.geometry.attributes[name];
      if (!attribute) continue;
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, n * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  set visible(v) {
    this.points.visible = v;
  }

  set size(px) {
    this.points.material.uniforms.uSize.value = px;
  }
}

export function aircraftLayer(globe) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSize: { value: 10 },
      uViewport: { value: new THREE.Vector2(1, 1) },
      uGroundScale: { value: 1 },
      uIcons: { value: iconTexture() },
      uHideRadiusSq: hideUniform(globe),
    },
    vertexShader: AIRCRAFT_VERTEX,
    fragmentShader: AIRCRAFT_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const cloud = new PointCloud(globe, material, { aColor: 3, aHeading: 1, aScale: 1, aClass: 1, aGround: 1 }, 10);
  cloud.setViewport = (w, h) => material.uniforms.uViewport.value.set(w, h);
  cloud.setGroundScale = (k) => (material.uniforms.uGroundScale.value = k);
  return cloud;
}

export function satelliteLayer(globe) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 4 }, uMix: { value: 0 } },
    vertexShader: SATELLITE_VERTEX,
    fragmentShader: DOT_FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
  const cloud = new PointCloud(globe, material, { aNext: 3, aColor: 3, aScale: 1 }, 9);
  Object.defineProperty(cloud, 'mix', {
    set(t) {
      material.uniforms.uMix.value = t;
    },
  });
  return cloud;
}

const ringMaterial = (globe) =>
  new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 30 }, uHideRadiusSq: hideUniform(globe) },
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });

// Rings around several aircraft at once (the ones the Ops tab marks), under the selection ring.
export function markerLayer(globe) {
  const cloud = new PointCloud(globe, ringMaterial(globe), { aColor: 3, aScale: 1 }, 10.8);
  cloud.visible = false;
  return cloud;
}

export function selectionRing(globe) {
  const cloud = new PointCloud(globe, ringMaterial(globe), { aColor: 3, aScale: 1 }, 11);
  const attrs = cloud.reserve(1);
  attrs.aColor.set([0.61, 0.82, 1]);
  attrs.aScale[0] = 1;
  cloud.place = (p) => {
    if (!p) {
      cloud.visible = false;
      return;
    }
    cloud.visible = true;
    cloud.geometry.attributes.position.array.set([p.x, p.y, p.z]);
    cloud.commit(1);
  };
  cloud.visible = false;
  return cloud;
}

// The path of the selected satellite's next orbit.
export function orbitLine(globe) {
  const line = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x9bd1ff, transparent: true, opacity: 0.65, depthWrite: false }),
  );
  line.frustumCulled = false;
  line.renderOrder = 8;
  line.visible = false;
  line.raycast = () => {};
  globe.scene().add(line);
  return {
    show(points) {
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry().setFromPoints(points.map((p) => new THREE.Vector3(p.x, p.y, p.z)));
      line.visible = points.length > 1;
    },
    hide() {
      line.visible = false;
    },
  };
}

// A line drawn as a ribbon a few pixels wide, since WebGL draws no thicker lines: a bright core
// with a dark edge, so it reads over any map or weather. Like the aircraft it is drawn after the
// weather layers without depth testing, and hidden behind the globe by the same test. It goes over
// the other aircraft (under the selection ring), which would otherwise hide most of it among dense
// traffic. Each segment is a quad of its own (a square end covers the joints), so a changed end
// can be rewritten, and uploaded, without touching the rest. `dashed` lines break into dashes of
// `dash` scene units. A segment that crosses the camera's plane is cut at it. The end called the
// tip (the last point of a line with `tip: 'end'`, the first with `tip: 'start'`) is where the
// aircraft is, and stops `gap` pixels short of it instead of running over it.
const LINE_VERTEX = /* glsl */ `
  attribute vec3 aOther;
  attribute float aSide;
  attribute float aEnd;
  attribute float aDist;
  attribute float aTip;
  uniform vec2 uViewport;
  uniform float uWidth;
  uniform float uGap;
  varying vec3 vWorld;
  varying float vSide;
  varying float vDist;
  // The distance in front of the camera under which a segment is cut.
  const float NEAR_W = 0.05;
  void main() {
    vec4 here = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 there = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);
    vec3 world = position;
    float dist = aDist;
    if (here.w < NEAR_W && there.w < NEAR_W) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }
    // Cut at the camera's plane: in clip space the cut point is on the straight line between the two.
    if (here.w < NEAR_W) {
      float t = (NEAR_W - here.w) / (there.w - here.w);
      here = mix(here, there, t);
      world = mix(position, aOther, t);
      dist = aDist + aEnd * t * length(aOther - position);
    } else if (there.w < NEAR_W) {
      there = mix(there, here, (NEAR_W - there.w) / (here.w - there.w));
    }
    vWorld = world;
    vSide = aSide;
    vDist = dist;
    vec2 toOther = (there.xy / there.w - here.xy / here.w) * uViewport * 0.5;
    float len = length(toOther);
    // The segment's direction on screen, from its first end to its second.
    vec2 dir = len > 1e-4 ? toOther / len * aEnd : vec2(1.0, 0.0);
    vec2 normal = vec2(-dir.y, dir.x);
    float hw = uWidth * 0.5;
    // The ends are squared off past the point by half the width, except the tip, which stops short.
    float along = aTip > 0.5 ? aEnd * min(uGap, len) : -aEnd * hw;
    vec2 offset = (normal * aSide * hw + dir * along) / (uViewport * 0.5);
    gl_Position = vec4(here.xy + offset * here.w, here.z, here.w);
  }
`;

const LINE_FRAGMENT = /* glsl */ `
  ${BEHIND_GLOBE}
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uDash;
  varying vec3 vWorld;
  varying float vSide;
  varying float vDist;
  void main() {
    if (behindGlobe(vWorld)) discard;
    if (uDash > 0.0 && mod(vDist, uDash * 1.8) > uDash) discard;
    float edge = smoothstep(0.5, 0.66, abs(vSide));
    float soft = 1.0 - smoothstep(0.88, 1.0, abs(vSide));
    gl_FragColor = vec4(mix(uColor, vec3(0.04, 0.05, 0.09), edge * 0.85), uAlpha * soft);
  }
`;

export function flightLine(globe, { color, dashed = false, width = 5, alpha = 0.95, renderOrder = 10.5, tip = null }) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uViewport: { value: new THREE.Vector2(1, 1) },
      uWidth: { value: width },
      uGap: { value: 0 },
      uColor: { value: new THREE.Color(...color) },
      uAlpha: { value: alpha },
      uDash: { value: 0 },
      uHideRadiusSq: hideUniform(globe),
    },
    vertexShader: LINE_VERTEX,
    fragmentShader: LINE_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const geometry = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = renderOrder;
  mesh.raycast = () => {};
  mesh.visible = false;
  globe.scene().add(mesh);

  const sizes = { position: 3, aOther: 3, aSide: 1, aEnd: 1, aDist: 1, aTip: 1 };
  let capacity = 0;
  let segments = 0;
  let points = new Float32Array(0);

  function reserve(n) {
    if (n <= capacity) return;
    // The buffers being replaced are freed, rather than left on the graphics card.
    geometry.dispose();
    capacity = Math.max(n, Math.ceil(capacity * 1.5), 64);
    for (const [name, size] of Object.entries(sizes)) {
      const attribute = new THREE.BufferAttribute(new Float32Array(capacity * 4 * size), size);
      attribute.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute(name, attribute);
    }
    const index = new Uint32Array(capacity * 6);
    for (let k = 0; k < capacity; k++) index.set([4 * k, 4 * k + 1, 4 * k + 2, 4 * k + 2, 4 * k + 1, 4 * k + 3], 6 * k);
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
  }

  // Writes segment k, from point k to point k + 1 of `points`, whose distance along the line at
  // its start is `dist`; returns the distance at its end.
  function writeSegment(k, dist) {
    const a = 3 * k;
    const b = a + 3;
    const length = Math.hypot(points[b] - points[a], points[b + 1] - points[a + 1], points[b + 2] - points[a + 2]);
    const { position, aOther, aSide, aEnd, aDist, aTip } = geometry.attributes;
    for (let v = 0; v < 4; v++) {
      const startVertex = v < 2;
      const own = startVertex ? a : b;
      const other = startVertex ? b : a;
      const i = 4 * k + v;
      position.array.set([points[own], points[own + 1], points[own + 2]], 3 * i);
      aOther.array.set([points[other], points[other + 1], points[other + 2]], 3 * i);
      aSide.array[i] = v % 2 ? 1 : -1;
      aEnd.array[i] = startVertex ? 1 : -1;
      aDist.array[i] = startVertex ? dist : dist + length;
      aTip.array[i] = (tip === 'end' && k === segments - 1 && !startVertex) || (tip === 'start' && k === 0 && startVertex) ? 1 : 0;
    }
    return dist + length;
  }

  // Uploads all of the named attributes, or only those of the vertices of one segment.
  function touch(names, segment = null) {
    for (const name of names) {
      const attribute = geometry.attributes[name];
      attribute.clearUpdateRanges();
      if (segment !== null) attribute.addUpdateRange(4 * segment * attribute.itemSize, 4 * attribute.itemSize);
      attribute.needsUpdate = true;
    }
  }

  return {
    mesh,
    // The line through `flat` (x, y, z of each point, in scene units).
    set(flat) {
      const n = Math.floor(flat.length / 3);
      if (n < 2) {
        segments = 0;
        mesh.visible = false;
        return;
      }
      reserve(n - 1);
      points = Float32Array.from(flat);
      segments = n - 1;
      let dist = 0;
      for (let k = 0; k < segments; k++) dist = writeSegment(k, dist);
      geometry.setDrawRange(0, segments * 6);
      touch(Object.keys(sizes));
      mesh.visible = true;
    },
    // Moves the last point, e.g. to where the aircraft is now, rewriting only the last segment.
    moveEnd(x, y, z) {
      if (!segments) return;
      points.set([x, y, z], 3 * segments);
      writeSegment(segments - 1, geometry.attributes.aDist.array[4 * (segments - 1)]);
      touch(['position', 'aOther', 'aDist'], segments - 1);
    },
    // Moves the first point, rewriting only the first segment.
    moveStart(x, y, z) {
      if (!segments) return;
      points.set([x, y, z], 0);
      writeSegment(0, 0);
      touch(['position', 'aOther', 'aDist'], 0);
    },
    hide() {
      segments = 0;
      mesh.visible = false;
    },
    setViewport(w, h) {
      material.uniforms.uViewport.value.set(w, h);
    },
    // How far the tip stops short of the aircraft, in pixels.
    set gap(pixels) {
      material.uniforms.uGap.value = pixels;
    },
    // Dash length in scene units (dashed lines only), kept at about the same size on screen.
    set dash(units) {
      if (dashed) material.uniforms.uDash.value = units;
    },
  };
}
