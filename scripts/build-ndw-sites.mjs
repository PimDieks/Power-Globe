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
// Run it again when roads change (a few times a year), commit the file, and the relay picks the new
// one up when restarted. Source: NDW, https://opendata.ndw.nu/ (no licence is stated for these files).
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { NDW_RADIUS_KM, addHeadings, distanceKm, readElements } from '../relay/api-relay.mjs';

const BASE = 'https://opendata.ndw.nu/';
const LIST = 'snelheden_en_intensiteiten_configuratie_meetlocaties.xml.gz';
const SPEEDS = 'snelheden_en_intensiteiten_meetgegevens.xml.gz';
const AIRPORTS = new URL('../public/data/airports.json', import.meta.url);
const OUT = new URL('../public/data/ndw-sites.json', import.meta.url);

async function open(source) {
  const gz = /\.gz$/.test(source);
  let stream;
  if (/^https?:\/\//.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`${source} answered ${res.status}`);
    stream = Readable.fromWeb(res.body);
  } else stream = createReadStream(source);
  return gz ? pipeline(stream, createGunzip(), () => {}) : stream;
}

// The Dutch airports with scheduled flights, as { icao: [lat, lon] }, busiest first.
export function dutchAirports(file) {
  const rows = file.airports.filter((a) => a[4] === 'NL' && a[9] === 1).sort((a, b) => (b[11] ?? 0) - (a[11] ?? 0));
  return Object.fromEntries(rows.map((a) => [a[0], [a[5], a[6]]]));
}

// What a site's id and name say of its road. NDW names no road in the list; the national roads of
// Rijkswaterstaat have it in the id (`0041hrl0322ra`: road 004, A4; main carriageway "hr" or
// connecting road "vw"; side l or r, which way the hectometre numbers run, as seen from the road;
// position 0322 = 32.2 km; lane group), the provinces' sites in the name ("N463 km 2.736 Li").
// The number is an A road if it is one of the motorways of the Netherlands (MOTORWAYS) and an N road
// otherwise, so that N46 is not taken for an A road.
export const MOTORWAYS = new Set([1, 2, 4, 5, 6, 7, 8, 9, 10, 12, 13, 15, 16, 18, 20, 22, 27, 28, 29, 30, 31, 32, 35, 37, 38, 44, 50, 58, 59, 65, 67, 73, 74, 76, 77, 78, 79]);

export function roadOf(id, name) {
  let m = /^RWS01_MONIBAS_(\d{3})\d(hr|vw)([a-z])(\d{4})/.exec(id) ?? /^(\d{3})(hr|vw)([a-z])(\d{4,6})/.exec(name ?? '');
  if (m) {
    const number = Number(m[1]);
    const side = m[2] === 'hr' ? (m[3] === 'l' ? 'l' : m[3] === 'r' ? 'r' : null) : null;
    return { road: `${MOTORWAYS.has(number) ? 'A' : 'N'}${number}`, side, position: Number(m[4]), connecting: m[2] === 'vw' };
  }
  m = /^(N\d{2,3})\s+km\s+([\d.]+)\s+(Li|Re)\b/.exec(name ?? '');
  if (m) return { road: m[1], side: m[3] === 'Li' ? 'l' : 'r', position: Number(m[2]), connecting: false };
  m = /^(N\d{2,3})\b/.exec(name ?? '');
  if (m) return { road: m[1], side: null, position: null, connecting: false };
  return null;
}

// An id as its prefix (up to the second underscore, if it has two) and the rest.
export function splitId(id) {
  const at = id.indexOf('_', id.indexOf('_') + 1);
  return at < 0 ? ['', id] : [id.slice(0, at + 1), id.slice(at + 1)];
}

