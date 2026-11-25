'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archive = require('./archive');

// ---------------------------------------------------------------------------
// The archiving loop, shared by `reckon archive --every <min>` and by
// `reckon watch --pet` (owner, 2026-11-24: while the pet is on, the archiver is
// on, at the default 15 minutes). It judges through lib/archive.js and stops
// through lib/act.js archiveIdle(); this file signals nothing itself.
//
//   - one loop on the machine at a time: ~/.cache/reckon/archive.pid, created
//     with O_EXCL, so two loops started in the same second cannot both run;
//   - a pass that comes late (the machine slept) judges nothing that time:
//     after a sleep every conversation looks old by the wall clock;
//   - stop() waits for a pass in progress, so a session already signalled
//     still gets its log line, and with it the command that resumes it.
// ---------------------------------------------------------------------------

const lockFile = (home) => path.join(home, '.cache', 'reckon', 'archive.pid');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function takeLock(home = os.homedir()) {
  const file = lockFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid)); fs.closeSync(fd);
      const release = () => { try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
      process.on('exit', release);
      return { ok: true, release };
    } catch (e) {
      if (e.code !== 'EEXIST') return { error: `Could not create ${file}: ${e.message}` };
      let old = NaN;
      try { old = Number(String(fs.readFileSync(file, 'utf8')).trim()); } catch { /* raced */ }
      if (Number.isInteger(old) && old > 1 && alive(old)) {
        return { error: `the session archiver already runs in pid ${old} (if it does not, remove ${file})`, pid: old };
      }
      try { fs.unlinkSync(file); } catch { /* raced */ }
    }
  }
  return { error: `Could not take ${file}.` };
}

// start({ act, idleS, everyMs, onResult, onSkip, home }) -> { stop(): Promise } or { error }
function start({ act, idleS = archive.DEFAULT_IDLE_S, everyMs = 5 * 60000, onResult = () => {}, onNote = () => {}, home } = {}) {
  if (!act || typeof act.archiveIdle !== 'function') return { error: 'no action engine' };
  const lock = takeLock(home);
  if (lock.error) return lock;
  let stopped = false, timer = null, pass = null, last = Date.now(), first = true;
  const once = async () => {
    const late = !first && Date.now() - last > everyMs + 60000;
    first = false;
    last = Date.now();
    if (late) { onNote(`the machine was asleep. Nothing judged this time; next pass in ${Math.round(everyMs / 60000)} min.`); return; }
    const r = await act.archiveIdle({ idleS, run: true }).catch((e) => ({ ok: false, refused: String(e && e.message || e) }));
    onResult(r);
  };
  const loop = async () => {
    if (stopped) return;
    pass = once();
    try { await pass; } catch { /* reported by once */ }
    pass = null;
    if (!stopped) timer = setTimeout(loop, everyMs);
  };
  loop();
  return {
    ok: true,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (pass) await pass.catch(() => {});
      lock.release();
    },
  };
}

module.exports = { start, takeLock, lockFile };
