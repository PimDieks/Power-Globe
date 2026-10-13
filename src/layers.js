// Weather layers shown on the globe. Each layer maps an Open-Meteo variable to a colour
// scale: `stops` are [value, colour] pairs in ascending order. Palettes are muted and
// painterly so the globe reads as a whole rather than as a chart.
//   opacity  how strongly the smooth field covers the Earth
//   fade     optional [from, to] range over which the field fades in from transparent,
//            so e.g. dry or clear areas show the Earth underneath

export const LAYERS = [
  {
    key: 'temperature',
    label: 'Temperature',
    variable: 'temperature_2m',
    unit: '°C',
    opacity: 0.52,
    stops: [
      [-40, '#1b1036'],
      [-25, '#2b3a8c'],
      [-10, '#3f7cc4'],
      [0, '#7fc6d9'],
      [10, '#bfe3c0'],
      [18, '#f3e3a1'],
      [26, '#f2a65e'],
      [34, '#d9534f'],
      [45, '#7a1f3d'],
    ],
  },
  {
    key: 'wind',
    label: 'Wind speed',
    variable: 'wind_speed_10m',
    unit: 'km/h',
    opacity: 0.55,
    stops: [
      [0, '#14213d'],
      [15, '#1f6f8b'],
      [30, '#3fb8af'],
      [50, '#b5e8d5'],
      [80, '#f6d6e8'],
      [110, '#ff8fab'],
    ],
  },
  {
    key: 'precipitation',
    label: 'Precipitation',
    variable: 'precipitation',
    // Averaged over the 3 hours up to the time shown, on the map and in the details panel alike.
    unit: 'mm/h',
    opacity: 0.8,
    fade: [0.05, 1.5],
    stops: [
      [0, '#a5d8ff'],
      [1, '#4dabf7'],
      [4, '#5f3dc4'],
      [15, '#e5dbff'],
    ],
  },
  {
    key: 'clouds',
    label: 'Cloud cover',
    variable: 'cloud_cover',
    unit: '%',
    opacity: 0.85,
    fade: [15, 100],
    stops: [
      [0, '#c5d3e8'],
      [60, '#e9eef5'],
      [100, '#ffffff'],
    ],
  },
  {
    key: 'humidity',
    label: 'Humidity',
    variable: 'relative_humidity_2m',
    unit: '%',
    opacity: 0.6,
    stops: [
      [0, '#7f4f24'],
      [40, '#dda15e'],
      [70, '#83c5be'],
      [100, '#006d77'],
    ],
  },
];

// Every Open-Meteo variable the app requests: the layers plus what the pattern overlays need.
export const VARIABLES = [...new Set([...LAYERS.map((l) => l.variable), 'wind_direction_10m', 'weather_code'])];

export function getLayer(key) {
  return LAYERS.find((l) => l.key === key) ?? LAYERS[0];
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

// Linearly interpolate a colour for `value` along the layer's stops, clamping at both ends.
export function colorFor(stops, value) {
  if (value == null || Number.isNaN(value)) return '#868e96';
  if (value <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i];
    if (value <= v1) {
      const [v0, c0] = stops[i - 1];
      const t = (value - v0) / (v1 - v0);
      const a = hexToRgb(c0);
      const b = hexToRgb(c1);
      return rgbToHex(a.map((x, j) => x + (b[j] - x) * t));
    }
  }
  return last[1];
}

// Precomputed RGBA lookup table spanning the stops' range, for fast per-pixel colouring.
// Alpha ramps up across the layer's `fade` range, if it has one.
export function buildLut({ stops, fade }, size = 256) {
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  const lut = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    const value = min + ((max - min) * i) / (size - 1);
    const [r, g, b] = hexToRgb(colorFor(stops, value));
    let alpha = 1;
    if (fade) {
      const t = Math.min(1, Math.max(0, (value - fade[0]) / (fade[1] - fade[0])));
      alpha = t * t * (3 - 2 * t);
    }
    lut.set([r, g, b, Math.round(alpha * 255)], i * 4);
  }
  return lut;
}

// 0..1 position of `value` within the layer's range, used for bar height on the globe.
export function normalize(stops, value) {
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  if (value == null || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

// WMO weather interpretation codes, as used by Open-Meteo.
const WEATHER_CODES = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  56: 'Freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Rain showers',
  81: 'Heavy rain showers',
  82: 'Violent rain showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with heavy hail',
};

export function describeWeatherCode(code) {
  return WEATHER_CODES[code] ?? 'Unknown';
}
