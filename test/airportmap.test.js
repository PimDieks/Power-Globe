import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { airportWeather, toAirport } from '../src/airports.js';
import { WEATHER_RETRY_MS, labelCandidates, setupAirportMap } from '../src/airportmap.js';

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

describe('the label of the selected airport', () => {
  const big = (ident, lat) => toAirport([ident, ident.slice(1), `${ident} International Airport`, 'Town', 'GB', lat, 0, 10, 1, 1, [['09', 90, '27', 270, 9000, 'ASP']], 100]);
  const BIG = big('EBIG', 51);
  // Not large and without scheduled flights: no label of its own at this zoom.
  const SMALL = toAirport(['ESML', '', 'Small Airfield', 'Smalltown', 'GB', 51.2, 0.1, 10, 0, 0, [['09', 90, '27', 270, 2000, 'GRS']]]);
  const REGION = { lat: 51, lng: 0, altitude: 0.3 };
  const FAR = { lat: 51, lng: 0, altitude: 1.5 };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('puts the selected airport first, once, whether or not its tier would show it', () => {
    expect(labelCandidates(SMALL, [], [BIG]).map((a) => a.ident)).toEqual(['ESML', 'EBIG']);
    expect(labelCandidates(BIG, [SMALL], [SMALL, BIG]).map((a) => a.ident)).toEqual(['EBIG', 'ESML']);
    expect(labelCandidates(null, [SMALL], [BIG, SMALL]).map((a) => a.ident)).toEqual(['ESML', 'EBIG']);
  });

  async function mapWithLabels() {
    vi.useFakeTimers();
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });
    const { loadAirports } = await import('../src/airports.js');
    loadAirports.mockResolvedValue([BIG, SMALL]);
    airportWeather.mockResolvedValue(undefined);
    const setRunwayLabels = vi.fn();
    const map = setupAirportMap({ globe: {}, mapFeatures: { setRunwayLabels }, getTime: () => '2026-10-13T12:00', getLimits: () => ({ crosswind: 25, tailwind: 10 }) });
    const lastLabels = () => setRunwayLabels.mock.calls.at(-1)[0];
    const settle = async (view) => {
      map.view(view);
      await vi.advanceTimersByTimeAsync(400);
    };
    return { map, settle, lastLabels, setRunwayLabels };
  }

  it('shows the selected airport, though its tier would not, selected and only once', async () => {
    const { map, settle, lastLabels } = await mapWithLabels();
    await settle(REGION);
    expect(lastLabels().filter((l) => l.kind === 'airport').map((l) => l.airport.ident)).toEqual(['EBIG']);

    map.select(SMALL);
    const labels = lastLabels().filter((l) => l.airport?.ident === 'ESML');
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ kind: 'airport', selected: true });
    // The others stay as they were, not selected.
    expect(lastLabels().filter((l) => l.selected)).toHaveLength(1);
    expect(lastLabels().find((l) => l.airport?.ident === 'EBIG')).toMatchObject({ selected: false });

    // Still there, and still one, once the view settles again.
    await settle({ ...REGION, lat: 51.01 });
    expect(lastLabels().filter((l) => l.airport?.ident === 'ESML' && l.selected)).toHaveLength(1);
  });

  it('draws an airport that is labelled anyway as selected, without a second label', async () => {
    const { map, settle, lastLabels } = await mapWithLabels();
    await settle(REGION);
    map.select(BIG);
    expect(lastLabels().filter((l) => l.airport?.ident === 'EBIG')).toHaveLength(1);
    expect(lastLabels().find((l) => l.airport?.ident === 'EBIG').selected).toBe(true);
  });

  it('returns the label to normal when the airport is deselected', async () => {
    const { map, settle, lastLabels } = await mapWithLabels();
    await settle(REGION);
    map.select(SMALL);
    map.select(BIG);
    expect(lastLabels().some((l) => l.airport?.ident === 'ESML')).toBe(false);
    map.select(null);
    expect(lastLabels().some((l) => l.selected)).toBe(false);
    expect(lastLabels().filter((l) => l.kind === 'airport').map((l) => l.airport.ident)).toEqual(['EBIG']);
  });

  it('shows one label for the selected airport when the view is too far out for the airport map', async () => {
    const { map, settle, lastLabels, setRunwayLabels } = await mapWithLabels();
    await settle(FAR);
    expect(setRunwayLabels).not.toHaveBeenCalled();
    map.select(SMALL);
    expect(lastLabels()).toHaveLength(1);
    expect(lastLabels()[0]).toMatchObject({ kind: 'airport', selected: true, airport: SMALL, lat: 51.2, lng: 0.1 });
    // Moving about out there does not rebuild it each time.
    const calls = setRunwayLabels.mock.calls.length;
    map.view({ ...FAR, lng: 3 });
    map.view({ ...FAR, lng: 4 });
    expect(setRunwayLabels).toHaveBeenCalledTimes(calls);
    // Zooming in swaps it for the placed labels, zooming out brings the lone one back.
    await settle(REGION);
    expect(lastLabels().filter((l) => l.airport?.ident === 'ESML' && l.selected)).toHaveLength(1);
    expect(lastLabels().length).toBeGreaterThan(1);
    map.view(FAR);
    expect(lastLabels()).toHaveLength(1);
    expect(lastLabels()[0]).toMatchObject({ selected: true, airport: SMALL });
    map.select(null);
    expect(lastLabels()).toEqual([]);
  });

  it('follows the wind check for a selected airport it flags, when shown on its own', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800 });
    const { loadAirports } = await import('../src/airports.js');
    loadAirports.mockResolvedValue([BIG, SMALL]);
    const setRunwayLabels = vi.fn();
    let problems = [];
    const map = setupAirportMap({
      globe: {},
      mapFeatures: { setRunwayLabels },
      getTime: () => '2026-10-13T12:00',
      getLimits: () => ({ crosswind: 25, tailwind: 10 }),
      getProblems: () => problems,
    });
    map.view(FAR);
    map.select(SMALL);
    expect(setRunwayLabels.mock.calls.at(-1)[0][0]).toMatchObject({ flag: false, status: 'unknown' });
    problems = [{ airport: SMALL, status: 'nogo' }];
    map.refresh();
    expect(setRunwayLabels.mock.calls.at(-1)[0]).toHaveLength(1);
    expect(setRunwayLabels.mock.calls.at(-1)[0][0]).toMatchObject({ selected: true, flag: true, status: 'nogo' });
  });
});
