'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Read-only views of what reckon already wrote inside ~/.cache/reckon/, for the
// Done and Watch tabs and for the Memory chart: actions.log, watch.json,
// watch.log. The one thing here that writes is `recordMemory`, which the
// watcher calls so that the Memory tab does not start empty after a restart;
// it appends inside the same folder and nowhere else.
//
// The folder is resolved when a function is CALLED, never when this file loads,
// so a test that points HOME at a temporary folder reads that folder.
// ---------------------------------------------------------------------------

const dirOf = (dir) => dir || path.join(os.homedir(), '.cache', 'reckon');

function jsonLines(file, limit) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => x && typeof x === 'object');
  } catch { return []; }
}

// ------------------------------------------------------------------ actions
// Newest first. Each row says what it did, what it measured, and whether it was
// refused. `freedKB` is only ever the number the action itself measured.
function readDone({ dir, limit = 200 } = {}) {
  const rows = jsonLines(path.join(dirOf(dir), 'actions.log'), limit).map((e) => ({
    at: e.at, action: e.action || null, id: e.id || null, title: e.title || null,
    target: typeof e.target === 'string' ? e.target : (typeof e.path === 'string' ? e.path : null),
    outcome: e.refused ? 'refused' : e.dryRun ? 'dry-run' : e.ok === false ? 'failed' : 'done',
    refused: e.refused || null, message: e.message || null,
    argv: Array.isArray(e.argv) ? e.argv : null,
    before: e.before || null, after: e.after || null,
    freedKB: Number.isFinite(e.freedKB) ? e.freedKB : null,
    gone: Number.isFinite(e.gone) ? e.gone : null,
    // Moved to the Trash (a Phase 3 disk action says so): the Done tab offers to open it.
    trashed: e.trashed === true || e.kind === 'trash' || /^trash/.test(String(e.action || '')),
  })).reverse();
  return { rows, file: path.join(dirOf(dir), 'actions.log') };
}

// "Check it": measure again ONLY what one log line was about. The browser sends
// the line's timestamp, never a path: the path comes from the log. Read-only.
async function recheck({ at, dir, home = os.homedir(), sizeOf, alive = pidAlive } = {}) {
  const e = jsonLines(path.join(dirOf(dir), 'actions.log'), 1000).find((x) => x.at === at);
  if (!e) return { ok: false, error: 'No such line in the log.' };
  const target = typeof e.target === 'string' ? e.target : (typeof e.path === 'string' ? e.path : null);
  if (target) {
    let p, h;
    try { p = fs.realpathSync(target); } catch { p = null; }
    try { h = fs.realpathSync(home); } catch { h = null; }
    if (!p) return { ok: true, kind: 'path', exists: false, note: 'The folder is not there now. It was moved or deleted.' };
    const rel = h ? path.relative(h, p) : '..';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: 'That path is outside your home folder, so it is not measured.' };
    const kb = await sizeOf(p);
    return { ok: true, kind: 'path', exists: true, kb: Number.isFinite(kb) ? kb : null, measuredAt: Date.now(), note: 'Measured again just now.' };
  }
  if (Array.isArray(e.stillAlive) && e.stillAlive.length) {
    const live = e.stillAlive.filter((pid) => alive(pid));
    return { ok: true, kind: 'pids', stillAlive: live, note: live.length ? `${live.length} of ${e.stillAlive.length} process(es) that were still running then are running now.` : 'None of the processes that were still running then are running now.' };
  }
  return { ok: true, kind: 'none', note: 'This line did not record a path or a process, so there is nothing to measure again.' };
}

