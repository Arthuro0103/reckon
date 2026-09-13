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

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; }
}
function writeCache(data) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(data)); } catch {}
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
  const ck = await checks.collect({ unmeasuredTargets: measured.unmeasured });

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

module.exports = { light, deep, readCache, CACHE };
