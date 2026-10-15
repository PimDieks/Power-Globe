import * as THREE from 'three';
import SlippyMap from 'three-slippy-map-globe';
import { PROXY_URL } from './api.js';
import { CITIES, labelTier } from './cities.js';
import { STATUS } from './runways.js';
import { retryingTextureLoad, withLoad } from './tileretry.js';
import {
  AREA_DEG,
  CAPABILITIES_URL,
  FADE_FROM_DEG,
  MAP_LEVEL_LIMIT,
  TileStore,
  coarserView,
  framesFor,
  loopFrames,
  loopStep,
  loopStatus,
  parseTimes,
  passedFrames,
  tileBounds,
  tileUrl,
  tilesInView,
} from './meteosat.js';

// Daily cloud imagery is used up to this tile level (about 300 m per pixel).
const CLOUDS_MAX_LEVEL = 9;
// The last whole day (UTC) of satellite passes, as YYYY-MM-DD.
export const cloudsDay = (now = Date.now()) => new Date(now - 86_400_000).toISOString().slice(0, 10);

const esri = (service) => (x, y, level) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/${level}/${y}/${x}`;

// Ways to show the Earth itself, all as Web Mercator map tiles. `light` scales the scene lighting.
export const BASEMAPS = {
  // Satellite and aerial imagery down to sub-metre detail in many places.
  satellite: {
    label: 'Satellite',
    url: esri('World_Imagery'),
    maxLevel: 17,
    light: 1,
    credit: 'Imagery <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics and the GIS User Community; NASA Blue Marble',
  },
  streets: {
    label: 'Streets',
    url: esri('World_Street_Map'),
    maxLevel: 18,
    light: 1.1,
    credit: 'Map <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, HERE, Garmin, USGS, OpenStreetMap contributors and the GIS User Community',
  },
  topo: {
    label: 'Topographic',
    url: esri('World_Topo_Map'),
    maxLevel: 18,
    light: 1.1,
    credit: 'Map <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, HERE, Garmin, FAO, NOAA, USGS, OpenStreetMap contributors and the GIS User Community',
  },
  // Clouds as seen from space: one day of NASA's VIIRS true colour imagery (NOAA-20, public
  // domain, via NASA GIBS), the most recent complete day. Its pixels are about 300 m across, so
  // closer in the view continues as the satellite imagery. Over Europe and Africa the clouds move
  // with the timeline, in a layer of their own above it (EUMETSAT's Meteosat images, see
  // setupMovingClouds), until zoomed in past their detail of 1 to 2 km.
  clouds: {
    label: 'Clouds',
    url: (x, y, level) =>
      level <= CLOUDS_MAX_LEVEL
        ? `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/${cloudsDay()}/GoogleMapsCompatible_Level9/${level}/${y}/${x}.jpg`
        : esri('World_Imagery')(x, y, level),
    maxLevel: 17,
    light: 1,
    // Where the satellite saw nothing that day the imagery is pure black: see through it to
    // the whole-Earth image beneath instead.
    noDataBlack: true,
    moving: true,
    get credit() {
      return `Clouds on ${cloudsDay()} (UTC): <a href="https://www.earthdata.nasa.gov/data/instruments/viirs" target="_blank" rel="noopener">NASA VIIRS</a> via GIBS; close up imagery <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics and the GIS User Community`;
    },
  },
  // An aeronautical chart: openAIP's airspaces, airports, navaids and reporting points (through
  // the Power Globe API, which holds the key) over a plain light grey map.
  aviation: {
    label: 'Aviation',
    url: esri('Canvas/World_Light_Gray_Base'),
    maxLevel: 16,
    light: 1.2,
    chart: { url: (x, y, level) => `${PROXY_URL}/tiles/openaip/${level}/${x}/${y}.png`, maxLevel: 14 },
    credit:
      'Chart <a href="https://www.openaip.net/" target="_blank" rel="noopener">openAIP</a> (CC BY-NC 4.0); map <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, HERE, Garmin, OpenStreetMap contributors and the GIS User Community',
  },
  // The satellite imagery recoloured into a calm night palette (see PALETTES), so aircraft,
  // labels and the weather stand out against it.
  dark: {
    label: 'Dark',
    url: esri('World_Imagery'),
    maxLevel: 17,
    light: 1.2,
    palette: 'night',
    credit: 'Imagery <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, Maxar, Earthstar Geographics and the GIS User Community; NASA Blue Marble',
  },
};

// Colour schemes a map's imagery can be drawn in (a basemap's `palette`). The imagery's
// brightness picks a colour along `stops` (sRGB, darkest first), and water, told apart by its
// blue or teal colour, goes darker still.
export const PALETTES = {
  night: { stops: ['#05080f', '#131a27', '#3a475e'] },
};
// Below this altitude the view reads as a map: brighter imagery, borders and city names.
const MAP_ALTITUDE = 1.3;

// Satellite imagery that sharpens as you zoom in, over a whole-Earth image just beneath it.
// The image shows wherever tiles are missing: the poles (beyond Web Mercator), while tiles
// load, or if the tile server cannot be reached.
// Returns { setAltitude(altitude), setStyle(key), setFollowing(on), setTime(time, ahead),
// cloudsAsOf(), cloudsShown(), and the clouds loop: startCloudsLoop({ manual }), stopCloudsLoop(),
// advanceCloudsLoop(), cloudsLoop() }. `onClouds()` is called when the moving clouds show another
// image, and `onCredit(html)` whenever the credit changes.
export function setupBasemap(globe, backdropUrl, { initial = 'satellite', onCredit, onClouds } = {}) {
  let style = BASEMAPS[initial] ?? BASEMAPS.satellite;
  globe.globeTileEngineUrl(style.url).globeTileEngineMaxLevel(style.maxLevel);
  // A second, transparent layer of tiles just above the map, for a chart drawn over it.
  const chart = setupChartLayer(globe);
  let tilesTuned = false;
  window.addEventListener('resize', () => {
    tilesTuned = matchTileDetailToScreen(globe, chart.engine);
  });
  // three-globe's tile engine joins the scene only once the globe has initialised, so keep trying.
  let baseEngine = null;
  const findBaseEngine = () => {
    if (!baseEngine) {
      baseEngine = findTileEngine(globe, chart.engine);
      if (baseEngine) {
        styleTiles(baseEngine, () => style);
        // Tiles loaded before the hook was in place go, and the view's tiles load again, styled:
        // the engine asks for tiles only as the camera moves, and it may not move again for a while.
        if (style.noDataBlack || style.palette) {
          globe.globeTileEngineClearCache();
          baseEngine.updatePov?.(globe.camera());
        }
        settleLevels(baseEngine, globe);
        boundAfterAdding(baseEngine, globe);
      }
    }
    return baseEngine;
  };
  // Moving clouds over Europe and Africa, just above the map, for the Clouds view.
  let lastCredit = null;
  const moving = setupMovingClouds(globe, findBaseEngine, () => {
    if (credit() !== lastCredit) onCredit?.((lastCredit = credit()));
    onClouds?.();
  });
  // The view's credit, and EUMETSAT's while its images are on screen.
  function credit() {
    const shown = moving.shown();
    if (shown === null) return style.credit;
    const year = new Date(shown).getUTCFullYear();
    return `Contains modified <a href="https://www.eumetsat.int/" target="_blank" rel="noopener">EUMETSAT</a> Meteosat data ${year}. ${style.credit}`;
  }

  const texture = new THREE.TextureLoader().load(backdropUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const dayMaterial = new THREE.MeshLambertMaterial({ map: texture });
  // The same image in each palette, so it matches the tiles while they load.
  const paletteMaterials = new Map();
  const backdropMaterial = () => {
    if (!style.palette) return dayMaterial;
    if (!paletteMaterials.has(style.palette)) {
      const material = new THREE.MeshLambertMaterial({ map: texture });
      restyle(material, { palette: style.palette });
      paletteMaterials.set(style.palette, material);
    }
    return paletteMaterials.get(style.palette);
  };
  const backdrop = new THREE.Mesh(
    new THREE.SphereGeometry(globe.getGlobeRadius() * 0.995, 96, 64),
    backdropMaterial(),
  );
  // three-globe rotates its globe mesh this way so equirectangular textures line up.
  backdrop.rotation.y = -Math.PI / 2;
  backdrop.raycast = () => {};
  globe.scene().add(backdrop);

  // Dim the lights when looking at the whole globe, so the weather glows on top of it, and
  // brighten them when zoomed in to a map.
  const lights = globe.lights().map((light) => ({ light, intensity: light.intensity }));
  let altitude = 2.5;

  function setAltitude(value) {
    altitude = value;
    tilesTuned ||= matchTileDetailToScreen(globe, chart.engine);
    boundTiles(findBaseEngine(), globe.camera());
    boundTiles(chart.engine, globe.camera());
    chart.update();
    moving.update();
    const t = Math.min(1, Math.max(0, (altitude - 0.4) / (MAP_ALTITUDE + 0.6 - 0.4)));
    // Not full brightness even zoomed in, so white wind trails and labels keep their contrast.
    const brightness = (0.85 - 0.3 * t) * style.light;
    for (const { light, intensity } of lights) light.intensity = intensity * brightness;
  }

  function setStyle(key) {
    const next = BASEMAPS[key] ?? BASEMAPS.satellite;
    if (next === style) return;
    style = next;
    // Drop the old map's tiles; the new URL then loads tiles for the current view.
    globe.globeTileEngineClearCache();
    globe.globeTileEngineMaxLevel(style.maxLevel).globeTileEngineUrl(style.url);
    backdrop.material = backdropMaterial();
    chart.set(style.chart);
    moving.setActive(Boolean(style.moving));
    setAltitude(altitude);
    onCredit?.((lastCredit = credit()));
  }

  chart.set(style.chart);
  moving.setActive(Boolean(style.moving));
  onCredit?.((lastCredit = credit()));
  return {
    setAltitude,
    setStyle,
    setFollowing(on) {
      chart.setFollowing(on);
      moving.setFollowing(on);
    },
    setTime: moving.setTime,
    cloudsAsOf: moving.asOf,
    cloudsShown: moving.shown,
    startCloudsLoop: moving.startLoop,
    stopCloudsLoop: moving.stopLoop,
    advanceCloudsLoop: moving.advanceLoop,
    cloudsLoop: moving.loopState,
  };
}

// three-globe's tile engine, once the globe has initialised (else null).
function findTileEngine(globe, exclude) {
  let engine = null;
  globe.scene().traverse((obj) => {
    if (!engine && obj !== exclude && Array.isArray(obj.thresholds) && 'tileUrl' in obj) engine = obj;
  });
  return engine;
}

// The tile engines keep every tile they load for as long as the view stays at its level or
// closer: the coarse tiles passed on the way in, and every tile flown over while following an
// aircraft, so their memory grew for as long as the page was open. Beyond MAX_TILES, or one and a
// half times the tiles in view if that is more, the tiles out of view are let go, farthest from the
// middle of the view first. The engine loads a tile again when it comes back into view (see
// evictTile in src/vendor/three-slippy-map-globe.mjs). Returns the number of tiles let go.
export const MAX_TILES = 300;
const sphere = new THREE.Sphere();
let warnedNoEvict = false;
// A tile's zoom level follows from its width.
const tileLevel = (tile) => Math.round(Math.log2((2 * Math.PI) / tile.geometry.parameters.phiLength));
export function boundTiles(engine, camera, max = MAX_TILES) {
  if (!camera?.isCamera || !(engine?.children?.length > max)) return 0;
  if (typeof engine.evictTile !== 'function') {
    if (!warnedNoEvict) {
      warnedNoEvict = true;
      console.warn(
        `The map has ${engine.children.length} tiles and cannot let any go: its tile engine has no evictTile (see vite.config.js).`,
      );
    }
    return 0;
  }
  // The camera always looks at the middle of the globe, but its direction can be a frame behind
  // its position when the view changes, so the view is worked out from a copy turned that way.
  const eye = camera.clone();
  eye.lookAt(0, 0, 0);
  eye.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(eye.projectionMatrix, eye.matrixWorldInverse),
  );
  // How far around a globe of `radius` the camera sees, as an angle from the point beneath it.
  const horizon = (radius) => Math.acos(Math.min(1, radius / eye.position.length()));
  const away = [];
  let loaded = 0;
  for (const tile of engine.children) {
    if (!tile.material?.map || !tile.geometry?.parameters?.phiLength) continue;
    loaded++;
    if (!tile.geometry.boundingSphere) tile.geometry.computeBoundingSphere();
    sphere.copy(tile.geometry.boundingSphere).applyMatrix4(tile.matrixWorld);
    const angle = eye.position.angleTo(sphere.center);
    // Coarser tiles than the view's are only seen where they are on the near side of the globe.
    // Tiles of the view's own level are kept while they are anywhere in the camera's view, near
    // side or far, as that is where the engine asks for them again.
    const reach = Math.asin(Math.min(1, sphere.radius / sphere.center.length()));
    if (tileLevel(tile) < engine.level && angle - reach > horizon(tile.geometry.parameters.radius)) {
      away.push({ tile, angle });
      continue;
    }
    // The tile is given a margin, so that one at the edge of the view is not let go and asked for
    // again.
    sphere.radius *= 1.5;
    if (!frustum.intersectsSphere(sphere)) away.push({ tile, angle });
  }
  const cap = Math.max(max, Math.ceil(1.5 * (loaded - away.length)));
  away.sort((a, b) => b.angle - a.angle);
  let forgotten = 0;
  for (const { tile } of away.slice(0, Math.max(0, loaded - cap))) if (engine.evictTile(tile)) forgotten++;
  return forgotten;
}

// Tiles also arrive after the camera has stopped, so the limit is checked again shortly after.
function boundAfterAdding(engine, globe) {
  const add = engine.add.bind(engine);
  let timer = null;
  engine.add = (...objects) => {
    const result = add(...objects);
    timer ??= setTimeout(() => {
      timer = null;
      boundTiles(engine, globe.camera());
    }, 200);
    return result;
  };
}

// Returns the tile level the engine picks for a camera (see updatePov in three-slippy-map-globe):
// the first of its thresholds, in globe radii above the ground, that the camera is above.
export function tileLevelFor(engine, camera, radius) {
  const height = (camera.position.length() - radius) / radius;
  const i = engine.thresholds.findIndex((t) => t && t <= height);
  return Math.min(engine.maxLevel, Math.max(engine.minLevel ?? 0, i < 0 ? engine.thresholds.length : i));
}

// three-globe tells its tile engine of every move of the camera, and the engine loads the tiles
// in view at every level it passes, most of them on screen for a moment if at all: a zoom out from
// an airport asked for over a thousand. A new level waits until the zoom pauses (250 ms, see
// whenSettled), or at most LEVEL_MAX_WAIT_MS while it goes on; moves within a level go through at
// once.
const LEVEL_MAX_WAIT_MS = 500;
export function settleLevels(engine, globe) {
  if (!engine.updatePov) return;
  const updatePov = engine.updatePov.bind(engine);
  const settled = whenSettled(() => updatePov(globe.camera()), { maxWait: LEVEL_MAX_WAIT_MS });
  engine.updatePov = (camera) => {
    if (camera?.position && tileLevelFor(engine, camera, globe.getGlobeRadius()) !== engine.level) {
      settled.update();
      return;
    }
    settled.cancel();
    updatePov(camera);
  };
}

// Pixels this dark (linear colour, about 5/255 before decoding) are taken as no data. Real
// imagery is never this dark in all three channels by day, not even deep ocean.
const NO_DATA_LEVEL = 0.0015;

// New tiles are drawn as the current style asks: with pure black pixels left out where it has
// `noDataBlack`, so the whole-Earth image beneath shows through gaps in the imagery, and
// recoloured where it has a `palette`.
function styleTiles(engine, current) {
  const add = engine.add.bind(engine);
  engine.add = (...tiles) => {
    const { noDataBlack, palette } = current();
    if (noDataBlack || palette) {
      for (const tile of tiles) if (tile.material?.map) restyle(tile.material, { noDataBlack, palette });
    }
    return add(...tiles);
  };
}

function restyle(material, { noDataBlack = false, palette = null }) {
  const steps = [];
  if (noDataBlack) steps.push(`if (max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b) < ${NO_DATA_LEVEL}) discard;`);
  if (palette) steps.push(paletteGlsl(PALETTES[palette]));
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n${steps.join('\n')}`);
  };
  const key = [noDataBlack && 'see-through-no-data', palette && `palette-${palette}`].filter(Boolean).join('+');
  material.customProgramCacheKey = () => key;
  // Dark gradients would show steps without it.
  material.dithering = Boolean(palette);
  material.needsUpdate = true;
}

