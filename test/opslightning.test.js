import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAME_MS, LightningMonitor, RAMP, analyseImage, decodeBlob, makeGeometry, summarise, unavailable } from '../src/lightning.js';
import { OPS_PARTS, createOpsHost, opsPanelHtml } from '../src/ops.js';
import { LEVEL_STATUS, RISK_STATUS, analyseLightning, lightningFact, motionLine, riskFields, trendText } from '../src/opslightning.js';
import { bind, compassSvg, lightningInnerHtml, lightningPart, lightningSectionHtml, setLightningOverlay, unbind } from '../src/opslightningview.js';

const MIN = 60_000;
const at = (iso) => Date.parse(iso);
const T0 = at('2026-10-14T14:00:00Z');
const G = makeGeometry(52, 5, { halfKm: 60, size: 120, nativeKm2: 4 });
const EHAM = { ident: 'EHAM', lat: 52.3086, lng: 4.7639 };
const TOKYO = { ident: 'RJTT', lat: 35.55, lng: 139.78 };

// A decoded image with discs of `count` at km east and north of the airport.
function image(discs = [], geometry = G) {
  const { size, kmPerPx } = geometry;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const x = (col + 0.5 - size / 2) * kmPerPx;
      const y = (size / 2 - row - 0.5) * kmPerPx;
      for (const d of discs) if (Math.hypot(x - d.x, y - d.y) <= d.r) data.set([...RAMP[(d.count ?? 4) - 1].slice(1), 255], (row * size + col) * 4);
    }
  }
  return { width: size, height: size, data };
}
const cell = (x, y, r = 3) => [{ x, y, r }];
const framesOf = (list) => list.map((discs, k) => analyseImage(image(discs), G, T0 + k * FRAME_MS));
// A result for the airport at 8 minutes after the newest image ends.
const resultOf = (list, behind = 8) => {
  const frames = framesOf(list);
  return summarise(frames, { geometry: G, now: frames.at(-1).time + FRAME_MS + behind * MIN, timeZone: 'UTC' });
};
const approaching = () => resultOf([48, 44, 40, 36, 32, 28].map((y) => cell(0, y)));
const overhead = () => resultOf(new Array(6).fill(cell(1, 1, 4)));
const none = () => resultOf(new Array(12).fill([]));
const receding = () => resultOf([0, 4, 8, 12, 16, 20].map((y) => cell(0, y)));

const NOW = at('2026-10-14T12:20:00Z');
const hourly = (over = {}) => {
  const time = Array.from({ length: 24 }, (_, i) => new Date(at('2026-10-14T10:00:00Z') + i * 3_600_000).toISOString().slice(0, 16));
  return { time, weather_code: time.map(() => 3), cape: time.map(() => 100), ...over };
};
const stormy = () => hourly({ weather_code: Array.from({ length: 24 }, (_, i) => (i === 5 ? 96 : 3)) });

describe('analyseLightning', () => {
  it('is loading for a covered airport until the monitor has a result', () => {
    const data = analyseLightning({ airport: EHAM, hourly: null, now: NOW });
    expect(data).toMatchObject({ covered: true, lightning: null, loading: true, risk: null, fields: [] });
    const result = none();
    expect(analyseLightning({ airport: EHAM, hourly: null, now: NOW, result })).toMatchObject({ lightning: result, loading: false });
  });

  it('says not covered for an airport the images do not reach, whatever result is given', () => {
    const data = analyseLightning({ airport: TOKYO, hourly: null, now: NOW, result: none() });
    expect(data.covered).toBe(false);
    expect(data.loading).toBe(false);
    expect(data.lightning.state).toBe('uncovered');
  });

  it('makes the thunderstorm risk from the forecast when it has the fields, and says which', () => {
    const data = analyseLightning({ airport: EHAM, hourly: stormy(), now: NOW });
    expect(data.fields).toEqual(['weather_code', 'cape']);
    expect(data.risk.level).toBe('high');
    expect(riskFields({ weather_code: [null, null], cape: [3] })).toEqual(['cape']);
    expect(riskFields({ temperature_2m: [1] })).toEqual([]);
    expect(riskFields(null)).toEqual([]);
    expect(analyseLightning({ airport: EHAM, hourly: { time: [], temperature_2m: [] }, now: NOW }).risk).toBeNull();
  });
});

