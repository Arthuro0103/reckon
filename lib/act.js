'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('./platform');
const { run: execRun } = require('./sh');
const actlog = require('./actlog');
const docker = require('./docker');
const { ancestorsOfSelf } = require('./memory');
const aitools = require('./aitools');

// ---------------------------------------------------------------------------
// The action engine. The ONLY file in this project that may change the state
// of the machine, and bin/check.js holds it to that.
//
// The rule, decided by the owner on 2026-10-07: reckon never does anything you
// did not click, and never anything outside the table below. No sudo, ever.
//
// How a click becomes a command:
//   1. The browser sends `{ action, id }` and nothing else. A path or a command
//      in the body is ignored: there is no field that reads one.
//   2. The id is looked up in what THIS server measured itself (the last
//      Pressure reading, the last Memory reading). An id it never measured is
//      refused.
//   3. The target is measured again, NOW: every pid must still be the same
//      process (same executable, same start time), the app must still be the
//      same app, Docker must still have no container running. Anything that
//      changed between the reading and the click is refused, not adapted to.
//   4. The argv is built from the fixed table, never from text, and run with
//      execFile through lib/sh.js run(): no shell, so nothing can be spliced.
//   5. The machine is measured again after, and the before/after goes back to
//      the screen and into ~/.cache/reckon/actions.log.
//
// A run needs a preview first (a single-use nonce), and refuses to start less
// than five seconds after it: the countdown on the screen is part of the rule,
// not decoration.
// ---------------------------------------------------------------------------

// Every command the table may produce. Anything else is a bug and throws.
// `safe-remove` is not a program: it is safeRemove() below, run in this process
// with node's fs, after the same checks run once more. It is spelled like a
// command so that it passes through the same gate, the same dry run and the
// same log line as everything else.
const ALLOWED_COMMANDS = Object.freeze(['osascript', 'kill', 'xcrun',
  // phase 3: disk
  'npm', 'brew', 'go', 'pip3', 'pip', 'uv', 'qlmanage', 'git', 'docker', '/usr/bin/trash', 'safe-remove',
  // AI tools: only `ollama stop <a model its own API listed at the click>`
  'ollama']);

// The tools' own cleaners, with the only arguments each may get.
const TOOL_ARGS = Object.freeze({
  npm: ['cache', 'clean', '--force'],
  brew: ['cleanup', '--prune=all'],
  go: ['clean', '-cache'],
  pip3: ['cache', 'purge'],
  pip: ['cache', 'purge'],
  uv: ['cache', 'clean'],
  qlmanage: ['-r', 'cache'],
});
const FINDER_DELETE = Object.freeze(['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv))', '-e', 'end run']);
const FINDER_EMPTY = Object.freeze(['-e', 'tell application "Finder" to empty trash']);
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

// ---------------------------------------------------------------------------
// safeRemove(path): the only place in reckon that deletes a file.
//
// It refuses unless EVERY one of these holds, checked in this order, and checked
// again right before the fs.rm (never trusted from an earlier reading):
//   - the path is absolute and already in canonical form: no `..`, no `//`,
//     no trailing slash (so nothing is resolved into something else);
//   - home is a real home folder, not `/` or a system folder;
//   - it lies inside home, at least two levels down: home itself, and every
//     folder or dotfile at the top of home (~/.ssh, ~/.npm, ~/Documents…), is
//     never removed whole;
//   - it is not one of the folders that hold everything (~/Library,
//     ~/Library/Caches…), and not under one that is yours by definition
//     (~/Documents, ~/Desktop, ~/Downloads, iCloud Drive…);
//   - the path is not itself a link, and no link along it leads anywhere else:
//     its real path is exactly home's real path plus the same steps;
//   - it is one of the paths the caller allows: for a cache, the folder reckon's
//     own table names (lib/platform, CACHE_TARGETS and EVERYDAY_TARGETS); for
//     node_modules, the folder of a repository the last scan measured.
// fs.rm does not follow links inside the folder: a link in there is removed as
// a link, and what it points at stays.
// ---------------------------------------------------------------------------
const SYSTEM_ROOTS = Object.freeze(['/', '/System', '/Applications', '/Library', '/Users', '/usr', '/bin', '/sbin',
  '/etc', '/var', '/private', '/opt', '/Volumes', '/cores', '/dev', '/tmp', '/home', '/root']);
// Relative to home. Never removed themselves; what is inside some of them may be.
const NEVER_EXACT = Object.freeze(['Library', 'Library/Caches', 'Library/Application Support', 'Library/Containers',
  'Library/Group Containers', 'Library/Developer', 'Library/Developer/Xcode', 'Library/Developer/CoreSimulator', 'Library/Logs']);
// Relative to home. Neither these nor anything under them.
const NEVER_UNDER = Object.freeze(['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music', 'Public',
  'Applications', 'Library/Mobile Documents', 'Library/CloudStorage', 'Library/Keychains', 'Library/Preferences',
  'Library/Mail', 'Library/Messages', 'Library/Accounts', 'Library/Cookies']);

function checkRemovable(target, { home = os.homedir(), allowed = [] } = {}) {
  const no = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  if (typeof target !== 'string' || !target || target.includes('\0')) return no('That is not a path.');
  if (!path.isAbsolute(target)) return no('A relative path is never removed.');
  if (path.resolve(target) !== target) return no(`${target} is not in plain form (.., // or a trailing slash). Nothing is resolved into something else.`);
  if (SYSTEM_ROOTS.includes(target)) return no(`${target} is part of the system. It is never removed.`);
  let realHome;
  try { realHome = fs.realpathSync(home); } catch { return no('The home folder could not be resolved, so nothing can be proven to be inside it.'); }
  if (SYSTEM_ROOTS.includes(realHome) || realHome.split('/').filter(Boolean).length < 2) return no(`The home folder is ${realHome}, which is not a user's home. Nothing is removed.`);
  const rel = path.relative(home, target);
  if (!rel) return no('That is your home folder itself.');
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return no(`${target} is outside your home folder.`);
  const parts = rel.split('/');
  if (parts.length < 2) {
    return no(parts[0].startsWith('.')
      ? `~/${parts[0]} is a dotfile at the top of your home: it holds a whole tool's settings. Never removed whole.`
      : `~/${parts[0]} is a folder at the top of your home. Never removed whole.`);
  }
  if (NEVER_EXACT.includes(rel)) return no(`~/${rel} holds everything of its kind. It is never removed whole.`);
  const under = NEVER_UNDER.find((d) => rel === d || rel.startsWith(d + '/'));
  if (under) return no(`~/${rel} is inside ~/${under}, which is yours by definition. Nothing there is removed.`);
  let st;
  try { st = fs.lstatSync(target); } catch { return no(`${target} is not there any more.`, { gone: true }); }
  if (st.isSymbolicLink()) return no(`${target} is itself a link. A link is never followed to remove what it points at.`);
  let real;
  try { real = fs.realpathSync(target); } catch { return no(`${target} could not be resolved.`); }
  if (real !== path.join(realHome, rel)) return no(`A link along ${target} leads somewhere else (${real}). Nothing is removed through a link.`);
  const listed = (allowed || []).some((a) => { try { return fs.realpathSync(a) === real; } catch { return false; } });
  if (!listed) return no(`${target} is not one of the folders reckon's own table names. Nothing outside that table is removed.`);
  return { ok: true, real, rel };
}

function safeRemove(target, opts = {}) {
  const c = checkRemovable(target, opts);
  if (!c.ok) return c;
  try {
    fs.rmSync(c.real, { recursive: true, force: false });
    return { ok: true, removed: c.real };
  } catch (e) {
    return { ok: false, reason: `${target}: ${e.code || e.message}${e.code === 'EPERM' || e.code === 'EACCES' ? ' (macOS did not allow it: some of it may already be gone)' : ''}` };
  }
}

// Apps that are the desktop itself. Quitting them is never what somebody meant.
const PROTECTED_BUNDLES = Object.freeze([
  'com.apple.finder', 'com.apple.dock', 'com.apple.loginwindow', 'com.apple.systemuiserver',
  'com.apple.controlcenter', 'com.apple.notificationcenterui', 'com.apple.WindowManager',
  'com.apple.Spotlight', 'com.apple.coreservices.uiagent', 'com.apple.SecurityAgent',
]);
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$/;
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/;
const NONCE = /^[0-9a-f]{32}$/;

// etime has one-second resolution and the reading takes time, so two readings of
// the same process disagree by a second or two. A recycled pid would have to be
// started inside this window, by the same executable, to pass.
const START_TOLERANCE_MS = 3000;
const PREVIEW_TTL_MS = 120000;
const TARGET_TTL_MS = 10 * 60000;

const mbOf = (kb) => Math.round((kb || 0) / 1024);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Re-measuring.
// ---------------------------------------------------------------------------
// The absolute start time when the platform publishes one (to the second, so two
// readings agree exactly); otherwise derived from the age, which drifts by however
// long the reading took, and that time is added to the tolerance.
function startOf(p, reading) {
  if (p.startedAt != null) return { at: p.startedAt, slack: 0 };
  return p.ageS == null ? null : { at: reading.now - p.ageS * 1000, slack: reading.tookMs };
}

