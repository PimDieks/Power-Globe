// "Flight relay on this computer" under Live traffic: points the site at relay/relay.mjs running
// on the visitor's computer (see api.js), after checking that it answers. `?relay=<address>` in
// the page address does the same, `?relay=off` stops using it.
import { relayUrl, setRelayUrl } from './api.js';

const TIMEOUT_MS = 5000;

// What the relay at `url` says about itself, or throws if it does not answer.
export async function relayHealth(url, fetchFn = fetch) {
  const res = await fetchFn(`${url}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  const body = await res.json();
  if (body?.name !== 'Power Globe flight relay') throw new Error('is not a Power Globe flight relay');
  return body;
}

// `onChange()` runs when the site starts or stops using a relay.
export function setupRelay(els, onChange) {
  const params = new URLSearchParams(location.search);
  if (params.has('relay')) {
    const value = params.get('relay');
    setRelayUrl(value === 'off' ? '' : value);
    params.delete('relay');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
  }

  function show(message) {
    els.status.textContent = message;
    els.off.hidden = !relayUrl();
  }

  async function check(url) {
    try {
      const { opensky } = await relayHealth(url);
      return `Using your relay at ${url} (OpenSky ${opensky === 'account' ? 'account' : 'without an account'}).`;
    } catch (err) {
      return `Your relay at ${url} does not answer (${err.name === 'TimeoutError' ? 'timed out' : err.message}). Is relay.mjs running? Chrome may also ask to allow access to devices on your local network.`;
    }
  }

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    let url;
    try {
      url = new URL(els.url.value.trim() || els.url.placeholder).origin;
    } catch {
      show('That is not an address, e.g. http://localhost:8787.');
      return;
    }
    show('Checking…');
    try {
      const { opensky } = await relayHealth(url);
      setRelayUrl(url);
      show(`Using your relay at ${url} (OpenSky ${opensky === 'account' ? 'account' : 'without an account'}).`);
      onChange();
    } catch (err) {
      show(`No relay answers at ${url} (${err.name === 'TimeoutError' ? 'timed out' : err.message}). Start it with node relay/relay.mjs; Chrome may also ask to allow access to devices on your local network.`);
    }
  });

  els.off.addEventListener('click', () => {
    setRelayUrl('');
    show('Not using a relay.');
    onChange();
  });

  const current = relayUrl();
  els.off.hidden = !current;
  if (current) {
    els.url.value = current;
    check(current).then(show);
  }
}
