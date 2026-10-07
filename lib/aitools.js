'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const platform = require('./platform');
const { ancestorsOfSelf } = require('./memory');

// ---------------------------------------------------------------------------
// Memory held by AI tools, for people who work with them all day. Three rows:
//
//   1. an idle AI session (claude, codex, aider, opencode, grok) in a terminal
//      nobody has touched for hours;
//   2. MCP and tool servers whose session is gone (parent died, ppid 1);
//   3. a local model Ollama keeps resident.
//
// This file only READS. Every row it builds is judged here, and judged AGAIN by
// lib/act.js at the click with the very same functions, so the preview and the
// run can never disagree about what "idle" means. The owner decided on
// 2026-10-07 that ending an idle session is a button; what makes a session
// idle is written below, and every rule refuses rather than guesses:
//
//   never offered, whatever else holds:
//     - reckon itself, and every process it runs inside (its terminal, its
//       shell, the agent that started it), and anything on reckon's terminal;
//     - a CLI whose parent is a running app (it is that app's engine);
//     - a process with no terminal (idleness cannot be measured);
//   offered only when ALL of these hold, at the preview and at the click:
//     - older than 6 hours;
//     - no live child process, except its own idle MCP / tool servers (decided
//       by the owner on 2026-10-07: a claude with MCP configured always has
//       them). Every descendant, at any depth, must be recognised by its
//       command line as a tool server (onlyToolChildren below), listen on no
//       port, use under 1% of a core and be up for 10 minutes or more. Anything
//       else in the tree (a shell, a build, git, a test runner, a dev server, a
//       compiler, an unrecognised python) means it is still running something:
//       no button, and the refusal names that process by its command name only,
//       never its arguments. A tree that cannot be measured is no button;
//     - its terminal device was neither read nor written for more than 2 hours;
//     - claude only: the newest transcript for its working folder under
//       ~/.claude/projects/ was not modified for more than 2 hours. Only the
//       file's modification time is read (stat), never its contents. A session
//       whose transcript cannot be found is not offered: the conversation could
//       not be proven to be on disk, so it could not be proven resumable.
//   Other tools stay copy-only ("cannot judge"): reckon does not know where they
//   keep a conversation per session.
// ---------------------------------------------------------------------------

const HOUR = 3600;
const DAY = 86400;
const SESSION_MIN_AGE_S = 6 * HOUR;
const TTY_IDLE_S = 2 * HOUR;
const TRANSCRIPT_IDLE_S = 2 * HOUR;
const TOOL_MIN_AGE_S = HOUR;
const TOOL_CHILD_MIN_AGE_S = 10 * 60;
const TOOL_CHILD_MAX_CPU = 1;

const INTERACTIVE = /(^|\/)(claude|codex|aider|opencode|grok)$/;
const toolOf = (comm) => { const m = INTERACTIVE.exec(String(comm || '').trim()); return m ? m[2] : null; };

const mbOf = (kb) => Math.round((kb || 0) / 1024);
const human = (s) => (s == null ? 'unknown'
  : s >= DAY ? `${Math.floor(s / DAY)}d${Math.floor((s % DAY) / HOUR)}h`
    : s >= HOUR ? `${Math.floor(s / HOUR)}h${Math.floor((s % HOUR) / 60)}m`
      : `${Math.floor(s / 60)}m`);
// A folder in a command a person copies: single-quoted, so a space or a $ in it stays text.
const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';

// Who a pid IS: its executable and when it started. lib/act.js refuses a pid that comes back
// with either one changed.
const identity = (p, now) => ({ pid: p.pid, comm: p.command,
  startedAt: p.startedAt != null ? p.startedAt : p.ageS == null ? null : now - p.ageS * 1000 });

// The same row shape as lib/pressure.js and lib/memory.js. `low` rows never carry an action.
function row({ id, title, kb = 0, costPct = 0, proof, lose, command, confidence, action = null, target = null, extra = {} }) {
  return { id, title, kb, mb: mbOf(kb), costPct: Math.round(costPct || 0), proof, lose, command, confidence, ...extra,
    ...(action && confidence !== 'low' ? { action, target } : {}) };
}

// Is this executable somewhere on PATH? A plain fs lookup: nothing is run.
function onPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transcripts. Claude Code keeps the conversations started in a folder under
// ~/.claude/projects/<that folder, every character that is not a letter or a
// digit turned into "-">. Only names and modification times are read here:
// readdir and stat, never open. Links are not followed (a Dirent of a link is
// neither a file nor a folder).
// ---------------------------------------------------------------------------
function projectDir(home, cwd) {
  return path.join(home, '.claude', 'projects', String(cwd).replace(/[^A-Za-z0-9]/g, '-'));
}

