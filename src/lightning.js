// Lightning near an airport, from the Lightning Imager on Meteosat Third Generation: EUMETSAT's
// "Accumulated Flash Area" map layer, a new image every 5 minutes (about 10 to 15 minutes behind
// real time) for everything within about 70° of 0° N, 0° E. Each image is small, a window of about
// 60 km around the airport, and its pixel colours are read back as an intensity. The layer counts
// flashes per pixel of each flash's footprint, so the numbers are not flash counts: this uses the
// area that is active and the peak intensity. From the last hour of images it finds how near the
// lightning is, whether it is getting more or less, and whether and when it reaches the airport.
// Everything but LightningMonitor's fetching runs without a browser.
//
// What the time of an image means. The layer's time is taken as the start of the 5 minute window
// the image shows, which the research for this says, but this could not be confirmed from
// EUMETSAT's product description (it only says the 5 minute product is made from 30 second
// accumulations). So the safe reading is used everywhere: an image is no newer than its stamp, so
// "data N min behind" counts from the stamp, not from the end of the window, and an arrival time
// is worked out from the stamp. Where lightning must not be missed (holding a level for 30 minutes)
// the end of the window is taken as the time it was last seen, which keeps the level longer.
//
// Contains modified EUMETSAT Meteosat data: the licence asks for it to be shown, see attribution().

import { Backoff, frameFor, parseTimes, satelliteAngle } from './meteosat.js';

const SERVICE = 'https://view.eumetsat.int/geoserver';
const LAYER = 'mtg_fd:li_afa';
export const CAPABILITIES_URL = `${SERVICE}/mtg_fd/li_afa/ows?service=WMS&version=1.3.0&request=GetCapabilities`;

export const FRAME_MS = 5 * 60_000;
// The last hour: 12 images.
export const FRAME_COUNT = 12;
// The images show this far from the airport in each direction (km), this many pixels square: a
// pixel is under a kilometre, finer than the 2 to 4 km the instrument sees in Europe.
export const HALF_KM = 60;
export const IMAGE_PX = 160;
// Distances (km) from the airport that are counted: lightning is reported within the last.
export const RING_KM = [5, 10, 20, 30];
// The images are used up to this angle from the point beneath the satellite. The service covers
// a little more (a 70° box), but a window right on its edge could be cut off.
export const COVERAGE_DEG = 69;
// The legend says 20 is as high as the colours go ("20+").
export const MAX_COUNT = 20;

const DEG = Math.PI / 180;
const KM_PER_DEG = 111.195;
const MIN = 60_000;

export const attribution = (now = Date.now()) => `Contains modified EUMETSAT Meteosat data ${new Date(now).getUTCFullYear()}`;

// Whether there are images for this place at all.
export const isCovered = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && satelliteAngle(lat, lon) <= COVERAGE_DEG;

// ---- Geometry and addresses ----

// The window of an airport: its bounding box in degrees, and what each pixel stands for.
// Pixels are about square on the ground, so the box is wider in degrees than it is tall.
export function makeGeometry(lat, lon, { halfKm = HALF_KM, size = IMAGE_PX } = {}) {
  const dLat = halfKm / KM_PER_DEG;
  const dLon = halfKm / (KM_PER_DEG * Math.cos(lat * DEG));
  const kmPerPx = (2 * halfKm) / size;
  return {
    lat,
    lon,
    halfKm,
    size,
    kmPerPx,
    pixelKm2: kmPerPx * kmPerPx,
    bbox: { south: lat - dLat, west: lon - dLon, north: lat + dLat, east: lon + dLon },
  };
}

// The address of one image at `time` (ms, the layer's time). Version 1.3.0 writes the box for
// EPSG:4326 with the latitudes first.
export function frameUrl(geometry, time) {
  const { south, west, north, east } = geometry.bbox;
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: LAYER,
    styles: '',
    crs: 'EPSG:4326',
    bbox: [south, west, north, east].map((v) => v.toFixed(5)).join(','),
    width: String(geometry.size),
    height: String(geometry.size),
    format: 'image/png',
    transparent: 'true',
    time: new Date(time).toISOString().replace('.000Z', 'Z'),
  });
  return `${SERVICE}/ows?${params}`;
}

// The times of the last `count` images, oldest first, up to the newest the layer has.
// `times` is the layer's time range ({ start, end, step }, see parseTimes). A time past the end
// is refused by the service, so none is asked for.
export function frameTimes(times, count = FRAME_COUNT) {
  const newest = frameFor(times.end, times);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = newest - i * times.step;
    if (t >= times.start) out.push(t);
  }
  return out;
}

// ---- Colours to intensities ----

