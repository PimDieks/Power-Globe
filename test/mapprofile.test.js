import { afterEach, describe, expect, it, vi } from 'vitest';
import { toAirport } from '../src/airports.js';
import { MAP_PROFILES, airportView, mapProfileFor, runwayEndText } from '../src/mapprofile.js';
import { OPS_PARTS, TOPIC_TABS, createOpsHost } from '../src/ops.js';
import { forgetTraffic, trafficPart } from '../src/opstrafficview.js';
import { lightningPart, unbind as unbindLightning, unwatch as unwatchLightning } from '../src/opslightningview.js';

const EHAM = toAirport(['EHAM', 'AMS', 'Amsterdam Airport Schiphol', 'Amsterdam', 'NL', 52.3086, 4.7639, -11, 1, 1, [['09', 87, '27', 267, 11329, 'ASP', 148, 52.3166, 4.74635, 52.3184, 4.79689]], 248]);
const EGLL = { ident: 'EGLL' };

describe('the map profile of each tab', () => {
  it('has a profile for every tab, with the same keys', () => {
    const tabs = ['details', ...TOPIC_TABS.map((t) => t.id)];
    expect(Object.keys(MAP_PROFILES).sort()).toEqual([...tabs].sort());
    const keys = Object.keys(MAP_PROFILES.details).sort();
    for (const tab of tabs) expect(Object.keys(MAP_PROFILES[tab]).sort()).toEqual(keys);
  });

  it('keeps Details as the map has always been, and puts each topic where it belongs', () => {
    expect(MAP_PROFILES.details).toMatchObject({ runwayStatus: true, windLabels: true, runwayUse: false, lightning: false, trafficMarks: false, roads: false });
    expect(MAP_PROFILES.weather).toMatchObject({ runwayStatus: true, windLabels: true, lightning: true, trafficMarks: false, runwayUse: false, roads: false });
    expect(MAP_PROFILES.traffic).toMatchObject({ runwayStatus: false, windLabels: false, runwayUse: true, trafficMarks: true, lightning: false, roads: false });
    expect(MAP_PROFILES.access).toMatchObject({ runwayStatus: false, windLabels: false, runwayUse: false, trafficMarks: false, lightning: false, roads: true });
    expect(mapProfileFor('nowhere')).toBe(MAP_PROFILES.details);
  });

  it('turns each overlay of a registered part on in its own tab only', () => {
    for (const part of OPS_PARTS.filter((p) => p.overlay)) {
      for (const tab of Object.keys(MAP_PROFILES)) expect(MAP_PROFILES[tab][part.overlay]).toBe(tab === part.tab);
    }
    expect(OPS_PARTS.filter((p) => p.overlay).map((p) => p.overlay).sort()).toEqual(['lightning', 'trafficMarks']);
  });
});

describe('how the airport map draws with a profile', () => {
  it('follows the profile for the open airport only, and not at all without one', () => {
    expect(airportView(EHAM, EHAM, MAP_PROFILES.traffic)).toBe(MAP_PROFILES.traffic);
    expect(airportView(EGLL, EHAM, MAP_PROFILES.traffic)).toMatchObject({ runwayStatus: true, windLabels: true });
    expect(airportView(EHAM, EHAM, null)).toMatchObject({ runwayStatus: true, windLabels: true });
    expect(airportView(EHAM, null, MAP_PROFILES.traffic)).toMatchObject({ runwayStatus: true });
  });

  it('writes a runway end as its name, with the status icon and the use as the view allows', () => {
    const use = { tag: 'ARR' };
    expect(runwayEndText('27', '✓', use, MAP_PROFILES.details)).toBe('27 ✓');
    expect(runwayEndText('27', '✓', use, MAP_PROFILES.weather)).toBe('27 ✓');
    expect(runwayEndText('27', '✓', use, MAP_PROFILES.traffic)).toBe('27 ARR');
    expect(runwayEndText('27', '✓', null, MAP_PROFILES.traffic)).toBe('27');
    expect(runwayEndText('27', '✓', use, MAP_PROFILES.access)).toBe('27');
    // Any other airport is as always: status and use both.
    expect(runwayEndText('27', '✓', use, airportView(EGLL, EHAM, MAP_PROFILES.traffic))).toBe('27 ✓ ARR');
  });
});

