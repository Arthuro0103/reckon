'use strict';
const os = require('node:os');
const path = require('node:path');
const { run, sh, duKB, realKB } = require('./sh');
const config = require('./config');

const HOME = os.homedir();
const p = (...x) => path.join(HOME, ...x);

// ---------------------------------------------------------------------------
// TARGETS. Each one carries the verdict AND what you lose if the verdict is
// wrong. 'disposable' = the machine rebuilds it on its own. 'yours' = only you
// can recreate it. 'unknown' = the tool cannot judge, so it recommends nothing.
//
// Every entry here is a cache some tool created. None of them are specific to
// any particular machine or person.
// ---------------------------------------------------------------------------
const TARGETS = [
  { id: 'npm-cacache', path: p('.npm', '_cacache'), label: 'npm cache', verdict: 'disposable',
    lose: 'Nothing permanent. The next `npm install` re-downloads what it needs — slower, once.',
    command: 'npm cache clean --force' },
  { id: 'npm-npx', path: p('.npm', '_npx'), label: 'Packages downloaded by npx', verdict: 'disposable',
    lose: 'Nothing. Every `npx something` fetches again next time you run it.',
    command: 'rm -rf ~/.npm/_npx' },
  { id: 'hf-xet', path: p('.cache', 'huggingface', 'xet'), label: 'HuggingFace download cache (xet)', verdict: 'disposable',
    lose: 'No models. This is the chunk layer that speeds up re-downloads — the models themselves live in hub/.',
    command: 'rm -rf ~/.cache/huggingface/xet' },
  { id: 'hf-hub', path: p('.cache', 'huggingface', 'hub'), label: 'Downloaded AI models (HuggingFace hub)', verdict: 'unknown',
    lose: 'The models themselves. Re-downloading costs time and bandwidth, and offline you simply will not have them.',
    command: null },
  { id: 'claude-vm', path: p('Library', 'Application Support', 'Claude', 'vm_bundles'), label: 'Claude Desktop local VM', verdict: 'disposable',
    lose: 'If you use local agent mode again, Claude Desktop downloads the whole VM once more.',
    command: 'rm -rf ~/Library/Application\\ Support/Claude/vm_bundles', sparse: true },
  { id: 'pip', path: p('Library', 'Caches', 'pip'), label: 'pip cache', verdict: 'disposable',
    lose: 'Nothing. Wheels are fetched again when needed.', command: 'pip cache purge' },
  { id: 'uv', path: p('.cache', 'uv'), label: 'uv cache (Python)', verdict: 'disposable',
    lose: 'Nothing. Re-downloaded on the next sync.', command: 'uv cache clean' },
  { id: 'brew', path: p('Library', 'Caches', 'Homebrew'), label: 'Homebrew cache', verdict: 'disposable',
    lose: 'Nothing. These are installers you already used.', command: 'brew cleanup --prune=all' },
  { id: 'playwright', path: p('Library', 'Caches', 'ms-playwright'), label: 'Playwright browsers', verdict: 'disposable',
    lose: 'Browser tests stop working until you run `npx playwright install`.', command: 'rm -rf ~/Library/Caches/ms-playwright' },
  { id: 'puppeteer', path: p('.cache', 'puppeteer'), label: 'Puppeteer Chromium', verdict: 'disposable',
    lose: 'Puppeteer scripts stop working until Chromium is downloaded again.', command: 'rm -rf ~/.cache/puppeteer' },
  { id: 'gradle', path: p('.gradle', 'caches'), label: 'Gradle cache', verdict: 'disposable',
    lose: 'Nothing. The next build downloads dependencies again.', command: 'rm -rf ~/.gradle/caches' },
  { id: 'cargo', path: p('.cargo', 'registry'), label: 'Cargo registry', verdict: 'disposable',
    lose: 'Nothing. `cargo build` fetches crates again.', command: 'rm -rf ~/.cargo/registry' },
  { id: 'go-build', path: p('Library', 'Caches', 'go-build'), label: 'Go build cache', verdict: 'disposable',
    lose: 'Nothing, beyond a slower first rebuild.', command: 'go clean -cache' },
  { id: 'xcode-derived', path: p('Library', 'Developer', 'Xcode', 'DerivedData'), label: 'Xcode DerivedData', verdict: 'disposable',
    lose: 'Indexes and build products. Xcode rebuilds them; the first build after is slow.',
    command: 'rm -rf ~/Library/Developer/Xcode/DerivedData' },
  { id: 'simulators', path: p('Library', 'Developer', 'CoreSimulator', 'Devices'), label: 'iOS simulator devices', verdict: 'unknown',
    lose: 'Simulator state: installed apps, their data, and any device you configured by hand.', command: null },
  { id: 'pnpm-store', path: p('Library', 'pnpm', 'store'), label: 'pnpm global store', verdict: 'unknown',
    lose: 'ACTIVE pnpm projects pull from here. Deleting it forces a re-download across all of them at once.', command: null },
  { id: 'trash', path: p('.Trash'), label: 'Trash', verdict: 'disposable',
    lose: 'Whatever you already moved to the trash.', command: 'rm -rf ~/.Trash/*' },
];

