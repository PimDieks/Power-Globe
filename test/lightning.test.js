import { describe, expect, it, vi } from 'vitest';
import {
  COLOUR_CACHE_MAX,
  FRAME_COUNT,
  FRAME_MS,
  HOLD_MIN,
  KEEP_MS,
  LightningMonitor,
  MAX_CELL_KM2,
  MIN_TREND_KM2,
  RAMP,
  RING_KM,
  STALE_MIN,
  analyseCounts,
  analyseImage,
  attribution,
  bearingOf,
  checkImage,
  colourCacheSize,
  compassOf,
  countFromColour,
  countsFromImage,
  estimateMotion,
  fitTrack,
  followCell,
  frameTimes,
  frameUrl,
  hourRisk,
  isCovered,
  levelOf,
  makeGeometry,
  minutesText,
  summarise,
  thunderstormRisk,
  trendOf,
  uncovered,
} from '../src/lightning.js';

const MIN = 60_000;
const at = (iso) => Date.parse(iso);
const T0 = at('2026-10-14T14:00:00Z');
// One kilometre per pixel.
const G = makeGeometry(52, 5, { halfKm: 60, size: 120 });

// A decoded image: discs of `count` (km east, km north of the airport, radius km), and extra
// single pixels [col, row].
function image(discs = [], pixels = [], geometry = G) {
  const { size, kmPerPx } = geometry;
  const data = new Uint8ClampedArray(size * size * 4);
  const put = (i, count) => data.set([...RAMP[count - 1].slice(1), 255], i * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const x = (col + 0.5 - size / 2) * kmPerPx;
      const y = (size / 2 - row - 0.5) * kmPerPx;
      for (const d of discs) if (Math.hypot(x - d.x, y - d.y) <= d.r) put(row * size + col, d.count ?? 4);
    }
  }
  for (const [col, row] of pixels) put(row * size + col, 3);
  return { width: size, height: size, data };
}

// Frames from one list of discs for each 5 minute frame, the first starting at T0.
const framesOf = (list, geometry = G, start = T0) => list.map((discs, k) => analyseImage(image(discs, [], geometry), geometry, start + k * FRAME_MS));
const cell = (x, y, r = 3) => [{ x, y, r }];
// Frames made of cells directly, for when the exact positions matter: one cell at each (x, y).
const synth = (points, area = 40) =>
  points.map((p, k) => ({
    time: T0 + k * FRAME_MS,
    cells: p ? [{ x: p[0], y: p[1], areaKm2: area, peak: 4, edge: false, nearestKm: Math.max(0, Math.hypot(p[0], p[1]) - 3.5), nearestBearing: 0 }] : [],
    rings: RING_KM.map((km) => ({ km, areaKm2: 0, peak: 0 })),
    nearest: null,
  }));
// `now` is `behind` minutes after the stamp of the newest frame.
const nowAfter = (frames, behind = 13) => frames.at(-1).time + behind * MIN;

describe('windows and addresses', () => {
  it('knows where the images reach', () => {
    expect(isCovered(52.31, 4.76)).toBe(true);
    expect(isCovered(53, 39)).toBe(true);
    expect(isCovered(-33.9, 18.6)).toBe(true);
    expect(isCovered(35.5, 139.8)).toBe(false);
    expect(isCovered(40.6, -73.8)).toBe(false);
    expect(isCovered(75, 0)).toBe(false);
    expect(isCovered(Number.NaN, 0)).toBe(false);
  });

  it('cuts a window about 60 km each way, wider in degrees away from the equator', () => {
    const g = makeGeometry(60, 10);
    expect(g.bbox.north - g.bbox.south).toBeCloseTo((2 * 60) / 111.195, 6);
    expect(g.bbox.east - g.bbox.west).toBeCloseTo((2 * 60) / (111.195 * Math.cos((60 * Math.PI) / 180)), 6);
    expect((g.bbox.north + g.bbox.south) / 2).toBeCloseTo(60, 9);
    expect((g.bbox.east + g.bbox.west) / 2).toBeCloseTo(10, 9);
    expect(g.kmPerPx).toBeCloseTo(0.75, 9);
  });

  it('writes the address with latitudes first and a time the layer knows', () => {
    const url = new URL(frameUrl(makeGeometry(52.31, 4.76), at('2026-10-14T15:25:00Z')));
    expect(url.origin + url.pathname).toBe('https://view.eumetsat.int/geoserver/ows');
    const p = url.searchParams;
    expect(p.get('layers')).toBe('mtg_fd:li_afa');
    expect(p.get('crs')).toBe('EPSG:4326');
    expect(p.get('format')).toBe('image/png');
    expect(p.get('time')).toBe('2026-10-14T15:25:00Z');
    const [south, west, north, east] = p.get('bbox').split(',').map(Number);
    expect(south).toBeLessThan(52.31);
    expect(north).toBeGreaterThan(52.31);
    expect(west).toBeLessThan(4.76);
    expect(east).toBeGreaterThan(4.76);
    expect(north - south).toBeLessThan(east - west);
    expect(p.get('width')).toBe('160');
  });

  it('asks for the last hour of windows, never one past the newest', () => {
    const times = { start: at('2025-05-30T15:00:00Z'), end: at('2026-10-14T15:25:00Z'), step: FRAME_MS };
    const list = frameTimes(times);
    expect(list).toHaveLength(FRAME_COUNT);
    expect(list.at(-1)).toBe(times.end);
    expect(list[0]).toBe(at('2026-10-14T14:30:00Z'));
    expect(list.every((t, i) => !i || t - list[i - 1] === FRAME_MS)).toBe(true);
    // A layer that starts later has fewer.
    expect(frameTimes({ ...times, start: at('2026-10-14T15:10:00Z') })).toEqual([at('2026-10-14T15:10:00Z'), at('2026-10-14T15:15:00Z'), at('2026-10-14T15:20:00Z'), times.end]);
  });

  it('gives the licence text with the year', () => {
    expect(attribution(at('2026-10-14T12:00:00Z'))).toBe('Contains modified EUMETSAT Meteosat data 2026');
  });
});

