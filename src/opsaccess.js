// Access for the Ops view: how people and goods get to the airport. For now that is the road
// traffic around the Dutch airports, from NDW's open data (read by the flight relay and passed on
// by the API, see api/worker.js and relay/api-relay.mjs): the speed at the measurement sites, and
// the jams, accidents and closures near the airport. Pure functions of that data, so they can be
// tested without a browser. Trains and buses are meant to come as further data next to the roads.
import { distanceKm } from './flightroute.js';

// The airports the road data is read for: the Dutch ones with scheduled flights (the list in
// public/data/ndw-sites.json, which a test keeps in step with this one).
export const ACCESS_AIRPORTS = ['EHAM', 'EHEH', 'EHRD', 'EHBK', 'EHGG'];
export const RADIUS_KM = 25;

// Speeds (km/h) the dots on the map and the counts use: above GREEN_FROM is flowing, below
// RED_BELOW is a jam in the making or a real one, in between is slow.
export const GREEN_FROM = 80;
export const RED_BELOW = 50;
// Road data older than this (minutes) is not taken for the state of the roads now. NDW's own
// readings are typically 4 to 6 minutes old when they reach the page.
export const OLD_MIN = 15;
// Slow sites on one road and way within this distance of each other are one stretch.
export const STRETCH_KM = 1.5;
// A stretch counts when a site in it is red, or when this many are slow.
export const STRETCH_MIN_SITES = 3;
export const MAX_STRETCHES = 5;
export const MAX_INCIDENTS = 8;

export const SPEED_COLORS = { green: '#7ee2a8', amber: '#ffc857', red: '#ff5a4f', grey: '#9aa3b2' };

export const isCovered = (airport) => ACCESS_AIRPORTS.includes(airport?.ident);

// The colour band of a site's speed: grey where no vehicle passed (an empty road says nothing of
// speed) or there is no reading.
export function speedBand(speed) {
  if (speed == null) return 'grey';
  return speed >= GREEN_FROM ? 'green' : speed >= RED_BELOW ? 'amber' : 'red';
}

const DIRECTIONS = { N: 'northbound', NE: 'north-eastbound', E: 'eastbound', SE: 'south-eastbound', S: 'southbound', SW: 'south-westbound', W: 'westbound', NW: 'north-westbound' };

// "A4 southbound", "A4" where the way is not known, or "Other road" where no measurement site
// is near enough to say which road it is.
export function roadText(road, dir) {
  if (!road) return dir && DIRECTIONS[dir] ? `Other road ${DIRECTIONS[dir]}` : 'Other road';
  return dir && DIRECTIONS[dir] ? `${road} ${DIRECTIONS[dir]}` : road;
}

const KINDS = {
  stationaryTraffic: 'stationary traffic',
  queuingTraffic: 'queuing traffic',
  slowTraffic: 'slow traffic',
  heavyTraffic: 'heavy traffic',
  roadClosed: 'road closed',
  carriagewayClosures: 'carriageway closed',
  laneClosures: 'lane closed',
};
const TYPE_LABELS = { jam: 'Jam', accident: 'Accident', closure: 'Closure', obstruction: 'Obstruction' };
export const typeLabel = (type) => TYPE_LABELS[type] ?? 'Incident';
export const kindText = (kind) => KINDS[kind] ?? null;

export const lengthText = (m) => (m == null ? null : m >= 1000 ? `${(Math.round(m / 100) / 10).toString().replace(/\.0$/, '')} km` : `${Math.round(m / 10) * 10} m`);

// One situation of the data in words: "A4 southbound, 6 km, +12 min, 8 km from the airport".
export function situationText(s) {
  const parts = [roadText(s.road, s.dir)];
  const length = lengthText(s.lengthM);
  if (length) parts.push(length);
  if (s.delayMin != null && s.delayMin > 0) parts.push(`+${s.delayMin} min`);
  parts.push(`${Math.round(s.distKm)} km from the airport`);
  return parts.join(', ');
}

// The slow stretches of the roads, slowest first: sites below GREEN_FROM that lie on one road
// and way within STRETCH_KM of each other, each as { road, dir, minSpeed, sites, km } (km: from
// the airport to the nearest of them). A stretch counts when a site is below RED_BELOW or at
// least STRETCH_MIN_SITES are slow, so that one heavy lorry on its own is not a jam.
export function slowStretches(data, airport, limit = MAX_STRETCHES) {
  const byGroup = new Map();
  for (const site of data.sites) {
    if (site[2] == null || site[2] >= GREEN_FROM) continue;
    if (!byGroup.has(site[4])) byGroup.set(site[4], []);
    byGroup.get(site[4]).push(site);
  }
  const stretches = [];
  for (const [group, slow] of byGroup) {
    const parent = slow.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    const near = (a, b) => Math.abs(a[0] - b[0]) < 0.02 && distanceKm({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }) <= STRETCH_KM;
    for (let i = 0; i < slow.length; i++) for (let j = i + 1; j < slow.length; j++) if (near(slow[i], slow[j])) parent[find(i)] = find(j);
    const clusters = new Map();
    slow.forEach((site, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), site]));
    for (const sites of clusters.values()) {
      const minSpeed = Math.min(...sites.map((s) => s[2]));
      if (minSpeed >= RED_BELOW && sites.length < STRETCH_MIN_SITES) continue;
      const [road, dir] = data.groups[group] ?? [null, null];
      const km = Math.min(...sites.map((s) => distanceKm(airport, { lat: s[0], lng: s[1] })));
      stretches.push({ road, dir, minSpeed, sites: sites.length, km });
    }
  }
  return stretches.sort((a, b) => a.minSpeed - b.minSpeed || b.sites - a.sites || a.km - b.km).slice(0, limit);
}

