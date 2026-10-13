// Following an aircraft with the camera: the parts that need no browser. The camera keeps the
// aircraft in the middle of the view, north up, seen from straight above; main.js applies what
// is worked out here to the globe every frame.
import { drawnAltitude, estimatePosition } from './aircraft.js';

// A new position report can disagree with where the old one put the aircraft. The camera does not
// jump to the new estimate: the gap fades, with about two thirds of it gone after this long.
export const SMOOTH_S = 1;
// The same for the sideways shift on phones (see visibleShift), which changes with the panel's height.
const SHIFT_SMOOTH_S = 0.3;
// The camera glides to the aircraft over this long.
export const GLIDE_MS = 2200;
// Following starts from this height at most (globe radii): the aircraft is a clear sprite, and
// runways and airports below it can be made out. A closer view is kept.
export const FOLLOW_ALTITUDE = 0.03;
// The camera stays at least this far above the aircraft (globe radii, about 9 km), so that a
// high one (a balloon) is not at or behind the camera. Aircraft are drawn at their true height.
export const CLEARANCE = 0.0015;
// With reduced motion the camera does not move continuously: it centres on the aircraft this
// often.
export const RECENTRE_MS = 4000;
// A pointer that moves farther than this between going down and coming up has dragged the map,
// rather than tapped it.
export const DRAG_PX = 6;
// Degrees of latitude the view spans per globe radius of camera altitude (see detail.js).
export const LAT_SPAN_PER_ALTITUDE = 53;

const wrapLng = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// Whether a pointer that went down at `down` and is now at `point` has dragged.
export const dragged = (down, point) => Math.hypot(point.x - down.x, point.y - down.y) > DRAG_PX;

// Moves `value` towards `target` the way the gap to the aircraft fades: `seconds` is the time
// for two thirds of it to go, `elapsedMs` the time since the last step.
export function approach(value, target, elapsedMs, seconds) {
  return target + (value - target) * Math.exp(-Math.max(0, elapsedMs) / 1000 / seconds);
}

// The point the camera looks at, one frame on. `previous` is the point from the last frame,
// { lat, lng, at } (at: when, in ms), or null for the first. The camera follows its own estimate
// of where the aircraft is (see estimatePosition), worked out for every frame rather than at the
// pace the sprites move at. The same report one frame ago says how far the aircraft itself has
// moved, which carries the point along; what is left between that and the point is a new report
// disagreeing with the last one, and it fades. A steady flight is followed exactly, with no lag.
export function followPoint(previous, ac, now) {
  const target = estimatePosition(ac, now);
  if (!previous) return { ...target, at: now };
  const before = estimatePosition(ac, previous.at);
  const elapsed = now - previous.at;
  return {
    lat: target.lat + approach(previous.lat - before.lat, 0, elapsed, SMOOTH_S),
    lng: wrapLng(target.lng + approach(wrapLng(previous.lng - before.lng), 0, elapsed, SMOOTH_S)),
    at: now,
  };
}

// The camera's height (altitude in globe radii) that stays above the aircraft, given the height
// it has now (the visitor chooses that with the wheel or by pinching).
export const cameraAltitude = (altitude, ac) => Math.max(altitude, drawnAltitude(ac) + CLEARANCE);

// How far the middle of the part of the screen left free (from `top` down to `bottom`, in pixels)
// lies above the middle of the screen, as a share of the screen's height. On phones the details
// panel covers the lower part; at least 80 px stay free.
export function visibleShift({ top, bottom, height }) {
  const free = Math.max(top + 80, bottom);
  return (height / 2 - (top + free) / 2) / height;
}

// The latitude to aim the camera at to see `lat` that much (see visibleShift) above the middle
// of the screen: south of it. Keeps clear of the poles.
export const shiftedLat = (lat, shift, altitude) => Math.max(-85, Math.min(85, lat - shift * LAT_SPAN_PER_ALTITUDE * altitude));

// The camera `elapsed` ms into a glide from `from` to `to`, both { lat, lng, altitude }: slow at
// both ends, the short way round the globe, and changing height in proportion, which reads as an
// even zoom.
export function glidePose(from, to, elapsed, duration = GLIDE_MS) {
  const p = duration > 0 ? Math.min(1, Math.max(0, elapsed / duration)) : 1;
  const e = p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2;
  return {
    lat: from.lat + (to.lat - from.lat) * e,
    lng: wrapLng(from.lng + wrapLng(to.lng - from.lng) * e),
    altitude: from.altitude * (to.altitude / from.altitude) ** e,
    done: p >= 1,
  };
}

// Why following should end now, or null to carry on. `selected` is what the traffic layer has
// selected ({ kind, id }), `report` that aircraft's latest report, if it is still being received.
export function stopReason({ id, selected, report }) {
  if (selected?.kind !== 'aircraft' || selected.id !== id) return 'deselected';
  return report ? null : 'lost';
}

// Starts following `report`'s aircraft from the camera's present point of view `pov`, at `now`.
// `reduced`: reduced motion, so no glide and no continuous movement (see followStep).
export function startFollow(report, pov, now, { reduced = false } = {}) {
  const altitude = cameraAltitude(Math.min(pov.altitude, FOLLOW_ALTITUDE), report);
  return {
    id: report.id,
    reduced,
    point: null,
    shift: null,
    shiftAt: now,
    centredAt: -Infinity,
    glide: { from: { lat: pov.lat, lng: pov.lng, altitude: pov.altitude }, altitude, start: now, duration: reduced ? 0 : GLIDE_MS },
  };
}

// Where the camera should be for this frame, { lat, lng, altitude }, or null to leave it where it
// is. `pov` is the camera now, `shift` the share of the screen's height the aircraft should sit
// above the middle (see visibleShift). Changes `follow`, which startFollow made.
export function followStep(follow, { report, pov, now, shift = 0 }) {
  const f = follow;
  if (f.reduced && !f.glide && now - f.centredAt < RECENTRE_MS) return null;
  f.centredAt = now;
  // Each centring with reduced motion is a jump, so there is nothing to smooth.
  f.point = followPoint(f.reduced ? null : f.point, report, now);
  f.shift = f.shift == null || f.reduced ? shift : approach(f.shift, shift, now - f.shiftAt, SHIFT_SMOOTH_S);
  f.shiftAt = now;
  if (f.glide) {
    const { from, altitude, start, duration } = f.glide;
    const to = { lat: shiftedLat(f.point.lat, f.shift, altitude), lng: f.point.lng, altitude: cameraAltitude(altitude, report) };
    const pose = glidePose(from, to, now - start, duration);
    if (pose.done) f.glide = null;
    return { lat: pose.lat, lng: pose.lng, altitude: pose.altitude };
  }
  const altitude = cameraAltitude(pov.altitude, report);
  return { lat: shiftedLat(f.point.lat, f.shift, altitude), lng: f.point.lng, altitude };
}
