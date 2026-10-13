// Airports on the map when zoomed in: runways coloured by whether they can be used in the
// forecast wind at the timeline's time, and closer in, a label at each runway end and the wind.
import { airportWeather, conditionsAt, loadAirports } from './airports.js';
import { STATUS, assessAirport, formatWind } from './runways.js';
import { viewBounds } from './detail.js';
import { CITIES, labelTier } from './cities.js';
import { destination, localFrame, placeLabels, runwayEnds, runwayStatus, setupRunways } from './runwaymap.js';

// Altitude to fly to an airport at: low enough to make out its runways.
export const AIRPORT_ALTITUDE = 0.004;

// The altitude to fly to an airport at when the camera is at `current`: the usual one, but never
// back out from a closer view.
export const airportFlightAltitude = (current) => Math.min(AIRPORT_ALTITUDE, current);

// Runways show below this camera altitude (globe radii); a 3 km runway is then over 10 px long.
export const RUNWAY_ALTITUDE = 0.035;
// Runway end and wind labels show below this one.
const LABEL_ALTITUDE = 0.009;
const MAX_AIRPORTS = 60;
// Airports whose weather is looked up at a time, nearest to the middle of the view first.
const MAX_WEATHER = 25;
const SETTLE_MS = 350;
// After the weather could not be had for an airport, no new lookup for it for this long, so that
// every view change does not send the same failing request again. It is asked again by itself
// when this is over.
export const WEATHER_RETRY_MS = 30_000;

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

// Airport labels show below this camera altitude: the view is then a map of a region.
export const AIRPORT_LABEL_ALTITUDE = 0.6;
const MAX_AIRPORT_LABELS = 80;

// Which airports get a label at a zoom: the big ones first, smaller ones as the view closes in.
export function airportLabelTier(airport, altitude) {
  if (altitude < 0.08) return true;
  if (altitude < 0.25) return airport.large || (airport.scheduled && airport.routes > 0);
  return airport.large && airport.scheduled;
}

const inBounds = (a, b) => a.lat >= b.south && a.lat <= b.north && wrapLng(a.lng - b.west) >= 0 && wrapLng(a.lng - b.west) <= b.span;

// Airports to label in view, most important first (large, then best connected).
export function airportsToLabel(airports, pov, aspect) {
  const b = viewBounds(pov, aspect);
  return airports
    .filter((a) => inBounds(a, b) && airportLabelTier(a, pov.altitude))
    .sort((a, c) => Number(c.large) - Number(a.large) || c.routes - a.routes || Number(c.scheduled) - Number(a.scheduled))
    .slice(0, MAX_AIRPORT_LABELS * 3);
}