// The legend's colours at counts 1 to 20 (the bar runs from 1 to 10 over its first 256 pixels and
// from 10 to 20+ over the next 230), read from its GetLegendGraphic image.
export const RAMP = [
  [1, 255, 255, 233],
  [2, 255, 244, 178],
  [3, 255, 236, 159],
  [4, 254, 227, 139],
  [5, 254, 218, 121],
  [6, 254, 202, 102],
  [7, 254, 185, 83],
  [8, 254, 168, 71],
  [9, 253, 151, 64],
  [10, 253, 131, 57],
  [11, 252, 107, 51],
  [12, 252, 82, 42],
  [13, 244, 61, 37],
  [14, 235, 43, 32],
  [15, 225, 25, 28],
  [16, 212, 15, 31],
  [17, 198, 6, 35],
  [18, 183, 0, 38],
  [19, 161, 0, 38],
  [20, 139, 0, 38],
];

const colourMatches = new Map();
// Colours kept at most; the real ones are a few hundred.
export const COLOUR_CACHE_MAX = 5000;
export const colourCacheSize = () => colourMatches.size;

// The nearest point on the ramp to a colour: { count, distance }. A colour between two steps gets a
// count between them, from 1 to MAX_COUNT; `distance` is how far (in RGB) the colour is from the
// ramp, a few units for the colours the service draws.
export function colourMatch(r, g, b, ramp = RAMP) {
  const key = (r << 16) | (g << 8) | b;
  const known = ramp === RAMP && colourMatches.get(key);
  if (known) return known;
  let best = Infinity;
  let count = 1;
  for (let i = 0; i < ramp.length - 1; i++) {
    const [c0, r0, g0, b0] = ramp[i];
    const [c1, r1, g1, b1] = ramp[i + 1];
    const dr = r1 - r0;
    const dg = g1 - g0;
    const db = b1 - b0;
    const along = ((r - r0) * dr + (g - g0) * dg + (b - b0) * db) / (dr * dr + dg * dg + db * db);
    const s = Math.min(1, Math.max(0, along));
    const d = (r - (r0 + s * dr)) ** 2 + (g - (g0 + s * dg)) ** 2 + (b - (b0 + s * db)) ** 2;
    if (d < best) {
      best = d;
      count = c0 + s * (c1 - c0);
    }
  }
  const result = { count: Math.max(1, Math.min(MAX_COUNT, Math.round(count))), distance: Math.sqrt(best) };
  if (ramp === RAMP) {
    if (colourMatches.size >= COLOUR_CACHE_MAX) colourMatches.clear();
    colourMatches.set(key, result);
  }
  return result;
}

// The intensity a colour stands for, 1 to MAX_COUNT.
export const countFromColour = (r, g, b, ramp = RAMP) => colourMatch(r, g, b, ramp).count;

// An image is only read if it looks like what the service draws: pixels either clear or fully
// opaque (a canvas that has blended or smoothed them gives other values), and the opaque ones in
// the colours of the legend.
export const FAR_COLOUR = 25;
export const MAX_FAR_SHARE = 0.1;
export function checkImage({ width, height, data }) {
  let opaque = 0;
  let far = 0;
  for (let i = 0; i < width * height; i++) {
    const alpha = data[i * 4 + 3];
    if (alpha === 0) continue;
    if (alpha !== 255) throw new Error('the lightning image has partly transparent pixels');
    opaque++;
    if (colourMatch(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]).distance > FAR_COLOUR) far++;
  }
  if (opaque >= 10 && far / opaque > MAX_FAR_SHARE) throw new Error('the lightning image is not in the legend colours');
}

