// The timeline's times. It is the forecast's, from 00:00 UTC today, except while the Clouds view
// is on: then the past day of satellite images comes first, so the clouds can be seen moving up
// to the present. The weather layers have nothing before the forecast; there they hold its first
// step.

import { parseTime } from './weather.js';

// Hours of satellite images shown before the present in the Clouds view.
export const PAST_HOURS = 24;
const HOUR = 3_600_000;

// The whole hours from `hours` before `now` up to, not including, the forecast's first time
// `first`, written like the forecast's times ("2026-10-14T07:00", UTC).
export function pastTimes(first, now = Date.now(), hours = PAST_HOURS) {
  const end = parseTime(first);
  const out = [];
  for (let t = Math.ceil((now - hours * HOUR) / HOUR) * HOUR; t < end; t += HOUR) {
    out.push(new Date(t).toISOString().slice(0, 16));
  }
  return out;
}

// The timeline: the forecast's times, after the past ones when `withPast`. `past` is how many
// steps come before the forecast.
export function buildTimeline(forecastTimes, { withPast = false, now = Date.now() } = {}) {
  const past = withPast ? pastTimes(forecastTimes[0], now) : [];
  return { times: [...past, ...forecastTimes], past: past.length };
}

// The fractional step into the forecast for the fractional timeline step `t`: the past steps
// hold the forecast's first.
export function forecastPosition(t, { past, times }) {
  return Math.min(times.length - 1 - past, Math.max(0, t - past));
}

// The step on `next` showing the same time as step `t` on `previous`, keeping the part between
// steps, or null when `next` does not have that time (as when the past steps go).
export function samePlace(t, previous, next) {
  const step = Math.round(t);
  const index = next.times.indexOf(previous.times[step]);
  return index < 0 ? null : Math.max(0, index + (t - step));
}
