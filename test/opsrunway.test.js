import { describe, expect, it } from 'vitest';
import { toAirport } from '../src/airports.js';
import { assessHour, favouredRuns, noCarry, noOutlookText, outlookLines, outlookStale, outlookTimes, runwayFact, runwayOutlook, runwayRows } from '../src/opsrunway.js';
import { assessAirport, runwayEnds } from '../src/runways.js';

const LIMITS = { crosswind: 25, tailwind: 10 };
const NOW = Date.parse('2026-10-14T12:20:00Z');
// Times as the page would write them, here just the GMT clock.
const fmt = (time) => time.slice(11, 16);

const two = toAirport(['XTST', 'TST', 'Test', 'Town', 'NL', 52, 4, 0, 1, 1, [['09', 90, '27', 270, 6000, 'ASP'], ['06', 60, '24', 240, 6000, 'ASP']]]);
const one = toAirport(['XONE', null, 'One', 'Town', 'NL', 52, 4, 0, 1, 1, [['09', 90, '27', 270, 6000, 'ASP']]]);

// Hourly data from 12:00 on 14 October: one [direction, speed, gust] per hour.
function hourly(rows) {
  const t0 = Date.parse('2026-10-14T12:00:00Z');
  return {
    time: rows.map((_, i) => new Date(t0 + i * 3_600_000).toISOString().slice(0, 16)),
    wind_direction_10m: rows.map((r) => r[0]),
    wind_speed_10m: rows.map((r) => r[1]),
    wind_gusts_10m: rows.map((r) => r[2] ?? r[1]),
  };
}
const steady = (row, n = 30) => Array.from({ length: n }, () => row);
const outlookFor = (airport, rows, extra = {}) => runwayOutlook({ airport, hourly: hourly(rows), now: NOW, limits: LIMITS, ...extra });

describe('outlookTimes', () => {
  it('starts at the hour containing now and covers 24 hours', () => {
    const times = outlookTimes(NOW);
    expect(times).toHaveLength(24);
    expect(times[0]).toBe('2026-10-14T12:00');
    expect(times[23]).toBe('2026-10-15T11:00');
  });
});

describe('assessHour', () => {
  const ends = runwayEnds(two);
  const wind = (direction, speed, gust) => ({ time: '2026-10-14T12:00', direction, speed, gust: gust ?? speed });
  const carry = (favoured) => ({ ...noCarry(), favoured });

  it('favours the end with the most headwind', () => {
    const hour = assessHour(ends, wind(270, 15), LIMITS);
    expect(hour.state).toBe('favoured');
    expect(hour.favoured).toBe('27');
    expect(hour.status).toBe('ok');
  });

  it('only favours ends within limits', () => {
    // 15 kt from 090 is a tailwind of 15 on 27 and 24 (over 10), and a headwind on 09.
    const hour = assessHour(ends, wind(90, 15), LIMITS);
    expect(hour.favoured).toBe('09');
    expect(hour.ends.find((e) => e.ident === '27').status).toBe('nogo');
  });

  it('counts marginal ends as within limits', () => {
    // A 21 kt crosswind is 84% of the limit: marginal, not out.
    const hour = assessHour(runwayEnds(one), wind(0, 21), LIMITS);
    expect(hour.status).toBe('caution');
    expect(hour.favoured).not.toBeNull();
  });

  it('keeps the previous end when another has no more than a knot more headwind', () => {
    // 15 kt from 250: 14.8 kt head on 24, 14.1 kt on 27.
    expect(assessHour(ends, wind(250, 15), LIMITS).favoured).toBe('24');
    expect(assessHour(ends, wind(250, 15), LIMITS, carry('27')).favoured).toBe('27');
    // A clearly better end wins.
    expect(assessHour(ends, wind(240, 15), LIMITS, carry('27')).favoured).toBe('24');
  });

  it('does not keep a previous end that is over a limit', () => {
    expect(assessHour(ends, wind(90, 15), LIMITS, carry('27')).favoured).toBe('09');
  });

  it('includes gusts in the limits', () => {
    // A mean wind of 10 kt is fine, but gusts of 45 kt from 340 are a crosswind of 42.
    const hour = assessHour(runwayEnds(one), wind(340, 10, 45), LIMITS);
    expect(hour.status).toBe('nogo');
    expect(hour.state).toBe('none');
    expect(hour.favoured).toBeNull();
  });

  it('says calm for light wind, with any runway', () => {
    const hour = assessHour(ends, wind(270, 0), LIMITS);
    expect(hour.state).toBe('calm');
    expect(hour.favoured).toBeNull();
    expect(hour.status).toBe('ok');
  });

  it('says none when every end is over a limit', () => {
    const hour = assessHour(ends, wind(340, 30), LIMITS);
    expect(hour.state).toBe('none');
    expect(hour.status).toBe('nogo');
  });

  it('reports missing data as such', () => {
    expect(assessHour(ends, null, LIMITS).state).toBe('missing');
    expect(assessHour(ends, { time: 'x', speed: null, direction: 200 }, LIMITS).state).toBe('missing');
    expect(assessHour([], wind(270, 10), LIMITS).state).toBe('missing');
  });
});

