// The site's own data, for when the public services cannot be used directly:
// - a static data API published with the site (data/api/, refreshed every six hours by the
//   deploy workflow, see scripts/build-data.mjs): the global forecast and airport weather;
// - optionally a live proxy (api/worker.js, a Cloudflare Worker) for flights, METARs and
//   satellites (see DEFAULT_PROXY_URL; VITE_API_URL at build time overrides it).

export const DATA_URL = `${import.meta.env?.BASE_URL ?? '/'}data/`;
// This site's own deployment; VITE_API_URL at build time points a fork at its own.
const DEFAULT_PROXY_URL = 'https://power-globe-api.pimdieks.workers.dev';
export const PROXY_URL = (import.meta.env?.VITE_API_URL || DEFAULT_PROXY_URL).replace(/\/+$/, '');

// A flight relay on the visitor's own computer (relay/relay.mjs), if they set one up: the free
// flight feeds refuse requests from cloud servers such as the Power Globe API's, but not from
// a home connection. Kept per browser.
const RELAY_KEY = 'power-globe:relay';
export function relayUrl() {
  try {
    return localStorage.getItem(RELAY_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setRelayUrl(url) {
  try {
    if (url) localStorage.setItem(RELAY_KEY, url.replace(/\/+$/, ''));
    else localStorage.removeItem(RELAY_KEY);
  } catch {
    // Not kept: private browsing.
  }
}

// Where to ask for live traffic, in order: the visitor's relay, then the Power Globe API.
export function trafficServers() {
  return [relayUrl() && { name: 'your relay', url: relayUrl() }, PROXY_URL && { name: 'Power Globe API', url: PROXY_URL }].filter(Boolean);
}

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
