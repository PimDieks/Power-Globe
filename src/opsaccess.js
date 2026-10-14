// Access for the Ops view: how people and goods get to the airport. For now that is the road
// traffic around the Dutch airports, from NDW's open data (read by the flight relay and passed on
// by the API, see api/worker.js and relay/api-relay.mjs): the speed at the measurement sites, and
// the jams, accidents and closures near the airport. Pure functions of that data, so they can be
// tested without a browser. Trains and buses are meant to come as further data next to the roads.
//
// What matters to a duty manager is what stops people reaching the airport, so the list is ranked
// and capped: (1) jams, (2) accidents, (3) closures on motorways that are not roadworks, (4)
// vehicles or objects on a motorway, started within three hours. The status fact comes from those
// four only; everything else (other roads, roadworks, a slow lane on a provincial road) is a count
// or sits lower in the section.
import { distanceKm } from './flightroute.js';

// The airports the road data is read for: the Dutch ones with scheduled flights (the list in
// public/data/ndw-sites.json, which a test keeps in step with this one).
export const ACCESS_AIRPORTS = ['EHAM', 'EHEH', 'EHRD', 'EHBK', 'EHGG'];
export const RADIUS_KM = 25;

// Speeds (km/h) of the colour bands, for motorways: above GREEN_FROM is flowing, below RED_BELOW
// is a jam in the making or a real one, in between is slow. A site with fewer than RED_MIN_FLOW
// vehicles an hour in all is at worst slow: a few vehicles do not make a jam. The bands are fixed
// (a motorway's limit is 100 or 120 km/h), not each site's own normal speed.
export const GREEN_FROM = 80;
export const RED_BELOW = 50;
export const RED_MIN_FLOW = 300;
// On other roads only this slow, over at least N_MIN_SITES neighbouring sites with RED_MIN_FLOW, is
// listed, and only as a stretch.
export const N_SLOW_BELOW = 25;
export const N_MIN_SITES = 3;
// Road data older than this (minutes) is not taken for the state of the roads now. NDW's own
// readings are typically 4 to 6 minutes old when they reach the page.
export const OLD_MIN = 15;
// Neighbouring sites of one road further apart than this (km) are not joined, and unsided sites
// join when this close.
export const ADJACENT_KM = 2.5;
export const CLUSTER_KM = 1.5;
// A jam measured on a motorway is this many neighbouring sites in a row below RED_BELOW; a slow
// stretch is a red site, or this many below GREEN_FROM.
export const JAM_MIN_SITES = 3;
export const STRETCH_MIN_SITES = 3;
export const MAX_STRETCHES = 5;
export const MAX_INCIDENTS = 8;
// Vehicles on the road are the least of the four ranks, and there are many of them: only the nearest few are listed.
export const MAX_OBSTRUCTIONS = 4;
// A temporary speed limit is context for a slow stretch within this distance of it (km).
const LIMIT_KM = 1.2;
// ... and a stretch with no red site whose slowest point keeps to this share of the limit is flowing.
const LIMIT_SHARE = 0.8;

export const SPEED_COLORS = { green: '#7ee2a8', amber: '#ffc857', red: '#ff5a4f', grey: '#9aa3b2' };

export const isCovered = (airport) => ACCESS_AIRPORTS.includes(airport?.ident);
export const isARoad = (road) => typeof road === 'string' && road.startsWith('A');

// The colour band of a site: grey where there is no speed (no traffic to speak of, or no reading).
export function speedBand(speed, flow = Infinity) {
  if (speed == null) return 'grey';
  if (speed >= GREEN_FROM) return 'green';
  return speed >= RED_BELOW || !(flow >= RED_MIN_FLOW) ? 'amber' : 'red';
}

const DIRECTIONS = { N: 'northbound', NE: 'north-eastbound', E: 'eastbound', SE: 'south-eastbound', S: 'southbound', SW: 'south-westbound', W: 'westbound', NW: 'north-westbound' };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const RAD = Math.PI / 180;
const bearing = (a, b) => {
  const y = Math.sin((b[1] - a[1]) * RAD) * Math.cos(b[0] * RAD);
  const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos((b[1] - a[1]) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
};
const compassOf = (deg) => COMPASS[Math.round(deg / 45) % 8];
const km = (a, b) => distanceKm({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] });

// "A4 southbound", "A4" where the way is not known, or "Other road" where no measurement site is
// near enough to say which road it is.
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
  brokenDownVehicle: 'broken down vehicle',
  abandonedVehicle: 'abandoned vehicle',
  vehicleOnFire: 'vehicle on fire',
};
const CLOSURE_KINDS = new Set(['roadClosed', 'carriagewayClosures', 'laneClosures']);
const TYPE_LABELS = { jam: 'Jam', accident: 'Accident', closure: 'Closure', obstruction: 'Obstruction' };
export const typeLabel = (type) => TYPE_LABELS[type] ?? 'Incident';
export const kindText = (kind) => KINDS[kind] ?? null;