// Streams the site list and gives the sites within `radiusKm` of an airport, with their lanes.
export async function readSites(source, airports, radiusKm = NDW_RADIUS_KM) {
  const sites = [];
  let total = 0;
  await readElements(await open(source), 'roa:measurementSite', (xml) => {
    total++;
    const lat = Number(/<loc:latitude>([-\d.]+)</.exec(xml)?.[1]);
    const lon = Number(/<loc:longitude>([-\d.]+)</.exec(xml)?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!Object.values(airports).some(([a, o]) => distanceKm(a, o, lat, lon) <= radiusKm)) return;
    const [, id, version] = /<roa:measurementSite id="([^"]+)" version="([^"]*)"/.exec(xml);
    const name = /<roa:measurementSiteName>.*?<com:value(?: [^>]*)?>([^<]*)</s.exec(xml)?.[1] ?? null;
    // The "any vehicle" flow and speed of each lane, in the order the lanes come.
    const speeds = [];
    const flows = [];
    for (const m of xml.matchAll(/<roa:measurementSpecificCharacteristics index="(\d+)"><roa:measurementSpecificCharacteristics>(.*?)<\/roa:measurementSpecificCharacteristics><\/roa:measurementSpecificCharacteristics>/gs)) {
      if (!m[2].includes('<com:vehicleType>anyVehicle<')) continue;
      const kind = /<roa:specificMeasurementValueType>(\w+)</.exec(m[2])?.[1];
      if (kind === 'trafficSpeed') speeds.push(Number(m[1]));
      else if (kind === 'trafficFlow') flows.push(Number(m[1]));
    }
    // A lane needs both: speed only counts where there is flow.
    if (!speeds.length || speeds.length !== flows.length) return;
    sites.push({ id, version, name, lat, lon, lanes: speeds.map((s, i) => [s, flows[i]]) });
  });
  return { sites, total };
}

// The ids of the sites that report in the live speed file.
export async function readLiveIds(source) {
  const ids = new Set();
  await readElements(await open(source), 'roa:siteMeasurements', (xml) => {
    const id = /measurementSiteReference[^>]*\sid="([^"]+)"/.exec(xml.slice(0, 400))?.[1];
    if (id) ids.add(id);
  });
  return ids;
}

export async function build({ list = BASE + LIST, speeds = BASE + SPEEDS, live = true } = {}) {
  const airports = dutchAirports(JSON.parse(await readFile(AIRPORTS, 'utf8')));
  console.log(`Airports: ${Object.keys(airports).join(', ')}`);
  const { sites: all, total } = await readSites(list, airports);
  console.log(`${total} sites in the list, ${all.length} with speed and flow within ${NDW_RADIUS_KM} km`);
  let kept = all;
  if (live) {
    const ids = await readLiveIds(speeds);
    kept = all.filter((s) => ids.has(s.id));
    console.log(`${ids.size} sites in the live file, ${kept.length} of ours report`);
  }
  const named = kept.map((s) => ({ ...s, ...roadOf(s.id, s.name) })).filter((s) => s.road);
  console.log(`${named.length} of those have a road (the rest are dropped: nothing to call them)`);
  const sites = named.filter((s) => !s.connecting);
  console.log(`${sites.length} on a main carriageway or provincial road (slip roads and connecting roads are left out), ${addHeadings(sites.map((s) => ({ ...s }))).filter((s) => s.heading != null).length} with a direction, ${sites.filter((s) => MOTORWAYS.has(Number(s.road.slice(1))) && s.road[0] === 'A').length} on motorways`);

  const patterns = [];
  const patternIndex = new Map();
  // Most ids begin alike (RWS01_MONIBAS_), so each is a prefix number and the rest.
  const counts = new Map();
  for (const s of sites) counts.set(splitId(s.id)[0], (counts.get(splitId(s.id)[0]) ?? 0) + 1);
  const common = new Set([...counts].filter(([, n]) => n >= 20).map(([p]) => p));
  const prefixes = [];
  const rows = sites.map((s) => {
    const key = JSON.stringify(s.lanes);
    if (!patternIndex.has(key)) patternIndex.set(key, patterns.push(s.lanes) - 1);
    const [prefix, rest] = common.has(splitId(s.id)[0]) ? splitId(s.id) : ['', s.id];
    if (!prefixes.includes(prefix)) prefixes.push(prefix);
    return [prefixes.indexOf(prefix), rest, Math.round(s.lat * 1e5) / 1e5, Math.round(s.lon * 1e5) / 1e5, s.road, s.side ?? '', s.position, s.version, patternIndex.get(key)];
  });
  return {
    version: 2,
    source: 'NDW, https://opendata.ndw.nu/ (measurement sites of snelheden_en_intensiteiten)',
    built: new Date().toISOString().slice(0, 10),
    radiusKm: NDW_RADIUS_KM,
    airports,
    fields: ['prefix', 'rest of id', 'lat', 'lon', 'road', 'side (l or r, where the numbers run along the road)', 'position along the road', 'version of the site', 'lanes pattern'],
    prefixes,
    patterns,
    sites: rows,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  const args = process.argv.slice(2);
  const files = args.filter((a) => !a.startsWith('--'));
  const data = await build({ list: files[0], speeds: files[1], live: !args.includes('--no-live') });
  const text = JSON.stringify(data);
  await writeFile(OUT, text);
  console.log(`Wrote ${data.sites.length} sites, ${(text.length / 1024).toFixed(0)} KB, to public/data/ndw-sites.json`);
}
