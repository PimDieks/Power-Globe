import { describe, expect, it } from 'vitest';
import { toObservation } from '../src/metar.js';
import { parseTaf } from '../src/taf.js';
import {
  DEFAULT_LVP_LIMITS,
  classify,
  cleanLimits,
  fogRuns,
  formatCeiling,
  formatVisibility,
  hourSummary,
  noOutlookText,
  observedConditions,
  outlookLines,
  parseRvr,
  problemRuns,
  readLimits,
  relativeHumidity,
  saveLimits,
  visibilityFact,
  visibilityOutlook,
  visibilityStale,
} from '../src/opsvis.js';
import samples from './taf-samples.json';

const NOW = Date.parse('2026-10-14T16:20:00Z');
// Times as the page would write them, here just the GMT clock.
const fmt = (time) => time.slice(11, 16);
const at = (time) => Date.parse(`${time}Z`);
const sample = (ident) => ({ ...samples[ident].meta, fcsts: samples[ident].fcsts });

// A TAF from groups written as [kind, from, to, visibility, ceiling, extras], times as GMT clock
// on 14 October to 15 October.
const group = (kind, from, to, visibility, ceiling, extra = {}) => ({ kind, probability: null, becoming: null, weather: '', from: at(from), to: at(to), visibility, ceiling, ...extra });
const taf = (...periods) => ({ ident: 'XXXX', issued: at('2026-10-14T15:00'), from: at('2026-10-14T15:00'), to: at('2026-10-15T18:00'), raw: '', periods });
const BASE = group('BASE', '2026-10-14T15:00', '2026-10-15T18:00', 10_000, null);

// Hourly model data from 16:00 on 14 October.
function model(rows, extra = {}) {
  const t0 = at('2026-10-14T16:00');
  const get = (key, fallback) => rows.map((r, i) => (typeof r === 'object' && r ? r[key] ?? fallback : key === 'visibility' ? r : fallback));
  return {
    time: rows.map((_, i) => new Date(t0 + i * 3_600_000).toISOString().slice(0, 16)),
    visibility: get('visibility', 10_000),
    temperature_2m: get('temperature_2m', 12),
    dew_point_2m: get('dew_point_2m', 4),
    wind_speed_10m: get('wind_speed_10m', 10),
    ...extra,
  };
}
const clearModel = (n = 30) => model(Array.from({ length: n }, () => 10_000));
const obs = (m) => toObservation({ obsTime: NOW / 1000 - 1500, temp: 12, dewp: 4, wdir: 230, wspd: 9, ...m });
const outlook = (parts) => visibilityOutlook({ now: NOW, ...parts });
const hourAt = (o, clock) => o.hours.find((h) => h.time.endsWith(clock));

describe('classify', () => {
  it('judges visibility and ceiling against the limits, strictly below', () => {
    expect(classify({ visibility: 1500, ceiling: 300 }).status).toBe('caution');
    expect(classify({ visibility: 1499, ceiling: 5000 })).toEqual({ status: 'nogo', reasons: ['visibility'] });
    expect(classify({ visibility: 10_000, ceiling: 299 })).toEqual({ status: 'nogo', reasons: ['ceiling'] });
    expect(classify({ visibility: 800, ceiling: 100 }).reasons).toEqual(['visibility', 'ceiling']);
    expect(classify({ visibility: 2999 })).toEqual({ status: 'caution', reasons: ['visibility'] });
    expect(classify({ visibility: 3000, ceiling: 499 })).toEqual({ status: 'caution', reasons: ['ceiling'] });
    expect(classify({ visibility: 3000, ceiling: 500 }).status).toBe('ok');
  });

  it('does not judge what is not known, or a sky with no ceiling', () => {
    expect(classify({ visibility: 10_000, ceiling: null }).status).toBe('ok');
    expect(classify({ visibility: null, ceiling: 200 }).status).toBe('nogo');
    expect(classify({ visibility: undefined, ceiling: undefined }).status).toBe('unknown');
    expect(classify({ visibility: null, ceiling: null }).status).toBe('unknown');
    expect(classify().status).toBe('unknown');
  });

  it('uses limits that are given', () => {
    const limits = { lvpVisibility: 550, lvpCeiling: 200, marginalVisibility: 1000, marginalCeiling: 400 };
    expect(classify({ visibility: 600, ceiling: 250 }, limits).status).toBe('caution');
    expect(classify({ visibility: 500, ceiling: 1000 }, limits).status).toBe('nogo');
    expect(classify({ visibility: 1000, ceiling: 400 }, limits).status).toBe('ok');
  });
});

