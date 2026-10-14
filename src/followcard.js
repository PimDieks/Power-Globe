// The small card that replaces the panels on phones while an aircraft is followed: the parts that
// need no browser. main.js shows the card and keeps its text up to date.
import { aircraftName } from './trafficview.js';

// The card's text is worked out this often at most.
export const CARD_REFRESH_MS = 1000;
// What screen readers hear changes this seldom at most, and only when it says something new.
export const SPOKEN_MIN_MS = 20_000;

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

// The same for a screen reader, in words and rounded coarsely (500 ft, 10 kt, 10 degrees) so
// that it changes only when the flight has changed noticeably.
export function spokenText(ac, { locale } = {}) {
  const parts = [`Flight ${aircraftName(ac)}`];
  if (ac.onGround) parts.push('on the ground');
  else if (known(ac.altitudeFt)) parts.push(`altitude ${round(ac.altitudeFt, 500).toLocaleString(locale)} feet`);
  if (known(ac.speedKt)) parts.push(`ground speed ${round(ac.speedKt, 10)} knots`);
  if (known(ac.track)) parts.push(`track ${String(round(ac.track, 10) % 360).padStart(3, '0')} degrees`);
  return `${parts.join(', ')}.`;
}

// Whether the live text for screen readers should be replaced now. `last` is { text, at } of the
// previous one, or null.
export const spokenDue = (last, text, now) => !last || (text !== last.text && now - last.at >= SPOKEN_MIN_MS);

// The part of the screen left free for the aircraft, as { top, bottom } in pixels from the top:
// above the card or the panel and below the notch (`safeTop`), or below the controls when they
// are still shown.
export function freeArea({ layout, controlsBottom, detailsTop, cardTop, safeTop = 0 }) {
  if (layout === 'card') return { top: safeTop, bottom: cardTop };
  if (layout === 'panel') return { top: safeTop, bottom: detailsTop };
  return { top: controlsBottom, bottom: detailsTop };
}

// Where focus goes when the layout changes, or null to leave it. 'stop' and 'open' are the
// card's buttons, 'minimise' the full panel's, 'follow' its Follow button (or its close button
// when that is off). Focus only moves if it was in the part that goes away (`inside`), never
// when the screen was just resized or turned, and only a fresh follow (`started`) lands on the
// Stop button: Stop is not a button to land on by chance.
export function focusTarget({ previous, layout, inside, started, resized }) {
  if (resized) return null;
  if (layout === 'card') {
    if (previous === 'panel') return inside ? 'open' : null;
    return started ? 'stop' : null;
  }
  if (!inside) return null;
  return layout === 'panel' ? 'minimise' : 'follow';
}
