import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remember } from '../src/api.js';
import { METAR_CACHE_SIZE, latestObservation } from '../src/metar.js';
import { TAF_CACHE_SIZE, latestTaf } from '../src/taf.js';
import { ROUTE_CACHE_SIZE, clearFlightCaches, knownRoute, loadRoute } from '../src/flightroute.js';

// The caches of what someone happens to look at keep no more than so many answers, the oldest
// going first, so that they cannot grow for as long as the page is open.

describe('remember', () => {
  it('keeps no more than so many entries, letting go of the oldest', () => {
    const map = new Map();
    for (const key of ['a', 'b', 'c', 'd']) expect(remember(map, key, key.toUpperCase(), 3)).toBe(key.toUpperCase());
    expect([...map.keys()]).toEqual(['b', 'c', 'd']);
  });

  it('counts an entry put in again as the newest', () => {
    const map = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    remember(map, 'a', 3, 2);
    remember(map, 'c', 4, 2);
    expect([...map]).toEqual([
      ['a', 3],
      ['c', 4],
    ]);
  });
});

// Answers nothing for every airport, and counts what was asked for which airport.
function service() {
  const fetchFn = vi.fn(async () => new Response(''));
  fetchFn.askedFor = (ident) => fetchFn.mock.calls.filter(([url]) => url.includes(`ids=${ident}`)).length;
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}
const idents = (n) => Array.from({ length: n }, (_, i) => `X${String(i).padStart(3, '0')}`);

describe.each([
  ['METAR', latestObservation, METAR_CACHE_SIZE],
  ['TAF', latestTaf, TAF_CACHE_SIZE],
])('the %s of an airport', (_, latest, size) => {
  afterEach(() => vi.unstubAllGlobals());

  it('is kept for no more than the airports asked for last', async () => {
    const fetchFn = service();
    const all = idents(size + 1);
    for (const ident of all) await latest(ident);
    // The newest is still kept, the oldest has gone and is asked for again.
    await latest(all.at(-1));
    expect(fetchFn.askedFor(all.at(-1))).toBe(1);
    await latest(all[0]);
    expect(fetchFn.askedFor(all[0])).toBe(2);
  });
});

describe('the routes of callsigns', () => {
  beforeEach(() => clearFlightCaches());

  it('are kept for no more than the callsigns looked up last', async () => {
    const fetchFn = vi.fn(async (url) =>
      url.includes('/KLM000.')
        ? new Response(
            JSON.stringify({
              airport_codes: 'EGLL-EHAM',
              _airports: [
                { icao: 'EGLL', iata: 'LHR', name: 'Heathrow', lat: 51.47, lon: -0.46 },
                { icao: 'EHAM', iata: 'AMS', name: 'Schiphol', lat: 52.31, lon: 4.76 },
              ],
            }),
          )
        : new Response('', { status: 404 }),
    );
    const callsigns = Array.from({ length: ROUTE_CACHE_SIZE + 1 }, (_, i) => `KLM${String(i).padStart(3, '0')}`);
    await loadRoute(callsigns[0], { fetchFn });
    expect(knownRoute(callsigns[0])).not.toBeNull();
    for (const callsign of callsigns.slice(1)) await loadRoute(callsign, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(ROUTE_CACHE_SIZE + 1);
    await loadRoute(callsigns.at(-1), { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(ROUTE_CACHE_SIZE + 1);
    // The first has gone, and is asked for again.
    expect(knownRoute(callsigns[0])).toBeNull();
    await loadRoute(callsigns[0], { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(ROUTE_CACHE_SIZE + 2);
  });

  it('keep the route of an aircraft selected again as the newest', async () => {
    const fetchFn = vi.fn(async () => new Response('', { status: 404 }));
    const callsigns = Array.from({ length: ROUTE_CACHE_SIZE + 1 }, (_, i) => `KLM${String(i).padStart(3, '0')}`);
    for (const callsign of callsigns.slice(0, -1)) await loadRoute(callsign, { fetchFn });
    // The first is looked up again (from the cache), then one more comes: the second goes instead.
    await loadRoute(callsigns[0], { fetchFn });
    await loadRoute(callsigns.at(-1), { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(ROUTE_CACHE_SIZE + 1);
    await loadRoute(callsigns[0], { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(ROUTE_CACHE_SIZE + 1);
    await loadRoute(callsigns[1], { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(ROUTE_CACHE_SIZE + 2);
  });
});
