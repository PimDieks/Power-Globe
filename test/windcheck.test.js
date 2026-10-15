import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { airportWeather, loadAirports, toAirport } from '../src/airports.js';
import { setupWindCheck } from '../src/windcheck.js';

vi.mock('../src/airports.js', async (importOriginal) => ({
  ...(await importOriginal()),
  loadAirports: vi.fn(),
  airportWeather: vi.fn(),
}));

describe('the wind check status', () => {
  const NOW = Date.parse('2026-10-13T12:00:00Z');
  const big = toAirport(['XBIG', 'BIG', 'Big Field', 'Nowhere', 'GB', 51, 0, 10, 1, 1, [['09', 90, '27', 270, 6000, 'ASP']]]);
  const hourly = (builtAt) => ({
    time: ['2026-10-13T12:00'],
    temperature_2m: [9],
    dew_point_2m: [8],
    wind_speed_10m: [5],
    wind_direction_10m: [270],
    wind_gusts_10m: [8],
    ...(builtAt ? { builtAt } : {}),
  });

  // Just enough of the page for the wind check to run: elements that take listeners and hold text.
  function elements() {
    const el = () => ({ addEventListener() {}, classList: { contains: () => true, remove() {}, add() {} }, replaceChildren() {}, textContent: '', value: '', checked: true });
    return { order: el(), preset: el(), limitsSummary: el(), marginal: el(), retry: el(), list: el(), status: el(), panel: el(), summary: el(), crosswind: el(), tailwind: el() };
  }

  // Opens the wind check on one airport whose weather is `series`, and gives the status it ends on.
  async function statusFor(series) {
    loadAirports.mockResolvedValue([big]);
    airportWeather.mockImplementation(async (list, { onData }) => {
      const result = new Map(list.map((a) => [a.ident, series]));
      onData(result);
      return result;
    });
    const els = elements();
    const windCheck = setupWindCheck({ els, getTime: () => '2026-10-13T12:00', formatTime: (t) => `at ${t}`, onSelect() {}, onProblems() {}, onLimitsChange() {} });
    windCheck.open();
    await vi.waitFor(() => expect(els.status.textContent).toMatch(/checked/));
    return els.status.textContent;
  }

  beforeEach(() => {
    vi.setSystemTime(NOW);
    vi.stubGlobal('Option', class {});
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} });
    vi.stubGlobal('requestAnimationFrame', (callback) => setTimeout(callback, 0));
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('says nothing about the data when it is live', async () => {
    expect(await statusFor(hourly())).toBe('1 major airports checked');
  });

  it("says when a copy of the site's data that is old was used", async () => {
    const status = await statusFor(hourly(NOW - 30 * 3_600_000));
    expect(status).toBe("1 major airports checked. Some are from the site's own copy, built at 2026-10-12T06:00, as live data was not available.");
  });

  it('works nothing out while its panel is closed and none of its airports is open', async () => {
    let inUse = true;
    const onProblems = vi.fn();
    loadAirports.mockResolvedValue([big]);
    airportWeather.mockImplementation(async (list, { onData }) => {
      const result = new Map(list.map((a) => [a.ident, hourly()]));
      onData(result);
      return result;
    });
    // The panel reads as hidden throughout (see elements).
    const els = elements();
    const windCheck = setupWindCheck({ els, getTime: () => '2026-10-13T12:00', formatTime: (t) => t, onSelect() {}, onProblems, onLimitsChange() {}, inUse: () => inUse });
    windCheck.open();
    await vi.waitFor(() => expect(els.status.textContent).toMatch(/checked/));
    onProblems.mockClear();
    expect(windCheck.update()).toBe(true);
    expect(onProblems).toHaveBeenCalledTimes(1);
    inUse = false;
    expect(windCheck.update()).toBe(false);
    expect(onProblems).toHaveBeenCalledTimes(1);
  });

  it('says nothing about a copy recent enough to be used instead of asking', async () => {
    expect(await statusFor(hourly(NOW - 3_600_000))).toBe('1 major airports checked');
  });
});
