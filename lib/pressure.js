'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('./platform');

// ---------------------------------------------------------------------------
// The Pressure tab: decisions about the machine RIGHT NOW, where the unit is
// not gigabytes but SECONDS STOLEN.
//
// Why it is a tab and not a section of Memory: lib/memory.js already reads
// swap, the process groups and the pressure counters, and lib/decisions.js has
// never looked at any of it — every row this tool has ever produced is about
// disk. That gap is not cosmetic.
//
// The machine this was written on had 365 orphaned `yes` processes holding
// 171 MB between them. Ranked by size they are the sixth row, and nobody reads
// the sixth row. Ranked by what they cost, they were the entire story: load
// average 539 on ten cores, and a fixed-work loop that runs in 0.30 s taking
// 6.14 s. Every existing row in this codebase would have stayed silent.
//
// So the house rule is kept exactly — how much it frees, the proof of that
// number, what you lose if the verdict is wrong — and only the currency
// changes. It still never kills anything: it hands you the command.
// ---------------------------------------------------------------------------

const CACHE_DIR = path.join(os.homedir(), '.cache', 'reckon');
const BASELINE = path.join(CACHE_DIR, 'pressure-baseline.json');

const DAY = 86400;
const HOUR = 3600;

// ---------------------------------------------------------------------------
// The probe.
//
// Fixed work, wall-clock timed, compared against the fastest this machine has
// ever run it. The baseline is EARNED, never configured: a threshold somebody
// types into a config file is a threshold nobody believes at 3 a.m., and the
// honest number — "this machine, at its best" — is one the machine can measure
// about itself.
//
// It competes for CPU the way the app you are waiting on does, which is the
// whole point. The 365 processes were `nice`d, so every per-process CPU column
// on the machine reported them as something you should not care about. They
// showed up here at 20x.
// ---------------------------------------------------------------------------
const PROBE_ITERATIONS = 40_000_000;

function probe() {
  const started = process.hrtime.bigint();
  let n = 0;
  for (let i = 0; i < PROBE_ITERATIONS; i++) n = (n + i) % 2147483647;
  // `n` is returned so that a future engine cannot prove the loop dead and
  // delete the thing being measured.
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, guard: n };
}

function baseline(ms) {
  let best = null;
  let since = null;
  try {
    const saved = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    best = typeof saved.bestMs === 'number' ? saved.bestMs : null;
    since = saved.at || null;
  } catch { /* first run, or a cache we may not read: both mean "no baseline" */ }

  if (best == null || ms < best) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(BASELINE, JSON.stringify({ bestMs: ms, at: Date.now() }, null, 2));
    } catch { /* a cache we cannot write must not take the reading down with it */ }
    return { bestMs: ms, fresh: true, since: Date.now() };
  }
  return { bestMs: best, fresh: false, since };
}

// ---------------------------------------------------------------------------
// Rows.
//
// Same shape as lib/decisions.js, and one field it does not have: `costPct`,
// the CPU this row is holding. It is what the tab sorts on, because a row that
// frees 8 MB and returns a core is the row you want at the top.
// ---------------------------------------------------------------------------
function row({ id, title, kb = 0, costPct = 0, proof, lose, command, confidence = 'high' }) {
  return { id, title, kb, mb: Math.round(kb / 1024), costPct: Math.round(costPct), proof, lose, command, confidence };
}

// `comm` sometimes carries arguments — npm rewrites its own process title to
// `npm exec next dev --turbopack -p 3010`. path.basename() on that returns
// "3010", which would title the row after a port number.
const short = (command) => path.basename(String(command).trim().split(/\s+/)[0]);

const human = (s) => (s == null ? 'unknown'
  : s >= DAY ? `${Math.floor(s / DAY)}d${Math.floor((s % DAY) / HOUR)}h`
    : s >= HOUR ? `${Math.floor(s / HOUR)}h${Math.floor((s % HOUR) / 60)}m`
      : `${Math.floor(s / 60)}m`);

// A swarm is identified by SHAPE, not by name. That `yes` is a load generator
// is a fact about one afternoon; "the same executable, orphaned, many times
// over, with no terminal to print to" is a fact about every leaked load
// generator nobody has written yet.
//
// `orphaned && !systemManaged` is doing the heavy lifting and the platform
// owns both halves — see lib/platform/CONTRACT.md, which explains what it cost
// to learn that those are two different questions.
const SWARM_MIN = 8;

