// Weather layers shown on the globe. Each layer maps an Open-Meteo "current"
// variable to a colour scale. `stops` are [value, colour] pairs in ascending order.

export const LAYERS = [
  {
    key: 'temperature',
    label: 'Temperature',
    variable: 'temperature_2m',
    unit: '°C',
    stops: [
      [-40, '#2c1c6b'],
      [-20, '#3b5bdb'],
      [0, '#74c0fc'],
      [10, '#8ce99a'],
      [20, '#ffe066'],
      [30, '#ff922b'],
      [45, '#c92a2a'],
    ],
  },
  {
    key: 'wind',
    label: 'Wind speed',
    variable: 'wind_speed_10m',
    unit: 'km/h',
    stops: [
      [0, '#e7f5ff'],
      [20, '#74c0fc'],
      [40, '#4c6ef5'],
      [70, '#ae3ec9'],
      [110, '#e64980'],
    ],
  },
  {
    key: 'precipitation',
    label: 'Precipitation',
    variable: 'precipitation',
    unit: 'mm',
    stops: [
      [0, '#f1f3f5'],
      [0.5, '#a5d8ff'],
      [2, '#339af0'],
      [5, '#1864ab'],
      [15, '#5f3dc4'],
    ],
  },
  {
    key: 'clouds',
    label: 'Cloud cover',
    variable: 'cloud_cover',
    unit: '%',
    stops: [
      [0, '#4dabf7'],
      [50, '#adb5bd'],
      [100, '#f8f9fa'],
    ],
  },
  {
    key: 'humidity',
    label: 'Humidity',
    variable: 'relative_humidity_2m',
    unit: '%',
    stops: [
      [0, '#e8590c'],
      [40, '#fcc419'],
      [70, '#63e6be'],
      [100, '#1971c2'],
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

// Precomputed RGB lookup table spanning the stops' range, for fast per-pixel colouring.
export function buildLut(stops, size = 256) {
  const min = stops[0][0];
  const max = stops[stops.length - 1][0];
  const lut = new Uint8ClampedArray(size * 3);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = hexToRgb(colorFor(stops, min + ((max - min) * i) / (size - 1)));
    lut.set([r, g, b], i * 3);
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
