'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('./platform');

// ---------------------------------------------------------------------------
// Where your code lives is not something this tool should assume.
//
// Everything here is discovered at runtime. A config file is optional and only
// exists to override the guess. Nothing about the machine that built this tool
// is baked into it — and nothing about the operating system either: the list of
// places worth looking comes from lib/platform, so a port changes the answers
// without changing a line of this file.
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const CONFIG = path.join(process.cwd(), 'reckon.config.json');

// Worktree managers park checkouts outside the main repo. These are the ones
// worth looking for; an unknown one simply won't be scanned, which is fine.
const LIKELY_WORKTREE_DIRS = [
  path.join('orca', 'workspaces'),
  path.join('.worktrees'),
  'worktrees',
];

// ---------------------------------------------------------------------------
// Where a link to a big folder tends to live. Not the same question as "where
// is the code": before recommending that a directory be deleted, the panel has
// to look for something pointing AT it, and an application folder is where that
// something usually is.
//
// Each candidate is kept only if it turns out to be a directory, so the two
// platform-specific entries cost nothing on the platform they do not belong to.
// ---------------------------------------------------------------------------
const LINK_ROOT_CANDIDATES = [
  '/Applications',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : null,
].filter(Boolean);

function readFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

const expand = (p) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

// A directory counts as a code directory if it holds at least one git
// repository, itself or one level down. A folder named "dev" full of PDFs does
// not. `.git` is tested with pathExists rather than isDirectory because in a
// worktree it is a FILE, and a worktree is still a repository.
async function holdsRepos(dir) {
  if (await platform.pathExists(path.join(dir, '.git'))) return true;
  for (const name of await platform.listDirectory(dir)) {
    if (await platform.pathExists(path.join(dir, name, '.git'))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Any vault, found by its marker directory — not by a hardcoded name.
//
// The walk is bounded twice: four levels deep, and a fixed number of
// directories visited. The depth bound is what the old `find -maxdepth 4` gave
// us; the visit budget is what replaces its timeout, because this runs inside
// the process now and a home directory with a deep synced tree in it would
// otherwise stall the first page load with nothing on screen to explain why.
// ---------------------------------------------------------------------------
const MAX_DEPTH = 4;
const VISIT_BUDGET = 20000;

async function findVaults() {
  const found = [];
  let visits = 0;

  const walk = async (dir, depth) => {
    if (depth >= MAX_DEPTH || visits >= VISIT_BUDGET) return;
    visits++;
    for (const name of await platform.listDirectory(dir)) {
      const child = path.join(dir, name);
      if (!(await platform.isDirectory(child))) continue;
      if (name === '.obsidian') { found.push(dir); continue; }
      await walk(child, depth + 1);
    }
  };

  for (const root of platform.vaultSearchRoots()) {
    if (!(await platform.isDirectory(root))) continue;
    await walk(root, 0);
    if (found.length >= 4) break;
  }
  return [...new Set(found)];
}

let cache = null;

async function load({ refresh = false } = {}) {
  if (cache && !refresh) return cache;
  const file = readFile();

  let codeDirs = (file.codeDirs || []).map(expand);
  if (!codeDirs.length) {
    for (const dir of platform.likelyCodeDirs()) {
      if (await platform.isDirectory(dir) && await holdsRepos(dir)) codeDirs.push(dir);
    }
  }

  let worktreeDirs = (file.worktreeDirs || []).map(expand);
  if (!worktreeDirs.length) {
    for (const rel of LIKELY_WORKTREE_DIRS) {
      const dir = path.join(HOME, rel);
      if (await platform.isDirectory(dir)) worktreeDirs.push(dir);
    }
  }

  let vaults = (file.vaults || []).map(expand);
  if (!vaults.length && file.vaults == null) vaults = await findVaults();

  const appRoots = [];
  for (const dir of LINK_ROOT_CANDIDATES) {
    if (await platform.isDirectory(dir)) appRoots.push(dir);
  }

  cache = {
    codeDirs, worktreeDirs, vaults,
    // The roots searched for links pointing at a delete candidate. Application
    // folders first: that is where a link to a large folder usually is.
    linkRoots: [...appRoots, ...codeDirs, ...worktreeDirs,
      path.join(HOME, '.config'), path.join(HOME, 'bin'), path.join(HOME, '.local', 'bin')],
    // Repositories quiet for longer than this are treated as parked, and their
    // node_modules become reclaimable. Not a judgement about the project.
    staleDays: Number.isFinite(file.staleDays) ? file.staleDays : 60,
    fromFile: Object.keys(file).length > 0,
    configPath: CONFIG,
  };
  return cache;
}

// Anything that can end up inside a generated delete command has to sit under a
// directory the user pointed us at. A path read from a state file must never be
// able to steer a command somewhere else.
async function isAllowed(target) {
  const c = await load();
  const roots = [...c.codeDirs, ...c.worktreeDirs].map((r) => path.resolve(r));
  const abs = path.resolve(target);
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}

module.exports = { load, isAllowed, HOME, CONFIG };