// The intensities in a decoded image ({ width, height, data } with RGBA bytes, as getImageData
// gives): one per pixel, 0 where nothing is drawn.
export function countsFromImage({ width, height, data }) {
  const counts = new Uint8Array(width * height);
  for (let i = 0; i < counts.length; i++) {
    if (data[i * 4 + 3] >= 128) counts[i] = countFromColour(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  }
  return counts;
}

// ---- One image ----

export const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
// A bearing is in degrees clockwise from north, 0 to 360.
export const bearingOf = (east, north) => (((Math.atan2(east, north) / DEG) % 360) + 360) % 360;
export const compassOf = (bearing) => COMPASS[Math.round(bearing / 45) % 8];

// A patch of lightning smaller than this (km²) is taken for noise: under a third of what the
// instrument's own pixel covers over Europe.
export const MIN_CLUSTER_KM2 = 3;
// Only this many cells are kept for each image, the nearest ones.
const MAX_CELLS = 12;

const round1 = (v) => Math.round(v * 10) / 10;

// Finds what is in an image of intensities: the cells (patches of touching pixels, noise left out),
// the rings, and the nearest lightning. All positions are km east and north of the airport.
// Returns { time, activeKm2, rings, nearest, cells }:
//   rings   [{ km, areaKm2, peak }] within each of RING_KM, cumulative: the area that is active
//           and the strongest intensity in it
//   nearest { km, bearing, compass } or null
//   cells   [{ x, y, areaKm2, peak, edge, nearestKm, nearestBearing }], nearest first; x, y is
//           the middle, weighted by intensity; `edge` says the cell reaches the image's edge
export function analyseCounts(counts, size, geometry, time) {
  const { kmPerPx, pixelKm2 } = geometry;
  const half = size / 2;
  const labels = new Int32Array(size * size);
  const stats = [];
  const stack = [];
  for (let start = 0; start < counts.length; start++) {
    if (!counts[start] || labels[start]) continue;
    const id = stats.length + 1;
    const cell = { px: 0, sum: 0, peak: 0, sx: 0, sy: 0, nearest: Infinity, nx: 0, ny: 0, edge: false };
    stats.push(cell);
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      const col = i % size;
      const row = (i - col) / size;
      const x = (col + 0.5 - half) * kmPerPx;
      const y = (half - row - 0.5) * kmPerPx;
      const c = counts[i];
      const d = Math.hypot(x, y);
      cell.px++;
      cell.sum += c;
      cell.peak = Math.max(cell.peak, c);
      cell.sx += x * c;
      cell.sy += y * c;
      if (col === 0 || row === 0 || col === size - 1 || row === size - 1) cell.edge = true;
      if (d < cell.nearest) Object.assign(cell, { nearest: d, nx: x, ny: y });
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r2 = row + dr;
          const c2 = col + dc;
          if (r2 < 0 || c2 < 0 || r2 >= size || c2 >= size) continue;
          const j = r2 * size + c2;
          if (counts[j] && !labels[j]) {
            labels[j] = id;
            stack.push(j);
          }
        }
      }
    }
  }
  const keep = stats.map((s) => s.px * pixelKm2 >= MIN_CLUSTER_KM2);
  const rings = RING_KM.map((km) => ({ km, px: 0, peak: 0 }));
  let px = 0;
  for (let i = 0; i < counts.length; i++) {
    const id = labels[i];
    if (!id || !keep[id - 1]) continue;
    const col = i % size;
    const d = Math.hypot((col + 0.5 - half) * kmPerPx, (half - (i - col) / size - 0.5) * kmPerPx);
    px++;
    for (const ring of rings) {
      if (d > ring.km) continue;
      ring.px++;
      ring.peak = Math.max(ring.peak, counts[i]);
    }
  }
  const cells = stats
    .filter((s, i) => keep[i])
    .map((s) => ({
      x: round1(s.sx / s.sum),
      y: round1(s.sy / s.sum),
      areaKm2: round1(s.px * pixelKm2),
      peak: s.peak,
      edge: s.edge,
      nearestKm: round1(s.nearest),
      nearestBearing: Math.round(bearingOf(s.nx, s.ny)),
    }))
    .sort((a, b) => a.nearestKm - b.nearestKm)
    .slice(0, MAX_CELLS);
  const near = cells[0];
  return {
    time,
    activeKm2: round1(px * pixelKm2),
    rings: rings.map((r) => ({ km: r.km, areaKm2: round1(r.px * pixelKm2), peak: r.peak })),
    nearest: near ? { km: near.nearestKm, bearing: near.nearestBearing, compass: compassOf(near.nearestBearing) } : null,
    cells,
  };
}

// analyseCounts for a decoded image, which must look like what the service draws (see checkImage).
// The window is taken from the image, not asked for: a service that sent another size would
// otherwise be read with the wrong scale.
export function analyseImage(image, geometry, time) {
  if (image.width !== image.height) throw new Error('lightning image is not square');
  checkImage(image);
  const size = image.width;
  const g = size === geometry.size ? geometry : makeGeometry(geometry.lat, geometry.lon, { halfKm: geometry.halfKm, size });
  return analyseCounts(countsFromImage(image), size, g, time);
}

// ---- Trend ----

// Active area (km²) within the outer ring has to change by at least this much for a trend: about
// three pixels of the instrument's own grid over Europe, so that one stray flash is not a trend.
export const MIN_TREND_KM2 = 30;

// Whether the active area within the outer ring has become more or less over the last `minutes`,
// comparing the older half of the images in that time with the newer half: 'rising', 'steady',
// 'falling', 'none' when there was none at all, or 'unknown' when fewer than three quarters of
// the images in that time are there. A change smaller than MIN_TREND_KM2 is 'steady', also from
// or to nothing.
// `frames` are analysed images, oldest first.
export function trendOf(frames, minutes) {
  if (!frames.length) return 'unknown';
  const wanted = Math.round(minutes / (FRAME_MS / MIN));
  const newest = frames.at(-1).time;
  const inSpan = frames.filter((f) => f.time > newest - minutes * MIN);
  if (inSpan.length < Math.ceil(wanted * 0.75) || inSpan.length < 2) return 'unknown';
  const value = (f) => f.rings.at(-1).areaKm2;
  const middle = Math.floor(inSpan.length / 2);
  const mean = (list) => list.reduce((a, f) => a + value(f), 0) / list.length;
  const older = mean(inSpan.slice(0, middle));
  const newer = mean(inSpan.slice(middle));
  if (!older && !newer) return 'none';
  if (newer >= older * 1.4 && newer - older >= MIN_TREND_KM2) return 'rising';
  if (newer <= older / 1.4 && older - newer >= MIN_TREND_KM2) return 'falling';
  return 'steady';
}

