import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROUPS, saveSatellites, siteUrl } from '../scripts/fetch-satellites.mjs';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-14T12:00:00Z');
const SITE = 'https://owner.github.io/Power-Globe';
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const tle = (label) => `${label}\n1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927\n2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537\n`;
const BUSY = '<!DOCTYPE HTML><title>503 Service Unavailable</title>';

// A web with the published site (files by name, null for none) and CelesTrak (per group: a text,
// or a status for a refusal). Records what CelesTrak was asked.
function web({ published = null, celestrak = {} }) {
  const asked = [];
  const fetchFn = vi.fn(async (url) => {
    const u = String(url);
    if (u.startsWith('https://celestrak.org/')) {
      const group = new URL(u).searchParams.get('GROUP');
      asked.push(group);
      const answer = celestrak[group] ?? { status: 503, body: BUSY };
      return answer.status ? new Response(answer.body ?? BUSY, { status: answer.status }) : new Response(answer);
    }
    const name = u.startsWith(`${SITE}/data/satellites/`) ? u.slice(`${SITE}/data/satellites/`.length) : null;
    if (published && name in published) return new Response(published[name], { status: 200 });
    return new Response('Not found', { status: 404 });
  });
  return { fetchFn, asked };
}

// Everything CelesTrak answers well.
const allGood = () => Object.fromEntries(GROUPS.map((g) => [g, tle(`${g} from CelesTrak`)]));
const publishedWith = (ages, extra = {}) => ({
  'meta.json': JSON.stringify({ source: 'CelesTrak', built: iso(Math.max(...Object.values(ages))), counts: {}, fetched: Object.fromEntries(Object.entries(ages).map(([g, a]) => [g, iso(a)])) }),
  ...Object.fromEntries(Object.keys(ages).map((g) => [`${g}.tle`, tle(`${g} published`)])),
  ...extra,
});

