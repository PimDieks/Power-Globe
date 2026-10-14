import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessAirport, assessRunwayEnd, formatWind, windComponents } from '../src/runways.js';
import { conditionsAt, fold, searchAirports, toAirport } from '../src/airports.js';
import { addHours, airportDetailsHtml, alongText, acrossText, copyNote, escapeHtml, listCopyNote, panelStays, verdictText, windProblems } from '../src/airportview.js';
import { SNAPSHOT_FRESH_MS, SNAPSHOT_TIMEOUT_MS } from '../src/api.js';
import { presetFor, readLimits } from '../src/windcheck.js';
import { buildAirportUrl, fetchAirportHourly, resetApiBudget } from '../src/weather.js';
import { buildAirports, parseCsv, routeCounts } from '../scripts/build-airports.mjs';

const SCHIPHOL = toAirport([
  'EHAM', 'AMS', 'Amsterdam Airport Schiphol', 'Amsterdam', 'NL', 52.3086, 4.7639, -11, 1, 1,
  [['18R', 183, '36L', 3, 12467, 'ASP'], ['09', 87, '27', 267, 11329, 'ASP'], ['06', 58, '24', 238, 11283, 'ASP']],
]);
const SINGLE = toAirport(['XSNG', '', 'Single Runway Field', 'Nowhere', 'GB', 51, 0, 300, 0, 1, [['09', 90, '27', 270, 6000, 'ASP']]]);
const LIMITS = { crosswind: 25, tailwind: 10 };

describe('windComponents', () => {
  it('splits wind into headwind and crosswind from the right', () => {
    const straight = windComponents(270, 270, 20);
    expect(straight.along).toBeCloseTo(20);
    expect(straight.across).toBeCloseTo(0);
    const fromRight = windComponents(270, 360, 20);
    expect(fromRight.along).toBeCloseTo(0);
    expect(fromRight.across).toBeCloseTo(20);
    const tail = windComponents(90, 270, 10);
    expect(tail.along).toBeCloseTo(-10);
  });

  it('gives half the wind as crosswind at 30 degrees', () => {
    expect(windComponents(270, 240, 20).across).toBeCloseTo(-10);
  });
});

describe('assessRunwayEnd', () => {
  it('is within limits in a light wind down the runway', () => {
    const end = assessRunwayEnd(270, { direction: 270, speed: 10, gust: 14 }, LIMITS);
    expect(end.status).toBe('ok');
    expect(end.headwind).toBeCloseTo(10);
    expect(end.peak.headwind).toBeCloseTo(14);
  });

  it('counts gusts against the limits', () => {
    // A 20 kt crosswind is fine, but gusting 30 it is not.
    const end = assessRunwayEnd(270, { direction: 360, speed: 20, gust: 30 }, LIMITS);
    expect(end.status).toBe('nogo');
    expect(end.reasons).toEqual(['crosswind']);
    expect(end.crosswind).toBeCloseTo(20);
    expect(end.crosswindSide).toBe('R');
  });

  it('is marginal from 80% of a limit', () => {
    const end = assessRunwayEnd(270, { direction: 180, speed: 22, gust: null }, LIMITS);
    expect(end.status).toBe('caution');
    expect(end.crosswindSide).toBe('L');
  });

  it('limits tailwind but not headwind', () => {
    expect(assessRunwayEnd(90, { direction: 270, speed: 15 }, LIMITS).reasons).toEqual(['tailwind']);
    const intoWind = assessRunwayEnd(270, { direction: 270, speed: 45, gust: 60 }, LIMITS);
    expect(intoWind.status).toBe('ok');
    expect(intoWind.headwind).toBeCloseTo(45);
  });

  it('knows when there is no data', () => {
    expect(assessRunwayEnd(270, { direction: null, speed: null }, LIMITS).status).toBe('unknown');
  });
});

describe('assessAirport', () => {
  it('is as good as its best runway end', () => {
    // A strong westerly: 27 has it straight down the runway, 18R/36L straight across.
    const result = assessAirport(SCHIPHOL, { direction: 270, speed: 25, gust: 30 }, LIMITS);
    expect(result.status).toBe('ok');
    expect(result.best.ident).toBe('27');
    expect(result.ends.find((e) => e.ident === '18R').status).toBe('nogo');
  });

  it('is out of limits when every runway is', () => {
    const result = assessAirport(SINGLE, { direction: 360, speed: 30, gust: 45 }, LIMITS);
    expect(result.status).toBe('nogo');
    expect(verdictText(result)).toMatch(/^Out of limits on every runway/);
  });
});

