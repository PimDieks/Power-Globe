// What kind of aircraft something is, from its ICAO type designator (B77W, A21N, C172) and
// failing that its emitter category. The globe draws each class with its own icon and size
// (see aircrafticons.js); the details panel says wide-body or narrow-body for airliners.

const set = (s) => new Set(s.trim().split(/\s+/));

// Twin-engined wide-bodies (the trijets go with them), and the freighters built from them.
const WIDE = set(`
  A306 A30B A310 A332 A333 A337 A338 A339 A359 A35K A3ST
  B762 B763 B764 B772 B773 B77L B77W B778 B779 B788 B789 B78X
  DC10 MD11 L101 KC10 K46
`);

// Four-engined wide-bodies and the big four-engined jets.
const QUAD = set(`
  A342 A343 A345 A346 A388 A124 A225 IL86 IL96
  B741 B742 B743 B744 B748 B74R B74S BLCF VC25 E3TF E3CF B703 K35R K35E DC86 DC87
`);

// Single-aisle jet airliners with their engines under the wing.
const NARROW = set(`
  A318 A319 A320 A321 A19N A20N A21N
  B731 B732 B733 B734 B735 B736 B737 B738 B739 B37M B38M B39M B3XM B752 B753 P8
  BCS1 BCS3 E170 E175 E190 E195 E75L E75S E290 E295
  B461 B462 B463 RJ70 RJ85 RJ1H C919 SU95 T204
`);

// Jets with their engines on the rear fuselage and a T-tail: regional jets and the airliners
// built the same way.
const REGIONAL = set(`
  CRJ1 CRJ2 CRJ7 CRJ9 CRJX E135 E145 E35L E45X AJ27
  F28 F70 F100 B722 DC9 DC91 DC93 DC94 DC95 MD81 MD82 MD83 MD87 MD88 MD90 B712 B717 YK40 YK42 T154
`);

// Business jets.
const BIZJET = set(`
  C500 C501 C510 C525 C25A C25B C25C C25M C526 C550 C551 C55B C560 C56X C650 C680 C68A C700 C750
  CL30 CL35 CL60 GL5T GL7T GLEX GLF2 GLF3 GLF4 GLF5 GLF6 G150 G200 G280 GA5C GA6C GA7C GA8C GALX ASTR
  E50P E55P E545 E550 F2TH F900 FA10 FA20 FA50 FA6X FA7X FA8X H25A H25B H25C
  LJ31 LJ35 LJ40 LJ45 LJ55 LJ60 LJ70 LJ75 PRM1 BE40 HDJT PC24 SF50 EA50 WW24
`);

// Regional turboprop airliners.
const TURBOPROP = set(`
  AT43 AT44 AT45 AT46 AT72 AT73 AT75 AT76 DH8A DH8B DH8C DH8D SF34 SB20 D328 F27 F50
  E120 JS31 JS32 JS41 B190 AN24 AN26 AN32 CN35 C295 S340 MA60 Y12 L410 DHC7
`);

// Light single-engined aircraft, piston and turboprop.
const SINGLE = set(`
  C150 C152 C162 C170 C172 C175 C177 C77R C180 C182 C185 C195 C205 C206 C207 C208 C210 P210 T210
  PA18 PA20 PA22 PA24 PA25 PA28 P28A P28B P28R P28T PA32 P32R P32T PA38 PA46 P46T
  SR20 SR22 S22T DA20 DA40 DV20 TB9 TB10 TB20 TB21 M20P M20T BE33 BE35 BE36 A210 AT3
  RV4 RV6 RV7 RV8 RV9 RV10 RV12 PC6 PC7 PC9 PC12 PC21 TBM7 TBM8 TBM9 KODI G115 DR40 EV97 AA5 GLID
  CH7A J3 ULAC
`);

