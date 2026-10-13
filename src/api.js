// The site's own data, for when the public services cannot be used directly:
// - a static data API published with the site (data/api/, refreshed every six hours by the
//   deploy workflow, see scripts/build-data.mjs): the global forecast and airport weather;
// - optionally a live proxy (api/worker.js, a Cloudflare Worker) for flights, METARs and
//   satellites (see DEFAULT_PROXY_URL; VITE_API_URL at build time overrides it).

export const DATA_URL = `${import.meta.env?.BASE_URL ?? '/'}data/`;
// This site's own deployment; VITE_API_URL at build time points a fork at its own.
const DEFAULT_PROXY_URL = 'https://power-globe-api.pimdieks.workers.dev';
export const PROXY_URL = (import.meta.env?.VITE_API_URL || DEFAULT_PROXY_URL).replace(/\/+$/, '');

// Snapshots this recent are used instead of asking the public services.
export const SNAPSHOT_FRESH_MS = 6.5 * 3_600_000;

// A JSON file from the static data API, or null if it is not there.
export async function fetchSnapshot(path) {
  try {
    const res = await fetch(`${DATA_URL}${path}`);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// `promise`, or a rejection with `message` (an error named TimeoutError) if it has not settled
// after `ms`, so that nothing shown as loading can wait for ever. An answer that comes later is
// ignored here; the caller can still read it from `promise`.
export function withTimeout(promise, ms, message) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { name: 'TimeoutError' })), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

// What went wrong, in words: "Failed to fetch" means the browser was not allowed to ask the
// service (it does not accept requests from other websites) or could not reach it.
export function explain(err) {
  if (/failed to fetch|networkerror|load failed/i.test(err?.message ?? '')) {
    return PROXY_URL ? 'not reachable' : 'the service does not accept requests from web pages; see "Power Globe API" in the README';
  }
  return err?.message || 'error';
}
