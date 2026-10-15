import { describe, expect, it } from 'vitest';
import { MAX_STEP_S, STEPS_PER_SECOND, takeStep } from '../src/flow.js';

describe('the wind particles’ steps', () => {
  // Steps taken over `seconds` of frames `dt` apart.
  function steps(dt, seconds = 1) {
    let pending = 0;
    const taken = [];
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      const next = takeStep(pending, dt);
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
});
