import { describe, expect, it } from 'vitest';
import {
  RESTING_STEPS_PER_SECOND,
  MAX_STEP_S,
  MAX_SUBSTEPS,
  SMALL_WIDTH,
  STEPS_PER_SECOND,
  SUBSTEP_S,
  RATE,
  WIDTH,
  WindFlow,
  substeps,
  takeStep,
} from '../src/flow.js';
import { WORLD } from '../src/field.js';
import { MODE_FPS } from '../src/pacing.js';

describe('the wind particles’ steps', () => {
  // Steps taken over `seconds` of frames `dt` apart.
  function steps(dt, seconds = 1, perSecond = STEPS_PER_SECOND) {
    let pending = 0;
    const taken = [];
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      const next = takeStep(pending, dt, perSecond);
      pending = next.pending;
      if (next.step) taken.push(next.step);
    }
    return taken;
  }

  it('steps at most 30 times a second, keeping the time of the frames between', () => {
    const at60 = steps(1 / 60);
    expect(at60).toHaveLength(STEPS_PER_SECOND);
    expect(at60.reduce((a, b) => a + b)).toBeCloseTo(1, 5);
    expect(steps(1 / 120)).toHaveLength(30);
  });

  it('steps every frame when frames are further apart, up to a still frame of a quarter second', () => {
    expect(steps(1 / 20)).toHaveLength(20);
    expect(steps(0.2)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
    expect(takeStep(0, 2).step).toBe(MAX_STEP_S);
  });

  it('steps on every frame drawn while nobody uses the page, and every other while the clouds loop plays', () => {
    const idle = steps(1 / MODE_FPS.idle, 10, RESTING_STEPS_PER_SECOND);
    expect(idle).toHaveLength(200);
    expect(idle.reduce((a, b) => a + b)).toBeCloseTo(10, 5);
    // Idle at 18 frames a second, on a 144 Hz screen.
    expect(steps(8 / 144, 10, RESTING_STEPS_PER_SECOND)).toHaveLength(180);
    expect(steps(1 / MODE_FPS.loop, 10, RESTING_STEPS_PER_SECOND)).toHaveLength(150);
  });

  it('moves each step in parts of at most a thirtieth of a second, up to a quarter second', () => {
    expect(substeps(1 / 30)).toBe(1);
    expect(substeps(1 / 60)).toBe(1);
    expect(substeps(1 / 20)).toBe(2);
    expect(substeps(0.2)).toBe(6);
    expect(substeps(MAX_STEP_S)).toBe(MAX_SUBSTEPS);
    // A long gap (a tab shown again) is capped well before it gets here, but never runs away.
    expect(substeps(60)).toBe(MAX_SUBSTEPS);
    for (const dt of [1 / 60, 1 / 30, 0.05, 0.1, 0.2, MAX_STEP_S]) expect(dt / substeps(dt)).toBeLessThanOrEqual(SUBSTEP_S + 1e-9);
  });
});

describe('what the wind particles send to the graphics card', () => {
  // Bytes a second for a canvas `width` wide (half as high), drawn `fps` times a second and stepped
  // as often as takeStep allows.
  const bytesPerSecond = (width, fps, perSecond) => {
    let pending = 0;
    let uploads = 0;
    for (let k = 0; k < fps * 10; k++) {
      const next = takeStep(pending, 1 / fps, perSecond);
      pending = next.pending;
      if (next.step) uploads++;
    }
    return (uploads / 10) * width * (width / 2) * 4;
  };
  const before = (mode) => bytesPerSecond(2048, MODE_FPS[mode], STEPS_PER_SECOND);
  const MB = 2 ** 20;

  it('is about half of a 2048 × 1024 canvas stepped every frame when idle on a large screen, and a quarter on a small one', () => {
    expect(bytesPerSecond(WIDTH, MODE_FPS.idle, RESTING_STEPS_PER_SECOND)).toBeLessThanOrEqual(before('idle') / 2);
    expect(bytesPerSecond(SMALL_WIDTH, MODE_FPS.idle, RESTING_STEPS_PER_SECOND)).toBeLessThanOrEqual(before('idle') / 4);
    // 80 MB a second on a large screen, 40 on a small one.
    expect(bytesPerSecond(WIDTH, MODE_FPS.idle, RESTING_STEPS_PER_SECOND) / MB).toBeCloseTo(80, 0);
    expect(bytesPerSecond(SMALL_WIDTH, MODE_FPS.idle, RESTING_STEPS_PER_SECOND) / MB).toBeCloseTo(40, 0);
  });

  it('is a quarter of before while the clouds loop plays on a large screen', () => {
    const was = bytesPerSecond(2048, MODE_FPS.active, STEPS_PER_SECOND);
    expect(bytesPerSecond(WIDTH, MODE_FPS.loop, RESTING_STEPS_PER_SECOND)).toBeLessThanOrEqual(was / 4);
  });
});

