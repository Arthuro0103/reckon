'use strict';
/* ---------------------------------------------------------------------------
   Charts drawn by hand in SVG. No dependencies — a panel that measures RAM
   cannot load a 300 kB library to draw a bar.

   Specs every mark here follows:
     bar     <= 24px thick, 4px rounded data-end, square at the baseline
     line    2px, round joins and caps
     dot     >= 8px across, with a 2px ring in the surface colour
     area    the series hue at ~10% — a wash, never a saturated block
     grid    1px, solid (never dashed), one step off the surface
     gap     a 2px gap in the surface colour separates touching marks, not a border

   Every shape with a plot gets a hover layer. Every shape gets a table twin:
   a tooltip improves reading, it is never the only way to read a value.
--------------------------------------------------------------------------- */

// A classic script shares the global scope with app.js: without this IIFE every
// `function` here collides with a `const` of the same name there, and the whole
// page dies in a SyntaxError before the first line runs.
(function () {

const NS = 'http://www.w3.org/2000/svg';
const SUP = '#0b1a26';           // surface: the colour of the gaps and the rings

function s(tag, attrs = {}, ...filhos) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, v);
  for (const f of filhos.flat()) if (f) n.append(f.nodeType ? f : document.createTextNode(String(f)));
  return n;
}
function h(tag, attrs = {}, ...filhos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const f of filhos.flat()) if (f != null && f !== false) n.append(f.nodeType ? f : document.createTextNode(String(f)));
  return n;
}
const SERIES = (i) => `var(--s${(i % 8) + 1})`;
const RAMP = ['var(--q1)', 'var(--q2)', 'var(--q3)', 'var(--q4)', 'var(--q5)', 'var(--q6)'];

// Ticks on round numbers. An axis does not show 3.7142.
function ticks(max, n = 4) {
  if (!(max > 0)) return [0];
  const bruto = max / n;
  const mag = Math.pow(10, Math.floor(Math.log10(bruto)));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((p) => p >= bruto) || 10 * mag;
  const saida = [];
  for (let v = 0; v <= max * 1.0001; v += passo) saida.push(+v.toFixed(6));
  return saida;
}
const fmt = (v, places = 1) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(places));
// Enough decimals for the label to tell the truth about where the line sits. A
// step of 2.5 rounded to whole numbers labelled the grid 0 · 3 · 5 · 8 · 10 —
// and the line at 2.5 then claimed to be 3.
function fmtScale(v, passo) {
  const p = Math.abs(passo);
  const places = Number.isInteger(p) ? 0 : Number.isInteger(p * 10) ? 1 : 2;
  return v.toFixed(places);
}

/* ------------------------------------------------------------------ tooltip */
// One for the whole page: 40 tooltips pinned to the DOM waste memory for nothing.
let tip;
function showTip(alvo, html, ev) {
  if (!tip) { tip = h('div', { class: 'tip' }); document.body.append(tip); }
  tip.innerHTML = html;
  tip.style.display = 'block';
  const r = alvo.getBoundingClientRect();
  const x = ev ? ev.clientX : r.left + r.width / 2;
  const y = ev ? ev.clientY : r.top;
  const d = tip.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(innerWidth - d.width - 8, x - d.width / 2)) + 'px';
  tip.style.top = Math.max(8, y - d.height - 12) + 'px';
}
const hideTip = () => { if (tip) tip.style.display = 'none'; };
addEventListener('scroll', hideTip, true);

// Generous hit area: nobody lands dead-centre on an 8px dot.
function hover(el, html) {
  el.style.cursor = 'default';
  el.addEventListener('mousemove', (ev) => showTip(el, html, ev));
  el.addEventListener('mouseleave', hideTip);
  el.setAttribute('tabindex', '0');
  el.addEventListener('focus', () => showTip(el, html, null));   // keyboard reads the same
  el.addEventListener('blur', hideTip);
  return el;
}

/* ------------------------------------------------------------- moldura */
// A card with a title, the shape, and the table twin behind a button.
function card({ title, sub, shape, table, legend, tall }) {
  const body = h('div', { class: 'g-body' }, shape);
  let tableEl = null;
  const toggle = table ? h('button', { class: 'g-toggle', onclick: () => {
    const showing = tableEl.hidden;
    tableEl.hidden = !showing; body.hidden = showing;
    toggle.textContent = showing ? 'show chart' : 'show table';
  } }, 'show table') : null;
  if (table) { tableEl = h('div', { class: 'g-table', hidden: true }, table); }
  return h('figure', { class: 'g-card' + (tall ? ' tall' : '') },
    h('figcaption', {},
      h('div', {}, h('h3', {}, title), sub ? h('p', {}, sub) : null),
      toggle),
    legend || null, body, tableEl);
}