describe('formatWind', () => {
  it('writes wind the way pilots do', () => {
    expect(formatWind({ direction: 243, speed: 18.2, gust: 31 })).toBe('240° 18 kt G31');
    expect(formatWind({ direction: 2, speed: 8, gust: 10 })).toBe('360° 8 kt');
    expect(formatWind({ direction: 0, speed: 0.4, gust: 2 })).toBe('Calm');
  });
});

describe('airport search', () => {
  const airports = [
    SINGLE,
    SCHIPHOL,
    toAirport(['EHRD', 'RTM', 'Rotterdam The Hague Airport', 'Rotterdam', 'NL', 51.9, 4.4, -15, 0, 1, []]),
    toAirport(['LEMD', 'MAD', 'Adolfo Suárez Madrid–Barajas Airport', 'Madrid', 'ES', 40.5, -3.6, 1998, 1, 1, []]),
  ];

  it('finds airports by ICAO or IATA code', () => {
    expect(searchAirports(airports, 'eham')[0].ident).toBe('EHAM');
    expect(searchAirports(airports, 'AMS')[0].ident).toBe('EHAM');
    expect(searchAirports(airports, 'eh').map((a) => a.ident)).toEqual(['EHAM', 'EHRD']);
  });

  it('finds airports by name or city, ignoring accents', () => {
    expect(searchAirports(airports, 'amsterdam')[0].ident).toBe('EHAM');
    expect(searchAirports(airports, 'suarez')[0].ident).toBe('LEMD');
    expect(searchAirports(airports, 'hague')[0].ident).toBe('EHRD');
  });

  it('needs at least two characters', () => {
    expect(searchAirports(airports, 'e')).toEqual([]);
    expect(fold(' Málaga ')).toBe('malaga');
  });
});

describe('conditionsAt', () => {
  const hourly = {
    time: ['2026-10-13T00:00', '2026-10-13T01:00'],
    temperature_2m: [12, 11.5],
    dew_point_2m: [10, 10.5],
    wind_speed_10m: [14, 18],
    wind_direction_10m: [250, 260],
    wind_gusts_10m: [22, 30],
  };

  it('picks the hour matching the time', () => {
    expect(conditionsAt(hourly, '2026-10-13T01:00')).toMatchObject({ temperature: 11.5, dewPoint: 10.5, speed: 18, direction: 260, gust: 30 });
  });

  it('is null outside the data', () => {
    expect(conditionsAt(hourly, '2026-10-20T00:00')).toBeNull();
    expect(conditionsAt(undefined, '2026-10-13T00:00')).toBeNull();
  });
});

