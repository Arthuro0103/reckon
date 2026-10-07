'use strict';
const os = require('node:os');
const platform = require('./platform');
const history = require('./history');

// ---------------------------------------------------------------------------
// HEADROOM: how much more can this machine take before it needs swap?
//
// READ-ONLY, for people and for other tools. An agent may read this before it
// opens another session. It starts nothing, writes nothing, and runs no probe: it
// reads `vm_stat` (through lib/platform), the process list, and the family history
// file `reckon watch` keeps inside ~/.cache/reckon/.
//
// THE FORMULA, and why each term is in it:
//
//   availableMB = free + max(inactive, purgeable)
//
//   free        pages nobody holds (speculative pages are counted in it by the platform).
//   inactive    pages no process touched recently. macOS reclaims these first, and the
//               clean ones cost nothing to take back.
//   purgeable   pages an app has said it can lose. They sit INSIDE the active and
//               inactive lists, so adding them to `inactive` could count the same page
//               twice. `max()` is the lower bound that cannot double count: it is exact
//               if every purgeable page is already inactive, and an underestimate
//               otherwise. For a number other tools act on, too small is the safe error.
//   NOT counted active (in use), wired (cannot move) and compressed (it is already the
//               result of squeezing memory; getting it back means decompressing into
//               pages that must come from somewhere else, so it frees nothing).
//
// Inactive memory is a bound, not a promise: a dirty anonymous page must be compressed or
// swapped before it can be reused. That is why `fits` keeps a reserve and why the
// pressure word is read from the share of RAM that is available, not from swap.
// ---------------------------------------------------------------------------

const MB = 1048576;
const RESERVE_MB = 1024;                // always left for the system; nothing "fits" into this
const DEFAULT_MIN_SAMPLES = 3;          // fewer history samples than this and the default is used

// The pressure word, from the share of RAM that is available.
const COMFORTABLE = 0.25;
const TIGHT = 0.10;

// The apps worth asking about, and what one of them weighs when this machine has no
// history of it. The defaults are rough sizes seen on a 16 GB Mac, NOT measurements;
// every answer says which of the two it used (`source`).
//   unit 'process'  one instance is one process (the CLIs, Godot): typical = RSS per process
//   unit 'family'   one instance is the whole family of helpers (an Electron app): typical = family total
const APPS = Object.freeze([
  { key: 'claude', name: 'Claude Code (CLI)', unit: 'process', defaultMB: 350 },
  { key: 'codex', name: 'Codex (CLI)', unit: 'process', defaultMB: 300 },
  { key: 'godot', name: 'Godot', unit: 'process', defaultMB: 1000 },
  { key: 'electron', name: 'Electron app', unit: 'family', defaultMB: 700 },
  { key: 'docker-vm', name: 'Docker VM', unit: 'family', defaultMB: 2500 },
  { key: 'simulators', name: 'Xcode simulators', unit: 'family', defaultMB: 1500 },
]);

const ELECTRON_FAMILIES = new Set(['Claude Desktop', 'Discord', 'Slack', 'VS Code', 'Obsidian']);

// Which known app a process belongs to, as { key, group } or null. `group` is what makes
// "one instance" for the family unit: every Electron app is its own group.
function classify(p) {
  const command = String(p.command || '');
  const base = command.split('/').pop().trim();
  const fam = p.family || '';
  if (fam === 'Claude Code (CLI)') return { key: 'claude', group: 'claude' };
  if (base === 'codex' || /\/codex$/.test(command)) return { key: 'codex', group: 'codex' };
  if (/^godot/i.test(base)) return { key: 'godot', group: 'godot' };
  if (fam === 'Docker Desktop' || fam === 'Apple VM (Docker/Claude)') return { key: 'docker-vm', group: 'docker-vm' };
  if (/CoreSimulator|Simulator\.app|launchd_sim/.test(command)) return { key: 'simulators', group: 'simulators' };
  if (ELECTRON_FAMILIES.has(fam) || /\/Electron( Helper[^/]*)?$/.test(command) || /\.app\/Contents\/Frameworks\/Electron/.test(command)) {
    return { key: 'electron', group: `electron:${fam || base}` };
  }
  return null;
}

