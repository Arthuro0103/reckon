#!/usr/bin/env node
'use strict';
/* ---------------------------------------------------------------------------
   Smoke tests. They exist for a concrete reason: adding accents to this panel's
   Portuguese copy once corrupted, silently, six names that are CONTRACTS — a
   require path, a tab id, an API key and a query parameter. `node --check`
   passed on every one of them. The worst built `networksetup -setdnsservers
   null`, which does not show a wrong number: it takes the internet down.
   These checks catch that whole class.
--------------------------------------------------------------------------- */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (m) => console.log('  ok    ' + m);
const fail = (m, d) => { failures++; console.log('  FAIL  ' + m + (d ? '\n          ' + d : '')); };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const ACCENT = /[áéíóúâêôàãõçÁÉÍÓÚÂÊÔÃÕÇ]/;

// lib/ has subdirectories now (lib/platform/), and readFileSync on a directory
// throws EISDIR — which would take the whole suite down before the first check
// ran. Walk instead, and take only .js: CONTRACT.md is documentation, not a
// contract position.
function libFiles(dir = 'lib') {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) out.push(...libFiles(rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

// 1. Every require resolves. `node --check` resolves no modules at all.
function requires() {
  const files = ['server.js', ...libFiles()];
  for (const f of files) {
    for (const m of read(f).matchAll(/require\('(\.[^']+)'\)/g)) {
      const target = path.resolve(ROOT, path.dirname(f), m[1]);
      if (fs.existsSync(target) || fs.existsSync(target + '.js')) ok(`${f} -> ${m[1]}`);
      else fail(`${f} requires '${m[1]}', which does not exist`);
    }
  }
}

// 2. The two front-end scripts share ONE global scope. `node --check` validates
//    each alone and cannot see the collision: a `function card` in charts.js
//    against a `const card` in app.js kills the whole page in a SyntaxError
//    before the first line runs. Loading both in one context is the only check
//    that catches it.
function sharedScope() {
  const vm = require('node:vm');
  const no = () => ({ setAttribute() {}, append() {}, addEventListener() {}, style: {},
    classList: { add() {} }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 10 }),
    querySelector: () => no(), querySelectorAll: () => [], remove() {}, hidden: false,
    get textContent() { return ''; }, set textContent(v) {}, get innerHTML() { return ''; }, set innerHTML(v) {} });
  const ctx = { console: { log() {}, error() {} }, window: {}, Date, Math, JSON, Promise, setTimeout,
    document: { createElement: no, createElementNS: no, createTextNode: no, body: no(),
      querySelector: () => no(), querySelectorAll: () => [], addEventListener() {} },
    addEventListener() {}, innerWidth: 1200, location: { hash: '' },
    navigator: { platform: 'test', userAgent: 'test' },
    fetch: () => Promise.resolve({ ok: true, json: () => ({ hasCache: false }) }) };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['web/charts.js', 'web/app.js']) {
    try { vm.runInContext(read(f), ctx, { filename: f }); ok(`${f} loads in the shared scope`); }
    catch (e) {
      if (e instanceof SyntaxError || /already been declared/.test(e.message)) {
        return fail(`${f} collides in the global scope`, e.message);
      }
      ok(`${f} loads (stopped later, in the fake DOM: ${e.message.slice(0, 46)})`);
    }
  }
  if (!ctx.window.G) fail('charts.js did not export window.G');
  else ok(`window.G exports ${Object.keys(ctx.window.G).length} shapes`);
}

// 3. Every selector the front-end uses exists in the HTML.
function selectors() {
  const app = read('web/app.js'), html = read('web/index.html');
  for (const m of app.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)) {
    if (html.includes(`id="${m[1]}"`)) ok(`#${m[1]} exists in the html`);
    else fail(`#${m[1]} is used in app.js and missing from index.html`);
  }
  const fromHtml = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]).sort();
  const fromJs = (app.match(/const TABS = \[([^\]]+)\]/) || [])[1];
  const jsList = fromJs ? fromJs.split(',').map((s) => s.trim().replace(/'/g, '')).sort() : [];
  if (JSON.stringify(fromHtml) === JSON.stringify(jsList)) ok('html tabs match the TABS list in js');
  else fail('tabs diverge', `html=${fromHtml} js=${jsList}`);
}

// 4. No contract identifier may carry an accent — this is the check that would
//    have caught the `-setdnsservers null` bug.
function contracts() {
  const targets = [
    ['web/app.js', /class: '([^']*)'/g, 'CSS class'],
    ['web/app.js', /fetch\('([^']*)'\)|get\('([^']*)'\)/g, 'route'],
    ['server.js', /searchParams\.get\('([^']*)'\)/g, 'query parameter'],
    ['server.js', /route === '([^']*)'/g, 'route'],
  ];
  for (const [file, re, kind] of targets) {
    let dirty = 0;
    for (const m of read(file).matchAll(re)) {
      const v = m[1] || m[2] || '';
      if (ACCENT.test(v)) { fail(`accented ${kind} in ${file}: '${v}'`); dirty++; }
    }
    if (!dirty) ok(`${kind}s in ${file} carry no accents`);
  }
  for (const f of libFiles()) {
    const lines = read(f).split('\n');
    let dirty = 0;
    lines.forEach((l, i) => {
      const m = l.match(/^\s*([a-zA-Z][a-zA-Z0-9_]*):\s/);
      if (m && ACCENT.test(m[1])) { fail(`accented object key in ${f}:${i + 1} -> ${m[1]}`); dirty++; }
    });
    if (!dirty) ok(`${f} has no accented keys`);
  }
}