describe('the limits kept in the browser', () => {
  const store = (initial = {}) => {
    const data = { ...initial };
    return { getItem: (k) => data[k] ?? null, setItem: (k, v) => (data[k] = v), data };
  };

  it('are the defaults until set, and anything unusable is a default', () => {
    expect(DEFAULT_LVP_LIMITS).toEqual({ lvpVisibility: 1500, lvpCeiling: 300, marginalVisibility: 3000, marginalCeiling: 500 });
    expect(readLimits(store())).toEqual(DEFAULT_LVP_LIMITS);
    expect(cleanLimits({ lvpVisibility: '800', lvpCeiling: '', marginalVisibility: 'abc', marginalCeiling: -5 })).toEqual({
      lvpVisibility: 800,
      lvpCeiling: 300,
      marginalVisibility: 3000,
      marginalCeiling: 500,
    });
  });

  it('keep marginal from being stricter than LVP', () => {
    expect(cleanLimits({ lvpVisibility: 4000, lvpCeiling: 700 })).toMatchObject({ lvpVisibility: 4000, marginalVisibility: 4000, lvpCeiling: 700, marginalCeiling: 700 });
  });

  it('are saved and read back, and a browser that cannot store them still works', () => {
    const s = store();
    saveLimits({ lvpVisibility: 600, lvpCeiling: 200, marginalVisibility: 1200, marginalCeiling: 400 }, s);
    expect(readLimits(s)).toEqual({ lvpVisibility: 600, lvpCeiling: 200, marginalVisibility: 1200, marginalCeiling: 400 });
    expect(readLimits(store({ 'power-globe:ops-visibility-limits': 'not json' }))).toEqual(DEFAULT_LVP_LIMITS);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readLimits(broken)).toEqual(DEFAULT_LVP_LIMITS);
    expect(() => saveLimits(DEFAULT_LVP_LIMITS, broken)).not.toThrow();
  });
});

describe('RVR', () => {
  it('reads the groups of a METAR in metres, with more-than and less-than, variation and feet', () => {
    expect(parseRvr('METAR EFRO 141550Z 0700 R21/0900N FG VV002 02/02 Q1009')).toEqual([{ runway: '21', value: 900, above: false, below: false, trend: 'N' }]);
    const ltfm = parseRvr('METAR LTFM 141550Z 2400 0900N R35R/P1500U R17L/P1500N R34L/0700N R36/0750N SHRA BKN006 15/14 Q1014');
    expect(ltfm.map((g) => [g.runway, g.value, g.above, g.trend])).toEqual([['35R', 1500, true, 'U'], ['17L', 1500, true, 'N'], ['34L', 700, false, 'N'], ['36', 750, false, 'N']]);
    expect(parseRvr('KORD 1M R04R/2400VP6000FT FG')[0]).toMatchObject({ runway: '04R', value: 730, to: 1830, toAbove: true });
    expect(parseRvr('EGLL R27L/M0050D')[0]).toMatchObject({ value: 50, below: true, trend: 'D' });
  });

  it('does not take runway state groups, remarks or nothing for RVR', () => {
    expect(parseRvr('METAR UUEE 141600Z CAVOK 08/07 Q1021 R06R/290245 R06C/290245 NOSIG')).toEqual([]);
    expect(parseRvr('METAR KJFK 10SM RMK AO2 R04R/2400FT')).toEqual([]);
    expect(parseRvr(undefined)).toEqual([]);
  });
});