function legendOf(items) {
  return h('div', { class: 'g-legend' }, ...items.map((i) =>
    h('span', {}, h('i', { style: `background:${i.color}` }), i.name)));
}

function tableOf(columns, rows) {
  return h('table', {},
    h('thead', {}, h('tr', {}, ...columns.map((c, i) => h('th', { class: i ? 'num' : '' }, c)))),
    h('tbody', {}, ...rows.map((l) => h('tr', {}, ...l.map((c, i) => h('td', { class: i ? 'num' : '' }, c))))));
}

/* =================================================================== BARRAS */
/* Nominal categories: ONE colour (slot 1) for all of them. Painting each bar a
   different shade by size would spend the identity channel repeating what the
   bar's length already says. */
function bars({ data, unit = 'GB', color = 'var(--s1)', highlight = null, directLabels = 2, height }) {
  const n = data.length;
  const linhaH = 30, topo = 6, esq = 0;
  const height2 = height || topo + n * linhaH + 4;
  const max = Math.max(...data.map((d) => d.value), 0.0001);
  const width = 600, plotX = 232, plotL = width - plotX - 58;

  const svg = s('svg', { viewBox: `0 0 ${width} ${height2}`, class: 'g-svg', preserveAspectRatio: 'xMidYMin meet' });

  data.forEach((d, i) => {
    const y = topo + i * linhaH;
    const w = Math.max(2, (d.value / max) * plotL);
    const c = highlight && highlight(d) ? 'var(--edge)' : (d.color || color);
    const g = s('g', {});
    // track: shows the scale without needing gridlines
    g.append(s('rect', { x: plotX, y: y + 7, width: plotL, height: 10, rx: 2, fill: 'var(--bg3)' }));
    // bar: square at the baseline, 4px rounded at the data end
    g.append(s('path', {
      d: `M${plotX},${y + 7} h${Math.max(0, w - 4)} a4,4 0 0 1 4,4 v2 a4,4 0 0 1 -4,4 h${-Math.max(0, w - 4)} z`,
      fill: c,
    }));
    g.append(s('text', { x: plotX - 12, y: y + 16, 'text-anchor': 'end', class: 'g-tick' }, d.name));
    // direct labels on the first few only: a number on every point is chaos
    if (i < directLabels || (highlight && highlight(d))) {
      g.append(s('text', { x: plotX + w + 9, y: y + 16, class: 'g-val' }, `${fmt(d.value)} ${unit}`));
    }
    hover(g, `<b>${d.name}</b><br>${fmt(d.value, 2)} ${unit}${d.note ? '<br><i>' + d.note + '</i>' : ''}`);
    svg.append(g);
  });
  return svg;
}

/* ========================================================= BARRA EMPILHADA */
/* A single bar, parts of a whole. A 2px gap in the surface colour between the
   segments — separation by gap, never by a border drawn around them. */
function stackedBar({ parts, height = 34, unit = 'GB', labels = true }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const width = 600, gapPx = 2;
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'g-svg', preserveAspectRatio: 'none' });
  let x = 0;
  parts.forEach((p, i) => {
    const w = Math.max(0, (p.value / total) * width - (i < parts.length - 1 ? gapPx : 0));
    const g = s('g', {});
    g.append(s('rect', { x, y: 0, width: w, height: height, rx: 2, fill: p.color }));
    if (labels && w > 78) {
      // The label wears light or dark ink depending on the segment: on a dark
      // slice, dark text simply disappeared.
      g.append(s('text', { x: x + 10, y: height / 2 + 4, class: 'g-inside' + (p.escuro ? ' claro' : '') },
        `${fmt(p.value)} ${unit}`));
    }
    hover(g, `<b>${p.name}</b><br>${fmt(p.value, 2)} ${unit} · ${((p.value / total) * 100).toFixed(1)}%`);
    svg.append(g);
    x += w + gapPx;
  });
  return svg;
}

/* =============================================================== AGRUPADAS */
/* Two series side by side, ONE axis. Never two: aligning two scales invents a
   correlation that is not in the data. */
