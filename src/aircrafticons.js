// Aircraft icons seen from above, nose up, one per aircraft class (see aircraftclass.js). Each is
// drawn white so the globe's colour tint shows, with a thin dark edge and a soft shadow so it
// reads over any map or weather. Shapes are in a 128 x 128 cell around its centre and stay
// inside the inscribed circle, so turning an icon never clips it.
//
// Each part is its right half as path commands, drawn again mirrored; the halves overlap the
// centre line so no seam shows.

export const ICON_SIZE = 128;
const EDGE = 3.5;

// A fuselage from the nose (y < 0) to the tail: a rounded nose of `noseLen`, a straight
// section `w` wide each side, and a tail cone of `tailLen` narrowing to `tailW`. `hump` widens
// the front of it a little up to y = `humpEnd`, like an upper deck.
function fuselage(nose, tail, w, { noseLen, tailLen, tailW = 1, hump = 0, humpEnd = 0 }) {
  const front = w + hump;
  const path = [['M', -1, nose], ['L', 0, nose], ['C', front * 0.55, nose, front, nose + noseLen * 0.4, front, nose + noseLen]];
  if (hump) path.push(['L', front, humpEnd - 6], ['Q', front, humpEnd, w, humpEnd + 4]);
  path.push(
    ['L', w, tail - tailLen],
    ['C', w, tail - tailLen * 0.4, tailW + 0.4, tail - tailLen * 0.06, tailW, tail],
    ['L', -1, tail],
    ['Z'],
  );
  return path;
}

// A wing or tailplane from the centre line: leading edge at `y`, out to the tip at `tipX`
// (`sweep` further aft) with a crisp tip `tipChord` long, back along the trailing edge, which
// can bend at `kink` [x, y] on the way to the root.
function wing(y, rootChord, tipX, sweep, tipChord, kink = null) {
  const path = [['M', 0, y], ['L', tipX, y + sweep], ['L', tipX - 0.6, y + sweep + tipChord]];
  if (kink) path.push(['L', ...kink]);
  path.push(['L', 0, y + rootChord], ['Z']);
  return path;
}

// An engine nacelle centred at x = `cx`, its intake at `y`, `len` long and `hw` wide each side.
function nacelle(cx, y, len, hw) {
  return [
    ['M', cx - hw, y + hw], ['Q', cx - hw, y, cx, y], ['Q', cx + hw, y, cx + hw, y + hw],
    ['L', cx + hw * 0.7, y + len], ['L', cx - hw * 0.7, y + len], ['Z'],
  ];
}


// Parts that sit on the centre line are given whole (their own mirror), the others as the
// right one.
export const ICONS = {
  // A320 / 737 / E190 / A220 / 757: span about the length, 25 degree sweep, engines under the wing.
  narrow: {
    parts: [
      wing(-6, 19, 52, 22, 4.5, [17, 12]),
      nacelle(16.5, -11, 15, 3.4),
      wing(36, 11, 19, 10, 4),
      fuselage(-55, 55, 5.2, { noseLen: 15, tailLen: 26, tailW: 1.2 }),
    ],
  },
  // A330 / 787 / 777 / A350 / 767: longer, more swept span and big engines.
  wide: {
    parts: [
      wing(-14, 25, 52, 32, 4, [20, 14]),
      nacelle(17.5, -16, 20, 5),
      wing(33, 13, 22, 13, 4.5),
      fuselage(-56, 56, 6.5, { noseLen: 18, tailLen: 28, tailW: 1.4 }),
    ],
  },
  // 747 / A380 / A340: four engines, a long swept span and an upper-deck hump.
  quad: {
    parts: [
      wing(-16, 26, 54, 35, 4, [20, 13]),
      nacelle(17, -15, 17, 4.2),
      nacelle(32, -4, 15, 3.8),
      wing(34, 13, 22, 13, 4.5),
      fuselage(-56, 56, 6.6, { noseLen: 16, tailLen: 28, tailW: 1.4, hump: 0.9, humpEnd: -24 }),
    ],
  },
  // CRJ / ERJ: a long slim fuselage, engines on the rear fuselage and a T-tail.
  regional: {
    parts: [
      wing(0, 16, 39, 17, 4.5),
      nacelle(8, 24, 17, 3.6),
      wing(44, 8, 16, 8, 3.5),
      fuselage(-56, 54, 4.5, { noseLen: 15, tailLen: 22, tailW: 1.4 }),
    ],
  },
  // Business jets: short, a small swept wing, engines on the rear fuselage and a T-tail.
  bizjet: {
    parts: [
      wing(-4, 17, 46, 24, 4.5),
      nacelle(8, 16, 18, 3.6),
      wing(38, 9, 18, 9, 4),
      fuselage(-52, 50, 4.6, { noseLen: 16, tailLen: 22, tailW: 1.5 }),
    ],
  },
  // ATR / Dash 8: a long straight wing, two big engines well forward, a T-tail.
  turboprop: {
    props: [[15, -25, 10]],
    parts: [
      wing(-10, 12, 55, 1, 6),
      nacelle(15, -24, 28, 4),
      wing(43, 7, 16, 4, 4),
      fuselage(-54, 52, 5, { noseLen: 13, tailLen: 24, tailW: 1.5 }),
    ],
  },
  // Light single: a straight wing wider than the plane is long, a propeller on the nose.
  single: {
    props: [[0, -39.5, 10]],
    parts: [
      wing(-12, 13, 55, 0.5, 9),
      wing(34, 9, 17, 2, 6),
      fuselage(-38, 45, 4.8, { noseLen: 10, tailLen: 30, tailW: 1 }),
    ],
  },
  // Light twin: a straight wing with an engine on each side.
  twin: {
    props: [[17, -27, 9]],
    parts: [
      wing(-10, 14, 55, 1, 8),
      nacelle(17, -26, 30, 4),
      wing(32, 9, 18, 2, 5),
      fuselage(-45, 42, 4.5, { noseLen: 14, tailLen: 28, tailW: 1 }),
    ],
  },
  // Helicopter: a cabin pod, a thin tail boom with a small tailplane, under a rotor disc.
  heli: {
    rotor: { y: -8, r: 48 },
    parts: [
      [['M', -1, 4], ['L', 2.4, 4], ['L', 1.5, 48], ['L', -1, 48], ['Z']],
      wing(38, 4, 9, 0, 3),
      fuselage(-28, 10, 7.5, { noseLen: 12, tailLen: 14, tailW: 2.5 }),
    ],
  },
  // Fighter: a pointed nose, a sharply swept wing, twin fins and tailplanes close behind it.
  fighter: {
    parts: [
      wing(-18, 44, 36, 36, 6),
      wing(30, 16, 22, 12, 5),
      // The two fins, seen edge-on from above.
      [['M', 6, 26], ['L', 8, 26], ['L', 11, 50], ['L', 9.6, 51], ['Z']],
      [['M', -1, -56], ['L', 0, -56], ['C', 1.5, -48, 3.5, -38, 4, -30], ['L', 8, -12], ['L', 8, 38], ['L', 6.5, 46], ['L', -1, 46], ['Z']],
    ],
  },
  // Military transport (C-130 / A400M): a high straight wing with four propellers.
  airlifter: {
    props: [[16, -23, 8], [32, -22, 8]],
    parts: [
      wing(-9, 13, 56, 2, 6),
      nacelle(16, -22, 22, 3.4),
      nacelle(32, -21, 20, 3.2),
      wing(31, 10, 22, 3, 5),
      fuselage(-40, 44, 5.2, { noseLen: 10, tailLen: 22, tailW: 2.5 }),
    ],
  },
};

