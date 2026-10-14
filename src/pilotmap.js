// The map behind the pilot view (see pilotview.js): MapLibre GL JS with Esri World Imagery and,
// optionally, relief from the Terrarium elevation tiles. This file is only ever loaded by a
// dynamic import, the first time the view is opened, together with MapLibre and its stylesheet.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre starts its worker from the file next to its own, which a bundle does not keep there.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { cameraTarget, hazeBand } from './pilotview.js';

maplibregl.setWorkerUrl(workerUrl);

// The same imagery as the Satellite map (BASEMAPS.satellite in map.js), down to level 17 like it.
// Close to the ground the view needs the finest levels, 18 and 19, which Esri has only in some
// places: elsewhere it answers with the same "Map data not yet available" picture (and over open
// sea at any level). That picture is recognised by its size and left out, which makes the map carry
// on with the coarser tile it has. The finest levels are a second layer over the first, shown only
// within a few metres of the ground: from the air they would cost three times the tiles.
const IMAGERY_URL = (z, y, x) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const NO_DATA_BYTES = 2521;
const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const IMAGERY_MAX_ZOOM = 17;
const FINE_MAX_ZOOM = 19;
// The finest imagery shows below the first of these heights above the ground (metres), and stays
// until above the second.
const FINE_BELOW_M = 15;
const FINE_ABOVE_M = 30;
const TERRAIN_MAX_ZOOM = 12;
const GROUND_COLOR = '#55603f';

// The imagery tiles come through here, so that they can be counted and checked. `requests` is the
// open view's own list (the protocol is global to MapLibre).
let requests = { imagery: [], terrain: [] };
maplibregl.addProtocol('pilotimagery', async ({ url }, abortController) => {
  const [z, y, x] = url.replace('pilotimagery://', '').split('/');
  requests.imagery.push(performance.now());
  const response = await fetch(IMAGERY_URL(z, y, x), { signal: abortController.signal });
  if (!response.ok) throw new Error(`Imagery ${response.status}`);
  const data = await response.arrayBuffer();
  if (data.byteLength === NO_DATA_BYTES) throw new Error('No imagery here');
  return { data };
});

export async function createPilotMap({ container, terrain, onLoaded }) {
  requests = { imagery: [], terrain: [] };
  const map = new maplibregl.Map({
    container,
    interactive: false,
    attributionControl: false,
    maxPitch: 120,
    pitch: 80,
    zoom: 10,
    centerClampedToGround: false,
    canvasContextAttributes: { antialias: true },
    fadeDuration: 0,
    // Terrain tiles are counted here, imagery tiles in the protocol above.
    transformRequest: (url) => {
      if (url.includes('elevation-tiles-prod')) requests.terrain.push(performance.now());
      return { url };
    },
    style: {
      version: 8,
      sources: {
        imagery: { type: 'raster', tiles: ['pilotimagery://{z}/{y}/{x}'], tileSize: 256, maxzoom: IMAGERY_MAX_ZOOM },
        'imagery-fine': { type: 'raster', tiles: ['pilotimagery://{z}/{y}/{x}'], tileSize: 256, maxzoom: FINE_MAX_ZOOM },
        dem: { type: 'raster-dem', tiles: [TERRAIN_URL], tileSize: 512, maxzoom: TERRAIN_MAX_ZOOM, encoding: 'terrarium' },
      },
      layers: [
        { id: 'ground', type: 'background', paint: { 'background-color': GROUND_COLOR } },
        { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 0 } },
        { id: 'imagery-fine', type: 'raster', source: 'imagery-fine', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } },
      ],
    },
  });

  const haze = document.createElement('div');
  haze.className = 'pilot-haze';
  container.appendChild(haze);

  // The style, then the terrain and the level of detail, are in place before the first tile is
  // asked for, so nothing is loaded twice.
  const loaded = new Promise((resolve, reject) => {
    map.once('style.load', () => {
      map.setMaxPitch(120);
      if (terrain) map.setTerrain({ source: 'dem', exaggeration: 1 });
      resolve();
    });
    // Tiles that cannot be had (see NO_DATA_BYTES) are errors too, and are left alone.
    map.on('error', (event) => reject(event.error));
  });
  await loaded;

  // Said once, when the first view has all its tiles (not before the first have been asked for).
  let told = false;
  const started = performance.now();
  let fineOn = false;
  let profileKey = null;
  let lod = '';
  let hazeFor = '';
  const applyProfile = (profile) => {
    if (profile.key !== profileKey) {
      profileKey = profile.key;
      map.setVerticalFieldOfView(profile.vfov);
      map.setSky(profile.sky);
    }
    if (profile.lod.join() !== lod) {
      lod = profile.lod.join();
      for (const id of ['imagery', 'imagery-fine']) map.setSourceTileLodParams(profile.lod[0], profile.lod[1], id);
    }
  };

  return {
    // The camera at the aircraft: `lat`, `lng`, `track` (degrees), `eyeM` and `groundM` (metres above
    // sea level) and the profile for this height (see viewProfile).
    place({ lat, lng, track, eyeM, groundM, profile }) {
      applyProfile(profile);
      const fine = fineOn ? eyeM - groundM < FINE_ABOVE_M : eyeM - groundM < FINE_BELOW_M;
      if (fine !== fineOn) {
        fineOn = fine;
        map.setLayoutProperty('imagery-fine', 'visibility', fine ? 'visible' : 'none');
      }
      if (!told && performance.now() - started > 800 && map.loaded() && map.areTilesLoaded()) {
        told = true;
        onLoaded?.();
      }
      const target = cameraTarget({ lat, lng, track, eyeM, groundM }, profile.lookDown);
      map.jumpTo(map.calculateCameraOptionsFromTo(new maplibregl.LngLat(lng, lat), eyeM, new maplibregl.LngLat(target.lng, target.lat), target.altM));
      const height = container.clientHeight;
      const aglM = eyeM - groundM;
      const key = `${Math.round(aglM / 20)}|${height}|${profile.key}`;
      if (key === hazeFor) return;
      hazeFor = key;
      const band = hazeBand({ height, aglM, lookDown: profile.lookDown, vfov: profile.vfov, visKm: profile.visKm, color: profile.sky['horizon-color'] });
      haze.style.display = band ? 'block' : 'none';
      if (band) {
        haze.style.top = `${band.top}px`;
        haze.style.height = `${band.height}px`;
        haze.style.background = band.background;
      }
    },
    setTerrain(on) {
      map.setTerrain(on ? { source: 'dem', exaggeration: 1 } : null);
    },
    // Ground height (metres above sea level) under a position, or null when the elevation tiles
    // are not there yet or the terrain is off.
    groundElevation(lat, lng) {
      return map.getTerrain() ? map.queryTerrainElevation(new maplibregl.LngLat(lng, lat)) : null;
    },
    // Tiles asked for so far, by kind, as the times (ms) they were asked at.
    requests,
    map,
    // Frees the GPU: the context and its textures go with the map.
    destroy() {
      map.remove();
      haze.remove();
    },
  };
}
