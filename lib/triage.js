'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./sh');

// ---------------------------------------------------------------------------
// The remembered verdict per repository (docs/2026-09-11-triage-design.md, part A).
//
// The owner says once whether a repo is `keep`, `trash` or `maybe`, and the panel
// shows it on the row from then on. It lives in ~/.cache/reckon/triage.json, apart
// from scan.json on purpose: a scan is what the machine measured, a verdict is
// what a person decided, and a new scan must never be able to erase the second.
//
// THE FINGERPRINT is the one rule that makes this safe. Every verdict stores
// { commit, dirty, hasRemote } as they were when it was given. If any of the three
// differs now, the verdict is EXPIRED and acts as if it had never been given: a
// three-month-old "trash" must not vouch for work that did not exist when it was
// said. An expired verdict is shown, with the reason, and asks again.
//
// This file only remembers and compares. It deletes, moves and archives nothing.
// The `git bundle` archive step waits for the disk actions (Phase 3).
// ---------------------------------------------------------------------------

const VERDICTS = Object.freeze(['keep', 'trash', 'maybe']);
const defaultDir = () => path.join(os.homedir(), '.cache', 'reckon');
const fileOf = (dir) => path.join(dir || defaultDir(), 'triage.json');

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// What the repo looks like right now: HEAD, how many files are dirty, and whether
// it has any remote. Three git calls, no writes. null means git could not answer,
// and a verdict that cannot be compared is treated as expired.
async function fingerprintOf(repo, { runCmd = run } = {}) {
  const git = (args) => runCmd('git', ['-C', repo, ...args], { timeout: 15000 });
  const head = await git(['rev-parse', 'HEAD']);   // no commit yet: not ok, so there is no fingerprint
  const dirty = await git(['status', '--porcelain']);
  const remote = await git(['remote']);
  if (!head.ok || !dirty.ok || !remote.ok) return null;
  return {
    commit: head.out.trim(),
    dirty: dirty.out.split('\n').filter(Boolean).length,
    hasRemote: remote.out.trim().length > 0,
  };
}

// Pure. Why a stored verdict no longer holds, or null when it still does.
function expiry(stored, now) {
  if (!stored || !stored.fingerprint) return 'This verdict has no fingerprint, so nothing says it still applies.';
  if (!now) return 'The repository could not be read just now, so the verdict cannot be compared with it.';
  const was = stored.fingerprint;
  if (was.commit !== now.commit) return 'You have committed to it (or switched branch) since.';
  if (was.dirty !== now.dirty) return `The number of uncommitted files changed (${was.dirty} then, ${now.dirty} now).`;
  if (was.hasRemote !== now.hasRemote) return now.hasRemote ? 'It has a remote now; it had none.' : 'Its remote is gone.';
  return null;
}

function readFile(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8'));
    return j && typeof j.items === 'object' && j.items ? j : { items: {} };
  } catch { return { items: {} }; }
}

function writeFile(dir, data) {
  const f = fileOf(dir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, f);
}

// The verdicts, each compared with its repo as it is now. A path that no longer
// exists is reported as gone (and dropped at the next write).
async function status({ dir, fingerprint = fingerprintOf } = {}) {
  const items = readFile(dir).items;
  const out = {};
  for (const [p, v] of Object.entries(items)) {
    if (!fs.existsSync(p)) { out[p] = { verdict: v.verdict, at: v.at, gone: true, expired: true, why: 'The folder no longer exists.' }; continue; }
    const why = expiry(v, await fingerprint(p));
    out[p] = { verdict: v.verdict, at: v.at, gone: false, expired: Boolean(why), why };
  }
  return { verdicts: out, valid: VERDICTS };
}

// Only a repository the last scan measured, inside the home folder, can be given a
// verdict: the file is a file on disk, and a path in it must never be a way to point
// anything at an arbitrary place.
async function mark(repo, verdict, { dir, home = os.homedir(), scanData, fingerprint = fingerprintOf } = {}) {
  if (!VERDICTS.includes(verdict)) return { ok: false, error: `verdict must be one of: ${VERDICTS.join(', ')}` };
  if (typeof repo !== 'string' || !path.isAbsolute(repo)) return { ok: false, error: 'an absolute repository path is required' };
  const p = real(repo), h = real(home);
  if (!p || !h) return { ok: false, error: 'path does not exist' };
  if (!inside(p, h)) return { ok: false, error: 'path is outside your home folder' };
  const known = new Map();   // real path -> the path as the scan wrote it, which is how the page looks it up
  for (const r of (scanData && scanData.repos && scanData.repos.repos) || []) if (r.git && r.path && real(r.path)) known.set(real(r.path), r.path);
  for (const r of (scanData && scanData.repos && scanData.repos.worktrees) || []) if (r.git && r.path && real(r.path)) known.set(real(r.path), r.path);
  if (!known.has(p)) return { ok: false, error: 'that repository was not measured by the last scan' };
  const fp = await fingerprint(p);
  if (!fp) return { ok: false, error: 'git could not read that repository, so there is nothing to fingerprint' };

  const data = readFile(dir);
  // Drop what no longer exists while the file is open anyway.
  for (const k of Object.keys(data.items)) if (!fs.existsSync(k)) delete data.items[k];
  data.items[known.get(p)] = { verdict, at: Date.now(), fingerprint: fp };
  data.at = Date.now();
  writeFile(dir, data);
  return { ok: true, path: known.get(p), verdict };
}

module.exports = { VERDICTS, fingerprintOf, expiry, status, mark, fileOf };
