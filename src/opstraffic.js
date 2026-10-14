// Traffic at one airport for its duty manager: aircraft likely to land in the next hour, aircraft
// holding, the runways the arrivals and departures use, and the counts per hour.
//
// Pure logic. It is fed the live aircraft list (src/aircraft.js shape) now and then, keeps a short
// history of each aircraft near the airport from the reports it is given, and answers with a
// report. Nothing here fetches or draws. Everything is an estimate from ADS-B reports: ETAs are
// "about", holding is judged from the track, and the runway in use is inferred from the aircraft
// seen landing and taking off, not from what the tower says.
import { estimatePosition } from './aircraft.js';
import { acceptRoute, distanceKm } from './flightroute.js';

const KM_PER_NM = 1.852;
const RAD = Math.PI / 180;
const MIN_MS = 60_000;

// Inbound: aircraft this close, and expected to land within this long, are listed.
export const INBOUND_RANGE_NM = 200;
export const INBOUND_HORIZON_MIN = 60;
// Above this height an aircraft counts as inbound only if it is descending.
export const INBOUND_LEVEL_FT = 15_000;
export const DESCENT_FPM = 500;
// Landing from the altitude takes about 3 NM for every 1,000 ft; an aircraft with more height
// than the distance (and this much extra) allows is passing over, not arriving.
export const NM_PER_1000_FT = 3;
export const DESCENT_MARGIN_NM = 30;
// A slow or unreported ground speed is taken as at least this for the ETA.
export const MIN_ETA_SPEED_KT = 120;
// The routes of aircraft heading for the airport may bear away from it by this much and still be
// believed (the route database says it is going there).
export const ROUTE_MAX_OFFSET_DEG = 90;

// Holding: a turn of at least this many degrees in the same direction ...
export const HOLD_TURN_DEG = 300;
// ... within this long, staying within this distance of the middle of the pattern ...
export const HOLD_WINDOW_MS = 10 * MIN_MS;
export const HOLD_EXTENT_NM = 12;
// ... near the airport, at a height where a hold is flown, and fast enough to be an airliner (the
// median ground speed; light aircraft orbiting for survey or training fly slower).
export const HOLD_RANGE_NM = 60;
export const HOLD_MIN_AGL_FT = 3000;
export const HOLD_MAX_ALT_FT = 25_000;
export const HOLD_MAX_BAND_FT = 2500;
export const HOLD_MAX_CLIMB_FPM = 600;
export const HOLD_MIN_SPEED_KT = 140;
// Reports further apart than this say nothing about turning; the median gap must be smaller.
export const HOLD_MAX_GAP_S = 120;
export const HOLD_MAX_MEDIAN_GAP_S = 45;
export const HOLD_MIN_POINTS = 8;
export const HOLD_MIN_SPAN_MS = 4 * MIN_MS;
// Holding aircraft within this distance of each other share a stack.
export const STACK_RADIUS_NM = 8;
// Kinds of aircraft that circle for other reasons than waiting to land.
const NOT_HOLDING = new Set(['Light aircraft', 'Helicopter', 'Glider', 'Balloon or airship', 'Ultralight', 'Drone', 'Space vehicle']);

// Landing: descending through this height above the airport, within this distance of a runway
// threshold, lined up with the runway to within this angle. (A 3 degree approach is at 1,000 ft
// about 3 NM out.) A touch-and-go counts as a landing; a go-around that climbs back above
// GO_AROUND_FT within five minutes takes the landing back.
export const LANDING_GATE_FT = 1000;
export const LANDING_MAX_NM = 3.5;
export const LANDING_ALIGN_DEG = 15;
export const LANDING_MAX_OFFSET_NM = 1.2;
export const GO_AROUND_FT = 1800;
// Taking off: an aircraft that was on the ground near the airport and is now flying, or one first
// seen low and climbing near a runway, lined up with it to within this angle.
export const TAKEOFF_ALIGN_DEG = 20;
export const TAKEOFF_MAX_NM = 6;
export const TAKEOFF_MAX_OFFSET_NM = 1;
export const TAKEOFF_CLIMB_FPM = 500;
export const TAKEOFF_LOW_FT = 2500;
// A runway end counts as in use if it was seen this recently.
export const RUNWAY_ACTIVE_MS = 30 * MIN_MS;
const SAME_AIRCRAFT_COOLDOWN_MS = 10 * MIN_MS;

