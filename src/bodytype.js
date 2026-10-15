// Whether an aircraft is a wide-body or a narrow-body, from its ICAO type designator (B77W, A21N)
// and failing that its emitter category. The globe draws wide-bodies bigger and broader.

// Twin-aisle airliners and the big freighters built from them, by ICAO type designator.
const WIDE = new Set([
  'A306', 'A30B', 'A310', 'A332', 'A333', 'A337', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346',
  'A359', 'A35K', 'A388', 'A3ST', 'A124', 'A225',
  'B741', 'B742', 'B743', 'B744', 'B748', 'B74R', 'B74S', 'BLCF',
  'B762', 'B763', 'B764', 'B772', 'B773', 'B77L', 'B77W', 'B778', 'B779', 'B788', 'B789', 'B78X',
  'DC10', 'MD11', 'L101', 'IL86', 'IL96', 'C5M', 'C5', 'C17', 'VC25',
]);

// Single-aisle jet airliners in service or still commonly seen.
const NARROW = new Set([
  'A318', 'A319', 'A320', 'A321', 'A19N', 'A20N', 'A21N',
  'B712', 'B717', 'B732', 'B733', 'B734', 'B735', 'B736', 'B737', 'B738', 'B739', 'B37M', 'B38M', 'B39M', 'B3XM',
  'B752', 'B753', 'B461', 'B462', 'B463', 'RJ85', 'RJ1H', 'F100', 'F70',
  'MD81', 'MD82', 'MD83', 'MD87', 'MD88', 'MD90',
  'BCS1', 'BCS3', 'E170', 'E175', 'E190', 'E195', 'E75L', 'E75S', 'E290', 'E295',
  'CRJ2', 'CRJ7', 'CRJ9', 'CRJX', 'C919', 'AJ27', 'SU95', 'T204',
]);

// 'wide' for the types listed above, or for a missing type in the heavy category; 'narrow' only
// for a type on the single-aisle list; null for everything else (turboprops, business jets,
// helicopters, light aircraft, military types), which the globe draws as before and the panel
// says nothing about.
export function bodyType(ac) {
  const type = (ac?.type ?? '').trim().toUpperCase();
  if (WIDE.has(type)) return 'wide';
  if (NARROW.has(type)) return 'narrow';
  return !type && ac?.category === 'Heavy aircraft' ? 'wide' : null;
}

export const BODY_LABELS = { wide: 'Wide-body', narrow: 'Narrow-body' };
