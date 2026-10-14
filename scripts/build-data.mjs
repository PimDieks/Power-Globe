// Builds the site's own data API in public/data/api/, so visitors share one download instead of
// each asking the public services (and running into their limits):
//   forecast.json         the global forecast grid the globe shows (Open-Meteo, 5 days, hourly)
//   airport-weather.json  ground conditions at the major airports (Open-Meteo, every hour)
//   index.json            what is here and when it was built
// Run at deploy time, every six hours: about 1,550 Open-Meteo locations a run, within its free
// allowance of 10,000 a day.
//
//   node scripts/build-data.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AIRPORT_SNAPSHOT_STEP, AIRPORT_VARIABLES, GRID_STEP, buildAirportUrl, buildGrid, buildUrl, chunk, forecastCopyOf, roundVisibility } from '../src/weather.js';
import { majorAirports, toAirport } from '../src/airports.js';

const OUT = new URL('../public/data/api/', import.meta.url);
const AIRPORTS = new URL('../public/data/airports.json', import.meta.url);
// Smaller requests than the site's own, so each answer stays well under a megabyte.
const CHUNK = 50;
const ATTEMPTS = 5;
// Stay under Open-Meteo's 600 locations a minute.
const PER_MINUTE = Number(process.env.PER_MINUTE) || 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let window = [];

async function paced(url, locations) {
  for (;;) {
    const now = Date.now();
    window = window.filter(([t]) => now - t < 60_000);
    const used = window.reduce((sum, [, n]) => sum + n, 0);
    if (used + locations <= PER_MINUTE) break;
    await sleep(60_000 - (now - window[0][0]) + 100);
  }
  window.push([Date.now(), locations]);
  // Network hiccups and cut-off answers happen on shared CI runners; try again with growing waits.
  let lastError;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt) await sleep(5_000 * 2 ** (attempt - 1));
    let res;
    let body;
    try {
      // gzip only: Node's fetch has had trouble with long brotli streams.
      res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(90_000) });
      body = await res.text();
    } catch (err) {
      lastError = new Error(`request failed: ${err.cause?.code ?? err.message}`);
      continue;
    }
    if (!res.ok) {
      lastError = new Error(`Open-Meteo ${res.status}: ${body.slice(0, 120)}`);
      if (res.status === 429 && /daily|hourly/i.test(body)) break;
      continue;
    }
    try {
      const data = JSON.parse(body);
      return Array.isArray(data) ? data : [data];
    } catch (err) {
      lastError = new Error(`unreadable answer (${body.length} bytes): ${err.message}`);
    }
  }
  throw lastError;
}

const round = (v, digits) => (v == null ? null : Number(v.toFixed(digits)));

async function forecast() {
  const points = buildGrid(GRID_STEP);
  const hourly = [];
  for (const part of chunk(points, CHUNK)) {
    hourly.push(...(await paced(buildUrl(part), part.length)).map((d) => d.hourly));
  }
  return forecastCopyOf(points, hourly);
}

async function airportWeather() {
  const rows = JSON.parse(await readFile(AIRPORTS, 'utf8')).airports;
  const airports = majorAirports(rows.map(toAirport));
  const out = {};
  let times = null;
  let failed = 0;
  for (const part of chunk(airports, CHUNK)) {
    let data;
    try {
      data = await paced(buildAirportUrl(part), part.length);
    } catch (err) {
      // Leave these airports out; the site asks Open-Meteo for them itself.
      console.error(`airports ${part[0].ident}…: ${err.message}`);
      failed += part.length;
      continue;
    }
    data.forEach(({ hourly }, i) => {
      // Every step (an hour, see AIRPORT_SNAPSHOT_STEP) of the timeline.
      const keep = hourly.time.flatMap((t, k) => (Number(t.slice(11, 13)) % AIRPORT_SNAPSHOT_STEP === 0 ? [k] : []));
      times ??= keep.map((k) => hourly.time[k]);
      out[part[i].ident] = AIRPORT_VARIABLES.map((v) =>
        keep.map((k) => (v === 'visibility' ? roundVisibility(hourly[v]?.[k]) : round(hourly[v]?.[k], v === 'temperature_2m' || v === 'dew_point_2m' ? 1 : 0))),
      );
    });
  }
  if (!times) throw new Error('no airport weather at all');
  if (failed) console.error(`${failed} of ${airports.length} airports left out`);
  return { step: AIRPORT_SNAPSHOT_STEP, variables: AIRPORT_VARIABLES, units: { wind: 'kn', temperature: '°C', visibility: 'm' }, times, airports: out };
}

await mkdir(OUT, { recursive: true });
const built = new Date().toISOString();
const source = 'Weather data by Open-Meteo.com (CC BY 4.0)';
const results = {};
for (const [name, build] of [
  ['forecast', forecast],
  ['airport-weather', airportWeather],
]) {
  try {
    const data = await build();
    await writeFile(new URL(`${name}.json`, OUT), JSON.stringify({ built, source, ...data }));
    results[name] = 'ok';
  } catch (err) {
    // Each part is optional: the site falls back to Open-Meteo directly.
    console.error(`${name}: ${err.message}`);
    results[name] = `failed: ${err.message}`;
  }
}
await writeFile(
  new URL('index.json', OUT),
  JSON.stringify(
    {
      name: 'Power Globe data API',
      built,
      endpoints: {
        'api/forecast.json': 'Global forecast grid, 12° spacing, 5 days every hour (Open-Meteo, CC BY 4.0)',
        'api/airport-weather.json': 'Temperature, dew point, wind and gusts (kt) and visibility at major airports, 5 days every hour (Open-Meteo, CC BY 4.0)',
        'airports.json': 'Airports and runways (OurAirports, public domain; route counts from OpenFlights, ODbL)',
        'satellites/<group>.tle': 'Satellite orbital elements (CelesTrak)',
      },
      results,
    },
    null,
    2,
  ),
);
console.log(results);
if (Object.values(results).every((r) => r !== 'ok')) process.exit(1);