describe('the METAR as conditions', () => {
  it('reads fog with vertical visibility and RVR (Finland)', () => {
    const now = observedConditions(obs({ rawOb: 'METAR EFRO 141550Z AUTO 17004KT 0700 R21/0900N FG VV002 02/02 Q1009', visib: 0.43, clouds: [{ cover: 'OVX', base: 200 }], temp: 2, dewp: 2 }));
    expect(now).toMatchObject({ visibility: 700, rvrMin: 900, controlling: 700, byRvr: false, ceiling: 200, verticalVisibility: true, spread: 0 });
  });

  it('lets a lower RVR stand for the visibility, but not an RVR of more than a value', () => {
    const low = observedConditions(obs({ rawOb: 'METAR LTFM 141550Z 2400 R34L/0700N R36/0750N SHRA', visib: 1.49 }));
    expect(low).toMatchObject({ visibility: 2400, rvrMin: 700, controlling: 700, byRvr: true });
    const above = observedConditions(obs({ rawOb: 'METAR LTFM 141550Z 0800 R35R/P1500U', visib: 0.5 }));
    expect(above).toMatchObject({ rvrMin: null, controlling: 800, byRvr: false });
  });

  it('converts statute miles (United States) and reads 10SM, P6SM and CAVOK as 10 km or more', () => {
    expect(observedConditions(obs({ rawOb: 'KOKC 3/4SM TSRA BKN005', visib: 0.75, clouds: [{ cover: 'BKN', base: 500 }] }))).toMatchObject({ visibility: 1200, ceiling: 500 });
    expect(observedConditions(obs({ rawOb: 'KJFK 10SM FEW070', visib: '10+' })).visibility).toBe(16_100);
    expect(observedConditions(obs({ rawOb: 'KJFK P6SM', visib: '6+' })).visibility).toBe(10_000);
    expect(observedConditions(obs({ rawOb: 'LFPO CAVOK 20/08', visib: '6+', fltCat: 'VFR' }))).toMatchObject({ visibility: 10_000, ceiling: null, category: 'VFR' });
  });

  it('reads the visibility from the words of the report when they give it, else from the data API miles', () => {
    expect(observedConditions(obs({ rawOb: 'METAR EFRO 141550Z AUTO 17004KT 0350 FG VV001', visib: 0.2 })).visibility).toBe(350);
    expect(observedConditions(obs({ rawOb: 'METAR XXXX 141550Z 17004KT //// ////// 12/10', visib: 1.86 })).visibility).toBe(3000);
    expect(observedConditions(obs({ rawOb: 'METAR KBTR 141553Z 00000KT 0SM FG VV001 20/20 A3000', visib: '' })).visibility).toBe(0);
  });

  it('copes with a report without visibility, temperature or an error', () => {
    const now = observedConditions(obs({ rawOb: 'METAR MKJP 141600Z 13011KT //// ////// 31/24 Q1013', visib: undefined, temp: undefined, dewp: undefined }));
    expect(now).toMatchObject({ visibility: null, spread: null, ceiling: null, rvr: [] });
    expect(observedConditions(null)).toBeNull();
    expect(observedConditions({ error: 'blocked' })).toBeNull();
  });
});

