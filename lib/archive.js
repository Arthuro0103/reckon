'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('./platform');
const aitools = require('./aitools');
const { ancestorsOfSelf } = require('./memory');

// ---------------------------------------------------------------------------
// Archiving idle Claude Code sessions.
//
// The owner decided on 2026-11-24 that this one thing may happen without a
// click, and only when the owner starts it (`reckon archive --run` or `--every`): a
// Claude Code session nobody touched for 15 minutes is ended with a polite stop
// (SIGTERM), its conversation stays on disk, and `claude --resume <id>` brings
// it back. It frees the 200 to 300 MB each idle session holds.
//
// This file only READS. It judges; lib/act.js runs the stop, from its table,
// after judging again with these same functions on a fresh process list.
//
// Where the sessions come from: Claude Code writes ~/.claude/sessions/<pid>.json
// for every live session (pid, sessionId, cwd, startedAt). That covers the
// sessions with no terminal too (Orca chats, desktop), which lib/aitools.js
// cannot measure and never offers.
//
// A session is archived only when ALL of these hold, and every rule refuses
// rather than guesses:
//   - its record names a live process that is the same claude process (same
//     executable, started at most 15 s before the record says): a recycled pid
//     is refused;
//   - it is an interactive session a person started (entry point cli or orca,
//     never an SDK script), and it is not reckon nor anything reckon
//     runs inside, nor on reckon's terminal;
//   - a terminal session (entry point cli) says, in its record, that it is
//     idle: busy means a tool call or an MCP answer is still in flight;
//   - it started at least the idle threshold ago;
//   - its conversation is on disk: ~/.claude/projects/<folder>/<sessionId>.jsonl
//     exists. Without it the session could not be proven resumable;
//   - that file, and everything under ~/.claude/projects/<folder>/<sessionId>/
//     (its subagents write there), was last modified at least the threshold
//     ago. Modification times only: no transcript is ever opened;
//   - if it has a terminal, the terminal was neither read nor written for the
//     threshold either (someone may be typing);
//   - the claude process used under 2% of a core in this reading;
//   - no child process except its own idle tool servers (the same rule as
//     lib/aitools.js) and the stdin helper Orca gives each chat. A shell, a
//     build, a test runner, anything else: it is still working.
// ---------------------------------------------------------------------------

const MIN = 60;
const DEFAULT_IDLE_S = 15 * MIN;
const IDLE_FLOOR_S = 5 * MIN;
const SESSION_MAX_CPU = 2;
const START_SLACK_MS = 1000;   // ps reads start times to the second
const RECORD_LAG_MS = 15000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The one helper allowed as a child: Orca's stdin relay, a leaf process.
const ORCA_HELPER = /(^|\/)orca-provider-exec$/;
// Entry points a person types into. Anything else (an SDK script) is never archived.
const PERSON_ENTRYPOINTS = new Set(['cli', 'orca']);

