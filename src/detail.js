// Zoomed-in detail: which part of the globe is in view, and the finer grid to fetch for it.

const DEG = Math.PI / 180;
// Below this camera altitude (in globe radii) the view switches to regional detail.
export const DETAIL_ALTITUDE = 1.1;
// Locations per regional request: keeps panning well within the free API's 600 per minute.
const MAX_POINTS = 200;
const NICE_STEPS = [0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20];

// Area of the globe in view, with a margin, for camera `pov` and viewport `aspect` (w/h).
// The camera's vertical field of view shows roughly 53° of latitude per globe radius of altitude.
export function viewBounds({ lat, lng, altitude }, aspect = 1) {
  const latSpan = Math.min(100, 70 * altitude + 1);
  const south = Math.max(-85, lat - latSpan / 2);
  const north = Math.min(85, lat + latSpan / 2);
  const cos = Math.max(0.2, Math.cos(lat * DEG));
  const span = Math.min(300, (latSpan * Math.max(0.6, aspect)) / cos);
  return { south, north, west: lng - span / 2, span };
}

// A regional grid covering `bounds` with at most MAX_POINTS locations, snapped to its step so
// nearby views share the same grid (and cache entry). Returns the grid shape and the exact
// area it covers.
export function regionFor(bounds) {
  const latSpan = bounds.north - bounds.south;
  let k = NICE_STEPS.findIndex((s) => s >= latSpan / 10);
  if (k < 0) k = NICE_STEPS.length - 1;
  for (; ; k++) {
    const step = NICE_STEPS[Math.min(k, NICE_STEPS.length - 1)];
    const lat0 = Math.max(-84, Math.floor(bounds.south / step) * step);
    const lng0 = Math.floor(bounds.west / step) * step;
    const rows = Math.ceil((Math.min(84, bounds.north) - lat0) / step) + 1;
    const cols = Math.ceil((bounds.west + bounds.span - lng0) / step) + 1;
    if (rows * cols <= MAX_POINTS || k >= NICE_STEPS.length - 1) {
      const shape = { step, lat0, lng0, rows, cols, wrap: false };
      return {
        shape,
        bounds: { south: lat0, north: lat0 + (rows - 1) * step, west: lng0, span: (cols - 1) * step },
      };
    }
  }
}

// Whether the camera has moved far enough from `region` (or zoomed in or out enough) that
// the detail should follow it.
export function needsNewRegion(region, pov, aspect = 1) {
  if (!region) return true;
  const want = viewBounds(pov, aspect);
  const { south, north, west, span } = region.bounds;
  const latSpan = north - south;
  const zoom = (want.north - want.south) / latSpan;
  if (zoom < 0.5 || zoom > 1.25) return true;
  const y = (pov.lat - south) / latSpan;
  const x = ((((pov.lng - west) % 360) + 360) % 360) / span;
  const nearPole = south <= -80 || north >= 80;
  return x < 0.3 || x > 0.7 || (!nearPole && (y < 0.3 || y > 0.7));
}
