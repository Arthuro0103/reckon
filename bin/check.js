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
  for (const f of ['server.js', ...libFiles()]) {
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

    // A platform without the capability must behave exactly as before.
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

(async () => {
  console.log('\nrequires');      requires();
  console.log('\nshared scope');  sharedScope();
  console.log('\nselectors');     selectors();
  console.log('\ncontracts');     contracts();
  console.log('\ncss');           css();
  console.log('\ndns');           dnsRecipe();
  console.log('\nplatform');      platformContract();
  console.log('\nblocklist');     blocklistSieve();
  console.log('\ntargets');    targetLists();
  console.log('\nwhich shell'); whichShell();
  console.log('\nbatch sizing'); await batchSizing();
  console.log('\ngrouping');   grouping();
  console.log('\ncross-platform'); crossPlatformRender();
  console.log('\ninternet');   await networkPromises();
  console.log('\npackaging');  packagedBundle();
  console.log('\nsafety');        safety(); noHardcodedPaths();
  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})();