// Which of the expected processes are still THE SAME processes. `changed` is a
// pid now worn by something else, and it refuses the whole action.
function match(expected, reading) {
  const byPid = new Map(reading.list.map((p) => [p.pid, p]));
  const alive = [], gone = [], changed = [];
  for (const e of expected) {
    const n = byPid.get(e.pid);
    if (!n) { gone.push(e); continue; }
    const s = startOf(n, reading);
    const same = n.command === e.comm && e.startedAt != null && s != null
      && Math.abs(s.at - e.startedAt) <= START_TOLERANCE_MS + s.slack;
    if (same) alive.push({ ...e, rssKB: n.rssKB, ppid: n.ppid });
    else changed.push({ pid: e.pid, was: e.comm, now: n.command });
  }
  return { alive, gone, changed };
}

// A pid this engine must never signal, whatever the table says: init, the panel
// itself, and every process the panel runs inside.
function forbiddenPids(list, selfPid) {
  const out = ancestorsOfSelf(list, selfPid);
  out.add(selfPid); out.add(0); out.add(1);
  return out;
}

async function listNow(deps) {
  const t0 = deps.now();
  const list = await deps.processList();
  const now = deps.now();
  return Array.isArray(list) && list.length ? { list, now, tookMs: Math.max(0, now - t0) } : null;
}

async function verifyProcesses(expected, deps, { mustBeOrphaned = null } = {}) {
  const reading = await listNow(deps);
  if (!reading) return { ok: false, reason: 'The process list could not be read just now, so nothing can be proven. Nothing was done.' };
  const { list } = reading;
  const { alive, gone, changed } = match(expected, reading);
  if (changed.length) {
    return { ok: false, reason: `pid ${changed[0].pid} is now a different process (${changed[0].now}), not the one measured. Measure again.` };
  }
  if (!alive.length) return { ok: false, reason: 'Every one of these processes has already exited. Nothing left to do.' };
  const forbidden = forbiddenPids(list, deps.selfPid);
  const bad = alive.find((p) => forbidden.has(p.pid) || !(p.pid > 1));
  if (bad) return { ok: false, reason: `pid ${bad.pid} is reckon itself or runs it. It is never signalled.` };
  if (mustBeOrphaned && alive.some((p) => mustBeOrphaned(p) && p.ppid !== 1)) {
    return { ok: false, reason: 'A process measured as orphaned has a parent again. Measure again.' };
  }
  const kb = alive.reduce((s, p) => s + (p.rssKB || 0), 0);
  return {
    ok: true, alive, gone, kb, list,
    fp: alive.map((p) => p.pid).sort((a, b) => a - b).join(','),
    proof: `Measured again just now: ${alive.length} of ${expected.length} process(es) are still the same ones `
      + `(same executable, same start time), holding ${mbOf(kb)} MB.`
      + (gone.length ? ` ${gone.length} already exited on their own.` : ''),
  };
}