let dir;
let out;
const read = (name) => readFile(join(dir, name), 'utf8');
const meta = async () => JSON.parse(await read('meta.json'));
const run = (options) => {
  const wait = vi.fn(async () => {});
  return saveSatellites({ out, site: SITE, now: () => NOW, wait, log: () => {}, ...options }).then((result) => ({ ...result, wait }));
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'satellites-'));
  out = pathToFileURL(dir + sep);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('saving the satellite elements at deploy time', () => {
  it('reuses a published copy younger than two hours without asking CelesTrak', async () => {
    const published = publishedWith(Object.fromEntries(GROUPS.map((g) => [g, 30 * 60_000])));
    const { fetchFn, asked } = web({ published, celestrak: allGood() });
    const result = await run({ fetchFn });
    expect(asked).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(await read('stations.tle')).toBe(tle('stations published'));
    // The times stay those of the data, not of this deploy.
    const written = await meta();
    expect(written.fetched.stations).toBe(iso(30 * 60_000));
    expect(written.built).toBe(iso(30 * 60_000));
    expect(Object.keys(written.counts)).toEqual(GROUPS);
  });

  it('reads a published copy made before each group had its own time', async () => {
    const published = {
      'meta.json': JSON.stringify({ source: 'CelesTrak', built: iso(20 * 60_000), counts: Object.fromEntries(GROUPS.map((g) => [g, 1])) }),
      ...Object.fromEntries(GROUPS.map((g) => [`${g}.tle`, tle(`${g} published`)])),
    };
    const { fetchFn, asked } = web({ published, celestrak: allGood() });
    await run({ fetchFn });
    expect(asked).toEqual([]);
    expect((await meta()).fetched.starlink).toBe(iso(20 * 60_000));
  });

  it('asks CelesTrak for the groups whose published copy is two hours old or more, and only those', async () => {
    const ages = { active: 30 * 60_000, stations: 3 * HOUR, starlink: 119 * 60_000, gnss: 2 * HOUR, weather: 5 * HOUR, military: 10 * 60_000 };
    const { fetchFn, asked } = web({ published: publishedWith(ages), celestrak: allGood() });
    await run({ fetchFn });
    expect(asked.sort()).toEqual(['gnss', 'stations', 'weather']);
    expect(await read('stations.tle')).toBe(tle('stations from CelesTrak'));
    expect(await read('active.tle')).toBe(tle('active published'));
    const written = await meta();
    expect(written.fetched.stations).toBe(iso(0));
    expect(written.fetched.active).toBe(iso(30 * 60_000));
    // For readers that know only `built`: nothing is younger than the oldest data.
    expect(written.built).toBe(iso(119 * 60_000));
  });

  it('keeps the published file of a group CelesTrak refuses, and says how old it is', async () => {
    const published = publishedWith(Object.fromEntries(GROUPS.map((g) => [g, 3 * HOUR])));
    const { fetchFn, asked } = web({ published, celestrak: { ...allGood(), starlink: { status: 503 } } });
    const result = await run({ fetchFn });
    expect(result.missing).toEqual([]);
    expect(await read('starlink.tle')).toBe(tle('starlink published'));
    expect(await read('gnss.tle')).toBe(tle('gnss from CelesTrak'));
    // It tried more than once, with pauses that grow.
    expect(asked.filter((g) => g === 'starlink')).toHaveLength(3);
    expect(result.wait.mock.calls.map(([ms]) => ms)).toEqual([20_000, 40_000]);
    const written = await meta();
    expect(written.fetched.starlink).toBe(iso(3 * HOUR));
    expect(written.fetched.gnss).toBe(iso(0));
    expect(written.built).toBe(iso(3 * HOUR));
  });

  it('leaves out only the group that has neither a fresh answer nor a published copy, and writes the rest', async () => {
    const { fetchFn } = web({ published: null, celestrak: { ...allGood(), military: { status: 503 } } });
    const result = await run({ fetchFn });
    expect(result.missing).toEqual(['military']);
    expect((await readdir(dir)).sort()).toEqual([...GROUPS.filter((g) => g !== 'military').map((g) => `${g}.tle`), 'meta.json'].sort());
    const written = await meta();
    expect(Object.keys(written.counts)).toEqual(GROUPS.filter((g) => g !== 'military'));
    expect(Object.keys(written.fetched)).toEqual(Object.keys(written.counts));
    expect(written.built).toBe(iso(0));
  });

  it('leaves a group out when the published copy lacks it too', async () => {
    // The published site lacks `weather` (an earlier deploy failed for it) and CelesTrak refuses it.
    const ages = Object.fromEntries(GROUPS.filter((g) => g !== 'weather').map((g) => [g, 5 * HOUR]));
    const { fetchFn } = web({ published: publishedWith(ages), celestrak: { ...allGood(), weather: { status: 503 } } });
    const result = await run({ fetchFn });
    expect(result.missing).toEqual(['weather']);
    expect(await read('active.tle')).toBe(tle('active from CelesTrak'));
  });

  it('writes nothing, not even meta.json, when nothing can be had at all', async () => {
    const { fetchFn } = web({ published: null, celestrak: {} });
    const result = await run({ fetchFn });
    expect(result.missing).toEqual(GROUPS);
    expect(await readdir(dir)).toEqual([]);
  });

  it('does not use a published page that is not elements', async () => {
    const published = publishedWith({ stations: 30 * 60_000 }, { 'stations.tle': '<!doctype html><title>Power Globe</title>' });
    const { fetchFn, asked } = web({ published, celestrak: allGood() });
    await run({ fetchFn });
    expect(asked).toContain('stations');
    expect(await read('stations.tle')).toBe(tle('stations from CelesTrak'));
  });

  it('asks CelesTrak for everything when the published site has no copy', async () => {
    const { fetchFn, asked } = web({ published: null, celestrak: allGood() });
    await run({ fetchFn });
    expect(asked).toEqual(GROUPS);
    expect((await meta()).counts.active).toBe(1);
  });

  it('retries a busy CelesTrak and a throttled answer, but not an explicit refusal', async () => {
    let tries = 0;
    const base = web({ celestrak: { ...allGood(), stations: { status: 403, body: 'Your IP has been blocked' } } });
    const fetchFn = vi.fn(async (url) => {
      if (String(url).includes('GROUP=weather') && ++tries < 3) return tries === 1 ? new Response(BUSY, { status: 503 }) : new Response('GP data has not updated since your last request');
      return base.fetchFn(url);
    });
    const result = await run({ fetchFn });
    expect(tries).toBe(3);
    expect(await read('weather.tle')).toBe(tle('weather from CelesTrak'));
    expect(base.asked.filter((g) => g === 'stations')).toHaveLength(1);
    expect(result.missing).toEqual(['stations']);
  });

  it('survives a network error, and a published site that cannot be reached', async () => {
    const fetchFn = vi.fn(async (url) => {
      if (String(url).startsWith(SITE)) throw new TypeError('fetch failed');
      return new Response(tle('from CelesTrak'));
    });
    const result = await run({ fetchFn });
    expect(result.missing).toEqual([]);
  });
});

describe('where the published copy is', () => {
  it('is the address the workflow gives, else the repository\'s own GitHub Pages address', () => {
    expect(siteUrl({ SITE_URL: 'https://globe.example.org', GITHUB_REPOSITORY: 'PimDieks/Power-Globe' })).toBe('https://globe.example.org');
    expect(siteUrl({ GITHUB_REPOSITORY: 'PimDieks/Power-Globe' })).toBe('https://pimdieks.github.io/Power-Globe/');
    expect(siteUrl({ GITHUB_REPOSITORY: 'someone/Power-Globe' })).toBe('https://someone.github.io/Power-Globe/');
    expect(siteUrl({ GITHUB_REPOSITORY: 'someone/someone.github.io' })).toBe('https://someone.github.io/');
  });

  it('is unknown on a developer\'s machine, which then asks CelesTrak for everything', async () => {
    expect(siteUrl({})).toBe('');
    const { fetchFn, asked } = web({ celestrak: allGood() });
    await run({ fetchFn, site: '' });
    expect(asked).toEqual(GROUPS);
    expect(fetchFn.mock.calls.every(([url]) => String(url).startsWith('https://celestrak.org/'))).toBe(true);
  });
});
