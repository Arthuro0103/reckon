'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('./sh');
const platform = require('./platform');

// ---------------------------------------------------------------------------
// Open-only actions. Every entry opens a window and changes nothing: no file is
// written, moved or deleted, no process is stopped, no command is typed anywhere.
// The browser sends an id from this table, never a command. The one id that takes
// a target (`reveal`) takes a PATH, and only a path this panel measured itself.
// ---------------------------------------------------------------------------
const pane = (id) => ['open', `x-apple.systempreferences:${id}`];

const OPENERS = Object.freeze({
  reveal:   { label: 'show in Finder',   target: true,  argv: (p) => ['open', '-R', p] },
  activity: { label: 'Activity Monitor', target: false, argv: () => ['open', '-a', 'Activity Monitor'] },
  storage:  { label: 'Storage settings', target: false, argv: () => pane('com.apple.settings.Storage') },
  backup:   { label: 'Time Machine settings', target: false, argv: () => pane('com.apple.Time-Machine-Settings.extension') },
  login:    { label: 'Login Items settings',  target: false, argv: () => pane('com.apple.LoginItems-Settings.extension') },
  // Opens the app and nothing else. It takes no argument: what to type there stays with the person.
  terminal: { label: 'open Terminal',    target: false, argv: () => ['open', '-a', 'Terminal'] },
});

// Only macOS has these openers. Elsewhere the answer is none and the UI hides the buttons.
function available(plat = platform.id) {
  return plat === 'darwin' ? Object.keys(OPENERS) : [];
}

const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// The paths the last scan measured: the folders it named, the top of home, the repositories.
function measuredPaths(scanData) {
  const out = new Set();
  if (!scanData) return out;
  for (const t of scanData.targets || []) if (t.path) out.add(t.path);
  for (const t of scanData.homeTop || []) if (t.path) out.add(t.path);
  for (const r of (scanData.repos && scanData.repos.repos) || []) if (r.path) out.add(r.path);
  return out;
}

// Returns { ok: true, argv } or { ok: false, error }. Never runs anything.
function resolve(id, target, { scanData, home = os.homedir(), plat = platform.id } = {}) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(OPENERS, id)) return { ok: false, error: 'unknown action' };
  if (!available(plat).includes(id)) return { ok: false, error: 'not available on this platform' };
  const o = OPENERS[id];
  if (!o.target) {
    if (target != null) return { ok: false, error: `${id} takes no target` };
    return { ok: true, argv: o.argv() };
  }
  if (typeof target !== 'string' || !path.isAbsolute(target)) return { ok: false, error: 'a measured absolute path is required' };
  const h = real(home);
  const p = real(target);
  if (!h || !p) return { ok: false, error: 'path does not exist' };
  if (!inside(p, h)) return { ok: false, error: 'path is outside your home folder' };
  const known = [...measuredPaths(scanData)].map(real).filter(Boolean);
  if (!known.includes(p)) return { ok: false, error: 'path was not measured by the last scan' };
  return { ok: true, argv: o.argv(p) };
}

async function open(id, target, opts = {}) {
  const r = resolve(id, target, opts);
  if (!r.ok) return r;
  const [cmd, ...args] = r.argv;
  const res = await run(cmd, args, { timeout: 8000 });
  return res.ok ? { ok: true } : { ok: false, error: res.erro || 'open failed' };
}

module.exports = { OPENERS, available, resolve, open, measuredPaths };
