// Builds public/data/ndw-sites.json: the road measurement sites of NDW (the Dutch road traffic data
// portal, https://opendata.ndw.nu/) within 25 km of each Dutch airport that has scheduled flights
// in public/data/airports.json. The relay (relay/api-relay.mjs, with NDW=1) reads speeds at these
// sites every minute; a site list this small is what lets it skip the other 60,000 or so in the
// 70 MB speed file, and the page never needs the 147 MB national list.
//
//   node scripts/build-ndw-sites.mjs                downloads the national list and the live speed
//                                                   file (to keep only sites that report now)
//   node scripts/build-ndw-sites.mjs <list.xml.gz|.xml> [<speeds.xml.gz|.xml>]
//                                                   reads local files instead
//   node scripts/build-ndw-sites.mjs --no-live      does not check the sites against the live file
//
// The building itself is in the relay (buildSiteList), which also builds a new list by itself when
// NDW gives many sites a new version. Run this when the airports change, or to publish a fresh list
// for relays that start from it, and commit the file. Source: NDW, https://opendata.ndw.nu/ (no
// licence is stated for these files).
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildSiteList } from '../relay/api-relay.mjs';

export { MOTORWAYS, readLiveIds, readSites, siteRoadOf as roadOf, splitId } from '../relay/api-relay.mjs';

const AIRPORTS = new URL('../public/data/airports.json', import.meta.url);
const OUT = new URL('../public/data/ndw-sites.json', import.meta.url);

// The Dutch airports with scheduled flights, as { icao: [lat, lon] }, busiest first.
export function dutchAirports(file) {
  const rows = file.airports.filter((a) => a[4] === 'NL' && a[9] === 1).sort((a, b) => (b[11] ?? 0) - (a[11] ?? 0));
  return Object.fromEntries(rows.map((a) => [a[0], [a[5], a[6]]]));
}

export async function build({ list, speeds, live = true } = {}) {
  const airports = dutchAirports(JSON.parse(await readFile(AIRPORTS, 'utf8')));
  console.log(`Airports: ${Object.keys(airports).join(', ')}`);
  return buildSiteList({ airports, ...(list && { list }), ...(speeds && { speeds }), live });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const data = await build({ list: files[0], speeds: files[1], live: !args.includes('--no-live') });
  const text = JSON.stringify(data);
  await writeFile(OUT, text);
  console.log(`Wrote ${data.sites.length} sites, ${(text.length / 1024).toFixed(0)} KB, to public/data/ndw-sites.json`);
}
