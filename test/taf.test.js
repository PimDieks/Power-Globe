import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROXY_URL } from '../src/api.js';
import { latestTaf, milesToMetres, newestTaf, parseTaf, tafCeiling, visibilityMetres } from '../src/taf.js';
import samples from './taf-samples.json';

// Real answers of the Aviation Weather Center's data API (14 October 2026), trimmed to the fields
// that are read.
const sample = (ident) => ({ ...samples[ident].meta, fcsts: samples[ident].fcsts });
const at = (time) => Date.parse(`${time}Z`);

describe('visibility in metres', () => {
  it('converts statute miles to the 100 m that reports are written in', () => {
    expect(milesToMetres(0.19)).toBe(300);
    expect(milesToMetres(0.5)).toBe(800);
    expect(milesToMetres(0.93)).toBe(1500);
    expect(milesToMetres(2.49)).toBe(4000);
    expect(milesToMetres(4.97)).toBe(8000);
    expect(milesToMetres(null)).toBeNull();
  });

  it('takes 6 miles and over (9999, P6SM, CAVOK) as 10 km or more', () => {
    expect(milesToMetres(6)).toBe(10_000);
    expect(milesToMetres(10)).toBe(16_100);
    expect(visibilityMetres('6+')).toBe(10_000);
    expect(visibilityMetres('10+')).toBe(16_100);
  });

  it('reads what the data API writes, and says when a group gives none', () => {
    expect(visibilityMetres('1 1/2')).toBe(2400);
    expect(visibilityMetres('3/4')).toBe(1200);
    expect(visibilityMetres(0.37)).toBe(600);
    expect(visibilityMetres('')).toBeUndefined();
    expect(visibilityMetres(null)).toBeUndefined();
  });
});

describe('ceiling of a TAF group', () => {
  it('is the lowest broken or overcast layer, none for few, scattered or no significant cloud, and not stated without clouds', () => {
    expect(tafCeiling([{ cover: 'FEW', base: 300 }, { cover: 'BKN', base: 1200 }, { cover: 'OVC', base: 2000 }])).toBe(1200);
    expect(tafCeiling([{ cover: 'SCT', base: 500 }])).toBeNull();
    expect(tafCeiling([{ cover: 'NSC', base: null }])).toBeNull();
    expect(tafCeiling([])).toBeUndefined();
    expect(tafCeiling(undefined)).toBeUndefined();
  });

  it('counts vertical visibility as the ceiling, but only where the sky is obscured', () => {
    expect(tafCeiling([{ cover: 'OVX', base: null }], 100)).toBe(100);
    expect(tafCeiling([{ cover: 'OVX', base: 400 }])).toBe(400);
    // The data API keeps an earlier group's vertical visibility on groups that have clouds.
    expect(tafCeiling([{ cover: 'BKN', base: 1000 }], 100)).toBe(1000);
    expect(tafCeiling([{ cover: 'OVX', base: null }])).toBeNull();
  });
});