function newestTranscript(dir) {
  let newest = null, count = 0, seen = 0;
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > 5000) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      try { const s = fs.statSync(p); count++; if (newest == null || s.mtimeMs > newest) newest = s.mtimeMs; } catch { /* gone */ }
    }
  };
  walk(dir, 0);
  return newest == null ? null : { at: newest, count };
}

// ---------------------------------------------------------------------------
// Ollama's own list of loaded models. ONE fixed address on this machine:
// http://127.0.0.1:11434/api/ps. The host is a constant and is never read from
// anywhere; no redirect is followed (anything but 200 is "could not find out");
// two seconds at most; one megabyte at most. `_testPort` exists for bin/check.js,
// which points it at a fake server it started itself; nothing in production
// passes it, and the check fails if anything does.
// ---------------------------------------------------------------------------
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;
const OLLAMA_PATH = '/api/ps';
const OLLAMA_URL = 'http://127.0.0.1:11434/api/ps';
const OLLAMA_TIMEOUT_MS = 2000;
// What a model name may be before it is passed to `ollama stop` as one argv entry: starts
// with a letter or digit (so never an option), then letters, digits and . _ : / - only.
const OLLAMA_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const validModelName = (n) => typeof n === 'string' && OLLAMA_NAME.test(n) && !n.includes('..') && !n.includes('//');

function ollamaLoaded({ _testPort } = {}) {
  const port = _testPort == null ? OLLAMA_PORT : _testPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); if (req) req.destroy(); resolve(v); };
    const timer = setTimeout(() => finish(null), OLLAMA_TIMEOUT_MS);
    try {
      req = http.request({ host: OLLAMA_HOST, port, path: OLLAMA_PATH, method: 'GET', agent: false,
        headers: { accept: 'application/json' }, timeout: OLLAMA_TIMEOUT_MS }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size > 1048576) finish(null); else chunks.push(c); });
        res.on('error', () => finish(null));
        res.on('end', () => {
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!j || !Array.isArray(j.models)) return finish(null);
            finish(j.models.slice(0, 50).map((m) => ({
              name: typeof m.name === 'string' ? m.name : null,
              size: Number.isFinite(+m.size) ? +m.size : null,
              sizeVram: Number.isFinite(+m.size_vram) ? +m.size_vram : null,
              expiresAt: typeof m.expires_at === 'string' ? m.expires_at.slice(0, 40) : null,
              digest: typeof m.digest === 'string' ? m.digest.slice(0, 64) : null,
            })));
          } catch { finish(null); }
        });
      });
      req.on('timeout', () => finish(null));
      req.on('error', () => finish(null));
      req.end();
    } catch { finish(null); }
  });
}

// The readings this file needs, each replaceable so a test can hand in a fake machine.
function defaultProbe() {
  return {
    now: Date.now,
    home: () => os.homedir(),
    ttyTouchedAt: (tty) => platform.ttyActivity(tty),
    cwdOf: (pid) => platform.processCwd(pid),
    newestTranscript: (dir) => newestTranscript(dir),
    argsOf: (pids) => platform.processArgs(pids),
    ports: () => platform.listeningPorts(),
    ollamaLoaded: () => ollamaLoaded(),
    which: (name) => onPath(name),
  };
}