// ---- Movement ----

// A cell is looked for this far (km) from where it was a frame before, per 5 minutes: storms
// move up to about 100 km/h, and the middle of a patch of lightning moves about as well.
export const MAX_JUMP_KM = 10;
// A cell is only followed if it can be seen in at least this many images over at least this many
// minutes, has moved at least this far (km) in that time, and its speed is known well enough: the
// standard error of the fitted speed may be at most this share of the speed.
export const MIN_TRACK_POINTS = 5;
export const MIN_TRACK_MIN = 20;
export const MIN_DISPLACEMENT_KM = 6;
export const MAX_SPEED_ERROR = 0.3;
// Slower than this a storm counts as staying where it is, faster than the maximum is no storm.
export const MIN_MOVE_KMH = 10;
export const MAX_MOVE_KMH = 120;
// A merged area bigger than this (km²), or one that runs off the image, has no middle to follow.
export const MAX_CELL_KM2 = 2000;
// A cell in the image before is the same one if its area is within this factor, and no other cell
// is nearly as near to where it was: with two near candidates the track ends rather than guesses.
export const MAX_AREA_RATIO = 3;
export const AMBIGUOUS_RATIO = 2;
// No time is given for lightning that would take longer to arrive.
export const MAX_ETA_MIN = 60;
// Data older than this (minutes since its stamp) is too old to say when anything arrives, or that
// there is none.
export const STALE_MIN = 30;
// How far back a cell is followed.
const TRACK_FRAMES = 6;

const unfit = (cell) => cell.areaKm2 > MAX_CELL_KM2 || cell.edge;

// The cell of the newest frame that is nearest the airport, followed back through earlier frames:
// [{ t, x, y, areaKm2, edge }] with t in minutes before the newest (so 0 or less), newest last. A
// frame with nothing near enough to where the cell was is skipped, but a gap longer than two
// frames ends it, as does a frame where the cell could be either of two cells, or has changed its
// size by more than MAX_AREA_RATIO.
export function followCell(frames) {
  const last = frames.at(-1);
  const start = last?.cells[0];
  if (!start) return [];
  const point = (t, cell) => ({ t, x: cell.x, y: cell.y, areaKm2: cell.areaKm2, edge: Boolean(cell.edge) });
  const points = [point(0, start)];
  let at = last.time;
  let prev = start;
  for (let i = frames.length - 2; i >= 0 && frames.length - 1 - i <= TRACK_FRAMES; i--) {
    const frame = frames[i];
    const gap = (at - frame.time) / FRAME_MS;
    if (gap > 2) break;
    const reach = MAX_JUMP_KM * gap;
    const near = frame.cells
      .map((cell) => ({ cell, d: Math.hypot(cell.x - prev.x, cell.y - prev.y) }))
      .filter((c) => c.d <= reach)
      .sort((a, b) => a.d - b.d);
    if (!near.length) continue;
    if (near.length > 1 && near[1].d < near[0].d * AMBIGUOUS_RATIO) break;
    const best = near[0].cell;
    const ratio = best.areaKm2 / prev.areaKm2;
    if (ratio > MAX_AREA_RATIO || ratio < 1 / MAX_AREA_RATIO) break;
    points.unshift(point((frame.time - last.time) / MIN, best));
    at = frame.time;
    prev = best;
  }
  return points;
}

// A straight line through the points over time: { vx, vy } in km per minute, the root mean square
// of how far the points lie from it (km), and `speedError`, the standard error of the speed (km per
// minute; 0 when the points lie on the line, Infinity with fewer than three).
export function fitTrack(points) {
  const n = points.length;
  const mean = (f) => points.reduce((a, p) => a + f(p), 0) / n;
  const tBar = mean((p) => p.t);
  const xBar = mean((p) => p.x);
  const yBar = mean((p) => p.y);
  const stt = points.reduce((a, p) => a + (p.t - tBar) ** 2, 0);
  const vx = points.reduce((a, p) => a + (p.t - tBar) * (p.x - xBar), 0) / stt;
  const vy = points.reduce((a, p) => a + (p.t - tBar) * (p.y - yBar), 0) / stt;
  const rssX = points.reduce((a, p) => a + (p.x - (xBar + vx * (p.t - tBar))) ** 2, 0);
  const rssY = points.reduce((a, p) => a + (p.y - (yBar + vy * (p.t - tBar))) ** 2, 0);
  const seX = n > 2 ? Math.sqrt(rssX / (n - 2) / stt) : Infinity;
  const seY = n > 2 ? Math.sqrt(rssY / (n - 2) / stt) : Infinity;
  const speed = Math.hypot(vx, vy);
  // The error of the length of (vx, vy), from the errors of its parts.
  const speedError = speed > 0 ? Math.hypot(vx * seX, vy * seY) / speed : Math.hypot(seX, seY);
  return { vx, vy, rms: Math.sqrt((rssX + rssY) / n), speedError };
}