// GLSL that recolours `diffuseColor` (linear, straight from the imagery) into `palette`.
function paletteGlsl({ stops }) {
  const [dark, mid, light] = stops.map((hex) => {
    const c = new THREE.Color().setStyle(hex, THREE.NoColorSpace);
    return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
  });
  return `{
    vec3 s = pow(max(diffuseColor.rgb, vec3(0.0)), vec3(1.0 / 2.2));
    float l = dot(s, vec3(0.299, 0.587, 0.114));
    // Water is blue or teal and darkish; green and brown land is not.
    float water = smoothstep(0.03, 0.12, s.b - s.r) * (1.0 - smoothstep(0.0, 0.06, s.g - s.b)) * (1.0 - smoothstep(0.35, 0.55, l));
    // A gentle curve: land starts a step above the sea and keeps its texture, its brightest
    // parts (towns, concrete, sand, snow) lift without glaring.
    float x = clamp((l - 0.04) / 0.76, 0.0, 1.0);
    float t = mix(0.26 + 0.66 * pow(x, 0.7), 0.04 + 0.2 * x, water);
    vec3 col = t < 0.5 ? mix(${dark}, ${mid}, t * 2.0) : mix(${mid}, ${light}, t * 2.0 - 1.0);
    diffuseColor.rgb = pow(col, vec3(2.2));
  }`;
}