describe('runwayEnds', () => {
  it('leaves out ends without a heading, and handles no runways', () => {
    const odd = { runways: [{ le: '09', leHeading: 90, he: '27', heHeading: null }, { le: '', leHeading: 10, he: '', heHeading: 190 }] };
    expect(runwayEnds(odd).map((e) => e.ident)).toEqual(['09']);
    expect(runwayEnds({ runways: [] })).toEqual([]);
    expect(runwayEnds({})).toEqual([]);
    expect(assessAirport(odd, { direction: 270, speed: 5 }, LIMITS).status).toBe('ok');
    expect(assessAirport({ runways: [] }, { direction: 270, speed: 10 }, LIMITS).status).toBe('unknown');
  });

  it('keeps a heading of zero', () => {
    expect(runwayEnds({ runways: [{ le: '36', leHeading: 0, he: '18', heHeading: 180 }] })).toHaveLength(2);
  });
});

describe('runwayOutlook', () => {
  it('follows a wind that shifts, naming the change', () => {
    const rows = [...steady([270, 15], 3), ...steady([240, 15], 27)];
    const outlook = outlookFor(two, rows);
    expect(outlook.hours).toHaveLength(24);
    expect(outlook.hours[0].favoured).toBe('27');
    expect(outlook.hours[3].favoured).toBe('24');
    const runs = favouredRuns(outlook);
    expect(runs.map((r) => [r.key, r.from, r.to])).toEqual([
      ['27', '2026-10-14T12:00', '2026-10-14T15:00'],
      ['24', '2026-10-14T15:00', null],
    ]);
    expect(outlookLines(outlook, fmt)).toEqual(['Runway 27 favoured until 15:00, then 24.']);
    expect(runwayFact(outlook, fmt)).toEqual({ text: 'RWY 27 → 24 at 15:00', status: 'ok' });
  });

  it('says so when the favoured runway stays the same', () => {
    const outlook = outlookFor(two, steady([270, 15]));
    expect(outlookLines(outlook, fmt)).toEqual(['Runway 27 favoured for the next 24 hours.']);
    expect(runwayFact(outlook, fmt).text).toBe('RWY 27, no change in 24 h');
  });

  it('finds the limit crossings and the hours when every runway is over', () => {
    const rows = [[270, 15], ...steady([340, 30], 3), ...steady([270, 15], 26)];
    const outlook = outlookFor(two, rows);
    expect(outlookLines(outlook, fmt)).toEqual([
      'Runway 27 favoured until 13:00, then no runway within limits until 16:00, then 27.',
      'All runways over limit from 13:00 to 16:00.',
      'Crosswind and tailwind on 09/27 over limit from 13:00 to 16:00.',
      'Crosswind on 06/24 over limit from 13:00 to 16:00.',
    ]);
    expect(runwayFact(outlook, fmt)).toEqual({ text: 'RWY 27 → none within limits at 13:00', status: 'ok' });
  });

  it('names the cause for a single runway, without an all-runways line', () => {
    // Wind from the north at 30 kt is a crosswind of 30 on 09/27.
    const rows = [...steady([270, 15], 4), ...steady([0, 30], 2), ...steady([270, 15], 24)];
    const outlook = outlookFor(one, rows);
    const lines = outlookLines(outlook, fmt);
    expect(lines).toContain('Crosswind on 09/27 over limit from 16:00 to 18:00.');
    expect(lines.some((l) => l.startsWith('All runways'))).toBe(false);
    expect(lines[0]).toBe('Runway 27 favoured until 16:00, then no runway within limits until 18:00, then 27.');
  });

  it('writes spells that run on to the end, or have already begun', () => {
    const now = outlookFor(two, [...steady([340, 30], 2), ...steady([270, 15], 28)]);
    expect(outlookLines(now, fmt)).toContain('All runways over limit now, until 14:00.');
    const late = outlookFor(two, [...steady([270, 15], 20), ...steady([340, 30], 10)]);
    expect(outlookLines(late, fmt)).toContain('All runways over limit from 08:00 onwards.');
    const whole = outlookFor(two, steady([340, 30]));
    expect(outlookLines(whole, fmt)).toContain('All runways over limit for the next 24 hours.');
  });

  it('does not report a tailwind on the wrong end of a runway that is usable the other way', () => {
    const outlook = outlookFor(one, steady([90, 15]));
    expect(outlookLines(outlook, fmt)).toEqual(['Runway 09 favoured for the next 24 hours.']);
  });

  it('shortens a long list of over-limit lines', () => {
    // A crosswind every other hour makes a spell of trouble every second hour.
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(i % 2 ? [0, 40] : [270, 15]);
    const lines = outlookLines(outlookFor(one, rows), fmt);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.at(-1)).toMatch(/more over-limit spells/);
  });

  it('names the first changes and says it changes again when there are many', () => {
    const rows = [];
    for (let i = 0; i < 30; i++) rows.push(Math.floor(i / 2) % 2 ? [340, 30] : [270, 15]);
    const first = outlookLines(outlookFor(two, rows), fmt)[0];
    expect(first).toBe('Runway 27 favoured until 14:00, then no runway within limits until 16:00, and changes again after 16:00.');
  });

  it('says calm, any runway', () => {
    const all = outlookFor(two, steady([270, 0]));
    expect(outlookLines(all, fmt)).toEqual(['Calm for the next 24 hours, any runway.']);
    expect(runwayFact(all, fmt)).toEqual({ text: 'Calm, any runway', status: 'ok' });
    const later = outlookFor(two, [...steady([0, 0], 5), ...steady([270, 12], 25)]);
    expect(outlookLines(later, fmt)[0]).toBe('Calm, any runway until 17:00, then 27.');
    expect(runwayFact(later, fmt).text).toBe('Calm → 27 at 17:00');
  });

  it('handles a forecast with gaps and one that ends early', () => {
    const early = outlookFor(two, steady([270, 15], 6));
    expect(early.hours.filter((h) => h.state === 'missing')).toHaveLength(24 - 6);
    expect(outlookLines(early, fmt)[0]).toBe('Runway 27 favoured until 18:00, then no forecast.');
    expect(runwayFact(early, fmt).text).toBe('RWY 27 → no forecast at 18:00');
    // A gap in the middle: an hour without a value.
    const gap = hourly(steady([270, 15], 30));
    gap.wind_speed_10m[3] = null;
    gap.wind_direction_10m[3] = null;
    const outlook = runwayOutlook({ airport: two, hourly: gap, now: NOW, limits: LIMITS });
    expect(outlook.hours[3].state).toBe('missing');
    expect(outlookLines(outlook, fmt)[0]).toBe('Runway 27 favoured until 15:00, then no forecast until 16:00, then 27.');
  });

  it('has nothing to say without a forecast or runways', () => {
    const none = runwayOutlook({ airport: two, hourly: null, now: NOW, limits: LIMITS });
    expect(none.reason).toBe('noForecast');
    expect(outlookLines(none, fmt)).toEqual([]);
    expect(runwayFact(none, fmt)).toBeNull();
    expect(noOutlookText(none, 'timed out')).toMatch(/timed out/);
    const gone = runwayOutlook({ airport: { runways: [] }, hourly: hourly(steady([270, 10])), now: NOW, limits: LIMITS });
    expect(gone.reason).toBe('noRunways');
    expect(noOutlookText(gone)).toMatch(/no runway/i);
    // Data that all lies before now is as good as none.
    const stale = runwayOutlook({ airport: two, hourly: hourly(steady([270, 10], 3)), now: Date.parse('2026-10-20T00:00:00Z'), limits: LIMITS });
    expect(stale.reason).toBe('noForecast');
  });

  it('works for a single runway', () => {
    const outlook = outlookFor(one, steady([250, 12]));
    expect(outlook.runways).toBe(1);
    expect(outlook.ends.map((e) => e.ident)).toEqual(['09', '27']);
    expect(outlook.hours[0].favoured).toBe('27');
  });

  it('uses the three-hourly copies the site may fall back on', () => {
    const t0 = Date.parse('2026-10-14T09:00:00Z');
    const copy = { time: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => new Date(t0 + i * 3 * 3_600_000).toISOString().slice(0, 16)) };
    copy.wind_direction_10m = copy.time.map(() => 270);
    copy.wind_speed_10m = copy.time.map(() => 12);
    copy.wind_gusts_10m = copy.time.map(() => 12);
    const outlook = runwayOutlook({ airport: two, hourly: copy, now: NOW, limits: LIMITS });
    expect(outlook.hours.every((h) => h.state === 'favoured')).toBe(true);
  });
});

