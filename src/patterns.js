// Severe-weather markers: soft pulses where storms, heavy rain or heavy snow are forecast.

export const HAZARDS = {
  storm: { label: 'Thunderstorm', rgb: '255, 135, 135' },
  rain: { label: 'Heavy rain', rgb: '116, 192, 252' },
  snow: { label: 'Heavy snow', rgb: '231, 245, 255' },
};

// Severe-weather class for a WMO weather code and precipitation rate (mm/h), or null.
export function classifyHazard(code, precipitation) {
  if (code === 95 || code === 96 || code === 99) return 'storm';
  if (code === 75 || code === 86) return 'snow';
  if (code === 65 || code === 67 || code === 82 || precipitation >= 2.5) return 'rain';
  return null;
}

export function hazardRings(points, codes, precipitation) {
  return points.flatMap((p, i) => {
    const kind = classifyHazard(codes[i], precipitation[i]);
    return kind ? [{ lat: p.lat, lng: p.lng, kind }] : [];
  });
}

// `next` (a list from hazardRings) in place of `previous`, the list the globe already shows: the
// very same list when nothing changed, so the globe is not given it again, and otherwise a list that
// keeps the objects of the rings that stay, so that their pulses carry on rather than start afresh.
export function reuseRings(previous, next) {
  const key = (r) => `${r.lat},${r.lng},${r.kind}`;
  const known = new Map(previous.map((r) => [key(r), r]));
  const merged = next.map((r) => known.get(key(r)) ?? r);
  return merged.length === previous.length && merged.every((r, i) => r === previous[i]) ? previous : merged;
}
