// Severe-weather markers: soft pulses where storms, heavy rain or heavy snow are forecast.

export const HAZARDS = {
  storm: { label: 'Thunderstorm', rgb: '255, 135, 135' },
  rain: { label: 'Heavy rain', rgb: '116, 192, 252' },
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
