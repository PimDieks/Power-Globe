// Moving clouds over Europe and Africa: EUMETSAT's Meteosat Third Generation "Geo Colour" images,
// a new one every 10 minutes from a satellite above 0° longitude, as Web Mercator map tiles cut
// from its map service. Clouds by day, and clouds over a dark Earth with city lights by night.
// Everything here runs without a browser; the layer that draws the tiles is in map.js.

const SERVICE = 'https://view.eumetsat.int/geoserver';
const LAYER = 'mtg_fd:rgb_geocolour';
// The layer's own capabilities: a few kilobytes, where the whole service's are megabytes.
export const CAPABILITIES_URL = `${SERVICE}/mtg_fd/rgb_geocolour/ows?service=WMS&version=1.3.0&request=GetCapabilities`;

// Images are used up to this angle from the point beneath the satellite (0° N, 0° E), fading out
// into the daily imagery from FADE_FROM_DEG. Further out the disk is seen so obliquely that it
// looks stretched and smeared.
export const FADE_FROM_DEG = 54;
export const AREA_DEG = 62;
// Each image is this many pixels square, for a tile one level coarser than the map's: the same
// detail as the map's own tiles in a quarter of the requests.
export const TILE_PIXELS = 512;
// The finest tile level asked for. 512 pixels at level 6 are about 1.2 km each at the equator and
// 0.8 km in central Europe, already finer than the images themselves (about 1 to 2 km).
export const MAX_LEVEL = 6;
// The finest level of the map's own tiles the images are shown over (a 512 pixel image covers
// four tiles of the next level). Closer in, the map's own tiles show instead.
export const MAP_LEVEL_LIMIT = MAX_LEVEL + 1;

const EARTH_HALF = 20037508.342789244;
const DEG = Math.PI / 180;

// The Web Mercator bounds (metres) of tile x, y at `level`: [minX, minY, maxX, maxY].
export function tileBbox(x, y, level) {
  const size = (2 * EARTH_HALF) / 2 ** level;
  const minX = -EARTH_HALF + x * size;
  const maxY = EARTH_HALF - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

const tileLat = (y, level) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** level))) / DEG;

// The tile's edges in degrees: { west, east, south, north }.
export function tileBounds(x, y, level) {
  const n = 2 ** level;
  return { west: (x / n) * 360 - 180, east: ((x + 1) / n) * 360 - 180, south: tileLat(y + 1, level), north: tileLat(y, level) };
}

// The angle (degrees) from the point beneath the satellite to `lat`, `lng`.
export const satelliteAngle = (lat, lng) => Math.acos(Math.cos(lat * DEG) * Math.cos(lng * DEG)) / DEG;

// The smallest angle from the point beneath the satellite to any part of the tile.
export function tileAngle(x, y, level) {
  const { west, east, south, north } = tileBounds(x, y, level);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return satelliteAngle(clamp(0, south, north), clamp(0, west, east));
}

// Tiles at `level` with some part inside the area the images cover, and some part in view:
// `inView(lat, lng)` says whether a point is. A 5 by 5 grid of points across each tile is checked,
// enough while a tile is less than four times the screen's size across (they are about half).
export function tilesInView(level, inView) {
  const n = 2 ** level;
  const tiles = [];
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      if (tileAngle(x, y, level) >= AREA_DEG) continue;
      const { west, east, south, north } = tileBounds(x, y, level);
      let seen = false;
      for (let i = 0; i < 5 && !seen; i++) {
        for (let j = 0; j < 5 && !seen; j++) {
          seen = inView(south + ((north - south) * i) / 4, west + ((east - west) * j) / 4);
        }
      }
      if (seen) tiles.push({ x, y });
    }
  }
  return tiles;
}

// The times images exist for, from the time dimension in the capabilities, written as
// "start/end/PT10M". Returns { start, end, step } in milliseconds, or null.
export function parseTimes(xml) {
  const match = /<Dimension[^>]*name="time"[^>]*>\s*([^<\s]+)\s*</.exec(xml);
  const parts = match?.[1].split('/');
  if (parts?.length !== 3) return null;
  const [start, end] = parts.slice(0, 2).map(Date.parse);
  const period = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(parts[2]);
  const step = period ? ((Number(period[1] ?? 0) * 60 + Number(period[2] ?? 0)) * 60_000) : 0;
  if (!Number.isFinite(start) || !Number.isFinite(end) || !step || end < start) return null;
  return { start, end, step };
}

// The image nearest to `time` (ms), or the first or last there is outside their range. A time
// outside the range is refused by the service rather than moved to the nearest image.
export function frameFor(time, { start, end, step }) {
  const nearest = start + Math.round((time - start) / step) * step;
  return Math.min(end, Math.max(start, nearest));
}

// The images for `time` and the times after it (`ahead`), without repeats: in the forecast part
// of the timeline they are all the newest image.
export function framesFor(time, ahead, times) {
  return [...new Set([time, ...ahead].map((t) => frameFor(t, times)))];
}

// While the timeline plays faster than images load, it passes images that were asked for as ones
// ahead before they are ready. Of `asked`, those after the image on show (`shown`, or null) and
// before the wanted one, latest first and at most `max`: they go on loading, and the latest that
// is ready shows while the wanted one is not, so the clouds keep moving.
export function passedFrames(asked, wanted, shown, max = 2) {
  const after = shown ?? -Infinity;
  return [...new Set(asked)]
    .filter((frame) => frame < wanted && frame > after)
    .sort((a, b) => b - a)
    .slice(0, max);
}