function swarms(procs) {
  const byCommand = new Map();
  for (const p of procs) {
    if (!p.orphaned || p.systemManaged || p.tty) continue;
    if (p.ageS != null && p.ageS < HOUR) continue;
    const key = p.command;
    if (!byCommand.has(key)) byCommand.set(key, []);
    byCommand.get(key).push(p);
  }

  const out = [];
  for (const [command, members] of byCommand) {
    if (members.length < SWARM_MIN) continue;
    const costPct = members.reduce((s, p) => s + (p.cpuPct || 0), 0);
    const kb = members.reduce((s, p) => s + p.rssKB, 0);

    // The whole premise of this file is seconds stolen. A swarm that steals no
    // measurable time and holds no meaningful memory has not earned a row,
    // however untidy it looks — and an untidy row somebody learns to scroll
    // past is worse than no row, because it teaches them to scroll past the
    // next one.
    if (costPct < 5 && kb < 200 * 1024) continue;

    const youngest = Math.min(...members.map((p) => (p.ageS == null ? Infinity : p.ageS)));
    out.push(row({
      id: `swarm-${short(command).replace(/\W+/g, '-')}`,
      title: `${members.length} copies of ${short(command)}, orphaned`,
      kb, costPct,
      proof: `${members.length} processes running the same executable, none with a living parent, `
        + `none attached to a terminal, none started by launchd or living in a system directory. `
        + `Youngest has been up ${human(youngest)}. Together they hold ${Math.round(costPct)}% of a core.`,
      lose: 'Nothing that can be named. A process with no parent and no terminal has nowhere to '
        + 'put a result — whatever it was doing, it stopped being able to report it when its shell died.',
      command: `kill ${members.map((p) => p.pid).join(' ')}`,
      confidence: 'high',
    }));
  }
  return out;
}

// An interactive CLI that has not moved in a day has probably finished. It is
// also probably the only copy of a conversation, so this row exists to be READ
// and never to be trusted: `confidence: 'low'`, and a `lose` that says why.
const INTERACTIVE = /(^|\/)(claude|codex|aider|opencode|grok)$/;

function staleSessions(procs, byPid) {
  const stale = procs.filter((p) => {
    if (!INTERACTIVE.test(p.command)) return false;
    if (!p.tty) return false;            // no terminal: not somebody's open window
    if (p.ageS == null || p.ageS < DAY) return false;
    // The lesson that cost the most: a CLI whose parent is a RUNNING app is
    // that app's engine, not a forgotten window. On this machine `claude -p`
    // is the brain of a Notch.app the person is using, and in a process table
    // it is indistinguishable from an idle session.
    const parent = byPid.get(p.ppid);
    return !(parent && /\.app\/Contents\//.test(parent.command));
  });
  if (!stale.length) return [];

  const pids = stale.map((p) => p.pid).join(' ');
  return [row({
    id: 'stale-sessions',
    title: `${stale.length} agent session${stale.length > 1 ? 's' : ''} idle for more than a day`,
    kb: stale.reduce((s, p) => s + p.rssKB, 0),
    costPct: stale.reduce((s, p) => s + (p.cpuPct || 0), 0),
    proof: stale.map((p) => `pid ${p.pid} on ${p.tty}, ${human(p.ageS)} old, ${Math.round(p.rssKB / 1024)} MB`).join(' · '),
    lose: 'The conversation in each one. Age is evidence that nobody typed, and nothing more — '
      + 'it is not evidence that the work finished. This is the one row here to open before you run: '
      + 'look at the terminal tab, then kill.',
    command: `# look first:\nps -o pid,tty,etime,command -p ${stale.map((p) => p.pid).join(',')}\n\nkill ${pids}`,
    confidence: 'low',
  })];
}

// A dev server outlives the shell that started it and then serves a port
// nobody is looking at. The port is what makes the row honest: it names
// exactly what goes dark.
const DEV_SERVER = /(next|vite|webpack|nodemon|rails|artisan|node|npm)/i;

function orphanServers(procs, ports) {
  if (!ports) return [];                 // null means "could not find out"

  const portsOf = new Map();
  for (const { pid, port } of ports) {
    if (!portsOf.has(pid)) portsOf.set(pid, new Set());
    portsOf.get(pid).add(port);
  }

  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }

  // The orphan and the listener are usually NOT the same process, and the first
  // version of this function missed every server that mattered because of it.
  // `npm exec next dev -p 3010` is the orphan; two generations below it a
  // `next-server` holds the socket, with a living parent of its own. Only the
  // root lost its shell, so only the root looks orphaned — and the port, which
  // is the one fact that makes the row safe to act on, lives at the leaf.
  const descendants = (root) => {
    const out = [];
    const stack = [root];
    const seen = new Set([root.pid]);
    while (stack.length) {
      const cur = stack.pop();
      out.push(cur);
      for (const kid of children.get(cur.pid) || []) {
        if (seen.has(kid.pid)) continue;   // a recycled pid must not loop forever
        seen.add(kid.pid);
        stack.push(kid);
      }
    }
    return out;
  };

  const rows = [];
  for (const p of procs) {
    if (!p.orphaned || p.systemManaged) continue;
    if (p.ageS == null || p.ageS <= DAY) continue;
    if (!DEV_SERVER.test(p.command)) continue;

    const tree = descendants(p);

    // The panel is itself a server on a port, and an old one left running is
    // exactly the shape this rule hunts for. Offering `kill` for the process
    // drawing the page is the one recommendation that can never be right, so
    // the tree this process lives in is skipped — and only this one. Another
    // copy of reckon, forgotten on another port eight days ago, is a real find
    // and still appears.
    if (tree.some((q) => q.pid === process.pid)) continue;

    const listening = new Set();
    for (const q of tree) for (const port of portsOf.get(q.pid) || []) listening.add(port);
    if (!listening.size) continue;

    const list = [...listening].sort((a, b) => a - b);
    const shown = list.join(', ');
    const pids = tree.map((q) => q.pid);
    rows.push(row({
      id: `orphan-server-${p.pid}`,
      kb: tree.reduce((sum, q) => sum + q.rssKB, 0),
      costPct: tree.reduce((sum, q) => sum + (q.cpuPct || 0), 0),
      title: `Dev server on port ${shown}, orphaned ${human(p.ageS)} ago`,
      proof: `${short(p.command)} (pid ${p.pid}) has no living parent, so the terminal that started `
        + `it is closed${tree.length > 1 ? `, and it still has ${tree.length - 1} process(es) below it` : ''}. `
        + `Still listening on ${shown} after ${human(p.ageS)}.`,
      lose: `Whatever you have open at localhost:${list[0]}. Nothing on disk: one command starts it again.`,
      // The whole tree, not just the root: killing an `npm exec` wrapper
      // regularly leaves the server it spawned holding the port, and then the
      // row reads as done while nothing changed.
      command: `kill ${pids.join(' ')}`,
      confidence: 'medium',
    }));
  }
  return rows;
}