describe('runways, the runway in use and the clock', () => {
  const ends = runwayEnds(two);
  const wind = (direction, speed, gust) => ({ time: '2026-10-14T12:00', direction, speed, gust: gust ?? speed });

  it('groups the ends into runways and colours each by its better end', () => {
    expect(runwayRows(ends)).toEqual([
      { label: '09/27', idents: ['09', '27'] },
      { label: '06/24', idents: ['06', '24'] },
    ]);
    // 15 kt from 270 is a tailwind of 15 on 09 (over the limit) and a headwind on 27: the runway is fine.
    const hour = assessHour(ends, wind(270, 15), LIMITS);
    expect(hour.runways.map((r) => [r.label, r.status, r.best])).toEqual([['09/27', 'ok', '27'], ['06/24', 'ok', '24']]);
    expect(hour.ends.find((e) => e.ident === '09').status).toBe('nogo');
    // Out of limits only when both ends are.
    const bad = assessHour(ends, wind(340, 30), LIMITS);
    expect(bad.runways.every((r) => r.status === 'nogo')).toBe(true);
  });

  it('keeps the runway in use as the better end within a knot, and picks the nearer limit when none is usable', () => {
    const row = runwayEnds(one);
    // 5 kt from 000: a crosswind of 5 on both ends, no headwind to tell them apart.
    expect(assessHour(row, wind(0, 5), LIMITS, { favoured: null, best: { '09/27': '27' } }).runways[0].best).toBe('27');
    expect(assessHour(row, wind(0, 5), LIMITS, { favoured: null, best: { '09/27': '09' } }).runways[0].best).toBe('09');
    // Over the limit at both ends: still one of them is named.
    const over = assessHour(row, wind(350, 40), LIMITS);
    expect(over.runways[0].status).toBe('nogo');
    expect(['09', '27']).toContain(over.runways[0].best);
  });

  it('counts calm only when the gusts are calm too', () => {
    expect(assessHour(ends, wind(270, 0.4, 0.4), LIMITS).state).toBe('calm');
    expect(assessHour(ends, { time: 't', direction: 270, speed: 0.4 }, LIMITS).state).toBe('calm');
    expect(assessHour(ends, wind(270, 0.4, 6), LIMITS).state).toBe('favoured');
  });

  it('keeps the runway in use through a calm hour and through a gap', () => {
    // 250 at 15 kt is a tie between 27 and 24, so the runway in use decides.
    const tie = [250, 15];
    const calm = outlookFor(two, [[270, 15], [270, 0], tie, ...steady(tie, 27)]);
    expect(calm.hours.slice(0, 3).map((h) => h.favoured)).toEqual(['27', null, '27']);
    const gap = hourly([[270, 15], [270, 15], tie, ...steady(tie, 27)]);
    gap.wind_speed_10m[1] = null;
    gap.wind_direction_10m[1] = null;
    const withGap = runwayOutlook({ airport: two, hourly: gap, now: NOW, limits: LIMITS });
    expect(withGap.hours.slice(0, 3).map((h) => h.state)).toEqual(['favoured', 'missing', 'favoured']);
    expect(withGap.hours[2].favoured).toBe('27');
    // Without the runway in use, the same wind favours the end with the most headwind.
    expect(outlookFor(two, steady(tie)).hours[0].favoured).toBe('24');
  });

  it('gives the same favoured ends for the same hours whenever the panel is opened', () => {
    const rows = [...steady([270, 15], 3), ...steady([250, 15], 27)];
    const early = outlookFor(two, rows, { now: Date.parse('2026-10-14T14:55:00Z') });
    const late = outlookFor(two, rows, { now: Date.parse('2026-10-14T15:05:00Z') });
    expect(early.hours[0].time).toBe('2026-10-14T14:00');
    expect(late.hours[0].time).toBe('2026-10-14T15:00');
    const favoured = (outlook) => Object.fromEntries(outlook.hours.map((h) => [h.time, h.favoured]));
    const a = favoured(early);
    const b = favoured(late);
    for (const time of Object.keys(b)) if (time in a) expect(b[time]).toBe(a[time]);
    // The tie after the shift goes the way the runway in use was going, not to a fresh pick.
    expect(late.hours[0].favoured).toBe('27');
  });

  it('knows when a new hour has begun', () => {
    expect(outlookStale('2026-10-14T12:00', Date.parse('2026-10-14T12:59:00Z'))).toBe(false);
    expect(outlookStale('2026-10-14T12:00', Date.parse('2026-10-14T13:00:00Z'))).toBe(true);
  });
});

describe('the order of the ends of an airport', () => {
  it('puts the end nearest its limits first among equally good ends, not the one with most headwind', () => {
    // Wind from the north at 10 kt. Y (heading 089) has a headwind of 0.2 and a crosswind of 10 (load 0.4);
    // X (heading 260) a tailwind of 1.7 and a crosswind of 9.8 (load 0.39). Both are within limits.
    const airport = { runways: [{ le: 'Y', leHeading: 89, he: '', heHeading: null }, { le: 'X', leHeading: 260, he: '', heHeading: null }] };
    const result = assessAirport(airport, { direction: 0, speed: 10, gust: 10 }, LIMITS);
    expect(result.ends.map((e) => e.status)).toEqual(['ok', 'ok']);
    expect(result.ends.map((e) => e.ident)).toEqual(['X', 'Y']);
    expect(result.best.ident).toBe('X');
  });
});
