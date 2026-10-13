// Drawing live traffic on the globe: thousands of aircraft and satellites as GPU point sprites,
// so they stay cheap to move every frame.
import * as THREE from 'three';

// Plane silhouettes, nose up, white with a dark outline so they read over any map or weather.
function planeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.translate(32, 32);
  const outline = [
    [0, -28], [3.5, -22], [3.5, -8], [27, 5], [27, 10], [3.5, 4], [3.5, 16], [11, 22], [11, 26], [0, 23],
    [-11, 26], [-11, 22], [-3.5, 16], [-3.5, 4], [-27, 10], [-27, 5], [-3.5, -8], [-3.5, -22],
  ];
  ctx.beginPath();
  outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  // Row 0 of the canvas at v = 0, like gl_PointCoord.
  texture.flipY = false;
  texture.colorSpace = THREE.NoColorSpace;
  return texture;
}

const AIRCRAFT_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aHeading;
  attribute float aScale;
  uniform float uSize;
  uniform vec2 uViewport;
  varying vec3 vColor;
  varying float vAngle;
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
    gl_Position = clip;
    gl_PointSize = uSize * aScale;
  }
`;

const AIRCRAFT_FRAGMENT = /* glsl */ `
  uniform sampler2D uGlyph;
  varying vec3 vColor;
  varying float vAngle;
  void main() {
    // Turn the nose-up glyph to the track's direction on screen.
    vec2 s = vec2(gl_PointCoord.x - 0.5, 0.5 - gl_PointCoord.y);
    float a = 1.5707963 - vAngle;
    vec2 t = vec2(s.x * cos(a) - s.y * sin(a), s.x * sin(a) + s.y * cos(a));
    vec2 uv = vec2(t.x + 0.5, 0.5 - t.y);
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) discard;
    vec4 g = texture2D(uGlyph, uv);
    if (g.a < 0.04) discard;
    gl_FragColor = vec4(g.rgb * vColor, g.a);
  }
`;

const DOT_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aScale;
  uniform float uSize;
  varying vec3 vColor;
  void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = uSize * aScale;
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
    uniforms: { uSize: { value: 10 }, uViewport: { value: new THREE.Vector2(1, 1) }, uGlyph: { value: planeTexture() } },
    vertexShader: AIRCRAFT_VERTEX,
    fragmentShader: AIRCRAFT_FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
  const cloud = new PointCloud(globe, material, { aColor: 3, aHeading: 1, aScale: 1 }, 10);
  cloud.setViewport = (w, h) => material.uniforms.uViewport.value.set(w, h);
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

export function selectionRing(globe) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 30 } },
    vertexShader: DOT_VERTEX,
    fragmentShader: RING_FRAGMENT,
    transparent: true,
    depthWrite: false,
  });
  const cloud = new PointCloud(globe, material, { aColor: 3, aScale: 1 }, 11);
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
