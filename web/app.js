'use strict';
/* ---------------------------------------------------------------------------
   Vanilla. No framework, no build step, no dependencies — a panel that measures
   RAM cannot load 300 kB of runtime to do it.
--------------------------------------------------------------------------- */

const { card, legendOf, tableOf, bars, stackedBar, groupedBars, steps,
  scatter, treemap, areaChart, donut, meter, pie, columns, stackedColumns,
  indexedLine, gauge, h: el } = window.G;

const $ = (s, r = document) => r.querySelector(s);
const gb = (n) => (n == null ? '—' : n >= 10 ? n.toFixed(1) : n.toFixed(2));
const kb2gb = (kb) => (kb || 0) / 1048576;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const short = (p) => String(p).replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
const get = async (u) => { const r = await fetch(u); if (!r.ok && r.status !== 409) throw new Error(u + ' ' + r.status); return r.json(); };

const state = { cache: null, light: null, dns: null, blocklist: null, tab: 'overview' };
const TABS = ['overview', 'memory', 'disk', 'checks', 'dns'];

const grid = (...f) => el('div', { class: 'grid' }, ...f.filter(Boolean));
const at = (cls, node) => { node.classList.add(cls); return node; };
const tile = (label, value, unit, foot) => el('div', { class: 'g-card' },
  el('div', { class: 'tile' },
    el('div', { class: 'lab' }, label),
    el('div', { class: 'val' }, value, unit ? el('small', {}, unit) : null),
    foot ? el('div', { class: 'foot', html: foot }) : null));

/* ------------------------------------------------------------------ command */
function commandBlock(text, note) {
  if (!text) return null;
  const html = esc(text).split('\n')
    .map((l) => (l.trimStart().startsWith('#') ? `<span class="c">${l}</span>` : l)).join('\n');
  const pre = el('pre', { html });
  const btn = el('button', { class: 'copy', onclick: async () => {
    try { await navigator.clipboard.writeText(text); btn.textContent = 'copied'; setTimeout(() => (btn.textContent = 'copy'), 1400); }
    catch { btn.textContent = 'select and copy'; }
  } }, 'copy');
  return el('div', { class: 'command' }, pre,
    el('div', { class: 'command-bar' }, btn, el('span', { class: 'note' }, note || 'this panel runs nothing. you run it.')));
}

/* ============================================================== OVERVIEW */
function overview(c) {
  const root = $('#tab-overview');
  root.textContent = '';

  if (!c || !c.hasCache) {
    root.append(
      el('div', { class: 'verdict' },
        el('p', { class: 'headline' }, 'I have not looked at this machine yet.'),
        el('p', { class: 'summary' }, 'The first scan reads the disk folder by folder, opens the Docker VM and runs git in every repository. It takes about two minutes and only happens when you ask.')),
      el('button', { class: 'action', onclick: runScan }, 'Scan this machine'));
    return;
  }

  const p = c.panel;
  const out = p.out.filter((d) => d.kb > 0);
  const top = out.slice(0, 3);

  // The verdict: what to do first. The number is the proof, not the content.
  const summary = el('p', { class: 'summary' });
  summary.append(...top.flatMap((d, i) => [
    i ? ' · ' : '',
    el('b', {}, `${gb(d.gb)} GB`),
    ` ${d.title}`,
  ]), out.length > 3 ? ` · and ${out.length - 3} smaller items.` : '.');

  const staying = p.stay.filter((f) => f.kb > 0).slice(0, 2);
  const stayLine = el('p', { class: 'summary', style: 'margin-top:8px' },
    el('b', {}, 'Staying put: '),
    staying.map((f) => `${f.title} (${gb(f.gb)} GB)`).join(' and '),
    staying.length ? ` — plus ${p.stay.length - staying.length} more, each with its reason written below.` : '');

  const age = Math.round((Date.now() - c.at) / 60000);
  root.append(el('div', { class: 'verdict' },
    el('p', { class: 'headline' }, 'You can free ', el('em', {}, `${gb(p.totalGB)} GB`), '.'),
    summary, stayLine,
    el('div', { class: 'stamp' },
      el('span', {}, age < 1 ? 'measured just now' : `measured ${age} min ago`),
      el('span', {}, `the scan took ${Math.round(c.ms / 1000)}s`),
      p.uncertainKB > 0 ? el('span', {}, `${gb(kb2gb(p.uncertainKB))} GB depend on a condition`) : null,
      el('button', { class: 'copy', onclick: runScan }, 'scan again'))));

  root.append(grid(at('c8', chartSteps(c)), at('c4', chartDiskDonut(c))));
  root.append(grid(at('c4', chartKinds(c)), at('c8', chartColumns(c))));
  root.append(grid(at('c12', chartDocker(c))));

  root.append(el('div', { class: 'section' },
    el('h2', {}, 'What can go'),
    el('p', {}, 'Ordered by how much it frees. Every item carries the proof of its number and what you lose if the verdict is wrong.')));
  for (const d of p.out) root.append(decisionCard(d));

  // THE BOUNDARY. The rules change here, and the screen says so.
  root.append(el('div', { class: 'boundary' }, 'below this line, nothing goes'));
  root.append(el('div', { class: 'section', style: 'margin-top:0' },
    el('p', {}, 'Large things a generic tool would call garbage. Each one has a reason to stay, and the reason is checkable.')));
  for (const f of p.stay.filter((x) => x.kb > 0 || x.critical)) root.append(stayCard(f));
  const zero = p.stay.filter((x) => !(x.kb > 0 || x.critical));
  if (zero.length) {
    root.append(el('details', { style: 'margin-top:10px' },
      el('summary', { style: 'color:var(--ink3);font-size:13px;cursor:pointer' },
        `${zero.length} more that stay without taking meaningful space`),
      el('div', { style: 'margin-top:11px' }, ...zero.map(stayCard))));
  }
}

/* The chart that ties the list of decisions to the number at the top: applying
   them in the recommended order, free space goes from here to there. */
