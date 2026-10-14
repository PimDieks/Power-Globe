// The small card that replaces the panels on phones while an aircraft is followed: the parts that
// need no browser. main.js shows the card and keeps its text up to date.
import { aircraftName } from './trafficview.js';

// The card's text is worked out this often at most.
export const CARD_REFRESH_MS = 1000;
// What screen readers hear changes this seldom at most, and only when it says something new.
export const SPOKEN_MIN_MS = 5000;

const round = (v, step) => Math.round(v / step) * step;
const known = (v) => v != null && !Number.isNaN(v);

// How the screen is laid out. 'normal': the usual panels. 'card': a phone that follows an
// aircraft, with only the small card. 'panel': the same phone after the card was tapped, with
// the aircraft's full panel but still without the controls and the timeline.
export function followLayout({ following, narrow, expanded }) {
  if (!following || !narrow) return 'normal';
  return expanded ? 'panel' : 'card';
}

// What the card says about an aircraft, from its latest report: { name, line }. Parts the
// report does not have are left out.
export function cardText(ac, { locale } = {}) {
  const parts = [];
  if (ac.onGround) parts.push('On the ground');
  else if (known(ac.altitudeFt)) parts.push(`${round(ac.altitudeFt, 25).toLocaleString(locale)} ft`);
  if (known(ac.speedKt)) parts.push(`${Math.round(ac.speedKt)} kt`);
  if (known(ac.track)) parts.push(`${String(Math.round(ac.track) % 360).padStart(3, '0')}°`);
  return { name: aircraftName(ac), line: parts.join(' · ') };
}

// The same for a screen reader, in words and rounded more coarsely so that it changes only when
// the flight has changed noticeably.
export function spokenText(ac, { locale } = {}) {
  const parts = [`Flight ${aircraftName(ac)}`];
  if (ac.onGround) parts.push('on the ground');
  else if (known(ac.altitudeFt)) parts.push(`altitude ${round(ac.altitudeFt, 100).toLocaleString(locale)} feet`);
  if (known(ac.speedKt)) parts.push(`ground speed ${round(ac.speedKt, 5)} knots`);
  if (known(ac.track)) parts.push(`track ${String(round(ac.track, 5) % 360).padStart(3, '0')} degrees`);
  return `${parts.join(', ')}.`;
}

// Whether the live text for screen readers should be replaced now. `last` is { text, at } of the
// previous one, or null.
export const spokenDue = (last, text, now) => !last || (text !== last.text && now - last.at >= SPOKEN_MIN_MS);

// The part of the screen left free for the aircraft, as { top, bottom } in pixels from the top:
// above the card or the panel, and below the controls when they are still shown.
export function freeArea({ layout, controlsBottom, detailsTop, cardTop }) {
  if (layout === 'card') return { top: 0, bottom: cardTop };
  if (layout === 'panel') return { top: 0, bottom: detailsTop };
  return { top: controlsBottom, bottom: detailsTop };
}