function trace(ctx, commands, sx) {
  ctx.beginPath();
  for (const [op, ...v] of commands) {
    const p = v.map((n, i) => (i % 2 ? n : n * sx));
    if (op === 'M') ctx.moveTo(...p);
    else if (op === 'L') ctx.lineTo(...p);
    else if (op === 'Q') ctx.quadraticCurveTo(...p);
    else if (op === 'C') ctx.bezierCurveTo(...p);
    else ctx.closePath();
  }
}

function silhouette(icon, style) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.translate(ICON_SIZE / 2, ICON_SIZE / 2);
  ctx.fillStyle = style;
  // Each part and its mirror filled on its own, so the overlaps make one clean outline.
  for (const part of icon.parts) {
    for (const sx of [1, -1]) {
      trace(ctx, part, sx);
      ctx.fill();
    }
  }
  return canvas;
}

// A rotor disc: faint, with two crossed blades, under the body.
function drawRotor(ctx, { y, r }) {
  ctx.save();
  ctx.translate(ICON_SIZE / 2, ICON_SIZE / 2 + y);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.fill();
  ctx.lineWidth = 4.5;
  ctx.strokeStyle = 'rgba(8, 12, 22, 0.3)';
  ctx.stroke();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
  ctx.stroke();
  ctx.lineCap = 'round';
  for (const [width, style] of [[4.5, 'rgba(8, 12, 22, 0.5)'], [2, 'rgba(255, 255, 255, 0.9)']]) {
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(-Math.cos(a) * r, -Math.sin(a) * r);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Propellers seen from above: thin, faint bars across the front of a nose or nacelle, each
// [x, y, half length] on the right and mirrored.
function drawProps(ctx, props) {
  ctx.save();
  ctx.translate(ICON_SIZE / 2, ICON_SIZE / 2);
  ctx.lineCap = 'round';
  for (const [width, style] of [[3.4, 'rgba(8, 12, 22, 0.4)'], [1.6, 'rgba(255, 255, 255, 0.85)']]) {
    ctx.lineWidth = width;
    ctx.strokeStyle = style;
    for (const [x, y, half] of props) {
      for (const sx of x ? [1, -1] : [1]) {
        ctx.beginPath();
        ctx.moveTo(sx * x - half, y);
        ctx.lineTo(sx * x + half, y);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

// The icon for `cls` (a key of ICONS) on a fresh ICON_SIZE canvas.
export function drawAircraftIcon(cls, { edge = EDGE, shadow = 6, shadowAlpha = 0.6 } = {}) {
  const icon = ICONS[cls];
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');
  if (icon.rotor) drawRotor(ctx, icon.rotor);
  const dark = silhouette(icon, 'rgb(8, 12, 22)');
  // A soft shadow under everything, then the thin edge: the dark silhouette nudged round a
  // small circle, then the white plane on top.
  ctx.save();
  ctx.shadowColor = `rgba(0, 0, 0, ${shadowAlpha})`;
  ctx.shadowBlur = shadow;
  ctx.drawImage(dark, 0, 0);
  ctx.restore();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ctx.drawImage(dark, Math.cos(a) * edge, Math.sin(a) * edge);
  }
  ctx.drawImage(silhouette(icon, '#fff'), 0, 0);
  if (icon.props) drawProps(ctx, icon.props);
  return canvas;
}
