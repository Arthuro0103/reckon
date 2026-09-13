'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const memory = require('./memory');
const disk = require('./disk');
const docker = require('./docker');
const repos = require('./repos');
const checks = require('./checks');
const decisions = require('./decisions');
const platform = require('./platform');
const self = require('./self');

const CACHE_DIR = path.join(os.homedir(), '.cache', 'reckon');
const CACHE = path.join(CACHE_DIR, 'scan.json');
// Exactly one scan back. The panel's closing question is "did doing that
// actually free anything", and it cannot be answered from a single reading.
// One is enough: two readings make a difference, and keeping a history of them
// would be this tool starting to collect on its own.
const PREVIOUS = path.join(CACHE_DIR, 'scan-previous.json');

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}
function readPrevious() {
  try { return JSON.parse(fs.readFileSync(PREVIOUS, 'utf8')); } catch { return null; }
}
function writeCache(data) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    // The scan that was current becomes the previous one. Copy, not rename:
    // a rename that half-fails would leave the panel with no current scan at
    // all, and losing today's reading to keep yesterday's is the wrong trade.
    try { const old = fs.readFileSync(CACHE); fs.writeFileSync(PREVIOUS, old); } catch {}
    fs.writeFileSync(CACHE, JSON.stringify(data));
  } catch {}
}

// ---------------------------------------------------------------------------
// WHAT CHANGED BETWEEN TWO SCANS.
//
// The honest unit is free space on the volume, because that is the thing a
// person actually cares about and the only one measured the same way both
// times. It is NOT attributed to this panel: free space moves for reasons that
// have nothing to do with acting on a list — a download finished, a snapshot
// expired, an app updated itself. The screen states the two readings and lets
// the reader draw the line, which is the same rule every other number here
// follows.
//
// `gone` is the stronger evidence: an item that was on the list and is not any
// more is something that was acted on, with its own measured size from the
// scan that saw it.
// ---------------------------------------------------------------------------
function changed(current, previous) {
  if (!current || !previous || !previous.volume || !current.volume) return null;
  const before = (previous.panel && previous.panel.out) || [];
  const now = (current.panel && current.panel.out) || [];
  const nowIds = new Set(now.filter((d) => d.kb > 0).map((d) => d.id));
  const gone = before.filter((d) => d.kb > 0 && !nowIds.has(d.id));
  const beforeIds = new Set(before.filter((d) => d.kb > 0).map((d) => d.id));
  const appeared = now.filter((d) => d.kb > 0 && !beforeIds.has(d.id));

  return {
    at: previous.at,
    days: Math.max(0, Math.round((current.at - previous.at) / 86400000)),
    hours: Math.max(0, Math.round((current.at - previous.at) / 3600000)),
    freeBeforeKB: previous.volume.freeKB,
    freeNowKB: current.volume.freeKB,
    freedKB: current.volume.freeKB - previous.volume.freeKB,
    gone: gone.map((d) => ({ id: d.id, title: d.title, kb: d.kb })).sort((a, b) => b.kb - a.kb),
    goneKB: gone.reduce((n, d) => n + d.kb, 0),
    appeared: appeared.map((d) => ({ id: d.id, title: d.title, kb: d.kb })).sort((a, b) => b.kb - a.kb),
  };
}

// Light scan: only what is cheap. Runs whenever you open a tab.
async function light() {
  const t0 = Date.now();
  const [mem, vol] = await Promise.all([memory.collect(), disk.volume()]);
  self.markScan(Date.now() - t0);
  return { type: 'light', platform: platform.id, shell: platform.COMMAND_SHELL || null, memory: mem, volume: vol, ms: Date.now() - t0, at: Date.now() };
}

// Deep scan: sizing every folder, git in every repository, and reading inside
// the Docker VM. Only when asked.
async function deep(log = () => {}) {
  const t0 = Date.now();
  log('measuring volume and memory');
  const [mem, vol] = await Promise.all([memory.collect(), disk.volume()]);

  log('measuring large folders');
  const measured = await disk.targets();
  const targets = measured.list;

  // GUARD: only once we know WHICH paths will reach the screen do we check them
  // for links and shared blocks. Running that across the whole disk would be
  // expensive and pointless.
  //
  // The link index is built once for every root and every target is tested
  // against it. `truncated` travels with each row as `linksProven`, because
  // while it is true "no link points here" is not something this answer proves,
  // and the card has to say so rather than recommend the delete anyway.
  log('checking links and shared blocks on the targets');
  const links = await disk.symlinkIndex();
  for (const t of targets) {
    if (t.verdict !== 'disposable') continue;
    t.symlinks = disk.linksTo(links, t.path);
    // Proof requires having looked. An empty `roots` means every candidate
    // directory was missing — the normal case on a machine that keeps its code
    // outside the user profile — and "I searched nowhere" must never render as
    // "nothing points here", which is the strongest claim this tool makes.
    t.linksProven = links.roots.length > 0 && !links.truncated;
    if (t.kb > 1048576) t.hardlinks = await disk.hardlinks(t.path);
  }

  log('reading docker from inside its VM');
  const dk = await docker.collect({ deep: true });

  log('reading git in every repository');
  const rp = await repos.collect({ deep: true });

  log('running checks');
  const ck = await checks.collect({ unmeasuredTargets: measured.unmeasured, repos: rp });

  log('building decisions');
  const panel = decisions.build({ docker: dk, targets, repos: rp });

  log('mapping the top of your home folder');
  const top = await disk.homeTop();

  const ms = Date.now() - t0;
  self.markScan(ms);
  const data = { type: 'deep', platform: platform.id, shell: platform.COMMAND_SHELL || null, memory: mem, volume: vol, targets,
    unmeasured: measured.unmeasured, docker: dk, repos: rp,
    checks: ck, panel, homeTop: top, ms, at: Date.now() };
  writeCache(data);
  return data;
}

module.exports = { light, deep, readCache, readPrevious, changed, CACHE, PREVIOUS };
