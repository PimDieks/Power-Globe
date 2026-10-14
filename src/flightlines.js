// The lines drawn for the selected aircraft: a solid one for where it came from (its track from
// OpenSky, then the positions the feeds have given since, then the aircraft itself), and, when its
// callsign has a route that fits its position, a dashed one to where it is going. See
// flightroute.js for the logic; traffic.js calls this for the aircraft it has selected.
import { drawnAltitude } from './aircraft.js';
import { flightLine } from './trafficlayer.js';
import { ARRIVED_KM, NO_TRACK, acceptRoute, airportCode, departureAirport, distanceKm, greatCircle, joinPath, lowStart, routeUrl, trackFits } from './flightroute.js';

// An amber that shows on the satellite imagery, the light maps and the weather layers.
const COLOR = [1, 0.76, 0.28];
// Reports closer together than this are the same place.
const MIN_STEP_KM = 0.03;
const MAX_TRAIL = 3000;
// The dashes are about this many pixels long, whatever the zoom.
const DASH_PX = 9;
const KM_PER_STEP = 100;
// An aircraft that takes off again has a new flight, but not twice within this long.
const RESTART_MIN_MS = 60_000;
const ICAO_ADDRESS = /^[0-9a-f]{6}$/;

export function setupFlightLines({ globe, scenePoint, onLabels, loadAirports, loadTrack, loadRoute, now = Date.now }) {
  const R = globe.getGlobeRadius();
  // The solid line stops short of the aircraft and the dashed one starts short of it, by about the
  // radius of its sprite (see setSprite), so the sprite shows.
  const past = flightLine(globe, { color: COLOR, tip: 'end' });
  const ahead = flightLine(globe, { color: COLOR, dashed: true, alpha: 0.9, tip: 'start' });
  // The selected aircraft's lines and what is known about its flight, or null.
  let state = null;

  function labels() {
    const list = [];
    const add = (airport, ident, kind) => airport && list.push({ lat: airport.lat, lng: airport.lng, text: airportCode(airport), title: airport.name, ident, kind });
    add(state?.departure, state?.departure?.ident, 'from');
    add(state?.leg?.to, state?.leg?.to?.icao, 'to');
    onLabels?.(list);
  }

  // The airport the track began at, once the track and the airport list are both in.
  function airportReady() {
    if (!state || state.departureDone || state.trackState !== 'ok' || !state.airports) return;
    state.departureDone = true;
    state.departure = departureAirport(state.track, state.airports);
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

  // The dashed line, from the aircraft to the destination, sinking to the ground there.
  function drawAhead() {
    const to = state?.leg?.to;
    if (!to || !state.report || distanceKm(state.report, to) < ARRIVED_KM) {
      ahead.hide();
      return;
    }
    const start = state.head ?? state.report;
    const steps = Math.min(120, Math.max(4, Math.ceil(distanceKm(start, to) / KM_PER_STEP)));
    const points = greatCircle(start, to, steps);
    const flat = new Float32Array(points.length * 3);
    points.forEach((p, i) => scenePoint(p.lat, p.lng, state.report.altitude * (1 - p.f), flat, i));
    ahead.set(flat);
  }

  // The track is used once it and the aircraft's report are both known: only if it is this
  // aircraft's flight now (see trackFits).
  function settleTrack() {
    if (!state || state.trackState !== 'loading' || !state.loaded || !state.latest) return;
    const fits = trackFits(state.loaded, state.latest);
    state.track = fits ? state.loaded.points : [];
    state.trackState = fits ? 'ok' : 'none';
    // The airports are only needed to name where a track began, so only a track that began low asks.
    if (fits && lowStart(state.track[0])) {
      const mine = state;
      loadAirports()
        .then((airports) => {
          if (state !== mine) return;
          mine.airports = airports;
          airportReady();
        })
        .catch(() => {});
    }
    drawPast();
    decide();
  }

  // Whether the route fits the aircraft is judged once, when the track, the route and the
  // aircraft's position are all known, so a line does not come and go as it flies.
  function decide() {
    if (!state || state.decided || state.trackState === 'loading' || state.routeState !== 'done' || !state.report) return;
    state.decided = true;
    const position = state.head ?? state.report;
    state.leg = state.route
      ? acceptRoute(state.route, { position, trackStart: state.trackState === 'ok' ? state.track[0] : null, heading: state.heading })
      : null;
    labels();
    drawAhead();
  }

  // Starts afresh for an aircraft: its track (`fresh` for a new flight, not the cached one), then
  // what is known of its route once its callsign is.
  function begin(id, ac, { fresh = false } = {}) {
    const mine = {
      id,
      begun: now(),
      track: [],
      trackState: 'loading',
      loaded: null,
      trail: [],
      lastSeen: 0,
      latest: null,
      report: null,
      head: null,
      heading: null,
      onGround: null,
      callsign: null,
      airports: null,
      departure: null,
      departureDone: false,
      route: null,
      routeState: 'idle',
      leg: null,
      decided: false,
    };
    state = mine;
    // Tracks are only asked for aircraft with an ICAO address (OpenSky has no others).
    if (ac?.nonIcao || !ICAO_ADDRESS.test(id)) mine.loaded = NO_TRACK;
    else {
      loadTrack(id, { fresh }).then((track) => {
        if (state !== mine) return;
        mine.loaded = track;
        settleTrack();
      });
    }
  }

  function start(id, ac) {
    if (state?.id === id) return;
    stop();
    begin(id, ac);
  }

  function stop() {
    if (!state) return;
    state = null;
    past.hide();
    ahead.hide();
    onLabels?.([]);
  }

  // Called when a report shows the flight is not the one being drawn: a new callsign, or take-off
  // after being on the ground. Everything is asked for afresh.
  function restart(ac) {
    past.hide();
    ahead.hide();
    begin(state.id, ac, { fresh: true });
    labels();
  }

  // The aircraft's route is looked up, when it has a callsign that can have one.
  function lookUpRoute(ac) {
    const mine = state;
    mine.callsign = ac.callsign || '';
    mine.routeState = 'idle';
    mine.route = null;
    mine.leg = null;
    mine.decided = false;
    if (routeUrl(ac.callsign)) {
      mine.routeState = 'loading';
      loadRoute(ac.callsign).then((route) => {
        if (state !== mine || mine.callsign !== (ac.callsign || '')) return;
        mine.route = route;
        mine.routeState = 'done';
        decide();
      });
    } else {
      // An aircraft with no callsign, or one that cannot have a route, has none to look up.
      mine.routeState = 'done';
    }
  }

  // The altitude to draw a report at: a missing one is the last known, not the ground.
  function altitudeOf(ac) {
    const last = joinPath(state.track, state.trail).at(-1);
    const altitudeFt = ac.altitudeFt ?? (ac.onGround ? null : (last?.altitudeFt ?? null));
    return { altitudeFt, altitude: drawnAltitude({ onGround: ac.onGround, altitudeFt }) };
  }

  // Called every frame with the selected aircraft's latest report and where it is drawn now.
  // Geometry changes only when a report comes in, apart from the aircraft's end of the lines.
  function frame(ac, estimate, altitude) {
    if (!state) return;
    ahead.dash = (DASH_PX * 2 * Math.tan((25 * Math.PI) / 180) * Math.max(altitude, 0.002) * R) / window.innerHeight;
    if (!ac) return;
    if (ac.seen > state.lastSeen) {
      // A report of another flight: a callsign that changed, or take-off after being on the ground.
      const callsign = ac.callsign || '';
      const changed = state.callsign !== null && state.callsign !== '' && callsign !== state.callsign;
      const tookOff = state.onGround === true && ac.onGround === false && now() - state.begun >= RESTART_MIN_MS;
      if (changed || tookOff) {
        restart(ac);
        return frame(ac, estimate, altitude);
      }
      // The first callsign, or one that arrived late, is the one to look up.
      if (state.callsign === null || (state.callsign === '' && callsign !== '')) lookUpRoute(ac);
      state.lastSeen = ac.seen;
      state.latest = ac;
      state.onGround = ac.onGround;
      state.heading = ac.onGround || ac.track == null ? null : ac.track;
      const { altitudeFt, altitude: sceneAltitude } = altitudeOf(ac);
      state.report = { lat: ac.lat, lng: ac.lng, altitude: sceneAltitude };
      const last = joinPath(state.track, state.trail).at(-1);
      if (!last || distanceKm(last, ac) > MIN_STEP_KM || last.onGround !== ac.onGround) {
        state.trail.push({ t: ac.seen / 1000, lat: ac.lat, lng: ac.lng, altitudeFt, onGround: ac.onGround });
        if (state.trail.length > MAX_TRAIL) state.trail.shift();
      }
      state.head = null;
      settleTrack();
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
      ahead.moveStart(out[0], out[1], out[2]);
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

  // The radius in pixels of the selected aircraft's sprite, which the lines stay clear of.
  function setSprite(radius) {
    past.gap = radius;
    ahead.gap = radius;
  }

  return { start, stop, frame, info, setViewport, setSprite };
}
