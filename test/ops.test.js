import { describe, expect, it, vi } from 'vitest';
import { toAirport } from '../src/airports.js';
import { DETAIL_TABS, OPS_PARTS, opsPanelHtml, readTab, saveTab, stripHtml, tabAfterKey } from '../src/ops.js';

const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v), data };
};

describe('the airport panel tabs', () => {
  it('has Details first and Ops second', () => {
    expect(DETAIL_TABS.map((t) => t.label)).toEqual(['Details', 'Ops']);
  });

  it('remembers the tab, and falls back to Details', () => {
    const storage = memory();
    expect(readTab(storage)).toBe('details');
    saveTab('ops', storage);
    expect(readTab(storage)).toBe('ops');
    expect(readTab(memory({ 'power-globe:airport-tab': 'gone' }))).toBe('details');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readTab(broken)).toBe('details');
    expect(() => saveTab('ops', broken)).not.toThrow();
  });

  it('moves between tabs with the arrow keys, Home and End, wrapping round', () => {
    expect(tabAfterKey('ArrowRight', 0, 2)).toBe(1);
    expect(tabAfterKey('ArrowRight', 1, 2)).toBe(0);
    expect(tabAfterKey('ArrowLeft', 0, 2)).toBe(1);
    expect(tabAfterKey('ArrowDown', 0, 3)).toBe(1);
    expect(tabAfterKey('Home', 2, 3)).toBe(0);
    expect(tabAfterKey('End', 0, 3)).toBe(2);
    expect(tabAfterKey('a', 0, 2)).toBeNull();
    expect(tabAfterKey('Tab', 0, 2)).toBeNull();
  });
});

describe('the Ops parts registry', () => {
  const part = (id, over = {}) => ({
    id,
    title: `Part ${id}`,
    factLabel: id.toUpperCase(),
    analyse: () => ({ id }),
    fact: (data) => ({ text: `fact ${data.id}`, status: 'ok' }),
    html: (data) => `<p>section ${data.id}</p>`,
    ...over,
  });

  it('gives each part a section and a fact in the status strip, in order', () => {
    const html = opsPanelHtml([part('a'), part('b')], {});
    expect(html.indexOf('ops-strip')).toBeLessThan(html.indexOf('ops-section'));
    expect(html.indexOf('fact a')).toBeLessThan(html.indexOf('fact b'));
    expect(html).toContain('section a');
    expect(html).toContain('section b');
    expect(html).toContain('<h3 id="ops-a-title">Part a</h3>');
    expect(html).toContain('aria-labelledby="ops-b-title"');
  });

  it('leaves a part without a fact out of the strip, and has no strip when no part has one', () => {
    const quiet = part('q', { fact: () => null });
    expect(opsPanelHtml([part('a'), quiet], {})).not.toContain('fact q');
    const html = opsPanelHtml([quiet], {});
    expect(html).not.toContain('ops-strip');
    expect(html).toContain('section q');
    expect(stripHtml([])).toBe('');
  });

  it('passes the context to every part, and one data object to its fact and section', () => {
    const analyse = vi.fn(() => ({ id: 'x' }));
    const html = vi.fn(() => '<p>x</p>');
    const fact = vi.fn(() => ({ text: 't' }));
    opsPanelHtml([part('x', { analyse, html, fact })], { airport: 'A' });
    expect(analyse).toHaveBeenCalledTimes(1);
    expect(analyse).toHaveBeenCalledWith({ airport: 'A' });
    expect(fact).toHaveBeenCalledWith({ id: 'x' }, { airport: 'A' });
    expect(html).toHaveBeenCalledWith({ id: 'x' }, { airport: 'A' });
  });

  it('keeps the other parts when one fails, and says which part could not be shown', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = part('bad', { analyse: () => { throw new Error('nope'); } });
    const late = part('late', { html: () => { throw new Error('nope'); } });
    const html = opsPanelHtml([boom, part('ok'), late], {});
    expect(html).toContain('section ok');
    expect(html).toContain('fact ok');
    expect(html).not.toContain('fact bad');
    expect(html.match(/could not be shown/g)).toHaveLength(2);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('escapes what parts put in the strip and the headings', () => {
    const html = opsPanelHtml([part('e', { title: '<b>T</b>', fact: () => ({ text: '<i>x</i>', status: 'bogus' }) })], {});
    expect(html).not.toContain('<i>x</i>');
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(html).toContain('&lt;b&gt;T&lt;/b&gt;');
  });
});

describe('the runway part in the Ops tab', () => {
  const now = Date.parse('2026-10-14T12:20:00Z');
  const airport = toAirport(['XTST', 'TST', 'Test', 'Town', 'NL', 52, 4, 0, 1, 1, [['09', 90, '27', 270, 6000, 'ASP'], ['06', 60, '24', 240, 6000, 'ASP']]]);
  const t0 = Date.parse('2026-10-14T12:00:00Z');
  const times = Array.from({ length: 30 }, (_, i) => new Date(t0 + i * 3_600_000).toISOString().slice(0, 16));
  const hourly = {
    time: times,
    wind_direction_10m: times.map((_, i) => (i < 3 ? 270 : 240)),
    wind_speed_10m: times.map(() => 15),
    wind_gusts_10m: times.map(() => 15),
  };
  const ctx = (over = {}) => ({
    airport,
    hourly,
    now,
    time: '2026-10-14T14:00',
    limits: { crosswind: 25, tailwind: 10 },
    formatClock: (t) => `${t.slice(11, 16)} UTC`,
    formatClockShort: (t) => t.slice(11, 16),
    formatHour: (t) => t.slice(11, 16),
    zone: 'UTC',
    ...over,
  });

  it('is the first part, with its fact', () => {
    expect(OPS_PARTS[0].id).toBe('runway');
    const html = opsPanelHtml(OPS_PARTS, ctx());
    expect(html).toContain('RWY 27 → 24 at 15:00 UTC');
    expect(html).toContain('Runway 27 favoured until 15:00, then 24.');
  });

  it('draws an hour per column for each runway end, with the timeline hour marked', () => {
    const html = opsPanelHtml(OPS_PARTS, ctx());
    expect(html.match(/class="ops-hour"/g)).toHaveLength(24);
    expect(html.match(/aria-current="time"/g)).toHaveLength(1);
    expect(html).toContain('data-time="2026-10-14T14:00" data-readout');
    // Four ends in each column.
    expect(html.match(/<i class="ops-cell/g)).toHaveLength(24 * 4);
    // Numbers are in the hover text, not in the strip.
    expect(html).toContain('favoured 27, crosswind');
    expect(html).toContain('Local time, UTC');
  });

  it('shows the timeline hour in the readout, or the first hour when the timeline is elsewhere', () => {
    expect(opsPanelHtml(OPS_PARTS, ctx())).toMatch(/<p class="ops-readout" data-default="14:00 UTC · /);
    expect(opsPanelHtml(OPS_PARTS, ctx({ time: '2026-12-01T00:00' }))).toMatch(/<p class="ops-readout" data-default="12:00 UTC · /);
  });

  it('says why there is no chart', () => {
    expect(opsPanelHtml(OPS_PARTS, ctx({ hourly: null, error: 'timed out' }))).toContain('The forecast could not be loaded here (timed out).');
    const html = opsPanelHtml(OPS_PARTS, ctx({ airport: { ...airport, runways: [] } }));
    expect(html).toContain('No runway data');
    expect(html).not.toContain('ops-hour');
  });
});
