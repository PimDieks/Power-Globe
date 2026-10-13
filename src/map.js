import * as THREE from 'three';
import { CITIES, labelTier } from './cities.js';

// Esri World Imagery: satellite and aerial imagery down to sub-metre detail in many places,
// as Web Mercator map tiles.
const TILE_URL = (x, y, level) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${level}/${y}/${x}`;
const MAX_TILE_LEVEL = 17;
// Below this altitude the view reads as a map: brighter imagery, borders and city names.
const MAP_ALTITUDE = 1.3;

// Satellite imagery that sharpens as you zoom in, over a whole-Earth image just beneath it.
// The image shows wherever tiles are missing: the poles (beyond Web Mercator), while tiles
// load, or if the tile server cannot be reached.
export function setupBasemap(globe, backdropUrl) {
  globe.globeTileEngineUrl(TILE_URL).globeTileEngineMaxLevel(MAX_TILE_LEVEL);
  let tilesTuned = false;
  window.addEventListener('resize', () => {
    tilesTuned = matchTileDetailToScreen(globe);
  });

  const texture = new THREE.TextureLoader().load(backdropUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const backdrop = new THREE.Mesh(
    new THREE.SphereGeometry(globe.getGlobeRadius() * 0.995, 96, 64),
    new THREE.MeshLambertMaterial({ map: texture }),
  );
  // three-globe rotates its globe mesh this way so equirectangular textures line up.
  backdrop.rotation.y = -Math.PI / 2;
  backdrop.raycast = () => {};
  globe.scene().add(backdrop);

  // Dim the lights when looking at the whole globe, so the weather glows on top of it, and
  // brighten them when zoomed in to a map.
  const lights = globe.lights().map((light) => ({ light, intensity: light.intensity }));
  return (altitude) => {
    // The tile engine joins the scene only once the globe has initialised, so keep trying.
    tilesTuned ||= matchTileDetailToScreen(globe);
    const t = Math.min(1, Math.max(0, (altitude - 0.4) / (MAP_ALTITUDE + 0.6 - 0.4)));
    const brightness = 1 - 0.45 * t;
    for (const { light, intensity } of lights) light.intensity = intensity * brightness;
  };
}

// three-globe picks a tile level from the camera's altitude alone (level L from 8 / 2^L globe
// radii down), which up close is about two levels too coarse for a phone's screen. Account
// for how many device pixels the view spans, so close-up tiles come out about one texel per pixel.
// Returns whether the tile engine was found.
function matchTileDetailToScreen(globe) {
  let engine = null;
  globe.scene().traverse((obj) => {
    if (!engine && Array.isArray(obj.thresholds) && 'tileUrl' in obj) engine = obj;
  });
  if (!engine) return false;
  const pixels = window.innerHeight * window.devicePixelRatio;
  // Levels finer than the default that the screen can show: on a phone about 1.8, which comes
  // out a little under one texel per pixel at mid latitudes. Going all the way to one texel
  // per pixel looks barely sharper but downloads about twice as many tiles.
  const shift = Math.log2(Math.min(40, Math.max(8, 0.013 * pixels)) / 8);
  // Keep the default for distant views, where it already looks sharp and finer levels would
  // mean hundreds of extra tiles, and blend to the full shift from level 5 to 8.
  engine.thresholds = engine.thresholds.map(
    (_, level) => (8 / 2 ** level) * 2 ** (shift * Math.min(1, Math.max(0, (level - 5) / 3))),
  );
  return true;
}

function labelElement(city) {
  const el = document.createElement('div');
  el.className = `city-label tier-${city.tier}`;
  el.textContent = city.name;
  return el;
}

// Country borders and city names that appear as the view zooms in. Returns an update
// function to call with the camera altitude.
export function setupMapFeatures(globe) {
  const elements = new Map(CITIES.map((city) => [city, labelElement(city)]));
  globe
    .htmlLat('lat')
    .htmlLng('lng')
    .htmlAltitude(0.0006)
    .htmlTransitionDuration(0)
    .htmlElement((city) => elements.get(city))
    .pathPoints((line) => line)
    .pathPointLat((p) => p[1])
    .pathPointLng((p) => p[0])
    // Close to the ground so they line up with the imagery when zoomed right in. They are drawn
    // after the weather layers, which do not write depth, so they still show on top.
    .pathPointAlt(0.0004)
    .pathColor(() => 'rgba(255, 255, 255, 0.28)')
    .pathTransitionDuration(0);

  let tier = -1;
  let borders = null;
  let bordersShown = false;

  async function loadBorders() {
    // Loaded on demand: the border data is only needed once someone zooms in.
    const [{ mesh }, world] = await Promise.all([
      import('topojson-client'),
      import('world-atlas/countries-50m.json').then((m) => m.default),
    ]);
    return mesh(world, world.objects.countries, (a, b) => a !== b).coordinates;
  }

  return (altitude) => {
    const nextTier = labelTier(altitude);
    if (nextTier !== tier) {
      tier = nextTier;
      globe.htmlElementsData(CITIES.filter((city) => city.tier <= tier));
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
  };
}
