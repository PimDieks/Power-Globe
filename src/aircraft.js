// Live aircraft from ADS-B: parsing the feeds into one shape, merging them, and estimating where
// each aircraft is between updates.

const FT_PER_M = 3.28084;
const KT_PER_MS = 1.943844;
const FPM_PER_MS = 196.8504;
const EARTH_RADIUS_M = 6_371_000;
const M_PER_FT = 0.3048;
const RAD = Math.PI / 180;
// Positions are moved along the aircraft's track for at most this long after the last report.
const MAX_ESTIMATE_S = 600;

// Emitter categories that are flying things worth showing (OpenSky numbers them, ADS-B Exchange
// style feeds use the ADS-B codes). Ground vehicles and obstacles are left out.
const OPENSKY_CATEGORY = {
  2: 'Light aircraft',
  3: 'Small aircraft',
  4: 'Large aircraft',
  5: 'Large aircraft',
  6: 'Heavy aircraft',
  7: 'High performance aircraft',
  8: 'Helicopter',
  9: 'Glider',
  10: 'Balloon or airship',
  12: 'Ultralight',
  14: 'Drone',
  15: 'Space vehicle',
};
const ADSB_CATEGORY = {
  A1: 'Light aircraft',
  A2: 'Small aircraft',
  A3: 'Large aircraft',
  A4: 'Large aircraft',
  A5: 'Heavy aircraft',
  A6: 'High performance aircraft',
  A7: 'Helicopter',
  B1: 'Glider',
  B2: 'Balloon or airship',
  B4: 'Ultralight',
  B6: 'Drone',
  B7: 'Space vehicle',
};
const OPENSKY_SURFACE = new Set([16, 17, 18, 19, 20]);

const orNull = (v) => (v == null || Number.isNaN(v) ? null : v);

// OpenSky Network /states/all: { time, states: [[icao24, callsign, country, timePosition,
// lastContact, lon, lat, baroAltitude, onGround, velocity, track, verticalRate, sensors,
// geoAltitude, squawk, spi, positionSource, category], ...] }, in metres and m/s.
export function fromOpenSky(data) {
  return (data?.states ?? [])
    .filter((s) => s[5] != null && s[6] != null && !OPENSKY_SURFACE.has(s[17]))
    .map((s) => {
      const altitude = s[7] ?? s[13];
      return {
        id: String(s[0]).toLowerCase(),
        callsign: (s[1] ?? '').trim(),
        country: s[2] ?? '',
        seen: (s[3] ?? s[4] ?? data.time) * 1000,
        lat: s[6],
        lng: s[5],
        altitudeFt: altitude == null ? null : Math.round(altitude * FT_PER_M),
        onGround: !!s[8],
        speedKt: s[9] == null ? null : s[9] * KT_PER_MS,
        track: orNull(s[10]),
        verticalFpm: s[11] == null ? null : Math.round(s[11] * FPM_PER_MS),
        squawk: s[14] ?? '',
        category: OPENSKY_CATEGORY[s[17]] ?? '',
        military: false,
      };
    });
}