async function verifyApp(t, deps) {
  if (!BUNDLE_ID.test(String(t.bundleId || ''))) return { ok: false, reason: 'The bundle id is not one this engine can address safely.' };
  if (PROTECTED_BUNDLES.includes(t.bundleId)) return { ok: false, reason: `${t.bundleId} is part of the desktop itself. It is never quit from here.` };
  if (/^\/System\/Library\//.test(t.appPath || '')) return { ok: false, reason: 'Apps in /System/Library are part of macOS. They are never quit from here.' };
  const reading = await listNow(deps);
  if (!reading) return { ok: false, reason: 'The process list could not be read just now. Nothing was done.' };
  const { list } = reading;
  const { alive } = match([t.main], reading);
  if (!alive.length) return { ok: false, reason: `${t.name} quit or restarted since it was measured. Measure again.` };
  const app = await deps.appBundle(alive[0].comm);
  if (!app || app.appPath !== t.appPath || app.bundleId !== t.bundleId) {
    return { ok: false, reason: `The running process is no longer ${t.bundleId}. Measure again.` };
  }
  const prefix = t.appPath + '/';
  const inside = list.filter((p) => String(p.command).startsWith(prefix));
  const forbidden = forbiddenPids(list, deps.selfPid);
  if (inside.some((p) => forbidden.has(p.pid))) {
    return { ok: false, reason: `${t.name} is running reckon itself. Quitting it would stop this panel mid-answer.` };
  }
  const kb = inside.reduce((s, p) => s + (p.rssKB || 0), 0);
  return {
    ok: true, kb, main: alive[0], pids: inside.map((p) => p.pid),
    fp: `${alive[0].pid}:${t.bundleId}`,
    proof: `Measured again just now: ${t.name} (bundle ${t.bundleId}) is still the same instance, pid ${alive[0].pid}, `
      + `with ${inside.length} process(es) inside ${t.appPath} holding ${mbOf(kb)} MB.`,
  };
}

async function verifyDocker(t, deps) {
  const app = await verifyApp(t, deps);
  if (!app.ok) return app;
  const running = await deps.runningContainers();
  if (running == null) return { ok: false, reason: 'Docker did not answer how many containers are running, so it cannot be proven that none are. Nothing was done.' };
  if (running > 0) return { ok: false, reason: `${running} container(s) are running now. Quitting Docker Desktop would stop them, so there is no button for it.` };
  return { ...app, proof: `${app.proof} \`docker ps\` lists 0 running containers right now.` };
}

const LAUNCHD_SIM = /(^|\/)launchd_sim$/;

async function verifySimulators(t, deps) {
  const reading = await listNow(deps);
  if (!reading) return { ok: false, reason: 'The process list could not be read just now. Nothing was done.' };
  const roots = reading.list.filter((p) => LAUNCHD_SIM.test(p.command));
  if (!roots.length) return { ok: false, reason: 'No simulator is booted now. Nothing left to do.' };
  const { alive, changed } = match(t.roots || [], reading);
  if (changed.length || alive.length !== roots.length) {
    return { ok: false, reason: 'A different set of simulators is booted than when this was measured. Measure again.' };
  }
  return {
    ok: true, kb: null, roots: alive,
    fp: alive.map((p) => p.pid).sort((a, b) => a - b).join(','),
    proof: `Measured again just now: the same ${alive.length} launchd_sim process(es) are running, one per booted device.`,
  };
}

// ---------------------------------------------------------------------------
// AI tools. The rules live in lib/aitools.js and are run AGAIN here, at the
// click, with the same functions the row was built with: the preview and the
// run cannot disagree about what "idle" or "orphaned" means.
// ---------------------------------------------------------------------------
async function verifySession(t, deps) {
  if (!t.pid || !Number.isInteger(t.pid.pid) || t.pid.pid <= 1) return refuse('This row names no process.');
  const reading = await listNow(deps);
  if (!reading) return refuse('The process list could not be read just now, so nothing can be proven. Nothing was done.');
  const { alive, changed } = match([t.pid], reading);
  if (changed.length) return refuse(`pid ${t.pid.pid} is now a different process (${changed[0].now}), not the session measured. Measure again.`);
  if (!alive.length) return refuse('The session has already ended. Nothing left to do.');
  const forbidden = forbiddenPids(reading.list, deps.selfPid);
  if (forbidden.has(t.pid.pid)) return refuse(`pid ${t.pid.pid} is reckon itself or runs it (its terminal, its shell, the agent that started it). It is never signalled.`);
  const p = reading.list.find((x) => x.pid === t.pid.pid);
  const j = await aitools.judgeSession(p, reading.list, deps.ai, deps.selfPid);
  if (!j.offer) return refuse(`Measured again just now, and the session is not provably idle any more: ${j.why || j.skip} Nothing was done.`);
  const f = j.facts;
  if (f.tool !== t.tool || f.cwd !== t.cwd || f.tty !== t.tty) return refuse('The session\'s terminal or working folder is not the one measured. Measure again.');
  // Its tool servers must be the very ones the row was built with: same pids, same executables,
  // same start times, none gone and none new. The whole tree was judged again just above.
  const measured = Array.isArray(t.tools) ? t.tools : [];
  const kids = match(measured, reading);
  const ids = (xs) => xs.map((x) => x.pid).sort((a, b) => a - b).join(',');
  if (kids.changed.length || kids.gone.length || ids(measured) !== ids(f.tools)) {
    return refuse('The session\'s child processes are not the ones measured (one appeared, exited or was replaced). Measure again. Nothing was done.');
  }
  const tools = f.tools.length
    ? `Its only child processes are the same ${f.tools.length} tool server process(es) as measured (${[...new Set(f.tools.map((x) => x.label))].join(', ')}), each recognised by its command line, listening on no port, under 1% of a core and up 10 minutes or more`
    : 'It has no child process';
  return {
    ok: true, alive, kb: alive[0].rssKB || 0, facts: f,
    fp: `${p.pid}:${t.pid.startedAt}:${f.tty}:${f.cwd}:${f.tools.map((x) => `${x.pid}/${x.comm}`).sort().join(',')}`,
    proof: `Measured again just now: pid ${p.pid} is still the same ${f.tool} process (same executable, same start time), ${Math.floor(f.ageS / 3600)} h old. `
      + `${tools}. Its terminal /dev/${f.tty} was last used ${Math.floor(f.ttyIdleS / 60)} min ago, and the newest transcript in ${f.dirShown} `
      + `was modified ${Math.floor(f.transcriptIdleS / 60)} min ago (modification time only; it was not opened). It is not reckon, and does not run reckon.`,
  };
}

async function verifyOrphanTools(t, deps) {
  const roots = new Set(Array.isArray(t.rootPids) ? t.rootPids : []);
  if (!roots.size || !Array.isArray(t.pids) || !t.pids.length) return refuse('This row names no process.');
  const v = await verifyProcesses(t.pids, deps, { mustBeOrphaned: (p) => roots.has(p.pid) });
  if (!v.ok) return v;
  const pids = new Set(v.alive.map((p) => p.pid));
  const ours = v.list.filter((p) => pids.has(p.pid));
  for (const r of ours.filter((p) => roots.has(p.pid))) {
    if (!aitools.sessionGone(r, ours, v.list)) {
      return refuse(`Something else now sits on the terminal of pid ${r.pid} (${r.tty}): its session may be open again. Nothing was done.`);
    }
  }
  const ports = await deps.ai.ports();
  if (ports == null) return refuse('Listening ports could not be read just now, so it cannot be proven that nothing talks to these servers. Nothing was done.');
  const hit = ports.find((x) => pids.has(x.pid));
  if (hit) return refuse(`pid ${hit.pid} now listens on port ${hit.port}, which reckon cannot explain. Nothing was done.`);
  return { ...v, proof: `${v.proof} Each root still has no parent (ppid 1), nothing else sits on its terminal, and none of them listens on a port.` };
}

async function verifyOllama(t, deps) {
  if (!aitools.validModelName(t.name)) return refuse('That model name is not one this engine passes to ollama.');
  if (!deps.which('ollama')) return refuse('The ollama command is not on this panel\'s PATH, so there is no button. Run the command yourself.');
  const models = await deps.ai.ollamaLoaded();
  if (models == null) return refuse(`Ollama's API (${aitools.OLLAMA_URL}) did not answer just now, so it cannot be proven the model is loaded. Nothing was done.`);
  const m = models.find((x) => x && x.name === t.name);
  if (!m || !aitools.validModelName(m.name)) return refuse(`${t.name} is not in Ollama's list of loaded models any more. Nothing left to do.`);
  const kb = m.size == null ? null : Math.round(m.size / 1024);
  return {
    ok: true, kb, name: m.name,
    fp: `${m.name}:${m.digest || ''}`,
    proof: `Measured again just now: Ollama's own API (${aitools.OLLAMA_URL}) lists ${m.name} as loaded${kb == null ? '' : `, ${gbOf(kb)} GB`}. The name passed to ollama is that exact string, as one argument.`,
  };
}

async function settleOllama(t, check, deps) {
  const until = deps.now() + deps.settleMs;
  let still = true;
  for (;;) {
    const models = await deps.ai.ollamaLoaded();
    if (models) still = models.some((m) => m && m.name === check.name);
    if (!still || deps.now() >= until) break;
    await sleep(250);
  }
  return { goneCount: still ? 0 : 1, stillAlive: still ? [check.name] : [], freedKB: still ? 0 : check.kb };
}

// ---------------------------------------------------------------------------
// Waiting for the effect. A command that exits 0 proves only that it ran; the
// machine is measured again to say what actually changed.
// ---------------------------------------------------------------------------
async function settleProcesses(expected, deps, waitMs) {
  const until = deps.now() + waitMs;
  // A reading that fails proves nothing either way, so until one succeeds every
  // process counts as still alive: the result never claims memory it cannot show.
  let m = { alive: expected };
  for (;;) {
    const reading = await listNow(deps);
    // A process that has exited but not yet been reaped (a zombie) still has its pid and
    // holds no memory: rss 0. It is gone in every sense this result reports.
    if (reading) { m = match(expected, reading); m.alive = m.alive.filter((p) => p.rssKB > 0); }
    if (!m.alive.length || deps.now() >= until) break;
    await sleep(250);
  }
  const goneKB = expected.filter((e) => !m.alive.some((a) => a.pid === e.pid)).reduce((s, e) => s + (e.rssKB || 0), 0);
  return { stillAlive: m.alive.map((p) => p.pid), goneCount: expected.length - m.alive.length, freedKB: goneKB };
}

// An app is gone when its main process is; what it held is everything that ran inside it.
async function settleApp(check, deps, waitMs) {
  const s = await settleProcesses([check.main], deps, waitMs);
  return s.stillAlive.length ? { ...s, freedKB: 0 } : { ...s, freedKB: check.kb };
}

// ---------------------------------------------------------------------------
// Re-measuring a folder, a repository, Docker. Phase 3.
// ---------------------------------------------------------------------------
const gbOf = (kb) => ((kb || 0) / 1048576).toFixed(2);
const shortHome = (p, deps) => String(p).replace(deps.home(), '~');
const refuse = (reason) => ({ ok: false, reason });

// The known table, by id: where reckon's own table says each cache lives.
function knownById(deps) {
  const out = new Map();
  for (const t of deps.known() || []) out.set(t.id, t);
  return out;
}

async function sizeOf(paths, deps) {
  let kb = 0, any = false;
  for (const p of paths) { const n = await deps.sizeKB(p); if (n != null) { kb += n; any = true; } }
  return any ? kb : null;
}

// A cache: every folder must still be the one reckon's table names, and pass
// checkRemovable now. The tool's own cleaner is used when the tool is on PATH.
async function verifyCache(t, deps) {
  const known = knownById(deps);
  const members = Array.isArray(t.members) ? t.members : [];
  if (!members.length) return refuse('This row names no folder.');
  const keep = [];
  for (const m of members) {
    const k = known.get(m.id);
    if (!k || k.path !== m.path || k.verdict !== 'disposable') return refuse(`${m.path} is not where reckon's own table says ${m.id} lives. Nothing outside that table is removed.`);
    const c = checkRemovable(m.path, { home: deps.home(), allowed: [k.path] });
    if (!c.ok && c.gone) continue;
    if (!c.ok) return refuse(c.reason);
    keep.push(m.path);
  }
  if (!keep.length) return refuse('Every folder in this row is already gone. Nothing left to do.');
  let tool = null;
  if (t.tool && keep.length === 1 && members.length === 1) {
    for (const cmd of t.tool) if (TOOL_ARGS[cmd] && deps.which(cmd)) { tool = [cmd, [...TOOL_ARGS[cmd]]]; break; }
  }
  const kb = await sizeOf(keep, deps);
  return {
    ok: true, kb, paths: keep, tool, allowed: keep,
    fp: `${keep.join('|')}:${tool ? tool[0] : 'rm'}`,
    proof: `Measured again just now: ${kb == null ? 'size unreadable' : gbOf(kb) + ' GB'} in ${keep.map((p) => shortHome(p, deps)).join(', ')}. `
      + 'Each folder is the one reckon\'s own table names, inside your home folder, reached through no link.'
      + (tool ? ` Cleared with the tool's own command (${tool[0]} is on PATH).` : ' Removed by reckon itself, after those checks run once more.'),
  };
}

async function verifyTrashMove(t, deps) {
  const k = knownById(deps).get(t.id);
  if (!k || k.path !== t.path || !['ios-backups', 'mail-downloads'].includes(t.id)) return refuse('This folder is not one reckon moves to the Trash.');
  const c = checkRemovable(t.path, { home: deps.home(), allowed: [k.path] });
  if (!c.ok) return refuse(c.gone ? 'Already gone. Nothing left to do.' : c.reason);
  const kb = await sizeOf([t.path], deps);
  const bin = deps.trashBin();
  return {
    ok: true, kb, path: c.real, bin, paths: [t.path],
    fp: c.real,
    proof: `Measured again just now: ${kb == null ? 'size unreadable (macOS may need Full Disk Access to read it)' : gbOf(kb) + ' GB'} in ${shortHome(t.path, deps)}, inside your home folder, reached through no link.`,
  };
}

async function verifyEmptyTrash(t, deps) {
  const k = knownById(deps).get('trash');
  if (!k || k.path !== t.path) return refuse('This is not the Trash reckon\'s own table names.');
  const kb = await sizeOf([t.path], deps);
  if (kb === 0) return refuse('The Trash is empty. Nothing left to do.');
  return {
    ok: true, kb, paths: [],
    fp: 'trash',
    proof: kb == null
      ? 'The Trash could not be measured just now (macOS guards it unless reckon has Full Disk Access). Finder empties it either way.'
      : `Measured again just now: ${gbOf(kb)} GB in the Trash.`,
  };
}

async function verifySimUnavailable(t, deps) {
  if (!deps.which('xcrun')) return refuse('xcrun is not installed here.');
  const r = await deps.read('xcrun', ['simctl', 'list', 'devices', 'unavailable', '-j'], { timeout: 20000 });
  let ids = [];
  try { ids = Object.values(JSON.parse(r.out).devices || {}).flat().map((d) => d.udid).filter(Boolean).sort(); }
  catch { return refuse('simctl did not say which simulators are unavailable, so nothing can be proven. Nothing was done.'); }
  if (!ids.length) return refuse('No simulator is unavailable right now. Nothing left to do.');
  return {
    ok: true, kb: null, paths: [], fp: ids.join(','),
    proof: `Measured again just now: \`xcrun simctl list devices unavailable\` lists ${ids.length} device(s) whose iOS runtime is no longer installed. They cannot boot.`,
  };
}

const git = (dir, args, deps, timeout = 15000) => deps.read('git', ['-C', dir, ...args], { timeout });
const countLines = (r) => (r.ok ? String(r.out).split('\n').filter(Boolean).length : null);

// node_modules of a parked repository: at the click, the repository must still
// be exactly as the scan saw it. A commit since, or a different count of
// uncommitted files, is a repository somebody is working in again.
async function verifyNodeModules(t, deps) {
  if (typeof t.repo !== 'string' || t.nm !== path.join(t.repo, 'node_modules')) return refuse('Only the node_modules folder of the repository itself is removed.');
  const c = checkRemovable(t.nm, { home: deps.home(), allowed: [t.nm] });
  if (!c.ok) return refuse(c.gone ? 'node_modules is already gone. Nothing left to do.' : c.reason);
  if (!t.lastHash) return refuse('The scan did not read this repository\'s last commit, so "nothing changed since" cannot be proven.');
  const head = await git(t.repo, ['log', '-1', '--format=%h'], deps);
  if (!head.ok) return refuse('git did not answer in this repository just now. Nothing was done.');
  const hash = String(head.out).trim();
  if (!(hash.startsWith(t.lastHash) || t.lastHash.startsWith(hash))) return refuse(`There is a commit since the scan (${hash}, was ${t.lastHash}): this repository is not parked any more. Scan again.`);
  const dirty = countLines(await git(t.repo, ['status', '--porcelain'], deps, 25000));
  if (dirty == null) return refuse('git status did not answer just now. Nothing was done.');
  if (dirty !== t.dirtyCount) return refuse(`The uncommitted files changed since the scan (${dirty} now, ${t.dirtyCount} then): somebody is working here. Scan again.`);
  const tracked = await git(t.repo, ['ls-files', '--error-unmatch', '--', 'node_modules'], deps);
  if (tracked.ok) return refuse('This repository commits its node_modules. Removing it would change the repository, so there is no button for it.');
  const kb = await sizeOf([t.nm], deps);
  return {
    ok: true, kb, paths: [t.nm], allowed: [t.nm],
    fp: `${hash}:${dirty}`,
    proof: `Measured again just now: last commit is still ${hash}, the same ${dirty} uncommitted file(s) as at the scan, `
      + `and node_modules (${kb == null ? 'size unreadable' : gbOf(kb) + ' GB'}) is not committed.`,
  };
}

// Ignored top-level names that a tool rebuilds. Anything else ignored in a
// worktree may exist only there, and plain `git worktree remove` deletes it
// silently (git status does not list ignored files, and git does not refuse).
const WT_REGENERABLE = Object.freeze(['node_modules', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'dist', 'build', 'out', 'target', '.venv', 'venv', '__pycache__', '.pytest_cache', '.gradle', '.svelte-kit', 'coverage']);

async function verifyWorktree(t, deps) {
  const c = checkRemovable(t.path, { home: deps.home(), allowed: [t.path] });
  if (!c.ok) return refuse(c.gone ? 'The worktree is already gone. Nothing left to do.' : c.reason);
  const common = await git(t.path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], deps);
  const dir = common.ok ? String(common.out).trim() : '';
  if (!dir || path.basename(dir) !== '.git') return refuse('git did not name the main repository of this worktree. Nothing was done.');
  const main = path.dirname(dir);
  if (main === c.real || main === t.path) return refuse('That is the main checkout, not a worktree. It is never removed.');
  const list = await git(main, ['worktree', 'list', '--porcelain'], deps);
  const listed = list.ok && String(list.out).split('\n').some((l) => l === `worktree ${c.real}` || l === `worktree ${t.path}`);
  if (!listed) return refuse('git does not list this folder as a worktree of its repository. Nothing was done.');
  if (!t.base) return refuse('The scan did not know the main branch, so "already merged" cannot be proven.');
  const off = await git(t.path, ['rev-list', '--count', `${t.base}..HEAD`], deps);
  if (!off.ok || String(off.out).trim() !== '0') return refuse(`This worktree now has commits that are not on ${t.base}. It is not disposable any more.`);
  const dirty = countLines(await git(t.path, ['status', '--porcelain'], deps, 25000));
  const ign = await git(t.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], deps, 25000);
  if (!ign.ok) return refuse('git did not list the ignored files in this worktree, so it cannot be judged whether they exist anywhere else. Nothing was done.');
  const ignored = String(ign.out).split('\n').filter(Boolean).sort();
  const only = ignored.filter((e) => !WT_REGENERABLE.includes(e.split('/')[0]));
  if (only.length) {
    return refuse(`This worktree holds ${only.length} ignored item(s) that are not regenerable, which git does not count as uncommitted and would delete with the worktree: `
      + `${only.slice(0, 10).join(', ')}${only.length > 10 ? ` (and ${only.length - 10} more)` : ''}. `
      + 'These exist only here: copy them first, then remove the worktree yourself.');
  }
  const ignKB = await sizeOf(ignored.map((e) => path.join(c.real, e)), deps);
  const kb = await sizeOf([t.path], deps);
  const ignNote = ignored.length
    ? `${ignored.length} ignored regenerable item(s), ${ignKB == null ? 'size unreadable' : `${Math.round(ignKB / 1024)} MB`}, will be deleted with the worktree (${ignored.slice(0, 10).join(', ')}${ignored.length > 10 ? ', …' : ''}).`
    : 'No ignored files.';
  return {
    ok: true, kb, paths: [t.path], main, wt: c.real, ignored,
    fp: `${main}:${c.real}:${ignored.join('|')}`,
    proof: `Measured again just now: git rev-list --count ${t.base}..HEAD = 0, so every commit here is on ${t.base}. `
      + `${dirty == null ? 'The uncommitted files could not be counted' : `${dirty} uncommitted file(s)`}; git refuses to remove a worktree that has any modified or untracked file, and reckon never forces it. `
      + `git does NOT refuse for ignored files, so reckon listed them itself: ${ignNote}`,
  };
}