let blankImage = null;
// A transparent pixel, for a tile that cannot be had.
function blank() {
  if (!blankImage) {
    blankImage = document.createElement('canvas');
    blankImage.width = blankImage.height = 1;
  }
  return blankImage;
}

// Runs `fn`, a call into a tile engine, with the tile loads it starts retried when they fail (see
// tileretry.js). The engine loads its tiles with a TextureLoader of its own, out of reach.
function withTileRetries(fn, isStale) {
  const load = retryingTextureLoad({ ImageLoader: THREE.ImageLoader, Texture: THREE.Texture, blank, isStale });
  withLoad(THREE.TextureLoader.prototype, load, fn);
}

// A layer of transparent map tiles over the globe's own (three-globe has room for one).
// `set({ url, maxLevel })` shows a chart, `set(null)` removes it; call `update()` as the camera
// moves.
function setupChartLayer(globe) {
  const engine = new SlippyMap(globe.getGlobeRadius() * 1.00002);
  engine.visible = false;
  // Its dark backing sphere would hide the map below.
  engine.children[0].material.visible = false;
  boundAfterAdding(engine, globe);
  // Tiles see through to the map, and only the current level shows: coarser tiles kept for
  // later would otherwise show through between the finer ones' lines and labels.
  const showLevel = () => {
    for (const tile of engine.children) if (tile.material.map) tile.visible = tileLevel(tile) === engine.level;
  };
  const add = engine.add.bind(engine);
  engine.add = (...tiles) => {
    for (const tile of tiles) {
      tile.material.transparent = true;
      tile.renderOrder = 1;
    }
    add(...tiles);
    showLevel();
    return engine;
  };
  globe.scene().add(engine);
  // Tiles are asked for once the view settles, not for every level passed on the way while
  // zooming: far fewer requests to the chart's service.
  const settled = whenSettled(() => {
    withRetries(() => engine.updatePov(globe.camera()));
    showLevel();
  });
  // Counts the times the chart was cleared, so tiles still being retried for the old one stop.
  let version = 0;
  const withRetries = (fn) => {
    const mine = version;
    withTileRetries(fn, () => version !== mine);
  };

  return {
    engine,
    set(chart) {
      version++;
      engine.clearTiles();
      engine.visible = Boolean(chart);
      if (!chart) return;
      engine.maxLevel = chart.maxLevel;
      withRetries(() => {
        engine.tileUrl = chart.url;
        engine.updatePov(globe.camera());
      });
    },
    setFollowing: settled.setFollowing,
    update() {
      if (engine.visible) settled.update();
    },
  };
}