function chartSteps(c) {
  const free = kb2gb(c.volume.freeKB);
  const list = c.panel.out.filter((d) => d.kb > 0).map((d) => ({ name: d.title, value: d.gb }));
  return card({
    title: 'If you work through them in order',
    sub: `Free space goes from ${gb(free)} GB to ${gb(free + c.panel.totalGB)} GB. Every step is an item from the list below.`,
    shape: steps({ base: free, stepList: list }),
    table: tableOf(['Step', 'Frees (GB)', 'Free afterwards (GB)'],
      list.map((s, i) => [`${i + 1}. ${s.name}`, gb(s.value),
        gb(free + list.slice(0, i + 1).reduce((a, x) => a + x.value, 0))])),
  });
}

function chartDiskDonut(c) {
  const used = kb2gb(c.volume.usedKB), free = kb2gb(c.volume.freeKB);
  const total = kb2gb(c.volume.totalKB);
  const lib = c.panel.totalGB;
  // used + free does not add up to total: the rest is APFS reserve (snapshots
  // and metadata). Naming that slice is more honest than summing wrong.
  const reserve = Math.max(0, total - used - free);
  // Emphasis: the slice that matters is the only one with colour; the others
  // recede in steps of the same neutral.
  const parts = [
    { name: 'Occupied, staying', value: Math.max(0, used - lib), color: 'var(--n2)' },
    reserve > 1 ? { name: 'Reserved by APFS', value: reserve, color: 'var(--n3)' } : null,
    { name: 'Can be freed', value: lib, color: 'var(--s1)' },
    { name: 'Already free', value: free, color: 'var(--n1)' },
  ].filter(Boolean);
  return card({
    title: 'The whole disk',
    sub: `${gb(total)} GB on the data volume.`,
    legend: legendOf(parts.map((p) => ({ name: `${p.name} · ${gb(p.value)} GB`, color: p.color }))),
    shape: donut({ parts, center: gb(lib) + ' GB', sub: 'can be freed' }),
    table: tableOf(['Slice', 'GB', '%'], parts.map((p) => [p.name, gb(p.value), ((p.value / total) * 100).toFixed(1) + '%'])),
  });
}

/* Pie: what KIND the leftovers are. It answers a question the ranked list
   cannot — if half of it is package cache, the problem is a habit, not a mess. */
function chartKinds(c) {
  const out = c.panel.out.filter((d) => d.kb > 0);
  const by = new Map();
  for (const d of out) {
    const t = by.get(d.kindLabel) || { name: d.kindLabel, value: 0, items: 0 };
    t.value += d.gb; t.items++; by.set(d.kindLabel, t);
  }
  const parts = [...by.values()].sort((a, b) => b.value - a.value)
    .map((t, i) => ({ ...t, value: +t.value.toFixed(2), color: `var(--s${i + 1})`,
      note: `${t.items} ${t.items === 1 ? 'item' : 'items'}` }));
  const biggest = parts[0];
  return card({
    title: 'What kind of leftovers these are',
    sub: `${gb(biggest.value)} GB — ${((biggest.value / c.panel.totalGB) * 100).toFixed(0)}% of the total — is ${biggest.name.toLowerCase()}: it comes back on its own unless the habit changes.`,
    legend: legendOf(parts.map((p) => ({ name: p.name, color: p.color }))),
    shape: pie({ parts }),
    table: tableOf(['Kind', 'GB', 'Items'], parts.map((p) => [p.name, gb(p.value), p.items])),
  });
}

/* Columns: the biggest ones upright, to judge the difference by height alone. */
function chartColumns(c) {
  const out = c.panel.out.filter((d) => d.kb > 0).slice(0, 8);
  const shorten = (t) => t
    .replace(/^Log of container /, 'log ')
    .replace(/^node_modules of /, '')
    .replace(/ cache$/, '').replace(/^Packages downloaded by /, '')
    .replace(/^HuggingFace download cache \(xet\)$/, 'HF xet')
    .replace(/^Claude Desktop local VM$/, 'Claude VM')
    .replace(/^Slack trapped in the Docker virtual disk$/, 'Docker slack');
  return card({
    title: 'The eight biggest, side by side',
    sub: 'Hover to read the full name and what you lose if the verdict is wrong.',
    shape: columns({
      data: out.map((d) => {
        const n = shorten(d.title);
        return {
          name: n.length > 13 ? n.slice(0, 12) + '…' : n,
          sub: d.kindLabel.split(' ')[0].toLowerCase(),
          value: d.gb,
          note: d.confidence !== 'high' ? 'has a condition: ' + (d.warning || '') : d.lose.slice(0, 90),
        };
      }), unit: 'GB', height: 270,
    }),
    table: tableOf(['Item', 'GB', 'Kind', 'Confidence'], out.map((d) => [d.title, gb(d.gb), d.kindLabel, d.confidence])),
  });
}

/* The blind spot, measured: docker measures Docker objects; the disk measures the disk. */
function chartDocker(c) {
  const d = c.docker;
  if (!d || !d.running || !d.folders) {
    return card({ title: 'Docker', sub: 'Not responding right now.', shape: el('p', { class: 'empty' }, '—') });
  }
  const folder = (n) => (d.folders.find((p) => p.path.endsWith('/' + n)) || { kb: 0 }).kb;
  const counted = (t) => (d.counted.find((x) => new RegExp(t, 'i').test(x.type)) || { kb: 0 }).kb;
  const groups = [
    { name: 'Image layers', values: [kb2gb(counted('image')), kb2gb(folder('overlay2'))] },
    { name: 'Containers', values: [kb2gb(counted('container')), kb2gb(folder('containers'))] },
    { name: 'Volumes', values: [kb2gb(counted('volume')), kb2gb(folder('volumes'))] },
    { name: 'Build cache', values: [kb2gb(counted('build')), kb2gb(folder('buildkit'))] },
  ];
  const series = [{ name: '`docker system df` reports', color: 'var(--s3)' }, { name: 'actually on disk in the VM', color: 'var(--s2)' }];
  const blind = groups[1].values[1] - groups[1].values[0];
  return card({
    title: 'What Docker counts, and what Docker occupies',
    sub: `Under "Containers" the gap is ${gb(blind)} GB: the command measures the writable layer and never the log file.`,
    legend: legendOf(series),
    shape: groupedBars({ groups, series }),
    table: tableOf(['Category', 'df reports (GB)', 'on disk (GB)', 'gap'],
      groups.map((g) => [g.name, gb(g.values[0]), gb(g.values[1]), gb(g.values[1] - g.values[0])])),
  });
}