const unclear = (reason) => ({ state: 'unclear', speedKmh: null, headingDeg: null, etaMin: null, closestKm: null, reason });

// Whether the nearest cell of the newest frame comes towards the airport, and when its edge would
// reach `ringKm`. `frames` are analysed images, oldest first; `behindMin` is how old the newest is
// (minutes since its stamp, see the top), which is taken off the time to arrive.
// Returns { state, speedKmh, headingDeg, etaMin, closestKm, reason } where state is
//   'none'        no lightning near enough in the newest image
//   'approaching' reaches ringKm in etaMin minutes from now (0: it has, and is still coming)
//   'passing'     comes closer but not as close as ringKm; closestKm is how near it gets
//   'receding'    moving away
//   'stationary'  hardly moving
//   'unclear'     no steady track to go by: nothing is guessed, `reason` says why
export function estimateMotion(frames, { ringKm = RING_KM[0], behindMin = 0 } = {}) {
  const last = frames.at(-1);
  if (!last?.cells.length) return { state: 'none', speedKmh: null, headingDeg: null, etaMin: null, closestKm: null, reason: 'No lightning in the newest image.' };
  if (behindMin > STALE_MIN) return unclear(`The data is ${Math.round(behindMin)} minutes old.`);
  if (unfit(last.cells[0])) return unclear('The lightning is one large area, or runs off the image: its middle says nothing about where it goes.');
  const points = followCell(frames);
  if (points.length < MIN_TRACK_POINTS || -points[0].t < MIN_TRACK_MIN) return unclear('Too little history to follow the cell.');
  if (points.some(unfit)) return unclear('The cell has been too large, or at the edge of the image, to follow.');
  const { vx, vy, rms, speedError } = fitTrack(points);
  const speedKmh = Math.hypot(vx, vy) * 60;
  const headingDeg = Math.round(bearingOf(vx, vy));
  const span = -points[0].t;
  const out = { speedKmh: Math.round(speedKmh), headingDeg, etaMin: null, closestKm: null, reason: '' };
  if (speedKmh > MAX_MOVE_KMH) return unclear('The movement is too fast to be a storm.');
  if (speedKmh < MIN_MOVE_KMH) {
    if (rms > 3) return unclear('The cell jumps about without a direction.');
    return { ...out, headingDeg: null, state: 'stationary', reason: 'The cell is hardly moving.' };
  }
  if (rms > Math.max(2, 0.25 * speedKmh * (span / 60))) return unclear('The cell does not move steadily.');
  if (speedKmh * (span / 60) < MIN_DISPLACEMENT_KM) return unclear('The cell has hardly moved from where it was.');
  if (speedError * 60 > MAX_SPEED_ERROR * speedKmh) return unclear('The speed of the cell is too uncertain.');
  // The cell's middle is followed, and its nearest edge is taken to stay that far ahead of it.
  const cell = last.cells[0];
  const px = cell.x;
  const py = cell.y;
  const d0 = Math.hypot(px, py);
  const edge = Math.max(0, d0 - cell.nearestKm);
  const reach = ringKm + edge;
  const dot = px * vx + py * vy;
  const speed2 = vx * vx + vy * vy;
  if (dot >= 0) return { ...out, state: 'receding', reason: 'The cell is moving away.' };
  const tClosest = -dot / speed2;
  const closestKm = Math.max(0, Math.hypot(px + vx * tClosest, py + vy * tClosest) - edge);
  if (d0 <= reach) return { ...out, state: 'approaching', etaMin: 0, closestKm: round1(closestKm), reason: 'The cell is within the ring and still coming closer.' };
  const a = speed2;
  const b = 2 * dot;
  const c = d0 * d0 - reach * reach;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return { ...out, state: 'passing', closestKm: round1(closestKm), reason: 'The cell comes closer but passes by.' };
  const tReach = (-b - Math.sqrt(disc)) / (2 * a);
  // `tReach` counts from the newest image's time, and the data is `behindMin` old.
  const etaMin = Math.max(0, tReach - behindMin);
  return { ...out, state: 'approaching', etaMin: Math.round(etaMin * 10) / 10, closestKm: round1(closestKm), reason: 'The cell moves steadily towards the airport.' };
}

