'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('../sh');

// ---------------------------------------------------------------------------
// The native pet: ONE optional Swift file (native/pet.swift) that this machine compiles
// itself, the first time, and runs as a child of `reckon watch --pet`. Why it exists and why
// it is allowed to: CONTRIBUTING.md section 2 and docs/2026-09-29-watch-design.md.
//
// What this file does about it, in order:
//   1. checks the Command Line Tools are there WITHOUT asking for them: with no tools the
//      `swiftc` on the PATH is a stub that opens an install dialog, and reckon never does that
//   2. compiles native/pet.swift into ~/.cache/reckon, only when the source, the compiler, the
//      macOS or the architecture changed since the last build (a key file remembers)
//   3. starts it WITHOUT a shell and keeps its stdin open: that open pipe is how the pet knows
//      the watcher is alive. When the watcher goes, even by kill -9, the pipe closes and the pet
//      leaves
//
// It writes only inside the cache folder it is given, and it never runs anything the pet shows.
// ---------------------------------------------------------------------------

const SOURCE = path.join(__dirname, '..', '..', 'native', 'pet.swift');

// One string that changes whenever a rebuild is due. A new Xcode, a new macOS, a different
// architecture or an edited source each make an old binary untrustworthy.
function petKey({ source, swiftVersion, macos, arch }) {
  return crypto.createHash('sha256').update(JSON.stringify([source, swiftVersion, macos, arch])).digest('hex');
}

// Returns { pid, stop() } when the pet is running, or null with the reason said through `log`.
//   cacheDir  where the binary, its key and the Swift module cache live
//   log(msg)  one honest line per thing worth knowing
//   onExit    called once if the pet process ends by itself (the person chose Quit, or it crashed)
async function startPet({ cacheDir = path.join(os.homedir(), '.cache', 'reckon'), log, onExit } = {}) {
  const say = typeof log === 'function' ? log : () => {};

  const tools = await run('xcode-select', ['-p'], { timeout: 5000 });
  if (!tools.ok) {
    say('the pet needs the Xcode Command Line Tools to compile its one file, and they are not installed. reckon will not start that installation for you.');
    return null;
  }

  let source;
  try { source = fs.readFileSync(SOURCE, 'utf8'); } catch { say('native/pet.swift is not in this copy of reckon, so there is nothing to compile.'); return null; }

  const ver = await run('swiftc', ['--version'], { timeout: 15000 });
  if (!ver.ok) { say(`swiftc did not answer: ${ver.erro || 'no output'}`); return null; }
  const macos = (await run('sw_vers', ['-productVersion'], { timeout: 5000 })).out.trim();
  const key = petKey({ source, swiftVersion: ver.out.trim(), macos, arch: process.arch });

  const bin = path.join(cacheDir, 'reckon-pet');
  const keyFile = path.join(cacheDir, 'reckon-pet.key');
  let current = false;
  try { current = fs.existsSync(bin) && fs.readFileSync(keyFile, 'utf8').trim() === key; } catch { current = false; }

  if (!current) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = bin + '.tmp';
    const argv = ['-O', '-module-cache-path', path.join(cacheDir, 'swift-modules'), SOURCE, '-o', tmp];
    say(`compiling the pet, first time only (about half a minute): swiftc ${argv.join(' ')}`);
    const t0 = Date.now();
    const built = await run('swiftc', argv, { timeout: 240000 });
    if (!built.ok) { say(`the pet did not compile: ${(built.erro || 'no message').slice(0, 300)}`); return null; }
    try {
      fs.renameSync(tmp, bin);
      fs.writeFileSync(keyFile, key + '\n');
    } catch (e) { say(`the pet compiled but could not be put in place: ${e.message}`); return null; }
    say(`compiled in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  const child = spawn(bin, [], { stdio: ['pipe', 'ignore', 'pipe'] });
  if (!child.pid) { say('the pet could not be started'); return null; }
  child.stdin.on('error', () => { /* the pet is gone; its exit event says so */ });
  let lines = 0;
  child.stderr.on('data', (d) => {
    for (const l of String(d).split('\n').filter(Boolean)) if (lines++ < 20) say(`pet process: ${l.slice(0, 200)}`);
  });
  child.on('error', (e) => say(`the pet could not be started: ${e.message}`));
  child.on('exit', (code, signal) => { if (typeof onExit === 'function') onExit(code, signal); });

  return {
    pid: child.pid,
    stop() { try { child.stdin.end(); child.kill('SIGTERM'); } catch { /* already gone */ } },
  };
}

module.exports = { startPet, petKey, SOURCE };