describe('colours to intensities', () => {
  it('gives the count of every step of the ramp back', () => {
    for (const [count, r, g, b] of RAMP) expect(countFromColour(r, g, b)).toBe(count);
  });

  it('puts a colour between two steps between their counts', () => {
    const [, r1, g1, b1] = RAMP[4];
    const [, r2, g2, b2] = RAMP[9];
    expect(countFromColour((r1 + r2) / 2, (g1 + g2) / 2, (b1 + b2) / 2)).toBeGreaterThanOrEqual(6);
    expect(countFromColour((r1 + r2) / 2, (g1 + g2) / 2, (b1 + b2) / 2)).toBeLessThanOrEqual(8);
    // Darker than the last step is still "20+".
    expect(countFromColour(100, 0, 40)).toBe(20);
  });

  it('keeps the colours the service really draws within the low counts', () => {
    expect(countFromColour(254, 249, 189)).toBeLessThanOrEqual(2);
    expect(countFromColour(254, 213, 113)).toBeGreaterThanOrEqual(5);
    expect(countFromColour(254, 213, 113)).toBeLessThanOrEqual(6);
  });

  it('reads one count per pixel and nothing where it is transparent', () => {
    const data = new Uint8ClampedArray(4 * 4);
    data.set([...RAMP[9].slice(1), 255], 0);
    data.set([...RAMP[1].slice(1), 40], 4);
    data.set([0, 0, 0, 0], 8);
    data.set([...RAMP[0].slice(1), 255], 12);
    expect([...countsFromImage({ width: 2, height: 2, data })]).toEqual([10, 0, 0, 1]);
  });

  it('keeps the colours it has seen within a bound, and reads on correctly after letting them go', () => {
    for (let i = 0; i < COLOUR_CACHE_MAX + 300; i++) countFromColour(i % 256, Math.floor(i / 256) % 256, 7 + Math.floor(i / 65536));
    expect(colourCacheSize()).toBeLessThanOrEqual(COLOUR_CACHE_MAX);
    expect(colourCacheSize()).toBeGreaterThan(0);
    for (const [count, r, g, b] of RAMP) expect(countFromColour(r, g, b)).toBe(count);
  });
});

describe('images that are not what the service draws', () => {
  const good = () => image(cell(20, 10, 3));

  it('lets a real looking image through', () => {
    expect(() => checkImage(good())).not.toThrow();
    expect(() => analyseImage(good(), G, T0)).not.toThrow();
  });

  it('refuses one with pixels that are partly transparent, as a canvas that smoothed it gives', () => {
    const img = good();
    const i = img.data.findIndex((v, k) => k % 4 === 3 && v === 255);
    img.data[i] = 200;
    expect(() => analyseImage(img, G, T0)).toThrow(/partly transparent/);
    // Not a single pixel of it is used.
    const faint = good();
    faint.data[3] = 1;
    expect(() => checkImage(faint)).toThrow(/partly transparent/);
  });

  it('refuses one where many opaque pixels are far from the colours of the legend', () => {
    const img = good();
    // A third of the opaque pixels turn blue.
    let seen = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3] === 255 && seen++ % 3 === 0) img.data.set([0, 40, 255, 255], i);
    }
    expect(() => analyseImage(img, G, T0)).toThrow(/legend colours/);
  });

  it('lets a few odd pixels pass: it is the many that give it away', () => {
    const img = good();
    let changed = 0;
    for (let i = 0; i < img.data.length && changed < 3; i += 4) {
      if (img.data[i + 3] === 255) {
        img.data.set([0, 40, 255, 255], i);
        changed++;
      }
    }
    expect(() => checkImage(img)).not.toThrow();
    // And an image with only a handful of pixels at all is not judged by colour.
    const few = image([], [[5, 5], [6, 5]]);
    few.data.set([0, 0, 255, 255], (5 * 120 + 5) * 4);
    expect(() => checkImage(few)).not.toThrow();
  });

  it('refuses one that is not square', () => {
    expect(() => analyseImage({ width: 4, height: 2, data: new Uint8ClampedArray(32) }, G, T0)).toThrow();
  });
});

describe('directions', () => {
  it('measures bearings clockwise from north', () => {
    expect(bearingOf(0, 5)).toBe(0);
    expect(bearingOf(5, 0)).toBe(90);
    expect(bearingOf(0, -5)).toBe(180);
    expect(bearingOf(-5, 0)).toBe(270);
    expect(compassOf(bearingOf(-4, 4))).toBe('NW');
    expect(compassOf(359)).toBe('N');
  });
});

describe('one image: cells and rings', () => {
  it('finds nothing in an empty image', () => {
    const r = analyseImage(image(), G, T0);
    expect(r.nearest).toBeNull();
    expect(r.cells).toEqual([]);
    expect(r.activeKm2).toBe(0);
    expect(r.rings.map((x) => x.km)).toEqual(RING_KM);
    expect(r.rings.every((x) => x.areaKm2 === 0 && x.peak === 0)).toBe(true);
    expect(JSON.stringify(r)).not.toContain('flashes');
  });

  it('leaves out noisy single pixels and pairs, but keeps a real patch', () => {
    const noise = [[10, 10], [60, 20], [90, 90], [30, 100], [55, 55], [56, 56], [100, 40], [101, 40]];
    expect(analyseImage(image([], noise), G, T0).cells).toEqual([]);
    expect(analyseImage(image([], noise), G, T0).nearest).toBeNull();
    const r = analyseImage(image(cell(20, 10, 2), noise), G, T0);
    expect(r.cells).toHaveLength(1);
    expect(r.cells[0].x).toBeCloseTo(20, 0);
    expect(r.cells[0].y).toBeCloseTo(10, 0);
  });

  it('gives the active area and the peak intensity within the rings, cumulatively', () => {
    // One cell 8 km east, one 25 km north, one 45 km west: only the last two rings see the second.
    const img = image([{ x: 8, y: 0, r: 2, count: 4 }, { x: 0, y: 25, r: 2, count: 8 }, { x: -45, y: 0, r: 2, count: 2 }]);
    const r = analyseImage(img, G, T0);
    const [r5, r10, r20, r30] = r.rings;
    const counts = countsFromImage(img);
    const brute = (km) => {
      let px = 0;
      let peak = 0;
      for (let i = 0; i < counts.length; i++) {
        if (!counts[i]) continue;
        const col = i % 120;
        const d = Math.hypot(col + 0.5 - 60, 60 - (i - col) / 120 - 0.5);
        if (d <= km) {
          px++;
          peak = Math.max(peak, counts[i]);
        }
      }
      return { px, peak };
    };
    expect(r5.areaKm2).toBe(0);
    expect(r5.peak).toBe(0);
    const b10 = brute(10);
    expect(b10.px).toBeGreaterThan(8);
    expect(r10.areaKm2).toBe(b10.px);
    expect(r10.peak).toBe(4);
    expect(r20.areaKm2).toBe(b10.px);
    expect(r30.areaKm2).toBe(brute(30).px);
    expect(r30.peak).toBe(8);
    expect(r.activeKm2).toBe(brute(100).px);
    expect(r.cells.map((c) => c.nearestKm)).toEqual([...r.cells.map((c) => c.nearestKm)].sort((a, b) => a - b));
  });

  it('says where the nearest lightning is', () => {
    const r = analyseImage(image([{ x: -9, y: 9, r: 2.5 }, { x: 30, y: 30, r: 4 }]), G, T0);
    expect(r.nearest.compass).toBe('NW');
    expect(r.nearest.bearing).toBeGreaterThan(315 - 10);
    expect(r.nearest.bearing).toBeLessThan(315 + 10);
    // The nearest pixel of the cell, not its middle: 12.7 km away, less the cell's own size.
    expect(r.nearest.km).toBeGreaterThan(9);
    expect(r.nearest.km).toBeLessThan(11.5);
    expect(r.cells[0].x).toBeCloseTo(-9, 0);
    expect(r.cells[0].y).toBeCloseTo(9, 0);
    expect(r.cells[1].nearestBearing).toBeGreaterThan(35);
    expect(r.cells[1].nearestBearing).toBeLessThan(55);
  });

  it('puts the middle of a cell towards its stronger pixels', () => {
    const size = 20;
    const g = makeGeometry(52, 5, { halfKm: 10, size });
    const counts = new Uint8Array(size * size);
    // Two rows of pixels, 3 wide: the upper row is much stronger.
    for (let c = 8; c < 11; c++) {
      counts[8 * size + c] = 18;
      counts[9 * size + c] = 2;
    }
    const r = analyseCounts(counts, size, g, T0);
    // Pixel rows 1.5 and 0.5 km north, weighted 18 to 2.
    expect(r.cells[0].y).toBeCloseTo(1.4, 1);
    expect(r.cells[0].peak).toBe(18);
  });

  it('says whether a cell runs off the edge of the image', () => {
    const inside = analyseImage(image(cell(20, 10, 3)), G, T0);
    expect(inside.cells[0].edge).toBe(false);
    const edge = analyseImage(image(cell(0, 56, 6)), G, T0);
    expect(edge.cells[0].edge).toBe(true);
  });

  it('reads the size from the image', () => {
    const g = makeGeometry(52, 5, { halfKm: 60, size: 160 });
    const small = analyseImage(image(cell(20, 0, 3), [], G), g, T0);
    expect(small.cells[0].x).toBeCloseTo(20, 0);
  });
});

