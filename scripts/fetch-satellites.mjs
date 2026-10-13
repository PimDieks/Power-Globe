// Saves CelesTrak's orbital elements (two-line element sets) for each satellite group shown on
// the globe to public/data/satellites/, so the site has a recent copy even when CelesTrak cannot
// be reached from the browser. Run at deploy time.
//
// CelesTrak asks for each group at most every two hours and refuses (403, 503) beyond that, and
// a deploy that fails here must not take the satellites off the site. So, per group:
//   1. the copy already published on the live site (SITE_URL) is reused while it is younger than
//      two hours, without asking CelesTrak;
//   2. else CelesTrak is asked, a few times with growing pauses;
//   3. else the published file is kept, however old;
//   4. only with none of these is the group missing.
// meta.json says when each group was fetched (`fetched`); `built` is the oldest of those times,
// for readers that know only that field.
//
//   node scripts/fetch-satellites.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const GROUPS = ['active', 'stations', 'starlink', 'gnss', 'weather', 'military'];
const OUT = new URL('../public/data/satellites/', import.meta.url);
const SOURCE = 'CelesTrak (https://celestrak.org/)';
// How often CelesTrak allows each group to be asked for.
export const ASK_EVERY_MS = 2 * 3_600_000;
const ATTEMPTS = 3;
const RETRY_PAUSE_MS = 20_000;
const TIMEOUT_MS = 60_000;

const hasElements = (text) => /^1 /m.test(text);
const countOf = (text) => text.split(/\r?\n/).filter((l) => l.startsWith('1 ')).length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The address of the published site: SITE_URL (the deploy workflow sets it), else the GitHub
// Pages address of the repository the workflow runs in, which is also a fork's own. Empty when
// neither is known, e.g. on a developer's machine.
export function siteUrl(env) {
  if (env.SITE_URL) return env.SITE_URL;
  const [owner, repo] = (env.GITHUB_REPOSITORY ?? '').split('/');
  if (!owner || !repo) return '';
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
}

// The satellite copy published with the site, or null if there is none: when each group was
// fetched (milliseconds), and a way to read a group's file.
async function publishedCopy(site, fetchFn) {
  if (!site) return null;
  const base = new URL('data/satellites/', site.endsWith('/') ? site : `${site}/`);
  const get = async (name) => {
    const res = await fetchFn(new URL(name, base), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? res : null;
  };
  try {
    const meta = await (await get('meta.json'))?.json();
    if (!meta) return null;
    // Copies made before `fetched` existed were all fetched at `built`.
    const stamps = meta.fetched ?? Object.fromEntries(Object.keys(meta.counts ?? {}).map((group) => [group, meta.built]));
    return {
      fetched: (group) => Date.parse(stamps[group]) || 0,
      async file(group) {
        try {
          const text = await (await get(`${group}.tle`))?.text();
          return text && hasElements(text) ? text : null;
        } catch {
          return null;
        }
      },
    };
  } catch {
    return null;
  }
}

// One group from CelesTrak: { text }, or { reason } when it would not answer.
async function askCelesTrak(group, { fetchFn, wait }) {
  let reason = '';
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await wait(RETRY_PAUSE_MS * attempt);
    try {
      const res = await fetchFn(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`, {
        headers: { 'User-Agent': 'power-globe (https://github.com/PimDieks/Power-Globe)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (res.ok && hasElements(text)) return { text };
      reason = `${res.status} ${text.replace(/\s+/g, ' ').trim().slice(0, 80)}`;
      // A refusal for asking too often is not helped by asking again.
      if (res.status === 403 || res.status === 429) break;
    } catch (err) {
      reason = err.cause?.code ?? err.message;
    }
  }
  return { reason };
}

// Writes every group that can be had to `out` (a directory URL) and returns { counts, fetched,
// missing }: the elements per group, when each was fetched, and the groups with nothing at all.
export async function saveSatellites({ out = OUT, site = '', fetchFn = fetch, now = Date.now, wait = sleep, log = console.log } = {}) {
  await mkdir(out, { recursive: true });
  const published = await publishedCopy(site, fetchFn);
  log(published ? `Published copy found at ${site}` : 'No published copy to fall back on');
  const counts = {};
  const fetched = {};
  const missing = [];
  for (const group of GROUPS) {
    const was = published?.fetched(group) ?? 0;
    const kept = was ? await published.file(group) : null;
    let text = null;
    // When the elements in `text` were fetched.
    let time = was;
    if (kept && now() - was < ASK_EVERY_MS) {
      text = kept;
      log(`${group}: reused the published copy, ${Math.round((now() - was) / 60_000)} min old`);
    } else {
      const answer = await askCelesTrak(group, { fetchFn, wait });
      text = answer.text ?? null;
      if (text) {
        time = now();
        log(`${group}: ${countOf(text)} from CelesTrak`);
      } else if (kept) {
        text = kept;
        log(`${group}: CelesTrak answered ${answer.reason}; kept the published copy from ${new Date(was).toISOString()}`);
      } else {
        log(`${group}: CelesTrak answered ${answer.reason}, and there is no published copy; leaving it out`);
      }
    }
    if (!text) {
      missing.push(group);
      continue;
    }
    await writeFile(new URL(`${group}.tle`, out), text);
    counts[group] = countOf(text);
    fetched[group] = new Date(time).toISOString();
  }
  if (Object.keys(fetched).length) {
    const built = new Date(Math.min(...Object.values(fetched).map(Date.parse))).toISOString();
    await writeFile(new URL('meta.json', out), JSON.stringify({ source: SOURCE, built, counts, fetched }));
  }
  return { counts, fetched, missing };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { counts, missing } = await saveSatellites({ site: siteUrl(process.env) });
  console.log(counts);
  // The deploy goes on without these groups; the step still shows that something is wrong.
  if (missing.length) {
    console.error(`No satellite data for: ${missing.join(', ')}`);
    process.exitCode = 1;
  }
}