// Calls `run` once the view has settled, 250 ms after the last call to `update()`, or at the
// latest `maxWait` ms after the first call since it last ran. While the camera follows an
// aircraft it never settles: `run` is then called at most once a second, counted from the last
// time it was.
function whenSettled(run, { maxWait = Infinity } = {}) {
  let last = 0;
  let following = false;
  let settle = null;
  let since = null;
  return {
    setFollowing(on) {
      following = on;
    },
    update() {
      if (following && settle) return;
      const now = performance.now();
      since ??= now;
      clearTimeout(settle);
      settle = setTimeout(
        () => {
          settle = null;
          since = null;
          last = performance.now();
          run();
        },
        following ? Math.max(250, last + 1000 - now) : Math.min(250, Math.max(0, since + maxWait - now)),
      );
    },
    cancel() {
      clearTimeout(settle);
      settle = null;
      since = null;
    },
  };
}

const DEG = Math.PI / 180;
// How often the times of the images are read again while the moving clouds are shown, and after
// a failure to read them.
const TIMES_REFRESH_MS = 600_000;
const TIMES_RETRY_MS = 60_000;
// Zoomed in past the images' detail, they stay this long while the map's finer tiles load, then
// fade out over FADE_OUT_MS.
const HOLD_MS = 400;
const FADE_OUT_MS = 500;

// The point at `lat`, `lng` on a sphere of `radius`, as three-globe places it.
const pointAt = (lat, lng, radius) => new THREE.Vector3().setFromSphericalCoords(radius, (90 - lat) * DEG, lng * DEG);

// A mesh for Web Mercator tile x, y at `level`, as three-slippy-map-globe makes them: a piece of
// a sphere, its texture stretched to match the Mercator image. Its flat facets are 2° across at
// most, so with the radius it is given they stay above the map's tiles, whose facets are up to 5°
// across and sag further below the sphere.
function mercatorTile(x, y, level, radius, material) {
  const { west, east, south, north } = tileBounds(x, y, level);
  const width = east - west;
  const height = north - south;
  const geometry = new THREE.SphereGeometry(
    radius,
    Math.max(2, Math.ceil(width / 2)),
    Math.max(2, Math.ceil(height / 2)),
    (90 + west) * DEG,
    width * DEG,
    (90 - north) * DEG,
    height * DEG,
  );
  const mercator = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const lat = south + uv.getY(i) * height;
    uv.setY(i, (mercator(lat) - mercator(south)) / (mercator(north) - mercator(south)));
  }
  return new THREE.Mesh(geometry, material);
}

// Leaves the images out beyond AREA_DEG from the point beneath the satellite, fading them in from
// FADE_FROM_DEG. That point is along +z, where three-globe puts 0° N, 0° E. The image can also
// fade into a second one, `userData.cross.map2`, by `userData.cross.crossMix` (0 to 1), for the
// clouds loop.
function fadeToArea(material) {
  const cos = (deg) => Math.cos(deg * DEG).toFixed(6);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, material.userData.cross);
    shader.vertexShader = `varying vec3 vSatelliteDir;
${shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSatelliteDir = position;')}`;
    shader.fragmentShader = `varying vec3 vSatelliteDir;
uniform sampler2D map2;
uniform float crossMix;
${shader.fragmentShader.replace(
  '#include <map_fragment>',
  `#include <map_fragment>
  diffuseColor.rgb = mix(diffuseColor.rgb, texture2D(map2, vMapUv).rgb, crossMix);
  diffuseColor.a *= smoothstep(${cos(AREA_DEG)}, ${cos(FADE_FROM_DEG)}, normalize(vSatelliteDir).z);`,
)}`;
  };
  material.customProgramCacheKey = () => 'fade-to-satellite-area';
}

// Drawn a little nearer than they are too: seen from afar, depth is not precise enough to tell
// them from the map's tiles beneath.
function tileMaterial(texture) {
  const material = new THREE.MeshLambertMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -8,
  });
  material.userData.cross = { map2: { value: texture }, crossMix: { value: 0 } };
  fadeToArea(material);
  return material;
}

// The tile store keeps this many images: each takes about 1 MB once decoded. While the clouds
// loop runs it keeps LOOP_STORE_MAX: the loop's 25 images of up to ANIMATION_MAX_TILES (8) tiles
// each, and the still view's tiles on show. Only the two images the loop fades between are on
// the graphics card at a time.
const STORE_MAX = 100;
const LOAD_TIMEOUT_MS = 20_000;
// How long the page is told a loop could not load, before it shows the time again, and how long a
// loop that is loading may go without a new image before it counts as failed.
const FAILED_NOTICE_MS = 6000;
const LOOP_STALL_MS = 30_000;
const LOOP_STORE_MAX = 230;