async function exists(target) {
  return (await run('test', ['-e', target], { timeout: 4000 })).ok;
}

// ---------------------------------------------------------------------------
// GUARD: before suggesting you delete a directory, look for a symlink pointing
// at it. `ls` and `du` follow symlinks, which makes the target and the link
// look like two independent things.
// ---------------------------------------------------------------------------
async function symlinksTo(target) {
  const c = await config.load();
  const roots = ['/Applications', ...c.codeDirs, ...c.worktreeDirs, p('.config'), p('bin'), p('.local/bin')];
  const found = [];
  for (const dir of roots) {
    if (!(await exists(dir))) continue;
    const r = await run('find', [dir, '-maxdepth', '4', '-type', 'l'], { timeout: 15000 });
    if (!r.ok) continue;
    for (const l of r.out.split('\n').filter(Boolean)) {
      const t = await run('readlink', [l], { timeout: 3000 });
      if (t.ok && t.out.trim().startsWith(target)) found.push({ link: l, points: t.out.trim() });
      if (found.length >= 5) return found;
    }
  }
  return found;
}

// pnpm and APFS share blocks through hard links and clones. `du` counts the
// same block twice, so deleting one copy can free nothing at all. Counting
// files with nlink > 1 is the only way to know.
async function hardlinks(target) {
  const total = await run('find', [target, '-type', 'f'], { timeout: 60000 });
  if (!total.ok) return null;
  const linked = await run('find', [target, '-type', 'f', '-links', '+1'], { timeout: 60000 });
  const nTotal = total.out.split('\n').filter(Boolean).length;
  const nLinked = linked.ok ? linked.out.split('\n').filter(Boolean).length : 0;
  return { files: nTotal, withHardlink: nLinked, suspect: nTotal > 0 && nLinked / nTotal > 0.2 };
}

async function volume() {
  const r = await sh('df -k / /System/Volumes/Data | tail -n +2', { timeout: 8000 });
  const lines = r.out.split('\n').filter(Boolean);
  const d = lines[lines.length - 1].trim().split(/\s+/);
  return { totalKB: +d[1], usedKB: +d[2], freeKB: +d[3], pct: d[4] };
}

async function targets() {
  const out = [];
  for (const t of TARGETS) {
    if (!(await exists(t.path))) continue;
    // A sparse file lies about its apparent size, so measure real blocks.
    const kb = t.sparse ? await realKB(t.path) : await duKB(t.path, 90000);
    if (kb == null || kb < 51200) continue;   // under 50 MB does not earn a row
    out.push({ ...t, kb });
  }
  return out.sort((a, b) => b.kb - a.kb);
}

// Dotfiles in $HOME that `du -sh ~/*` cannot see: the shell glob does not
// expand names beginning with a dot. This is how tens of GB stay out of every
// count people make by hand.
async function homeTop() {
  const r = await sh('du -sk -x ~/* ~/.[a-zA-Z]* 2>/dev/null | sort -rn | head -30', { timeout: 180000 });
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('\t');
    return { kb: parseInt(l.slice(0, i), 10), path: l.slice(i + 1), hidden: path.basename(l.slice(i + 1)).startsWith('.') };
  }).filter((x) => Number.isFinite(x.kb));
}

module.exports = { volume, targets, homeTop, symlinksTo, hardlinks, TARGETS, HOME };
