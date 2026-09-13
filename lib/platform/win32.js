'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../sh');

// ---------------------------------------------------------------------------
// Windows. Every command this tool runs against the machine lives here, and
// nowhere else. One binary does almost all of it — powershell.exe — because
// the CIM classes and the Dns/Net cmdlets are the only interfaces Windows
// offers for what darwin.js gets from vm_stat, ps, df, du and networksetup.
//
// THE RULE, both halves of it:
//   - A measurement never throws. When the tool is missing or the command
//     fails it returns null (or [] where the caller expects a list). null
//     means "could not find out", which is NOT the same as zero. That matters
//     more here than on macOS: PowerShell answers "0" for a great many things
//     it could not read, and a panel that prints "0 GB can be freed" because a
//     query was denied is worse than a panel that says it does not know.
//   - A command builder never returns null. It validates and throws TypeError.
//
// NOT VERIFIED ON WINDOWS HARDWARE. Every function below was written against
// the documented behaviour of the cmdlet or CIM class it calls; none of it has
// been run on a Windows machine. Where a macOS concept has no honest Windows
// equivalent the answer is null and the caller says "cannot judge" — there is
// no invented parity anywhere in this file.
//
// See CONTRACT.md for the exact return shape of every function.
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const p = (...x) => path.join(HOME, ...x);

// Windows keeps caches in three places and only the first is reliably under the
// home directory. Read the environment, fall back to the documented layout: a
// machine with a redirected profile still answers correctly, and one with no
// environment at all still gets a path instead of `undefined`.
const LOCALAPPDATA = process.env.LOCALAPPDATA || p('AppData', 'Local');
const APPDATA = process.env.APPDATA || p('AppData', 'Roaming');
const SYSTEMROOT = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
const PROGRAMDATA = process.env.ProgramData || 'C:\\ProgramData';

const intOr = (v, fallback = null) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };
// Number(null) is 0, and 0 is finite — so the old form turned "could not find
// out" into "zero" at the one place this codebase promises never to. null and
// undefined take the fallback before Number() ever sees them.
const numOr = (v, fallback = null) => {
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ===========================================================================
// RUNNING POWERSHELL
// ===========================================================================

const PS = 'powershell.exe';
// -NoProfile: a profile that prints a banner corrupts every JSON answer here,
// and a slow profile doubles the cost of the light scan.
// -NonInteractive: nothing may stop to ask a question with no terminal to ask in.
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];

// A command that failed because the binary is not installed is a different
// answer from a command that ran and disagreed with us. Only the first one
// means "this platform cannot tell you".
const toolMissing = (r) => !r.ok && /ENOENT|not recognized|cannot find/i.test(r.erro || '');

