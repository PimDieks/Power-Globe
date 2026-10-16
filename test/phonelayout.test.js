import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAT_SPAN_PER_ALTITUDE } from '../src/follow.js';
import { AIM_MAX_ALTITUDE, SWIPE_PX, aimAt, freeRect, insideRect, onPhone, revealPose, setupSheet } from '../src/phonelayout.js';

describe('freeRect', () => {
  it('leaves the band between the top bar and where a sheet opens on a narrow phone', () => {
    const rect = freeRect({ landscape: false, width: 390, height: 844, controlsBottom: 70, timelineTop: 90, edge: 408 });
    expect(rect).toEqual({ top: 70, bottom: 408, left: 0, right: 390 });
  });

  it('leaves the part left of the column and above the timeline on a landscape phone', () => {
    const rect = freeRect({ landscape: true, width: 844, height: 390, controlsBottom: 68, timelineTop: 90, edge: 451 });
    expect(rect).toEqual({ top: 68, bottom: 300, left: 0, right: 451 });
  });
});

describe('aimAt', () => {
  const rect = { top: 0, bottom: 400, left: 0, right: 400 };

  it('aims south of a point to show it in a band above the middle', () => {
    const aim = aimAt({ lat: 52, lng: 4 }, 0.01, rect, { width: 400, height: 800 });
    // The band's middle is 200 px above the screen's, a quarter of its height.
    expect(aim.lat).toBeCloseTo(52 - 0.25 * LAT_SPAN_PER_ALTITUDE * 0.01, 8);
    expect(aim.lng).toBe(4);
  });

  it('aims east of a point to show it left of the middle, by more away from the equator', () => {
    const size = { width: 800, height: 400 };
    const aim = aimAt({ lat: 0, lng: 4 }, 0.01, rect, size);
    expect(aim.lat).toBeCloseTo(0, 8);
    // 200 px left of the middle, half the screen's height.
    expect(aim.lng).toBeCloseTo(4 + 0.5 * LAT_SPAN_PER_ALTITUDE * 0.01, 8);
    const north = aimAt({ lat: 60, lng: 4 }, 0.01, rect, size);
    expect(north.lng - 4).toBeCloseTo((aim.lng - 4) * 2, 6);
  });

  it('wraps over the date line', () => {
    const aim = aimAt({ lat: 0, lng: 179.9 }, 0.1, rect, { width: 800, height: 400 });
    expect(aim.lng).toBeLessThan(-170);
  });

  it('only centres from high up, where the globe curves away too much to work it out this way', () => {
    const size = { width: 844, height: 390 };
    expect(aimAt({ lat: 65, lng: 4 }, 2.4, { top: 68, bottom: 300, left: 0, right: 474 }, size)).toEqual({ lat: 65, lng: 4 });
    expect(aimAt({ lat: 65, lng: 4 }, AIM_MAX_ALTITUDE, { top: 68, bottom: 300, left: 0, right: 474 }, size).lng).toBeGreaterThan(4);
  });
});

describe('insideRect', () => {
  const rect = { top: 70, bottom: 400, left: 0, right: 390 };

  it('tells a point in the free part from one under a panel', () => {
    expect(insideRect({ x: 200, y: 200 }, rect, 24)).toBe(true);
    expect(insideRect({ x: 200, y: 500 }, rect, 24)).toBe(false);
    expect(insideRect({ x: 200, y: 80 }, rect, 24)).toBe(false);
    expect(insideRect({ x: 10, y: 200 }, rect, 24)).toBe(false);
  });
});

describe('revealPose', () => {
  const rect = { top: 70, bottom: 408, left: 0, right: 390 };
  const size = { width: 390, height: 844 };
  const pov = { lat: 52, lng: 4.8, altitude: 1 };

  it('leaves an aircraft that is in view alone', () => {
    expect(revealPose({ size, screen: { x: 195, y: 240 }, rect, pov, target: { lat: 52, lng: 4.8 }, spot: { lat: 52, lng: 4.8 } })).toBeNull();
  });

  it('moves the camera by as much as lies between the aircraft and the middle of the free part', () => {
    // Under the sheet, seen from high up; the free part's middle shows a place 0.05° north of it.
    const pose = revealPose({ size, screen: { x: 195, y: 650 }, rect, pov, target: { lat: 51.95, lng: 4.8 }, spot: { lat: 52.0, lng: 4.8 } });
    expect(pose.lat).toBeCloseTo(51.95, 8);
    expect(pose.lng).toBeCloseTo(4.8, 8);
    expect(pose.altitude).toBe(1);
  });

  it('close in, aims as for an airport', () => {
    const close = { lat: 52, lng: 4.8, altitude: 0.004 };
    const pose = revealPose({ size, screen: { x: 195, y: 650 }, rect, pov: close, target: { lat: 51.99, lng: 4.8 }, spot: null });
    expect(pose).toEqual({ ...aimAt({ lat: 51.99, lng: 4.8 }, 0.004, rect, size), altitude: 0.004 });
    expect(pose.lat).toBeLessThan(51.99);
  });

  it('moves nothing when the middle of the free part is beside the globe', () => {
    expect(revealPose({ size, screen: { x: 195, y: 650 }, rect, pov, target: { lat: 51, lng: 4 }, spot: null })).toBeNull();
  });

  it('wraps over the date line and keeps clear of the poles', () => {
    const pose = revealPose({
      screen: { x: 195, y: 650 },
      rect,
      pov: { lat: 80, lng: 179, altitude: 1 },
      target: { lat: 89, lng: -178 },
      spot: { lat: 75, lng: 178 },
    });
    expect(pose.lng).toBeCloseTo(-177, 8);
    expect(pose.lat).toBe(85);
  });
});

