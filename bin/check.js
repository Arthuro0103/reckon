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
  const names = Object.keys(act.ACTIONS);
  for (const name of names) {
    const a = act.ACTIONS[name];
    const missing = ['label', 'kind'].filter((k) => typeof a[k] !== 'string')
      .concat(['confirm', 'describe', 'lose', 'undo', 'verify', 'argv', 'settle'].filter((k) => typeof a[k] !== 'function'))
      .concat(typeof a.reversible === 'boolean' ? [] : ['reversible']);
    if (missing.length) { fail(`action ${name} is missing ${missing.join(', ')}`); continue; }
    let argv;
    try { argv = a.argv(sample, check); act.assertSafe(...argv); }
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
  await step('corner', async () => { await cornerIsSafe(); });
  await step('open only', async () => { await openOnly(); });
  await step('actions', async () => { await actions(); });
  await step('phase 4', async () => { await phase4(); });
  await step('agent skills', async () => { await agentSkills(); });
  await step('stray draw', async () => { noStrayDraw(); });
  if (!process.env.RECKON_CHECK_CHILD) await step('other platforms', asUnsupportedPlatform);
  console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
  process.exit(failures ? 1 : 0);
})();