// ---------------------------------------------------------------------------
// 1. Idle AI sessions.
// judgeSession() answers one of three ways:
//   { skip }              not a row at all: never offered, or not idle
//   { offer: false, why } a row, copy-only: idle-looking, but something cannot be proven
//   { offer: true }       a row with a button
// ---------------------------------------------------------------------------
async function judgeSession(p, list, probe, selfPid = process.pid) {
  const tool = p && toolOf(p.command);
  if (!tool) return { skip: 'It is not an AI command-line tool.' };
  const forbidden = ancestorsOfSelf(list, selfPid);
  forbidden.add(selfPid);
  if (forbidden.has(p.pid)) return { skip: 'It is reckon itself or runs it (its terminal, its shell, the agent that started it).' };
  const byPid = new Map(list.map((x) => [x.pid, x]));
  const parent = byPid.get(p.ppid);
  // A CLI whose parent is a RUNNING app is that app's engine, not a forgotten window.
  if (parent && /\.app\/Contents\//.test(parent.command)) return { skip: 'Its parent is a running app: it is that app\'s engine.' };
  if (!p.tty) return { skip: 'It has no terminal, so how long since anyone used it cannot be measured.' };
  const self = byPid.get(selfPid);
  if (self && self.tty && self.tty === p.tty) return { skip: 'It is on the same terminal as reckon.' };
  if (p.ageS == null || p.ageS < SESSION_MIN_AGE_S) return { skip: 'It started less than 6 hours ago.' };

  const now = probe.now();
  const facts = { tool, pid: p.pid, tty: p.tty, ageS: p.ageS, rssKB: p.rssKB || 0 };
  const touched = await probe.ttyTouchedAt(p.tty);
  facts.ttyIdleS = touched == null ? null : Math.max(0, Math.floor((now - touched) / 1000));
  if (facts.ttyIdleS != null && facts.ttyIdleS < TTY_IDLE_S) return { skip: `Its terminal was used ${human(facts.ttyIdleS)} ago.`, facts };
  // Children: only its own idle MCP / tool servers are allowed, and the whole tree is judged.
  facts.tools = [];
  if (list.some((x) => x.ppid === p.pid)) {
    const desc = treeOf(p, list).slice(1);
    const c = onlyToolChildren(p.pid, list, { args: await probe.argsOf(desc.map((d) => d.pid)), ports: await probe.ports(), forbidden });
    if (!c.ok) return { offer: false, facts, why: c.why };
    facts.tools = c.tools;
  }
  if (facts.ttyIdleS == null) {
    return { offer: false, facts, why: `Its terminal (/dev/${p.tty}) could not be read, so how long since anyone typed in it, or it printed, cannot be measured. Cannot judge, so no button.` };
  }
  if (tool !== 'claude') {
    return { offer: false, facts, why: `reckon does not know where ${tool} keeps a conversation per session, so it cannot prove this one is saved. Cannot judge, so no button.` };
  }
  const cwd = await probe.cwdOf(p.pid);
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return { offer: false, facts, why: 'Its working folder could not be read, so its transcript cannot be found. Cannot judge, so no button.' };
  }
  facts.cwd = cwd;
  facts.dir = projectDir(probe.home(), cwd);
  facts.dirShown = `~/.claude/projects/${path.basename(facts.dir)}`;
  facts.resume = `cd ${quote(cwd)} && claude --resume`;
  const t = await probe.newestTranscript(facts.dir);
  if (!t || t.at == null) {
    return { offer: false, facts, why: `No transcript was found in ${facts.dirShown}, so the conversation cannot be proven to be on disk, or resumable. No button.` };
  }
  facts.transcriptIdleS = Math.max(0, Math.floor((now - t.at) / 1000));
  facts.transcripts = t.count;
  if (facts.transcriptIdleS < TRANSCRIPT_IDLE_S) return { skip: `A transcript in its folder was written ${human(facts.transcriptIdleS)} ago.`, facts };
  return { offer: true, facts };
}

function sessionProof(f) {
  return `pid ${f.pid}, ${f.tool}, started ${human(f.ageS)} ago, ${mbOf(f.rssKB)} MB resident. `
    + (f.ttyIdleS == null ? `Its terminal /dev/${f.tty} could not be read. ` : `Its terminal /dev/${f.tty} was last read or written ${human(f.ttyIdleS)} ago. `)
    + (f.transcriptIdleS != null
      ? `${childrenProof(f.tools)} The newest of ${f.transcripts} transcript(s) in ${f.dirShown} was modified ${human(f.transcriptIdleS)} ago (its modification time only: reckon does not open it).`
      : '');
}

function childrenProof(tools) {
  if (!tools || !tools.length) return 'No child process.';
  return `Its only child processes are its own tool servers: ${toolsSentence(tools)}, each recognised by its command line, `
    + 'listening on no port, under 1% of a core and up 10 minutes or more.';
}

function sessionLose(f) {
  const tools = f.tools || [];
  return 'The running process and whatever lives only in it: text typed but not sent, a tool call in flight. '
    + `The conversation itself stays on disk in ${f.dirShown}/, and it comes back with \`${f.resume}\` (pick it from the list). `
    + (tools.length ? `${toolsSentence(tools)}: they exit with it, or are left orphaned; an orphaned one is offered later by the orphaned tool servers row (once it is an hour old and nothing else sits on its terminal), with a button of its own. ` : '')
    + 'Its shell and its terminal tab are not touched.';
}