// What the process list says now, by app: { key: { mb, n } } for the process unit, and
// per-group totals for the family unit. The watcher records this exact shape.
function tally(procs) {
  const app = {};
  for (const p of procs || []) {
    const c = classify(p);
    if (!c || !(p.rssKB > 0)) continue;
    const e = app[c.group] || (app[c.group] = { key: c.key, mb: 0, n: 0 });
    e.mb += p.rssKB / 1024;
    e.n += 1;
  }
  return app;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Pools every sample of one app, from the history lines and from now.
// process unit -> MB per process; family unit -> MB per group (one Electron app).
function samplesFor(app, lines, nowTally) {
  const out = [];
  const take = (groups) => {
    for (const [group, e] of Object.entries(groups || {})) {
      const key = e.key || (group.startsWith('electron:') ? 'electron' : group);
      if (key !== app.key || !Number.isFinite(e.mb) || e.mb <= 0) continue;
      out.push(app.unit === 'process' ? e.mb / Math.max(1, e.n || 1) : e.mb);
    }
  };
  for (const l of lines || []) take(l.app);
  const fromHistory = out.length;
  take(nowTally);
  return { all: out, fromHistory };
}

// The pure core: everything it needs is passed in, so a test can hand it a fake
// vm_stat and a fake process list.
//   vm      the platform's memoryStats() object, or null
//   procs   the platform's processList() array
//   lines   history.readFamilies() lines
function compute({ vm, procs, lines = [], totalBytes = os.totalmem() } = {}) {
  const now = tally(procs);
  const totalMB = (totalBytes || 0) / MB;
  if (!vm || !totalMB) {
    return { availableMB: null, pressure: null, perApp: [], verdict: 'Cannot tell: this machine did not report its memory, so nothing is guessed.', basis: null };
  }
  const freeMB = (vm.freeBytes || 0) / MB;
  const inactiveMB = (vm.inactiveBytes || 0) / MB;
  const purgeableMB = vm.purgeableBytes == null ? 0 : vm.purgeableBytes / MB;
  const availableMB = Math.round(freeMB + Math.max(inactiveMB, purgeableMB));
  const share = availableMB / totalMB;
  const pressure = share >= COMFORTABLE ? 'comfortable' : share >= TIGHT ? 'tight' : 'critical';
  const room = Math.max(0, availableMB - RESERVE_MB);

  const perApp = APPS.map((app) => {
    const { all: samples, fromHistory } = samplesFor(app, lines, now);
    // "Learned" needs history; what is running right now only sharpens it. One look at the
    // process list is not a habit.
    const learned = fromHistory >= DEFAULT_MIN_SAMPLES;
    const typicalMB = Math.round(learned ? median(samples) : app.defaultMB);
    const running = Object.values(now).filter((e) => e.key === app.key);
    return {
      key: app.key, name: app.name, typicalMB,
      fits: typicalMB > 0 ? Math.floor(room / typicalMB) : 0,
      source: learned ? 'history' : 'default', samples: fromHistory,
      running: app.unit === 'process' ? running.reduce((s, e) => s + e.n, 0) : running.length,
    };
  });

  const gb = (n) => `${(n / 1024).toFixed(1)} GB`;
  const best = perApp.filter((a) => a.running > 0 || a.key === 'claude').slice(0, 3)
    .map((a) => `${a.fits} more ${a.name}`).join(', ');
  const verdict = pressure === 'critical'
    ? `Only ${gb(availableMB)} of ${gb(totalMB)} is available and ${gb(RESERVE_MB)} of it is kept for the system. Start nothing more; the next thing would need swap.`
    : `${gb(availableMB)} of ${gb(totalMB)} is available (${pressure}); after ${gb(RESERVE_MB)} kept for the system, room for ${best} before swap is needed.`;

  return {
    availableMB, pressure, perApp, verdict,
    basis: {
      totalMB: Math.round(totalMB), freeMB: Math.round(freeMB), inactiveMB: Math.round(inactiveMB),
      purgeableMB: vm.purgeableBytes == null ? null : Math.round(purgeableMB), reserveMB: RESERVE_MB,
      formula: 'free + max(inactive, purgeable)',
    },
  };
}

// The live answer. Reads three things and writes none.
async function collect({ dir } = {}) {
  const [vm, procs] = await Promise.all([platform.memoryStats().catch(() => null), platform.processList().catch(() => [])]);
  const out = compute({ vm, procs, lines: history.readFamilies({ dir }), totalBytes: (vm && vm.totalBytes) || os.totalmem() });
  return { ...out, at: Date.now() };
}

module.exports = { collect, compute, classify, tally, APPS, RESERVE_MB, DEFAULT_MIN_SAMPLES, COMFORTABLE, TIGHT };