// ---- The result ----

export const LEVELS = ['none', 'distant', 'near', 'close', 'overhead'];
// How near the nearest lightning is: within 5 km 'overhead', 10 'close', 20 'near', 30 'distant'.
export function levelOf(km) {
  if (km == null) return 'none';
  return km <= RING_KM[0] ? 'overhead' : km <= RING_KM[1] ? 'close' : km <= RING_KM[2] ? 'near' : km <= RING_KM[3] ? 'distant' : 'none';
}
const worse = (a, b) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);

export const clock = (ms, timeZone) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });

// "~20 min", rounded to 5, with "<5 min" and ">60 min" at the ends.
export function minutesText(min) {
  if (min < 5) return '<5 min';
  if (min > MAX_ETA_MIN) return `>${MAX_ETA_MIN} min`;
  return `~${Math.round(min / 5) * 5} min`;
}

// After lightning within the outer ring the level stays where it was until this long (minutes)
// after the last lightning was seen, as is usual for ramp and outdoor work. The images are 5
// minute windows, flickering from one to the next, so one empty image clears nothing.
export const HOLD_MIN = 30;

// Everything the Ops tab shows, from the analysed images (oldest first, not empty) at `now` (ms).
// `timeZone` is for the times written out, the browser's own when left out.
// `status.level` is 'none', 'distant', 'near', 'close' or 'overhead', and 'unknown' for old data,
// which says nothing, not even that there is none.
export function summarise(frames, { geometry, now = Date.now(), timeZone } = {}) {
  const outer = RING_KM.at(-1);
  const last = frames.at(-1);
  // From the stamp: the safe reading, see the top.
  const age = Math.max(0, (now - last.time) / MIN);
  const behindMin = Math.round(age);
  const stale = age > STALE_MIN;
  const nearest = last.nearest;
  const motion = estimateMotion(frames, { behindMin: age });
  const trend = { min30: trendOf(frames, 30), min60: trendOf(frames, 60) };
  const dataText = `as of ${clock(last.time, timeZone)}, data ${behindMin} min behind`;
  // The last lightning within the outer ring: the time it was last seen is taken as the end of the
  // window it was in (see the top), and the level of the hold is the nearest within the hold.
  const within = (f) => f.nearest && f.nearest.km <= outer;
  const seenAgo = (f) => Math.max(0, (now - f.time - FRAME_MS) / MIN);
  const recent = frames.filter((f) => within(f) && seenAgo(f) <= HOLD_MIN);
  const nearestSeen = recent.reduce((best, f) => (!best || f.nearest.km <= best.nearest.km ? f : best), null);
  const held = recent.length ? { km: nearestSeen.nearest.km, minAgo: seenAgo(recent.at(-1)), nearestMinAgo: seenAgo(nearestSeen) } : null;
  const heldLevel = levelOf(held?.km);
  const current = within(last) ? levelOf(nearest.km) : 'none';
  const level = stale ? 'unknown' : worse(current, heldLevel);
  const agoText = (min) => `${minutesText(min).replace(/^~/, '')} ago`;
  let text;
  let detail = '';
  // What the level is held for, when it is held at something worse than the lightning now.
  let hold = '';
  if (stale) {
    text = `Lightning data ${behindMin} min old`;
    detail = 'No newer images could be had, so this says nothing of the lightning now.';
  } else if (within(last)) {
    const where = nearest.km <= RING_KM[0] ? `within ${RING_KM[0]} km` : `${Math.round(nearest.km)} km ${nearest.compass}`;
    const how = {
      approaching: motion.etaMin ? `approaching, ${minutesText(motion.etaMin)}` : 'approaching',
      passing: 'passing by',
      receding: 'moving away',
      stationary: 'nearly stationary',
      unclear: 'movement unclear',
      none: 'movement unclear',
    }[motion.state];
    text = `Lightning ${where}, ${how}`;
    if (motion.state === 'approaching' && motion.etaMin) {
      detail = `Expected within ${RING_KM[0]} km at about ${clock(now + motion.etaMin * MIN, timeZone)}, moving ${compassOf(motion.headingDeg)} at ${motion.speedKmh} km/h.`;
    } else if (motion.state === 'passing') detail = `Closest about ${Math.round(motion.closestKm)} km, moving ${compassOf(motion.headingDeg)} at ${motion.speedKmh} km/h.`;
    else if (motion.state === 'unclear') detail = motion.reason;
    if (LEVELS.indexOf(heldLevel) > LEVELS.indexOf(current)) hold = `Lightning was within ${Math.round(held.km)} km ${agoText(held.nearestMinAgo)}, so the level stays until ${HOLD_MIN} minutes after the last lightning that near.`;
  } else if (held) {
    text = `No lightning within ${outer} km now, last lightning ${agoText(held.minAgo)}`;
    hold = `Kept as a warning until ${HOLD_MIN} minutes after the last lightning: within ${Math.round(held.km)} km.`;
  } else {
    text = `No lightning within ${outer} km`;
    const before = [...frames].reverse().find(within);
    if (before) text += `, last lightning ${agoText(seenAgo(before))}`;
  }
  return {
    state: 'ok',
    geometry: geometry && { lat: geometry.lat, lon: geometry.lon },
    newestFrame: last.time,
    asOf: last.time,
    behindMin,
    stale,
    frames,
    nearest,
    rings: last.rings,
    trend,
    motion,
    held,
    status: { level, text, detail, hold, dataText },
    attribution: attribution(now),
  };
}