describe('airport panels', () => {
  const time = '2026-10-13T12:00';
  const hours = Array.from({ length: 48 }, (_, i) => addHours('2026-10-13T00:00', i));
  const hourly = {
    time: hours,
    temperature_2m: hours.map(() => 9),
    dew_point_2m: hours.map(() => 8),
    wind_speed_10m: hours.map(() => 28),
    wind_direction_10m: hours.map(() => 0),
    wind_gusts_10m: hours.map(() => 40),
  };

  it('adds hours across midnight', () => {
    expect(addHours('2026-10-13T22:00', 3)).toBe('2026-10-14T01:00');
  });

  it('shows conditions, a verdict and every runway end', () => {
    const html = airportDetailsHtml({
      airport: SINGLE,
      hourly,
      time,
      limits: LIMITS,
      limitsLabel: 'Regional',
      formatTime: (t) => t,
      formatHour: (t) => t.slice(11),
    });
    expect(html).toContain('Out of limits');
    expect(html).toContain('360° 28 kt G40');
    expect(html).toContain('8 °C');
    expect(html).toContain('fog or low cloud likely');
    expect(html).toContain('<th scope="row">09</th>');
    expect(html).toContain('<th scope="row">27</th>');
    // Eight 3-hour steps ahead.
    expect(html.match(/outlook-hour/g)).toHaveLength(8);
    expect(html).toContain('not an official observation');
  });

  it('says why there is no forecast, and still shows the observation', () => {
    const html = airportDetailsHtml({
      airport: SINGLE,
      hourly: null,
      time,
      limits: LIMITS,
      limitsLabel: 'Regional',
      formatTime: (t) => t,
      formatHour: (t) => t.slice(11),
      observation: { error: 'not reachable' },
      error: 'Open-Meteo: <b>Daily</b> limit (429)',
    });
    expect(html).toContain('The forecast could not be loaded here (Open-Meteo: &lt;b&gt;Daily&lt;/b&gt; limit (429)).');
    expect(html).toContain('(METAR) could not be loaded here (not reachable)');
    expect(html).not.toContain('No forecast for');
  });

  it("says when the conditions come from an old copy of the site's data, and only then", () => {
    const asOf = Date.parse('2026-10-13T12:00:00Z');
    const copy = (hoursOld) => ({ ...hourly, builtAt: asOf - hoursOld * 3_600_000 });
    const show = (data) =>
      airportDetailsHtml({ airport: SINGLE, hourly: data, time, limits: LIMITS, limitsLabel: 'Regional', formatTime: (t) => `at ${t}`, formatHour: (t) => t.slice(11), asOf });
    expect(show(copy(30))).toContain("From the site&#39;s own copy, built at 2026-10-12T06:00, as live data was not available.");
    // Live data, and a copy recent enough to be used instead of asking, say nothing.
    expect(show(hourly)).not.toContain('own copy');
    expect(show(copy(2))).not.toContain('own copy');
    expect(show({ ...hourly, builtAt: asOf - SNAPSHOT_FRESH_MS })).not.toContain('own copy');
    expect(show({ ...hourly, builtAt: asOf - SNAPSHOT_FRESH_MS - 1 })).toContain('own copy');
  });

  it('gives the wind check the age of the oldest old copy among its airports', () => {
    const asOf = Date.parse('2026-10-13T12:00:00Z');
    const copy = (hoursOld) => ({ ...hourly, builtAt: asOf - hoursOld * 3_600_000 });
    const formatTime = (t) => `at ${t}`;
    expect(listCopyNote([hourly, copy(2), copy(30), copy(50)], formatTime, asOf)).toBe(
      "Some are from the site's own copy, built at 2026-10-11T10:00, as live data was not available.",
    );
    expect(listCopyNote([hourly, copy(2)].values(), formatTime, asOf)).toBe('');
    expect(copyNote(copy(2), formatTime, asOf)).toBe('');
  });

  it("leaves the panel alone when an open airport's label is tapped, unless it is showing an error", () => {
    expect(panelStays({ airport: SINGLE, error: null }, SINGLE)).toBe(true);
    expect(panelStays({ airport: SINGLE, error: 'no answer in time' }, SINGLE)).toBe(false);
    expect(panelStays({ airport: SCHIPHOL, error: null }, SINGLE)).toBe(false);
    expect(panelStays(null, SINGLE)).toBe(false);
  });

  it('describes components with gusts in brackets', () => {
    const end = assessRunwayEnd(270, { direction: 300, speed: 20, gust: 30 }, LIMITS);
    expect(alongText(end)).toBe('H 17 (26)');
    expect(acrossText(end)).toBe('10 (15) R');
  });

  it('lists airports with wind trouble, worst first', () => {
    const calm = toAirport(['XCLM', '', 'Calm Field', '', 'GB', 50, 0, 0, 1, 1, [['18', 180, '36', 360, 5000, 'ASP']]]);
    const light = { ...hourly, wind_speed_10m: hours.map(() => 20), wind_gusts_10m: hours.map(() => 22) };
    const weather = new Map([
      ['XSNG', hourly],
      ['XCLM', light],
      ['EHAM', light],
    ]);
    const { problems, checked } = windProblems([calm, SCHIPHOL, SINGLE], weather, time, LIMITS);
    expect(checked).toBe(3);
    expect(problems.map((p) => p.airport.ident)).toEqual(['XSNG']);
  });

  it('escapes text from the data', () => {
    expect(escapeHtml('<b>"A&B"</b>')).toBe('&lt;b&gt;&quot;A&amp;B&quot;&lt;/b&gt;');
  });
});

describe('limits', () => {
  it('falls back to the defaults when nothing valid is saved', () => {
    const storage = (value) => ({ getItem: () => value });
    expect(readLimits(storage(null))).toEqual({ crosswind: 25, tailwind: 10 });
    expect(readLimits(storage('{"crosswind":-1,"tailwind":10}'))).toEqual({ crosswind: 25, tailwind: 10 });
    // Limits saved before headwind was dropped still load.
    expect(readLimits(storage('{"crosswind":20,"tailwind":5,"headwind":30}'))).toEqual({ crosswind: 20, tailwind: 5 });
  });

  it('recognises presets', () => {
    expect(presetFor({ crosswind: 35, tailwind: 10 })).toBe('airliner');
    expect(presetFor({ crosswind: 33, tailwind: 10 })).toBe('custom');
  });
});