export const lengthText = (m) => (m == null ? null : m >= 1000 ? `${(Math.round(m / 100) / 10).toString().replace(/\.0$/, '')} km` : `${Math.round(m / 10) * 10} m`);

// One item of the list in words: "A4 southbound, 6 km, +12 min, 8 km from the airport".
export function situationText(s) {
  const parts = [roadText(s.road, s.dir)];
  const length = lengthText(s.lengthM);
  if (length) parts.push(length);
  if (s.delayMin != null && s.delayMin > 0) parts.push(`+${s.delayMin} min`);
  parts.push(`${Math.round(s.distKm)} km from the airport`);
  return parts.join(', ');
}

// ---- Measured stretches ----

// The runs of points of a chain that `is` picks: for a chain with a side, neighbours in the order
// of the road less than ADJACENT_KM apart; for one without (a provincial road's sites, no order),
// points within CLUSTER_KM of each other.
function runsOf(chain, is) {
  const runs = [];
  if (chain.side) {
    let run = [];
    chain.pts.forEach((p, i) => {
      if (is(p) && (!run.length || km(chain.pts[i - 1], p) <= ADJACENT_KM)) run.push(p);
      else {
        if (run.length) runs.push(run);
        run = is(p) ? [p] : [];
      }
    });
    if (run.length) runs.push(run);
    return runs;
  }
  const picked = chain.pts.filter(is);
  const parent = picked.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < picked.length; i++) for (let j = i + 1; j < picked.length; j++) if (km(picked[i], picked[j]) <= CLUSTER_KM) parent[find(i)] = find(j);
  const groups = new Map();
  picked.forEach((p, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), p]));
  return [...groups.values()];
}

// The direction of travel along a run of a chain with a side: with the numbers on the right side
// of the road, against them on the left. Null for one point or a chain without a side.
function runDirection(chain, run) {
  if (!chain.side || run.length < 2) return null;
  const up = bearing(run[0], run.at(-1));
  return compassOf(chain.side === 'r' ? up : (up + 180) % 360);
}

const runLengthM = (run) => Math.round(run.slice(1).reduce((sum, p, i) => sum + km(run[i], p), 0) * 1000);
const nearestKm = (run, airport) => Math.min(...run.map((p) => km([airport.lat, airport.lng], p)));

// The temporary speed limit in force near a run, if the data has one.
function limitNear(run, limits) {
  const found = limits.find((l) => l.line.some((q) => run.some((p) => km(p, q) <= LIMIT_KM)));
  return found?.kmh ?? null;
}

// What the speeds say: jams (runs of JAM_MIN_SITES or more neighbouring motorway sites below
// RED_BELOW with the flow of a jam) and slow stretches ({ road, dir, minSpeed, sites, km, limitKmh,
// provincial }), slowest first. A motorway stretch has a red site or STRETCH_MIN_SITES slow ones; a
// provincial road's only counts with N_MIN_SITES neighbours below N_SLOW_BELOW.
export function measuredStretches(data, airport) {
  const limits = data.limits ?? [];
  const jams = [];
  const stretches = [];
  for (const chain of data.chains ?? []) {
    const speedOf = (p) => p[2];
    if (isARoad(chain.road)) {
      for (const run of runsOf(chain, (p) => speedBand(p[2], p[3]) === 'red')) {
        if (run.length >= JAM_MIN_SITES) jams.push({ road: chain.road, dir: runDirection(chain, run), lengthM: runLengthM(run), distKm: nearestKm(run, airport), sites: run.length, minSpeed: Math.min(...run.map(speedOf)), points: run });
      }
      for (const run of runsOf(chain, (p) => p[2] != null && p[2] < GREEN_FROM)) {
        const minSpeed = Math.min(...run.map(speedOf));
        const red = run.some((p) => speedBand(p[2], p[3]) === 'red');
        if (!red && run.length < STRETCH_MIN_SITES) continue;
        // A run that is a measured jam is listed as one, not twice.
        if (run.length >= JAM_MIN_SITES && run.every((p) => speedBand(p[2], p[3]) === 'red')) continue;
        const limitKmh = limitNear(run, limits);
        // Traffic keeping to a temporary limit is not slow.
        if (!red && limitKmh && minSpeed >= LIMIT_SHARE * limitKmh) continue;
        stretches.push({ road: chain.road, dir: runDirection(chain, run), minSpeed, sites: run.length, km: nearestKm(run, airport), limitKmh, provincial: false });
      }
    } else {
      for (const run of runsOf(chain, (p) => p[2] != null && p[2] < N_SLOW_BELOW && p[3] >= RED_MIN_FLOW)) {
        if (run.length >= N_MIN_SITES) stretches.push({ road: chain.road, dir: runDirection(chain, run), minSpeed: Math.min(...run.map(speedOf)), sites: run.length, km: nearestKm(run, airport), limitKmh: null, provincial: true });
      }
    }
  }
  stretches.sort((a, b) => a.minSpeed - b.minSpeed || b.sites - a.sites || a.km - b.km);
  return { jams, stretches: stretches.slice(0, MAX_STRETCHES) };
}

