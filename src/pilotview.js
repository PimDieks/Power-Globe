// The pilot's view: the outside view from the selected aircraft, full screen, as it flies. This
// file holds what needs no browser (where the eye is, what the view looks like at that height, the
// readout) and the overlay that runs it. The map itself is MapLibre, loaded from pilotmap.js the
// first time the view is opened, so the rest of the site does not carry it.
import { approach, followPoint, SMOOTH_S, stopReason } from './follow.js';

const M_PER_FT = 0.3048;
const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

// The eye is this high above the ground on the ground (a cockpit on the apron), and an aircraft in
// the air is never put lower than this above the ground, whatever its barometric altitude says.
export const EYE_HEIGHT_M = 5;
// Altitude is carried on at the last vertical speed for at most this long after a report.
export const MAX_ALTITUDE_ESTIMATE_S = 60;
// The heading turns to a new track the way the position closes a gap, a little slower.
export const TRACK_SMOOTH_S = 1.5;
// The ground under the aircraft changes as finer elevation tiles arrive; the eye follows it over this long.
const GROUND_SMOOTH_S = 0.5;
// The readout is redrawn this often.
const READOUT_MS = 100;

const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const wrap360 = (d) => ((d % 360) + 360) % 360;

// Moves along a constant track (a rhumb line) from a position: the point `metres` ahead.
export function advance(lat, lng, trackDeg, metres) {
  const d = metres / R;
  const th = rad(trackDeg);
  const phi1 = rad(lat);
  const phi2 = phi1 + d * Math.cos(th);
  const dPsi = Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
  const q = Math.abs(dPsi) > 1e-12 ? (phi2 - phi1) / dPsi : Math.cos(phi1);
  const lam2 = rad(lng) + (d * Math.sin(th)) / q;
  return { lat: deg(phi2), lng: wrap180(deg(lam2)) };
}

// Barometric altitude (ft) at `now`: the last report carried on at its vertical speed. Null when
// the aircraft gave none.
export function estimateAltitudeFt(ac, now) {
  if (!Number.isFinite(ac.altitudeFt)) return null;
  if (ac.onGround || !Number.isFinite(ac.verticalFpm)) return ac.altitudeFt;
  const seconds = Math.min(MAX_ALTITUDE_ESTIMATE_S, Math.max(0, (now - ac.seen) / 1000));
  return ac.altitudeFt + (ac.verticalFpm * seconds) / 60;
}

// Starts a view of `report`'s aircraft. `pilot` keeps what smoothing needs between frames.
export const startPilot = (report) => ({ id: report.id, point: null, altitude: null, track: null });

// The aircraft's position, altitude and track for this frame, { lat, lng, altitudeFt, track,
// speedKt, onGround }. A new position report that disagrees with the last one is faded in, as when
// following (see followPoint), for the altitude and the track as well, so the view never jumps.
// Changes `pilot`, which startPilot made.
export function pilotStep(pilot, report, now) {
  pilot.point = followPoint(pilot.point, report, now);
  const target = estimateAltitudeFt(report, now);
  if (target == null) {
    pilot.altitude = null;
  } else if (!pilot.altitude) {
    pilot.altitude = { ft: target, at: now };
  } else {
    const before = estimateAltitudeFt(report, pilot.altitude.at) ?? target;
    pilot.altitude = { ft: target + approach(pilot.altitude.ft - before, 0, now - pilot.altitude.at, SMOOTH_S), at: now };
  }
  const wanted = Number.isFinite(report.track) ? report.track : (pilot.track?.deg ?? 0);
  pilot.track = {
    deg: pilot.track ? wrap360(wanted + approach(wrap180(pilot.track.deg - wanted), 0, now - pilot.track.at, TRACK_SMOOTH_S)) : wanted,
    at: now,
  };
  return {
    lat: pilot.point.lat,
    lng: pilot.point.lng,
    altitudeFt: pilot.altitude?.ft ?? null,
    track: pilot.track.deg,
    speedKt: Number.isFinite(report.speedKt) ? report.speedKt : null,
    onGround: !!report.onGround,
  };
}

// Where the eye is (metres above sea level) over ground `groundM` high. An aircraft on the ground
// has its eye a cockpit's height above the ground; one in the air is at its barometric altitude,
// but never closer to the ground than that.
export function eyeAltitudeM(pose, groundM = 0) {
  if (pose.onGround || pose.altitudeFt == null) return groundM + EYE_HEIGHT_M;
  return Math.max(pose.altitudeFt * M_PER_FT, groundM + EYE_HEIGHT_M);
}

