'use strict';
/* ---------------------------------------------------------------------------
   Builds a single-executable copy of reckon using Node's built-in `node:sea`.
   Zero runtime dependencies: everything this script needs is either a Node
   built-in module or a tool it shells out to (tar — ships on macOS and on
   Windows since 10 1803 — and, on macOS, codesign; npx to run postject on
   demand). Nothing here becomes an entry in package.json's "dependencies".

   WHY IT DOWNLOADS NODE INSTEAD OF COPYING YOURS
   Building against the Homebrew build at /usr/local/bin/node fails with
   "Multiple occurrences of sentinel found" — postject's fuse-injection step
   scans the binary for its sentinel string and Homebrew's build happens to
   contain it twice (its packaging duplicates a section of the binary that
   the official build does not). The binary published on nodejs.org contains
   it exactly once. So: never point this script at `process.execPath` or any
   `node` found on PATH — always fetch an official build for the platform
   being targeted, once, into build/.cache/, and inject into that copy.
   If you hit the sentinel error again, you are almost certainly building
   against a repackaged Node (Homebrew, nvm-built-from-source with patches,
   a corporate mirror) rather than one downloaded from nodejs.org.

   WHAT GETS EMBEDDED
   - web/index.html, app.js, charts.js, style.css, tokens.css go in verbatim
     through the SEA "assets" map, read back at runtime with sea.getAsset().
   - server.js and every lib/ (recursively) file are concatenated into ONE generated
     main script (build/.gen/sea-main.js) with a small hand-rolled require()
     shim — SEA embeds exactly one main script, it does not walk a project's
     require() graph, so the alternative is a bundler, and this project does
     not use one even at build time. The shim below is ~40 lines because the
     dependency graph it has to serve is exactly the one lib/ already has:
     relative requires, node: builtins, and lib/platform's
     require.resolve()-and-catch probe for a platform file that may not exist.
--------------------------------------------------------------------------- */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CACHE = path.join(__dirname, '.cache');
const GEN = path.join(__dirname, '.gen');
const DIST = path.join(__dirname, 'dist');

// Pinned to the version the target machines for this task run. Bump this
// alongside the "engines" field in package.json, not independently of it.
const NODE_VERSION = process.env.RECKON_BUILD_NODE_VERSION || '22.15.1';
// Pinned: a build that silently changes its injector is not reproducible.
const POSTJECT_VERSION = '1.0.0-alpha.6';
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// One entry per shippable target. `dist` names the nodejs.org build; `bin`
// is the executable's path inside that archive; `out` is what we name the
// artifact. Windows and macOS only — this project has no Linux platform
// module yet (lib/platform/index.js says so plainly instead of pretending).
const TARGETS = {
  'darwin-arm64': { dist: 'darwin-arm64.tar.gz', bin: 'bin/node', out: 'reckon-macos-arm64', os: 'darwin' },
  'darwin-x64': { dist: 'darwin-x64.tar.gz', bin: 'bin/node', out: 'reckon-macos-x64', os: 'darwin' },
  'win32-x64': { dist: 'win-x64.zip', bin: 'node.exe', out: 'reckon-windows-x64.exe', os: 'win32' },
};

function hostTarget() {
  const arch = os.arch(); // 'arm64' | 'x64'
  if (os.platform() === 'darwin') return `darwin-${arch}`;
  if (os.platform() === 'win32') return 'win32-x64';
  throw new Error(`no SEA target for ${os.platform()}/${arch} — add one to TARGETS if you need it`);
}

function log(m) { console.log('  ' + m); }

