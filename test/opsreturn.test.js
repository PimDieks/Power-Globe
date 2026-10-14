import { describe, expect, it } from 'vitest';
import { afterDeselect, backAction, escapeAction, opsKeepsWatching, opsReturnFor } from '../src/opsreturn.js';

const airport = { airport: { ident: 'EHAM' }, hourly: {}, fromList: false };
const aircraft = { kind: 'aircraft', id: 'abc123' };
const satellite = { kind: 'satellite', index: 3 };

describe('the way back from an aircraft picked on the Traffic tab', () => {
  it('remembers the airport when an aircraft is picked while its Traffic tab is open, and not otherwise', () => {
    expect(opsReturnFor({ detail: airport, detailTab: 'traffic', opsReturn: null }, aircraft)).toBe(airport);
    // The other tabs, a spot, nothing open, or a satellite: nothing to go back to.
    expect(opsReturnFor({ detail: airport, detailTab: 'details', opsReturn: null }, aircraft)).toBeNull();
    expect(opsReturnFor({ detail: { lat: 1, lng: 2 }, detailTab: 'traffic', opsReturn: null }, aircraft)).toBeNull();
    expect(opsReturnFor({ detail: null, detailTab: 'traffic', opsReturn: null }, aircraft)).toBeNull();
    expect(opsReturnFor({ detail: airport, detailTab: 'traffic', opsReturn: null }, satellite)).toBeNull();
  });

  it('keeps the airport when another aircraft is picked from the aircraft panel', () => {
    expect(opsReturnFor({ detail: { traffic: aircraft }, detailTab: 'traffic', opsReturn: airport }, { kind: 'aircraft', id: 'def456' })).toBe(airport);
    // An aircraft panel with no airport behind it has none to keep.
    expect(opsReturnFor({ detail: { traffic: aircraft }, detailTab: 'traffic', opsReturn: null }, aircraft)).toBeNull();
  });

  it('keeps the Traffic tab watching only while the aircraft panel has an airport behind it', () => {
    expect(opsKeepsWatching({ detail: { traffic: aircraft }, opsReturn: airport })).toBe(true);
    expect(opsKeepsWatching({ detail: { traffic: aircraft }, opsReturn: null })).toBe(false);
    expect(opsKeepsWatching({ detail: airport, opsReturn: null })).toBe(false);
    expect(opsKeepsWatching({ detail: null, opsReturn: airport })).toBe(false);
  });

  it('closes the aircraft panel and the way back when the aircraft is deselected, so nothing is left watching', () => {
    // The Flights layer is switched off with an aircraft picked from the Traffic tab: the page deselects it.
    const state = { detail: { traffic: aircraft }, opsReturn: airport };
    const next = afterDeselect(state);
    expect(next).toEqual({ detail: null, opsReturn: null });
    Object.assign(state, next);
    expect(opsKeepsWatching(state)).toBe(false);
    // With no aircraft panel open, a deselect changes nothing (going back to the airport does it itself).
    expect(afterDeselect({ detail: airport, opsReturn: null })).toBeNull();
    expect(afterDeselect({ detail: null, opsReturn: null })).toBeNull();
  });

  it('goes back to the airport for the back button and for Escape, and to the wind check or closing otherwise', () => {
    const fromOps = { detail: { traffic: aircraft }, opsReturn: airport };
    expect(backAction(fromOps)).toBe('back-to-airport');
    expect(escapeAction(fromOps)).toBe('back-to-airport');
    // Following comes first, as it did.
    expect(escapeAction(fromOps, { following: true })).toBe('stop-following');
    // An aircraft picked on the map: close, as before; back goes to the wind check.
    const plain = { detail: { traffic: aircraft }, opsReturn: null };
    expect(escapeAction(plain)).toBe('close');
    expect(backAction(plain)).toBe('back-to-wind-check');
    expect(escapeAction({ detail: { ...airport, fromList: true }, opsReturn: null })).toBe('back-to-wind-check');
    expect(escapeAction({ detail: airport, opsReturn: null })).toBe('close');
    expect(escapeAction({ detail: null, opsReturn: null })).toBeNull();
  });
});
