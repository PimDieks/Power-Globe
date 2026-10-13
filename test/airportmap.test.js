import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const field = (ident, lat, lng) => toAirport([ident, '', `Field ${ident}`, 'Nowhere', 'GB', lat, lng, 10, 0, 1, [['09', 90, '27', 270, 6000, 'ASP']]]);
  const FIELD = field('XMAP', 51, 0);
  // Far enough from FIELD that it is not in view from there (the view at this altitude spans about half a degree).
  const OTHER = field('XOTH', 52, 1);
  // The camera comes to rest near the airport, close enough for its runways.
  const view = { lat: 51, lng: 0, altitude: 0.01 };
  const requested = () => airportWeather.mock.calls.map(([list]) => list.map((a) => a.ident));

  // A map over `airports`, and a way to let the camera come to rest for `ms`.
  async function setup(airports) {
    const { loadAirports } = await import('../src/airports.js');
    loadAirports.mockResolvedValue(airports);
    const map = setupAirportMap({ globe: {}, mapFeatures: { setRunwayLabels() {} }, getTime: () => '2026-10-13T12:00', getLimits: () => ({ crosswind: 25, tailwind: 10 }) });
    const settle = async (pov = view, ms = 400) => {
      map.view(pov);
      await vi.advanceTimersByTimeAsync(ms);
    };
    return { map, settle };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-10-13T12:00:00Z'));
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    airportWeather.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('does not ask again on every view change after the weather could not be had', async () => {
    airportWeather.mockRejectedValue(new Error('Open-Meteo usage limit reached for now'));
    const { settle } = await setup([FIELD]);
    await settle();
    expect(airportWeather).toHaveBeenCalledTimes(1);
    await settle();
    await settle();
    expect(airportWeather).toHaveBeenCalledTimes(1);
  });

  it('asks again by itself when the wait is over, without the camera moving', async () => {
    airportWeather.mockRejectedValueOnce(new Error('Open-Meteo usage limit reached for now')).mockResolvedValue(new Map());
    const { settle } = await setup([FIELD]);
    await settle();
    expect(airportWeather).toHaveBeenCalledTimes(1);
    // A view change inside the wait is not lost either: it asks again when the wait is over.
    await vi.advanceTimersByTimeAsync(10_000);
    await settle();
    expect(airportWeather).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WEATHER_RETRY_MS);
    expect(airportWeather).toHaveBeenCalledTimes(2);
    expect(requested()).toEqual([['XMAP'], ['XMAP']]);
  });

  it('waits only for the airports that failed, not for the ones flown to next', async () => {
    airportWeather.mockRejectedValueOnce(new Error('Open-Meteo usage limit reached for now')).mockResolvedValue(new Map());
    const { settle } = await setup([FIELD, OTHER]);
    await settle();
    await settle({ lat: 52, lng: 1, altitude: 0.01 });
    expect(requested()).toEqual([['XMAP'], ['XOTH']]);
  });

  it('does not ask again for airports that are being looked up', async () => {
    airportWeather.mockReturnValue(new Promise(() => {}));
    const { settle } = await setup([FIELD]);
    for (let i = 0; i < 5; i++) await settle({ ...view, lat: 51 + i * 0.001 });
    expect(airportWeather).toHaveBeenCalledTimes(1);
  });

  it('asks for an airport again once its lookup is over without an answer for it', async () => {
    airportWeather.mockResolvedValue(new Map());
    const { settle } = await setup([FIELD]);
    await settle();
    await settle();
    expect(airportWeather).toHaveBeenCalledTimes(2);
  });
});