describe('trend', () => {
  const frame = (k, area) => ({ time: T0 + k * FRAME_MS, rings: [0, 0, 0, area].map((areaKm2, i) => ({ km: RING_KM[i], areaKm2, peak: 0 })) });
  const series = (list) => list.map((a, k) => frame(k, a));

  it('sees more, the same and less area over 30 and over 60 minutes', () => {
    expect(trendOf(series([0, 0, 0, 0, 0, 0, 0, 0, 0, 60, 120, 200]), 30)).toBe('rising');
    expect(trendOf(series([100, 110, 100, 110, 100, 110, 100, 110, 100, 110, 100, 110]), 60)).toBe('steady');
    expect(trendOf(series([300, 300, 200, 200, 100, 100, 80, 50, 40, 20, 10, 0]), 60)).toBe('falling');
    // Rising over the hour but falling within the last half.
    const mixed = series([10, 20, 50, 100, 200, 300, 400, 500, 400, 300, 200, 100]);
    expect(trendOf(mixed, 60)).toBe('rising');
    expect(trendOf(mixed, 30)).toBe('falling');
  });

  it('says none when there was none, and unknown with too few images', () => {
    expect(trendOf(series(new Array(12).fill(0)), 60)).toBe('none');
    expect(trendOf(series([5]), 60)).toBe('unknown');
    expect(trendOf([], 30)).toBe('unknown');
    expect(trendOf(series([10, 20]), 60)).toBe('unknown');
  });

  it('does not take one stray flash for a trend, from nothing or to nothing', () => {
    // One instrument pixel, about 10 km², where there was none, and then none again.
    expect(trendOf(series([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10]), 60)).toBe('steady');
    expect(trendOf(series([0, 0, 0, 10, 10, 10]), 30)).toBe('steady');
    expect(trendOf(series([10, 10, 10, 0, 0, 0]), 30)).toBe('steady');
    expect(trendOf(series([0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0]), 60)).toBe('steady');
    // A real change from nothing, and to nothing, is one.
    expect(trendOf(series([0, 0, 0, MIN_TREND_KM2 + 10, MIN_TREND_KM2 + 10, MIN_TREND_KM2 + 10]), 30)).toBe('rising');
    expect(trendOf(series([MIN_TREND_KM2 + 10, MIN_TREND_KM2 + 10, MIN_TREND_KM2 + 10, 0, 0, 0]), 30)).toBe('falling');
  });

  it('does not take a small change in a small area for a trend either', () => {
    expect(trendOf(series([10, 10, 10, 25, 25, 25]), 30)).toBe('steady');
  });
});