function groupedBars({ groups, series, unit = 'GB' }) {
  const width = 600, height2 = 40 + groups.length * 62, plotX = 148, plotL = width - plotX - 62;
  const max = Math.max(...groups.flatMap((g) => g.values), 0.0001);
  const esc = ticks(max);
  const svg = s('svg', { viewBox: `0 0 ${width} ${height2}`, class: 'g-svg', preserveAspectRatio: 'xMidYMin meet' });

  // grid: solid hairline, one step off the surface, recessive
  for (const t of esc) {
    const x = plotX + (t / max) * plotL;
    svg.append(s('line', { x1: x, y1: 16, x2: x, y2: height2 - 22, stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x, y: height2 - 8, 'text-anchor': 'middle', class: 'g-axis' }, fmt(t, 0)));
  }
  groups.forEach((bigArc, i) => {
    const y0 = 26 + i * 62;
    svg.append(s('text', { x: plotX - 12, y: y0 + 22, 'text-anchor': 'end', class: 'g-tick' }, bigArc.name));
    bigArc.values.forEach((v, j) => {
      const y = y0 + j * 20;          // 18px of bar + a 2px gap
      const w = Math.max(2, (v / max) * plotL);
      const g = s('g', {});
      g.append(s('path', {
        d: `M${plotX},${y} h${Math.max(0, w - 4)} a4,4 0 0 1 4,4 v10 a4,4 0 0 1 -4,4 h${-Math.max(0, w - 4)} z`,
        fill: series[j].color,
      }));
      g.append(s('text', { x: plotX + w + 9, y: y + 13, class: 'g-val' }, fmt(v)));
      hover(g, `<b>${bigArc.name}</b><br>${series[j].name}: ${fmt(v, 2)} ${unit}`);
      svg.append(g);
    });
  });
  return svg;
}

/* ================================================================== DEGRAUS */
/* Cumulative: "do these in this order and free space goes from X to Y."
   This is the shape that ties the list of decisions to the number at the top. */