describe('airport weather requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiBudget();
  });

  it('asks for ground conditions in knots at the airport elevation', () => {
    const url = new URL(buildAirportUrl([SCHIPHOL, SINGLE]));
    expect(url.searchParams.get('latitude')).toBe('52.3086,51');
    expect(url.searchParams.get('elevation')).toBe('-3,91');
    expect(url.searchParams.get('wind_speed_unit')).toBe('kn');
    expect(url.searchParams.get('hourly')).toBe('temperature_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code,cape');
  });

  it('hands over each batch as it arrives', async () => {
    const fetchMock = vi.fn(async (url) => {
      const n = new URL(url).searchParams.get('latitude').split(',').length;
      const body = Array.from({ length: n }, (_, i) => ({ hourly: { time: ['t'], wind_speed_10m: [i] } }));
      return { ok: true, json: async () => (n === 1 ? body[0] : body) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const airports = Array.from({ length: 150 }, (_, i) => ({ ...SINGLE, ident: `X${i}` }));
    const batches = [];
    await fetchAirportHourly(airports, { onBatch: (part, hourly) => batches.push([part.length, hourly.length]) });
    expect(batches).toEqual([
      [100, 100],
      [50, 50],
    ]);
  });
});

// A time of day far from 00:00 GMT, so that tests which compute the day or the end of a copy of the
// data from the clock, and then advance the fake timers, cannot run across a change of day.
const NOW = Date.parse('2026-10-13T12:00:00Z');
const useClock = () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
};

