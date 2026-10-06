'use strict';
/* ---------------------------------------------------------------------------
   The companion, drawn by hand in SVG. No dependencies, like charts.js.

   Three candidate creatures, each drawn from something reckon actually
   measures, so the SHAPE carries the data instead of decorating it:

     dial     a gauge with one big eye — the pupil is the needle
     tide     a body that fills with water — the water line is the swap
     lantern  a lantern whose rays multiply — the count of rays is the strain

   Every expression is a row of numbers fed to a drawing function. A new
   expression is a new row, not a new file.

   Status is never a colour (CONTRIBUTING.md §5). The only colours are the cyan
   accent and the ocean surface, identical in every state. How bad things are
   is told by shape: eye opening, brows, needle, water line, ray count,
   outline tremor, a drop.

   Everything is measured against a 120 x 120 box.
--------------------------------------------------------------------------- */
(function () {

//   open    eye height, 0 (a closed line) to 1 (wide)
//   brow    brow tilt in degrees, positive = the inner ends rise (worry)
//   mouth   negative smiles, 0 flat, positive frowns
//   shake   offset of the doubled outline in px; 0 = one steady line
//   drop    1 draws a drop of sweat
//   glow    the lantern's light: cyan, then yellow, then orange. Never the red or
//           the green of the palette, and never the ONLY signal — the flame, the
//           rays and the tremor say the same thing to anyone who cannot tell hues apart
//   level   0..1 — what the creature's own instrument shows: needle angle,
//           water height, or number of rays. In production this is the
//           MEASURED value, not a pose.
const STATES = {
  resting:  { label: 'resting',  says: 'nothing to report',           open: 0.10, brow: 0,  mouth: -1, shake: 0, drop: 0, level: 0.05, glow: null },
  watching: { label: 'watching', says: 'keeping an eye on something', open: 0.75, brow: 0,  mouth: -2, shake: 0, drop: 0, level: 0.30, glow: 'var(--cyan)' },
  uneasy:   { label: 'uneasy',   says: 'something is getting slow',   open: 0.85, brow: 16, mouth: 2,  shake: 0, drop: 0, level: 0.62, glow: 'var(--s4)' },
  strained: { label: 'strained', says: 'this is costing you seconds', open: 1.00, brow: 24, mouth: 5,  shake: 3, drop: 1, level: 0.95, glow: 'var(--s2)' },
};

const INK = 'var(--cyan)';
const FACE = 'var(--bg2)';

function attrs(o) {
  return Object.entries(o).map(([k, v]) => `${k}="${v}"`).join(' ');
}
const line = (extra) => attrs({ fill: 'none', stroke: INK, 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...extra });
const path = (d, extra) => `<path ${attrs({ d })} ${line(extra)}/>`;

// A regular eye at (cx, cy): a ring with a pupil, or a closed lid when nearly shut.
function eye(cx, cy, p, rx = 8) {
  if (p.open < 0.2) return path(`M${cx - rx} ${cy} Q${cx} ${cy + 4} ${cx + rx} ${cy}`);
  const ry = 3 + 8 * p.open;
  return `<ellipse ${attrs({ cx, cy, rx, ry })} ${line()}/>` +
    `<circle ${attrs({ cx, cy: cy + (p.open > 0.9 ? 0 : 1), r: p.pupil || 3, fill: INK })}/>`;
}

// Positive tilt raises the INNER ends: the shape of worry.
function brows(cxL, cxR, y, p, half = 7) {
  if (!p.brow) return '';
  const dy = Math.sin((p.brow * Math.PI) / 180) * half;
  return path(`M${cxL - half} ${y + dy} L${cxL + half} ${y - dy}`) +
         path(`M${cxR - half} ${y - dy} L${cxR + half} ${y + dy}`);
}

function mouth(cx, y, w, p) {
  return path(`M${cx - w} ${y} Q${cx} ${y - p.mouth * 2.2} ${cx + w} ${y}`);
}

function drop(x, y, p) {
  return p.drop ? path(`M${x} ${y} Q${x + 7} ${y + 11} ${x} ${y + 16} Q${x - 7} ${y + 11} ${x} ${y}Z`, { 'stroke-width': 3 }) : '';
}

// The outline, drawn twice and offset when the creature is trembling. A still
// image of a trembling line has to read as trembling without animation.
function trembling(p, draw) {
  return p.shake ? draw(-p.shake, 0.45) + draw(p.shake, 1) : draw(0, 1);
}

// ---------------------------------------------------------------------------
// DIAL. A round gauge. Nine ticks on the upper arc, and one big eye whose
// needle points at the reading. The ticks up to the reading are drawn heavy,
// so the level survives being looked at for half a second from across a room.
// ---------------------------------------------------------------------------
function dial(p) {
  const cx = 60, cy = 64;
  const polar = (deg, r) => [cx + r * Math.cos((deg * Math.PI) / 180), cy + r * Math.sin((deg * Math.PI) / 180)];
  const body = trembling(p, (dx, o) =>
    `<circle ${attrs({ cx: cx + dx, cy, r: 42, fill: FACE })}/>` +
    `<circle ${attrs({ cx: cx + dx, cy, r: 42, opacity: o })} ${line({ 'stroke-width': 5 })}/>`);

  let ticks = '';
  const lit = Math.round(p.level * 8);
  for (let i = 0; i <= 8; i++) {
    const deg = 200 + (i / 8) * 140;
    const [x1, y1] = polar(deg, 30), [x2, y2] = polar(deg, 36);
    ticks += path(`M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`, { 'stroke-width': i <= lit ? 4.5 : 2 });
  }

  const eyeY = cy + 6;
  const ry = 2 + 11 * p.open;
  const eyeShape = p.open < 0.2
    ? path(`M42 ${eyeY} Q60 ${eyeY + 6} 78 ${eyeY}`)
    : `<ellipse ${attrs({ cx, cy: eyeY, rx: 18, ry })} ${line()}/>`;
  // The needle is the pupil: it starts at the middle of the eye and points at the reading.
  const [nx, ny] = polar(200 + p.level * 140, 25);
  const needle = p.open < 0.2 ? '' : path(`M${cx} ${eyeY} L${nx.toFixed(1)} ${ny.toFixed(1)}`, { 'stroke-width': 4 }) +
    `<circle ${attrs({ cx, cy: eyeY, r: 3.5, fill: INK })}/>`;

  const feet = path('M44 106 L44 112') + path('M76 106 L76 112');
  return body + ticks + eyeShape + needle + mouth(cx, eyeY + 22, 8, p) + feet + drop(96, 36, p);
}

// ---------------------------------------------------------------------------
// TIDE. A ghost-shaped body that fills with water from the feet up. The water
// line IS the swap: in production `level` is swap used over swap total.
// ---------------------------------------------------------------------------
function tide(p, id) {
  const bodyD = 'M34 102 V56 A26 26 0 0 1 86 56 V102 Z';
  const top = 100 - p.level * 34;               // water surface, y
  const wave = (y) => {
    let d = `M30 ${y}`;
    for (let x = 30; x < 92; x += 14) d += ` q7 -5 14 0`;
    return d;
  };
  const clip = `<clipPath id="tide-${id}"><path d="${bodyD}"/></clipPath>`;
  const water = `<g clip-path="url(#tide-${id})">` +
    `<rect ${attrs({ x: 20, y: top, width: 80, height: 110, fill: INK, opacity: 0.28 })}/>` +
    path(wave(top), { 'stroke-width': 3 }) + `</g>`;
  const body = trembling(p, (dx, o) =>
    `<path ${attrs({ d: bodyD, transform: `translate(${dx} 0)`, fill: FACE })}/>` +
    `<path ${attrs({ d: bodyD, transform: `translate(${dx} 0)`, opacity: o })} ${line({ 'stroke-width': 5 })}/>`);
  const bubbles = p.level > 0.85
    ? `<circle ${attrs({ cx: 48, cy: 88, r: 3 })} ${line({ 'stroke-width': 2 })}/>` +
      `<circle ${attrs({ cx: 68, cy: 80, r: 4 })} ${line({ 'stroke-width': 2 })}/>` +
      `<circle ${attrs({ cx: 58, cy: 94, r: 2.5 })} ${line({ 'stroke-width': 2 })}/>` : '';
  const feet = path('M46 102 L46 110') + path('M74 102 L74 110');
  return clip + body + water + brows(50, 70, 34, p, 6) + eye(50, 44, p, 7) + eye(70, 44, p, 7) +
    mouth(60, 59, 7, p) + bubbles + feet + drop(90, 34, p);
}

// ---------------------------------------------------------------------------
// POSE. The lantern as NUMBERS and nothing else: every quantity the drawing and its
// motion depend on, derived from the one measured level. The SVG below consumes this,
// and a native drawing of the same lantern consumes the same numbers, so the two cannot
// drift apart without `bin/check.js` noticing. Nothing here is rounded: a consumer
// rounds where it draws.
//
// `heat` is 0 at a reading of 80 and 1 at 100. The four states cover the whole scale,
// but the last one covers the part that matters most, so it keeps changing all the way
// up: more rays, a paler and brighter glow (heat is white, never red), a whiter flame,
// a harder tremble.
// ---------------------------------------------------------------------------
function pose(input) {
  const p = resolve(input);
  if (!p) throw new TypeError('unknown pet state: ' + input);
  const l = p.level;
  const heat = Math.max(0, Math.min(1, (l - 0.8) / 0.2));
  const lit = Math.min(1, 0.25 + l * 0.75);
  const rays = l > 0.8 ? 4 + Math.round(heat * 3) : Math.round(l * 5);
  // At the top it trembles instead of swinging: a wide sway caught mid-swing reads as
  // a crooked lantern, which is exactly what the first strained drawing looked like.
  const sway = l < 0.8 ? 0.8 + l * 1.6 : 2.08 - Math.min(1, heat * 2) * 1.08;   // 2.1 deg at 80, down to 1.0 by 90
  return {
    level: l, heat, lit, glow: p.glow, open: p.open, drop: p.drop, shake: p.shake,
    brow: p.brow + heat * 8, mouth: p.mouth + heat * 3, pupil: 3 - heat * 1.2,
    glowMix: heat * 50,                       // percent of --ink mixed into the glow
    haloOpacity: 0.10 + l * 0.32 + heat * 0.22,
    glassOpacity: Math.min(0.95, 0.30 + lit * 0.55 + heat * 0.10),
    flameH: 5 + l * 10, flameW: 0.55 + heat * 0.4, coreOpacity: heat * 0.9,
    rays, rayGap: rays > 5 ? 8.5 : 10, rayLen: 6 + l * 8 + heat * 4,
    secondDrop: heat > 0.5 ? 1 : 0,
    sway, swingT: 4.6 - l * 3.2, flickT: 1.7 - l * 1.2, pulseT: 3.4 - l * 2.5,
    shakePx: 0.5 + heat * 2.2, shakeT: 0.14 - heat * 0.07,
  };
}

// ---------------------------------------------------------------------------
// LANTERN. A small lantern with a flame behind its face. The flame grows, the
// glass fills with light, a halo spreads behind it, and rays leave in pairs —
// and the light changes colour as things get worse. Asleep, it is unlit.
//
// It MOVES, and every movement means something: it hangs from its ring and
// sways, the flame flickers, the halo breathes, the rays pulse outward, it
// blinks. All of it speeds up with `level`, and at the top it trembles and
// the sweat drop falls. A still frame never fakes a tremor by drawing the
// outline twice — that only ever shifted the body and left the roof behind.
// ---------------------------------------------------------------------------
function lantern(p, id) {
  const q = pose(p);
  const heat = q.heat;
  const glow = q.glow && heat > 0 ? `color-mix(in srgb, ${q.glow}, var(--ink) ${Math.round(q.glowMix)}%)` : q.glow;
  const bodyD = 'M38 46 Q31 76 37 106 H83 Q89 76 82 46 Z';

  // The gradients need ids that cannot collide when several lanterns share a page.
  const defs = glow ? `<defs>` +
    `<radialGradient id="halo-${id}" cx="60" cy="66" r="52" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0.35" stop-color="${glow}" stop-opacity="${q.haloOpacity.toFixed(2)}"/>` +
      `<stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="glass-${id}" cx="60" cy="66" r="34" gradientUnits="userSpaceOnUse">` +
      `<stop offset="0" stop-color="${glow}" stop-opacity="${q.glassOpacity.toFixed(2)}"/>` +
      `<stop offset="1" stop-color="${glow}" stop-opacity="0.06"/></radialGradient></defs>` : '';
  const halo = glow ? `<circle class="pet-halo" ${attrs({ cx: 60, cy: 66, r: 52, fill: `url(#halo-${id})` })}/>` : '';

  const body =
    `<path ${attrs({ d: bodyD, fill: FACE })}/>` +
    (glow ? `<path ${attrs({ d: bodyD, fill: `url(#glass-${id})` })}/>` : '') +
    `<path ${attrs({ d: bodyD })} ${line({ 'stroke-width': 5 })}/>`;

  // The flame sits between the roof and the eyes. Unlit, it is one small dot.
  const h = q.flameH;
  const w = q.flameW;
  const flameD = (k) => `M60 ${62 - h * k} Q${60 + h * w * k} ${62 - h * 0.35 * k} 60 62 Q${60 - h * w * k} ${62 - h * 0.35 * k} 60 ${62 - h * k}Z`;
  const core = heat > 0
    ? path(flameD(0.55), { fill: 'var(--ink)', stroke: 'none', opacity: q.coreOpacity.toFixed(2) }) : '';
  const flame = glow
    ? `<g class="pet-flame">` + path(flameD(1), { fill: glow, stroke: glow, 'stroke-width': 2, opacity: 0.95 }) + core + `</g>`
    : `<circle ${attrs({ cx: 60, cy: 60, r: 1.8, fill: INK, opacity: 0.45 })}/>`;

  const roof = path('M34 46 L46 32 H74 L86 46 Z', { 'stroke-width': 5 });
  const ring = `<circle ${attrs({ cx: 60, cy: 20, r: 7 })} ${line({ 'stroke-width': 4 })}/>` + path('M60 27 V32', { 'stroke-width': 4 });
  const base = path('M30 110 H90', { 'stroke-width': 6 });

  const pairs = q.rays;
  const gap = q.rayGap;
  let left = '', right = '';
  for (let i = 0; i < pairs; i++) {
    const y = 56 + i * gap - (pairs - 1) * 2;
    const len = q.rayLen;
    left += path(`M24 ${y} L${24 - len} ${y - 3}`, { stroke: glow || INK, 'stroke-width': 3 });
    right += path(`M96 ${y} L${96 + len} ${y - 3}`, { stroke: glow || INK, 'stroke-width': 3 });
  }
  const rays = pairs ? `<g class="pet-ray-l">${left}</g><g class="pet-ray-r">${right}</g>` : '';

  const face = `<g class="pet-eyes">` + brows(50, 70, 70, q, 6) + eye(50, 80, q, 7) + eye(70, 80, q, 7) + `</g>` + mouth(60, 100, 7, q);
  const sweat = p.drop
    ? `<g class="pet-drop">${drop(92, 26, p)}</g>` + (q.secondDrop ? `<g class="pet-drop pet-drop2">${drop(26, 26, p)}</g>` : '') : '';

  // Outermost group pops in when the state changes; the halo is outside the swing
  // because light does not hang from the ring.
  return defs + `<g class="pet-pop">` + halo +
    `<g class="pet-swing"><g class="pet-shake">` + rays + body + flame + roof + ring + base + face + sweat + `</g></g></g>`;
}

// The motion. It lives inside the drawing so the SVG is self-contained: the same
// string animates on the page, in an export, or anywhere it is dropped. Rates come
// from custom properties set on the root from `level`, so a busier machine gives
// a busier lantern without a second stylesheet. Nothing here uses a child
// combinator, because the drawing is also read as XML.
const CSS = `
.pet-root { overflow: visible }
.pet-pop, .pet-swing, .pet-shake, .pet-flame, .pet-eyes, .pet-halo, .pet-drop, .pet-ray-l, .pet-ray-r
  { transform-box: view-box }
.pet-pop   { transform-origin: 60px 66px }
.pet-swing { transform-origin: 60px 13px; animation: pet-sway var(--swingT) ease-in-out infinite }
.pet-flame { transform-origin: 60px 62px; animation: pet-flicker var(--flickT) ease-in-out infinite alternate }
.pet-halo  { transform-origin: 60px 66px; animation: pet-breathe-glow var(--pulseT) ease-in-out infinite }
.pet-eyes  { transform-origin: 60px 80px; animation: pet-blink 4.6s ease-in-out infinite }
.pet-ray-l { animation: pet-ray-l var(--pulseT) ease-out infinite }
.pet-ray-r { animation: pet-ray-r var(--pulseT) ease-out infinite }
.pet-drop  { animation: pet-fall 1.5s ease-in infinite }
.pet-drop2 { animation-delay: 0.75s }
.pet-asleep .pet-swing { transform-origin: 60px 110px; animation: pet-breathe 3.8s ease-in-out infinite }
.pet-asleep .pet-eyes { animation: none }
.pet-strain .pet-shake { animation: pet-shake var(--shakeT) steps(1, end) infinite }
.pet-strain .pet-eyes { animation: none }
.pet-wake .pet-pop { animation: pet-wake 0.6s cubic-bezier(0.3, 1.5, 0.5, 1) }
@keyframes pet-sway { 0%, 100% { transform: rotate(calc(var(--sway) * -1)) } 50% { transform: rotate(var(--sway)) } }
@keyframes pet-breathe { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.025, 1.015) } }
@keyframes pet-flicker {
  0% { transform: scale(1, 1) skewX(0deg) }
  50% { transform: scale(0.9, 1.14) skewX(5deg) }
  100% { transform: scale(1.07, 0.9) skewX(-5deg) }
}
@keyframes pet-breathe-glow { 0%, 100% { opacity: 0.7; transform: scale(0.96) } 50% { opacity: 1; transform: scale(1.05) } }
@keyframes pet-blink { 0%, 90%, 100% { transform: scaleY(1) } 94% { transform: scaleY(0.08) } }
@keyframes pet-ray-l { 0% { transform: translateX(0); opacity: 1 } 100% { transform: translateX(-5px); opacity: 0.25 } }
@keyframes pet-ray-r { 0% { transform: translateX(0); opacity: 1 } 100% { transform: translateX(5px); opacity: 0.25 } }
@keyframes pet-fall { 0% { transform: translateY(0); opacity: 0 } 20% { opacity: 1 } 100% { transform: translateY(24px); opacity: 0 } }
@keyframes pet-shake { 0% { transform: translate(var(--shake), 0) } 50% { transform: translate(calc(var(--shake) * -1), calc(var(--shake) * 0.4)) } }
@keyframes pet-wake { 0% { transform: scale(0.82); opacity: 0.4 } 100% { transform: scale(1); opacity: 1 } }
@media (prefers-reduced-motion: reduce) { .pet-root * { animation: none !important } }
`;

// Everything a state needs to move, derived from the one measured number.
function tempo(p) {
  const q = pose(p);
  return `--sway:${q.sway.toFixed(1)}deg;--swingT:${q.swingT.toFixed(2)}s;` +
    `--flickT:${q.flickT.toFixed(2)}s;--pulseT:${q.pulseT.toFixed(2)}s;` +
    `--shake:${q.shakePx.toFixed(2)}px;--shakeT:${q.shakeT.toFixed(3)}s`;
}

const CONCEPTS = { lantern, tide, dial };

// A number is a measurement, a string names a state, an object is used as it comes.
// The discrete parts of a face (open eyes, brows, mouth) come from the nearest state;
// the continuous parts (flame, halo, rays, tempo) follow the number itself.
function resolve(input) {
  if (typeof input === 'string') return STATES[input] || null;
  if (typeof input === 'number') {
    const l = Math.max(0, Math.min(1, input));
    const k = l < 0.15 ? 'resting' : l < 0.45 ? 'watching' : l < 0.8 ? 'uneasy' : 'strained';
    return { ...STATES[k], level: l };
  }
  return input;
}

// Returns the SVG as a STRING. Pure on purpose: it can be tested in Node without
// a DOM, and the page sets it with innerHTML.
//   opts.uid   keeps gradient ids apart when several drawings share one page
//   opts.wake  plays the short pop that says "the state just changed"
function svg(state, size, concept, opts) {
  const p = resolve(state);
  if (!p) throw new TypeError('unknown pet state: ' + state);
  const name = concept || 'lantern';
  const draw = CONCEPTS[name];
  if (!draw) throw new TypeError('unknown pet concept: ' + name);
  const o = opts || {};
  const px = size || 120;
  const id = `${typeof state === 'string' ? state : 'live'}${o.uid ? '-' + o.uid : ''}`;
  const cls = ['pet-root', p.level < 0.15 ? 'pet-asleep' : '', p.level > 0.8 ? 'pet-strain' : '', o.wake ? 'pet-wake' : '']
    .filter(Boolean).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${cls}" style="${tempo(p)}" viewBox="0 0 120 120" ` +
    `width="${px}" height="${px}" role="img" aria-label="reckon, ${p.label || 'live'}">` +
    `<style>${CSS}</style>` + draw(p, id) + '</svg>';
}

// A live companion: one element that changes state without being rebuilt by hand.
// `set` accepts a state name or a measurement from 0 to 1, and plays the wake pop
// only when the STATE changes, not on every reading that stays inside it.
function mount(el, size, concept) {
  let last = null;
  return {
    set(input) {
      const p = resolve(input);
      const kind = p.level < 0.15 ? 0 : p.level < 0.45 ? 1 : p.level < 0.8 ? 2 : 3;
      el.innerHTML = svg(input, size, concept, { uid: 'mounted', wake: last !== null && kind !== last });
      last = kind;
    },
  };
}

const api = { STATES, CONCEPTS: Object.keys(CONCEPTS), svg, mount, resolve, pose, CSS };
if (typeof window !== 'undefined') window.reckonPet = api;
if (typeof module !== 'undefined') module.exports = api;

})();