// The text of the readout: altitude (ft), ground speed (kt) and track (degrees, three digits).
export function formatReadout(pose, locale) {
  const flying = !pose.onGround && pose.altitudeFt != null;
  return {
    alt: pose.onGround ? 'GND' : pose.altitudeFt == null ? '–' : Math.round(pose.altitudeFt).toLocaleString(locale),
    altUnit: flying ? 'ft' : '',
    gs: pose.speedKt == null ? '–' : String(Math.round(pose.speedKt)),
    trk: String(Math.round(pose.track) % 360).padStart(3, '0'),
  };
}

// How the view looks at different heights above the ground, from the prototype's three cases (on
// the apron, final approach at 3,000 ft over a flat country, cruise at 38,000 ft): how far below
// the horizon the camera points, the vertical field of view, how far one sees through the haze
// (km, until 63% of the ground's colour is lost) and the sky. Between them the values blend, by the
// logarithm of the height.
const KEYS = [
  {
    agl: EYE_HEIGHT_M,
    lookDown: 0.5,
    vfov: 50,
    visKm: 8,
    sky: { 'sky-color': '#4a86c4', 'horizon-color': '#dbe7f1', 'fog-color': '#dbe7f1', 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.4, 'atmosphere-blend': 1 },
  },
  {
    agl: 915,
    lookDown: 4,
    vfov: 50,
    visKm: 45,
    sky: { 'sky-color': '#3b78bd', 'horizon-color': '#cfdfee', 'fog-color': '#cfdfee', 'sky-horizon-blend': 0.5, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.5, 'atmosphere-blend': 1 },
  },
  {
    agl: 11_600,
    lookDown: 5,
    vfov: 52,
    visKm: 220,
    sky: { 'sky-color': '#2c63a8', 'horizon-color': '#cfdfee', 'fog-color': '#cfdfee', 'sky-horizon-blend': 0.55, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.55, 'atmosphere-blend': 1 },
  },
];
const LOGS = KEYS.map((k) => Math.log(k.agl));
// The view changes in this many steps between two cases, so the sky is not set again every frame.
const STEPS = 12;
// The tile level of detail (how many zoom levels are on screen at once, and the ratio of most to
// fewest tiles) by height: MapLibre's own (9.314 and 3) low down, where fewer levels make it ask
// for far more tiles, then fewer levels from the air and fewer still from far up. The
// prototype's 7 and 6 for an approach asked for up to 500 imagery tiles a minute; 5 and 3 asks
// for under 300 and looks the same.
const LOD_ENGINE = [9.314, 3];
const LOD_LOW = [5, 3];
const LOD_HIGH = [7, 3];
export const LOD_NEAR_GROUND_M = 300;
export const LOD_HIGH_M = 4000;

const mix = (a, b, t) => a + (b - a) * t;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mixColor = (a, b, t) => `#${rgb(a).map((v, i) => Math.round(mix(v, rgb(b)[i], t)).toString(16).padStart(2, '0')).join('')}`;

export function viewProfile(aglM) {
  const x = Math.log(Math.max(aglM, KEYS[0].agl));
  let u = KEYS.length - 1;
  for (let i = 0; i < KEYS.length - 1; i++) {
    if (x <= LOGS[i + 1]) {
      u = i + Math.max(0, (x - LOGS[i]) / (LOGS[i + 1] - LOGS[i]));
      break;
    }
  }
  u = Math.round(u * STEPS) / STEPS;
  const i = Math.min(KEYS.length - 2, Math.floor(u));
  const t = u - i;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const sky = {};
  for (const key of Object.keys(a.sky)) {
    sky[key] = typeof a.sky[key] === 'string' ? mixColor(a.sky[key], b.sky[key], t) : mix(a.sky[key], b.sky[key], t);
  }
  return {
    key: u,
    lookDown: mix(a.lookDown, b.lookDown, t),
    vfov: mix(a.vfov, b.vfov, t),
    visKm: Math.exp(mix(Math.log(a.visKm), Math.log(b.visKm), t)),
    sky,
    lod: aglM < LOD_NEAR_GROUND_M ? LOD_ENGINE : aglM < LOD_HIGH_M ? LOD_LOW : LOD_HIGH,
  };
}