describe('airport weather when Open-Meteo refuses', () => {
  const DAILY_LIMIT = 'Daily API request limit exceeded. Please try again tomorrow.';
  const OPEN_METEO = 'https://api.open-meteo.com/';
  const field = (id) => toAirport([id, '', `Field ${id}`, 'Nowhere', 'GB', 51, 0, 10, 0, 1, [['09', 90, '27', 270, 6000, 'ASP']]]);
  const hourlyFor = () => ({
    time: ['2026-10-13T00:00'],
    temperature_2m: [9],
    dew_point_2m: [8],
    wind_speed_10m: [5],
    wind_direction_10m: [270],
    wind_gusts_10m: [8],
  });
  const refused = { ok: false, status: 429, json: async () => ({ error: true, reason: DAILY_LIMIT }) };
  const missing = { ok: false, status: 404, json: async () => ({}) };
  // One answer per requested location, as Open-Meteo gives them (an object for a single one).
  const answer = (url) => {
    const n = new URL(url).searchParams.get('latitude').split(',').length;
    const body = Array.from({ length: n }, () => ({ hourly: hourlyFor() }));
    return { ok: true, json: async () => (n === 1 ? body[0] : body) };
  };
  // Open-Meteo refuses (unless `openMeteo`), the Power Globe API answers (unless `proxy` is false),
  // and the site has no copy of the data (unless it is given as `snapshot`).
  const services = ({ openMeteo = false, proxy = true, snapshot = null } = {}) =>
    vi.fn(async (url) => {
      url = String(url);
      if (url.startsWith(OPEN_METEO)) return openMeteo ? answer(url) : refused;
      if (url.includes('/forecast?')) return proxy ? answer(url) : { ok: false, status: 500, json: async () => ({}) };
      if (url.includes('airport-weather.json')) return snapshot ? { ok: true, json: async () => snapshot } : missing;
      throw new Error(`unexpected request ${url}`);
    });
  const locationsIn = (url) => new URL(url).searchParams.get('latitude').split(',').length;
  const askedOpenMeteo = (fetchMock) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(OPEN_METEO)).length;
  // The locations asked of Open-Meteo, one number per request.
  const askedOpenMeteoFor = (fetchMock) => fetchMock.mock.calls.filter(([url]) => String(url).startsWith(OPEN_METEO)).map(([url]) => locationsIn(url));
  // The locations asked of the Power Globe API, one number per request.
  const askedProxy = (fetchMock) =>
    fetchMock.mock.calls.filter(([url]) => !String(url).startsWith(OPEN_METEO) && String(url).includes('/forecast?')).map(([url]) => locationsIn(url));
  const copyRequests = (fetchMock) => fetchMock.mock.calls.filter(([url]) => String(url).includes('airport-weather.json')).length;
  // This browser has used `used` of its share of the day; returns what gets written back.
  const shareUsed = (used) => {
    const day = new Date().toISOString().slice(0, 10);
    const writes = [];
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ day, used }), setItem: (_, value) => writes.push(value) });
    return writes;
  };
  // A copy of the site's data made long ago that still reaches past now, holding the airports `idents` (wind 7 kt).
  const oldSnapshot = (idents) => {
    const end = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
    const rows = [[9], [8], [7], [270], [8]];
    return { built: '2026-10-01T00:00Z', times: [end], airports: Object.fromEntries(idents.map((ident) => [ident, rows])) };
  };
  // The modules afresh, so that what one test learns (a pause, the site's copy) does not leak into the next.
  const fresh = async () => {
    vi.resetModules();
    return { ...(await import('../src/airports.js')), ...(await import('../src/weather.js')) };
  };
  // Runs `request` for `ms` of fake time and says whether it had settled by then.
  const settlesWithin = async (request, ms) => {
    let settled = false;
    request.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
  };

  beforeEach(useClock);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('asks the Power Globe API for the next airport instead of waiting for the limit to reset', async () => {
    const fetchMock = services();
    vi.stubGlobal('fetch', fetchMock);
    const { airportWeather } = await fresh();
    // The first request finds out the limit is reached, and is answered by the Power Globe API.
    expect((await airportWeather([field('XAA1')], { preferLive: true })).has('XAA1')).toBe(true);
    const next = airportWeather([field('XAA2')], { preferLive: true });
    expect(await settlesWithin(next, 30_000)).toBe(true);
    expect((await next).get('XAA2').time).toHaveLength(1);
    expect(askedOpenMeteo(fetchMock)).toBe(1);
  });

  it('does the same for long lists, without pacing them', async () => {
    const fetchMock = services();
    vi.stubGlobal('fetch', fetchMock);
    const { airportWeather } = await fresh();
    await airportWeather([field('XAB0')], { preferLive: true });
    const list = Array.from({ length: 150 }, (_, i) => field(`XAB${i + 1}`));
    const waits = [];
    const request = airportWeather(list, { onWait: (waiting) => waits.push(waiting) });
    expect(await settlesWithin(request, 30_000)).toBe(true);
    expect((await request).size).toBe(150);
    expect(waits).toEqual([]);
  });

  it('does not wait for the rest of the day once this browser has used its share', async () => {
    const day = new Date().toISOString().slice(0, 10);
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ day, used: 4_990 }), setItem: () => {} });
    vi.stubGlobal('fetch', services({ openMeteo: true }));
    const { airportWeather } = await fresh();
    expect(await settlesWithin(airportWeather([field('XAC1')]), 30_000)).toBe(true);
  });

  it('still paces a list to the per-minute allowance, but not the airport being looked at', async () => {
    vi.stubGlobal('fetch', services({ openMeteo: true }));
    const { airportWeather, fetchHourly, buildGrid } = await fresh();
    // 590 of the 600 locations a minute are spent.
    await fetchHourly(buildGrid(10).slice(0, 590));
    const waits = [];
    const list = airportWeather([field('XAD1')], { onWait: (waiting) => waits.push(waiting) });
    expect(await settlesWithin(list, 30_000)).toBe(false);
    expect(waits).toEqual([true]);
    expect(await settlesWithin(list, 31_000)).toBe(true);
    expect(waits).toEqual([true, false]);
    // A new minute's worth of allowance is gone again.
    await fetchHourly(buildGrid(10).slice(0, 590));
    expect(await settlesWithin(airportWeather([field('XAD2')], { preferLive: true }), 1_000)).toBe(true);
  });

  it('says why when neither Open-Meteo nor the Power Globe API can be used', async () => {
    vi.stubGlobal('fetch', services({ proxy: false }));
    const { airportWeather } = await fresh();
    await expect(airportWeather([field('XAE1')], { preferLive: true })).rejects.toThrow(`Open-Meteo: ${DAILY_LIMIT} (429)`);
    // Already paused: the same answer at once, not a wait.
    await expect(airportWeather([field('XAE2')], { preferLive: true })).rejects.toThrow('usage limit reached');
  });

  it("falls back to the site's own copy, however old, when both fail", async () => {
    const end = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
    const rows = Object.values(hourlyFor()).slice(1).map((values) => [values[0]]);
    const snapshot = { built: '2026-10-01T00:00Z', times: [end], airports: { XAF1: rows } };
    vi.stubGlobal('fetch', services({ proxy: false, snapshot }));
    const { airportWeather } = await fresh();
    const weather = await airportWeather([field('XAF1')], { preferLive: true });
    expect(weather.get('XAF1').wind_speed_10m).toEqual([5]);
    expect(weather.get('XAF1').time).toEqual([end]);
  });

  it('sends the airport being looked at to the Power Globe API, not Open-Meteo, when the minute is used up', async () => {
    const fetchMock = services({ openMeteo: true });
    vi.stubGlobal('fetch', fetchMock);
    const { airportWeather, fetchHourly, buildGrid } = await fresh();
    await fetchHourly(buildGrid(10).slice(0, 600));
    const asked = askedOpenMeteo(fetchMock);
    const request = airportWeather([field('XAG1')], { preferLive: true });
    expect(await settlesWithin(request, 1_000)).toBe(true);
    expect((await request).has('XAG1')).toBe(true);
    expect(askedOpenMeteo(fetchMock)).toBe(asked);
    expect(askedProxy(fetchMock)).toEqual([1]);
  });

  it('lets the airport being looked at use the locations a list leaves free', async () => {
    const fetchMock = services({ openMeteo: true });
    vi.stubGlobal('fetch', fetchMock);
    const { airportWeather, fetchHourly, buildGrid } = await fresh();
    // 15 of the 600 locations a minute are left: not enough for a list, which keeps 20 free.
    await fetchHourly(buildGrid(10).slice(0, 585));
    const asked = askedOpenMeteo(fetchMock);
    await airportWeather([field('XAH1')], { preferLive: true });
    expect(askedOpenMeteo(fetchMock)).toBe(asked + 1);
    expect(askedProxy(fetchMock)).toEqual([]);
  });

  it("does not ask Open-Meteo for a list the rest of the day's share cannot cover, nor pace it", async () => {
    const writes = shareUsed(4_900);
    const fetchMock = services({ openMeteo: true });
    vi.stubGlobal('fetch', fetchMock);
    const { airportWeather } = await fresh();
    const waits = [];
    const request = airportWeather(Array.from({ length: 200 }, (_, i) => field(`XAI${i}`)), { onWait: (waiting) => waits.push(waiting) });
    expect(await settlesWithin(request, 30_000)).toBe(true);
    expect((await request).size).toBe(200);
    expect(waits).toEqual([]);
    // The 100 locations left of the day are still there, and the Power Globe API answered.
    expect(askedOpenMeteo(fetchMock)).toBe(0);
    expect(writes).toEqual([]);
    expect(askedProxy(fetchMock)).toEqual([100, 100]);
  });

  it("keeps the day's last 20 locations for the airport being looked at", async () => {
    shareUsed(4_985);
    const fetchMock = services({ openMeteo: true });
    vi.stubGlobal('fetch', fetchMock);
    const { airportWeather } = await fresh();
    await airportWeather([field('XAJ1')]);
    expect(askedOpenMeteo(fetchMock)).toBe(0);
    expect(askedProxy(fetchMock)).toEqual([1]);
    await airportWeather([field('XAJ2')], { preferLive: true });
    expect(askedOpenMeteo(fetchMock)).toBe(1);
  });

  it("takes the site's copy however old before the Power Globe API, which only gets the airports it lacks", async () => {
    const fetchMock = services({ snapshot: oldSnapshot(['XAK1', 'XAK2', 'XAK3']) });
    vi.stubGlobal('fetch', fetchMock);
    const { airportWeather } = await fresh();
    // The first request finds out the limit is reached.
    await airportWeather([field('XAK0')], { preferLive: true });
    expect(askedProxy(fetchMock)).toEqual([1]);
    const weather = await airportWeather(['XAK1', 'XAK2', 'XAK3', 'XAK4', 'XAK5'].map(field));
    expect(weather.size).toBe(5);
    expect(weather.get('XAK1').wind_speed_10m).toEqual([7]);
    expect(weather.get('XAK4').wind_speed_10m).toEqual([5]);
    expect(askedProxy(fetchMock)).toEqual([1, 2]);
    expect(askedOpenMeteo(fetchMock)).toBe(1);
  });

  it("takes the site's copy first for the whole of a long list once Open-Meteo cannot be asked for all of it", async () => {
    // 150 locations are left of the day: the first 100 could be asked, but the last 100 of 250 could not.
    shareUsed(4_850);
    const ids = Array.from({ length: 250 }, (_, i) => `XAN${i}`);
    const fetchMock = services({ openMeteo: true, snapshot: oldSnapshot(ids) });
    vi.stubGlobal('fetch', fetchMock);
    const { airportWeather } = await fresh();
    const weather = await airportWeather(ids.map(field));
    expect(weather.size).toBe(250);
    expect(askedOpenMeteo(fetchMock)).toBe(0);
    expect(askedProxy(fetchMock)).toEqual([]);
  });

  it("sends on only the airports the site's copy lacks, to Open-Meteo while the day's share covers them", async () => {
    shareUsed(4_850);
    const ids = Array.from({ length: 250 }, (_, i) => `XAO${i}`);
    const fetchMock = services({ openMeteo: true, snapshot: oldSnapshot(ids.slice(0, 200)) });
    vi.stubGlobal('fetch', fetchMock);
    const { airportWeather } = await fresh();
    expect((await airportWeather(ids.map(field))).size).toBe(250);
    expect(askedOpenMeteoFor(fetchMock)).toEqual([50]);
    expect(askedProxy(fetchMock)).toEqual([]);
  });

  it("remembers for a minute that the site's copy could not be had, then asks for it again", async () => {
    let snapshot = null;
    const fetchMock = services({ proxy: false });
    const stub = vi.fn(async (url) => (String(url).includes('airport-weather.json') && snapshot ? { ok: true, json: async () => snapshot } : fetchMock(url)));
    vi.stubGlobal('fetch', stub);
    const { airportWeather } = await fresh();
    await expect(airportWeather([field('XAL1')], { preferLive: true })).rejects.toThrow();
    expect(copyRequests(stub)).toBe(1);
    // It is there now, but not asked for again yet.
    snapshot = oldSnapshot(['XAL1']);
    await expect(airportWeather([field('XAL1')], { preferLive: true })).rejects.toThrow();
    expect(copyRequests(stub)).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    const weather = await airportWeather([field('XAL1')], { preferLive: true });
    expect(copyRequests(stub)).toBe(2);
    expect(weather.get('XAL1').wind_speed_10m).toEqual([7]);
  });

  it("asks for a missing site copy once for a list, though the list looks at it three times", async () => {
    const fetchMock = services({ proxy: false });
    vi.stubGlobal('fetch', fetchMock);
    const { airportWeather } = await fresh();
    // The first request finds out the limit is reached.
    await expect(airportWeather([field('XAM0')], { preferLive: true })).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(61_000);
    const before = copyRequests(fetchMock);
    // The list looks for recent data, then for data of any age, then again after the Power Globe API fails.
    await expect(airportWeather([field('XAM1')])).rejects.toThrow();
    expect(copyRequests(fetchMock) - before).toBe(1);
  });

  it('does not make a request that skips Open-Meteo wait behind the ones queued for it', async () => {
    let stalled = false;
    const fetchMock = services({ openMeteo: true });
    vi.stubGlobal('fetch', (url) => (stalled && String(url).startsWith(OPEN_METEO) ? new Promise(() => {}) : fetchMock(url)));
    const { fetchAirportHourly, fetchHourly, buildGrid } = await fresh();
    // The minute's allowance is used up, so the airport being looked at skips Open-Meteo.
    await fetchHourly(buildGrid(10).slice(0, 600));
    stalled = true;
    fetchHourly([{ lat: 1, lng: 2 }]);
    fetchHourly([{ lat: 3, lng: 4 }]);
    const batches = [];
    const request = fetchAirportHourly([field('XAP1')], { preferLive: true, onBatch: (part) => batches.push(part.length) });
    expect(await settlesWithin(request, 1_000)).toBe(true);
    expect(batches).toEqual([1]);
    expect(askedProxy(fetchMock)).toEqual([1]);
  });
});

