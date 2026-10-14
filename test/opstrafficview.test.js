import { afterEach, describe, expect, it, vi } from 'vitest';
import { toAirport } from '../src/airports.js';
import { OPS_PARTS, opsPanelHtml } from '../src/ops.js';
import { OpsTraffic } from '../src/opstraffic.js';
import {
  MAX_INBOUND_SHOWN,
  WATCH_NM,
  agoText,
  bind,
  forgetTraffic,
  heightText,
  overlayFor,
  routeHints,
  runwayUse,
  trafficBodyHtml,
  trafficPart,
  unbind,
} from '../src/opstrafficview.js';

const EHAM = toAirport(['EHAM', 'AMS', 'Amsterdam Airport Schiphol', 'Amsterdam', 'NL', 52.3086, 4.7639, -11, 1, 1, [['09', 87, '27', 267, 11329, 'ASP', 148, 52.3166, 4.74635, 52.3184, 4.79689]], 248]);
const EGLL = toAirport(['EGLL', 'LHR', 'London Heathrow Airport', 'London', 'GB', 51.4707, -0.4599, 83, 1, 1, [['09L', 90, '27R', 270, 12799, 'ASP', 164, 51.47749, -0.48944, 51.47768, -0.43323]], 172]);
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const MIN = 60_000;
const formatTick = (time) => time.slice(11, 13);

// A report as OpsTraffic gives them, by hand.
function report(over = {}) {
  const inbound = Array.from({ length: 11 }, (_, i) => ({ id: `a${i}`, callsign: `KLM${i}`, type: 'B738', distanceNm: 20 + i * 10, altitudeFt: i < 3 ? 4200 : 36_000, etaMin: 5 + i * 5, route: false }));
  const base = {
    inbound: { list: inbound, total: inbound.length, within30: 6, between30and60: 5, rangeNm: 200 },
    holding: {
      count: 3,
      list: [],
      stacks: [
        { centre: { lat: 52.6, lng: 5.3 }, direction: 'NE', distanceNm: 38, count: 2, minAltitudeFt: 8000, maxAltitudeFt: 9000, longestMinutes: 14, aircraft: [
          { id: 'h1', callsign: 'BAW1', type: 'A320', altitudeFt: 8000, minutes: 14, centre: { lat: 52.6, lng: 5.3 } },
          { id: 'h2', callsign: 'DLH2', type: '', altitudeFt: 9000, minutes: 6, centre: { lat: 52.62, lng: 5.35 } },
        ] },
        { centre: { lat: 52.0, lng: 4.0 }, direction: 'SW', distanceNm: 30, count: 1, minAltitudeFt: 7000, maxAltitudeFt: 7000, longestMinutes: 3, aircraft: [{ id: 'h3', callsign: 'AFR3', type: 'A21N', altitudeFt: 7000, minutes: 3, centre: { lat: 52.0, lng: 4.0 } }] },
      ],
    },
    movements: {
      arrivals: { total: 22, lastHour: 14, perHour: 12.4, runways: [{ ident: '27', count: 20, lastAt: T0, ageMin: 2, active: true }, { ident: '09', count: 2, lastAt: T0 - 50 * MIN, ageMin: 50, active: false }] },
      departures: { total: 19, lastHour: 12, perHour: 10.1, runways: [{ ident: '27', count: 19, lastAt: T0, ageMin: 0, active: true }] },
      byHour: [
        { hour: Date.UTC(2026, 9, 14, 10), arrivals: 5, departures: 4, monitoredMs: 20 * MIN, partial: true },
        { hour: Date.UTC(2026, 9, 14, 11), arrivals: 12, departures: 10, monitoredMs: 60 * MIN, partial: false },
      ],
    },
    coverage: { holdingReliable: true, holdingReady: true, movementsReliable: true, notes: ['Counts and holding times only cover the time this page has been open (since 10:40 UTC).'] },
    status: '6 inbound in 30 min · 3 holding',
    summary: 'About 6 inbound in the next 30 min, and 5 more in 30 to 60 min.',
  };
  base.holding.list = base.holding.stacks.flatMap((s) => s.aircraft);
  return { ...base, ...over };
}
const data = (over = {}, extra = {}) => ({ report: report(over), started: true, error: null, watching: true, layerOn: true, ...extra });

describe('texts', () => {
  it('writes heights as pilots do', () => {
    expect(heightText(4200)).toBe('4,200 ft');
    expect(heightText(17_999)).toBe('17,999 ft');
    expect(heightText(35_000)).toBe('FL350');
    expect(heightText(null)).toBe('–');
  });

  it('writes how long ago', () => {
    expect([0, 1, 7].map(agoText)).toEqual(['just now', '1 min ago', '7 min ago']);
  });
});