function decisionCard(d) {
  const c = el('div', { class: 'card' });
  c.append(el('div', { class: 'row' },
    el('div', { class: 'weight' }, d.kb > 0 ? gb(d.gb) : '—', d.kb > 0 ? el('small', {}, 'GB') : null),
    el('div', {}, el('p', { class: 'title' }, d.title,
      d.confidence !== 'high' ? el('span', { class: 'tag' }, 'has a condition') : null))));
  c.append(el('div', { class: 'proof' }, d.proof, el('span', { class: 'src' }, 'measured by: ' + d.source)));
  c.append(el('div', { class: 'lose' }, el('b', {}, 'If I am wrong, you lose: '), d.lose));
  if (d.warning) c.append(el('div', { class: 'alert' }, d.warning));
  const cmd = commandBlock(d.command);
  if (cmd) c.append(cmd);
  return c;
}

function stayCard(f) {
  return el('div', { class: 'card stays' },
    el('div', { class: 'row' },
      el('div', { class: 'weight' }, f.kb > 0 ? gb(f.gb) : '—', f.kb > 0 ? el('small', {}, 'GB') : null),
      el('div', {}, el('p', { class: 'title' }, f.title,
        el('span', { class: 'tag' }, f.verdict === 'unknown' ? 'cannot judge' : f.verdict === 'yours' ? 'yours' : 'in use'),
        f.critical ? el('span', { class: 'tag' }, 'only copy') : null))),
    el('div', { class: 'why' }, f.why));
}

/* ------------------------------------------------------------------ scan */
async function runScan() {
  const root = $(`#tab-${state.tab}`);
  const before = root.innerHTML;
  root.textContent = '';
  root.append(el('div', { class: 'verdict' },
    el('p', { class: 'headline' }, 'Looking.'),
    el('p', { class: 'summary loading' }, 'reading the disk folder by folder, opening the Docker VM, running git in every repository'),
    el('div', { class: 'stamp' }, el('span', {}, 'this takes about two minutes and runs once'))));
  try {
    const d = await get('/api/deep');
    if (d.alreadyRunning) { root.innerHTML = before; return; }
    state.cache = { hasCache: true, ...d };
    render();
  } catch (e) {
    root.textContent = '';
    root.append(el('p', { class: 'empty' }, 'the scan failed: ' + e.message));
  }
}

/* =============================================================== MEMORY */
function memory(d) {
  const root = $('#tab-memory');
  root.textContent = '';
  if (!d) { root.append(el('p', { class: 'loading' }, 'measuring')); return; }

  const m = d.memory, total = m.totalBytes / 1073741824;
  const base = new Map((d.opened?.groups || []).map((g) => [g.name, g.rssKB]));
  // The first group is usually macOS itself, and you cannot quit the system.
  // The headline names the biggest thing you can actually act on.
  const yours = m.groups.find((g) => g.name !== 'macOS (system)') || m.groups[0];
  const system = m.groups.find((g) => g.name === 'macOS (system)');

  root.append(el('div', { class: 'verdict' },
    el('p', { class: 'headline' }, yours.name, ' is using ', el('em', {}, gb(kb2gb(yours.rssKB)) + ' GB'), '.'),
    el('p', { class: 'summary' },
      `That is ${yours.n} processes under one name — quitting the app quits all of them. `,
      system ? `macOS takes another ${gb(kb2gb(system.rssKB))} GB across ${system.n} processes, and those are not yours to quit. ` : '',
      m.note)));

  const g = m.vm;
  // Categorical slots validated in this ring order (worst adjacent pair ΔE 8.0
  // under deuteranopia, 16.4 for normal vision). 'Free' is neutral — it is not
  // a state, it is an absence — and still needs a visible swatch in the legend.
  const parts = [
    { name: 'Wired (the system will not release it)', value: g.wired / 1073741824, color: 'var(--s3)' },
    { name: 'Active', value: g.active / 1073741824, color: 'var(--s1)' },
    { name: 'Compressed', value: g.compressed / 1073741824, color: 'var(--s2)' },
    { name: 'Inactive', value: g.inactive / 1073741824, color: 'var(--s7)' },
    { name: 'Free', value: g.free / 1073741824, color: 'var(--line2)' },
  ];
  const hist = d.history || [];
  const swapPct = m.swap ? Math.round((m.swap.usedMB / m.swap.totalMB) * 100) : 0;

  root.append(grid(
    at('c8', chartGroups(m, base)),
    at('c4', card({
      title: `How the ${total.toFixed(0)} GB sit right now`,
      sub: 'Compressing is macOS squeezing what does not fit — the symptom that arrives before swap.',
      legend: legendOf(parts.map((p) => ({ name: p.name, color: p.color }))),
      shape: donut({ parts, center: gb(g.compressed / 1073741824) + ' GB', sub: 'compressed' }),
      table: tableOf(['State', 'GB', '%'], parts.map((p) => [p.name, gb(p.value), ((p.value / total) * 100).toFixed(1) + '%'])),
    })),
  ));

  // How many PROCESSES each app opens — a different measure from how much RAM
  // it eats. A browser with 50 processes tells the same story another way.
  root.append(grid(
    at('c6', card({
      title: 'How many processes each app opens',
      sub: 'A modern browser opens one process per tab. Each one carries a fixed cost before it holds any content at all.',
      shape: columns({
        data: m.groups.filter((x) => x.n > 1).slice(0, 8).map((x) => ({
          name: x.name.length > 12 ? x.name.slice(0, 11) + '…' : x.name,
          sub: gb(kb2gb(x.rssKB)) + ' GB', value: x.n,
          note: `${gb(kb2gb(x.rssKB))} GB in total — about ${(kb2gb(x.rssKB) / x.n * 1024).toFixed(0)} MB per process`,
        })), unit: 'processes', height: 240,
      }),
      table: tableOf(['Group', 'Processes', 'GB'], m.groups.map((x) => [x.name, x.n, gb(kb2gb(x.rssKB))])),
    })),
    at('c6', hist.length > 1 ? card({
      title: 'Swap and compression since you opened this',
      sub: 'Two measures on different scales in one chart, both turned into index 100 at the first point. Two axes would invent a correlation that is not in the data.',
      legend: legendOf([{ name: 'swap', color: 'var(--s1)' }, { name: 'compressed memory', color: 'var(--s2)' }]),
      shape: indexedLine({
        series: [
          { name: 'swap', vals: hist.map((x) => x.swap?.usedMB || 0), color: 'var(--s1)' },
          { name: 'compressed', vals: hist.map((x) => x.vm.compressed / 1073741824), color: 'var(--s2)' },
        ], xLabel: `${hist.length} readings this session — one for every time you looked`,
      }),
      table: tableOf(['Reading', 'Swap (MB)', 'Compressed (GB)'],
        hist.map((x, i) => [i + 1, gb(x.swap?.usedMB || 0), gb(x.vm.compressed / 1073741824)])),
    }) : card({ title: 'Swap and compression', sub: 'Come back to this tab to produce a second point — the panel only measures when you look.',
      shape: el('p', { class: 'empty' }, 'one reading so far') })),
  ));

  if (hist.length > 1) {
    root.append(grid(
      at('c4', card({ title: 'Swap in use', sub: 'Disk pretending to be memory.',
        shape: areaChart({ vals: hist.map((x) => x.swap?.usedMB || 0), rot: 'Swap', unit: 'MB' }),
        table: tableOf(['Reading', 'MB'], hist.map((x, i) => [i + 1, gb(x.swap?.usedMB || 0)])) })),
      at('c4', card({ title: 'Compressed memory', sub: 'Rises before swap does.',
        shape: areaChart({ vals: hist.map((x) => x.vm.compressed / 1073741824), rot: 'Compressed', unit: 'GB', color: 'var(--s2)' }),
        table: tableOf(['Reading', 'GB'], hist.map((x, i) => [i + 1, gb(x.vm.compressed / 1073741824)])) })),
      at('c4', card({ title: 'Swap used', sub: m.swap ? `${gb(m.swap.usedMB / 1024)} GB of ${gb(m.swap.totalMB / 1024)} GB` : '—',
        shape: gauge({ pct: swapPct, center: swapPct + '%', sub: 'of swap in use' }) })),
    ));
  }

  root.append(el('div', { class: 'section' }, el('h2', {}, 'Since this machine booted')));
  root.append(grid(
    at('c4', tile('Trips to the disk', (g.swapins + g.swapouts).toLocaleString('en-US'), null,
      'Each one is the machine stopping to fetch memory from the SSD.')),
    at('c4', tile('Compressions', g.compressions.toLocaleString('en-US'), null,
      'macOS squeezed memory this many times to avoid touching the disk.')),
    at('c4', tile('Total RAM', total.toFixed(0), 'GB',
      'Soldered. On Apple Silicon it cannot be increased — only fitted into better.')),
  ));
}