// ADS-B Exchange v2 style feeds (adsb.lol, adsb.fi): { now, ac: [{ hex, flight,
// r, t, desc, ownOp, dbFlags, alt_baro, gs, track, baro_rate, squawk, lat, lon, seen_pos }] },
// in feet and knots. dbFlags bit 1 marks military aircraft.
export function fromAdsb(data, { military = false } = {}) {
  // adsb.fi gives the time of the feed in seconds, the others in milliseconds.
  const now = data?.now == null ? Date.now() : data.now < 1e11 ? data.now * 1000 : data.now;
  return (data?.ac ?? data?.aircraft ?? [])
    .filter((a) => a.lat != null && a.lon != null && !/^C/.test(a.category ?? ''))
    .map((a) => {
      const onGround = a.alt_baro === 'ground';
      const altitude = onGround ? 0 : (a.alt_baro ?? a.alt_geom);
      return {
        id: String(a.hex).replace(/^~/, '').toLowerCase(),
        callsign: (a.flight ?? '').trim(),
        registration: a.r ?? '',
        type: a.t ?? '',
        description: a.desc ?? '',
        operator: a.ownOp ?? '',
        seen: now - (a.seen_pos ?? a.seen ?? 0) * 1000,
        lat: a.lat,
        lng: a.lon,
        altitudeFt: typeof altitude === 'number' ? altitude : null,
        onGround,
        speedKt: orNull(a.gs),
        track: orNull(a.track ?? a.true_heading),
        verticalFpm: orNull(a.baro_rate ?? a.geom_rate),
        squawk: a.squawk ?? '',
        category: ADSB_CATEGORY[a.category] ?? '',
        military: military || (a.dbFlags & 1) === 1,
      };
    });
}

// Where an aircraft is likely to be at `now`, following its track at its ground speed since the
// last report (great-circle dead reckoning). Aircraft on the ground stay put.
export function estimatePosition(ac, now) {
  if (ac.onGround || !ac.speedKt || ac.track == null) return { lat: ac.lat, lng: ac.lng };
  const seconds = Math.min(MAX_ESTIMATE_S, Math.max(0, (now - ac.seen) / 1000));
  const d = (ac.speedKt / KT_PER_MS) * seconds / EARTH_RADIUS_M;
  const lat1 = ac.lat * RAD;
  const lng1 = ac.lng * RAD;
  const bearing = ac.track * RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(bearing));
  const lng2 = lng1 + Math.atan2(Math.sin(bearing) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 / RAD, lng: ((((lng2 / RAD + 180) % 360) + 360) % 360) - 180 };
}

// How far above the surface an aircraft is drawn, in globe radii. Its true height, so nothing
// jumps at take-off or touchdown. On the ground it is at the surface whatever its barometric
// altitude says (that is not a height above the map), and an altitude that is negative or
// missing never puts it below the surface.
export function drawnAltitude(ac) {
  if (ac.onGround || !Number.isFinite(ac.altitudeFt)) return 0;
  return (Math.max(0, ac.altitudeFt) * M_PER_FT) / EARTH_RADIUS_M;
}

// Whether the layers that are on leave `ac` out: civil aircraft show with Flights, military ones
// with Military flights. An aircraft that is gone is hidden only when both are off.
export function hiddenByLayers(ac, { flights, military }) {
  if (!ac) return !(flights || military);
  return !(ac.military ? military : flights);
}

// Every aircraft heard from any feed, by ICAO 24-bit address. Each report replaces an older one;
// details only one feed has (registration, type) are kept.
export class AircraftStore {
  constructor() {
    this.byId = new Map();
  }

  update(list) {
    for (const ac of list) {
      const old = this.byId.get(ac.id);
      if (!old) {
        this.byId.set(ac.id, ac);
        continue;
      }
      const newer = ac.seen >= old.seen;
      const merged = newer ? { ...old, ...ac } : { ...ac, ...old };
      for (const key of ['registration', 'type', 'description', 'operator', 'country', 'category', 'callsign']) {
        merged[key] = (newer ? ac[key] : old[key]) || (newer ? old[key] : ac[key]) || '';
      }
      merged.military = old.military || ac.military;
      this.byId.set(ac.id, merged);
    }
  }

  // Forget aircraft not heard from for `maxAge` ms (landed, or out of coverage).
  prune(now, maxAge) {
    for (const [id, ac] of this.byId) if (now - ac.seen > maxAge) this.byId.delete(id);
  }

  // Aircraft to show: civil ones, military ones, or both.
  list({ civil = true, military = true } = {}) {
    return [...this.byId.values()].filter((ac) => (ac.military ? military : civil));
  }

  get size() {
    return this.byId.size;
  }
}
