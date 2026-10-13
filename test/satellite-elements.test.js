import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { explain } from '../src/api.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-14T12:00:00Z');
const ELEMENTS = {
  bundled: 'BUNDLED\n1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927\n2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537\n',
  api: 'FROM API\n1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927\n2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537\n',
  celestrak: 'FROM CELESTRAK\n1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927\n2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537\n',
};
const API_ERROR = 'celestrak.org unreachable (The operation was aborted due to timeout)';

const text = (body) => new Response(body, { status: 200 });
const failure = (status, body = '<!DOCTYPE HTML><title>busy</title>') => new Response(body, { status });
const apiRefuses = () => new Response(JSON.stringify({ error: API_ERROR }), { status: 502, headers: { 'Content-Type': 'application/json' } });

// What the page asks: the bundled copy (meta.json, <group>.tle), the Power Globe API, CelesTrak.
// `answers` gives each a function that makes the response (or throws), so nothing is read twice.
let calls;
function stubWeb({ meta, copy, api, celestrak }) {
  calls = [];
  const none = () => failure(404, '');
  const answers = { meta: meta ?? none, copy: copy ?? none, api: api ?? none, celestrak: celestrak ?? none };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url) => {
      const u = String(url);
      const kind = u.endsWith('data/satellites/meta.json') ? 'meta' : u.includes('data/satellites/') ? 'copy' : u.includes('/satellites/') ? 'api' : u.startsWith('https://celestrak.org/') ? 'celestrak' : 'other';
      calls.push(kind);
      return answers[kind]();
    }),
  );
}
const asked = (kind) => calls.filter((c) => c === kind).length;
const metaFrom = (body) => () => text(JSON.stringify(body));
const blocked = () => {
  throw new TypeError('Failed to fetch');
};

// Browser storage that lasts across a "page load" (resetModules) like the real one.
function stubStorage() {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
  });
}

// The Cache API, in memory.
function stubCaches() {
  const store = new Map();
  vi.stubGlobal('caches', {
    open: async () => ({
      match: async (url) => store.get(String(url))?.clone(),
      put: async (url, res) => void store.set(String(url), res),
    }),
  });
}