describe('words', () => {
  it('writes the trend', () => {
    expect(trendText({ min30: 'rising', min60: 'steady' })).toBe('Last 30 min rising, last 60 min steady');
    expect(trendText({ min30: 'none', min60: 'unknown' })).toBe('Last 30 min no lightning, last 60 min not enough images');
  });

  it('writes the movement by state, and nothing when there is nothing to say', () => {
    expect(motionLine(approaching())).toMatch(/^Expected within 5 km at about \d\d:\d\d, moving S at 48 km\/h\.$/);
    expect(motionLine(receding())).toBe('Moving away, N at 48 km/h.');
    expect(motionLine(overhead())).toBe('Hardly moving.');
    expect(motionLine(none())).toBe('');
    const unclear = resultOf([20, 26, 30, 26, 20, 14].map((y) => cell(-12, y)));
    expect(motionLine(unclear)).toBe('Movement unclear: the cell does not move steadily.');
  });
});

describe('the status fact', () => {
  const fact = (result, extra = {}) => lightningFact(analyseLightning({ airport: EHAM, hourly: null, now: NOW, result, ...extra }));

  it('uses the lightning status text, coloured by how near it is', () => {
    expect(fact(approaching())).toEqual({ text: 'Lightning 26 km N, approaching, ~15 min', status: 'caution' });
    expect(fact(overhead())).toEqual({ text: 'Lightning within 5 km, nearly stationary', status: 'nogo' });
    expect(fact(none())).toEqual({ text: 'No lightning within 30 km', status: 'ok' });
    expect(fact(receding())).toEqual({ text: 'Lightning 18 km N, moving away', status: 'caution' });
    expect(LEVEL_STATUS).toEqual({ none: 'ok', distant: 'caution', near: 'caution', close: 'nogo', overhead: 'nogo' });
  });

  it('says when the data is old', () => {
    const old = resultOf([48, 44, 40, 36, 32, 28].map((y) => cell(0, y)), 40);
    expect(fact(old).text).toBe('Lightning 26 km N, movement unclear, data 40 min behind');
  });

  it('falls back on the forecast when the airport is not covered or there is no data', () => {
    const risk = { airport: TOKYO, hourly: stormy() };
    expect(lightningFact(analyseLightning({ ...risk, now: NOW }))).toEqual({ text: expect.stringMatching(/^Thunderstorms forecast.*\(forecast\), no lightning data here$/), status: 'nogo' });
    const calm = lightningFact(analyseLightning({ airport: EHAM, hourly: hourly(), now: NOW, result: unavailable(52, 5, 'HTTP 500', NOW) }));
    expect(calm).toEqual({ text: 'Thunderstorms unlikely in the next 6 h (forecast)', status: 'ok' });
    const moderate = lightningFact(analyseLightning({ airport: EHAM, hourly: hourly({ cape: hourly().time.map(() => 1800) }), now: NOW, result: unavailable(52, 5, null, NOW) }));
    expect(moderate.status).toBe('caution');
    expect(RISK_STATUS.low).toBe('ok');
  });

  it('is plain when there is nothing to go by', () => {
    expect(fact(null)).toEqual({ text: 'Loading lightning data', status: 'unknown' });
    expect(lightningFact(analyseLightning({ airport: TOKYO, hourly: null, now: NOW }))).toEqual({ text: 'Not covered here', status: 'unknown' });
    expect(fact(unavailable(52, 5, 'x', NOW))).toEqual({ text: 'No lightning data', status: 'unknown' });
  });
});