async function idleSessions(procs, probe = defaultProbe(), selfPid = process.pid) {
  const rows = [];
  const now = probe.now();
  // Listening ports are read once for every session in this reading, not once per session.
  let portsRead = null;
  const once = { ...probe, ports: () => (portsRead = portsRead || Promise.resolve(probe.ports())) };
  for (const p of procs) {
    if (!toolOf(p.command)) continue;
    const j = await judgeSession(p, procs, once, selfPid);
    if (j.skip) continue;
    const f = j.facts;
    const idle = j.offer ? Math.min(f.ttyIdleS, f.transcriptIdleS) : null;
    rows.push(row({
      id: `ai-session-${p.pid}`,
      title: `${f.tool} session on ${f.tty}, ${human(f.ageS)} old${j.offer ? `, idle ${human(idle)}` : ''}`,
      kb: f.rssKB, costPct: p.cpuPct,
      proof: sessionProof(f) + (j.offer ? '' : ` ${j.why}`),
      lose: j.offer ? sessionLose(f)
        : `Possibly the only copy of a conversation. ${j.why} Look at the terminal tab before you run anything.`,
      command: j.offer
        ? `kill -TERM ${p.pid}\n\n# to come back to the conversation later:\n${f.resume}`
        : `# look first:\nps -o pid,tty,etime,command -p ${p.pid}\n\nkill -TERM ${p.pid}`,
      confidence: j.offer ? 'medium' : 'low',
      action: { id: 'end-ai-session', label: 'End the session' },
      target: j.offer ? { kind: 'ai-session', tool: f.tool, tty: f.tty, cwd: f.cwd, dirShown: f.dirShown, resume: f.resume,
        pid: identity(p, now), tools: f.tools.map((t) => ({ ...identity({ pid: t.pid, command: t.comm, startedAt: t.startedAt, ageS: t.ageS }, now), label: t.label })),
        lose: sessionLose(f) } : null,
      extra: { resume: f.resume || null },
    }));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 2. Orphaned MCP and tool servers. Recognised by SHAPE and by command line:
// the root's parent is gone (ppid 1), it was not started by launchd and does not
// live in an app, it is older than an hour, its command line names an MCP
// server, npx/uvx, or a language server, nothing else sits on its terminal (the
// session that started it is gone), and nothing in its tree listens on a port
// (a port is a client reckon cannot see; it would have to be explained first).
// The command line is matched and dropped: only a tool name is kept.
// ---------------------------------------------------------------------------
// What names a tool server. TOOL_LINE is the same set plus "something npx / uvx runs", which is
// enough for an orphan (its session is gone) but not for a child of a live session: there, npx
// and uvx count only when what they run is itself named as a tool server (recognisedTool below).
const TOOL_NAME = /modelcontextprotocol|(^|[^a-z])mcp|mcp([^a-z]|$)|language-?server|langserver|(^|[^a-z])lsp([^a-z]|$)|tsserver|pyright|gopls|rust-analyzer|clangd|jdtls/i;
const TOOL_LINE = new RegExp(`${TOOL_NAME.source}|(^|[\\s/])(npx|uvx)(\\s|$)|npm exec`, 'i');
const TOOL_SEGMENT = /modelcontextprotocol|mcp|language-?server|langserver|lsp|tsserver|pyright|gopls|rust-analyzer|clangd|jdtls/i;

// A short, safe name for the group: the path segment that names the tool, never a whole path.
function toolLabel(args, comm) {
  const clean = (s) => String(s).replace(/@[\d][\w.-]*$/, '').replace(/[^A-Za-z0-9@._-]/g, '').slice(0, 48);
  const toks = String(args || '').split(/\s+/).filter(Boolean);
  const mcpPkg = toks.map((t) => /@modelcontextprotocol\/([\w.-]+)/.exec(t)).find(Boolean);
  if (mcpPkg) return clean(`mcp ${mcpPkg[1]}`.replace(' ', '-'));
  for (const t of toks) {
    const seg = t.split('/').reverse().find((s) => TOOL_SEGMENT.test(s) && !/^(node_modules|\.bin|dist|lib|src|build)$/.test(s));
    if (seg) return clean(seg) || 'tool server';
  }
  const i = toks.findIndex((t) => /(^|\/)(npx|uvx)$/.test(t));
  if (i >= 0) { const pkg = toks.slice(i + 1).find((t) => !t.startsWith('-')); if (pkg) return clean(pkg.split('/').pop()) || 'tool server'; }
  return clean(path.basename(String(comm || '').split(/\s+/)[0])) || 'tool server';
}

function treeOf(root, procs) {
  const children = new Map();
  for (const p of procs) { if (!children.has(p.ppid)) children.set(p.ppid, []); children.get(p.ppid).push(p); }
  const out = [], stack = [root], seen = new Set([root.pid]);
  while (stack.length) {
    const cur = stack.pop();
    out.push(cur);
    for (const k of children.get(cur.pid) || []) { if (seen.has(k.pid)) continue; seen.add(k.pid); stack.push(k); }
  }
  return out;
}

// Is the session that started this tree really gone? Nothing outside the tree may sit on
// its terminal: a shell still there is a terminal somebody has open.
const sessionGone = (root, tree, procs) => !root.tty || !procs.some((x) => x.tty === root.tty && !tree.some((t) => t.pid === x.pid));

// ---------------------------------------------------------------------------
// The children of a LIVE session. Stricter than an orphan's root: only what
// actually runs is looked at, never a folder somebody named for a project of
// their own. `node ~/www/mcp-tools/scripts/build.js` is a build, not a tool
// server; `node …/node_modules/.bin/mcp-server-x`, `npx -y @scope/thing-mcp`,
// `uvx mcp-server-fetch`, `python -m mcp_server_git`, `gopls` are.
// A shell counts only as the wrapper npm puts between npx and the server
// (`sh -c mcp-server-x <args>`): one plain command, no ; | & $ ` < > ( ) or
// quotes. Anything that does not parse into one of these shapes is
// unrecognised, and unrecognised refuses.
// ---------------------------------------------------------------------------
const INTERPRETER = /^(node|nodejs|bun|deno|python[0-9.]*|pypy[0-9.]*)$/;
const LAUNCHER = /^(npx|bunx|pnpx|uvx)$/;
const RUNNER = /^(npm|pnpm|yarn|uv|pipx)$/;
const RUNNER_VERB = new Set(['exec', 'x', 'dlx', 'run', 'tool']);
const SHELL = /^-?(sh|bash|zsh|dash|ksh|fish|tcsh|csh)$/;
const SHELL_META = /[;&|`$<>(){}\\'"*?!\n]/;
const ENTRY_FILE = /^(index|main|server|cli)\.[cm]?[jt]s$/;
const ENTRY_DIR = /^(dist|build|lib|src|out|bin)$/;

// The part of a token that names what runs. A bare name or a package spec is itself; a path is
// what follows its last node_modules/, or its file name, or, for an entry file such as
// dist/index.js, the package folder that holds it.
function namePart(tok) {
  const t = String(tok);
  if (!/^[/.~]/.test(t)) return t;
  const nm = t.lastIndexOf('node_modules/');
  if (nm >= 0) return t.slice(nm + 'node_modules/'.length);
  const parts = t.split('/').filter(Boolean);
  const base = parts[parts.length - 1] || '';
  if (!ENTRY_FILE.test(base)) return base;
  const parent = parts[parts.length - 2] || '';
  return ENTRY_DIR.test(parent) ? `${parts[parts.length - 3] || ''}/${parent}/${base}` : `${parent}/${base}`;
}

// Is this command line a recognised tool server? true or false, nothing in between.
function recognisedTool(line) {
  const toks = String(line || '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  for (let hop = 0; hop < 6 && i < toks.length; hop++) {
    const base = path.basename(toks[i]).toLowerCase();
    if (SHELL.test(base)) {
      if (toks[i + 1] !== '-c' || toks.length < i + 3 || SHELL_META.test(toks.slice(i + 2).join(' '))) return false;
      i += 2; continue;
    }
    if (INTERPRETER.test(base)) {
      i++;
      if ((base === 'deno' || base === 'bun') && toks[i] === 'run') i++;
      while (i < toks.length && toks[i].startsWith('-')) { if (toks[i++] === '-m') break; }
      continue;
    }
    if (LAUNCHER.test(base) || RUNNER.test(base)) {
      i++;
      while (i < toks.length && (toks[i].startsWith('-') || (RUNNER.test(base) && RUNNER_VERB.has(toks[i])))) i++;
      continue;
    }
    return TOOL_NAME.test(namePart(toks[i]));
  }
  return false;
}

// A process's command NAME, for a sentence: never a path, never an argument.
function commandName(comm) {
  const c = String(comm || '').trim();
  const exe = /\.app\/Contents\/MacOS\//.test(c) ? c : c.split(/\s+/)[0];
  return path.basename(exe).replace(/[^A-Za-z0-9 ._+-]/g, '').slice(0, 40) || 'unknown';
}

// May this session be ended although it has children? Only when EVERY descendant, at any
// depth, is a recognised tool server whose parent chain stays inside the session's tree, that
// listens on no port, uses under 1% of a core in this reading and is up 10 minutes or more.
// Pure: the process list, the command lines (`args`, { pid: line } or null when unread) and the
// listening ports (null when unread) are handed in. Answers { ok: true, tools } or
// { ok: false, why }. `why` names a process by its command name and pid, never its arguments.
function onlyToolChildren(pid, procs, { args, ports, forbidden = new Set() } = {}) {
  const root = (procs || []).find((p) => p.pid === pid);
  if (!root) return { ok: false, why: 'The session is not in the process list. Cannot judge, so no button.' };
  const desc = treeOf(root, procs).slice(1).sort((a, b) => a.pid - b.pid);
  if (!desc.length) return { ok: true, tools: [] };
  const n = desc.length;
  const kids = `${n} child process${n > 1 ? 'es' : ''}`;
  if (!args || typeof args !== 'object') return { ok: false, why: `The command lines of its ${kids} could not be read, so they cannot be proven to be idle tool servers. Cannot judge, so no button.` };
  if (ports == null) return { ok: false, why: `Listening ports could not be read, so its ${kids} cannot be proven idle. Cannot judge, so no button.` };
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const inTree = new Set([pid, ...desc.map((d) => d.pid)]);
  const who = (d) => `${commandName(d.command)} (pid ${d.pid})`;
  const tools = [];
  for (const d of desc) {
    if (forbidden.has(d.pid)) return { ok: false, why: `Its child process ${who(d)} is reckon itself or runs it. No button.` };
    let cur = d, steps = 0;
    while (cur && cur.pid !== pid) {
      if (!inTree.has(cur.ppid) || ++steps > n) return { ok: false, why: `Its child process ${who(d)} has a parent outside the session. Cannot judge, so no button.` };
      cur = byPid.get(cur.ppid);
    }
    const line = args[d.pid];
    if (typeof line !== 'string' || !line.trim()) return { ok: false, why: `The command line of its child process ${who(d)} could not be read, so it cannot be proven to be an idle tool server. Cannot judge, so no button.` };
    if (!recognisedTool(line)) return { ok: false, why: `It has a child process that is not a recognised MCP or tool server: ${who(d)}. It is still running something, so it is not idle. No button.` };
    tools.push({ pid: d.pid, comm: d.command, startedAt: d.startedAt != null ? d.startedAt : null, ageS: d.ageS, name: commandName(d.command), label: toolLabel(line, d.command), d });
  }
  const listening = new Map();
  for (const x of ports) if (inTree.has(x.pid) && x.pid !== pid && !listening.has(x.pid)) listening.set(x.pid, x.port);
  for (const { d } of tools) {
    if (listening.has(d.pid)) return { ok: false, why: `Its child process ${who(d)} listens on port ${listening.get(d.pid)}: something may be talking to it. No button.` };
    if (typeof d.cpuPct !== 'number' || !Number.isFinite(d.cpuPct)) return { ok: false, why: `How busy its child process ${who(d)} is could not be read. Cannot judge, so no button.` };
    if (d.cpuPct >= TOOL_CHILD_MAX_CPU) return { ok: false, why: `Its child process ${who(d)} used ${Math.round(d.cpuPct)}% of a core in this reading: it is working. No button.` };
    if (d.ageS == null || !Number.isFinite(d.ageS)) return { ok: false, why: `How long its child process ${who(d)} has been up could not be read. Cannot judge, so no button.` };
    if (d.ageS < TOOL_CHILD_MIN_AGE_S) return { ok: false, why: `Its child process ${who(d)} started ${human(d.ageS)} ago (a tool server must be up 10 minutes or more): the session may be using it. No button.` };
  }
  return { ok: true, tools: tools.map(({ d, ...t }) => t) };
}

const toolNames = (tools) => [...new Set(tools.map((t) => t.label))].join(', ');
const toolsSentence = (tools) => `${tools.length} tool server process${tools.length > 1 ? 'es' : ''} belong${tools.length > 1 ? '' : 's'} to this session (${toolNames(tools)})`;

async function orphanTools(procs, probe = defaultProbe(), ports = undefined, { selfPid = process.pid, exclude = new Set() } = {}) {
  const now = probe.now();
  const forbidden = ancestorsOfSelf(procs, selfPid);
  forbidden.add(selfPid);
  const roots = procs.filter((p) => p.ppid === 1 && !p.systemManaged && p.ageS != null && p.ageS >= TOOL_MIN_AGE_S
    && !toolOf(p.command) && !exclude.has(p.pid) && !forbidden.has(p.pid) && p.pid > 1);
  if (!roots.length) return [];
  const args = await probe.argsOf(roots.map((r) => r.pid));
  if (!args) return [];   // the command lines could not be read: nothing is recognised, nothing is claimed
  if (ports === undefined) ports = await probe.ports();

  const groups = new Map();
  for (const r of roots) {
    const line = args[r.pid];
    if (!line || !TOOL_LINE.test(line)) continue;
    const tree = treeOf(r, procs);
    if (tree.some((q) => forbidden.has(q.pid) || exclude.has(q.pid))) continue;
    if (!sessionGone(r, tree, procs)) continue;
    const label = toolLabel(line, r.command);
    const g = groups.get(label) || { label, roots: [], members: [] };
    g.roots.push(r); g.members.push(...tree);
    groups.set(label, g);
  }

  const portsOf = new Map();
  for (const { pid, port } of ports || []) { if (!portsOf.has(pid)) portsOf.set(pid, new Set()); portsOf.get(pid).add(port); }
  const rows = [];
  for (const g of groups.values()) {
    const kb = g.members.reduce((s, p) => s + (p.rssKB || 0), 0);
    const cpu = g.members.reduce((s, p) => s + (p.cpuPct || 0), 0);
    const ages = g.roots.map((p) => p.ageS);
    const listening = [...new Set(g.members.flatMap((p) => [...(portsOf.get(p.pid) || [])]))].sort((a, b) => a - b);
    const pids = g.members.map((p) => p.pid);
    const n = g.roots.length;
    const base = `${n} process tree${n > 1 ? 's' : ''} (${g.members.length} process${g.members.length > 1 ? 'es' : ''}) whose command line names ${g.label}. `
      + `Each root's parent is gone (ppid 1, not started by launchd, not inside an app) and nothing else sits on its terminal, so the session that started it is gone. `
      + `Oldest up ${human(Math.max(...ages))}, youngest ${human(Math.min(...ages))}; together ${mbOf(kb)} MB and ${Math.round(cpu)}% of a core.`;
    let confidence = 'medium', why = '';
    if (ports == null) { confidence = 'low'; why = ' Listening ports could not be read, so it cannot be proven that nothing talks to these servers. Cannot judge, so no button.'; }
    else if (listening.length) { confidence = 'low'; why = ` It listens on port ${listening.join(', ')}, which reckon cannot explain: something may still be talking to it. No button.`; }
    else why = ' None of them listens on a port.';
    rows.push(row({
      id: `orphan-tool-${slug(g.label)}`,
      title: `${n} orphaned ${g.label} server${n > 1 ? 's' : ''}`,
      kb, costPct: cpu,
      proof: base + why,
      lose: `Whatever ${g.label} was doing for a session that no longer exists. A tool server is started again by the client that needs it, the next time that client starts. Nothing on disk is touched.`,
      command: `kill -TERM ${pids.join(' ')}`,
      confidence,
      action: { id: 'stop-orphan-tools', label: `Stop ${g.label}` },
      target: { kind: 'orphan-tool', label: g.label, rootPids: g.roots.map((p) => p.pid), pids: g.members.map((p) => identity(p, now)) },
    }));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 3. Local models. Ollama is read through its own API and gets a row per loaded
// model; LM Studio and llama.cpp are only detected and named, copy-only, because
// reckon does not read what they hold.
// ---------------------------------------------------------------------------
const IS_OLLAMA = (c) => /(^|\/)ollama$/.test(c) || /\/Ollama\.app\//.test(c);
const IS_LMSTUDIO = (c) => /\/LM Studio\.app\//.test(c) || /(^|\/)lms$/.test(c);
const IS_LLAMACPP = (c) => /(^|\/)(llama-server|llama-cli|llamafile)$/.test(c);

const gbOf = (bytes) => (bytes == null ? '?' : (bytes / 1073741824).toFixed(1));

async function localModels(procs, probe = defaultProbe()) {
  const rows = [];
  const sum = (list) => list.reduce((s, p) => s + (p.rssKB || 0), 0);
  const ollama = procs.filter((p) => IS_OLLAMA(String(p.command)));
  if (ollama.length) {
    const models = await probe.ollamaLoaded();
    const bin = probe.which('ollama');
    if (models == null) {
      rows.push(row({ id: 'ollama-unread', title: 'Ollama is running, and did not say which models it holds',
        kb: sum(ollama), proof: `${ollama.length} ollama process(es) hold ${mbOf(sum(ollama))} MB, but its API at ${OLLAMA_URL} did not answer within 2 s. Cannot judge which models are loaded.`,
        lose: 'Unknown from here.', command: 'ollama ps', confidence: 'low' }));
    }
    for (const m of models || []) {
      if (!validModelName(m.name)) {
        rows.push(row({ id: `ollama-odd-${crypto.createHash('sha1').update(String(m.name)).digest('hex').slice(0, 8)}`,
          title: 'Ollama holds a model whose name reckon will not pass to a command', kb: m.size == null ? 0 : Math.round(m.size / 1024),
          proof: `Ollama's API lists a loaded model whose name has characters outside letters, digits and . _ : / -. It is not passed to any command.`,
          lose: 'Nothing: there is no button for it.', command: 'ollama ps', confidence: 'low' }));
        continue;
      }
      const kb = m.size == null ? 0 : Math.round(m.size / 1024);
      const until = m.expiresAt && !Number.isNaN(Date.parse(m.expiresAt)) ? ` Ollama will unload it by itself at ${new Date(Date.parse(m.expiresAt)).toLocaleTimeString()}.` : '';
      rows.push(row({
        id: `ollama-${slug(m.name).slice(0, 30)}-${crypto.createHash('sha1').update(m.name).digest('hex').slice(0, 8)}`,
        title: `Ollama holds ${m.name} in memory`,
        kb,
        proof: `Ollama's own API (GET ${OLLAMA_URL}) lists ${m.name} as loaded, ${gbOf(m.size)} GB`
          + (m.sizeVram ? ` (${gbOf(m.sizeVram)} GB of it in GPU memory, which on a Mac is the same RAM)` : '') + '. '
          + `The ollama process(es) hold ${mbOf(sum(ollama))} MB resident.${until}`
          + (bin ? '' : ' The `ollama` command is not on this panel\'s PATH, so there is no button: run the command yourself.'),
        lose: 'Nothing on disk: the model file stays. The next request to this model loads it again (seconds to a minute), and what it held in memory for the current chat is dropped.',
        command: `ollama stop ${m.name}`,
        confidence: 'medium',
        action: bin ? { id: 'stop-ollama-model', label: `Unload ${m.name}` } : null,
        target: bin ? { kind: 'ollama', name: m.name } : null,
        extra: bin ? {} : { missing: 'ollama is not on PATH' },
      }));
    }
  }
  const lm = procs.filter((p) => IS_LMSTUDIO(String(p.command)));
  if (lm.length) {
    rows.push(row({ id: 'lmstudio-running', title: 'LM Studio is running', kb: sum(lm),
      proof: `${lm.length} LM Studio process(es) hold ${mbOf(sum(lm))} MB. reckon reads only Ollama's list of loaded models, so what LM Studio holds is not judged here.`,
      lose: 'Any model LM Studio has loaded, and the chat it is serving.', command: '# unload from LM Studio itself, or with its own CLI:\nlms unload --all', confidence: 'low' }));
  }
  const llama = procs.filter((p) => IS_LLAMACPP(String(p.command)));
  if (llama.length) {
    rows.push(row({ id: 'llamacpp-running', title: `${llama.length} llama.cpp server process${llama.length > 1 ? 'es' : ''} running`, kb: sum(llama),
      proof: `${llama.map((p) => `pid ${p.pid}, ${human(p.ageS)} old, ${mbOf(p.rssKB)} MB`).join(' · ')}. reckon does not read what a llama.cpp server is serving, so there is no button.`,
      lose: 'The model it serves, and every client using it.', command: `# look first:\nps -o pid,etime,command -p ${llama.map((p) => p.pid).join(',')}\n\nkill -TERM ${llama.map((p) => p.pid).join(' ')}`, confidence: 'low' }));
  }
  return rows;
}

module.exports = {
  SESSION_MIN_AGE_S, TTY_IDLE_S, TRANSCRIPT_IDLE_S, TOOL_MIN_AGE_S, OLLAMA_URL, OLLAMA_HOST, OLLAMA_PORT,
  INTERACTIVE, toolOf, projectDir, newestTranscript, ollamaLoaded, validModelName, defaultProbe, onPath,
  judgeSession, idleSessions, orphanTools, toolLabel, sessionGone, treeOf, localModels,
  TOOL_CHILD_MIN_AGE_S, TOOL_CHILD_MAX_CPU, onlyToolChildren, recognisedTool, commandName, toolsSentence,
};