describe('the TAF hour by hour', () => {
  it('judges what prevails, FM and BECMG groups taking over from the time they say', () => {
    const t = taf(
      group('BASE', '2026-10-14T15:00', '2026-10-15T18:00', 10_000, null),
      group('FM', '2026-10-14T20:00', '2026-10-15T18:00', 2500, 400),
      group('FM', '2026-10-15T00:00', '2026-10-15T18:00', 1200, 400),
      group('FM', '2026-10-15T02:00', '2026-10-15T18:00', 10_000, null),
    );
    const o = outlook({ taf: t });
    expect(hourAt(o, '19:00').taf.prevailing.status).toBe('ok');
    expect(hourAt(o, '20:00').taf.prevailing).toMatchObject({ status: 'caution', visibility: 2500, ceiling: 400 });
    expect(hourAt(o, '23:00').taf.prevailing.status).toBe('caution');
    expect(hourAt(o, '01:00').taf.prevailing).toMatchObject({ status: 'nogo', visibility: 1200, ceiling: 400 });
    expect(hourAt(o, '02:00').taf.prevailing.status).toBe('ok');
  });

  it('counts the worse of before and after through a BECMG transition, and the new conditions after it', () => {
    const t = taf(BASE, group('BECMG', '2026-10-15T06:00', '2026-10-15T18:00', 600, undefined, { becoming: at('2026-10-15T09:00') }));
    const o = outlook({ taf: t });
    expect(hourAt(o, '05:00').taf.prevailing.status).toBe('ok');
    // 06:00 to 09:00 is the transition: the new visibility counts from the start of it, as the worse.
    expect(hourAt(o, '06:00').taf.prevailing).toMatchObject({ status: 'nogo', visibility: 600 });
    expect(hourAt(o, '08:00').taf.prevailing.status).toBe('nogo');
    expect(hourAt(o, '09:00').taf.prevailing).toMatchObject({ status: 'nogo', visibility: 600, ceiling: null });
  });

  it('lets a group keep what it does not state', () => {
    const t = taf(group('BASE', '2026-10-14T15:00', '2026-10-15T18:00', 800, 200), group('BECMG', '2026-10-15T00:00', '2026-10-15T18:00', 6000, undefined, { becoming: at('2026-10-15T01:00') }));
    const o = outlook({ taf: t });
    expect(hourAt(o, '03:00').taf.prevailing).toMatchObject({ visibility: 6000, ceiling: 200, status: 'nogo', reasons: ['ceiling'] });
  });

  it('shows a TEMPO group apart from what prevails, with only what it states changed', () => {
    const t = taf(group('BASE', '2026-10-14T15:00', '2026-10-15T18:00', 10_000, 1500), group('TEMPO', '2026-10-15T03:00', '2026-10-15T08:00', 600, undefined));
    const o = outlook({ taf: t });
    expect(hourAt(o, '02:00').taf.change).toBeNull();
    expect(hourAt(o, '03:00').taf).toMatchObject({ prevailing: { status: 'ok' }, change: { label: 'TEMPO', status: 'nogo', visibility: 600, ceiling: 1500, weight: 'tempo' } });
    expect(hourAt(o, '07:00').taf.change.status).toBe('nogo');
    expect(hourAt(o, '08:00').taf.change).toBeNull();
  });

  it('labels PROB groups, with or without TEMPO, and leaves out groups that state no visibility or ceiling', () => {
    const t = taf(
      BASE,
      group('PROB', '2026-10-15T01:00', '2026-10-15T03:00', 1000, undefined, { probability: 30 }),
      group('TEMPO', '2026-10-15T04:00', '2026-10-15T06:00', 2000, undefined, { probability: 40 }),
      group('PROB', '2026-10-15T07:00', '2026-10-15T09:00', undefined, undefined, { probability: 30, weather: '-SHRA' }),
    );
    const o = outlook({ taf: t });
    expect(hourAt(o, '01:00').taf.change).toMatchObject({ label: 'PROB30', weight: 'prob', status: 'nogo' });
    expect(hourAt(o, '04:00').taf.change).toMatchObject({ label: 'PROB40 TEMPO', weight: 'prob', status: 'caution' });
    expect(hourAt(o, '07:00').taf.change).toBeNull();
    expect(o.taf.changes).toBe(true);
  });

  it('takes the worst of several groups in an hour', () => {
    const t = taf(BASE, group('TEMPO', '2026-10-15T03:00', '2026-10-15T05:00', 2000, undefined), group('TEMPO', '2026-10-15T04:00', '2026-10-15T06:00', 700, undefined));
    expect(hourAt(outlook({ taf: t }), '04:00').taf.change.visibility).toBe(700);
  });

  it('knows nothing of hours the TAF does not cover, and of a TAF that has run out', () => {
    const t = taf(group('BASE', '2026-10-14T15:00', '2026-10-15T00:00', 10_000, null));
    const o = outlook({ taf: { ...t, to: at('2026-10-15T00:00') } });
    expect(hourAt(o, '23:00').taf.prevailing.status).toBe('ok');
    expect(hourAt(o, '00:00').taf.prevailing).toBeNull();
    expect(hourAt(o, '00:00').level).toBe('unknown');
    const expired = outlook({ taf: { ...t, to: at('2026-10-14T16:00') } });
    expect(expired.taf.state).toBe('expired');
    expect(outlookLines(expired, fmt)).toContain('The latest TAF is no longer valid.');
  });

  it('judges real TAFs: fog in Finland, CAVOK in France, US statute miles, a PROB40 fog in Germany', () => {
    const efro = outlook({ taf: parseTaf(sample('EFRO')) });
    expect(hourAt(efro, '16:00').taf).toMatchObject({ prevailing: { status: 'nogo', visibility: 300 }, change: { status: 'nogo' } });
    expect(hourAt(efro, '14:00').taf.prevailing.status).toBe('ok');
    const lfpg = outlook({ taf: parseTaf(sample('LFPG')) });
    expect(lfpg.hours.every((h) => h.taf.prevailing === null || h.taf.prevailing.status === 'ok')).toBe(true);
    expect(lfpg.taf.changes).toBe(false);
    const kjfk = outlook({ taf: parseTaf(sample('KJFK')) });
    expect(hourAt(kjfk, '19:00').taf).toMatchObject({ prevailing: { visibility: 10_000, ceiling: 25_000, status: 'ok' }, change: null });
    const eddf = outlook({ taf: parseTaf(sample('EDDF')) });
    expect(hourAt(eddf, '05:00').taf.change).toMatchObject({ label: 'PROB40 TEMPO', status: 'nogo' });
    expect(hourAt(eddf, '05:00').taf.prevailing.status).toBe('ok');
  });
});

