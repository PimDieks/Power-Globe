import { describe, expect, it } from 'vitest';
import { bodyType } from '../src/bodytype.js';
import { aircraftDetailsHtml } from '../src/trafficview.js';

describe('bodyType', () => {
  it('calls the airliners and freighters on the list wide-bodies', () => {
    for (const type of ['B77W', 'A359', 'B744', 'A388', 'B789', 'MD11', 'C17', 'A124']) {
      expect(bodyType({ type }), type).toBe('wide');
    }
    expect(bodyType({ type: 'b77w' })).toBe('wide');
    expect(bodyType({ type: ' A333 ' })).toBe('wide');
  });

  it('calls the single-aisle jet airliners narrow-bodies', () => {
    for (const type of ['A21N', 'A20N', 'B738', 'A320', 'B38M', 'B752', 'E190', 'CRJ9', 'BCS3', 'MD82']) {
      expect(bodyType({ type }), type).toBe('narrow');
    }
  });

  it('falls back on the heavy category when the type is missing', () => {
    expect(bodyType({ type: '', category: 'Heavy aircraft' })).toBe('wide');
    expect(bodyType({ category: 'Heavy aircraft' })).toBe('wide');
  });

  it('leaves it unknown when it cannot be told', () => {
    expect(bodyType({})).toBeNull();
    expect(bodyType({ type: '', category: 'Large aircraft' })).toBeNull();
    expect(bodyType({ type: '', category: 'Light aircraft' })).toBeNull();
    expect(bodyType(null)).toBeNull();
  });

  it('says nothing of light aircraft, turboprops, business jets, helicopters, military types or unlisted heavies', () => {
    expect(bodyType({ type: 'C172', category: '' })).toBeNull();
    expect(bodyType({ type: 'C172' })).toBeNull();
    expect(bodyType({ type: 'R44', category: 'Helicopter' })).toBeNull();
    expect(bodyType({ type: 'AT76', category: 'Large aircraft' })).toBeNull();
    expect(bodyType({ type: 'DH8D', category: 'Large aircraft' })).toBeNull();
    expect(bodyType({ type: 'GLF5', category: 'Large aircraft' })).toBeNull();
    expect(bodyType({ type: 'B52', category: 'Heavy aircraft' })).toBeNull();
    expect(bodyType({ type: 'C130', category: 'Large aircraft', military: true })).toBeNull();
    // A wide-body stays one when it is military.
    expect(bodyType({ type: 'C17', military: true })).toBe('wide');
    expect(bodyType({ type: 'VC25' })).toBe('wide');
  });
});

describe('the details panel', () => {
  const ask = (ac) => aircraftDetailsHtml({ id: 'ae1234', seen: 0, ...ac }, { position: { lat: 51.5, lng: -1.2 }, now: 0, locale: 'en-US' });

  it('says wide-body or narrow-body next to the type, and nothing when it is unknown', () => {
    expect(ask({ type: 'B77W' })).toContain('<dt>Body</dt><dd>Wide-body</dd>');
    expect(ask({ type: 'A21N', category: 'Large aircraft' })).toContain('<dt>Body</dt><dd>Narrow-body</dd>');
    expect(ask({ callsign: 'ABC1' })).not.toContain('<dt>Body</dt>');
  });
});