// `getProblems()`: the wind check's airports with wind trouble, [{ airport, status }]; zoomed
// in, their airfield labels take the place of the wind check's markers.
export function setupAirportMap({ globe, mapFeatures, getTime, getLimits, getProblems = () => [], onSelect }) {
  const runways = setupRunways(globe);
  const weather = new Map();
  let airports = null;
  let shown = [];
  let labelled = [];
  let pov = null;
  let timer = null;
  let active = false;
  // Airports whose weather is being looked up, and those it could not be had for, until when.
  const looking = new Set();
  const retryAt = new Map();

  function aspect() {
    return window.innerWidth / window.innerHeight;
  }

  // Call as the camera moves.
  function view(next) {
    pov = next;
    clearTimeout(timer);
    timer = null;
    if (next.altitude >= AIRPORT_LABEL_ALTITUDE) {
      if (active) clear();
      return;
    }
    timer = setTimeout(update, SETTLE_MS);
  }

  // Updates again by itself when the first airport in view that is waiting to be asked again may
  // be, unless an update is already coming (the camera moving schedules its own).
  function retryWhenDue() {
    if (timer) return;
    const now = Date.now();
    const due = shown.filter((a) => !weather.has(a.ident) && retryAt.get(a.ident) > now).map((a) => retryAt.get(a.ident));
    if (due.length) timer = setTimeout(update, Math.min(...due) - now);
  }

  function clear() {
    active = false;
    shown = [];
    labelled = [];
    runways.draw([], 1);
    mapFeatures.setRunwayLabels([]);
  }

  async function update() {
    timer = null;
    if (!pov || pov.altitude >= AIRPORT_LABEL_ALTITUDE) return;
    airports ??= await loadAirports().catch(() => null);
    if (!airports) return;
    active = true;
    labelled = airportsToLabel(airports, pov, aspect());
    shown = pov.altitude < RUNWAY_ALTITUDE ? airportsInView(airports, pov, aspect()) : [];
    render();
    // Weather for the nearest airports with runways shown and not looked up yet (and not being
    // looked up, or waiting to be asked again): the site's own data where it has them, else
    // Open-Meteo.
    const now = Date.now();
    const missing = shown
      .filter((a) => !weather.has(a.ident) && !looking.has(a.ident) && !(retryAt.get(a.ident) > now))
      .slice(0, MAX_WEATHER);
    retryWhenDue();
    if (!missing.length) return;
    for (const a of missing) looking.add(a.ident);
    try {
      await airportWeather(missing, {
        onData: (data) => {
          for (const [ident, hourly] of data) weather.set(ident, hourly);
          render();
        },
      });
    } catch (err) {
      for (const a of missing) if (!weather.has(a.ident)) retryAt.set(a.ident, Date.now() + WEATHER_RETRY_MS);
      retryWhenDue();
      console.error('Could not load weather for runways', err);
    } finally {
      for (const a of missing) looking.delete(a.ident);
    }
  }

  // Airport status at the timeline's time: per runway end, and the airport's best.
  function statusOf(airport, time, limits) {
    const conditions = conditionsAt(weather.get(airport.ident), time);
    if (!conditions) return { conditions: null, endStatus: new Map(), status: 'unknown' };
    const result = assessAirport(airport, conditions, limits);
    return { conditions, endStatus: new Map(result.ends.map((e) => [e.ident, e.status])), status: result.status };
  }

  // Draw the runways in view and place every label, for the timeline's time.
  function render() {
    if (!active || !pov) return;
    const time = getTime();
    const limits = getLimits();
    const mpp = metresPerPixel(pov.altitude, window.innerHeight);
    const showEnds = pov.altitude < LABEL_ALTITUDE;
    const frame = localFrame(pov);
    const strips = [];
    const segments = [];
    const wanted = [];
    const withWind = new Set();
    for (const airport of shown) {
      const { conditions, endStatus } = statusOf(airport, time, limits);
      for (const runway of airport.runways) {
        const ends = runwayEnds(airport, runway);
        strips.push({ ends, widthFt: runway.widthFt, status: runwayStatus(runway, endStatus) });
        const [a, b] = ends.map(frame.toXY);
        // As drawn: at least 5 px wide, plus its outline.
        segments.push({ a, b, r: Math.max(runway.widthFt * 0.3048, 5 * mpp) / 2 + 1.5 * mpp });
        if (!showEnds) continue;
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
      if (showEnds && conditions) {
        withWind.add(airport.ident);
        const text = `${airport.iata || airport.ident} · ${formatWind(conditions)}`;
        wanted.push({
          label: {
            key: `${airport.ident}:wind`,
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
    // Where each airfield is: its code (and closer in, its name), on the airport when that is
    // free, else just above; left out where a more important airport's label already is.
    // Airports the wind check flags come first, always labelled, in their status colour.
    const named = pov.altitude < 0.15;
    const bounds = viewBounds(pov, aspect());
    const flagged = new Map(getProblems().filter((p) => inBounds(p.airport, bounds)).map((p) => [p.airport.ident, p.status]));
    const candidates = [...getProblems().map((p) => p.airport).filter((a) => flagged.has(a.ident)), ...labelled.filter((a) => !flagged.has(a.ident))];
    for (const airport of candidates) {
      if (withWind.has(airport.ident)) continue;
      const flag = flagged.get(airport.ident);
      const status = flag ?? statusOf(airport, time, limits).status;
      const code = airport.iata || airport.ident;
      const text = named ? `${code} ${shortName(airport)}` : code;
      // Room for the plane, and for a flagged airport its status badge.
      const extra = flag ? 50 : 30;
      wanted.push({
        label: {
          key: `${airport.ident}:airport`,
          kind: 'airport',
          airport,
          status,
          flag: Boolean(flag),
          text,
          title: flag ? `${airport.name}: ${STATUS[flag].label} in the wind check; open the runway check` : `${airport.name}: open the runway check`,
        },
        anchor: frame.toXY(airport),
        direction: { x: 0, y: 1 },
        w: (7.4 * text.length + extra) * mpp,
        h: 22 * mpp,
        distances: flag ? [-11, 4, 14, 24, 36] : [-11, 4, 14],
        optional: !flag,
      });
    }
    runways.draw(strips, mpp);
    // Runway ends first, so they get the spots nearest their runways; then winds, then airports.
    const order = { runway: 0, wind: 1, airport: 2 };
    wanted.sort((p, q) => order[p.label.kind] - order[q.label.kind]);
    // City names on the map (see map.js): a dot with the name to its right, 11 px capitals.
    const tier = labelTier(pov.altitude);
    const taken = CITIES.filter((c) => c.tier <= tier).map((c) => {
      const { x, y } = frame.toXY(c);
      return { x0: x - 5 * mpp, x1: x + (9 * c.name.length + 12) * mpp, y0: y - 8 * mpp, y1: y + 8 * mpp };
    });
    const centres = placeLabels(wanted, segments, mpp, { gap: 4, taken });
    const labels = [];
    let airportsPlaced = 0;
    wanted.forEach((w, i) => {
      if (!centres[i]) return;
      if (w.label.kind === 'airport' && ++airportsPlaced > MAX_AIRPORT_LABELS) return;
      labels.push({ ...w.label, ...frame.toLatLng(centres[i]) });
    });
    mapFeatures.setRunwayLabels(labels, onSelect);
  }

  return { view, refresh: render };
}

// The distinctive part of an airport's name: "Amsterdam Airport Schiphol" → "Schiphol".
export function shortName(airport) {
  const name = airport.name
    .replace(/\b(international|intl\.?|regional|municipal|airport|airfield|aerodrome|air base|airbase|field)\b/gi, '')
    .replace(/[–-]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const city = airport.city?.trim();
  const rest = city && name.toLowerCase().startsWith(city.toLowerCase()) && name.length > city.length + 2 ? name.slice(city.length).trim() : name;
  const short = rest.replace(/^[-–/,]\s*/, '') || airport.city || airport.name;
  return short.length > 22 ? `${short.slice(0, 21)}…` : short;
}
