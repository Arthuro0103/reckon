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
//     - no live child process (it is not running anything);
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
  const kids = list.filter((x) => x.ppid === p.pid);
  if (kids.length) {
    return { offer: false, facts, why: `It has ${kids.length} live child process${kids.length > 1 ? 'es' : ''} (pid ${kids.slice(0, 5).map((k) => k.pid).join(', ')}${kids.length > 5 ? ', …' : ''}): it is still running something, so it is not idle. No button.` };
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
      ? `No child process. The newest of ${f.transcripts} transcript(s) in ${f.dirShown} was modified ${human(f.transcriptIdleS)} ago (its modification time only: reckon does not open it).`
      : '');
}

function sessionLose(f) {
  return 'The running process and whatever lives only in it: text typed but not sent, a tool call in flight. '
    + `The conversation itself stays on disk in ${f.dirShown}/, and it comes back with \`${f.resume}\` (pick it from the list). `
    + 'Its shell and its terminal tab are not touched.';
}

async function idleSessions(procs, probe = defaultProbe(), selfPid = process.pid) {
  const rows = [];
  const now = probe.now();
  for (const p of procs) {
    if (!toolOf(p.command)) continue;
    const j = await judgeSession(p, procs, probe, selfPid);
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
        pid: identity(p, now), lose: sessionLose(f) } : null,
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
const TOOL_LINE = /modelcontextprotocol|(^|[^a-z])mcp|mcp([^a-z]|$)|(^|[\s/])(npx|uvx)(\s|$)|npm exec|language-?server|langserver|(^|[^a-z])lsp([^a-z]|$)|tsserver|pyright|gopls|rust-analyzer|clangd|jdtls/i;
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
};
