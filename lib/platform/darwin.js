'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, sh } = require('../sh');

// ---------------------------------------------------------------------------
// macOS. Every command this tool runs against the machine lives here, and
// nowhere else: vm_stat, sysctl, ps, df, du, find, stat, readlink, tmutil,
// launchctl, networksetup, scutil, dig.
//
// THE RULE, both halves of it:
//   - A measurement never throws. When the tool is missing or the command
//     fails it returns null (or [] where the caller expects a list). null
//     means "could not find out", which is NOT the same as zero, and a caller
//     that prints "0 placeholders" for a check that never ran has silently
//     lost a guard.
//   - A command builder never returns null. It validates its arguments and
//     throws a TypeError, because a half-built command does not show a wrong
//     number on screen: `networksetup -setdnsservers null` takes the internet
//     down, and whoever pasted it can no longer search for how to fix it.
//
// See CONTRACT.md for the exact return shape of every function.
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const p = (...x) => path.join(HOME, ...x);

// Anything taking a path runs through argv, never through a shell line. Paths
// were being interpolated with JSON.stringify, which is the wrong tool: inside
// double quotes the shell still expands $(...) and `...`, so a directory named
// `$(reboot)` would have run. The shell is used below only for the two fixed
// command lines that need a glob or a pipe, neither of which touches input.
const lines = (out) => String(out || '').split('\n').filter(Boolean);
const intOr = (v, fallback = null) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };

// A command that failed because the binary is not installed is a different
// answer from a command that ran and disagreed with us. Only the first one
// means "this platform cannot tell you".
const toolMissing = (r) => !r.ok && /ENOENT|not found|No such file or directory/i.test(r.erro || '');

// ===========================================================================
// MEMORY AND PROCESSES
// ===========================================================================

// vm_stat pages -> bytes. Cheap (~5 ms): safe for the light scan.
async function memoryStats() {
  const r = await run('vm_stat', [], { timeout: 5000 });
  if (!r.ok) return null;
  const out = r.out.split('\n');
  const pageSizeBytes = intOr((out[0].match(/page size of (\d+)/) || [])[1], 4096);
  const m = {};
  for (const l of out.slice(1)) {
    const mt = l.match(/^(.+?):\s+(\d+)\.?$/);
    if (mt) m[mt[1].trim()] = parseInt(mt[2], 10);
  }
  const bytes = (k) => (m[k] || 0) * pageSizeBytes;
  return {
    pageSizeBytes,
    totalBytes: os.totalmem(),          // identical to `sysctl -n hw.memsize` here
    freeBytes: bytes('Pages free') + bytes('Pages speculative'),
    activeBytes: bytes('Pages active'),
    inactiveBytes: bytes('Pages inactive'),
    wiredBytes: bytes('Pages wired down'),
    compressedBytes: bytes('Pages occupied by compressor'),
    // Counters accumulated since boot. These are the proof that the machine
    // has been suffering, not a reading of how it is right now.
    compressions: m['Compressions'] || 0,
    decompressions: m['Decompressions'] || 0,
    swapins: m['Swapins'] || 0,
    swapouts: m['Swapouts'] || 0,
  };
}

// MB, because that is the unit vm.swapusage reports and converting twice is
// how a number ends up a thousand times too big on a chart.
async function swapStats() {
  const r = await run('sysctl', ['-n', 'vm.swapusage'], { timeout: 5000 });
  if (!r.ok) return null;
  const g = (k) => { const mt = r.out.match(new RegExp(k + '\\s*=\\s*([\\d.]+)M')); return mt ? +mt[1] : 0; };
  return { totalMB: g('total'), usedMB: g('used'), freeMB: g('free') };
}