function steps({ base, stepList, unit = 'GB' }) {
  const width = 620, height2 = 250, mE = 52, mD = 16, mT = 18, mB = 74;
  const pl = width - mE - mD, ph = height2 - mT - mB;
  const running = [];
  let v = base;
  for (const p of stepList) { v += p.value; running.push(v); }
  const max = v, min = base - (max - base) * 0.12;
  const X = (i) => mE + (i / stepList.length) * pl;
  const Y = (val) => mT + ph - ((val - min) / (max - min || 1)) * ph;

  const svg = s('svg', { viewBox: `0 0 ${width} ${height2}`, class: 'g-svg', preserveAspectRatio: 'xMidYMin meet' });
  const tD = ticks(max - min, 4), gapD = tD.length > 1 ? tD[1] - tD[0] : 1;
  for (const t of tD.map((t) => min + t)) {
    svg.append(s('line', { x1: mE, y1: Y(t), x2: width - mD, y2: Y(t), stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: mE - 9, y: Y(t) + 4, 'text-anchor': 'end', class: 'g-axis' }, fmtScale(t, gapD)));
  }
  // area under the curve: a ~10% wash, never a block
  let d = `M${X(0)},${Y(base)}`;
  running.forEach((a, i) => { d += ` L${X(i)},${Y(running[i - 1] ?? base)} L${X(i + 1 > stepList.length ? stepList.length : i + 1)},${Y(a)}`; });
  let dArea = `M${X(0)},${Y(min)} L${X(0)},${Y(base)}`;
  running.forEach((a, i) => { dArea += ` L${X(i)},${Y(running[i - 1] ?? base)} L${X(i + 1)},${Y(a)}`; });
  dArea += ` L${X(stepList.length)},${Y(min)} Z`;
  svg.append(s('path', { d: dArea, fill: 'var(--s1)', opacity: 0.1 }));

  // the staircase itself: 2px, round joins
  let dLinha = `M${X(0)},${Y(base)}`;
  running.forEach((a, i) => { dLinha += ` L${X(i)},${Y(running[i - 1] ?? base)} L${X(i + 1)},${Y(a)}`; });
  svg.append(s('path', { d: dLinha, fill: 'none', stroke: 'var(--s1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  // dots with a 2px ring in the surface colour
  stepList.forEach((p, i) => {
    const cx = X(i + 1), cy = Y(running[i]);
    const g = s('g', {});
    g.append(s('circle', { cx, cy, r: 5, fill: 'var(--s1)', stroke: SUP, 'stroke-width': 2 }));
    g.append(s('rect', { x: cx - 14, y: cy - 14, width: 28, height: 28, fill: 'transparent' })); // hit target >= 24px
    hover(g, `<b>${p.name}</b><br>+${fmt(p.value, 2)} ${unit}<br>livre passa a <b>${fmt(running[i], 1)} ${unit}</b>`);
    svg.append(g);
  });
  // Direct label only on the end that arrives: the start is already in the
  // subtitle, and written here it collided with the axis's first tick.
  svg.append(s('text', { x: width - mD, y: Y(max) - 12, 'text-anchor': 'end', class: 'g-val highlight' }, `${fmt(max, 0)} ${unit}`));
  svg.append(s('text', { x: mE, y: height2 - 30, class: 'g-axis' }, 'first step'));
  svg.append(s('text', { x: width - mD, y: height2 - 30, 'text-anchor': 'end', class: 'g-axis' }, `after all ${stepList.length}`));
  return svg;
}

/* ================================================================ DISPERSÃO */
/* Two measures per repository. An all-pairs shape: three slots at most, which
   is why only two categories exist here. */
function scatter({ points, xLabel2, yLabel, xUnit = '', yUnit = '' }) {
  const width = 620, height2 = 340, mE = 58, mD = 24, mT = 20, mB = 56;
  const pl = width - mE - mD, ph = height2 - mT - mB;
  const xMax = Math.max(...points.map((p) => p.x), 1);
  const yMax = Math.max(...points.map((p) => p.y), 0.1);
  const X = (v) => mE + (v / xMax) * pl;
  const Y = (v) => mT + ph - (v / yMax) * ph;
  const svg = s('svg', { viewBox: `0 0 ${width} ${height2}`, class: 'g-svg', preserveAspectRatio: 'xMidYMin meet' });

  const tY = ticks(yMax), gapY = tY.length > 1 ? tY[1] - tY[0] : 1;
  for (const t of tY) {
    svg.append(s('line', { x1: mE, y1: Y(t), x2: width - mD, y2: Y(t), stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: mE - 9, y: Y(t) + 4, 'text-anchor': 'end', class: 'g-axis' }, fmtScale(t, gapY)));
  }
  for (const t of ticks(xMax)) {
    svg.append(s('text', { x: X(t), y: height2 - 30, 'text-anchor': 'middle', class: 'g-axis' }, fmt(t, 0)));
  }
  svg.append(s('text', { x: mE + pl / 2, y: height2 - 10, 'text-anchor': 'middle', class: 'g-axis strong' }, xLabel2));
  svg.append(s('text', { x: 13, y: mT + ph / 2, 'text-anchor': 'middle', class: 'g-axis strong',
    transform: `rotate(-90 13 ${mT + ph / 2})` }, yLabel));

  for (const p of points) {
    const g = s('g', {});
    const r = 6;
    g.append(s('circle', { cx: X(p.x), cy: Y(p.y), r, fill: p.color, stroke: SUP, 'stroke-width': 2 }));
    // secondary encoding: anything with commits off main gets a ring, not just a hue
    if (p.marked) {
      g.append(s('circle', { cx: X(p.x), cy: Y(p.y), r: r + 4.5, fill: 'none',
        stroke: 'var(--edge)', 'stroke-width': 1.5 }));
    }
    g.append(s('rect', { x: X(p.x) - 13, y: Y(p.y) - 13, width: 26, height: 26, fill: 'transparent' }));
    hover(g, `<b>${p.name}</b><br>${xLabel2}: ${fmt(p.x, 0)}${xUnit}<br>${yLabel}: ${fmt(p.y, 2)}${yUnit}`
      + (p.marked ? `<br><i>${p.note}</i>` : ''));
    svg.append(g);
  }
  // Direct labels on the extremes only — and on whichever side fits: on the
  // right it overflowed the card and the name came out clipped.
  const extremes = [...points].sort((a, b) => b.y - a.y).slice(0, 2);
  for (const p of extremes) {
    const fitsRight = X(p.x) + 14 + p.name.length * 6.4 < width - mD;
    svg.append(s('text', {
      x: X(p.x) + (fitsRight ? 13 : -13), y: Y(p.y) + 4,
      'text-anchor': fitsRight ? 'start' : 'end', class: 'g-val',
    }, p.name));
  }
  return svg;
}

/* ================================================================== TREEMAP */
/* Squarified. Magnitude by area; the verdict is categorical and enters as a
   slot colour, not as a ramp. */
function treemap({ items, width = 1180, height2 = 330 }) {
  const total = items.reduce((a, i) => a + i.value, 0) || 1;
  const boxes = [];
  (function split(lista, x, y, w, hh) {
    if (!lista.length) return;
    if (lista.length === 1) { boxes.push({ ...lista[0], x, y, w, h: hh }); return; }
    const soma = lista.reduce((a, i) => a + i.value, 0);
    let acc = 0, corte = 1;
    for (let i = 0; i < lista.length; i++) { acc += lista[i].value; if (acc >= soma / 2) { corte = i + 1; break; } }
    const a = lista.slice(0, corte), b = lista.slice(corte);
    const fa = a.reduce((t, i) => t + i.value, 0) / soma;
    if (w >= hh) { split(a, x, y, w * fa, hh); split(b, x + w * fa, y, w * (1 - fa), hh); }
    else { split(a, x, y, w, hh * fa); split(b, x, y + hh * fa, w, hh * (1 - fa)); }
  })([...items].sort((a, b) => b.value - a.value), 0, 0, width, height2);

  const svg = s('svg', { viewBox: `0 0 ${width} ${height2}`, class: 'g-svg', preserveAspectRatio: 'xMidYMid meet' });
  for (const c of boxes) {
    const g = s('g', {});
    // a 2px gap in the surface colour — separation by gap, not by a border
    g.append(s('rect', { x: c.x + 1, y: c.y + 1, width: Math.max(0, c.w - 2), height: Math.max(0, c.h - 2),
      rx: 3, fill: c.color, opacity: 0.92 }));
    // only label it if it fits with room to spare; never a clipped label
    // A label only goes in if it fits with room to spare, and the cut comes
    // from the box width rather than a fixed letter count. Before this, a narrow
    // box sliced the name in half and the value spilled past the edge.
    const fits = Math.floor((c.w - 20) / 7);
    if (c.w > 96 && c.h > 34 && fits >= 6) {
      g.append(s('text', { x: c.x + 9, y: c.y + 20, class: 'g-inside' },
        c.name.length > fits ? c.name.slice(0, fits - 1) + '…' : c.name));
      if (c.h > 50) g.append(s('text', { x: c.x + 9, y: c.y + 37, class: 'g-inside faint' }, `${fmt(c.value)} GB`));
    }
    hover(g, `<b>${c.name}</b><br>${fmt(c.value, 2)} GB · ${((c.value / total) * 100).toFixed(1)}% do medido<br><i>${c.label}</i>`);
    svg.append(g);
  }
  return svg;
}

/* ============================================================ ÁREA / LINHA */
/* A series over time, with a crosshair and a tooltip. Two measures on different
   scales become TWO small charts side by side — never two axes on one plot. */
function areaChart({ vals, rot, unit, color = 'var(--s1)', height = 132 }) {
  const width = 300, mE = 44, mD = 10, mT = 12, mB = 22;
  const pl = width - mE - mD, ph = height - mT - mB;
  const max = Math.max(...vals), min = Math.min(...vals);
  const alvoMax = max + (max - min || max * 0.05) * 0.25;
  const alvoMin = Math.max(0, min - (max - min || max * 0.05) * 0.45);
  const X = (i) => mE + (vals.length < 2 ? pl / 2 : (i / (vals.length - 1)) * pl);
  const Y = (v) => mT + ph - ((v - alvoMin) / (alvoMax - alvoMin || 1)) * ph;

  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'g-svg', preserveAspectRatio: 'none' });
  const stepList = ticks(alvoMax - alvoMin, 2);
  const gap = stepList.length > 1 ? stepList[1] - stepList[0] : 1;
  for (const t of stepList.map((t) => alvoMin + t)) {
    svg.append(s('line', { x1: mE, y1: Y(t), x2: width - mD, y2: Y(t), stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: mE - 7, y: Y(t) + 3.5, 'text-anchor': 'end', class: 'g-axis mini' }, fmtScale(t, gap)));
  }
  const pts = vals.map((v, i) => `${X(i)},${Y(v)}`).join(' L');
  svg.append(s('path', { d: `M${mE},${Y(alvoMin)} L${pts} L${X(vals.length - 1)},${Y(alvoMin)} Z`, fill: color, opacity: 0.1 }));
  svg.append(s('path', { d: `M${pts}`, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  svg.append(s('circle', { cx: X(vals.length - 1), cy: Y(vals[vals.length - 1]), r: 4, fill: color, stroke: SUP, 'stroke-width': 2 }));

  // crosshair: a vertical line that follows the pointer and reads the nearest point
  const crosshair = s('line', { y1: mT, y2: mT + ph, stroke: 'var(--ink3)', 'stroke-width': 1, opacity: 0 });
  svg.append(crosshair);
  const capture = s('rect', { x: mE, y: mT, width: pl, height: ph, fill: 'transparent' });
  capture.addEventListener('mousemove', (ev) => {
    const cx = svg.getBoundingClientRect();
    const rel = ((ev.clientX - cx.left) / cx.width) * width;
    const i = Math.max(0, Math.min(vals.length - 1, Math.round(((rel - mE) / pl) * (vals.length - 1))));
    crosshair.setAttribute('x1', X(i)); crosshair.setAttribute('x2', X(i)); crosshair.setAttribute('opacity', 0.55);
    showTip(capture, `<b>${rot}</b><br>${fmt(vals[i], 1)} ${unit}<br><i>reading ${i + 1} of ${vals.length}</i>`, ev);
  });
  capture.addEventListener('mouseleave', () => { crosshair.setAttribute('opacity', 0); hideTip(); });
  svg.append(capture);
  return svg;
}

/* =================================================================== ANEL */
/* Part-to-whole at a glance, <= 6 slices. Not for comparing close values —
   when that is the job, use a bar. */
function donut({ parts, center, sub, size = 168 }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const r = size / 2 - 12, ri = r * 0.63, cx = size / 2, cy = size / 2;
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: 'g-svg donut' });
  let angle = -Math.PI / 2;
  const vaoAng = 0.022;                         // the 2px gap, expressed in radians
  for (const p of parts) {
    const slice = (p.value / total) * Math.PI * 2;
    const a0 = angle + vaoAng / 2, a1 = angle + slice - vaoAng / 2;
    if (a1 > a0) {
      const bigArc = a1 - a0 > Math.PI ? 1 : 0;
      const d = `M${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)}`
        + ` A${r},${r} 0 ${bigArc} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)}`
        + ` L${cx + ri * Math.cos(a1)},${cy + ri * Math.sin(a1)}`
        + ` A${ri},${ri} 0 ${bigArc} 0 ${cx + ri * Math.cos(a0)},${cy + ri * Math.sin(a0)} Z`;
      const g = s('g', {}, s('path', { d, fill: p.color }));
      hover(g, `<b>${p.name}</b><br>${fmt(p.value, 2)} GB · ${((p.value / total) * 100).toFixed(1)}%`);
      svg.append(g);
    }
    angle += slice;
  }
  svg.append(s('text', { x: cx, y: cy + 2, 'text-anchor': 'middle', class: 'g-center' }, center));
  if (sub) svg.append(s('text', { x: cx, y: cy + 19, 'text-anchor': 'middle', class: 'g-axis' }, sub));
  return svg;
}


/* ==================================================================== PIZZA */
/* Part-to-whole at a glance. Worth it when the slices differ clearly in size
   and there are few of them (<= 6). To compare close values, use a bar.
   The pair that CLOSES the circle (last slice touching the first) lands in the
   validator's warn band under deuteranopia — so the direct label here is not
   decoration, it is the secondary encoding that makes the palette legal. */
function pie({ parts, size = 330, unit = 'GB', minLabel = 0.045 }) {
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const cx = size / 2, cy = size / 2 - 4, r = size * 0.29;
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: 'g-svg pie' });
  let angle = -Math.PI / 2;
  const gapPx = 0.016;

  for (const p of parts) {
    const slice = (p.value / total) * Math.PI * 2;
    const a0 = angle + gapPx / 2, a1 = angle + slice - gapPx / 2;
    if (a1 > a0) {
      const bigArc = a1 - a0 > Math.PI ? 1 : 0;
      const d = `M${cx},${cy} L${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)}`
        + ` A${r},${r} 0 ${bigArc} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)} Z`;
      const g = s('g', {}, s('path', { d, fill: p.color }));

      // Label outside the slice, with a leader line. It only goes in if the
      // slice can carry it: squeezed inside a thin slice it comes out clipped.
      const frac = p.value / total;
      if (frac >= minLabel) {
        const am = (a0 + a1) / 2;
        const x1 = cx + (r + 3) * Math.cos(am), y1 = cy + (r + 3) * Math.sin(am);
        const x2 = cx + (r + 17) * Math.cos(am), y2 = cy + (r + 17) * Math.sin(am);
        const dirn = Math.cos(am) >= 0 ? 1 : -1;
        const x3 = x2 + 9 * dirn;
        g.append(s('polyline', { points: `${x1},${y1} ${x2},${y2} ${x3},${y2}`,
          fill: 'none', stroke: 'var(--line2)', 'stroke-width': 1 }));
        g.append(s('text', { x: x3 + 4 * dirn, y: y2 - 1,
          'text-anchor': dirn > 0 ? 'start' : 'end', class: 'g-val' },
          `${fmt(p.value)} ${unit}`));
        g.append(s('text', { x: x3 + 4 * dirn, y: y2 + 12,
          'text-anchor': dirn > 0 ? 'start' : 'end', class: 'g-axis' },
          `${(frac * 100).toFixed(0)}%`));
      }
      hover(g, `<b>${p.name}</b><br>${fmt(p.value, 2)} ${unit} · ${(frac * 100).toFixed(1)}%`
        + (p.note ? `<br><i>${p.note}</i>` : ''));
      svg.append(g);
    }
    angle += slice;
  }
  return svg;
}