// A stand-in for the page, as far as setupSheet uses it.
function fakeElement() {
  const classes = new Set();
  const attributes = new Map();
  const listeners = new Map();
  return {
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name),
    addEventListener: (type, f) => listeners.set(type, f),
    fire: (type, event = {}) => listeners.get(type)?.({ isPrimary: true, button: 0, pointerId: 1, detail: 1, ...event }),
  };
}

describe('setupSheet', () => {
  let observers;
  let now;

  beforeEach(() => {
    observers = [];
    now = 1000;
    vi.stubGlobal(
      'MutationObserver',
      class {
        constructor(callback) {
          this.callback = callback;
        }
        observe(target) {
          observers.push({ target, callback: this.callback });
        }
      },
    );
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function sheet({ active = () => true } = {}) {
    const handle = fakeElement();
    const title = fakeElement();
    const panel = fakeElement();
    panel.querySelector = () => handle;
    panel.contains = (el) => el === title;
    panel.classList.add('hidden');
    const api = setupSheet(panel, { titles: [title], active });
    const changed = (target) => observers.filter((o) => o.target === target).forEach((o) => o.callback());
    return { handle, title, panel, api, changed, expanded: () => panel.classList.contains('sheet-expanded') };
  }

  it('starts folded and says so', () => {
    const { handle, expanded } = sheet();
    expect(expanded()).toBe(false);
    expect(handle.getAttribute('aria-expanded')).toBe('false');
  });

  it('pulls up and folds on a press of the handle', () => {
    const { handle, expanded } = sheet();
    handle.fire('click');
    expect(expanded()).toBe(true);
    expect(handle.getAttribute('aria-expanded')).toBe('true');
    handle.fire('click', { detail: 0 });
    expect(expanded()).toBe(false);
  });

  it('follows a swipe that goes far enough, and ignores the click after it', () => {
    const { handle, expanded } = sheet();
    handle.fire('pointerdown', { clientY: 300 });
    handle.fire('pointerup', { clientY: 300 - SWIPE_PX + 1 });
    expect(expanded()).toBe(false);
    handle.fire('pointerdown', { clientY: 300 });
    handle.fire('pointerup', { clientY: 300 - SWIPE_PX - 10 });
    expect(expanded()).toBe(true);
    handle.fire('click');
    expect(expanded()).toBe(true);
    handle.fire('pointerdown', { clientY: 300 });
    handle.fire('pointerup', { clientY: 340 });
    expect(expanded()).toBe(false);
  });

  it('does not swallow a later press when no click came after the swipe', () => {
    const { handle, expanded } = sheet();
    handle.fire('pointerdown', { clientY: 300 });
    handle.fire('pointerup', { clientY: 200 });
    expect(expanded()).toBe(true);
    // A keyboard press at once, and a tap a moment later, both count.
    handle.fire('click', { detail: 0 });
    expect(expanded()).toBe(false);
    handle.fire('pointerdown', { clientY: 300 });
    handle.fire('pointerup', { clientY: 200 });
    now += 600;
    handle.fire('click');
    expect(expanded()).toBe(false);
  });

  it('only swipes with the main button of the first pointer', () => {
    const { handle, expanded } = sheet();
    handle.fire('pointerdown', { clientY: 300, button: 2 });
    handle.fire('pointerup', { clientY: 200 });
    expect(expanded()).toBe(false);
    handle.fire('pointerdown', { clientY: 300, isPrimary: false });
    handle.fire('pointerup', { clientY: 200 });
    expect(expanded()).toBe(false);
  });

  it('opens folded again every time, and when it shows something else', () => {
    const { handle, title, panel, changed, expanded } = sheet();
    panel.classList.remove('hidden');
    changed(panel);
    handle.fire('click');
    expect(expanded()).toBe(true);
    changed(title);
    expect(expanded()).toBe(false);
    handle.fire('click');
    panel.classList.add('hidden');
    changed(panel);
    expect(expanded()).toBe(true);
    panel.classList.remove('hidden');
    changed(panel);
    expect(expanded()).toBe(false);
  });

  it('folds on Escape only when it was pulled up, shown and in use', () => {
    let active = true;
    const { handle, panel, changed, api, expanded } = sheet({ active: () => active });
    panel.classList.remove('hidden');
    changed(panel);
    expect(api.collapse()).toBe(false);
    handle.fire('click');
    active = false;
    expect(api.collapse()).toBe(false);
    active = true;
    expect(api.collapse()).toBe(true);
    expect(expanded()).toBe(false);
  });
});

describe('onPhone', () => {
  it('is false without a browser', () => {
    expect(onPhone()).toBe(false);
  });
});
