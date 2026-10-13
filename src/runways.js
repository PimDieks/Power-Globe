// Runway wind analysis: headwind, tailwind and crosswind on each runway end, judged against
// operating limits. All speeds in knots, directions in degrees true.

const DEG = Math.PI / 180;

// Typical maximum wind components for different kinds of operation. Real limits depend on the
// aircraft type, the operator and the runway condition; these are starting points to adjust.
export const PRESETS = {
  light: { label: 'Light aircraft', crosswind: 15, tailwind: 5, headwind: 30 },
  regional: { label: 'Regional', crosswind: 25, tailwind: 10, headwind: 40 },
  airliner: { label: 'Airliner', crosswind: 35, tailwind: 10, headwind: 50 },
};
export const DEFAULT_LIMITS = { ...PRESETS.regional };

// Share of a limit from which a runway counts as marginal.
export const CAUTION_SHARE = 0.8;

export const STATUS = {
  ok: { rank: 0, label: 'Within limits', short: 'OK', icon: '✓' },
  caution: { rank: 1, label: 'Marginal', short: 'Marginal', icon: '!' },
  nogo: { rank: 2, label: 'Out of limits', short: 'Out of limits', icon: '✕' },
  unknown: { rank: -1, label: 'No data', short: 'No data', icon: '–' },
};

// Wind from `direction` at `speed`, on a runway end facing `heading`: the component along the
// runway (positive = headwind, negative = tailwind) and across it (positive = from the right).
export function windComponents(heading, direction, speed) {
  const angle = (direction - heading) * DEG;
  return { along: speed * Math.cos(angle), across: speed * Math.sin(angle) };
}

const share = (value, limit) => (limit > 0 ? value / limit : value > 0 ? Infinity : 0);

// Everything about one runway end in the given wind. Limits are checked against the stronger of
// the mean wind and the gusts, as a gust can bring the component over the limit on its own.
export function assessRunwayEnd(heading, wind, limits) {
  const { direction, speed, gust } = wind;
  if ([direction, speed].some((v) => v == null || Number.isNaN(v))) {
    return { status: 'unknown', reasons: [] };
  }
  const peak = Math.max(speed, gust ?? speed);
  const mean = windComponents(heading, direction, speed);
  const peakComponents = windComponents(heading, direction, peak);
  const crosswind = Math.abs(peakComponents.across);
  const headwind = Math.max(0, peakComponents.along);
  const tailwind = Math.max(0, -peakComponents.along);
  const checks = [
    ['crosswind', crosswind, limits.crosswind],
    ['tailwind', tailwind, limits.tailwind],
    ['headwind', headwind, limits.headwind],
  ];
  const over = checks.filter(([, value, limit]) => value > limit).map(([name]) => name);
  const near = checks.filter(([, value, limit]) => value > limit * CAUTION_SHARE && value <= limit).map(([name]) => name);
  return {
    status: over.length ? 'nogo' : near.length ? 'caution' : 'ok',
    reasons: over.length ? over : near,
    headwind: Math.max(0, mean.along),
    tailwind: Math.max(0, -mean.along),
    crosswind: Math.abs(mean.across),
    crosswindSide: mean.across >= 0 ? 'R' : 'L',
    peak: { headwind, tailwind, crosswind },
    // How close the worst component is to its limit (1 = at the limit).
    load: Math.max(...checks.map(([, value, limit]) => share(value, limit))),
    // For choosing between runway ends: crosswind and tailwind count, headwind only once it
    // nears its limit, since landing and taking off into the wind is what runways are for.
    strain: Math.max(
      share(crosswind, limits.crosswind),
      share(tailwind, limits.tailwind),
      share(headwind, limits.headwind) > CAUTION_SHARE ? share(headwind, limits.headwind) : 0,
    ),
  };
}

// Every runway end of an airport in the given wind, best first, and the airport's overall status:
// as good as its best runway end, since one usable runway is enough to operate.
export function assessAirport(airport, wind, limits) {
  const ends = airport.runways
    .flatMap((r) => [
      { runway: r, ident: r.le, heading: r.leHeading },
      r.he ? { runway: r, ident: r.he, heading: r.heHeading } : null,
    ])
    .filter(Boolean)
    .map((end) => ({ ...end, ...assessRunwayEnd(end.heading, wind, limits) }))
    .sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank || a.strain - b.strain || a.load - b.load);
  const best = ends[0];
  return { status: best?.status ?? 'unknown', best, ends };
}

// Short explanation of why a runway end is marginal or out of limits.
export function describeReasons(end) {
  if (!end?.reasons?.length) return '';
  return end.reasons.map((r) => r[0].toUpperCase() + r.slice(1)).join(', ');
}

// Wind as pilots write it: "240° 18 kt G31".
export function formatWind({ direction, speed, gust }) {
  if (speed == null || Number.isNaN(speed)) return '–';
  if (speed < 1) return 'Calm';
  const dir = String(Math.round(direction / 10) * 10 || 360).padStart(3, '0');
  const g = gust != null && gust >= speed + 5 ? ` G${Math.round(gust)}` : '';
  return `${dir}° ${Math.round(speed)} kt${g}`;
}
