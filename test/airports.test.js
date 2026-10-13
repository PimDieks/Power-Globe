import { afterEach, describe, expect, it, vi } from 'vitest';
import { assessAirport, assessRunwayEnd, formatWind, windComponents } from '../src/runways.js';
import { conditionsAt, fold, searchAirports, toAirport } from '../src/airports.js';
import { addHours, airportDetailsHtml, alongText, acrossText, escapeHtml, verdictText, windProblems } from '../src/airportview.js';
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
    expect(url.searchParams.get('hourly')).toBe('temperature_2m,dew_point_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m');
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
      ['09', 92, '27', 272, 8000, 'ASPH'],
      ['18', 180, '36', 0, 6000, 'ASPH'],
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