// The moving clouds of the Clouds view (see meteosat.js), in a layer of tiles of their own just
// above the map, which goes on showing yesterday's clouds beneath them and elsewhere. They show
// the image for the timeline's time, the newest one for times after it. A new image (or the
// tiles for a new view) takes the place of the one on show only once all its tiles in view have
// loaded, so the clouds never flash blank or half drawn; while the timeline plays, the next
// images load ahead. The clouds loop plays the last 12 hours like a weather radar, once nearly all
// its images have loaded, each fading into the next, with coarser tiles (see coarserView).
// `baseEngine()` is the map's own tile engine, whose tile level this follows.
// Returns { setActive(on), update(), setFollowing(on), setTime(time, ahead, playing), asOf(),
// shown(), startLoop({ manual }), stopLoop(), advanceLoop(), loopState() }.
function setupMovingClouds(globe, baseEngine, onChange) {
  // 0.0002 globe radii is about 1.3 km above the ground.
  const radius = globe.getGlobeRadius() * 1.0002;
  const group = new THREE.Group();
  group.visible = false;
  globe.scene().add(group);
  const loader = new THREE.ImageLoader();
  let active = false;
  let times = null;
  let timesTimer = null;
  let loadingTimes = false;
  // The timeline's time, while it plays the next times it will reach (ms), and whether it plays.
  let time = Date.now();
  let ahead = [];
  let playing = false;
  // The images asked for last time, and those the timeline has passed on its way to the wanted
  // one while they loaded (see passedFrames).
  let lastFrames = [];
  let passed = [];
  // The tiles in view: `full` for the timeline's images and `coarse` for the loop's many (see
  // coarserView), or null when zoomed in closer than the images have detail for.
  let views = null;
  // On show: the image's time, and a mesh per tile by "level/x/y", with the store's key for its
  // image as `userData.key`.
  let shownFrame = null;
  const meshes = new Map();
  const shownKeys = new Set();
  // The clouds loop while it runs: { frames, status ('loading' or 'playing'), progress (0 to 1),
  // playable (the frames it shows), ready (the tiles it shows), manual, index (the frame on show),
  // since (when that frame came), raf }.
  let loop = null;
  let loopFailed = false;

  const store = new TileStore({
    max: STORE_MAX,
    // A request that has not been answered after LOAD_TIMEOUT_MS counts as failed, so that a few
    // stalled ones cannot hold up all the others.
    // An image that arrives after that is let go: nothing would own its texture.
    load: (url) =>
      new Promise((resolve, reject) => {
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          // Stops the download.
          if (image) image.src = '';
          reject(new Error(`No answer for ${url}`));
        }, LOAD_TIMEOUT_MS);
        const image = loader.load(
          url,
          (loaded) => {
            clearTimeout(timeout);
            if (timedOut) return;
            const texture = new THREE.Texture(loaded);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.needsUpdate = true;
            // Sent to the graphics card as it arrives, rather than a dozen at once when the image
            // it belongs to goes on show. Not the loop's many images: each goes there when shown.
            if (!loop) globe.renderer?.()?.initTexture(texture);
            resolve(texture);
          },
          undefined,
          (err) => {
            clearTimeout(timeout);
            reject(err);
          },
        );
      }),
    inUse: (key) => shownKeys.has(key),
    dispose: (texture) => texture.dispose(),
    onSettle: () => refresh(),
  });

  function removeMesh(tile) {
    const mesh = meshes.get(tile);
    group.remove(mesh);
    shownKeys.delete(mesh.userData.key);
    // The images stay in the store; only their copies on the graphics card go.
    mesh.material.map?.dispose();
    mesh.material.userData.cross.map2.value?.dispose();
    mesh.material.dispose();
    mesh.geometry.dispose();
    meshes.delete(tile);
  }

  // The mesh for `tile` ("level/x/y"), made with `texture` if there is none yet.
  function meshFor(tile, texture) {
    let mesh = meshes.get(tile);
    if (!mesh) {
      const [level, x, y] = tile.split('/').map(Number);
      mesh = mercatorTile(x, y, level, radius, tileMaterial(texture));
      // Beneath the weather layers, which are drawn from -3 up.
      mesh.renderOrder = -4;
      mesh.raycast = () => {};
      meshes.set(tile, mesh);
      group.add(mesh);
    }
    return mesh;
  }

  // Shows images `a` and `b` (textures) on the mesh, `mix` of the way from one to the other, and
  // lets the graphics card forget those it showed before. `key` is the store's key for `a`.
  function paint(mesh, key, a, b = a, mix = 0) {
    const { cross } = mesh.material.userData;
    for (const old of [mesh.material.map, cross.map2.value]) if (old !== a && old !== b) old?.dispose();
    mesh.material.map = a;
    cross.map2.value = b;
    cross.crossMix.value = mix;
    shownKeys.delete(mesh.userData.key);
    mesh.userData.key = key;
    shownKeys.add(key);
  }

  function setShown(frame) {
    group.visible = meshes.size > 0;
    const next = meshes.size ? frame : null;
    if (next === shownFrame) return;
    shownFrame = next;
    onChange?.();
  }

  function setOpacity(opacity) {
    for (const mesh of meshes.values()) mesh.material.opacity = opacity;
  }

  // Zoomed in past the images' detail: they stay a moment while the map's finer tiles load, then
  // fade out, so the map's own clouds take over without a flash.
  let fading = null;
  function fadeOut() {
    if (fading) return;
    if (!meshes.size || !globalThis.requestAnimationFrame) {
      clear();
      return;
    }
    const start = performance.now() + HOLD_MS;
    const step = () => {
      const t = (performance.now() - start) / FADE_OUT_MS;
      if (t >= 1) {
        fading = null;
        clear();
        return;
      }
      setOpacity(1 - Math.max(0, t));
      fading = requestAnimationFrame(step);
    };
    fading = requestAnimationFrame(step);
  }

  function stopFading() {
    if (!fading) return;
    cancelAnimationFrame(fading);
    fading = null;
    setOpacity(1);
  }

  function clear() {
    stopFading();
    for (const tile of [...meshes.keys()]) removeMesh(tile);
    group.visible = false;
    // Images passed on the way to another time belong to that time only.
    lastFrames = [];
    passed = [];
    if (shownFrame !== null) {
      shownFrame = null;
      onChange?.();
    }
  }

  const tileKeys = ({ level, tiles }) => tiles.map(({ x, y }) => `${level}/${x}/${y}`);
  const jobsFor = (frames, { level, tiles }) =>
    frames.flatMap((frame) => tiles.map(({ x, y }) => ({ key: `${frame}/${level}/${x}/${y}`, url: tileUrl(x, y, level, frame) })));

  // Shows `frame` for the tiles of `view` once all of them have loaded, and says whether it did. A
  // tile that failed is asked for again after a pause; one that failed twice is left empty rather
  // than hold up the rest, and not filled with an image of another time. If none loaded, what is on
  // show stays.
  function swap(frame, view) {
    const tiles = tileKeys(view);
    if (!tiles.length) {
      clear();
      return true;
    }
    const entries = tiles.map((tile) => store.get(`${frame}/${tile}`));
    if (!entries.every((e) => e?.state === 'done' || e?.failures >= 2)) return false;
    if (!entries.some((e) => e.state === 'done') && meshes.size) return false;
    const keep = new Set(tiles.filter((_, i) => entries[i].state === 'done'));
    for (const tile of [...meshes.keys()]) if (!keep.has(tile)) removeMesh(tile);
    tiles.forEach((tile, i) => {
      const { state, value: texture } = entries[i];
      const key = `${frame}/${tile}`;
      if (state !== 'done') return;
      const mesh = meshFor(tile, texture);
      if (mesh.userData.key !== key || mesh.material.userData.cross.crossMix.value) paint(mesh, key, texture);
    });
    setShown(frame);
    return true;
  }

  // The loop's images `a` and `b` on its tiles, `mix` of the way from one to the other. Tiles that
  // came into view since it started join once all its images for them are there.
  function showLoop(a, b, mix) {
    const tiles = tileKeys(views.coarse).filter((tile) => loop.ready.has(tile));
    const keep = new Set(tiles);
    for (const tile of [...meshes.keys()]) if (!keep.has(tile)) removeMesh(tile);
    for (const tile of tiles) {
      const ta = store.get(`${a}/${tile}`).value;
      const tb = store.get(`${b}/${tile}`).value;
      paint(meshFor(tile, ta), `${a}/${tile}`, ta, tb, mix);
    }
    setShown(a);
  }

  function animateLoop() {
    if (!globalThis.requestAnimationFrame) return;
    const frame = (now) => {
      if (loop?.status !== 'playing') return;
      try {
        const step = loopStep({ index: loop.index, since: loop.since }, now, loop.playable.length);
        loop.index = step.index;
        loop.since = step.since;
        showLoop(loop.playable[step.index], loop.playable[step.next], step.mix);
      } finally {
        if (loop?.status === 'playing') loop.raf = requestAnimationFrame(frame);
      }
    };
    loop.raf = requestAnimationFrame(frame);
  }

  // Ends the loop. The store goes back to its usual bound once the refresh that follows has said
  // which tiles are wanted now (see TileStore.want).
  function stopLoop({ failed = false } = {}) {
    if (!loop) return;
    if (loop.raf) cancelAnimationFrame(loop.raf);
    clearTimeout(loop.stall);
    loop = null;
    setFailed(failed);
    store.max = STORE_MAX;
    store.evict();
    for (const mesh of meshes.values()) {
      const { cross } = mesh.material.userData;
      if (cross.map2.value !== mesh.material.map) cross.map2.value?.dispose();
      cross.map2.value = mesh.material.map;
      cross.crossMix.value = 0;
    }
    onChange?.();
  }

  // A loop that could not load says so for a while, then the time comes back.
  let failedTimer = null;
  function setFailed(failed) {
    clearTimeout(failedTimer);
    const changed = failed !== loopFailed;
    loopFailed = failed;
    if (failed) {
      failedTimer = setTimeout(() => setFailed(false), FAILED_NOTICE_MS);
    }
    if (changed && !loop) onChange?.();
  }

  // Loads the loop's images for the tiles in view, and starts it once nearly all have arrived.
  function refreshLoop() {
    const view = views.coarse;
    store.want(jobsFor(loop.frames, view));
    const tiles = tileKeys(view);
    if (loop.status === 'playing') {
      // Images that arrive while it plays join it, in their place in time, once they are there
      // for every tile it shows. When the view moves (the globe turns by itself, or follows an
      // aircraft) the loop plays on, and new tiles join it once they have all its images.
      const has = (frame, tile) => store.get(`${frame}/${tile}`)?.state === 'done';
      const shown = loop.playable[loop.index];
      loop.playable = loop.frames.filter((frame) => loop.playable.includes(frame) || [...loop.ready].every((tile) => has(frame, tile)));
      loop.index = Math.max(0, loop.playable.indexOf(shown));
      for (const tile of tiles) if (!loop.ready.has(tile) && loop.playable.every((frame) => has(frame, tile))) loop.ready.add(tile);
      loop.progress = loop.frames.reduce((n, frame) => n + tiles.filter((tile) => has(frame, tile)).length, 0) / (loop.frames.length * tiles.length || 1);
      return;
    }
    let done = 0;
    let settled = true;
    const playable = loop.frames.filter((frame) => {
      let complete = true;
      for (const tile of tiles) {
        const entry = store.get(`${frame}/${tile}`);
        if (entry?.state === 'done') done++;
        else {
          complete = false;
          if (!(entry?.failures >= 2)) settled = false;
        }
      }
      return complete;
    });
    const status = tiles.length ? loopStatus({ frames: loop.frames.length, complete: playable.length, settled }) : 'failed';
    if (status === 'failed') {
      stopLoop({ failed: true });
      refresh();
      return;
    }
    const progress = done / (loop.frames.length * tiles.length);
    const changed = Math.floor(progress * 20) !== Math.floor(loop.progress * 20);
    // When EUMETSAT stops answering, the store waits longer and longer between tries: the loop
    // gives up once nothing new has come for a while.
    if (progress > loop.progress || !loop.stall) {
      clearTimeout(loop.stall);
      const stalled = loop;
      loop.stall = setTimeout(() => {
        if (loop !== stalled || loop.status !== 'loading') return;
        stopLoop({ failed: true });
        refresh();
      }, LOOP_STALL_MS);
    }
    loop.progress = progress;
    loop.playable = playable;
    if (status === 'ready') {
      loop.status = 'playing';
      loop.ready = new Set(tiles);
      loop.since = performance.now();
      loop.index = 0;
      showLoop(playable[0], playable[0], 0);
      if (!loop.manual) animateLoop();
      onChange?.();
    } else if (changed) {
      onChange?.();
    }
  }

  function refresh() {
    if (!active) {
      stopLoop();
      store.clear();
      clear();
      return;
    }
    if (!times || !views) {
      store.want([]);
      if (!views) {
        stopLoop();
        fadeOut();
      }
      return;
    }
    stopFading();
    if (loop) {
      refreshLoop();
      return;
    }
    const view = views.full;
    const frames = framesFor(time, ahead, times);
    passed = passedFrames([...passed, ...lastFrames], frames[0], shownFrame);
    lastFrames = frames;
    store.want(jobsFor([...frames, ...passed], view));
    for (const frame of [frames[0], ...passed]) if (swap(frame, view)) break;
  }

  // Works out the tiles in view, one level coarser than the map's own (the images are twice as
  // many pixels across), or none when zoomed in closer than the images have detail for.
  function measure() {
    const level = baseEngine()?.level;
    const camera = globe.camera();
    if (level == null) {
      // The globe has not initialised yet.
      retry = setTimeout(() => settled.update(), 1000);
      views = null;
      return;
    }
    if (level > MAP_LEVEL_LIMIT || !camera?.position) {
      views = null;
      return;
    }
    // The camera always looks at the middle of the globe. Its position is up to date before its
    // direction is (the controls turn it on their next update), so the view is worked out from a
    // copy turned that way. A point is in view when it is on screen and on the side of the globe
    // facing the camera.
    const eye = camera.clone();
    eye.lookAt(0, 0, 0);
    eye.updateMatrixWorld();
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(eye.projectionMatrix, eye.matrixWorldInverse),
    );
    const r2 = radius * radius;
    const inView = (lat, lng) => {
      const point = pointAt(lat, lng, radius);
      return point.dot(eye.position) > r2 && frustum.containsPoint(point);
    };
    const tileLevel = Math.max(0, level - 1);
    views = { full: { level: tileLevel, tiles: tilesInView(tileLevel, inView) }, coarse: coarserView(tileLevel, inView) };
  }

  let retry = null;
  // The globe turns by itself when zoomed out, so the view may never settle: then the tiles in
  // view are worked out once a second.
  const settled = whenSettled(
    () => {
      clearTimeout(retry);
      measure();
      refresh();
    },
    { maxWait: 1000 },
  );

  async function loadTimes() {
    if (loadingTimes) return;
    loadingTimes = true;
    clearTimeout(timesTimer);
    let next = TIMES_REFRESH_MS;
    try {
      const response = await fetch(CAPABILITIES_URL);
      if (!response.ok) throw new Error(`EUMETSAT answered ${response.status}`);
      const parsed = parseTimes(await response.text());
      if (!parsed) throw new Error('No image times in the EUMETSAT capabilities');
      times = parsed;
      refresh();
      onChange?.();
    } catch (err) {
      console.warn('Moving clouds: could not read the image times', err);
      next = TIMES_RETRY_MS;
    }
    loadingTimes = false;
    if (active) timesTimer = setTimeout(loadTimes, next);
  }

  return {
    setActive(on) {
      if (on === active) return;
      active = on;
      setFailed(false);
      if (on) {
        loadTimes();
        settled.update();
      } else {
        clearTimeout(timesTimer);
        clearTimeout(retry);
        settled.cancel();
        views = null;
        stopLoop();
        store.clear();
        clear();
      }
    },
    update() {
      if (active) settled.update();
    },
    setFollowing: settled.setFollowing,
    // `next` and `nextAhead` in milliseconds; `nextPlaying` while the timeline plays.
    setTime(next, nextAhead = [], nextPlaying = false) {
      if (next === time && nextAhead.join() === ahead.join() && nextPlaying === playing) return;
      if (next !== time) setFailed(false);
      time = next;
      ahead = nextAhead;
      playing = nextPlaying;
      // The loop and the timeline do not play together.
      if (playing) stopLoop();
      if (active) refresh();
    },
    // The time of the image on show when the timeline is later than it (the newest image, or
    // while the next one loads), else null. Not while the loop runs, whose images are its own.
    asOf() {
      return active && !loop && shownFrame !== null && time > shownFrame ? shownFrame : null;
    },
    // The time of the image on show, or null when none is.
    shown: () => shownFrame,
    // Starts the clouds loop; `manual` steps it on with advanceLoop() instead of playing it.
    // Returns whether it could start (the clouds are shown, their times known and some in view).
    startLoop({ manual = false } = {}) {
      setFailed(false);
      if (!active || !times || !views?.coarse.tiles.length) return false;
      if (loop) stopLoop();
      loop = { frames: loopFrames(times), status: 'loading', progress: 0, playable: [], ready: new Set(), manual, index: 0, since: 0, raf: null };
      store.max = LOOP_STORE_MAX;
      refresh();
      onChange?.();
      return true;
    },
    stopLoop() {
      setFailed(false);
      if (!loop) return;
      stopLoop();
      refresh();
    },
    // One image on, for a loop started `manual`; after the newest it ends.
    advanceLoop() {
      if (loop?.status !== 'playing') return;
      loop.index++;
      if (loop.index >= loop.playable.length) {
        stopLoop();
        refresh();
        return;
      }
      showLoop(loop.playable[loop.index], loop.playable[loop.index], 0);
    },
    // The loop for the page to show: null when off, else { status: 'loading' | 'playing' |
    // 'failed', progress (0 to 1), frame (the image on show while playing), last (whether a manual
    // loop is on its newest image) }.
    loopState() {
      if (loopFailed) return { status: 'failed', progress: 0, frame: null, last: false };
      if (!loop) return null;
      return {
        status: loop.status,
        progress: loop.progress,
        frame: loop.status === 'playing' ? shownFrame : null,
        last: loop.manual && loop.index >= loop.playable.length - 1,
      };
    },
  };
}