// The counts of the sites by colour: { green, amber, red, grey }.
export function bandCounts(sites) {
  const counts = { green: 0, amber: 0, red: 0, grey: 0 };
  for (const site of sites) counts[speedBand(site[2])]++;
  return counts;
}

// The airport's access situation for one render. `result` is what the poll last found for this
// airport: { state: 'ok', data, problem? }, { state: 'unavailable', reason } or { state: 'error',
// error }, or null while there is none. `now` is in ms.
export function analyseAccess({ airport, now = Date.now(), result = null }) {
  if (!isCovered(airport)) return { covered: false };
  if (!result) return { covered: true, loading: true };
  if (result.state === 'unavailable') return { covered: true, unavailable: result.reason ?? 'Road data is not available' };
  if (result.state !== 'ok') return { covered: true, error: result.error ?? 'Road data did not load' };
  const { data } = result;
  const measured = data.measuredAt ?? data.fetched ?? now;
  const ageMin = Math.max(0, Math.round((now - measured) / 60_000));
  const situations = data.situations ?? [];
  const byType = (type) => situations.filter((s) => s.type === type);
  return {
    covered: true,
    data,
    ageMin,
    // Old data is said to be old, and is not given as the state of the roads now.
    old: ageMin > OLD_MIN,
    stale: Boolean(data.stale),
    problem: result.problem ?? null,
    jams: byType('jam'),
    accidents: byType('accident'),
    closures: byType('closure'),
    obstructions: byType('obstruction'),
    stretches: slowStretches(data, airport),
    counts: bandCounts(data.sites),
  };
}

// "A4 jam 6 km, +12 min" for the worst jam (the longest delay, then the longest), "2 more" after
// it for the others.
function jamFact(jams) {
  const [worst] = [...jams].sort((a, b) => (b.delayMin ?? 0) - (a.delayMin ?? 0) || (b.lengthM ?? 0) - (a.lengthM ?? 0) || a.distKm - b.distKm);
  const head = worst.road ? `${worst.road} jam` : 'Jam';
  const detail = [lengthText(worst.lengthM), worst.delayMin > 0 ? `+${worst.delayMin} min` : null].filter(Boolean).join(', ');
  const text = detail ? `${head} ${detail}` : head;
  return jams.length > 1 ? `${text}, ${jams.length - 1} more` : text;
}

// The one line for the status strip: { text, status }, or null where the part has nothing to say
// (an airport without road data).
export function accessFact(data) {
  if (!data.covered) return null;
  if (data.loading) return { text: 'Loading road data', status: 'unknown' };
  if (data.unavailable) return { text: 'No road data', status: 'unknown' };
  if (data.error) return { text: 'Road data unavailable', status: 'unknown' };
  if (data.old || data.stale) return { text: `Road data ${data.ageMin} min old`, status: 'unknown' };
  if (data.jams.length) return { text: jamFact(data.jams), status: 'caution' };
  const [slowest] = data.stretches;
  if (slowest && slowest.minSpeed < RED_BELOW) return { text: `${roadText(slowest.road, slowest.dir)} slow, ${slowest.minSpeed} km/h`, status: 'caution' };
  if (data.accidents.length) {
    const [near] = [...data.accidents].sort((a, b) => a.distKm - b.distKm);
    return { text: `Accident${near.road ? ` on ${near.road}` : ''}, ${Math.round(near.distKm)} km out`, status: 'caution' };
  }
  const closed = data.closures.length;
  return { text: closed ? `Roads flowing, ${closed} ${closed === 1 ? 'closure' : 'closures'}` : 'Roads flowing', status: 'ok' };
}

// What goes on the map for the data: a dot per measurement site coloured by its speed, a line for
// each jam and closure that has geometry, and a marker for each accident and obstruction.
export function mapShapes(data) {
  const dots = data.sites.map((s) => ({ lat: s[0], lng: s[1], band: speedBand(s[2]) }));
  const lines = [];
  const markers = [];
  for (const s of data.situations ?? []) {
    if (s.line && (s.type === 'jam' || s.type === 'closure')) lines.push({ kind: s.type, points: s.line });
    else markers.push({ kind: s.type, lat: s.start[0], lng: s.start[1] });
  }
  return { dots, lines, markers };
}