function chartGroups(m, base) {
  const data = m.groups.slice(0, 12).map((x) => {
    const before = base.get(x.name);
    const delta = before != null ? (x.rssKB - before) / 1024 : null;
    return {
      name: `${x.name}  (${x.n}x)`, value: kb2gb(x.rssKB),
      note: delta != null && Math.abs(delta) > 20
        ? `${delta > 0 ? 'grew' : 'shrank'} ${Math.abs(delta).toFixed(0)} MB since you opened this` : null,
    };
  });
  return card({
    title: 'What is using RAM right now',
    sub: 'Grouped by what the processes actually are: fourteen processes named "node" are one thing to the person looking.',
    shape: bars({ data, directLabels: 3 }),
    table: tableOf(['Group', 'GB', 'Processes'], m.groups.map((x) => [x.name, gb(kb2gb(x.rssKB)), x.n])),
  });
}

/* ================================================================== DISK */
function disk(c) {
  const root = $('#tab-disk');
  root.textContent = '';
  if (!c || !c.hasCache) { root.append(el('p', { class: 'empty' }, 'Run the scan on the Overview tab first.')); return; }

  root.append(el('div', { class: 'verdict' },
    el('p', { class: 'headline' }, 'Where the space went.'),
    el('p', { class: 'summary' }, 'Every folder with a verdict. ',
      el('b', {}, '"cannot judge"'), ' is an honest answer: this tool only calls something disposable when it can prove the machine rebuilds it.')));

  const COLORS = { disposable: 'var(--s1)', yours: 'var(--s3)', unknown: 'var(--s2)' };
  const LABEL = { disposable: 'disposable', yours: 'yours', unknown: 'cannot judge' };
  const targets = c.targets || [];

  root.append(grid(
    at('c12', card({
      title: 'The folders this tool can name',
      shape: treemap({ items: targets.map((t) => ({ name: t.label, value: kb2gb(t.kb), color: COLORS[t.verdict], label: t.lose })) }),
      sub: 'Area is size. Colour is the verdict. Hover to read what you lose.',
      // Only verdicts that actually appear go in the legend: announcing a colour
      // that is not in the chart sends the reader hunting for nothing.
      legend: legendOf([...new Set(targets.map((t) => t.verdict))].map((k) => ({ name: LABEL[k], color: COLORS[k] }))),
      table: tableOf(['Folder', 'GB', 'Verdict'], targets.map((t) => [t.label, gb(kb2gb(t.kb)), LABEL[t.verdict]])),
      tall: true,
    })),
  ));

  // Pie of verdicts: how much of what was measured this tool can judge, and how
  // much it admits it cannot. A distribution of CONFIDENCE, not of size.
  const byVerdict = new Map();
  for (const t of targets) {
    const v = byVerdict.get(t.verdict) || { name: LABEL[t.verdict], value: 0, items: 0, color: COLORS[t.verdict] };
    v.value += kb2gb(t.kb); v.items++; byVerdict.set(t.verdict, v);
  }
  const verdictParts = [...byVerdict.values()].sort((a, b) => b.value - a.value)
    .map((t) => ({ ...t, value: +t.value.toFixed(2), note: `${t.items} folders` }));

  const top = c.homeTop || [];
  root.append(grid(
    at('c4', card({
      title: 'How much of it this tool can judge',
      sub: `Of ${gb(targets.reduce((a, x) => a + kb2gb(x.kb), 0))} GB it can name, ${gb((byVerdict.get('disposable') || { value: 0 }).value)} GB is provably rebuildable. The rest is "cannot judge", and it stays.`,
      legend: legendOf(verdictParts.map((f) => ({ name: f.name, color: f.color }))),
      shape: pie({ parts: verdictParts }),
      table: tableOf(['Verdict', 'GB', 'Folders'], verdictParts.map((f) => [f.name, gb(f.value), f.items])),
    })),
    at('c8', chartHidden(c)),
  ));

  root.append(grid(
    at('c6', chartRepos(c)),
    at('c6', card({
      title: 'The top of your home folder',
      sub: 'The ten largest, hidden folders included.',
      shape: bars({ data: top.slice(0, 10).map((t) => ({
        name: short(t.path), value: kb2gb(t.kb), color: t.hidden ? 'var(--edge)' : 'var(--s1)',
        note: t.hidden ? 'hidden — out of reach of a plain `du ~/*`' : null })), directLabels: 2 }),
      table: tableOf(['Folder', 'GB'], top.map((t) => [short(t.path), gb(kb2gb(t.kb))])),
    })),
  ));

  root.append(el('div', { class: 'section' }, el('h2', {}, 'Targets, with the verdict spelled out')));
  const tb = el('table', { class: 'wide' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Folder'), el('th', { class: 'num' }, 'Size'),
      el('th', {}, 'Verdict'), el('th', {}, 'What you lose'))));
  const body = el('tbody');
  for (const t of targets) {
    body.append(el('tr', {},
      el('td', { class: 'name' }, el('div', {}, t.label),
        el('div', { style: 'font:11.5px var(--mono);color:var(--ink3);margin-top:2px' }, short(t.path))),
      el('td', { class: 'num' }, gb(kb2gb(t.kb)), ' GB'),
      el('td', {}, el('span', { class: 'tag' }, LABEL[t.verdict])),
      el('td', { style: 'color:var(--ink2);max-width:40ch' }, t.lose)));
  }
  tb.append(body);
  root.append(el('div', { class: 'scrollable' }, tb));
}