// three-globe picks a tile level from the camera's altitude alone (level L from 8 / 2^L globe
// radii down), which up close is about two levels too coarse for a phone's screen. Account
// for how many device pixels the view spans, so close-up tiles come out about one texel per pixel.
// Returns whether the tile engine was found.
function matchTileDetailToScreen(globe, chart) {
  const engine = findTileEngine(globe, chart);
  if (!engine) return false;
  const pixels = window.innerHeight * window.devicePixelRatio;
  // Levels finer than the default that the screen can show: on a phone about 1.8, which comes
  // out a little under one texel per pixel at mid latitudes. Going all the way to one texel
  // per pixel looks barely sharper but downloads about twice as many tiles.
  const shift = Math.log2(Math.min(40, Math.max(8, 0.013 * pixels)) / 8);
  // Up close, blend to the full shift from level 5 to 8 (a full shift at every level would mean
  // thousands of tiles in mid-zoom views).
  const zoomed = (level) => (8 / 2 ** level) * 2 ** (shift * Math.min(1, Math.max(0, (level - 5) / 3)));
  // Looking at the whole globe, pick the level that gives the middle of the globe about 0.6 tile
  // pixels per screen pixel: level L covers the Earth's circumference with 256 × 2^L pixels, and
  // from `d` globe radii up the screen shows π·H / (d·tan 25°) pixels of it (50° field of view).
  // The default is two levels coarser on a large screen, which looks soft.
  const wholeGlobe = (level) => (Math.PI * pixels * 0.6) / (Math.tan((25 * Math.PI) / 180) * 256 * 2 ** level);
  for (const e of [engine, chart].filter(Boolean)) {
    e.thresholds = e.thresholds.map((_, level) => (level <= 4 ? Math.max(zoomed(level), wholeGlobe(level)) : zoomed(level)));
  }
  return true;
}

