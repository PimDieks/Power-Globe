import { describe, expect, it } from 'vitest';
import { SPOKEN_MIN_MS, cardText, focusTarget, followLayout, freeArea, spokenDue, spokenText } from '../src/followcard.js';

const ac = (overrides = {}) => ({
  id: 'abc123',
  callsign: 'KLM123',
  registration: 'PH-BXA',
  altitudeFt: 36012,
  speedKt: 450.4,
  track: 270.2,
  onGround: false,
  ...overrides,
});

describe('followLayout', () => {
  it('shows the card on a phone while following', () => {
    expect(followLayout({ following: true, narrow: true, expanded: false })).toBe('card');
  });

  it('shows the full panel after the card was tapped', () => {
    expect(followLayout({ following: true, narrow: true, expanded: true })).toBe('panel');
  });

  it('leaves the usual layout when not following or on a wide screen', () => {
    expect(followLayout({ following: false, narrow: true, expanded: false })).toBe('normal');
    expect(followLayout({ following: false, narrow: true, expanded: true })).toBe('normal');
    expect(followLayout({ following: true, narrow: false, expanded: false })).toBe('normal');
    expect(followLayout({ following: true, narrow: false, expanded: true })).toBe('normal');
  });
});

describe('cardText', () => {
  it('gives the name, altitude, ground speed and track', () => {
    expect(cardText(ac(), { locale: 'en-US' })).toEqual({ name: 'KLM123', line: '36,000 ft · 450 kt · 270°' });
  });

  it('pads the track and wraps 360 to 000', () => {
    expect(cardText(ac({ track: 5 })).line).toContain('005°');
    expect(cardText(ac({ track: 359.8 })).line).toContain('000°');
  });

  it('names an aircraft without a callsign by its registration, then its address', () => {
    expect(cardText(ac({ callsign: '' })).name).toBe('PH-BXA');
    expect(cardText(ac({ callsign: null, registration: null })).name).toBe('ABC123');
  });

  it('says so when on the ground and leaves out what is not known', () => {
    expect(cardText(ac({ onGround: true, speedKt: 12 })).line).toBe('On the ground · 12 kt · 270°');
    expect(cardText(ac({ altitudeFt: null, speedKt: undefined, track: NaN })).line).toBe('');
  });
});

describe('spokenText', () => {
  it('reads in words, rounded coarsely', () => {
    expect(spokenText(ac(), { locale: 'en-US' })).toBe('Flight KLM123, altitude 36,000 feet, ground speed 450 knots, track 270 degrees.');
  });

  it('does not change for small differences', () => {
    expect(spokenText(ac({ altitudeFt: 36040, speedKt: 452, track: 271 }))).toBe(spokenText(ac()));
  });

  it('changes when the flight changes noticeably', () => {
    expect(spokenText(ac({ altitudeFt: 37000 }))).not.toBe(spokenText(ac()));
    expect(spokenText(ac({ track: 300 }))).not.toBe(spokenText(ac()));
  });
});

describe('spokenDue', () => {
  it('speaks the first text', () => {
    expect(spokenDue(null, 'a', 0)).toBe(true);
  });

  it('waits, and stays quiet for the same text', () => {
    const last = { text: 'a', at: 1000 };
    expect(spokenDue(last, 'b', 1000 + SPOKEN_MIN_MS - 1)).toBe(false);
    expect(spokenDue(last, 'b', 1000 + SPOKEN_MIN_MS)).toBe(true);
    expect(spokenDue(last, 'a', 1000 + 10 * SPOKEN_MIN_MS)).toBe(false);
  });
});

describe('freeArea', () => {
  const measured = { controlsBottom: 120, detailsTop: 400, cardTop: 700 };

  it('is the screen above the card', () => {
    expect(freeArea({ layout: 'card', ...measured })).toEqual({ top: 0, bottom: 700 });
  });

  it('is the screen above the full panel, with no controls', () => {
    expect(freeArea({ layout: 'panel', ...measured })).toEqual({ top: 0, bottom: 400 });
  });

  it('starts below the notch', () => {
    expect(freeArea({ layout: 'card', safeTop: 44, ...measured })).toEqual({ top: 44, bottom: 700 });
    expect(freeArea({ layout: 'panel', safeTop: 44, ...measured })).toEqual({ top: 44, bottom: 400 });
  });

  it('is between the controls and the panel otherwise', () => {
    expect(freeArea({ layout: 'normal', ...measured })).toEqual({ top: 120, bottom: 400 });
  });
});

describe('focusTarget', () => {
  const base = { inside: true, started: false, resized: false };

  it('lands on Stop only for a fresh follow', () => {
    expect(focusTarget({ ...base, previous: 'normal', layout: 'card', started: true })).toBe('stop');
    expect(focusTarget({ ...base, previous: 'normal', layout: 'card' })).toBeNull();
  });

  it('goes to the open button of the card when the panel is minimised, not to Stop', () => {
    expect(focusTarget({ ...base, previous: 'panel', layout: 'card' })).toBe('open');
  });

  it('goes to Minimise when the card is opened', () => {
    expect(focusTarget({ ...base, previous: 'card', layout: 'panel' })).toBe('minimise');
  });

  it('goes back to Follow when following ends', () => {
    expect(focusTarget({ ...base, previous: 'card', layout: 'normal' })).toBe('follow');
    expect(focusTarget({ ...base, previous: 'panel', layout: 'normal' })).toBe('follow');
  });

  it('leaves focus alone when it was not in the part that went away', () => {
    expect(focusTarget({ ...base, inside: false, previous: 'card', layout: 'normal' })).toBeNull();
    expect(focusTarget({ ...base, inside: false, previous: 'card', layout: 'panel' })).toBeNull();
    expect(focusTarget({ ...base, inside: false, previous: 'panel', layout: 'card' })).toBeNull();
  });

  it('leaves focus alone on a resize or a turn of the screen', () => {
    expect(focusTarget({ ...base, resized: true, started: true, previous: 'normal', layout: 'card' })).toBeNull();
    expect(focusTarget({ ...base, resized: true, previous: 'card', layout: 'normal' })).toBeNull();
  });
});