// Where the camera looks from an eye at `eyeM` over ground `groundM`, as MapLibre wants it: a
// point ahead of the aircraft along its track, below the horizon by the profile's angle, and its
// distance. MapLibre has no camera at an altitude, only this aimed point plus pitch, bearing and
// distance. Two things pick the distance. The aimed point should lie on the ground (distance =
// height / sin(angle)), or MapLibre loads many fine tiles under the aircraft that are never on
// screen. But the near clipping plane scales with that distance (about 6 percent of it) and must
// stay below the nearest ground in view, which rules out a long distance for a low eye: it is
// capped at 20 times the height.
export function cameraTarget({ lat, lng, track, eyeM, groundM }, lookDown) {
  const agl = Math.max(2, eyeM - groundM);
  const hitsGroundAt = lookDown > 0.1 ? agl / Math.sin(rad(lookDown)) : Infinity;
  const distanceM = Math.max(20, Math.min(hitsGroundAt, 20 * agl));
  const ahead = advance(lat, lng, track, distanceM * Math.cos(rad(lookDown)));
  return { lat: ahead.lat, lng: ahead.lng, altM: eyeM - distanceM * Math.sin(rad(lookDown)), distanceM };
}

// MapLibre's own fog only reaches the far plane, so the aerial haze is a gradient over the picture
// below the horizon: each row is turned into the distance it shows on flat ground, and the haze
// follows Beer-Lambert, alpha = 1 - exp(-distance / visibility). Returns the band's top and
// height in pixels and its CSS background, or null for no haze.
// MapLibre ends the map 0.75 degrees below the true horizontal.
const ENGINE_HORIZON_DIP = 0.75;
const HAZE_STEPS = 28;
export function hazeBand({ height, aglM, lookDown, vfov, visKm, color }) {
  if (!(height > 0)) return null;
  const above = Math.max(2, aglM);
  const focal = height / 2 / Math.tan(rad(vfov / 2));
  const yHorizon = height / 2 - focal * Math.tan(rad(lookDown - ENGINE_HORIZON_DIP));
  if (yHorizon >= height) return null;
  const [r, g, b] = rgb(color);
  const stops = [];
  for (let i = 0; i <= HAZE_STEPS; i++) {
    const s = i / HAZE_STEPS;
    const y = yHorizon + (height - yHorizon) * s * s;
    // Degrees below the horizontal that screen row y looks.
    const below = lookDown - deg(Math.atan((height / 2 - y) / focal));
    const distance = below > 0.02 ? above / Math.tan(rad(below)) : 1e9;
    const alpha = Math.min(1, 1 - Math.exp(-distance / (visKm * 1000)));
    stops.push(`rgba(${r},${g},${b},${alpha.toFixed(3)}) ${(((y - yHorizon + 2) / (height - yHorizon + 2)) * 100).toFixed(2)}%`);
  }
  return { top: yHorizon - 2, height: height - yHorizon + 2, background: `linear-gradient(to bottom, ${stops.join(', ')})` };
}

