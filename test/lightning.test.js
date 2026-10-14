import { describe, expect, it, vi } from 'vitest';
import {
  FRAME_COUNT,
  FRAME_MS,
  LightningMonitor,
  RAMP,
  RING_KM,
  STALE_MIN,
  analyseCounts,
  analyseImage,
  attribution,
  bearingOf,
  compassOf,
  countFromColour,
  countsFromImage,
  estimateMotion,
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
// One kilometre per pixel, and one instrument pixel is 4 km², so a flash is 4 image pixels.
const G = makeGeometry(52, 5, { halfKm: 60, size: 120, nativeKm2: 4 });
const ONE = makeGeometry(52, 5, { halfKm: 60, size: 120, nativeKm2: 1 });

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
// `now` is 8 minutes after the newest frame ends.
const nowAfter = (frames, behind = 8) => frames.at(-1).time + FRAME_MS + behind * MIN;

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

describe('colours to counts', () => {
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
    expect(r.flashes).toBe(0);
    expect(r.activeKm2).toBe(0);
    expect(r.rings.map((x) => x.km)).toEqual(RING_KM);
    expect(r.rings.every((x) => x.areaKm2 === 0 && x.flashes === 0 && x.peak === 0)).toBe(true);
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

  it('counts area and flashes within the rings, cumulatively', () => {
    // One cell 8 km east, one 25 km north, one 45 km west: only the last two rings see the second.
    const img = image([{ x: 8, y: 0, r: 2, count: 4 }, { x: 0, y: 25, r: 2, count: 8 }, { x: -45, y: 0, r: 2, count: 2 }], [], ONE);
    const r = analyseImage(img, ONE, T0);
    const [r5, r10, r20, r30] = r.rings;
    const counts = countsFromImage(img);
    const brute = (km) => {
      let px = 0;
      let sum = 0;
      let peak = 0;
      for (let i = 0; i < counts.length; i++) {
        if (!counts[i]) continue;
        const col = i % 120;
        const d = Math.hypot(col + 0.5 - 60, 60 - (i - col) / 120 - 0.5);
        if (d <= km) {
          px++;
          sum += counts[i];
          peak = Math.max(peak, counts[i]);
        }
      }
      return { px, sum, peak };
    };
    expect(r5.areaKm2).toBe(0);
    expect(r5.flashes).toBe(0);
    const b10 = brute(10);
    expect(b10.px).toBeGreaterThan(8);
    expect(r10.areaKm2).toBe(b10.px);
    expect(r10.flashes).toBe(b10.sum);
    expect(r10.peak).toBe(4);
    expect(r20.areaKm2).toBe(b10.px);
    expect(r30.areaKm2).toBe(brute(30).px);
    expect(r30.flashes).toBe(brute(30).sum);
    expect(r30.peak).toBe(8);
    expect(r.activeKm2).toBe(brute(100).px);
    expect(r.cells.map((c) => c.nearestKm)).toEqual([...r.cells.map((c) => c.nearestKm)].sort((a, b) => a - b));
  });

  it('turns the many pixels of one flash back into about one flash', () => {
    // A 4 km² instrument pixel is 4 image pixels here: a patch of 16 pixels of count 3 is 12 flashes.
    const img = image([{ x: 15, y: 0, r: 2.3, count: 3 }]);
    const r = analyseImage(img, G, T0);
    const px = countsFromImage(img).filter(Boolean).length;
    expect(r.rings[2].flashes).toBe(Math.round((px * 3) / 4));
    expect(r.flashes).toBe(r.rings[2].flashes);
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
    const g = makeGeometry(52, 5, { halfKm: 10, size, nativeKm2: 1 });
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

  it('refuses an image that is not square, and reads the size from the image', () => {
    expect(() => analyseImage({ width: 4, height: 2, data: new Uint8ClampedArray(32) }, G, T0)).toThrow();
    const g = makeGeometry(52, 5, { halfKm: 60, size: 160 });
    const small = analyseImage(image(cell(20, 0, 3), [], G), g, T0);
    expect(small.cells[0].x).toBeCloseTo(20, 0);
  });
});

describe('trend', () => {
  const frame = (k, flashes) => ({ time: T0 + k * FRAME_MS, rings: [{ flashes: 0 }, { flashes: 0 }, { flashes: 0 }, { flashes }] });
  const series = (list) => list.map((f, k) => frame(k, f));

  it('sees more, the same and less over 30 and over 60 minutes', () => {
    expect(trendOf(series([0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 20]), 30)).toBe('rising');
    expect(trendOf(series([2, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2]), 60)).toBe('steady');
    expect(trendOf(series([30, 30, 20, 20, 10, 10, 8, 5, 4, 2, 1, 0]), 60)).toBe('falling');
    // Rising over the hour but falling within the last half.
    const mixed = series([1, 2, 5, 10, 20, 30, 40, 50, 40, 30, 20, 10]);
    expect(trendOf(mixed, 60)).toBe('rising');
    expect(trendOf(mixed, 30)).toBe('falling');
  });

  it('says none when there was none, and unknown with too few images', () => {
    expect(trendOf(series(new Array(12).fill(0)), 60)).toBe('none');
    expect(trendOf(series([5]), 60)).toBe('unknown');
    expect(trendOf([], 30)).toBe('unknown');
    expect(trendOf(series([1, 2]), 60)).toBe('unknown');
  });

  it('treats a single flash more or less as noise: small changes are steady', () => {
    expect(trendOf(series([1, 1, 1, 2, 2, 2]), 30)).toBe('steady');
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
    const m = estimateMotion(coming, { behindMin: 8 });
    expect(m.state).toBe('approaching');
    expect(m.speedKmh).toBe(48);
    expect(m.headingDeg).toBe(180);
    // 20.5 km left to go to the ring at 0.8 km/min, 8 minutes behind and half a frame into the window.
    expect(m.etaMin).toBeGreaterThan(13);
    expect(m.etaMin).toBeLessThan(17);
    expect(estimateMotion(coming, { behindMin: 0 }).etaMin).toBeGreaterThan(m.etaMin + 7);
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

  it('gives no time for a cell without history, or with too little', () => {
    expect(estimateMotion(framesOf([[], [], [], [], [], cell(0, 20)])).state).toBe('unclear');
    expect(estimateMotion(framesOf([[], [], [], [], cell(0, 24), cell(0, 20)])).state).toBe('unclear');
    expect(estimateMotion(framesOf([cell(0, 40)])).state).toBe('unclear');
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
    const m = estimateMotion(gap, { behindMin: 8 });
    expect(m.state).toBe('approaching');
    expect(m.speedKmh).toBe(48);
  });

  it('gives no wait for a cell that would be within the ring by now', () => {
    const m = estimateMotion(framesOf([30, 26, 22, 18, 14, 10].map((y) => cell(0, y))), { behindMin: 8 });
    expect(m.state).toBe('approaching');
    expect(m.etaMin).toBe(0);
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
  const sum = (frames, behind = 8, extra = {}) => summarise(frames, { geometry: G, now: nowAfter(frames, behind), timeZone: 'UTC', ...extra });

  it('writes an approaching storm with the time it arrives', () => {
    const frames = framesOf([48, 44, 40, 36, 32, 28].map((y) => cell(0, y)));
    const r = sum(frames);
    expect(r.state).toBe('ok');
    expect(r.status.level).toBe('distant');
    expect(r.status.text).toBe('Lightning 26 km N, approaching, ~15 min');
    expect(r.status.dataText).toBe('as of 14:30, data 8 min behind');
    expect(r.status.detail).toMatch(/^Expected within 5 km at about 14:5\d, moving S at 48 km\/h\.$/);
    expect(r.asOf).toBe(at('2026-10-14T14:30:00Z'));
    expect(r.behindMin).toBe(8);
    expect(r.stale).toBe(false);
    expect(r.trend.min30).toBe('rising');
    expect(r.attribution).toBe('Contains modified EUMETSAT Meteosat data 2026');
    expect(r.frames).toHaveLength(6);
    expect(r.rings).toHaveLength(4);
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
    expect(away.status.level).toBe('near');
  });

  it('writes a storm overhead', () => {
    const r = sum(framesOf(new Array(6).fill(cell(1, 1, 4))));
    expect(r.status.level).toBe('overhead');
    expect(r.status.text).toBe('Lightning within 5 km, nearly stationary');
    // Half an hour of images is too little for the trend over an hour.
    expect(r.trend).toEqual({ min30: 'steady', min60: 'unknown' });
    expect(r.rings[0].areaKm2).toBeGreaterThan(20);
  });

  it('writes none within 30 km, for no lightning, noise, or lightning farther out', () => {
    expect(sum(framesOf(new Array(12).fill([]))).status.text).toBe('No lightning within 30 km');
    expect(sum(framesOf(new Array(12).fill([]))).trend).toEqual({ min30: 'none', min60: 'none' });
    expect(sum(framesOf(new Array(6).fill(cell(0, 50)))).status.text).toBe('No lightning within 30 km');
    expect(sum(framesOf(new Array(6).fill(cell(0, 50)))).status.level).toBe('none');
  });

  it('says when lightning was there a while ago', () => {
    const frames = framesOf([cell(0, 20), cell(0, 22), cell(0, 24), [], [], []]);
    const r = sum(frames, 8);
    expect(r.status.text).toBe('No lightning within 30 km, last 25 min ago');
    expect(r.trend.min30).toBe('falling');
  });

  it('flags data that is behind and gives no time from it', () => {
    const frames = framesOf([48, 44, 40, 36, 32, 28].map((y) => cell(0, y)));
    const r = sum(frames, 40);
    expect(r.stale).toBe(true);
    expect(r.status.dataText).toBe('as of 14:30, data 40 min behind');
    expect(r.status.text).toBe('Lightning 26 km N, movement unclear');
    expect(r.motion.etaMin).toBeNull();
  });

  it('answers for a place the images do not cover', () => {
    const r = uncovered(35.5, 139.8, T0);
    expect(r.state).toBe('uncovered');
    expect(r.status.text).toBe('Lightning: not covered here');
    expect(r.frames).toEqual([]);
  });
});

describe('thunderstorm risk from the forecast', () => {
  const now = at('2026-10-14T12:20:00Z');
  const hours = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const hourly = (over = {}) => ({
    time: hours(10, (i) => new Date(at('2026-10-14T10:00:00Z') + i * 3_600_000).toISOString().slice(0, 16)),
    weather_code: hours(10, () => 3),
    cape: hours(10, () => 100),
    lifted_index: hours(10, () => 2),
    ...over,
  });

  it('rates an hour by code, CAPE and lifted index', () => {
    expect(hourRisk(95, 0, 5)).toBe('high');
    expect(hourRisk(99, null, null)).toBe('high');
    expect(hourRisk(3, 1600, 1)).toBe('moderate');
    expect(hourRisk(3, 1100, -3)).toBe('moderate');
    expect(hourRisk(3, 600, 1)).toBe('low');
    expect(hourRisk(3, 100, -2.5)).toBe('low');
    expect(hourRisk(3, 100, 2)).toBe('none');
    expect(hourRisk(undefined, undefined, undefined)).toBe('none');
    expect(hourRisk(94, 0, 0)).toBe('none');
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

  it('works from CAPE alone and says none when it is calm', () => {
    const r = thunderstormRisk(hourly({ weather_code: undefined, cape: hours(10, (i) => (i === 4 ? 1800 : 50)) }), { now, timeZone: 'UTC' });
    expect(r.level).toBe('moderate');
    expect(r.word).toBe('likely');
    expect(r.text).toBe('Thunderstorms likely, from 14:00');
    const calm = thunderstormRisk(hourly(), { now });
    expect(calm).toMatchObject({ level: 'none', firstHour: null });
    expect(calm.text).toBe('Thunderstorms unlikely in the next 6 h');
  });

  it('says so when the forecast does not reach the next hours, and takes times as numbers', () => {
    expect(thunderstormRisk({ time: [] }, { now }).word).toBe('unknown');
    expect(thunderstormRisk(undefined, { now }).level).toBe('none');
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
  };
  service.fetchText = async () => {
    service.texts++;
    if (service.failText) throw new Error('HTTP 500');
    return `<Dimension name="time" default="x" units="ISO8601">2025-05-30T15:00:00.000Z/${new Date(service.end).toISOString()}/PT5M</Dimension>`;
  };
  service.loadImage = async (url) => {
    service.urls.push(url);
    if (service.failImages) throw new Error('HTTP 400');
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
    expect(result.status.dataText).toBe('as of 15:30, data 8 min behind');
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
    expect(r.behindMin).toBe(14);
    expect(live()[0].ms).toBe(30_000);
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