// ------------------------------------------------------------------- watcher
// The same rule as native/pet.swift: a snapshot older than max(3 x interval, 90 s)
// means the watcher stopped, whatever the file says. A file that says running with
// a dead pid is a crash, and says so.
const STALE_FLOOR_MS = 90_000;
const staleAfterMs = (intervalMs) => Math.max(3 * (Number(intervalMs) || 30_000), STALE_FLOOR_MS);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function judgeWatch(snap, { now = Date.now(), alive = pidAlive } = {}) {
  if (!snap || typeof snap !== 'object') return { status: 'never', running: false, why: 'reckon watch has never written a reading on this machine.' };
  const age = now - (Number(snap.at) || 0);
  const limit = staleAfterMs(snap.intervalMs);
  if (!snap.running) return { status: 'stopped', running: false, ageMs: age, staleAfterMs: limit, why: 'reckon watch stopped cleanly.' };
  if (age > limit) return { status: 'stopped', running: false, ageMs: age, staleAfterMs: limit, why: `The last reading is ${Math.round(age / 1000)} s old, more than ${Math.round(limit / 1000)} s: the watcher seems to have stopped.` };
  if (!alive(snap.pid)) return { status: 'stopped', running: false, ageMs: age, staleAfterMs: limit, why: `The file says it is running, but pid ${snap.pid} is gone.` };
  return { status: 'running', running: true, ageMs: age, staleAfterMs: limit, why: `Last reading ${Math.round(age / 1000)} s ago, pid ${snap.pid} is alive.` };
}

const strOrNull = (s) => (typeof s === 'string' ? s : null);

function readWatch({ dir, now, alive, events = 25 } = {}) {
  let snap = null;
  try { snap = JSON.parse(fs.readFileSync(path.join(dirOf(dir), 'watch.json'), 'utf8')); } catch { /* absent or half-written */ }
  const verdict = judgeWatch(snap, { now, alive });
  const log = jsonLines(path.join(dirOf(dir), 'watch.log'), events).map((e) => ({
    type: strOrNull(e.type), kind: strOrNull(e.kind), at: Number(e.at) || null, title: strOrNull(e.title),
    cost: strOrNull(e.cost), proof: strOrNull(e.proof), lose: strOrNull(e.lose), command: strOrNull(e.command),
    level: Number.isFinite(e.level) ? e.level : null,
  })).reverse();
  return {
    ...verdict,
    snapshot: snap && {
      at: snap.at, pid: snap.pid, startedAt: snap.startedAt || null, intervalMs: snap.intervalMs || null,
      // A stopped watcher has no level worth showing.
      level: verdict.running && Number.isFinite(snap.level) ? snap.level : null,
      state: verdict.running ? strOrNull(snap.state) : null,
      active: verdict.running && Array.isArray(snap.active) ? snap.active : [],
      reading: verdict.running ? snap.reading || null : null,
      headline: verdict.running ? snap.headline || null : null,
      cost: snap.cost || null,
    },
    events: log,
    // Text for the person to run in their own terminal. The panel never starts it.
    startWith: 'node bin/reckon watch',
    startNote: 'Add --no-notify for no banners. --corner and --pet open windows, so they stay your choice.',
  };
}

// ------------------------------------------------------------ memory history
const MEM_FILE = 'memory-history.jsonl';
const MEM_MAX_LINES = 2000;
const MEM_KEEP_LINES = 1500;

// Called by the watcher once per reading. Never throws.
function recordMemory(point, { dir } = {}) {
  try {
    if (!point || !Number.isFinite(point.t) || !Number.isFinite(point.swapMB)) return false;
    const d = dirOf(dir);
    fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, MEM_FILE);
    const line = JSON.stringify({ t: point.t, swapMB: Math.round(point.swapMB), ramMB: Math.round(point.ramMB || 0) }) + '\n';
    fs.appendFileSync(f, line, { flag: 'a' });
    if (fs.statSync(f).size > MEM_MAX_LINES * 30) {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      if (lines.length > MEM_MAX_LINES) {
        const tmp = `${f}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, lines.slice(-MEM_KEEP_LINES).join('\n') + '\n');
        fs.renameSync(tmp, f);
      }
    }
    return true;
  } catch { return false; }
}

function readMemory({ dir, limit = 600 } = {}) {
  const points = jsonLines(path.join(dirOf(dir), MEM_FILE), limit)
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.swapMB))
    .map((p) => ({ t: p.t, swapMB: p.swapMB, ramMB: Number.isFinite(p.ramMB) ? p.ramMB : null }));
  return { points, from: points.length ? points[0].t : null, to: points.length ? points[points.length - 1].t : null };
}

module.exports = { readDone, recheck, readWatch, judgeWatch, staleAfterMs, pidAlive, recordMemory, readMemory, MEM_FILE };