/* A plain `du -sh ~/*` cannot see a folder starting with a dot — the shell does
   not expand the glob. That is how tens of GB stay out of every hand count. */
function chartHidden(c) {
  const top = c.homeTop || [];
  const hidden = top.filter((t) => t.hidden);
  const hiddenSum = hidden.reduce((s, t) => s + t.kb, 0);
  const visibleSum = top.filter((t) => !t.hidden).reduce((s, t) => s + t.kb, 0);
  return card({
    title: 'What `du -sh ~/*` does not show',
    sub: 'The shell does not expand names that begin with a dot.',
    legend: legendOf([{ name: 'visible', color: 'var(--line2)' }, { name: 'hidden', color: 'var(--edge)' }]),
    shape: stackedBar({ parts: [
      { name: 'Visible folders', value: kb2gb(visibleSum), color: 'var(--line2)', dark: true },
      { name: 'Hidden folders (starting with a dot)', value: kb2gb(hiddenSum), color: 'var(--edge)' },
    ], height: 42 }),
    table: tableOf(['Hidden folder', 'GB'], hidden.map((t) => [short(t.path), gb(kb2gb(t.kb))])),
  });
}

/* Two measures per repository. An all-pairs shape: only two categories. */
function chartRepos(c) {
  const repos = (c.repos?.repos || []).filter((r) => r.git && (r.nodeModulesKB || 0) > 51200);
  const points = repos.map((r) => ({
    name: r.name, x: r.days, y: kb2gb(r.nodeModulesKB),
    color: r.stale ? 'var(--s2)' : 'var(--s1)',
    marked: r.off > 0 || !r.hasRemote,
    note: !r.hasRemote ? 'no remote at all — this machine is the only copy'
      : `${r.off} commit(s) off ${r.base} — the repo itself is not disposable`,
  }));
  return card({
    title: 'Projects: age against weight',
    sub: 'The amber ring marks anything with commits off the main branch, or no remote at all. Those repos are not disposable, however long they have sat still.',
    legend: legendOf([{ name: 'quiet for over 60 days', color: 'var(--s2)' }, { name: 'active', color: 'var(--s1)' }]),
    shape: scatter({ points, xLabel2: 'days since last commit', yLabel: 'node_modules (GB)', xUnit: ' days', yUnit: ' GB' }),
    table: tableOf(['Project', 'Days', 'GB', 'Off main', 'Remote'],
      repos.map((r) => [r.name, r.days, gb(kb2gb(r.nodeModulesKB)), r.off || 0, r.hasRemote ? 'yes' : 'none'])),
    tall: true,
  });
}