// The result for a place the images do not cover.
export function uncovered(lat, lon, now = Date.now()) {
  return {
    state: 'uncovered',
    geometry: { lat, lon },
    frames: [],
    nearest: null,
    status: { level: 'unknown', text: 'Lightning: not covered here', hold: '', detail: 'The lightning images cover Europe, Africa and the Atlantic, within about 70° of 0° N, 0° E.', dataText: '' },
    attribution: attribution(now),
  };
}

// The result while there is nothing to go by yet or the images could not be fetched.
export function unavailable(lat, lon, problem, now = Date.now()) {
  return {
    state: 'unavailable',
    geometry: { lat, lon },
    frames: [],
    nearest: null,
    problem,
    status: { level: 'unknown', text: 'Lightning data unavailable', detail: problem ?? '', hold: '', dataText: '' },
    attribution: attribution(now),
  };
}

// ---- Forecast stand-in ----

// A word for the risk of thunderstorms in the next `hours` hours from the hourly forecast, for when
// there is no lightning data (or none for the place). `hourly` has the forecast's arrays, each with
// an entry per hour: `time` (ms, or text in GMT as the forecast writes it), `weather_code` (95 to
// 99 are thunderstorms) and `cape` (J/kg). Either may be missing.
// Returns { level, word, text, firstHour }: level 'none', 'low', 'moderate' or 'high', or
// 'unknown' when the forecast has no hour in the time; firstHour the first hour (ms) at moderate
// or above, or null.
export const RISK_WORDS = { none: 'unlikely', low: 'possible', moderate: 'likely', high: 'forecast' };

// Showers and rain: with a lot of CAPE they are what a thunderstorm grows from.
const WET_CODES = new Set([61, 63, 65, 66, 67, 80, 81, 82, 85, 86]);

// CAPE alone is only 'possible': 'likely' needs the forecast's weather to be wet as well.
export function hourRisk(code, cape) {
  if (code >= 95 && code <= 99) return 'high';
  if (cape >= 1000 && WET_CODES.has(code)) return 'moderate';
  if (cape >= 500) return 'low';
  return 'none';
}

const toMs = (t) => (typeof t === 'number' ? t : Date.parse(/Z|[+-]\d\d:?\d\d$/.test(t) ? t : `${t}Z`));

export function thunderstormRisk(hourly, { now = Date.now(), hours = 6, timeZone } = {}) {
  const times = hourly?.time ?? [];
  const rank = { none: 0, low: 1, moderate: 2, high: 3 };
  let level = 'none';
  let firstHour = null;
  let seen = 0;
  for (let i = 0; i < times.length; i++) {
    const t = toMs(times[i]);
    // The hour in progress counts.
    if (!Number.isFinite(t) || t + 3_600_000 <= now || t >= now + hours * 3_600_000) continue;
    seen++;
    const risk = hourRisk(hourly.weather_code?.[i], hourly.cape?.[i]);
    if (rank[risk] > rank[level]) level = risk;
    if (rank[risk] >= 2 && firstHour == null) firstHour = t;
  }
  if (!seen) return { level: 'unknown', word: 'unknown', text: 'No forecast for the next hours', firstHour: null };
  const word = RISK_WORDS[level];
  const text = level === 'none' ? `Thunderstorms ${word} in the next ${hours} h` : firstHour != null && firstHour > now ? `Thunderstorms ${word}, from ${clock(firstHour, timeZone)}` : `Thunderstorms ${word}`;
  return { level, word, text, firstHour };
}

// ---- Fetching and polling ----

export const POLL_MS = FRAME_MS;
const TIMEOUT_MS = 20_000;
// Images older than this (ms since their stamp) are let go at every refresh, successful or not: a
// full hour of images, which come about 15 minutes behind, and a little more.
export const KEEP_MS = (FRAME_COUNT * FRAME_MS) + 20 * MIN;

// A decoded image ({ width, height, data }) from a PNG blob, in a browser. The image is not to be
// changed on its way to the canvas: no premultiplied alpha, no colour conversion.
export async function decodeBlob(blob) {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = typeof OffscreenCanvas === 'undefined' ? Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height }) : new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  // Its size is read before it is closed, which empties it.
  const { width, height } = bitmap;
  bitmap.close?.();
  return { width, height, data };
}