/* ================================================================== COLUNAS */
/* Columns when the category has a natural order (time, ranking) or when the
   name is short. A long name wants a horizontal bar — under a column it becomes
   an unreadable diagonal, or it gets clipped. */
function columns({ data, unit = '', height = 250, color = 'var(--s1)', labelAll = false }) {
  // A count takes no decimals: "1.0 domains" is an invented number.
  const allIntegers = data.every((d) => Number.isInteger(d.value));
  const width = 620, mE = 50, mD = 14, mT = 26, mB = 58;
  const pl = width - mE - mD, ph = height - mT - mB;
  const max = Math.max(...data.map((d) => d.value), 0.0001);
  const band = pl / data.length;
  const w = Math.min(24, band * 0.56);      // <= 24px: the leftover band is air
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'g-svg', preserveAspectRatio: 'xMidYMin meet' });

  const tk = ticks(max), gap = tk.length > 1 ? tk[1] - tk[0] : 1;
  for (const t of tk) {
    const y = mT + ph - (t / max) * ph;
    svg.append(s('line', { x1: mE, y1: y, x2: width - mD, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: mE - 9, y: y + 4, 'text-anchor': 'end', class: 'g-axis' }, fmtScale(t, gap)));
  }
  data.forEach((d, i) => {
    const x = mE + band * i + (band - w) / 2;
    const hh = Math.max(2, (d.value / max) * ph);
    const y = mT + ph - hh;
    const g = s('g', {});
    // 4px rounded cap, square at the baseline
    g.append(s('path', {
      d: `M${x},${mT + ph} v${-(hh - 4)} a4,4 0 0 1 4,-4 h${w - 8} a4,4 0 0 1 4,4 v${hh - 4} z`,
      fill: d.color || color,
    }));
    if (labelAll || i < 2) {
      g.append(s('text', { x: x + w / 2, y: y - 7, 'text-anchor': 'middle', class: 'g-val' }, allIntegers ? String(d.value) : fmt(d.value, d.value >= 10 ? 0 : 1)));
    }
    // name under the column, on a second row when it does not fit on one
    const fits = Math.floor(band / 6.2);
    const name = d.name.length > fits ? d.name.slice(0, fits - 1) + '…' : d.name;
    g.append(s('text', { x: x + w / 2, y: height - 34, 'text-anchor': 'middle', class: 'g-axis' }, name));
    if (d.sub) g.append(s('text', { x: x + w / 2, y: height - 20, 'text-anchor': 'middle', class: 'g-axis mini' }, d.sub));
    g.append(s('rect', { x: mE + band * i, y: mT, width: band, height: ph, fill: 'transparent' }));
    hover(g, `<b>${d.name}</b><br>${allIntegers ? d.value : fmt(d.value, 2)} ${unit}${d.note ? '<br><i>' + d.note + '</i>' : ''}`);
    svg.append(g);
  });
  return svg;
}

