// Times for the Ops view, written in the reader's local time. Each takes a GMT time as the
// forecast writes it ("2026-10-14T15:00") and options for tests: `locale`, `timeZone` and `today`
// (ms, which day counts as today).
import { parseTime } from './weather.js';

const date = (time) => new Date(parseTime(time));

// "15:00 CEST", or "Thu 02:00 CEST" when it is not today; without the zone when `withZone` is false.
export function formatClock(time, { withZone = true, locale, timeZone, today = Date.now() } = {}) {
  const d = date(time);
  const sameDay = d.toLocaleDateString(locale, { timeZone }) === new Date(today).toLocaleDateString(locale, { timeZone });
  return d.toLocaleTimeString(locale, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
    ...(withZone ? { timeZoneName: 'short' } : {}),
    timeZone,
  });
}

export const formatClockShort = (time, options) => formatClock(time, { ...options, withZone: false });

// The label for an hour along an axis: "5 PM" or "17", and with the minutes where the zone has them
// ("8:30 PM" in India).
export function formatTick(time, { locale, timeZone } = {}) {
  const d = date(time);
  const minutes = Number(new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone }).format(d));
  return d.toLocaleTimeString(locale, { hour: 'numeric', ...(minutes ? { minute: '2-digit' } : {}), timeZone });
}

// The zone's short name, "CEST" or "GMT+2".
export function zoneName({ locale, timeZone, at = Date.now() } = {}) {
  const part = new Intl.DateTimeFormat(locale, { timeZoneName: 'short', timeZone }).formatToParts(new Date(at)).find((p) => p.type === 'timeZoneName');
  return part?.value ?? 'local time';
}