describe('the airport panel never waits for ever', () => {
  const OPEN_METEO = 'https://api.open-meteo.com/';
  const field = (id) => toAirport([id, '', `Field ${id}`, 'Nowhere', 'GB', 51, 0, 10, 0, 1, [['09', 90, '27', 270, 6000, 'ASP']]]);
  const live = { time: ['2026-10-13T00:00'], temperature_2m: [9], dew_point_2m: [8], wind_speed_10m: [5], wind_direction_10m: [270], wind_gusts_10m: [8] };
  // Open-Meteo answers only when `release()` is called. The site's copy, if any, comes at once, or
  // when `releaseCopy()` is called with `holds`, or never with `stalls`.
  const setup = async (copy, { holds = false, stalls = false } = {}) => {
    let release;
    let releaseCopy;
    const held = new Promise((resolve) => (release = resolve));
    const heldCopy = new Promise((resolve) => (releaseCopy = resolve));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        url = String(url);
        if (url.startsWith(OPEN_METEO)) {
          await held;
          return { ok: true, json: async () => ({ hourly: live }) };
        }
        if (url.includes('airport-weather.json')) {
          if (stalls) return new Promise(() => {});
          if (holds) await heldCopy;
          if (copy) return { ok: true, json: async () => copy };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    vi.resetModules();
    return { ...(await import('../src/airports.js')), release, releaseCopy };
  };
  const oldCopy = (ident) => {
    const end = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
    return { built: '2026-10-01T00:00Z', times: [end], airports: { [ident]: [[9], [8], [7], [270], [8]] } };
  };
  // Whether `promise` has settled after `ms` of fake time.
  const settlesWithin = async (promise, ms) => {
    let settled = false;
    promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(ms);
    return settled;
  };

  beforeEach(useClock);
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows the site's copy when the request does not answer in time, and the real answer if it comes later", async () => {
    const { airportPanelWeather, release } = await setup(oldCopy('XPA1'));
    const onLate = vi.fn();
    const panel = airportPanelWeather(field('XPA1'), { timeoutMs: 45_000, onLate });
    await vi.advanceTimersByTimeAsync(45_000);
    const shown = await panel;
    expect(shown.wind_speed_10m).toEqual([7]);
    // The panel can tell how old the copy is.
    expect(shown.builtAt).toBe(Date.parse('2026-10-01T00:00Z'));
    expect(onLate).not.toHaveBeenCalled();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(onLate.mock.calls[0][0].wind_speed_10m).toEqual([5]);
  });

  it('says it had no answer when there is no copy either, but still hands over a late answer', async () => {
    const { airportPanelWeather, release } = await setup(null);
    const onLate = vi.fn();
    const panel = airportPanelWeather(field('XPB1'), { timeoutMs: 45_000, onLate });
    const failed = expect(panel).rejects.toThrow('no answer in time');
    await vi.advanceTimersByTimeAsync(45_000);
    await failed;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onLate.mock.calls[0][0].wind_speed_10m).toEqual([5]);
  });

  it('gives up on a site copy that does not come, and still hands over a late answer', async () => {
    const { airportPanelWeather, release } = await setup(null, { stalls: true });
    const onLate = vi.fn();
    const panel = airportPanelWeather(field('XPC1'), { timeoutMs: 45_000, onLate });
    // The copy is given up on after SNAPSHOT_TIMEOUT_MS, even if the download itself never ends.
    expect(await settlesWithin(panel, 45_000 + SNAPSHOT_TIMEOUT_MS)).toBe(true);
    await expect(panel).rejects.toThrow('no answer in time');
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(onLate.mock.calls[0][0].wind_speed_10m).toEqual([5]);
  });

  it('shows the real answer when it comes while the site copy is being fetched', async () => {
    const { airportPanelWeather, release, releaseCopy } = await setup(oldCopy('XPD1'), { holds: true });
    const onLate = vi.fn();
    const panel = airportPanelWeather(field('XPD1'), { timeoutMs: 45_000, onLate });
    expect(await settlesWithin(panel, 45_000)).toBe(false);
    release();
    expect(await settlesWithin(panel, 0)).toBe(true);
    expect((await panel).wind_speed_10m).toEqual([5]);
    // The copy arriving after that changes nothing, and the answer is not handed over twice.
    releaseCopy();
    await vi.advanceTimersByTimeAsync(0);
    expect(onLate).not.toHaveBeenCalled();
  });
});

