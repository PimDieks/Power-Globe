// The site's own data, for when the public services cannot be used directly:
// - a static data API published with the site (data/api/, refreshed every six hours by the
//   deploy workflow, see scripts/build-data.mjs): the global forecast and airport weather;
// - optionally a live proxy (api/worker.js, a Cloudflare Worker) for flights, METARs and
//   satellites, whose address is set at build time in VITE_API_URL.

export const DATA_URL = `${import.meta.env?.BASE_URL ?? '/'}data/`;
export const PROXY_URL = (import.meta.env?.VITE_API_URL ?? '').replace(/\/+$/, '');

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

// What went wrong, in words: "Failed to fetch" means the browser was not allowed to ask the
// service (it does not accept requests from other websites) or could not reach it.
export function explain(err) {
  if (/failed to fetch|networkerror|load failed/i.test(err?.message ?? '')) {
    return PROXY_URL ? 'not reachable' : 'the service does not accept requests from web pages; see "Power Globe API" in the README';
  }
  return err?.message || 'error';
}