// ---- 1. fetch an official Node build -------------------------------------

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest + '.part');
    https.get(url, { headers: { 'user-agent': 'reckon-build-sea' } }, (res) => {
      // nodejs.org does not redirect for these URLs today, but handle it
      // anyway rather than silently writing a redirect's HTML into the archive.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlinkSync(dest + '.part');
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.unlinkSync(dest + '.part');
        return reject(new Error(`GET ${url} -> ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => { fs.renameSync(dest + '.part', dest); resolve(); }));
    }).on('error', reject);
  });
}

// Read one file from nodejs.org as text. Used for SHASUMS256.txt, the only thing
// between "the CDN served the right bytes" and "I signed whatever arrived with my
// own identity and published it under my name".
function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'reckon-build-sea' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`GET ${url} -> ${res.statusCode}`));
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// The downloaded archive becomes more than 99% of an executable this pipeline
// ad-hoc-signs and attaches to a release under the project's name. Skipping this
// turns a TLS-intercepting proxy, a poisoned resolver, or one bad CDN object into
// a signed artifact carrying the maintainer's name.
//
// What it proves, and what it does not: the bytes match what nodejs.org's
// SHASUMS256.txt says, fetched over TLS from the same host. It is NOT a signature
// check. nodejs.org also publishes SHASUMS256.txt.sig, and verifying that needs
// release keys in a keyring this script does not carry, so anyone able to forge
// the archive over TLS could forge the sums file too. This closes accident and
// corruption, not a determined man-in-the-middle — and saying which is which is
// the difference between a real guarantee and a comforting one.
async function verifyAgainstShasums(archivePath, archiveName) {
  log('verifying the download against nodejs.org SHASUMS256.txt');
  const text = await fetchText(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`);
  const line = text.split('\n').find((l) => l.trim().endsWith(archiveName));
  if (!line) throw new Error(`${archiveName} is not listed in SHASUMS256.txt for v${NODE_VERSION} — wrong version, or the archive name changed`);
  const expected = line.trim().split(/\s+/)[0];
  const actual = sha256(archivePath);
  if (actual !== expected) {
    fs.unlinkSync(archivePath);   // never leave a bad archive cached to be reused
    throw new Error(`checksum mismatch for ${archiveName}\n  expected ${expected}\n  got      ${actual}\nThe cached copy was deleted. Do not ship this.`);
  }
  log(`  sha256 ok  ${expected.slice(0, 16)}…`);
}

// postject, fetched as a tarball and called through its programmatic API.
// `npx` on Windows is npx.cmd, and since the Node 18.20.2/20.12.2 hardening
// child_process refuses to run a .cmd without shell:true instead of resolving it
// through PATHEXT. The old form worked only because it was written and tested on
// macOS, where npx is a shell script: the Windows leg of this pipeline could
// never have run. The registry tarball sidesteps the launcher entirely.
async function fetchPostject() {
  fs.mkdirSync(CACHE, { recursive: true });
  const dir = path.join(CACHE, `postject-${POSTJECT_VERSION}`);
  const api = path.join(dir, 'package', 'dist', 'api.js');
  if (fs.existsSync(api)) { log(`using cached postject ${POSTJECT_VERSION}`); return api; }
  const tgz = path.join(CACHE, `postject-${POSTJECT_VERSION}.tgz`);
  if (!fs.existsSync(tgz)) {
    const url = `https://registry.npmjs.org/postject/-/postject-${POSTJECT_VERSION}.tgz`;
    log(`downloading ${url}`);
    await download(url, tgz);
  }
  // The registry publishes a sha for every tarball; check it for the same reason
  // the Node archive is checked.
  const meta = JSON.parse(await fetchText(`https://registry.npmjs.org/postject/${POSTJECT_VERSION}`));
  const want = ((meta.dist || {}).integrity || '').replace(/^sha512-/, '');
  if (want) {
    const got = crypto.createHash('sha512').update(fs.readFileSync(tgz)).digest('base64');
    if (got !== want) { fs.unlinkSync(tgz); throw new Error('postject tarball failed its integrity check; the cached copy was deleted'); }
    log('  postject integrity ok');
  } else {
    log('  WARNING: the registry returned no integrity hash for postject; proceeding unverified');
  }
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xf', tgz, '-C', dir]);
  if (!fs.existsSync(api)) throw new Error(`postject api not found at ${api} after extraction — package layout changed?`);
  return api;
}

async function fetchNode(targetKey) {
  const t = TARGETS[targetKey];
  if (!t) throw new Error(`unknown target '${targetKey}'. known: ${Object.keys(TARGETS).join(', ')}`);
  fs.mkdirSync(CACHE, { recursive: true });
  const archiveName = `node-v${NODE_VERSION}-${t.dist}`;
  const archivePath = path.join(CACHE, archiveName);
  const extractDir = path.join(CACHE, `node-v${NODE_VERSION}-${targetKey}`);
  // t.dist's own basename minus the extension IS the extracted folder's
  // suffix (nodejs.org always names the archive after the folder it unpacks
  // to) — deriving it this way avoids the trap of matching '.dist' against
  // "win": "darwin" contains the substring "win" too.
  const archiveFolderSuffix = t.dist.replace(/\.(tar\.gz|zip)$/, '');
  const binPath = path.join(extractDir, `node-v${NODE_VERSION}-${archiveFolderSuffix}`, t.bin);

  if (!fs.existsSync(archivePath)) {
    const url = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
    log(`downloading ${url}`);
    await download(url, archivePath);
    await verifyAgainstShasums(archivePath, archiveName);
  } else {
    log(`using cached ${archivePath}`);
    // The cache is re-verified, never trusted: it is a file on disk that
    // something else may have touched since.
    await verifyAgainstShasums(archivePath, archiveName);
  }

  if (!fs.existsSync(binPath)) {
    fs.mkdirSync(extractDir, { recursive: true });
    log(`extracting ${archiveName}`);
    // `tar -xf` (no explicit -z) auto-detects gzip vs. zip: macOS ships
    // bsdtar (libarchive-backed, reads both) and so does Windows since
    // Windows 10 1803 — one command instead of branching on `unzip` vs `tar`
    // and hoping `unzip` exists on whatever CI runner or Mac this runs on.
    execFileSync('tar', ['-xf', archivePath, '-C', extractDir]);
  }

  if (!fs.existsSync(binPath)) throw new Error(`expected node binary at ${binPath} after extraction — archive layout changed?`);
  return binPath;
}

// ---- 2. bundle server.js + lib/ (recursively) into one main script ---------------

// Walks lib/ and returns POSIX-style paths relative to ROOT, e.g. 'lib/sh.js'
// and 'lib/platform/darwin.js'. Sorted so the generated bundle is deterministic
// (a stable diff between builds, not a different file every run).
function libFiles() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  })('lib');
  return out.sort();
}

