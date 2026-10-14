import { afterEach, describe, expect, it, vi } from 'vitest';
import { toAirport } from '../src/airports.js';
import {
  DETAIL_TABS,
  OPS_PARTS,
  STALE_AFTER_MS,
  SUMMARY_REFRESH_MS,
  TOPIC_TABS,
  analysePart,
  createOpsHost,
  isTopicTab,
  opsPanelHtml,
  partsByTab,
  readTab,
  saveTab,
  summaryFact,
  summaryHtml,
  tabAfterKey,
  tabsFor,
} from '../src/ops.js';

const memory = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v), data };
};

describe('the airport panel tabs', () => {
  it('has Details, Weather, Traffic and Access, in that order', () => {
    expect(DETAIL_TABS.map((t) => t.label)).toEqual(['Details', 'Weather', 'Traffic', 'Access']);
    expect(DETAIL_TABS.map((t) => t.id)).toEqual(['details', 'weather', 'traffic', 'access']);
    expect(isTopicTab('weather')).toBe(true);
    expect(isTopicTab('details')).toBe(false);
  });

  it('remembers the tab, and falls back to Details', () => {
    const storage = memory();
    expect(readTab(storage)).toBe('details');
    saveTab('traffic', storage);
    expect(readTab(storage)).toBe('traffic');
    expect(readTab(memory({ 'power-globe:airport-tab': 'gone' }))).toBe('details');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(readTab(broken)).toBe('details');
    expect(() => saveTab('weather', broken)).not.toThrow();
  });

  it('turns the old "ops" tab into "weather", and keeps it so', () => {
    const storage = memory({ 'power-globe:airport-tab': 'ops' });
    expect(readTab(storage)).toBe('weather');
    expect(storage.data['power-globe:airport-tab']).toBe('weather');
    expect(readTab(storage)).toBe('weather');
    // A browser that cannot write still gets the new name.
    const readOnly = { getItem: () => 'ops', setItem: () => { throw new Error('full'); } };
    expect(readTab(readOnly)).toBe('weather');
  });

  it('survives a localStorage that throws when it is looked up', () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    try {
      expect(readTab()).toBe('details');
      expect(() => saveTab('weather')).not.toThrow();
    } finally {
      if (had) Object.defineProperty(globalThis, 'localStorage', had);
      else delete globalThis.localStorage;
    }
  });

  it('moves between tabs with the arrow keys, Home and End, wrapping round', () => {
    expect(tabAfterKey('ArrowRight', 0, 4)).toBe(1);
    expect(tabAfterKey('ArrowRight', 3, 4)).toBe(0);
    expect(tabAfterKey('ArrowLeft', 0, 4)).toBe(3);
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
    tab: 'weather',
    title: `Part ${id}`,
    factLabel: id.toUpperCase(),
    analyse: () => ({ id }),
    fact: (data) => ({ text: `fact ${data.id}`, status: 'ok' }),
    html: (data) => `<p>section ${data.id}</p>`,
    ...over,
  });

  it('puts the registered parts in their tabs: runway, visibility and lightning in Weather, traffic in Traffic', () => {
    const groups = partsByTab(OPS_PARTS);
    expect(groups.weather.map((p) => p.id)).toEqual(['runway', 'visibility', 'lightning']);
    expect(groups.traffic.map((p) => p.id)).toEqual(['traffic']);
    expect(groups.access).toEqual([]);
    expect(OPS_PARTS.every((p) => TOPIC_TABS.some((t) => t.id === p.tab))).toBe(true);
  });

  it('groups parts by the tab they declare, in registry order, and adding one touches nothing else', () => {
    const groups = partsByTab([part('a'), part('b', { tab: 'traffic' }), part('c'), part('d', { tab: 'access' })]);
    expect(groups.weather.map((p) => p.id)).toEqual(['a', 'c']);
    expect(groups.traffic.map((p) => p.id)).toEqual(['b']);
    expect(groups.access.map((p) => p.id)).toEqual(['d']);
  });

  it('leaves out a part in a tab that does not exist, with a note', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lost = part('lost', { tab: 'nowhere' });
    const groups = partsByTab([part('a'), lost]);
    expect(Object.values(groups).flat().map((p) => p.id)).toEqual(['a']);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('lost'));
    spy.mockRestore();
  });

  it('always has the Access tab, with a note while it has no part', () => {
    expect(tabsFor([]).map((t) => t.id)).toEqual(['details', 'access']);
    expect(tabsFor([part('a')]).map((t) => t.id)).toEqual(['details', 'weather', 'access']);
    expect(TOPIC_TABS.find((t) => t.id === 'access').empty).toBe('Road and public transport information, coming soon');
  });

  it('gives each part a section with a heading to focus, in order', () => {
    const html = opsPanelHtml([part('a'), part('b')], {});
    expect(html.indexOf('section a')).toBeLessThan(html.indexOf('section b'));
    expect(html).toContain('<h3 id="ops-a-title" tabindex="-1" data-focus-key="section-a">Part a</h3>');
    expect(html).toContain('aria-labelledby="ops-b-title"');
    expect(html).not.toContain('ops-facts');
  });

  it('passes the context to every part, and one data object to its fact and section', () => {
    const analyse = vi.fn(() => ({ id: 'x' }));
    const html = vi.fn(() => '<p>x</p>');
    const fact = vi.fn(() => ({ text: 't' }));
    const x = part('x', { analyse, html, fact });
    const entry = analysePart(x, { airport: 'A' });
    opsPanelHtml([x], { airport: 'A' });
    expect(entry.fact).toEqual({ text: 't' });
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
    expect(html.match(/could not be shown/g)).toHaveLength(2);
    expect(analysePart(boom, {}).fact).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the summary line', () => {
  const part = (id, over = {}) => ({ id, tab: 'weather', title: `Part ${id}`, factLabel: id.toUpperCase(), ...over });
  const entry = (p, fact) => ({ part: p, fact });
  const NOW = Date.parse('2026-10-14T12:00:00Z');

  it('has a button for each fact, in order, that names its tab and carries the part', () => {
    const html = summaryHtml([entry(part('a'), { text: 'fact a', status: 'ok' }), entry(part('b', { tab: 'traffic', title: 'Traffic here' }), { text: 'fact b', status: 'caution' })], NOW);
    expect(html.indexOf('fact a')).toBeLessThan(html.indexOf('fact b'));
    expect(html).toContain('<button type="button" class="ops-fact-button status-ok" data-part="a"');
    expect(html).toContain('data-part="b"');
    expect(html).toContain('(Within limits). Shows part a in the Weather tab.');
    expect(html).toContain('(Marginal). Shows traffic here in the Traffic tab.');
  });

  it('leaves a part without a fact out, and is empty when no part has one', () => {
    expect(summaryHtml([entry(part('q'), null), entry(part('r'), { text: '' })], NOW)).toBe('');
    expect(summaryHtml([], NOW)).toBe('');
    expect(summaryHtml([entry(part('q'), null), entry(part('a'), { text: 'fact a' })], NOW)).not.toContain('data-part="q"');
  });

  it('escapes what parts put in it', () => {
    const html = summaryHtml([entry(part('e', { title: '<b>T</b>' }), { text: '<i>x</i>', status: 'bogus' })], NOW);
    expect(html).not.toContain('<i>x</i>');
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(html).toContain('&lt;b&gt;t&lt;/b&gt;');
    expect(html).toContain('status-unknown');
  });

  describe('keeps a fact fresh or says how old it is', () => {
    const p = part('f');

    it('shows a fact without an age as it is: it comes from the context, which is current', () => {
      const fact = { text: 'RWY 27', status: 'ok' };
      expect(summaryFact(p, fact, NOW)).toBe(fact);
    });

    it('shows a fact whose data is recent as it is', () => {
      const fact = { text: '3 inbound', status: 'ok', asOf: NOW - STALE_AFTER_MS };
      expect(summaryFact(p, fact, NOW)).toBe(fact);
    });

    it('turns a fact whose data is older grey, with its age, never green or amber', () => {
      for (const status of ['ok', 'caution', 'nogo']) {
        const shown = summaryFact(p, { text: '3 inbound', status, asOf: NOW - 23 * 60_000 }, NOW);
        expect(shown).toMatchObject({ text: '3 inbound, 23 min old', status: 'unknown', stale: true });
      }
    });

    it('uses the limit of the part, and says at least a minute', () => {
      const quick = part('q', { staleAfterMs: 120_000 });
      expect(summaryFact(quick, { text: 't', status: 'ok', asOf: NOW - 100_000 }, NOW).stale).toBeUndefined();
      expect(summaryFact(quick, { text: 't', status: 'ok', asOf: NOW - 130_000 }, NOW).text).toBe('t, 2 min old');
      expect(summaryFact(quick, { text: 't', status: 'ok', asOf: NOW - 121_000 }, NOW).text).toBe('t, 2 min old');
    });

    it('is applied in the line, so an old fact does not look green', () => {
      const html = summaryHtml([entry(p, { text: 'quiet', status: 'ok', asOf: NOW - 3_600_000 })], NOW);
      expect(html).toContain('status-unknown');
      expect(html).toContain('quiet, 60 min old');
      expect(html).not.toContain('status-ok');
    });
  });
});