describe('the compass', () => {
  it('draws the rings, a dot for each cell and the airport', () => {
    const svg = compassSvg(approaching());
    expect(svg.match(/class="lc-ring"/g)).toHaveLength(4);
    expect(svg.match(/class="lc-near"/g)).toHaveLength(1);
    expect(svg.match(/class="lc-cell"/g)).toHaveLength(1);
    expect(svg).toContain('class="lc-airport"');
    expect(svg).toContain('status-caution');
    expect(svg).toContain('aria-label="Lightning around the airport, rings at 5, 10, 20, 30 km: Lightning 26 km N, approaching, ~15 min"');
    expect(svg).not.toMatch(/NaN|undefined/);
  });

  it('puts the dot where the lightning is: north is up, east is right', () => {
    // A cell 20 km east: its nearest dot is right of the middle and at its height.
    const east = compassSvg(resultOf(new Array(6).fill(cell(20, 0))));
    const [, cx, cy] = /class="lc-near" cx="([\d.]+)" cy="([\d.]+)"/.exec(east);
    expect(Number(cx)).toBeGreaterThan(100);
    expect(Math.abs(Number(cy) - 100)).toBeLessThan(3);
    const north = compassSvg(resultOf(new Array(6).fill(cell(0, 20))));
    const [, nx, ny] = /class="lc-near" cx="([\d.]+)" cy="([\d.]+)"/.exec(north);
    expect(Math.abs(Number(nx) - 100)).toBeLessThan(3);
    expect(Number(ny)).toBeLessThan(100);
  });

  it('shows an arrow for the way the nearest cell moves, only when that is known', () => {
    expect(compassSvg(approaching())).toContain('class="lc-arrow"');
    expect(compassSvg(receding())).toContain('class="lc-arrow"');
    expect(compassSvg(overhead())).not.toContain('lc-arrow');
    expect(compassSvg(none())).not.toContain('lc-arrow');
  });

  it('is only rings when there is no lightning', () => {
    const svg = compassSvg(none());
    expect(svg).not.toContain('lc-near');
    expect(svg).toContain('status-ok');
  });
});

describe('the section', () => {
  const ctx = { zone: 'CEST' };
  const html = (result, over = {}) => lightningSectionHtml(analyseLightning({ airport: EHAM, hourly: null, now: NOW, result, timeZone: 'UTC', ...over }), ctx);

  it('shows the status, movement, trend, the data age, the rings and the licence', () => {
    const out = html(approaching());
    expect(out).toContain('Local time, CEST');
    expect(out).toContain('<svg class="lightning-compass');
    expect(out).toContain('Lightning 26 km N, approaching, ~15 min');
    expect(out).toMatch(/Expected within 5 km at about \d\d:\d\d, moving S at 48 km\/h\./);
    expect(out).toContain('Last 30 min rising, last 60 min not enough images');
    expect(out).toContain('As of 14:30, data 8 min behind.');
    expect(out.match(/<tr>/g)).toHaveLength(1 + 4);
    expect(out).toContain('Contains modified EUMETSAT Meteosat data 2026');
    expect(out).toContain('approximate');
    expect(out).toContain('class="ops-lightning"');
  });

  it('says there is no lightning, with the rings empty', () => {
    const out = html(none());
    expect(out).toContain('No lightning within 30 km');
    expect(out).toContain('<td>none</td>');
  });

  it('adds the forecast risk, or says the forecast has no fields for it', () => {
    expect(html(none(), { hourly: stormy() })).toContain('<b>Forecast:</b> Thunderstorms forecast, from 15:00');
    expect(html(none(), { hourly: stormy() })).toContain('from the forecast&#39;s weather code, CAPE');
    expect(html(none(), { hourly: null })).toContain('no thunderstorm fields');
  });

  it('explains a place outside the coverage, and gives the forecast risk in its place', () => {
    const out = lightningSectionHtml(analyseLightning({ airport: TOKYO, hourly: stormy(), now: NOW }), ctx);
    expect(out).toContain('does not see this airport');
    expect(out).toContain('Thunderstorms forecast');
    expect(out).not.toContain('<svg');
  });

  it('says so while loading and when the data is unavailable, and escapes what it was told', () => {
    expect(html(null)).toContain('Loading lightning data');
    const out = html(unavailable(52, 5, 'Could not be fetched (<b>x</b>).', NOW), { hourly: hourly() });
    expect(out).toContain('No lightning data right now.');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(out).not.toContain('<b>x</b>');
    expect(out).toContain('Thunderstorms unlikely');
    expect(out).toContain('tries again by itself');
  });

  it('notes that old data gives no arrival time, and a failed refresh', () => {
    const old = resultOf([48, 44, 40, 36, 32, 28].map((y) => cell(0, y)), 40);
    expect(html(old)).toContain('The data is old: no arrival time is given.');
    expect(html({ ...none(), problem: 'The newest lightning image could not be fetched.' })).toContain('could not be fetched.');
  });

  it('is the same inside as a whole', () => {
    const data = analyseLightning({ airport: EHAM, hourly: null, now: NOW, result: none() });
    expect(lightningSectionHtml(data, ctx)).toBe(`<div class="ops-lightning">${lightningInnerHtml(data, ctx)}</div>`);
  });
});