describe('the verdict of each hour', () => {
  const lvpTempo = taf(BASE, group('TEMPO', '2026-10-15T03:00', '2026-10-15T08:00', 600, undefined));
  const lvpModel = model(Array.from({ length: 30 }, (_, i) => (i >= 11 && i < 16 ? 800 : 10_000)));

  it('says LVP likely when a TEMPO group and the model agree, as in the example', () => {
    const o = outlook({ taf: lvpTempo, hourly: lvpModel, observation: obs({ visib: '6+', rawOb: 'METAR XXXX 9999' }) });
    expect(hourAt(o, '03:00')).toMatchObject({ level: 'nogo', strength: 'likely' });
    expect(hourAt(o, '03:00').sources.map((s) => s.label)).toEqual(['TAF TEMPO', 'model']);
    expect(outlookLines(o, fmt)[0]).toBe('LVP likely from 03:00 to 08:00 (TAF TEMPO, model).');
  });

  it('says possible for a TEMPO group, a PROB group or the model alone', () => {
    const tempoOnly = outlook({ taf: lvpTempo });
    expect(hourAt(tempoOnly, '04:00')).toMatchObject({ level: 'nogo', strength: 'possible' });
    expect(outlookLines(tempoOnly, fmt)[0]).toBe('LVP possible from 03:00 to 08:00 (TAF TEMPO).');
    const modelOnly = outlook({ hourly: lvpModel });
    expect(outlookLines(modelOnly, fmt)[0]).toBe('LVP possible from 03:00 to 08:00 (model).');
    const probWithModel = outlook({ taf: taf(BASE, group('PROB', '2026-10-15T03:00', '2026-10-15T08:00', 600, undefined, { probability: 30 })), hourly: lvpModel });
    expect(hourAt(probWithModel, '04:00').strength).toBe('possible');
  });

  it('says expected for what prevails in the TAF and what the METAR shows now', () => {
    const t = taf(BASE, group('FM', '2026-10-15T03:00', '2026-10-15T07:00', 500, undefined), group('FM', '2026-10-15T07:00', '2026-10-15T18:00', 10_000, null));
    const o = outlook({ taf: t, hourly: lvpModel });
    expect(outlookLines(o, fmt)[0]).toBe('LVP expected from 03:00 to 07:00 (TAF, model).');
    expect(outlookLines(o, fmt)[1]).toBe('LVP possible from 07:00 to 08:00 (model).');
  });

  it('puts the METAR first and says now', () => {
    const fog = obs({ rawOb: 'METAR OOSH 141550Z AUTO 11004KT 0600 FG 33/19 Q1012', visib: 0.37, temp: 33, dewp: 19 });
    const only = outlook({ observation: fog });
    expect(outlookLines(only, fmt)).toEqual(['LVP now (METAR).', 'There is no forecast of visibility here, so the next hours cannot be judged.', 'Loading the TAF…']);
    const withTaf = outlook({ observation: fog, taf: taf(group('BASE', '2026-10-14T15:00', '2026-10-14T20:00', 500, undefined), group('FM', '2026-10-14T20:00', '2026-10-15T18:00', 10_000, null)) });
    expect(outlookLines(withTaf, fmt)[0]).toBe('LVP now, until 20:00 (METAR, TAF).');
  });

  it('writes marginal spells after LVP ones, and sums up what does not fit', () => {
    const t = taf(
      BASE,
      group('FM', '2026-10-14T18:00', '2026-10-14T19:00', 2000, null),
      group('FM', '2026-10-14T19:00', '2026-10-14T20:00', 10_000, null),
      group('FM', '2026-10-14T20:00', '2026-10-14T21:00', 1000, null),
      group('FM', '2026-10-14T21:00', '2026-10-14T22:00', 10_000, null),
      group('FM', '2026-10-14T22:00', '2026-10-14T23:00', 900, null),
      group('FM', '2026-10-14T23:00', '2026-10-15T00:00', 10_000, null),
      group('FM', '2026-10-15T00:00', '2026-10-15T01:00', 800, null),
      group('FM', '2026-10-15T01:00', '2026-10-15T02:00', 10_000, null),
      group('FM', '2026-10-15T02:00', '2026-10-15T03:00', 700, null),
      group('FM', '2026-10-15T03:00', '2026-10-15T18:00', 10_000, null),
    );
    const lines = outlookLines(outlook({ taf: t }), fmt);
    expect(lines.slice(0, 4).every((l) => l.startsWith('LVP expected from'))).toBe(true);
    // The marginal hour at 18:00 is the fifth spell.
    expect(lines[4]).toBe('1 more spell in the strips below.');
    expect(lines).toHaveLength(6);
  });

  it('writes a marginal spell as marginal', () => {
    const t = taf(BASE, group('FM', '2026-10-15T11:00', '2026-10-15T14:00', 2500, 400), group('FM', '2026-10-15T14:00', '2026-10-15T18:00', 10_000, null));
    expect(outlookLines(outlook({ taf: t }), fmt)[0]).toBe('Marginal visibility or ceiling expected from 11:00 to 14:00 (TAF).');
  });

  it('writes a spell that lasts to the end, and one that fills the outlook', () => {
    const t = taf(BASE, group('FM', '2026-10-15T10:00', '2026-10-15T18:00', 500, undefined));
    expect(outlookLines(outlook({ taf: t }), fmt)[0]).toBe('LVP expected from 10:00 onwards (TAF).');
    const all = outlook({ taf: taf(group('BASE', '2026-10-14T15:00', '2026-10-16T00:00', 500, undefined)) });
    expect(outlookLines(all, fmt)[0]).toBe('LVP expected for the next 24 hours (TAF).');
  });

  it('says visibility is above limits when it is, naming the sources that say so', () => {
    const clear = obs({ rawOb: 'METAR XXXX 9999', visib: '6+' });
    expect(outlookLines(outlook({ observation: clear, taf: taf(BASE), hourly: clearModel() }), fmt)).toEqual(['Visibility and ceiling above limits for the next 24 hours (TAF, model).']);
    expect(outlookLines(outlook({ observation: clear, taf: null, hourly: clearModel() }), fmt)).toEqual(['Visibility above limits for the next 24 hours (model).', 'No TAF for this airport.']);
  });

  it('uses the limits it is given', () => {
    const t = taf(group('BASE', '2026-10-14T15:00', '2026-10-15T18:00', 2000, null));
    expect(outlookLines(outlook({ taf: t }), fmt)[0]).toContain('Marginal');
    const loose = { lvpVisibility: 500, lvpCeiling: 100, marginalVisibility: 1000, marginalCeiling: 200 };
    expect(outlookLines(outlook({ taf: t, limits: loose }), fmt)[0]).toContain('above limits');
    const strict = { lvpVisibility: 2500, lvpCeiling: 300, marginalVisibility: 3000, marginalCeiling: 500 };
    expect(outlookLines(outlook({ taf: t, limits: strict }), fmt)[0]).toBe('LVP expected for the next 24 hours (TAF).');
  });
});