describe('the section', () => {
  const html = trafficBodyHtml(data(), { formatTick });

  it('says the summary and the counts for the two half hours', () => {
    expect(html).toContain('About 6 inbound in the next 30 min');
    expect(html).toContain('<b>6</b> in 0 to 30 min');
    expect(html).toContain('<b>at least 5</b> in 30 to 60 min');
  });

  it('lists the first eight inbound aircraft, compactly, and counts the rest', () => {
    expect((html.match(/class="ops-flight"/g) ?? []).length).toBe(MAX_INBOUND_SHOWN + 3);
    expect(html).toContain('<span class="ops-flight-call">KLM0</span><span>B738</span><span>20 NM</span><span>4,200 ft</span><span class="ops-flight-eta">about 5 min</span>');
    expect(html).toContain('FL360');
    expect(html).toContain('and 3 more');
    expect(html).not.toContain('KLM8<');
  });

  it('makes each aircraft something to press, by its id', () => {
    expect(html).toContain('data-aircraft="a0"');
    expect(html).toContain('data-aircraft="h1"');
    expect(html).toContain('data-focus-key="traffic-a0"');
  });

  it('describes the holding stacks: where, how many, how high and for how long', () => {
    expect(html).toContain('<b>2 aircraft</b> NE of the airport, 38 NM out, 8,000 ft to 9,000 ft, the longest seen holding for at least 14 min');
    expect(html).toContain('<b>1 aircraft</b> SW of the airport, 30 NM out, 7,000 ft, the longest seen holding for at least 3 min');
  });

  it('names the runways in use with when they were last seen, and marks the stale one as not in use', () => {
    expect(html).toContain('<span class="ops-rwy ops-rwy-active"><b>27</b> last seen 2 min ago</span>');
    expect(html).toContain('<span class="ops-rwy"><b>09</b> last seen 50 min ago</span>');
    expect(html).toContain('<dt>Departing from</dt><dd><span class="ops-rwy ops-rwy-active"><b>27</b> last seen just now</span></dd>');
  });

  it('draws the movements per hour as bars, the partial hour marked, with the totals in words', () => {
    expect((html.match(/class="ops-hourbar[ "]/g) ?? []).length).toBe(2);
    expect(html).toContain('class="ops-hourbar ops-partial"');
    expect(html).toContain('aria-label="10: 5 arrivals and 4 departures (only part of the hour was watched)"');
    expect(html).toContain('style="height: 100%"');
    expect(html).toContain('22 arrivals and 19 departures seen, about 12.4 arrivals and 10.1 departures an hour.');
  });

  it('puts the coverage notes in plain words, with what is watched', () => {
    expect(html).toContain(`Watching ${WATCH_NM} NM around the airport`);
    expect(html).toContain('only cover the time this page has been open');
    expect(trafficBodyHtml(data({}, { error: 'answered 502' }), { formatTick })).toContain('did not answer (answered 502)');
    expect(trafficBodyHtml(data({}, { layerOn: false }), { formatTick })).toContain('Flights are switched off');
    expect(html).not.toContain('Flights are switched off');
  });

  it('says what it cannot judge instead of showing zeros', () => {
    const limited = trafficBodyHtml(data({ coverage: { holdingReliable: false, movementsReliable: false, notes: ['Only the worldwide feed is known to cover this airport.'] } }), { formatTick });
    expect(limited).toContain('Holding cannot be judged from this data.');
    expect(limited).toContain('Runway use cannot be judged from this data.');
    expect(limited).not.toContain('ops-hourbars');
    const quiet = trafficBodyHtml(data({ inbound: { list: [], total: 0, within30: 0, between30and60: 0 }, holding: { count: 0, list: [], stacks: [] } }), { formatTick });
    expect(quiet).toContain('No inbound traffic seen.');
    expect(quiet).toContain('No aircraft holding.');
  });

  it('says "not known" for the later half hour when none is counted, and "at least" when some are', () => {
    const none = trafficBodyHtml(data({ inbound: { list: [], total: 0, within30: 4, between30and60: 0 } }), { formatTick });
    expect(none).toContain('<b>not known</b> for 30 to 60 min');
    expect(none).toContain('title="Aircraft further than 100 NM are only counted when their route is known"');
    expect(none).not.toContain('<b>0</b> in 30 to 60 min');
    expect(html).not.toContain('not known');
  });

  it('says it is still watching for holding in the first minutes, rather than that none is holding', () => {
    const early = trafficBodyHtml(data({ holding: { count: 0, list: [], stacks: [] }, coverage: { holdingReliable: true, holdingReady: false, movementsReliable: true, notes: [] } }), { formatTick });
    expect(early).toContain('Still watching');
    expect(early).not.toContain('No aircraft holding');
  });

  it('words holding times as minimums counted from when the page opened', () => {
    expect(html).toContain('>14+ min</span>');
    expect(html).toContain('title="Seen holding for at least 14 min"');
    expect(html).toContain('Holding times are minimums: they count from when this page saw the aircraft start holding.');
    expect(trafficBodyHtml(data({ holding: { count: 0, list: [], stacks: [] } }), { formatTick })).not.toContain('Holding times are minimums');
  });

  it('escapes what the aircraft report', () => {
    const r = report();
    r.inbound.list[0].callsign = '<img src=x>';
    r.inbound.list[0].type = '"><b>';
    const out = trafficBodyHtml({ report: r, started: true, watching: true, layerOn: true }, { formatTick });
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img src=x&gt;');
  });
});

