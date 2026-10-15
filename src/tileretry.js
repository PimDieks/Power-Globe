// Map tiles that fail to load are asked for again, a few times and a little later, instead of
// staying missing. three-slippy-map-globe as published asks for each tile once and has no handler
// for a failed load: the tile is "loading" for ever, so a single refused request (a busy service, a
// dropped connection) left a hole in the chart until the page was reloaded. The site's copy (see
// src/vendor) now frees such a tile and asks for it again when it is next in view after a pause of
// at least five seconds; the loader below, which never reports a failure to the engine, retries
// sooner and under a fresh address, and gives up with a transparent tile.

// Waits before each further attempt. Even with the spread below they add up to over a minute, so
// a limit that resets every minute (see TILE_RATE_LIMIT in api/worker.js) has passed before the
// last attempt.
export const RETRY_DELAYS_MS = [2000, 6000, 18000, 50000];

// The same tile under a new address on every retry, so that neither the browser nor the API's own
// cache hands back the failure it remembers for the first (see FAILURE_SECONDS in api/worker.js).
export function retryUrl(url, attempt) {
  if (!attempt) return url;
  return `${url}${url.includes('?') ? '&' : '?'}retry=${attempt}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls `load(url)` (which returns a promise) until it succeeds or the delays run out, and returns
// the result of the first success. Rejects with the last error. Waits are spread by up to a fifth
// either way, so tiles that failed together do not all come back together. `isStale()` is asked
// before each retry: when it says true the tile is no longer wanted and the last error is thrown.
export async function loadWithRetry(load, url, { delays = RETRY_DELAYS_MS, wait = sleep, jitter = Math.random, isStale = () => false } = {}) {
  let error;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (attempt > 0) {
      await wait(Math.round(delays[attempt - 1] * (0.8 + 0.4 * jitter())));
      if (isStale()) break;
    }
    try {
      return await load(retryUrl(url, attempt));
    } catch (err) {
      error = err;
    }
  }
  throw error;
}

// Runs `fn` with `proto.load` swapped for `load`, and puts the original back afterwards, also if
// `fn` throws. Meant for a call into code that makes its own loaders, out of reach: while `fn`
// runs nothing else does, so only the loads that call starts are affected.
export function withLoad(proto, load, fn) {
  const original = proto.load;
  proto.load = load;
  try {
    return fn();
  } finally {
    proto.load = original;
  }
}

// A stand-in for THREE.TextureLoader's `load(url, onLoad)` that retries a failing tile (see
// loadWithRetry). A tile that still cannot be had is given a transparent texture: the engine then
// treats it as loaded, so zooming out and in again asks for it afresh, and the chart simply has
// nothing there. `blank()` makes that transparent image. Nothing is called back for a stale tile.
export function retryingTextureLoad({ ImageLoader, Texture, blank, isStale, ...options }) {
  return function load(url, onLoad, onProgress) {
    const texture = new Texture();
    const images = new ImageLoader(this.manager).setCrossOrigin(this.crossOrigin).setPath(this.path);
    const loadImage = (src) => new Promise((resolve, reject) => images.load(src, resolve, onProgress, reject));
    loadWithRetry(loadImage, url, { ...options, isStale }).then(
      (image) => {
        texture.image = image;
        texture.needsUpdate = true;
        onLoad?.(texture);
      },
      (err) => {
        if (isStale?.()) return;
        console.warn(`Map tile ${url} could not be loaded`, err);
        texture.image = blank();
        texture.needsUpdate = true;
        onLoad?.(texture);
      },
    );
    return texture;
  };
}
