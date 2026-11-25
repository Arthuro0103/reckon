'use strict';
// `reckon archive`: idle Claude Code sessions, judged by lib/archive.js and stopped by lib/act.js.
//
//   reckon archive                 report only: every live session and why it would or would not be archived
//   reckon archive --run           archive the idle ones once, then exit
//   reckon archive --every 5       archive the idle ones now and every 5 minutes, until ctrl+c
//   reckon archive --list          the sessions archived so far, each with the command that resumes it
//   --idle 15                      minutes without activity before a session counts as idle (5 at least)
//
// Nothing is archived unless --run or --every is given. Writes only ~/.cache/reckon/actions.log
// (through lib/actlog.js) and, while --every runs, ~/.cache/reckon/archive.pid (lib/archiveloop.js).
const os = require('node:os');
const act = require('../lib/act');
const actlog = require('../lib/actlog');
const archive = require('../lib/archive');

const HELP = `reckon archive                 report only: what would be archived, and why
reckon archive --run           archive the idle Claude Code sessions once
reckon archive --every <min>   archive now and every <min> minutes (until ctrl+c)
reckon archive --list          sessions archived so far, with the command that resumes each
  --idle <min>                 minutes without activity that make a session idle (default 15, at least 5)`;

function parse(argv) {
  const o = { run: false, every: null, list: false, idleS: archive.DEFAULT_IDLE_S };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') o.run = true;
    else if (a === '--list') o.list = true;
    else if (a === '--every') {
      const n = Number(argv[++i]);
      if (!(n >= 1 && n <= 120)) return { error: '--every takes minutes, from 1 to 120.' };
      o.every = n; o.run = true;
    } else if (a === '--idle') {
      const s = archive.parseIdle(argv[++i]);
      if (s == null) return { error: `--idle takes minutes, ${archive.IDLE_FLOOR_S / 60} at least.` };
      o.idleS = s;
    } else if (a === '-h' || a === '--help') o.help = true;
    else return { error: `Unknown option: ${a}` };
  }
  return o;
}

const home = os.homedir();
const short = (p) => (p.startsWith(home + '/') ? '~' + p.slice(home.length) : p);
const stamp = () => new Date().toTimeString().slice(0, 8);

function report(r) {
  const sessions = r.sessions || [];
  if (!sessions.length) { console.log('No live Claude Code session was found in ~/.claude/sessions/.'); return; }
  for (const s of sessions) {
    const head = `${s.archive ? 'IDLE ' : 'keep '} pid ${s.pid}  ${s.mb == null ? '?' : s.mb} MB  ${short(s.cwd)}  (${s.entrypoint || '?'})`;
    console.log(head);
    console.log(`      ${s.archive ? s.proof : s.why}`);
  }
  const idle = sessions.filter((s) => s.archive);
  const mb = idle.reduce((t, s) => t + (s.mb || 0), 0);
  console.log(`\n${idle.length} of ${sessions.length} session(s) idle for ${r.idleS / 60} min or more, about ${mb} MB.`
    + (r.ran ? '' : idle.length ? ' Nothing was done. `reckon archive --run` archives them.' : ''));
}

function results(r) {
  for (const x of r.results || []) {
    if (x.refused) console.log(`[${stamp()}] not archived, pid ${x.pid}: ${x.refused}`);
    else if (x.dryRun) console.log(`[${stamp()}] dry run, pid ${x.pid}: would run ${x.argv.join(' ')}`);
    else if (x.ok) console.log(`[${stamp()}] archived pid ${x.pid} (${short(x.cwd)}), ${Math.round((x.freedKB || 0) / 1024)} MB freed. Back with:\n    ${x.resume}`);
    else if (x.exitOk === false) console.log(`[${stamp()}] the stop to pid ${x.pid} failed: ${x.error}`);
    else console.log(`[${stamp()}] pid ${x.pid} is still running after the polite stop. Nothing more was sent.`);
  }
}

function list() {
  const rows = actlog.read(500).filter((e) => e.action === 'archive-ai-session' && e.ok && !e.dryRun && e.info);
  if (!rows.length) { console.log('No session has been archived yet.'); return; }
  for (const e of rows) {
    console.log(`${new Date(e.at).toLocaleString()}  ${short(e.info.cwd)}  ${Math.round((e.freedKB || 0) / 1024)} MB`);
    console.log(`    ${e.info.resume}`);
  }
}

async function main(argv) {
  const o = parse(argv);
  if (o.error) { console.error(`${o.error}\n\n${HELP}`); process.exitCode = 2; return; }
  if (o.help) { console.log(HELP); return; }
  if (o.list) { list(); return; }
  if (!o.every) {
    const r = await act.archiveIdle({ idleS: o.idleS, run: o.run });
    if (!r.ok) { console.error(r.refused); process.exitCode = 1; return; }
    report(r); results(r);
    return;
  }
  console.log(`[${stamp()}] archiving Claude Code sessions idle ${o.idleS / 60} min or more, every ${o.every} min. ctrl+c stops.`);
  const loop = require('../lib/archiveloop').start({ act, idleS: o.idleS, everyMs: o.every * 60000,
    onResult: (r) => (r.ok ? results(r) : console.log(`[${stamp()}] ${r.refused}`)),
    onNote: (t) => console.log(`[${stamp()}] ${t}`) });
  if (loop.error) { console.error(`Not started: ${loop.error}.`); process.exitCode = 1; return; }
  // A stop in the middle of a pass waits for it: a session already signalled still gets its log line.
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await loop.stop(); process.exit(0); };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, stop);
}

main(process.argv.slice(3));