/* ================================================================ CHECKS */
function checks(c) {
  const root = $('#tab-checks');
  root.textContent = '';
  if (!c || !c.hasCache) { root.append(el('p', { class: 'empty' }, 'Run the scan on the Overview tab first.')); return; }
  const items = c.checks?.items || [];
  const serious = items.filter((i) => i.serious);

  root.append(el('div', { class: 'verdict' },
    el('p', { class: 'headline' }, serious.length, serious.length === 1 ? ' thing is broken' : ' things are broken', el('em', {}, '.')),
    el('p', { class: 'summary' }, 'Nothing gets a row here unless it has a fix. A diagnosis with no action is noise.')));

  const v = c.volume, m = c.memory;
  const diskPct = Math.round((v.usedKB / (v.usedKB + v.freeKB)) * 100);
  const swapPct = m.swap ? Math.round((m.swap.usedMB / m.swap.totalMB) * 100) : 0;
  const memPct = Math.round(((m.vm.active + m.vm.wired + m.vm.compressed) / m.totalBytes) * 100);
  root.append(grid(
    at('c4', card({ title: 'Disk used', sub: `${gb(kb2gb(v.freeKB))} GB free`,
      shape: gauge({ pct: diskPct, center: diskPct + '%', sub: 'of the data volume' }) })),
    at('c4', card({ title: 'Swap used', sub: 'Disk standing in for RAM.',
      shape: gauge({ pct: swapPct, center: swapPct + '%', sub: 'of reserved swap' }) })),
    at('c4', card({ title: 'RAM committed', sub: 'Wired, active and compressed — what is not available right now.',
      shape: gauge({ pct: memPct, center: memPct + '%', sub: 'of total RAM' }) })),
  ));

  // ONE measure, several entities: the log size of each container. Plotting GB
  // and a restart count on one axis, dividing one by 100 so it "fits", is a
  // dual axis in disguise — the alignment would be arbitrary. The restart count
  // lives in the label.
  const logs = (c.docker?.logs || []).slice(0, 8);
  const looping = logs.find((l) => l.restarts >= 5);
  if (logs.length) {
    root.append(grid(at('c12', card({
      title: 'Container log, per container',
      sub: looping
        ? `${looping.name} leads because it has restarted ${looping.restarts} times under policy '${looping.policy}': every cycle writes the startup log again. \`docker system df\` shows none of this.`
        : '`docker system df` measures a container\'s writable layer and never this file.',
      shape: columns({
        data: logs.map((l) => ({
          name: l.name.length > 13 ? l.name.slice(0, 12) + '…' : l.name,
          sub: l.restarts >= 5 ? `${l.restarts} restarts` : (l.noRotation ? 'no limit' : ''),
          value: +(l.bytes / 1073741824).toFixed(3),
          note: `${l.restarts} restarts · policy '${l.policy}'` + (l.noRotation ? ' · no rotation limit' : ''),
        })), unit: 'GB', height: 230,
      }),
      table: tableOf(['Container', 'Log (GB)', 'Restarts', 'Rotation'],
        logs.map((l) => [l.name, gb(l.bytes / 1073741824), l.restarts, l.noRotation ? 'none' : 'configured'])),
    }))));
  }

  for (const i of items) {
    const c2 = el('div', { class: 'card' + (i.serious ? '' : ' stays') });
    // Urgency is a word and a position, never a traffic light.
    c2.append(el('div', { class: 'row' },
      el('div', { class: 'weight', style: 'font-size:14px' }, i.serious ? 'now' : 'later'),
      el('div', {}, el('p', { class: 'title' }, i.title))));
    c2.append(el('div', { class: 'proof' }, i.found));
    if (i.cost) c2.append(el('div', { class: 'lose' }, el('b', {}, 'Cost of acting: '), i.cost));
    const cmd = commandBlock(i.fix, 'paste it yourself. this panel does not execute.');
    if (cmd) c2.append(cmd);
    root.append(c2);
  }
}

/* =================================================================== DNS */
/* A separate tab on purpose: a bug in the monitor shows a wrong number, a bug
   here leaves the machine without internet. Nothing runs from here. Ever. */
function dns(d) {
  const root = $('#tab-dns');
  root.textContent = '';
  if (!d) { root.append(el('p', { class: 'loading' }, 'reading the network configuration')); return; }

  const wifi = d.services.find((s) => /wi-?fi/i.test(s.service)) || d.services[0];
  const current = wifi ? wifi.ips : [];

  root.append(el('div', { class: 'verdict' },
    el('p', { class: 'headline' }, 'Block ads and dangerous sites.'),
    el('p', { class: 'summary' }, 'Two halves: a blocklist you build, and the resolver your machine asks. ',
      el('b', {}, 'This tab never executes anything.'), ' It writes the command and the undo; you are the one who types them.')));

  root.append(el('div', { class: 'warn-box' },
    el('h3', {}, 'Read this before changing anything'),
    el('ul', {}, ...d.warnings.map((a) => el('li', {}, a)))));

  root.append(el('div', { class: 'section' },
    el('h2', {}, 'How it stands now'), el('p', {}, 'What the system actually queries, in order.')));
  const t = el('table', { class: 'wide' }, el('thead', {}, el('tr', {}, el('th', {}, 'Service'), el('th', {}, 'Configured DNS'))));
  const tb = el('tbody');
  tb.append(el('tr', {}, el('td', { class: 'name' }, el('b', {}, 'what actually answers')),
    el('td', { style: 'font:12.5px var(--mono)' }, d.effective.ips.join('  ·  '))));
  for (const s of d.services) {
    tb.append(el('tr', {}, el('td', { class: 'name' }, s.service),
      el('td', { style: 'font:12.5px var(--mono);color:var(--ink2)' }, s.inherited ? 'inherited from the router' : s.ips.join('  ·  '))));
  }
  t.append(tb); root.append(el('div', { class: 'scrollable' }, t));

  if (d.health && d.health.length) root.append(resolverHealth(d));

  if (state.blocklist) root.append(blocklistSection(state.blocklist));

  root.append(el('div', { class: 'section' },
    el('h2', {}, 'Change the resolver'),
    el('p', {}, 'Filters against a list somebody else maintains, and it catches subdomains — which the list above does not. Each option ships with the undo built from what is configured right now.')));

  for (const p of d.providers.filter((x) => x.ips.length)) {
    const c = el('div', { class: 'provider' });
    c.append(el('div', { class: 'head' }, el('span', { class: 'name' }, p.name), el('span', { class: 'ips' }, p.ips.join('  ·  '))));
    c.append(el('div', { class: 'blocks' }, el('b', {}, 'Blocks: '), p.blocks));
    c.append(el('div', { class: 'note' }, p.note));
    const open = el('button', { class: 'copy', style: 'margin-top:11px', onclick: async () => {
      open.remove();
      const r = await get(`/api/dns/recipe?service=${encodeURIComponent(wifi.service)}&provider=${p.id}&current=${current.join(',')}`);
      // THE UNDO COMES FIRST. On purpose: if DNS breaks, you cannot search for
      // how to fix it.
      c.append(
        el('div', { class: 'undo-first' },
          el('span', { class: 'step' }, '1. keep the undo — before applying anything'),
          commandBlock(r.undo, r.undoExplained)),
        el('div', { style: 'margin-top:15px' },
          el('span', { class: 'step' }, '2. apply'),
          commandBlock(r.apply, 'it will ask for your password. this panel does not type sudo for you.')),
        el('div', { style: 'margin-top:15px' },
          el('span', { class: 'step' }, '3. check that it took'),
          commandBlock(r.verify, r.ifItBreaks)));
    } }, 'build the commands for ' + p.name);
    c.append(open);
    root.append(c);
  }
}