function labelElement(city) {
  const el = document.createElement('div');
  el.className = `city-label tier-${city.tier}`;
  el.textContent = city.name;
  return el;
}

// A pin for the place whose forecast is open, labelled with its name if it has one.
function markerElement(name) {
  const el = document.createElement('div');
  el.className = 'place-marker';
  if (name) {
    const label = document.createElement('span');
    label.textContent = name;
    el.append(label);
  }
  return el;
}

// A marker for an airport where wind puts the runways near or over the limits. The list in the
// wind check panel is the accessible way to the same airports, so markers are hidden from
// screen readers and keyboard focus.
function airportElement(airport, status, onClick) {
  const el = document.createElement('div');
  el.className = `airport-marker status-${status}`;
  el.setAttribute('aria-hidden', 'true');
  el.title = airport.name;
  const label = document.createElement('span');
  label.textContent = airport.iata || airport.ident;
  el.append(label);
  el.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick(airport);
  });
  return el;
}

// The code of an airport at the end of an aircraft's line. Hidden from screen readers: the aircraft's
// panel says the same.
function flightEndElement(end) {
  const el = document.createElement('div');
  el.className = `flight-end ${end.kind}`;
  el.setAttribute('aria-hidden', 'true');
  el.title = end.title ?? '';
  const label = document.createElement('span');
  label.textContent = end.text;
  el.append(label);
  return el;
}

