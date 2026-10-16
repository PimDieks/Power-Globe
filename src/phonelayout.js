// Phones: where the panels go on a small screen, and the part of the globe they leave free. There
// are two shapes, with the same media queries as the stylesheet. A narrow (portrait) phone has a
// compact bar at the top and the airport and wind check panels as sheets above the timeline; a
// short (landscape) phone with a touch screen has the same bar and the panels as a column on the
// right. The helpers at the top need no browser; setupPhoneLayout wires up the page.
import { estimatePosition, drawnAltitude } from './aircraft.js';
import { shiftedLat, shiftedLng, sideShift, visibleShift } from './follow.js';

export const NARROW_QUERY = '(max-width: 640px)';
// Any short screen held sideways, gated on a touch screen so that a short window on a computer
// keeps the usual layout. It wins over NARROW_QUERY (a 640 by 360 phone is a landscape one).
export const PHONE_LANDSCAPE_QUERY = '(max-height: 500px) and (pointer: coarse) and (orientation: landscape)';

// Above this camera height (globe radii) the globe's curve makes shiftedLat and shiftedLng too far
// off (by more than about 7% at the edge of the screen): aimAt then simply centres.
export const AIM_MAX_ALTITUDE = 0.1;
// An aircraft this close to the edge of the free part (px) is moved into it.
export const REVEAL_MARGIN = 24;
// The pan that brings it there, in ms.
const REVEAL_MS = 700;
// A drag this far (px) up or down the handle of a sheet is a swipe.
export const SWIPE_PX = 24;
// The click a browser may send after a swipe is ignored for this long (ms).
const SWIPE_CLICK_MS = 500;

const noQuery = { matches: false, addEventListener() {} };
const query = (q) => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q) : noQuery);
const narrowQuery = query(NARROW_QUERY);
export const phoneLandscape = query(PHONE_LANDSCAPE_QUERY);
// A narrow (portrait) phone: narrow, and not a landscape one.
export const phoneLayout = {
  get matches() {
    return narrowQuery.matches && !phoneLandscape.matches;
  },
  addEventListener(type, listener) {
    narrowQuery.addEventListener(type, listener);
    phoneLandscape.addEventListener(type, listener);
  },
};
// Either shape of phone.
export const onPhone = () => narrowQuery.matches || phoneLandscape.matches;

const clampLat = (lat) => Math.max(-85, Math.min(85, lat));
const wrapLng = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// The part of the screen a newly opened panel leaves to the globe, { top, bottom, left, right } in
// px: under the top bar (which ends at `controlsBottom`) and above the sheet at its first height
// (its top is `edge`) on a narrow phone; above the timeline (`timelineTop` px from the bottom) and
// left of the column (its left is `edge`) on a landscape one.
export function freeRect({ landscape, width, height, controlsBottom, timelineTop, edge }) {
  if (landscape) return { top: controlsBottom, bottom: height - timelineTop, left: 0, right: edge };
  return { top: controlsBottom, bottom: edge, left: 0, right: width };
}

// Where to aim the camera, at `altitude`, to see `point` ({ lat, lng }) in the middle of `rect`
// (see freeRect) on a screen `width` by `height` px: { lat, lng }. Seen from high up it is
// simply centred.
export function aimAt(point, altitude, rect, { width, height }) {
  if (altitude > AIM_MAX_ALTITUDE) return { lat: point.lat, lng: point.lng };
  const shift = visibleShift({ top: rect.top, bottom: rect.bottom, height });
  const shiftX = sideShift({ left: rect.left, right: rect.right, width, height });
  return { lat: shiftedLat(point.lat, shift, altitude), lng: shiftedLng(point.lng, point.lat, shiftX, altitude) };
}

// Whether the screen position `p` ({ x, y }) is inside `rect`, at least `margin` px from its edges.
export const insideRect = (p, rect, margin = 0) =>
  p.x >= rect.left + margin && p.x <= rect.right - margin && p.y >= rect.top + margin && p.y <= rect.bottom - margin;

// The camera that brings `target` ({ lat, lng }, now at `screen` px) into the middle of `rect`
// on a screen of `size` ({ width, height }), or null when it is in view already. `pov` is the
// camera now. Close in, aimAt works it out. Higher up, `spot` is the place on the globe at the
// middle of `rect` now (null when that is beside the globe, and then nothing moves), and the camera
// moves by as much as lies between the two. (globe.gl finds that place too roughly close in.)
export function revealPose({ screen, rect, size, pov, target, spot, margin = REVEAL_MARGIN }) {
  if (!screen || insideRect(screen, rect, margin)) return null;
  if (pov.altitude <= AIM_MAX_ALTITUDE) return { ...aimAt(target, pov.altitude, rect, size), altitude: pov.altitude };
  if (!spot) return null;
  return {
    lat: clampLat(pov.lat + target.lat - spot.lat),
    lng: wrapLng(pov.lng + wrapLng(target.lng - spot.lng)),
    altitude: pov.altitude,
  };
}