/* Every resolver the machine is configured to use, asked a real question and
   timed. This exists because a dead entry in the list is invisible from the
   outside: the internet still works, pages still open, and only the things
   pulled from a second hostname — stylesheets, fonts — quietly time out. */
function resolverHealth(d) {
  const box = el('div', {});
  const dead = d.dead || [], slow = d.slow || [];

  box.append(el('div', { class: 'section' },
    el('h2', {}, 'Is each one actually answering?'),
    el('p', {}, dead.length
      ? `${dead.length} of the ${d.health.length} addresses configured here did not answer. A resolver list is failover: every lookup that lands on a dead entry stalls until it gives up.`
      : `All ${d.health.length} addresses answered. Timings are from one query each, just now.`)));

  const fastest = Math.max(...d.health.filter((h) => h.answered).map((h) => h.ms), 1);
  box.append(grid(at('c12', card({
    title: 'Response time per resolver',
    sub: 'Measured against the machine, one query each. A bar at the far right, or none at all, is the one to remove.',
    shape: bars({
      data: d.health.map((h) => ({
        name: h.ip + (h.owner ? `  (${h.owner})` : ''),
        // A dead resolver has no time to plot. It gets the full bar and the
        // boundary colour, because "no answer" is not "slow" — it is a
        // different kind of thing, and the chart should not imply an ordering.
        value: h.answered ? h.ms : fastest,
        // The bar is full width to be impossible to miss, but the label says
        // what actually happened. Printing "53 ms" next to a server that never
        // replied would be the chart asserting a measurement nobody took.
        labelText: h.answered ? `${h.ms} ms` : 'no answer',
        color: h.answered ? (h.slow ? 'var(--s2)' : 'var(--s1)') : 'var(--edge)',
        note: h.answered
          ? `answered in ${h.ms} ms${h.slow ? ' — slow enough to feel on a page with several hostnames' : ''}`
          : 'did not answer at all. every lookup that lands here stalls.',
      })), unit: 'ms', directLabels: d.health.length,
    }),
    legend: legendOf([
      { name: 'answering', color: 'var(--s1)' },
      ...(slow.length ? [{ name: 'slow (over 250 ms)', color: 'var(--s2)' }] : []),
      ...(dead.length ? [{ name: 'no answer — remove it', color: 'var(--edge)' }] : []),
    ]),
    table: tableOf(['Resolver', 'Provider', 'Response'],
      d.health.map((h) => [h.ip, h.owner || 'unknown', h.answered ? `${h.ms} ms` : 'no answer'])),
  }))));

  // The fix, built from what was actually measured rather than from a template.
  if (dead.length || d.stacked) {
    const wifi = d.services.find((s) => /wi-?fi/i.test(s.service)) || d.services[0];
    const alive = d.health.filter((h) => h.answered && !h.slow);
    // Every provider the user already chose that is also answering. Picking one
    // for them would be guessing at what they wanted blocked; the command needs
    // a concrete pair, so it takes the first and says the rest are one swap away.
    const candidates = d.providers.filter((p) => p.ips.length && p.ips.some((ip) => alive.some((a) => a.ip === ip)));
    const keep = candidates[0] || { ips: ['1.1.1.1', '1.0.0.1'], name: 'Cloudflare (unfiltered)' };
    const others = candidates.slice(1).map((p) => p.name);
    box.append(el('div', { class: 'provider' },
      el('div', { class: 'head' },
        el('span', { class: 'name' }, 'Reduce the list to one working provider'),
        el('span', { class: 'ips' }, `${d.health.length} configured now · ${keep.ips.length} is the right number`)),
      el('div', { class: 'blocks' },
        el('b', {}, 'Why: '),
        dead.length
          ? `${dead.map((x) => x.ip).join(', ')} never answers, and one dead entry slows down every lookup on the machine. `
          : '',
        d.stacked
          ? 'Several providers are stacked on one interface. macOS asks whichever answers first, so this does not combine their filters — it picks one of them at random.'
          : ''),
      el('div', { class: 'note' },
        `The command below keeps ${keep.name} — two addresses from one provider, a primary and a secondary, which is exactly what a resolver list is for. `,
        others.length
          ? `You also have ${others.join(' and ')} configured and answering; to keep one of those instead, swap in its two addresses from the list further down. `
          : '',
        'What matters is that it is one provider, not which.'),
      el('div', { class: 'undo-first' },
        el('span', { class: 'step' }, '1. keep the undo — it puts back exactly what is set now'),
        commandBlock(`sudo networksetup -setdnsservers ${JSON.stringify(wifi.service)} ${wifi.ips.join(' ')} && sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder`,
          'this restores the current list, dead entry included. it is here so nothing is lost by trying.')),
      el('div', { style: 'margin-top:15px' },
        el('span', { class: 'step' }, '2. apply'),
        commandBlock(`sudo networksetup -setdnsservers ${JSON.stringify(wifi.service)} ${keep.ips.join(' ')} && sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder`,
          'it will ask for your password. this panel does not type sudo for you.')),
      el('div', { style: 'margin-top:15px' },
        el('span', { class: 'step' }, '3. check that it took'),
        commandBlock(`scutil --dns | grep nameserver | head -4`,
          'come back to this tab afterwards and every bar should be short.'))));
  }
  return box;
}

/* A blocklist applied through /etc/hosts. This tool keeps the list, generates
   the snippet and shows the command — and writes not one line to /etc/hosts. */