describe('what is missing', () => {
  it('says so for an airport without a METAR or a TAF, and uses the model alone', () => {
    const o = outlook({ hourly: clearModel(), observation: null, taf: null });
    expect(outlookLines(o, fmt)).toEqual([
      'Visibility above limits for the next 24 hours (model).',
      'No METAR from this airport in the last 3 hours.',
      'No TAF for this airport.',
    ]);
    expect(o.hasData).toBe(true);
  });

  it('says there is nothing when there is nothing', () => {
    const o = outlook({ hourly: { time: ['2026-10-14T16:00'], temperature_2m: [10] }, observation: null, taf: null });
    expect(o.hasData).toBe(false);
    expect(outlookLines(o, fmt)).toEqual(['No METAR from this airport in the last 3 hours.', 'No TAF for this airport.']);
    expect(noOutlookText(o)).toBe('No METAR from this airport in the last 3 hours. No TAF for this airport.');
    expect(visibilityFact(o, fmt)).toEqual({ text: 'No data', status: 'unknown' });
    expect(noOutlookText(outlook({}))).toContain('Loading the METAR');
    expect(noOutlookText({ metar: { state: 'ok' }, taf: { state: 'ok' } })).toBe('No METAR, TAF or model visibility for this airport.');
  });

  it('says what failed, and that it is loading', () => {
    const o = outlook({ observation: { error: 'blocked' }, taf: { error: 'aviationweather.gov answered 502' }, hourly: clearModel() });
    expect(outlookLines(o, fmt)).toContain('The METAR could not be loaded (blocked).');
    expect(outlookLines(o, fmt)).toContain('The TAF could not be loaded (aviationweather.gov answered 502).');
    expect(outlookLines(outlook({ hourly: clearModel() }), fmt)).toContain('Loading the TAF…');
  });

  it('leaves out the model when the forecast has no visibility, or none in the next hours', () => {
    expect(outlook({ hourly: model([10_000]), taf: taf(BASE) }).model.state).toBe('ok');
    const noVis = outlook({ hourly: { time: ['2026-10-14T16:00'], temperature_2m: [10], dew_point_2m: [9] }, taf: taf(BASE) });
    expect(noVis.model.state).toBe('none');
    expect(noVis.hours.every((h) => h.model === null)).toBe(true);
    const gaps = outlook({ hourly: model([null, null, null]), taf: taf(BASE) });
    expect(gaps.model.state).toBe('none');
    expect(outlook({ hourly: null, taf: taf(BASE) }).model.state).toBe('none');
  });

  it('copes with a model that stops before the outlook ends', () => {
    const o = outlook({ hourly: model([10_000, 800, 10_000]) });
    expect(o.hours[1].model.status).toBe('nogo');
    expect(o.hours[5].model).toBeNull();
    expect(o.hours[5].level).toBe('unknown');
  });
});