/* ====================================================== COLUNAS EMPILHADAS */
function stackedColumns({ groups, series, height = 250, unit = 'GB' }) {
  const width = 620, mE = 50, mD = 14, mT = 20, mB = 50;
  const pl = width - mE - mD, ph = height - mT - mB;
  const totals = groups.map((g) => g.values.reduce((a, v) => a + v, 0));
  const max = Math.max(...totals, 0.0001);
  const band = pl / groups.length, w = Math.min(28, band * 0.5);
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'g-svg', preserveAspectRatio: 'xMidYMin meet' });

  const tk = ticks(max), gap = tk.length > 1 ? tk[1] - tk[0] : 1;
  for (const t of tk) {
    const y = mT + ph - (t / max) * ph;
    svg.append(s('line', { x1: mE, y1: y, x2: width - mD, y2: y, stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: mE - 9, y: y + 4, 'text-anchor': 'end', class: 'g-axis' }, fmtScale(t, gap)));
  }
  groups.forEach((bigArc, i) => {
    const x = mE + band * i + (band - w) / 2;
    let stacked = 0;
    bigArc.values.forEach((v, j) => {
      const hh = (v / max) * ph;
      if (hh <= 0.5) { stacked += v; return; }
      const y = mT + ph - ((stacked + v) / max) * ph;
      const g = s('g', {});
      // a 2px gap in the surface colour between touching segments
      g.append(s('rect', { x, y, width: w, height: Math.max(1, hh - 2), rx: 2, fill: series[j].color }));
      hover(g, `<b>${bigArc.name}</b><br>${series[j].name}: ${fmt(v, 2)} ${unit}`);
      svg.append(g);
      stacked += v;
    });
    svg.append(s('text', { x: x + w / 2, y: mT + ph - (totals[i] / max) * ph - 8, 'text-anchor': 'middle', class: 'g-val' }, fmt(totals[i], 1)));
    svg.append(s('text', { x: x + w / 2, y: height - 30, 'text-anchor': 'middle', class: 'g-axis' }, bigArc.name));
  });
  return svg;
}