// Memory: nothing is kept for aircraft further than TRACK_RANGE_NM, a track only for those within
// HISTORY_RANGE_NM, and none for longer than STALE_MS after the last report.
export const TRACK_RANGE_NM = 220;
export const HISTORY_RANGE_NM = 80;
export const STALE_MS = 10 * MIN_MS;
export const MAX_POINTS = 120;
export const HISTORY_MAX_AGE_MS = 30 * MIN_MS;
export const MAX_TRACKED = 1500;
export const MAX_HISTORY_AIRCRAFT = 400;
export const MAX_EVENTS = 3000;
export const EVENT_MAX_AGE_MS = 24 * 3_600_000;
// Time between two updates longer than this is not counted as time monitored (the page was asleep).
export const MAX_GAP_MS = 2 * MIN_MS;
const MAX_STEPS = 300;

const finite = (v) => Number.isFinite(v);
const nmBetween = (a, b) => distanceKm(a, b) / KM_PER_NM;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const angleBetween = (a, b) => Math.abs(wrap180(a - b));

function bearing(a, b) {
  const dLng = (b.lng - a.lng) * RAD;
  const y = Math.sin(dLng) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos(dLng);
  return (((Math.atan2(y, x) / RAD) % 360) + 360) % 360;
}

// East and north of `origin` in nautical miles (flat earth: fine within a few hundred miles).
function local(origin, p) {
  return { x: wrap180(p.lng - origin.lng) * Math.cos(origin.lat * RAD) * 60, y: (p.lat - origin.lat) * 60 };
}

