import { describe, expect, it } from 'vitest';
import { PAST_HOURS, buildTimeline, forecastPosition, pastTimes, samePlace, stepNearest } from '../src/timeline.js';
import { cloudTimes, parseTime, startIndex } from '../src/weather.js';

const hours = (from, count) => Array.from({ length: count }, (_, i) => new Date(Date.parse(`${from}Z`) + i * 3_600_000).toISOString().slice(0, 16));
const forecast = hours('2026-10-14T00:00', 120);
const now = Date.parse('2026-10-14T11:10:00Z');

describe('the past day before the forecast', () => {
  it('runs from the first whole hour of the last 24 to the forecast, in its format', () => {
    const past = pastTimes(forecast[0], now);
    expect(past[0]).toBe('2026-10-13T12:00');
    expect(past.at(-1)).toBe('2026-10-13T23:00');
    expect(past).toHaveLength(12);
    // With what the forecast already has, the timeline holds the last PAST_HOURS hours up to now.
    expect(past.length + 12).toBe(PAST_HOURS);
  });

  it('is empty when the forecast reaches back far enough', () => {
    expect(pastTimes(forecast[0], Date.parse('2026-10-14T23:30:00Z'))).toEqual([]);
    expect(pastTimes(forecast[0], Date.parse('2026-10-15T08:00:00Z'))).toEqual([]);
  });

  it('starts on the hour when now is one', () => {
    expect(pastTimes(forecast[0], Date.parse('2026-10-14T06:00:00Z'))[0]).toBe('2026-10-13T06:00');
  });
});

describe('the timeline', () => {
  const plain = buildTimeline(forecast, { now });
  const clouds = buildTimeline(forecast, { withPast: true, now });

  it('is the forecast alone, or the past day first in the Clouds view', () => {
    expect(plain).toEqual({ times: forecast, past: 0 });
    expect(clouds.past).toBe(12);
    expect(clouds.times).toHaveLength(132);
    expect(clouds.times[12]).toBe(forecast[0]);
  });

  it('lands on the present with Now either way', () => {
    expect(plain.times[startIndex(plain.times, now)]).toBe('2026-10-14T11:00');
    expect(clouds.times[startIndex(clouds.times, now)]).toBe('2026-10-14T11:00');
  });

  it('holds the weather at the forecast first hour through the past day', () => {
    expect(forecastPosition(0, clouds)).toBe(0);
    expect(forecastPosition(11.5, clouds)).toBe(0);
    expect(forecastPosition(12, clouds)).toBe(0);
    expect(forecastPosition(14.25, clouds)).toBe(2.25);
    expect(forecastPosition(500, clouds)).toBe(119);
    expect(forecastPosition(7.5, plain)).toBe(7.5);
  });

  it('keeps its place across a change of view, and gives it up in the past day', () => {
    expect(samePlace(30.5, plain, clouds)).toBe(42.5);
    expect(samePlace(42, clouds, plain)).toBe(30);
    expect(samePlace(5, clouds, plain)).toBeNull();
    expect(samePlace(0, plain, plain)).toBe(0);
  });
});

describe('the moving clouds while the timeline plays through the past day', () => {
  const { times } = buildTimeline(forecast, { withPast: true, now });
  const hourlyBefore = parseTime(forecast[0]);
  const ms = (i) => parseTime(times[i]);

  it('follow every hour there, and every third hour in the forecast', () => {
    expect(cloudTimes(times, 3, { playing: true, lookahead: 3, hourlyBefore })).toEqual({ time: ms(3), ahead: [ms(4), ms(5), ms(6)] });
    // At the edge: the past hours one by one, then the forecast's three-hourly times.
    expect(cloudTimes(times, 10, { playing: true, lookahead: 6, hourlyBefore })).toEqual({ time: ms(10), ahead: [ms(11), ms(12), ms(15)] });
    expect(cloudTimes(times, 13, { playing: true, lookahead: 3, hourlyBefore })).toEqual({ time: ms(12), ahead: [ms(15)] });
  });

  it('follow every hour up to the present, which is past the forecast start', () => {
    // Now is 11:10 today: the forecast's first eleven hours have images of their own too.
    expect(cloudTimes(times, 14, { playing: true, lookahead: 2, hourlyBefore: now })).toEqual({ time: ms(14), ahead: [ms(15), ms(16)] });
    // In the future, every third hour (all the newest image anyway).
    expect(cloudTimes(times, 25, { playing: true, lookahead: 2, hourlyBefore: now })).toEqual({ time: ms(24), ahead: [ms(27)] });
  });
});

describe('the step nearest a time', () => {
  it('finds the exact hour, or the closest one when the timeline has gaps', () => {
    expect(stepNearest(forecast, '2026-10-14T15:00')).toBe(15);
    const threeHourly = hours('2026-10-14T00:00', 8).filter((_, i) => i % 3 === 0);
    expect(stepNearest(threeHourly, '2026-10-14T04:00')).toBe(1);
    expect(stepNearest(threeHourly, '2026-10-14T05:00')).toBe(2);
    expect(stepNearest(forecast, '2026-12-01T00:00')).toBe(forecast.length - 1);
    expect(stepNearest([], '2026-10-14T00:00')).toBe(-1);
  });
});