const fetchText = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

// A time past the layer's newest, or any other mistake, comes back as an XML error and not an image.
export const loadFrameImage = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok || !/^image\/png/.test(res.headers.get('content-type') ?? '')) throw new Error(`HTTP ${res.status}`);
  return decodeBlob(await res.blob());
};

const keyOf = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

// Keeps the lightning picture of one airport up to date while it is wanted: `start(airport)` loads
// the last hour of images and then looks again every 5 minutes, `stop()` ends that and nothing
// more is fetched until the next start. Analysed images are kept by time for the last few airports
// (a frame is fetched once, and a return to an airport only asks for what is new), and those older
// than an hour are dropped at every refresh. After a failure it waits, 30 seconds at first and up
// to 5 minutes, before trying again.
// `onUpdate(result)` gets a result (see summarise, uncovered, unavailable) after each attempt.
// `fetchText(url)` and `loadImage(url)` (to { width, height, data }) can be replaced for tests.
export class LightningMonitor {
  constructor({ fetchText: ft = fetchText, loadImage: li = loadFrameImage, now = Date.now, onUpdate = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, maxAirports = 4, timeZone, backoff = new Backoff({ first: 30_000, max: 300_000 }) } = {}) {
    // The timers are called as plain functions: in a browser they must not be called as methods.
    Object.assign(this, { fetchText: ft, loadImage: li, now, onUpdate, setTimer: (fn, ms) => setTimer(fn, ms), clearTimer: (timer) => clearTimer(timer), maxAirports, timeZone, backoff });
    this.cache = new Map();
    this.airport = null;
    this.timer = null;
    this.running = 0;
    this.result = null;
  }

  // Starts, or moves to another airport: `{ lat, lon }`. Returns the first result, which comes
  // from the cache or the service, or at once for a place the images do not cover.
  start(airport) {
    this.stop();
    this.airport = { lat: airport.lat, lon: airport.lon };
    if (!isCovered(airport.lat, airport.lon)) {
      this.result = uncovered(airport.lat, airport.lon, this.now());
      this.onUpdate(this.result);
      return Promise.resolve(this.result);
    }
    return this.refresh();
  }

  stop() {
    this.airport = null;
    this.running++;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  // The frames kept for an airport, newest use last.
  entry(geometry) {
    const key = keyOf(geometry.lat, geometry.lon);
    let entry = this.cache.get(key);
    if (entry) this.cache.delete(key);
    else entry = new Map();
    this.cache.set(key, entry);
    while (this.cache.size > this.maxAirports) this.cache.delete(this.cache.keys().next().value);
    return entry;
  }

  async refresh() {
    const airport = this.airport;
    if (!airport) return this.result;
    const run = ++this.running;
    const geometry = makeGeometry(airport.lat, airport.lon);
    const frames = this.entry(geometry);
    let ok = false;
    let problem = null;
    try {
      const times = parseTimes(await this.fetchText(CAPABILITIES_URL));
      if (!times) throw new Error('no time range');
      // Stopped while the time range was loading: no images are asked for.
      if (run !== this.running) return this.result;
      const wanted = frameTimes(times);
      for (const t of frames.keys()) if (!wanted.includes(t)) frames.delete(t);
      const missing = wanted.filter((t) => !frames.has(t));
      const loaded = await Promise.allSettled(
        missing.map(async (t) => {
          const frame = analyseImage(await this.loadImage(frameUrl(geometry, t)), geometry, t);
          // Stopped, or moved on, while this was loading.
          if (run === this.running) frames.set(t, frame);
        }),
      );
      ok = loaded.every((r) => r.status === 'fulfilled') || frames.has(wanted.at(-1));
      if (!ok) problem = 'The newest lightning image could not be fetched.';
    } catch (error) {
      problem = `Lightning data could not be fetched (${error.message}).`;
    }
    // Stopped or moved while waiting: whatever was fetched is kept, but nobody asked for a result.
    if (run !== this.running) return this.result;
    const now = this.now();
    if (ok) this.backoff.succeed();
    else this.backoff.fail(now);
    // Whatever happened, nothing older than an hour is kept to be read as the present.
    for (const t of frames.keys()) if (now - t > KEEP_MS) frames.delete(t);
    const list = [...frames.values()].sort((a, b) => a.time - b.time);
    this.result = list.length ? { ...summarise(list, { geometry, now, timeZone: this.timeZone }), problem } : unavailable(airport.lat, airport.lon, problem, now);
    this.timer = this.setTimer(() => this.refresh(), ok ? POLL_MS : Math.max(this.backoff.wait(now), 1000));
    this.onUpdate(this.result);
    return this.result;
  }
}
