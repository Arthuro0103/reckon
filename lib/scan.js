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
  return { type: 'light', memory: mem, volume: vol, ms: Date.now() - t0, at: Date.now() };
}

// Deep scan: du, git, and reading inside the Docker VM. Only when asked.
async function deep(log = () => {}) {
  const t0 = Date.now();
  log('measuring volume and memory');
  const [mem, vol] = await Promise.all([memory.collect(), disk.volume()]);

  log('measuring large folders (du)');
  const targets = await disk.targets();

  // GUARD: only once we know WHICH paths will reach the screen do we check them
  // for symlinks and hard links. Running that across the whole disk would be
  // expensive and pointless.
  log('checking symlinks and hard links on the targets');
  for (const t of targets) {
    if (t.verdict !== 'disposable') continue;
    t.symlinks = await disk.symlinksTo(t.path);
    if (t.kb > 1048576) t.hardlinks = await disk.hardlinks(t.path);
  }

  log('reading docker from inside its VM');
  const dk = await docker.collect({ deep: true });

  log('reading git in every repository');
  const rp = await repos.collect({ deep: true });

  log('running checks');
  const ck = await checks.collect();

  log('building decisions');
  const panel = decisions.build({ docker: dk, targets, repos: rp });

  log('mapping the top of your home folder');
  const top = await disk.homeTop();

  const ms = Date.now() - t0;
  self.markScan(ms);
  const data = { type: 'deep', memory: mem, volume: vol, targets, docker: dk, repos: rp,
    checks: ck, panel, homeTop: top, ms, at: Date.now() };
  writeCache(data);
  return data;
}

module.exports = { light, deep, readCache, CACHE };