// The page's side: the sheets' handles, folding the controls and the credits when the globe is
// touched, the credits' button, and the camera helpers main.js calls. `globe` is the globe.gl
// instance.
export function setupPhoneLayout({ globe, globeEl, controls, timeline, sheets, titles, creditsToggle, collapseControls, closeCredits }) {
  // An invisible box where a panel that opens now would be (see .panel-probe in the stylesheet),
  // so the camera aims at the same place the panels really go, the notch's room included.
  const probe = document.createElement('div');
  probe.className = 'panel-probe';
  probe.setAttribute('aria-hidden', 'true');
  document.body.append(probe);

  // Sheets can be pulled up only on narrow phones, and not while following.
  const sheetsActive = () => phoneLayout.matches && !document.body.classList.contains('follow-compact');
  const handles = sheets.map((panel) => setupSheet(panel, { titles, active: sheetsActive })).filter(Boolean);

  // Touching the globe folds the open menu and the open credits away, so the map is free to use.
  globeEl.addEventListener(
    'pointerdown',
    () => {
      if (!onPhone()) return;
      collapseControls();
      closeCredits();
    },
    { capture: true, passive: true },
  );

  // On a phone the credits are a single line with a button to read them in full; elsewhere the
  // button is there only while following folds the credits away.
  function syncCredits() {
    creditsToggle.hidden = !onPhone() && !document.body.classList.contains('follow-compact');
    if (creditsToggle.hidden) closeCredits();
  }
  phoneLayout.addEventListener('change', syncCredits);
  syncCredits();

  // The numbers freeRect needs, measured now. The controls are measured as they are: fold them first.
  function geometry() {
    const landscape = phoneLandscape.matches;
    return {
      landscape,
      width: window.innerWidth,
      height: window.innerHeight,
      controlsBottom: controls.offsetTop + controls.offsetHeight,
      timelineTop: window.innerHeight - timeline.offsetTop,
      edge: landscape ? probe.offsetLeft : probe.offsetTop,
    };
  }

  return {
    syncCredits,

    // Escape folds a sheet that was pulled up; true when it did.
    collapseSheet: () => handles.some((sheet) => sheet.collapse()),

    // Where to aim the camera at `altitude` so that `point` shows in the part of the screen left
    // free once its panel is open.
    aim(point, altitude) {
      const g = geometry();
      return aimAt(point, altitude, freeRect(g), g);
    },

    // A pan that brings the aircraft `report` out from under the panels, at the same height, as
    // { pose, ms }, or null when it is in view already.
    reveal(report, { reduced = false } = {}) {
      if (!onPhone() || !report) return null;
      const g = geometry();
      const rect = freeRect(g);
      const target = estimatePosition(report, Date.now());
      const pose = revealPose({
        screen: globe.getScreenCoords(target.lat, target.lng, drawnAltitude(report)),
        rect,
        size: g,
        pov: globe.pointOfView(),
        target,
        spot: globe.toGlobeCoords((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2),
      });
      return pose && { pose, ms: reduced ? 0 : REVEAL_MS };
    },
  };
}

// A sheet opens at its first height; its handle (a button at the top) pulls it up to just under
// the top bar and back. A swipe up or down on the handle does the same. Every panel that opens, or
// shows something else (its title changes), starts at the first height again. `active` says
// whether the handle is in use. Returns { collapse }, which folds the sheet if it was pulled up.
export function setupSheet(panel, { titles = [], active = () => true } = {}) {
  const handle = panel.querySelector('.sheet-handle');
  if (!handle) return null;
  const expanded = () => panel.classList.contains('sheet-expanded');
  const set = (on) => {
    panel.classList.toggle('sheet-expanded', on);
    handle.setAttribute('aria-expanded', String(on));
  };
  set(false);

  let downY = null;
  let swipedAt = -Infinity;
  handle.addEventListener('pointerdown', (event) => {
    swipedAt = -Infinity;
    if (!event.isPrimary || event.button !== 0) return;
    downY = event.clientY;
    // The swipe may end beyond the handle.
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener('pointerup', (event) => {
    if (downY == null) return;
    const dy = event.clientY - downY;
    downY = null;
    if (Math.abs(dy) < SWIPE_PX) return;
    swipedAt = performance.now();
    set(dy < 0);
  });
  handle.addEventListener('pointercancel', () => {
    downY = null;
  });
  // The click a browser sends after a swipe is not a second press; a keyboard's (detail 0) always is.
  handle.addEventListener('click', (event) => {
    if (event.detail !== 0 && performance.now() - swipedAt < SWIPE_CLICK_MS) return;
    set(!expanded());
  });

  let hidden = panel.classList.contains('hidden');
  new MutationObserver(() => {
    const now = panel.classList.contains('hidden');
    if (hidden && !now) set(false);
    hidden = now;
  }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  const title = titles.find((el) => panel.contains(el));
  if (title) new MutationObserver(() => set(false)).observe(title, { childList: true, characterData: true, subtree: true });

  return {
    collapse() {
      if (!active() || panel.classList.contains('hidden') || !expanded()) return false;
      set(false);
      return true;
    },
  };
}
