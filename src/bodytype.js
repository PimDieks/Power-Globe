// Whether an aircraft is a wide-body or a narrow-body, from its ICAO type designator (B77W, A21N)
// and failing that its emitter category. The globe draws wide-bodies bigger and broader.

// Twin-aisle airliners and the big freighters built from them, by ICAO type designator.
const WIDE = new Set([
  'A306', 'A30B', 'A310', 'A332', 'A333', 'A337', 'A338', 'A339', 'A342', 'A343', 'A345', 'A346',
  'A359', 'A35K', 'A388', 'A3ST', 'A124', 'A225',
  'B741', 'B742', 'B743', 'B744', 'B748', 'B74R', 'B74S', 'BLCF',
  'B762', 'B763', 'B764', 'B772', 'B773', 'B77L', 'B77W', 'B778', 'B779', 'B788', 'B789', 'B78X',
  'DC10', 'MD11', 'L101', 'IL86', 'IL96', 'C5M', 'C5', 'C17',
]);

// 'wide', 'narrow', or null when it cannot be told. Narrow-body is only said of a known type in
// the large-aircraft class (or with no class given), so helicopters, light aircraft, military
// types and the heavies that are not on the list stay unknown rather than being called narrow-body.
export function bodyType(ac) {
  const type = (ac?.type ?? '').trim().toUpperCase();
  if (WIDE.has(type)) return 'wide';
  if (!type) return ac?.category === 'Heavy aircraft' ? 'wide' : null;
  if (ac.military) return null;
  return !ac.category || ac.category === 'Large aircraft' ? 'narrow' : null;
}

export const BODY_LABELS = { wide: 'Wide-body', narrow: 'Narrow-body' };