// Group processes by what they ARE, not by PID. Fourteen processes named
// `claude` are ONE thing to the person looking at the screen. The patterns are
// macOS bundle layout, which is why this lives here and not in the collector;
// the LABELS it returns are the contract, and every platform has to produce
// the same vocabulary or the Memory tab stops grouping across a port.
function family(comm) {
  const c = String(comm).trim();
  const base = c.split('/').pop();
  if (/^claude$/.test(base) || c.endsWith('/claude')) return 'Claude Code (CLI)';
  if (c.includes('/Claude.app/') || c.includes('Claude Helper')) return 'Claude Desktop';
  if (c.includes('Virtualization.framework')) return 'Apple VM (Docker/Claude)';
  if (c.includes('com.docker') || base.startsWith('docker')) return 'Docker Desktop';
  if (c.includes('Google Chrome')) return 'Chrome';
  if (c.includes('/Opera.app/') || c.includes('Opera Helper')) return 'Opera';
  if (c.includes('Firefox')) return 'Firefox';
  if (c.includes('Safari')) return 'Safari';
  if (c.includes('/Discord.app/') || c.includes('Discord Helper')) return 'Discord';
  if (c.includes('/Slack.app/') || c.includes('Slack Helper')) return 'Slack';
  if (c.includes('/Code Helper') || c.includes('Visual Studio Code')) return 'VS Code';
  if (c.includes('Steam')) return 'Steam';
  if (c.includes('Spotify')) return 'Spotify';
  if (c.includes('Obsidian')) return 'Obsidian';
  if (base === 'node' || c.endsWith('/node')) return 'node (dev servers)';
  if (base === 'python3' || base.startsWith('python')) return 'python';
  if (base === 'ruby' || base === 'java' || base === 'go') return base;
  if (c.startsWith('/System/') || c.startsWith('/usr/libexec/') || c.startsWith('/usr/sbin/')) return 'macOS (system)';
  return base;
}

// One `ps`, once. No polling: the panel measures when you look.
// Returns EVERY process. The "under 2 MB changes nothing on screen" cut is a
// product decision and belongs to the collector, not here.
async function processList() {
  const r = await sh('ps -Axo rss,pid,%cpu,comm | tail -n +2', { timeout: 15000 });
  if (!r.ok) return [];
  const list = [];
  for (const l of r.out.split('\n')) {
    const mt = l.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!mt) continue;
    list.push({ rssKB: +mt[1], pid: +mt[2], cpuPct: +mt[3], command: mt[4], family: family(mt[4]) });
  }
  return list;
}

// The panel measuring itself. Cumulative %CPU straight from ps — the same
// number Activity Monitor shows.
async function selfProcess(pid) {
  const r = await run('ps', ['-o', '%cpu,rss,etime', '-p', String(pid)], { timeout: 5000 });
  if (!r.ok) return null;
  const l = r.out.split('\n')[1];
  if (!l) return null;
  const c = l.trim().split(/\s+/);
  return { pid: Number(pid), cpuPct: +c[0], rssKB: intOr(c[1]), elapsed: c[2] || null };
}

// ===========================================================================
// FILESYSTEM PRIMITIVES
//
// These exist for one reason: `run('test', ...)` and `ls -1` were scattered
// through the collectors, and on a platform without /bin/test every one of
// them answers "false" — the panel would report an empty machine rather than
// an unsupported one. Node's fs answers the same question everywhere.
// ===========================================================================

// Follows symlinks, like `test -e` did. false also covers "exists but I am not
// allowed to stat it", so never read false as proof of absence for a path
// under another user.
async function pathExists(target) {
  try { await fs.promises.stat(target); return true; } catch { return false; }
}

async function isDirectory(target) {
  try { return (await fs.promises.stat(target)).isDirectory(); } catch { return false; }
}

// Names only, not paths. [] when the directory is missing or unreadable.
async function listDirectory(target) {
  try { return await fs.promises.readdir(target); } catch { return []; }
}

// ===========================================================================
// SIZE, AND THE GUARDS THAT MAKE A SIZE TRUSTWORTHY
// ===========================================================================