describe('movement', () => {
  // The cell comes south at 4 km per frame, 48 km/h, from 48 km north.
  const coming = framesOf([48, 44, 40, 36, 32, 28].map((y) => cell(0, y)));

  it('follows a cell back through the frames', () => {
    const track = followCell(coming);
    expect(track).toHaveLength(6);
    expect(track[0].t).toBe(-25);
    expect(track.at(-1)).toMatchObject({ t: 0 });
    expect(track.at(-1).y).toBeCloseTo(28, 0);
    expect(track[0].y).toBeCloseTo(48, 0);
  });

  it('says a cell comes closer, and when its edge is 5 km away', () => {
    const m = estimateMotion(coming, { behindMin: 13 });
    expect(m.state).toBe('approaching');
    expect(m.speedKmh).toBe(48);
    expect(m.headingDeg).toBe(180);
    // 20.5 km left to go to the ring at 0.8 km/min, and the data 13 minutes old.
    expect(m.etaMin).toBeGreaterThan(10);
    expect(m.etaMin).toBeLessThan(15);
    expect(estimateMotion(coming, { behindMin: 0 }).etaMin).toBeGreaterThan(m.etaMin + 10);
  });

  it('says a cell goes away', () => {
    const m = estimateMotion(framesOf([28, 32, 36, 40, 44, 48].map((y) => cell(0, y))));
    expect(m.state).toBe('receding');
    expect(m.etaMin).toBeNull();
    expect(m.headingDeg).toBe(0);
  });

  it('says a cell goes past when it will not come within 5 km', () => {
    const m = estimateMotion(framesOf([-27, -22, -17, -12, -7, -2].map((x) => cell(x, 15))));
    expect(m.state).toBe('passing');
    expect(m.etaMin).toBeNull();
    expect(m.closestKm).toBeGreaterThan(11);
    expect(m.closestKm).toBeLessThan(14);
    expect(m.headingDeg).toBe(90);
  });

  it('says a storm over the airport that stays there stays', () => {
    const m = estimateMotion(framesOf(new Array(6).fill(cell(1, 1, 4))));
    expect(m.state).toBe('stationary');
    expect(m.etaMin).toBeNull();
    expect(m.speedKmh).toBeLessThan(10);
  });

  it('says there is nothing without lightning, or with only noise', () => {
    expect(estimateMotion(framesOf(new Array(6).fill([]))).state).toBe('none');
    const noisy = [0, 1, 2, 3, 4, 5].map((k) => analyseImage(image([], [[20 + k * 3, 30 - k], [70, 70 + k]]), G, T0 + k * FRAME_MS));
    expect(estimateMotion(noisy).state).toBe('none');
  });

  it('gives no time for a cell that jumps about', () => {
    const m = estimateMotion(framesOf([0, 9, -8, 10, -9, 8].map((x) => cell(x, 30))));
    expect(m.state).toBe('unclear');
    expect(m.etaMin).toBeNull();
    expect(m.reason).not.toBe('');
  });

  it('gives no time for a cell that turns back', () => {
    const m = estimateMotion(framesOf([40, 36, 32, 36, 40, 44].map((y) => cell(0, y))));
    expect(m.state).toBe('unclear');
    expect(m.etaMin).toBeNull();
  });

  it('gives no time for a cell without history, or with too little: five images are needed', () => {
    expect(estimateMotion(framesOf([[], [], [], [], [], cell(0, 20)])).state).toBe('unclear');
    expect(estimateMotion(framesOf([[], [], [], [], cell(0, 24), cell(0, 20)])).state).toBe('unclear');
    expect(estimateMotion(framesOf([cell(0, 40)])).state).toBe('unclear');
    // Four images of a cell moving perfectly steadily: still too few.
    const four = estimateMotion(framesOf([[], [], cell(0, 40), cell(0, 36), cell(0, 32), cell(0, 28)]));
    expect(four.state).toBe('unclear');
    expect(four.reason).toMatch(/Too little history/);
    // With five it is followed.
    expect(estimateMotion(framesOf([[], cell(0, 44), cell(0, 40), cell(0, 36), cell(0, 32), cell(0, 28)])).state).toBe('approaching');
  });

  it('gives no time for a cell that has hardly moved from where it was', () => {
    // 12 km/h is above what counts as staying put, but 5 km in 25 minutes is under the least.
    const m = estimateMotion(synth([[0, 40], [0, 39], [0, 38], [0, 37], [0, 36], [0, 35]]));
    expect(m.state).toBe('unclear');
    expect(m.reason).toMatch(/hardly moved/);
    // The same speed for longer is a movement.
    expect(estimateMotion(synth([[0, 44], [0, 43], [0, 42], [0, 41], [0, 40], [0, 39], [0, 38]])).state).toBe('approaching');
  });

  it('gives no time when the speed is known too poorly', () => {
    // A cell going south at about 25 km/h, but the points lie about 2.6 km from the line.
    const ys = [40, 33, 37, 29, 33, 27];
    const frames = synth(ys.map((y) => [0, y]));
    const { speedError, vy, rms } = fitTrack(frames.map((f, k) => ({ t: -25 + 5 * k, x: 0, y: f.cells[0].y })));
    expect(speedError * 60).toBeGreaterThan(0.3 * Math.abs(vy) * 60);
    expect(rms).toBeLessThan(Math.max(2, 0.25 * Math.abs(vy) * 60 * (25 / 60)));
    const m = estimateMotion(frames);
    expect(m.state).toBe('unclear');
    expect(m.reason).toMatch(/uncertain/);
  });

  it('gives no time when the cell is one large area, or runs off the image', () => {
    // A merged area of about 2,460 km², moving steadily.
    const big = estimateMotion(framesOf([48, 44, 40, 36, 32, 28].map((y) => [{ x: 0, y: y - 25, r: 28 }])));
    expect(big.state).toBe('unclear');
    expect(big.reason).toMatch(/large area/);
    expect(synth([[0, 20]], MAX_CELL_KM2 + 1)[0].cells[0].areaKm2).toBeGreaterThan(MAX_CELL_KM2);
    expect(estimateMotion(synth([[0, 40], [0, 36], [0, 32], [0, 28], [0, 24], [0, 20]], MAX_CELL_KM2 + 1)).state).toBe('unclear');
    // The same track on a cell that touches the edge of the image.
    const edgy = synth([[0, 40], [0, 36], [0, 32], [0, 28], [0, 24], [0, 20]]);
    edgy.at(-1).cells[0].edge = true;
    expect(estimateMotion(edgy).state).toBe('unclear');
    // Or one that did so some images ago.
    const past = synth([[0, 40], [0, 36], [0, 32], [0, 28], [0, 24], [0, 20]]);
    past[1].cells[0].edge = true;
    const m = estimateMotion(past);
    expect(m.state).toBe('unclear');
    expect(m.reason).toMatch(/too large|edge/);
  });

  it('does not hop to a neighbouring cell: with two near ones the track ends', () => {
    // Two cells 5 km apart, moving together: which was which can not be told.
    const two = framesOf([48, 44, 40, 36, 32, 28].map((y) => [{ x: 0, y, r: 2 }, { x: 5, y, r: 2 }]));
    expect(followCell(two)).toHaveLength(1);
    expect(estimateMotion(two).state).toBe('unclear');
    // Far enough apart they are told apart, and the nearer is followed.
    const apart = framesOf([48, 44, 40, 36, 32, 28].map((y) => [{ x: 0, y, r: 2 }, { x: 25, y, r: 2 }]));
    expect(followCell(apart)).toHaveLength(6);
    expect(estimateMotion(apart).state).toBe('approaching');
  });

  it('ends the track where a cell is of quite another size', () => {
    const grown = framesOf([[{ x: 0, y: 48, r: 2 }], [{ x: 0, y: 44, r: 2 }], [{ x: 0, y: 40, r: 2 }], [{ x: 0, y: 36, r: 6 }], [{ x: 0, y: 32, r: 6 }], [{ x: 0, y: 28, r: 6 }]]);
    expect(followCell(grown)).toHaveLength(3);
    expect(estimateMotion(grown).state).toBe('unclear');
  });

  it('gives no time when the cell moves faster than a storm does', () => {
    // 12 km per frame is 144 km/h: more than a cell is looked for within, so it is not followed.
    const m = estimateMotion(framesOf([58, 46, 34, 22, 10].map((y) => cell(0, y))));
    expect(m.state).toBe('unclear');
    expect(m.etaMin).toBeNull();
    // 9 km per frame, 108 km/h, is fast but can be followed.
    expect(estimateMotion(framesOf([55, 46, 37, 28, 19, 10].map((y) => cell(0, y)))).speedKmh).toBe(108);
  });

  it('gives no time from data that is old', () => {
    const m = estimateMotion(coming, { behindMin: STALE_MIN + 5 });
    expect(m.state).toBe('unclear');
    expect(m.etaMin).toBeNull();
  });

  it('copes with a frame in the middle where the cell was not seen', () => {
    const gap = framesOf([cell(0, 48), cell(0, 44), [], cell(0, 36), cell(0, 32), cell(0, 28)]);
    const m = estimateMotion(gap, { behindMin: 13 });
    expect(m.state).toBe('approaching');
    expect(m.speedKmh).toBe(48);
  });

  it('gives no wait for a cell that would be within the ring by now', () => {
    const m = estimateMotion(framesOf([30, 26, 22, 18, 14, 10].map((y) => cell(0, y))), { behindMin: 13 });
    expect(m.state).toBe('approaching');
    expect(m.etaMin).toBe(0);
  });

  it('almost never says a cell that stays where it is is moving, whatever the jitter of its middle', () => {
    // A cell 25 km north that does not move, its middle found 1 to 1.5 km off in each image.
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const jitter = (size) => (random() * 2 - 1) * size;
    const states = {};
    const trials = 4000;
    for (const size of [1, 1.5]) {
      for (let n = 0; n < trials; n++) {
        const frames = synth(Array.from({ length: 6 }, () => [jitter(size), 25 + jitter(size)]));
        const { state } = estimateMotion(frames);
        states[state] = (states[state] ?? 0) + 1;
      }
    }
    const moving = (states.approaching ?? 0) + (states.passing ?? 0) + (states.receding ?? 0);
    expect(moving / (2 * trials)).toBeLessThan(0.002);
    // And it is called stationary or unclear, not left unsaid.
    expect((states.stationary ?? 0) + (states.unclear ?? 0)).toBe(2 * trials - moving);
  });

  it('does not go on calling a moving cell unclear: the jitter does not hide steady movement', () => {
    let seed = 99;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    let approaching = 0;
    for (let n = 0; n < 500; n++) {
      const frames = synth(Array.from({ length: 6 }, (_, k) => [(random() * 2 - 1) * 1, 48 - 4 * k + (random() * 2 - 1) * 1]));
      if (estimateMotion(frames, { behindMin: 13 }).state === 'approaching') approaching++;
    }
    expect(approaching).toBeGreaterThan(450);
  });
});

