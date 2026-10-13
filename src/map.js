import * as THREE from 'three';
import { CITIES, labelTier } from './cities.js';

// Black Marble is used up to this tile level (about 600 m per pixel).
const NIGHT_LIGHTS_MAX_LEVEL = 7;

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
  // City lights seen from space at night (NASA Black Marble, public domain, via NASA GIBS). Its
  // pixels are about 500 m across, so closer in, where it would only blur, the view continues
  // as Esri's dark grey map (sharp down to street level, no key needed).
  night: {
    label: 'Night lights',
    url: (x, y, level) =>
      level <= NIGHT_LIGHTS_MAX_LEVEL
        ? `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/${level}/${y}/${x}.png`
        : esri('Canvas/World_Dark_Gray_Base')(x, y, level),
    maxLevel: 16,
    light: 1.6,
    dark: true,
    credit:
      'Night lights <a href="https://earthobservatory.nasa.gov/features/NightLights" target="_blank" rel="noopener">NASA Black Marble</a> via GIBS; close up <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a>, HERE, Garmin, OpenStreetMap contributors and the GIS User Community',
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
  let tilesTuned = false;
  window.addEventListener('resize', () => {
    tilesTuned = matchTileDetailToScreen(globe);
  });

  const texture = new THREE.TextureLoader().load(backdropUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const dayMaterial = new THREE.MeshLambertMaterial({ map: texture });
  // Behind the night lights, where tiles are missing, the Earth is simply dark.
  const nightMaterial = new THREE.MeshBasicMaterial({ color: 0x04060c });
  const backdrop = new THREE.Mesh(
    new THREE.SphereGeometry(globe.getGlobeRadius() * 0.995, 96, 64),
    style.dark ? nightMaterial : dayMaterial,
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
    tilesTuned ||= matchTileDetailToScreen(globe);
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
    backdrop.material = style.dark ? nightMaterial : dayMaterial;
    setAltitude(altitude);
    onCredit?.(style.credit);
  }

  onCredit?.(style.credit);
  return { setAltitude, setStyle };
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
  // Up close, blend to the full shift from level 5 to 8 (a full shift at every level would mean
  // thousands of tiles in mid-zoom views).
  const zoomed = (level) => (8 / 2 ** level) * 2 ** (shift * Math.min(1, Math.max(0, (level - 5) / 3)));
  // Looking at the whole globe, pick the level that gives the middle of the globe about 0.6 tile
  // pixels per screen pixel: level L covers the Earth's circumference with 256 × 2^L pixels, and
  // from `d` globe radii up the screen shows π·H / (d·tan 25°) pixels of it (50° field of view).
  // The default is two levels coarser on a large screen, which looks soft.
  const wholeGlobe = (level) => (Math.PI * pixels * 0.6) / (Math.tan((25 * Math.PI) / 180) * 256 * 2 ** level);
  engine.thresholds = engine.thresholds.map((_, level) => (level <= 4 ? Math.max(zoomed(level), wholeGlobe(level)) : zoomed(level)));
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
// where an airfield is ("✈ AMS Schiphol", coloured by its wind status once known).
// Hidden from screen readers: the airport panel says the same.
function runwayLabelElement(label, onSelect) {
  const el = document.createElement('div');
  el.className =
    label.kind === 'wind' ? 'wind-label' : label.kind === 'airport' ? `airport-label status-${label.status}` : `runway-label status-${label.status}`;
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
    const shown = marker ? airports.filter((a) => a.lat !== marker.lat || a.lng !== marker.lng) : airports;
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
      const datum = airportMarkers.get(key) ?? { lat: airport.lat, lng: airport.lng, el: airportElement(airport, status, onClick) };
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
    runwayLabels = labels.map((label) => ({ lat: label.lat, lng: label.lng, el: runwayLabelElement(label, onSelect) }));
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
