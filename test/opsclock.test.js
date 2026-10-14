import { describe, expect, it } from 'vitest';
import { formatClock, formatClockShort, formatTick, zoneName } from '../src/opsclock.js';

const TODAY = Date.parse('2026-10-14T12:00:00Z');

describe('the clock of the Ops view', () => {
  it('writes a time in the local zone, with the zone, and the day when it is not today', () => {
    const opts = { locale: 'en-GB', timeZone: 'Europe/Amsterdam', today: TODAY };
    expect(formatClock('2026-10-14T13:00', opts)).toBe('15:00 CEST');
    expect(formatClock('2026-10-14T23:00', opts)).toMatch(/^Thu,? 01:00 CEST$/);
    expect(formatClockShort('2026-10-14T13:00', opts)).toBe('15:00');
  });

  it('counts a day in the zone, not in GMT', () => {
    // 22:00 GMT on the 14th is already the 15th in Amsterdam, 21:30 is not.
    const opts = { locale: 'en-GB', timeZone: 'Europe/Amsterdam', today: TODAY };
    expect(formatClockShort('2026-10-14T21:30', opts)).toBe('23:30');
    expect(formatClockShort('2026-10-14T22:00', opts)).toMatch(/^Thu/);
  });

  it('labels an axis with the hour, and the minutes in zones that have them', () => {
    expect(formatTick('2026-10-14T15:00', { locale: 'en-US', timeZone: 'UTC' })).toBe('3 PM');
    expect(formatTick('2026-10-14T15:00', { locale: 'en-US', timeZone: 'Asia/Kolkata' })).toBe('8:30 PM');
    expect(formatTick('2026-10-14T15:00', { locale: 'en-US', timeZone: 'Asia/Kathmandu' })).toBe('8:45 PM');
    expect(formatTick('2026-10-14T15:00', { locale: 'en-GB', timeZone: 'Europe/Amsterdam' })).toBe('17');
  });

  it('names the zone', () => {
    expect(zoneName({ locale: 'en-GB', timeZone: 'Europe/Amsterdam', at: TODAY })).toBe('CEST');
    expect(zoneName({ locale: 'en-US', timeZone: 'UTC', at: TODAY })).toBe('UTC');
  });
});