describe('drawing the wind particles’ paths', () => {
  // A WindFlow without the globe, over the whole world on a 360 × 180 canvas (a pixel a degree),
  // with `particles` ({ lat, lng, age, life }), recording the paths it draws as runs of [x, y]
  // points: a moveTo starts a run.
  function bareFlow(particles) {
    const flow = Object.create(WindFlow.prototype);
    const n = particles.length;
    const runs = [];
    const ctx = {
      fillRect() {},
      beginPath() {},
      stroke() {},
      moveTo: (x, y) => runs.push([[x, y]]),
      lineTo: (x, y) => runs.at(-1).push([x, y]),
    };
    Object.assign(flow, {
      ctx,
      width: 360,
      height: 180,
      bounds: WORLD,
      rate: RATE,
      sinSouth: -1,
      sinNorth: 1,
      wind: new Float32Array(2),
      next: new Float64Array(2),
      lat: Float32Array.from(particles, (p) => p.lat),
      lng: Float32Array.from(particles, (p) => p.lng),
      age: Float32Array.from(particles, (p) => p.age ?? 0),
      life: Float32Array.from(particles, (p) => p.life ?? 10),
      points: new Float32Array(n * (MAX_SUBSTEPS + 1) * 2),
      drawn: new Uint8Array(n),
      band: new Uint8Array(n),
      pending: 0,
      texture: {},
    });
    return { flow, runs };
  }
  // Wind of 100 km/h from the west: 22 degrees a second east.
  const westerly = (lat, lng, out) => {
    out[0] = 100;
    out[1] = 0;
    return true;
  };

  it('draws a particle’s step as one line through its parts', () => {
    const { flow, runs } = bareFlow([{ lat: 0, lng: 0 }]);
    flow.step(0.1, westerly);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(substeps(0.1) + 1);
    expect(runs[0][0]).toEqual([180, 90]);
    expect(runs[0].at(-1)[0]).toBeCloseTo(180 + 2.2, 3);
  });

  it('ends the line at the date line rather than streaking across the map, and carries on beyond it', () => {
    const { flow, runs } = bareFlow([{ lat: 0, lng: 179 }]);
    flow.step(0.1, westerly);
    // 179° → 179.73° is drawn; the parts from there, across 180°, are not.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(2);
    for (const run of runs) for (let k = 1; k < run.length; k++) expect(Math.abs(run[k][0] - run[k - 1][0])).toBeLessThan(180);
    expect(flow.lng[0]).toBeCloseTo(-179 + 2.2 - 2, 3);
  });

  it('draws the parts before a particle respawns in the middle of a step, and not a line to where it respawns', () => {
    // Its life ends in the second of the step's three parts.
    const { flow, runs } = bareFlow([{ lat: 0, lng: 0, age: 9.95, life: 10 }]);
    flow.step(0.1, westerly);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toHaveLength(2);
    expect(runs[0][1][0]).toBeCloseTo(180 + 2.2 / 3, 3);
    expect(flow.age[0]).toBe(0);
  });

  it('draws nothing for a particle with fewer than two points in the step', () => {
    const nowhere = (lat, lng, out) => {
      out[0] = NaN;
      out[1] = NaN;
      return true;
    };
    const { flow, runs } = bareFlow([{ lat: 0, lng: 0 }, { lat: 10, lng: 10 }]);
    flow.step(0.1, nowhere);
    expect(runs).toHaveLength(0);
    // Off the map at the first part: respawned without a line.
    const edge = bareFlow([{ lat: 84.99, lng: 0 }]);
    edge.flow.step(0.1, (lat, lng, out) => {
      out[0] = 0;
      out[1] = 100;
      return true;
    });
    expect(edge.runs).toHaveLength(0);
  });
});