// Light twins.
const TWIN = set(`
  BE55 BE58 BE60 BE76 BE95 BE9L BE9T BE20 BE30 B350 PA23 PA27 PA30 PA31 PA34 PA44 P68 DA42 DA62
  C310 C303 C340 C402 C404 C414 C421 C425 C441 BN2P DHC6 AC90 AC95 P180 MU2 SW4 E2
`);

// Helicopters.
const HELI = set(`
  R22 R44 R66 EC20 EC30 EC35 EC45 EC55 EC75 EC25 AS50 AS55 AS65 AS32 AS3B
  A109 A119 A139 A169 A189 B06 B06T H145 B407 B412 B429 B505 B212 H500 H60 S76 S92 S61 NH90 EH10
  H47 H64 MI8 MI24 BK17 B47G EXPL UH1 LYNX TIGR PUMA
`);

// Fighters and fast jet trainers.
const FIGHTER = set(`
  F15 F16 F18 F18S F22 F35 F4 F5 F14 F117 EUFI RFAL TOR MIR2 HAWK AJET T38 MG29 SU27 SU30 SU35 A10
  L159 M346 L39 T45
`);

// Military transports: high wing, four engines.
const AIRLIFTER = set(`
  C130 C30J C27J A400 C17 C5 C5M C160 AN12 IL76 C141 KC39 V22 B52
`);

const BY_TYPE = [
  ['wide', WIDE], ['quad', QUAD], ['narrow', NARROW], ['regional', REGIONAL], ['bizjet', BIZJET],
  ['turboprop', TURBOPROP], ['single', SINGLE], ['twin', TWIN], ['heli', HELI],
  ['fighter', FIGHTER], ['airlifter', AIRLIFTER],
];

// When the type is missing: the emitter category says something too.
const BY_CATEGORY = {
  'Heavy aircraft': 'wide',
  'Light aircraft': 'single',
  Ultralight: 'single',
  Glider: 'single',
  'Small aircraft': 'bizjet',
  Helicopter: 'heli',
  'High performance aircraft': 'fighter',
};

// The classes in the order of the globe's icon layers: narrow-body first, which is also what
// an aircraft of unknown class is drawn as.
export const AIRCRAFT_CLASSES = ['narrow', 'wide', 'quad', 'regional', 'bizjet', 'turboprop', 'single', 'twin', 'heli', 'fighter', 'airlifter'];

// How big each class is drawn, against a narrow-body.
export const CLASS_SCALES = {
  single: 0.7,
  twin: 0.75,
  heli: 0.8,
  bizjet: 0.8,
  turboprop: 0.9,
  regional: 0.9,
  narrow: 1,
  wide: 1.35,
  quad: 1.5,
  fighter: 0.85,
  airlifter: 1.25,
};

// The class of `ac` (a key of CLASS_SCALES), or null when it cannot be told: an unlisted type,
// or no type and a category that says nothing (a large aircraft, or only that it is military).
export function aircraftClass(ac) {
  const type = (ac?.type ?? '').trim().toUpperCase();
  if (type) {
    for (const [cls, types] of BY_TYPE) if (types.has(type)) return cls;
    return null;
  }
  return BY_CATEGORY[ac?.category] ?? null;
}

// The class `ac` is drawn as: its own, or for an unlisted type what its category says.
const iconClass = (ac) => aircraftClass(ac) ?? BY_CATEGORY[ac?.category] ?? null;

// Which icon layer and size `ac` is drawn with.
export const iconLayer = (ac) => Math.max(0, AIRCRAFT_CLASSES.indexOf(iconClass(ac)));
export const iconScale = (ac) => CLASS_SCALES[iconClass(ac)] ?? 1;

// 'Wide-body' or 'Narrow-body' for airliners, undefined for everything else.
const BODY_LABELS = { wide: 'Wide-body', quad: 'Wide-body', narrow: 'Narrow-body' };
export const bodyLabel = (ac) => BODY_LABELS[aircraftClass(ac)];