// The overlay. `els`: root, map (where the view goes), title, status, terrain, close, button (the
// details panel's "Pilot view" button), detailsClose, hud { alt, altUnit, gs, trk } and terrainCredit.
// `traffic`: the traffic layer (selectedAircraft, selected, title). `background`: the page's other
// elements, made inert while the overlay is open. `onOpen` and `onClose`: the globe's pause and
// resume. `loadMap`: loads the map module (replaced in tests).
export function setupPilotView({ els, traffic, background, onOpen, onClose, announce, loadMap = () => import('./pilotmap.js') }) {
  let session = null;
  let inerted = [];

  function open() {
    const report = traffic.selectedAircraft();
    if (session || !report) return;
    const name = traffic.title(traffic.selected);
    const mine = { id: report.id, name, pilot: startPilot(report), map: null, ground: null, readoutAt: -Infinity, raf: 0 };
    session = mine;
    els.title.textContent = name;
    els.status.textContent = 'Loading the view…';
    els.terrain.setAttribute('aria-pressed', 'true');
    els.terrain.textContent = 'Terrain: on';
    els.terrainCredit.hidden = false;
    els.root.hidden = false;
    inerted = background().filter((el) => !el.inert);
    for (const el of inerted) el.inert = true;
    els.close.focus();
    onOpen();
    announce(`Pilot view from ${name}. Press Escape to close.`);
    schedule(mine);
    (async () => {
      try {
        const module = await loadMap();
        const map = await module.createPilotMap({
          container: els.map,
          terrain: els.terrain.getAttribute('aria-pressed') === 'true',
          onLoaded: () => session === mine && (els.status.textContent = ''),
        });
        // Closed while it loaded.
        if (session !== mine) map.destroy();
        else mine.map = map;
      } catch (err) {
        console.error(err);
        if (session === mine) close('The pilot view could not be loaded. Closed the pilot view.');
      }
    })();
  }

  function schedule(mine) {
    mine.raf = requestAnimationFrame(() => {
      if (session !== mine) return;
      try {
        frame();
      } catch (err) {
        console.error(err);
        close('The pilot view stopped working. Closed the pilot view.');
        return;
      }
      if (session === mine) schedule(mine);
    });
  }

  // One frame: checks that the aircraft is still there, and puts the camera at it.
  function frame(now = Date.now(), clock = performance.now()) {
    const mine = session;
    if (!mine) return;
    const report = traffic.selectedAircraft();
    const reason = stopReason({ id: mine.id, selected: traffic.selected, report });
    if (reason) {
      close(reason === 'lost' ? `${mine.name} is no longer received. Closed the pilot view.` : undefined);
      return;
    }
    const pose = pilotStep(mine.pilot, report, now);
    const map = mine.map;
    let groundM = 0;
    if (map) {
      const measured = map.groundElevation(pose.lat, pose.lng);
      if (measured != null) {
        // The first height is taken as it is: easing up from sea level would fly the eye up a mountain.
        mine.ground = mine.ground == null ? { m: measured, at: now } : { m: approach(mine.ground.m, measured, now - mine.ground.at, GROUND_SMOOTH_S), at: now };
      }
      groundM = mine.ground?.m ?? 0;
      const eyeM = eyeAltitudeM(pose, groundM);
      map.place({ lat: pose.lat, lng: pose.lng, track: pose.track, eyeM, groundM, profile: viewProfile(eyeM - groundM) });
    }
    if (clock - mine.readoutAt >= READOUT_MS) {
      mine.readoutAt = clock;
      const text = formatReadout(pose);
      els.hud.alt.textContent = text.alt;
      els.hud.altUnit.textContent = text.altUnit;
      els.hud.gs.textContent = text.gs;
      els.hud.trk.textContent = text.trk;
    }
  }

  // Closes the view and gives the globe back as it was. `message`: said to screen readers.
  function close(message) {
    const mine = session;
    if (!mine) return;
    session = null;
    cancelAnimationFrame(mine.raf);
    mine.map?.destroy();
    els.root.hidden = true;
    for (const el of inerted) el.inert = false;
    inerted = [];
    onClose();
    if (message) announce(message);
    // The focus goes back to the button that opened it, or to the panel's close button if the
    // aircraft is gone and the button is off.
    if (!els.button.hidden && traffic.selectedAircraft()) els.button.focus();
    else els.detailsClose.focus();
  }

  // The button is in the details panel's header, which is not rebuilt every second like its body.
  // It shows for an aircraft, and is off while the aircraft is not being received.
  let buttonKey = '';
  function sync() {
    const aircraft = traffic.selected?.kind === 'aircraft';
    const received = !!traffic.selectedAircraft();
    const key = `${aircraft}:${received}`;
    if (key === buttonKey) return;
    buttonKey = key;
    els.button.hidden = !aircraft;
    els.button.disabled = !received;
    // A disabled button cannot keep focus: the panel's close button is the next stop.
    if (els.button.disabled && els.button.ownerDocument?.activeElement === els.button) els.detailsClose.focus();
  }

  els.button.addEventListener('click', open);
  els.close.addEventListener('click', () => close());
  els.terrain.addEventListener('click', () => {
    if (!session) return;
    const on = els.terrain.getAttribute('aria-pressed') !== 'true';
    els.terrain.setAttribute('aria-pressed', String(on));
    els.terrain.textContent = on ? 'Terrain: on' : 'Terrain: off';
    els.terrainCredit.hidden = !on;
    session.map?.setTerrain(on);
    if (!on) session.ground = null;
  });

  return { open, close, frame, sync, get isOpen() { return !!session; }, get map() { return session?.map ?? null; } };
}