// server.js reads web/ off disk with fs.readFile so `node server.js` from a
// clone keeps working untouched. Under SEA there is no disk copy of web/ to
// read, so this same function, once patched (see build/README.md and the
// server.js patch that ships with this task), tries the embedded asset
// first. This transform applies that exact patch to an in-memory copy of
// server.js for the bundle, WITHOUT touching the real file on disk — the
// canonical server.js in the repo is edited by the integrator from the
// patch, and this string stays byte-for-byte identical to that patch so the
// two never drift apart.
function embedAssetPatch(src) {
  if (src.includes("require('node:sea')")) return src; // already patched upstream — nothing to do

  const guardAnchor = "const blocklist = require('./lib/blocklist');";
  const guard = `${guardAnchor}

// Single-executable builds (build/build-sea.js) embed web/ via the SEA assets
// map; sea.getAsset throws when an asset name isn't embedded, which is exactly
// what happens when this file runs from a normal \`node server.js\` clone —
// node:sea itself doesn't exist before Node 20, so the require is guarded too.
let sea = null;
try { sea = require('node:sea'); } catch { /* Node < 20, or not built as a SEA: filesystem only */ }`;
  if (!src.includes(guardAnchor)) throw new Error('embedAssetPatch: anchor not found — has server.js changed shape?');
  src = src.replace(guardAnchor, guard);

  const staticAnchor = `function static_(res, file) {
  const target = path.join(WEB, file);`;
  const staticReplacement = `function static_(res, file) {
  if (sea && sea.isSea()) {
    try {
      const buf = Buffer.from(sea.getAsset(file));
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(buf);
    } catch { /* not embedded under this name -- fall through to disk, same as a normal clone */ }
  }
  const target = path.join(WEB, file);`;
  if (!src.includes(staticAnchor)) throw new Error('embedAssetPatch: static_() anchor not found — has server.js changed shape?');
  return src.replace(staticAnchor, staticReplacement);
}

