import { afterEach, describe, expect, it, vi } from 'vitest';
import { airportWeather, toAirport } from '../src/airports.js';
import { WEATHER_RETRY_MS, setupAirportMap } from '../src/airportmap.js';

vi.mock('../src/airports.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadAirports: vi.fn(),
  airportWeather: vi.fn(),
}));
// Runways are drawn with three.js, which needs a globe.
vi.mock('../src/runwaymap.js', async (importOriginal) => ({ ...(await importOriginal()), setupRunways: () => ({ draw() {} }) }));

describe('weather for the airports in view', () => {
  const FIELD = toAirport(['XMAP', '', 'Map Field', 'Nowhere', 'GB', 51, 0, 10, 0, 1, [['09', 90, '27', 270, 6000, 'ASP']]]);
  // The camera comes to rest near the airport, close enough for its runways.
  const view = { lat: 51, lng: 0, altitude: 0.01 };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not ask again on every view change after the weather could not be had', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { loadAirports } = await import('../src/airports.js');
    loadAirports.mockResolvedValue([FIELD]);
    airportWeather.mockRejectedValue(new Error('Open-Meteo usage limit reached for now'));
    const map = setupAirportMap({ globe: {}, mapFeatures: { setRunwayLabels() {} }, getTime: () => '2026-10-13T12:00', getLimits: () => ({ crosswind: 25, tailwind: 10 }) });
    const settle = async (ms = 400) => {
      map.view(view);
      await vi.advanceTimersByTimeAsync(ms);
    };

    await settle();
    expect(airportWeather).toHaveBeenCalledTimes(1);
    await settle();
    await settle();
    expect(airportWeather).toHaveBeenCalledTimes(1);
    await settle(WEATHER_RETRY_MS);
    await settle();
    expect(airportWeather).toHaveBeenCalledTimes(2);
  });
});