describe('levels and words', () => {
  it('names how near the lightning is', () => {
    expect([null, 40, 30, 20, 10, 5, 0].map(levelOf)).toEqual(['none', 'none', 'distant', 'near', 'close', 'overhead', 'overhead']);
    expect(levelOf(25)).toBe('distant');
    expect(levelOf(7.5)).toBe('close');
  });

  it('writes times rounded to 5 minutes', () => {
    expect(minutesText(2)).toBe('<5 min');
    expect(minutesText(14.5)).toBe('~15 min');
    expect(minutesText(22)).toBe('~20 min');
    expect(minutesText(75)).toBe('>60 min');
  });
});

describe('the status', () => {
  const sum = (frames, behind = 13, extra = {}) => summarise(frames, { geometry: G, now: nowAfter(frames, behind), timeZone: 'UTC', ...extra });

  it('writes an approaching storm with the time it arrives', () => {
    const frames = framesOf([48, 44, 40, 36, 32, 28].map((y) => cell(0, y)));
    const r = sum(frames);
    expect(r.state).toBe('ok');
    expect(r.status.level).toBe('distant');
    expect(r.status.text).toBe('Lightning 26 km N, approaching, ~15 min');
    // From the stamp of the newest image, the safe reading.
    expect(r.status.dataText).toBe('as of 14:25, data 13 min behind');
    expect(r.status.detail).toMatch(/^Expected within 5 km at about 14:5\d, moving S at 48 km\/h\.$/);
    expect(r.asOf).toBe(at('2026-10-14T14:25:00Z'));
    expect(r.behindMin).toBe(13);
    expect(r.stale).toBe(false);
    expect(r.held).not.toBeNull();
    expect(r.attribution).toBe('Contains modified EUMETSAT Meteosat data 2026');
    expect(r.frames).toHaveLength(6);
    expect(r.rings).toHaveLength(4);
    expect(JSON.stringify(r.rings)).not.toContain('flashes');
  });

  it('writes a storm that goes past, or is not clear', () => {
    const unclear = sum(framesOf([20, 26, 30, 26, 20, 14].map((y) => cell(-12, y))));
    expect(unclear.status.text).toMatch(/^Lightning 1\d km NW, movement unclear$/);
    expect(unclear.status.detail).not.toBe('');
    expect(unclear.motion.etaMin).toBeNull();
    const passing = sum(framesOf([-27, -22, -17, -12, -7, -2].map((x) => cell(x, 15))));
    expect(passing.status.text).toMatch(/^Lightning 1\d km N[EW]?, passing by$/);
    expect(passing.status.detail).toMatch(/^Closest about 1\d km, moving E at \d+ km\/h\.$/);
  });

  it('writes a storm that goes away', () => {
    const away = sum(framesOf([0, 4, 8, 12, 16, 20].map((y) => cell(0, y))));
    expect(away.status.text).toBe('Lightning 18 km N, moving away');
    // It was over the airport a few minutes ago: the level stays where it was.
    expect(away.status.level).toBe('overhead');
    expect(away.status.hold).toMatch(/Lightning was within \d km \d+ min ago/);
  });

  it('writes a storm overhead', () => {
    const r = sum(framesOf(new Array(6).fill(cell(1, 1, 4))));
    expect(r.status.level).toBe('overhead');
    expect(r.status.text).toBe('Lightning within 5 km, nearly stationary');
    // Half an hour of images is too little for the trend over an hour.
    expect(r.trend).toEqual({ min30: 'steady', min60: 'unknown' });
    expect(r.rings[0].areaKm2).toBeGreaterThan(20);
    expect(r.rings[0].peak).toBe(4);
  });

  it('writes none within 30 km, for no lightning, noise, or lightning farther out', () => {
    expect(sum(framesOf(new Array(12).fill([]))).status.text).toBe('No lightning within 30 km');
    expect(sum(framesOf(new Array(12).fill([]))).trend).toEqual({ min30: 'none', min60: 'none' });
    expect(sum(framesOf(new Array(6).fill(cell(0, 50)))).status.text).toBe('No lightning within 30 km');
    expect(sum(framesOf(new Array(6).fill(cell(0, 50)))).status.level).toBe('none');
  });

  it('answers for a place the images do not cover', () => {
    const r = uncovered(35.5, 139.8, T0);
    expect(r.state).toBe('uncovered');
    expect(r.status.text).toBe('Lightning: not covered here');
    expect(r.status.level).toBe('unknown');
    expect(r.frames).toEqual([]);
  });

  describe('old data', () => {
    const frames = () => framesOf([48, 44, 40, 36, 32, 28].map((y) => cell(0, y)));

    it('says nothing of the lightning, not even that there is none', () => {
      const r = sum(frames(), STALE_MIN + 10);
      expect(r.stale).toBe(true);
      expect(r.status.level).toBe('unknown');
      expect(r.status.text).toBe('Lightning data 40 min old');
      expect(r.status.dataText).toBe('as of 14:25, data 40 min behind');
      expect(r.motion.etaMin).toBeNull();
    });

    it('is old after more than the least, and not at it', () => {
      expect(sum(frames(), STALE_MIN).stale).toBe(false);
      expect(sum(frames(), STALE_MIN + 1).stale).toBe(true);
      // Even with nothing in the images.
      const empty = sum(framesOf(new Array(12).fill([])), 45);
      expect(empty.status.level).toBe('unknown');
      expect(empty.status.text).toBe('Lightning data 45 min old');
    });
  });

  describe('holding the level after lightning', () => {
    // Lightning at 8 km (5.5 km to its nearest edge: 'close') in some images, none in the others.
    const L = cell(0, 8);
    const list = (...cells) => framesOf(cells);

    it('does not clear at an empty image: it flickers from one 5 minute window to the next', () => {
      // Lightning, nothing, lightning, nothing, nothing: now is the empty window after the second.
      const r = sum(list(L, [], L, [], []), 13);
      expect(r.status.level).toBe('close');
      expect(r.status.text).toBe('No lightning within 30 km now, last lightning 20 min ago');
      expect(r.status.hold).toMatch(/Kept as a warning until 30 minutes after the last lightning: within \d+ km\./);
      expect(r.held.km).toBeLessThan(10);
    });

    it('holds the worse level, not the last one', () => {
      // Overhead, then 25 km away: still overhead for the half hour.
      const r = sum(list(cell(1, 1, 3), [], cell(0, 28, 3), []), 13);
      expect(r.status.level).toBe('overhead');
      const now = sum(list(cell(1, 1, 3), cell(0, 28, 3)), 13);
      expect(now.status.text).toMatch(/^Lightning 2\d km N/);
      expect(now.status.level).toBe('overhead');
      expect(now.status.hold).toMatch(/Lightning was within \d km \d+ min ago/);
    });

    it('clears 30 minutes after the last lightning, counted from the end of its window', () => {
      // The last lightning is in the first window, ending 5 minutes after T0: 30 minutes on, at T0 + 35.
      const frames = list(L, [], [], [], [], [], []);
      const at29 = summarise(frames, { geometry: G, now: T0 + 5 * MIN + (HOLD_MIN - 1) * MIN, timeZone: 'UTC' });
      expect(at29.status.level).toBe('close');
      const at31 = summarise(frames, { geometry: G, now: T0 + 5 * MIN + (HOLD_MIN + 1) * MIN, timeZone: 'UTC' });
      // Stale by then (the newest image is 6 windows after T0 and this is 36 minutes after it ends).
      expect(['none', 'unknown']).toContain(at31.status.level);
      // With newer images the all clear is plain, and says how long it is since.
      const later = list(L, [], [], [], [], [], [], [], []);
      const clear = summarise(later, { geometry: G, now: T0 + 40 * MIN + 5 * MIN, timeZone: 'UTC' });
      expect(clear.status.level).toBe('none');
      expect(clear.status.text).toBe('No lightning within 30 km, last lightning 40 min ago');
      expect(clear.held).toBeNull();
    });

    it('starts the 30 minutes again with each new lightning', () => {
      const r = sum(list(L, [], [], [], [], L, []), 13);
      expect(r.status.level).toBe('close');
      expect(r.held.minAgo).toBeLessThan(30);
    });

    it('keeps an amber at least: any lightning within 30 km held is never green', () => {
      const r = sum(list(cell(0, 40, 3), cell(0, 30, 2), [], []), 13);
      expect(['distant', 'near']).toContain(r.status.level);
      expect(r.status.level).not.toBe('none');
    });

    it('does not hold for lightning farther than 30 km', () => {
      expect(sum(list(cell(0, 50), [], []), 13).status.level).toBe('none');
    });
  });
});

