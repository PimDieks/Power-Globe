// Airports on the map when zoomed in: runways coloured by whether they can be used in the
// forecast wind at the timeline's time, and closer in, a label at each runway end and the wind.
import { airportWeather, conditionsAt, loadAirports } from './airports.js';
import { STATUS, assessAirport, formatWind } from './runways.js';
import { viewBounds } from './detail.js';
import { destination, localFrame, placeLabels, runwayEnds, runwayStatus, setupRunways } from './runwaymap.js';

// Runways show below this camera altitude (globe radii); a 3 km runway is then over 10 px long.
export const RUNWAY_ALTITUDE = 0.035;
// Runway end and wind labels show below this one.
const LABEL_ALTITUDE = 0.009;
const MAX_AIRPORTS = 60;
// Airports whose weather is looked up at a time, nearest to the middle of the view first.
const MAX_WEATHER = 25;
const SETTLE_MS = 350;

const DEG = Math.PI / 180;
const wrapLng = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// Metres covered by one screen pixel at camera `altitude` (globe radii), looking straight down
// with the camera's 50° field of view.
export const metresPerPixel = (altitude, height) => (2 * altitude * 6_371_000 * Math.tan(25 * DEG)) / height;

// How far an airport's runway ends reach from its reference point, in metres.
function airportRadius(airport) {
  let max = 0;
  for (const runway of airport.runways) {
    for (const end of runwayEnds(airport, runway)) {
      const dy = (end.lat - airport.lat) * 111_320;
      const dx = (end.lng - airport.lng) * 111_320 * Math.cos(airport.lat * DEG);
      max = Math.max(max, Math.hypot(dx, dy));
    }
  }
  return max;
}

export function airportsInView(airports, pov, aspect) {
  const b = viewBounds(pov, aspect);
  const inView = airports.filter(
    (a) => a.runways.length && a.lat >= b.south && a.lat <= b.north && wrapLng(a.lng - b.west) <= b.span && wrapLng(a.lng - b.west) >= 0,
  );
  const d2 = (a) => (a.lat - pov.lat) ** 2 + (wrapLng(a.lng - pov.lng) * Math.cos(pov.lat * DEG)) ** 2;
  return inView.sort((a, b2) => d2(a) - d2(b2)).slice(0, MAX_AIRPORTS);
}

export function setupAirportMap({ globe, mapFeatures, getTime, getLimits, onSelect }) {
  const runways = setupRunways(globe);
  const weather = new Map();
  let airports = null;
  let shown = [];
  let pov = null;
  let timer = null;
  let request = 0;

  function aspect() {
    return window.innerWidth / window.innerHeight;
  }

  // Call as the camera moves.
  function view(next) {
    pov = next;
    clearTimeout(timer);
    if (next.altitude >= RUNWAY_ALTITUDE) {
      if (shown.length) clear();
      return;
    }
    timer = setTimeout(update, SETTLE_MS);
  }

  function clear() {
    shown = [];
    runways.draw([], 1);
    mapFeatures.setRunwayLabels([]);
  }

  async function update() {
    if (!pov || pov.altitude >= RUNWAY_ALTITUDE) return;
    airports ??= await loadAirports().catch(() => null);
    if (!airports) return;
    shown = airportsInView(airports, pov, aspect());
    render();
    // Weather for the nearest airports not looked up yet: the site's own data where it has
    // them, else Open-Meteo.
    const missing = shown.filter((a) => !weather.has(a.ident)).slice(0, MAX_WEATHER);
    if (!missing.length) return;
    const id = ++request;
    try {
      await airportWeather(missing, {
        onData: (data) => {
          for (const [ident, hourly] of data) weather.set(ident, hourly);
          if (id === request) render();
        },
      });
    } catch (err) {
      console.error('Could not load weather for runways', err);
    }
  }

  // Colour every runway in view and place the labels, for the timeline's time.
  function render() {
    if (!pov || pov.altitude >= RUNWAY_ALTITUDE) return;
    const time = getTime();
    const limits = getLimits();
    const mpp = metresPerPixel(pov.altitude, window.innerHeight);
    const showLabels = pov.altitude < LABEL_ALTITUDE;
    const frame = localFrame(pov);
    const strips = [];
    const segments = [];
    const wanted = [];
    for (const airport of shown) {
      const conditions = conditionsAt(weather.get(airport.ident), time);
      const endStatus = new Map();
      if (conditions) for (const end of assessAirport(airport, conditions, limits).ends) endStatus.set(end.ident, end.status);
      for (const runway of airport.runways) {
        const ends = runwayEnds(airport, runway);
        strips.push({ ends, widthFt: runway.widthFt, status: runwayStatus(runway, endStatus) });
        if (!showLabels) continue;
        const [a, b] = ends.map(frame.toXY);
        // As drawn: at least 5 px wide, plus its outline.
        segments.push({ a, b, r: Math.max(runway.widthFt * 0.3048, 5 * mpp) / 2 + 1.5 * mpp });
        const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const along = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
        // Each end's label goes beyond its threshold, on the extended centreline if that is free.
        [runway.le, runway.he].forEach((ident, k) => {
          if (!ident) return;
          const status = endStatus.get(ident) ?? 'unknown';
          const text = `${ident} ${STATUS[status].icon}`;
          wanted.push({
            label: { key: `${airport.ident}:${ident}:${status}`, kind: 'runway', status, text, title: `Runway ${ident}: ${STATUS[status].label}` },
            anchor: k ? b : a,
            direction: k ? along : { x: -along.x, y: -along.y },
            // Estimated size of the label on screen (12 px bold text, padding and border).
            w: (8.2 * text.length + 18) * mpp,
            h: 22 * mpp,
          });
        });
      }
      if (showLabels && conditions) {
        const text = `${airport.iata || airport.ident} · ${formatWind(conditions)}`;
        wanted.push({
          label: {
            key: `${airport.ident}:wind:${Math.round(conditions.direction)}:${Math.round(conditions.speed)}:${Math.round(conditions.gust ?? 0)}`,
            kind: 'wind',
            airport,
            text,
            direction: conditions.direction,
            title: `${airport.name}: open the runway check`,
          },
          // North of the airport, clear of its runways.
          anchor: frame.toXY(destination(airport, 0, airportRadius(airport))),
          direction: { x: 0, y: 1 },
          w: (7.6 * text.length + 34) * mpp,
          h: 24 * mpp,
        });
      }
    }
    runways.draw(strips, mpp);
    // Runway ends first, so they get the spots nearest their runways; then the winds.
    wanted.sort((p, q) => (p.label.kind === 'wind') - (q.label.kind === 'wind'));
    const centres = placeLabels(wanted, segments, mpp, { gap: 4 });
    const labels = wanted.map((w, i) => ({ ...w.label, ...frame.toLatLng(centres[i]) }));
    mapFeatures.setRunwayLabels(labels, onSelect);
  }

  return { view, refresh: render };
}
