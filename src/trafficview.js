// What the details panel shows for a selected aircraft or satellite, as HTML.
import { escapeHtml } from './airportview.js';
import { bodyLabel } from './aircraftclass.js';
import { ORBIT_LABELS } from './orbits.js';

const EMERGENCY_SQUAWKS = { 7500: 'Hijack', 7600: 'Radio failure', 7700: 'Emergency' };

const round = (v, digits = 0) => (v == null || Number.isNaN(v) ? null : Number(v.toFixed(digits)));
// Numbers follow the visitor's own locale unless one is given.
const num = (v, locale) => v.toLocaleString(locale);

export const coordsText = (lat, lng) =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(2)}° ${lng >= 0 ? 'E' : 'W'}`;

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

// The name to show for an aircraft: its callsign, else its registration, else its address.
export const aircraftName = (ac) => ac.callsign || ac.registration || ac.id.toUpperCase();

// An airport as the panel names it: "Amsterdam Airport Schiphol (AMS)".
const airportText = (airport) => (airport.name ? `${airport.name} (${airport.code})` : airport.code);

// `flight` is what the lines on the map know (see flightlines.js): where the aircraft came from
// and, if its route fits, where it is going, and whether its track could be had.
export function aircraftDetailsHtml(ac, { position, now, locale, flight }) {
  const rows = [];
  const row = (label, value) => value != null && value !== '' && rows.push(`<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`);
  row('From', flight?.from ? airportText(flight.from) : null);
  row('To', flight?.to ? airportText(flight.to) : null);
  row('Altitude', ac.onGround ? 'On the ground' : ac.altitudeFt == null ? null : `${num(Math.round(ac.altitudeFt / 25) * 25, locale)} ft`);
  row('Ground speed', round(ac.speedKt) == null ? null : `${round(ac.speedKt)} kt`);
  row('Track', round(ac.track) == null ? null : `${String(round(ac.track)).padStart(3, '0')}°`);
  if (!ac.onGround && ac.verticalFpm != null) {
    const v = Math.round(ac.verticalFpm / 50) * 50;
    row('Vertical speed', v === 0 ? 'Level' : `${v > 0 ? 'Climbing' : 'Descending'} ${num(Math.abs(v), locale)} ft/min`);
  }
  row('Squawk', ac.squawk ? `${ac.squawk}${EMERGENCY_SQUAWKS[ac.squawk] ? ` (${EMERGENCY_SQUAWKS[ac.squawk]})` : ''}` : null);
  row('Registration', ac.registration);
  row('Aircraft type', ac.description || ac.type);
  row('Body', bodyLabel(ac));
  row('Kind', ac.category);
  row('Operator', ac.operator);
  row('Country', ac.country);
  row('ICAO address', ac.id.toUpperCase());
  row('Position', coordsText(position.lat, position.lng));
  const badges = [ac.military ? '<span class="badge military">Military</span>' : ''];
  if (EMERGENCY_SQUAWKS[ac.squawk]) badges.push(`<span class="badge emergency">${EMERGENCY_SQUAWKS[ac.squawk]}</span>`);
  return `
    <p>${badges.join('')}Live ADS-B · last report ${ago(now - ac.seen)} via ${escapeHtml(ac.source ?? 'ADS-B')}${
      ac.onGround ? '' : '; position estimated since then from speed and track'
    }</p>${flight?.trackState === 'none' ? '<p>Track not available; the line shows where it has been since it was selected.</p>' : ''}
    <dl>${rows.join('')}</dl>`;
}

export function satelliteDetailsHtml(sat, { position, speed, period, inclination, orbit, epoch, now, locale }) {
  const rows = [];
  const row = (label, value) => value != null && rows.push(`<dt>${label}</dt><dd>${escapeHtml(value)}</dd>`);
  row('Altitude', position ? `${num(Math.round(position.altitudeKm), locale)} km` : null);
  row('Speed', speed == null ? null : `${speed.toFixed(2)} km/s (${num(Math.round(speed * 3600), locale)} km/h)`);
  row('Orbit', ORBIT_LABELS[orbit] ?? null);
  row('Period', period == null ? null : period < 120 ? `${Math.round(period)} min` : `${(period / 60).toFixed(1)} h`);
  row('Inclination', inclination == null ? null : `${inclination.toFixed(1)}°`);
  row('Above', position ? coordsText(position.lat, position.lng) : null);
  row('NORAD catalogue number', sat.line1.slice(2, 7).trim());
  return `
    <p>Computed live from orbital elements measured ${ago(now - epoch.getTime())} (CelesTrak). The line shows its next orbit.</p>
    <dl>${rows.join('')}</dl>`;
}