// The data volume, not the read-only system snapshot. `df -k /` on Apple
// Silicon reports the sealed system volume, which is 7% full and tells you
// nothing; the last line is the one people mean by "my disk".
// Cheap (~30 ms): safe for the light scan.
async function volumeUsage() {
  const r = await sh('df -k / /System/Volumes/Data | tail -n +2', { timeout: 8000 });
  if (!r.ok) return null;
  const rows = lines(r.out);
  if (!rows.length) return null;
  const d = rows[rows.length - 1].trim().split(/\s+/);
  const totalKB = intOr(d[1]), usedKB = intOr(d[2]), freeKB = intOr(d[3]);
  if (totalKB == null || usedKB == null || freeKB == null) return null;
  return {
    device: d[0], mount: d[d.length - 1],
    totalKB, usedKB, freeKB,
    // A NUMBER, 0-100. df prints "64%" and a caller that forgets the parseInt
    // gets NaN through every comparison without a single error.
    usedPct: intOr(String(d[4]).replace('%', ''), 0),
  };
}

// Apparent size, `du -sk`. DEEP SCAN ONLY: minutes on a large tree.
async function dirSizeKB(target, timeout = 60000) {
  const r = await run('du', ['-sk', target], { timeout });
  if (!r.ok) return null;
  return intOr(String(r.out).trim().split(/\s+/)[0]);
}

// ---------------------------------------------------------------------------
// GUARD: size actually ON DISK (allocated blocks), not the apparent size.
// A sparse file lies about the latter: Docker.raw reports 1 TB and occupies
// 20 GB. For a directory the blocks of every file have to be summed — reading
// the folder's own inode is how a 9.57 GB bundle once measured as zero.
// DEEP SCAN ONLY.
// ---------------------------------------------------------------------------
async function realSizeKB(target, timeout = 120000) {
  if (await isDirectory(target)) {
    const r = await run('find', [target, '-type', 'f', '-exec', 'stat', '-f', '%b', '{}', '+'], { timeout });
    if (!r.ok) return null;
    let blocks = 0;
    for (const l of r.out.split('\n')) { const n = parseInt(l, 10); if (Number.isFinite(n)) blocks += n; }
    return Math.round((blocks * 512) / 1024);
  }
  const r = await run('stat', ['-f', '%b', target], { timeout });
  if (!r.ok) return null;
  const blocks = intOr(String(r.out).trim());
  return blocks == null ? null : Math.round((blocks * 512) / 1024);
}

// How many files under a path. `skip` prunes directory NAMES anywhere in the
// tree — `.git` for a vault, because tracked history is not user content.
//
// Counted here rather than piped through `wc -l`, so that find's exit status
// survives: `find /gone | wc -l` succeeds and prints 0, and a zero that means
// "the path is not there" reads on screen exactly like a zero that was
// measured. DEEP SCAN ONLY.
async function fileCount(target, { skip = [], timeout = 90000 } = {}) {
  const prune = [];
  for (const name of skip) prune.push('-not', '-path', `*/${name}/*`);
  const r = await run('find', [target, '-type', 'f', ...prune], { timeout });
  if (!r.ok) return null;
  return lines(r.out).length;
}

// ---------------------------------------------------------------------------
// GUARD: pnpm and APFS share blocks through hard links and clones. `du` counts
// the same block twice, so deleting one copy can free nothing at all. Counting
// files with nlink > 1 is the only way to know, and the screen says the check
// was made either way. DEEP SCAN ONLY, and only worth it above ~1 GB.
// ---------------------------------------------------------------------------
async function hardlinkRatio(target, timeout = 60000) {
  const total = await run('find', [target, '-type', 'f'], { timeout });
  if (!total.ok) return null;
  const linked = await run('find', [target, '-type', 'f', '-links', '+1'], { timeout });
  const files = lines(total.out).length;
  const withHardlink = linked.ok ? lines(linked.out).length : 0;
  const ratio = files > 0 ? withHardlink / files : 0;
  return { files, withHardlink, ratio, suspect: files > 0 && ratio > 0.2 };
}