function offset(origin, bearingDeg, miles) {
  return {
    lat: origin.lat + (miles * Math.cos(bearingDeg * RAD)) / 60,
    lng: origin.lng + (miles * Math.sin(bearingDeg * RAD)) / (60 * Math.cos(origin.lat * RAD)),
  };
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The runway ends of an airport (airports.js shape): { ident, heading, thr, far, lengthNm }, where
// thr is where an aircraft landing on this end touches down and far the other end. Where the
// airport list has no threshold positions they are put half the runway's length from the airport
// along its heading. Helipads and runways without a heading are left out.
export function runwayEnds(airport) {
  const ends = [];
  for (const r of airport.runways ?? []) {
    const lengthNm = (r.lengthFt || 0) / 6076.12;
    const pairs = [
      [r.le, r.leHeading, r.leEnd, r.heEnd],
      [r.he, r.heHeading, r.heEnd, r.leEnd],
    ];
    for (const [ident, heading, thr, far] of pairs) {
      if (!ident || !finite(heading) || /^H/i.test(ident)) continue;
      const centre = { lat: airport.lat, lng: airport.lng };
      ends.push({
        ident,
        heading,
        thr: thr ?? offset(centre, heading + 180, lengthNm / 2),
        far: far ?? offset(centre, heading, lengthNm / 2),
        lengthNm,
      });
    }
  }
  return ends;
}

// The runway end a position and track fit best, or null: lined up with the end to within
// `alignDeg`, no more than `offsetNm` to the side of its centre line, and between `behindNm`
// before the threshold and `aheadNm` past it (miles along the runway heading).
function matchEnd(ends, p, track, { alignDeg, offsetNm, behindNm, aheadNm }) {
  let best = null;
  for (const end of ends) {
    if (angleBetween(track, end.heading) > alignDeg) continue;
    const { x, y } = local(end.thr, p);
    const h = end.heading * RAD;
    const along = x * Math.sin(h) + y * Math.cos(h);
    const across = Math.abs(x * Math.cos(h) - y * Math.sin(h));
    if (across > offsetNm || along < -behindNm || along > aheadNm(end)) continue;
    if (!best || across < best.across) best = { end, across };
  }
  return best?.end ?? null;
}

// One aircraft's track as the list of its reports { t, lat, lng, alt, gs, trk, vs, ground }.
function headingAt(points, i) {
  const p = points[i];
  if (finite(p.trk)) return p.trk;
  for (const j of [i + 1, i - 1]) {
    const q = points[j];
    if (!q || Math.abs(q.t - p.t) > HOLD_MAX_GAP_S * 1000) continue;
    const [a, b] = j > i ? [p, q] : [q, p];
    if (nmBetween(a, b) >= 0.15) return bearing(a, b);
  }
  return null;
}

// Total turn in degrees (positive to the right) over the points, from the reported track, else
// from the direction between positions. Turns across a gap too long to follow are not counted.
export function totalTurn(points) {
  let sum = 0;
  let last = null;
  for (let i = 0; i < points.length; i++) {
    const h = headingAt(points, i);
    if (h == null) {
      last = null;
      continue;
    }
    if (last && points[i].t - last.t <= HOLD_MAX_GAP_S * 1000) sum += wrap180(h - last.h);
    last = { h, t: points[i].t };
  }
  return sum;
}

// Whether the points (an aircraft's reports, oldest first) show it holding at `now`: { centre,
// since, turn, altitudeFt, speedKt } or null. See the HOLD_* constants. Aircraft climbing or
// descending (a turn onto final, a departure turning out) fail the height band and the climb
// rate; vectoring that zigzags fails the one-way turn; a pattern that wanders off fails the extent.
export function detectHolding(points, ac, airport, now) {
  if (NOT_HOLDING.has(ac.category) || ac.military) return null;
  const window = points.filter((p) => p.t >= now - HOLD_WINDOW_MS);
  const last = window.at(-1);
  if (window.length < HOLD_MIN_POINTS || now - last.t > 2 * MIN_MS || last.t - window[0].t < HOLD_MIN_SPAN_MS) return null;
  if (window.some((p) => p.ground)) return null;
  const gaps = window.slice(1).map((p, i) => (p.t - window[i].t) / 1000);
  if (median(gaps) > HOLD_MAX_MEDIAN_GAP_S) return null;
  if (nmBetween(airport, last) > HOLD_RANGE_NM) return null;

  const alts = window.map((p) => p.alt).filter(finite);
  if (alts.length < window.length * 0.7) return null;
  const midAlt = median(alts);
  if (midAlt < (airport.elevationFt ?? 0) + HOLD_MIN_AGL_FT || midAlt > HOLD_MAX_ALT_FT) return null;
  if (Math.max(...alts) - Math.min(...alts) > HOLD_MAX_BAND_FT) return null;
  const minutes = (last.t - window[0].t) / MIN_MS;
  if (Math.abs(alts.at(-1) - alts[0]) / minutes > HOLD_MAX_CLIMB_FPM) return null;
  const speeds = window.map((p) => p.gs).filter(finite);
  if (speeds.length && median(speeds) < HOLD_MIN_SPEED_KT) return null;

  const centre = {
    lat: window.reduce((s, p) => s + p.lat, 0) / window.length,
    lng: window.reduce((s, p) => s + p.lng, 0) / window.length,
  };
  if (window.some((p) => nmBetween(centre, p) > HOLD_EXTENT_NM)) return null;
  const turn = totalTurn(window);
  if (Math.abs(turn) < HOLD_TURN_DEG) return null;

  // How long it has stayed here: back through the whole history while it was near the pattern.
  let since = last.t;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (p.ground || nmBetween(centre, p) > HOLD_EXTENT_NM || (finite(p.alt) && Math.abs(p.alt - midAlt) > HOLD_MAX_BAND_FT)) break;
    since = p.t;
  }
  return { centre, since, turn, altitudeFt: finite(last.alt) ? last.alt : midAlt, speedKt: speeds.length ? median(speeds) : null };
}

// A hint's destination (ICAO or IATA code) as the airport.
const isHere = (airport, code) => Boolean(code) && [airport.ident, airport.iata].filter(Boolean).includes(String(code).toUpperCase());

// What the route database says of an aircraft, if its route fits where the aircraft is and where it
// is heading (flightroute.js acceptRoute): { origin, destination } as ICAO codes, else null. `route`
// is the airports of parseRoute. Pass the result as the aircraft's hint to OpsTraffic.update.
export function routeHint(route, ac) {
  const leg = acceptRoute(route, { position: ac, heading: ac.track ?? null });
  return leg ? { origin: leg.from.icao ?? leg.from.code, destination: leg.to.icao ?? leg.to.code } : null;
}

const hourStart = (t) => Math.floor(t / 3_600_000) * 3_600_000;

