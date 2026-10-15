// The map behind the pilot view (see pilotview.js): MapLibre GL JS with Esri World Imagery and,
// optionally, relief from the Terrarium elevation tiles. This file is only ever loaded by a
// dynamic import, the first time the view is opened, together with MapLibre and its stylesheet.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre starts its worker from the file next to its own, which a bundle does not keep there.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { withTimeout } from './api.js';
import { pixelRatio } from './pacing.js';
import { cameraTarget, hazeBand, imageryTier } from './pilotview.js';

maplibregl.setWorkerUrl(workerUrl);

// The same imagery as the Satellite map (BASEMAPS.satellite in map.js), but with the levels the
// view needs. Close to the ground that is 18 and 19, which Esri has only in some places: elsewhere
// it answers with the same "Map data not yet available" picture (and over open sea at any level).
// That picture is recognised by its size and left out, which makes the map carry on with the
// coarser tile it has. The finest levels are a second layer over the first, shown only within a
// few metres of the ground (from the air they would cost three times the tiles), and from far up
// only levels up to 11 show, because the imagery changes source after that (see imageryTier).
const imageryUrl = (z, y, x) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const terrainUrl = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const NO_DATA_BYTES = 2521;
const NORMAL_MAX_ZOOM = 17;
const FAR_MAX_ZOOM = 11;
const FINE_MAX_ZOOM = 19;
const TERRAIN_MAX_ZOOM = 12;
const GROUND_COLOR = '#55603f';
const IMAGERY_LAYERS = ['imagery', 'imagery-far', 'imagery-fine'];

// A tile that cannot be had and is not worth asking for again: Esri's picture for no imagery, or
// a place the terrain has no tile for.
export class TileUnavailable extends Error {}

// A failed tile is asked for again after these pauses (ms), then given up on: MapLibre leaves a
// tile that failed as it is.
export const RETRY_PAUSES_MS = [400, 1500];
// This many tiles of one kind in a row failing for good means the service cannot be reached.
export const TROUBLE_AFTER = 6;

// The listener goes with the pause, so that the tile's signal does not gather one for every retry.
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// A map whose style has not loaded by then is given up on: MapLibre may never say either way
// (when the GPU context is lost as it starts), and the map and its context would stay.
export const STYLE_TIMEOUT_MS = 20_000;

const TROUBLE_TEXT = { imagery: 'Imagery unavailable', terrain: 'Terrain unavailable', 'imagery terrain': 'Imagery and terrain unavailable' };

// Tracks whether imagery and terrain tiles are coming. `onChange(text)` is told what to say about
// it ('' when all is well) whenever that changes.
export class TileHealth {
  constructor(onChange) {
    this.onChange = onChange;
    this.failed = { imagery: 0, terrain: 0 };
    this.text = '';
  }

  record(kind, ok) {
    this.failed[kind] = ok ? 0 : this.failed[kind] + 1;
    const text = TROUBLE_TEXT[Object.keys(this.failed).filter((k) => this.failed[k] >= TROUBLE_AFTER).join(' ')] ?? '';
    if (text === this.text) return;
    this.text = text;
    this.onChange?.(text);
  }
}

// The tile's data, asked for again when it fails. `kind`: 'imagery' or 'terrain', for `health`.
// `noDataBytes`: the size of a picture that says there is nothing here. Throws TileUnavailable for
// a tile that is not there, and the last error for one that cannot be had.
export async function fetchTile(url, { kind, health, signal, noDataBytes, fetchImpl = fetch, pause = sleep } = {}) {
  let last;
  for (let attempt = 0; attempt <= RETRY_PAUSES_MS.length; attempt++) {
    if (attempt) await pause(RETRY_PAUSES_MS[attempt - 1], signal);
    try {
      const response = await fetchImpl(url, { signal });
      // The service answered: there is just nothing there.
      if (response.status === 404 || response.status === 403) {
        health?.record(kind, true);
        throw new TileUnavailable(`No tile (${response.status})`);
      }
      if (!response.ok) throw new Error(`Tile ${response.status}`);
      const data = await response.arrayBuffer();
      health?.record(kind, true);
      if (noDataBytes && data.byteLength === noDataBytes) throw new TileUnavailable('No imagery here');
      return data;
    } catch (err) {
      if (err instanceof TileUnavailable || signal?.aborted) throw err;
      last = err;
    }
  }
  health?.record(kind, false);
  throw last;
}

// The tiles come through here (the protocol is global to MapLibre, `current` is the open view's).
let current = null;
maplibregl.addProtocol('pilotimagery', async ({ url }, abortController) => {
  const [z, y, x] = url.replace('pilotimagery://', '').split('/');
  return { data: await fetchTile(imageryUrl(z, y, x), { kind: 'imagery', health: current?.health, signal: abortController.signal, noDataBytes: NO_DATA_BYTES }) };
});
maplibregl.addProtocol('pilotterrain', async ({ url }, abortController) => {
  const [z, x, y] = url.replace('pilotterrain://', '').split('/');
  return { data: await fetchTile(terrainUrl(z, x, y), { kind: 'terrain', health: current?.health, signal: abortController.signal }) };
});