async function dockerUp(deps) {
  const r = await deps.read('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 12000 });
  return r.ok && String(r.out).trim() ? String(r.out).trim() : null;
}

async function verifyDockerVolumes(t, deps) {
  const names = Array.isArray(t.names) ? t.names : [];
  if (!names.length || names.some((n) => !DOCKER_NAME.test(n))) return refuse('These volume names are not ones this engine can address safely.');
  if (!(await dockerUp(deps))) return refuse('Docker is not answering, so it cannot be proven that no container uses these volumes. Nothing was done.');
  const r = await deps.read('docker', ['volume', 'ls', '-qf', 'dangling=true'], { timeout: 20000 });
  if (!r.ok) return refuse('Docker did not list its unused volumes just now. Nothing was done.');
  const dangling = new Set(String(r.out).split('\n').filter(Boolean));
  const lost = names.filter((n) => !dangling.has(n));
  if (lost.length) return refuse(`${lost.join(', ')} ${lost.length === 1 ? 'is' : 'are'} now used by a container, or gone. Scan again.`);
  return {
    ok: true, kb: null, paths: [], names: [...names].sort(),
    fp: [...names].sort().join(','),
    proof: `Measured again just now: \`docker volume ls -f dangling=true\` still lists ${names.join(', ')}: no container, running or stopped, points at them.`,
  };
}

async function dockerReclaimable(deps) {
  const r = await deps.read('docker', ['system', 'df', '--format', '{{.Type}}\t{{.Reclaimable}}'], { timeout: 25000 });
  return r.ok ? String(r.out).split('\n').filter(Boolean).map((l) => l.split('\t')).map(([type, rec]) => `${type}: ${rec}`).join(', ') : null;
}

async function verifyDockerBuilder(t, deps) {
  if (!(await dockerUp(deps))) return refuse('Docker is not answering. Nothing was done.');
  const rec = await dockerReclaimable(deps);
  return {
    ok: true, kb: null, paths: [], fp: 'builder',
    proof: `Measured again just now: Docker answers, and \`docker system df\` reports reclaimable ${rec || '(unreadable)'}. Only build cache older than 48 hours goes.`,
  };
}

async function verifyDockerPrune(t, deps) {
  if (!(await dockerUp(deps))) return refuse('Docker is not answering. Nothing was done.');
  const r = await deps.read('docker', ['ps', '-a', '--filter', 'status=exited', '--filter', 'status=created', '--filter', 'status=dead', '--format', '{{.Names}}'], { timeout: 20000 });
  if (!r.ok) return refuse('Docker did not list its stopped containers just now, so what would go cannot be shown. Nothing was done.');
  const stopped = String(r.out).split('\n').filter(Boolean).sort();
  const rec = await dockerReclaimable(deps);
  return {
    ok: true, kb: null, paths: [], stopped,
    fp: stopped.join(','),
    proof: `Measured again just now: ${stopped.length} stopped container(s)${stopped.length ? ` (${stopped.slice(0, 8).join(', ')}${stopped.length > 8 ? '…' : ''})` : ''} would be removed. `
      + `\`docker system df\` reports reclaimable ${rec || '(unreadable)'}. No volume is touched: there is no --volumes, and no -a.`,
  };
}

// After a disk action: how many of the folders are really gone now.
async function settlePaths(t, check, deps) {
  // A tool's own cleaner empties what it chooses and may keep the folder itself.
  if (check.tool) return { goneCount: 0, stillAlive: [], freedKB: null };
  const paths = check.paths || [];
  const left = paths.filter((p) => deps.exists(p));
  return { goneCount: paths.length - left.length, stillAlive: left, freedKB: null };
}

// Where the Trash put it. Finder adds a number when the name is taken, so the
// newest entry that starts with the same name is the one.
async function settleTrash(t, check, deps) {
  const s = await settlePaths(t, check, deps);
  const base = path.basename(check.path || '');
  let trashedTo = null;
  try {
    const dir = path.join(deps.home(), '.Trash');
    const hit = fs.readdirSync(dir).filter((n) => n === base || n.startsWith(base + ' '))
      .map((n) => ({ n, at: fs.lstatSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.at - a.at)[0];
    if (hit) trashedTo = path.join(dir, hit.n);
  } catch { /* macOS guards ~/.Trash without Full Disk Access */ }
  return { ...s, trashedTo: trashedTo || (s.goneCount ? `~/.Trash (as "${base}", or "${base} 2" if that name was taken)` : null) };
}

const settleNone = async () => ({ goneCount: 0, stillAlive: [], freedKB: null });

const REMOVAL = Object.freeze({
  regenerable: 'Removed for good. It is a cache: the tool that made it rebuilds it.',
  trash: 'Goes to the Trash. You can put it back.',
  irreversible: 'Removed for good, and it cannot be undone.',
  git: 'git removes the worktree folder. Its commits stay in the repository.',
  docker: 'Removed from Docker for good.',
});

const shownArgv =([cmd, args]) => [cmd, ...args.map((a) => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a))].join(' ');
const appQuit = (t) => ['osascript', ['-e', `tell application id "${t.bundleId}" to quit`]];

// ---------------------------------------------------------------------------
// THE TABLE. Every action reckon can take. Each one says what it does, what you
// lose, whether it can be undone, how it is re-measured, and the exact argv.
// ---------------------------------------------------------------------------
const ACTIONS = Object.freeze({
  'quit-app': Object.freeze({
    label: 'Quit the app',
    kind: 'memory',
    reversible: true,
    confirm: (t) => `Quit ${t.name}? It asks to save anything unsaved first.`,
    describe: (t) => `Ask ${t.name} to quit, the same as choosing Quit in its menu.`,
    lose: (t) => `Whatever is open in ${t.name}. A graceful quit: the app asks to save, and Cancel in its dialog stops the quit.`,
    undo: (t) => `Open ${t.name} again.`,
    // Docker Desktop goes through quit-docker, which proves no container is running first.
    verify: (t, deps) => (t.bundleId === 'com.docker.docker'
      ? { ok: false, reason: 'Docker Desktop is quit only from its own row, which first checks that no container is running.' }
      : verifyApp(t, deps)),
    argv: (t) => appQuit(t),
    timeoutMs: 130000,   // the app may sit on a save dialog until the person answers
    settle: (t, check, deps) => settleApp(check, deps, deps.settleMs),
  }),
  'quit-docker': Object.freeze({
    label: 'Quit Docker Desktop',
    kind: 'memory',
    reversible: true,
    confirm: () => 'Quit Docker Desktop? No container is running.',
    describe: (t) => `Ask ${t.name} to quit, which shuts its VM down and gives its memory back.`,
    lose: () => 'Nothing that is running. Images, volumes and stopped containers stay on disk.',
    undo: (t) => `Open ${t.name} again; it takes under a minute to be ready.`,
    verify: verifyDocker,
    argv: (t) => appQuit(t),
    timeoutMs: 130000,
    settle: (t, check, deps) => settleApp(check, deps, Math.max(deps.settleMs, 15000)),
  }),
  'term-processes': Object.freeze({
    label: 'Stop the processes',
    kind: 'memory',
    reversible: false,
    confirm: (t) => `Send a polite stop (SIGTERM) to ${t.pids.length} process(es)?`,
    describe: (t, c) => `Send SIGTERM to ${c.alive.length} process(es). Each one may clean up and exit. If any are still alive after 10 seconds, a separate click can force them.`,
    lose: (t) => t.lose || 'Whatever these processes were doing.',
    undo: () => 'Not undoable: a stopped process does not come back. Start the program again if you need it.',
    verify: (t, deps) => verifyProcesses(t.pids, deps, {
      mustBeOrphaned: (p) => t.kind === 'swarm' || p.pid === t.rootPid,
    }),
    argv: (t, c) => ['kill', ['-TERM', ...c.alive.map((p) => String(p.pid))]],
    timeoutMs: 10000,
    settle: (t, check, deps) => settleProcesses(check.alive, deps, 5000),
  }),
  'kill-processes': Object.freeze({
    label: 'Force them to stop',
    kind: 'memory',
    reversible: false,
    follows: 'term-processes',
    confirm: (t) => `Force ${t.pids.length} process(es) that ignored the polite stop to exit (SIGKILL)?`,
    describe: (t, c) => `Send SIGKILL to the ${c.alive.length} process(es) still alive after the polite stop. They get no chance to clean up.`,
    lose: () => 'Anything they had not written yet. SIGKILL gives no chance to save or clean up.',
    undo: () => 'Not undoable.',
    verify: (t, deps) => verifyProcesses(t.pids, deps),
    argv: (t, c) => ['kill', ['-KILL', ...c.alive.map((p) => String(p.pid))]],
    timeoutMs: 10000,
    settle: (t, check, deps) => settleProcesses(check.alive, deps, 5000),
  }),
  'shutdown-simulators': Object.freeze({
    label: 'Shut down simulators',
    kind: 'memory',
    reversible: true,
    confirm: () => 'Shut down every booted iOS simulator?',
    describe: (t, c) => `Run \`xcrun simctl shutdown all\`, which shuts down the ${c.roots.length} booted simulator(s).`,
    lose: () => 'The state of whatever app runs inside each simulator. The devices stay installed.',
    undo: () => 'Open Simulator, or `xcrun simctl boot <device>`.',
    verify: verifySimulators,
    argv: () => ['xcrun', ['simctl', 'shutdown', 'all']],
    timeoutMs: 60000,
    settle: (t, check, deps) => settleProcesses(check.roots, deps, deps.settleMs),
  }),

  // ---- AI tools. lib/aitools.js judges each row; it is judged again here at the click.
  'end-ai-session': Object.freeze({
    label: 'End the session',
    kind: 'memory',
    reversible: false,
    confirm: (t) => `End the ${t.tool} session on ${t.tty}? Its conversation stays on disk.`,
    describe: (t, c) => `Send a polite stop (SIGTERM) to pid ${c.alive[0].pid}, the ${t.tool} process on ${t.tty}, and to nothing else: not its shell, not its terminal`
      + (c.facts.tools.length ? `, not its tool servers. ${aitools.toolsSentence(c.facts.tools)}: they exit with it, or are left orphaned and offered later by the orphaned tool servers row` : '')
      + '. No forced stop follows.',
    lose: (t) => t.lose || 'The running process. The conversation stays on disk.',
    undo: (t) => `The process does not come back; the conversation does: \`${t.resume}\`, then pick it from the list.`,
    verify: verifySession,
    argv: (t, c) => ['kill', ['-TERM', String(c.alive[0].pid)]],
    timeoutMs: 10000,
    settle: (t, check, deps) => settleProcesses(check.alive, deps, 5000),
    logInfo: (t) => ({ tool: t.tool, tty: t.tty, cwd: t.cwd, resume: t.resume }),
  }),
  'stop-orphan-tools': Object.freeze({
    label: 'Stop the orphaned servers',
    kind: 'memory',
    reversible: false,
    confirm: (t) => `Send a polite stop (SIGTERM) to ${t.pids.length} orphaned ${t.label} process(es)?`,
    describe: (t, c) => `Send SIGTERM to the ${c.alive.length} process(es) of these ${t.label} trees. Each may clean up and exit. No forced stop follows.`,
    lose: (t) => t.lose || 'Whatever these servers were doing for a session that is gone.',
    undo: () => 'Not undoable, and not needed: the client that uses a tool server starts it again the next time it starts.',
    verify: verifyOrphanTools,
    argv: (t, c) => ['kill', ['-TERM', ...c.alive.map((p) => String(p.pid))]],
    timeoutMs: 10000,
    settle: (t, check, deps) => settleProcesses(check.alive, deps, 5000),
    logInfo: (t) => ({ tool: t.label }),
  }),
  'stop-ollama-model': Object.freeze({
    label: 'Unload the model',
    kind: 'memory', unit: 'model',
    reversible: true,
    confirm: (t) => `Unload ${t.name} from Ollama? The model file stays on disk.`,
    describe: (t, c) => `Run \`ollama stop ${c.name}\`, which asks Ollama to drop the model from memory. Ollama itself keeps running.`,
    lose: () => 'Nothing on disk. The next request to this model loads it again, and what it held for the current chat is dropped.',
    undo: (t) => `It reloads by itself on the next request to ${t.name}, or with \`ollama run ${t.name}\`.`,
    verify: verifyOllama,
    argv: (t, c) => ['ollama', ['stop', c.name]],
    timeoutMs: 30000,
    settle: settleOllama,
    logInfo: (t) => ({ model: t.name }),
  }),

  // ---- phase 3: disk. Each row's target comes from the last deep scan the
  // server read itself; every one is measured again at the click.
  'clear-cache': Object.freeze({
    label: 'Clear the cache',
    kind: 'disk', removal: 'regenerable', queue: true,
    reversible: false,
    confirm: (t) => `Clear ${t.title}? It is removed for good, and it rebuilds itself.`,
    describe: (t, c) => (c.tool
      ? `Run the tool's own cleaner, \`${[c.tool[0], ...c.tool[1]].join(' ')}\`, which knows which of its files are safe to drop.`
      : `Remove ${c.paths.length} folder(s) reckon's table names as a cache. The tool that made it builds it again when it needs it.`),
    lose: (t) => t.lose || 'Nothing you made. The next use is slower, once.',
    undo: () => 'Not undoable, and not needed: the cache is rebuilt the next time it is used.',
    verify: verifyCache,
    argv: (t, c) => (c.tool ? c.tool : ['safe-remove', [...c.paths]]),
    timeoutMs: 300000,
    settle: settlePaths,
  }),
  'remove-node-modules': Object.freeze({
    label: 'Remove node_modules',
    kind: 'disk', removal: 'regenerable', queue: true,
    reversible: false,
    confirm: (t) => `Remove node_modules of ${t.name}? Nothing else in the repository is touched.`,
    describe: (t) => `Remove ${t.nm} and nothing else. The repository, its commits and its uncommitted files stay.`,
    lose: (t) => t.lose || 'None of your code. One install rebuilds it.',
    undo: (t) => `Not undoable, and not needed: \`${t.install || 'npm install'}\` in the repository rebuilds it.`,
    verify: verifyNodeModules,
    argv: (t, c) => ['safe-remove', [...c.paths]],
    timeoutMs: 300000,
    settle: settlePaths,
  }),
  'remove-worktree': Object.freeze({
    label: 'Remove the worktree',
    kind: 'disk', removal: 'git', queue: true,
    reversible: false,
    confirm: (t) => `Remove the worktree ${t.name}? Its commits are already on ${t.base}.`,
    describe: (t, c) => `Run \`git worktree remove\` from the main repository (${c.main}). Without --force: git refuses on modified or untracked files, and reckon shows that and stops. git does NOT refuse on ignored files, so reckon checks those itself: only regenerable ones (${WT_REGENERABLE.slice(0, 4).join(', ')}, ...) are allowed, and they are deleted with the worktree${c && c.ignored && c.ignored.length ? ` (${c.ignored.slice(0, 10).join(', ')})` : ''}. Any other ignored file refuses.`,
    lose: (t) => t.lose || 'Ignored regenerable folders inside it (node_modules, build output), deleted with it. Modified or untracked files: git refuses. Other ignored files: reckon refuses.',
    undo: (t) => `\`git worktree add <path> <branch>\` brings a worktree back. Its commits are on ${t.base}.`,
    verify: verifyWorktree,
    argv: (t, c) => ['git', ['-C', c.main, 'worktree', 'remove', c.wt]],
    timeoutMs: 120000,
    settle: settlePaths,
  }),
  'move-to-trash': Object.freeze({
    label: 'Move to the Trash',
    kind: 'disk', removal: 'trash', queue: true,
    reversible: true,
    confirm: (t) => `Move ${t.title} to the Trash? You can put it back from there.`,
    describe: (t, c) => (c.bin
      ? `Move ${c.path} to the Trash with macOS's own \`trash\` tool.`
      : `Ask Finder to move ${c.path} to the Trash, the same as dragging it there.`),
    lose: (t) => t.lose || 'Nothing until you empty the Trash.',
    undo: () => 'Open the Trash in Finder, select it, and choose File > Put Back.',
    verify: verifyTrashMove,
    argv: (t, c) => (c.bin ? ['/usr/bin/trash', ['-s', c.path]] : ['osascript', [...FINDER_DELETE, c.path]]),
    timeoutMs: 600000,
    settle: settleTrash,
  }),
  'empty-trash': Object.freeze({
    label: 'Empty the Trash',
    kind: 'disk', removal: 'irreversible', queue: false, twice: true,
    reversible: false,
    confirm: () => 'Empty the Trash? Everything in it is deleted for good.',
    again: () => 'Second confirmation: this cannot be undone. Nothing that is in the Trash can be put back after this.',
    describe: () => 'Ask Finder to empty the Trash, the same as Finder > Empty Trash.',
    lose: (t) => t.lose || 'Everything in the Trash, for good.',
    undo: () => 'Not undoable. Only a backup (Time Machine) brings anything back.',
    verify: verifyEmptyTrash,
    argv: () => ['osascript', [...FINDER_EMPTY]],
    timeoutMs: 600000,
    settle: settleNone,
  }),
  'delete-unavailable-simulators': Object.freeze({
    label: 'Delete unavailable simulators',
    kind: 'disk', removal: 'irreversible', queue: true,
    reversible: false,
    confirm: () => 'Delete the simulators whose iOS version is no longer installed?',
    describe: (t, c) => `Run \`xcrun simctl delete unavailable\`: only devices that cannot boot any more. Every simulator that still works stays.`,
    lose: () => 'Simulators that cannot boot: their apps and data. A device you still use is not touched.',
    undo: () => 'Not undoable. Install that iOS runtime again and create the device again.',
    verify: verifySimUnavailable,
    argv: () => ['xcrun', ['simctl', 'delete', 'unavailable']],
    timeoutMs: 120000,
    settle: settleNone,
  }),
  'docker-volume-rm': Object.freeze({
    label: 'Remove the unused volumes',
    kind: 'disk', removal: 'docker', queue: true,
    reversible: false,
    confirm: (t) => `Remove ${t.names.length} Docker volume(s) no container uses?`,
    describe: (t, c) => `Run \`docker volume rm\` on ${c.names.join(', ')}, named one by one. Docker itself refuses a volume a container uses.`,
    lose: (t) => t.lose || 'The data in those volumes, for good.',
    undo: () => 'Not undoable.',
    verify: verifyDockerVolumes,
    argv: (t, c) => ['docker', ['volume', 'rm', ...c.names]],
    timeoutMs: 120000,
    settle: settleNone,
  }),
  'docker-builder-prune': Object.freeze({
    label: 'Prune old build cache',
    kind: 'disk', removal: 'regenerable', queue: true,
    reversible: false,
    confirm: () => 'Remove Docker build cache older than 48 hours?',
    describe: () => 'Run `docker builder prune --filter until=48h`. -f only skips Docker\'s own y/N question, which this confirmation replaces. The space comes back inside the Docker VM; macOS sees it after Docker trims its disk.',
    lose: () => 'Build layers older than two days. The next build of those images is slower, once.',
    undo: () => 'Not undoable, and not needed: the next build makes them again.',
    verify: verifyDockerBuilder,
    argv: () => ['docker', ['builder', 'prune', '-f', '--filter', 'until=48h']],
    timeoutMs: 600000,
    settle: settleNone,
  }),
  'docker-system-prune': Object.freeze({
    label: 'Prune Docker (no volumes)',
    kind: 'disk', removal: 'docker', queue: true,
    reversible: false,
    confirm: () => 'Prune Docker: stopped containers, unused networks, dangling images and build cache? No volume, no tagged image.',
    describe: (t, c) => `Run \`docker system prune\` without -a and without --volumes: ${c.stopped.length} stopped container(s), unused networks, dangling images and unused build cache go. -f only skips Docker's own y/N question. The space comes back inside the Docker VM; macOS sees it after Docker trims its disk.`,
    lose: () => 'The stopped containers themselves (anything written inside them that is not in a volume). Their volumes stay, and so does every tagged image.',
    undo: () => 'Not undoable. A container is recreated from its image, without what was written inside it.',
    verify: verifyDockerPrune,
    argv: () => ['docker', ['system', 'prune', '-f']],
    timeoutMs: 600000,
    settle: settleNone,
  }),
});

// The last gate before execFile. The table can only produce these shapes; if it
// ever produces another, that is a bug, and it throws rather than runs.
function assertSafe(cmd, args) {
  if (!ALLOWED_COMMANDS.includes(cmd)) throw new Error(`refused: ${cmd} is not in the action table`);
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new Error('refused: arguments must be strings');
  if ([cmd, ...args].some((a) => /\bsudo\b/.test(a))) throw new Error('refused: sudo is never run');
  if (cmd === 'kill') {
    if (!['-TERM', '-KILL'].includes(args[0])) throw new Error('refused: unknown signal');
    if (args.length < 2 || args.slice(1).some((a) => !/^\d+$/.test(a) || +a <= 1)) throw new Error('refused: bad pid');
  }
  const isOsaQuit = cmd === 'osascript' && args.length === 2 && args[0] === '-e' && /^tell application id "[A-Za-z0-9][A-Za-z0-9.-]{0,154}" to quit$/.test(args[1]);
  if (cmd === 'osascript' && !isOsaQuit) {
    // Finder may move ONE absolute path to the Trash (passed as an argument, never
    // spliced into the script), or empty the Trash. Nothing else.
    const del = args.length === FINDER_DELETE.length + 1 && FINDER_DELETE.every((a, i) => args[i] === a) && absPath(args[args.length - 1]);
    const empty = args.length === FINDER_EMPTY.length && FINDER_EMPTY.every((a, i) => args[i] === a);
    if (!del && !empty) throw new Error('refused: osascript may only quit an app, trash one path, or empty the Trash');
  }
  if (cmd === 'xcrun' && !['simctl shutdown all', 'simctl delete unavailable'].includes(args.join(' '))) throw new Error('refused: xcrun may only shut simulators down or delete unavailable ones');
  if (Object.hasOwn(TOOL_ARGS, cmd) && args.join('\0') !== TOOL_ARGS[cmd].join('\0')) throw new Error(`refused: ${cmd} may only run its own cache cleaner`);
  if (cmd === 'git') {
    if (!(args.length === 5 && args[0] === '-C' && absPath(args[1]) && args[2] === 'worktree' && args[3] === 'remove' && absPath(args[4]))) throw new Error('refused: git may only remove a worktree');
    if (args.some((a) => /^-(f|-force)$/.test(a))) throw new Error('refused: a worktree is never removed with --force');
  }
  if (cmd === 'docker') {
    const vol = args.length >= 3 && args[0] === 'volume' && args[1] === 'rm' && args.slice(2).every((n) => DOCKER_NAME.test(n));
    const builder = args.join(' ') === 'builder prune -f --filter until=48h';
    const system = args.join(' ') === 'system prune -f';
    if (!vol && !builder && !system) throw new Error('refused: docker may only remove named unused volumes, prune old build cache, or prune without -a and --volumes');
  }
  if (cmd === 'ollama' && !(args.length === 2 && args[0] === 'stop' && aitools.validModelName(args[1]))) throw new Error('refused: ollama may only stop one model, named exactly');
  if (cmd === '/usr/bin/trash' && !(args.length === 2 && args[0] === '-s' && absPath(args[1]))) throw new Error('refused: trash takes one absolute path');
  if (cmd === 'safe-remove' && !(args.length >= 1 && args.length <= 40 && args.every(absPath))) throw new Error('refused: safe-remove takes absolute paths');
}

// An absolute path in plain form, that cannot be mistaken for an option.
function absPath(a) {
  return typeof a === 'string' && a.startsWith('/') && !a.includes('\0') && path.resolve(a) === a && a !== '/';
}

// What the browser may say: an action name, a row id, and (for run) the nonce
// its preview returned. Every other field, `path` and `command` included, is
// dropped here and never read again.
function clean(body) {
  if (!body || typeof body !== 'object') return null;
  const { action, id, nonce } = body;
  if (typeof action !== 'string' || !Object.hasOwn(ACTIONS, action)) return null;
  if (typeof id !== 'string' || !ROW_ID.test(id)) return null;
  return { action, id, nonce: typeof nonce === 'string' && NONCE.test(nonce) ? nonce : null };
}

// ---------------------------------------------------------------------------
// The engine. One per server; tests build their own with a fake process list,
// a fake HOME and, when they want, a dry run that returns the argv unrun.
// ---------------------------------------------------------------------------
// Is this executable somewhere on PATH? A plain fs lookup: nothing is run.
function onPath(name) {
  if (name.includes('/')) { try { fs.accessSync(name, fs.constants.X_OK); return name; } catch { return null; } }
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

function createEngine(opts = {}) {
  const deps = {
    processList: opts.processList || (() => platform.processList()),
    appBundle: opts.appBundle || ((c) => platform.appBundle(c)),
    runningContainers: opts.runningContainers || (() => docker.runningContainers()),
    memoryStats: opts.memoryStats || (() => platform.memoryStats()),
    memoryPressure: opts.memoryPressure || (() => platform.memoryPressure()),
    exec: opts.exec || execRun,
    log: opts.log || actlog,
    now: opts.now || Date.now,
    selfPid: opts.selfPid ?? process.pid,
    settleMs: opts.settleMs ?? 8000,
    // phase 3: disk. Each is replaceable, so a test can hand in a fake machine.
    volume: opts.volume || (() => platform.volumeUsage()),
    known: opts.known || (() => (typeof platform.knownCacheTargets === 'function' ? platform.knownCacheTargets() : [])),
    home: opts.home || (() => os.homedir()),
    sizeKB: opts.sizeKB || ((p) => platform.dirSizeKB(p, 60000)),
    // Reading only: git log/status, docker ls, simctl list. Never a command from the table.
    read: opts.read || execRun,
    which: opts.which || onPath,
    trashBin: opts.trashBin || (() => onPath('/usr/bin/trash')),
    exists: opts.exists || ((p) => { try { fs.lstatSync(p); return true; } catch { return false; } }),
  };
  // The AI-tool readings (lib/aitools.js), on the same clock and home as the rest, so a test's
  // fake machine is the only machine a verify can see.
  deps.ai = { ...aitools.defaultProbe(), now: deps.now, home: deps.home, which: deps.which, ...(opts.ai || {}) };
  const dryRun = opts.dryRun ?? process.env.RECKON_ACT_DRY_RUN === '1';
  const minDelayMs = opts.minDelayMs ?? 5000;
  const killAfterMs = opts.killAfterMs ?? 10000;

  const TARGETS = new Map();   // id -> { source, at, title, action, target }
  const PENDING = new Map();   // nonce -> { action, id, at, fp, stage? }
  const QUEUES = new Map();    // nonce -> { at, items: [{ action, id, fp }] }
  const TERMED = new Map();    // id -> { at, title, target } : what a polite stop left alive
  let busy = false;

  // Called by the server with every reading it serves. Only rows the collector
  // gave an action to, and only `high` or `medium`, become clickable. A disk row
  // is addressed by its action's `ref` (a hash of the row id), because a repo or
  // a worktree name can hold characters a row id may not.
  function remember(source, rows) {
    for (const [id, t] of TARGETS) if (t.source === source) TARGETS.delete(id);
    for (const r of rows || []) {
      if (!r || !r.action || !r.target || !['high', 'medium'].includes(r.confidence)) continue;
      if (!Object.hasOwn(ACTIONS, r.action.id) || ACTIONS[r.action.id].follows) continue;
      const key = typeof r.action.ref === 'string' && ROW_ID.test(r.action.ref) ? r.action.ref : r.id;
      TARGETS.set(key, { source, at: deps.now(), title: r.title, action: r.action.id,
        target: { ...r.target, title: r.title, lose: r.lose, warning: r.warning || null } });
    }
  }

  function lookup(req) {
    const def = ACTIONS[req.action];
    if (def.follows) {
      const t = TERMED.get(req.id);
      if (!t) return { refused: 'There is no polite stop to follow up. The forced stop is only offered after one.' };
      const wait = t.at + killAfterMs - deps.now();
      if (wait > 0) return { refused: `The forced stop is offered ${killAfterMs / 1000} s after the polite one. ${Math.ceil(wait / 1000)} s to go.` };
      return { entry: t };
    }
    const t = TARGETS.get(req.id);
    if (!t) return { refused: 'That row is not in the last reading this panel took. Measure again.' };
    if (t.action !== req.action) return { refused: 'That action does not belong to that row.' };
    if (deps.now() - t.at > TARGET_TTL_MS) {
      return { refused: t.source === 'disk'
        ? 'The panel read the scan more than ten minutes ago. Reload the page so it reads it again.'
        : 'That reading is more than ten minutes old. Measure again.' };
    }
    return { entry: t };
  }

  async function snapshot(kind) {
    const [m, p, v] = await Promise.all([
      Promise.resolve().then(deps.memoryStats).catch(() => null),
      Promise.resolve().then(deps.memoryPressure).catch(() => null),
      // A light `df`, not a scan: the free space on the volume, before and after.
      kind === 'disk' ? Promise.resolve().then(deps.volume).catch(() => null) : null,
    ]);
    return {
      at: deps.now(),
      pressure: p ? p.label : null,
      // What the system can hand to a new app without swapping: free plus inactive.
      availableMB: m && m.freeBytes != null ? Math.round(((m.freeBytes || 0) + (m.inactiveBytes || 0)) / 1048576) : null,
      compressedMB: m && m.compressedBytes != null ? Math.round(m.compressedBytes / 1048576) : null,
      ...(kind === 'disk' ? { freeKB: v && v.freeKB != null ? v.freeKB : null } : {}),
    };
  }

  // The one place a table argv becomes an effect. safe-remove runs here, in this
  // process, with checkRemovable run once more on every path; everything else is
  // execFile through lib/sh.js run(), with no shell.
  async function execute(cmd, args, check, def) {
    if (cmd !== 'safe-remove') return deps.exec(cmd, args, { timeout: def.timeoutMs || 20000 });
    const errors = [];
    for (const p of args) {
      const r = safeRemove(p, { home: deps.home(), allowed: check.allowed || [] });
      if (!r.ok) errors.push(r.reason);
    }
    return errors.length ? { ok: false, out: '', erro: errors.join(' | ') } : { ok: true, out: '', erro: null };
  }

  function describeOf(def, req, found, check, argv) {
    const { target } = found.entry;
    return {
      action: req.action, id: req.id, title: found.entry.title, label: def.label, kind: def.kind,
      what: def.describe(target, check), kb: check.kb, mb: check.kb == null ? null : mbOf(check.kb),
      proof: check.proof, lose: def.lose(target), reversible: def.reversible, undo: def.undo(target),
      confirm: def.confirm(target), command: argv[0] === 'safe-remove'
        ? `# removed by reckon itself (fs.rm), after the safety checks run again:\n${argv[1].join('\n')}`
        : shownArgv(argv),
      removal: def.removal || null, removalLabel: def.removal ? REMOVAL[def.removal] : null,
      warning: target.warning || null,
    };
  }

  async function preview(body) {
    const req = clean(body);
    if (!req) return { ok: false, refused: 'Unknown action or row.' };
    const def = ACTIONS[req.action];
    const found = lookup(req);
    if (found.refused) return { ok: false, refused: found.refused };
    const { target } = found.entry;
    const check = await def.verify(target, deps);
    if (!check.ok) return { ok: false, refused: check.reason };
    const argv = def.argv(target, check);
    assertSafe(...argv);
    for (const [n, p] of PENDING) if (deps.now() - p.at > PREVIEW_TTL_MS) PENDING.delete(n);

    // Irreversible actions are confirmed twice, and the server holds that rule:
    // the first preview's nonce cannot run, it can only ask for the second.
    let stage = null;
    if (def.twice) {
      const first = req.nonce && PENDING.get(req.nonce);
      if (req.nonce) PENDING.delete(req.nonce);
      if (!first) stage = 1;
      else if (first.stage !== 1 || first.action !== req.action || first.id !== req.id) return { ok: false, refused: 'That first confirmation does not match. Start again.' };
      else if (first.fp !== check.fp) return { ok: false, refused: 'What would be acted on changed between the two confirmations. Nothing was done.' };
      else stage = 2;
    }
    const nonce = crypto.randomBytes(16).toString('hex');
    PENDING.set(nonce, { action: req.action, id: req.id, at: deps.now(), fp: check.fp, stage });
    return {
      ok: true, ...describeOf(def, req, found, check, argv),
      countdownS: Math.ceil(minDelayMs / 1000), nonce,
      ...(def.twice ? { stage, again: stage === 1 ? def.again(target) : null } : {}),
    };
  }

  // Measure again, compare with the preview's fingerprint, run, measure after,
  // log. Shared by a single run and by every item of a queue.
  async function runOne(req, pending) {
    const def = ACTIONS[req.action];
    const found = lookup(req);
    if (found.refused) { deps.log.append({ action: req.action, id: req.id, refused: found.refused }); return { ok: false, refused: found.refused }; }
    const { target, title } = found.entry;
    // Measured AGAIN, now, after the countdown. The preview's reading is not trusted for this.
    const check = await def.verify(target, deps);
    if (!check.ok) { deps.log.append({ action: req.action, id: req.id, title, refused: check.reason }); return { ok: false, refused: check.reason }; }
    if (check.fp !== pending.fp) {
      const why = 'What would be acted on changed between the preview and now. Nothing was done; preview again.';
      deps.log.append({ action: req.action, id: req.id, title, refused: why });
      return { ok: false, refused: why };
    }
    const [cmd, args] = def.argv(target, check);
    assertSafe(cmd, args);
    const before = await snapshot(def.kind);
    if (dryRun) {
      deps.log.append({ action: req.action, id: req.id, title, argv: [cmd, ...args], dryRun: true, ...(def.logInfo ? { info: def.logInfo(target, check) } : {}) });
      return { ok: true, dryRun: true, kind: def.kind, argv: [cmd, ...args], before };
    }

    const r = await execute(cmd, args, check, def);
    const settled = await def.settle(target, check, deps);
    const after = await snapshot(def.kind);
    TARGETS.delete(req.id);   // that reading is history now

    let message = null;
    if (!r.ok && /-128|User canceled/i.test(r.erro || '')) message = def.kind === 'disk' ? 'Cancel was chosen in the dialog. Nothing was done.' : 'The app asked, and Cancel was chosen there. Nothing quit.';
    else if (!r.ok && /-1743|Not authori[sz]ed/i.test(r.erro || '')) message = def.kind === 'disk'
      ? 'macOS did not allow reckon to ask Finder. System Settings, Privacy & Security, Automation: allow the app that runs reckon to control Finder, then try again.'
      : 'macOS did not allow reckon to ask that app to quit. System Settings, Privacy & Security, Automation: allow the app that runs reckon to control it, then try again.';
    else if (settled.stillAlive.length && /quit/.test(req.action)) message = 'The app is still running. It may be waiting on a dialog of its own.';
    else if (!r.ok) message = r.erro || 'The command failed.';

    let killOffer = null;
    if (req.action === 'term-processes' && settled.stillAlive.length) {
      const pids = new Set(settled.stillAlive);
      TERMED.set(req.id, { at: deps.now(), title, target: { ...target, pids: target.pids.filter((p) => pids.has(p.pid)) } });
      killOffer = { action: 'kill-processes', id: req.id, inS: Math.ceil(killAfterMs / 1000), count: settled.stillAlive.length };
    }
    if (req.action === 'kill-processes') TERMED.delete(req.id);

    const result = {
      ok: settled.goneCount > 0 || (r.ok && !settled.stillAlive.length),
      kind: def.kind, ...(def.unit ? { unit: def.unit } : {}), ran: [cmd, ...args], exitOk: r.ok, message,
      gone: settled.goneCount, stillAlive: settled.stillAlive, freedKB: settled.freedKB,
      before, after, killOffer,
    };
    if (def.kind === 'disk') {
      result.removal = def.removal || null;
      result.trashedTo = settled.trashedTo || null;
      if (before.freeKB != null && after.freeKB != null) result.freeDeltaKB = after.freeKB - before.freeKB;
    }
    result.logged = deps.log.append({ action: req.action, id: req.id, title, argv: result.ran, ok: result.ok,
      exitOk: r.ok, message, gone: result.gone, stillAlive: result.stillAlive, freedKB: result.freedKB, before, after,
      ...(result.trashedTo ? { trashedTo: result.trashedTo } : {}), ...(def.removal ? { removal: def.removal } : {}),
      ...(def.logInfo ? { info: def.logInfo(target, check) } : {}) });
    return result;
  }

  async function run(body) {
    const req = clean(body);
    if (!req) return { ok: false, refused: 'Unknown action or row.' };
    const pending = req.nonce && PENDING.get(req.nonce);
    if (req.nonce) PENDING.delete(req.nonce);   // single use, whatever happens next
    if (!pending || pending.action !== req.action || pending.id !== req.id) {
      return { ok: false, refused: 'No preview matches this. Every action is previewed and confirmed first.' };
    }
    if (pending.stage === 1) return { ok: false, refused: 'This needs its second confirmation first. Nothing was done.' };
    const age = deps.now() - pending.at;
    if (age < minDelayMs) return { ok: false, refused: 'Too soon after the preview: the countdown is part of the rule.' };
    if (age > PREVIEW_TTL_MS) return { ok: false, refused: 'The preview is more than two minutes old. Ask for it again.' };
    if (busy) return { ok: false, refused: 'Another action is running. One at a time.' };

    busy = true;
    try { return await runOne(req, pending); } finally { busy = false; }
  }

  // ---- the queue ("collector"): several disk rows, one confirmation with the
  // summed total, run one by one, each logged, stopping at the first refusal.
  function cleanQueue(body) {
    if (!body || !Array.isArray(body.items) || !body.items.length || body.items.length > QUEUE_MAX) return null;
    const items = body.items.map(clean);
    if (items.some((i) => !i) || new Set(items.map((i) => i.id)).size !== items.length) return null;
    return items.map(({ action, id }) => ({ action, id }));
  }

  async function previewQueue(body) {
    const items = cleanQueue(body);
    if (!items) return { ok: false, refused: `A queue is 1 to ${QUEUE_MAX} different rows.` };
    const out = [];
    for (const req of items) {
      const def = ACTIONS[req.action];
      if (def.kind !== 'disk' || !def.queue || def.twice) return { ok: false, refused: `"${def.label}" is not queued: it has a confirmation of its own.` };
      const found = lookup(req);
      if (found.refused) return { ok: false, refused: `${req.id}: ${found.refused}`, items: out };
      const check = await def.verify(found.entry.target, deps);
      if (!check.ok) return { ok: false, refused: `${found.entry.title}: ${check.reason}`, items: out };
      const argv = def.argv(found.entry.target, check);
      assertSafe(...argv);
      out.push({ ...describeOf(def, req, found, check, argv), fp: check.fp });
    }
    for (const [n, q] of QUEUES) if (deps.now() - q.at > PREVIEW_TTL_MS) QUEUES.delete(n);
    const nonce = crypto.randomBytes(16).toString('hex');
    QUEUES.set(nonce, { at: deps.now(), items: out.map((i) => ({ action: i.action, id: i.id, fp: i.fp })) });
    const known = out.filter((i) => i.kb != null);
    return {
      ok: true, nonce, countdownS: Math.ceil(minDelayMs / 1000),
      items: out.map(({ fp, ...rest }) => rest),
      totalKB: known.reduce((s, i) => s + i.kb, 0), unmeasured: out.length - known.length,
    };
  }

  async function runQueue(body) {
    const nonce = body && typeof body.nonce === 'string' && NONCE.test(body.nonce) ? body.nonce : null;
    const q = nonce && QUEUES.get(nonce);
    if (nonce) QUEUES.delete(nonce);
    if (!q) return { ok: false, refused: 'No queue preview matches this. A queue is previewed and confirmed first.' };
    const age = deps.now() - q.at;
    if (age < minDelayMs) return { ok: false, refused: 'Too soon after the preview: the countdown is part of the rule.' };
    if (age > PREVIEW_TTL_MS) return { ok: false, refused: 'The preview is more than two minutes old. Ask for it again.' };
    if (busy) return { ok: false, refused: 'Another action is running. One at a time.' };
    busy = true;
    const results = [];
    let stoppedAt = null;
    try {
      for (const item of q.items) {
        const title = (TARGETS.get(item.id) || {}).title || item.id;
        const r = await runOne({ action: item.action, id: item.id }, { fp: item.fp });
        results.push({ action: item.action, id: item.id, title, ...r });
        if (!r.ok) { stoppedAt = item.id; break; }
      }
    } finally { busy = false; }
    const first = results[0], last = results[results.length - 1];
    return {
      ok: stoppedAt == null, kind: 'disk', results, stoppedAt,
      skipped: q.items.length - results.length,
      before: first && first.before, after: last && (last.after || last.before),
      dryRun: results.length > 0 && results.every((r) => r.dryRun),
    };
  }

  return { preview, run, remember, previewQueue, runQueue, _targets: TARGETS, _termed: TERMED };
}

const QUEUE_MAX = 25;
const engine = createEngine();

module.exports = {
  ACTIONS, ALLOWED_COMMANDS, PROTECTED_BUNDLES, REMOVAL, assertSafe, clean, createEngine,
  checkRemovable, safeRemove,
  preview: engine.preview, run: engine.run, remember: engine.remember,
  previewQueue: engine.previewQueue, runQueue: engine.runQueue,
};