// The counts of the motorway sites by colour: { green, amber, red, grey }.
export function bandCounts(data) {
  const counts = { green: 0, amber: 0, red: 0, grey: 0 };
  for (const chain of data.chains ?? []) if (isARoad(chain.road)) for (const p of chain.pts) counts[speedBand(p[2], p[3])]++;
  return counts;
}

// ---- The airport as the part analyses it ----

const byDelayThenLength = (a, b) => (b.delayMin ?? 0) - (a.delayMin ?? 0) || (b.lengthM ?? 0) - (a.lengthM ?? 0) || a.distKm - b.distKm;

// The list, ranked and capped: jams (NDW's own, and those the speeds show where NDW has none), then
// accidents (and closures for an accident), then closures on motorways, then obstructions on
// motorways. `others` counts what is left: other roads, roadworks that end soon.
function rank(data, measured) {
  const situations = data.situations ?? [];
  const ndwJams = situations.filter((s) => s.type === 'jam');
  // A jam the speeds show is the same as NDW's when one lies within a stretch's length of it.
  const nearNdw = (run) => ndwJams.some((j) => (j.line ?? [j.start, j.end]).some((q) => run.points.some((p) => km(p, q) <= CLUSTER_KM)));
  const detected = measured.jams
    .filter((run) => !nearNdw(run))
    .map((run) => ({ id: `measured-${run.road}-${run.points[0][0]}`, type: 'jam', kind: 'measured', road: run.road, dir: run.dir, aRoad: true, delayMin: null, lengthM: run.lengthM, distKm: run.distKm, measured: true, start: run.points[0].slice(0, 2), end: run.points.at(-1).slice(0, 2), line: run.points.map((p) => p.slice(0, 2)) }));
  const jams = [...ndwJams, ...detected].sort(byDelayThenLength);
  const accidents = situations.filter((s) => s.type === 'accident').sort((a, b) => a.distKm - b.distKm);
  const closures = situations.filter((s) => s.type === 'closure' && s.aRoad).sort((a, b) => a.distKm - b.distKm);
  const obstructions = situations.filter((s) => s.type === 'obstruction' && s.aRoad).sort((a, b) => a.distKm - b.distKm);
  const ranked = [...jams, ...accidents, ...closures, ...obstructions];
  const shown = [...jams, ...accidents, ...closures, ...obstructions.slice(0, MAX_OBSTRUCTIONS)];
  return {
    jams,
    accidents,
    closures,
    obstructions,
    listed: shown.slice(0, MAX_INCIDENTS),
    more: ranked.length - Math.min(shown.length, MAX_INCIDENTS),
    others: {
      closures: situations.filter((s) => s.type === 'closure' && !s.aRoad).length,
      obstructions: situations.filter((s) => s.type === 'obstruction' && !s.aRoad).length,
      planned: data.planned ?? 0,
    },
  };
}

// `result` is what the poll last found for this airport: { state: 'ok', data, problem? },
// { state: 'unavailable', reason } or { state: 'error', error }, or null while there is none.
// `now` is in ms.
export function analyseAccess({ airport, now = Date.now(), result = null }) {
  if (!isCovered(airport)) return { covered: false };
  if (!result) return { covered: true, loading: true };
  if (result.state === 'unavailable') return { covered: true, unavailable: result.reason ?? 'Road data is not available' };
  if (result.state !== 'ok') return { covered: true, error: result.error ?? 'Road data did not load' };
  const { data } = result;
  const age = (at) => (Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : null);
  const ageMin = age(data.measuredAt ?? data.fetched) ?? 0;
  const counts = bandCounts(data);
  const measured = measuredStretches(data, airport);
  // Speed data: there is a time on it, it is fresh, and it has something to say. Otherwise the
  // answer is "no speed data", never "roads flowing".
  const speedOld = !Number.isFinite(data.measuredAt) || ageMin > OLD_MIN;
  const speedOk = !speedOld && counts.green + counts.amber + counts.red > 0;
  const ranked = rank(data, measured);
  return {
    covered: true,
    data,
    ageMin,
    // Old data is said to be old, and is not given as the state of the roads now.
    old: speedOld,
    speedOk,
    stale: Boolean(data.stale),
    problem: result.problem ?? null,
    ...ranked,
    stretches: measured.stretches,
    counts,
  };
}