// A label at a runway end ("27 ✓"), the wind at an airport with an arrow pointing downwind, or
// where an airfield is ("✈ AMS Schiphol", coloured by its wind status once known). The airport
// open in the panel has its label `selected` (see airportmap.js). Hidden from screen readers: the
// airport panel says the same.
function runwayLabelElement(label, onSelect) {
  const el = document.createElement('div');
  const selected = label.selected ? ' selected' : '';
  el.className =
    label.kind === 'wind'
      ? `wind-label${selected}`
      : label.kind === 'airport'
        ? `airport-label status-${label.status}${label.flag ? ' flagged' : ''}${selected}`
        : `runway-label status-${label.status}${label.use ? ' in-use' : ''}`;
  el.setAttribute('aria-hidden', 'true');
  el.title = label.title ?? '';
  const span = document.createElement('span');
  if (label.kind === 'airport') {
    const icon = document.createElement('i');
    icon.textContent = '✈';
    span.append(icon);
  }
  if (label.kind === 'wind' && label.direction != null) {
    const arrow = document.createElement('i');
    arrow.textContent = '↑';
    arrow.style.transform = `rotate(${label.direction + 180}deg)`;
    span.append(arrow);
  }
  span.append(label.text);
  // An airport the wind check flags: its status as on the wind check's markers.
  if (label.flag) {
    const badge = document.createElement('b');
    badge.textContent = STATUS[label.status].icon;
    span.append(badge);
  }
  el.append(span);
  if (label.airport) {
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      onSelect?.(label.airport);
    });
  }
  return el;
}

// Country borders and city names that appear as the view zooms in, airports with wind trouble
// and a pin for the selected place. Returns `update(altitude)` to call as the camera moves,
// `setMarker(place)` and `setAirports(problems, onClick)`.
export function setupMapFeatures(globe) {
  const elements = new Map(CITIES.map((city) => [city, labelElement(city)]));
  globe
    .htmlLat('lat')
    .htmlLng('lng')
    // On the ground (about 60 m up), so labels stay on the spot they name: higher up, they
    // would drift away from it as the view moves, a lot when zoomed in to an airport.
    .htmlAltitude(0.00001)
    .htmlTransitionDuration(0)
    .htmlElement((d) => d.el ?? elements.get(d))
    .pathPoints((line) => line)
    .pathPointLat((p) => p[1])
    .pathPointLng((p) => p[0])
    // Close to the ground so they line up with the imagery when zoomed right in. They are drawn
    // after the weather layers, which do not write depth, so they still show on top.
    .pathPointAlt(0.0004)
    .pathColor(() => 'rgba(255, 255, 255, 0.28)')
    .pathTransitionDuration(0);

  let tier = -1;
  let marker = null;
  let airports = [];
  // Airport markers by airport and status, reused while the status stays the same (the globe
  // keeps an object on screen as long as the same datum is passed in).
  let airportMarkers = new Map();
  let runwayLabels = [];
  // The airports at the ends of the selected aircraft's lines (see flightlines.js).
  let flightEnds = [];
  let borders = null;
  let bordersShown = false;

  function refreshLabels() {
    const cities = CITIES.filter((city) => city.tier <= tier && !(marker && city.name === marker.name));
    // An airport with a label of its own on the map (see airportmap.js) needs no marker.
    const labelled = new Set(runwayLabels.map((l) => l.ident).filter(Boolean));
    // An airport at the end of a flight line has that label instead of its own, so it has just one.
    const ends = new Set(flightEnds.map((e) => e.ident).filter(Boolean));
    const shown = airports.filter((a) => !labelled.has(a.ident) && !ends.has(a.ident) && !(marker && a.lat === marker.lat && a.lng === marker.lng));
    const named = runwayLabels.filter((l) => !(l.kind === 'airport' && ends.has(l.ident)));
    globe.htmlElementsData([...cities, ...named, ...shown, ...flightEnds, ...(marker ? [marker] : [])]);
  }

  async function loadBorders() {
    // Loaded on demand: the border data is only needed once someone zooms in.
    const [{ mesh }, world] = await Promise.all([
      import('topojson-client'),
      import('world-atlas/countries-50m.json').then((m) => m.default),
    ]);
    return mesh(world, world.objects.countries, (a, b) => a !== b).coordinates;
  }

  function setMarker(place) {
    marker = place ? { lat: place.lat, lng: place.lng, name: place.name, el: markerElement(place.name) } : null;
    refreshLabels();
  }

  // `problems`: [{ airport, status }], or [] to remove the markers.
  function setAirports(problems, onClick) {
    if (!problems.length && !airports.length) return;
    const next = new Map();
    airports = problems.map(({ airport, status }) => {
      const key = `${airport.ident}:${status}`;
      const datum = airportMarkers.get(key) ?? { lat: airport.lat, lng: airport.lng, ident: airport.ident, el: airportElement(airport, status, onClick) };
      next.set(key, datum);
      return datum;
    });
    airportMarkers = next;
    refreshLabels();
  }

  // Labels for runway ends and airport winds (see airportmap.js). Made afresh each time: they
  // only change when the view settles, the timeline steps or weather arrives, and fresh labels
  // can never be left at a previous layout's position.
  function setRunwayLabels(labels, onSelect) {
    if (!labels.length && !runwayLabels.length) return;
    runwayLabels = labels.map((label) => ({ lat: label.lat, lng: label.lng, ident: label.airport?.ident, kind: label.kind, el: runwayLabelElement(label, onSelect) }));
    refreshLabels();
  }

  // Labels for the airports a selected aircraft left from and is going to: [{ lat, lng, text,
  // title, ident, kind }] (`ident` is the airport's ICAO code, whose own label is then left out), or
  // [] to remove them.
  function setFlightEnds(ends) {
    if (!ends.length && !flightEnds.length) return;
    flightEnds = ends.map((end) => ({ lat: end.lat, lng: end.lng, ident: end.ident, el: flightEndElement(end) }));
    refreshLabels();
  }

  function update(altitude) {
    // Airport codes would pile up on top of each other on the whole globe; dots are enough there.
    document.body.classList.toggle('globe-far', altitude >= MAP_ALTITUDE);
    const nextTier = labelTier(altitude);
    if (nextTier !== tier) {
      tier = nextTier;
      refreshLabels();
    }
    const showBorders = altitude < MAP_ALTITUDE;
    if (showBorders === bordersShown) return;
    bordersShown = showBorders;
    if (!showBorders) {
      globe.pathsData([]);
      return;
    }
    borders ??= loadBorders().catch((err) => {
      console.error(err);
      borders = null;
      return [];
    });
    borders.then((lines) => {
      if (bordersShown) globe.pathsData(lines);
    });
  }

  return { update, setMarker, setAirports, setRunwayLabels, setFlightEnds };
}