// ---------------------------------------------------------------------------
// GUARD: before suggesting you delete a directory, look for a symlink pointing
// at it. `ls` and `du` follow symlinks, which makes the target and the link
// look like two independent things.
//
// Enumerates every link under `roots` ONCE so the caller can test many targets
// against one listing — the old per-target search re-walked /Applications for
// every row. `truncated` is load-bearing: when it is true, "no link points
// here" is not something this answer proves, and the caller must say so rather
// than recommend a delete.
// ---------------------------------------------------------------------------
async function findSymlinksUnder(roots, { limit = 400, maxDepth = 4, timeout = 15000 } = {}) {
  const links = [];
  const scanned = [];
  const skipped = [];
  let truncated = false;
  for (const dir of roots || []) {
    // A root that is not a directory was NOT searched, and that has to travel
    // with the result. Silently skipping every root is indistinguishable from
    // searching them all and finding nothing — and the caller turns that into
    // "no symlink points here", the strongest claim this tool makes.
    if (!(await isDirectory(dir))) { skipped.push(dir); continue; }
    const r = await run('find', [dir, '-maxdepth', String(maxDepth), '-type', 'l'], { timeout });
    // A root we could not read is not a root with no symlinks in it.
    if (!r.ok) { truncated = true; continue; }
    scanned.push(dir);
    for (const link of lines(r.out)) {
      if (links.length >= limit) { truncated = true; break; }
      const t = await run('readlink', [link], { timeout: 3000 });
      if (t.ok) links.push({ link, target: t.out.trim() });
    }
  }
  return { links, roots: scanned, skipped, truncated };
}

// Dotfiles in $HOME that `du -sh ~/*` cannot see: the shell glob does not
// expand names beginning with a dot. This is how tens of GB stay out of every
// count people make by hand. DEEP SCAN ONLY: this is the slowest call here.
async function homeTopLevelSizes({ limit = 30, timeout = 180000 } = {}) {
  const r = await sh(`du -sk -x ~/* ~/.[a-zA-Z]* 2>/dev/null | sort -rn | head -${Number(limit) || 30}`, { timeout });
  if (!r.ok) return [];
  return lines(r.out).map((l) => {
    const i = l.indexOf('\t');
    const target = l.slice(i + 1);
    return { kb: intOr(l.slice(0, i)), path: target, hidden: path.basename(target).startsWith('.') };
  }).filter((x) => x.kb != null);
}

// ---------------------------------------------------------------------------
// GUARD: inside an iCloud-backed vault `ls` lies. iCloud evicts file contents
// and leaves a placeholder behind, so a directory listing reports fewer files
// than the vault holds.
//
// null here means "could not check", and the caller MUST print that instead of
// "no placeholders" — a failed count that reads as a clean result is how the
// warning quietly disappears from a screen that still shows the vault.
// DEEP SCAN ONLY.
// ---------------------------------------------------------------------------
async function cloudPlaceholders(target, { timeout = 60000 } = {}) {
  // Not piped into `wc -l`: that pipeline succeeds and prints 0 for a path
  // that does not exist, and a failed check that reads as "no placeholders" is
  // the warning quietly leaving a screen that still shows the vault.
  const r = await run('find', [target, '-name', '*.icloud'], { timeout });
  if (!r.ok) return null;
  return { count: lines(r.out).length, kind: 'icloud', label: 'iCloud Drive' };
}

// ===========================================================================
// WHERE THINGS LIVE ON THIS PLATFORM
// ===========================================================================

