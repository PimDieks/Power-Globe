// Saves CelesTrak's orbital elements (two-line element sets) for each satellite group shown on
// the globe to public/data/satellites/, so the site has a recent copy even when CelesTrak cannot
// be reached from the browser. Run at deploy time; CelesTrak asks for each group at most every
// two hours.
//
//   node scripts/fetch-satellites.mjs
import { mkdir, writeFile } from 'node:fs/promises';

const GROUPS = ['active', 'stations', 'starlink', 'gnss', 'weather', 'military'];
const OUT = new URL('../public/data/satellites/', import.meta.url);

await mkdir(OUT, { recursive: true });
const counts = {};
for (const group of GROUPS) {
  const res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`, {
    headers: { 'User-Agent': 'power-globe (https://github.com/PimDieks/Power-Globe)' },
  });
  const text = await res.text();
  if (!res.ok || !/^1 /m.test(text)) throw new Error(`CelesTrak ${group}: ${res.status} ${text.slice(0, 80)}`);
  await writeFile(new URL(`${group}.tle`, OUT), text);
  counts[group] = text.split(/\r?\n/).filter((l) => l.startsWith('1 ')).length;
}
await writeFile(new URL('meta.json', OUT), JSON.stringify({ source: 'CelesTrak (https://celestrak.org/)', built: new Date().toISOString(), counts }));
console.log(counts);