/* ========================================================= LINHA INDEXADA */
/* Two measures on different scales in one chart, WITHOUT two axes: both become
   index 100 at the first point. It is the only honest way to overlay swap (MB)
   and compressed memory (GB) — two axes would invent a correlation that is not
   in the data. */
function indexedLine({ series, height = 210, xLabel = '' }) {
  const width = 620, mE = 52, mD = 46, mT = 18, mB = 42;
  const pl = width - mE - mD, ph = height - mT - mB;
  const idx = series.map((se) => se.vals.map((v) => (se.vals[0] ? (v / se.vals[0]) * 100 : 100)));
  const allVals = idx.flat();
  let max = Math.max(...allVals, 101), min = Math.min(...allVals, 99);
  const folga = (max - min) * 0.2 || 2;
  max += folga; min -= folga;
  const n = Math.max(...series.map((se) => se.vals.length));
  const X = (i) => mE + (n < 2 ? pl / 2 : (i / (n - 1)) * pl);
  const Y = (v) => mT + ph - ((v - min) / (max - min || 1)) * ph;
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, class: 'g-svg', preserveAspectRatio: 'xMidYMin meet' });

  const tk = ticks(max - min, 4), gap = tk.length > 1 ? tk[1] - tk[0] : 1;
  for (const t of tk.map((t) => min + t)) {
    svg.append(s('line', { x1: mE, y1: Y(t), x2: width - mD, y2: Y(t), stroke: 'var(--line)', 'stroke-width': 1 }));
    svg.append(s('text', { x: mE - 9, y: Y(t) + 4, 'text-anchor': 'end', class: 'g-axis' }, fmtScale(t, gap)));
  }
  // the 100 line is the reference: where everything started
  if (100 >= min && 100 <= max) {
    svg.append(s('line', { x1: mE, y1: Y(100), x2: width - mD, y2: Y(100), stroke: 'var(--line2)', 'stroke-width': 1 }));
    svg.append(s('text', { x: width - mD + 5, y: Y(100) + 4, class: 'g-axis' }, 'base'));
  }
  series.forEach((se, k) => {
    const pts = idx[k].map((v, i) => `${X(i)},${Y(v)}`).join(' L');
    svg.append(s('path', { d: `M${pts}`, fill: 'none', stroke: se.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    const last = idx[k].length - 1;
    svg.append(s('circle', { cx: X(last), cy: Y(idx[k][last]), r: 4, fill: se.color, stroke: SUP, 'stroke-width': 2 }));
    // direct label at the end: with 2 series nobody should hunt through a legend
    svg.append(s('text', { x: X(last) + 9, y: Y(idx[k][last]) + 4, class: 'g-val' }, fmt(idx[k][last], 0)));
  });
  if (xLabel) svg.append(s('text', { x: mE + pl / 2, y: height - 8, 'text-anchor': 'middle', class: 'g-axis strong' }, xLabel));
  return svg;
}

/* ==================================================================== ARCO */
/* A radial meter. One number: a stat tile with a shape around it rather than a
   chart — which is why it carries no axis and no grid. */
function gauge({ pct, center, sub, size = 190 }) {
  const cx = size / 2, cy = size * 0.55, r = size * 0.36, thick = 13;
  // The viewBox has to fit the label BELOW the gauge's tips. Centred, it crossed
  // the stroke itself on both sides.
  const svg = s('svg', { viewBox: `0 0 ${size} ${size * 0.88}`, class: 'g-svg gauge' });
  const A0 = Math.PI * 0.86, A1 = Math.PI * 2.14;    // gauge aberto embaixo
  const arcoD = (a0, a1) => {
    const bigArc = a1 - a0 > Math.PI ? 1 : 0;
    return `M${cx + r * Math.cos(a0)},${cy + r * Math.sin(a0)} A${r},${r} 0 ${bigArc} 1 ${cx + r * Math.cos(a1)},${cy + r * Math.sin(a1)}`;
  };
  svg.append(s('path', { d: arcoD(A0, A1), fill: 'none', stroke: 'var(--bg3)', 'stroke-width': thick, 'stroke-linecap': 'round' }));
  const f = Math.max(0, Math.min(100, pct)) / 100;
  if (f > 0.004) {
    svg.append(s('path', { d: arcoD(A0, A0 + (A1 - A0) * f), fill: 'none', stroke: 'var(--s1)', 'stroke-width': thick, 'stroke-linecap': 'round' }));
  }
  svg.append(s('text', { x: cx, y: cy + 6, 'text-anchor': 'middle', class: 'g-center' }, center));
  // below the gauge tips (which land at cy + 0.42*r), not on top of them
  if (sub) svg.append(s('text', { x: cx, y: cy + r * 0.42 + 26, 'text-anchor': 'middle', class: 'g-axis' }, sub));
  hover(svg, `<b>${sub || 'uso'}</b><br>${pct}%`);
  return svg;
}

/* ================================================================ MEDIDOR */
function meter({ pct, rot, note }) {
  const width = 300, height2 = 12;
  const svg = s('svg', { viewBox: `0 0 ${width} ${height2}`, class: 'g-svg', preserveAspectRatio: 'none' });
  svg.append(s('rect', { x: 0, y: 0, width: width, height: height2, rx: 2, fill: 'var(--bg3)' }));
  const w = Math.max(3, (Math.min(100, pct) / 100) * width);
  svg.append(s('rect', { x: 0, y: 0, width: w, height: height2, rx: 2, fill: 'var(--s1)' }));
  hover(svg, `<b>${rot}</b><br>${pct}%${note ? '<br><i>' + note + '</i>' : ''}`);
  return svg;
}

window.G = { card, legendOf, tableOf, bars, stackedBar, groupedBars, steps,
  scatter, treemap, areaChart, donut, meter, pie, columns, stackedColumns,
  indexedLine, gauge, h, SERIES, RAMP, fmt, hover };

})();