// ---------------------------------------------------------------------------
// Each target carries the verdict AND what you lose if the verdict is wrong.
// 'disposable' = the machine rebuilds it on its own. 'yours' = only you can
// recreate it. 'unknown' = the tool cannot judge, so it recommends nothing.
//
// Every entry is a cache some tool created. None of them is specific to any
// particular machine or person — the paths are built from os.homedir().
// ---------------------------------------------------------------------------
const CACHE_TARGETS = [
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

// Free: a frozen table, no command runs. Nothing here is measured — the caller
// decides which of these exist and what they weigh.
// ---------------------------------------------------------------------------
// EVERYDAY TARGETS — the junk a machine accumulates whether or not anybody has
// ever opened a terminal on it.
//
// Until this list existed, reckon could only find developer leavings: package
// caches, node_modules, container logs. On a machine that has never run npm it
// opened with "you can free 0.4 GB", which is honest and useless. Measured on
// the machine this was written on — a developer's, so these are the SMALL
// numbers: 1.8 GB of Opera cache, 1.6 GB of its service workers, 923 MB of
// Chrome. On a machine that only browses, this list is the whole story.
//
// Same rule as everything else here: `disposable` only where the machine
// rebuilds it on its own. A browser cache qualifies. A phone backup does not,
// and calling it disposable to make a number bigger would be the worst thing
// this tool could do.
// ---------------------------------------------------------------------------

// One browser, and everywhere it hides things. The cache and the code cache are
// rebuilt from the network; the service worker store is rebuilt too, but it
// carries offline data for sites that work offline, which is a different loss.
const BROWSERS = [
  { id: 'chrome', label: 'Chrome', caches: ['Google/Chrome'], support: 'Google/Chrome' },
  { id: 'edge', label: 'Edge', caches: ['Microsoft Edge'], support: 'Microsoft Edge' },
  { id: 'brave', label: 'Brave', caches: ['BraveSoftware/Brave-Browser'], support: 'BraveSoftware/Brave-Browser' },
  { id: 'vivaldi', label: 'Vivaldi', caches: ['Vivaldi'], support: 'Vivaldi' },
  { id: 'arc', label: 'Arc', caches: ['company.thebrowser.Browser'], support: 'Arc' },
  { id: 'opera', label: 'Opera', caches: ['com.operasoftware.Opera'], support: 'com.operasoftware.Opera' },
  { id: 'operagx', label: 'Opera GX', caches: ['com.operasoftware.OperaGX'], support: 'com.operasoftware.OperaGX' },
  { id: 'firefox', label: 'Firefox', caches: ['Firefox'], support: 'Firefox' },
];

function browserTargets() {
  const out = [];
  for (const b of BROWSERS) {
    for (const c of b.caches) {
      out.push({
        id: `browser-cache-${b.id}`, path: p('Library', 'Caches', ...c.split('/')),
        label: `${b.label} cache`, verdict: 'disposable', everyday: true,
        lose: `Nothing you typed or saved. Pages you have visited load from the network once more instead of from disk, so the first visit to each is slower. You stay signed in.`,
        command: `rm -rf ${JSON.stringify(p('Library', 'Caches', ...c.split('/')))}`,
      });
    }
    // The service worker store is the one that surprises people: it is where
    // offline-capable sites keep their data, and on the machine this was written
    // on it had grown to 1.6 GB across 67 origins.
    out.push({
      id: `browser-sw-${b.id}`,
      path: p('Library', 'Application Support', b.support, 'Default', 'Service Worker'),
      label: `${b.label} offline site data`, verdict: 'disposable', everyday: true,
      lose: 'Sites that work offline lose what they had stored and download it again next visit. A few may sign you out. Nothing of yours that only exists there — if a site kept your work only here, it would already be losing it on its own.',
      command: `rm -rf ${JSON.stringify(p('Library', 'Application Support', b.support, 'Default', 'Service Worker'))}`,
    });
  }
  // Safari keeps its own, in a container.
  out.push({
    id: 'browser-cache-safari', path: p('Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Caches'),
    label: 'Safari cache', verdict: 'disposable', everyday: true,
    lose: 'Nothing you typed or saved. Pages load from the network once more instead of from disk.',
    command: `rm -rf ${JSON.stringify(p('Library', 'Containers', 'com.apple.Safari', 'Data', 'Library', 'Caches'))}`,
  });
  return out;
}

const EVERYDAY_TARGETS = [
  {
    id: 'ios-backups', path: p('Library', 'Application Support', 'MobileSync', 'Backup'),
    label: 'iPhone and iPad backups', verdict: 'yours', everyday: true,
    lose: 'A full backup of a phone or tablet, which is often the only copy of photos and messages from before the last iCloud sync. These are frequently the single largest folder on a Mac and almost nobody knows they are here — which is why it is listed, not because it should go.',
    command: null,
  },
  {
    id: 'mail-downloads', path: p('Library', 'Containers', 'com.apple.mail', 'Data', 'Library', 'Mail Downloads'),
    label: 'Mail attachment cache', verdict: 'disposable', everyday: true,
    lose: 'Nothing. These are copies of attachments still on the mail server; Mail fetches one again when you open it.',
    command: `rm -rf ${JSON.stringify(p('Library', 'Containers', 'com.apple.mail', 'Data', 'Library', 'Mail Downloads'))}/*`,
  },
  {
    id: 'photo-analysis', path: p('Library', 'Containers', 'com.apple.photoanalysisd'),
    label: 'Photos analysis cache', verdict: 'disposable', everyday: true,
    lose: 'No photos. Photos re-derives faces and scenes in the background, which uses power for a while.',
    command: null,
  },
  {
    id: 'quicklook', path: p('Library', 'Caches', 'com.apple.QuickLook.thumbnailcache'),
    label: 'Finder preview thumbnails', verdict: 'disposable', everyday: true,
    lose: 'Nothing. Previews are drawn again the next time you look at a folder.',
    command: 'qlmanage -r cache',
  },
  {
    id: 'crashreports', path: p('Library', 'Logs', 'DiagnosticReports'),
    label: 'Crash reports', verdict: 'disposable', everyday: true,
    lose: 'Records of apps that crashed. Useful only if you are diagnosing one right now.',
    command: `rm -rf ${JSON.stringify(p('Library', 'Logs', 'DiagnosticReports'))}/*`,
  },
];

function knownCacheTargets() {
  return [...CACHE_TARGETS, ...browserTargets(), ...EVERYDAY_TARGETS].map((t) => ({ ...t }));
}

// Docker Desktop's disk image. Sparse: it reports 1 TB and occupies 20 GB, so
// it has to be measured with realSizeKB and never with dirSizeKB.
function dockerDiskImagePath() {
  return p('Library', 'Containers', 'com.docker.docker', 'Data', 'vms', '0', 'data', 'Docker.raw');
}

// Places people on this platform actually keep repositories. A guess, checked
// at runtime by the caller — a folder named "dev" full of PDFs is not a code
// directory and must not become one.
function likelyCodeDirs() {
  return ['code', 'dev', 'src', 'Projects', 'projects', 'repos', 'git', 'work', 'www', 'Developer'].map((n) => p(n));
}

// Where a cloud-synced vault can be, most specific first. `Mobile Documents`
// is where iCloud puts every app's container, and it is the one that has to be
// searched before the plain Documents folder.
function vaultSearchRoots() {
  return [p('Library', 'Mobile Documents'), p('Documents'), HOME];
}

// ===========================================================================
// CHECKS
// ===========================================================================

// Time Machine. Cheap enough for any scan (~200 ms).
// null = no backup tool on this platform, which is NOT the same as "no backup
// configured". A caller that confuses them reports a serious finding on a
// machine that simply backs up some other way.
async function backupStatus() {
  const dest = await run('tmutil', ['destinationinfo'], { timeout: 15000 });
  if (toolMissing(dest)) return null;

  const configured = dest.ok && !/No destinations configured/i.test(dest.out + (dest.erro || ''));
  if (!configured) return { tool: 'Time Machine', configured: false, latest: null, ageDays: null };

  const latest = await run('tmutil', ['latestbackup'], { timeout: 20000 });
  const name = (latest.out || '').trim().split('/').pop() || null;
  // Backup folders are named YYYY-MM-DD-HHMMSS. Reading the date off the name
  // costs nothing and avoids a second, slower tmutil call.
  const m = name && name.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const ageDays = m ? Math.floor((Date.now() - new Date(`${m[1]}-${m[2]}-${m[3]}`).getTime()) / 86400000) : null;
  return { tool: 'Time Machine', configured: true, latest: name, ageDays };
}

// User services that exited with an error. Apple's own labels are filtered out
// here rather than in the collector: `com.apple.` only means "system noise" on
// this platform, and system noise has no fix a person can apply.
// Cheap (~100 ms).
async function failedServices({ limit = 12 } = {}) {
  const r = await sh("launchctl list 2>/dev/null | awk 'NR>1 && $2 != 0 && $2 != \"-\" {print $2\"\\t\"$3}' | head -40", { timeout: 15000 });
  if (!r.ok) return [];
  return lines(r.out)
    .map((l) => { const [code, label] = l.split('\t'); return { label: label || null, exitCode: intOr(code) }; })
    .filter((s) => s.label && !s.label.startsWith('com.apple.'))
    .slice(0, limit);
}

// ===========================================================================
// DNS
//
// A bug in the monitor shows a wrong number; a bug here leaves the machine
// WITHOUT INTERNET, and nobody connects the two. Nothing in this section runs
// a change. The two command builders return TEXT for a person to read.
// ===========================================================================

// The network services macOS can set DNS on, in the order it lists them. The
// first line of output is a header, and a leading `*` marks a disabled
// service — setting DNS on one of those changes nothing and looks like the
// panel lied.
async function dnsServices() {
  const r = await run('networksetup', ['-listallnetworkservices'], { timeout: 15000 });
  if (!r.ok) return [];
  return r.out.split('\n').slice(1).map((s) => s.trim()).filter(Boolean).filter((s) => !s.startsWith('*'));
}

// What is configured on one service. `inherited: true` means the service has
// no DNS of its own and takes whatever the router hands out over DHCP.
// null means networksetup could not be asked — the caller must drop it rather
// than treat an unreadable service as an empty one.
async function dnsForService(name) {
  const r = await run('networksetup', ['-getdnsservers', String(name)], { timeout: 12000 });
  if (!r.ok) return null;
  const out = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (out.some((l) => /aren't any DNS Servers/i.test(l))) return { service: name, ips: [], inherited: true };
  return { service: name, ips: out.filter((l) => /^[\d.:a-f]+$/i.test(l)), inherited: false };
}

// What the system is ACTUALLY querying right now, which may not be what
// networksetup reports: a VPN or mesh network can intercept first.
//
// 100.100.100.100 (and fd7a:) is Tailscale MagicDNS. If it answers first,
// changing the Wi-Fi DNS may do nothing at all — worth saying before you try,
// because otherwise the panel hands you a command that appears to fail.
async function effectiveResolver() {
  const r = await run('scutil', ['--dns'], { timeout: 12000 });
  if (!r.ok) return null;
  const ips = [];
  for (const l of r.out.split('\n')) {
    const m = l.match(/nameserver\[\d+\]\s*:\s*(\S+)/);
    if (m && !ips.includes(m[1])) ips.push(m[1]);
  }
  const mesh = ips.find((i) => i.startsWith('100.100.100.100') || i.startsWith('fd7a:')) || null;
  return {
    ips: ips.slice(0, 6),
    source: 'scutil --dns',
    intercepted: mesh != null,
    interceptedBy: mesh ? 'Tailscale (MagicDNS)' : null,
  };
}

// Ask one resolver a question and time it. `dig` gets a hard 3s ceiling, so a
// dead server costs three seconds here instead of poisoning the whole page.
//
// When `answered` is false, `ms` is how long the probe WAITED before giving
// up. It is not a latency and must never be labelled as one: a dead resolver's
// bar reads "no answer", not a millisecond figure.
async function probeResolver(ip) {
  const t0 = Date.now();
  const r = await run('dig', ['+short', '+time=3', '+tries=1', 'example.com', `@${String(ip)}`], { timeout: 6000 });
  const ms = Date.now() - t0;
  if (toolMissing(r)) return null;
  return { ip, ms, answered: r.ok && /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/m.test(r.out.trim()) };
}

const SERVICE_SAFE = /^[^"'`$\\\n\r\t;&|<>()]{1,64}$/;
const IPV6 = /^[0-9a-f:]{2,45}$/i;
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((o) => +o <= 255);

// ---------------------------------------------------------------------------
// The command that changes DNS, as TEXT. This tool never runs it.
//
// It THROWS on anything it cannot build cleanly, and that is the whole point:
// `service` arrives from a query parameter, and when it was missing the old
// builder produced `networksetup -setdnsservers null 1.1.1.1`, which does not
// show a wrong number — it sets the internet to a server called "null".
//
// An empty `ips` list is not an error: `empty` is the word networksetup
// understands for "hand this service back to DHCP", and it is how the undo for
// a machine that had no DNS set is written.
// ---------------------------------------------------------------------------
function setDnsCommand(service, ips = []) {
  const name = typeof service === 'string' ? service.trim() : '';
  if (!name || !SERVICE_SAFE.test(name)) {
    throw new TypeError(`setDnsCommand: ${JSON.stringify(service)} is not a usable network service name. ` +
      'Refusing to build a DNS command rather than emit one that points the machine at a server called "null".');
  }
  if (!Array.isArray(ips)) throw new TypeError('setDnsCommand: ips must be an array (use [] to reset to DHCP).');
  const list = ips.map((x) => String(x).trim()).filter(Boolean);
  for (const ip of list) {
    if (!isIPv4(ip) && !IPV6.test(ip)) throw new TypeError(`setDnsCommand: ${JSON.stringify(ip)} is not an IP address.`);
  }
  return {
    command: `sudo networksetup -setdnsservers "${name}" ${list.length ? list.join(' ') : 'empty'}`,
    service: name,
    ips: list,
    resetsToDhcp: list.length === 0,
  };
}

// macOS caches answers in two places and both have to be told. Without the
// second half the old answer keeps being served and the change looks like it
// did not work.
function dnsFlushCommand() {
  return 'sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder';
}

// ===========================================================================
// THE HOSTS FILE
//
// This tool never writes a line into it. These are paths and command text.
// ===========================================================================

function hostsFilePath() { return '/etc/hosts'; }

// The copy taken before the first block is ever applied. Its name has to sit
// next to the file it restores, or a person finds it months later with no idea
// what it is.
function hostsBackupPath() { return '/etc/hosts.before-reckon'; }

// ---------------------------------------------------------------------------
// The (apply, undo) pair as TEXT, markers and all.
//
// `begin`/`end` become sed addresses, so they are checked hard: a `/` in a
// marker silently ends the address and turns the delete into something else
// entirely, against /etc/hosts, with sudo. Throwing beats guessing.
// ---------------------------------------------------------------------------
function hostsCommands({ snippetPath, begin, end } = {}) {
  const marker = (v, which) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s || /[/\\'"\n\r]/.test(s)) {
      throw new TypeError(`hostsCommands: the ${which} marker ${JSON.stringify(v)} cannot be used as a sed address ` +
        '(it must be non-empty and free of slashes, quotes and newlines).');
    }
    return s;
  };
  if (typeof snippetPath !== 'string' || !snippetPath.trim()) {
    throw new TypeError('hostsCommands: snippetPath is required — it is the file this tool generated and the user appends.');
  }
  const b = marker(begin, 'begin'), e = marker(end, 'end');
  const hosts = hostsFilePath(), backup = hostsBackupPath();
  // "$HOME/..." keeps the command readable AND correct when the home directory
  // has a space in it. Unquoted ~ expansion breaks on exactly those machines.
  const snippet = snippetPath.startsWith(HOME + path.sep)
    ? `"$HOME${snippetPath.slice(HOME.length)}"`
    : q(snippetPath);

  return {
    backupPath: backup,
    backupOnce: `[ -f ${backup} ] || sudo cp ${hosts} ${backup}`,
    strip: `sudo sed -i '' '/${b}/,/${e}/d' ${hosts}`,
    append: `sudo tee -a ${hosts} < ${snippet} >/dev/null`,
    restore: `sudo cp ${backup} ${hosts}`,
  };
}

// The network capabilities live in their own file: they are the only ones that
// send a packet, and keeping them separate makes that easy to audit.
const net = require('./darwin-net');

module.exports = {
  ...net,
  // memory and processes
  memoryStats, swapStats, processList, selfProcess,
  // filesystem primitives
  pathExists, isDirectory, listDirectory,
  // size, and the guards that make a size trustworthy
  volumeUsage, dirSizeKB, realSizeKB, fileCount, hardlinkRatio,
  findSymlinksUnder, homeTopLevelSizes, cloudPlaceholders,
  // where things live
  knownCacheTargets, dockerDiskImagePath, likelyCodeDirs, vaultSearchRoots,
  // checks
  backupStatus, failedServices,
  // dns
  dnsServices, dnsForService, effectiveResolver, probeResolver,
  setDnsCommand, dnsFlushCommand,
  // hosts file
  hostsFilePath, hostsBackupPath, hostsCommands,
};
