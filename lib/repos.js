'use strict';
const path = require('node:path');
const { run, sh, duKB } = require('./sh');
const config = require('./config');

const git = (repo, args, timeout = 15000) => run('git', ['-C', repo, ...args], { timeout });

async function isRepo(dir) {
  const r = await git(dir, ['rev-parse', '--is-inside-work-tree'], 6000);
  return r.ok && r.out.trim() === 'true';
}

// ---------------------------------------------------------------------------
// GUARD: a worktree or branch holding commits that are not on the main branch
// is NOT disposable. Run `git rev-list --count main..HEAD` before calling any
// folder garbage.
//
// And check whether those commits were pushed: 175 commits outside the local
// main but present on a remote is a much smaller risk than 175 that exist only
// here. The screen has to tell those two apart.
// ---------------------------------------------------------------------------
async function commitsOffMain(repo) {
  let base = null;
  for (const b of ['main', 'master', 'develop', 'trunk']) {
    const r = await git(repo, ['rev-parse', '--verify', '--quiet', b], 8000);
    if (r.ok && r.out.trim()) { base = b; break; }
  }
  const branch = (await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], 8000)).out.trim();
  if (!base) return { base: null, branch, off: null, pushed: null, behind: null, remotes: [] };

  const off = await git(repo, ['rev-list', '--count', `${base}..HEAD`], 20000);
  const behind = await git(repo, ['rev-list', '--count', `HEAD..${base}`], 20000);

  // Is HEAD contained in any remote ref? If so, a copy exists off this machine.
  const contains = await git(repo, ['branch', '-r', '--contains', 'HEAD'], 20000);
  const remotes = (contains.ok ? contains.out : '').split('\n').map((s) => s.trim()).filter(Boolean);

  return {
    base, branch,
    off: parseInt(off.out, 10) || 0,
    behind: parseInt(behind.out, 10) || 0,
    pushed: remotes.length > 0,
    remotes: remotes.slice(0, 3),
  };
}

async function one(dir, name, staleDays) {
  if (!(await isRepo(dir))) {
    // With no git there is nothing to judge. That is 'unknown', never 'disposable'.
    return { name, path: dir, git: false, verdict: 'unknown',
      why: 'No git repository here: there is no way to tell whether work inside it exists only on this machine.' };
  }
  const last = await git(dir, ['log', '-1', '--format=%ct\t%cs\t%h\t%s'], 12000);
  const [ts, date, hash, subject] = (last.ok ? last.out.trim() : '').split('\t');
  const days = ts ? Math.floor((Date.now() / 1000 - +ts) / 86400) : null;

  const dirty = await git(dir, ['status', '--porcelain'], 25000);
  const dirtyCount = (dirty.ok ? dirty.out : '').split('\n').filter(Boolean).length;

  // A repo with no remote at all is a single copy. This is different from
  // "has a remote but is ahead of it" and the screen must not blur them.
  const remoteList = await git(dir, ['remote'], 8000);
  const hasRemote = (remoteList.ok ? remoteList.out : '').trim().length > 0;

  const stash = await git(dir, ['stash', 'list'], 10000);
  const stashes = (stash.ok ? stash.out : '').split('\n').filter(Boolean).length;

  const m = await commitsOffMain(dir);

  let nodeModulesKB = null;
  const nm = path.join(dir, 'node_modules');
  if ((await run('test', ['-d', nm], { timeout: 4000 })).ok) nodeModulesKB = await duKB(nm, 120000);

  const manager = await (async () => {
    for (const [file, mgr] of [['pnpm-lock.yaml', 'pnpm'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
                               ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']]) {
      if ((await run('test', ['-f', path.join(dir, file)], { timeout: 3000 })).ok) return mgr;
    }
    return null;
  })();

  return {
    name, path: dir, git: true,
    lastCommit: date || null, lastHash: hash || null, lastSubject: subject || null, days,
    dirtyCount, hasRemote, stashes,
    ...m,
    nodeModulesKB, manager,
    stale: days != null && days > staleDays,
  };
}

async function listDir(root) {
  const r = await sh(`ls -1 ${JSON.stringify(root)} 2>/dev/null`, { timeout: 10000 });
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean);
}

// ---------------------------------------------------------------------------
// GUARD: inside an iCloud-backed vault, `ls` lies. iCloud evicts file contents
// and leaves a placeholder behind, so a directory listing can report fewer
// files than the vault actually contains. `git ls-files` is the count that can
// be trusted. And .git is NEVER garbage.
// ---------------------------------------------------------------------------
async function vault(vaultPath) {
  if (!(await run('test', ['-d', vaultPath], { timeout: 5000 })).ok) return null;
  const name = path.basename(vaultPath);
  const isGit = await isRepo(vaultPath);

  const onDisk = await sh(`find ${JSON.stringify(vaultPath)} -type f -not -path '*/.git/*' 2>/dev/null | wc -l`, { timeout: 90000 });
  const placeholders = await sh(`find ${JSON.stringify(vaultPath)} -name '*.icloud' 2>/dev/null | wc -l`, { timeout: 60000 });
  const nPlaceholder = parseInt((placeholders.ok ? placeholders.out : '0').trim(), 10) || 0;

  let tracked = null, gitKB = null, m = {};
  if (isGit) {
    const t = await git(vaultPath, ['ls-files'], 45000);
    tracked = (t.ok ? t.out : '').split('\n').filter(Boolean).length;
    gitKB = await duKB(path.join(vaultPath, '.git'), 90000);
    m = await commitsOffMain(vaultPath);
  }

  return {
    path: vaultPath, name, git: isGit, tracked,
    onDisk: parseInt((onDisk.ok ? onDisk.out : '0').trim(), 10) || 0,
    placeholders: nPlaceholder, gitKB, ...m,
    warning: nPlaceholder > 0
      ? `${nPlaceholder} file(s) are iCloud placeholders: they exist in the index, the content is not here.`
      : 'No .icloud placeholders right now — but that changes on its own whenever iCloud decides to reclaim space.',
  };
}

async function worktrees(dirs) {
  const out = [];
  for (const root of dirs) {
    for (const ws of await listDir(root)) {
      const dir = path.join(root, ws);
      for (const wt of await listDir(dir)) {
        const target = path.join(dir, wt);
        if (!(await isRepo(target))) continue;
        const info = await one(target, `${ws}/${wt}`, 60);
        info.sizeKB = await duKB(target, 120000);
        info.worktree = true;
        out.push(info);
      }
    }
  }
  return out;
}

async function collect({ deep = false } = {}) {
  const c = await config.load();
  const repos = [];
  for (const root of c.codeDirs) {
    for (const n of await listDir(root)) {
      const dir = path.join(root, n);
      if (!(await run('test', ['-d', dir], { timeout: 3000 })).ok) continue;
      repos.push(await one(dir, n, c.staleDays));
    }
  }
  const vaults = [];
  for (const v of c.vaults) {
    const info = await vault(v);
    if (info) vaults.push(info);
  }
  return {
    repos: repos.sort((a, b) => (b.nodeModulesKB || 0) - (a.nodeModulesKB || 0)),
    worktrees: deep ? await worktrees(c.worktreeDirs) : [],
    vaults,
    at: Date.now(),
  };
}

module.exports = { collect, one, vault, commitsOffMain };