export class OpsTraffic {
  // `airport` is an airport of airports.js (ident, lat, lng, elevationFt, runways).
  constructor(airport) {
    this.airport = airport;
    this.elevationFt = airport.elevationFt ?? 0;
    this.ends = runwayEnds(airport);
    this.reset();
  }

  reset() {
    // Every aircraft near enough: { id, ac (latest report), lastSeen, points, hint, landing, departure }.
    this.tracked = new Map();
    this.events = [];
    this.steps = [];
    this.area = null;
    this.since = null;
    this.clock = null;
    this.monitoredMs = 0;
    // Time monitored in each clock hour (UTC), by the start of the hour.
    this.covered = new Map();
    this.lastUpdate = null;
  }

  // Take the aircraft list as it is now. `area` is the circle the area feed last covered ({ lat,
  // lng, nm }, if any), and `hints` the route database results by aircraft id (routeHint): the
  // monitor keeps a hint for as long as it keeps the aircraft.
  update(list, { now = Date.now(), area = null, hints = null } = {}) {
    this.#clock(now);
    if (area) this.area = { lat: area.lat, lng: area.lng ?? area.lon, nm: area.nm };
    for (const ac of list) this.#ingest(ac, now, hints?.[ac.id] ?? (hints instanceof Map ? hints.get(ac.id) : null));
    this.#prune(now);
  }

