'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./sh');

// ---------------------------------------------------------------------------
// Where your code lives is not something this tool should assume.
//
// Everything here is discovered at runtime. A config file is optional and only
// exists to override the guess. Nothing about the machine that built this tool
// is baked into it.
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const CONFIG = path.join(process.cwd(), 'reckon.config.json');

// Places people actually keep repositories, in no particular order.
const LIKELY_CODE_DIRS = [
  'code', 'dev', 'src', 'Projects', 'projects', 'repos', 'git', 'work', 'www', 'Developer',
];

// Worktree managers park checkouts outside the main repo. These are the ones
// worth looking for; an unknown one simply won't be scanned, which is fine.
const LIKELY_WORKTREE_DIRS = [
  path.join('orca', 'workspaces'),
  path.join('.worktrees'),
  'worktrees',
];

function readFile() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

const expand = (p) => (p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

async function isDir(p) {
  return (await run('test', ['-d', p], { timeout: 4000 })).ok;
}

// A directory counts as a code directory if it holds at least one git
// repository one level down. A folder named "dev" full of PDFs does not.
async function holdsRepos(dir) {
  const r = await run('find', [dir, '-maxdepth', '2', '-name', '.git', '-maxdepth', '2'], { timeout: 12000 });
  return r.ok && r.out.trim().length > 0;
}

// Any Obsidian vault, found by its marker directory — not by a hardcoded name.
async function findVaults() {
  const roots = [
    path.join(HOME, 'Library/Mobile Documents'),
    path.join(HOME, 'Documents'),
    HOME,
  ];
  const found = [];
  for (const root of roots) {
    if (!(await isDir(root))) continue;
    const r = await run('find', [root, '-maxdepth', '4', '-type', 'd', '-name', '.obsidian'], { timeout: 25000 });
    if (!r.ok) continue;
    for (const line of r.out.split('\n').filter(Boolean)) found.push(path.dirname(line));
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
    for (const name of LIKELY_CODE_DIRS) {
      const dir = path.join(HOME, name);
      if (await isDir(dir) && await holdsRepos(dir)) codeDirs.push(dir);
    }
  }

  let worktreeDirs = (file.worktreeDirs || []).map(expand);
  if (!worktreeDirs.length) {
    for (const rel of LIKELY_WORKTREE_DIRS) {
      const dir = path.join(HOME, rel);
      if (await isDir(dir)) worktreeDirs.push(dir);
    }
  }

  let vaults = (file.vaults || []).map(expand);
  if (!vaults.length && file.vaults == null) vaults = await findVaults();

  cache = {
    codeDirs, worktreeDirs, vaults,
    // Repositories quiet for longer than this are treated as parked, and their
    // node_modules become reclaimable. Not a judgement about the project.
    staleDays: Number.isFinite(file.staleDays) ? file.staleDays : 60,
    fromFile: Object.keys(file).length > 0,
    configPath: CONFIG,
  };
  return cache;
}

// Anything that can end up inside a generated `rm -rf` has to sit under a
// directory the user pointed us at. A path read from a state file must never be
// able to steer a command somewhere else.
async function isAllowed(target) {
  const c = await load();
  const roots = [...c.codeDirs, ...c.worktreeDirs].map((r) => path.resolve(r));
  const abs = path.resolve(target);
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}

module.exports = { load, isAllowed, HOME, CONFIG, LIKELY_CODE_DIRS };