// Makes the map in a fresh element of its own inside `container`, so that a map that is being
// removed and one being made can never share one. `onLoaded()` is called once the first view has
// all its tiles, `onTrouble(text)` when tiles stop coming ('' when they come again).
export async function createPilotMap({ container, terrain, onLoaded, onTrouble }) {
  const host = document.createElement('div');
  host.className = 'pilot-map-host';
  container.appendChild(host);
  const mine = { health: new TileHealth(onTrouble) };
  current = mine;
  let map;
  try {
    map = new maplibregl.Map({
      container: host,
      interactive: false,
      attributionControl: false,
      maxPitch: 120,
      pitch: 80,
      zoom: 10,
      centerClampedToGround: false,
      // The globe's cap on the pixel ratio (see pacing.js): at a Retina screen's full ratio, the
      // view with terrain is nearly 6 million pixels a frame.
      pixelRatio: pixelRatio(),
      canvasContextAttributes: { antialias: true },
      fadeDuration: 0,
      style: {
        version: 8,
        sources: {
          imagery: { type: 'raster', tiles: ['pilotimagery://{z}/{y}/{x}'], tileSize: 256, maxzoom: NORMAL_MAX_ZOOM },
          'imagery-far': { type: 'raster', tiles: ['pilotimagery://{z}/{y}/{x}'], tileSize: 256, maxzoom: FAR_MAX_ZOOM },
          'imagery-fine': { type: 'raster', tiles: ['pilotimagery://{z}/{y}/{x}'], tileSize: 256, maxzoom: FINE_MAX_ZOOM },
          dem: { type: 'raster-dem', tiles: ['pilotterrain://{z}/{x}/{y}'], tileSize: 512, maxzoom: TERRAIN_MAX_ZOOM, encoding: 'terrarium' },
        },
        layers: [
          { id: 'ground', type: 'background', paint: { 'background-color': GROUND_COLOR } },
          { id: 'imagery-far', type: 'raster', source: 'imagery-far', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } },
          { id: 'imagery', type: 'raster', source: 'imagery', paint: { 'raster-fade-duration': 0 } },
          { id: 'imagery-fine', type: 'raster', source: 'imagery-fine', layout: { visibility: 'none' }, paint: { 'raster-fade-duration': 0 } },
        ],
      },
    });
    const haze = document.createElement('div');
    haze.className = 'pilot-haze';
    host.appendChild(haze);

    // The style, then the terrain and the level of detail, are in place before the first tile is
    // asked for, so nothing is loaded twice.
    let ready = false;
    // Set once the map is given up on, so that a style that loads after all touches nothing.
    let gaveUp = false;
    const styled = new Promise((resolve, reject) => {
      map.once('style.load', () => {
        if (gaveUp) return;
        map.setMaxPitch(120);
        if (terrain) map.setTerrain({ source: 'dem', exaggeration: 1 });
        ready = true;
        resolve();
      });
      // A tile that cannot be had is dealt with where it is asked for (see fetchTile). Anything
      // else is a failure to start the map, or later, worth a line in the console.
      map.on('error', (event) => {
        if (event.tile || event.sourceId) return;
        if (ready) console.error(event.error);
        else reject(event.error);
      });
    });
    await withTimeout(styled, STYLE_TIMEOUT_MS, 'The map did not start in time').catch((err) => {
      gaveUp = true;
      throw err;
    });

    // Said once, when the first view has all its tiles (not before the first have been asked for).
    let told = false;
    const started = performance.now();
    let tier = 'normal';
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
        for (const id of IMAGERY_LAYERS) map.setSourceTileLodParams(profile.lod[0], profile.lod[1], id);
      }
    };
    // What was set on the map is set again after the GPU context is lost and comes back.
    map.getCanvas().addEventListener('webglcontextrestored', () => {
      profileKey = null;
      lod = '';
      hazeFor = '';
    });
    const setTier = (next) => {
      tier = next;
      map.setLayoutProperty('imagery-far', 'visibility', next === 'far' ? 'visible' : 'none');
      map.setLayoutProperty('imagery', 'visibility', next === 'far' ? 'none' : 'visible');
      map.setLayoutProperty('imagery-fine', 'visibility', next === 'fine' ? 'visible' : 'none');
    };

    return {
      // The camera at the aircraft: `lat`, `lng`, `track` (degrees), `eyeM` and `groundM` (metres above
      // sea level) and the profile for this height (see viewProfile).
      place({ lat, lng, track, eyeM, groundM, profile }) {
        applyProfile(profile);
        const aglM = eyeM - groundM;
        const next = imageryTier(tier, aglM);
        if (next !== tier) setTier(next);
        if (!told && performance.now() - started > 800 && map.loaded() && map.areTilesLoaded()) {
          told = true;
          onLoaded?.();
        }
        const target = cameraTarget({ lat, lng, track, eyeM, groundM }, profile.lookDown);
        map.jumpTo(map.calculateCameraOptionsFromTo(new maplibregl.LngLat(lng, lat), eyeM, new maplibregl.LngLat(target.lng, target.lat), target.altM));
        const height = host.clientHeight;
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
      // Frees the GPU (the context and its textures go with the map) and the element.
      destroy() {
        if (current === mine) current = null;
        try {
          map.remove();
        } finally {
          host.remove();
        }
      },
    };
  } catch (err) {
    // The map could not be started: nothing of it is left.
    if (current === mine) current = null;
    try {
      map?.remove();
    } finally {
      host.remove();
    }
    throw err;
  }
}