  #clock(now) {
    if (this.since == null) this.since = now;
    if (this.clock != null && now > this.clock && now - this.clock <= MAX_GAP_MS) {
      this.monitoredMs += now - this.clock;
      for (let a = this.clock; a < now; ) {
        const hour = hourStart(a);
        const b = Math.min(now, hour + 3_600_000);
        this.covered.set(hour, (this.covered.get(hour) ?? 0) + (b - a));
        a = b;
      }
    }
    this.clock = Math.max(this.clock ?? now, now);
  }

  #ingest(ac, now, hint) {
    if (!finite(ac.lat) || !finite(ac.lng) || !ac.id) return;
    const seen = finite(ac.seen) ? ac.seen : now;
    if (now - seen > STALE_MS) return;
    const miles = nmBetween(this.airport, ac);
    if (miles > TRACK_RANGE_NM) {
      this.tracked.delete(ac.id);
      return;
    }
    let entry = this.tracked.get(ac.id);
    if (!entry) {
      entry = { id: ac.id, ac: null, lastSeen: seen, points: [], hint: null, landing: null, departure: null, distanceNm: miles };
      this.tracked.set(ac.id, entry);
    }
    if (entry.ac && seen < entry.ac.seen) return;
    entry.ac = { ...ac, seen };
    entry.lastSeen = seen;
    entry.distanceNm = miles;
    if (hint) entry.hint = hint;
    const prev = entry.points.at(-1);
    if (prev && seen <= prev.t) return;
    const p = {
      t: seen,
      lat: ac.lat,
      lng: ac.lng,
      alt: finite(ac.altitudeFt) ? ac.altitudeFt : null,
      gs: finite(ac.speedKt) ? ac.speedKt : null,
      trk: finite(ac.track) ? ac.track : null,
      vs: finite(ac.verticalFpm) ? ac.verticalFpm : null,
      ground: !!ac.onGround,
    };
    // Further out only the last two reports are kept, for the direction of flight.
    if (miles > HISTORY_RANGE_NM) {
      entry.points = [...entry.points.slice(-1), p];
      return;
    }
    if (prev && miles <= HOLD_RANGE_NM) {
      this.steps.push((seen - prev.t) / 1000);
      if (this.steps.length > MAX_STEPS) this.steps.shift();
    }
    entry.points.push(p);
    while (entry.points.length > MAX_POINTS || (entry.points.length > 1 && seen - entry.points[0].t > HISTORY_MAX_AGE_MS)) entry.points.shift();
    this.#movement(entry, p, prev);
  }

  // The direction an aircraft is going at its latest report p: reported, else from the last
  // report before it.
  #track(p, prev) {
    if (finite(p.trk)) return p.trk;
    if (prev && p.t - prev.t <= HOLD_MAX_GAP_S * 1000 && nmBetween(prev, p) >= 0.15) return bearing(prev, p);
    return null;
  }

  #event(kind, entry, p, end) {
    const event = { kind, id: entry.id, callsign: entry.ac.callsign || '', t: p.t, runway: end?.ident ?? null };
    this.events.push(event);
    return event;
  }

  // Landings and take-offs from the aircraft's newest report `p` and the one before it.
  #movement(entry, p, prev) {
    const track = this.#track(p, prev);
    const gate = this.elevationFt + LANDING_GATE_FT;

    // A landing that turns out to be a go-around is taken back.
    if (entry.landing && !p.ground && finite(p.alt) && p.alt > this.elevationFt + GO_AROUND_FT && p.t - entry.landing.t < 5 * MIN_MS) {
      this.events = this.events.filter((e) => e !== entry.landing);
      entry.landing = null;
    }

    if (!p.ground && track != null && finite(p.alt) && p.alt <= gate + 150 && (!entry.landing || p.t - entry.landing.t > SAME_AIRCRAFT_COOLDOWN_MS)) {
      const descending = finite(p.vs) ? p.vs < -100 : prev != null && finite(prev.alt) && prev.alt > p.alt;
      const end =
        descending &&
        matchEnd(this.ends, p, track, {
          alignDeg: LANDING_ALIGN_DEG,
          offsetNm: LANDING_MAX_OFFSET_NM,
          behindNm: LANDING_MAX_NM,
          aheadNm: () => 0.3,
        });
      if (end) {
        entry.landing = this.#event('arrival', entry, p, end);
        return;
      }
    }

    if (p.ground || !(entry.departure == null || p.t - entry.departure.t > SAME_AIRCRAFT_COOLDOWN_MS)) return;
    const near = nmBetween(this.airport, p) <= TAKEOFF_MAX_NM;
    if (!near || (finite(p.alt) && p.alt > this.elevationFt + TAKEOFF_LOW_FT + 1000)) return;
    // Seen on the ground at the airport, and flying now ...
    const wasOnGround = entry.points.some((q) => q.ground && nmBetween(this.airport, q) <= 2.5 && p.t - q.t <= 10 * MIN_MS);
    // ... or first seen low and climbing near a runway.
    const climbingOut =
      entry.points.length === 1 && finite(p.alt) && p.alt <= this.elevationFt + TAKEOFF_LOW_FT && finite(p.vs) && p.vs >= TAKEOFF_CLIMB_FPM;
    if (!wasOnGround && !climbingOut) return;
    const end = track == null ? null : matchEnd(this.ends, p, track, {
      alignDeg: TAKEOFF_ALIGN_DEG,
      offsetNm: TAKEOFF_MAX_OFFSET_NM,
      behindNm: 0.3,
      aheadNm: (e) => e.lengthNm + TAKEOFF_MAX_NM,
    });
    // Climbing out but not lined up with any runway is no take-off from this airport, unless it
    // was seen on the ground here.
    if (!wasOnGround && !end) return;
    entry.departure = this.#event('departure', entry, p, end);
  }

  #prune(now) {
    for (const [id, e] of this.tracked) if (now - e.lastSeen > STALE_MS) this.tracked.delete(id);
    if (this.tracked.size > MAX_TRACKED) {
      const keep = [...this.tracked.values()].sort((a, b) => a.distanceNm - b.distanceNm).slice(0, MAX_TRACKED);
      this.tracked = new Map(keep.map((e) => [e.id, e]));
    }
    const withHistory = [...this.tracked.values()].filter((e) => e.points.length);
    if (withHistory.length > MAX_HISTORY_AIRCRAFT) {
      withHistory.sort((a, b) => a.distanceNm - b.distanceNm);
      for (const e of withHistory.slice(MAX_HISTORY_AIRCRAFT)) e.points = [];
    }
    this.events = this.events.filter((e) => now - e.t <= EVENT_MAX_AGE_MS);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  // How much is held, for tests and for the curious.
  stats() {
    let points = 0;
    let withHistory = 0;
    for (const e of this.tracked.values()) {
      points += e.points.length;
      if (e.points.length) withHistory++;
    }
    return { tracked: this.tracked.size, withHistory, points, events: this.events.length, steps: this.steps.length };
  }

  // Everything the Ops tab shows, as of `now`.
  report(now = Date.now()) {
    const holding = this.#holding(now);
    const holdingIds = new Set(holding.list.map((h) => h.id));
    const inbound = this.#inbound(now, holdingIds);
    const movements = this.#movements(now);
    const coverage = this.#coverage(now);
    const report = { at: now, airport: this.airport.ident, since: this.since, monitoredMs: this.monitoredMs, inbound, holding, movements, coverage };
    report.status = statusFact(report);
    report.summary = summaryLine(report);
    return report;
  }

  #inbound(now, holdingIds) {
    const list = [];
    for (const e of this.tracked.values()) {
      if (holdingIds.has(e.id) || e.landing || !e.ac || now - e.ac.seen > STALE_MS) continue;
      const ac = e.ac;
      // Helicopters and the like are not arrivals to plan for; light aircraft are.
      if (ac.onGround || (NOT_HOLDING.has(ac.category) && ac.category !== 'Light aircraft')) continue;
      const pos = estimatePosition(ac, now);
      const miles = nmBetween(this.airport, pos);
      if (miles > INBOUND_RANGE_NM) continue;
      const here = isHere(this.airport, e.hint?.destination);
      if (e.hint?.destination && !here) continue;

      const prev = e.points.length > 1 ? e.points.at(-2) : null;
      const last = e.points.at(-1);
      const heading = finite(ac.track) ? ac.track : prev && last.t - prev.t <= STALE_MS && nmBetween(prev, last) >= 0.15 ? bearing(prev, last) : null;
      const offsetDeg = heading == null ? null : angleBetween(heading, bearing(pos, this.airport));
      const alt = finite(ac.altitudeFt) ? ac.altitudeFt : null;
      const vs = this.#verticalRate(e);
      const speed = finite(ac.speedKt) && ac.speedKt > 0 ? ac.speedKt : null;

      if (here) {
        if (offsetDeg != null && offsetDeg > ROUTE_MAX_OFFSET_DEG) continue;
      } else {
        if (offsetDeg == null || alt == null) continue;
        const agl = alt - this.elevationFt;
        if (agl > INBOUND_LEVEL_FT && !(vs != null && vs <= -DESCENT_FPM)) continue;
        if (vs != null && vs > DESCENT_FPM) continue;
        if ((agl / 1000) * NM_PER_1000_FT > miles + DESCENT_MARGIN_NM) continue;
        const circuit = miles < 15 && agl < 5000;
        const allowed = miles > 100 ? 40 : miles > 40 ? 60 : miles > 15 ? 90 : circuit ? 180 : 90;
        if (offsetDeg > allowed) continue;
        if (!speed || speed < 80) continue;
      }
      const etaMin = Math.max(1, Math.round((miles / Math.max(speed ?? 0, MIN_ETA_SPEED_KT)) * 60));
      if (etaMin > INBOUND_HORIZON_MIN) continue;
      list.push({
        id: e.id,
        callsign: ac.callsign || '',
        type: ac.type || '',
        category: ac.category || '',
        distanceNm: Math.round(miles),
        bearingDeg: Math.round(bearing(this.airport, pos)),
        altitudeFt: alt,
        verticalFpm: vs,
        speedKt: speed == null ? null : Math.round(speed),
        etaMin,
        etaAt: now + etaMin * MIN_MS,
        // Whether the route database says it is going here.
        route: here,
        origin: e.hint?.origin ?? null,
      });
    }
    list.sort((a, b) => a.etaMin - b.etaMin || a.distanceNm - b.distanceNm);
    return {
      list,
      within30: list.filter((a) => a.etaMin <= 30).length,
      between30and60: list.filter((a) => a.etaMin > 30).length,
      total: list.length,
      rangeNm: INBOUND_RANGE_NM,
    };
  }

  // Climb rate: reported, else from the height change over the last few minutes of reports.
  #verticalRate(e) {
    if (finite(e.ac.verticalFpm)) return e.ac.verticalFpm;
    const last = e.points.at(-1);
    const first = e.points.find((p) => finite(p.alt) && last.t - p.t <= 5 * MIN_MS && last.t - p.t >= MIN_MS);
    if (!last || !first || !finite(last.alt)) return null;
    return Math.round((last.alt - first.alt) / ((last.t - first.t) / MIN_MS));
  }

  #holding(now) {
    const list = [];
    for (const e of this.tracked.values()) {
      if (!e.ac || e.points.length < HOLD_MIN_POINTS) continue;
      const hold = detectHolding(e.points, e.ac, this.airport, now);
      if (!hold) continue;
      const miles = nmBetween(this.airport, hold.centre);
      list.push({
        id: e.id,
        callsign: e.ac.callsign || '',
        type: e.ac.type || '',
        centre: hold.centre,
        distanceNm: Math.round(miles),
        bearingDeg: Math.round(bearing(this.airport, hold.centre)),
        direction: compass(bearing(this.airport, hold.centre)),
        altitudeFt: hold.altitudeFt,
        sinceMs: hold.since,
        minutes: Math.max(1, Math.round((now - hold.since) / MIN_MS)),
        turnDeg: Math.round(hold.turn),
      });
    }
    list.sort((a, b) => b.minutes - a.minutes);
    // Stacks: aircraft whose patterns are close share one.
    const stacks = [];
    for (const h of list) {
      const stack = stacks.find((s) => nmBetween(s.centre, h.centre) <= STACK_RADIUS_NM);
      if (stack) {
        stack.aircraft.push(h);
        stack.count++;
      } else stacks.push({ centre: h.centre, aircraft: [h], count: 1 });
    }
    for (const s of stacks) {
      s.centre = {
        lat: s.aircraft.reduce((sum, h) => sum + h.centre.lat, 0) / s.count,
        lng: s.aircraft.reduce((sum, h) => sum + h.centre.lng, 0) / s.count,
      };
      s.distanceNm = Math.round(nmBetween(this.airport, s.centre));
      s.bearingDeg = Math.round(bearing(this.airport, s.centre));
      s.direction = compass(s.bearingDeg);
      const alts = s.aircraft.map((h) => h.altitudeFt).filter(finite);
      s.minAltitudeFt = alts.length ? Math.min(...alts) : null;
      s.maxAltitudeFt = alts.length ? Math.max(...alts) : null;
      s.longestMinutes = Math.max(...s.aircraft.map((h) => h.minutes));
    }
    stacks.sort((a, b) => b.count - a.count);
    return { list, stacks, count: list.length };
  }

  #movements(now) {
    const make = (kind) => {
      const events = this.events.filter((e) => e.kind === kind);
      const runways = new Map();
      for (const e of events) {
        if (!e.runway) continue;
        const r = runways.get(e.runway) ?? { ident: e.runway, count: 0, lastAt: 0 };
        r.count++;
        r.lastAt = Math.max(r.lastAt, e.t);
        runways.set(e.runway, r);
      }
      const used = [...runways.values()]
        .map((r) => ({ ...r, ageMin: Math.max(0, Math.round((now - r.lastAt) / MIN_MS)), active: now - r.lastAt <= RUNWAY_ACTIVE_MS }))
        .sort((a, b) => b.lastAt - a.lastAt);
      const hours = this.monitoredMs / 3_600_000;
      return {
        total: events.length,
        lastHour: events.filter((e) => now - e.t <= 3_600_000).length,
        // Average per hour over the time monitored, once that is long enough to mean anything.
        perHour: this.monitoredMs >= 30 * MIN_MS ? Math.round((events.length / hours) * 10) / 10 : null,
        runways: used,
        inUse: used.filter((r) => r.active).map((r) => r.ident),
        lastAt: events.length ? Math.max(...events.map((e) => e.t)) : null,
      };
    };
    const byHour = [];
    if (this.since != null) {
      for (let h = hourStart(this.since); h <= hourStart(now); h += 3_600_000) {
        const inHour = this.events.filter((e) => e.t >= h && e.t < h + 3_600_000);
        const covered = this.covered.get(h) ?? 0;
        byHour.push({
          hour: h,
          arrivals: inHour.filter((e) => e.kind === 'arrival').length,
          departures: inHour.filter((e) => e.kind === 'departure').length,
          monitoredMs: covered,
          // Less than the whole hour was monitored (the first, the current, or one with gaps).
          partial: covered < 3_600_000 - MIN_MS,
        });
      }
    }
    return { arrivals: make('arrival'), departures: make('departure'), byHour };
  }

  // What the feeds let this report say, and the notes to show with it.
  #coverage(now) {
    const area = this.area;
    const away = area ? nmBetween(area, this.airport) : null;
    const inboundNm = area ? Math.max(0, Math.min(INBOUND_RANGE_NM, area.nm - away)) : null;
    const gap = median(this.steps);
    const areaHolds = area ? away + HOLD_RANGE_NM <= area.nm : true;
    const areaMoves = area ? away + TAKEOFF_MAX_NM <= area.nm : true;
    const fastEnough = gap != null && gap <= HOLD_MAX_MEDIAN_GAP_S;
    // With an area given the feed is trusted unless the reports are seen to be slow; without one,
    // only the pace of the reports can say.
    const holdingReliable = areaHolds && (area ? gap == null || fastEnough : fastEnough);
    const movementsReliable = areaMoves && (area ? gap == null || fastEnough : fastEnough);
    const notes = [];
    if (!area && !fastEnough) notes.push('Only the worldwide feed (reports every few minutes) is known to cover this airport, so holding and runway use cannot be detected reliably.');
    else if (area && !areaHolds) notes.push(`The area feed is not centred on this airport (${Math.round(away)} NM away, ${area.nm} NM wide), so holding and runway use may be missed.`);
    else if (gap != null && !fastEnough) notes.push(`Aircraft near the airport are reported only every ${Math.round(gap)} s, too slowly to see holding or landings reliably.`);
    if (area && inboundNm < INBOUND_RANGE_NM) notes.push(`The area feed covers only ${Math.round(inboundNm)} NM around the airport; inbound traffic further out is seen only from the worldwide feed and may be missing.`);
    notes.push(
      this.since == null
        ? 'Nothing monitored yet.'
        : `Movement counts only cover the time this page has been open (since ${new Date(this.since).toISOString().slice(11, 16)} UTC${this.monitoredMs < now - this.since - MIN_MS ? ', with gaps' : ''}).`,
    );
    notes.push('Inbound times and runways in use are estimates from aircraft reports, not tower information.');
    return {
      source: area ? 'area' : 'unknown',
      area: area ? { ...area, distanceNm: Math.round(away) } : null,
      inboundNm: inboundNm == null ? null : Math.round(inboundNm),
      holdingReliable,
      movementsReliable,
      reportGapS: gap == null ? null : Math.round(gap),
      notes,
    };
  }
}

