// Builds public/data/airports.json from OurAirports (https://ourairports.com/data/, public domain):
// medium and large airports with their open runways and runway headings, and how connected each
// one is: the number of airports it has scheduled routes to, from the OpenFlights route database
// (https://openflights.org/data.php, Open Database License).
//
//   node scripts/build-airports.mjs            downloads the latest data
//   node scripts/build-airports.mjs <dir>      uses airports.csv, runways.csv and routes.dat from <dir>
import { readFile, writeFile } from 'node:fs/promises';

const SOURCE = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main';
const ROUTES_SOURCE = 'https://raw.githubusercontent.com/jpatokal/openflights/master/data';
const OUT = new URL('../public/data/airports.json', import.meta.url);

// Minimal CSV parser for OurAirports' quoted, comma-separated files.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...data] = rows;
  return data.filter((r) => r.length === header.length).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const toRad = (d) => (d * Math.PI) / 180;

// True bearing from one runway end to the other.
function bearing(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const num = (v) => (v === '' || v == null ? null : Number(v));

// True heading of runway end `end` from the data, else from the end coordinates, or null.
function trueHeading(r, end, other) {
  const given = num(r[`${end}_heading_degT`]);
  if (given != null && !Number.isNaN(given)) return given;
  const [lat1, lon1, lat2, lon2] = [r[`${end}_latitude_deg`], r[`${end}_longitude_deg`], r[`${other}_latitude_deg`], r[`${other}_longitude_deg`]].map(num);
  if ([lat1, lon1, lat2, lon2].every((v) => v != null && !Number.isNaN(v)) && (lat1 !== lat2 || lon1 !== lon2)) {
    return bearing(lat1, lon1, lat2, lon2);
  }
  return null;
}

// Heading from a runway number, e.g. "27" is about 270°. That is magnetic, so only approximate.
function numberHeading(ident) {
  const n = parseInt(ident, 10);
  return n >= 1 && n <= 36 ? (n * 10) % 360 : null;
}

// Airports connected to each airport by at least one route, by code (IATA or ICAO, as the
// route data has them). OpenFlights routes.dat: airline, airline id, from, from id, to, to id, ...
export function routeCounts(routesText) {
  const partners = new Map();
  const link = (a, b) => {
    if (!partners.has(a)) partners.set(a, new Set());
    partners.get(a).add(b);
  };
  for (const line of routesText.split(/\r?\n/)) {
    const [, , from, , to] = line.split(',');
    if (!from || !to || from === to) continue;
    link(from, to);
    link(to, from);
  }
  return new Map([...partners].map(([code, set]) => [code, set.size]));
}

export function buildAirports(airportRows, runwayRows, routes = new Map()) {
  const runwaysByAirport = new Map();
  for (const r of runwayRows) {
    if (r.closed === '1' || !r.le_ident || /^H/i.test(r.le_ident)) continue;
    // A true heading for one end gives the other; runway numbers are the last resort.
    let le = trueHeading(r, 'le', 'he');
    let he = r.he_ident ? trueHeading(r, 'he', 'le') : null;
    le ??= he != null ? (he + 180) % 360 : numberHeading(r.le_ident);
    he ??= le != null ? (le + 180) % 360 : null;
    if (le == null) continue;
    const runway = [r.le_ident, Math.round(le), r.he_ident || '', Math.round(he), num(r.length_ft) ?? 0, (r.surface || '').toUpperCase().slice(0, 4)];
    if (!runwaysByAirport.has(r.airport_ref)) runwaysByAirport.set(r.airport_ref, []);
    runwaysByAirport.get(r.airport_ref).push(runway);
  }
  const airports = [];
  for (const a of airportRows) {
    if (a.type !== 'large_airport' && a.type !== 'medium_airport') continue;
    const runways = runwaysByAirport.get(a.id);
    if (!runways?.length) continue;
    const code = a.icao_code || a.gps_code || a.ident;
    airports.push([
      code,
      a.iata_code || '',
      a.name,
      a.municipality || '',
      a.iso_country,
      Math.round(Number(a.latitude_deg) * 1e4) / 1e4,
      Math.round(Number(a.longitude_deg) * 1e4) / 1e4,
      num(a.elevation_ft) ?? 0,
      a.type === 'large_airport' ? 1 : 0,
      a.scheduled_service === 'yes' ? 1 : 0,
      runways.sort((x, y) => y[4] - x[4]),
      Math.max(routes.get(a.iata_code) ?? 0, routes.get(code) ?? 0),
    ]);
  }
  // Large airports first, then the best connected.
  return airports.sort((x, y) => y[8] - x[8] || y[9] - x[9] || y[11] - x[11] || x[0].localeCompare(y[0]));
}

async function load(dir, name, source = SOURCE) {
  if (dir) return readFile(`${dir}/${name}`, 'utf8');
  const res = await fetch(`${source}/${name}`);
  if (!res.ok) throw new Error(`Could not download ${name}: ${res.status}`);
  return res.text();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const [airports, runways, routes] = await Promise.all([
    load(dir, 'airports.csv'),
    load(dir, 'runways.csv'),
    load(dir, 'routes.dat', ROUTES_SOURCE),
  ]);
  const data = buildAirports(parseCsv(airports), parseCsv(runways), routeCounts(routes));
  const json = JSON.stringify({
    source:
      'Airports and runways: OurAirports (https://ourairports.com/data/), public domain. ' +
      'Routes: OpenFlights (https://openflights.org/data.php), Open Database License (ODbL).',
    built: new Date().toISOString().slice(0, 10),
    fields: ['ident', 'iata', 'name', 'city', 'country', 'lat', 'lon', 'elevationFt', 'large', 'scheduled', 'runways', 'routes'],
    runwayFields: ['leIdent', 'leHeadingT', 'heIdent', 'heHeadingT', 'lengthFt', 'surface'],
    airports: data,
  });
  await writeFile(OUT, json);
  console.log(`${data.length} airports (${data.filter((a) => a[8]).length} large), ${(json.length / 1024).toFixed(0)} KB`);
}
