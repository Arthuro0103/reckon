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

// 1. Every require resolves. `node --check` resolves no modules at all.
function requires() {
  const files = ['server.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => 'lib/' + f)];
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
  for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
    const lines = read('lib/' + f).split('\n');
    let dirty = 0;
    lines.forEach((l, i) => {
      const m = l.match(/^\s*([a-zA-Z][a-zA-Z0-9_]*):\s/);
      if (m && ACCENT.test(m[1])) { fail(`accented object key in lib/${f}:${i + 1} -> ${m[1]}`); dirty++; }
    });
    if (!dirty) ok(`lib/${f} has no accented keys`);
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
  const r = recipe('Wi-Fi', 'adguard', ['8.8.8.8', '8.8.4.4']);
  if (!r) return fail('the DNS recipe was not built');
  for (const [field, text] of [['apply', r.apply], ['undo', r.undo]]) {
    if (/\bnull\b|undefined/.test(text)) fail(`the '${field}' command came out with null/undefined`, text);
    else if (!text.includes('"Wi-Fi"')) fail(`the '${field}' command does not name the service`, text);
    else ok(`the '${field}' command names the service`);
  }
  if (r.undo.includes('8.8.8.8 8.8.4.4')) ok('undo restores exactly the addresses from before');
  else fail('undo does not restore the original addresses', r.undo);
  if (recipe('Wi-Fi', 'current', ['8.8.8.8']) === null) ok('a provider with no addresses produces no command');
  else fail('the "current" provider should not produce a command');
}

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

// 8. Nothing destructive runs on its own, and the server is loopback-only.
function safety() {
  const suspect = /execFile\(\s*['"](rm|sudo|networksetup)\b|exec\(\s*['"]\s*(rm|sudo)\b/;
  let dirty = 0;
  for (const f of ['server.js', ...fs.readdirSync(path.join(ROOT, 'lib')).map((x) => 'lib/' + x)]) {
    if (suspect.test(read(f))) { fail(`${f} appears to run a destructive command directly`); dirty++; }
  }
  if (!dirty) ok('no module runs rm/sudo/networksetup on its own');

  const s = read('server.js');
  if (s.includes('127.0.0.1') && s.includes('403')) ok('the server refuses non-loopback callers');
  else fail('the server does not check where the connection came from');
  if (/listen\(\s*PORT\s*,\s*'127\.0\.0\.1'/.test(s)) ok('the server listens on 127.0.0.1 only');
  else fail('the server may be listening on every interface');
}

// 9. Nothing personal to the machine that built this is baked into the source.
function noHardcodedPaths() {
  const files = [...fs.readdirSync(path.join(ROOT, 'lib')).map((f) => 'lib/' + f), 'server.js', 'web/app.js'];
  const suspect = /\/Users\/(?!\[)[a-z]/i;
  let dirty = 0;
  for (const f of files) {
    const m = read(f).match(suspect);
    if (m) { fail(`${f} contains an absolute path to somebody's home directory`, m[0]); dirty++; }
  }
  if (!dirty) ok('no hardcoded home directory anywhere in the source');
}

(async () => {
  console.log('\nrequires');      requires();
  console.log('\nshared scope');  sharedScope();
  console.log('\nselectors');     selectors();
  console.log('\ncontracts');     contracts();
  console.log('\ncss');           css();
  console.log('\ndns');           dnsRecipe();
  console.log('\nblocklist');     blocklistSieve();
  console.log('\nsafety');        safety(); noHardcodedPaths();
  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})();