// The one-line fact for the Ops status strip: "12 inbound in 30 min · 2 holding".
export function statusFact({ inbound, holding, coverage }) {
  const head = inbound.within30 ? `${inbound.within30} inbound in 30 min` : inbound.total ? `${inbound.total} inbound in 60 min` : 'No inbound traffic seen';
  const hold = coverage.holdingReliable && holding.count ? ` · ${holding.count} holding` : '';
  return head + hold;
}

const list = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0]);

// A short summary for the section, in sentences.
export function summaryLine({ inbound, holding, movements, coverage }) {
  const parts = [];
  if (!inbound.total) parts.push('No inbound traffic seen.');
  else {
    const later = inbound.between30and60 ? `, and ${inbound.between30and60} more in 30 to 60 min` : '';
    parts.push(inbound.within30 ? `About ${inbound.within30} inbound in the next 30 min${later}.` : `About ${inbound.total} inbound in 30 to 60 min.`);
  }
  if (!coverage.holdingReliable) parts.push('Holding cannot be judged from this data.');
  else if (!holding.count) parts.push('No aircraft holding.');
  else {
    const where = list(holding.stacks.map((s) => `${s.count} ${s.direction} ${s.distanceNm} NM out`));
    const longest = Math.max(...holding.stacks.map((s) => s.longestMinutes));
    parts.push(`${holding.count} holding, ${where}, the longest about ${longest} min.`);
  }
  const arr = movements.arrivals.inUse;
  const dep = movements.departures.inUse;
  if (!coverage.movementsReliable) parts.push('Runway use cannot be judged from this data.');
  else if (arr.length || dep.length) {
    parts.push(
      [arr.length ? `Landing on ${list(arr)}` : '', dep.length ? `departing from ${list(dep)}` : '']
        .filter(Boolean)
        .join(', ')
        .replace(/^./, (c) => c.toUpperCase()) + ' (as seen).',
    );
  } else parts.push('No runway use seen yet.');
  return parts.join(' ');
}