describe('switching tabs shows and hides the right overlays', () => {
  afterEach(() => {
    unbindLightning();
    unwatchLightning();
    forgetTraffic();
    vi.unstubAllGlobals();
  });

  function setup() {
    vi.stubGlobal('document', { activeElement: null });
    vi.stubGlobal('CSS', { escape: (x) => x });
    // The lightning monitor and the map's rings, recording.
    const monitors = [];
    const lightningMap = [];
    const deps = {
      createMonitor: (options) => {
        const m = { options, started: 0, stopped: 0, start() { this.started++; return Promise.resolve(); }, stop() { this.stopped++; } };
        monitors.push(m);
        return m;
      },
      overlay: { show: () => lightningMap.push('show'), hide: () => lightningMap.push('hide') },
    };
    const lightning = { ...lightningPart, bind: (r, api) => lightningPart.bind(r, api, deps), watch: (api) => lightningPart.watch(api, deps) };
    // The page's flight feed and its marks.
    const listeners = new Set();
    const marks = [];
    const source = {
      subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
      watchArea: vi.fn(),
      setOverlay: (o) => marks.push(o),
      aircraft: () => [{ id: 'inb1', callsign: 'KLM1', type: 'B738', category: 'Large aircraft', lat: 52.3086, lng: 4.7639 + 60 / (60 * Math.cos((52.3086 * Math.PI) / 180)), altitudeFt: 9000, onGround: false, speedKt: 250, track: 270, verticalFpm: -1500, military: false, seen: Date.now() }],
      layerOn: () => true,
      select: vi.fn(),
    };
    const root = { innerHTML: '', addEventListener() {}, removeEventListener() {}, contains: () => false, querySelector: () => null };
    const profiles = [];
    const ctx = () => ({ airport: EHAM, hourly: null, now: Date.now(), zone: 'CEST', formatTick: (t) => t.slice(11, 13), trafficSource: source });
    const host = createOpsHost({
      root,
      getContext: ctx,
      requestRender: () => {},
      setTime: () => {},
      selectTab: () => {},
      onProfile: (p) => profiles.push(p),
      parts: [lightning, trafficPart],
      setTimer: () => 1,
      clearTimer: () => {},
    });
    const feed = () => listeners.forEach((fn) => fn({ area: { lat: 52.25, lng: 4.75, nm: 125 }, name: 'adsb.lol' }));
    return { host, ctx, monitors, lightningMap, marks, profiles, feed, source };
  }
  const marked = (marks) => marks.length > 0 && marks.at(-1) !== null;

  it('shows the lightning on the map in the Weather tab only, and the traffic marks in the Traffic tab only', () => {
    const s = setup();
    s.host.show('details');
    s.host.render(s.ctx());
    s.feed();
    // Details: both parts look at their data for the summary line, and nothing is drawn.
    expect(s.monitors[0].started).toBe(1);
    expect(s.lightningMap).toEqual([]);
    expect(marked(s.marks)).toBe(false);
    expect(s.profiles.at(-1)).toBe(MAP_PROFILES.details);

    s.host.show('weather');
    expect(s.lightningMap).toEqual(['show']);
    s.feed();
    expect(marked(s.marks)).toBe(false);
    expect(s.profiles.at(-1)).toBe(MAP_PROFILES.weather);

    s.host.show('traffic');
    expect(s.lightningMap).toEqual(['show', 'hide']);
    expect(marked(s.marks)).toBe(true);
    expect(s.marks.at(-1).inbound).toEqual(['inb1']);
    expect(s.profiles.at(-1)).toBe(MAP_PROFILES.traffic);
    // The lightning monitor was not restarted by any of it.
    expect(s.monitors).toHaveLength(1);
    expect(s.monitors[0].started).toBe(1);

    s.host.show('access');
    expect(s.lightningMap).toEqual(['show', 'hide']);
    expect(s.marks.at(-1)).toBeNull();
    expect(s.profiles.at(-1)).toBe(MAP_PROFILES.access);
    s.feed();
    expect(s.marks.at(-1)).toBeNull();

    s.host.show('weather');
    expect(s.lightningMap).toEqual(['show', 'hide', 'show']);
  });

  it('gives the map no profile, and draws nothing, once the panel is closed', () => {
    const s = setup();
    s.host.show('traffic');
    s.host.render(s.ctx());
    s.feed();
    expect(marked(s.marks)).toBe(true);
    s.host.stop();
    expect(s.profiles.at(-1)).toBeNull();
    expect(s.marks.at(-1)).toBeNull();
    expect(s.source.watchArea).toHaveBeenLastCalledWith(null);
    expect(s.monitors.every((m) => m.stopped >= 1)).toBe(true);
  });

  it('tells the map of a tab once, not on every call', () => {
    const s = setup();
    s.host.show('weather');
    s.host.show('weather');
    s.host.show('traffic');
    expect(s.profiles).toEqual([MAP_PROFILES.weather, MAP_PROFILES.traffic]);
  });
});