describe('what goes on the map', () => {
  it('marks the inbound and holding aircraft and circles each stack beyond its aircraft', () => {
    const o = overlayFor(report(), EHAM);
    expect(o.inbound).toHaveLength(11);
    expect(o.holding).toEqual(['h1', 'h2', 'h3']);
    expect(o.stacks).toHaveLength(2);
    expect(o.stacks[0]).toMatchObject({ lat: 52.6, lng: 5.3 });
    // The first stack's aircraft are within 2 NM of its middle, so the circle is the smallest or a bit more.
    expect(o.stacks[0].radiusNm).toBeGreaterThanOrEqual(6);
    expect(o.stacks[1].radiusNm).toBe(6);
  });

  it('labels the runway ends in use for arrivals, departures or both, with when', () => {
    expect(runwayUse(report())).toEqual({
      27: { tag: 'ARR+DEP', title: 'In use for arrivals, last seen 2 min ago; departures, last seen just now' },
    });
    expect(overlayFor(report(), EHAM).runwayUse).toMatchObject({ ident: 'EHAM' });
    // Nothing where the data cannot say.
    expect(runwayUse(report({ coverage: { movementsReliable: false, notes: [] } }))).toEqual({});
  });

  it('keeps routes to the aircraft whose route is known and fits, and asks for nothing else', () => {
    const route = [
      { icao: 'EGLL', code: 'LHR', lat: 51.4706, lng: -0.4619 },
      { icao: 'EHAM', code: 'AMS', lat: 52.3086, lng: 4.7639 },
    ];
    const known = vi.fn((callsign) => (callsign === 'KLM66A' ? route : null));
    const list = [
      { id: 'a', callsign: 'KLM66A', lat: 52.0, lng: 2.2, track: 70 },
      // Its route is known but it is going the other way.
      { id: 'b', callsign: 'KLM66A', lat: 52.0, lng: 2.2, track: 250 },
      { id: 'c', callsign: 'XYZ1', lat: 52.0, lng: 2.2, track: 70 },
      { id: 'd', callsign: '', lat: 52.0, lng: 2.2, track: 70 },
      // Far from the airport: not even looked at.
      { id: 'e', callsign: 'KLM66A', lat: 40, lng: 2.2, track: 70 },
    ];
    expect(routeHints(list, EHAM, known)).toEqual({ a: { origin: 'EGLL', destination: 'EHAM' } });
    expect(known).toHaveBeenCalledTimes(3);
  });
});