describe('the fog hint', () => {
  // Humid, still hours from 02:00 to 06:00 in the model.
  const damp = (extra = {}) => model(Array.from({ length: 30 }, (_, i) => (i >= 10 && i < 15 ? { visibility: 10_000, temperature_2m: 5, dew_point_2m: 4.5, wind_speed_10m: 3, ...extra } : { visibility: 10_000, temperature_2m: 12, dew_point_2m: 4, wind_speed_10m: 10 })));

  it('needs a spread of 2 degrees or less, light wind and high humidity', () => {
    const o = outlook({ hourly: damp() });
    expect(o.hours.filter((h) => h.fog).map((h) => fmt(h.time))).toEqual(['02:00', '03:00', '04:00', '05:00', '06:00']);
    expect(fogRuns(o)).toEqual([{ start: 10, end: 15, from: '2026-10-15T02:00', to: '2026-10-15T07:00' }]);
    expect(outlookLines(o, fmt).find((l) => l.startsWith('Fog risk'))).toBe('Fog risk from 02:00 to 07:00: spread 2 °C or less, wind 8 kt or less, humidity 90% or more.');
    expect(outlook({ hourly: damp({ wind_speed_10m: 12 }) }).hours.some((h) => h.fog)).toBe(false);
    expect(outlook({ hourly: damp({ dew_point_2m: 2 }) }).hours.some((h) => h.fog)).toBe(false);
    // Within 2 degrees, but not humid enough: cold air near 0 with a 2 degree spread is 86%.
    expect(outlook({ hourly: damp({ temperature_2m: 0, dew_point_2m: -2 }) }).hours.some((h) => h.fog)).toBe(false);
  });

  it('is in the readout of an hour and its summary, and needs the model', () => {
    const o = outlook({ hourly: damp(), taf: taf(BASE) });
    expect(hourSummary(hourAt(o, '03:00'))).toBe('above limits, fog risk');
    expect(hourSummary(hourAt(o, '12:00'))).toBe('above limits');
    expect(outlook({ taf: taf(BASE) }).hours.some((h) => h.fog)).toBe(false);
  });

  it('takes the spread and wind of the first hour from the METAR', () => {
    const wet = obs({ rawOb: 'METAR XXXX 9999', visib: '6+', temp: 9, dewp: 8, wspd: 4 });
    const dry = obs({ rawOb: 'METAR XXXX 9999', visib: '6+', temp: 12, dewp: 4, wspd: 4 });
    // The model has the first hour dry; the METAR says it is not. The model's humidity is the model's own.
    const humid = model(Array.from({ length: 30 }, () => ({ visibility: 10_000, temperature_2m: 5, dew_point_2m: 4.5, wind_speed_10m: 12 })));
    expect(outlook({ hourly: humid, observation: wet }).hours[0].fog).toBe(true);
    expect(outlook({ hourly: humid, observation: dry }).hours[0].fog).toBe(false);
    expect(outlook({ hourly: humid }).hours[0].fog).toBe(false);
  });

  it('computes humidity from temperature and dew point', () => {
    expect(relativeHumidity(10, 10)).toBeCloseTo(100, 5);
    expect(relativeHumidity(20, 10)).toBeCloseTo(52.5, 0);
    expect(relativeHumidity(null, 10)).toBeNull();
  });
});