describe('thunderstorm risk from the forecast', () => {
  const now = at('2026-10-14T12:20:00Z');
  const hours = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const hourly = (over = {}) => ({
    time: hours(10, (i) => new Date(at('2026-10-14T10:00:00Z') + i * 3_600_000).toISOString().slice(0, 16)),
    weather_code: hours(10, () => 3),
    cape: hours(10, () => 100),
    ...over,
  });

  it('rates an hour by the weather code and CAPE', () => {
    expect(hourRisk(95, 0)).toBe('high');
    expect(hourRisk(99, null)).toBe('high');
    // CAPE alone is only possible, however high.
    expect(hourRisk(3, 1600)).toBe('low');
    expect(hourRisk(3, 4000)).toBe('low');
    expect(hourRisk(undefined, 2000)).toBe('low');
    // Likely needs wet weather in the forecast as well.
    expect(hourRisk(80, 1100)).toBe('moderate');
    expect(hourRisk(63, 1500)).toBe('moderate');
    expect(hourRisk(80, 600)).toBe('low');
    expect(hourRisk(3, 600)).toBe('low');
    expect(hourRisk(3, 100)).toBe('none');
    expect(hourRisk(undefined, undefined)).toBe('none');
    expect(hourRisk(94, 0)).toBe('none');
  });

  it('gives the worst hour in the next hours, and when it starts', () => {
    const codes = hours(10, (i) => (i === 5 ? 96 : 3));
    const r = thunderstormRisk(hourly({ weather_code: codes }), { now, timeZone: 'UTC' });
    expect(r.level).toBe('high');
    expect(r.firstHour).toBe(at('2026-10-14T15:00:00Z'));
    expect(r.text).toBe('Thunderstorms forecast, from 15:00');
  });

  it('looks only at the hours coming, with the one in progress', () => {
    const early = hours(10, (i) => (i === 0 ? 97 : 3));
    expect(thunderstormRisk(hourly({ weather_code: early }), { now }).level).toBe('none');
    const current = hours(10, (i) => (i === 2 ? 97 : 3));
    const r = thunderstormRisk(hourly({ weather_code: current }), { now, timeZone: 'UTC' });
    expect(r.level).toBe('high');
    expect(r.text).toBe('Thunderstorms forecast');
    const late = hours(10, (i) => (i === 9 ? 97 : 3));
    expect(thunderstormRisk(hourly({ weather_code: late }), { now, hours: 6 }).level).toBe('none');
  });

  it('works from CAPE alone as a possibility, and says unlikely when it is calm', () => {
    const r = thunderstormRisk(hourly({ weather_code: undefined, cape: hours(10, (i) => (i === 4 ? 1800 : 50)) }), { now, timeZone: 'UTC' });
    expect(r.level).toBe('low');
    expect(r.word).toBe('possible');
    expect(r.text).toBe('Thunderstorms possible');
    expect(r.firstHour).toBeNull();
    const likely = thunderstormRisk(hourly({ weather_code: hours(10, (i) => (i === 4 ? 81 : 3)), cape: hours(10, (i) => (i === 4 ? 1800 : 50)) }), { now, timeZone: 'UTC' });
    expect(likely.level).toBe('moderate');
    expect(likely.text).toBe('Thunderstorms likely, from 14:00');
    const calm = thunderstormRisk(hourly(), { now });
    expect(calm).toMatchObject({ level: 'none', firstHour: null });
    expect(calm.text).toBe('Thunderstorms unlikely in the next 6 h');
  });

  it('says unknown, not unlikely, when the forecast does not reach the next hours', () => {
    expect(thunderstormRisk({ time: [] }, { now })).toMatchObject({ level: 'unknown', word: 'unknown' });
    expect(thunderstormRisk(undefined, { now }).level).toBe('unknown');
    expect(thunderstormRisk({ time: [now - 5 * 3_600_000], weather_code: [3] }, { now }).level).toBe('unknown');
  });

  it('takes times as numbers', () => {
    const r = thunderstormRisk({ time: [now, now + 3_600_000], weather_code: [3, 95] }, { now });
    expect(r.level).toBe('high');
  });
});