describe('build-airports', () => {
  it('counts the airports each airport has routes to', () => {
    const routes = routeCounts('KL,1,AMS,1,JFK,2,,0,777\nDL,2,JFK,2,AMS,1,,0,767\nKL,1,AMS,1,LHR,3,,0,737\n');
    expect(routes.get('AMS')).toBe(2);
    expect(routes.get('JFK')).toBe(1);
    expect(routes.get('LHR')).toBe(1);
  });

  it('parses quoted CSV', () => {
    const rows = parseCsv('a,b,c\n1,"x, ""y""",3\r\n4,5,6\n');
    expect(rows).toEqual([
      { a: '1', b: 'x, "y"', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('keeps open runways of medium and large airports, with true headings', () => {
    const airports = [
      { id: '1', ident: 'EXXX', type: 'large_airport', name: 'Test', latitude_deg: '50.123456', longitude_deg: '4.5', elevation_ft: '30', iso_country: 'NL', municipality: 'Town', scheduled_service: 'yes', icao_code: 'EXXX', iata_code: 'TST', gps_code: '' },
      { id: '2', ident: 'EYYY', type: 'small_airport', name: 'Small', latitude_deg: '50', longitude_deg: '4', elevation_ft: '', iso_country: 'NL', municipality: '', scheduled_service: 'no', icao_code: '', iata_code: '', gps_code: '' },
    ];
    const runway = (over) => ({ airport_ref: '1', closed: '0', le_ident: '09', he_ident: '27', le_heading_degT: '', he_heading_degT: '', le_latitude_deg: '', le_longitude_deg: '', he_latitude_deg: '', he_longitude_deg: '', length_ft: '8000', surface: 'asphalt', ...over });
    const runways = [
      runway({ le_heading_degT: '92' }),
      runway({ le_ident: '18', he_ident: '36', length_ft: '6000' }),
      runway({ le_ident: 'H1', he_ident: '' }),
      runway({ le_ident: '04', he_ident: '22', closed: '1' }),
      runway({ airport_ref: '2' }),
    ];
    const [airport, ...rest] = buildAirports(airports, runways, new Map([['TST', 12]]));
    expect(rest).toEqual([]);
    expect(airport[11]).toBe(12);
    expect(airport.slice(0, 10)).toEqual(['EXXX', 'TST', 'Test', 'Town', 'NL', 50.1235, 4.5, 30, 1, 1]);
    expect(airport[10]).toEqual([
      ['09', 92, '27', 272, 8000, 'ASPH', 0, null, null, null, null],
      ['18', 180, '36', 0, 6000, 'ASPH', 0, null, null, null, null],
    ]);
  });
});

describe('wind check order', () => {
  it('measures distance on the globe, across the date line too', async () => {
    const { distance } = await import('../src/windcheck.js');
    expect(distance({ lat: 0, lng: 179 }, { lat: 0, lng: -179 })).toBeCloseTo((2 * Math.PI) / 180);
    expect(distance({ lat: 52, lng: 4 }, { lat: 52, lng: 4 })).toBe(0);
  });
});
