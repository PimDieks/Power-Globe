import { CURRENT_VARIABLES } from './layers.js';

const API_URL = 'https://api.open-meteo.com/v1/forecast';
// Open-Meteo accepts many coordinates per request; keep URLs a sensible length.
const CHUNK_SIZE = 100;
const CACHE_KEY = 'power-globe:grid';
const CACHE_TTL_MS = 30 * 60 * 1000;

// Evenly spaced sample points covering the globe, `step` degrees apart.
export function buildGrid(step = 10) {
  const points = [];
  for (let lat = -80; lat <= 80; lat += step) {
    for (let lng = -180; lng < 180; lng += step) {
      points.push({ lat, lng });
    }
  }
  return points;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function buildUrl(points) {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(','),
    longitude: points.map((p) => p.lng).join(','),
    current: CURRENT_VARIABLES.join(','),
    timezone: 'GMT',
  });
  return `${API_URL}?${params}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo request failed (${res.status})`);
  return res.json();
}

// Fetch current conditions for a list of points. The API returns an array for
// multiple coordinates and a single object for one.
export async function fetchCurrent(points) {
  const results = [];
  for (const part of chunk(points, CHUNK_SIZE)) {
    const data = await fetchJson(buildUrl(part));
    const list = Array.isArray(data) ? data : [data];
    list.forEach((item, i) => {
      results.push({ lat: part[i].lat, lng: part[i].lng, time: item.current?.time, ...item.current });
    });
  }
  return results;
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { savedAt, data } = JSON.parse(raw);
    return Date.now() - savedAt < CACHE_TTL_MS ? data : null;
  } catch {
    return null;
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // Storage unavailable or full; caching is only a convenience.
  }
}

// Global grid of current conditions, cached locally to stay within the free API's limits.
export async function loadGlobalWeather({ step = 10, force = false } = {}) {
  if (!force) {
    const cached = readCache();
    if (cached) return cached;
  }
  const data = await fetchCurrent(buildGrid(step));
  writeCache(data);
  return data;
}

export async function loadPointWeather(lat, lng) {
  const [point] = await fetchCurrent([{ lat: +lat.toFixed(2), lng: +lng.toFixed(2) }]);
  return point;
}