describe('the part', () => {
  afterEach(() => forgetTraffic());

  // The page's side of it: a feed to subscribe to, the map to mark, aircraft to hold.
  function source() {
    const listeners = new Set();
    const src = {
      list: [],
      watched: [],
      overlays: [],
      selected: [],
      layer: true,
      subscribe: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      watchArea: vi.fn((a) => src.watched.push(a)),
      setOverlay: vi.fn((o) => src.overlays.push(o)),
      aircraft: () => src.list,
      layerOn: () => src.layer,
      select: vi.fn((id) => {
        src.selected.push(id);
        return true;
      }),
      emit: (event) => [...listeners].forEach((fn) => fn(event)),
      listeners,
    };
    return src;
  }
  // The root of the tab: keeps its listeners and the section and strip the part draws into.
  function page() {
    const handlers = new Map();
    const section = { innerHTML: '' };
    const fact = { textContent: '' };
    const icon = { textContent: '' };
    const hidden = { textContent: '' };
    const li = { className: '', querySelector: (sel) => ({ '.ops-fact': fact, '.status-icon': icon, '.visually-hidden': hidden })[sel] };
    return {
      handlers,
      section,
      fact,
      li,
      root: {
        addEventListener: (type, fn) => handlers.set(type, fn),
        removeEventListener: (type, fn) => handlers.get(type) === fn && handlers.delete(type),
        querySelector: (sel) => (sel === '[data-ops-traffic]' ? section : sel === '.ops-strip li[data-part="traffic"]' ? li : null),
      },
    };
  }
  const quiet = { setTimer: vi.fn(() => 7), clearTimer: vi.fn() };
  // An aircraft coming in 60 miles east of Schiphol, as the area feed gives it.
  const inbound = (id = 'inb1', seen = Date.now()) => ({ id, callsign: 'KLM1', type: 'B738', category: 'Large aircraft', lat: 52.3086, lng: 4.7639 + 60 / (60 * Math.cos((52.3086 * Math.PI) / 180)), altitudeFt: 9000, onGround: false, speedKt: 250, track: 270, verticalFpm: -1500, military: false, seen });
  const context = (src, airport = () => EHAM, observation = null) => () => ({ airport: airport(), now: Date.now(), formatTick, trafficSource: src, observation });

  it('is in the Ops parts, after the runway, visibility and lightning parts', () => {
    expect(OPS_PARTS.map((p) => p.id).slice(0, 4)).toEqual(['runway', 'visibility', 'lightning', 'traffic']);
  });

  it('shows its fact and section in the panel, and waits for data first', () => {
    const src = source();
    const ctx = { airport: EHAM, now: Date.now(), formatTick, trafficSource: src };
    const html = opsPanelHtml([trafficPart], ctx);
    expect(html).toContain('data-part="traffic"');
    expect(html).toContain('Waiting for flight data');
    expect(html).toContain('<h3 id="ops-traffic-title">Traffic</h3>');
    expect(html).toContain('data-ops-traffic');
    expect(html).toContain('No inbound traffic seen.');
    // Without the page's feed it says it could not be shown.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(opsPanelHtml([trafficPart], { airport: EHAM, now: 1, formatTick })).toContain('could not be shown');
    spy.mockRestore();
  });

  it('starts watching the airport when bound, feeds the monitor from each answer, and marks the map', () => {
    const src = source();
    const { root, section, fact, li } = page();
    bind(root, { getContext: context(src), rerender: vi.fn() }, quiet);
    expect(src.watched.at(-1)).toEqual({ lat: EHAM.lat, lng: EHAM.lng, nm: WATCH_NM });
    expect(src.listeners.size).toBe(1);
    expect(src.overlays).toHaveLength(0);

    src.list = [inbound()];
    src.emit({ area: { lat: 52.25, lng: 4.75, nm: 200 }, name: 'adsb.lol' });
    expect(src.overlays.at(-1)).toMatchObject({ inbound: ['inb1'], holding: [], stacks: [], runwayUse: { ident: 'EHAM' } });
    expect(section.innerHTML).toContain('KLM1');
    expect(section.innerHTML).toContain('about 14 min');
    expect(fact.textContent).toBe('1 inbound in 30 min');
    expect(li.className).toBe('status-ok');
    // The section and the fact the panel draws agree.
    const ctx = context(src)();
    expect(opsPanelHtml([trafficPart], ctx)).toContain('1 inbound in 30 min');
  });

  it('says so when the feed fails, and goes on when it comes back', () => {
    const src = source();
    const { root, section } = page();
    bind(root, { getContext: context(src), rerender: vi.fn() }, quiet);
    src.emit({ error: 'answered 502' });
    expect(section.innerHTML).toContain('did not answer (answered 502)');
    expect(opsPanelHtml([trafficPart], context(src)())).toContain('Flight data unavailable');
    src.list = [inbound()];
    src.emit({ area: { lat: 52.25, lng: 4.75, nm: 200 }, name: 'adsb.lol' });
    expect(section.innerHTML).not.toContain('did not answer');
  });

  it('selects an aircraft that is pressed in its section, and nothing for other clicks', () => {
    const src = source();
    const { root, handlers } = page();
    bind(root, { getContext: context(src), rerender: vi.fn() }, quiet);
    handlers.get('click')({ target: { closest: () => ({ dataset: { aircraft: 'inb1' } }) } });
    handlers.get('click')({ target: { closest: () => null } });
    expect(src.selected).toEqual(['inb1']);
  });

  it('stops watching and takes the marks off when unbound, and ignores answers after', () => {
    const src = source();
    const { root, handlers } = page();
    bind(root, { getContext: context(src), rerender: vi.fn() }, quiet);
    unbind();
    expect(src.listeners.size).toBe(0);
    expect(src.watched.at(-1)).toBeNull();
    expect(src.overlays.at(-1)).toBeNull();
    expect(handlers.size).toBe(0);
    expect(quiet.clearTimer).toHaveBeenCalledWith(7);
    // Unbinding again, or with nothing bound, does nothing.
    unbind();
    expect(src.watched).toHaveLength(2);
  });

  it('starts again for another airport when the panel moves to one, keeping nothing of the first', () => {
    const src = source();
    const { root } = page();
    let airport = EHAM;
    bind(root, { getContext: context(src, () => airport), rerender: vi.fn() }, quiet);
    src.list = [inbound()];
    src.emit({ area: { lat: 52.25, lng: 4.75, nm: 200 }, name: 'adsb.lol' });
    expect(opsPanelHtml([trafficPart], context(src, () => airport)())).toContain('KLM1');
    airport = EGLL;
    src.list = [];
    src.emit({ area: { lat: 51.5, lng: -0.5, nm: 200 }, name: 'adsb.lol' });
    expect(src.watched.at(-1)).toEqual({ lat: EGLL.lat, lng: EGLL.lng, nm: WATCH_NM });
    const html = opsPanelHtml([trafficPart], context(src, () => airport)());
    expect(html).not.toContain('KLM1');
    expect(html).toContain('No inbound traffic seen.');
    // The marks of the first airport were replaced.
    expect(src.overlays.at(-1)).toMatchObject({ inbound: [], runwayUse: { ident: 'EGLL' } });
  });

  it('switches airport when only the panel is drawn again (analyse sees another airport)', () => {
    const src = source();
    const { root } = page();
    bind(root, { getContext: context(src), rerender: vi.fn() }, quiet);
    opsPanelHtml([trafficPart], { airport: EGLL, now: Date.now(), formatTick, trafficSource: src });
    expect(src.watched.at(-1)).toMatchObject({ lat: EGLL.lat });
  });

  it('goes on with the same airport when the tab is opened again, not counting the time away', () => {
    const src = source();
    const first = page();
    bind(first.root, { getContext: context(src), rerender: vi.fn() }, quiet);
    src.list = [inbound('inb1', Date.now())];
    src.emit({ area: { lat: 52.25, lng: 4.75, nm: 200 }, name: 'adsb.lol' });
    unbind();
    const second = page();
    bind(second.root, { getContext: context(src), rerender: vi.fn() }, quiet);
    // The monitor is the one that was running: it has been told of the airport before.
    const ctx = context(src)();
    expect(opsPanelHtml([trafficPart], ctx)).toContain('KLM1');
    // Another airport starts clean.
    unbind();
    bind(second.root, { getContext: context(src, () => EGLL), rerender: vi.fn() }, quiet);
    expect(opsPanelHtml([trafficPart], { ...ctx, airport: EGLL })).not.toContain('KLM1');
  });

  it('gives the monitor the QNH of the METAR: a landing in a deep low is seen only with it', () => {
    // 2.5 miles out on the 27 approach, 850 ft true, reading 2,018 ft at the standard setting.
    const landing = () => ({ id: 'low1', callsign: 'LOW1', category: 'Large aircraft', lat: 52.3184, lng: 4.79689 + 2.5 / (60 * Math.cos((52.3184 * Math.PI) / 180)), altitudeFt: 2018, onGround: false, speedKt: 140, track: 267, verticalFpm: -700, military: false, seen: Date.now() });
    const run = (observation) => {
      const src = source();
      bind(page().root, { getContext: context(src, () => EHAM, observation), rerender: vi.fn() }, quiet);
      src.list = [landing()];
      src.emit({ area: { lat: 52.25, lng: 4.75, nm: 125 }, name: 'adsb.lol' });
      const use = src.overlays.at(-1).runwayUse.ends;
      forgetTraffic();
      return use;
    };
    expect(Object.keys(run({ qnh: 970 }))).toEqual(['27']);
    expect(run(null)).toEqual({});
  });

  it('draws the section again on a timer, whether or not the feed answered', () => {
    const src = source();
    const { root, section } = page();
    const timers = [];
    bind(root, { getContext: context(src), rerender: vi.fn() }, { setTimer: (fn) => timers.push(fn) && 1, clearTimer: () => {} });
    expect(section.innerHTML).toBe('');
    timers[0]();
    expect(section.innerHTML).toContain('No inbound traffic seen.');
  });

  it('has a monitor for its airport that is the real one: a plain OpsTraffic', () => {
    const monitor = new OpsTraffic(EHAM);
    expect(monitor.report(T0).inbound.total).toBe(0);
  });
});