describe('the parts of the panel at work, bound and watched with the tab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A part that records what is running: `running` is what the part's own source does (polling), as a
  // part with the contract of ops.js would do it: running while bound or watching.
  function fakePart(id, tab, { summaryMode = true } = {}) {
    const log = [];
    const state = { bound: false, watching: false, started: 0, stopped: 0, released: 0 };
    const sync = () => {
      const should = state.bound || state.watching;
      if (should && !state.running) {
        state.running = true;
        state.started++;
      } else if (!should && state.running) {
        state.running = false;
        state.stopped++;
      }
    };
    const p = {
      id,
      tab,
      title: id,
      analyse: () => ({}),
      fact: () => ({ text: `fact ${id}`, status: 'ok' }),
      html: () => `<p>${id}</p>`,
      bind: () => {
        log.push('bind');
        state.bound = true;
        sync();
      },
      unbind: () => {
        log.push('unbind');
        state.bound = false;
        sync();
      },
      release: () => state.released++,
    };
    if (summaryMode) {
      p.watch = () => {
        log.push('watch');
        state.watching = true;
        sync();
      };
      p.unwatch = () => {
        log.push('unwatch');
        state.watching = false;
        sync();
      };
    }
    return { part: p, state, log };
  }

  function setup(fakes, { selectTab = vi.fn() } = {}) {
    vi.stubGlobal('document', { activeElement: null });
    vi.stubGlobal('CSS', { escape: (x) => x });
    const root = { innerHTML: '', addEventListener: vi.fn(), removeEventListener: vi.fn(), contains: () => false, querySelector: () => null };
    const summaryRoot = { innerHTML: '', addEventListener: vi.fn(), removeEventListener: vi.fn(), contains: () => false, querySelector: () => null };
    const timers = [];
    const cleared = [];
    const ctx = { now: Date.parse('2026-10-14T12:00:00Z') };
    const host = createOpsHost({
      root,
      summaryRoot,
      getContext: () => ctx,
      requestRender: vi.fn(),
      setTime: vi.fn(),
      selectTab,
      parts: fakes.map((f) => f.part),
      setTimer: (fn, ms) => timers.push({ fn, ms }),
      clearTimer: (t) => cleared.push(t),
    });
    return { host, root, summaryRoot, timers, cleared, ctx };
  }

  it('watches nothing until a part\'s own tab has been shown: a Details-only reader costs nothing', () => {
    const weather = fakePart('w', 'weather');
    const traffic = fakePart('t', 'traffic');
    const { host } = setup([weather, traffic]);
    host.show('details');
    host.show('access');
    for (const f of [weather, traffic]) {
      expect(f.log).toEqual([]);
      expect(f.state.running).toBeFalsy();
    }
  });

  it('arms a part when its tab is bound, and then watches it on every other tab', () => {
    const weather = fakePart('w', 'weather');
    const traffic = fakePart('t', 'traffic');
    const { host } = setup([weather, traffic]);
    host.show('details');
    host.show('weather');
    expect([weather.state.bound, traffic.state.bound]).toEqual([true, false]);
    expect([weather.state.watching, traffic.state.watching]).toEqual([false, false]);
    host.show('traffic');
    expect([weather.state.bound, traffic.state.bound]).toEqual([false, true]);
    expect([weather.state.watching, traffic.state.watching]).toEqual([true, false]);
    host.show('access');
    expect([weather.state.bound, traffic.state.bound]).toEqual([false, false]);
    expect([weather.state.watching, traffic.state.watching]).toEqual([true, true]);
    host.show('details');
    expect(weather.state.running && traffic.state.running).toBe(true);
  });

  it('arms at once for the tab the panel opens on (a remembered tab)', () => {
    const traffic = fakePart('t', 'traffic');
    const weather = fakePart('w', 'weather');
    const { host } = setup([weather, traffic]);
    host.show('traffic');
    expect([traffic.state.bound, weather.state.running]).toEqual([true, undefined]);
    host.show('details');
    expect(traffic.state.watching).toBe(true);
    expect(weather.state.running).toBeFalsy();
  });

  it('keeps the arming for the next airport, and clears it when the panel closes', () => {
    const weather = fakePart('w', 'weather');
    const { host } = setup([weather]);
    host.show('weather');
    host.show('details');
    host.release();
    host.show('details');
    expect(weather.state.watching).toBe(true);
    host.stop();
    expect(weather.state.running).toBe(false);
    host.show('details');
    expect(weather.state.watching).toBe(false);
    expect(weather.state.started).toBe(1);
  });

  it('says "Not watched yet, open Weather" for a part that is not armed, and does not ask it', () => {
    const weather = fakePart('w', 'weather');
    const traffic = fakePart('t', 'traffic');
    const analyse = vi.fn(() => ({}));
    traffic.part.analyse = analyse;
    const { host, summaryRoot, ctx } = setup([weather, traffic]);
    host.show('details');
    host.render(ctx);
    expect(summaryRoot.innerHTML).toContain('Not watched yet, open Weather');
    expect(summaryRoot.innerHTML).toContain('Not watched yet, open Traffic');
    expect(summaryRoot.innerHTML).toContain('(not watched yet). Shows w in the Weather tab.');
    expect(summaryRoot.innerHTML).toContain('status-unknown');
    expect(analyse).not.toHaveBeenCalled();
    // Once its tab has been shown it has its own fact.
    host.show('traffic');
    host.show('details');
    host.render(ctx);
    expect(summaryRoot.innerHTML).toContain('fact t');
    expect(summaryRoot.innerHTML).toContain('Not watched yet, open Weather');
  });

  it('does not stop and start a part\'s source when the tab changes: the new mode starts before the old one ends', () => {
    const weather = fakePart('w', 'weather');
    const { host } = setup([weather]);
    host.show('weather');
    host.show('traffic');
    host.show('weather');
    expect(weather.state.started).toBe(1);
    expect(weather.state.stopped).toBe(0);
    expect(weather.log).toEqual(['bind', 'watch', 'unbind', 'bind', 'unwatch']);
  });

  it('calls bind and watch once, however often the panel asks for the same tab', () => {
    const weather = fakePart('w', 'weather');
    const { host } = setup([weather]);
    host.show('weather');
    host.show('weather');
    host.show('weather');
    expect(weather.log).toEqual(['bind']);
  });

  it('leaves a part without a summary mode idle on other tabs', () => {
    const calm = fakePart('c', 'weather', { summaryMode: false });
    const { host } = setup([calm]);
    host.show('traffic');
    expect(calm.log).toEqual([]);
    host.show('weather');
    expect(calm.log).toEqual(['bind']);
    host.show('details');
    expect(calm.log).toEqual(['bind', 'unbind']);
  });

  it('ends everything when the panel closes, and again does nothing', () => {
    const weather = fakePart('w', 'weather');
    const traffic = fakePart('t', 'traffic');
    const { host, summaryRoot, cleared } = setup([weather, traffic]);
    host.show('weather');
    host.show('traffic');
    host.stop();
    for (const f of [weather, traffic]) {
      expect(f.state.running).toBe(false);
      expect(f.state.started).toBe(1);
      expect(f.state.stopped).toBe(1);
    }
    expect(summaryRoot.innerHTML).toBe('');
    expect(cleared).toHaveLength(1);
    host.stop();
    expect(weather.state.stopped).toBe(1);
    expect(cleared).toHaveLength(1);
    // Opened again, it starts afresh: nothing is armed.
    host.show('traffic');
    expect(weather.state.started).toBe(1);
    expect(traffic.state.bound).toBe(true);
  });

  it('ends the summary modes while the panel is held, keeps the bound tab, and brings them back on the way back', () => {
    const weather = fakePart('w', 'weather');
    const traffic = fakePart('t', 'traffic');
    const { host, summaryRoot, ctx } = setup([weather, traffic]);
    host.show('weather');
    host.show('traffic');
    host.render(ctx);
    expect([weather.state.watching, traffic.state.bound]).toEqual([true, true]);
    host.hold();
    // What the aircraft was picked from goes on; the summary line's watching is over.
    expect([weather.state.watching, weather.state.running, traffic.state.bound]).toEqual([false, false, true]);
    host.hold();
    expect(weather.log.filter((l) => l === 'unwatch')).toHaveLength(1);
    host.refreshSummary();
    // Back on the airport panel (any tab): the watch is on again.
    host.show('traffic');
    expect([weather.state.watching, weather.state.running]).toEqual([true, true]);
    expect(weather.state.started).toBe(2);
    // Held with nothing shown does nothing.
    host.stop();
    host.hold();
    expect(weather.state.running).toBe(false);
  });

  it('lets every part go of the open airport at once on release, and clears the summary line', () => {
    const weather = fakePart('w', 'weather');
    const traffic = fakePart('t', 'traffic');
    const { host, summaryRoot } = setup([weather, traffic]);
    host.show('weather');
    host.show('traffic');
    host.render({ now: 1 });
    expect(summaryRoot.innerHTML).toContain('fact w');
    host.release();
    expect(weather.state.released).toBe(1);
    expect(traffic.state.released).toBe(1);
    expect(summaryRoot.innerHTML).toBe('');
    // The sources are still running: the next airport is followed when the panel is drawn for it.
    expect(weather.state.running && traffic.state.running).toBe(true);
  });

  it('does not let a part that throws stop the others from starting and ending', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = fakePart('bad', 'weather');
    bad.part.bind = () => {
      throw new Error('nope');
    };
    bad.part.unwatch = () => {
      throw new Error('nope');
    };
    const good = fakePart('good', 'traffic');
    const { host } = setup([bad, good]);
    host.show('details');
    host.show('weather');
    host.show('traffic');
    expect(good.state.bound).toBe(true);
    host.stop();
    expect(good.state.running).toBe(false);
    spy.mockRestore();
  });

  it('draws the summary line of every part on every tab, and the sections of the shown tab only', () => {
    const weather = fakePart('w', 'weather');
    const traffic = fakePart('t', 'traffic');
    const { host, root, summaryRoot } = setup([weather, traffic]);
    host.show('weather');
    host.show('details');
    host.render({ now: 1 });
    expect(summaryRoot.innerHTML).toContain('fact w');
    expect(summaryRoot.innerHTML).toContain('Not watched yet, open Traffic');
    expect(root.innerHTML).toBe('');
    host.show('traffic');
    host.render({ now: 1 });
    expect(root.innerHTML).toContain('<p>t</p>');
    expect(root.innerHTML).not.toContain('<p>w</p>');
    expect(summaryRoot.innerHTML).toContain('fact w');
    expect(summaryRoot.innerHTML).toContain('fact t');
    // Each section's heading can be given back focus after a redraw.
    expect(root.innerHTML).toContain('data-focus-key="section-t"');
  });

  it('says the Access tab is coming while no part is in it', () => {
    const { host, root } = setup([fakePart('w', 'weather')]);
    host.show('access');
    host.render({ now: 1 });
    expect(root.innerHTML).toContain('Road and public transport information, coming soon');
  });

  it('draws the summary line again on a timer and when a part asks, but only once the panel has been drawn', () => {
    const weather = fakePart('w', 'weather');
    const { host, summaryRoot, timers, ctx } = setup([weather]);
    host.show('weather');
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(SUMMARY_REFRESH_MS);
    // Before the first draw there is no summary: the forecast may not be there yet.
    timers[0].fn();
    expect(summaryRoot.innerHTML).toBe('');
    host.render(ctx);
    weather.part.fact = () => ({ text: 'changed', status: 'ok' });
    timers[0].fn();
    expect(summaryRoot.innerHTML).toContain('changed');
    weather.part.fact = () => ({ text: 'again', status: 'ok' });
    host.refreshSummary();
    expect(summaryRoot.innerHTML).toContain('again');
    // Closed, it draws nothing.
    host.stop();
    host.refreshSummary();
    expect(summaryRoot.innerHTML).toBe('');
  });

  it('opens the tab of a pressed fact and scrolls its section into view', () => {
    const weather = fakePart('w', 'weather');
    const traffic = fakePart('t', 'traffic');
    const selectTab = vi.fn();
    const { host, root, summaryRoot } = setup([weather, traffic], { selectTab });
    const scrollIntoView = vi.fn();
    const heading = { focus: vi.fn() };
    root.querySelector = (sel) => (sel === '.ops-section[data-part="t"]' ? { scrollIntoView, querySelector: () => heading } : null);
    host.show('details');
    const press = summaryRoot.addEventListener.mock.calls.find((c) => c[0] === 'click')[1];
    press({ target: { closest: () => ({ dataset: { part: 't' } }) } });
    expect(selectTab).toHaveBeenCalledWith('traffic');
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
    expect(heading.focus).toHaveBeenCalled();
    // A press elsewhere in the line does nothing.
    selectTab.mockClear();
    press({ target: { closest: () => null } });
    expect(selectTab).not.toHaveBeenCalled();
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
    formatTick: (t) => String(Number(t.slice(11, 13))),
    limitsLabel: 'Regional',
    zone: 'UTC',
    ...over,
  });

  it('is the first part, with its fact', () => {
    expect(OPS_PARTS[0].id).toBe('runway');
    const html = opsPanelHtml(OPS_PARTS, ctx());
    expect(summaryHtml([analysePart(OPS_PARTS[0], ctx())])).toContain('RWY 27 → 24 at 15:00 UTC');
    expect(html).toContain('Runway 27 favoured until 15:00, then 24.');
  });

  it('draws an hour per column for each runway end, with the timeline hour marked', () => {
    const html = opsPanelHtml(OPS_PARTS, ctx());
    expect(html.match(/class="ops-hour"/g)).toHaveLength(24);
    expect(html.match(/aria-current="time"/g)).toHaveLength(1);
    expect(html).toContain('data-time="2026-10-14T14:00" data-readout');
    // A cell for each of the two runways in every column, not for each of the four ends.
    expect(html.match(/<i class="ops-cell/g)).toHaveLength(24 * 2);
    expect(html).toContain('<span>09/27</span><span>06/24</span>');
    // Numbers are in the hover text, not in the strip.
    expect(html).toContain('favoured 27, crosswind');
    expect(html).toContain('Local time, UTC');
    expect(html).toContain('Limits (Regional): crosswind 25 kt, tailwind 10 kt');
    expect(html).toContain('Set them in the wind check');
  });

  it('shows the timeline hour in the readout, or the first hour when the timeline is elsewhere', () => {
    expect(opsPanelHtml(OPS_PARTS, ctx())).toMatch(/<p class="ops-readout" data-default="14:00 · /);
    expect(opsPanelHtml(OPS_PARTS, ctx({ time: '2026-12-01T00:00' }))).toMatch(/<p class="ops-readout" data-default="12:00 · /);
  });

  it('goes grey when the forecast it was worked out from is old, and not before', () => {
    const line = (hourlyAsOf) => summaryHtml([analysePart(OPS_PARTS[0], ctx({ hourlyAsOf }))], now);
    expect(line(now - 2 * 3_600_000)).toContain('status-ok');
    expect(line(now - 2 * 3_600_000)).not.toContain('old');
    const old = line(now - 4 * 3_600_000);
    expect(old).toContain('status-unknown');
    expect(old).toContain('RWY 27 → 24 at 15:00 UTC, 240 min old');
    expect(old).toContain('(old data)');
    // A forecast with no fetch time is taken as it comes.
    expect(line(undefined)).toContain('status-ok');
  });

  it('says why there is no chart', () => {
    expect(opsPanelHtml(OPS_PARTS, ctx({ hourly: null, error: 'timed out' }))).toContain('The forecast could not be loaded here (timed out).');
    const html = opsPanelHtml(OPS_PARTS, ctx({ airport: { ...airport, runways: [] } }));
    expect(summaryHtml([analysePart(OPS_PARTS[0], ctx({ airport: { ...airport, runways: [] } }))])).toContain('No runway data');
    expect(html).not.toContain('ops-hour');
  });
});