const human = (s) => (s == null ? 'unknown' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const resumeOf = (cwd, sessionId) => `cd ${quote(cwd)} && claude --resume ${sessionId}`;

// The records Claude Code keeps per live session. Malformed ones are dropped, not guessed at.
function readRecords(home) {
  const dir = path.join(home, '.claude', 'sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { return e && e.code === 'ENOENT' ? [] : null; }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let j;
    try {
      const st = fs.lstatSync(path.join(dir, n));
      if (!st.isFile() || st.size > 64 * 1024) continue;
      j = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
    } catch { continue; }
    if (!j || !Number.isInteger(j.pid) || j.pid <= 1 || `${j.pid}.json` !== n) continue;
    if (typeof j.sessionId !== 'string' || !SESSION_ID.test(j.sessionId)) continue;
    if (typeof j.cwd !== 'string' || !path.isAbsolute(j.cwd)) continue;
    out.push({ pid: j.pid, sessionId: j.sessionId, cwd: j.cwd, kind: j.kind || null, entrypoint: j.entrypoint || null,
      status: typeof j.status === 'string' ? j.status : null,
      procStart: typeof j.procStart === 'string' ? j.procStart : null,
      startedAt: Number.isFinite(j.startedAt) ? j.startedAt : null });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// The newest modification time of the conversation: its .jsonl and its own folder (subagents).
function conversationAt(home, cwd, sessionId) {
  const dir = aitools.projectDir(home, cwd);
  const file = path.join(dir, `${sessionId}.jsonl`);
  let at;
  try { const s = fs.lstatSync(file); if (!s.isFile()) return null; at = s.mtimeMs; } catch { return null; }
  const sub = aitools.newestTranscript(path.join(dir, sessionId));
  if (sub && sub.at > at) at = sub.at;
  return { at, file, dirShown: `~/.claude/projects/${path.basename(dir)}` };
}

function defaultProbe() {
  return {
    now: Date.now,
    home: () => os.homedir(),
    records: () => readRecords(os.homedir()),
    conversationAt: (home, cwd, id) => conversationAt(home, cwd, id),
    ttyTouchedAt: (tty) => platform.ttyActivity(tty),
    argsOf: (pids) => platform.processArgs(pids),
    ports: () => platform.listeningPorts(),
  };
}

// One record, one answer: { archive: true, facts } or { skip: why }. Never throws.
async function judge(rec, list, probe, { idleS = DEFAULT_IDLE_S, selfPid = process.pid } = {}) {
  if (!rec || !Number.isInteger(rec.pid)) return { skip: 'No session record.' };
  const byPid = new Map(list.map((x) => [x.pid, x]));
  const p = byPid.get(rec.pid);
  if (!p) return { skip: `pid ${rec.pid} is not running: the record is stale.` };
  if (aitools.toolOf(p.command) !== 'claude') return { skip: `pid ${rec.pid} is not a claude process now.` };
  // The record's startedAt (epoch ms) is written by the process itself, 0.4 to 4 s after it
  // started (measured 2026-11-24 on 11 sessions). Its procStart text is not used: it is printed
  // in another time zone than `ps` reads, three hours off on the owner's machine.
  const lag = rec.startedAt != null && p.startedAt != null ? rec.startedAt - p.startedAt : NaN;
  if (!(lag >= -START_SLACK_MS && lag <= RECORD_LAG_MS)) {
    return { skip: `pid ${rec.pid} does not have the start time its record says: it may be a recycled pid. Cannot judge.` };
  }
  if (rec.kind !== 'interactive') return { skip: `It is ${rec.kind ? `a ${rec.kind}` : 'an unlabelled'} session, not an interactive one.` };
  // A script drives an SDK session (sdk-py, sdk-cli...): stopping it would break the script, not free a forgotten tab.
  if (!PERSON_ENTRYPOINTS.has(rec.entrypoint)) return { skip: `It was started by ${rec.entrypoint || 'an unknown entry point'}, not by a person in a terminal or in Orca.` };
  // A terminal session reports its own state: anything but "idle" (a tool call in flight, an
  // MCP server still answering, a scheduled wake-up) keeps it. Orca chats report "busy" for
  // their whole life (measured 2026-11-24 on 3 chats), so for them this says nothing.
  if (rec.entrypoint === 'cli' && rec.status !== 'idle') return { skip: `It says it is ${rec.status || 'in an unknown state'}, not idle.` };
  const forbidden = ancestorsOfSelf(list, selfPid);
  forbidden.add(selfPid);
  if (forbidden.has(p.pid)) return { skip: 'It is reckon itself or runs it.' };
  const self = byPid.get(selfPid);
  if (p.tty && self && self.tty === p.tty) return { skip: 'It is on the same terminal as reckon.' };

  const now = probe.now();
  const facts = { pid: p.pid, startedAt: p.startedAt, comm: p.command, sessionId: rec.sessionId, cwd: rec.cwd,
    entrypoint: rec.entrypoint, tty: p.tty || null, rssKB: p.rssKB || 0, ageS: p.ageS,
    resume: resumeOf(rec.cwd, rec.sessionId) };
  if (p.ageS == null || p.ageS < idleS) return { skip: `It started ${human(p.ageS)} ago.`, facts };

  const conv = await probe.conversationAt(probe.home(), rec.cwd, rec.sessionId);
  if (!conv || conv.at == null) return { skip: 'Its conversation file was not found, so it cannot be proven resumable. Cannot judge.', facts };
  facts.dirShown = conv.dirShown;
  facts.idleS = Math.max(0, Math.floor((now - conv.at) / 1000));
  if (facts.idleS < idleS) return { skip: `Its conversation was written ${human(facts.idleS)} ago.`, facts };

  if (p.tty) {
    const touched = await probe.ttyTouchedAt(p.tty);
    if (touched == null) return { skip: `Its terminal (/dev/${p.tty}) could not be read. Cannot judge.`, facts };
    facts.ttyIdleS = Math.max(0, Math.floor((now - touched) / 1000));
    if (facts.ttyIdleS < idleS) return { skip: `Its terminal was used ${human(facts.ttyIdleS)} ago.`, facts };
  }
  if (typeof p.cpuPct !== 'number' || !Number.isFinite(p.cpuPct)) return { skip: 'How busy it is could not be read. Cannot judge.', facts };
  if (p.cpuPct >= SESSION_MAX_CPU) return { skip: `It used ${Math.round(p.cpuPct)}% of a core in this reading: it is working.`, facts };

  // Children. Orca's leaf stdin helper is set aside; everything else must be an idle tool server.
  const helpers = new Set(list.filter((x) => x.ppid === p.pid && ORCA_HELPER.test(x.command) && !list.some((y) => y.ppid === x.pid)).map((x) => x.pid));
  const view = list.filter((x) => !helpers.has(x.pid));
  facts.helpers = [...helpers].map((pid) => { const h = byPid.get(pid); return { pid, comm: h.command, startedAt: h.startedAt }; });
  facts.tools = [];
  if (view.some((x) => x.ppid === p.pid)) {
    const desc = aitools.treeOf(p, view).slice(1);
    const c = aitools.onlyToolChildren(p.pid, view, { args: await probe.argsOf(desc.map((d) => d.pid)), ports: await probe.ports(), forbidden });
    if (!c.ok) return { skip: c.why.replace(/ (Cannot judge, so )?[Nn]o button\./, ' Not archived.'), facts };
    facts.tools = c.tools;
  }
  return { archive: true, facts };
}

// Every live session, judged. Ports are read once per pass.
async function survey(list, probe = defaultProbe(), opts = {}) {
  let portsRead = null;
  const once = { ...probe, ports: () => (portsRead = portsRead || Promise.resolve(probe.ports())) };
  const out = [];
  const recs = await probe.records();
  if (recs == null) return null;
  for (const rec of recs) out.push({ rec, ...(await judge(rec, list, once, opts)) });
  return out;
}

function proofOf(f) {
  return `pid ${f.pid}, claude, session ${f.sessionId}, started ${human(f.ageS)} ago, ${Math.round(f.rssKB / 1024)} MB resident. `
    + `Its conversation in ${f.dirShown}/ was last written ${human(f.idleS)} ago (modification time only; it was not opened). `
    + (f.tty ? `Its terminal /dev/${f.tty} was last used ${human(f.ttyIdleS)} ago. ` : 'It has no terminal. ')
    + (f.tools.length ? `${aitools.toolsSentence(f.tools)}. ` : 'No child process but its own stdin helper, if any. ');
}

const parseIdle = (min) => {
  const n = Number(min);
  if (!Number.isFinite(n)) return null;
  const s = Math.round(n * 60);
  return s >= IDLE_FLOOR_S ? s : null;
};

module.exports = {
  DEFAULT_IDLE_S, IDLE_FLOOR_S, SESSION_MAX_CPU, SESSION_ID, ORCA_HELPER, PERSON_ENTRYPOINTS,
  readRecords, conversationAt, defaultProbe, judge, survey, proofOf, resumeOf, parseIdle, human,
};
