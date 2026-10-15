import { describe, expect, it } from 'vitest';
import { AIRCRAFT_CLASSES, CLASS_SCALES, aircraftClass, bodyLabel, iconLayer, iconScale } from '../src/aircraftclass.js';
import { aircraftDetailsHtml } from '../src/trafficview.js';

describe('aircraftClass', () => {
  const cases = {
    narrow: ['A320', 'A21N', 'B738', 'B38M', 'B752', 'E190', 'BCS3', 'A319'],
    wide: ['B77W', 'A359', 'B789', 'A333', 'B763', 'MD11', 'A35K'],
    quad: ['B744', 'B748', 'A388', 'A346', 'IL96', 'A124', 'VC25'],
    regional: ['CRJ9', 'CRJ2', 'E145', 'E135', 'MD82', 'B712', 'F100'],
    bizjet: ['GLF5', 'GL7T', 'C56X', 'C25A', 'FA7X', 'CL35', 'LJ45', 'PC24'],
    turboprop: ['AT76', 'AT75', 'DH8D', 'SF34', 'D328', 'B190', 'C295'],
    single: ['C172', 'P28A', 'SR22', 'DA40', 'PC12', 'C208', 'TBM9'],
    twin: ['BE58', 'DA42', 'PA34', 'C421', 'BE20', 'P68', 'DHC6'],
    heli: ['R44', 'EC35', 'A139', 'AS50', 'H60', 'B407', 'S92'],
    fighter: ['F16', 'F35', 'EUFI', 'RFAL', 'F18S', 'HAWK'],
    airlifter: ['C130', 'C30J', 'A400', 'C17', 'C5M', 'IL76'],
  };

  it('knows a class for the common types of each kind', () => {
    for (const [cls, types] of Object.entries(cases)) {
      for (const type of types) expect(aircraftClass({ type }), type).toBe(cls);
    }
    expect(aircraftClass({ type: 'b77w' })).toBe('wide');
    expect(aircraftClass({ type: ' A333 ' })).toBe('wide');
  });

  it('keeps to the type when there is one, military or not', () => {
    expect(aircraftClass({ type: 'C17', military: true })).toBe('airlifter');
    expect(aircraftClass({ type: 'B744', category: 'Light aircraft' })).toBe('quad');
    expect(aircraftClass({ type: 'C172', category: 'Heavy aircraft' })).toBe('single');
  });

  it('falls back on the category when the type is missing', () => {
    expect(aircraftClass({ type: '', category: 'Heavy aircraft' })).toBe('wide');
    expect(aircraftClass({ category: 'Helicopter' })).toBe('heli');
    expect(aircraftClass({ category: 'Light aircraft' })).toBe('single');
    expect(aircraftClass({ category: 'Ultralight' })).toBe('single');
    expect(aircraftClass({ category: 'Small aircraft' })).toBe('bizjet');
    expect(aircraftClass({ category: 'High performance aircraft' })).toBe('fighter');
  });

  it('leaves it unknown when it cannot be told', () => {
    expect(aircraftClass({})).toBeNull();
    expect(aircraftClass(null)).toBeNull();
    expect(aircraftClass({ type: '', category: 'Large aircraft' })).toBeNull();
    expect(aircraftClass({ military: true })).toBeNull();
    // An unlisted type is unknown whatever its category says.
    expect(aircraftClass({ type: 'B52', category: 'Heavy aircraft' })).toBeNull();
    expect(aircraftClass({ type: 'ZZZZ', category: 'Light aircraft', military: true })).toBeNull();
  });

  it('draws unknown classes as a narrow-body at full size, the rest with their own icon and size', () => {
    expect(AIRCRAFT_CLASSES[0]).toBe('narrow');
    expect([...AIRCRAFT_CLASSES].sort()).toEqual(Object.keys(CLASS_SCALES).sort());
    expect(iconLayer({ type: 'ZZZZ' })).toBe(0);
    expect(iconScale({ type: 'ZZZZ' })).toBe(1);
    expect(iconLayer({ type: 'R44' })).toBe(AIRCRAFT_CLASSES.indexOf('heli'));
    expect(iconScale({ type: 'R44' })).toBe(0.8);
    expect(iconScale({ type: 'A388' })).toBe(1.5);
    expect(iconScale({ type: 'B789' })).toBe(1.35);
  });

  it('calls only airliners wide-body or narrow-body', () => {
    expect(bodyLabel({ type: 'B789' })).toBe('Wide-body');
    expect(bodyLabel({ type: 'A388' })).toBe('Wide-body');
    expect(bodyLabel({ type: 'A20N' })).toBe('Narrow-body');
    for (const type of ['CRJ9', 'GLF5', 'AT76', 'C172', 'R44', 'F16', 'C17', 'ZZZZ']) expect(bodyLabel({ type }), type).toBeUndefined();
  });
});

describe('the details panel', () => {
  const ask = (ac) => aircraftDetailsHtml({ id: 'ae1234', seen: 0, ...ac }, { position: { lat: 51.5, lng: -1.2 }, now: 0, locale: 'en-US' });

  it('says wide-body or narrow-body next to the type, and nothing for other classes or unknown ones', () => {
    expect(ask({ type: 'B77W' })).toContain('<dt>Body</dt><dd>Wide-body</dd>');
    expect(ask({ type: 'B748' })).toContain('<dt>Body</dt><dd>Wide-body</dd>');
    expect(ask({ type: 'A21N', category: 'Large aircraft' })).toContain('<dt>Body</dt><dd>Narrow-body</dd>');
    expect(ask({ type: 'GLF5' })).not.toContain('<dt>Body</dt>');
    expect(ask({ callsign: 'ABC1' })).not.toContain('<dt>Body</dt>');
  });
});