// A fake service: the layer's newest window is `service.end`; images show nothing, or a cell that
// comes closer, depending on `service.storm`.
function fakeService(airportGeometry) {
  const service = {
    end: at('2026-10-14T15:25:00Z'),
    texts: 0,
    urls: [],
    storm: true,
    failImages: false,
    failText: false,
    makeImage: null,
  };
  service.fetchText = async () => {
    service.texts++;
    if (service.failText) throw new Error('HTTP 500');
    return `<Dimension name="time" default="x" units="ISO8601">2025-05-30T15:00:00.000Z/${new Date(service.end).toISOString()}/PT5M</Dimension>`;
  };
  service.loadImage = async (url) => {
    service.urls.push(url);
    if (service.failImages) throw new Error('HTTP 400');
    if (service.makeImage) return service.makeImage(url);
    const time = Date.parse(new URL(url).searchParams.get('time'));
    const k = (time - at('2026-10-14T14:30:00Z')) / FRAME_MS;
    return image(service.storm ? cell(0, 48 - 4 * (k % 6)) : [], [], airportGeometry);
  };
  return service;
}

describe('the monitor', () => {
  function setup(options = {}) {
    const service = fakeService(makeGeometry(52.31, 4.76));
    let clock = at('2026-10-14T15:38:00Z');
    const timers = [];
    const updates = [];
    const monitor = new LightningMonitor({
      fetchText: service.fetchText,
      loadImage: service.loadImage,
      now: () => clock,
      onUpdate: (r) => updates.push(r),
      setTimer: (fn, ms) => {
        const timer = {
          ms,
          live: true,
          fn: () => {
            timer.live = false;
            return fn();
          },
        };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => {
        if (timer) timer.live = false;
      },
      timeZone: 'UTC',
      ...options,
    });
    const live = () => timers.filter((t) => t.live);
    return { service, monitor, timers, updates, live, setNow: (t) => (clock = t) };
  }
  const EHAM = { lat: 52.31, lon: 4.76 };

  it('loads the last hour of one airport and polls again in 5 minutes', async () => {
    const { service, monitor, live, updates } = setup();
    const result = await monitor.start(EHAM);
    expect(service.texts).toBe(1);
    expect(service.urls).toHaveLength(12);
    expect(result.frames).toHaveLength(12);
    expect(result.state).toBe('ok');
    expect(result.status.dataText).toBe('as of 15:25, data 13 min behind');
    expect(updates).toHaveLength(1);
    expect(live()).toHaveLength(1);
    expect(live()[0].ms).toBe(5 * MIN);
  });

  it('fetches only the new window on the next poll, and drops the oldest', async () => {
    const { service, monitor, live, updates } = setup();
    await monitor.start(EHAM);
    service.end += FRAME_MS;
    service.urls.length = 0;
    await live()[0].fn();
    expect(service.urls).toHaveLength(1);
    expect(new URL(service.urls[0]).searchParams.get('time')).toBe('2026-10-14T15:30:00Z');
    expect(updates.at(-1).frames).toHaveLength(12);
    expect(updates.at(-1).newestFrame).toBe(at('2026-10-14T15:30:00Z'));
    expect(updates.at(-1).frames[0].time).toBe(at('2026-10-14T14:35:00Z'));
    // When the layer has nothing new, nothing is fetched but its time range.
    service.urls.length = 0;
    await live()[0].fn();
    expect(service.urls).toHaveLength(0);
  });

  it('fetches nothing once stopped, and a restart only asks for what is missing', async () => {
    const { service, monitor, live } = setup();
    await monitor.start(EHAM);
    monitor.stop();
    expect(live()).toHaveLength(0);
    service.end += 3 * FRAME_MS;
    service.texts = 0;
    service.urls.length = 0;
    await monitor.refresh();
    expect(service.texts).toBe(0);
    expect(service.urls).toHaveLength(0);
    await monitor.start(EHAM);
    expect(service.urls).toHaveLength(3);
  });

  it('ignores an answer that arrives after a stop', async () => {
    const { service, monitor, live, updates } = setup();
    const first = monitor.start(EHAM);
    monitor.stop();
    await first;
    expect(updates).toHaveLength(0);
    expect(live()).toHaveLength(0);
    expect(service.texts).toBe(1);
    // Nothing more is asked for once it has stopped.
    expect(service.urls).toHaveLength(0);
  });

  describe('stopped, or moved, while the images are loading', () => {
    // Images that come when told to.
    function held() {
      const { service, monitor, live, updates } = setup();
      const pending = [];
      service.loadImage = (url) => {
        service.urls.push(url);
        return new Promise((resolve) => pending.push(() => resolve(image([], [], makeGeometry(52.31, 4.76)))));
      };
      monitor.loadImage = service.loadImage;
      const settle = async () => {
        await vi.waitFor(() => expect(pending.length).toBeGreaterThan(0));
        for (const resolve of pending.splice(0)) resolve();
      };
      return { service, monitor, live, updates, pending, settle };
    }

    it('keeps none of them, gives no result and sets no timer', async () => {
      const { monitor, live, updates, settle, pending } = held();
      const first = monitor.start(EHAM);
      await vi.waitFor(() => expect(pending.length).toBe(12));
      monitor.stop();
      await settle();
      await first;
      expect([...monitor.cache.values()].every((frames) => frames.size === 0)).toBe(true);
      expect(updates).toHaveLength(0);
      expect(live()).toHaveLength(0);
    });

    it('keeps none of the first airport in the cache of the second', async () => {
      const { monitor, updates, settle, pending } = held();
      const first = monitor.start(EHAM);
      await vi.waitFor(() => expect(pending.length).toBe(12));
      const firstImages = pending.splice(0);
      const second = monitor.start({ lat: 51.47, lon: -0.45 });
      await vi.waitFor(() => expect(pending.length).toBe(12));
      // The first airport's images come in after the second was asked for.
      for (const resolve of firstImages) resolve();
      await settle();
      await first;
      await second;
      const sizes = [...monitor.cache.entries()].map(([key, frames]) => [key, frames.size]);
      expect(sizes.find(([key]) => key === '52.310,4.760')[1]).toBe(0);
      expect(sizes.find(([key]) => key === '51.470,-0.450')[1]).toBe(12);
      // Only the second airport was reported.
      expect(updates).toHaveLength(1);
      expect(updates[0].geometry.lat).toBe(51.47);
    });
  });

  it('fetches nothing for a place outside the coverage', async () => {
    const { service, monitor, live, updates } = setup();
    const result = await monitor.start({ lat: 35.5, lon: 139.8 });
    expect(result.state).toBe('uncovered');
    expect(updates).toHaveLength(1);
    expect(service.texts).toBe(0);
    expect(service.urls).toHaveLength(0);
    expect(live()).toHaveLength(0);
  });

  it('waits longer after each failure and goes back to 5 minutes after a success', async () => {
    const { service, monitor, live, setNow } = setup();
    service.failText = true;
    const first = await monitor.start(EHAM);
    expect(first.state).toBe('unavailable');
    expect(first.status.text).toBe('Lightning data unavailable');
    expect(first.status.level).toBe('unknown');
    expect(live()[0].ms).toBe(30_000);
    setNow(at('2026-10-14T15:39:00Z'));
    await live()[0].fn();
    expect(live()[0].ms).toBe(60_000);
    setNow(at('2026-10-14T15:41:00Z'));
    await live()[0].fn();
    expect(live()[0].ms).toBe(120_000);
    service.failText = false;
    const ok = await live()[0].fn();
    expect(ok.state).toBe('ok');
    expect(live()[0].ms).toBe(5 * MIN);
  });

  it('keeps showing what it has when a poll fails, and says so', async () => {
    const { service, monitor, live, setNow } = setup();
    await monitor.start(EHAM);
    service.failText = true;
    setNow(at('2026-10-14T15:44:00Z'));
    const r = await live()[0].fn();
    expect(r.state).toBe('ok');
    expect(r.frames).toHaveLength(12);
    expect(r.problem).toMatch(/could not be fetched/);
    expect(r.behindMin).toBe(19);
    expect(live()[0].ms).toBe(30_000);
  });

  it('lets go of images older than an hour at every refresh, also when it fails', async () => {
    const { service, monitor, live, setNow } = setup();
    await monitor.start(EHAM);
    service.failText = true;
    // 75 minutes after the newest stamp: the older images (stamps 14:30 to 15:20) are past it.
    setNow(at('2026-10-14T15:25:00Z') + 75 * MIN);
    const r = await live()[0].fn();
    expect(r.problem).toMatch(/could not be fetched/);
    expect(r.frames.length).toBeLessThan(12);
    expect(r.frames.every((f) => at('2026-10-14T15:25:00Z') + 75 * MIN - f.time <= KEEP_MS)).toBe(true);
    // The newest is still there, and is old: it says nothing of the lightning.
    expect(r.stale).toBe(true);
    expect(r.status.level).toBe('unknown');
    expect([...monitor.cache.values()][0].size).toBe(r.frames.length);
    // Long after, there is nothing at all.
    setNow(at('2026-10-14T15:25:00Z') + 2 * 3_600_000);
    const none = await live()[0].fn();
    expect(none.state).toBe('unavailable');
    expect([...monitor.cache.values()][0].size).toBe(0);
  });

  it('lets go of them on a successful refresh as well', async () => {
    const { service, monitor, live, setNow } = setup();
    await monitor.start(EHAM);
    service.end += 12 * FRAME_MS;
    setNow(at('2026-10-14T15:25:00Z') + 12 * FRAME_MS + 13 * MIN);
    const r = await live()[0].fn();
    expect(r.state).toBe('ok');
    expect(r.frames).toHaveLength(12);
    expect(r.frames[0].time).toBeGreaterThan(at('2026-10-14T15:25:00Z'));
  });

  it('still gives a result when only the older images fail', async () => {
    const service = fakeService(makeGeometry(52.31, 4.76));
    const monitor = new LightningMonitor({
      fetchText: service.fetchText,
      loadImage: async (url) => {
        if (new URL(url).searchParams.get('time') < '2026-10-14T15:00:00Z') throw new Error('HTTP 400');
        return service.loadImage(url);
      },
      now: () => at('2026-10-14T15:38:00Z'),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    const r = await monitor.start(EHAM);
    expect(r.state).toBe('ok');
    expect(r.frames).toHaveLength(6);
    expect(r.problem).toBeNull();
  });

  it('reports a failure of the newest image', async () => {
    const { service, monitor } = setup();
    service.failImages = true;
    const r = await monitor.start(EHAM);
    expect(r.state).toBe('unavailable');
    expect(r.problem).toMatch(/newest/);
  });

  it('treats an image that does not look like the service draws as failed', async () => {
    const { service, monitor } = setup();
    // What a canvas that blended the image would give: half transparent pixels.
    service.makeImage = () => {
      const img = image(cell(0, 20));
      for (let i = 3; i < img.data.length; i += 4) if (img.data[i] === 255) img.data[i] = 128;
      return img;
    };
    const r = await monitor.start(EHAM);
    expect(r.state).toBe('unavailable');
    expect(r.problem).toMatch(/newest/);
  });

  it('keeps the images of only a few airports', async () => {
    const { monitor } = setup({ maxAirports: 2 });
    for (const lat of [50, 51, 52]) await monitor.start({ lat, lon: 5 });
    expect(monitor.cache.size).toBe(2);
    expect([...monitor.cache.keys()]).toEqual(['51.000,5.000', '52.000,5.000']);
    expect([...monitor.cache.values()].every((frames) => frames.size <= 12)).toBe(true);
  });

  it('moves to another airport without keeping the first one polling', async () => {
    const { monitor, live } = setup();
    await monitor.start(EHAM);
    await monitor.start({ lat: 51.47, lon: -0.45 });
    expect(live()).toHaveLength(1);
  });

  it('sees a cell come in through the whole path', async () => {
    const { monitor } = setup();
    const r = await monitor.start(EHAM);
    expect(r.nearest).not.toBeNull();
    expect(r.motion.state).toBe('approaching');
    expect(r.status.text).toMatch(/^Lightning \d+ km N, approaching/);
  });

  it('calls the timers as plain functions, as a browser needs', async () => {
    const seen = [];
    const service = fakeService(makeGeometry(52.31, 4.76));
    const monitor = new LightningMonitor({
      fetchText: service.fetchText,
      loadImage: service.loadImage,
      now: () => at('2026-10-14T15:38:00Z'),
      setTimer: function (fn, ms) {
        seen.push(['set', this, ms]);
        return 7;
      },
      clearTimer: function (timer) {
        seen.push(['clear', this, timer]);
      },
    });
    await monitor.start(EHAM);
    monitor.stop();
    expect(seen).toEqual([['clear', undefined, null], ['set', undefined, 5 * MIN], ['clear', undefined, 7]]);
  });

  it('uses fetch and a decoder of its own by default', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 500 }));
    const m = new LightningMonitor({ setTimer: () => 0, clearTimer: () => {} });
    return m.start(EHAM).then((r) => {
      expect(r.state).toBe('unavailable');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });
  });
});