// Swap is not a row, because there is no command to hand somebody: you do not
// "free" swap, you stop asking for memory. It is a headline, and the counters
// behind it are the proof that the machine has been suffering rather than a
// reading of how it is right now.
function swapHeadline(swap) {
  // `swapStats()` answers in MB. The contract says so in bold — "converting
  // twice is how a number ends up a thousand times too big" — and the first
  // draft of this function read `.usedKB`, got undefined, and rendered no swap
  // headline at all on a machine sitting at 87%.
  if (!swap || !swap.totalMB) return null;
  const share = swap.usedMB / swap.totalMB;
  return {
    usedMB: swap.usedMB, totalMB: swap.totalMB, share,
    strained: share > 0.8,
    note: share > 0.8
      ? 'Swap is nearly full. Every window you return to has to be decompressed before it can draw, '
        + 'which is the pause you feel when an app you left alone comes back.'
      : null,
  };
}

async function collect() {
  const [procs, swap, ports] = await Promise.all([
    platform.processList(),
    platform.swapStats(),
    platform.listeningPorts(),
  ]);
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  // The probe runs LAST, after the readings. It is the only thing in this file
  // that deliberately burns CPU, and a reading taken while it runs would be a
  // reading of this tool.
  const measured = probe().ms;
  const base = baseline(measured);

  const rows = [...swarms(procs), ...staleSessions(procs, byPid), ...orphanServers(procs, ports)]
    .sort((a, b) => b.costPct - a.costPct || b.kb - a.kb);

  return {
    probe: {
      nowMs: Math.round(measured),
      bestMs: Math.round(base.bestMs),
      // The headline number. 1.0 is this machine at its best; the afternoon
      // that produced this file read 20.5.
      factor: +(measured / base.bestMs).toFixed(1),
      fresh: base.fresh,
      since: base.since,
    },
    swap: swapHeadline(swap),
    // Named so a screen can say WHICH reading did not happen, rather than
    // drawing an empty list that looks like good news.
    portsKnown: ports !== null,
    processCount: procs.length,
    rows,
    at: Date.now(),
  };
}

module.exports = { collect, probe, swarms, staleSessions, orphanServers, swapHeadline };
