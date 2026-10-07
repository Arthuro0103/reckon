'use strict';
const crypto = require('node:crypto');
const platform = require('./platform');
const { run: execRun } = require('./sh');
const actlog = require('./actlog');
const docker = require('./docker');
const { ancestorsOfSelf } = require('./memory');

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
const ALLOWED_COMMANDS = Object.freeze(['osascript', 'kill', 'xcrun']);

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
    ok: true, alive, gone, kb,
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
  if (cmd === 'osascript' && !(args.length === 2 && args[0] === '-e' && /^tell application id "[A-Za-z0-9][A-Za-z0-9.-]{0,154}" to quit$/.test(args[1]))) {
    throw new Error('refused: osascript may only ask an app to quit');
  }
  if (cmd === 'xcrun' && args.join(' ') !== 'simctl shutdown all') throw new Error('refused: xcrun may only shut simulators down');
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
  };
  const dryRun = opts.dryRun ?? process.env.RECKON_ACT_DRY_RUN === '1';
  const minDelayMs = opts.minDelayMs ?? 5000;
  const killAfterMs = opts.killAfterMs ?? 10000;

  const TARGETS = new Map();   // id -> { source, at, title, action, target }
  const PENDING = new Map();   // nonce -> { action, id, at, fp }
  const TERMED = new Map();    // id -> { at, title, target } : what a polite stop left alive
  let busy = false;

  // Called by the server with every reading it serves. Only rows the collector
  // gave an action to, and only `high` or `medium`, become clickable.
  function remember(source, rows) {
    for (const [id, t] of TARGETS) if (t.source === source) TARGETS.delete(id);
    for (const r of rows || []) {
      if (!r || !r.action || !r.target || !['high', 'medium'].includes(r.confidence)) continue;
      if (!Object.hasOwn(ACTIONS, r.action.id) || ACTIONS[r.action.id].follows) continue;
      TARGETS.set(r.id, { source, at: deps.now(), title: r.title, action: r.action.id, target: { ...r.target, lose: r.lose } });
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
    if (deps.now() - t.at > TARGET_TTL_MS) return { refused: 'That reading is more than ten minutes old. Measure again.' };
    return { entry: t };
  }

  async function snapshot() {
    const [m, p] = await Promise.all([
      Promise.resolve().then(deps.memoryStats).catch(() => null),
      Promise.resolve().then(deps.memoryPressure).catch(() => null),
    ]);
    return {
      at: deps.now(),
      pressure: p ? p.label : null,
      // What the system can hand to a new app without swapping: free plus inactive.
      availableMB: m && m.freeBytes != null ? Math.round(((m.freeBytes || 0) + (m.inactiveBytes || 0)) / 1048576) : null,
      compressedMB: m && m.compressedBytes != null ? Math.round(m.compressedBytes / 1048576) : null,
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
    const nonce = crypto.randomBytes(16).toString('hex');
    PENDING.set(nonce, { action: req.action, id: req.id, at: deps.now(), fp: check.fp });
    return {
      ok: true, action: req.action, id: req.id, title: found.entry.title, label: def.label,
      what: def.describe(target, check), kb: check.kb, mb: check.kb == null ? null : mbOf(check.kb),
      proof: check.proof, lose: def.lose(target), reversible: def.reversible, undo: def.undo(target),
      confirm: def.confirm(target), command: shownArgv(argv), countdownS: Math.ceil(minDelayMs / 1000), nonce,
    };
  }

  async function run(body) {
    const req = clean(body);
    if (!req) return { ok: false, refused: 'Unknown action or row.' };
    const pending = req.nonce && PENDING.get(req.nonce);
    if (req.nonce) PENDING.delete(req.nonce);   // single use, whatever happens next
    if (!pending || pending.action !== req.action || pending.id !== req.id) {
      return { ok: false, refused: 'No preview matches this. Every action is previewed and confirmed first.' };
    }
    const age = deps.now() - pending.at;
    if (age < minDelayMs) return { ok: false, refused: 'Too soon after the preview: the countdown is part of the rule.' };
    if (age > PREVIEW_TTL_MS) return { ok: false, refused: 'The preview is more than two minutes old. Ask for it again.' };
    if (busy) return { ok: false, refused: 'Another action is running. One at a time.' };

    busy = true;
    const def = ACTIONS[req.action];
    try {
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
      const before = await snapshot();
      if (dryRun) {
        deps.log.append({ action: req.action, id: req.id, title, argv: [cmd, ...args], dryRun: true });
        return { ok: true, dryRun: true, argv: [cmd, ...args], before };
      }

      const r = await deps.exec(cmd, args, { timeout: def.timeoutMs || 20000 });
      const settled = await def.settle(target, check, deps);
      const after = await snapshot();
      TARGETS.delete(req.id);   // that reading is history now

      let message = null;
      if (!r.ok && /-128|User canceled/i.test(r.erro || '')) message = 'The app asked, and Cancel was chosen there. Nothing quit.';
      else if (!r.ok && /-1743|Not authori[sz]ed/i.test(r.erro || '')) message = 'macOS did not allow reckon to ask that app to quit. System Settings, Privacy & Security, Automation: allow the app that runs reckon to control it, then try again.';
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
        ran: [cmd, ...args], exitOk: r.ok, message,
        gone: settled.goneCount, stillAlive: settled.stillAlive, freedKB: settled.freedKB,
        before, after, killOffer,
      };
      result.logged = deps.log.append({ action: req.action, id: req.id, title, argv: result.ran, ok: result.ok,
        exitOk: r.ok, message, gone: result.gone, stillAlive: result.stillAlive, freedKB: result.freedKB, before, after });
      return result;
    } finally { busy = false; }
  }

  return { preview, run, remember, _targets: TARGETS, _termed: TERMED };
}

// ---------------------------------------------------------------------------
// The request guard for the action routes.
// MERGE: unify with phase 0 token guard. Phase 0 adds a Host/Origin check to
// every route and injects this token into index.html; when it lands, this
// helper and GET /api/act/token give way to it.
// ---------------------------------------------------------------------------
const TOKEN = crypto.randomBytes(24).toString('hex');

function hostOk(req, port) {
  const h = String(req.headers.host || '');
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

function originOk(req, port) {
  const o = req.headers.origin;
  return o == null || o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

function deny(res, why) {
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(why);
  return false;
}

// Host exact (a page that rebinds its own name to 127.0.0.1 still sends its own
// Host), Origin ours when present, and the per-run token in `x-reckon-token`.
function requireToken(req, res, port) {
  if (!hostOk(req, port)) return deny(res, 'wrong host');
  if (!originOk(req, port)) return deny(res, 'wrong origin');
  const got = Buffer.from(String(req.headers['x-reckon-token'] || ''));
  const want = Buffer.from(TOKEN);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return deny(res, 'no token');
  return true;
}

// The page reads the token from here until phase 0 injects it into index.html.
// A page on another origin cannot read this answer (no CORS header), and one
// that rebinds its name to 127.0.0.1 is refused by the Host check.
function tokenFor(req, res, port) {
  if (!hostOk(req, port) || !originOk(req, port)) { deny(res, 'wrong host'); return null; }
  return TOKEN;
}

const engine = createEngine();

module.exports = {
  ACTIONS, ALLOWED_COMMANDS, PROTECTED_BUNDLES, assertSafe, clean, createEngine,
  requireToken, tokenFor,
  preview: engine.preview, run: engine.run, remember: engine.remember,
};