describe('reading a TAF', () => {
  it('reads fog with vertical visibility, TEMPO and BECMG groups (Finland)', () => {
    const taf = parseTaf(sample('EFRO'));
    expect(taf).toMatchObject({ ident: 'EFRO', from: at('2026-10-14T15:00'), to: at('2026-10-15T15:00') });
    expect(taf.raw).toContain('FG VV001');
    expect(taf.periods).toHaveLength(6);
    expect(taf.periods[0]).toMatchObject({ kind: 'BASE', visibility: 300, ceiling: 100, weather: 'FG', probability: null });
    expect(taf.periods[1]).toMatchObject({ kind: 'TEMPO', visibility: 1200, ceiling: 200, from: at('2026-10-14T15:00'), to: at('2026-10-14T18:00') });
    expect(taf.periods[3]).toMatchObject({ kind: 'BECMG', from: at('2026-10-15T07:00'), becoming: at('2026-10-15T09:00'), visibility: 1200, ceiling: 200 });
    expect(taf.periods[5]).toMatchObject({ kind: 'BECMG', visibility: 10_000, ceiling: 1000 });
  });

  it('reads P6SM, FM groups and a PROB group that gives only the weather (United States)', () => {
    const taf = parseTaf(sample('KJFK'));
    expect(taf.periods.map((p) => p.kind)).toEqual(['BASE', 'FM', 'PROB', 'FM', 'FM', 'FM', 'FM', 'FM']);
    expect(taf.periods[0]).toMatchObject({ visibility: 10_000, ceiling: 25_000 });
    expect(taf.periods[1]).toMatchObject({ kind: 'FM', visibility: 10_000, ceiling: 25_000 });
    expect(taf.periods[2]).toMatchObject({ kind: 'PROB', probability: 30, visibility: undefined, ceiling: undefined, weather: '-SHRA' });
    expect(taf.periods[6]).toMatchObject({ ceiling: null });
  });

  it('reads CAVOK as 10 km or more with no ceiling, and a TEMPO that gives only the wind (France)', () => {
    const taf = parseTaf(sample('LFPG'));
    expect(taf.periods[0]).toMatchObject({ kind: 'BASE', visibility: 10_000, ceiling: null });
    expect(taf.periods[2]).toMatchObject({ kind: 'TEMPO', visibility: undefined, ceiling: undefined });
  });

  it('reads PROB40 TEMPO as a TEMPO with a probability (Germany)', () => {
    const taf = parseTaf(sample('EDDF'));
    const prob = taf.periods.find((p) => p.probability === 40 && p.visibility === 300);
    expect(prob).toMatchObject({ kind: 'TEMPO', probability: 40, ceiling: 100 });
    expect(taf.periods.some((p) => p.kind === 'TEMPO' && p.probability === null && p.visibility === 2500)).toBe(true);
  });

  it('reads PROB30 TEMPO groups (United Kingdom) and INTER, which the data API gives as TEMPO (Australia)', () => {
    const prob = parseTaf(sample('EGLL')).periods.filter((p) => p.probability);
    expect(prob.map((p) => [p.probability, p.visibility])).toEqual([[30, 8000], [40, 6000], [30, undefined]]);
    const inter = parseTaf(sample('YSSY')).periods.find((p) => p.kind === 'TEMPO');
    expect(inter).toMatchObject({ visibility: 5000, ceiling: 1300, from: at('2026-10-14T20:00') });
    // A change it does not know is taken as TEMPO.
    const odd = parseTaf({ fcsts: [{ timeFrom: 1, timeTo: 2, fcstChange: 'INTER', visib: '1' }] });
    expect(odd.periods[0]).toMatchObject({ kind: 'TEMPO', visibility: 1600 });
  });

  it('gives null for an answer with no groups', () => {
    expect(parseTaf(null)).toBeNull();
    expect(parseTaf({ icaoId: 'EHAM', fcsts: [] })).toBeNull();
    expect(parseTaf({ icaoId: 'EHAM', fcsts: [{ visib: '6+' }] })).toBeNull();
  });

  it('takes the newest of several, and null for none', () => {
    const older = { ...sample('KJFK'), issueTime: '2026-10-14T08:44:00.000Z', rawTAF: 'older' };
    expect(newestTaf([older, sample('KJFK')]).raw).toContain('141444Z');
    expect(newestTaf([])).toBeNull();
    expect(newestTaf('Not found')).toBeNull();
  });
});

describe('asking for a TAF', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), init);

  it('asks the Power Globe API, keeps the answer for a while and says none for an empty one', async () => {
    const fetchFn = vi.fn(async (url) => (url.includes('ids=EHAM') ? answer([sample('LFPG')]) : answer('')));
    vi.stubGlobal('fetch', fetchFn);
    expect((await latestTaf('EHAM')).ident).toBe('LFPG');
    expect(fetchFn.mock.calls[0][0]).toBe(`${PROXY_URL}/taf?ids=EHAM`);
    await latestTaf('EHAM');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(await latestTaf('EHRD')).toBeNull();
  });

  it('asks the Aviation Weather Center when the API cannot answer, and fails when neither can', async () => {
    const fetchFn = vi.fn(async (url) => (url.startsWith(PROXY_URL) ? answer('no route', { status: 404 }) : answer([sample('KJFK')])));
    vi.stubGlobal('fetch', fetchFn);
    expect((await latestTaf('KJFK')).ident).toBe('KJFK');
    expect(fetchFn.mock.calls[1][0]).toBe('https://aviationweather.gov/api/data/taf?ids=KJFK&format=json');

    vi.stubGlobal('fetch', vi.fn(async () => answer('down', { status: 502 })));
    await expect(latestTaf('KORD')).rejects.toThrow('aviationweather.gov answered 502');
  });
});
