import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import { DRAWN, MAX_TRAIL_STEPS, ScreenFlow, TRAIL, TRAIL_STEP_S, drawnPoints, trailSteps } from '../src/screenflow.js';

describe('the zoomed-in wind particles', () => {
  // Steps taken over `seconds` of frames `dt` apart.
  function stepsOver(dt, seconds = 10) {
    let remainder = 0;
    let total = 0;
    for (let k = 0; k < Math.round(seconds / dt); k++) {
      const next = trailSteps(remainder, dt);
      remainder = next.remainder;
      total += next.steps;
    }
    return total;
  }

  it('move in steps of a sixtieth of a second at any frame rate, so their trails are as long', () => {
    for (const fps of [5, 18, 20, 30, 60, 72, 90, 120]) expect(stepsOver(1 / fps)).toBeCloseTo(600, -0.5);
  });

  it('take a step per frame at 60 frames a second, however the frame times jitter', () => {
    let remainder = 0;
    for (let k = 0; k < 600; k++) {
      const next = trailSteps(remainder, 1 / 60 + (k % 2 ? 0.002 : -0.002));
      remainder = next.remainder;
      expect(next.steps).toBe(1);
    }
  });

  it('take at most a quarter second of steps after a long gap', () => {
    expect(trailSteps(0, 30)).toEqual({ steps: MAX_TRAIL_STEPS, remainder: 0 });
    expect(MAX_TRAIL_STEPS * TRAIL_STEP_S).toBeCloseTo(0.25, 5);
  });

  it('leave trails of 25 steps, about 0.42 seconds of motion', () => {
    expect((TRAIL - 1) * TRAIL_STEP_S).toBeCloseTo(0.42, 2);
  });
});

describe('the positions a trail is drawn through', () => {
  it('takes every other one from the newest and keeps the oldest, so the trail keeps its length', () => {
    expect(drawnPoints(26, 2)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 25]);
    expect(drawnPoints(25, 2)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
  });

  it('takes all of them with a stride of one', () => {
    expect(drawnPoints(5, 1)).toEqual([0, 1, 2, 3, 4]);
  });
});

// A path that records what is drawn through it, as [x, y] runs: a moveTo starts a run.
function recordingPath() {
  const runs = [];
  return {
    runs,
    moveTo: (x, y) => runs.push([[x, y]]),
    lineTo: (x, y) => runs.at(-1).push([x, y]),
    addPath: (other) => runs.push(...other.runs),
  };
}

describe('drawing the zoomed-in wind', () => {
  // One particle whose trail, from newest (age 0) to oldest, runs along x at z = 0.9 on a globe of
  // radius 1 seen from z = 10, through an identity view-projection onto a 200 × 100 canvas: the
  // point of age `k` at x = k / 100, pixel x = (1 + k / 100) * 100.
  function flowWithTrail(hidden = []) {
    const flow = Object.create(ScreenFlow.prototype);
    const camera = { projectionMatrix: new Matrix4(), matrixWorldInverse: new Matrix4(), position: { x: 0, y: 0, z: 10 } };
    const strokes = [];
    Object.assign(flow, {
      globe: { camera: () => camera },
      canvas: { width: 200, height: 100 },
      ctx: { clearRect() {}, stroke: (path) => strokes.push({ runs: path.runs, width: flow.ctx.lineWidth }) },
      matrix: new Matrix4(),
      newPath: recordingPath,
      radius: 1,
      lineWidth: 1,
      lat: new Float32Array(1),
      slow: new Uint8Array(1),
      head: 0,
      trail: new Float32Array(TRAIL * 3),
      points: new Float32Array(DRAWN.length * 2),
      shown: new Uint8Array(DRAWN.length),
    });
    for (let k = 0; k < TRAIL; k++) {
      // Behind the globe, as seen from the camera.
      flow.trail.set([k / 100, 0, hidden.includes(k) ? -0.9 : 0.9], ((TRAIL - k) % TRAIL) * 3);
    }
    flow.draw();
    // The ages each run of the white trails goes through (the halo, drawn first, is wider).
    const ages = (run) => run.map(([x]) => Math.round((x / 100 - 1) * 100));
    const trails = strokes.filter((s) => s.width === 1);
    return { halo: strokes.filter((s) => s.width > 1), runs: trails.flatMap((s) => s.runs.map(ages)) };
  }

  it('draws a trail through every other position, the oldest included, in a run for each fading step', () => {
    const { runs } = flowWithTrail();
    expect(runs.flat().filter((a, i, all) => all.indexOf(a) === i)).toEqual(DRAWN);
    // Each run picks up where the one before ended.
    for (let r = 1; r < runs.length; r++) expect(runs[r][0]).toBe(runs[r - 1].at(-1));
  });

  it('breaks the trail where a position is behind the globe, rather than drawing through it', () => {
    const { runs } = flowWithTrail([12]);
    const segments = runs.flatMap((run) => run.slice(1).map((a, i) => [run[i], a]));
    expect(segments.some(([a, b]) => a <= 12 && b >= 12)).toBe(false);
    expect(segments).toContainEqual([8, 10]);
    expect(segments).toContainEqual([14, 16]);
    expect(segments).toContainEqual([24, 25]);
  });

  it('draws the halo once, under all of the trails', () => {
    const { halo, runs } = flowWithTrail([12]);
    expect(halo).toHaveLength(1);
    expect(halo[0].runs).toHaveLength(runs.length);
  });
});
