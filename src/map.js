import * as THREE from 'three';
import SlippyMap from 'three-slippy-map-globe';
import { PROXY_URL } from './api.js';
import { CITIES, labelTier } from './cities.js';
import { STATUS } from './runways.js';
import { retryingTextureLoad, withLoad } from './tileretry.js';

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
  // Yesterday's clouds as seen from space: one day of NASA's VIIRS true colour imagery (NOAA-20,
  // public domain, via NASA GIBS), the most recent complete day. Its pixels are about 300 m
  // across, so closer in the view continues as the satellite imagery.
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
};
// Below this altitude the view reads as a map: brighter imagery, borders and city names.
const MAP_ALTITUDE = 1.3;

// Satellite imagery that sharpens as you zoom in, over a whole-Earth image just beneath it.
// The image shows wherever tiles are missing: the poles (beyond Web Mercator), while tiles
// load, or if the tile server cannot be reached.
// Returns { setAltitude(altitude), setStyle(key) }.
export function setupBasemap(globe, backdropUrl, { initial = 'satellite', onCredit } = {}) {
  let style = BASEMAPS[initial] ?? BASEMAPS.satellite;
  globe.globeTileEngineUrl(style.url).globeTileEngineMaxLevel(style.maxLevel);
  // A second, transparent layer of tiles just above the map, for a chart drawn over it.
  const chart = setupChartLayer(globe);
  let tilesTuned = false;
  window.addEventListener('resize', () => {
    tilesTuned = matchTileDetailToScreen(globe, chart.engine);
  });
  let engineHooked = false;

  const texture = new THREE.TextureLoader().load(backdropUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const dayMaterial = new THREE.MeshLambertMaterial({ map: texture });
  const backdrop = new THREE.Mesh(
    new THREE.SphereGeometry(globe.getGlobeRadius() * 0.995, 96, 64),
    dayMaterial,
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
    // The tile engine joins the scene only once the globe has initialised, so keep trying.
    tilesTuned ||= matchTileDetailToScreen(globe, chart.engine);
    if (!engineHooked) {
      const engine = findTileEngine(globe, chart.engine);
      if (engine) {
        engineHooked = true;
        seeThroughNoData(engine, () => style.noDataBlack);
        // Tiles loaded before the hook was in place.
        if (style.noDataBlack) globe.globeTileEngineClearCache();
      }
    }
    chart.update();
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
    chart.set(style.chart);
    setAltitude(altitude);
    onCredit?.(style.credit);
  }

  chart.set(style.chart);
  onCredit?.(style.credit);
  return { setAltitude, setStyle };
}

// three-globe's tile engine, once the globe has initialised (else null).
function findTileEngine(globe, exclude) {
  let engine = null;
  globe.scene().traverse((obj) => {
    if (!engine && obj !== exclude && Array.isArray(obj.thresholds) && 'tileUrl' in obj) engine = obj;
  });
  return engine;
}

// Pixels this dark (linear colour, about 5/255 before decoding) are taken as no data. Real
// imagery is never this dark in all three channels by day, not even deep ocean.
const NO_DATA_LEVEL = 0.0015;

// While `active()`, new tiles leave out pure black pixels, so the whole-Earth image beneath
// shows through gaps in the imagery.
function seeThroughNoData(engine, active) {
  const add = engine.add.bind(engine);
  engine.add = (...tiles) => {
    if (active()) {
      for (const tile of tiles) {
        if (!tile.material?.map) continue;
        tile.material.onBeforeCompile = (shader) => {
          shader.fragmentShader = shader.fragmentShader.replace(
            '#include <map_fragment>',
            `#include <map_fragment>
            if (max(max(diffuseColor.r, diffuseColor.g), diffuseColor.b) < ${NO_DATA_LEVEL}) discard;`,
          );
        };
        tile.material.customProgramCacheKey = () => 'see-through-no-data';
        tile.material.needsUpdate = true;
      }
    }
    return add(...tiles);
  };
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
  const tileLevel = (tile) => Math.round(Math.log2((2 * Math.PI) / tile.geometry.parameters.phiLength));
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
  let settle = null;
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
    // Tiles are asked for once the view settles, not for every level passed on the way while
    // zooming: far fewer requests to the chart's service.
    update() {
      if (!engine.visible) return;
      clearTimeout(settle);
      settle = setTimeout(() => {
        withRetries(() => engine.updatePov(globe.camera()));
        showLevel();
      }, 250);
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
        : `runway-label status-${label.status}`;
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
  let borders = null;
  let bordersShown = false;

  function refreshLabels() {
    const cities = CITIES.filter((city) => city.tier <= tier && !(marker && city.name === marker.name));
    // An airport with a label of its own on the map (see airportmap.js) needs no marker.
    const labelled = new Set(runwayLabels.map((l) => l.ident).filter(Boolean));
    const shown = airports.filter((a) => !labelled.has(a.ident) && !(marker && a.lat === marker.lat && a.lng === marker.lng));
    globe.htmlElementsData([...cities, ...runwayLabels, ...shown, ...(marker ? [marker] : [])]);
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
    runwayLabels = labels.map((label) => ({ lat: label.lat, lng: label.lng, ident: label.airport?.ident, el: runwayLabelElement(label, onSelect) }));
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

  return { update, setMarker, setAirports, setRunwayLabels };
}
