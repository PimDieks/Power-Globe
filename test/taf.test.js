import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROXY_URL } from '../src/api.js';
import { latestTaf, metarVisibility, milesToMetres, newestTaf, parseTaf, tafCeiling, visibilityInWords, visibilityMetres } from '../src/taf.js';
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

  it('rounds to 50 m below 800 m, where metric reports use 50 m steps', () => {
    expect(milesToMetres(0.09)).toBe(150);
    expect(milesToMetres(0.22)).toBe(350);
    expect(milesToMetres(0.43)).toBe(700);
    expect(milesToMetres(0.37)).toBe(600);
    expect(milesToMetres(0.25)).toBe(400);
    expect(milesToMetres(0.49)).toBe(800);
    expect(milesToMetres(0)).toBe(0);
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

describe('visibility as the words of a report give it', () => {
  it('reads metric groups, CAVOK, miles and fractions of miles', () => {
    expect(visibilityInWords(['0350', 'FG'])).toBe(350);
    expect(visibilityInWords(['9999'])).toBe(10_000);
    expect(visibilityInWords(['CAVOK'])).toBe(10_000);
    expect(visibilityInWords(['P6SM', 'SKC'])).toBe(10_000);
    expect(visibilityInWords(['0SM', 'FG', 'VV001'])).toBe(0);
    expect(visibilityInWords(['1', '1/2SM', 'BR'])).toBe(2400);
    expect(visibilityInWords(['3/4SM'])).toBe(1200);
    expect(visibilityInWords(['M1/4SM', 'FG'])).toBe(400);
    expect(visibilityInWords(['3SM', 'BR'])).toBe(4800);
  });

  it('is undefined when the words give none, and the first one counts', () => {
    expect(visibilityInWords(['26006KT', 'SCT026'])).toBeUndefined();
    expect(visibilityInWords(['1506/1509', 'VRB03KT'])).toBeUndefined();
    expect(visibilityInWords(['2400', '0900N'])).toBe(2400);
  });

  it('reads a METAR after its wind, as far as the remarks and the trend', () => {
    expect(metarVisibility('METAR EFRO 141550Z AUTO 17004KT 0700 R21/0900N FG VV002 02/02 Q1009')).toBe(700);
    expect(metarVisibility('METAR EHAM 141525Z 22010KT 190V260 9999 FEW031 17/10 Q1027 NOSIG')).toBe(10_000);
    expect(metarVisibility('METAR LTFM 141550Z 01035G45KT 2400 0900N R35R/P1500U SHRA')).toBe(2400);
    expect(metarVisibility('METAR KOKC 141510Z 03011KT 3/4SM TSRA BKN005 20/19 A3010 RMK AO2')).toBe(1200);
    expect(metarVisibility('METAR CWEU 141600Z 03007KT 3/8SM IC FZFG VV004 M27/M30 A2966')).toBe(600);
    expect(metarVisibility('METAR LFPO 141600Z VRB02KT CAVOK 20/08 Q1028 NOSIG')).toBe(10_000);
    expect(metarVisibility('METAR UUEE 141600Z 36003G08MPS 310V080 CAVOK 08/07 Q1021 R06R/290245')).toBe(10_000);
  });

  it('is undefined for a METAR that gives none, and not fooled by the trend or remarks', () => {
    expect(metarVisibility('METAR MKJP 141600Z 13011KT //// ////// 31/24 Q1013 RMK CLD FROM CEILOMETER 1200')).toBeUndefined();
    expect(metarVisibility('METAR LTAI 141550Z 21009KT //// 15/14 Q1008 BECMG TL1600 9999 NSW')).toBeUndefined();
    expect(metarVisibility('')).toBeUndefined();
    expect(metarVisibility(undefined)).toBeUndefined();
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

  it('reads 0SM, which the data API gives as nothing, from the text (United States)', () => {
    const taf = parseTaf(sample('KBTR'));
    expect(taf.periods.map((p) => [p.kind, p.visibility, p.ceiling])).toEqual([
      ['BASE', 0, 100],
      ['FM', 4800, null],
      ['FM', 10_000, null],
      ['FM', 2400, 200],
    ]);
  });

  it('reads an FM group of 0SM FG SCT001 as 0 m with a ceiling of none, not as not stated', () => {
    const entry = {
      icaoId: 'KXXX',
      issueTime: '2026-10-14T11:00:00.000Z',
      validTimeFrom: 1791979200,
      validTimeTo: 1792065600,
      rawTAF: 'TAF KXXX 141100Z 1412/1512 25005KT P6SM FEW030 FM150300 00000KT 0SM FG SCT001 FM150900 25005KT 3SM BR OVC002',
      fcsts: [
        { timeFrom: 1791979200, timeTo: 1792014000, visib: '6+', clouds: [{ cover: 'FEW', base: 3000 }] },
        { timeFrom: 1792014000, timeTo: 1792036800, fcstChange: 'FM', visib: '', clouds: [{ cover: 'SCT', base: 100 }] },
        { timeFrom: 1792036800, timeTo: 1792065600, fcstChange: 'FM', visib: 3, clouds: [{ cover: 'OVC', base: 200 }] },
      ],
    };
    expect(parseTaf(entry).periods.map((p) => [p.visibility, p.ceiling])).toEqual([[10_000, null], [0, null], [4800, 200]]);
  });

  it('keeps "not stated" where the text really gives no visibility, and where a group has none to match', () => {
    const entry = { icaoId: 'GMMX', rawTAF: 'TAF GMMX 141100Z 1412/1518 26006KT SCT026 TEMPO 1415/1421 34016KT', fcsts: [
      { timeFrom: 1791979200, timeTo: 1792087200, visib: '', clouds: [{ cover: 'SCT', base: 2600 }] },
      { timeFrom: 1791988200, timeTo: 1792010400, fcstChange: 'TEMPO', visib: '' },
    ] };
    expect(parseTaf(entry).periods.map((p) => p.visibility)).toEqual([undefined, undefined]);
    // Text that does not match the groups of the data API is not used: its own figures are.
    const odd = { ...entry, rawTAF: 'TAF GMMX 141100Z 1412/1518 26006KT 0SM FEW030', fcsts: [{ timeFrom: 1, timeTo: 2, visib: 0.5 }, { timeFrom: 3, timeTo: 4, fcstChange: 'BECMG', visib: 1 }] };
    expect(parseTaf(odd).periods.map((p) => p.visibility)).toEqual([800, 1600]);
    expect(parseTaf({ ...odd, rawTAF: undefined }).periods.map((p) => p.visibility)).toEqual([800, 1600]);
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
