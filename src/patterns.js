// Weather-pattern overlays: wind flow streaks and pulsing rings for severe weather.

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

// Point reached by travelling `distance` degrees of arc from lat/lng along compass `bearing`.
export function destination(lat, lng, bearing, distance) {
  const φ1 = toRad(lat);
  const λ1 = toRad(lng);
  const θ = toRad(bearing);
  const δ = toRad(distance);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lng: ((toDeg(λ2) + 540) % 360) - 180 };
}

// Short streaks pointing downwind, longer for stronger wind. Open-Meteo's wind direction is
// where the wind comes from, so streaks head the opposite way.
export function windStreaks(points, speed, direction, { minSpeed = 3 } = {}) {
  return points.flatMap((p, i) => {
    const s = speed[i];
    const d = direction[i];
    if (s == null || d == null || s < minSpeed) return [];
    const end = destination(p.lat, p.lng, (d + 180) % 360, Math.min(s / 5, 9));
    return [{ points: [p, end], speed: s }];
  });
}

export const HAZARDS = {
  storm: { label: 'Thunderstorm', rgb: '255, 107, 107' },
  rain: { label: 'Heavy rain', rgb: '77, 171, 247' },
  snow: { label: 'Heavy snow', rgb: '231, 245, 255' },
};

// Severe-weather class for a WMO weather code and hourly precipitation (mm), or null.
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
