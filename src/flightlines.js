// The lines drawn for the selected aircraft: a solid one for where it came from (its track from
// OpenSky, then the positions the feeds have given since, then the aircraft itself), and, when its
// callsign has a route that fits its position, a dashed one to where it is going. See
// flightroute.js for the logic; traffic.js calls this for the aircraft it has selected.
import { drawnAltitude } from './aircraft.js';
import { flightLine } from './trafficlayer.js';
import { ARRIVED_KM, acceptRoute, airportCode, departureAirport, distanceKm, greatCircle, joinPath, routeUrl } from './flightroute.js';

// An amber that shows on the satellite imagery, the light maps and the weather layers.
const COLOR = [1, 0.76, 0.28];
// Reports closer together than this are the same place.
const MIN_STEP_KM = 0.03;
const MAX_TRAIL = 3000;
// The dashes are about this many pixels long, whatever the zoom.
const DASH_PX = 9;
const KM_PER_STEP = 100;

export function setupFlightLines({ globe, scenePoint, onLabels, loadAirports, loadTrack, loadRoute }) {
  const R = globe.getGlobeRadius();
  const past = flightLine(globe, { color: COLOR });
  const ahead = flightLine(globe, { color: COLOR, dashed: true, alpha: 0.9 });
  // The selected aircraft's lines and what is known about its flight, or null.
  let state = null;

  function labels() {
    const list = [];
    const add = (airport, kind) => airport && list.push({ lat: airport.lat, lng: airport.lng, text: airportCode(airport), title: airport.name, kind });
    add(state?.departure, 'from');
    add(state?.leg?.to, 'to');
    onLabels?.(list);
  }

  function airportReady() {
    if (!state || state.departureDone || state.trackState !== 'ok' || !state.airports) return;
    state.departureDone = true;
    state.departure = departureAirport(state.track[0], state.airports);
    if (state.departure) labels();
  }

  // The solid line: every point so far, then the aircraft's own position as its end.
  function drawPast() {
    if (!state?.report) return;
    const path = joinPath(state.track, state.trail);
    const flat = new Float32Array((path.length + 1) * 3);
    path.forEach((p, i) => scenePoint(p.lat, p.lng, drawnAltitude(p), flat, i));
    const head = state.head ?? state.report;
    scenePoint(head.lat, head.lng, head.altitude, flat, path.length);
    past.set(flat);
  }

  // The dashed line, from the last report to the destination, sinking to the ground there.
  function drawAhead() {
    const to = state?.leg?.to;
    if (!to || !state.report || distanceKm(state.report, to) < ARRIVED_KM) {
      ahead.hide();
      return;
    }
    const steps = Math.min(120, Math.max(4, Math.ceil(distanceKm(state.report, to) / KM_PER_STEP)));
    const points = greatCircle(state.report, to, steps);
    const flat = new Float32Array(points.length * 3);
    points.forEach((p, i) => scenePoint(p.lat, p.lng, state.report.altitude * (1 - p.f), flat, i));
    ahead.set(flat);
  }

  // Whether the route fits the aircraft is judged once, when the track, the route and the
  // aircraft's position are all known, so a line does not come and go as it flies.
  function decide() {
    if (!state || state.decided || state.trackState === 'loading' || state.routeState !== 'done' || !state.report) return;
    state.decided = true;
    const position = state.head ?? state.report;
    state.leg = state.route ? acceptRoute(state.route, { position, trackStart: state.trackState === 'ok' ? state.track[0] : null }) : null;
    labels();
    drawAhead();
  }

  function start(id) {
    if (state?.id === id) return;
    stop();
    const mine = {
      id,
      track: [],
      trackState: 'loading',
      trail: [],
      lastSeen: 0,
      report: null,
      head: null,
      airports: null,
      departure: null,
      departureDone: false,
      route: null,
      routeState: 'idle',
      leg: null,
      decided: false,
    };
    state = mine;
    loadTrack(id).then((points) => {
      if (state !== mine) return;
      mine.track = points;
      mine.trackState = points.length ? 'ok' : 'none';
      airportReady();
      drawPast();
      decide();
    });
    loadAirports()
      .then((airports) => {
        if (state !== mine) return;
        mine.airports = airports;
        airportReady();
      })
      .catch(() => {});
  }

  function stop() {
    if (!state) return;
    state = null;
    past.hide();
    ahead.hide();
    onLabels?.([]);
  }

  // Called every frame with the selected aircraft's latest report and where it is drawn now.
  // Geometry changes only when a report comes in, apart from the aircraft's end of the solid line.
  function frame(ac, estimate, altitude) {
    if (!state) return;
    const scale = (DASH_PX * 2 * Math.tan((25 * Math.PI) / 180) * Math.max(altitude, 0.002) * R) / window.innerHeight;
    ahead.dash = scale;
    if (!ac) return;
    if (state.routeState === 'idle') {
      // An aircraft with no callsign, or one that cannot have a route, has none to look up.
      if (routeUrl(ac.callsign)) {
        state.routeState = 'loading';
        const mine = state;
        loadRoute(ac.callsign).then((route) => {
          if (state !== mine) return;
          mine.route = route;
          mine.routeState = 'done';
          decide();
        });
      } else {
        state.routeState = 'done';
      }
    }
    if (ac.seen > state.lastSeen) {
      state.lastSeen = ac.seen;
      const altitudeScene = drawnAltitude(ac);
      state.report = { lat: ac.lat, lng: ac.lng, altitude: altitudeScene };
      const last = joinPath(state.track, state.trail).at(-1);
      if (!last || distanceKm(last, ac) > MIN_STEP_KM || last.onGround !== ac.onGround) {
        state.trail.push({ t: ac.seen / 1000, lat: ac.lat, lng: ac.lng, altitudeFt: ac.altitudeFt, onGround: ac.onGround });
        if (state.trail.length > MAX_TRAIL) state.trail.shift();
      }
      state.head = null;
      drawPast();
      drawAhead();
      decide();
    }
    const at = estimate ?? ac;
    if (state.report && (state.head?.lat !== at.lat || state.head?.lng !== at.lng)) {
      state.head = { lat: at.lat, lng: at.lng, altitude: state.report.altitude };
      const out = [0, 0, 0];
      scenePoint(at.lat, at.lng, state.head.altitude, out, 0);
      past.moveEnd(out[0], out[1], out[2]);
    }
  }

  // What the panel says about the flight so far.
  function info() {
    if (!state) return null;
    return {
      trackState: state.trackState,
      from: state.departure && { code: airportCode(state.departure), name: state.departure.name },
      to: state.leg && { code: state.leg.to.code, name: state.leg.to.name },
    };
  }

  function setViewport(w, h) {
    past.setViewport(w, h);
    ahead.setViewport(w, h);
  }

  return { start, stop, frame, info, setViewport };
}