function blocklistSection(b) {
  const box = el('div', {});
  const total = b.domains.length;

  box.append(el('div', { class: 'section' },
    el('h2', {}, 'Your blocklist'),
    el('p', {}, total
      ? `${total} ${total === 1 ? 'domain' : 'domains'} on the list. ${b.state.hasBlock ? `${b.state.activeNow} are already in effect in /etc/hosts.` : 'None are in effect yet — they still have to be applied.'}`
      : 'Empty. Add a ready-made set, or type a domain.')));

  // THE LIMIT, above any button: whoever misses this will think the block
  // failed when in truth it never covered the subdomain.
  box.append(el('div', { class: 'warn-box' },
    el('h3', {}, 'What this list does, and what it does not'),
    el('ul', {},
      el('li', {}, b.limit),
      el('li', {}, 'This tool writes only to a file of its own. You are the one editing /etc/hosts, with the command shown below.'))));

  const setsRow = el('div', { class: 'sets' });
  for (const s of b.sets) {
    const already = s.domains.every((d) => b.domains.some((x) => x.name === d));
    setsRow.append(el('button', {
      class: 'set' + (already ? ' inside' : ''),
      onclick: () => sendBlocklist('/api/blocklist/add', { set: s.id }),
      title: s.description,
    }, el('b', {}, s.label), el('span', {}, `${s.count} domains`),
       el('i', {}, already ? 'already on the list' : s.description)));
  }
  box.append(setsRow);

  const field = el('input', { type: 'text', placeholder: 'example.com', class: 'field',
    onkeydown: (e) => { if (e.key === 'Enter') submit(); } });
  const err = el('span', { class: 'field-error' });
  function submit() {
    const v = field.value.trim();
    if (!v) return;
    sendBlocklist('/api/blocklist/add', { domain: v }, (r) => {
      if (r && r.error) { err.textContent = r.error; return; }
      field.value = ''; err.textContent = '';
    });
  }
  box.append(el('div', { class: 'add-row' },
    field, el('button', { class: 'action', onclick: submit }, 'Add to list'), err));

  if (total) {
    const cats = Object.entries(b.byCategory).sort((a, b2) => b2[1] - a[1]);
    box.append(grid(
      at('c5', card({
        title: 'The list by category',
        sub: `${total} domains in total.`,
        shape: columns({
          data: cats.map(([name, n], i) => ({ name, value: n, color: `var(--s${i + 1})`, sub: 'domains' })),
          unit: 'domains', height: 200, labelAll: true,
        }),
        table: tableOf(['Category', 'Domains'], cats),
      })),
      at('c7', card({
        title: 'The domains',
        sub: 'Click the x to drop one. None of this takes effect until you apply it.',
        shape: el('div', { class: 'chips' }, ...b.domains.map((d) =>
          el('span', { class: 'chip' }, d.name,
            el('button', { title: 'remove from list',
              onclick: () => sendBlocklist('/api/blocklist/remove', { domain: d.name }) }, '×')))),
      })),
    ));

    const stepsBox = el('div', { class: 'provider' });
    stepsBox.append(el('div', { class: 'head' },
      el('span', { class: 'name' }, 'Apply the list to /etc/hosts'),
      el('span', { class: 'ips' }, `${total} domains · ${b.snippet.lines} lines`)));
    stepsBox.append(el('div', { class: 'undo-first' },
      el('span', { class: 'step' }, '1. keep the undo — before applying anything'),
      commandBlock(b.recipe.undo, b.recipe.undoExplained)));
    stepsBox.append(el('div', { style: 'margin-top:15px' },
      el('span', { class: 'step' }, '2. apply'),
      commandBlock(b.recipe.apply, 'it will ask for your password. this panel does not type sudo for you.')));
    stepsBox.append(el('div', { style: 'margin-top:15px' },
      el('span', { class: 'step' }, '3. check that it took'),
      commandBlock(b.recipe.verify, b.recipe.ifItBreaks)));
    box.append(stepsBox);
  }
  return box;
}

async function sendBlocklist(route, body, after) {
  try {
    const r = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) { if (after) after(d); return; }
    state.blocklist = d;
    if (after) after(null);
    dns(state.dns);
  } catch (e) { if (after) after({ error: e.message }); }
}

/* ----------------------------------------------------------------- footer */
async function measureSelf() {
  try {
    const e = await get('/api/self');
    $('#self-rss').textContent = e.rssMB + ' MB';
    $('#self-share').textContent = e.shareOfRam != null ? `(${e.shareOfRam}% of the machine)` : '';
    $('#self-cpu').textContent = (e.cpuPct ?? 0).toFixed(1) + '%';
    $('#self-policy').textContent = `${e.scans} ${e.scans === 1 ? 'scan' : 'scans'} · no polling between them`;
    const freeable = state.cache?.panel?.totalGB;
    if (freeable != null) {
      const costGB = e.rssMB / 1024;
      // If the cost ever exceeds the benefit, the screen says so rather than hiding it.
      $('#balance').innerHTML = costGB >= freeable
        ? `costs <b>more</b> than it finds: ${gb(costGB)} GB to find ${gb(freeable)} GB`
        : `points at <b>${gb(freeable)} GB</b> while using ${e.rssMB.toFixed(0)} MB`;
    }
  } catch {}
}

/* ------------------------------------------------------------------ tabs */
function render() {
  overview(state.cache);
  memory(state.light);
  disk(state.cache);
  checks(state.cache);
  dns(state.dns);
  const n = state.cache?.panel?.out?.filter((d) => d.kb > 0).length;
  $('#count-overview').textContent = n || '';
  const g = state.cache?.checks?.items?.filter((i) => i.serious).length;
  $('#count-checks').textContent = g || '';
  measureSelf();
}

function goTo(tab, noHash) {
  if (!TABS.includes(tab)) tab = 'overview';
  state.tab = tab;
  // The tab lives in the URL: reload without losing your place, and bookmark
  // the one you actually use.
  if (!noHash && location.hash.slice(1) !== tab) location.hash = tab;
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const s of document.querySelectorAll('main section')) s.hidden = s.id !== `tab-${tab}`;
  if (tab === 'memory') refreshLight();
  if (tab === 'dns' && !state.dns) {
    Promise.all([get('/api/dns'), get('/api/blocklist')]).then(([d, b]) => {
      state.dns = d; state.blocklist = b; dns(d);
    });
  }
  measureSelf();
}

async function refreshLight() {
  state.light = await get('/api/light');
  memory(state.light);
  const m = state.light.memory;
  $('#machine-sub').textContent =
    `${(m.totalBytes / 1073741824).toFixed(0)} GB of RAM · ${m.swap ? gb(m.swap.usedMB / 1024) : '?'} GB in swap`;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('#tabs button');
  if (b) goTo(b.dataset.tab);
});
addEventListener('hashchange', () => goTo(location.hash.slice(1), true));

(async function start() {
  state.cache = await get('/api/cache');
  await refreshLight();
  render();
  if (location.hash.slice(1)) goTo(location.hash.slice(1), true);
})();