// A monitor that only records, and gives the update function it was made with.
function fakeMonitors() {
  const made = [];
  const createMonitor = (options) => {
    const monitor = {
      options,
      started: [],
      stopped: 0,
      start(airport) {
        this.started.push(airport);
        return Promise.resolve();
      },
      stop() {
        this.stopped++;
      },
    };
    made.push(monitor);
    return monitor;
  };
  return { made, createMonitor };
}

function fakeOverlay() {
  const calls = [];
  return { calls, show: (arg) => calls.push(['show', arg]), hide: () => calls.push(['hide']) };
}

// A root with the two places the part writes to, and no way to listen: the part must not need one.
function fakeRoot() {
  const inner = { innerHTML: '' };
  const item = { outerHTML: '' };
  const root = {
    inner,
    item,
    querySelector(selector) {
      if (selector === '[data-part="lightning"] .ops-lightning') return inner;
      if (selector === '.ops-strip li[data-part="lightning"]') return item;
      return null;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return root;
}

describe('keeping it up to date', () => {
  afterEach(() => {
    unbind();
    setLightningOverlay(null);
  });

  function setup(context = { airport: EHAM, hourly: null, now: NOW, zone: 'CEST' }) {
    const monitors = fakeMonitors();
    const overlay = fakeOverlay();
    const root = fakeRoot();
    const state = { context };
    const api = { getContext: () => {
      if (!state.context) throw new TypeError('no details open');
      return state.context;
    }, rerender: vi.fn(), setTime: vi.fn() };
    const images = [];
    const loadImage = async (url) => {
      const img = { width: 2, height: 2, data: new Uint8ClampedArray(16), url };
      images.push(img);
      return img;
    };
    bind(root, api, { createMonitor: monitors.createMonitor, overlay, loadImage });
    return { ...monitors, overlay, root, api, state, images };
  }
  const render = (ctx) => lightningPart.analyse(ctx);
  const ctxFor = (airport) => ({ airport, hourly: null, now: NOW, zone: 'CEST' });

  it('makes a monitor on bind but fetches nothing until an airport is drawn', () => {
    const s = setup();
    expect(s.made).toHaveLength(1);
    expect(s.made[0].started).toEqual([]);
    expect(s.overlay.calls).toEqual([]);
    expect(s.root.addEventListener).not.toHaveBeenCalled();
  });

  it('starts for the airport that is drawn, once, and shows the rings on the map', () => {
    const s = setup();
    const data = render(ctxFor(EHAM));
    expect(data.loading).toBe(true);
    render(ctxFor(EHAM));
    render(ctxFor({ ...EHAM }));
    expect(s.made[0].started).toEqual([{ lat: EHAM.lat, lon: EHAM.lng }]);
    expect(s.overlay.calls).toHaveLength(1);
    expect(s.overlay.calls[0][0]).toBe('show');
    expect(s.overlay.calls[0][1].image).toBeNull();
    expect(s.overlay.calls[0][1].geometry.lat).toBe(EHAM.lat);
  });

  it('moves along when another airport is drawn: the first is stopped', () => {
    const s = setup();
    render(ctxFor(EHAM));
    render(ctxFor({ ident: 'EGLL', lat: 51.47, lng: -0.45 }));
    expect(s.made[0].stopped).toBe(1);
    expect(s.made[0].started.map((a) => a.lat)).toEqual([EHAM.lat, 51.47]);
    expect(s.overlay.calls.map((c) => c[0])).toEqual(['show', 'hide', 'show']);
  });

  it('starts nothing for an airport out of the coverage, and stops the one before', () => {
    const s = setup();
    render(ctxFor(EHAM));
    const data = render(ctxFor(TOKYO));
    expect(data.lightning.state).toBe('uncovered');
    expect(s.made[0].started).toHaveLength(1);
    expect(s.made[0].stopped).toBe(1);
    expect(s.overlay.calls.at(-1)).toEqual(['hide']);
    // And again: nothing starts.
    render(ctxFor(TOKYO));
    expect(s.made[0].started).toHaveLength(1);
  });

  it('draws only the section and its fact again when a result comes in, and the map', async () => {
    const s = setup();
    render(ctxFor(EHAM));
    // An image comes in through the monitor's own loader.
    await s.made[0].options.loadImage('https://x/ows?time=2026-10-14T15%3A30%3A00Z');
    await s.made[0].options.loadImage('https://x/ows?time=2026-10-14T15%3A25%3A00Z');
    const result = none();
    s.made[0].options.onUpdate(result);
    expect(s.root.inner.innerHTML).toContain('No lightning within 30 km');
    expect(s.root.item.outerHTML).toContain('data-part="lightning"');
    expect(s.root.item.outerHTML).toContain('status-ok');
    expect(s.root.item.outerHTML).toContain('No lightning within 30 km');
    expect(s.api.rerender).not.toHaveBeenCalled();
    const [name, arg] = s.overlay.calls.at(-1);
    expect(name).toBe('show');
    // The newest of the two images is the one for the map.
    expect(arg.image).toBe(s.images[0]);
    // The next draw of the whole tab has the result at once.
    expect(render(ctxFor(EHAM)).lightning).toBe(result);
  });

  it('keeps only the newest image, and not one that came in for an airport left since', async () => {
    const s = setup();
    render(ctxFor(EHAM));
    const slow = s.made[0].options.loadImage('https://x/ows?time=2026-10-14T15%3A30%3A00Z');
    render(ctxFor({ ident: 'EGLL', lat: 51.47, lng: -0.45 }));
    s.state.context = ctxFor({ ident: 'EGLL', lat: 51.47, lng: -0.45 });
    await slow;
    s.made[0].options.onUpdate(none());
    expect(s.overlay.calls.at(-1)[1].image).toBeNull();
  });

  it('lets go of everything when another airport, or none, is open as a result comes in', () => {
    const s = setup();
    render(ctxFor(EHAM));
    s.state.context = ctxFor({ ident: 'EGLL', lat: 51.47, lng: -0.45 });
    s.made[0].options.onUpdate(none());
    expect(s.made[0].stopped).toBe(1);
    expect(s.root.inner.innerHTML).toBe('');
    expect(s.overlay.calls.at(-1)).toEqual(['hide']);
    // The panel closed: the context is not there at all.
    render(ctxFor(EHAM));
    s.state.context = null;
    s.made[0].options.onUpdate(none());
    expect(s.made[0].stopped).toBe(2);
  });

  it('stops and clears the map on unbind, and ignores what comes after', () => {
    const s = setup();
    render(ctxFor(EHAM));
    unbind();
    expect(s.made[0].stopped).toBe(1);
    expect(s.overlay.calls.at(-1)).toEqual(['hide']);
    s.made[0].options.onUpdate(none());
    expect(s.root.inner.innerHTML).toBe('');
    // Nothing drawn without being bound: no fetching either.
    expect(render(ctxFor(EHAM)).loading).toBe(true);
    expect(s.made[0].started).toHaveLength(1);
    unbind();
    expect(s.made[0].stopped).toBe(1);
  });

  it('leaves nothing behind over many opens and closes', () => {
    const monitors = fakeMonitors();
    const overlay = fakeOverlay();
    const root = fakeRoot();
    for (let i = 0; i < 25; i++) {
      bind(root, { getContext: () => ctxFor(EHAM) }, { createMonitor: monitors.createMonitor, overlay });
      render(ctxFor(EHAM));
      unbind();
    }
    expect(monitors.made).toHaveLength(25);
    expect(monitors.made.every((m) => m.started.length === 1 && m.stopped === 1)).toBe(true);
    expect(root.addEventListener).not.toHaveBeenCalled();
    expect(overlay.calls.filter((c) => c[0] === 'show')).toHaveLength(25);
  });

  it('keeps one real monitor between binds, so that what it fetched is kept', () => {
    const start = vi.spyOn(LightningMonitor.prototype, 'start').mockResolvedValue();
    const stop = vi.spyOn(LightningMonitor.prototype, 'stop').mockImplementation(() => {});
    const root = fakeRoot();
    const api = { getContext: () => ctxFor(EHAM) };
    for (let i = 0; i < 3; i++) {
      bind(root, api, { overlay: fakeOverlay() });
      render(ctxFor(EHAM));
      unbind();
    }
    expect(start).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(new Set(start.mock.contexts).size).toBe(1);
    start.mockRestore();
    stop.mockRestore();
  });

  it('binding again first lets go of the earlier binding', () => {
    const monitors = fakeMonitors();
    const root = fakeRoot();
    bind(root, { getContext: () => ctxFor(EHAM) }, { createMonitor: monitors.createMonitor, overlay: fakeOverlay() });
    render(ctxFor(EHAM));
    bind(root, { getContext: () => ctxFor(EHAM) }, { createMonitor: monitors.createMonitor, overlay: fakeOverlay() });
    expect(monitors.made[0].stopped).toBe(1);
    expect(monitors.made[1].started).toEqual([]);
  });
});

describe('the part in the Ops tab', () => {
  afterEach(() => unbind());

  it('is registered after the runway part, with a section and a status fact', () => {
    expect(OPS_PARTS.map((p) => p.id)).toEqual(['runway', 'lightning']);
    const ctx = { airport: TOKYO, hourly: stormy(), now: NOW, zone: 'CEST', limits: {}, limitsLabel: '', time: '', formatClock: () => '', formatClockShort: () => '', formatTick: () => '' };
    const html = opsPanelHtml([lightningPart], ctx);
    expect(html).toContain('<li class="status-nogo" data-part="lightning">');
    expect(html).toContain('<section class="ops-section" data-part="lightning"');
    expect(html).toContain('Storms and lightning');
    expect(html).toContain('<div class="ops-lightning">');
  });

  it('says it could not be shown when the context lacks what it reads', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(opsPanelHtml([lightningPart], { airport: EHAM })).toContain('could not be shown');
    spy.mockRestore();
  });

  it('is started and stopped with the tab', () => {
    const monitors = fakeMonitors();
    const root = { addEventListener() {}, removeEventListener() {}, querySelector: () => null };
    const part = { ...lightningPart, bind: (r, api) => lightningPart.bind(r, api, { createMonitor: monitors.createMonitor, overlay: fakeOverlay() }) };
    const host = createOpsHost({ root, getContext: () => ({ airport: EHAM, hourly: null, now: NOW, zone: 'CEST' }), requestRender: () => {}, setTime: () => {}, parts: [part] });
    host.mount();
    opsPanelHtml([lightningPart], { airport: EHAM, hourly: null, now: NOW, zone: 'CEST' });
    expect(monitors.made[0].started).toHaveLength(1);
    host.unmount();
    expect(monitors.made[0].stopped).toBe(1);
  });
});

describe('decoding an image in the browser', () => {
  const globals = ['createImageBitmap', 'OffscreenCanvas'];
  const saved = Object.fromEntries(globals.map((g) => [g, globalThis[g]]));
  afterEach(() => {
    for (const g of globals) {
      if (saved[g] === undefined) delete globalThis[g];
      else globalThis[g] = saved[g];
    }
  });

  it('gives the size of the image although closing it empties it', async () => {
    const bitmap = {
      width: 160,
      height: 160,
      close() {
        this.width = 0;
        this.height = 0;
      },
    };
    const pixels = new Uint8ClampedArray(160 * 160 * 4);
    globalThis.createImageBitmap = vi.fn(async () => bitmap);
    globalThis.OffscreenCanvas = class {
      getContext() {
        return { drawImage() {}, getImageData: () => ({ data: pixels }) };
      }
    };
    const image = await decodeBlob({});
    expect(image).toEqual({ width: 160, height: 160, data: pixels });
  });
});