// Turns 'lib/platform/index.js' minus its extension into 'lib/platform/index',
// and resolves a require()'d id ('./darwin', '../sh') against it the same way
// Node's own resolver would — but only across the registry we bundled, never
// touching the filesystem, because there is no filesystem once this is one file.
function resolveId(fromKey, id) {
  if (!id.startsWith('.')) return null; // node: builtins and (there are none) bare specifiers
  const fromDir = fromKey.split('/').slice(0, -1);
  const stack = fromDir.slice();
  for (const part of id.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function buildMainScript() {
  const files = ['server.js', ...libFiles()];
  const modules = files.map((f) => {
    const key = f.replace(/\.js$/, '');
    let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (f === 'server.js') src = embedAssetPatch(src);
    return { key, src };
  });

  // Each module body runs inside a Function(module, exports, require,
  // __filename, __dirname) wrapper, same shape Node itself uses — so nothing
  // in lib/ has to know it is not running as normal, separate files.
  const registryEntries = modules
    .map((m) => `  ${JSON.stringify(m.key)}: function (module, exports, require, __filename, __dirname) {\n${m.src}\n  }`)
    .join(',\n');

  return `'use strict';
// GENERATED by build/build-sea.js — do not edit. Source of truth is server.js
// and lib/ (recursively) at the repo root; re-run the build script after changing them.
const hostRequire = require;

const REGISTRY = {
${registryEntries}
};

const cache = Object.create(null);

function resolveId(fromKey, id) {
  if (!id.startsWith('.')) return null;
  const fromDir = fromKey.split('/').slice(0, -1);
  const stack = fromDir.slice();
  for (const part of id.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

function requireModule(key) {
  if (cache[key]) return cache[key].exports;
  const entry = REGISTRY[key];
  if (!entry) throw new Error("bundled module not found: '" + key + "'");
  const mod = { exports: {} };
  cache[key] = mod;
  const localRequire = (id) => {
    const resolved = resolveId(key, id);
    if (resolved !== null && REGISTRY[resolved]) return requireModule(resolved);
    if (resolved !== null && REGISTRY[resolved + '/index']) return requireModule(resolved + '/index');
    return hostRequire(id); // node: builtins, or a real require.resolve probe below
  };
  localRequire.resolve = (id) => {
    const resolved = resolveId(key, id);
    if (resolved !== null && (REGISTRY[resolved] || REGISTRY[resolved + '/index'])) return resolved;
    return hostRequire.resolve(id); // throws for lib/platform/win32.js etc. — exactly what "not built yet" means
  };
  entry(mod, mod.exports, localRequire, key + '.js', key.split('/').slice(0, -1).join('/'));
  return mod.exports;
}

requireModule('server');

// Tier 3: behave like an app, not a terminal program. server.js prints its
// own "listening" line synchronously off the .listen() callback; we don't
// have a hook into that from out here without editing the shared file, so
// this opens the browser a beat later instead of coupling to that callback.
// A tab opening on an already-open server is harmless; a tab racing ahead of
// the socket is not — 700ms is generous slack on a bind that costs low
// single-digit milliseconds on any machine this targets.
setTimeout(() => {
  const { execFile } = hostRequire('node:child_process');
  const port = process.env.PORT || 4127;
  const url = 'http://127.0.0.1:' + port;
  const platform = process.platform;
  const opener = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  execFile(opener, args, () => { /* no browser to open to, e.g. a headless CI smoke test — the server still runs */ });
}, 700);
`;
}

// ---- 3. sea-config, blob, inject -------------------------------------------

function writeSeaConfig(mainPath, blobPath) {
  fs.mkdirSync(GEN, { recursive: true });
  const configPath = path.join(GEN, 'sea-config.json');
  const config = {
    main: mainPath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    // Both false on purpose: a V8 code cache / startup snapshot is tied to
    // the exact V8 build that made it, i.e. to one platform+arch+version.
    // This script builds cross-platform from a single machine (see README),
    // so the blob it produces must stay pure data, not compiled bytecode.
    useSnapshot: false,
    useCodeCache: false,
    assets: {
      'index.html': path.join(ROOT, 'web/index.html'),
      'app.js': path.join(ROOT, 'web/app.js'),
      'charts.js': path.join(ROOT, 'web/charts.js'),
      'style.css': path.join(ROOT, 'web/style.css'),
      'tokens.css': path.join(ROOT, 'web/tokens.css'),
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

async function build(targetKey) {
  console.log(`\nbuilding ${targetKey} (node v${NODE_VERSION})`);
  const t = TARGETS[targetKey];

  const nodeBinPath = await fetchNode(targetKey);
  log(`official node binary: ${nodeBinPath}`);

  fs.mkdirSync(GEN, { recursive: true });
  const mainPath = path.join(GEN, 'sea-main.js');
  fs.writeFileSync(mainPath, buildMainScript());
  log(`wrote bundle: ${mainPath}`);

  const blobPath = path.join(GEN, `sea-blob-${targetKey}.blob`);
  const configPath = writeSeaConfig(mainPath, blobPath);

  // The blob format only depends on the Node MAJOR version's SEA internals,
  // not on the target OS/arch (useSnapshot/useCodeCache are off above), so
  // it is generated with whichever node runs this script, not the one we
  // just downloaded for darwin-x64 or win32-x64. That is what makes a single
  // macOS machine able to produce all three targets without emulation.
  log('generating SEA blob');
  execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' });

  fs.mkdirSync(DIST, { recursive: true });
  const outPath = path.join(DIST, t.out);
  fs.copyFileSync(nodeBinPath, outPath);
  fs.chmodSync(outPath, 0o755);

  if (t.os === 'darwin') {
    // Postject writes into the binary's existing Mach-O load commands, which
    // is exactly what an existing code signature also covers — leaving the
    // old signature in place makes it describe bytes that no longer match,
    // and the OS refuses to run it at all rather than merely warning.
    log('removing existing signature');
    execFileSync('codesign', ['--remove-signature', outPath]);
  }

  // postject's CLI needs `commander`; its programmatic API needs only crypto, fs

  // and path — all built-ins. Running the CLI out of the bare tarball failed with

  // MODULE_NOT_FOUND on the first real CI run, because a registry tarball carries

  // a package's code and not its dependencies. Calling inject() directly needs no

  // install step at all, which is also why this stays out of package.json.

  const postjectApi = await fetchPostject();

  const { inject } = require(postjectApi);

  log('injecting the SEA blob with postject');

  await inject(outPath, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), {

    sentinelFuse: FUSE,

    machoSegmentName: t.os === 'darwin' ? 'NODE_SEA' : undefined,

  });

  if (t.os === 'darwin') {
    // Ad-hoc signature (no Apple Developer identity involved: "-" means
    // "sign, but with no identity"). Without this the binary won't launch at
    // all on Apple Silicon, which refuses to run unsigned Mach-O executables
    // — see build/README.md for what a downloader still has to click past.
    log('applying ad-hoc signature');
    execFileSync('codesign', ['--sign', '-', outPath]);
  }

  const size = fs.statSync(outPath).size;
  log(`done: ${outPath} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  return outPath;
}

async function main() {
  const arg = process.argv[2];
  const targetKey = arg && arg !== '--host' ? arg : hostTarget();
  await build(targetKey);
}

if (require.main === module) {
  main().catch((e) => {
    // A build that fails with an empty line wastes an hour. Network errors from
    // node's https carry a `code` and an empty `message`, which is exactly how
    // this one first presented: "build failed:" and nothing after the colon.
    const code = e && e.code ? ` [${e.code}]` : '';
    const msg = (e && e.message) || '(no message — see the code above)';
    console.error(`\nbuild failed${code}: ${msg}`);
    if (e && (e.code === 'EHOSTUNREACH' || e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT' || e.code === 'ECONNREFUSED')) {
      console.error('\nThis build needs to reach two hosts:');
      console.error('  https://nodejs.org        the official Node binary and its SHASUMS256.txt');
      console.error('  https://registry.npmjs.org  the postject tarball used to inject the blob');
      console.error('Both are fetched once and cached under build/.cache, so a machine that can');
      console.error('reach them once can build offline afterwards. Behind a proxy, set HTTPS_PROXY.');
    }
    if (e && e.stack && process.env.RECKON_DEBUG) console.error('\n' + e.stack);
    process.exit(1);
  });
}

module.exports = { build, TARGETS, hostTarget, NODE_VERSION };