async function load(group) {
  const { loadElements } = await import('../src/traffic.js');
  return loadElements(group);
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stubStorage();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('satellite elements in the page', () => {
  it('uses the bundled copy while it is fresh and asks nobody else', async () => {
    stubWeb({ meta: metaFrom({ built: new Date(NOW - HOUR).toISOString(), counts: { stations: 1 } }), copy: () => text(ELEMENTS.bundled) });
    expect(await load('stations')).toBe(ELEMENTS.bundled);
    expect(asked('api') + asked('celestrak')).toBe(0);
  });

  it('judges each group by its own time when the copy has them', async () => {
    const meta = metaFrom({
      built: new Date(NOW - 30 * HOUR).toISOString(),
      counts: { stations: 1, active: 1 },
      fetched: { stations: new Date(NOW - HOUR).toISOString(), active: new Date(NOW - 30 * HOUR).toISOString() },
    });
    stubWeb({ meta, copy: () => text(ELEMENTS.bundled), api: () => text(ELEMENTS.api) });
    expect(await load('stations')).toBe(ELEMENTS.bundled);
    expect(asked('api')).toBe(0);
    expect(await load('active')).toBe(ELEMENTS.api);
    // A group the copy lacks is never taken as fresh because the rest is.
    stubWeb({ meta: metaFrom({ built: new Date(NOW - HOUR).toISOString(), counts: { stations: 1 }, fetched: { stations: new Date(NOW - HOUR).toISOString() } }), api: () => text(ELEMENTS.api) });
    expect(await load('gnss')).toBe(ELEMENTS.api);
  });

  it('asks the API when there is no copy, and keeps the answer for two hours', async () => {
    stubCaches();
    stubWeb({ api: () => text(ELEMENTS.api) });
    expect(await load('stations')).toBe(ELEMENTS.api);
    vi.setSystemTime(NOW + 119 * 60_000);
    expect(await load('stations')).toBe(ELEMENTS.api);
    expect(asked('api')).toBe(1);
    expect(asked('celestrak')).toBe(0);
    vi.setSystemTime(NOW + 121 * 60_000);
    await load('stations');
    expect(asked('api')).toBe(2);
  });

  it.each([
    ['answers 502', apiRefuses],
    ['is blocked', blocked],
  ])('asks CelesTrak itself when the API %s', async (_, api) => {
    stubWeb({ api, celestrak: () => text(ELEMENTS.celestrak) });
    expect(await load('stations')).toBe(ELEMENTS.celestrak);
    expect(calls.filter((c) => c === 'api' || c === 'celestrak')).toEqual(['api', 'celestrak']);
  });

  it('keeps a CelesTrak answer for two hours, whichever way it came', async () => {
    stubCaches();
    stubWeb({ api: apiRefuses, celestrak: () => text(ELEMENTS.celestrak) });
    await load('stations');
    expect(await load('stations')).toBe(ELEMENTS.celestrak);
    expect(asked('api')).toBe(1);
    expect(asked('celestrak')).toBe(1);
  });

  it('falls back to the old copy when neither the API nor CelesTrak answers', async () => {
    stubWeb({
      meta: metaFrom({ built: new Date(NOW - 30 * HOUR).toISOString(), counts: { stations: 1 } }),
      copy: () => text(ELEMENTS.bundled),
      api: apiRefuses,
      celestrak: () => failure(503),
    });
    expect(await load('stations')).toBe(ELEMENTS.bundled);
    expect(calls.filter((c) => c === 'api' || c === 'celestrak')).toEqual(['api', 'celestrak']);
  });

  it('says which of the two failed, and how', async () => {
    stubWeb({ api: apiRefuses, celestrak: () => failure(503) });
    const err = await load('stations').catch((e) => e);
    expect(err.message).toBe(`Power Globe API: ${API_ERROR}; from this browser: CelesTrak answered 503`);
    expect(explain(err)).toBe(err.message);
    // The API refusing the page (CORS) and CelesTrak not answering: not a vague "not reachable".
    stubWeb({ api: blocked, celestrak: blocked });
    const blockedErr = await load('gnss').catch((e) => e);
    expect(blockedErr.message).toBe('Power Globe API: blocked; from this browser: CelesTrak blocked');
    expect(explain(blockedErr)).toBe(blockedErr.message);
    // A short message instead of elements (CelesTrak does this when throttling).
    stubWeb({ api: () => text('GP data has not updated since your last request'), celestrak: () => text('GROUP query returned no data') });
    expect((await load('weather').catch((e) => e)).message).toBe(
      'Power Globe API: sent no elements (GP data has not updated since your last request); from this browser: CelesTrak sent no elements (GROUP query returned no data)',
    );
  });

  it('does not ask again within two hours after both failed, not even after a page reload', async () => {
    stubWeb({ api: apiRefuses, celestrak: () => failure(503) });
    const first = await load('stations').catch((e) => e);
    await load('stations').catch(() => {});
    await load('stations').catch(() => {});
    expect(asked('api')).toBe(1);
    expect(asked('celestrak')).toBe(1);
    // The same words for the status line, without a request.
    expect((await load('stations').catch((e) => e)).message).toBe(first.message);
    // Another group is its own matter.
    await load('gnss').catch(() => {});
    expect(asked('celestrak')).toBe(2);
    // A reload of the page.
    vi.resetModules();
    await load('stations').catch(() => {});
    expect(asked('celestrak')).toBe(2);
    // After two hours it asks again.
    vi.setSystemTime(NOW + 2 * HOUR + 60_000);
    await load('stations').catch(() => {});
    expect(asked('celestrak')).toBe(3);
  });

  it('does not ask again after a failure when the browser keeps nothing', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
    });
    stubWeb({ api: apiRefuses, celestrak: () => failure(503) });
    await load('stations').catch(() => {});
    await load('stations').catch(() => {});
    expect(asked('celestrak')).toBe(1);
  });

  it('uses the old copy on later tries too, without asking', async () => {
    stubWeb({
      meta: metaFrom({ built: new Date(NOW - 30 * HOUR).toISOString(), counts: { stations: 1 } }),
      copy: () => text(ELEMENTS.bundled),
      api: apiRefuses,
      celestrak: () => failure(503),
    });
    await load('stations');
    expect(await load('stations')).toBe(ELEMENTS.bundled);
    expect(asked('celestrak')).toBe(1);
  });

  it('asks once when two callers want the same group at the same time', async () => {
    stubWeb({ api: apiRefuses, celestrak: () => text(ELEMENTS.celestrak) });
    const [a, b] = await Promise.all([load('stations'), load('stations')]);
    expect(a).toBe(ELEMENTS.celestrak);
    expect(b).toBe(ELEMENTS.celestrak);
    expect(asked('api')).toBe(1);
    expect(asked('celestrak')).toBe(1);
  });

  it('does not take a page that is not elements (a dev server answering every path) for a copy', async () => {
    stubWeb({
      meta: metaFrom({ built: new Date(NOW - HOUR).toISOString(), counts: { stations: 1 } }),
      copy: () => text('<!doctype html><html></html>'),
      api: () => text(ELEMENTS.api),
    });
    expect(await load('stations')).toBe(ELEMENTS.api);
  });
});