// "A4 jam 6 km, +12 min" for the worst jam, "2 more" after it for the others.
function jamFact(jams) {
  const [worst] = jams;
  const head = worst.road ? `${worst.road} jam` : 'Jam';
  const detail = [lengthText(worst.lengthM), worst.delayMin > 0 ? `+${worst.delayMin} min` : null].filter(Boolean).join(', ');
  const text = detail ? `${head} ${detail}` : head;
  return jams.length > 1 ? `${text}, ${jams.length - 1} more` : text;
}

// The one line for the summary: { text, status, asOf }, or null where the part has nothing to say (an
// airport without road data). It comes from the ranked items only; "Roads flowing" needs speed
// data that is fresh and says something.
export function accessFact(data) {
  if (!data.covered) return null;
  if (data.loading) return { text: 'Loading road data', status: 'unknown' };
  if (data.unavailable) return { text: 'No road data', status: 'unknown' };
  if (data.error) return { text: 'Road data unavailable', status: 'unknown' };
  const asOf = data.data.situationsAt ?? data.data.fetched ?? null;
  const nearest = (list) => [...list].sort((a, b) => a.distKm - b.distKm)[0];
  if (data.jams.length) return { text: jamFact(data.jams), status: 'caution', asOf };
  if (data.accidents.length) {
    const a = nearest(data.accidents);
    return { text: `${CLOSURE_KINDS.has(a.kind) ? 'Accident closure' : 'Accident'}${a.road ? ` on ${a.road}` : ''}, ${Math.round(a.distKm)} km out`, status: 'caution', asOf };
  }
  if (data.closures.length) {
    const c = nearest(data.closures);
    return { text: `${c.road} ${kindText(c.kind) ?? 'closure'}, ${Math.round(c.distKm)} km out`, status: 'caution', asOf };
  }
  if (data.obstructions.length) {
    const o = nearest(data.obstructions);
    return { text: `Vehicle on ${o.road}, ${Math.round(o.distKm)} km out`, status: 'caution', asOf };
  }
  if (!data.speedOk) return { text: 'No speed data', status: 'unknown' };
  return { text: 'Roads flowing', status: 'ok', asOf: data.data.measuredAt };
}

// ---- The map ----

// The slower end's band of a segment between neighbours.
function segmentBand(a, b) {
  const known = [a, b].filter((p) => p[2] != null);
  if (!known.length) return 'grey';
  const slow = known.reduce((m, p) => (p[2] < m[2] ? p : m));
  return speedBand(slow[2], slow[3]);
}

// What goes on the map for the data: a line along each motorway coloured by speed, between its
// neighbouring sites (coloured by the slower end), the lines of the slow stretches of other roads
// the section lists, a line for each jam and closure that has geometry, and a marker for each
// accident and obstruction and each jam or closure with none.
export function mapShapes(analysis) {
  const { data } = analysis;
  const segments = [];
  for (const chain of data.chains ?? []) {
    const wanted = isARoad(chain.road);
    if (wanted && chain.side) {
      for (let i = 1; i < chain.pts.length; i++) {
        const a = chain.pts[i - 1];
        const b = chain.pts[i];
        if (km(a, b) <= ADJACENT_KM) segments.push({ a: [a[0], a[1]], b: [b[0], b[1]], band: segmentBand(a, b) });
      }
    }
  }
  // Slow stretches of provincial roads that are listed.
  for (const chain of data.chains ?? []) {
    if (isARoad(chain.road)) continue;
    for (const run of runsOf(chain, (p) => p[2] != null && p[2] < N_SLOW_BELOW && p[3] >= RED_MIN_FLOW)) {
      if (run.length < N_MIN_SITES) continue;
      for (let i = 1; i < run.length; i++) segments.push({ a: [run[i - 1][0], run[i - 1][1]], b: [run[i][0], run[i][1]], band: 'red' });
    }
  }
  const lines = [];
  const markers = [];
  for (const s of [...analysis.jams, ...analysis.accidents, ...analysis.closures, ...analysis.obstructions]) {
    if (s.line && (s.type === 'jam' || s.type === 'closure')) lines.push({ kind: s.type, points: s.line });
    else markers.push({ kind: s.type, lat: s.start[0], lng: s.start[1] });
  }
  return { segments, lines, markers };
}