describe('the status fact', () => {
  const fog = obs({ rawOb: 'METAR EFRO 141550Z AUTO 17004KT 0700 R21/0900N FG VV002 02/02 Q1009', visib: 0.43, clouds: [{ cover: 'OVX', base: 200 }], temp: 2, dewp: 2 });

  it('gives the visibility and LVP when the METAR is over a limit', () => {
    const vis = obs({ rawOb: 'METAR OOSH 141550Z 11004KT 0800 FG', visib: 0.5 });
    expect(visibilityFact(outlook({ observation: vis }), fmt)).toEqual({ text: 'VIS 800 m, LVP', status: 'nogo' });
    expect(visibilityFact(outlook({ observation: fog }), fmt)).toEqual({ text: 'VIS 700 m, VV 200 ft, LVP', status: 'nogo' });
    const cig = obs({ rawOb: 'METAR KOKC 10SM OVC002', visib: 10, clouds: [{ cover: 'OVC', base: 200 }] });
    expect(visibilityFact(outlook({ observation: cig }), fmt)).toEqual({ text: 'CIG 200 ft, LVP', status: 'nogo' });
  });

  it('names the RVR when it is what is low', () => {
    const rvr = obs({ rawOb: 'METAR LTFM 2400 R34L/0700N', visib: 1.49 });
    expect(visibilityFact(outlook({ observation: rvr }), fmt)).toEqual({ text: 'RVR 700 m, LVP', status: 'nogo' });
  });

  it('says marginal when it is marginal', () => {
    const o = obs({ rawOb: 'METAR LTAI 2500 TSRA', visib: 1.55 });
    expect(visibilityFact(outlook({ observation: o }), fmt)).toEqual({ text: 'VIS 2,500 m, marginal', status: 'caution' });
  });

  it('warns of LVP to come, in amber, with how sure it is', () => {
    const clear = obs({ rawOb: 'METAR EHAM 9999', visib: '6+' });
    const t = taf(BASE, group('FM', '2026-10-15T03:00', '2026-10-15T08:00', 500, undefined), group('FM', '2026-10-15T08:00', '2026-10-15T18:00', 10_000, null));
    expect(visibilityFact(outlook({ observation: clear, taf: t }), fmt)).toEqual({ text: 'LVP expected 03:00', status: 'caution' });
    const tempo = taf(BASE, group('TEMPO', '2026-10-15T03:00', '2026-10-15T08:00', 500, undefined));
    expect(visibilityFact(outlook({ observation: clear, taf: tempo }), fmt)).toEqual({ text: 'LVP possible 03:00', status: 'caution' });
    const marginal = taf(BASE, group('FM', '2026-10-15T11:00', '2026-10-15T14:00', 2500, undefined), group('FM', '2026-10-15T14:00', '2026-10-15T18:00', 10_000, null));
    expect(visibilityFact(outlook({ observation: clear, taf: marginal }), fmt)).toEqual({ text: 'Marginal expected 11:00', status: 'caution' });
  });

  it('says all is well when it is', () => {
    const clear = obs({ rawOb: 'METAR EHAM 9999', visib: '6+' });
    expect(visibilityFact(outlook({ observation: clear, taf: taf(BASE) }), fmt)).toEqual({ text: 'VIS 10 km or more, no LVP in 24 h', status: 'ok' });
    expect(visibilityFact(outlook({ observation: clear }), fmt)).toEqual({ text: 'VIS 10 km or more', status: 'ok' });
    expect(visibilityFact(outlook({ taf: taf(BASE) }), fmt)).toEqual({ text: 'No LVP expected in 24 h', status: 'ok' });
  });

  it('uses the forecast for now when there is no METAR', () => {
    const t = taf(group('BASE', '2026-10-14T15:00', '2026-10-15T18:00', 500, undefined));
    expect(visibilityFact(outlook({ taf: t }), fmt)).toEqual({ text: 'LVP now', status: 'nogo' });
    expect(visibilityFact(outlook({ hourly: model([2500, 10_000]) }), fmt)).toEqual({ text: 'Marginal now', status: 'caution' });
  });
});

describe('runs and wording', () => {
  it('splits a spell where it changes level or how sure it is', () => {
    const t = taf(BASE, group('FM', '2026-10-15T01:00', '2026-10-15T04:00', 2500, undefined), group('FM', '2026-10-15T04:00', '2026-10-15T06:00', 500, undefined), group('FM', '2026-10-15T06:00', '2026-10-15T18:00', 10_000, null));
    const runs = problemRuns(outlook({ taf: t }));
    expect(runs.map((r) => [r.level, r.strength, r.from.slice(11, 16), r.to?.slice(11, 16)])).toEqual([
      ['caution', 'expected', '01:00', '04:00'],
      ['nogo', 'expected', '04:00', '06:00'],
    ]);
    expect(runs[1]).toMatchObject({ start: 12, end: 14, sources: ['TAF'] });
  });

  it('formats numbers and tells whether an outlook is out of date', () => {
    expect(formatVisibility(800)).toBe('800 m');
    expect(formatVisibility(1500)).toBe('1,500 m');
    expect(formatVisibility(10_000)).toBe('10 km or more');
    expect(formatVisibility(null)).toBe('unknown');
    expect(formatCeiling(1200)).toBe('1,200 ft');
    expect(formatCeiling(null)).toBe('none');
    expect(visibilityStale('2026-10-14T16:00', Date.parse('2026-10-14T16:59:00Z'))).toBe(false);
    expect(visibilityStale('2026-10-14T16:00', Date.parse('2026-10-14T17:00:30Z'))).toBe(true);
  });

  it('writes the summary of an hour for a screen reader', () => {
    const o = outlook({ taf: taf(BASE, group('TEMPO', '2026-10-15T03:00', '2026-10-15T05:00', 600, undefined)) });
    expect(hourSummary(hourAt(o, '03:00'))).toBe('LVP possible');
    expect(hourSummary(hourAt(o, '12:00'))).toBe('above limits');
    expect(hourSummary({ level: 'unknown' })).toBe('no data');
  });
});