// ---------------------------------------------------------------------------
// Every script is single-quoted throughout, and paths reach it through lit().
//
// PowerShell single quotes are the only fully literal string it has: no
// variable expansion, no $(...) subexpression, no backtick escape. Double
// quotes are avoided in the script text as well, because the whole script
// travels as one argv entry and Windows' own command-line quoting is the layer
// nobody tests. The single place that needs a double quote (a DllImport
// attribute) builds one from its character code instead.
// ---------------------------------------------------------------------------
function lit(value) {
  const s = value == null ? '' : String(value);
  // A Windows filesystem cannot hold a double quote or a newline in a name, so
  // a value carrying one did not come from the filesystem. Refusing beats
  // quoting something that was never a path.
  if (!s || /["\r\n\0]/.test(s)) return null;
  return "'" + s.replace(/'/g, "''") + "'";
}

function wrap(script) {
  return [
    // Stop turns a non-terminating error into a failure the exit code carries.
    // Without it PowerShell prints the error, returns 0, and the caller reads a
    // half-built object as a measurement.
    '$ErrorActionPreference = ' + lit('Stop'),
    '$ProgressPreference = ' + lit('SilentlyContinue'),
    'try {',
    script,
    '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
  ].join('\n');
}

async function ps(script, { timeout = 20000 } = {}) {
  return run(PS, [...PS_FLAGS, wrap(script)], { timeout });
}

// Runs a script whose last statement is the value to return. Gives back the
// parsed value or null — never a partial object, because a truncated JSON body
// parsed leniently is how a missing field becomes a zero on screen.
//
// The pipe goes at the END of the script's last line, not at the start of a new
// one. Windows PowerShell 5.1 — which is the PowerShell every Windows machine
// has — rejects a line that begins with `|` outright, so writing it the other
// way round is a syntax error on the only interpreter guaranteed to be there.
async function psJson(script, opts) {
  const r = await ps(script + ' |\nConvertTo-Json -Compress -Depth 4', opts);
  if (!r.ok) return null;
  // PowerShell writes a BOM on redirected output under some code pages.
  const text = String(r.out || '').replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ---------------------------------------------------------------------------
// One directory walker, used by every size and count below.
//
// It is iterative, not recursive, and it never crosses a reparse point. Both
// are load-bearing: `Get-ChildItem -Recurse` follows junctions, and a user
// profile contains junctions that point at themselves (AppData\Local\Application
// Data is the classic one), so the obvious one-liner walks forever and then
// dies on a path-length error.
//
// It reports `rootOk` and an error count as well as the numbers, so a caller
// can tell "the tree holds nothing" from "the tree could not be read" — the
// distinction `find | wc -l` throws away.
// ---------------------------------------------------------------------------
const WALK = [
  'function Walk-Tree {',
  '  param([string]$Root, [string[]]$Skip = @())',
  '  $bytes = [long]0; $files = 0; $dirs = 0; $errors = 0; $placeholders = 0',
  '  $odd = 0',   // files whose apparent size is not their size on disk
  '  $rootOk = $true',
  '  $stack = New-Object System.Collections.Generic.Stack[string]',
  '  $stack.Push($Root)',
  '  $seen = 0',
  '  while ($stack.Count -gt 0) {',
  '    $d = $stack.Pop()',
  '    try { $items = @(Get-ChildItem -LiteralPath $d -Force -ErrorAction Stop) }',
  '    catch { if ($seen -eq 0) { $rootOk = $false }; $errors++; $seen++; continue }',
  '    $seen++; $dirs++',
  '    foreach ($i in $items) {',
  '      $a = [int]$i.Attributes',
  // 0x400 FILE_ATTRIBUTE_REPARSE_POINT: a junction or a symlink.
  '      if ($a -band 0x400) { continue }',
  '      if ($i.PSIsContainer) {',
  '        if ($Skip -notcontains $i.Name) { $stack.Push($i.FullName) }',
  '      } else {',
  '        $files++',
  '        $bytes += [long]$i.Length',
  // 0x1000 OFFLINE, 0x40000 RECALL_ON_OPEN, 0x400000 RECALL_ON_DATA_ACCESS:
  // the three attributes a cloud sync service leaves on a file whose contents
  // it has evicted from this disk.
  '        if ($a -band 0x441000) { $placeholders++ }',
  // 0x200 SPARSE_FILE, 0x800 COMPRESSED: for these two the length on screen is
  // not the space on disk, and realSizeKB refuses to answer rather than guess.
  '        if ($a -band 0xA00) { $odd++ }',
  '      }',
  '    }',
  '  }',
  '  [pscustomobject]@{ bytes = $bytes; files = $files; dirs = $dirs; errors = $errors;',
  '    placeholders = $placeholders; odd = $odd; rootOk = $rootOk }',
  '}',
].join('\n');

// ===========================================================================
// MEMORY AND PROCESSES
// ===========================================================================

// ---------------------------------------------------------------------------
// Windows does not publish the five lists vm_stat prints, so this is a mapping
// and the mapping is stated rather than hidden:
//
//   free       FreeAndZeroPageListBytes — pages holding nothing at all
//   inactive   the standby lists plus the modified list — cached, reclaimable,
//              still holding something. This is what macOS calls inactive.
//   wired      PoolNonpagedBytes — kernel memory that cannot be paged out
//   compressed the working set of the MemCompression process, which is exactly
//              what Task Manager labels "Compressed"
//   active     the residual. Windows has no "active list"; what is left after
//              the four above is what processes are holding right now.
//
// `compressions` and `decompressions` are null and will stay null: Windows
// compresses memory but publishes no counter for how often, and a zero there
// would read on screen as a machine that has never been under pressure.
// `swapins`/`swapouts` are real — the raw form of the Pages Input/Output
// counters is a cumulative page count since boot, the same thing vm_stat's
// Swapins and Swapouts are.
// ---------------------------------------------------------------------------
async function memoryStats() {
  const d = await psJson([
    '$m = Get-CimInstance -ClassName Win32_PerfRawData_PerfOS_Memory',
    '$page = 4096',
    'try { $page = [System.Environment]::SystemPageSize } catch { }',
    '$comp = 0',
    '$c = @(Get-CimInstance -ClassName Win32_Process -Filter ' + lit("Name = 'MemCompression'") + ' -ErrorAction SilentlyContinue)',
    'if ($c.Count -gt 0) { $comp = [long]$c[0].WorkingSetSize }',
    '$standby = [long]$m.StandbyCacheCoreBytes + [long]$m.StandbyCacheNormalPriorityBytes',
    '$standby += [long]$m.StandbyCacheReserveBytes + [long]$m.ModifiedPageListBytes',
    '[pscustomobject]@{',
    '  pageSizeBytes = [int]$page',
    '  freeBytes = [long]$m.FreeAndZeroPageListBytes',
    '  inactiveBytes = $standby',
    '  wiredBytes = [long]$m.PoolNonpagedBytes',
    '  compressedBytes = [long]$comp',
    '  swapins = [long]$m.PagesInputPersec',
    '  swapouts = [long]$m.PagesOutputPersec',
    '}',
  ].join('\n'), { timeout: 20000 });
  if (!d) return null;

  const totalBytes = os.totalmem();
  const freeBytes = numOr(d.freeBytes, 0);
  const inactiveBytes = numOr(d.inactiveBytes, 0);
  const wiredBytes = numOr(d.wiredBytes, 0);
  const compressedBytes = numOr(d.compressedBytes, 0);
  const rest = totalBytes - freeBytes - inactiveBytes - wiredBytes - compressedBytes;

  return {
    pageSizeBytes: intOr(d.pageSizeBytes, 4096),
    totalBytes,
    freeBytes,
    activeBytes: Math.max(0, rest),
    inactiveBytes,
    wiredBytes,
    compressedBytes,
    // No Windows counter exposes these. null, never 0.
    compressions: null,
    decompressions: null,
    swapins: numOr(d.swapins, null),
    swapouts: numOr(d.swapouts, null),
  };
}

// The page file. Win32_PageFileUsage already reports megabytes, which is the
// unit this contract wants — converting twice is how a number ends up a
// thousand times too big.
//
// An empty result is not a failure: a machine with the page file switched off
// genuinely has no swap, and the query would have failed loudly if it could not
// be asked. That is why zeros are returned here and null is not.
async function swapStats() {
  const d = await psJson([
    '$f = @(Get-CimInstance -ClassName Win32_PageFileUsage)',
    '$total = 0; $used = 0',
    'foreach ($x in $f) { $total += [int]$x.AllocatedBaseSize; $used += [int]$x.CurrentUsage }',
    '[pscustomobject]@{ totalMB = $total; usedMB = $used }',
  ].join('\n'), { timeout: 15000 });
  if (!d) return null;
  const totalMB = numOr(d.totalMB, 0);
  const usedMB = numOr(d.usedMB, 0);
  return { totalMB, usedMB, freeMB: Math.max(0, totalMB - usedMB) };
}

// Group processes by what they ARE, not by PID. The labels are the contract —
// the Memory tab groups on them — so the macOS vocabulary is reproduced here
// wherever it applies. Two entries are Windows-only and deliberately named for
// what they actually are: 'Edge', because it is on every Windows machine, and
// 'WSL VM (Docker)', because vmmem is the WSL virtual machine and calling it
// "Apple VM" to preserve a label would be a lie on screen.
function family(commandLine, exePath, name) {
  const c = String(commandLine || exePath || name || '').trim();
  const base = String(name || path.basename(exePath || '') || '').trim();
  const low = c.toLowerCase();
  const lowBase = base.toLowerCase();

  if (lowBase === 'claude.exe' && /\\anthropicclaude\\/i.test(c)) return 'Claude Desktop';
  if (/\\anthropic\\claude|\\anthropicclaude\\/i.test(low)) return 'Claude Desktop';
  // Claude Code is a node script, so the executable is node.exe and only the
  // command line says which one. That is why the command line is matched first.
  if (/\\claude\\(cli|dist)|[\\/ ]claude(\.js|\.cmd)?(\s|$)/i.test(c) && /node/i.test(lowBase)) return 'Claude Code (CLI)';
  if (lowBase === 'claude.exe' || lowBase === 'claude') return 'Claude Code (CLI)';
  if (lowBase === 'vmmem.exe' || lowBase === 'vmmem' || lowBase === 'vmmemwsl.exe' || lowBase === 'vmmemwsl') return 'WSL VM (Docker)';
  if (/com\.docker|docker desktop|dockerd|\\docker\\/i.test(low) || lowBase.startsWith('docker')) return 'Docker Desktop';
  if (/\\google\\chrome\\/i.test(low) || lowBase === 'chrome.exe') return 'Chrome';
  if (lowBase === 'msedge.exe' || /\\microsoft\\edge\\/i.test(low)) return 'Edge';
  if (lowBase === 'opera.exe' || /\\opera\\/i.test(low)) return 'Opera';
  if (lowBase === 'firefox.exe' || /\\mozilla firefox\\/i.test(low)) return 'Firefox';
  if (lowBase === 'discord.exe' || /\\discord\\/i.test(low)) return 'Discord';
  if (lowBase === 'slack.exe' || /\\slack\\/i.test(low)) return 'Slack';
  if (lowBase === 'code.exe' || /\\microsoft vs code\\/i.test(low)) return 'VS Code';
  if (/\\steam\\/i.test(low) || lowBase.startsWith('steam')) return 'Steam';
  if (lowBase === 'spotify.exe' || /\\spotify\\/i.test(low)) return 'Spotify';
  if (lowBase === 'obsidian.exe' || /\\obsidian\\/i.test(low)) return 'Obsidian';
  if (lowBase === 'node.exe' || lowBase === 'node') return 'node (dev servers)';
  if (/^python/i.test(lowBase)) return 'python';
  if (lowBase === 'ruby.exe' || lowBase === 'java.exe' || lowBase === 'go.exe') return lowBase.replace(/\.exe$/, '');
  // A process with no readable path is a protected system process. So is
  // anything living under the Windows directory. Neither has a fix a person
  // can apply, which is the whole reason they are grouped away.
  if (!exePath || String(exePath).toLowerCase().startsWith(SYSTEMROOT.toLowerCase())) return 'Windows (system)';
  return base || 'Windows (system)';
}

// One CIM query, once. No polling: the panel measures when you look.
//
// cpuPct is built the way `ps -o %cpu` builds it — CPU time divided by wall
// time since the process started — so it means the same thing it means on
// macOS, and the same thing Task Manager's per-process average means.
// WorkingSetSize is the closest Windows has to RSS and it double-counts shared
// pages the way RSS does; the caller already says so on screen.
async function processList() {
  const d = await psJson([
    '$now = Get-Date',
    '$out = foreach ($x in @(Get-CimInstance -ClassName Win32_Process)) {',
    '  $secs = 0',
    '  if ($x.CreationDate) { $secs = ($now - $x.CreationDate).TotalSeconds }',
    '  $cpu = $null',
    '  if ($secs -gt 0.5) { $cpu = [math]::Round(((([double]$x.KernelModeTime + [double]$x.UserModeTime) / 10000000.0) / $secs) * 100, 1) }',
    '  [pscustomobject]@{',
    '    pid = [int]$x.ProcessId',
    '    rssKB = [int]([long]$x.WorkingSetSize / 1024)',
    '    cpuPct = $cpu',
    '    exe = $x.ExecutablePath',
    '    name = $x.Name',
    '    line = $x.CommandLine',
    '  }',
    '}',
    '@($out)',
  ].join('\n'), { timeout: 30000 });
  if (!d) return [];
  return arr(d).map((x) => ({
    pid: intOr(x.pid, 0),
    rssKB: intOr(x.rssKB, 0),
    cpuPct: numOr(x.cpuPct, null),
    command: x.exe || x.name || '',
    family: family(x.line, x.exe, x.name),
  })).filter((x) => x.pid > 0);
}

// The panel measuring itself. cpuPct is cumulative, the same number Task
// Manager shows as the process average; elapsed is a display string in the
// format `ps -o etime` prints, so the footer reads the same on both platforms.
async function selfProcess(pid) {
  const n = intOr(pid);
  if (n == null) return null;
  const d = await psJson([
    `$x = Get-CimInstance -ClassName Win32_Process -Filter ${lit('ProcessId = ' + n)}`,
    'if (-not $x) { exit 1 }',
    '$secs = 0',
    'if ($x.CreationDate) { $secs = ((Get-Date) - $x.CreationDate).TotalSeconds }',
    '$cpu = 0',
    'if ($secs -gt 0.5) { $cpu = [math]::Round(((([double]$x.KernelModeTime + [double]$x.UserModeTime) / 10000000.0) / $secs) * 100, 2) }',
    '$t = [TimeSpan]::FromSeconds([math]::Floor($secs))',
    'if ($t.Days -gt 0) { $e = ' + lit('{0}-{1:00}:{2:00}:{3:00}') + ' -f $t.Days, $t.Hours, $t.Minutes, $t.Seconds }',
    'elseif ($t.Hours -gt 0) { $e = ' + lit('{0:00}:{1:00}:{2:00}') + ' -f $t.Hours, $t.Minutes, $t.Seconds }',
    'else { $e = ' + lit('{0:00}:{1:00}') + ' -f $t.Minutes, $t.Seconds }',
    '[pscustomobject]@{ cpuPct = $cpu; rssKB = [int]([long]$x.WorkingSetSize / 1024); elapsed = $e }',
  ].join('\n'), { timeout: 15000 });
  if (!d) return null;
  return { pid: n, cpuPct: numOr(d.cpuPct, null), rssKB: intOr(d.rssKB), elapsed: d.elapsed || null };
}

// ===========================================================================
// FILESYSTEM PRIMITIVES
//
// Node's fs answers these the same way everywhere, and that is the point: on a
// platform with no /bin/test, a collector that shells out for "does this exist"
// gets "no" for every path and the panel reports an empty machine rather than
// an unsupported one.
// ===========================================================================

async function pathExists(target) {
  try { await fs.promises.stat(target); return true; } catch { return false; }
}

async function isDirectory(target) {
  try { return (await fs.promises.stat(target)).isDirectory(); } catch { return false; }
}

async function listDirectory(target) {
  try { return await fs.promises.readdir(target); } catch { return []; }
}

// ===========================================================================
// SIZE, AND THE GUARDS THAT MAKE A SIZE TRUSTWORTHY
// ===========================================================================

// The volume holding user data. Not $env:SystemDrive: a profile redirected to
// a second disk is common on Windows, and reporting C: for a machine whose home
// directory is on D: describes somebody else's disk.
async function volumeUsage() {
  // A home directory on a UNC share has no drive letter and no local volume to
  // report, so fall back to the system drive — which is where every cache this
  // tool knows about lives anyway.
  const root = path.parse(HOME).root || '';
  const letter = /^[A-Za-z]:/.test(root) ? root.slice(0, 2) : (process.env.SystemDrive || 'C:');
  const mount = letter + '\\';
  const q = lit(`DeviceID = '${letter}'`);
  if (!q) return null;
  const d = await psJson([
    `$v = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ${q}`,
    'if (-not $v) { exit 1 }',
    '[pscustomobject]@{ device = $v.DeviceID; total = [long]$v.Size; free = [long]$v.FreeSpace }',
  ].join('\n'), { timeout: 15000 });
  if (!d) return null;
  const totalB = numOr(d.total, null);
  const freeB = numOr(d.free, null);
  if (totalB == null || freeB == null || totalB <= 0) return null;
  const totalKB = Math.round(totalB / 1024);
  const freeKB = Math.round(freeB / 1024);
  const usedKB = totalKB - freeKB;
  return {
    device: d.device || letter,
    mount,
    totalKB, usedKB, freeKB,
    // A NUMBER, 0-100. Never the string '64%'.
    usedPct: Math.round((usedKB / totalKB) * 100),
  };
}

// Apparent size, the `du -sk` number. DEEP SCAN ONLY.
//
// This is the slowest thing on Windows by a wide margin: there is no `du`, and
// walking a large tree through Get-ChildItem costs several times what du costs
// for the same tree. The timeout is generous for that reason, and a tree that
// blows through it returns null — "could not measure" — rather than the partial
// sum, which would read on screen as a measurement.
// ---------------------------------------------------------------------------
// Measure many roots in ONE PowerShell. This is a performance fix with a
// correctness consequence: a scan that measures 35 targets one at a time pays
// PowerShell's startup 70 times (once to test the path, once to walk it) and
// takes most of a minute before it has walked a single folder. Every target
// added made it worse, so the list stayed short — and a short list is why a
// Windows machine full of ordinary junk reported two gigabytes.
//
// A root that does not exist comes back absent rather than as an error: the
// caller already treats "not there" and "nothing to measure" the same way, and
// this removes the separate existence check entirely.
// ---------------------------------------------------------------------------
async function dirSizesKB(paths, { timeout = 300000 } = {}) {
  const list = (paths || []).filter((p) => typeof p === 'string' && p);
  if (!list.length) return {};
  // The paths go in as a PowerShell array literal, each one quoted by the same
  // lit() every other command here uses. A path it refuses is dropped rather
  // than interpolated raw.
  const quoted = list.map((p) => lit(p)).filter(Boolean);
  if (!quoted.length) return {};
  const d = await psJson([
    WALK,
    `$roots = @(${quoted.join(',')})`,
    '$out = @{}',
    'foreach ($r in $roots) {',
    '  if (-not (Test-Path -LiteralPath $r)) { continue }',
    '  $w = Walk-Tree -Root $r',
    '  if ($w.rootOk -ne $true) { continue }',
    '  $out[$r] = [long]$w.bytes',
    '}',
    '$out',
  ].join('\n'), { timeout });
  if (!d || typeof d !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    const n = numOr(v, null);
    if (n != null) out[k] = Math.round(n / 1024);
  }
  return out;
}

async function dirSizeKB(target, timeout = 240000) {
  const q = lit(target);
  if (!q) return null;
  const d = await psJson([WALK, `$r = Walk-Tree -Root ${q}`,
    '[pscustomobject]@{ bytes = $r.bytes; files = $r.files; rootOk = $r.rootOk }'].join('\n'), { timeout });
  if (!d || d.rootOk !== true) return null;
  const bytes = numOr(d.bytes, null);
  if (bytes == null) return null;
  return Math.round(bytes / 1024);
}

// ---------------------------------------------------------------------------
// GUARD: size actually ON DISK, not the apparent size.
//
// Windows will not give an allocated size without a native call, so this
// answers only the case it can prove. A file that is neither sparse nor
// NTFS-compressed occupies what it says it occupies, give or take a cluster,
// and that answer is honest. A file that is either one does not, and there is
// no cheap way to find out by how much — so the answer is null, the caller
// prints "could not check", and nothing is recommended on the strength of a
// number that was never measured.
//
// This is where the macOS finding does not translate, and it should not be made
// to: Docker.raw is a fixed 1 TB sparse file that occupies 20 GB, while Docker
// Desktop on WSL2 keeps a dynamically expanding VHDX whose file length already
// tracks what it holds. There is usually no trapped slack to report here, and
// inventing one would be worse than reporting nothing.
// DEEP SCAN ONLY.
// ---------------------------------------------------------------------------
async function realSizeKB(target, timeout = 240000) {
  const q = lit(target);
  if (!q) return null;
  if (await isDirectory(target)) {
    const d = await psJson([WALK, `$r = Walk-Tree -Root ${q}`,
      '[pscustomobject]@{ bytes = $r.bytes; odd = $r.odd; rootOk = $r.rootOk }'].join('\n'), { timeout });
    if (!d || d.rootOk !== true) return null;
    // One sparse or compressed file anywhere in the tree and the sum is no
    // longer the space on disk. Refuse the whole answer rather than hand back
    // a total that is wrong by an unknown amount.
    if (numOr(d.odd, 0) > 0) return null;
    const bytes = numOr(d.bytes, null);
    return bytes == null ? null : Math.round(bytes / 1024);
  }
  const d = await psJson([
    `$f = Get-Item -LiteralPath ${q} -Force`,
    '[pscustomobject]@{ bytes = [long]$f.Length; attr = [int]$f.Attributes }',
  ].join('\n'), { timeout: 15000 });
  if (!d) return null;
  const attr = intOr(d.attr, 0);
  if (attr & 0xA00) return null;            // SPARSE_FILE | COMPRESSED
  const bytes = numOr(d.bytes, null);
  return bytes == null ? null : Math.round(bytes / 1024);
}

// How many files under a path. `skip` prunes directory NAMES anywhere in the
// tree. Counted inside the walk rather than by measuring a listing, so a path
// that could not be read comes back as null instead of as a confident zero.
// DEEP SCAN ONLY.
async function fileCount(target, { skip = [], timeout = 180000 } = {}) {
  const q = lit(target);
  if (!q) return null;
  const names = [];
  for (const s of skip) { const l = lit(s); if (l) names.push(l); }
  const skipArg = names.length ? ` -Skip @(${names.join(', ')})` : '';
  const d = await psJson([WALK, `$r = Walk-Tree -Root ${q}${skipArg}`,
    '[pscustomobject]@{ files = $r.files; rootOk = $r.rootOk }'].join('\n'), { timeout });
  if (!d || d.rootOk !== true) return null;
  return intOr(d.files, null);
}

// ---------------------------------------------------------------------------
// GUARD: hard links. pnpm on Windows links from its global store into every
// project's node_modules exactly the way it does on macOS, so a walk that adds
// up file lengths counts the same blocks once per project and deleting one copy
// frees nothing.
//
// nNumberOfLinks is only reachable through GetFileInformationByHandle, so this
// is the one function here that compiles a native signature. When that is not
// allowed — constrained language mode, a locked-down machine — the answer is
// null and the screen says the check could not run. It never silently reports
// a ratio of zero, which would read as "no sharing found".
// DEEP SCAN ONLY, and only worth it above ~1 GB.
// ---------------------------------------------------------------------------
const NATIVE = [
  // The one double quote this file needs, built from its character code rather
  // than written, so the script stays free of quoting that Windows' own
  // command-line rules would have to survive.
  '$dq = [string][char]34',
  '$code = @(',
  "  '[System.Runtime.InteropServices.DllImport(' + $dq + 'kernel32.dll' + $dq + ', SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode)]',",
  "  'public static extern System.IntPtr CreateFileW(string p, uint a, uint s, System.IntPtr sa, uint d, uint f, System.IntPtr t);',",
  "  '[System.Runtime.InteropServices.DllImport(' + $dq + 'kernel32.dll' + $dq + ', SetLastError=true)]',",
  "  'public static extern bool GetFileInformationByHandle(System.IntPtr h, byte[] info);',",
  "  '[System.Runtime.InteropServices.DllImport(' + $dq + 'kernel32.dll' + $dq + ', SetLastError=true)]',",
  "  'public static extern bool CloseHandle(System.IntPtr h);',",
  "  'public static int LinkCount(string p) {',",
  // access 0 asks for metadata only, so a file another process holds open still
  // answers; share 7 is read|write|delete; 0x02000000 is BACKUP_SEMANTICS,
  // without which a directory cannot be opened at all.
  "  '  System.IntPtr h = CreateFileW(p, 0, 7, System.IntPtr.Zero, 3, 0x02000000, System.IntPtr.Zero);',",
  "  '  if (h == new System.IntPtr(-1)) { return -1; }',",
  // BY_HANDLE_FILE_INFORMATION is 52 bytes and nNumberOfLinks sits at offset 40.
  // Reading it out of a byte array avoids declaring the struct, which is the
  // part of Add-Type most likely to fail to compile on an unusual runtime.
  "  '  byte[] b = new byte[52];',",
  "  '  bool ok = GetFileInformationByHandle(h, b);',",
  "  '  CloseHandle(h);',",
  "  '  if (!ok) { return -1; }',",
  "  '  return (int)System.BitConverter.ToUInt32(b, 40);',",
  "  '}'",
  ') -join [Environment]::NewLine',
  'Add-Type -Namespace Reckon -Name Native -MemberDefinition $code',
].join('\n');

async function hardlinkRatio(target, timeout = 180000) {
  const q = lit(target);
  if (!q) return null;
  const d = await psJson([
    NATIVE,
    '$files = 0; $linked = 0; $unknown = 0; $errors = 0; $rootOk = $true; $seen = 0',
    '$stack = New-Object System.Collections.Generic.Stack[string]',
    `$stack.Push(${q})`,
    'while ($stack.Count -gt 0) {',
    '  $d = $stack.Pop()',
    '  try { $items = @(Get-ChildItem -LiteralPath $d -Force -ErrorAction Stop) }',
    '  catch { if ($seen -eq 0) { $rootOk = $false }; $errors++; $seen++; continue }',
    '  $seen++',
    '  foreach ($i in $items) {',
    '    if ([int]$i.Attributes -band 0x400) { continue }',
    '    if ($i.PSIsContainer) { $stack.Push($i.FullName); continue }',
    '    $files++',
    '    $n = [Reckon.Native]::LinkCount($i.FullName)',
    '    if ($n -lt 0) { $unknown++ } elseif ($n -gt 1) { $linked++ }',
    '  }',
    '}',
    '[pscustomobject]@{ files = $files; linked = $linked; unknown = $unknown; rootOk = $rootOk }',
  ].join('\n'), { timeout });
  if (!d || d.rootOk !== true) return null;
  const files = intOr(d.files, null);
  if (files == null) return null;
  // Files whose link count could not be read are not counted as unlinked. If
  // most of the tree refused to answer there is no ratio worth printing.
  const unknown = intOr(d.unknown, 0);
  if (files > 0 && unknown > files / 2) return null;
  const withHardlink = intOr(d.linked, 0);
  const ratio = files > 0 ? withHardlink / files : 0;
  return { files, withHardlink, ratio, suspect: files > 0 && ratio > 0.2 };
}

// ---------------------------------------------------------------------------
// GUARD: before suggesting you delete a directory, look for a link pointing at
// it. On Windows that means junctions as well as symlinks — a junction is what
// the tooling actually creates, and a listing walks straight through one as if
// the target were a second, independent copy.
//
// Enumerates every link under `roots` ONCE so the caller can test many targets
// against one listing. `truncated` is load-bearing: while it is true, "no link
// points here" is not something this answer proves.
// ---------------------------------------------------------------------------
async function findSymlinksUnder(roots, { limit = 400, maxDepth = 4, timeout = 60000 } = {}) {
  const links = [];
  const scanned = [];
  const skipped = [];
  let truncated = false;
  for (const dir of roots || []) {
    if (links.length >= limit) { truncated = true; break; }
    // A root that is not a directory was NOT searched, and that has to travel
    // with the result. Silently skipping every root is indistinguishable from
    // searching them all and finding nothing — and the caller turns that into
    // "no symlink points here", the strongest claim this tool makes.
    if (!(await isDirectory(dir))) { skipped.push(dir); continue; }
    const q = lit(dir);
    if (!q) { truncated = true; continue; }
    const d = await psJson([
      `$items = @(Get-ChildItem -LiteralPath ${q} -Force -Recurse -Depth ${intOr(maxDepth, 4)} -Attributes ReparsePoint -ErrorAction SilentlyContinue)`,
      '$out = foreach ($i in $items) {',
      // PowerShell 5.1 exposes Target (a collection), 7 exposes LinkTarget.
      // Ask for both so one file works on both.
      '  $t = $null',
      '  if ($i.PSObject.Properties.Name -contains ' + lit('LinkTarget') + ') { $t = $i.LinkTarget }',
      '  if (-not $t -and ($i.PSObject.Properties.Name -contains ' + lit('Target') + ')) { $t = @($i.Target)[0] }',
      '  if ($t) { [pscustomobject]@{ link = $i.FullName; target = [string]$t } }',
      '}',
      '@($out)',
    ].join('\n'), { timeout });
    // A root we could not read is not a root with no links in it.
    if (d == null) { truncated = true; continue; }
    scanned.push(dir);
    for (const x of arr(d)) {
      if (links.length >= limit) { truncated = true; break; }
      if (!x || !x.link || !x.target) continue;
      // A junction's target comes back in the kernel's own form. Strip the
      // prefix or every startsWith() the caller runs against a real path fails.
      links.push({ link: String(x.link), target: String(x.target).replace(/^\\\\\?\\/, '').replace(/^\\\?\?\\/, '') });
    }
  }
  return { links, roots: scanned, skipped, truncated };
}

// The top of the home directory, biggest first. Hidden entries are included and
// marked, because that is the whole point: AppData alone is routinely tens of
// gigabytes and it is invisible in a listing anybody makes by hand.
// DEEP SCAN ONLY — the slowest call here, by a lot.
async function homeTopLevelSizes({ limit = 30, timeout = 600000 } = {}) {
  const q = lit(HOME);
  if (!q) return [];
  const d = await psJson([
    WALK,
    `$top = @(Get-ChildItem -LiteralPath ${q} -Force -ErrorAction SilentlyContinue)`,
    '$out = foreach ($e in $top) {',
    '  $a = [int]$e.Attributes',
    '  if ($a -band 0x400) { continue }',
    '  $kb = 0',
    '  if ($e.PSIsContainer) { $kb = [long]((Walk-Tree -Root $e.FullName).bytes / 1024) }',
    '  else { $kb = [long]([long]$e.Length / 1024) }',
    // Hidden on Windows is an attribute, not a naming convention — but the dot
    // names put there by cross-platform tools are just as invisible to somebody
    // adding up folders in Explorer, so both count.
    '  [pscustomobject]@{ path = $e.FullName; kb = $kb; hidden = (($a -band 0x2) -ne 0) -or $e.Name.StartsWith(' + lit('.') + ') }',
    '}',
    `@($out | Sort-Object -Property kb -Descending | Select-Object -First ${intOr(limit, 30)})`,
  ].join('\n'), { timeout });
  if (!d) return [];
  return arr(d)
    .map((x) => ({ path: String(x.path || ''), kb: intOr(x.kb), hidden: x.hidden === true }))
    .filter((x) => x.path && x.kb != null);
}

// ---------------------------------------------------------------------------
// GUARD: a cloud-synced folder lies to a listing. OneDrive Files On-Demand
// leaves a placeholder with no local contents, and so does every other service
// built on the same Cloud Files API, so a count of what is on disk under-reports
// what the folder holds.
//
// `kind` is 'ondemand' rather than the name of a service on purpose: the file
// attribute proves a placeholder, it does not say who put it there, and naming
// OneDrive on a folder Dropbox is syncing would be a guess printed as a fact.
//
// null means "could not check", and the caller must print that rather than "no
// placeholders" — a failed count that reads as a clean result is how the
// warning quietly disappears from a screen that still shows the folder.
// DEEP SCAN ONLY.
// ---------------------------------------------------------------------------
async function cloudPlaceholders(target, { timeout = 180000 } = {}) {
  const q = lit(target);
  if (!q) return null;
  const d = await psJson([WALK, `$r = Walk-Tree -Root ${q}`,
    '[pscustomobject]@{ placeholders = $r.placeholders; rootOk = $r.rootOk }'].join('\n'), { timeout });
  if (!d || d.rootOk !== true) return null;
  const count = intOr(d.placeholders, null);
  if (count == null) return null;
  return { count, kind: 'ondemand', label: 'cloud sync (Files On-Demand)' };
}

// ===========================================================================
// WHERE THINGS LIVE ON THIS PLATFORM
// ===========================================================================

// ---------------------------------------------------------------------------
// Each target carries the verdict AND what you lose if the verdict is wrong.
// 'disposable' = the machine rebuilds it on its own. 'yours' = only you can
// recreate it. 'unknown' = the tool cannot judge, so it recommends nothing and
// `command` is null.
//
// Every command is PowerShell, because that is the shell a Windows user has
// open. Where the tool that made the cache knows how to clear it, its own
// command is used: it knows what is safe to keep and a recursive delete does
// not.
// ---------------------------------------------------------------------------
const la = (...x) => path.join(LOCALAPPDATA, ...x);
const ra = (...x) => path.join(APPDATA, ...x);

const CACHE_TARGETS = [
  { id: 'npm-cacache', path: la('npm-cache', '_cacache'), label: 'npm cache', verdict: 'disposable',
    lose: 'Nothing permanent. The next `npm install` re-downloads what it needs — slower, once.',
    command: 'npm cache clean --force' },
  { id: 'npm-npx', path: la('npm-cache', '_npx'), label: 'Packages downloaded by npx', verdict: 'disposable',
    lose: 'Nothing. Every `npx something` fetches again next time you run it.',
    command: 'Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\npm-cache\\_npx"' },
  { id: 'hf-xet', path: p('.cache', 'huggingface', 'xet'), label: 'HuggingFace download cache (xet)', verdict: 'disposable',
    lose: 'No models. This is the chunk layer that speeds up re-downloads — the models themselves live in hub/.',
    command: 'Remove-Item -Recurse -Force "$env:USERPROFILE\\.cache\\huggingface\\xet"' },
  { id: 'hf-hub', path: p('.cache', 'huggingface', 'hub'), label: 'Downloaded AI models (HuggingFace hub)', verdict: 'unknown',
    lose: 'The models themselves. Re-downloading costs time and bandwidth, and offline you simply will not have them.',
    command: null },
  { id: 'pip', path: la('pip', 'Cache'), label: 'pip cache', verdict: 'disposable',
    lose: 'Nothing. Wheels are fetched again when needed.', command: 'pip cache purge' },
  { id: 'uv', path: la('uv', 'cache'), label: 'uv cache (Python)', verdict: 'disposable',
    lose: 'Nothing. Re-downloaded on the next sync.', command: 'uv cache clean' },
  { id: 'playwright', path: la('ms-playwright'), label: 'Playwright browsers', verdict: 'disposable',
    lose: 'Browser tests stop working until you run `npx playwright install`.',
    command: 'Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\ms-playwright"' },
  { id: 'puppeteer', path: p('.cache', 'puppeteer'), label: 'Puppeteer Chromium', verdict: 'disposable',
    lose: 'Puppeteer scripts stop working until Chromium is downloaded again.',
    command: 'Remove-Item -Recurse -Force "$env:USERPROFILE\\.cache\\puppeteer"' },
  { id: 'gradle', path: p('.gradle', 'caches'), label: 'Gradle cache', verdict: 'disposable',
    lose: 'Nothing. The next build downloads dependencies again.',
    command: 'Remove-Item -Recurse -Force "$env:USERPROFILE\\.gradle\\caches"' },
  { id: 'cargo', path: p('.cargo', 'registry'), label: 'Cargo registry', verdict: 'disposable',
    lose: 'Nothing. `cargo build` fetches crates again.',
    command: 'Remove-Item -Recurse -Force "$env:USERPROFILE\\.cargo\\registry"' },
  { id: 'go-build', path: la('go-build'), label: 'Go build cache', verdict: 'disposable',
    lose: 'Nothing, beyond a slower first rebuild.', command: 'go clean -cache' },
  { id: 'nuget', path: p('.nuget', 'packages'), label: 'NuGet package cache', verdict: 'disposable',
    lose: 'Nothing permanent. The next `dotnet restore` downloads the packages again — offline builds stop working until it has.',
    command: 'dotnet nuget locals all --clear' },
  { id: 'yarn', path: la('Yarn', 'Cache'), label: 'Yarn cache', verdict: 'disposable',
    lose: 'Nothing. Yarn fetches the packages again on the next install.', command: 'yarn cache clean' },
  { id: 'pnpm-store', path: la('pnpm', 'store'), label: 'pnpm global store', verdict: 'unknown',
    lose: 'ACTIVE pnpm projects link into here. Deleting it forces a re-download across all of them at once.', command: null },
  { id: 'vscode-cache', path: ra('Code', 'CachedExtensionVSIXs'), label: 'VS Code downloaded extension installers', verdict: 'disposable',
    lose: 'Nothing. These are the .vsix files of extensions already installed.',
    command: 'Remove-Item -Recurse -Force "$env:APPDATA\\Code\\CachedExtensionVSIXs"' },
  { id: 'temp', path: la('Temp'), label: 'Your temporary files', verdict: 'disposable',
    lose: 'Nothing permanent. Files a running program still has open refuse to delete, and that is the right outcome — leave them.',
    command: 'Remove-Item -Recurse -Force "$env:LOCALAPPDATA\\Temp\\*" -ErrorAction SilentlyContinue' },
  { id: 'trash', path: path.join(path.parse(HOME).root || 'C:\\', '$Recycle.Bin'), label: 'Recycle Bin', verdict: 'disposable',
    lose: 'Whatever you already sent to the Recycle Bin.', command: 'Clear-RecycleBin -Force' },
];

// Free: a frozen table, no command runs. Nothing here is measured.
// ---------------------------------------------------------------------------
// EVERYDAY TARGETS on Windows — the junk a machine accumulates whether or not
// anybody has ever opened a terminal on it. On a machine that only browses,
// this list is the whole story, and without it reckon opens with a number so
// small the person closes it.
//
// UNVERIFIED ON HARDWARE. Nobody has run this on Windows. Every path below is
// taken from Microsoft's documented layout, and a path that does not exist is
// simply skipped by the caller — it cannot invent a number. What it CAN do is
// miss something, which is why nothing here claims to be exhaustive.
// ---------------------------------------------------------------------------
function everydayTargets() {
  const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const win = process.env.SystemRoot || 'C:\\Windows';
  const sysDrive = process.env.SystemDrive || 'C:';
  const j = path.join;
  const rm = (dir) => `Remove-Item -LiteralPath "${dir}" -Recurse -Force -ErrorAction SilentlyContinue`;
  const empty = (dir) => `Get-ChildItem -LiteralPath "${dir}" -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`;

  const out = [];
  const add = (t) => { out.push(t); return t; };

  // ---- browsers -----------------------------------------------------------
  // WHERE THE PROFILE ACTUALLY LIVES. Opera and Opera GX were pointed at
  // %LOCALAPPDATA%\Programs\Opera — which is where the PROGRAM is installed,
  // not where it keeps anything. The cache of somebody's main browser measured
  // zero because of it, on a machine that reported two gigabytes in total.
  // Opera keeps its profile under %APPDATA%\Opera Software\<edition> and its
  // cache under %LOCALAPPDATA%\Opera Software\<edition>; the Google-shaped
  // browsers keep both together under %LOCALAPPDATA%\<vendor>\User Data.
  const CHROMIUM = [
    { id: 'chrome', label: 'Chrome', cacheRoot: j(local, 'Google', 'Chrome', 'User Data') },
    { id: 'edge', label: 'Edge', cacheRoot: j(local, 'Microsoft', 'Edge', 'User Data') },
    { id: 'brave', label: 'Brave', cacheRoot: j(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
    { id: 'vivaldi', label: 'Vivaldi', cacheRoot: j(local, 'Vivaldi', 'User Data') },
    { id: 'opera', label: 'Opera', cacheRoot: j(local, 'Opera Software', 'Opera Stable') },
    { id: 'operagx', label: 'Opera GX', cacheRoot: j(local, 'Opera Software', 'Opera GX Stable') },
    { id: 'operaair', label: 'Opera Air', cacheRoot: j(local, 'Opera Software', 'Opera Air Stable') },
  ];
  const LOSE_CACHE = 'Nothing you typed or saved. Pages you have visited load from the network once more instead of from disk, so the first visit to each is slower. You stay signed in.';
  // One row per browser, not one per cache folder per profile. The folders are
  // still measured and still named inside the row; what collapses is the list.
  const browserGroup = (b) => ({
    group: `browser-${b.id}`, groupLabel: `${b.label} caches`,
    groupLose: `${LOSE_CACHE} This covers every cache folder ${b.label} keeps — pages, compiled scripts, graphics, shaders and offline site data — across every profile it has here.`,
  });

  for (const b of CHROMIUM) {
    // Opera puts the cache directly under its edition folder; the Google-shaped
    // ones put it under a profile folder inside User Data.
    const isOpera = /^opera/.test(b.id);
    const profiles = isOpera ? [''] : ['Default', 'Profile 1', 'Profile 2'];
    for (const prof of profiles) {
      const base = prof ? j(b.cacheRoot, prof) : b.cacheRoot;
      const suffix = prof && prof !== 'Default' ? `-${prof.toLowerCase().replace(/\s+/g, '')}` : '';
      const who = prof && prof !== 'Default' ? `${b.label} (${prof})` : b.label;

      add({ ...browserGroup(b), id: `browser-cache-${b.id}${suffix}`, path: j(base, 'Cache'),
        label: `${who} cache`, verdict: 'disposable', everyday: true,
        lose: LOSE_CACHE, command: rm(j(base, 'Cache')) });

      // Compiled JavaScript, kept separately from the page cache and routinely
      // as large as it. Leaving it out under-reported every browser by roughly
      // half.
      add({ ...browserGroup(b), id: `browser-code-${b.id}${suffix}`, path: j(base, 'Code Cache'),
        label: `${who} compiled-script cache`, verdict: 'disposable', everyday: true,
        lose: 'Nothing. The browser compiles each site\'s scripts again the first time you open it, which costs a moment once.',
        command: rm(j(base, 'Code Cache')) });

      if (!suffix) {
        add({ ...browserGroup(b), id: `browser-gpu-${b.id}`, path: j(base, 'GPUCache'),
          label: `${who} graphics cache`, verdict: 'disposable', everyday: true,
          lose: 'Nothing. Rebuilt on demand.', command: rm(j(base, 'GPUCache')) });
        add({ ...browserGroup(b), id: `browser-sw-${b.id}`, path: j(base, 'Service Worker'),
          label: `${who} offline site data`, verdict: 'disposable', everyday: true,
          lose: 'Sites that work offline lose what they had stored and download it again next visit. A few may sign you out.',
          command: rm(j(base, 'Service Worker')) });
      }
    }
    // Shader caches sit beside the profiles, shared by all of them.
    for (const shader of ['GrShaderCache', 'ShaderCache']) {
      add({ ...browserGroup(b), id: `browser-shader-${b.id}-${shader.toLowerCase()}`, path: j(b.cacheRoot, shader),
        label: `${b.label} shader cache`, verdict: 'disposable', everyday: true,
        lose: 'Nothing. The graphics driver compiles these again as pages use them.',
        command: rm(j(b.cacheRoot, shader)) });
    }
  }

  add({ id: 'firefox-cache', path: j(local, 'Mozilla', 'Firefox', 'Profiles'),
    label: 'Firefox cache', verdict: 'disposable', everyday: true,
    lose: 'Nothing you typed or saved. Pages load from the network once more.',
    command: null });

  // ---- Windows itself -----------------------------------------------------
  add({
    // Usually the single biggest thing on a machine that was upgraded in
    // place, and Windows deletes it on its own after about ten days — which
    // is exactly why somebody who looks today may still find it.
    id: 'windows-old', path: j(sysDrive + '\\', 'Windows.old'),
    label: 'Previous Windows installation', verdict: 'disposable', everyday: true,
    lose: 'The ability to roll back to the Windows version you upgraded from. Windows removes this on its own about ten days after an upgrade; if it is still here, that window is probably still open.',
    command: 'Use Settings > System > Storage > Temporary files, and tick "Previous Windows installation(s)". Deleting it by hand leaves pieces behind.',
  });
  add({ id: 'windows-temp', path: j(local, 'Temp'),
    label: 'Temporary files', verdict: 'disposable', everyday: true,
    lose: 'Nothing, as long as no installer is running right now. Files in use are skipped.',
    command: empty(j(local, 'Temp')) });
  add({ id: 'windows-temp-system', path: j(win, 'Temp'),
    label: 'System temporary files', verdict: 'disposable', everyday: true,
    lose: 'Nothing. Installers and Windows itself write scratch files here and never come back for them.',
    command: `# needs an administrator PowerShell\n${empty(j(win, 'Temp'))}` });
  add({ id: 'delivery-optimization', path: j(win, 'SoftwareDistribution', 'Download'),
    label: 'Windows Update download cache', verdict: 'disposable', everyday: true,
    lose: 'Nothing. Updates already installed keep their installers here; Windows fetches one again if it ever needs to.',
    command: 'Use Settings > System > Storage > Temporary files, and tick "Windows Update Cleanup".' });
  add({
    // Separate from the update cache above: this is the peer-to-peer copy
    // Windows keeps so it can hand updates to other machines on the network.
    id: 'delivery-optimization-p2p',
    path: j(win, 'ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization'),
    label: 'Update sharing cache', verdict: 'disposable', everyday: true,
    lose: 'Nothing of yours. This is the copy Windows keeps so it can pass updates to other PCs on your network.',
    command: 'Use Settings > System > Storage > Temporary files, and tick "Delivery Optimization Files".' });
  add({ id: 'recycle-bin', path: j(sysDrive + '\\', '$Recycle.Bin'),
    label: 'Recycle Bin', verdict: 'disposable', everyday: true,
    lose: 'Whatever you already put in it.', command: 'Clear-RecycleBin -Force' });
  add({ id: 'thumbnail-cache', path: j(local, 'Microsoft', 'Windows', 'Explorer'),
    label: 'Explorer thumbnail cache', verdict: 'disposable', everyday: true,
    lose: 'Nothing. Thumbnails are drawn again the next time you open a folder.',
    command: null });
  add({
    // Installers that install themselves so they can uninstall later. Visual
    // Studio, .NET and the Office tooling each leave hundreds of megabytes.
    id: 'package-cache', path: j(programData, 'Package Cache'),
    label: 'Installer cache', verdict: 'yours', everyday: true,
    lose: 'The ability of some programs to repair or uninstall themselves without the original download. It is listed because it is often gigabytes and nobody knows it is there — not because it should go.',
    command: null });

  // ---- crashes ------------------------------------------------------------
  // A full memory dump is the size of the machine's RAM. On 16 GB it is a
  // 16 GB file, written once and never read by anybody.
  add({ group: 'crashreports', groupLabel: 'Crash reports and dumps', groupLose: 'The record of crashes that already happened. If this machine has been crashing, read them BEFORE deleting: each one names what did it.', id: 'crashreports', path: j(local, 'CrashDumps'),
    label: 'Crash dumps', verdict: 'disposable', everyday: true,
    lose: 'The evidence of crashes that already happened. Nothing a person reads.',
    command: empty(j(local, 'CrashDumps')) });
  add({ group: 'crashreports', groupLabel: 'Crash reports and dumps', groupLose: 'The record of crashes that already happened. If this machine has been crashing, read them BEFORE deleting: each one names what did it.', id: 'crashreports-wer', path: j(local, 'Microsoft', 'Windows', 'WER'),
    label: 'Error reports', verdict: 'disposable', everyday: true,
    lose: 'Reports about crashes that already happened, queued for a service that mostly never asks for them.',
    command: empty(j(local, 'Microsoft', 'Windows', 'WER')) });
  add({ id: 'crashreports-minidump', path: j(win, 'Minidump'),
    label: 'Blue-screen dumps', verdict: 'disposable', everyday: true,
    lose: 'The record of past blue screens. Worth reading FIRST if this machine has been crashing — each file names the driver that did it.',
    command: `# needs an administrator PowerShell\n${empty(j(win, 'Minidump'))}` });

  // ---- games --------------------------------------------------------------
  // On a machine with Steam and Epic on the taskbar this is usually where the
  // gigabytes actually are, and none of it was being looked at.
  const steam = j(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam');
  add({ group: 'steam', groupLabel: 'Steam leftovers', groupLose: 'No installed game, no save and no setting. Half-finished downloads restart, compiled shaders are rebuilt on first launch, and store artwork is fetched again.', id: 'steam-downloading', path: j(steam, 'steamapps', 'downloading'),
    label: 'Steam half-finished downloads', verdict: 'disposable', everyday: true,
    lose: 'The progress of any download still in flight — Steam starts those parts again. Finished games are not here.',
    command: rm(j(steam, 'steamapps', 'downloading')) });
  add({ group: 'steam', groupLabel: 'Steam leftovers', groupLose: 'No installed game, no save and no setting. Half-finished downloads restart, compiled shaders are rebuilt on first launch, and store artwork is fetched again.', id: 'steam-shadercache', path: j(steam, 'steamapps', 'shadercache'),
    label: 'Steam shader cache', verdict: 'disposable', everyday: true,
    lose: 'Nothing permanent. Games compile shaders again on first launch, so one session stutters more than usual.',
    command: rm(j(steam, 'steamapps', 'shadercache')) });
  add({ group: 'steam', groupLabel: 'Steam leftovers', groupLose: 'No installed game, no save and no setting. Half-finished downloads restart, compiled shaders are rebuilt on first launch, and store artwork is fetched again.', id: 'steam-httpcache', path: j(steam, 'appcache', 'httpcache'),
    label: 'Steam interface cache', verdict: 'disposable', everyday: true,
    lose: 'Nothing. Store pages and artwork are fetched again.',
    command: rm(j(steam, 'appcache', 'httpcache')) });
  add({ group: 'epic', groupLabel: 'Epic Games launcher leftovers', groupLose: 'Nothing. The launcher is a web page and these are its cache and its logs. No game is touched.', id: 'epic-webcache', path: j(local, 'EpicGamesLauncher', 'Saved', 'webcache'),
    label: 'Epic Games launcher cache', verdict: 'disposable', everyday: true,
    lose: 'Nothing. The launcher is a web page; this is its browser cache.',
    command: rm(j(local, 'EpicGamesLauncher', 'Saved', 'webcache')) });
  add({ group: 'epic', groupLabel: 'Epic Games launcher leftovers', groupLose: 'Nothing. The launcher is a web page and these are its cache and its logs. No game is touched.', id: 'epic-logs', path: j(local, 'EpicGamesLauncher', 'Saved', 'Logs'),
    label: 'Epic Games logs', verdict: 'disposable', everyday: true,
    lose: 'Nothing. Launcher logs.', command: rm(j(local, 'EpicGamesLauncher', 'Saved', 'Logs')) });
  add({ id: 'shader-d3d', path: j(local, 'D3DSCache'),
    label: 'DirectX shader cache', verdict: 'disposable', everyday: true,
    lose: 'Nothing permanent. Shaders are compiled again the next time a game or app needs them.',
    command: rm(j(local, 'D3DSCache')) });
  for (const v of [['NVIDIA', 'DXCache'], ['NVIDIA', 'GLCache'], ['AMD', 'DxCache'], ['AMD', 'DxcCache']]) {
    add({ group: 'shader-driver', groupLabel: 'Graphics driver shader caches',
      groupLose: 'Nothing permanent. The driver compiles these again on demand, so the first launch of a game after this is slower than usual and then it is back to normal.',
      id: `shader-${v[0].toLowerCase()}-${v[1].toLowerCase()}`, path: j(local, ...v),
      label: `${v[0]} shader cache`, verdict: 'disposable', everyday: true,
      lose: 'Nothing permanent. The driver compiles these again on demand.',
      command: rm(j(local, ...v)) });
  }
  add({ id: 'minecraft-logs', path: j(roaming, '.minecraft', 'logs'),
    label: 'Minecraft logs', verdict: 'disposable', everyday: true,
    lose: 'Nothing. Worlds, mods and settings are elsewhere and are not touched.',
    command: rm(j(roaming, '.minecraft', 'logs')) });
  add({ id: 'lunarclient-offline', path: j(HOME, '.lunarclient', 'offline'),
    label: 'Lunar Client old versions', verdict: 'disposable', everyday: true,
    lose: 'Nothing you play with now. Lunar downloads a version again if you pick it.',
    command: rm(j(HOME, '.lunarclient', 'offline')) });

  // ---- everyday apps ------------------------------------------------------
  for (const app of [
    { id: 'discord', label: 'Discord', dirs: [j(roaming, 'discord', 'Cache'), j(roaming, 'discord', 'Code Cache'), j(roaming, 'discord', 'GPUCache')] },
    { id: 'spotify', label: 'Spotify', dirs: [j(local, 'Spotify', 'Storage'), j(local, 'Spotify', 'Data')] },
    { id: 'teams', label: 'Teams', dirs: [j(roaming, 'Microsoft', 'Teams', 'Cache')] },
    { id: 'slack', label: 'Slack', dirs: [j(roaming, 'Slack', 'Cache'), j(roaming, 'Slack', 'Service Worker')] },
  ]) {
    app.dirs.forEach((dir, i) => {
      add({ group: `app-${app.id}`, groupLabel: `${app.label} cache`,
        groupLose: `Nothing you wrote. ${app.label} downloads images and files again when you scroll back to them, and you stay signed in.`,
        id: `app-cache-${app.id}${i ? '-' + i : ''}`, path: dir,
        label: `${app.label} cache`, verdict: 'disposable', everyday: true,
        lose: `Nothing you wrote. ${app.label} downloads images and files again when you scroll back to them, and you stay signed in.`,
        command: rm(dir) });
    });
  }

  // ---- the folder everybody forgets --------------------------------------
  add({
    // Not junk, and not offered with a command. It is listed because on an
    // ordinary machine it is frequently the largest folder a person owns and
    // is made almost entirely of installers they already ran.
    id: 'downloads-folder', path: j(HOME, 'Downloads'),
    label: 'Downloads folder', verdict: 'yours', everyday: true,
    lose: 'Whatever is in there, which is yours and which this tool will not guess about. Worth opening and sorting by size: on most machines it is mostly installers that were already used.',
    command: null });

  return out;
}

function knownCacheTargets() {
  return [...(CACHE_TARGETS.map((t) => ({ ...t }))), ...everydayTargets()];
}

// Docker Desktop's disk image, if it keeps one.
//
// Which file it is depends on the backend and on the version, so the candidates
// are checked rather than guessed. null when none of them is there: the caller
// then measures nothing instead of measuring a path that does not exist, and
// the Docker blind-spot card simply does not appear.
function dockerDiskImagePath() {
  const candidates = [
    la('Docker', 'wsl', 'disk', 'docker_data.vhdx'),
    la('Docker', 'wsl', 'data', 'ext4.vhdx'),
    la('Docker', 'wsl', 'main', 'ext4.vhdx'),
    path.join(PROGRAMDATA, 'DockerDesktop', 'vm-data', 'DockerDesktop.vhdx'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* next candidate */ }
  }
  return null;
}

// Places people on this platform keep repositories. A guess, checked at runtime
// by the caller — a folder named 'dev' full of PDFs is not a code directory.
// `source\repos` is here because it is what Visual Studio creates by default.
function likelyCodeDirs() {
  const names = ['code', 'dev', 'src', 'Projects', 'projects', 'repos', 'git', 'work', 'www', 'Developer'];
  return [...names.map((n) => p(n)), p('source', 'repos'), p('source')];
}

// Where a cloud-synced vault can be, most specific first: the sync service's
// own folder before the plain Documents folder, because on Windows Documents is
// frequently redirected INTO OneDrive and finding it twice is worse than once.
function vaultSearchRoots() {
  const roots = [p('OneDrive'), p('iCloudDrive'), p('Documents'), HOME];
  const seen = new Set();
  return roots.filter((r) => (seen.has(r) ? false : (seen.add(r), true)));
}

// ===========================================================================
// CHECKS
// ===========================================================================

// ---------------------------------------------------------------------------
// Windows has no equivalent of `tmutil destinationinfo`, and this returns null
// on purpose rather than reaching for the nearest thing.
//
// What is actually available: File History, whose configuration lives in a
// registry key that says nothing about whether it has ever run; System Restore,
// which snapshots system state and is NOT a copy of your files; wbadmin, which
// needs an elevated shell and is absent from most consumer editions; and
// OneDrive, which is a sync, not a backup — it copies a deletion as faithfully
// as it copies a file.
//
// None of those can answer "is there a backup of this machine" truthfully, and
// a wrong answer here is the worst kind this tool can give: a person who
// believes they are backed up does not make a backup. So the answer is "could
// not find out", and the caller says so on screen.
// ---------------------------------------------------------------------------
async function backupStatus() {
  return null;
}

// Services set to start automatically that stopped with an error.
//
// Microsoft's own services are filtered out here rather than in the caller,
// because only this file knows what the vendor prefix is on this platform, and
// on Windows the prefix is a location: a service whose binary lives under the
// Windows directory is the operating system, and system noise has no fix a
// person can apply. Exit code 1077 is excluded too — it does not mean failure,
// it means the service has not been asked to start since boot.
async function failedServices({ limit = 12 } = {}) {
  const d = await psJson([
    '$out = foreach ($s in @(Get-CimInstance -ClassName Win32_Service)) {',
    '  if ($s.StartMode -ne ' + lit('Auto') + ') { continue }',
    '  if ($s.State -eq ' + lit('Running') + ') { continue }',
    '  $code = [int]$s.ExitCode',
    '  if ($code -eq 0 -or $code -eq 1077) { continue }',
    '  [pscustomobject]@{ label = $s.Name; exitCode = $code; binary = [string]$s.PathName }',
    '}',
    '@($out)',
  ].join('\n'), { timeout: 25000 });
  if (!d) return [];
  const sys = SYSTEMROOT.toLowerCase();
  return arr(d)
    .map((s) => ({ label: s.label || null, exitCode: intOr(s.exitCode), binary: String(s.binary || '') }))
    .filter((s) => s.label && !s.binary.replace(/^"/, '').toLowerCase().startsWith(sys))
    .map((s) => ({ label: s.label, exitCode: s.exitCode }))
    .slice(0, limit);
}

// ===========================================================================
// DNS
//
// A bug in the monitor shows a wrong number; a bug here leaves the machine
// WITHOUT INTERNET, and nobody connects the two. Nothing in this section runs a
// change. The command builders return TEXT for a person to read.
// ===========================================================================

// The adapters DNS can be set on, in the order Windows indexes them. Adapters
// that are not up are omitted: setting DNS on a disconnected one changes
// nothing and looks like the panel lied.
async function dnsServices() {
  const d = await psJson([
    '$a = @(Get-NetAdapter -ErrorAction Stop | Where-Object { $_.Status -eq ' + lit('Up') + ' } | Sort-Object -Property ifIndex)',
    '@($a | ForEach-Object { [string]$_.Name })',
  ].join('\n'), { timeout: 20000 });
  if (!d) return [];
  return arr(d).map((x) => String(x)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// What is CONFIGURED on one adapter, which is not the same as what it is using.
//
// Get-DnsClientServerAddress hands back whatever the adapter resolves with,
// static or handed out by DHCP, and cannot tell the two apart. The registry
// can: the NameServer value holds what somebody set by hand and is empty when
// nothing was. Reading it is what makes `inherited` mean anything — and
// `inherited` is what decides whether the undo command written for this machine
// restores addresses or hands the adapter back to DHCP.
//
// null means the adapter could not be read. The caller must drop it rather than
// treat an unreadable adapter as one with no DNS.
// ---------------------------------------------------------------------------
async function dnsForService(name) {
  const q = lit(name);
  if (!q) return null;
  const d = await psJson([
    `$a = Get-NetAdapter -Name ${q} -ErrorAction Stop`,
    `$c = Get-DnsClientServerAddress -InterfaceAlias ${q} -AddressFamily IPv4 -ErrorAction Stop`,
    '$static = $null',
    '$key = ' + lit('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\') + ' + $a.InterfaceGuid',
    'try { $static = (Get-ItemProperty -Path $key -Name NameServer -ErrorAction Stop).NameServer } catch { $static = $null }',
    '[pscustomobject]@{ ips = @($c.ServerAddresses); static = [string]$static }',
  ].join('\n'), { timeout: 20000 });
  if (!d) return null;
  const service = String(name);
  const staticList = String(d.static || '').split(/[,\s]+/).filter(Boolean);
  // Nothing set by hand: this adapter takes whatever DHCP hands out. Reported
  // the way macOS reports it, with an empty list, so the caller probes only the
  // resolvers somebody actually chose.
  if (!staticList.length) return { service, ips: [], inherited: true };
  const ips = arr(d.ips).map((x) => String(x)).filter(Boolean);
  return { service, ips: ips.length ? ips : staticList, inherited: false };
}

// What the system is ACTUALLY querying right now, which may not be what the
// adapter config says: a VPN or mesh network can intercept first. Interfaces are
// read in metric order, which is the order Windows asks them in.
//
// 100.64.0.0/10 and fd7a: are Tailscale MagicDNS. While it answers first,
// changing the Wi-Fi DNS may do nothing at all — worth saying before you try,
// because otherwise the panel appears to hand out a command that fails.
async function effectiveResolver() {
  const d = await psJson([
    '$order = @{}',
    'foreach ($n in @(Get-NetIPInterface -ErrorAction SilentlyContinue)) {',
    '  if (-not $order.ContainsKey([string]$n.InterfaceAlias)) { $order[[string]$n.InterfaceAlias] = [int]$n.InterfaceMetric }',
    '}',
    '$rows = @(Get-DnsClientServerAddress -ErrorAction Stop | Where-Object { $_.ServerAddresses.Count -gt 0 })',
    '$sorted = $rows | Sort-Object -Property @{ Expression = { if ($order.ContainsKey([string]$_.InterfaceAlias)) { $order[[string]$_.InterfaceAlias] } else { 9999 } } }',
    '$ips = New-Object System.Collections.Generic.List[string]',
    'foreach ($r in $sorted) { foreach ($ip in $r.ServerAddresses) { if (-not $ips.Contains([string]$ip)) { $ips.Add([string]$ip) } } }',
    '@($ips)',
  ].join('\n'), { timeout: 20000 });
  if (!d) return null;
  const ips = arr(d).map((x) => String(x)).filter(Boolean);
  const mesh = ips.find((i) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i) || i.toLowerCase().startsWith('fd7a:')) || null;
  return {
    ips: ips.slice(0, 6),
    source: 'Get-DnsClientServerAddress',
    intercepted: mesh != null,
    interceptedBy: mesh ? 'Tailscale (MagicDNS)' : null,
  };
}

// ---------------------------------------------------------------------------
// Ask one resolver a question and time it.
//
// The stopwatch runs INSIDE PowerShell. Timing the process from Node would
// charge every resolver the ~300 ms it costs to start a PowerShell, and the
// caller's "answers, but slowly" threshold is 250 ms — every resolver on the
// machine would be reported as slow, by the panel's own overhead.
//
// -NoHostsFile matters here more than anywhere: this tool manages the hosts
// file, and a resolver that looks alive because the hosts file answered for it
// is a measurement of nothing.
//
// When `answered` is false, `ms` is how long the probe WAITED before giving up.
// It is not a latency and must never be labelled as one.
// ---------------------------------------------------------------------------
async function probeResolver(ip) {
  const q = lit(ip);
  if (!q) return null;
  const t0 = Date.now();
  const r = await ps([
    '$sw = [System.Diagnostics.Stopwatch]::StartNew()',
    '$answered = $false',
    'try {',
    `  $a = @(Resolve-DnsName -Name ${lit('example.com')} -Server ${q} -Type A -DnsOnly -NoHostsFile -QuickTimeout -ErrorAction Stop)`,
    '  $answered = @($a | Where-Object { $_.IPAddress }).Count -gt 0',
    '} catch { $answered = $false }',
    '$sw.Stop()',
    '[Console]::Out.WriteLine([string][int]$sw.ElapsedMilliseconds + ' + lit(' ') + ' + [string]$answered)',
  ].join('\n'), { timeout: 6000 });
  if (toolMissing(r)) return null;
  const waited = Date.now() - t0;
  if (!r.ok) return { ip: String(ip), ms: waited, answered: false };
  const m = String(r.out || '').trim().match(/^(\d+)\s+(\S+)/);
  if (!m) return { ip: String(ip), ms: waited, answered: false };
  return { ip: String(ip), ms: intOr(m[1], waited), answered: /^true$/i.test(m[2]) };
}

const SERVICE_SAFE = /^[^"'`$\\\n\r\t;&|<>()]{1,64}$/;
const IPV6 = /^[0-9a-f:]{2,45}$/i;
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((o) => +o <= 255);

// ---------------------------------------------------------------------------
// The command that changes DNS, as TEXT. This tool never runs it.
//
// It THROWS on anything it cannot build cleanly, and that is the whole point:
// `service` arrives from a query parameter, and a half-built command here does
// not show a wrong number — it points the machine at a server that does not
// exist, and whoever pasted it can no longer search for how to fix it.
//
// An empty `ips` list is not an error: -ResetServerAddresses is the form that
// hands the adapter back to DHCP, and it is how the undo for a machine that had
// no DNS set is written.
//
// There is no sudo on Windows. The command has to run in a PowerShell started
// with Run as administrator, and saying so is the caller's job — the same place
// the rest of the prose lives.
// ---------------------------------------------------------------------------
function setDnsCommand(service, ips = []) {
  const name = typeof service === 'string' ? service.trim() : '';
  if (!name || !SERVICE_SAFE.test(name)) {
    throw new TypeError(`setDnsCommand: ${JSON.stringify(service)} is not a usable network adapter name. ` +
      'Refusing to build a DNS command rather than emit one that points the machine at an adapter that does not exist.');
  }
  if (!Array.isArray(ips)) throw new TypeError('setDnsCommand: ips must be an array (use [] to reset to DHCP).');
  const list = ips.map((x) => String(x).trim()).filter(Boolean);
  for (const ip of list) {
    if (!isIPv4(ip) && !IPV6.test(ip)) throw new TypeError(`setDnsCommand: ${JSON.stringify(ip)} is not an IP address.`);
  }
  const tail = list.length
    ? `-ServerAddresses ${list.map((x) => `"${x}"`).join(',')}`
    : '-ResetServerAddresses';
  return {
    command: `Set-DnsClientServerAddress -InterfaceAlias "${name}" ${tail}`,
    service: name,
    ips: list,
    resetsToDhcp: list.length === 0,
  };
}

// Windows keeps one client-side cache and this empties it. Without it the old
// answer keeps being served and the change looks like it did not work.
function dnsFlushCommand() {
  return 'Clear-DnsClientCache';
}

// ===========================================================================
// THE HOSTS FILE
//
// This tool never writes a line into it. These are paths and command text.
// ===========================================================================

function hostsFilePath() {
  return path.join(SYSTEMROOT, 'System32', 'drivers', 'etc', 'hosts');
}

// The copy taken before the first block is ever applied. Its name has to sit
// next to the file it restores, or a person finds it months later with no idea
// what it is.
function hostsBackupPath() {
  return path.join(SYSTEMROOT, 'System32', 'drivers', 'etc', 'hosts.before-reckon');
}

// ---------------------------------------------------------------------------
// The (apply, undo) pair as TEXT, markers and all.
//
// The markers are matched with String.Contains, not with -match: a marker is
// free text and -match would read it as a regular expression, so a marker
// carrying a bracket would quietly match the wrong lines of a file being
// rewritten under administrator rights. They are still checked hard for
// quotes, slashes and newlines, because they are pasted into a single-quoted
// PowerShell string and one stray quote ends it.
//
// The rewrite is written back as ASCII. A hosts file is ASCII in practice and
// the alternative — PowerShell's default encoding, which is the system code
// page on 5.1 and UTF-8 with a byte-order mark on 7 — would rewrite the file
// differently depending on which PowerShell the person happened to open. The
// backup is taken first, which is what makes that safe to state plainly.
// ---------------------------------------------------------------------------
function hostsCommands({ snippetPath, begin, end } = {}) {
  const marker = (v, which) => {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s || /[/\\'"\n\r]/.test(s)) {
      throw new TypeError(`hostsCommands: the ${which} marker ${JSON.stringify(v)} cannot be used to address lines of the hosts file ` +
        '(it must be non-empty and free of slashes, quotes and newlines).');
    }
    return s;
  };
  if (typeof snippetPath !== 'string' || !snippetPath.trim()) {
    throw new TypeError('hostsCommands: snippetPath is required — it is the file this tool generated and the user appends.');
  }
  const b = marker(begin, 'begin'), e = marker(end, 'end');
  const hosts = hostsFilePath(), backup = hostsBackupPath();
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

  // One line, and the branches are an if/elseif chain rather than `continue`
  // statements: a person reads this before pasting it into an administrator
  // shell that rewrites the hosts file, and a chain of statements separated by
  // semicolons inside a loop body is harder to be sure about than a chain of
  // branches that each produce a line or do not.
  const strip = `$h = ${q(hosts)}; $keep = $true; `
    + '$out = foreach ($l in [System.IO.File]::ReadAllLines($h)) { '
    + `if ($l.Contains(${q(b)})) { $keep = $false } `
    + `elseif ($l.Contains(${q(e)})) { $keep = $true } `
    + 'elseif ($keep) { $l } }; '
    + 'Set-Content -LiteralPath $h -Value $out -Encoding ASCII';

  return {
    backupPath: backup,
    backupOnce: `if (-not (Test-Path -LiteralPath ${q(backup)})) { Copy-Item -LiteralPath ${q(hosts)} -Destination ${q(backup)} }`,
    strip,
    append: `Get-Content -LiteralPath ${q(snippetPath)} | Add-Content -LiteralPath ${q(hosts)} -Encoding ASCII`,
    restore: `Copy-Item -LiteralPath ${q(backup)} -Destination ${q(hosts)} -Force`,
  };
}

module.exports = {
  // memory and processes
  memoryStats, swapStats, processList, selfProcess,
  // filesystem primitives
  pathExists, isDirectory, listDirectory,
  // size, and the guards that make a size trustworthy
  volumeUsage, dirSizeKB, dirSizesKB, realSizeKB, fileCount, hardlinkRatio,
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