// 5. Every class the front-end uses has a CSS rule. Grid classes included:
//    using `c5` with no matching rule breaks nothing visibly in the code — the
//    card silently becomes 1/12 of a column and the chart inside it vanishes.
function css() {
  const style = read('web/style.css') + read('web/tokens.css'), app = read('web/app.js'), charts = read('web/charts.js');
  const missing = new Set();
  for (const src of [app, charts])
    for (const m of src.matchAll(/class: '([^']+)'/g))
      for (const c of m[1].split(/\s+/)) if (c && !style.includes('.' + c)) missing.add(c);
  for (const m of app.matchAll(/at\('([^']+)'/g))
    if (!new RegExp('\\.' + m[1] + '\\b').test(style)) missing.add(m[1]);
  if (missing.size) fail('classes with no CSS rule: ' + [...missing].join(', '));
  else ok('every class used has a CSS rule');

  const vars = new Set([...style.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
  const orphan = new Set();
  for (const src of [style, app, charts])
    // `var(--s${i + 1})` in a template is not a variable named `--s`
    for (const m of src.matchAll(/var\((--[a-z0-9-]+)(\$\{)?/g)) if (!m[2] && !vars.has(m[1])) orphan.add(m[1]);
  if (orphan.size) fail('CSS variables used but never defined: ' + [...orphan].join(', '));
  else ok('every CSS variable used is defined');
}

// 6. The DNS command pair. The most important test in this file.
function dnsRecipe() {
  const { recipe } = require(path.join(ROOT, 'lib/dns.js'));
  // On a platform with no implementation, building a DNS command is SUPPOSED to
  // throw — the seam refuses to invent one rather than emit something that looks
  // like a command and is not. That is the design working, and this suite has to
  // be runnable by a contributor on Linux who has no lib/platform/linux.js. What
  // gets asserted there instead is that the refusal is actionable.
  const platform = require(path.join(ROOT, 'lib/platform'));
  if (platform.supported === false && !/darwin|win32/.test(platform.id)) {
    const why = String(platform.unsupportedReason || '');
    if (/lib\/platform\/\w+\.js/.test(why) && /CONTRACT\.md/.test(why)) {
      ok(`no implementation for ${platform.id}, and the message names the file to write`);
    } else {
      fail(`the unsupported message for ${platform.id} does not say which file to write`, why.slice(0, 200));
    }
    try {
      recipe('Wi-Fi', 'adguard', ['8.8.8.8']);
      fail('building a DNS command on an unimplemented platform should throw, not invent one');
    } catch (e) {
      if (e && e.code === 'RECKON_PLATFORM_UNSUPPORTED') ok('a DNS command is refused rather than invented');
      else fail('the refusal came with the wrong error', String((e && e.message) || e).slice(0, 120));
    }
    return;
  }
  const r = recipe('Wi-Fi', 'adguard', ['8.8.8.8', '8.8.4.4']);
  if (!r) return fail('the DNS recipe was not built');
  for (const [field, text] of [['apply', r.apply], ['undo', r.undo]]) {
    if (/\bnull\b|undefined/.test(text)) fail(`the '${field}' command came out with null/undefined`, text);
    else if (!text.includes('"Wi-Fi"')) fail(`the '${field}' command does not name the service`, text);
    else ok(`the '${field}' command names the service`);
  }
  // Both addresses, in the order they were found in. Tested as two positions
  // rather than as one literal string: a platform separates a resolver list
  // with a space and another with a comma, and an assertion that only holds on
  // the platform this happens to run on is an assertion that stops working the
  // moment somebody ports the file it is guarding.
  const first = r.undo.indexOf('8.8.8.8'), second = r.undo.indexOf('8.8.4.4');
  if (first >= 0 && second > first) ok('undo restores exactly the addresses from before, in order');
  else fail('undo does not restore the original addresses', r.undo);
  if (recipe('Wi-Fi', 'current', ['8.8.8.8']) === null) ok('a provider with no addresses produces no command');
  else fail('the "current" provider should not produce a command');

  // The bug this whole file exists for: a missing service name must stop the
  // command being built at all. Returning something for it is how the machine
  // ends up pointed at a resolver called "null".
  for (const bad of [undefined, '', 'Wi-Fi"; rm -rf /', 'a$(reboot)b']) {
    let built = null;
    try { built = recipe(bad, 'adguard', []); } catch { built = 'refused'; }
    if (built === 'refused') ok(`a service name of ${JSON.stringify(bad)} is refused, not built around`);
    else fail(`recipe() built a DNS command for the service name ${JSON.stringify(bad)}`, String(built && built.apply));
  }
}

// 6b. Every platform implementation covers the whole contract. A capability
//     that is absent does not fail at load — it fails the moment somebody on
//     that platform opens the tab that needs it, which is the worst possible
//     time to find out.
function platformContract() {
  const index = read('lib/platform/index.js');
  const block = (index.match(/const CAPABILITIES = Object\.freeze\(\[([\s\S]*?)\]\)/) || [])[1] || '';
  const names = [...block.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  // OPTIONAL capabilities are part of the contract too: a platform may skip them
  // and stay supported, but exporting one is never "a name the contract does not
  // list". Reading both lists from the same file keeps them from drifting.
  const optBlock = (index.match(/const OPTIONAL = Object\.freeze\(\[([\s\S]*?)\]\)/) || [])[1] || '';
  const optional = [...optBlock.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
  const decBlock = (index.match(/const DECLARATIONS = Object\.freeze\(\[([\s\S]*?)\]\)/) || [])[1] || '';
  const declarations = [...decBlock.matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]);
  const known = [...names, ...optional, ...declarations];
  if (!names.length) return fail('could not read the capability list out of lib/platform/index.js');
  ok(`the contract lists ${names.length} capabilities`);

  // Only the files index.js actually offers a slot for. lib/platform holds
  // other things now, and a helper is not an implementation.
  const files = [...index.matchAll(/file: '([a-z0-9]+\.js)'/g)].map((m) => m[1]);
  for (const file of files) {
    const full = path.join(ROOT, 'lib/platform', file);
    if (!fs.existsSync(full)) { ok(`lib/platform/${file} is not written yet (index.js says so)`); continue; }
    let impl;
    try { impl = require(full); } catch (e) { fail(`lib/platform/${file} throws on load`, e.message); continue; }
    const missing = names.filter((n) => typeof impl[n] !== 'function');
    if (missing.length) fail(`lib/platform/${file} is missing ${missing.length} capability/ies`, missing.join(', '));
    else ok(`lib/platform/${file} implements all ${names.length}`);
    const extra = Object.keys(impl).filter((k) => !known.includes(k));
    if (extra.length) fail(`lib/platform/${file} exports names the contract does not list`, extra.join(', '));
  }
}


// 6c. Polish: a light theme that keeps the colour rules, tabs a keyboard can use, a visible
//     focus, folds and filters that survive a blocked localStorage, and `--open` that opens
//     nothing but the panel's own loopback address.
async function polish() {
  const tokens = read('web/tokens.css'), style = read('web/style.css'), html = read('web/index.html'), app = read('web/app.js');

  // --- the light token set
  const body = (re) => (tokens.match(re) || [])[1];
  const dark = body(/\n:root \{([\s\S]*?)\n\}/);
  const auto = body(/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{([\s\S]*?)\n  \}\n\}/);
  const pinned = body(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/);
  if (!dark || !auto || !pinned) return fail('tokens.css lacks the dark set, the prefers-color-scheme light set or the data-theme="light" set');
  const defs = (b) => Object.fromEntries([...b.matchAll(/^\s*(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6,8})\b/gm)].map((m) => [m[1], m[2].toLowerCase()]));
  const D = defs(dark), A = defs(auto), P = defs(pinned);
  if (JSON.stringify(A) === JSON.stringify(P)) ok('the light set under prefers-color-scheme and under data-theme="light" are the same');
  else fail('the two copies of the light tokens differ');
  if (/color-scheme:\s*dark/.test(dark) && /color-scheme:\s*light/.test(auto) && /color-scheme:\s*light/.test(pinned)) ok('each set declares its color-scheme');
  else fail('a token set does not declare its color-scheme');
  // Every colour token the dark set defines is either redefined for light or deliberately shared.
  const SHARED = new Set(['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8', '--cyan-d', '--on-series']);
  const unthemed = Object.keys(D).filter((k) => !(k in P) && !SHARED.has(k));
  if (unthemed.length) fail('tokens with a dark value and no light value', unthemed.join(', '));
  else ok('every surface, ink and accent token has a light value');
  if (!/--s1:/.test(light(auto)) && Object.keys(P).every((k) => !/^--s[1-8]$/.test(k))) ok('the eight series keep their hues and their order in both themes');
  else fail('the series colours were redefined for light: the colour-vision validation no longer covers them');

  const lum = (hx) => { const c = [1, 3, 5].map((i) => parseInt(hx.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  for (const [name, T] of [['dark', { ...D }], ['light', { ...D, ...P }]]) {
    const bad = [];
    for (const surf of ['--bg', '--bg2']) {
      for (const [k, min] of [['--ink', 7], ['--ink2', 4.5], ['--ink3', 4.5], ['--cyan', 4.5], ['--edge', 4.5]])
        if (ratio(T[k], T[surf]) < min) bad.push(`${k} on ${surf} ${ratio(T[k], T[surf]).toFixed(2)}`);
      for (let i = 1; i <= 8; i++) if (ratio(T['--s' + i], T['--bg2']) < 3) bad.push(`--s${i} on ${surf === '--bg2' ? 'card' : surf} ${ratio(T['--s' + i], T['--bg2']).toFixed(2)}`);
    }
    if (ratio(T['--on-cyan'], T['--cyan']) < 4.5) bad.push('--on-cyan on --cyan ' + ratio(T['--on-cyan'], T['--cyan']).toFixed(2));
    // the sequential ramp stays monotone in lightness
    const L = [1, 2, 3, 4, 5, 6].map((i) => lum(T['--q' + i]));
    if (!L.every((v, i) => i === 0 || (name === 'dark' ? v < L[i - 1] : v < L[i - 1]))) bad.push('the q ramp is not monotone');
    if (bad.length) fail(`the ${name} theme fails contrast`, [...new Set(bad)].join('; '));
    else ok(`the ${name} theme: ink at least 4.5:1, series at least 3:1 on the card, text on the accent readable, ramp monotone`);
  }
  if (!/#[0-9a-fA-F]{6}\b/.test(style.replace(/\/\*[\s\S]*?\*\//g, '').replace(/#(?:00000073)\b/g, ''))) ok('style.css holds no raw colour that would ignore the theme');
  else fail('style.css has a raw hex colour that will not follow the theme');
  if (/const SUP = 'var\(--bg2\)'/.test(read('web/charts.js'))) ok('the chart rings and gaps follow the card surface');
  else fail('web/charts.js paints its rings with a fixed colour');

  // --- tabs
  const tabs = [...html.matchAll(/<button[^>]*data-tab="(\w+)"[^>]*>/g)].map((m) => m[0]);
  if (/<nav id="tabs" role="tablist"/.test(html) && tabs.length >= 7 && tabs.every((b) => /role="tab"/.test(b) && /aria-controls="tab-\w+"/.test(b) && /aria-selected="(true|false)"/.test(b)))
    ok(`all ${tabs.length} tabs are role="tab" with aria-controls and aria-selected, in a role="tablist"`);
  else fail('the tabs are not a complete tablist in web/index.html');
  if ([...html.matchAll(/<section id="tab-(\w+)"/g)].every((m) => new RegExp(`id="tab-${m[1]}" role="tabpanel"`).test(html))) ok('every panel is a role="tabpanel"');
  else fail('a panel is not a role="tabpanel"');
  if (/ArrowRight/.test(app) && /ArrowLeft/.test(app) && /Home/.test(app) && /End/.test(app) && /setAttribute\('aria-selected'/.test(app)) ok('arrow keys, Home and End move between tabs, and aria-selected is kept');
  else fail('web/app.js has no arrow-key, Home and End navigation on the tabs');

  // --- focus
  const bare = style.split('\n').filter((l) => /outline:\s*(none|0)\b/.test(l.replace(/\/\*.*?\*\//g, '')));
  if (/:focus-visible\s*\{[^}]*outline:\s*2px solid/.test(style)) ok('there is a visible :focus-visible outline');
  else fail('web/style.css has no visible :focus-visible outline');
  if (!bare.length) ok('no rule removes the focus outline (the add-domain field keeps it)');
  else fail('a rule removes the focus outline', bare.join(' | '));

  // --- folds, filter, storage, footer
  if (/function fold\(/.test(app) && /createElement|el\('details'/.test(app) && /function kindFilter\(/.test(app) && /kindLabel/.test(app)) ok('the Overview lists fold, and the decisions filter by kind with a count');
  else fail('the Overview folds or the kind filter are missing');
  const raw = [...(app + html).matchAll(/localStorage/g)].length;
  const guarded = [...(app + html).matchAll(/try \{[^}]*localStorage[^}]*\}\s*catch/g)].length;
  if (raw > 0 && raw === guarded) ok('every localStorage access is inside try/catch');
  else fail('a localStorage access is not wrapped in try/catch', `${raw} uses, ${guarded} guarded`);
  if (/<footer>[\s\S]*<a href="\/pet"[\s\S]*<\/footer>/.test(html)) ok('the footer links the /pet preview');
  else fail('the footer does not link /pet');

  // --- --open
  const darwin = require(path.join(ROOT, 'lib/platform/darwin.js'));
  for (const bad of ['https://example.com/', 'http://127.0.0.1:4128/../../etc', 'http://localhost:4127/', 'file:///etc/passwd', 'http://127.0.0.1:4127@evil.com/', 'http://127.0.0.1:4127/x;rm -rf ~', '-a Calculator', 'http://0.0.0.0:4127/']) {
    try { await darwin.openBrowser(bad); fail('openBrowser accepted an address that is not the panel\'s own', bad); return; }
    catch (e) { if (!(e instanceof TypeError)) throw e; }
  }
  ok('openBrowser throws on anything that is not http://127.0.0.1:<port>/');
  const dsrc = read('lib/platform/darwin.js');
  if (/run\('open', \[String\(url\)\]/.test(dsrc) && !/openBrowser[\s\S]{0,400}(shell|exec\()/.test(dsrc.slice(dsrc.indexOf('async function openBrowser'), dsrc.indexOf('async function openBrowser') + 500))) ok('openBrowser runs `open` with a fixed argv and no shell');
  else fail('openBrowser does not run `open` with a fixed argv');
  const platform = require(path.join(ROOT, 'lib/platform')), real = platform.openBrowser, seen = [], lines = [];
  platform.openBrowser = async (u) => { seen.push(u); if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(u)) throw new TypeError('nope'); return true; };
  try {
    const { openPanel } = require(path.join(ROOT, 'lib/openpanel.js'));
    await openPanel('http://127.0.0.1:4127/', (l) => lines.push(l));
    await openPanel('https://example.com/', (l) => lines.push(l));
    if (seen.length === 2 && lines.length === 1 && /nope/.test(lines[0])) ok('--open passes the loopback address to the seam and reports a refusal instead of crashing');
    else fail('openPanel did not behave', JSON.stringify({ seen, lines }));
  } finally { platform.openBrowser = real; }
  const srv = read('server.js'), bin = read('bin/reckon');
  if (/process\.argv\.includes\('--open'\)/.test(srv) && /openPanel\(`http:\/\/127\.0\.0\.1:\$\{PORT\}\/`\)/.test(srv)) ok('server.js opens only its own loopback address, and only with --open');
  else fail('server.js does not guard --open to its loopback address');
  if (/else require\('\.\.\/server\.js'\)/.test(bin)) ok('`reckon --open` reaches the server');
  else fail('bin/reckon no longer starts the server by default');
}
function light(b) { return b; }

// 7. The blocklist sieve: anything that gets past it becomes a line in /etc/hosts.
function blocklistSieve() {
  const { cleanDomain } = require(path.join(ROOT, 'lib/blocklist.js'));
  const cases = [
    ['example.com', 'example.com'], ['https://ads.google.com/path', 'ads.google.com'],
    ['*.doubleclick.net', 'doubleclick.net'], ['  UPPER.COM  ', 'upper.com'],
    ['not a domain', null], ['localhost', null], ['', null], ['../../etc/passwd', null],
    ['a b.com; rm -rf /', null],
  ];
  let bad = 0;
  for (const [input, want] of cases) {
    const got = cleanDomain(input);
    if (got !== want) { fail(`cleanDomain(${JSON.stringify(input)}) returned ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); bad++; }
  }
  if (!bad) ok(`the domain sieve handles all ${cases.length} cases`);
}

// 8. Nothing changes the machine outside lib/act.js, and the server is loopback-only.
//    The old check was one regex for `execFile('rm'`; it could not see `run('kill', …)`,
//    which is exactly the shape every command here takes. This one knows the shapes the
//    codebase actually uses, and it is run against planted samples first, because a
//    checker that has never failed proves nothing.
const STATE_CHANGING = [
  [/\b(?:run|sh|execFile|execFileSync|spawn|spawnSync|exec|execSync)\(\s*['"`](?:\/usr\/bin\/|\/bin\/|\/usr\/sbin\/)?(kill|killall|pkill|xcrun|trash|rm|rmdir|sudo|purge|shutdown|reboot)\b/, 'runs a state-changing command'],
  // These two are read here every day, so only their READING verbs are allowed.
  [/\brun\(\s*['"]networksetup['"],\s*\[\s*['"](?!-list|-get)/, 'changes the network settings'],
  [/\brun\(\s*['"]tmutil['"],\s*\[\s*['"](?!destinationinfo|latestbackup|listbackups|listlocalsnapshots|machinedirectory)/, 'changes Time Machine'],
  [/\b(?:run|execFile|spawn)\(\s*['"]osascript['"][^)]*\bquit\b/, 'asks an app to quit'],
  [/\b(?:run|sh)\(\s*['"`][^'"`]*\b(?:kill|killall|pkill|simctl\s+shutdown|rm\s+-|sudo)\b/, 'runs a state-changing shell line'],
  [/\brun\(\s*['"]launchctl['"],\s*\[\s*['"](?!list['"])/, 'changes a launchd job'],
  [/\bprocess\.kill\(\s*[^,()]+(?:\)|,(?!\s*0\s*\))[^)]*\))/, 'signals a pid'],
];
function stateChangingIn(src) {
  // Comments say what a command does; only code runs it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, '')).join('\n');
  return STATE_CHANGING.filter(([re]) => re.test(code)).map(([, why]) => why);
}

function safety() {
  const samples = [
    "await run('kill', ['-9', pid]);", "run('/bin/rm', ['-rf', p])", "execFile('sudo', ['purge'])",
    "run('osascript', ['-e', 'tell application id \"x\" to quit'])", "sh(`kill ${pid}`)",
    "process.kill(pid, 'SIGKILL')", "process.kill(pid)", "run('launchctl', ['bootout', 'gui/501/x'])",
    "run('xcrun', ['simctl', 'shutdown', 'all'])", "run('networksetup', ['-setdnsservers', 'Wi-Fi', 'Empty'])",
    "run('tmutil', ['deletelocalsnapshots', '/'])",
  ];
  const missed = samples.filter((s) => !stateChangingIn(s).length);
  const clean = ["run('launchctl', ['list'])", "process.kill(pid, 0)", "run('networksetup', ['-getdnsservers', n])", "run('tmutil', ['latestbackup'])", "run('osascript', ['-e', script, title])", "// run('kill', [pid])"];
  const flagged = clean.filter((s) => stateChangingIn(s).length);
  if (!missed.length && !flagged.length) ok(`the state-change detector catches all ${samples.length} planted commands and none of the ${clean.length} readings`);
  else fail('the state-change detector is wrong', `missed: ${missed.join(' | ')} flagged: ${flagged.join(' | ')}`);

  const files = ['server.js', ...libFiles(), 'bin/reckon', 'bin/report.js', 'bin/scan.js'].filter((f) => fs.existsSync(path.join(ROOT, f)));
  let dirty = 0;
  for (const f of files) {
    if (f === 'lib/act.js') continue;
    const why = stateChangingIn(read(f));
    if (why.length) { fail(`${f} ${why.join(', ')} — only lib/act.js may, from its table`); dirty++; }
  }
  if (!dirty) ok(`no file but lib/act.js runs a command that changes the machine (${files.length - 1} files read)`);
  // And lib/act.js does run them only through lib/sh.js run() — no shell, no exec.
  const act = read('lib/act.js');
  if (/require\('\.\/sh'\)/.test(act) && !/child_process|\bsh\(|shell\s*:\s*true/.test(act)) ok('lib/act.js runs its commands through lib/sh.js run(), never through a shell');
  else fail('lib/act.js reaches for a shell or for child_process directly');

  const s = read('server.js');
  if (s.includes('127.0.0.1') && s.includes('403')) ok('the server refuses non-loopback callers');
  else fail('the server does not check where the connection came from');
  if (/listen\(\s*PORT\s*,\s*'127\.0\.0\.1'/.test(s)) ok('the server listens on 127.0.0.1 only');
  else fail('the server may be listening on every interface');
}

// 9. Nothing personal to the machine that built this is baked into the source.
//
//    Two shapes, because a port brings a second one with it. The Windows
//    pattern is deliberately narrow: it looks for a profile directory under a
//    drive letter, not for any absolute Windows path. C:\Windows is where the
//    operating system lives on every machine and says nothing about whose
//    machine it is — refusing it would push the code into building system
//    paths out of string fragments, which is worse.
function noHardcodedPaths() {
  const files = [...libFiles(), 'server.js', 'web/app.js'];
  const suspect = [
    [/\/Users\/(?!\[)[a-z]/i, 'a macOS home directory'],
    [/\/home\/(?!\[)[a-z]/i, 'a Linux home directory'],
    [/[A-Za-z]:[\\/]+Users[\\/]+(?!\[)[A-Za-z0-9_.$-]/, 'a Windows profile directory'],
    [/%USERPROFILE%[\\/]+(?!\[)[A-Za-z0-9_.-]/i, 'an expanded Windows profile path'],
  ];
  let dirty = 0;
  for (const f of files) {
    const text = read(f);
    for (const [re, what] of suspect) {
      const m = text.match(re);
      if (m) { fail(`${f} contains ${what}`, m[0]); dirty++; }
    }
  }
  if (!dirty) ok('no hardcoded home or profile directory anywhere in the source');
}

// The binary is what a tester actually runs, and for a while it had exactly one
// behaviour no matter what they typed: `reckon report` started the server, which
// never returns. CI read that as a hang; a person reads it as a frozen window.
// This asserts the bundle carries the report and dispatches on the argument,
// without needing the network the real build needs.
function packagedBundle() {
  let buildSea;
  try { buildSea = require(path.join(ROOT, 'build/build-sea.js')); }
  catch (e) { return fail('build/build-sea.js does not load', e.message); }
  if (typeof buildSea.buildMainScript !== 'function') return fail('build-sea.js no longer exports buildMainScript, so the bundle cannot be checked here');
  let src;
  try { src = buildSea.buildMainScript(); } catch (e) { return fail('the bundle could not be generated', e.message); }
  try { new (require('node:vm').Script)(src); ok('the packaged bundle is syntactically valid'); }
  catch (e) { return fail('the packaged bundle is not valid JavaScript', e.message); }
  for (const [needle, what] of [
    ['"bin/report"', 'bin/report.js is bundled'],
    ["subcommand === 'report'", 'the binary dispatches on its argument'],
    ['"server"', 'server.js is bundled'],
  ]) {
    if (src.includes(needle)) ok(what);
    else fail(`the packaged bundle is missing: ${what}`);
  }
}

// The target list is the product's judgement made concrete, and until now no
// check ever loaded it for a platform other than the host — so a Windows target
// list could throw, or claim something disposable with no account of what is
// lost, and every test still passed.
function targetLists() {
  const platformPath = path.join(ROOT, 'lib/platform');
  for (const id of ['darwin', 'win32']) {
    let targets;
    try {
      delete require.cache[require.resolve(platformPath)];
      delete require.cache[require.resolve(path.join(platformPath, id + '.js'))];
      const real = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: id, configurable: true });
      process.env.LOCALAPPDATA = process.env.LOCALAPPDATA || 'C:\\Users\\test\\AppData\\Local';
      process.env.APPDATA = process.env.APPDATA || 'C:\\Users\\test\\AppData\\Roaming';
      targets = require(platformPath).knownCacheTargets();
      Object.defineProperty(process, 'platform', real);
      delete require.cache[require.resolve(platformPath)];
    } catch (e) {
      fail(`knownCacheTargets() throws on ${id}`, e.message);
      continue;
    }
    if (!Array.isArray(targets) || !targets.length) { fail(`${id} returned no cache targets`); continue; }
    const everyday = targets.filter((t) => t.everyday);
    const bad = [];
    for (const t of targets) {
      if (!t.id || !t.path || !t.label) bad.push(`${t.id || '(no id)'}: missing id/path/label`);
      if (!t.lose) bad.push(`${t.id}: no account of what is lost`);
      if (!['disposable', 'yours', 'unknown'].includes(t.verdict)) bad.push(`${t.id}: verdict '${t.verdict}'`);
      // A verdict of "cannot judge" must not ship a command: offering one is
      // recommending an action the tool just said it could not justify.
      if (t.verdict !== 'disposable' && t.command) bad.push(`${t.id}: verdict '${t.verdict}' but carries a command`);
    }
    const ids = targets.map((t) => t.id);
    const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
    if (dupes.length) bad.push(`duplicate ids: ${[...new Set(dupes)].join(', ')}`);
    if (bad.length) fail(`${id} target list has ${bad.length} problem(s)`, bad.slice(0, 4).join('; '));
    else ok(`${id}: ${targets.length} targets, ${everyday.length} everyday, all well-formed`);
    if (!everyday.length) fail(`${id} has no everyday targets — a machine that never ran npm would see almost nothing`);
  }
}

/* The Internet tab's two promises, in test form. Both were written down in
   lib/network.js and neither one is enforced by anything a reader can see, so
   a refactor could break either without a symptom on the screen:

     1. collect() runs on tab open. If it ever calls the paid capabilities,
        opening a tab starts a transfer that costs real money on a hotspot.
     2. Every address it pings is one this machine was ALREADY configured to
        use. An earlier draft pinged 1.1.1.1 on every open — a third party the
        user never chose, and it made this project's own privacy page untrue.

   The test installs a fake platform under require.cache, so it runs the same
   on a laptop as on a CI runner with no network at all. */
async function networkPromises() {
  const platPath = require.resolve('../lib/platform');
  const dnsPath = require.resolve('../lib/dns');
  const netPath = require.resolve('../lib/network');
  const saved = [platPath, dnsPath, netPath].map((k) => [k, require.cache[k]]);

  const pinged = [];
  let paidCalls = 0;
  const CONFIGURED = ['192.168.1.1', '9.9.9.9'];
  require.cache[platPath] = { id: platPath, loaded: true, exports: {
    id: 'fake', label: 'fake', supported: true,
    defaultRoute: async () => ({ interface: 'en0', gateway: '192.168.1.1', kind: 'wi-fi', hardwarePort: 'Wi-Fi' }),
    linkInterfaces: async () => [{ name: 'en0', kind: 'wi-fi', ipv4: '192.168.1.50' }],
    pingHost: async (ip) => { pinged.push(ip); return { sent: 5, received: 5, lossPct: 0, avgMs: 9, minMs: 8, maxMs: 11, stddevMs: 1 }; },
    speedTest: async () => { paidCalls++; return { downBps: 1e8, upBps: 1e7, responsivenessRpm: 900 }; },
    radioLink: async () => { paidCalls++; return { rateMbps: 600, phyFamily: 'ax', widthMHz: 80, mcs: 11, rssiDbm: -50, noiseDbm: -90 }; },
  } };
  require.cache[dnsPath] = { id: dnsPath, loaded: true, exports: {
    collect: async () => ({ effective: { ips: CONFIGURED, intercepted: false, interceptedBy: null }, health: [], dead: [], slow: [] }),
  } };
  delete require.cache[netPath];

  try {
    const net = require('../lib/network');
    const d = await net.collect();

    if (paidCalls === 0) ok('opening the tab runs neither paid reading');
    else fail('opening the tab runs a paid reading', `${paidCalls} call(s) to speedTest/radioLink from collect()`);

    const allowed = new Set(['192.168.1.1', ...CONFIGURED]);
    const strangers = pinged.filter((ip) => !allowed.has(ip));
    if (!strangers.length) ok(`every address pinged was already configured (${pinged.join(', ')})`);
    else fail('it contacted an address nobody configured', strangers.join(', '));

    if (d.cost && d.cost.speed && d.cost.speed.data) ok('the price of the speed test is in the payload, for the screen to print');
    else fail('the payload carries no cost for the speed test');

    if (d.verdict && d.verdict.headline) ok('a verdict is always produced — the tab opens with a decision');
    else fail('collect() produced no verdict');

    // A finding with no fix is a diagnosis, which this panel does not ship.
    const mute = (d.findings || []).filter((f) => f.serious && !f.fix);
    if (!mute.length) ok('no serious finding is shipped without a fix');
    else fail('a serious finding has no fix', mute.map((f) => f.id).join(', '));
  } catch (e) {
    fail('lib/network.js threw during collect()', String(e && e.message));
  } finally {
    for (const [k, v] of saved) { if (v) require.cache[k] = v; else delete require.cache[k]; }
    delete require.cache[netPath];
  }

  // The paid routes must be POST. A GET is something a browser can be made to
  // do by a link, a prefetch or a history restore; spending somebody's data
  // cap must take a deliberate action.
  const srv = read('server.js');
  for (const r of ['/api/network/speed', '/api/network/radio']) {
    const line = srv.split('\n').find((l) => l.includes(`'${r}'`));
    if (line && /req\.method === 'POST'/.test(line)) ok(`${r} is POST-only`);
    else fail(`${r} is reachable without POST`, line ? line.trim() : 'route not found');
  }
  const cheap = srv.split('\n').find((l) => l.includes("'/api/network'") && !l.includes('speed') && !l.includes('radio'));
  if (cheap && !/POST/.test(cheap)) ok('/api/network — the cheap read — needs no ceremony');
  else fail('the cheap read is missing or gated');
}

/* The class of bug that took the Memory tab down on Windows: lib/platform
   returns null to mean "this system does not publish that counter", the screen
   treated it as a number, and `.toLocaleString()` on null killed the tab. The
   panel ran on the machine it was written on, so nothing caught it here.

   This renders every tab inside a fake DOM against a payload where every field
   the contract is allowed to null IS null, and where the system process group
   carries a Windows label rather than a macOS one. A tab that throws fails.
   The DOM is fake, which is the point — what breaks in this class is
   arithmetic and property access on the data, not layout. */
function crossPlatformRender() {
  const vm = require('node:vm');
  const no = () => ({ setAttribute() {}, append() {}, appendChild() {}, prepend() {}, addEventListener() {},
    style: {}, dataset: {}, classList: { add() {}, remove() {} }, childNodes: [], replaceWith() {}, remove() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 10 }),
    querySelector: () => no(), querySelectorAll: () => [], hidden: false,
    get textContent() { return ''; }, set textContent(v) {}, get innerHTML() { return ''; }, set innerHTML(v) {} });
  const ctx = {
    console: { log() {}, error() {} }, window: {}, Date, Math, JSON, Promise, setTimeout,
    Set, Map, Array, Object, Number, String, RegExp, Error, isNaN, parseInt, parseFloat, Infinity,
    document: { createElement: no, createElementNS: no, createTextNode: no, body: no(),
      querySelector: () => no(), querySelectorAll: () => [], addEventListener() {} },
    addEventListener() {}, innerWidth: 1200, location: { hash: '' },
    navigator: { platform: 'Win32', userAgent: 'Windows' },
    fetch: () => Promise.resolve({ ok: true, json: () => ({ hasCache: false }) }),
  };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ['web/charts.js', 'web/app.js']) {
    try { vm.runInContext(read(f), ctx, { filename: f }); }
    catch (e) { return fail('the front end did not load in the fake DOM', e.message); }
  }

  const GB = 1073741824;
  // Every value here that is null is null BY CONTRACT on at least one supported
  // platform. Filling any of them with a zero is what this test exists to stop.
  const light = {
    memory: {
      totalBytes: 8 * GB,
      vm: { wired: GB, active: 2 * GB, compressed: 0, inactive: GB, free: 3 * GB,
        compressions: null, decompressions: null, swapins: null, swapouts: null },
      swap: null,                                   // a machine with the page file off
      groups: [
        { name: 'Windows (system)', rssKB: 900000, n: 120, cpu: 2 },
        { name: 'Opera', rssKB: 700000, n: 14, cpu: 5 },
      ],
      processCount: 134, rssSumKB: 1600000, note: 'note', at: 1,
    },
    volume: { usedKB: 100000000, freeKB: 50000000 },
    history: [], opened: { groups: null }, at: 1,
  };
  const cache = {
    hasCache: true, at: 1, volume: light.volume, memory: light.memory,
    panel: { totalGB: 0, out: [], stay: [] },
    checks: { items: [] },
    docker: { running: false, logs: [], folders: null, counted: null },
    repos: [], hidden: [], home: [],
  };
  const net = {
    at: 1, supported: true, problems: [], route: null, interfaces: [], anchors: [],
    pingCount: 5, noOffNetworkHost: true, resolvers: null, resolverError: null,
    tunnels: [], history: [], radio: null, speed: null,
    cost: { speed: { seconds: 's', data: 'd', warning: null }, radio: { seconds: 's', data: 'd', warning: null } },
    findings: [], verdict: { headline: 'h', summary: 's', more: 'm', link: 'l' }, unmeasured: [],
  };
  const dnsPayload = {
    services: [{ service: 'Wi-Fi', ips: [], inherited: true }],
    effective: { ips: [], intercepted: false, interceptedBy: null },
    warnings: [], providers: [], health: [], dead: [], slow: [], stacked: false, repair: null,
  };

  for (const [name, arg] of [['memory', light], ['overview', cache], ['disk', cache],
    ['checks', cache], ['internet', net], ['dns', dnsPayload]]) {
    const fn = ctx[name];
    if (typeof fn !== 'function') { fail(`${name}() is not reachable`); continue; }
    try { fn(arg); ok(`${name} survives a payload where every nullable field is null`); }
    catch (e) { fail(`${name} throws when the platform could not measure something`, e.message); }
    try { fn(null); ok(`${name} survives having no payload at all`); }
    catch (e) { fail(`${name} throws on a missing payload`, e.message); }
  }

  // The system process group is named for the platform. A hardcoded
  // 'macOS (system)' made the Memory tab tell a Windows user to quit Windows.
  // Comments are stripped first: the fix for this very bug carries the old
  // string in a comment explaining why it is gone, and a test that cannot tell
  // a comment from code fails on its own documentation.
  const app = read('web/app.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const hard = app.match(/'macOS \(system\)'/g);
  if (!hard) ok("the front end does not hardcode 'macOS (system)'");
  else fail("the front end hardcodes 'macOS (system)'", `${hard.length} occurrence(s) — a Windows machine labels it 'Windows (system)'`);
}

/* `draw` is a local of the init function, not a global: a top-level function that
   calls it throws ReferenceError after the work is done. sendBlocklist did, and
   redrew the wrong tab. Every top-level function in app.js must stay off it. */
function noStrayDraw() {
  const app = read('web/app.js');
  const body = (app.match(/async function sendBlocklist[\s\S]*?\n}\n/) || [''])[0];
  if (!body) fail('sendBlocklist is missing from web/app.js');
  else if (/\bdraw\(/.test(body)) fail('sendBlocklist calls draw(), which is not in scope there');
  else if (!/\bdns\(state\.dns\)/.test(body)) fail('sendBlocklist does not redraw the DNS tab');
  else ok('sendBlocklist redraws the DNS tab without the out-of-scope draw()');
}

/* Grouping ten cache folders into one row is a readability win that can hide a
   warning, which would make it a safety loss. These assert the merge keeps
   every guard it inherited, and that a merged number still shows its parts. */
function grouping() {
  const { build, classify, KINDS } = require('../lib/decisions');

  const t = (over) => ({ id: 'x', label: 'Chrome cache', kb: 1048576, path: 'C:\\a',
    verdict: 'disposable', lose: 'nothing', command: 'Remove-Item -LiteralPath "C:\\a"',
    group: 'browser-chrome', groupLabel: 'Chrome caches', groupLose: 'nothing at all', ...over });

  const one = build({ docker: null, targets: [
    t({ id: 'a', kb: 2097152, path: 'C:\\a', command: 'RM A' }),
    t({ id: 'b', kb: 1048576, path: 'C:\\b', label: 'Chrome compiled-script cache', command: 'RM B' }),
  ], repos: { repos: [] } });
  const row = one.out.find((d) => /chrome/i.test(d.id));
  if (one.out.length === 1) ok('two cache folders of one browser become one row');
  else fail('grouping did not collapse the rows', `${one.out.length} rows`);
  if (row && row.kb === 3145728) ok('the merged row carries the sum of its parts');
  else fail('the merged size is wrong', row ? String(row.kb) : 'no row');
  // Half the folders deleted while the row claims the size of all of them is
  // the panel reporting work it did not describe.
  if (row && /RM A/.test(row.command) && /RM B/.test(row.command)) ok('every member\'s command survives the merge');
  else fail('the merge dropped a command', row ? row.command : '');
  if (row && /2 folders/.test(row.proof)) ok('the merged proof names how many folders it added up');
  else fail('the merged proof does not show its parts', row ? row.proof : '');

  // THE ONE THAT MATTERS.
  const risky = build({ docker: null, targets: [
    t({ id: 'a', kb: 2097152, path: 'C:\\a' }),
    t({ id: 'b', kb: 1048576, path: 'C:\\b', symlinks: [{ link: 'C:\\else' }] }),
  ], repos: { repos: [] } });
  const r2 = risky.out.find((d) => /chrome/i.test(d.id));
  if (r2 && r2.warning && /symlink/i.test(r2.warning)) ok('a symlink on ONE member warns the whole group');
  else fail('grouping swallowed a symlink warning', r2 ? String(r2.warning) : 'no row');
  if (r2 && r2.confidence !== 'high') ok('a group is only as certain as its least certain member');
  else fail('the merged row claims high confidence over a warned member');

  const unproven = build({ docker: null, targets: [
    t({ id: 'a', kb: 2097152, path: 'C:\\a', linksProven: true }),
    t({ id: 'b', kb: 1048576, path: 'C:\\b', linksProven: false }),
  ], repos: { repos: [] } });
  const r3 = unproven.out.find((d) => /chrome/i.test(d.id));
  if (r3 && /could not be completed/.test(r3.proof)) ok('an unproven link search on one member is stated for the group');
  else fail('grouping turned an unproven all-clear into a proven one', r3 ? r3.proof : '');

  // A target whose kind falls through to 'other' is a category the pie cannot
  // name, and the pie is the chart that answers "what KIND of thing is this".
  const platforms = [['darwin', require('../lib/platform/darwin')]];
  try { platforms.push(['win32', require('../lib/platform/win32')]); } catch {}
  for (const [name, mod] of platforms) {
    const orphans = mod.knownCacheTargets().filter((x) => classify(x.id) === 'other');
    if (!orphans.length) ok(`${name}: every target lands in a kind the pie can name`);
    else fail(`${name}: ${orphans.length} target(s) fall through to 'other'`, orphans.map((x) => x.id).join(', '));
  }
  if (Object.keys(KINDS).length >= 10) ok(`${Object.keys(KINDS).length} kinds defined`);
}

/* The batch measurement path only ever executes on Windows, which is the one
   platform this cannot be run on here. So it gets exercised against a fake
   platform instead — otherwise the only test it ever gets is somebody else's
   machine.

   The distinction that matters: a root that is ABSENT must be skipped
   silently, and a root that EXISTS BUT COULD NOT BE MEASURED must be reported
   as unmeasured. Collapsing those two is how a disk full of junk reports
   nothing and a person believes it. */
async function batchSizing() {
  const path = require('node:path');
  const platPath = require.resolve('../lib/platform');
  const diskPath = require.resolve('../lib/disk');
  const saved = [platPath, diskPath].map((k) => [k, require.cache[k]]);

  const FLOOR = 51200;
  const targets = [
    { id: 'big', path: 'X:\\big', label: 'Big', verdict: 'disposable', lose: '', command: 'rm' },
    { id: 'small', path: 'X:\\small', label: 'Small', verdict: 'disposable', lose: '', command: 'rm' },
    { id: 'absent', path: 'X:\\absent', label: 'Absent', verdict: 'disposable', lose: '', command: 'rm' },
    { id: 'refused', path: 'X:\\refused', label: 'Refused', verdict: 'disposable', lose: '', command: 'rm' },
  ];
  let batchCalls = 0, singleCalls = 0, existsCalls = 0;
  const fake = {
    id: 'fake', label: 'fake', supported: true,
    knownCacheTargets: () => targets.map((t) => ({ ...t })),
    pathExists: async () => { existsCalls++; return true; },
    dirSizeKB: async () => { singleCalls++; return FLOOR * 2; },
    realSizeKB: async () => FLOOR * 2,
    dirSizesKB: async (paths) => {
      batchCalls++;
      const out = {};
      for (const p of paths) {
        if (/absent/.test(p)) continue;              // not there at all
        if (/refused/.test(p)) { out[p] = null; continue; }  // there, unreadable
        out[p] = /big/.test(p) ? FLOOR * 40 : 1024;
      }
      return out;
    },
  };
  require.cache[platPath] = { id: platPath, loaded: true, exports: fake };
  delete require.cache[diskPath];

  try {
    const disk = require('../lib/disk');
    const { list, unmeasured } = await disk.targets();

    if (batchCalls === 1) ok('every target is measured in ONE call, not one call each');
    else fail('the batch path did not run', `${batchCalls} batch call(s), ${singleCalls} single`);
    if (existsCalls === 0) ok('the batch removes the separate existence check too');
    else fail('it still tests each path separately', `${existsCalls} calls`);

    const ids = list.map((x) => x.id);
    if (ids.includes('big') && !ids.includes('small')) ok('over the floor is kept, under it is dropped');
    else fail('the floor is not applied through the batch', ids.join(', '));
    if (!ids.includes('absent')) ok('a root that is not there is skipped silently');
    else fail('an absent root became a row');
    // THE ONE THAT MATTERS: unreadable is not empty.
    if (unmeasured.some((u) => u.id === 'refused')) ok('a root that exists but could not be read is reported as unmeasured');
    else fail('an unreadable folder was silently treated as empty', JSON.stringify(unmeasured));
    if (!ids.includes('refused')) ok('and it is not counted in the total');
    else fail('an unmeasured folder reached the total');

    // A CHUNK THAT DIES MUST NOT TAKE THE OTHERS WITH IT. One call for
    // everything means one timeout for everything, and a single slow root —
    // Windows.old, the recycle bin — would have made the panel report an
    // empty machine.
    const many = [];
    for (let i = 0; i < 40; i++) {
      many.push({ id: `t${i}`, path: `X:\\t${i}`, label: `T${i}`, verdict: 'disposable', lose: '', command: 'rm' });
    }
    // The 20th root is in the second chunk of 16 and poisons that whole call.
    let poisoned = 0;
    fake.knownCacheTargets = () => many.map((t) => ({ ...t }));
    fake.dirSizesKB = async (paths) => {
      if (paths.some((p) => /\bt20$/.test(p))) { poisoned++; return null; }
      return Object.fromEntries(paths.map((p) => [p, FLOOR * 40]));
    };
    singleCalls = 0; existsCalls = 0;
    delete require.cache[diskPath];
    const r3 = await require('../lib/disk').targets();
    if (poisoned === 1) ok('one chunk failed, as the test intended');
    if (r3.list.length === 40) ok('a chunk that dies is re-measured one at a time — all 40 still counted');
    else fail('a failed chunk lost its targets', `${r3.list.length} of 40`);
    if (singleCalls === 16 && existsCalls === 16) ok('and ONLY that chunk pays the slow path');
    else fail('the fallback was wider than the failed chunk', `${singleCalls} single calls`);

    // A platform without the capability must behave exactly as before.
    fake.knownCacheTargets = () => targets.map((t) => ({ ...t }));
    delete fake.dirSizesKB;
    delete require.cache[diskPath];
    const disk2 = require('../lib/disk');
    singleCalls = 0; existsCalls = 0;
    const r2 = await disk2.targets();
    if (singleCalls === 4 && existsCalls === 4) ok('a platform without the capability falls back to one at a time');
    else fail('the fallback path changed', `${singleCalls} sizes, ${existsCalls} exists`);
    if (r2.list.length === 4) ok('and still measures every target');
    else fail('the fallback lost targets', String(r2.list.length));
  } catch (e) {
    fail('lib/disk.js threw while measuring in batch', String(e && e.message));
  } finally {
    for (const [k, v] of saved) { if (v) require.cache[k] = v; else delete require.cache[k]; }
    delete require.cache[diskPath];
  }
}

/* A correct command pasted into the wrong shell fails with an error that does
   not name the cause. This asserts the panel always says which shell, and that
   the commands a platform prints are actually written for the shell it names. */
function whichShell() {
  const platforms = [['darwin', require('../lib/platform/darwin')]];
  try { platforms.push(['win32', require('../lib/platform/win32')]); } catch {}

  for (const [name, mod] of platforms) {
    const sh = mod.COMMAND_SHELL;
    if (sh && sh.name && sh.open) ok(`${name} declares which shell its commands are for (${sh.name})`);
    else { fail(`${name} does not declare a shell for its commands`); continue; }

    // Windows is the platform where getting it wrong is silent and likely:
    // searching "prompt" offers Command Prompt, and every command here is
    // PowerShell. It must name the one to avoid.
    if (name === 'win32') {
      if (sh.notThis) ok('win32 names the shell that will NOT work');
      else fail('win32 does not warn about Command Prompt');
      if (sh.openAdmin) ok('win32 says how to open it as administrator');
      else fail('win32 has commands needing administrator and no way to say how');

      // PowerShell cmdlets in a command the panel claims is PowerShell.
      const cmds = mod.knownCacheTargets().map((t) => t.command).filter((c) => c && /^[A-Z]/m.test(c));
      const posix = cmds.filter((c) => /^\s*(rm|rmdir|del)\s/m.test(c));
      if (!posix.length) ok('no win32 command is a unix one in disguise');
      else fail('a win32 command is not PowerShell', posix[0].slice(0, 60));
    }
  }

  // The screen has to actually use it. A declaration nothing reads is a comment.
  const app = read('web/app.js');
  if (/shellNote\(\)/.test(app) && /commandBlock\([\s\S]{0,200}?shellNote/.test(app.replace(/\n/g, ' '))
      || /pre, shellNote\(\)/.test(app)) ok('every command block carries the shell note');
  else fail('the shell note is declared but not attached to the command blocks');
  if (/notThis/.test(app)) ok('the screen names the shell that will not work');
  else fail('the screen never mentions the wrong shell');
}

/* The row that says how much committed work has no copy off this disk. The
   guard that matters: git failing to answer must read as "could not tell", not
   as "nothing is at risk". A clean screen for the wrong reason is the failure
   this whole panel is built against. */
async function onlyHere() {
  const checks = require('../lib/checks');
  // Under the real home directory, because that is where repositories actually
  // are and it is the only shape that tests the shortener. A made-up path
  // outside it has no username to hide and would pass for the wrong reason.
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const r = (over) => ({ name: 'x', path: `${home}/www/x`, git: true, days: 1,
    lastCommit: '2026-01-01', hasRemote: true, onlyHere: 0, ...over });
  const run = async (repos) => {
    const d = await withStubbedPlatform((checks) => checks.collect({ unmeasuredTargets: [], repos: { repos } }));
    return d.items.find((i) => i.id === 'only-here');
  };

  const none = await run([r({ name: 'a' }), r({ name: 'b' })]);
  if (none && !none.serious && /exists somewhere else/i.test(none.title)) ok('all pushed reads as safe, and still gets a row');
  else fail('a fully pushed machine got the wrong row', none ? none.title : 'no row');

  // THE ONE THAT MATTERS.
  const blind = await run([r({ name: 'a', onlyHere: null }), r({ name: 'b', onlyHere: null })]);
  if (blind && /Could not tell/i.test(blind.title)) ok('git failing to answer reads as "could not tell", never as "nothing at risk"');
  else fail('an unanswerable repo was reported as safe', blind ? blind.title : 'no row');

  const risky = await run([
    r({ name: 'sim', onlyHere: 261, hasRemote: false, days: 118 }),
    r({ name: 'ahead', onlyHere: 5, hasRemote: true, days: 0 }),
  ]);
  if (risky && /266 commits in 2 repositories/.test(risky.title)) ok('the count is the sum across repositories');
  else fail('the count is wrong', risky ? risky.title : 'no row');
  if (risky && risky.serious) ok('real history with no copy is serious');
  else fail('266 unbacked commits were not marked serious');
  // A repository with no remote loses EVERYTHING, not just what is unpushed.
  // Blurring the two would understate the one that matters more.
  if (risky && /no remote at all/.test(risky.found)) ok('a repo with no remote is named as such, not as merely behind');
  else fail('the row does not distinguish "no remote" from "behind"');
  if (risky && /bundle create/.test(risky.fix) && /git push/.test(risky.fix)) ok('the fix covers both cases, each with its own command');
  else fail('the fix does not cover both cases', risky ? risky.fix : '');
  // Commands reach the screen; a username must not.
  if (risky && !risky.fix.includes(home) && /~\/www\/x/.test(risky.fix)) ok('the commands wear ~ and carry no username');
  else fail('a home directory leaked into the fix', risky ? risky.fix : '');

  const small = await run([r({ name: 'a', onlyHere: 1, hasRemote: true })]);
  if (small && !small.serious) ok('a single unpushed commit is a nudge, not an alarm');
  else fail('one commit was escalated to serious');
}

/* The three things this round added, and the line each one must not cross. */
function lastRound() {
  const scan = require('../lib/scan');
  const GB = 1048576;   // in KB

  // --- what changed between two scans ------------------------------------
  const mk = (at, freeKB, out) => ({ at, volume: { freeKB, usedKB: 100 * GB }, panel: { out } });
  const prev = mk(1000, 100 * GB, [
    { id: 'a', title: 'Cache A', kb: 10 * GB }, { id: 'b', title: 'Cache B', kb: 2 * GB },
    { id: 'zero', title: 'Empty', kb: 0 },
  ]);
  const now = mk(1000 + 86400000 * 2, 112 * GB, [
    { id: 'b', title: 'Cache B', kb: 2 * GB }, { id: 'c', title: 'Cache C', kb: 1 * GB },
  ]);
  const ch = scan.changed(now, prev);

  if (ch && ch.freedKB === 12 * GB) ok('free space is the difference between two readings of the volume');
  else fail('the freed figure is wrong', ch ? String(ch.freedKB) : 'no result');
  if (ch && ch.gone.length === 1 && ch.gone[0].id === 'a') ok('an item that was on the list and is not any more counts as gone');
  else fail('gone is wrong', ch ? JSON.stringify(ch.gone) : '');
  // An item measured at zero was never on the list; calling it "gone" would
  // inflate the count with things nobody did anything about.
  if (ch && !ch.gone.some((g) => g.id === 'zero')) ok('an item that measured zero is not counted as gone');
  else fail('a zero-size item was reported as removed');
  if (ch && ch.appeared.length === 1 && ch.appeared[0].id === 'c') ok('something new since then is named too');
  else fail('appeared is wrong', ch ? JSON.stringify(ch.appeared) : '');
  if (ch && ch.goneKB === 10 * GB) ok('the gone total uses the size measured when it was last seen');
  else fail('goneKB is wrong', ch ? String(ch.goneKB) : '');
  if (ch && ch.days === 2) ok('the gap is stated in days');
  else fail('the gap is wrong', ch ? String(ch.days) : '');
  if (scan.changed(now, null) === null) ok('no previous scan means no comparison, not a comparison against zero');
  else fail('a missing previous scan produced a difference anyway');

  // A shrinking disk is as real a reading as a growing one and must not be
  // hidden: somebody whose free space fell needs to see that.
  const worse = scan.changed(mk(2000, 90 * GB, []), prev);
  if (worse && worse.freedKB === -10 * GB) ok('free space going DOWN is reported, not suppressed');
  else fail('a negative change was not reported', worse ? String(worse.freedKB) : '');

  // THE LINE: the screen states two measurements and does not claim to be the
  // cause. Free space moves for reasons that have nothing to do with this tool.
  const app = read('web/app.js');
  if (/not a claim about what caused/.test(app)) ok('the screen says the difference is not attributed to the panel');
  else fail('the panel takes credit for a change it cannot prove it caused');

  // --- progress while scanning -------------------------------------------
  const srv = read('server.js');
  if (/'\/api\/deep\/progress'/.test(srv)) ok('the scan reports what it is doing');
  else fail('there is no way for the screen to read the scan\'s progress');
  if (/progress = null/.test(srv)) ok('and stops reporting the moment the scan ends');
  else fail('progress is never cleared, so the screen could poll forever');
  if (/Math\.min\(94/.test(app)) ok('the progress bar cannot reach the end before the answer does');
  else fail('the progress bar can claim to be finished while the scan is not');
  // Pressing a button and having nothing happen is the failure mode this panel
  // exists to eliminate. A scan already in flight is followed, not ignored.
  if (/alreadyRunning[\s\S]{0,400}already running/.test(app)) ok('a scan already in flight is followed, and the screen says so');
  else fail('a second scan request silently restores the old screen');
  if (/const secs = Math\.max/.test(app)) ok('the step shows how long it has been running, so a slow step does not read as frozen');
  else fail('a step that holds for a minute looks identical to a hang');

}

/* checks.collect() reaches through lib/platform, which on a platform with no
   implementation refuses rather than guesses. That is correct behaviour and it
   is also why these tests took CI down on Linux the first time they ran there:
   a test that only works on the machine it was written on tests nothing about
   the ones it ships to. Both of these now run against a stubbed platform, on
   any OS. */
function withStubbedPlatform(fn) {
  const platPath = require.resolve('../lib/platform');
  const checksPath = require.resolve('../lib/checks');
  const saved = [platPath, checksPath].map((k) => [k, require.cache[k]]);
  require.cache[platPath] = { id: platPath, loaded: true, exports: {
    id: 'fake', label: 'fake', supported: true,
    backupStatus: async () => ({ tool: 'Time Machine', configured: false, latest: null, ageDays: null }),
    volumeUsage: async () => ({ usedKB: 100, freeKB: 100 }),
    memoryStats: async () => ({ totalBytes: 8e9, freeBytes: 4e9, wiredBytes: 1e9, activeBytes: 1e9, inactiveBytes: 1e9, compressedBytes: 0, pageSizeBytes: 4096, compressions: null, decompressions: null, swapins: null, swapouts: null }),
    swapStats: async () => ({ totalMB: 0, usedMB: 0, freeMB: 0 }),
    restartingContainers: async () => [],
    unboundedLogContainers: async () => [],
    failedServices: async () => [],
  } };
  delete require.cache[checksPath];
  return Promise.resolve()
    .then(() => fn(require('../lib/checks')))
    .finally(() => {
      for (const [k, v] of saved) { if (v) require.cache[k] = v; else delete require.cache[k]; }
      delete require.cache[checksPath];
    });
}

/* The README is a promise to somebody who has not run this yet, and a promise
   that has gone stale is worse than no promise. These are the three claims that
   were already false by the time anybody read them: a tab that exists and is
   not listed, "it does not follow up" after follow-up was built, and "macOS
   only" after Windows shipped. Each is now something a test can notice. */
function readmeIsTrue() {
  const readme = read('README.md');
  const html = read('web/index.html');

  const tabs = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  const missing = tabs.filter((t) => !new RegExp(`\\*\\*${t}\\*\\*`, 'i').test(readme));
  if (!missing.length) ok(`all ${tabs.length} tabs are listed in the README`);
  else fail('the README does not list every tab', missing.join(', '));

  // A platform with an implementation must not be described as unsupported.
  const hasWin = fs.existsSync(path.join(ROOT, 'lib/platform/win32.js'));
  if (!hasWin) ok('no win32 implementation, so no claim to check');
  else if (/macOS only/i.test(readme)) fail('win32.js exists and the README still says "macOS only"');
  else ok('the README does not call this macOS-only while win32.js exists');

  if (/does not follow up/i.test(readme) && /scan-previous/.test(read('lib/scan.js'))) {
    fail('the README says it does not follow up, and lib/scan.js keeps a previous scan');
  } else ok('the README and the code agree about whether it follows up');
}

/* The backup row, read the way the screen reads it. An earlier version of this
   test regexed the source file instead and counted three rungs where the screen
   shows four — passing for a reason that had nothing to do with the product.
   Test the output. */
async function backupLadder() {
  const d = await withStubbedPlatform((checks) => checks.collect({ unmeasuredTargets: [], repos: null }));
  const b = d.items.find((i) => i.id === 'backup');
  if (!b) return fail('there is no backup row at all');
  if (!b.fix) {
    // A configured, current backup legitimately has no fix.
    if (/current|configured/i.test(b.title)) return ok('a machine with a working backup needs no fix, and gets none');
    return fail('the backup row has no fix', b.title);
  }
  const rungs = (b.fix.match(/^# \d\./gm) || []).length;
  if (rungs >= 3) ok(`the backup row offers ${rungs} things to do, not one purchase`);
  else fail('the backup row dead-ends on buying a disk', `${rungs} rung(s) in the text shown`);
  if (/is NOT\b|not a backup/i.test(b.fix)) ok('and says which rungs are not really a backup');
  else fail('the ladder presents a sync folder as a backup');
  // The cheapest thing must come first: somebody who stops reading after one
  // line should have read the one they can do today.
  const first = (b.fix.match(/^# 1\..*/m) || [''])[0];
  if (/free|now/i.test(first)) ok('and the first rung is one you can do today, for nothing');
  else fail('the ladder leads with something that costs money', first);
}

/* NOTHING MAY TOUCH THE SEAM AT MODULE SCOPE.
 *
 * lib/platform refuses rather than guesses on a platform it has no
 * implementation for, and a required capability called at require time turns
 * that refusal into "this file cannot be loaded at all". The panel then does
 * not start, on a platform where most of it would have worked.
 *
 * This has now happened twice: once with hostsFilePath(), and once with a
 * home-directory lookup in lib/checks.js that took CI down on Linux while
 * passing on the machine it was written on. The second time is what makes it
 * worth a test rather than a rule.
 *
 * A child process is spawned with process.platform redefined to a platform
 * with no implementation, and every file under lib/ is required in it. Loading
 * must succeed. Running is a different question and not this test's.
 */
function loadsOnAnyPlatform() {
  const { spawnSync } = require('node:child_process');
  const files = libFiles().filter((f) => !/^lib\/platform\/(darwin|win32)/.test(f));
  const script = `
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const bad = [];
    for (const f of ${JSON.stringify(files)}) {
      try { require(require('node:path').join(${JSON.stringify(ROOT)}, f)); }
      catch (e) { bad.push(f + ': ' + String((e && e.message) || e).split('\\n')[0]); }
    }
    console.log(JSON.stringify(bad));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) return fail('could not test loading on an unsupported platform', (r.stderr || '').split('\n')[0]);
  let bad;
  try { bad = JSON.parse(String(r.stdout).trim().split('\n').pop()); }
  catch { return fail('the unsupported-platform probe returned nothing readable', String(r.stdout).slice(0, 120)); }
  if (!bad.length) ok(`all ${files.length} lib files load on a platform with no implementation`);
  else fail(`${bad.length} file(s) run the seam at module scope`, bad.join(' | '));

  // The binary's own entry points, too: `reckon report` on an unsupported
  // platform must produce a report that says so, not a stack trace.
  for (const entry of ['bin/report.js', 'server.js']) {
    const one = spawnSync(process.execPath, ['-e', `
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      try { require(${JSON.stringify(ROOT)} + '/${entry}'); console.log('OK'); }
      catch (e) { console.log('THREW ' + String((e && e.message) || e).split('\\n')[0]); }
    `], { encoding: 'utf8', timeout: 30000 });
    const out = String(one.stdout || '').trim();
    if (out.startsWith('OK')) ok(`${entry} loads on a platform with no implementation`);
    else if (/THREW/.test(out)) fail(`${entry} throws at load on an unsupported platform`, out.slice(0, 110));
    else ok(`${entry} did not load cleanly enough to judge (${out.slice(0, 40) || 'no output'})`);
  }
}

/* RUN THE WHOLE SUITE AGAIN AS A PLATFORM WITH NO IMPLEMENTATION.
 *
 * This exists because of a specific failure: two commits were pushed that
 * passed here and failed in CI, and nobody looked at CI until a third change
 * was ready to tag. The tests were fine; the machine they ran on was the
 * problem. macOS has an implementation, so anything that reaches through the
 * seam works — and on Linux the same call refuses, correctly, and takes the
 * suite down.
 *
 * So the suite runs itself a second time in a child process that declares
 * itself Linux. A test that only passes on the machine it was written on says
 * nothing about the machines it ships to, and now it cannot pretend otherwise
 * without this failing first.
 */
function asUnsupportedPlatform() {
  if (process.env.RECKON_CHECK_CHILD) return;   // this IS the child
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [
    '-e',
    `Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });`
    + ` process.argv[1] = ${JSON.stringify(path.join(ROOT, 'bin/check.js'))};`
    + ` require(process.argv[1]);`,
  ], { encoding: 'utf8', timeout: 180000, env: { ...process.env, RECKON_CHECK_CHILD: '1' } });

  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.status === 0 && /all checks passed/.test(out)) {
    ok('the whole suite passes again on a platform with no implementation');
    return;
  }
  const why = (out.match(/^ {2}FAIL {2}.*/m) || [])[0]
    || (out.match(/^.*(Error|UnsupportedPlatform).*/m) || [])[0]
    || `exit ${r.status}`;
  fail('the suite fails on a platform with no implementation — CI will fail', why.trim().slice(0, 160));
}

// The companion. CONTRIBUTING.md §5 says status is never a colour, and a pet that
// turns red when the machine is struggling is the first thing anyone would draw.
// So the rule is enforced on the drawing itself: every colour it emits must be a
// design token, and the four states must differ by SHAPE, or "uneasy" is just
// "watching" with a label.
function petStatusIsShape() {
  const pet = require(path.join(ROOT, 'web/pet.js'));
  const ids = Object.keys(pet.STATES);
  if (ids.length >= 4) ok(`the companion has ${ids.length} states`);
  else fail(`the companion has ${ids.length} states`, 'resting, watching, uneasy and strained are the contract');

  // pose() is the lantern as numbers, the one thing a native drawing is compared against.
  // It must stay numbers: a string or a NaN in it would be a drawing decision hiding there.
  const bad = [];
  for (let i = 0; i <= 100; i++) {
    for (const [k, v] of Object.entries(pet.pose(i / 100))) {
      if (k === 'glow') { if (v !== null && typeof v !== 'string') bad.push(`${i}: glow`); }
      else if (typeof v !== 'number' || !Number.isFinite(v)) bad.push(`${i}: ${k}=${v}`);
    }
  }
  if (!bad.length) ok('pose() is finite numbers at all 101 levels');
  else fail('pose() holds something that is not a number', bad[0]);

  const drawn = {};
  for (const concept of pet.CONCEPTS) for (const id of ids) drawn[`${concept}/${id}`] = pet.svg(id, 120, concept);
  if (pet.CONCEPTS.length >= 3) ok(`${pet.CONCEPTS.length} candidate creatures, ${Object.keys(drawn).length} drawings`);
  else fail(`only ${pet.CONCEPTS.length} candidate creatures`, 'the owner picks between at least three');

  const loose = [];
  for (const [id, markup] of Object.entries(drawn)) {
    for (const m of markup.matchAll(/(?:fill|stroke)="([^"]+)"/g)) {
      const v = m[1];
      if (v !== 'none' && !v.startsWith('var(--') && !v.startsWith('url(#') && !/^color-mix\(in srgb, var\(--[a-z0-9]+\), var\(--[a-z0-9]+\) \d+%\)$/.test(v)) loose.push(`${id}: ${v}`);
    }
  }
  if (loose.length) fail('the companion uses a colour that is not a design token', loose.join(', '));
  else ok('every colour the companion draws is a design token');

  // The drawing is a string, so nothing stops an element from declaring one
  // attribute twice. Browsers forgive it when a page sets innerHTML; anything that
  // reads the file as XML (a thumbnail, an export, a screenshot tool) refuses the
  // whole drawing. That is how a duplicate `fill` once shipped unnoticed.
  const doubled = [];
  for (const [id, markup] of Object.entries(drawn))
    for (const tag of markup.matchAll(/<[a-zA-Z][^>]*>/g)) {
      const names = [...tag[0].matchAll(/\s([a-zA-Z:-]+)="/g)].map((m) => m[1]);
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) doubled.push(`${id}: ${dup}`);
    }
  if (doubled.length) fail('a companion drawing declares an attribute twice', [...new Set(doubled)].join(', '));
  else ok('no companion drawing declares an attribute twice');

  // The lantern may glow in colour, but never in the palette's red or green: those
  // are the two hues a traffic light teaches people to read as good and bad.
  const trafficLight = Object.entries(drawn).filter(([, m]) => /var\(--s6\)|var\(--s8\)/.test(m)).map(([id]) => id);
  if (trafficLight.length) fail('the companion uses the palette red or green', trafficLight.join(', '));
  else ok('the companion never uses the palette red or green');

  // Within ONE creature, no two states may be the same picture: a state that only
  // changes its label is not a state.
  const same = [];
  for (const concept of pet.CONCEPTS) {
    const seen = new Set();
    for (const id of ids) { const m = drawn[`${concept}/${id}`]; if (seen.has(m)) same.push(`${concept}/${id}`); seen.add(m); }
  }
  if (same.length) fail('two companion states draw the same picture', same.join(', '));
  else ok('no two states of one creature draw the same picture');

  // It moves, and it can be told to stop. The motion is part of the drawing.
  const strained = pet.svg('strained');
  if (/@keyframes pet-shake/.test(strained) && /@keyframes pet-flicker/.test(strained)) ok('the lantern carries its own animation');
  else fail('the lantern has no animation in its markup', 'the drawing is meant to move');
  if (/prefers-reduced-motion:\s*reduce/.test(strained)) ok('the animation stops for prefers-reduced-motion');
  else fail('the animation ignores prefers-reduced-motion', 'a moving companion must be stoppable');

  // The first strained drawing looked crooked. Caught mid-swing, a wide sway is the
  // same picture, so at the top of the scale the lantern must tremble, not swing.
  const swayOf = (input) => Number((pet.svg(input).match(/--sway:([\d.]+)deg/) || [])[1]);
  if (swayOf('strained') <= 2) ok(`the strained lantern sways ${swayOf('strained')} deg at most, so it does not read as crooked`);
  else fail(`the strained lantern sways ${swayOf('strained')} deg`, 'caught mid-swing that reads as a crooked lantern');

  // More strain, faster motion: the tempo is the measurement, not decoration.
  const periodOf = (input) => Number((pet.svg(input).match(/--swingT:([\d.]+)s/) || [])[1]);
  if (periodOf(0.9) < periodOf(0.4) && periodOf(0.4) < periodOf(0.05)) ok('a worse reading moves faster');
  else fail('the tempo does not follow the reading', `${periodOf(0.05)}s, ${periodOf(0.4)}s, ${periodOf(0.9)}s`);

  // From 80 to 100 the lantern is in its last state, and the first version drew the
  // same picture across that whole stretch: the part of the scale that matters most
  // was the part that told you the least. Every step of five must look different.
  const top = [0.8, 0.85, 0.9, 0.95, 1].map((n) => pet.svg(n));
  if (new Set(top).size === top.length) ok('80, 85, 90, 95 and 100 each draw a different lantern');
  else fail('two readings between 80 and 100 draw the same lantern', 'the last stretch must keep changing');
  const rays = (m) => (m.match(/class="pet-ray-l"/) ? m.split('class="pet-ray-r"')[0].split('<path').length - 1 : 0);
  const shakeOf = (n) => Number((pet.svg(n).match(/--shake:([\d.]+)px/) || [])[1]);
  if (rays(pet.svg(1)) > rays(pet.svg(0.8)) && shakeOf(1) > shakeOf(0.85) && shakeOf(0.85) > shakeOf(0.8))
    ok('more rays and a harder tremble as the reading climbs to 100');
  else fail('the top of the scale does not escalate', `rays ${rays(pet.svg(0.8))} -> ${rays(pet.svg(1))}, tremble ${shakeOf(0.8)} -> ${shakeOf(0.85)} -> ${shakeOf(1)}`);
  if (/color-mix\(in srgb, var\(--s2\), var\(--ink\)/.test(pet.svg(1)) && !/color-mix/.test(pet.svg(0.5))) ok('the glow only heats up past 80');
  else fail('the glow heating is wrong', 'it must start at 80 and never touch the calmer states');

  // A measurement maps to a state, so the real reading can drive it directly.
  const names = [0.05, 0.3, 0.6, 0.95].map((n) => pet.resolve(n).label).join(',');
  if (names === 'resting,watching,uneasy,strained') ok('a measurement from 0 to 1 picks the right state');
  else fail('a measurement picks the wrong state', names);

  try { pet.svg('resting', 120, 'nonsense'); fail('an unknown creature must throw, not draw a blank'); }
  catch (e) { if (e instanceof TypeError) ok('an unknown creature throws instead of drawing nothing'); else throw e; }

  try { pet.svg('nonsense'); fail('an unknown state must throw, not draw a blank'); }
  catch (e) { if (e instanceof TypeError) ok('an unknown state throws instead of drawing nothing'); else throw e; }
}

// `reckon watch` decides when to interrupt a person, so its rules are tested as rules.
// Each case below is something that actually happened on the machine this was
// written on, or the exact way the first version of it was wrong.
function watchDecides() {
  const w = require(path.join(ROOT, 'lib/watch.js'));
  const pet = require(path.join(ROOT, 'web/pet.js'));
  const R = (o) => ({ swapOfRam: 0.05, swapUsedMB: 800, swapTotalMB: 1024, ramMB: 16384, gainedOfRam: null, spanMs: null,
    factor: 1.1, probe: { nowMs: 350, bestMs: 319, factor: 1.1 }, rows: [], load1: 60, load5: 60, ncpu: 10, ...o });
  const MIN = 60_000;
  const run = (readings, start = 0) => {
    let st = w.emptyState(), all = [];
    readings.forEach((r, i) => { const o = w.step(st, r, start + i * 30_000); st = o.state; all.push(...o.events); });
    return { st, events: all };
  };

  // 1. Load alone never alerts. A watcher built on load rang four times, at 72, 61,
  //    50 and 44, during an ordinary compile with swap at 0 and half the RAM free.
  const busy = run(Array.from({ length: 8 }, () => R({ load5: 72, load1: 72 })));
  if (busy.events.length === 0) ok('a load of 72 on 10 cores, with nothing else wrong, is silent');
  else fail('load alone raised an alert', busy.events.map((e) => e.kind).join(', '));

  // 2. The bad afternoon: 12.7 GB of swap on a 16 GB machine, the probe 20x its best.
  const bad = R({ swapOfRam: 12700 / 16384, swapUsedMB: 12700, factor: 20, probe: { nowMs: 6140, bestMs: 300, factor: 20 } });
  const one = run([bad]);
  const kinds = one.events.filter((e) => e.type === 'alert').map((e) => e.kind).sort().join(',');
  if (kinds === 'stolen,swap') ok('the bad afternoon raises exactly two alerts: seconds stolen and swap');
  else fail('the bad afternoon raised the wrong alerts', kinds || 'none');
  const empty = one.events.filter((e) => !e.title || !e.cost || !e.proof || !e.lose);
  if (!empty.length) ok('every alert carries its cost, its proof and what you lose if it is wrong');
  else fail('an alert went out with a gap in it', empty.map((e) => e.kind).join(', '));

  // 3. One alert per problem, not one per reading.
  const long = run(Array.from({ length: 12 }, () => bad));
  if (long.events.filter((e) => e.type === 'alert').length === 2 && long.events.length === 2) ok('twelve identical readings ring twice, not twenty-four times');
  else fail('the same problem rang more than once', String(long.events.length) + ' events');

  // 4. It speaks again only when it gets worse by a step.
  const stepUp = run([R({ factor: 5, probe: { nowMs: 1600, bestMs: 319, factor: 5 } }), R({ factor: 6, probe: { nowMs: 1900, bestMs: 319, factor: 6 } }),
    R({ factor: 11, probe: { nowMs: 3500, bestMs: 319, factor: 11 } })]);
  const seq = stepUp.events.map((e) => `${e.type}:${e.kind}`).join(' ');
  if (seq === 'alert:stolen worse:stolen') ok('5x alerts, 6x stays quiet, 11x says it got worse');
  else fail('the escalation is wrong', seq);

  // 5. Clearing needs two calm readings in a row, so a flapping line cannot ring.
  const calm = R({});
  const one2 = run([bad, calm]);
  const two2 = run([bad, calm, calm]);
  if (!one2.events.some((e) => e.type === 'clear') && two2.events.filter((e) => e.type === 'clear').length === 2) ok('it clears after two calm readings, not one');
  else fail('clearing is not debounced', `${one2.events.length} / ${two2.events.length} events`);

  // 6. After a clear it stays quiet for a cooldown.
  const soon = run([bad, calm, calm, bad]);                 // 90 s later
  const later = (() => {
    let st = w.emptyState(); const ev = [];
    for (const [r, at] of [[bad, 0], [calm, 30_000], [calm, 60_000], [bad, 60_000 + 11 * MIN]]) { const o = w.step(st, r, at); st = o.state; ev.push(...o.events); }
    return ev;
  })();
  const alertsOf = (evs) => evs.filter((e) => e.type === 'alert').length;
  if (alertsOf(soon.events) === 2 && alertsOf(later) === 4) ok('inside the ten-minute cooldown it stays quiet; after it, it may speak again');
  else fail('the cooldown is wrong', `${alertsOf(soon.events)} inside, ${alertsOf(later)} after`);

  // 7. A reading that was not taken is unknown, not calm.
  const unknown = run([bad, ...Array.from({ length: 6 }, () => R({ factor: null, probe: null, swapOfRam: 12700 / 16384, swapUsedMB: 12700 }))]);
  const cleared = unknown.events.filter((e) => e.type === 'clear' && e.kind === 'stolen');
  if (!cleared.length) ok('a probe that did not run cannot clear a "stolen" alert');
  else fail('an unmeasured reading cleared an alert', 'not measured must never read as calm');

  // 8. An alert that cannot fill its three parts is not sent.
  const noProof = run([R({ factor: 6, probe: null })]);
  if (!noProof.events.length) ok('an alert with no proof to show is not sent');
  else fail('an alert went out without its proof', noProof.events[0].kind);

  // 9. Named causes: only the confident and the costly.
  const row = (o) => ({ id: 'swarm-yes', title: '365 copies of yes, orphaned', kb: 171 * 1024, costPct: 300, confidence: 'high',
    proof: '365 processes running the same executable.', lose: 'Nothing that can be named.', command: 'kill 101 102', ...o });
  const withRow = run([R({ rows: [row()] })]);
  const stale = run([R({ rows: [row({ id: 'stale-sessions', confidence: 'low' })] })]);
  const tiny = run([R({ rows: [row({ costPct: 4, kb: 1024 })] })]);
  if (withRow.events.some((e) => e.kind === 'row:swarm-yes' && e.command === 'kill 101 102')) ok('a costly orphaned swarm alerts, with the command to hand');
  else fail('a costly swarm did not alert');
  if (!stale.events.length && !tiny.events.length) ok('a low-confidence row and a cheap one stay silent');
  else fail('a row that should stay silent raised an alert');

  // 10. The level, and the bug in the first version of it.
  const L = w.levelOf;
  if (L({ swapOfRam: 742 / 16384 }) < 0.15) ok('742 MB of swap on a 16 GB machine is resting, not "72% full"');
  else fail('a trivial swap reads as trouble', String(L({ swapOfRam: 742 / 16384 })));
  if (L({ swapOfRam: 0.79 }) === 1 && L({ factor: 20 }) === 1 && L({}) === 0 && L({ factor: 1.1 }) < 0.15) ok('the level runs from 0 (calm or unmeasured) to 1 (the bad afternoon)');
  else fail('the level scale is wrong');
  let mono = true, prev = -1;
  for (let f = 1; f <= 16; f += 0.5) { const v = L({ factor: f }); if (v < prev) mono = false; prev = v; }
  if (mono) ok('a slower machine never lowers the level');
  else fail('the level is not monotonic in seconds stolen');

  // 11. lib/ and web/ write the same cut-offs twice on purpose; they must agree.
  let drift = null;
  for (let l = 0; l <= 1.0001; l += 0.01) if (w.stateOf(l) !== pet.resolve(l).label) { drift = l.toFixed(2); break; }
  if (!drift) ok('the watcher and the lantern agree on where each state begins');
  else fail('the watcher and the lantern disagree about the states', `at ${drift}`);

  // 12. The banner cannot run anything: the text travels as data.
  const darwin = read('lib/platform/darwin.js');
  const fn = (darwin.match(/async function notify\([\s\S]*?\n}\n/) || [''])[0];
  if (/run\('osascript'/.test(fn) && /item 2 of argv/.test(fn) && !/\bsh\(/.test(fn) && !/\$\{/.test(fn)) ok('the notification passes its text as argv to a fixed script, never through a shell');
  else fail('notify() may splice text into a script or a shell line', 'the text must travel as argv');

  // 13. Where it writes, and how it is started.
  if (w.CACHE_DIR.endsWith(path.join('.cache', 'reckon')) && w.STATE_FILE.startsWith(w.CACHE_DIR) && w.LOG_FILE.startsWith(w.CACHE_DIR)) ok('watch writes only inside ~/.cache/reckon');
  else fail('watch writes outside ~/.cache/reckon', `${w.STATE_FILE} ${w.LOG_FILE}`);
  if (w.parse(['--interval', '5']).bad && !w.parse(['--interval', '60']).bad && w.parse(['--bogus']).bad) ok('the options refuse nonsense: an interval under ten seconds, an unknown flag');
  else fail('the options accept nonsense');
  if (/arg === 'watch'/.test(read('bin/reckon'))) ok('bin/reckon dispatches `watch`');
  else fail('bin/reckon does not dispatch `watch`');
  if (!/setInterval|autostart|launchctl|LaunchAgents|crontab/.test(read('lib/watch.js'))) ok('watch never installs itself or schedules itself');
  else fail('watch installs or schedules itself', 'it must only ever start when someone runs it');
}

// The corner window shows text that came from the machine — process names end up in an
// alert's title — so what it may do with that text is tested, not assumed.
/* THE DASHBOARD'S OWN SERVER, ASKED OVER A REAL SOCKET.
 *
 * Loopback-only stops other machines. It does not stop another page open in the
 * same browser: that page can make the browser POST to 127.0.0.1, or point its
 * own name at 127.0.0.1 and read the answers. Three guards close that, and each
 * one is asked here the way an attacker would ask.
 *
 * The server runs on a free port with HOME pointed at a temporary folder, so
 * anything it writes lands there. If HOME cannot be redirected on this system,
 * no POST is sent at all: a broken guard would then write into the person's
 * real cache. Only routes that cannot cost anything are ever asked: the speed
 * test and the deep scan are never sent a POST from here.
 */
async function serverGuards() {
  const os = require('node:os');
  const net = require('node:net');
  const http = require('node:http');
  const { spawn, spawnSync } = require('node:child_process');

  const app = read('web/app.js');
  const posts = (app.match(/method: 'POST'/g) || []).length;
  const signed = (app.match(/method: 'POST', headers: authed\(/g) || []).length;
  if (posts && posts === signed) ok(`every POST in web/app.js carries the token (${posts})`);
  else fail('a POST in web/app.js does not send x-reckon-token', `${signed} of ${posts}`);
  if (/<meta name="reckon-token" content="">/.test(read('web/index.html'))) ok('index.html has the empty token slot the server fills');
  else fail('index.html has no reckon-token meta for the server to fill');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-server-check-'));
  const seen = spawnSync(process.execPath, ['-e', "process.stdout.write(require('os').homedir())"],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 10000 });
  const redirected = fs.realpathSync(String(seen.stdout || '.')) === fs.realpathSync(home);

  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(port), HOME: home, USERPROFILE: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ask = (method, route, headers = {}, body) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route,
      headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (e) => resolve({ status: 0, text: e.message }));
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });

  try {
    const up = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 15000);
      child.stdout.on('data', (c) => { if (/127\.0\.0\.1/.test(String(c))) { clearTimeout(t); resolve(true); } });
      child.on('exit', () => { clearTimeout(t); resolve(false); });
    });
    if (!up) return fail('the server did not start on a free port for the guard checks');

    const rebound = await ask('GET', '/api/self', { host: `evil.example:${port}` });
    if (rebound.status === 403) ok('a request under another Host name is refused (403)');
    else fail('a rebound Host name was answered', String(rebound.status));
    const otherPort = await ask('GET', '/', { host: `127.0.0.1:${port + 1}` });
    if (otherPort.status === 403) ok('the right address with the wrong port is refused too');
    else fail('a Host with the wrong port was answered', String(otherPort.status));

    const hrWrong = await ask('GET', '/api/headroom', { host: `evil.example:${port}` });
    if (hrWrong.status === 403) ok('/api/headroom refuses a rebound Host name');
    else fail('/api/headroom answered a rebound Host', String(hrWrong.status));
    const hrOk = await ask('GET', '/api/headroom');
    let hrBody = null; try { hrBody = JSON.parse(hrOk.text); } catch { /* shown below */ }
    if (hrOk.status === 200 && hrBody && 'availableMB' in hrBody && Array.isArray(hrBody.perApp) && typeof hrBody.verdict === 'string') ok('/api/headroom answers a GET with { availableMB, pressure, perApp, verdict }');
    else fail('/api/headroom did not answer with its shape', `${hrOk.status} ${hrOk.text.slice(0, 80)}`);
    const hrPost = await ask('POST', '/api/headroom');
    if (hrPost.status === 403 || hrPost.status === 404 || hrPost.status === 405) ok('/api/headroom is not writable: a POST is refused');
    else fail('a POST to /api/headroom was answered', String(hrPost.status));

    const page = await ask('GET', '/');
    const token = (page.text.match(/<meta name="reckon-token" content="([0-9a-f]{64})">/) || [])[1];
    if (page.status === 200 && token) ok('the page is served with a fresh 64-hex token written in');
    else fail('the served page carries no token', String(page.status));
    const again = await ask('GET', '/', { host: `localhost:${port}` });
    if (again.status === 200 && token && again.text.includes(token)) ok('localhost:<port> is answered, with the same token for this launch');
    else fail('localhost:<port> was refused or got a different token', String(again.status));

    const deep = await ask('GET', '/api/deep');
    if (deep.status === 405 && /POST/.test(deep.text)) ok('GET /api/deep is refused with 405 and says to use POST');
    else fail('GET /api/deep still starts a scan', String(deep.status));

    // The plan route: a POST under the same guard as every other /api/act/ route. It reads and builds.
    const planGet = await ask('GET', '/api/act/plan');
    if (planGet.status === 404) ok('GET /api/act/plan is not a route: the plan is a POST');
    else fail('GET /api/act/plan answered', String(planGet.status));
    const planBody = JSON.stringify({ needMB: 100 });
    const planJson = { 'content-type': 'application/json' };
    const planBare = await ask('POST', '/api/act/plan', planJson, planBody);
    const planForeign = await ask('POST', '/api/act/plan', { ...planJson, 'x-reckon-token': token, origin: 'http://evil.example' }, planBody);
    const planRebound = await ask('POST', '/api/act/plan', { ...planJson, 'x-reckon-token': token, host: `evil.example:${port}` }, planBody);
    if (planBare.status === 403 && planForeign.status === 403 && planRebound.status === 403) ok('POST /api/act/plan without the token, from another Origin, or under another Host is refused (403)');
    else fail('the plan route is not behind the guard', [planBare.status, planForeign.status, planRebound.status].join(','));
    const planGood = await ask('POST', '/api/act/plan', { ...planJson, 'x-reckon-token': token, origin: `http://127.0.0.1:${port}` }, planBody);
    let planAns = null; try { planAns = JSON.parse(planGood.text); } catch { /* shown below */ }
    if (planGood.status === 200 && planAns && planAns.ok === false && /at least/.test(planAns.refused || '')) ok('the panel\'s own POST reaches the plan, which refuses an ask below 256 MB without reading or running anything');
    else fail('the plan route did not answer the panel\'s own POST', `${planGood.status} ${planGood.text.slice(0, 80)}`);

    const snippet = path.join(home, '.cache', 'reckon', 'hosts-block.txt');
    if (redirected) {
      fs.mkdirSync(path.dirname(snippet), { recursive: true });
      fs.writeFileSync(snippet, 'sentinel\n');
      const before = fs.statSync(snippet).mtimeMs;
      await ask('GET', '/api/blocklist');
      if (fs.readFileSync(snippet, 'utf8') === 'sentinel\n' && fs.statSync(snippet).mtimeMs === before) ok('GET /api/blocklist leaves hosts-block.txt untouched');
      else fail('GET /api/blocklist rewrote hosts-block.txt');

      const body = JSON.stringify({ domain: 'example.com' });
      const json = { 'content-type': 'application/json' };
      const bare = await ask('POST', '/api/blocklist/remove', json, body);
      if (bare.status === 403) ok('a POST without the token is refused (403)');
      else fail('a POST without the token was answered', String(bare.status));
      const wrong = await ask('POST', '/api/blocklist/remove', { ...json, 'x-reckon-token': '0'.repeat(64) }, body);
      if (wrong.status === 403) ok('a POST with a wrong token of the right length is refused (403)');
      else fail('a wrong token was accepted', String(wrong.status));
      const foreign = await ask('POST', '/api/blocklist/remove', { ...json, 'x-reckon-token': token, origin: 'http://evil.example' }, body);
      if (foreign.status === 403) ok('a POST from another Origin is refused even with the token (403)');
      else fail('a POST from a foreign Origin was answered', String(foreign.status));
      if (fs.readFileSync(snippet, 'utf8') === 'sentinel\n') ok('none of the refused POSTs wrote anything');
      else fail('a refused POST still wrote the snippet');

      const good = await ask('POST', '/api/blocklist/remove', { ...json, 'x-reckon-token': token, origin: `http://127.0.0.1:${port}` }, body);
      if (good.status !== 403 && fs.readFileSync(snippet, 'utf8').includes('>>> reckon')) ok('the panel\'s own POST, with token and Origin, gets through and rewrites the snippet');
      else fail('the panel\'s own POST was refused or did not write the snippet', String(good.status));
    } else {
      ok('HOME could not be redirected here, so no POST was sent (a broken guard would have written to the real cache)');
    }
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function cornerIsSafe() {
  const w = require(path.join(ROOT, 'lib/watch.js'));
  const html = read('web/corner.html');

  const used = [...html.matchAll(/\$\('([a-z-]+)'\)/g)].map((m) => m[1]);
  const declared = new Set([...html.matchAll(/\sid="([a-z-]+)"/g)].map((m) => m[1]));
  const missing = [...new Set(used)].filter((id) => !declared.has(id));
  if (!missing.length) ok('every element the corner page reaches for exists');
  else fail('the corner page reaches for elements that are not there', missing.join(', '));

  // A process can be NAMED anything. Text from the machine goes in with textContent;
  // innerHTML on it would turn a process called `<img onerror=…>` into script.
  const scripts = (html.match(/<script>[\s\S]*?<\/script>/g) || []).join('\n');
  if (!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(scripts)) ok('the corner page writes machine text with textContent only');
  else fail('the corner page could turn a process name into markup', 'use textContent');
  if (!/https?:\/\//.test(html)) ok('the corner page reaches for nothing outside this machine');
  else fail('the corner page names an external address');
  if (!/\.(click|submit)\(\)|exec|spawn/.test(scripts) && /writeText/.test(scripts)) ok('the command is shown and can be copied; the page never runs it');
  else fail('the corner page does something with the command other than show and copy it');

  const files = Object.values(w.CORNER_FILES).map((f) => f[0]);
  const gone = files.filter((f) => !fs.existsSync(path.join(ROOT, 'web', f)));
  if (!gone.length && files.length === 3) ok('the corner server serves exactly three files, and they exist');
  else fail('the corner server serves the wrong files', gone.join(', ') || String(files.length));
  const src = read('lib/watch.js');
  if (/server\.listen\(CORNER_PORT, '127\.0\.0\.1'/.test(src) && /remoteAddress/.test(src) && /local only/.test(src)) ok('the corner server listens on 127.0.0.1 only and refuses other callers');
  else fail('the corner server is not loopback-only');

  // Loopback is not enough: a page on another site can resolve its own name to 127.0.0.1.
  // The handler is driven directly (no port: the owner may already have one running).
  {
    const call = (host, url) => {
      const out = { status: null };
      const req = { socket: { remoteAddress: '127.0.0.1' }, headers: host == null ? {} : { host }, url };
      const res = { writeHead: (c) => { out.status = c; }, end: () => {} };
      w.cornerHandler({ snapshot: null })(req, res);
      return out.status;
    };
    const mine = `127.0.0.1:${w.CORNER_PORT}`;
    const refused = ['evil.example.com', `evil.example.com:${w.CORNER_PORT}`, `localhost:${w.CORNER_PORT}`, '127.0.0.1', null].map((h) => call(h, '/api/watch'));
    if (refused.every((c) => c === 403)) ok('the corner server answers only to its own Host, so DNS rebinding reads nothing');
    else fail('the corner server answered to a Host that is not its own', refused.join(','));
    if (call(mine, '/api/watch') === 200) ok('the corner server still answers to its own Host');
    else fail('the corner server refused its own Host');
  }

  // --pet: the native lantern. Started once, never through the browser, and its cost is stated.
  {
    const alone = w.parse(['--pet']), both = w.parse(['--pet', '--corner']), none = w.parse([]);
    if (alone.pet && !alone.bad && !none.pet) ok('--pet is its own flag and is off by default');
    else fail('--pet is not parsed as a flag of its own');
    if (both.bad) ok('--pet and --corner together are refused, so two lanterns cannot appear');
    else fail('--pet and --corner were both accepted');

    const platform = require(path.join(ROOT, 'lib/platform'));
    const realStart = platform.startPet, realOpen = platform.openWindow, realId = platform.id;
    let starts = 0, opens = 0, said = [], exitCb = null, stopped = 0;
    platform.openWindow = async () => { opens++; return true; };
    platform.startPet = async (o) => { starts++; exitCb = o.onExit; return { pid: 4242, stop: () => { stopped++; } }; };
    try {
      const ctx = { pet: true, petPid: null };
      platform.id = 'darwin';
      const h = await w.startPetFor(ctx, (m) => said.push(m));
      if (starts === 1 && h && ctx.petPid === 4242) ok('startPetFor starts the pet exactly once and remembers its pid');
      else fail('startPetFor did not start the pet once', String(starts));
      if (opens === 0) ok('the pet never goes through the browser window');
      else fail('--pet opened a browser window');
      exitCb(0, null);
      if (ctx.petPid === null && said.some((m) => /does not come back/.test(m))) ok('when the person closes the pet it is not restarted, and the log says so');
      else fail('a closed pet was not reported or was restarted', said.join(' | '));

      platform.startPet = async (o) => { o.log('no compiler'); return null; };
      said = [];
      const none2 = await w.startPetFor({ pet: true, petPid: null }, (m) => said.push(m));
      if (none2 === null && said.some((m) => /not started/.test(m))) ok('a pet that cannot start says so and the rest keeps working');
      else fail('a failed pet start was silent');

      platform.id = 'win32'; starts = 0; platform.startPet = async () => { starts++; return null; }; said = [];
      await w.startPetFor({ pet: true, petPid: null }, (m) => said.push(m));
      if (starts === 0 && said.some((m) => /macOS only/.test(m))) ok('on another system it says the native pet is macOS only, and does not try');
      else fail('a non-mac system tried to start the pet or said nothing');
    } finally { platform.startPet = realStart; platform.openWindow = realOpen; platform.id = realId; }

    // The build key: anything that makes an old binary untrustworthy must change it.
    const { petKey } = require(path.join(ROOT, 'lib/platform/darwin-pet.js'));
    const base = { source: 'a', swiftVersion: 'v1', macos: '26.0', arch: 'arm64' };
    const keys = new Set([petKey(base), petKey({ ...base, source: 'b' }), petKey({ ...base, swiftVersion: 'v2' }), petKey({ ...base, macos: '26.1' }), petKey({ ...base, arch: 'x64' })]);
    if (keys.size === 5 && petKey(base) === petKey({ ...base })) ok('the pet is rebuilt when the source, the compiler, the macOS or the architecture changes, and not otherwise');
    else fail('the pet build key misses a change that should force a rebuild');

    const dp = read('lib/platform/darwin-pet.js');
    if (/spawn\(bin, \[\], \{ stdio: \['pipe', 'ignore', 'pipe'\] \}\)/.test(dp) && !/shell\s*:\s*true|\bexec\(|execSync/.test(dp)) ok('the pet is started without a shell, with its stdin held open');
    else fail('the pet is not started the way the contract says');
    if (/xcode-select', \['-p'\]/.test(dp) && !/xcode-select', \['--install'/.test(dp)) ok('it checks for the Command Line Tools without ever starting their installation');
    else fail('startPet does not check the Command Line Tools first, or starts their installation');
  }

  // The window opens once when things turn bad, and again only after a real calm.
  const platform = require(path.join(ROOT, 'lib/platform'));
  const real = platform.openWindow;
  let opened = 0, urls = [];
  platform.openWindow = async (u) => { opened++; urls.push(u); return true; };
  try {
    const ctx = { corner: true, cornerOpenedAt: null, calmSince: null, snapshot: null };
    const at = async (state, t) => { ctx.snapshot = { state }; await w.maybeOpenCorner(ctx, t); };
    await at('resting', 0);
    if (opened === 0) ok('a calm machine opens no window');
    else fail('a window opened on a calm machine');
    await at('uneasy', 1000); await at('strained', 2000); await at('resting', 3000); await at('uneasy', 60_000);
    if (opened === 1) ok('it opens once when things turn bad, and not again while they stay bad');
    else fail('the corner window opened more than once for one bad stretch', String(opened));
    await at('resting', 61_000); await at('resting', 61_000 + 121_000); await at('uneasy', 190_000);
    if (opened === 2) ok('after two calm minutes it may open again');
    else fail('the corner window did not reopen after a real calm', String(opened));
    if (urls.every((u) => /^http:\/\/127\.0\.0\.1:\d+\/corner$/.test(u))) ok('it only ever asks to open its own loopback address');
    else fail('it asked to open something other than its own address', urls.join(', '));
    opened = 0;
    const off = { corner: false, cornerOpenedAt: null, calmSince: null, snapshot: { state: 'strained' } };
    await w.maybeOpenCorner(off, 1);
    if (opened === 0) ok('without --corner no window ever opens');
    else fail('a window opened without --corner');
  } finally { platform.openWindow = real; }

  // The seam refuses to be a way to open any page.
  const darwin = require(path.join(ROOT, 'lib/platform/darwin.js'));
  for (const bad of ['https://example.com/', 'http://127.0.0.1:4128/../../etc', 'http://localhost:4128/corner', 'file:///etc/passwd']) {
    try { await darwin.openWindow(bad); fail('openWindow accepted an address that is not its own', bad); return; }
    catch (e) { if (!(e instanceof TypeError)) throw e; }
  }
  ok('openWindow throws on anything that is not reckon\'s own loopback address');
}

/* A suite that dies tells you less than one that reports. An unhandled
 * rejection here printed an error object with no stack and no test name, three
 * times over, and finding which line produced it cost more than the bug did.
 * Every step runs inside its own guard: a throw becomes a named FAIL and the
 * rest of the suite still runs. */
/* The skills in .claude/skills/ are instructions to an AI that has a shell. The
   rule of this project is that nothing here deletes anything, so the worst
   skill is one that tells an agent to run the command reckon prints: that turns
   a tool that only recommends into one that deletes. This reads every skill the
   way the agent will and refuses the ones that could be read as permission.
   It runs the same rules over two samples first, because a checker that has
   never failed is a checker nobody knows works. */
const SKILL_HARD_START = '<!-- hard-rules:start -->';
const SKILL_HARD_END = '<!-- hard-rules:end -->';
const SKILL_EXPECTED = ['reckon-check', 'reckon-panel', 'reckon-report', 'reckon-scan', 'reckon-slow', 'reckon-watch'];

function skillProblems(dir, text) {
  const out = [];
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!fm) return { problems: ['no frontmatter'], hard: null };
  const meta = {};
  for (const line of fm[1].split('\n')) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2].trim();
  }
  const body = text.slice(fm[0].length);
  if (meta.name !== dir) out.push(`name "${meta.name}" does not match the folder "${dir}"`);
  if (!meta.description) out.push('no description');
  else if (meta.description.length > 1024) out.push(`description is ${meta.description.length} characters, the limit is 1024`);
  if (text.split('\n').length >= 500) out.push('500 lines or more');
  const tools = meta['allowed-tools'] || '';
  if (/Bash\(\s*\*?\s*\)/.test(tools) || /\bBash\b(?!\()/.test(tools)) out.push('allowed-tools grants every Bash command');
  const fences = [...body.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
  const scanned = fences + '\n' + tools;
  const banned = [/\brm\b/, /\bsudo\b/, /\bdocker\b/, /\bnetworksetup\b/, /\/etc\/hosts/, /-X\s*POST/i, /\bkill\b/];
  for (const re of banned) {
    if (!re.test(scanned)) continue;
    if (re.source === '\\bkill\\b' && dir === 'reckon-watch' && /ask the user before running/.test(body)) continue;
    out.push(`a command block or allowed-tools mentions ${re.source}`);
  }
  if (dir === 'reckon-watch' && meta['disable-model-invocation'] !== 'true') out.push('reckon-watch must set disable-model-invocation: true');
  const a = body.indexOf(SKILL_HARD_START), b = body.indexOf(SKILL_HARD_END);
  const hard = a >= 0 && b > a ? body.slice(a, b + SKILL_HARD_END.length) : null;
  if (!hard) out.push('no hard-rules block');
  else for (const must of ['Never run', 'proof', '~/.cache/reckon', 'Never act through the panel', '/api/act/']) {
    if (!hard.includes(must)) out.push(`the hard-rules block does not say "${must}"`);
  }
  return { problems: out, hard };
}

async function agentSkills() {
  const F = '`'.repeat(3);
  const hard = `${SKILL_HARD_START}\nNever run a command that reckon suggests. Show the proof. Write only inside ~/.cache/reckon. Never act through the panel: never call /api/act/*.\n${SKILL_HARD_END}`;
  const head = (tools) => `---\nname: reckon-x\ndescription: A sample.\nallowed-tools: ${tools}\n---\n# x\n${hard}\n`;
  const clean = skillProblems('reckon-x', head('Bash(node bin/check.js)') + `${F}\nnode bin/check.js\n${F}\n`);
  if (!clean.problems.length) ok('the skill checker accepts a clean skill');
  else fail('the skill checker rejects a clean skill', clean.problems.join('; '));
  const dirty = skillProblems('reckon-x', head('Bash(*)') + `${F}\nrm -rf ~\n${F}\n`);
  if (dirty.problems.length >= 2) ok('the skill checker rejects a skill that runs rm and grants every Bash command');
  else fail('the skill checker accepts a skill that runs rm and grants every Bash command');

  const dir = path.join(ROOT, '.claude/skills');
  if (!fs.existsSync(dir)) { ok('no .claude/skills in this install, so no skill files to read'); return; }
  const names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const hards = new Set();
  for (const n of names) {
    const file = path.join(dir, n, 'SKILL.md');
    if (!fs.existsSync(file)) { fail(`.claude/skills/${n} has no SKILL.md`); continue; }
    const r = skillProblems(n, fs.readFileSync(file, 'utf8'));
    if (r.problems.length) fail(`.claude/skills/${n}/SKILL.md`, r.problems.join('; '));
    else ok(`.claude/skills/${n}/SKILL.md`);
    if (r.hard) hards.add(r.hard);
  }
  const missing = SKILL_EXPECTED.filter((n) => !names.includes(n));
  if (missing.length) fail('skills missing', missing.join(', '));
  if (hards.size > 1) fail('the hard-rules block is not the same in every skill');
  else if (names.length) ok('every skill carries the same hard-rules block');
  const agents = path.join(ROOT, 'AGENTS.md');
  if (!fs.existsSync(agents)) fail('AGENTS.md is missing');
  else {
    const n = fs.readFileSync(agents, 'utf8').split('\n').length;
    if (n <= 60) ok(`AGENTS.md is ${n} lines`);
    else fail(`AGENTS.md is ${n} lines, the limit is 60`);
    if (/Never act through the panel/.test(fs.readFileSync(agents, 'utf8')) && /\/api\/act\//.test(fs.readFileSync(agents, 'utf8'))) ok('AGENTS.md forbids agents the action routes and the Do button');
    else fail('AGENTS.md does not forbid agents /api/act/* and the Do button');
  }
}

// ---------------------------------------------------------------------------
// The native pet: ONE Swift file (native/pet.swift), the single exception to "plain Node and
// hand-written web files" (CONTRIBUTING.md section 2). A file nobody builds in the suite is a
// file that rots, and a second drawing of the lantern is a second place for it to be wrong, so:
//   1. it is linted for what it must never do and for what it must do to stay above full-screen apps,
//      and the linter is run against bad copies first, because a linter that cannot fail proves nothing
//   2. the static paths and the colours are the SAME strings as web/pet.js and web/tokens.css
//   3. on a Mac with swiftc it is compiled (which typechecks it) and `--dump-pose` is compared with
//      pose() in web/pet.js at all 101 levels
// ---------------------------------------------------------------------------
const SWIFT_FORBIDDEN = [
  [/Process\(/, 'starts a process'], [/NSTask/, 'starts a process'], [/posix_spawn/, 'starts a process'], [/\bsystem\(/, 'runs a shell command'],
  [/NSAppleScript/, 'runs a script'], [/NSWorkspace[^\n]*\bopen/, 'opens something'], [/removeItem/, 'deletes a file'],
  [/dlopen/, 'loads code'], [/http/i, 'names an address, and the pet reaches for none'],
];
const SWIFT_REQUIRED = [
  ['.screenSaver', 'the window level that stays above full-screen apps'], ['canJoinAllSpaces', 'being on every Space'],
  ['fullScreenAuxiliary', 'sitting beside a full-screen app'], ['nonactivatingPanel', 'not stealing focus'],
  ['standardInput', 'the open stdin that tells it the watcher is alive'],
];
function lintSwift(src) {
  const bad = [];
  for (const [re, why] of SWIFT_FORBIDDEN) if (re.test(src)) bad.push(`forbidden (${why}): ${re}`);
  for (const [word, why] of SWIFT_REQUIRED) if (!src.includes(word)) bad.push(`missing ${word} (${why})`);
  // The only thing it may write is inside the cache folder.
  for (const m of src.matchAll(/\.write\(to:\s*([^,)]+)/g)) if (!/^CACHE\b/.test(m[1].trim())) bad.push(`writes outside the cache folder: ${m[1].trim().slice(0, 40)}`);
  return bad;
}

async function nativePet() {
  const swift = read('native/pet.swift');
  const js = read('web/pet.js');

  const bad = lintSwift(swift);
  if (!bad.length) ok('native/pet.swift does nothing it must never do, and has what keeps it above full-screen apps');
  else fail('native/pet.swift breaks a rule of the native pet', bad.join('; '));
  const samples = [
    swift + '\nlet p = Process()', swift + '\nlet u = "https://example.com"', swift + '\nlet n = NSAppleScript(source: "")',
    swift + '\ntry FileManager.default.removeItem(at: x)', swift + '\ntry d.write(to: URL(fileURLWithPath: "/tmp/x"))',
    swift.replace('.screenSaver', '.floating'), swift.replace('standardInput', 'x'),
  ];
  const missed = samples.filter((t) => !lintSwift(t).length).length;
  if (!missed) ok(`the Swift linter rejects all ${samples.length} bad copies it was shown`);
  else fail('the Swift linter let a bad copy through', `${missed} of ${samples.length}`);

  // The static paths: every literal path in the lantern's drawing must also be in the Swift file, unchanged.
  const lantern = js.slice(js.indexOf('function lantern('), js.indexOf('// The motion.'));
  const paths = [...lantern.matchAll(/'(M[0-9. QLHVZ-]+)'/g)].map((m) => m[1]);
  const lost = paths.filter((d) => !swift.includes(`"${d}"`));
  if (paths.length >= 4 && !lost.length) ok(`the ${paths.length} fixed paths of the lantern are the same strings in the Swift file`);
  else fail('a fixed path of the lantern is not the same in native/pet.swift', lost.join(' | ') || `only ${paths.length} found in web/pet.js`);

  // The colours: same hex as web/tokens.css.
  const css = read('web/tokens.css');
  const token = (n) => (css.match(new RegExp(`--${n}:\\s*#([0-9a-fA-F]{6})\\b`)) || [])[1];
  const pairs = { cBg2: 'bg2', cBg3: 'bg3', cInk: 'ink', cInk2: 'ink2', cInk3: 'ink3', cLine2: 'line2', cCyan: 'cyan', cS4: 's4', cS2: 's2' };
  const off = [];
  for (const [name, tok] of Object.entries(pairs)) {
    const m = swift.match(new RegExp(`\\b${name} = hex\\(0x([0-9a-fA-F]{6})\\)`));
    if (!m || !token(tok) || m[1].toLowerCase() !== token(tok).toLowerCase()) off.push(`${name} vs --${tok}`);
  }
  if (!off.length) ok(`the ${Object.keys(pairs).length} colours of the Swift file are the colours of web/tokens.css`);
  else fail('a colour in native/pet.swift is not the one in web/tokens.css', off.join(', '));

  // Compile and compare. Skipped, and said so, where there is no Mac with a compiler; and in the child run
  // that re-checks the suite on another platform, where it would only repeat the same compile.
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const tools = process.platform === 'darwin' && !process.env.RECKON_CHECK_CHILD && spawnSync('xcode-select', ['-p']).status === 0;
  if (!tools) { ok('(compile and pose comparison not run here: needs a Mac with the Command Line Tools)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-pet-check-'));
  const bin = path.join(dir, 'reckon-pet');
  const modules = path.join(os.tmpdir(), 'reckon-check-swift-modules');   // survives between runs; outside the person's cache
  const built = spawnSync('swiftc', ['-O', '-module-cache-path', modules, path.join(ROOT, 'native/pet.swift'), '-o', bin], { encoding: 'utf8', timeout: 300000 });
  if (built.status !== 0) { fail('native/pet.swift does not compile', String(built.stderr || built.error).split('\n').slice(0, 3).join(' | ')); return; }
  ok('native/pet.swift compiles, so it typechecks');

  const dump = spawnSync(bin, ['--dump-pose'], { encoding: 'utf8', timeout: 20000 });
  let theirs;
  try { theirs = JSON.parse(dump.stdout); } catch { fail('--dump-pose did not print JSON', String(dump.stdout).slice(0, 80)); return; }
  const pet = require(path.join(ROOT, 'web/pet.js'));
  const off2 = [];
  let worst = 0;
  for (let i = 0; i <= 100; i++) {
    const a = pet.pose(i / 100), b = theirs[i] || {};
    if (Object.keys(a).sort().join() !== Object.keys(b).sort().join()) { off2.push(`${i}: different keys`); break; }
    for (const k of Object.keys(a)) {
      if (k === 'glow') { if (a[k] !== b[k]) off2.push(`${i} glow ${a[k]} vs ${b[k]}`); continue; }
      const d = Math.abs(a[k] - b[k]);
      worst = Math.max(worst, d);
      if (!(d <= 1e-3)) off2.push(`${i} ${k} ${a[k]} vs ${b[k]}`);
    }
  }
  if (theirs.length === 101 && !off2.length) ok(`pose() in the Swift file matches web/pet.js at all 101 levels (worst difference ${worst})`);
  else fail('the Swift pose and web/pet.js pose disagree', off2.slice(0, 3).join(' | ') || `${theirs.length} levels`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The action engine (lib/act.js). The one place that changes the machine, so it
// gets the strongest tests here:
//   - the table: every action has a label, what you lose, whether it is
//     reversible, a verify, a preview and an argv; no argv can contain sudo
//   - the request: only { action, id, nonce } is read; `path` and `command` are
//     ignored; a run needs a preview, five seconds, and the same target
//   - the race: a pid that is now another process is refused
//   - the routes: wrong Host, foreign Origin or no token is a 403
//   - for real, in a sandbox: a child process with HOME in a temporary folder
//     kills only `sleep` processes it spawned itself, and the real
//     ~/.cache/reckon is not touched.
// Everything except the sandbox runs against a FAKE process list and a dry run:
// no real process is ever looked up by these tests, let alone signalled.
// ---------------------------------------------------------------------------
async function actions() {
  const act = require(path.join(ROOT, 'lib/act.js'));

  // --- the table ---------------------------------------------------------
  const sample = {
    kind: 'swarm', name: 'Sample', appPath: '/Applications/Sample.app', bundleId: 'com.example.sample',
    pids: [{ pid: 4242, comm: '/usr/bin/yes', startedAt: 0 }], main: { pid: 4242, comm: 'x', startedAt: 0 }, roots: [],
  };
  const check = { alive: [{ pid: 4242 }, { pid: 4243 }], roots: [{ pid: 4242 }] };
  // Phase 3: the disk rows take a folder, a repository or volume names instead of pids.
  const H = '/Users/sample';
  const DISK_SAMPLES = {
    'clear-cache': [{ members: [] }, { paths: [`${H}/.npm/_npx`], tool: null }],
    'remove-node-modules': [{}, { paths: [`${H}/www/p/node_modules`] }],
    'remove-worktree': [{}, { main: `${H}/www/r`, wt: `${H}/www/wt/a` }],
    'move-to-trash': [{}, { bin: '/usr/bin/trash', path: `${H}/Library/Application Support/MobileSync/Backup` }],
    'docker-volume-rm': [{ names: ['v1'] }, { names: ['v1'] }],
    // AI tools: a model name instead of pids.
    'stop-ollama-model': [{ name: 'llama3.2:latest' }, { name: 'llama3.2:latest' }],
  };
  const names = Object.keys(act.ACTIONS);
  for (const name of names) {
    const a = act.ACTIONS[name];
    const missing = ['label', 'kind'].filter((k) => typeof a[k] !== 'string')
      .concat(['confirm', 'describe', 'lose', 'undo', 'verify', 'argv', 'settle'].filter((k) => typeof a[k] !== 'function'))
      .concat(typeof a.reversible === 'boolean' ? [] : ['reversible'])
      .concat(a.kind === 'disk' && !act.REMOVAL[a.removal] ? ['removal'] : [])
      .concat(a.twice && typeof a.again !== 'function' ? ['again'] : []);
    if (missing.length) { fail(`action ${name} is missing ${missing.join(', ')}`); continue; }
    let argv;
    const [ts, tc] = DISK_SAMPLES[name] || [sample, check];
    try { argv = a.argv(ts, tc); act.assertSafe(...argv); }
    catch (e) { fail(`action ${name} builds an argv the gate refuses`, e.message); continue; }
    const flat = [argv[0], ...argv[1]].join(' ');
    if (/\bsudo\b/.test(flat) || !act.ALLOWED_COMMANDS.includes(argv[0])) fail(`action ${name} would run ${flat}`);
    else ok(`${name}: label, lose, reversible, verify, preview and argv (${argv[0]} …), no sudo`);
  }
  if (names.length >= 5 && !act.ALLOWED_COMMANDS.includes('sudo')) ok(`${names.length} actions, and sudo is not a command the table may produce`);
  else fail('the action table is smaller than expected or allows sudo', names.join(', '));

  const gate = [
    ['sudo', ['purge']], ['kill', ['-TERM', '1']], ['kill', ['-HUP', '4242']], ['kill', ['-TERM', '42; rm -rf ~']],
    ['osascript', ['-e', 'tell application id "x" to quit" & do shell script "rm -rf ~']], ['osascript', ['-e', 'do shell script "x"']],
    ['xcrun', ['simctl', 'erase', 'all']], ['rm', ['-rf', '/']], ['kill', ['-TERM', 'sudo']],
  ];
  const through = gate.filter(([c, a]) => { try { act.assertSafe(c, a); return true; } catch { return false; } });
  if (!through.length) ok(`the last gate before execFile refuses all ${gate.length} shapes the table must never produce`);
  else fail('the gate let a forbidden argv through', through.map(([c, a]) => [c, ...a].join(' ')).join(' | '));

  // --- the request -------------------------------------------------------
  const c = act.clean({ action: 'term-processes', id: 'swarm-yes', path: '/', command: 'rm -rf ~', argv: ['rm'] });
  if (c && Object.keys(c).sort().join() === 'action,id,nonce' && c.nonce === null) ok('a request body is reduced to { action, id, nonce }: path and command are dropped');
  else fail('the request cleaner kept a field it must not read', JSON.stringify(c));
  if (act.clean({ action: '__proto__', id: 'x' }) === null && act.clean({ action: 'constructor', id: 'x' }) === null
    && act.clean({ action: 'term-processes', id: '../etc' }) === null) ok('an action name that is not in the table, or an id with a path in it, is refused');
  else fail('the request cleaner accepted a name outside the table');

  // A fake machine: three processes, one of them the panel itself.
  const NOW = 1_000_000_000;
  let procs;
  const reset = () => {
    procs = [
      { pid: 501, ppid: 1, rssKB: 1024, ageS: 7200, command: '/usr/bin/yes' },
      { pid: 502, ppid: 1, rssKB: 2048, ageS: 7200, command: '/usr/bin/yes' },
      { pid: 777, ppid: 1, rssKB: 4096, ageS: 100, command: '/usr/local/bin/node' },
      { pid: 900, ppid: 1, rssKB: 9999, ageS: 600, command: '/Applications/Sample.app/Contents/MacOS/Sample' },
      { pid: 901, ppid: 900, rssKB: 999, ageS: 600, command: '/Applications/Sample.app/Contents/Frameworks/H.app/Contents/MacOS/H' },
    ];
  };
  reset();
  const ran = [];
  const logged = [];
  const make = (o = {}) => act.createEngine({
    processList: async () => procs.map((p) => ({ ...p })),
    appBundle: async (comm) => (String(comm).startsWith('/Applications/Sample.app/') ? { appPath: '/Applications/Sample.app', bundleId: 'com.example.sample', name: 'Sample' } : null),
    runningContainers: async () => 0, memoryStats: async () => null, memoryPressure: async () => null,
    exec: async (cmd, args) => { ran.push([cmd, ...args]); return { ok: true, out: '', erro: null }; },
    log: { append: (e) => { logged.push(e); return true; } },
    now: () => NOW, selfPid: 777, dryRun: true, minDelayMs: 0, killAfterMs: 0, settleMs: 0, ...o,
  });
  const ident = (p) => ({ pid: p.pid, comm: p.command, startedAt: NOW - p.ageS * 1000 });
  const swarmRow = (over = {}) => ({ id: 'swarm-yes', title: '2 copies of yes', confidence: 'high', lose: 'nothing',
    action: { id: 'term-processes', label: 'Stop them' }, target: { kind: 'swarm', pids: procs.slice(0, 2).map(ident) }, ...over });

  let e = make();
  const unknown = await e.preview({ action: 'term-processes', id: 'swarm-yes' });
  if (!unknown.ok && /not in the last reading/.test(unknown.refused)) ok('an id the server never measured is refused');
  else fail('an id the server never measured was accepted', JSON.stringify(unknown));

  e.remember('pressure', [swarmRow({ confidence: 'low' })]);
  const low = await e.preview({ action: 'term-processes', id: 'swarm-yes' });
  if (!low.ok) ok('a low-confidence row gets no action, even if it carries one');
  else fail('a low-confidence row was made clickable');

  e.remember('pressure', [swarmRow()]);
  const p1 = await e.preview({ action: 'term-processes', id: 'swarm-yes', path: '/', command: 'rm -rf ~' });
  if (p1.ok && p1.nonce && p1.proof && p1.lose && typeof p1.reversible === 'boolean' && p1.mb != null) ok('the preview carries what, how much, proof measured now, what you lose and whether it is reversible');
  else fail('the preview is incomplete', JSON.stringify(p1));
  const noNonce = await e.run({ action: 'term-processes', id: 'swarm-yes' });
  if (!noNonce.ok && /preview/.test(noNonce.refused)) ok('a run without a preview is refused');
  else fail('a run without a preview went ahead');
  const r1 = await e.run({ action: 'term-processes', id: 'swarm-yes', nonce: p1.nonce, path: '/', command: 'rm -rf ~' });
  if (r1.ok && r1.dryRun && r1.argv.join(' ') === 'kill -TERM 501 502' && !ran.length) ok('dry run: the argv comes from the table (kill -TERM 501 502), the body\'s path and command are ignored, nothing ran');
  else fail('the dry run is wrong', JSON.stringify(r1) + ' ran=' + JSON.stringify(ran));
  const again = await e.run({ action: 'term-processes', id: 'swarm-yes', nonce: p1.nonce });
  if (!again.ok) ok('a nonce works once');
  else fail('a nonce was accepted twice');

  // The countdown is a rule on the server, not only on the screen.
  const slow = make({ minDelayMs: 5000 });
  slow.remember('pressure', [swarmRow()]);
  const ps = await slow.preview({ action: 'term-processes', id: 'swarm-yes' });
  const early = await slow.run({ action: 'term-processes', id: 'swarm-yes', nonce: ps.nonce });
  if (!early.ok && /Too soon/.test(early.refused)) ok('a run sooner than five seconds after its preview is refused by the server');
  else fail('the server ran an action before the countdown could finish', JSON.stringify(early));

  // --- the race ----------------------------------------------------------
  e = make();
  e.remember('pressure', [swarmRow()]);
  procs[1].ageS = 5;   // pid 502 now belongs to a process started 5 s ago
  const recycled = await e.preview({ action: 'term-processes', id: 'swarm-yes' });
  if (!recycled.ok && /different process/.test(recycled.refused)) ok('a pid now worn by a younger process is refused (same number, other start time)');
  else fail('a recycled pid was accepted', JSON.stringify(recycled));
  // With an absolute start time (macOS publishes one), that is what decides, not the age.
  reset();
  procs.forEach((p) => { p.startedAt = NOW - p.ageS * 1000; });
  e.remember('pressure', [swarmRow({ target: { kind: 'swarm', pids: procs.slice(0, 2).map((p) => ({ pid: p.pid, comm: p.command, startedAt: p.startedAt })) } })]);
  const sameAbs = await e.preview({ action: 'term-processes', id: 'swarm-yes' });
  procs[0].startedAt += 60000;
  const otherAbs = await e.preview({ action: 'term-processes', id: 'swarm-yes' });
  if (sameAbs.ok && !otherAbs.ok) ok('an absolute start time a minute off is a different process, however long the reading took');
  else fail('the absolute start time is not what decides identity', JSON.stringify([sameAbs.refused, otherAbs.refused]));
  reset();
  e.remember('pressure', [swarmRow()]);
  procs[0].command = '/bin/zsh';
  const renamed = await e.preview({ action: 'term-processes', id: 'swarm-yes' });
  if (!renamed.ok) ok('a pid now running another executable is refused');
  else fail('a pid running another executable was accepted');
  reset();
  e.remember('pressure', [swarmRow()]);
  const p2 = await e.preview({ action: 'term-processes', id: 'swarm-yes' });
  procs.splice(1, 1);   // 502 exits between the preview and the click
  const moved = await e.run({ action: 'term-processes', id: 'swarm-yes', nonce: p2.nonce });
  if (!moved.ok && /changed between the preview and now/.test(moved.refused)) ok('the target changed between preview and click: refused, and the refusal is logged');
  else fail('a target that changed after the preview was acted on', JSON.stringify(moved));
  if (logged.some((l) => l.refused && /changed/.test(l.refused))) ok('the refusal went to actions.log');
  else fail('a refusal was not logged');
  reset();
  procs[0].ppid = 4000;
  e.remember('pressure', [swarmRow()]);
  const adopted = await e.preview({ action: 'term-processes', id: 'swarm-yes' });
  if (!adopted.ok) ok('a swarm member that has a parent again is refused');
  else fail('a swarm member with a living parent was accepted');
  reset();

  // The panel never signals itself or what it runs inside.
  e.remember('pressure', [swarmRow({ target: { kind: 'test', pids: [ident(procs[2])] } })]);
  const self = await e.preview({ action: 'term-processes', id: 'swarm-yes' });
  if (!self.ok && /reckon itself/.test(self.refused)) ok('reckon refuses to signal its own pid');
  else fail('reckon offered to signal itself', JSON.stringify(self));

  // SIGKILL only as its own click, after a polite stop.
  const kill0 = await e.preview({ action: 'kill-processes', id: 'swarm-yes' });
  if (!kill0.ok && /polite stop/.test(kill0.refused)) ok('a forced stop with no polite stop before it is refused');
  else fail('SIGKILL was offered without a SIGTERM first');

  // --- apps --------------------------------------------------------------
  const appRow = (over = {}) => ({ id: 'group-sample', title: 'Sample', confidence: 'medium', lose: 'x',
    action: { id: 'quit-app', label: 'Quit Sample' },
    target: { kind: 'app', appPath: '/Applications/Sample.app', bundleId: 'com.example.sample', name: 'Sample', main: ident(procs[3]), pids: [ident(procs[3]), ident(procs[4])] }, ...over });
  e = make();
  e.remember('memory', [appRow()]);
  const pa = await e.preview({ action: 'quit-app', id: 'group-sample' });
  const ra = pa.ok && await e.run({ action: 'quit-app', id: 'group-sample', nonce: pa.nonce });
  if (ra && ra.dryRun && ra.argv.join(' ') === 'osascript -e tell application id "com.example.sample" to quit') ok('quit-app asks the app by bundle id to quit, gracefully, through osascript');
  else fail('quit-app built the wrong argv', JSON.stringify(ra || pa));
  e.remember('memory', [appRow({ target: { ...appRow().target, bundleId: 'com.apple.finder' } })]);
  const finder = await e.preview({ action: 'quit-app', id: 'group-sample' });
  if (!finder.ok) ok('the desktop itself (Finder, Dock, loginwindow…) is never quit');
  else fail('the engine offered to quit Finder');
  e.remember('memory', [appRow({ target: { ...appRow().target, bundleId: 'x" to quit\ndo shell script "rm' } })]);
  const inj = await e.preview({ action: 'quit-app', id: 'group-sample' });
  if (!inj.ok) ok('a bundle id with a quote in it is refused before it can reach AppleScript');
  else fail('an injected bundle id reached the preview');
  const hosting = make({ selfPid: 777 });
  procs[2].ppid = 901;   // reckon now runs inside the app
  hosting.remember('memory', [appRow()]);
  const host = await hosting.preview({ action: 'quit-app', id: 'group-sample' });
  if (!host.ok && /reckon itself/.test(host.refused)) ok('the app that runs reckon is never quit from reckon');
  else fail('reckon offered to quit the app it runs inside', JSON.stringify(host));
  reset();
  const busy = make({ runningContainers: async () => 2 });
  busy.remember('memory', [appRow({ id: 'docker-idle', action: { id: 'quit-docker', label: 'Quit Docker' } })]);
  const dk = await busy.preview({ action: 'quit-docker', id: 'docker-idle' });
  if (!dk.ok && /running now/.test(dk.refused)) ok('Docker Desktop is not quit while a container runs (measured at the click)');
  else fail('Docker Desktop was offered with containers running', JSON.stringify(dk));
  if (!ran.length) ok('no test above ran a single command: the fake machine and the dry run held');
  else fail('a test ran a command', JSON.stringify(ran));

  // --- the routes --------------------------------------------------------
  // The Host, Origin and token guards are the server's own, tested for real in
  // 'server guards'. Here: the action routes are POST-only, sit below that guard,
  // and there is no second token for the panel to fetch.
  const srv = read('server.js');
  const guardAt = srv.indexOf("if (!tokenOk(req))");
  const postOnly = ['/api/act/preview', '/api/act/run'].every((r) => {
    const at = srv.indexOf(`'${r}' && req.method === 'POST'`);
    return at > guardAt && guardAt > -1;
  });
  if (postOnly) ok('both action routes are POST-only and sit below the server-wide Host/Origin/token guard');
  else fail('an action route is not POST-only, or is reachable before the guard');
  if (!/act\/token|requireToken|tokenFor/.test(srv + read('lib/act.js') + read('web/app.js'))) ok('there is one token, the server\'s: the action engine has none of its own');
  else fail('a second token mechanism is still in the code');

  // --- for real, in a sandbox -------------------------------------------
  await actSandbox();

  // --- phase 3: disk -----------------------------------------------------
  await diskActions(act);
  await diskSandbox();

  // --- AI tools: idle sessions, orphaned tool servers, local models ----------
  await aiActions(act);
  await aiSandbox();
}

// ---------------------------------------------------------------------------
// Phase 3: the disk actions. The bad paths are planted first, because a guard
// that has never refused anything proves nothing. Everything here runs in
// temporary folders this test made; tool cleaners (npm, brew, go, pip, simctl,
// docker) and the Trash are only ever looked at as argv in a dry run.
// ---------------------------------------------------------------------------
async function diskActions(act) {
  const os = require('node:os');
  if (process.platform === 'win32') { ok('(disk actions are macOS-only; not tested on Windows)'); return; }

  // --- the gate: shapes the table must never produce -----------------------
  const gate = [
    ['git', ['-C', '/Users/x/r', 'worktree', 'remove', '--force', '/Users/x/w']], ['git', ['-C', '/Users/x/r', 'worktree', 'remove', '-f']],
    ['git', ['-C', '/Users/x/r', 'reset', '--hard', 'HEAD']], ['git', ['-C', 'r', 'worktree', 'remove', '/Users/x/w']],
    ['docker', ['system', 'prune', '-a', '-f']], ['docker', ['system', 'prune', '-f', '--volumes']], ['docker', ['builder', 'prune', '-a', '-f']],
    ['docker', ['volume', 'rm', 'x; rm -rf ~']], ['docker', ['volume', 'prune', '-f']], ['docker', ['rm', '-f', 'db']],
    ['npm', ['install', 'evil']], ['brew', ['uninstall', 'git']], ['go', ['clean', '-modcache']], ['pip', ['uninstall', 'x']],
    ['osascript', ['-e', 'on run argv', '-e', 'do shell script "rm -rf ~"', '-e', 'end run', '/Users/x/a']],
    ['osascript', ['-e', 'tell application "Finder" to delete (POSIX file "/")']],
    ['/usr/bin/trash', ['-s', 'relative']], ['/usr/bin/trash', ['-s', '/']], ['/usr/bin/trash', ['/Users/x/a', '/Users/x/b']],
    ['safe-remove', ['relative/x']], ['safe-remove', ['/Users/x/../../etc']], ['safe-remove', ['/']], ['safe-remove', []],
    ['xcrun', ['simctl', 'delete', 'all']], ['rm', ['-rf', '/Users/x/.npm']], ['sudo', ['npm', 'cache', 'clean', '--force']],
  ];
  const through = gate.filter(([c, a]) => { try { act.assertSafe(c, a); return true; } catch { return false; } });
  if (!through.length) ok(`the gate refuses all ${gate.length} disk shapes the table must never produce (--force, -a, --volumes, a script, a relative path…)`);
  else fail('the gate let a forbidden disk argv through', through.map(([c, a]) => [c, ...a].join(' ')).join(' | '));
  const sudoFree = Object.keys(act.ACTIONS).every((n) => !/\bsudo\b/.test(String(act.ACTIONS[n].argv)));
  if (sudoFree && !act.ALLOWED_COMMANDS.some((c) => /sudo|^rm$|^sh$|bash|zsh/.test(c))) ok('no action builds sudo, rm or a shell: removal is safeRemove() in-process');
  else fail('an action can build sudo, rm or a shell');

  // --- safeRemove against planted bad paths --------------------------------
  const H = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-rm-check-'));
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-rm-outside-'));
  try {
    const mk = (...p) => { const d = path.join(H, ...p); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'f'), 'x'); return d; };
    fs.writeFileSync(path.join(OUT, 'precious'), 'outside home');
    const caches = path.join(H, 'Library', 'Caches');
    const good = mk('Library', 'Caches', 'good');
    const sibling = mk('Library', 'Caches', 'sibling');
    const docs = mk('Documents', 'x'), desk = mk('Desktop', 'x'), down = mk('Downloads', 'x'), icloud = mk('Library', 'Mobile Documents', 'x');
    mk('.ssh'); mk('.npm'); mk('www');
    const linkOut = path.join(caches, 'link-out'); fs.symlinkSync(OUT, linkOut);
    const viaLink = path.join(caches, 'via-link'); fs.symlinkSync(OUT, viaLink);
    const throughLink = path.join(viaLink, 'precious');
    const linkIn = path.join(caches, 'link-in'); fs.symlinkSync(good, linkIn);
    const notListed = mk('Library', 'Caches', 'not-listed');
    const bad = {
      'the root': '/', '/System': '/System', '/Applications': '/Applications', 'home itself': H,
      '~/Library': path.join(H, 'Library'), '~/Library/Caches': caches, 'a file in ~/Documents': docs, '~/Desktop': desk, '~/Downloads': down,
      'iCloud Drive': icloud, 'the ~/.ssh dotfile': path.join(H, '.ssh'), 'the ~/.npm dotfile': path.join(H, '.npm'), 'a top folder of home': path.join(H, 'www'),
      'a relative path': 'Library/Caches/good', 'a path with ..': path.join(caches, 'good') + '/../../../Documents/x',
      'a trailing slash': good + '/', 'a symlink that leads outside home': linkOut, 'a path through a symlink out of home': throughLink,
      'a symlink inside home': linkIn, 'a folder outside home': OUT, 'a path not in the table': notListed, 'a NUL byte': good + '\0x', 'not a string': null,
    };
    const allowed = Object.values(bad).filter((p) => typeof p === 'string').concat([good]);
    const passed = Object.entries(bad).filter(([why, p]) => {
      const c = act.checkRemovable(p, { home: H, allowed: why === 'a path not in the table' ? [good] : allowed });
      return c.ok;
    });
    if (!passed.length) ok(`safeRemove refuses all ${Object.keys(bad).length} planted bad paths (root, home, ~/Library, ~/Documents, dotfiles, .., symlink escapes, outside home, not in the table)`);
    else fail('safeRemove accepted a planted bad path', passed.map(([w]) => w).join(', '));
    // Every refusal above is a refusal BEFORE fs.rm: nothing planted is gone.
    for (const [why, p] of Object.entries(bad)) act.safeRemove(p, { home: H, allowed: why === 'a path not in the table' ? [good] : allowed });
    const intact = [docs, desk, down, icloud, notListed, path.join(H, '.ssh'), path.join(H, '.npm'), path.join(H, 'www'), good].every((d) => fs.existsSync(path.join(d, 'f')))
      && fs.existsSync(path.join(OUT, 'precious')) && fs.lstatSync(linkOut).isSymbolicLink();
    if (intact) ok('after safeRemove was called on every planted bad path, every one of them is still there, and so is the file outside home');
    else fail('safeRemove removed something it refused');
    const r = act.safeRemove(good, { home: H, allowed: [good] });
    if (r.ok && !fs.existsSync(good) && fs.existsSync(path.join(sibling, 'f'))) ok('safeRemove removes the one listed folder, and its sibling stays');
    else fail('safeRemove did not remove exactly the listed folder', JSON.stringify(r));
    if (!act.checkRemovable(good, { home: '/', allowed: [good] }).ok) ok('with HOME set to /, nothing is removable');
    else fail('HOME=/ made a path removable');
  } finally { fs.rmSync(H, { recursive: true, force: true }); fs.rmSync(OUT, { recursive: true, force: true }); }

  // --- the engine, on a fake machine, in a dry run -------------------------
  const decisions = require(path.join(ROOT, 'lib/decisions.js'));
  const platform = require(path.join(ROOT, 'lib/platform'));
  const FH = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-disk-check-'));
  const ran = [], logged = [];
  try {
    const P = (...x) => path.join(FH, ...x);
    for (const d of [P('.npm', '_npx'), P('.npm', '_cacache'), P('.Trash'), P('Library', 'Application Support', 'MobileSync', 'Backup'), P('www', 'p', 'node_modules'), P('www', 'wt', 'a')]) {
      fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'f'), 'x');
    }
    const known = [
      { id: 'npm-npx', path: P('.npm', '_npx'), verdict: 'disposable', label: 'npx', lose: 'n', command: 'rm -rf x' },
      { id: 'npm-cacache', path: P('.npm', '_cacache'), verdict: 'disposable', label: 'npm cache', lose: 'n', command: 'npm cache clean --force' },
      { id: 'trash', path: P('.Trash'), verdict: 'disposable', label: 'Trash', lose: 'n', command: 'rm -rf ~/.Trash/*' },
      { id: 'ios-backups', path: P('Library', 'Application Support', 'MobileSync', 'Backup'), verdict: 'yours', label: 'iPhone backups', lose: 'n', command: null },
    ];
    const fake = { hash: 'abc1234', dirty: '', tracked: false, off: '0', ignored: '', dangling: 'vol_a\nvol_b\n', stopped: 'old_db\n' };
    const read = async (cmd, args) => {
      const a = args.join(' ');
      const R = (out) => ({ ok: true, out, erro: null });
      if (cmd === 'git' && /log -1/.test(a)) return R(fake.hash + '\n');
      if (cmd === 'git' && /status --porcelain/.test(a)) return R(fake.dirty);
      if (cmd === 'git' && /ls-files --others --ignored/.test(a)) return fake.ignored == null ? { ok: false, out: '', erro: 'boom' } : R(fake.ignored);
      if (cmd === 'git' && /ls-files/.test(a)) return fake.tracked ? R('node_modules/x\n') : { ok: false, out: '', erro: 'did not match' };
      if (cmd === 'git' && /git-common-dir/.test(a)) return R(P('www', 'r', '.git') + '\n');
      if (cmd === 'git' && /worktree list/.test(a)) return R(`worktree ${P('www', 'r')}\n\nworktree ${fs.realpathSync(P('www', 'wt', 'a'))}\n`);
      if (cmd === 'git' && /rev-list/.test(a)) return R(fake.off + '\n');
      if (cmd === 'docker' && /^info/.test(a)) return R('27.0.0\n');
      if (cmd === 'docker' && /dangling/.test(a)) return R(fake.dangling);
      if (cmd === 'docker' && /^ps/.test(a)) return R(fake.stopped);
      if (cmd === 'docker' && /system df/.test(a)) return R('Build Cache\t3GB\n');
      if (cmd === 'xcrun') return R(JSON.stringify({ devices: { 'iOS-15': [{ udid: 'U1' }] } }));
      return { ok: false, out: '', erro: 'not faked' };
    };
    let tools = new Set();
    let trashBin = '/usr/bin/trash';
    const make = () => act.createEngine({
      dryRun: true, minDelayMs: 0, home: () => FH, known: () => known, sizeKB: async () => 2048, read,
      which: (c) => tools.has(c), trashBin: () => trashBin, volume: async () => ({ freeKB: 1000 }),
      memoryStats: async () => null, memoryPressure: async () => null,
      exec: async (cmd, args) => { ran.push([cmd, ...args]); return { ok: true, out: '', erro: null }; },
      log: { append: (e) => { logged.push(e); return true; } },
    });
    const isMac = platform.id === 'darwin';
    const targets = known.map((k) => ({ ...k, kb: 300000 }));
    const repos = { repos: [{ name: 'p', path: P('www', 'p'), git: true, stale: true, days: 400, nodeModulesKB: 300000, lastHash: 'abc1234', dirtyCount: 0, off: 0, hasRemote: true, manager: 'npm', lastCommit: '2025-01-01' }],
      worktrees: [{ name: 'wt/a', path: P('www', 'wt', 'a'), base: 'main', off: 0, days: 60, sizeKB: 300000, dirtyCount: 0 }] };
    const dk = { running: true, volumes: [{ name: 'vol_a', situation: 'orphan', uses: [] }, { name: 'vol_b', situation: 'orphan', uses: [] }],
      counted: [{ type: 'Build Cache', reclaimable: '3GB', reclaimableKB: 3145728 }, { type: 'Containers', reclaimable: '400MB', reclaimableKB: 409600 }] };
    const panel = decisions.build({ docker: dk, targets, repos });
    const rows = [...panel.out, ...panel.stay].filter((r) => r.action);
    if (!isMac) { if (!rows.length) ok('off macOS no decision row gets a Do button'); else fail('a decision row got an action off macOS'); return; }
    const byAction = (id, f = () => true) => rows.find((r) => r.action.id === id && f(r));
    const want = ['clear-cache', 'empty-trash', 'move-to-trash', 'remove-node-modules', 'remove-worktree', 'docker-volume-rm', 'docker-builder-prune', 'docker-system-prune'];
    const absent = want.filter((w) => !byAction(w));
    if (!absent.length && rows.every((r) => /^d[0-9a-f]{24}$/.test(r.action.ref) && r.action.removal && ['high', 'medium'].includes(r.confidence))) {
      ok(`decisions give ${rows.length} rows an action from the table, each with a ref, a removal label and confidence high or medium`);
    } else fail('decisions did not attach the expected actions', `missing ${absent.join(', ')}`);
    if (!rows.some((r) => r.action.id === 'move-to-trash' && /node_modules|www/.test(r.target.path || ''))) ok('only iOS backups and Mail downloads go to the Trash: no repository is offered');
    else fail('a repository was offered for the Trash');

    let e = make();
    e.remember('disk', rows);
    const go = async (row, body = {}) => {
      const p = await e.preview({ action: row.action.id, id: row.action.ref, ...body });
      if (!p.ok) return { p };
      return { p, r: await e.run({ action: row.action.id, id: row.action.ref, nonce: p.nonce }) };
    };
    // clear-cache: removal in-process, or the tool's own cleaner when it is on PATH
    const npx = byAction('clear-cache', (r) => r.target.members[0].id === 'npm-npx');
    const a1 = await go(npx);
    if (a1.r && a1.r.dryRun && a1.r.argv[0] === 'safe-remove' && a1.r.argv[1] === P('.npm', '_npx') && a1.p.removal === 'regenerable' && /for good/.test(a1.p.removalLabel)) ok('a cache with no tool of its own: safe-remove of exactly its folder, labelled "regenerable, removed for good"');
    else fail('clear-cache built the wrong thing', JSON.stringify(a1));
    const cacache = byAction('clear-cache', (r) => r.target.members[0].id === 'npm-cacache');
    tools = new Set(['npm']);
    const a2 = await go(cacache);
    tools = new Set();
    const a3 = await go(cacache);
    if (a2.r && a2.r.argv.join(' ') === 'npm cache clean --force' && a3.r && a3.r.argv[0] === 'safe-remove') ok('npm cache: `npm cache clean --force` when npm is on PATH, safe-remove of its folder when it is not');
    else fail('the tool-first rule is wrong', JSON.stringify([a2.r, a3.r]));
    // A target whose path is not where the table says.
    e.remember('disk', [{ ...npx, target: { members: [{ id: 'npm-npx', path: P('Documents') }] } }]);
    const moved = await e.preview({ action: 'clear-cache', id: npx.action.ref });
    if (!moved.ok && /table/.test(moved.refused)) ok('a cache row whose path is not the one in reckon\'s own table is refused');
    else fail('a cache row with a foreign path was accepted', JSON.stringify(moved));
    e.remember('disk', rows);

    // node_modules: changed since the scan is refused
    const nm = byAction('remove-node-modules');
    fake.hash = 'def5678';
    const c1 = await e.preview({ action: nm.action.id, id: nm.action.ref });
    fake.hash = 'abc1234'; fake.dirty = ' M src/a.js\n';
    const c2 = await e.preview({ action: nm.action.id, id: nm.action.ref });
    fake.dirty = ''; fake.tracked = true;
    const c3 = await e.preview({ action: nm.action.id, id: nm.action.ref });
    fake.tracked = false;
    if (!c1.ok && /commit since the scan/.test(c1.refused) && !c2.ok && /uncommitted files changed/.test(c2.refused) && !c3.ok && /commits its node_modules/.test(c3.refused)) {
      ok('node_modules: a commit since the scan, a changed set of uncommitted files, or a committed node_modules, each refuses');
    } else fail('node_modules accepted a repository that changed since the scan', JSON.stringify([c1.refused, c2.refused, c3.refused]));
    // and a change between the preview and the click
    const pn = await e.preview({ action: nm.action.id, id: nm.action.ref });
    fake.dirty = '?? new.txt\n';
    const rn = await e.run({ action: nm.action.id, id: nm.action.ref, nonce: pn.nonce });
    fake.dirty = '';
    if (pn.ok && !rn.ok) ok('node_modules: a file changed between the preview and the click, refused at the click');
    else fail('a repository that changed after the preview was acted on', JSON.stringify(rn));
    const a4 = await go(nm);
    if (a4.r && a4.r.argv.join(' ') === `safe-remove ${P('www', 'p', 'node_modules')}`) ok('node_modules unchanged since the scan: only <repo>/node_modules is removed');
    else fail('remove-node-modules built the wrong argv', JSON.stringify(a4));

    // worktree: git worktree remove, never --force
    const wt = byAction('remove-worktree');
    const a5 = await go(wt);
    fake.off = '2';
    const a6 = await e.preview({ action: wt.action.id, id: wt.action.ref });
    fake.off = '0';
    if (a5.r && a5.r.argv[0] === 'git' && a5.r.argv.includes('remove') && !a5.r.argv.some((x) => /^-(f|-force)$/.test(x)) && !a6.ok) ok('worktree: `git -C <main> worktree remove <path>` without --force, refused once it has commits off main');
    else fail('remove-worktree is wrong', JSON.stringify([a5, a6]));

    // worktree: ignored files are invisible to git status and to git's own refusal
    fake.ignored = 'node_modules/\n.next/\n';
    const w1 = await e.preview({ action: wt.action.id, id: wt.action.ref });
    fake.ignored = 'node_modules/\narte/bruto.png\n';
    const w2 = await e.preview({ action: wt.action.id, id: wt.action.ref });
    fake.ignored = null;
    const w3 = await e.preview({ action: wt.action.id, id: wt.action.ref });
    fake.ignored = 'node_modules/\n';
    const w4 = await go(wt);
    fake.ignored = '';
    if (w1.ok && /2 ignored regenerable item\(s\)/.test(w1.proof) && /\.next\/, node_modules\//.test(w1.proof)
      && !w2.ok && /arte\/bruto\.png/.test(w2.refused) && /copy them first/.test(w2.refused)
      && !w3.ok && /did not list the ignored/.test(w3.refused)
      && w4.r && w4.r.argv.join(' ') === `git -C ${P('www', 'r')} worktree remove ${fs.realpathSync(P('www', 'wt', 'a'))}`) {
      ok('worktree: only regenerable ignored folders are allowed and listed; an ignored file outside the allowlist, or a failed listing, refuses; argv has no --force');
    } else fail('worktree ignored-file check is wrong', JSON.stringify([w1, w2.refused, w3.refused, w4.r]));
    // a change of the ignored set between the preview and the click is refused at the click
    fake.ignored = 'node_modules/\n';
    const w5 = await e.preview({ action: wt.action.id, id: wt.action.ref });
    fake.ignored = 'node_modules/\ndist/\n';
    const w6 = await e.run({ action: wt.action.id, id: wt.action.ref, nonce: w5.nonce });
    fake.ignored = '';
    if (w5.ok && !w6.ok) ok('worktree: the ignored set is measured again at the click, and a change refuses');
    else fail('worktree ignored set changed after the preview and was acted on', JSON.stringify(w6));

    // the user's things: the Trash, by /usr/bin/trash or Finder
    const ios = byAction('move-to-trash');
    const a7 = await go(ios);
    trashBin = null;
    const a8 = await go(ios);
    trashBin = '/usr/bin/trash';
    if (a7.r && a7.r.argv[0] === '/usr/bin/trash' && a8.r && a8.r.argv[0] === 'osascript' && a8.r.argv.at(-1) === fs.realpathSync(ios.target.path) && a7.p.reversible && /put it back/.test(a7.p.removalLabel)) {
      ok('iOS backups go to the Trash: /usr/bin/trash, else Finder with the path as an argument (never inside the script), labelled "you can put it back"');
    } else fail('move-to-trash is wrong', JSON.stringify([a7, a8]));

    // empty the Trash: two confirmations, held by the server
    const tr = byAction('empty-trash');
    const s1 = await e.preview({ action: tr.action.id, id: tr.action.ref });
    const early = await e.run({ action: tr.action.id, id: tr.action.ref, nonce: s1.nonce });
    const s1b = await e.preview({ action: tr.action.id, id: tr.action.ref });
    const s2 = await e.preview({ action: tr.action.id, id: tr.action.ref, nonce: s1b.nonce });
    const done = await e.run({ action: tr.action.id, id: tr.action.ref, nonce: s2.nonce });
    if (s1.stage === 1 && !early.ok && /second confirmation/.test(early.refused) && s2.stage === 2 && done.ok && done.argv.join(' ') === 'osascript -e tell application "Finder" to empty trash') {
      ok('emptying the Trash needs two confirmations; the first one\'s nonce cannot run');
    } else fail('the Trash double confirmation is wrong', JSON.stringify([s1.stage, early, s2.stage, done]));

    // docker
    const vol = byAction('docker-volume-rm');
    fake.dangling = 'vol_a\n';
    const v1 = await e.preview({ action: vol.action.id, id: vol.action.ref });
    fake.dangling = 'vol_a\nvol_b\n';
    const v2 = await go(vol);
    const bp = await go(byAction('docker-builder-prune'));
    const sp = await go(byAction('docker-system-prune'));
    if (!v1.ok && v2.r && v2.r.argv.join(' ') === 'docker volume rm vol_a vol_b' && bp.r.argv.join(' ') === 'docker builder prune -f --filter until=48h' && sp.r.argv.join(' ') === 'docker system prune -f') {
      ok('docker: a volume that gained a container is refused; volume rm by name, builder prune until=48h, system prune with no -a and no --volumes');
    } else fail('a docker action is wrong', JSON.stringify([v1, v2.r, bp.r, sp.r]));

    // --- the queue -----------------------------------------------------------
    e = make(); e.remember('disk', rows);
    const items = [npx, nm, wt].map((r) => ({ action: r.action.id, id: r.action.ref }));
    const qp = await e.previewQueue({ items });
    const qr = qp.ok && await e.runQueue({ nonce: qp.nonce });
    if (qp.ok && qp.items.length === 3 && qp.totalKB === 3 * 2048 && qr && qr.ok && qr.results.length === 3 && qr.results.every((x) => x.dryRun)) ok('queue: three rows, one preview with the summed total, one confirmation, run one by one');
    else fail('the queue did not run its three rows', JSON.stringify([qp, qr]));
    const withTrash = await e.previewQueue({ items: [...items, { action: tr.action.id, id: tr.action.ref }] });
    if (!withTrash.ok) ok('emptying the Trash cannot ride in a queue: it has its own double confirmation');
    else fail('empty-trash was queued');
    e = make(); e.remember('disk', rows);
    const qp2 = await e.previewQueue({ items });
    fake.hash = 'fff0000';   // the repository moves on between the preview and the run
    const qr2 = await e.runQueue({ nonce: qp2.nonce });
    fake.hash = 'abc1234';
    if (qr2 && !qr2.ok && qr2.results.length === 2 && qr2.results[0].ok && !qr2.results[1].ok && qr2.skipped === 1) ok('queue: it stops at the first refusal (the repo got a commit), and the rest is not started');
    else fail('the queue did not stop at the first refusal', JSON.stringify(qr2));
    const qr3 = await e.runQueue({ nonce: qp2.nonce });
    if (!qr3.ok && /No queue preview/.test(qr3.refused)) ok('a queue nonce works once');
    else fail('a queue nonce was accepted twice');

    if (!ran.length && fs.existsSync(P('.npm', '_npx', 'f')) && fs.existsSync(P('www', 'p', 'node_modules', 'f'))) ok('dry run: nothing above ran, and every folder the test made is still there');
    else fail('a dry-run test ran a command or removed a folder', JSON.stringify(ran));
    if (logged.some((l) => l.dryRun) && logged.some((l) => l.refused)) ok('runs and refusals went to the action log');
    else fail('the disk actions were not logged');
  } finally { fs.rmSync(FH, { recursive: true, force: true }); }
}

// For real, in a child process with HOME in a temporary folder: the scan rows
// are built from reckon's own table under that HOME, and only folders the test
// made there are removed. Tool cleaners and the Trash are NOT run: `which` says
// no tool exists, there is no trash binary, and exec refuses everything.
async function diskSandbox() {
  if (process.platform !== 'darwin') { ok('(sandboxed disk test runs on macOS only)'); return; }
  if (process.env.RECKON_CHECK_CHILD) { ok('(sandboxed disk test runs once, in the parent suite)'); return; }
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const realLog = path.join(os.homedir(), '.cache', 'reckon', 'actions.log');
  const stamp = (f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } };
  const before = stamp(realLog);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-disk-sandbox-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-disk-outside-'));
  fs.writeFileSync(path.join(outside, 'precious'), 'must survive');
  const script = `
    const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const ROOT = ${JSON.stringify(ROOT)};
    const OUTSIDE = ${JSON.stringify(outside)};
    if (os.homedir() !== process.env.HOME || !/reckon-disk-sandbox-/.test(os.homedir())) { console.log(JSON.stringify({ floor: 'HOME is not the sandbox' })); process.exit(0); }
    const H = os.homedir();
    const act = require(path.join(ROOT, 'lib/act.js'));
    const decisions = require(path.join(ROOT, 'lib/decisions.js'));
    const platform = require(path.join(ROOT, 'lib/platform'));
    const { createLog } = require(path.join(ROOT, 'lib/actlog.js'));
    const res = {};
    (async () => {
      try {
        const known = platform.knownCacheTargets();
        const npx = known.find((t) => t.id === 'npm-npx'), pw = known.find((t) => t.id === 'playwright');
        res.inside = npx.path.startsWith(H) && pw.path.startsWith(H);
        fs.mkdirSync(path.join(npx.path, 'pkg'), { recursive: true }); fs.writeFileSync(path.join(npx.path, 'pkg', 'f'), 'x');
        fs.writeFileSync(path.join(H, '.npm', 'keep-me'), 'sibling');
        fs.mkdirSync(path.dirname(pw.path), { recursive: true }); fs.symlinkSync(OUTSIDE, pw.path);   // planted: the cache folder is a link out of home
        const repo = path.join(H, 'www', 'proj');
        fs.mkdirSync(path.join(repo, 'node_modules', 'dep'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'node_modules', 'dep', 'index.js'), '1');
        fs.writeFileSync(path.join(repo, 'package.json'), '{}');
        fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\\n');
        const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...a], { encoding: 'utf8' }).trim();
        execFileSync('git', ['init', '-q', repo]);
        g('add', '.'); g('commit', '-qm', 'one');
        const hash = () => g('log', '-1', '--format=%h');
        const build = () => decisions.build({ docker: null, targets: [{ ...npx, kb: 200000 }, { ...pw, kb: 200000 }],
          repos: { repos: [{ name: 'proj', path: repo, git: true, stale: true, days: 400, nodeModulesKB: 200000, lastHash: hash(), dirtyCount: 0, off: 0, hasRemote: true, manager: 'npm' }] } });
        const exec = [];
        const e = act.createEngine({ dryRun: false, minDelayMs: 0, which: () => null, trashBin: () => null,
          exec: async (c, a) => { exec.push([c, ...a]); return { ok: false, out: '', erro: 'the sandbox runs no program' }; },
          memoryStats: async () => null, memoryPressure: async () => null,
          log: createLog({ dir: path.join(H, '.cache', 'reckon') }) });
        let rows = [...build().out].filter((r) => r.action);
        e.remember('disk', rows);
        const row = (id, f) => rows.find((r) => r.action.id === id && (!f || f(r)));
        const go = async (r) => { const p = await e.preview({ action: r.action.id, id: r.action.ref }); return p.ok ? e.run({ action: r.action.id, id: r.action.ref, nonce: p.nonce }) : p; };

        const r1 = await go(row('clear-cache', (r) => r.target.members[0].id === 'npm-npx'));
        res.npx = { ok: r1.ok, gone: !fs.existsSync(npx.path), sibling: fs.existsSync(path.join(H, '.npm', 'keep-me')), before: r1.before && r1.before.freeKB != null, after: r1.after && r1.after.freeKB != null };
        const r2 = await go(row('clear-cache', (r) => r.target.members[0].id === 'playwright'));
        res.link = { refused: !r2.ok && !!r2.refused, why: r2.refused, precious: fs.existsSync(path.join(OUTSIDE, 'precious')) };

        fs.writeFileSync(path.join(repo, 'more.txt'), '2'); g('add', '.'); g('commit', '-qm', 'two');   // the repo moves on after the scan
        const r3 = await go(row('remove-node-modules'));
        res.changed = { refused: !r3.ok && /commit since the scan/.test(r3.refused || ''), still: fs.existsSync(path.join(repo, 'node_modules')) };
        rows = [...build().out].filter((r) => r.action); e.remember('disk', rows);   // a new scan
        const r4 = await go(row('remove-node-modules'));
        res.nm = { ok: r4.ok, gone: !fs.existsSync(path.join(repo, 'node_modules')), repo: fs.existsSync(path.join(repo, 'package.json')) && fs.existsSync(path.join(repo, '.git')) };
        // a real worktree with ignored content, in a dry run (nothing is removed either way)
        const base = g('rev-parse', '--abbrev-ref', 'HEAD');
        const wtp = path.join(H, 'www', 'proj-wt');
        g('worktree', 'add', '-q', '-b', 'wtb', wtp);
        fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\\narte\\n'); g('add', '.'); g('commit', '-qm', 'ignore');
        g('-C', wtp, 'merge', '-q', base);
        const e2 = act.createEngine({ dryRun: true, minDelayMs: 0, which: () => null, trashBin: () => null, exec: async () => ({ ok: false, out: '', erro: 'no' }),
          memoryStats: async () => null, memoryPressure: async () => null, log: createLog({ dir: path.join(H, '.cache', 'reckon') }) });
        const wrows = () => [...decisions.build({ docker: null, targets: [], repos: { repos: [], worktrees: [{ name: 'proj-wt', path: wtp, base, off: 0, days: 60, sizeKB: 300000, dirtyCount: 0 }] } }).out].filter((r) => r.action && r.action.id === 'remove-worktree');
        const wgo = async () => { const r = wrows()[0]; e2.remember('disk', [r]); const p = await e2.preview({ action: r.action.id, id: r.action.ref }); return p.ok ? { p, r: await e2.run({ action: r.action.id, id: r.action.ref, nonce: p.nonce }) } : { p }; };
        fs.mkdirSync(path.join(wtp, 'node_modules', 'dep'), { recursive: true }); fs.writeFileSync(path.join(wtp, 'node_modules', 'dep', 'i.js'), '1');
        const w1 = await wgo();
        fs.mkdirSync(path.join(wtp, 'arte'), { recursive: true }); fs.writeFileSync(path.join(wtp, 'arte', 'bruto.png'), 'art');
        const w2 = await wgo();
        res.wt = { allowed: !!(w1.r && w1.r.ok), lists: !!(w1.p.ok && /node_modules/.test(w1.p.proof) && /will be deleted with the worktree/.test(w1.p.proof)),
          argv: w1.r && w1.r.argv.join(' ') === ['git', '-C', fs.realpathSync(repo), 'worktree', 'remove', fs.realpathSync(wtp)].join(' '),
          refused: !w2.p.ok && /arte\\//.test(w2.p.refused || ''), file: fs.existsSync(path.join(wtp, 'arte', 'bruto.png')) };
        res.exec = exec.length;
        res.log = fs.readFileSync(path.join(H, '.cache', 'reckon', 'actions.log'), 'utf8').split('\\n').filter(Boolean).length;
      } catch (err) { res.error = String(err && err.stack || err).split('\\n').slice(0, 2).join(' | '); }
      console.log(JSON.stringify(res));
    })();
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 90000,
    env: { ...process.env, HOME: home, USERPROFILE: home, RECKON_ACT_DRY_RUN: '' } });
  let res;
  try { res = JSON.parse(String(r.stdout).trim().split('\n').pop()); }
  catch { res = { error: String(r.stderr || r.stdout).slice(0, 200) }; }
  const precious = fs.existsSync(path.join(outside, 'precious'));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  if (res.floor || res.error) return fail('the sandboxed disk test did not run', res.floor || res.error);
  if (res.inside) ok('in the sandbox, reckon\'s own table of caches points inside the temporary HOME');
  else fail('the sandbox table pointed outside the temporary HOME');
  if (res.npx && res.npx.ok && res.npx.gone && res.npx.sibling && res.npx.before && res.npx.after) ok('for real: the planted npx cache is removed, ~/.npm and its other file stay, free space read before and after');
  else fail('the sandboxed cache removal is wrong', JSON.stringify(res.npx));
  if (res.link && res.link.refused && res.link.precious && precious) ok('for real: a cache folder that is a link out of home is refused, and the file it points at survives');
  else fail('a cache link out of home was followed', JSON.stringify(res.link));
  if (res.changed && res.changed.refused && res.changed.still) ok('for real: a commit after the scan refuses the node_modules removal, and node_modules stays');
  else fail('node_modules was removed from a repository that changed since the scan', JSON.stringify(res.changed));
  if (res.nm && res.nm.ok && res.nm.gone && res.nm.repo) ok('for real: after a new scan, only <repo>/node_modules is removed; package.json and .git stay');
  else fail('the sandboxed node_modules removal is wrong', JSON.stringify(res.nm));
  if (res.wt && res.wt.allowed && res.wt.lists && res.wt.argv && res.wt.refused && res.wt.file) ok('for real: a worktree with only node_modules ignored is allowed and lists it; an ignored arte/bruto.png refuses and the file stays; argv has no --force');
  else fail('the real-worktree ignored-file check is wrong', JSON.stringify(res.wt));
  if (res.exec === 0) ok('no program was run in the sandbox: removal is in-process, and no tool cleaner was reached');
  else fail('the sandbox reached a program', String(res.exec));
  if (res.log >= 2) ok(`actions.log was written inside the sandbox (${res.log} lines)`);
  else fail('the sandbox action log is short', String(res.log));
  if (stamp(realLog) === before) ok('the real ~/.cache/reckon/actions.log was not touched by the disk tests');
  else fail('the disk tests wrote to the real actions.log');
}

// A child process with HOME (and so ~/.cache/reckon) in a fresh temporary folder.
// It spawns its own `sleep` processes, and the process list it gives the engine is
// filtered to exactly those pids: even a bug in the engine could not reach anything else.
async function actSandbox() {
  if (process.platform === 'win32') { ok('(sandboxed kill test not run on Windows: no kill or ps)'); return; }
  if (process.env.RECKON_CHECK_CHILD) { ok('(sandboxed kill test runs once, in the parent suite)'); return; }
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const realLog = path.join(os.homedir(), '.cache', 'reckon', 'actions.log');
  const stamp = (f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } };
  const before = stamp(realLog);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-act-check-'));
  const script = `
    const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const ROOT = ${JSON.stringify(ROOT)};
    if (os.homedir() !== process.env.HOME || !/reckon-act-check-/.test(os.homedir())) { console.log(JSON.stringify({ floor: 'HOME is not the sandbox' })); process.exit(0); }
    const { run } = require(path.join(ROOT, 'lib/sh.js'));
    const act = require(path.join(ROOT, 'lib/act.js'));
    const { createLog } = require(path.join(ROOT, 'lib/actlog.js'));
    const kids = [];
    const mine = new Set();
    const own = (c) => { kids.push(c); mine.add(c.pid); return c; };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Only this sandbox's own children, by pid, and nothing else on the machine.
    async function list() {
      if (!mine.size) return [];
      const r = await run('ps', ['-o', 'pid=,ppid=,rss=,etime=,comm=', '-p', [process.pid, ...mine].join(',')], { timeout: 5000 });
      const out = [];
      for (const l of String(r.out || '').split('\\n')) {
        const m = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(.*)$/.exec(l);
        if (!m) continue;
        // Its own children, plus itself: a list that is never empty, so "all gone" is a reading and not a failure.
        if (+m[1] !== process.pid && (!mine.has(+m[1]) || +m[2] !== process.pid)) continue;
        const t = /^(?:(\\d+)-)?(?:(\\d+):)?(\\d+):(\\d+)$/.exec(m[4]);
        const ageS = t ? (+(t[1] || 0)) * 86400 + (+(t[2] || 0)) * 3600 + (+t[3]) * 60 + (+t[4]) : null;
        out.push({ pid: +m[1], ppid: +m[2], rssKB: +m[3], ageS, command: m[5].trim() });
      }
      return out;
    }
    (async () => {
      const res = {};
      try {
        const a = own(spawn('sleep', ['60'], { stdio: 'ignore' }));
        const b = own(spawn('sleep', ['60'], { stdio: 'ignore' }));
        // A sleep that ignores the polite stop: SIG_IGN survives exec, so this is still sleep.
        const c = own(spawn('/bin/sh', ['-c', "trap '' TERM; exec sleep 60"], { stdio: 'ignore' }));
        await sleep(400);
        const e = act.createEngine({ processList: list, selfPid: process.pid, minDelayMs: 0, killAfterMs: 0, settleMs: 1500,
          memoryStats: async () => null, memoryPressure: async () => null,
          log: createLog({ dir: path.join(os.homedir(), '.cache', 'reckon') }) });
        const now = Date.now();
        const L = await list();
        res.seen = L.length;
        const ident = (pid) => { const p = L.find((x) => x.pid === pid); return { pid, comm: p.command, startedAt: now - p.ageS * 1000 }; };
        const row = (id, pids) => ({ id, title: id, confidence: 'high', lose: 'a test sleep', action: { id: 'term-processes', label: 'stop' }, target: { kind: 'test', pids: pids.map(ident) } });
        e.remember('pressure', [row('sandbox-two', [a.pid, b.pid]), row('sandbox-stubborn', [c.pid])]);

        const p = await e.preview({ action: 'term-processes', id: 'sandbox-two' });
        const r = await e.run({ action: 'term-processes', id: 'sandbox-two', nonce: p.nonce });
        res.two = { ok: r.ok, gone: r.gone, alive: r.stillAlive, ran: r.ran };

        const p2 = await e.preview({ action: 'term-processes', id: 'sandbox-stubborn' });
        const r2 = await e.run({ action: 'term-processes', id: 'sandbox-stubborn', nonce: p2.nonce });
        res.stubborn = { alive: r2.stillAlive, offer: r2.killOffer };
        const p3 = await e.preview({ action: 'kill-processes', id: 'sandbox-stubborn' });
        const r3 = p3.ok ? await e.run({ action: 'kill-processes', id: 'sandbox-stubborn', nonce: p3.nonce }) : p3;
        res.killed = { ok: r3.ok, gone: r3.gone, ran: r3.ran, refused: r3.refused };
        res.log = e && fs.readFileSync(path.join(os.homedir(), '.cache', 'reckon', 'actions.log'), 'utf8').split('\\n').filter(Boolean).length;
      } catch (err) { res.error = String(err && err.stack || err).split('\\n').slice(0, 2).join(' | '); }
      finally { for (const k of kids) { try { k.kill('SIGKILL'); } catch {} } }
      console.log(JSON.stringify(res));
    })();
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, USERPROFILE: home } });
  let res;
  try { res = JSON.parse(String(r.stdout).trim().split('\n').pop()); }
  catch { fs.rmSync(home, { recursive: true, force: true }); return fail('the sandboxed kill test printed nothing readable', String(r.stderr || r.stdout).slice(0, 160)); }
  fs.rmSync(home, { recursive: true, force: true });
  if (res.floor || res.error) return fail('the sandboxed kill test did not run', res.floor || res.error);
  if (res.seen === 4) ok('the sandbox sees exactly its own three sleep processes and itself, and nothing else on the machine');
  else fail('the sandbox saw the wrong processes', String(res.seen));
  if (res.two && res.two.ok && res.two.gone === 2 && !res.two.alive.length && res.two.ran[0] === 'kill' && res.two.ran[1] === '-TERM') ok('preview, confirm, run: SIGTERM stopped the two test sleeps, measured gone after');
  else fail('the polite stop did not work on the test sleeps', JSON.stringify(res.two));
  if (res.stubborn && res.stubborn.alive.length === 1 && res.stubborn.offer && res.stubborn.offer.action === 'kill-processes') ok('a sleep that ignores SIGTERM is still alive, and SIGKILL is OFFERED, not sent');
  else fail('the stubborn sleep was not handled as expected', JSON.stringify(res.stubborn));
  if (res.killed && res.killed.ok && res.killed.gone === 1 && res.killed.ran[1] === '-KILL') ok('the separate click sends SIGKILL, and the stubborn sleep is gone');
  else fail('the forced stop did not work', JSON.stringify(res.killed));
  if (res.log >= 3) ok(`actions.log was written inside the sandbox's own ~/.cache/reckon (${res.log} lines)`);
  else fail('actions.log was not written in the sandbox', String(res.log));
  if (stamp(realLog) === before) ok('the real ~/.cache/reckon/actions.log was not touched');
  else fail('the test wrote to the real ~/.cache/reckon/actions.log');
}

// Three read-only memory measurements: swap ACTIVITY (not size), HEADROOM, and LEAKS.
// Everything is a fixture: a fake vm_stat, a fake process list, and series whose time is
// the `t` each point carries, so three hours of story run in milliseconds.
async function memoryMeasures() {
  const w = require(path.join(ROOT, 'lib/watch.js'));
  const hr = require(path.join(ROOT, 'lib/headroom.js'));
  const lk = require(path.join(ROOT, 'lib/leak.js'));
  const hist = require(path.join(ROOT, 'lib/history.js'));
  const os = require('node:os');
  const platform = require(path.join(ROOT, 'lib/platform'));
  const R = (o) => ({ swapOfRam: 0.05, swapUsedMB: 800, swapTotalMB: 1024, ramMB: 16384, gainedOfRam: null, spanMs: null,
    factor: 1.1, probe: { nowMs: 350, bestMs: 319, factor: 1.1 }, rows: [], load1: 2, load5: 2, ncpu: 10,
    swapOutPerSec: 0, swapInPerSec: 0, swapMovingStreak: 0, leaks: [], ...o });
  const run = (readings) => {
    let st = w.emptyState(); const all = [];
    readings.forEach((r, i) => { const o = w.step(st, r, i * 30_000); st = o.state; all.push(...o.events); });
    return all;
  };
  const MBYTES = 1048576;

  // ---- 1. swap activity, not size
  const still = run(Array.from({ length: 10 }, () => R({ swapOfRam: 0.62, swapUsedMB: 10200 })));
  if (!still.length) ok('10 GB of swap that just sits there never alerts');
  else fail('swap size alone raised an alert', still.map((e) => e.kind).join(','));
  const oneBurst = run([R({ swapOfRam: 0.4, swapMovingStreak: 1, swapOutPerSec: 900 }), R({ swapOfRam: 0.4, swapMovingStreak: 0 })]);
  if (!oneBurst.length) ok('one burst of swap-outs is not sustained, so it is silent');
  else fail('a single moving reading alerted', oneBurst.map((e) => e.kind).join(','));

  const moving = run([R({ swapOfRam: 0.4, swapUsedMB: 6500, swapOutPerSec: 350, swapInPerSec: 120, swapMovingStreak: 1 }),
    R({ swapOfRam: 0.4, swapUsedMB: 6500, swapOutPerSec: 350, swapInPerSec: 120, swapMovingStreak: 2 })]);
  const sw = moving.find((e) => e.type === 'alert' && e.kind === 'swap');
  if (sw && /350 pages\/s/.test(sw.title) && /350 pages\/s going out/.test(sw.proof) && sw.cost && sw.lose) ok('swap that is moving alerts, with the measured rate in the title and the proof');
  else fail('the moving-swap alert is missing or states no rate', JSON.stringify(sw && { title: sw.title, proof: sw.proof }));

  const slowProbe = run([R({ swapOfRam: 0.4, swapUsedMB: 6500, swapOutPerSec: 3, swapInPerSec: 1, factor: 9, probe: { nowMs: 2900, bestMs: 319, factor: 9 } })]);
  const sw2 = slowProbe.find((e) => e.kind === 'swap');
  if (sw2 && /3 pages\/s/.test(sw2.proof)) ok('held swap plus a slow probe alerts, and still states the measured rate');
  else fail('the slowdown-probe path for swap is wrong', JSON.stringify(sw2));
  const fastNoSwap = run([R({ swapOfRam: 0.05, factor: 9, probe: { nowMs: 2900, bestMs: 319, factor: 9 } })]);
  if (!fastNoSwap.some((e) => e.kind === 'swap')) ok('a slow probe with almost no swap does not blame swap');
  else fail('a slow probe with 5% swap raised a swap alert');

  // the rate itself, from cumulative counters
  const t0 = { t: 0, swapouts: 1000, swapins: 500 };
  const r1 = w.swapRate(t0, { t: 30_000, swapouts: 7000, swapins: 800 });
  if (r1 && r1.outPerSec === 200 && r1.inPerSec === 10) ok('the rate is the counter difference over the seconds between two readings');
  else fail('swapRate arithmetic is wrong', JSON.stringify(r1));
  const nulls = [w.swapRate(null, t0), w.swapRate(t0, { t: 1, swapouts: null, swapins: null }), w.swapRate(t0, { t: 0, swapouts: 2000, swapins: 600 }),
    w.swapRate(t0, { t: 30_000, swapouts: 10, swapins: 5 })];
  if (nulls.every((x) => x === null)) ok('a missing counter, no elapsed time, or a counter that went backwards is null, never 0');
  else fail('swapRate returned a number where it could not measure', JSON.stringify(nulls));

  // the whole path through sampleCheap with a stubbed platform, restored after
  const keep = { m: platform.memoryStats, s: platform.swapStats };
  try {
    let n = 0;
    const counters = [[1000, 0], [1000, 0], [1000, 0], [10_000, 400], [19_000, 800]];   // flat, then 300 pages/s twice
    platform.memoryStats = async () => { const c = counters[Math.min(n++, counters.length - 1)]; return { swapouts: c[0], swapins: c[1] }; };
    platform.swapStats = async () => ({ usedMB: 9000, totalMB: 10000, freeMB: 1000 });
    const mem = { prev: null, movingStreak: 0 };   // no `series`: the leak sampler is not part of this case
    const hist2 = [];
    const taken = [];
    for (let i = 0; i < 5; i++) taken.push(await w.sampleCheap(hist2, 1_000_000 + i * 30_000, mem));
    const still2 = taken.slice(0, 3).every((x) => x.swapMovingStreak === 0) && taken[0].swapOutPerSec === null && taken[1].swapOutPerSec === 0;
    const fast = taken[4].swapMovingStreak === 2 && Math.round(taken[4].swapOutPerSec) === 300;
    const ev = run([taken[0], taken[1], taken[2]]);
    const ev2 = (() => { let st = w.emptyState(); const out = []; for (const [i, r] of [taken[3], taken[4]].entries()) { const o = w.step(st, r, i * 30_000); st = o.state; out.push(...o.events); } return out; })();
    if (still2 && !ev.length) ok('read end to end: 9 GB held with flat counters stays silent');
    else fail('flat counters were read as movement', JSON.stringify(taken.map((x) => [x.swapOutPerSec, x.swapMovingStreak])));
    if (fast && ev2.some((e) => e.kind === 'swap' && /300 pages\/s/.test(e.proof))) ok('read end to end: two readings at 300 pages/s raise the swap alert');
    else fail('moving counters did not reach the alert', JSON.stringify(taken.slice(3).map((x) => [x.swapOutPerSec, x.swapMovingStreak])));
  } finally { platform.memoryStats = keep.m; platform.swapStats = keep.s; }

  // the lantern: only what feeds `level` changed, never the state cut-offs
  const L = w.levelOf;
  if (L({ swapOfRam: 0.62, moving: false }) < 0.15 && w.stateOf(L({ swapOfRam: 0.62, moving: false })) === 'resting') ok('held swap with nothing moving reads as a resting lantern');
  else fail('held swap still colours the lantern', String(L({ swapOfRam: 0.62, moving: false })));
  if (L({ swapOfRam: 0.79, moving: true }) === 1 && L({ swapOfRam: 0.79 }) === 1 && L({ swapOfRam: 0.79, factor: 20, moving: false }) === 1) ok('moving swap, or an unmeasured rate, or a slow probe, keeps the old scale');
  else fail('the level scale changed where it must not');
  if (/swapOutPagesPerSec: 100/.test(read('lib/watch.js')) && w.TUNING.swapOutPagesPerSec === 100 && w.TUNING.swapMovingReadings === 2) ok('the swap-out line and the two-reading rule are TUNING constants');
  else fail('the swap activity thresholds are not in TUNING');

  // ---- 2. headroom
  const fakeVm = (o) => ({ totalBytes: 16384 * MBYTES, freeBytes: 1024 * MBYTES, inactiveBytes: 3072 * MBYTES, purgeableBytes: 1024 * MBYTES, activeBytes: 8000 * MBYTES, wiredBytes: 2000 * MBYTES, compressedBytes: 2000 * MBYTES, ...o });
  const P = (family, command, rssKB, pid) => ({ family, command, rssKB, pid, ppid: 1, cpuPct: 0 });
  const procs = [P('Claude Code (CLI)', '/usr/local/bin/claude', 300 * 1024, 1), P('Claude Code (CLI)', '/usr/local/bin/claude', 300 * 1024, 2), P('Claude Code (CLI)', '/usr/local/bin/claude', 300 * 1024, 3),
    P('Godot_v4.3', '/Applications/Godot.app/Contents/MacOS/Godot', 1200 * 1024, 4), P('node (dev servers)', '/usr/local/bin/node', 900 * 1024, 5)];
  const a1 = hr.compute({ vm: fakeVm({}), procs, lines: [], totalBytes: 16384 * MBYTES });
  if (a1.availableMB === 4096) ok('headroom is free + max(inactive, purgeable): 1 GB + max(3 GB, 1 GB) = 4096 MB');
  else fail('the headroom formula is wrong', String(a1.availableMB));
  const a2 = hr.compute({ vm: fakeVm({ purgeableBytes: 5120 * MBYTES }), procs, lines: [], totalBytes: 16384 * MBYTES });
  if (a2.availableMB === 6144) ok('purgeable memory larger than inactive is used once, not added on top (1 GB + 5 GB)');
  else fail('purgeable was double counted or dropped', String(a2.availableMB));
  const a3 = hr.compute({ vm: fakeVm({ purgeableBytes: null }), procs, lines: [], totalBytes: 16384 * MBYTES });
  if (a3.availableMB === 4096) ok('a platform with no purgeable notion (null) is not read as an error');
  else fail('purgeableBytes null broke the formula', String(a3.availableMB));
  const claude = a1.perApp.find((x) => x.key === 'claude');
  const godot = a1.perApp.find((x) => x.key === 'godot');
  // room = 4096 - 1024 kept for the system = 3072
  if (claude && claude.typicalMB === 350 && claude.source === 'default' && claude.fits === 8 && claude.running === 3) ok('with no history the default is used and fits = floor((available - reserve) / typical) = 8');
  else fail('the fits arithmetic with defaults is wrong', JSON.stringify(claude));
  if (godot && godot.fits === 3 && godot.typicalMB === 1000) ok('a heavier app fits fewer times: Godot at 1000 MB fits 3');
  else fail('Godot fits is wrong', JSON.stringify(godot));
  const lines = Array.from({ length: 5 }, (_, i) => ({ t: i, fam: {}, app: { claude: { mb: 900, n: 3 } } }));
  const a4 = hr.compute({ vm: fakeVm({}), procs, lines, totalBytes: 16384 * MBYTES });
  const claude4 = a4.perApp.find((x) => x.key === 'claude');
  if (claude4.typicalMB === 300 && claude4.source === 'history' && claude4.fits === 10) ok('history wins over the default: 900 MB over 3 processes is 300 MB each, so 10 fit');
  else fail('history was not used', JSON.stringify(claude4));
  const shape = a1 && typeof a1.availableMB === 'number' && ['comfortable', 'tight', 'critical'].includes(a1.pressure) && Array.isArray(a1.perApp)
    && a1.perApp.every((x) => typeof x.name === 'string' && typeof x.typicalMB === 'number' && Number.isInteger(x.fits)) && typeof a1.verdict === 'string' && a1.verdict.length > 0;
  if (shape) ok('the answer has the shape { availableMB, pressure, perApp: [{ name, typicalMB, fits }], verdict }');
  else fail('the headroom answer has the wrong shape', JSON.stringify(a1).slice(0, 200));
  const crit = hr.compute({ vm: fakeVm({ freeBytes: 100 * MBYTES, inactiveBytes: 200 * MBYTES, purgeableBytes: 0 }), procs, lines: [], totalBytes: 16384 * MBYTES });
  if (crit.pressure === 'critical' && crit.perApp.every((x) => x.fits === 0) && /Start nothing more/.test(crit.verdict)) ok('under the reserve nothing fits, the pressure is critical, and the verdict says so');
  else fail('a nearly empty machine still has room', JSON.stringify(crit.perApp.map((x) => x.fits)));
  const none = hr.compute({ vm: null, procs, lines: [], totalBytes: 16384 * MBYTES });
  if (none.availableMB === null && none.pressure === null && /Cannot tell/.test(none.verdict)) ok('no memory reading means "cannot tell", not a guess');
  else fail('headroom guessed without a reading');
  const electron = hr.classify({ family: 'Slack', command: '/Applications/Slack.app/Contents/MacOS/Slack' });
  const sim = hr.classify({ family: 'launchd_sim', command: '/Library/Developer/CoreSimulator/Volumes/iOS/launchd_sim' });
  if (electron && electron.key === 'electron' && sim && sim.key === 'simulators' && hr.classify({ family: 'Chrome', command: '/Applications/Google Chrome.app/x' }) === null) ok('apps are classified by family: AI CLIs, Godot, Electron, Docker VM, simulators');
  else fail('classify put a process in the wrong family');
  const hsrc = read('lib/headroom.js');
  if (!/writeFile|appendFile|rename|unlink|rmSync|child_process|spawn|exec\(|recordFamilies|recordMemory/.test(hsrc)) ok('lib/headroom.js has no way to write, delete or start anything');
  else fail('lib/headroom.js can write or start something');

  // ---- 3. leaks
  const HOUR = 3_600_000;
  const rand = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const make = (hours, f, step = 4 * 60_000) => { const out = []; for (let t = 0; t <= hours * HOUR; t += step) out.push({ t, mb: f(t / HOUR) }); return out; };
  const rnd = rand(7);
  const rising = make(3.2, (h) => 800 + 120 * h + (rnd() - 0.5) * 20);
  const v = lk.verdict(rising);
  if (v && Math.abs(v.slopeMBPerHour - 120) < 15 && v.hours >= 2.8 && v.lastMB > v.firstMB) ok('a family climbing 120 MB/h for three hours is a leak, with its slope and duration');
  else fail('a true leak was missed', JSON.stringify(v));
  const flat = make(3.2, () => 1500 + (rnd() - 0.5) * 120);
  const noisy = make(3.2, (h) => 1500 + 300 * Math.sin(h * 9) + (rnd() - 0.5) * 200);
  const late = make(3.2, (h) => 900 + (h < 2.2 ? 0 : 200 * (h - 2.2)) + (rnd() - 0.5) * 10);
  const stopped = make(3.2, (h) => 900 + (h < 2 ? 150 * h : 300) + (rnd() - 0.5) * 10);
  const saw = make(3.2, (h) => 900 + 500 * (h % 1) + (rnd() - 0.5) * 10);
  const fine = [lk.verdict(flat), lk.verdict(noisy), lk.verdict(late), lk.verdict(stopped), lk.verdict(saw)];
  if (fine.every((x) => x === null)) ok('flat, noisy, late-starting, stopped and sawtooth families are not flagged');
  else fail('a family that is not leaking was flagged', JSON.stringify(fine.map((x) => x && Math.round(x.slopeMBPerHour))));
  const tooShort = make(1, (h) => 800 + 400 * h);
  const slow = make(3.2, (h) => 800 + 30 * h);
  if (lk.verdict(tooShort) === null && lk.verdict(slow) === null) ok('under three hours of readings, or under 50 MB/h, is not enough');
  else fail('too little evidence was called a leak');
  const tiny = make(3.2, (h) => 10 + 55 * h);
  if (lk.verdict(tiny) === null) ok('a family under 200 MB is too small to matter');
  else fail('a tiny family was flagged');
  const ser = lk.emptySeries();
  for (let i = 0; i < 200; i++) lk.push(ser, { A: 500 + i }, i * lk.LEAK.pointEveryMs);
  if (ser.map.get('A').length === 60) ok('the in-memory series is bounded at 60 points');
  else fail('the series grew past its bound', String(ser.map.get('A').length));
  if (lk.push(ser, { A: 1 }, 199 * lk.LEAK.pointEveryMs + 1000) === false) ok('two samples inside the spacing rule are one point');
  else fail('the spacing rule did not hold');
  const seeded = lk.seed(lk.emptySeries(), Array.from({ length: 50 }, (_, i) => ({ t: i * lk.LEAK.pointEveryMs, fam: { A: { mb: 400 + 40 * i, n: 2 } } })));
  if (seeded.map.get('A').length === 50) ok('a restart rebuilds the series from the history file lines');
  else fail('seed lost points');

  // the alert: proof and lose text, and no command invented
  const lkv = { family: 'Claude Code (CLI)', ...v };
  const events = run([R({ leaks: [lkv] })]);
  const al = events.find((e) => e.kind === 'leak:Claude Code (CLI)' && e.type === 'alert');
  if (al && /MB per hour/.test(al.proof) && /GB|MB/.test(al.proof) && /h \(/.test(al.proof) && /loses its in-memory state/.test(al.lose) && al.cost) ok('a leak alert carries first and last RSS, slope, duration, cost, and "restarting loses its in-memory state"');
  else fail('the leak alert is incomplete', JSON.stringify(al));
  if (al && al.command === null && !/kill|restart it with|quit/i.test(al.hint)) ok('a leak alert with no pressure row shows NO command: none is invented');
  else fail('a leak alert invented a command', JSON.stringify(al && { command: al.command, hint: al.hint }));
  const row = { id: 'swarm-yes', title: '365 copies of yes', kb: 171 * 1024, costPct: 300, confidence: 'high', proof: 'p', lose: 'l', command: 'kill 101 102' };
  const al2 = run([R({ leaks: [lkv], rows: [row] })]).find((e) => e.kind === 'leak:Claude Code (CLI)');
  if (al2 && al2.command === 'kill 101 102') ok('an existing high-confidence pressure row command is shown, as for every other alert');
  else fail('the pressure row command was not offered', JSON.stringify(al2 && al2.command));
  const cleared = run([R({ leaks: [lkv] }), R({ leaks: [] }), R({ leaks: [] })]);
  if (cleared.some((e) => e.type === 'clear' && e.kind === 'leak:Claude Code (CLI)')) ok('a leak clears after two readings without it');
  else fail('a leak never cleared');
  const rep = run(Array.from({ length: 8 }, () => R({ leaks: [lkv] })));
  if (rep.filter((e) => e.kind.startsWith('leak:')).length === 1) ok('a leak speaks once, not once per reading');
  else fail('a leak rang more than once');
  const unknownLeak = run([R({ leaks: [lkv] }), R({ leaks: null }), R({ leaks: null }), R({ leaks: null })]);
  if (!unknownLeak.some((e) => e.type === 'clear')) ok('a family sample that was not taken cannot clear a leak');
  else fail('an unmeasured leak reading cleared an alert');
  if (w.TUNING.leak === lk.LEAK && lk.LEAK.slopeMBPerHour === 50 && lk.LEAK.windowHours === 3) ok('the leak slope (50 MB/h) and window (3 hours) are TUNING constants');
  else fail('the leak thresholds are not in TUNING');

  // the history file: one line per sample, trimmed
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-fam-check-'));
  try {
    for (let i = 0; i < 1600; i++) hist.recordFamilies({ t: i, fam: { 'Claude Code (CLI)': { mb: 500 + i, n: 2 } }, app: { claude: { mb: 600, n: 2 } } }, { dir });
    const back = hist.readFamilies({ dir, limit: 5000 });
    if (back.length <= 1500 && back.length >= 1000 && back[back.length - 1].t === 1599 && back[back.length - 1].fam['Claude Code (CLI)'].mb === 2099) ok('family-history.jsonl is appended inside the cache folder and trimmed like memory-history.jsonl');
    else fail('the family history was not trimmed or lost its tail', String(back.length));
    if (fs.readdirSync(dir).every((f) => f === hist.FAM_FILE)) ok('the history leaves no stray files behind');
    else fail('the history left temp files', fs.readdirSync(dir).join(','));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // ---- the platform seam, and the routes
  if (/purgeableBytes: null/.test(read('lib/platform/win32.js')) && /purgeableBytes: bytes\('Pages purgeable'\)/.test(read('lib/platform/darwin.js'))) ok('purgeableBytes is a number on macOS and null on Windows, never 0');
  else fail('purgeableBytes is not null where the platform has no such notion');
  if (/swapins: numOr\(d\.swapins, null\)/.test(read('lib/platform/win32.js'))) ok('a platform without the page counters returns null, which swapRate keeps as null');
  else fail('win32 no longer returns null for missing counters');
  const srv = read('server.js');
  const at = srv.indexOf("route === '/api/headroom'");
  if (at > srv.indexOf('HOSTS.has(req.headers.host)') && srv.indexOf('HOSTS.has(req.headers.host)') > 0 && /route === '\/api\/headroom' && req\.method === 'GET'/.test(srv)) ok('/api/headroom is a GET and sits below the Host guard');
  else fail('/api/headroom is not guarded as a GET');
  if (!/route === '\/api\/headroom'(?! && req\.method === 'GET')/.test(srv)) ok('/api/headroom has no route without the GET condition');
  else fail('there is a /api/headroom route that is not GET only');
  if (!/headroom\.(?!collect)\w+\(/.test(srv.replace(/require\('\.\/lib\/headroom'\)/, ''))) ok('server.js uses headroom only to read');
  else fail('server.js calls something on headroom besides collect()');
}

// ---------------------------------------------------------------------------
// AI tools: idle AI sessions, orphaned MCP / tool servers, Ollama models.
// Everything here runs against a FAKE machine (process list, terminals,
// working folders, transcript times, ports) and a dry run, and the one HTTP
// server it talks to is a fake Ollama this test starts on a random loopback
// port. No real process is looked up, no real ~/.claude is read, no real
// Ollama is contacted. The bad cases are planted first: a guard that has never
// refused anything proves nothing.
// ---------------------------------------------------------------------------
async function aiActions(act) {
  const http = require('node:http');
  const ai = require(path.join(ROOT, 'lib/aitools.js'));
  const H = 3600, NOW = 2_000_000_000_000, HOME = '/Users/sample';
  const P = (pid, ppid, command, ageS, tty = null, extra = {}) => ({ pid, ppid, command, ageS, startedAt: NOW - ageS * 1000, tty, rssKB: 300 * 1024, cpuPct: 0.1, ...extra });
  const CLAUDE = '/Users/sample/.local/bin/claude';
  let procs;
  const resetProcs = () => {
    procs = [
      P(400, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', 20 * H, null, { systemManaged: true }),
      P(450, 400, '/bin/zsh', 20 * H, 'ttys001'),
      P(500, 450, CLAUDE, 10 * H, 'ttys001'),           // the agent that started reckon: an ancestor
      P(600, 500, '/bin/zsh', H, 'ttys001'),
      P(777, 600, '/usr/local/bin/node', 100, null),    // reckon itself (no terminal of its own here)
      P(4001, 400, '/bin/zsh', 9 * H, 'ttys002'), P(1001, 4001, CLAUDE, 8 * H, 'ttys002'),            // idle, transcript old: offered
      P(4002, 400, '/bin/zsh', 9 * H, 'ttys003'), P(1002, 4002, CLAUDE, 8 * H, 'ttys003'), P(1003, 1002, '/usr/local/bin/node', 8 * H, 'ttys003'),   // has a child
      // Each under a shell of its own, as in a real terminal tab (the shell is the parent, not Terminal.app).
      P(1004, 4004, CLAUDE, 8 * H, 'ttys004'), P(4004, 400, '/bin/zsh', 9 * H, 'ttys004'),     // terminal used 30 min ago
      P(1005, 4005, CLAUDE, 8 * H, 'ttys005'), P(4005, 400, '/bin/zsh', 9 * H, 'ttys005'),     // transcript written 30 min ago
      P(1006, 4006, CLAUDE, 8 * H, 'ttys006'), P(4006, 400, '/bin/zsh', 9 * H, 'ttys006'),     // terminal unreadable
      P(1007, 4007, CLAUDE, 8 * H, 'ttys007'), P(4007, 400, '/bin/zsh', 9 * H, 'ttys007'),     // working folder unreadable
      P(1008, 4008, CLAUDE, 8 * H, 'ttys008'), P(4008, 400, '/bin/zsh', 9 * H, 'ttys008'),     // no transcript at all
      P(1009, 4009, '/opt/homebrew/bin/codex', 8 * H, 'ttys010'), P(4009, 400, '/bin/zsh', 9 * H, 'ttys010'),   // a tool whose transcripts reckon does not know
      P(1011, 4011, CLAUDE, 2 * H, 'ttys011'), P(4011, 400, '/bin/zsh', 9 * H, 'ttys011'),     // younger than 6 h
      P(1013, 1, '/Applications/Notch.app/Contents/MacOS/Notch', 9 * H, null, { systemManaged: true }), P(1012, 1013, CLAUDE, 8 * H, 'ttys012'),   // an app's engine
    ];
  };
  resetProcs();
  const TTY = { ttys001: NOW - 3 * H * 1000, ttys002: NOW - 3 * H * 1000, ttys003: NOW - 3 * H * 1000, ttys004: NOW - 1800 * 1000,
    ttys005: NOW - 3 * H * 1000, ttys007: NOW - 3 * H * 1000, ttys008: NOW - 3 * H * 1000, ttys010: NOW - 3 * H * 1000, ttys011: NOW - 3 * H * 1000, ttys012: NOW - 3 * H * 1000 };
  const CWD = { 500: `${HOME}/www/r`, 1001: `${HOME}/www/p1`, 1002: `${HOME}/www/p2`, 1004: `${HOME}/www/p4`, 1005: `${HOME}/www/p5`, 1006: `${HOME}/www/p6`, 1008: `${HOME}/www/p8`, 1012: `${HOME}/www/n` };
  const TR = new Map();
  const transcript = (cwd, at, count = 3) => TR.set(ai.projectDir(HOME, cwd), { at, count });
  for (const pid of [500, 1001, 1002, 1004, 1006, 1012]) transcript(CWD[pid], NOW - 3 * H * 1000);
  transcript(CWD[1005], NOW - 1800 * 1000);
  let PORTS = [];
  let ARGS = {};
  const reads = { ttys: [], cwds: [], dirs: [] };
  const probe = {
    now: () => NOW, home: () => HOME,
    ttyTouchedAt: async (t) => { reads.ttys.push(t); return TTY[t] ?? null; },
    cwdOf: async (pid) => { reads.cwds.push(pid); return CWD[pid] ?? null; },
    newestTranscript: async (dir) => { reads.dirs.push(dir); return TR.get(dir) || null; },
    argsOf: async (pids) => (ARGS == null ? null : Object.fromEntries(pids.filter((p) => ARGS[p]).map((p) => [p, ARGS[p]]))),
    ports: async () => PORTS,
    ollamaLoaded: async () => null,
    which: () => null,
  };
  const ran = [], logged = [];
  const make = (o = {}) => act.createEngine({
    processList: async () => procs.map((p) => ({ ...p })),
    appBundle: async () => null, runningContainers: async () => 0, memoryStats: async () => null, memoryPressure: async () => null,
    exec: async (cmd, args) => { ran.push([cmd, ...args]); return { ok: true, out: '', erro: null }; },
    log: { append: (e) => { logged.push(e); return true; } },
    now: () => NOW, home: () => HOME, selfPid: 777, dryRun: true, minDelayMs: 0, killAfterMs: 0, settleMs: 0,
    which: () => null, ai: probe, ...o,
  });
  const ident = (p) => ({ pid: p.pid, comm: p.command, startedAt: p.startedAt });
  const byPid = (pid) => procs.find((p) => p.pid === pid);

  // --- 1. idle AI sessions ------------------------------------------------
  const rows = await ai.idleSessions(procs, probe, 777);
  const ids = rows.map((r) => r.id).sort().join(',');
  const want = ['ai-session-1001', 'ai-session-1002', 'ai-session-1006', 'ai-session-1007', 'ai-session-1008', 'ai-session-1009'].join(',');
  if (ids === want) ok('idle sessions: one row each for the idle-looking ones; reckon\'s own agent, a busy terminal, a fresh transcript, a young session and an app\'s engine get no row');
  else fail('the idle-session rows are wrong', ids);
  const offered = rows.filter((r) => r.action).map((r) => r.id);
  if (offered.join() === 'ai-session-1001' && rows.filter((r) => !r.action).every((r) => r.confidence === 'low')) ok('only the session with every proof (6 h old, no child, terminal and transcript quiet for 2 h) gets a button; the rest are low and copy-only');
  else fail('a session got a button without every proof', offered.join());
  const r1001 = rows.find((r) => r.id === 'ai-session-1001');
  if (r1001 && r1001.confidence === 'medium' && /stays on disk/.test(r1001.lose) && r1001.lose.includes(`cd '${HOME}/www/p1' && claude --resume`) && /modification time only/.test(r1001.proof) && /3h0m ago/.test(r1001.proof)) ok('the offered row is medium, its proof has the measured idle times, and its lose says the conversation stays on disk with the exact resume command');
  else fail('the offered session row is missing its proof or its resume command', JSON.stringify(r1001));
  const whyOf = (id) => (rows.find((r) => r.id === id) || {}).proof || '';
  if (/child process/.test(whyOf('ai-session-1002')) && /Cannot judge/.test(whyOf('ai-session-1006')) && /Cannot judge/.test(whyOf('ai-session-1007'))
    && /No transcript/.test(whyOf('ai-session-1008')) && /does not know where codex/.test(whyOf('ai-session-1009'))) ok('each copy-only session says why: a live child, an unreadable terminal or folder ("cannot judge"), no transcript, or a tool reckon cannot read');
  else fail('a copy-only session does not say why', [1002, 1006, 1007, 1008, 1009].map((p) => whyOf(`ai-session-${p}`).slice(-80)).join(' | '));
  if (!reads.cwds.includes(500) && !reads.ttys.includes('ttys012')) ok('reckon\'s own ancestor and an app\'s engine are refused before anything about them is even read');
  else fail('an ancestor or an app engine was measured as a candidate');

  let e = make();
  e.remember('pressure', rows);
  const p1 = await e.preview({ action: 'end-ai-session', id: 'ai-session-1001' });
  const run1 = p1.ok && await e.run({ action: 'end-ai-session', id: 'ai-session-1001', nonce: p1.nonce });
  if (p1.ok && /stays on disk/.test(p1.lose) && /claude --resume/.test(p1.undo) && p1.reversible === false && run1 && run1.dryRun
    && JSON.stringify(run1.argv) === JSON.stringify(['kill', '-TERM', '1001'])) ok('preview then dry run: the argv is exactly ["kill", "-TERM", "1001"], nothing else, and the preview shows the resume command');
  else fail('the idle-session action is wrong', JSON.stringify(run1 || p1));
  const line = logged.find((l) => l.action === 'end-ai-session' && l.dryRun);
  if (line && line.info && line.info.resume && line.info.tty === 'ttys002') ok('actions.log gets the session\'s terminal, folder and resume command');
  else fail('the idle-session log line has no target info', JSON.stringify(line));

  // Forged rows: even a row this collector never built is judged again at the click.
  const forge = (pid, over = {}) => ({ id: `ai-session-${pid}`, title: 'forged', confidence: 'medium', lose: 'x',
    action: { id: 'end-ai-session', label: 'End' },
    target: { kind: 'ai-session', tool: 'claude', tty: byPid(pid).tty, cwd: CWD[pid] || null, dirShown: 'x', resume: 'x', pid: ident(byPid(pid)), ...over } });
  const tryForged = async (pid, over) => { const x = make(); x.remember('pressure', [forge(pid, over)]); return x.preview({ action: 'end-ai-session', id: `ai-session-${pid}` }); };
  const fAnc = await tryForged(500), fSelf = await tryForged(777), fKid = await tryForged(1002), fTty = await tryForged(1004),
    fTr = await tryForged(1005), fNoTty = await tryForged(1006), fYoung = await tryForged(1011), fApp = await tryForged(1012);
  if (!fAnc.ok && /reckon itself or runs it/.test(fAnc.refused) && !fSelf.ok && /reckon itself/.test(fSelf.refused)) ok('the agent that started reckon (an ancestor) and reckon itself are refused at the click, even on a forged row');
  else fail('reckon or its ancestor could be signalled', JSON.stringify([fAnc, fSelf]));
  if (!fKid.ok && /child process/.test(fKid.refused)) ok('a session with a live child is refused at the click');
  else fail('a session with a child was accepted', JSON.stringify(fKid));
  if (!fTty.ok && /terminal was used/.test(fTty.refused) && !fTr.ok && /transcript in its folder was written/.test(fTr.refused)) ok('a terminal used 30 min ago, or a transcript written 30 min ago, is refused');
  else fail('a recently active session was accepted', JSON.stringify([fTty, fTr]));
  if (!fNoTty.ok && /Cannot judge/.test(fNoTty.refused)) ok('a session whose idleness cannot be measured is refused: "cannot judge"');
  else fail('an unmeasurable session was accepted', JSON.stringify(fNoTty));
  if (!fYoung.ok && !fApp.ok) ok('a session younger than 6 h, and the engine of a running app, are refused');
  else fail('a young session or an app engine was accepted');

  // Same terminal as reckon: never, even when everything else holds.
  procs.find((p) => p.pid === 777).tty = 'ttys002';
  const sameTty = await ai.idleSessions(procs, probe, 777);
  const fSame = await tryForged(1001);
  if (!sameTty.some((r) => r.id === 'ai-session-1001') && !fSame.ok && /same terminal as reckon/.test(fSame.refused)) ok('a session on reckon\'s own terminal gets no row and is refused');
  else fail('a session on reckon\'s terminal was offered', JSON.stringify(fSame));
  resetProcs();

  // Between the preview and the click.
  const between = async (change) => {
    resetProcs();
    const x = make(); x.remember('pressure', rows);
    const pv = await x.preview({ action: 'end-ai-session', id: 'ai-session-1001' });
    const undo = change();
    const rv = await x.run({ action: 'end-ai-session', id: 'ai-session-1001', nonce: pv.nonce });
    if (undo) undo();
    resetProcs();
    return { pv, rv };
  };
  const typed = await between(() => { const was = TTY.ttys002; TTY.ttys002 = NOW - 60 * 1000; return () => { TTY.ttys002 = was; }; });
  const wrote = await between(() => { const k = ai.projectDir(HOME, CWD[1001]); const was = TR.get(k); TR.set(k, { at: NOW - 60 * 1000, count: 4 }); return () => TR.set(k, was); });
  const reused = await between(() => { byPid(1001).startedAt += 60000; });
  const other = await between(() => { byPid(1001).command = '/bin/zsh'; });
  const spawned = await between(() => { procs.push(P(1099, 1001, '/usr/local/bin/node', 10, 'ttys002')); });
  const moved = await between(() => { const was = CWD[1001]; CWD[1001] = `${HOME}/www/elsewhere`; transcript(CWD[1001], NOW - 3 * H * 1000); return () => { CWD[1001] = was; }; });
  if (typed.pv.ok && !typed.rv.ok && /terminal was used/.test(typed.rv.refused) && !wrote.rv.ok && /transcript/.test(wrote.rv.refused)) ok('a keystroke or a transcript write between the preview and the click refuses the run');
  else fail('activity after the preview did not refuse the run', JSON.stringify([typed.rv, wrote.rv]));
  if (!reused.rv.ok && /different process/.test(reused.rv.refused) && !other.rv.ok) ok('PID reuse is refused: same number, another start time or another executable');
  else fail('a recycled session pid was accepted', JSON.stringify([reused.rv, other.rv]));
  if (!spawned.rv.ok && /child process/.test(spawned.rv.refused) && !moved.rv.ok && /working folder/.test(moved.rv.refused)) ok('a child that appeared, or a working folder that changed, after the preview refuses the run');
  else fail('a session that started work after the preview was acted on', JSON.stringify([spawned.rv, moved.rv]));
  if (logged.filter((l) => l.action === 'end-ai-session' && l.refused).length >= 5) ok('every refused run went to actions.log');
  else fail('a refused idle-session run was not logged');
  if (!act.ACTIONS['end-ai-session'].follows && !Object.values(act.ACTIONS).some((a) => a.follows === 'end-ai-session' || a.follows === 'stop-orphan-tools')
    && act.ACTIONS['kill-processes'].follows === 'term-processes') ok('an AI session or a tool server is only ever sent SIGTERM: no forced stop follows either action');
  else fail('a forced stop can follow an AI action');

  // --- 1b. a session whose only children are its own idle MCP / tool servers --
  // Owner's decision of 2026-10-07: those children no longer block the button.
  // Anything else anywhere in the tree still does, and is named by its command
  // name only. Every bad case below is planted and must refuse.
  const SECRET = 's3cr3t-token-42';
  const MCP_ARGS = {
    1021: 'npm exec @modelcontextprotocol/server-github',
    1022: 'sh -c mcp-server-github',
    1023: `node ${HOME}/.npm/_npx/ab/node_modules/.bin/mcp-server-github`,
    1024: '/opt/homebrew/bin/typescript-language-server --stdio',
    1025: `node ${HOME}/.npm/_npx/9f/node_modules/.bin/mcp-server-filesystem ${HOME}/secret-folder`,
  };
  TTY.ttys021 = NOW - 3 * H * 1000; TTY.ttys031 = NOW - 3 * H * 1000;
  CWD[1020] = `${HOME}/www/p20`; CWD[1031] = `${HOME}/www/p31`;
  transcript(CWD[1020], NOW - 3 * H * 1000);
  const mcpTree = ({ extra = [], args = {}, ports = [], tweak = null } = {}) => {
    resetProcs();
    procs.push(P(4020, 400, '/bin/zsh', 9 * H, 'ttys021'), P(1020, 4020, CLAUDE, 8 * H, 'ttys021'),
      P(1021, 1020, '/usr/local/bin/node', 7 * H, 'ttys021'), P(1022, 1021, '/bin/sh', 7 * H, 'ttys021'),
      P(1023, 1022, '/usr/local/bin/node', 7 * H, 'ttys021'), P(1024, 1020, '/opt/homebrew/bin/typescript-language-server', 7 * H, 'ttys021'),
      P(1025, 1020, '/usr/local/bin/node', 7 * H, 'ttys021'), ...extra);
    if (tweak) tweak();
    ARGS = args === null ? null : { ...MCP_ARGS, ...args };
    PORTS = ports;
  };
  const row1020 = async () => (await ai.idleSessions(procs, probe, 777)).find((r) => r.id === 'ai-session-1020') || null;
  const refusedRow = (r, re) => !!r && !r.action && r.confidence === 'low' && re.test(r.proof) && !r.proof.includes(SECRET) && !r.proof.includes('secret-folder');

  mcpTree();
  const clean = await row1020();
  const cleanJson = JSON.stringify(clean || {});
  if (clean && clean.action && clean.confidence === 'medium' && /Its only child processes are its own tool servers: 5 tool server processes belong to this session/.test(clean.proof)
    && ['mcp-server-github', 'typescript-language-server', 'mcp-server-filesystem'].every((n) => clean.proof.includes(n))
    && /5 tool server processes belong to this session/.test(clean.lose) && /orphaned tool servers row/.test(clean.lose) && clean.lose.includes(`cd '${HOME}/www/p20' && claude --resume`)
    && !cleanJson.includes('secret-folder') && !cleanJson.includes('.npm/_npx')) ok('a session whose whole tree is idle MCP / tool servers (npm exec -> sh -c -> node, a language server, an npx server) gets a button; its proof and lose name the 5 tool servers, keep the resume command, and carry no command line');
  else fail('a session with only idle tool-server children was not offered as it should be', cleanJson.slice(0, 400));
  e = make(); e.remember('pressure', [clean]);
  const pm = clean && await e.preview({ action: 'end-ai-session', id: 'ai-session-1020' });
  const rm = pm && pm.ok && await e.run({ action: 'end-ai-session', id: 'ai-session-1020', nonce: pm.nonce });
  if (pm && pm.ok && /not its tool servers/.test(pm.what) && /5 tool server processes belong to this session/.test(pm.what) && /same 5 tool server process/.test(pm.proof)
    && /claude --resume/.test(pm.undo) && rm && rm.dryRun && JSON.stringify(rm.argv) === JSON.stringify(['kill', '-TERM', '1020'])) ok('its preview says the tool servers exit with it or become orphans, and the run is still exactly ["kill", "-TERM", "1020"]: never a tool server, never the shell');
  else fail('the session-with-tool-servers action is wrong', JSON.stringify(rm || pm).slice(0, 400));

  mcpTree({ extra: [P(1026, 1020, '/bin/zsh', 7 * H, 'ttys021')], args: { 1026: `/bin/zsh -c make test API_TOKEN=${SECRET}` } });
  const shellRow = await row1020();
  const fShell = await tryForged(1020);
  if (refusedRow(shellRow, /not a recognised MCP or tool server: zsh \(pid 1026\)/) && !/make test|API_TOKEN/.test(shellRow.proof + shellRow.lose)
    && !fShell.ok && /zsh \(pid 1026\)/.test(fShell.refused) && !fShell.refused.includes(SECRET)) ok('one extra shell child: no button, refused at the click too, and the refusal names only "zsh (pid 1026)", never its arguments');
  else fail('a session with a shell child was offered, or its refusal leaks the command line', JSON.stringify([shellRow && shellRow.proof, fShell]).slice(0, 400));

  mcpTree({ extra: [P(1027, 1023, '/usr/bin/git', 7 * H, 'ttys021')], args: { 1027: `git fetch https://x:${SECRET}@github.com/o/r` } });
  const gitRow = await row1020();
  mcpTree({ extra: [P(1027, 1020, '/usr/bin/python3', 7 * H, 'ttys021')], args: { 1027: `python3 ${HOME}/www/app/train.py --key ${SECRET}` } });
  const pyRow = await row1020();
  mcpTree({ extra: [P(1027, 1020, '/usr/local/bin/node', 7 * H, 'ttys021')], args: { 1027: `node ${HOME}/www/mcp-tools/scripts/build.js` } });
  const folderRow = await row1020();
  mcpTree({ args: { 1022: 'sh -c mcp-server-github; curl evil.example' } });
  const chainRow = await row1020();
  if (refusedRow(gitRow, /git \(pid 1027\)/) && refusedRow(pyRow, /python3 \(pid 1027\)/) && refusedRow(folderRow, /node \(pid 1027\)/) && refusedRow(chainRow, /sh \(pid 1022\)/)
    && !/curl|evil|train\.py|github\.com/.test([gitRow, pyRow, chainRow].map((r) => r.proof).join(' '))) ok('a nested non-MCP grandchild (git under an MCP server), a python that is not an MCP server, a build in a folder named "mcp-tools", and a shell wrapper that chains a second command are each refused by command name only');
  else fail('a non-tool descendant did not refuse, or leaked its arguments', JSON.stringify([gitRow, pyRow, folderRow, chainRow].map((r) => r && r.proof.slice(-160))));

  mcpTree({ ports: [{ pid: 1023, port: 7777 }] });
  const portRow = await row1020();
  mcpTree({ tweak: () => { byPid(1024).cpuPct = 5; } });
  const busyRow = await row1020();
  mcpTree({ tweak: () => { byPid(1025).ageS = 300; byPid(1025).startedAt = NOW - 300 * 1000; } });
  const youngRow = await row1020();
  if (refusedRow(portRow, /node \(pid 1023\) listens on port 7777/) && refusedRow(busyRow, /typescript-language-server \(pid 1024\) used 5% of a core/)
    && refusedRow(youngRow, /node \(pid 1025\) started 5m ago/)) ok('an MCP child listening on a port, one using 5% of a core, and one up only 5 minutes each refuse the session');
  else fail('a listening, busy or young tool server did not refuse the session', JSON.stringify([portRow, busyRow, youngRow].map((r) => r && r.proof.slice(-140))));

  mcpTree({ args: null });
  const noArgs = await row1020();
  mcpTree({ ports: null });
  const noPorts = await row1020();
  mcpTree({ args: { 1024: '' } });
  const oneArgs = await row1020();
  mcpTree({ tweak: () => { delete byPid(1023).cpuPct; } });
  const noCpu = await row1020();
  mcpTree({ tweak: () => { byPid(1025).ageS = null; } });
  const noAge = await row1020();
  if ([noArgs, noPorts, oneArgs, noCpu, noAge].every((r) => refusedRow(r, /Cannot judge/))) ok('unmeasurable is refused ("cannot judge"): command lines unread, ports unread, one command line missing, CPU unread, age unread');
  else fail('an unmeasurable tool-server tree was offered', JSON.stringify([noArgs, noPorts, oneArgs, noCpu, noAge].map((r) => r && `${r.confidence} ${r.proof.slice(-100)}`)));

  // Between the preview and the click: the whole tree is judged again.
  const treeBetween = async (change) => {
    mcpTree();
    const r0 = await row1020();
    const x = make(); x.remember('pressure', [r0]);
    const pv = await x.preview({ action: 'end-ai-session', id: 'ai-session-1020' });
    change();
    const rv = await x.run({ action: 'end-ai-session', id: 'ai-session-1020', nonce: pv.nonce });
    return { pv, rv };
  };
  const tNew = await treeBetween(() => { procs.push(P(1028, 1020, '/usr/local/bin/node', 7 * H, 'ttys021')); ARGS[1028] = 'uvx mcp-server-fetch'; });
  const tShell = await treeBetween(() => { procs.push(P(1029, 1023, '/bin/bash', 7 * H, 'ttys021')); ARGS[1029] = '/bin/bash'; });
  const tSwap = await treeBetween(() => { byPid(1025).startedAt += 60000; });
  const tGone = await treeBetween(() => { procs.splice(procs.indexOf(byPid(1024)), 1); });
  const tPort = await treeBetween(() => { PORTS = [{ pid: 1022, port: 9000 }]; });
  const tBusy = await treeBetween(() => { byPid(1021).cpuPct = 40; });
  if (tNew.pv.ok && !tNew.rv.ok && /not the ones measured/.test(tNew.rv.refused) && !tShell.rv.ok && /bash \(pid 1029\)/.test(tShell.rv.refused)
    && !tSwap.rv.ok && /not the ones measured/.test(tSwap.rv.refused) && !tGone.rv.ok && /not the ones measured/.test(tGone.rv.refused)
    && !tPort.rv.ok && /listens on port 9000/.test(tPort.rv.refused) && !tBusy.rv.ok && /40% of a core/.test(tBusy.rv.refused)) ok('the tree is judged again at the click: a new tool server, a shell under an MCP server, a replaced, exited, listening or busy child each refuse the run');
  else fail('a session whose tree changed after the preview was acted on', JSON.stringify([tNew, tShell, tSwap, tGone, tPort, tBusy].map((t) => t.rv.refused || t.rv.argv)));

  // The pure function, on its own.
  mcpTree();
  const direct = ai.onlyToolChildren(1020, procs, { args: ARGS, ports: [] });
  const viaSelf = ai.onlyToolChildren(1020, procs, { args: ARGS, ports: [], forbidden: new Set([1023]) });
  const leaf = ai.onlyToolChildren(1001, procs, { args: null, ports: null });
  if (direct.ok && direct.tools.map((t) => t.pid).join() === '1021,1022,1023,1024,1025' && !viaSelf.ok && /reckon itself/.test(viaSelf.why) && leaf.ok && !leaf.tools.length) ok('onlyToolChildren: the whole descendant tree, never a pid reckon runs as, and a session with no child needs no reading at all');
  else fail('onlyToolChildren answers wrongly', JSON.stringify([direct, viaSelf, leaf]).slice(0, 300));
  const shapes = {
    'npx -y @upstash/context7-mcp@latest': true, 'uvx mcp-server-fetch': true, 'python3 -m mcp_server_git --repository /x': true,
    'node /x/node_modules/typescript/lib/tsserver.js': true, '/opt/homebrew/bin/gopls': true, [`node ${HOME}/www/my-mcp-server/dist/index.js`]: true,
    'node /usr/local/bin/npx -y @modelcontextprotocol/server-memory': true, 'sh -c mcp-server-x /tmp/dir': true,
    'npx vite': false, 'npm run test': false, 'make': false, 'cargo build --release': false, '-zsh': false, '/bin/zsh': false,
    'bash -c mcp-server-x && rm -rf ~': false, [`node ${HOME}/www/mcp-tools/scripts/build.js`]: false, 'python3 train.py': false, 'git status': false,
    'node --inspect server.js': false, 'tsc --watch': false,
  };
  const wrong = Object.entries(shapes).filter(([l, want]) => ai.recognisedTool(l) !== want).map(([l]) => l);
  if (!wrong.length) ok(`a live session's child is recognised by what runs, not by a folder name: ${Object.keys(shapes).length} command-line shapes classified as expected`);
  else fail('a command line is classified wrongly as a tool server or not', wrong.join(' | '));
  if (ai.commandName('npm exec @modelcontextprotocol/server-github --token abc') === 'npm' && ai.commandName('/usr/bin/git') === 'git'
    && ai.commandName('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') === 'Google Chrome') ok('a refusal names a process by its executable\'s name only, even when the process rewrote its title with arguments');
  else fail('commandName leaks more than a name', ai.commandName('npm exec @modelcontextprotocol/server-github --token abc'));

  // Other tools stay copy-only, idle tool children or not.
  resetProcs();
  procs.push(P(4031, 400, '/bin/zsh', 9 * H, 'ttys031'), P(1031, 4031, '/opt/homebrew/bin/codex', 8 * H, 'ttys031'), P(1032, 1031, '/usr/local/bin/node', 7 * H, 'ttys031'));
  ARGS = { 1032: 'npx -y @modelcontextprotocol/server-memory' }; PORTS = [];
  const codexRow = (await ai.idleSessions(procs, probe, 777)).find((r) => r.id === 'ai-session-1031');
  if (codexRow && !codexRow.action && codexRow.confidence === 'low' && /does not know where codex/.test(codexRow.proof)) ok('codex with only idle MCP children is still low and copy-only');
  else fail('codex got a button', JSON.stringify(codexRow));
  resetProcs(); ARGS = {}; PORTS = [];

  // --- 2. orphaned MCP / tool servers ---------------------------------------
  const base = procs.filter((p) => [400, 450, 500, 600, 777].includes(p.pid));
  const tools = () => [
    ...base,
    P(2001, 1, '/usr/local/bin/node', 2 * H, null, { rssKB: 80 * 1024 }), P(2002, 2001, '/usr/local/bin/node', 2 * H, null, { rssKB: 40 * 1024 }),
    P(2003, 1, '/usr/local/bin/node', 3 * H), P(2004, 1, '/usr/local/bin/node', 3 * H), P(2005, 1, '/usr/local/bin/node', 1800),
    P(4000, 1, '/bin/zsh', 9 * H, 'ttys030'), P(2006, 4000, '/usr/local/bin/node', 3 * H, 'ttys030'),
    P(2007, 1, '/usr/local/bin/node', 2 * H), P(2008, 1, '/usr/local/bin/node', 2 * H, null, { systemManaged: true }),
    P(2009, 1, '/usr/local/bin/node', 2 * H, 'ttys020'), P(2010, 450, '/bin/zsh', 2 * H, 'ttys020'),
  ];
  ARGS = {
    2001: `node ${HOME}/.npm/_npx/9f/node_modules/.bin/mcp-server-filesystem ${HOME}/secret-folder`, 2003: 'npm exec @modelcontextprotocol/server-github',
    2004: 'node server.js', 2005: 'node mcp-young.js', 2006: 'node mcp-attached.js', 2007: 'uvx mcp-server-fetch', 2008: 'node mcp-agent.js',
    2009: 'node /x/typescript-language-server --stdio', 4000: '-zsh',
  };
  PORTS = [{ pid: 2007, port: 8123 }];
  procs = tools();
  const trows = await ai.orphanTools(procs, probe, PORTS, { selfPid: 777 });
  const tids = trows.map((r) => `${r.id}:${r.confidence}`).sort().join(',');
  if (tids === 'orphan-tool-mcp-server-fetch:low,orphan-tool-mcp-server-filesystem:medium,orphan-tool-mcp-server-github:medium') ok('orphaned tool servers: grouped by tool; a young one, one with a living parent, a launchd one, one whose terminal is still open and a plain node server get no row; one listening on a port is copy-only');
  else fail('the orphaned-tool rows are wrong', tids);
  const fs1 = trows.find((r) => r.id === 'orphan-tool-mcp-server-filesystem');
  if (fs1 && fs1.mb === 120 && /ppid 1/.test(fs1.proof) && !JSON.stringify(trows).includes('secret-folder')) ok('the group carries its total RSS (120 MB) and its proof, and the command line itself never reaches the row');
  else fail('the orphaned-tool row leaks its command line or misses its total', JSON.stringify(fs1));
  e = make(); e.remember('pressure', trows);
  const pt = await e.preview({ action: 'stop-orphan-tools', id: 'orphan-tool-mcp-server-filesystem' });
  const rt = pt.ok && await e.run({ action: 'stop-orphan-tools', id: 'orphan-tool-mcp-server-filesystem', nonce: pt.nonce });
  if (rt && rt.dryRun && JSON.stringify(rt.argv) === JSON.stringify(['kill', '-TERM', '2001', '2002'])) ok('the group is stopped with exactly ["kill", "-TERM", "2001", "2002"]: the orphan and its child');
  else fail('the orphaned-tool argv is wrong', JSON.stringify(rt || pt));
  const lowT = await e.preview({ action: 'stop-orphan-tools', id: 'orphan-tool-mcp-server-fetch' });
  if (!lowT.ok) ok('a tool server listening on a port has no button');
  else fail('a listening tool server was offered');
  const tBetween = async (change) => {
    procs = tools(); PORTS = [{ pid: 2007, port: 8123 }];
    const x = make(); x.remember('pressure', trows);
    const pv = await x.preview({ action: 'stop-orphan-tools', id: 'orphan-tool-mcp-server-filesystem' });
    change();
    return x.run({ action: 'stop-orphan-tools', id: 'orphan-tool-mcp-server-filesystem', nonce: pv.nonce });
  };
  const adopted = await tBetween(() => { procs.find((p) => p.pid === 2001).ppid = 4000; });
  const listens = await tBetween(() => { PORTS = [{ pid: 2002, port: 9999 }]; });
  const blind = await tBetween(() => { PORTS = null; });
  const recycled = await tBetween(() => { procs.find((p) => p.pid === 2002).startedAt -= 120000; });
  if (!adopted.ok && /parent again/.test(adopted.refused) && !listens.ok && /listens on port 9999/.test(listens.refused) && !blind.ok && /could not be read/.test(blind.refused)) ok('at the click: a root with a parent again, a new listening port, or ports that cannot be read, each refuses');
  else fail('an orphaned tool group that changed was acted on', JSON.stringify([adopted, listens, blind]));
  if (!recycled.ok && /different process/.test(recycled.refused)) ok('a recycled pid in a tool group is refused');
  else fail('a recycled tool pid was accepted', JSON.stringify(recycled));
  procs = tools();
  procs.find((p) => p.pid === 777).ppid = 2002;   // reckon now runs inside the filesystem server's tree
  const withSelf = await ai.orphanTools(procs, probe, [], { selfPid: 777 });
  if (!withSelf.some((r) => r.id === 'orphan-tool-mcp-server-filesystem')) ok('a tool tree that reckon runs inside is never offered');
  else fail('reckon offered to stop the tree it runs in');
  if (ai.toolLabel('node /a/b/node_modules/.bin/mcp-server-x /Users/me/private', 'node') === 'mcp-server-x' && ai.toolLabel('npx -y @modelcontextprotocol/server-memory@1.2.3', 'node') === 'mcp-server-memory') ok('a tool is named by the path segment that names it, never by a whole path');
  else fail('the tool label is wrong', ai.toolLabel('npx -y @modelcontextprotocol/server-memory@1.2.3', 'node'));
  resetProcs();

  // --- 3. local models: a fake Ollama on a random loopback port --------------
  let body = { models: [
    { name: 'llama3.2:latest', size: 2147483648, size_vram: 0, digest: 'd1', expires_at: '2026-10-07T20:00:00Z' },
    { name: '--help', size: 1 }, { name: 'x; rm -rf ~', size: 1 },
    { name: 'hf.co/user/repo:Q4_K_M', size: 1073741824, digest: 'd2' },
  ] };
  let hits = 0;
  const serve = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); });
  const fake = await serve((req, res) => {
    hits++;
    if (req.url !== '/api/ps' || req.method !== 'GET') { res.statusCode = 404; return res.end(); }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body));
  });
  const port = fake.address().port;
  const redirect = await serve((req, res) => { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${port}/api/ps`); res.end(); });
  const garbage = await serve((req, res) => { res.end('<html>not json'); });
  const hang = await serve(() => { /* never answers */ });
  try {
    const listed = await ai.ollamaLoaded({ _testPort: port });
    if (Array.isArray(listed) && listed.length === 4 && listed[0].name === 'llama3.2:latest' && listed[0].size === 2147483648) ok('the Ollama reader reads /api/ps from the fake server: names and sizes from the API');
    else fail('the Ollama reader did not read the fake server', JSON.stringify(listed));
    const before = hits;
    const redir = await ai.ollamaLoaded({ _testPort: redirect.address().port });
    const junk = await ai.ollamaLoaded({ _testPort: garbage.address().port });
    const t0 = Date.now();
    const slow = await ai.ollamaLoaded({ _testPort: hang.address().port });
    const took = Date.now() - t0;
    if (redir === null && hits === before && junk === null) ok('a redirect is not followed (the target was never asked) and a body that is not JSON is "could not find out"');
    else fail('the Ollama reader followed a redirect or trusted garbage', JSON.stringify([redir, junk, hits - before]));
    if (slow === null && took < 3500) ok(`a server that never answers is given up on after ${took} ms (the limit is 2 s)`);
    else fail('the Ollama reader waited too long or invented an answer', `${took} ms`);

    const probeO = { ...probe, ollamaLoaded: () => ai.ollamaLoaded({ _testPort: port }), which: (n) => (n === 'ollama' ? '/fake/bin/ollama' : null) };
    const withOllama = [...procs, P(3001, 1, '/Applications/Ollama.app/Contents/Resources/ollama', 5 * H, null, { rssKB: 2_200_000 }),
      P(3002, 1, '/Applications/LM Studio.app/Contents/MacOS/LM Studio', 5 * H, null, { rssKB: 500_000 })];
    const mrows = await ai.localModels(withOllama, probeO);
    const acted = mrows.filter((r) => r.action).map((r) => r.target.name).sort();
    if (acted.join('|') === 'hf.co/user/repo:Q4_K_M|llama3.2:latest' && mrows.filter((r) => /ollama-odd/.test(r.id)).length === 2 && mrows.some((r) => r.id === 'lmstudio-running' && !r.action && r.confidence === 'low')) ok('a row per loaded model, sized by the API; a model name with an option or a ; in it gets no button; LM Studio is detected but copy-only');
    else fail('the Ollama rows are wrong', JSON.stringify(mrows.map((r) => [r.id, r.confidence, !!r.action])));
    const llamaRow = mrows.find((r) => r.target && r.target.name === 'llama3.2:latest');
    if (llamaRow && llamaRow.mb === 2048 && /api\/ps/.test(llamaRow.proof) && /model file stays/.test(llamaRow.lose)) ok('the model row says how much (2048 MB from the API), where that came from, and that the file on disk stays');
    else fail('the model row is incomplete', JSON.stringify(llamaRow));
    const noBin = await ai.localModels(withOllama, { ...probeO, which: () => null });
    const nb = noBin.find((r) => /llama3-2/.test(r.id));
    if (nb && !nb.action && /not on this panel's PATH/.test(nb.proof)) ok('with no ollama binary the button is hidden and the row says why');
    else fail('a model row offered a button with no ollama binary', JSON.stringify(nb));

    const eo = make({ ai: probeO, which: probeO.which });
    eo.remember('memory', mrows);
    const po = await eo.preview({ action: 'stop-ollama-model', id: llamaRow.id });
    const ro = po.ok && await eo.run({ action: 'stop-ollama-model', id: llamaRow.id, nonce: po.nonce });
    if (po.ok && po.reversible === true && ro && ro.dryRun && JSON.stringify(ro.argv) === JSON.stringify(['ollama', 'stop', 'llama3.2:latest'])) ok('preview then dry run: exactly ["ollama", "stop", "llama3.2:latest"], the name as one argv entry, marked reversible');
    else fail('the Ollama action is wrong', JSON.stringify(ro || po));
    const hfRow = mrows.find((r) => r.target && r.target.name === 'hf.co/user/repo:Q4_K_M');
    const ph = await eo.preview({ action: 'stop-ollama-model', id: hfRow.id });
    const rh = ph.ok && await eo.run({ action: 'stop-ollama-model', id: hfRow.id, nonce: ph.nonce });
    if (rh && JSON.stringify(rh.argv) === JSON.stringify(['ollama', 'stop', 'hf.co/user/repo:Q4_K_M'])) ok('a namespaced model name passes through unchanged, as one argument');
    else fail('the namespaced model argv is wrong', JSON.stringify(rh || ph));

    const forgeM = (name) => ({ id: 'ollama-forged', title: 'forged', confidence: 'medium', lose: 'x', action: { id: 'stop-ollama-model', label: 'x' }, target: { kind: 'ollama', name } });
    const injected = [];
    for (const name of ['--help', 'x; rm -rf ~', '$(touch /tmp/p)', '../../etc', 'a b', '-v', 'llama3.2:latest\nrm']) {
      const x = make({ ai: probeO, which: probeO.which }); x.remember('memory', [forgeM(name)]);
      const r = await x.preview({ action: 'stop-ollama-model', id: 'ollama-forged' });
      if (r.ok) injected.push(name);
    }
    if (!injected.length) ok('7 injected model names (an option, a ;, a $(), a .., a space, a newline) are refused before anything runs');
    else fail('an injected model name reached the preview', injected.join(' | '));
    const notListed = make({ ai: probeO, which: probeO.which }); notListed.remember('memory', [forgeM('mistral:7b')]);
    const nl = await notListed.preview({ action: 'stop-ollama-model', id: 'ollama-forged' });
    if (!nl.ok && /not in Ollama's list/.test(nl.refused)) ok('a well-formed name that Ollama does not list at the click is refused');
    else fail('a model Ollama did not list was offered', JSON.stringify(nl));
    const eo2 = make({ ai: probeO, which: probeO.which }); eo2.remember('memory', mrows);
    const po2 = await eo2.preview({ action: 'stop-ollama-model', id: llamaRow.id });
    const keep = body; body = { models: [] };
    const ro2 = await eo2.run({ action: 'stop-ollama-model', id: llamaRow.id, nonce: po2.nonce });
    body = keep;
    if (po2.ok && !ro2.ok && /not in Ollama's list/.test(ro2.refused)) ok('a model unloaded between the preview and the click is refused, not stopped twice');
    else fail('the Ollama run did not re-read /api/ps at the click', JSON.stringify(ro2));
    const nob = make({ ai: probeO, which: () => null }); nob.remember('memory', mrows);
    const pnb = await nob.preview({ action: 'stop-ollama-model', id: llamaRow.id });
    if (!pnb.ok && /not on this panel's PATH/.test(pnb.refused)) ok('the action is refused at the click when the ollama binary is missing');
    else fail('the Ollama action ran with no binary', JSON.stringify(pnb));
  } finally { for (const s of [fake, redirect, garbage, hang]) { s.closeAllConnections && s.closeAllConnections(); s.close(); } }
  const down = make({ ai: { ...probe, ollamaLoaded: () => ai.ollamaLoaded({ _testPort: port }) }, which: () => '/fake/bin/ollama' });
  down.remember('memory', [{ id: 'ollama-x', title: 'x', confidence: 'medium', lose: 'x', action: { id: 'stop-ollama-model', label: 'x' }, target: { kind: 'ollama', name: 'llama3.2:latest' } }]);
  const pd = await down.preview({ action: 'stop-ollama-model', id: 'ollama-x' });
  if (!pd.ok && /did not answer/.test(pd.refused)) ok('with Ollama not answering, the action is refused ("could not find out" is not "loaded")');
  else fail('the Ollama action went ahead with no answer from the API', JSON.stringify(pd));

  // The gate, and the address that is never configurable.
  const gate = [['ollama', ['stop', '--help']], ['ollama', ['stop', 'a b']], ['ollama', ['run', 'llama3']], ['ollama', ['stop', 'a', 'b']],
    ['ollama', ['stop', '../x']], ['ollama', ['rm', 'llama3']], ['ollama', ['stop']], ['kill', ['-TERM', '1']], ['sudo', ['ollama', 'stop', 'x']]];
  const through = gate.filter(([c, a]) => { try { act.assertSafe(c, a); return true; } catch { return false; } });
  if (!through.length) ok(`the gate refuses all ${gate.length} ollama and kill shapes the AI rows must never produce (an option, two names, run, rm, sudo)`);
  else fail('the gate let an AI-tool argv through', through.map(([c, a]) => [c, ...a].join(' ')).join(' | '));
  const src = read('lib/aitools.js');
  const elsewhere = ['server.js', ...libFiles()].filter((f) => f !== 'lib/aitools.js' && /_testPort/.test(read(f)));
  if (/const OLLAMA_HOST = '127\.0\.0\.1';/.test(src) && /const OLLAMA_PORT = 11434;/.test(src) && !/process\.env\.(?!PATH\b)/.test(src)
    && !/_testPort\s*:/.test(src) && !elsewhere.length && /ollamaLoaded: \(\) => ollamaLoaded\(\)/.test(src)) ok('production reads Ollama at the hard-coded http://127.0.0.1:11434/api/ps: no environment variable, no config, and the test port is passed by bin/check.js alone');
  else fail('the Ollama address can be changed outside the tests', elsewhere.join(', '));
  if (!/readFileSync|createReadStream|openSync/.test(src)) ok('lib/aitools.js never opens a file: transcripts are known by their modification time only');
  else fail('lib/aitools.js reads a file\'s contents');
  if (!ran.length) ok('no AI-tool test above ran a command: the fake machine and the dry run held');
  else fail('an AI-tool test ran a command', JSON.stringify(ran));
}

// For real, in a child process with HOME in a temporary folder: two links to
// /bin/sleep named `claude`, spawned by the test with a working folder and a
// transcript of their own. Only the one whose every proof holds is signalled,
// for real; the other, whose terminal "was used a minute ago", must survive.
// The process list is filtered to the test's own children: even a bug in the
// engine could not reach anything else. Terminal times are supplied by the
// test (a spawned child has no terminal); working folders are read for real
// with lsof; transcript times are read for real with stat.
async function aiSandbox() {
  if (process.platform !== 'darwin') { ok('(sandboxed AI-session test runs on macOS only)'); return; }
  if (process.env.RECKON_CHECK_CHILD) { ok('(sandboxed AI-session test runs once, in the parent suite)'); return; }
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const realLog = path.join(os.homedir(), '.cache', 'reckon', 'actions.log');
  const stamp = (f) => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } };
  const before = stamp(realLog);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-ai-check-'));
  const script = `
    const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
    const { spawn } = require('node:child_process');
    const ROOT = ${JSON.stringify(ROOT)};
    const home = os.homedir();
    if (home !== process.env.HOME || !/reckon-ai-check-/.test(home)) { console.log(JSON.stringify({ floor: 'HOME is not the sandbox' })); process.exit(0); }
    const { run } = require(path.join(ROOT, 'lib/sh.js'));
    const act = require(path.join(ROOT, 'lib/act.js'));
    const ai = require(path.join(ROOT, 'lib/aitools.js'));
    const { createLog } = require(path.join(ROOT, 'lib/actlog.js'));
    const H = 3600, AGE = 7 * H;
    const kids = [], mine = new Set(), TTYOF = new Map(), spawnedPids = [];
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function list() {
      const r = await run('ps', ['-o', 'pid=,ppid=,rss=,%cpu=,etime=,comm=', '-p', [process.pid, ...mine].join(',')], { timeout: 5000 });
      const out = [];
      for (const l of String(r.out || '').split('\\n')) {
        const m = /^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+([\\d.]+)\\s+(\\S+)\\s+(.*)$/.exec(l);
        if (!m) continue;
        // Only this test and what it spawned: a child of the test, or a child of one of those.
        if (+m[1] !== process.pid && (!mine.has(+m[1]) || (+m[2] !== process.pid && !mine.has(+m[2])))) continue;
        const t = /^(?:(\\d+)-)?(?:(\\d+):)?(\\d+):(\\d+)$/.exec(m[5]);
        const ageS = t ? (+(t[1] || 0)) * 86400 + (+(t[2] || 0)) * 3600 + (+t[3]) * 60 + (+t[4]) : null;
        const own = mine.has(+m[1]);
        // A spawned child has no terminal and is seconds old: both are supplied, consistently, so
        // its start time (and so its identity) is the same in every reading.
        out.push({ pid: +m[1], ppid: +m[2], rssKB: +m[3], cpuPct: +m[4], ageS: own && ageS != null ? ageS + AGE : ageS, command: m[6].trim(), tty: own ? TTYOF.get(+m[1]) : null });
      }
      return out;
    }
    (async () => {
      const res = {};
      try {
        const mk = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
        // A link named claude to /bin/sleep, not a copy: macOS kills a copy of a system binary
        // run from another folder (SIGKILL at launch), while ps shows the link's own path.
        const fake = (name) => { const f = path.join(mk(path.join(home, name)), 'claude'); fs.symlinkSync('/bin/sleep', f); return f; };
        const binA = fake('binA'), binB = fake('binB');
        const projA = mk(path.join(home, 'www', 'proj-a')), projB = mk(path.join(home, 'www', 'proj-b'));
        const old = (Date.now() - 3 * H * 1000) / 1000;
        const transcriptFor = (proj) => {
          const dir = mk(ai.projectDir(home, fs.realpathSync(proj)));
          const f = path.join(dir, 'session.jsonl');
          fs.writeFileSync(f, '{"note":"never read by reckon"}\\n');
          fs.utimesSync(f, old, old);
          return { dir, f, mtime: fs.statSync(f).mtimeMs };
        };
        const tA = transcriptFor(projA), tB = transcriptFor(projB);
        res.inside = tA.dir.startsWith(home + path.sep) && tB.dir.startsWith(home + path.sep);
        // A fake MCP server too: a link to /bin/sleep named mcp-server-test. The fake claude A
        // must be its parent, and sleep cannot spawn, so a shell starts the MCP child in the
        // background and then becomes claude with exec (same pid, so A is the MCP's parent).
        const mcpBin = path.join(mk(path.join(home, 'mcpbin')), 'mcp-server-test');
        fs.symlinkSync('/bin/sleep', mcpBin);
        const a = spawn('/bin/sh', ['-c', '"$1" 60 & exec "$2" 60', 'sh', mcpBin, binA], { cwd: projA, stdio: 'ignore' });
        const b = spawn(binB, ['60'], { cwd: projB, stdio: 'ignore' });
        for (const c of [a, b]) { kids.push(c); mine.add(c.pid); }
        TTYOF.set(a.pid, 'ttys990'); TTYOF.set(b.pid, 'ttys991');
        await sleep(400);
        const pg = await run('pgrep', ['-P', String(a.pid)], { timeout: 5000 });
        const mcpPids = String(pg.out || '').split('\\n').map((x) => +x.trim()).filter((x) => x > 1);
        res.mcpPid = mcpPids.length === 1 ? mcpPids[0] : null;
        for (const m of mcpPids) { mine.add(m); TTYOF.set(m, 'ttys990'); spawnedPids.push(m); }
        // Command lines are read for real (ps -o args), but only for the test's own processes.
        const realArgs = ai.defaultProbe().argsOf;
        const aiProbe = {
          ttyTouchedAt: async (t) => (t === 'ttys990' ? Date.now() - 3 * H * 1000 : t === 'ttys991' ? Date.now() - 60 * 1000 : null),
          ports: async () => [], ollamaLoaded: async () => null, argsOf: (pids) => realArgs(pids.filter((p) => mine.has(p))), which: () => null,
        };
        const rows = await ai.idleSessions(await list(), { ...ai.defaultProbe(), ...aiProbe }, process.pid);
        res.rows = rows.map((r) => r.id + ':' + r.confidence);
        res.wantA = 'ai-session-' + a.pid + ':medium';
        res.noB = !rows.some((r) => r.id === 'ai-session-' + b.pid);
        res.noSelf = !rows.some((r) => r.id === 'ai-session-' + process.pid);
        const rowA = rows.find((r) => r.id === 'ai-session-' + a.pid);
        res.resume = rowA && rowA.lose.includes("claude --resume");
        res.mcpNamed = !!rowA && /1 tool server process belongs to this session \\(mcp-server-test\\)/.test(rowA.proof + ' ' + rowA.lose)
          && !!rowA.target && rowA.target.tools.length === 1 && rowA.target.tools[0].pid === res.mcpPid;
        const e = act.createEngine({ processList: list, selfPid: process.pid, minDelayMs: 0, settleMs: 1500,
          memoryStats: async () => null, memoryPressure: async () => null, ai: aiProbe,
          log: createLog({ dir: path.join(home, '.cache', 'reckon') }) });
        const L = await list();
        const pb = L.find((x) => x.pid === b.pid);
        const forgedB = { id: 'ai-session-' + b.pid, title: 'forged', confidence: 'medium', lose: 'x', action: { id: 'end-ai-session', label: 'x' },
          target: { kind: 'ai-session', tool: 'claude', tty: 'ttys991', cwd: fs.realpathSync(projB), dirShown: 'x', resume: 'x',
            pid: { pid: b.pid, comm: pb.command, startedAt: Date.now() - pb.ageS * 1000 } } };
        e.remember('pressure', [...rows, forgedB]);
        const pB = await e.preview({ action: 'end-ai-session', id: 'ai-session-' + b.pid });
        res.bRefused = !pB.ok && /terminal was used/.test(pB.refused || '');
        const pA = await e.preview({ action: 'end-ai-session', id: 'ai-session-' + a.pid });
        const rA = pA.ok ? await e.run({ action: 'end-ai-session', id: 'ai-session-' + a.pid, nonce: pA.nonce }) : pA;
        res.a = { ok: rA.ok, gone: rA.gone, ran: rA.ran, refused: rA.refused, pid: a.pid };
        await sleep(200);
        try { process.kill(b.pid, 0); res.bAlive = true; } catch { res.bAlive = false; }
        // reckon signalled the claude only: its MCP child is still alive (orphaned now), and the
        // test, not reckon, stops it below.
        try { process.kill(res.mcpPid, 0); res.mcpAlive = true; } catch { res.mcpAlive = false; }
        res.untouched = fs.statSync(tA.f).mtimeMs === tA.mtime && fs.statSync(tB.f).mtimeMs === tB.mtime;
        let lines = [];
        try { lines = fs.readFileSync(path.join(home, '.cache', 'reckon', 'actions.log'), 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* reported below */ }
        res.logged = lines.some((l) => l.action === 'end-ai-session' && l.info && /claude --resume/.test(l.info.resume || ''));
      } catch (err) { res.error = String(err && err.stack || err).split('\\n').slice(0, 2).join(' | '); }
      finally {
        for (const k of kids) { try { k.kill('SIGKILL'); } catch {} }
        // The fake MCP child: stopped only if that pid is still the link this test made.
        for (const p of spawnedPids) {
          try {
            const c = await run('ps', ['-o', 'comm=', '-p', String(p)], { timeout: 5000 });
            if (String(c.out || '').trim().endsWith(path.join('mcpbin', 'mcp-server-test'))) process.kill(p, 'SIGKILL');
          } catch {}
        }
      }
      console.log(JSON.stringify(res));
    })();
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, USERPROFILE: home } });
  let res;
  try { res = JSON.parse(String(r.stdout).trim().split('\n').pop()); }
  catch { fs.rmSync(home, { recursive: true, force: true }); return fail('the sandboxed AI-session test printed nothing readable', String(r.stderr || r.stdout).slice(0, 200)); }
  fs.rmSync(home, { recursive: true, force: true });
  if (res.floor || res.error) return fail('the sandboxed AI-session test did not run', res.floor || res.error);
  if (res.inside) ok('in the sandbox, the transcript folders reckon looks in are inside the temporary HOME, never the real ~/.claude');
  else fail('the sandbox transcript folder is outside the temporary HOME');
  if (res.rows && res.rows.length === 1 && res.rows[0] === res.wantA && res.noB && res.noSelf && res.resume) ok('for real: the fake claude whose working folder (read with lsof) and transcript (stat) are quiet is the one row, with its resume command; the busy one and the sandbox itself get none');
  else fail('the sandbox session rows are wrong', JSON.stringify(res.rows));
  if (res.bRefused && res.bAlive) ok('for real: a forged button for the session whose terminal was used a minute ago is refused, and that process is still alive');
  else fail('the busy fake session was not protected', JSON.stringify({ refused: res.bRefused, alive: res.bAlive }));
  if (res.a && res.a.ok && res.a.gone === 1 && JSON.stringify(res.a.ran) === JSON.stringify(['kill', '-TERM', String(res.a.pid)])) ok('for real: preview, confirm, run sent exactly kill -TERM <pid> to the idle fake claude, measured gone after');
  else fail('the idle fake claude was not stopped as expected', JSON.stringify(res.a));
  if (res.mcpPid && res.mcpNamed && res.mcpAlive) ok('for real: the fake claude\'s only child, an idle fake MCP server (a link to /bin/sleep named mcp-server-test, its command line read with ps), did not block the button, was named in the row, and was not signalled: reckon stopped the claude alone and the test stopped what it spawned');
  else fail('the fake MCP child was not handled as expected', JSON.stringify({ pid: res.mcpPid, named: res.mcpNamed, alive: res.mcpAlive }));
  if (res.untouched) ok('the transcripts were not touched (their modification times are what the test set)');
  else fail('a transcript changed during the test');
  if (res.logged) ok('actions.log inside the sandbox has the session\'s resume command');
  else fail('the sandbox AI-session log line is missing');
  if (stamp(realLog) === before) ok('the real ~/.cache/reckon/actions.log was not touched by the AI-session tests');
  else fail('the AI-session tests wrote to the real actions.log');
}

// "I need X GB": the plan, the queue it hands to, helper grouping and the Docker advice card.
// Every machine here is a fake one: a process list and a memory reading held in variables, an exec that only
// records, a HOME in a temp dir. Nothing is run against the real machine.
async function memoryPlan() {
  const os = require('node:os');
  const act = require(path.join(ROOT, 'lib/act.js'));
  const mem = require(path.join(ROOT, 'lib/memory.js'));
  const platform = require(path.join(ROOT, 'lib/platform'));
  const NOW = 2_000_000_000_000;
  const MB = 1024;   // KB per MB
  const T = (pid, comm, ageS = 7200) => ({ pid, comm, startedAt: NOW - ageS * 1000 });

  // ---- 1. the plan: ordering, totals, honesty -----------------------------------------------------
  const ran = [], logged = [];
  let AVAIL = 1000;
  const mk = (o = {}) => act.createEngine({
    processList: async () => [], appBundle: async () => null, runningContainers: async () => 0,
    memoryStats: async () => ({ totalBytes: 32 * 1024 * 1048576, freeBytes: 0, inactiveBytes: 0 }), memoryPressure: async () => null,
    exec: async (cmd, args) => { ran.push([cmd, ...args]); return { ok: true, out: '', erro: null }; },
    log: { append: (e) => { logged.push(e); return true; } },
    available: async () => AVAIL,
    now: () => NOW, selfPid: 777, dryRun: true, minDelayMs: 0, killAfterMs: 0, settleMs: 0, ...o,
  });
  const row = (id, action, kbMB, over = {}) => ({ id, title: `title ${id}`, kb: kbMB * MB, mb: kbMB, confidence: 'medium', lose: `lose ${id}`,
    action: { id: action, label: action }, target: { kind: 'x', pids: [T(Number(String(id).replace(/\D/g, '')) || 1, '/bin/x')], main: T(1, '/bin/x') }, ...over });
  const memRows = [
    row('group-orca', 'quit-app', 3000, { target: { kind: 'app', appPath: '/Applications/Orca.app', bundleId: 'com.example.orca', name: 'Orca', main: T(900, '/Applications/Orca.app/Contents/MacOS/Orca'), pids: [T(900, 'o'), T(901, 'o')] } }),
    row('ollama-llama', 'stop-ollama-model', 2000, { target: { kind: 'ollama', name: 'llama3:latest' } }),
    row('simulators', 'shutdown-simulators', 1500, { target: { kind: 'simulators', roots: [T(3001, '/x/launchd_sim')] } }),
    row('docker-idle', 'quit-docker', 2500, { target: { kind: 'docker', main: T(3100, '/Applications/Docker.app/Contents/MacOS/com.docker.backend') } }),
    row('group-huge-low', 'quit-app', 9000, { confidence: 'low' }),
  ];
  const pressRows = [
    row('orphan-tool-mcp', 'stop-orphan-tools', 500, { target: { kind: 'orphan-tool', label: 'mcp', rootPids: [4001], pids: [T(4001, '/x/node'), T(4002, '/x/node')] } }),
    row('ai-session-5001', 'end-ai-session', 600, { target: { kind: 'ai-session', tool: 'claude', resume: "cd '/x' && claude --resume", pid: T(5001, '/x/claude') } }),
    row('ai-session-5002', 'end-ai-session', 300, { target: { kind: 'ai-session', tool: 'claude', resume: null, pid: T(5002, '/x/claude') } }),
    row('swarm-yes', 'term-processes', 400, { confidence: 'high', target: { kind: 'swarm', pids: [T(6001, '/usr/bin/yes'), T(6002, '/usr/bin/yes')] } }),
    // The same process as the orphan tool above: it is counted once.
    row('swarm-dup', 'term-processes', 450, { confidence: 'high', target: { kind: 'swarm', pids: [T(4002, '/x/node')] } }),
    row('swarm-tiny', 'term-processes', 0, { confidence: 'high' }),
  ];
  const diskRow = { ...row('disk-cache', 'clear-cache', 5000), target: { kind: 'cache', members: [] } };
  let e = mk();
  e.remember('memory', memRows);
  e.remember('pressure', pressRows);
  e.remember('disk', [diskRow]);

  const big = await e.plan({ needMB: 16 * 1024 });
  const order = big.items.map((i) => i.id).join(',');
  const wantOrder = 'ollama-llama,orphan-tool-mcp,ai-session-5001,simulators,docker-idle,ai-session-5002,swarm-yes,group-orca';
  if (big.ok && order === wantOrder) ok('plan order: reversible first (Ollama model, orphaned servers, session with a resume command, simulators, Docker VM), then the rest, and the app that asks to save last');
  else fail('the plan is in the wrong order', order);
  const sums = big.items.map((i) => i.runningTotalMB).join(',');
  if (sums === '2000,2500,3100,4600,7100,7400,7800,10800' && big.totalMB === 10800 && big.items.every((i) => i.upToMB === Math.floor(i.upToMB))) ok('each item shows "up to" its measured MB with a running total (2000, 2500, 3100, 4600, 7100, 7400, 7800, 10800)');
  else fail('the running total is wrong', sums);
  const last = big.items[big.items.length - 1];
  if (last.asksToSave && big.items.filter((i) => i.asksToSave).length === 1 && last.tierLabel === 'asks to save first') ok('only the app whose quit asks to save is flagged "asks to save first", and it is last');
  else fail('the asks-to-save flag is wrong', JSON.stringify(big.items.map((i) => [i.id, i.asksToSave])));
  const noResume = big.items.find((i) => i.id === 'ai-session-5002'), withResume = big.items.find((i) => i.id === 'ai-session-5001');
  if (withResume.tier === 0 && withResume.resume && noResume.tier === 1) ok('an idle session counts as easy to get back only when it has a resume command');
  else fail('the session tiers are wrong', JSON.stringify([withResume.tier, noResume.tier]));
  if (!big.items.some((i) => ['group-huge-low', 'disk-cache', 'swarm-dup', 'swarm-tiny'].includes(i.id))) ok('a low-confidence row, a disk row, a row sharing a process with another, and a row under 1 MB never enter the plan');
  else fail('a row that must not be planned was planned', order);
  if (!big.reaches && /free up to 10\.5 GB; you asked for 16 GB available/.test(big.message) && /nothing else here is safe to stop/.test(big.message)) ok('when the whole list cannot reach the need it says so: "these free up to X GB; you asked for Y GB; nothing else here is safe to stop"');
  else fail('the "cannot reach" message is not honest', big.message);

  const small = await e.plan({ needMB: 4096 });
  if (small.reaches && small.items.map((i) => i.id).join(',') === 'ollama-llama,orphan-tool-mcp,ai-session-5001' && small.totalMB === 3100 && small.gapMB === 3096) ok('the list stops as soon as the total reaches the gap (4 GB asked, 1000 MB already available: three steps, 3100 MB)');
  else fail('the plan did not stop where the need was met', JSON.stringify([small.items.map((i) => i.id), small.totalMB, small.gapMB]));
  const withSave = await e.plan({ needMB: 10 * 1024 });
  if (withSave.reaches && withSave.items[withSave.items.length - 1].id === 'group-orca' && /asks to save first/.test(withSave.message)) ok('when only the app that asks to save gets the plan there, it is last and the message says so');
  else fail('the asks-to-save case is wrong', withSave.message);
  AVAIL = 5000;
  const already = await e.plan({ needMB: 4096 });
  if (already.ok && already.enough && !already.items.length && /already covers/.test(already.message)) ok('when enough is already available the plan is empty and says so');
  else fail('an already-met need still got a plan', JSON.stringify(already));
  AVAIL = 1000;
  const tooBig = await e.plan({ needMB: 64 * 1024 }), tooSmall = await e.plan({ needMB: 10 }), noNum = await e.plan({ needMB: 'lots' }), noBody = await e.plan(null);
  if (!tooBig.ok && /never be available/.test(tooBig.refused) && !tooSmall.ok && !noNum.ok && !noBody.ok) ok('a need larger than the machine, below 256 MB, not a number, or no body is refused');
  else fail('a bad ask was planned', JSON.stringify([tooBig, tooSmall, noNum, noBody]));
  AVAIL = null;
  const blind = await e.plan({ needMB: 4096 });
  if (blind.ok && blind.availableMB === null && blind.gapMB === 4096 && /could not be read/.test(blind.message)) ok('available memory that cannot be read is not guessed: the whole ask is the gap, and the message says why');
  else fail('an unreadable available figure was guessed at', JSON.stringify(blind));
  AVAIL = 1000;
  if (!ran.length && !logged.length) ok('building a plan runs nothing and logs nothing');
  else fail('the plan ran or logged something', JSON.stringify([ran, logged]));
  // The plan code itself never reaches the executor.
  const planSrc = (read('lib/act.js').match(/async function plan\(body\) \{[\s\S]*?\n  \}\n/) || [''])[0];
  if (planSrc.length > 500 && !/deps\.exec|execute\(|runOne|deps\.read/.test(planSrc)) ok('the plan function never calls the executor, runOne or a reader of the machine');
  else fail('the plan function reaches an executor');

  // ---- 2. the queue the plan hands to --------------------------------------------------------------
  let procs;
  const reset = () => {
    procs = [
      { pid: 5101, ppid: 1, rssKB: 1500 * MB, ageS: 7200, startedAt: NOW - 7200_000, command: '/usr/bin/yes' },
      { pid: 5102, ppid: 1, rssKB: 1500 * MB, ageS: 7200, startedAt: NOW - 7200_000, command: '/usr/bin/yes' },
      { pid: 5103, ppid: 1, rssKB: 1500 * MB, ageS: 7200, startedAt: NOW - 7200_000, command: '/usr/bin/yes' },
      { pid: 5104, ppid: 1, rssKB: 1500 * MB, ageS: 7200, startedAt: NOW - 7200_000, command: '/usr/bin/yes' },
      { pid: 900, ppid: 1, rssKB: 900 * MB, ageS: 600, startedAt: NOW - 600_000, command: '/Applications/Sample.app/Contents/MacOS/Sample' },
      { pid: 901, ppid: 900, rssKB: 100 * MB, ageS: 600, startedAt: NOW - 600_000, command: '/Applications/Sample.app/Contents/Frameworks/H.app/Contents/MacOS/H' },
    ];
  };
  reset();
  ran.length = 0; logged.length = 0;
  const killed = (args) => args.slice(1).forEach((p) => { procs = procs.filter((x) => x.pid !== Number(p)); });
  const seq = [];   // the fake "available memory": what each reading returns, in order
  let reads = 0;
  const mkq = (o = {}) => act.createEngine({
    processList: async () => procs.map((p) => ({ ...p })),
    appBundle: async (c) => (String(c).startsWith('/Applications/Sample.app/') ? { appPath: '/Applications/Sample.app', bundleId: 'com.example.sample', name: 'Sample' } : null),
    runningContainers: async () => 0, memoryStats: async () => ({ totalBytes: 32 * 1024 * 1048576 }), memoryPressure: async () => null,
    exec: async (cmd, args) => {
      ran.push([cmd, ...args]);
      if (cmd === 'kill') killed(args);
      if (cmd === 'osascript') procs = procs.filter((x) => !x.command.startsWith('/Applications/Sample.app/'));
      return { ok: true, out: '', erro: null };
    },
    log: { append: (x) => { logged.push(x); return true; } },
    available: async () => { const v = seq[Math.min(reads, seq.length - 1)]; reads++; return v; },
    now: () => NOW, selfPid: 777, dryRun: false, minDelayMs: 0, killAfterMs: 0, settleMs: 0, ...o,
  });
  const swarm = (id, pid) => ({ id, title: `swarm ${pid}`, kb: 1500 * MB, confidence: 'high', lose: 'a loop', action: { id: 'term-processes', label: 'Stop' },
    target: { kind: 'swarm', pids: [T(pid, '/usr/bin/yes')] } });
  const sample = { id: 'group-sample', title: 'Sample', kb: 1000 * MB, confidence: 'medium', lose: 'open docs', action: { id: 'quit-app', label: 'Quit Sample' },
    target: { kind: 'app', appPath: '/Applications/Sample.app', bundleId: 'com.example.sample', name: 'Sample', main: T(900, '/Applications/Sample.app/Contents/MacOS/Sample', 600),
      pids: [T(900, '/Applications/Sample.app/Contents/MacOS/Sample', 600), T(901, '/Applications/Sample.app/Contents/Frameworks/H.app/Contents/MacOS/H', 600)] } };
  const rowsQ = [sample, swarm('swarm-a', 5101), swarm('swarm-b', 5102), swarm('swarm-c', 5103), swarm('swarm-d', 5104)];
  const items = (ids) => ids.map((id) => ({ action: id === 'group-sample' ? 'quit-app' : 'term-processes', id }));

  // 2a. one summed preview; the app that asks to save is moved behind the rest, whatever order was sent
  let q = mkq(); q.remember('pressure', rowsQ);
  const pv = await q.previewQueue({ items: items(['group-sample', 'swarm-a', 'swarm-b', 'swarm-c']), needMB: 4000 });
  if (pv.ok && pv.kind === 'memory' && pv.nonce && pv.items.map((i) => i.id).join() === 'swarm-a,swarm-b,swarm-c,group-sample' && pv.totalKB === (3 * 1500 + 1000) * MB
    && pv.items.find((i) => i.id === 'group-sample').asksToSave && pv.items.every((i) => i.proof && i.lose && i.command)) ok('queue preview: one summed total, every item with proof, what you lose and the exact command, and the app that asks to save moved last');
  else fail('the memory queue preview is wrong', JSON.stringify(pv).slice(0, 300));
  const mixed = await mkq().previewQueue({ items: [{ action: 'term-processes', id: 'swarm-a' }, { action: 'clear-cache', id: 'disk-x' }] });
  const notPlanned = await mkq().previewQueue({ items: [{ action: 'kill-processes', id: 'swarm-a' }] });
  if (!mixed.ok && !notPlanned.ok && /not both|not queued/.test(mixed.refused + notPlanned.refused)) ok('a queue never mixes disk and memory rows, and a memory action outside the plan\'s table (the forced stop) is not queued');
  else fail('a queue took a mix or an action outside the plan', JSON.stringify([mixed.refused, notPlanned.refused]));

  // 2b. early stop: the real available memory is read before the first step and after each, and the rest are skipped
  ran.length = 0; logged.length = 0; reads = 0; seq.length = 0; seq.push(1000, 1500, 4200);
  q = mkq(); q.remember('pressure', rowsQ);
  let pre = await q.previewQueue({ items: items(['swarm-a', 'swarm-b', 'swarm-c', 'swarm-d']), needMB: 4000 });
  let r = await q.runQueue({ nonce: pre.nonce });
  const killsRan = ran.filter((c) => c[0] === 'kill').map((c) => c.join(' ')).join(' | ');
  if (r.ok && r.results.length === 2 && r.skipped === 2 && killsRan === 'kill -TERM 5101 | kill -TERM 5102'
    && r.plan.metNeed && r.plan.stoppedEarly && r.plan.availableBefore === 1000 && r.plan.availableAfter === 4200) ok('early stop: after the second step the measured available memory (4200 MB) meets the 4000 MB need, so only two steps ran');
  else fail('the plan did not stop early', JSON.stringify({ n: r.results && r.results.length, ran: killsRan, plan: r.plan }));
  if (r.skippedItems.map((s) => s.id).join() === 'swarm-c,swarm-d' && r.skippedItems.every((s) => /need was already met/.test(s.why))) ok('the steps that were not run are named, with the reason: the need was already met');
  else fail('the skipped steps are not said', JSON.stringify(r.skippedItems));
  if (logged.filter((l) => l.action === 'term-processes' && l.ok).length === 2 && !logged.some((l) => l.id === 'swarm-c')) ok('every step that ran is in actions.log, and the skipped ones are not');
  else fail('actions.log does not match what ran', JSON.stringify(logged.map((l) => l.id)));

  // 2c. never starts what is already enough; and runs to the end, honestly short, when the need is never met
  procs = null; reset(); ran.length = 0; reads = 0; seq.length = 0; seq.push(5000);
  q = mkq(); q.remember('pressure', rowsQ);
  pre = await q.previewQueue({ items: items(['swarm-a', 'swarm-b']), needMB: 4000 });
  r = await q.runQueue({ nonce: pre.nonce });
  if (r.ok && !r.results.length && r.skipped === 2 && r.plan.metNeed && !ran.length) ok('available memory already at the need before the first step: nothing is run, both steps are said to be skipped');
  else fail('a met need still started the queue', JSON.stringify({ ran, plan: r.plan }));
  reset(); ran.length = 0; reads = 0; seq.length = 0; seq.push(1000, 1100, 1200);
  q = mkq(); q.remember('pressure', rowsQ);
  pre = await q.previewQueue({ items: items(['swarm-a', 'swarm-b']), needMB: 4000 });
  r = await q.runQueue({ nonce: pre.nonce });
  if (r.ok && r.results.length === 2 && !r.plan.metNeed && !r.plan.stoppedEarly && r.plan.availableAfter === 1200) ok('when the need is never met, every step runs and the result says the need was not met, with the real before and after');
  else fail('a short plan claimed success', JSON.stringify(r.plan));

  // 2d. the first refusal stops the queue
  reset(); ran.length = 0; reads = 0; seq.length = 0; seq.push(1000);
  q = mkq(); q.remember('pressure', rowsQ);
  pre = await q.previewQueue({ items: items(['swarm-a', 'swarm-b', 'swarm-c']), needMB: 8000 });
  procs.find((p) => p.pid === 5102).startedAt += 60000;   // pid 5102 is now another process
  r = await q.runQueue({ nonce: pre.nonce });
  if (!r.ok && r.stoppedAt === 'swarm-b' && r.results.length === 2 && r.skipped === 1 && r.skippedItems[0].id === 'swarm-c' && /refused/.test(r.skippedItems[0].why)
    && ran.filter((c) => c[0] === 'kill').length === 1) ok('stop on the first refusal: step 2 is refused at the click (its pid is another process now), step 3 is skipped and said to be, only step 1 ran');
  else fail('the queue did not stop on a refusal', JSON.stringify({ stoppedAt: r.stoppedAt, n: r.results.length, ran }));
  const replay = await q.runQueue({ nonce: pre.nonce });
  if (!replay.ok && /No queue preview/.test(replay.refused)) ok('a queue nonce works once');
  else fail('a queue nonce ran twice');

  // 2e. the countdown is a server rule for the memory queue too
  reset(); reads = 0; seq.length = 0; seq.push(1000);
  const slow = mkq({ minDelayMs: 5000 }); slow.remember('pressure', rowsQ);
  const sp = await slow.previewQueue({ items: items(['swarm-a']), needMB: 4000 });
  const early = await slow.runQueue({ nonce: sp.nonce });
  if (!early.ok && /Too soon/.test(early.refused)) ok('a memory queue run sooner than five seconds after its preview is refused by the server');
  else fail('the memory queue skipped the countdown', JSON.stringify(early));

  // ---- 3. helpers grouped under their app -----------------------------------------------------------------
  const P = (pid, command, family, kbMB, ppid = 1) => ({ pid, ppid, command, family, rssKB: kbMB * MB, cpuPct: 1, ageS: 5000, startedAt: NOW - 5_000_000, tty: null });
  const ORCA = '/Applications/Orca.app/Contents';
  const fake = [
    P(11, `${ORCA}/MacOS/Orca`, 'Orca', 120),
    P(12, `${ORCA}/Frameworks/Orca Helper (Renderer).app/Contents/MacOS/Orca Helper (Renderer)`, 'Orca Helper (Renderer)', 150, 11),
    P(13, `${ORCA}/Frameworks/Orca Helper (GPU).app/Contents/MacOS/Orca Helper (GPU)`, 'Orca Helper (GPU)', 90, 11),
    P(14, `${ORCA}/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper`, 'Orca Helper', 50, 11),
    P(21, '/Applications/Cursor.app/Contents/MacOS/Cursor', 'Cursor', 100),
    P(22, '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Renderer).app/Contents/MacOS/Cursor Helper (Renderer)', 'Cursor Helper (Renderer)', 200, 21),
    P(31, '/Applications/Discord.app/Contents/MacOS/Discord', 'Discord', 80),
    P(32, '/Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer).app/Contents/MacOS/Discord Helper (Renderer)', 'Discord', 60, 31),
    P(41, '/usr/local/bin/node', 'node (dev servers)', 300),
    P(42, '/usr/local/bin/other', 'other', 1),   // under the 2 MB floor
  ];
  const groups = mem.group(mem.processes(fake));
  const names = groups.map((g) => g.name).sort().join(',');
  const orca = groups.find((g) => g.name === 'Orca');
  if (names === 'Cursor,Discord,Orca,node (dev servers)' && orca.n === 4 && orca.rssKB === 410 * MB) ok('helpers sit under their parent .app as one group: "Orca: 4 processes, 410 MB" (Orca, Orca Helper, Orca Helper (Renderer), Orca Helper (GPU)), and a name the platform already knew is kept');
  else fail('helpers are not grouped under their app', `${names} / ${orca && orca.n} / ${orca && orca.rssKB}`);
  if (mem.appOf('/usr/local/bin/node') === null && mem.appOf('relative/App.app/x') === null && mem.appOf(`${ORCA}/Frameworks/X.app/Contents/MacOS/X`).appPath === '/Applications/Orca.app') ok('the parent app is the outermost .app; a command outside any bundle has none');
  else fail('appOf is wrong');
  const keep = {};
  for (const k of ['processList', 'memoryStats', 'swapStats', 'memoryPressure', 'appBundle']) keep[k] = platform[k];
  try {
    platform.processList = async () => fake;
    platform.memoryStats = async () => ({ totalBytes: 16 * 1073741824, freeBytes: 1e9, activeBytes: 1e9, inactiveBytes: 1e9, wiredBytes: 1e9, compressedBytes: 0, pageSizeBytes: 4096 });
    platform.swapStats = async () => ({ totalMB: 0, usedMB: 0, freeMB: 0 });
    platform.memoryPressure = async () => null;
    platform.appBundle = async (c) => { const m = /^(\/Applications\/([^/]+)\.app)\//.exec(String(c)); return m ? { appPath: m[1], bundleId: `com.example.${m[2].toLowerCase()}`, name: m[2] } : null; };
    const d = await mem.collect();
    const g = d.groups.find((x) => x.name === 'Orca');
    const withAction = d.groups.filter((x) => x.action);
    const orcaRows = d.groups.filter((x) => x.target && x.target.appPath === '/Applications/Orca.app');
    if (g && g.n === 4 && g.helpers === 3 && g.procs.length === 4 && g.procs.filter((p) => p.helper).length === 3 && !g.procs.find((p) => p.pid === 11).helper) ok('the group row carries its processes with the helpers marked, "Orca: 4 processes, 3 helpers"');
    else fail('the Orca group row is wrong', JSON.stringify(g && { n: g.n, helpers: g.helpers, procs: g.procs.length }));
    if (g.action && g.action.id === 'quit-app' && orcaRows.length === 1 && g.target.pids.length === 4 && withAction.every((x) => x.action.id === 'quit-app')) ok('quit-app is on the app row only: one row for Orca, naming all four pids, and no group offers any other action');
    else fail('quit-app is not on the app row only', JSON.stringify({ rows: orcaRows.length, action: g.action }));
    if (!JSON.stringify(d.groups.map((x) => x.procs)).includes('"action"')) ok('no individual helper process carries an action');
    else fail('a helper process carries an action');
  } finally { for (const k of Object.keys(keep)) platform[k] = keep[k]; }
  const actSrc = read('lib/act.js');
  if (!/helper/i.test((actSrc.match(/const ACTIONS = Object\.freeze\(\{[\s\S]*?\n\}\);/) || [''])[0].replace(/lose:[^\n]*|describe:[^\n]*|confirm:[^\n]*/g, ''))) ok('the action table has no entry for a helper process');
  else fail('the action table mentions a helper process');

  // ---- 4. the Docker advice card ----------------------------------------------------------------------------
  const parse = mem.parseDockerSettings;
  const p1 = parse('{"MemoryMiB": 8192, "other": 1}'), p2 = parse('{"memoryMiB": 4096}'), p3 = parse('not json'), p4 = parse('{"memoryMiB": "8"}'), p5 = parse('{"cpus": 4}'), p6 = parse('[1]'), p7 = parse('{"memoryMiB": 3}');
  if (p1.memoryMiB === 8192 && p2.memoryMiB === 4096 && p3.ok === false && p4.memoryMiB === null && p5.memoryMiB === null && p6.ok === false && p7.memoryMiB === null) ok('Docker settings parse: MemoryMiB or memoryMiB, whatever the case; invalid JSON, a non-number, a missing key or an absurd value is no limit, never a guess');
  else fail('the Docker settings parser is wrong', JSON.stringify([p1, p2, p3, p4, p5, p6, p7]));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-docker-card-'));
  try {
    const none = mem.readDockerSettings({ home });
    if (none.file === null && none.memoryMiB === null && none.why === 'absent') ok('a missing Docker settings file is tolerated: no file, no limit, "absent"');
    else fail('a missing settings file was not tolerated', JSON.stringify(none));
    const dir = path.join(home, 'Library', 'Group Containers', 'group.com.docker');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"memoryMiB": 6144}');
    const old = mem.readDockerSettings({ home });
    fs.writeFileSync(path.join(dir, 'settings-store.json'), '{"MemoryMiB": 10240}');
    const fresh = mem.readDockerSettings({ home });
    fs.writeFileSync(path.join(dir, 'settings-store.json'), '{"cpus": 4}');
    const fallback = mem.readDockerSettings({ home });
    fs.writeFileSync(path.join(dir, 'settings-store.json'), '{{ broken');
    const broken = mem.readDockerSettings({ home });
    if (old.memoryMiB === 6144 && fresh.memoryMiB === 10240 && /settings-store\.json$/.test(fresh.file) && fallback.memoryMiB === 6144 && broken.memoryMiB === 6144) ok('settings-store.json is read first, settings.json is the fallback, and a store with no key or a broken one falls through to it');
    else fail('the Docker settings file order is wrong', JSON.stringify([old, fresh, fallback, broken]));
    fs.rmSync(path.join(dir, 'settings.json'));
    const onlyBroken = mem.readDockerSettings({ home });
    if (onlyBroken.memoryMiB === null && onlyBroken.why === 'unreadable') ok('a settings file that is there but unreadable says "unreadable", not "no limit configured"');
    else fail('a broken settings file was misreported', JSON.stringify(onlyBroken));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }

  const desktop = { pid: 50, ppid: 1, command: '/Applications/Docker.app/Contents/MacOS/com.docker.backend', family: 'Docker Desktop', rssKB: 300 * MB };
  const vm = (kbMB) => ({ pid: 51, ppid: 50, command: '/System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine', family: 'Apple VM (Docker/Claude)', rssKB: kbMB * MB });
  const total = 16 * 1073741824;
  const asked = [];
  const card = await mem.dockerAdvice([desktop, vm(4096)], { totalBytes: total, settings: () => ({ file: '/x/settings-store.json', memoryMiB: 8192 }), containers: async () => { asked.push(1); return 0; } });
  if (card && card.limitMiB === 8192 && card.limitPct === 50 && card.containers === 0 && card.vmMB === 4096 && /50% of this machine's 16 GB/.test(card.advice)
    && /Settings > Resources/.test(card.changeAt) && /Settings > Resources > Advanced > Memory limit/.test(card.advice) && /Resource Saver/.test(card.advice) && !('action' in card)) ok('Docker card: the limit (8 GB), as a share of RAM (50%), 0 containers running, the exact Docker Desktop path (Settings > Resources) and the Resource Saver advice, and no action');
  else fail('the Docker card is wrong', JSON.stringify(card));
  const busy = await mem.dockerAdvice([desktop, vm(4096)], { totalBytes: total, settings: () => ({ file: '/x/s.json', memoryMiB: 12288 }), containers: async () => 3 });
  if (busy.containers === 3 && busy.limitPct === 75 && /3 container\(s\) are running/.test(busy.advice) && /lower the limit/.test(busy.advice) && !/Turn on Resource Saver/.test(busy.advice)) ok('with containers running and a limit above half of RAM, the advice is to lower the limit, not to enable Resource Saver');
  else fail('the busy-Docker advice is wrong', busy.advice);
  asked.length = 0;
  const asleep = await mem.dockerAdvice([desktop, vm(100)], { totalBytes: total, settings: () => ({ file: null, memoryMiB: null, why: 'absent' }), containers: async () => { asked.push(1); return 0; } });
  if (asleep.asleep && asleep.containers === null && !asked.length && asleep.limitMiB === null && asleep.limitPct === null && /not found/.test(asleep.advice) && /asking would wake it/.test(asleep.advice)) ok('a sleeping Docker VM is not woken to count containers, and a missing settings file is said to be missing, not guessed');
  else fail('the sleeping-Docker card is wrong', JSON.stringify([asleep, asked]));
  const nokey = await mem.dockerAdvice([desktop, vm(2048)], { totalBytes: total, settings: () => ({ file: path.join(os.homedir(), 'Library/x.json'), memoryMiB: null, why: 'no-limit-key' }), containers: async () => 1 });
  if (nokey.limitMiB === null && /has no memory limit/.test(nokey.advice) && !/\/Users\//.test(nokey.file || '')) ok('a settings file without the key says so, and the path is shown with ~ for the home folder');
  else fail('the no-key card is wrong', JSON.stringify(nokey));
  const absent = await mem.dockerAdvice([{ pid: 1, command: '/usr/bin/yes', family: 'yes', rssKB: 5000 }], { totalBytes: total });
  const noVm = await mem.dockerAdvice([desktop], { totalBytes: total });
  if (absent === null && noVm === null) ok('no Docker Desktop VM running, no card');
  else fail('a Docker card appeared without a Docker VM');
  const privacy = read('docs/PRIVACY.md'), readme = read('README.md');
  if (/settings-store\.json/.test(privacy) && /group\.com\.docker/.test(privacy) && /memoryMiB/i.test(privacy)) ok('docs/PRIVACY.md names the Docker settings file, its folder and the one key read from it');
  else fail('docs/PRIVACY.md does not document the Docker settings read');
  if (/I need X GB/.test(readme) && /Docker Desktop/.test(readme)) ok('the README describes the plan and the Docker card');
  else fail('the README does not describe the plan');
}

async function step(name, fn) {
  console.log('\n' + name);
  try { await fn(); }
  catch (e) { fail(`${name} threw instead of reporting`, String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')); }
}

// Open-only actions: the table is closed, a path must have been measured, and the
// Terminal opener carries nothing the browser could fill in.
async function openOnly() {
  const os = require('node:os');
  const o = require('../lib/open');
  const home = fs.realpathSync(os.homedir());
  const banned = /^(rm|sudo|kill|killall|networksetup|osascript|sh|bash|zsh|do shell script)$/;

  const ids = Object.keys(o.OPENERS).sort().join(',');
  if (ids === 'activity,backup,login,reveal,storage,terminal,trash') ok('the open-only table has exactly the seven agreed entries (the Trash opener takes no argument)');
  else fail('the open-only table changed', ids);

  const bad = [];
  for (const [id, e] of Object.entries(o.OPENERS)) {
    const argv = e.argv(id === 'reveal' ? path.join(home, 'x') : undefined);
    if (argv[0] !== 'open' || argv.some((a) => banned.test(a))) bad.push(id);
  }
  if (!bad.length) ok('every opener is `open` and none builds rm, sudo, kill or networksetup');
  else fail('an opener builds something other than a plain open', bad.join(', '));

  const t = o.OPENERS.terminal;
  const same = JSON.stringify(t.argv('rm -rf ~')) === JSON.stringify(t.argv()) && t.argv().length === 3;
  if (same && o.resolve('terminal', 'rm -rf ~', { plat: 'darwin' }).ok === false) ok('the Terminal opener has no argument, and refuses one');
  else fail('the Terminal opener can carry text');

  // A folder inside home that the scan "measured", one inside home it did not, and one outside home.
  const dir = fs.mkdtempSync(path.join(home, '.reckon-check-'));
  try {
    const link = path.join(dir, 'link');
    fs.symlinkSync('/etc', link);
    const scanData = { targets: [{ path: dir }, { path: link }], homeTop: [], repos: { repos: [] } };
    const r = (t, d = scanData) => o.resolve('reveal', t, { scanData: d, plat: 'darwin' });
    if (r(dir).ok && r(dir).argv.join(' ') === `open -R ${fs.realpathSync(dir)}`) ok('reveal accepts a path the scan measured');
    else fail('reveal refused a measured path', JSON.stringify(r(dir)));
    if (!r(path.join(dir, 'other')).ok && !r(os.tmpdir()).ok) ok('reveal refuses a path the scan did not measure');
    else fail('reveal accepted an unmeasured path');
    if (!r('/etc').ok && !r('/etc', { targets: [{ path: '/etc' }] }).ok) ok('reveal refuses a path outside home, even when listed');
    else fail('reveal accepted a path outside home');
    if (!r(link).ok) ok('reveal refuses a symlink that leads outside home');
    else fail('reveal followed a symlink out of home');
    if (!r(dir, null).ok && !r('relative/path').ok && !o.resolve('reveal', undefined, { scanData, plat: 'darwin' }).ok) ok('reveal refuses with no scan, a relative path or no target');
    else fail('reveal accepted a missing scan or a malformed target');
    if (!o.resolve('activity', dir, { plat: 'darwin' }).ok) ok('only reveal takes a target');
    else fail('a no-target opener accepted a target');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  if (!o.resolve('unknown', null, { plat: 'darwin' }).ok && !o.resolve('__proto__', null, { plat: 'darwin' }).ok) ok('an id outside the table is refused');
  else fail('an unknown opener id was accepted');
  if (o.available('win32').length === 0 && o.available('linux').length === 0 && !o.resolve('terminal', null, { plat: 'win32' }).ok) ok('off macOS there are no openers, so the UI draws no buttons');
  else fail('openers are offered off macOS');
}

// ---- phase 4: history, the watcher view, the remembered verdict -----------------
// Every fixture lives in a temporary folder that the test makes and removes. Nothing here reads
// or writes the real ~/.cache/reckon, and nothing runs an action.
async function phase4() {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const h = require('../lib/history');
  const tri = require('../lib/triage');
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reckon-p4-')));
  const cache = path.join(tmp, '.cache', 'reckon');
  fs.mkdirSync(cache, { recursive: true });
  try {
    // 1. actions.log: parsed, newest first, refusals kept, a corrupt line skipped.
    const lines = [
      { at: 1000, action: 'quit-app', id: 'g1', title: 'Opera', refused: 'quit or restarted' },
      '{not json',
      { at: 2000, action: 'quit-app', id: 'g2', title: 'Discord', argv: ['osascript'], dryRun: true },
      { at: 3000, action: 'quit-app', id: 'g3', title: 'Slack', ok: true, freedKB: 2048, before: { availableMB: 100 }, after: { availableMB: 300 } },
      { at: 4000, action: 'trash-path', id: 'd1', title: 'old', ok: true, target: path.join(tmp, 'gone') },
    ].map((l) => (typeof l === 'string' ? l : JSON.stringify(l)));
    fs.writeFileSync(path.join(cache, 'actions.log'), lines.join('\n') + '\n');
    const d = h.readDone({ dir: cache });
    const outcomes = d.rows.map((r) => r.outcome).join(',');
    if (d.rows.length === 4 && d.rows[0].at === 4000 && outcomes === 'done,done,dry-run,refused') ok('the Done tab reads actions.log newest first, refusals included, a corrupt line skipped');
    else fail('actions.log was not parsed as expected', outcomes);
    if (d.rows[0].trashed && !d.rows[1].trashed && d.rows[1].freedKB === 2048 && d.rows[2].freedKB === null) ok('freed is only a number the action measured; trashed items are flagged for the Open Trash button');
    else fail('freed or trashed is wrong');
    if (h.readDone({ dir: path.join(tmp, 'nothing') }).rows.length === 0) ok('a missing log is an empty list, not an error');
    else fail('a missing actions.log threw or invented rows');

    // 2. "check it" measures one target again, from the log, inside home only.
    const inHome = path.join(tmp, 'thing'); fs.mkdirSync(inHome);
    fs.appendFileSync(path.join(cache, 'actions.log'), JSON.stringify({ at: 5000, action: 'x', target: inHome, ok: true }) + '\n'
      + JSON.stringify({ at: 5001, action: 'x', target: '/etc', ok: true }) + '\n'
      + JSON.stringify({ at: 5002, action: 'term', stillAlive: [999999999], ok: true }) + '\n'
      + JSON.stringify({ at: 5003, action: 'y', ok: true }) + '\n');
    const sizeOf = async () => 42;
    const c1 = await h.recheck({ at: 5000, dir: cache, home: tmp, sizeOf });
    const c2 = await h.recheck({ at: 5001, dir: cache, home: tmp, sizeOf });
    const c3 = await h.recheck({ at: 5002, dir: cache, home: tmp, sizeOf, alive: () => false });
    const c4 = await h.recheck({ at: 5003, dir: cache, home: tmp, sizeOf });
    const c5 = await h.recheck({ at: 77, dir: cache, home: tmp, sizeOf });
    fs.rmSync(inHome, { recursive: true });
    const c6 = await h.recheck({ at: 5000, dir: cache, home: tmp, sizeOf });
    if (c1.ok && c1.exists && c1.kb === 42 && !c2.ok && c3.kind === 'pids' && c3.stillAlive.length === 0 && c4.kind === 'none' && !c5.ok && c6.exists === false) ok('"check it" measures only the target in the log line, refuses a path outside home, and says so when there is nothing to measure');
    else fail('"check it" is wrong', JSON.stringify([c1, c2, c3, c4, c5, c6]));

    // 3. The watcher is judged by the same rule as the native pet.
    const swift = read('native/pet.swift');
    if (/max\(3 \* every, 90_000\)/.test(swift) && h.staleAfterMs(30000) === 90000 && h.staleAfterMs(60000) === 180000 && h.staleAfterMs(10000) === 90000) ok('the stale rule is max(3 x interval, 90 s), the one native/pet.swift uses');
    else fail('the stale rule drifted from native/pet.swift');
    const now = 1_000_000_000_000, alive = () => true;
    const snap = (over) => ({ running: true, pid: 5, at: now - 10_000, intervalMs: 30000, level: 0.4, state: 'watching', active: [], ...over });
    const j = (s, a = alive) => h.judgeWatch(s, { now, alive: a }).status;
    const rows = [j(snap()) === 'running', j(snap({ at: now - 89_000 })) === 'running', j(snap({ at: now - 91_000 })) === 'stopped',
      j(snap({ at: now - 120_000, intervalMs: 60000 })) === 'running', j(snap({ at: now - 181_000, intervalMs: 60000 })) === 'stopped',
      j(snap(), () => false) === 'stopped', j(snap({ running: false })) === 'stopped', j(null) === 'never'];
    if (rows.every(Boolean)) ok('a watcher is running only if its pid is alive and its reading is fresh; otherwise stopped or never');
    else fail('the watcher staleness rule is wrong', rows.join(','));
    fs.writeFileSync(path.join(cache, 'watch.json'), JSON.stringify(snap({ at: Date.now(), pid: process.pid })));
    fs.writeFileSync(path.join(cache, 'watch.log'), JSON.stringify({ type: 'alert', kind: 'swap', at: 1, title: 'Swap holds 9 GB', cost: 'c', proof: 'p', lose: 'l', command: 'ps' }) + '\nbroken\n'
      + JSON.stringify({ type: 'clear', kind: 'swap', at: 2, title: 'Cleared' }) + '\n');
    const w = h.readWatch({ dir: cache });
    if (w.running && w.events.length === 2 && w.events[1].proof === 'p' && w.events[1].lose === 'l' && w.events[0].type === 'clear' && w.startWith === 'node bin/reckon watch') ok('the Watch tab reads the state and the last events with their proof and what you lose, and offers the start command as text');
    else fail('readWatch is wrong', JSON.stringify(w).slice(0, 200));
    fs.writeFileSync(path.join(cache, 'watch.json'), JSON.stringify(snap({ at: Date.now() - 600_000, pid: process.pid })));
    const ws = h.readWatch({ dir: cache });
    if (!ws.running && ws.snapshot.level === null && ws.snapshot.state === null) ok('a stale watcher shows no level and no state');
    else fail('a stopped watcher still shows a level');

    // 4. Memory history: recorded, read back, trimmed.
    for (let i = 0; i < 3; i++) h.recordMemory({ t: 1000 + i, swapMB: 100.4 + i, ramMB: 16384 }, { dir: cache });
    h.recordMemory({ t: 'x', swapMB: 1 }, { dir: cache });
    const m = h.readMemory({ dir: cache });
    if (m.points.length === 3 && m.points[0].swapMB === 100 && m.to === 1002) ok('the memory history survives: readings are appended and read back, bad ones ignored');
    else fail('memory history is wrong', JSON.stringify(m));
    const big = path.join(tmp, 'big'); fs.mkdirSync(big);
    for (let i = 0; i < 2100; i++) h.recordMemory({ t: i, swapMB: 5, ramMB: 16384 }, { dir: big });
    const n = fs.readFileSync(path.join(big, h.MEM_FILE), 'utf8').split('\n').filter(Boolean).length;
    if (n < 2100 && n >= 1500) ok('the memory history file is trimmed, not left to grow');
    else fail('the memory history file was not trimmed', String(n));
    if (/history\.recordMemory/.test(read('lib/watch.js'))) ok('the watcher records each swap reading');
    else fail('the watcher does not record the memory history');

    // 5. Verdict per repo, with the fingerprint that expires it.
    const git = (repo, ...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
    const repo = path.join(tmp, 'proj'); fs.mkdirSync(repo);
    git(repo, 'init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), '1'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'one');
    const scanData = { repos: { repos: [{ git: true, path: repo }] } };
    const o = { dir: cache, home: tmp, scanData };
    const bad1 = await tri.mark(repo, 'delete', o), bad2 = await tri.mark(repo, 'keep', { ...o, scanData: { repos: { repos: [] } } });
    const outside = await tri.mark('/etc', 'keep', { ...o, scanData: { repos: { repos: [{ git: true, path: '/etc' }] } } });
    if (!bad1.ok && !bad2.ok && !outside.ok) ok('a verdict outside keep/trash/maybe, a repo the scan did not measure, and a path outside home are all refused');
    else fail('a bad verdict request was accepted', JSON.stringify([bad1, bad2, outside]));
    if ((await tri.mark(repo, 'trash', o)).ok && !(await tri.status({ dir: cache })).verdicts[repo].expired) ok('a verdict is remembered, and holds while the repo is unchanged');
    else fail('a fresh verdict was not remembered or already expired');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'dirty');
    const s1 = (await tri.status({ dir: cache })).verdicts[repo];
    if (s1.expired && /uncommitted/.test(s1.why)) ok('uncommitted changes expire the verdict, with the reason');
    else fail('a dirty tree did not expire the verdict', JSON.stringify(s1));
    await tri.mark(repo, 'keep', o);
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'two');
    const s2 = (await tri.status({ dir: cache })).verdicts[repo];
    if (s2.expired && /committed/.test(s2.why)) ok('a new commit expires the verdict, with the reason');
    else fail('a new commit did not expire the verdict', JSON.stringify(s2));
    git(repo, 'remote', 'add', 'origin', 'https://example.invalid/x.git');
    await tri.mark(repo, 'maybe', o);
    git(repo, 'remote', 'remove', 'origin');
    if ((await tri.status({ dir: cache })).verdicts[repo].expired) ok('gaining or losing a remote expires the verdict');
    else fail('a changed remote did not expire the verdict');
    const pure = [tri.expiry({ fingerprint: { commit: 'a', dirty: 0, hasRemote: true } }, { commit: 'a', dirty: 0, hasRemote: true }) === null,
      tri.expiry({ fingerprint: { commit: 'a', dirty: 0, hasRemote: true } }, null) !== null, tri.expiry({}, { commit: 'a', dirty: 0, hasRemote: true }) !== null];
    if (pure.every(Boolean)) ok('a verdict that cannot be compared with its repo counts as expired');
    else fail('expiry() trusts a verdict it cannot compare');
    fs.rmSync(repo, { recursive: true });
    if ((await tri.status({ dir: cache })).verdicts[repo].gone) ok('a verdict whose folder is gone is reported as gone');
    else fail('a verdict for a missing folder was not reported');

    // 6. The new routes: GET and read-only; the one POST needs the token the guard already requires.
    const srv = read('server.js');
    const p4 = srv.slice(srv.indexOf('// ---- phase 4 routes'), srv.indexOf('// ---- end phase 4 routes'));
    const readRoutes = ['/api/done', '/api/done/check', '/api/watchstate', '/api/memory/history', '/api/triage'];
    const notGet = readRoutes.filter((r) => !new RegExp(`route === '${r}' && req\\.method === 'GET'`).test(p4));
    if (!notGet.length) ok('the Done, Watch, memory-history and triage reads are GET routes');
    else fail('a phase 4 read is not restricted to GET', notGet.join(', '));
    const hist = read('lib/history.js').replace(/\/\/.*$/gm, '');
    const writers = (hist.match(/writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync/g) || []).length;
    const writeOutside = hist.slice(0, hist.indexOf('function recordMemory')).match(/writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync/);
    if (!writeOutside && writers > 0 && !/spawn|execFile|run\(/.test(hist)) ok('lib/history.js writes only in recordMemory, inside the cache folder, and runs no command');
    else fail('lib/history.js writes or runs something outside recordMemory');
    if (/route === '\/api\/triage\/mark' && req\.method === 'POST'/.test(p4) && !/\/api\/triage\/mark' && req\.method === 'GET/.test(p4)) ok('marking a verdict is a POST, behind the Host, Origin and token guard');
    else fail('marking a verdict is not a POST');
    if (!/\b(act|opener)\./.test(p4)) ok('no phase 4 route touches the action engine or the openers');
    else fail('a phase 4 route reaches into the action engine');

    // 7. The tabs are wired: ids, sections, selectors, and the Open Trash opener.
    const html = read('web/index.html'), app = read('web/app.js');
    const wired = ['done', 'watch'].filter((t) => !(html.includes(`data-tab="${t}"`) && html.includes(`id="tab-${t}"`) && new RegExp(`const TABS = \\[[^\\]]*'${t}'`).test(app) && app.includes(`$('#tab-${t}')`)));
    if (!wired.length) ok('the Done and Watch tabs have a button, a section, an entry in TABS and a drawing function');
    else fail('a tab is not wired', wired.join(', '));
    if (/loadDone\(\)/.test(app) && /loadWatch\(\)/.test(app) && /\/api\/done'/.test(app) && /\/api\/watchstate/.test(app) && /\/api\/memory\/history/.test(app) && /\/api\/triage'/.test(app)) ok('the page calls each new read route');
    else fail('the page does not call a new route');
    if (/openBtn\('trash'/.test(app) && /trash:\s+\{[^}]*target: false/.test(read('lib/open.js'))) ok('Open Trash uses a fixed opener that takes no argument');
    else fail('Open Trash is not a fixed no-argument opener');
    const corner = read('web/corner.html');
    if (/id="panel"/.test(corner) && /:4127\/#pressure/.test(corner) && !/execute|\.click\(\)/.test(corner)) ok('the corner links to the panel’s Pressure tab and executes nothing');
    else fail('the corner link is missing or does something more');
    if (fs.existsSync(path.join(ROOT, 'docs/2026-10-07-pet-panel-link-proposal.md'))) ok('the native pet link is a proposal in docs/, not an edit to native/pet.swift');
    else fail('the pet link proposal is missing');
    const tdoc = read('docs/2026-09-11-triage-design.md');
    if (!/triagem|decisoes|testar\.js/.test(tdoc)) ok('the triage design names the real English files');
    else fail('the triage design still names Portuguese files');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

(async () => {
  await step('requires', async () => { await requires(); });
  await step('any platform', async () => { await loadsOnAnyPlatform(); });
  await step('shared scope', async () => { await sharedScope(); });
  await step('selectors', async () => { await selectors(); });
  await step('contracts', async () => { await contracts(); });
  await step('css', async () => { await css(); });
  await step('dns', async () => { await dnsRecipe(); });
  await step('polish', async () => { await polish(); });
  await step('platform', async () => { await platformContract(); });
  await step('blocklist', async () => { await blocklistSieve(); });
  await step('targets', async () => { await targetLists(); });
  await step('last round', async () => { await lastRound(); await backupLadder(); await readmeIsTrue(); });
  await step('only here', async () => { await onlyHere(); });
  await step('which shell', async () => { await whichShell(); });
  await step('batch sizing', async () => { await batchSizing(); });
  await step('grouping', async () => { await grouping(); });
  await step('cross-platform', async () => { await crossPlatformRender(); });
  await step('internet', async () => { await networkPromises(); });
  await step('packaging', async () => { await packagedBundle(); });
  await step('safety', async () => { await safety(); await noHardcodedPaths(); });
  await step('server guards', async () => { await serverGuards(); });
  await step('companion', async () => { await petStatusIsShape(); });
  await step('native pet', async () => { await nativePet(); });
  await step('watch', async () => { await watchDecides(); });
  await step('memory measurements', async () => { await memoryMeasures(); });
  await step('corner', async () => { await cornerIsSafe(); });
  await step('open only', async () => { await openOnly(); });
  await step('actions', async () => { await actions(); });
  await step('memory plan', async () => { await memoryPlan(); });
  await step('phase 4', async () => { await phase4(); });
  await step('agent skills', async () => { await agentSkills(); });
  await step('stray draw', async () => { noStrayDraw(); });
  if (!process.env.RECKON_CHECK_CHILD) await step('other platforms', asUnsupportedPlatform);
  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})();