// The address of one tile's image at `frame` (ms).
export function tileUrl(x, y, level, frame) {
  const params = new URLSearchParams({
    service: 'WMS',
    version: '1.3.0',
    request: 'GetMap',
    layers: LAYER,
    styles: '',
    crs: 'EPSG:3857',
    bbox: tileBbox(x, y, level).join(','),
    width: String(TILE_PIXELS),
    height: String(TILE_PIXELS),
    format: 'image/jpeg',
    time: new Date(frame).toISOString().replace('.000Z', 'Z'),
  });
  return `${SERVICE}/ows?${params}`;
}

// A pause after failures: 5 seconds after the first, doubling up to two minutes, and gone after a
// success. Failures during a pause, such as the other requests sent along with the one that failed
// first, do not make it longer: only one after the pause has ended does.
export class Backoff {
  constructor({ first = 5000, max = 120_000 } = {}) {
    Object.assign(this, { first, max, delay: 0, until: 0 });
  }

  fail(now) {
    if (this.delay && now < this.until) return;
    this.delay = this.delay ? Math.min(this.max, this.delay * 2) : this.first;
    this.until = now + this.delay;
  }

  succeed() {
    this.delay = 0;
    this.until = 0;
  }

  // Milliseconds left to wait, 0 when requests may go ahead.
  wait(now) {
    return Math.max(0, this.until - now);
  }
}

// A tile that failed this many times is not asked for again while it is kept.
export const MAX_ATTEMPTS = 3;

// Loaded tile images by key, with a bounded number kept and a bounded number loading at once.
// `want(jobs)` names the tiles needed now, most urgent first, as [{ key, url }]: tiles not yet
// loaded are queued, each once, and anything queued but no longer wanted is dropped. `get(key)`
// gives { state: 'loading' | 'done' | 'failed', value, failures }. After a failure nothing new
// starts until the back-off has passed, then one at a time until one loads; a failed tile is asked
// for again only once its own pause has passed, and at most MAX_ATTEMPTS times in all. `onSettle()`
// is called after every load that ends and when a pause is over. The least recently used entries
// beyond `max` are dropped, except wanted ones, loading ones and those `inUse(key)`. A 512 pixel
// image takes about 1 MB once decoded, hence the modest default.
export class TileStore {
  constructor({ load, max = 100, concurrency = 6, backoff = new Backoff(), now = Date.now, onSettle = () => {}, inUse = () => false, dispose = () => {} }) {
    Object.assign(this, { load, max, concurrency, backoff, now, onSettle, inUse, dispose });
    this.entries = new Map();
    this.queue = [];
    this.wanted = new Set();
    this.loading = 0;
    this.timer = null;
    this.timerDue = 0;
  }

  get(key) {
    const entry = this.entries.get(key);
    if (entry) {
      // Most recently used last.
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  // Whether the tile should be asked for now: not had yet, or failed and due again.
  due(key, now) {
    const entry = this.entries.get(key);
    return !entry || (entry.state === 'failed' && entry.failures < MAX_ATTEMPTS && now >= entry.retryAt);
  }

  want(jobs) {
    const now = this.now();
    this.wanted = new Set(jobs.map((j) => j.key));
    this.queue = [];
    for (const job of jobs) {
      const entry = this.entries.get(job.key);
      if (this.due(job.key, now)) this.queue.push(job);
      // A failed tile that is not due yet: look again when it is.
      else if (entry.state === 'failed' && entry.failures < MAX_ATTEMPTS) this.wake(entry.retryAt - now);
    }
    this.pump();
  }

  pump() {
    // After a failure one request goes first, and the rest follow once one has worked.
    while (this.loading < (this.backoff.delay ? 1 : this.concurrency) && this.queue.length) {
      const now = this.now();
      const wait = this.backoff.wait(now);
      if (wait) {
        this.wake(wait);
        return;
      }
      // A tile named twice, or started meanwhile, is not asked for again.
      const job = this.queue.shift();
      if (this.due(job.key, now)) this.start(job);
    }
  }

  // Calls `onSettle()` and carries on loading after `wait` ms, or sooner if that is already
  // arranged.
  wake(wait) {
    const due = this.now() + wait;
    if (this.timer) {
      if (this.timerDue <= due) return;
      clearTimeout(this.timer);
    }
    this.timerDue = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onSettle();
      this.pump();
    }, wait);
  }

  start({ key, url }) {
    const entry = this.entries.get(key) ?? { value: null, failures: 0 };
    entry.state = 'loading';
    this.entries.set(key, entry);
    this.loading++;
    Promise.resolve()
      .then(() => this.load(url))
      .then(
        (value) => {
          Object.assign(entry, { state: 'done', value });
          this.backoff.succeed();
        },
        () => {
          this.backoff.fail(this.now());
          Object.assign(entry, { state: 'failed', retryAt: this.backoff.until, failures: entry.failures + 1 });
        },
      )
      .finally(() => {
        this.loading--;
        this.evict();
        this.onSettle();
        this.pump();
      });
  }

  evict() {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.max) return;
      if (entry.state === 'loading' || this.wanted.has(key) || this.inUse(key)) continue;
      this.entries.delete(key);
      if (entry.value) this.dispose(entry.value);
    }
  }

  // Forgets the queue and every tile not loading, e.g. when the moving clouds are not shown. Loads
  // under way still finish; call again once they have.
  clear() {
    this.queue = [];
    this.wanted = new Set();
    clearTimeout(this.timer);
    this.timer = null;
    for (const [key, entry] of this.entries) {
      if (entry.state === 'loading') continue;
      this.entries.delete(key);
      if (entry.value) this.dispose(entry.value);
    }
  }
}
