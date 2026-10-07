'use strict';
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const platform = require('./platform');
const pressure = require('./pressure');
const self = require('./self');
const history = require('./history');
const leak = require('./leak');
const headroom = require('./headroom');

// ---------------------------------------------------------------------------
// `reckon watch` — a companion that speaks only when the machine is struggling.
// The design, and the afternoon that produced it: docs/2026-09-29-watch-design.md.
//
// The dashboard collects on demand and sits at 0% between clicks; that is its
// stated virtue and it stays true. This is a SEPARATE command that never starts
// by itself, states its own cost when it starts, and writes only inside
// ~/.cache/reckon/. The dashboard server is untouched.
//
// The one thing to remember before editing anything here: LOAD IS NEVER THE
// ANSWER. It counts runnable work, and a machine doing a lot of legitimate work
// looks identical to one that is suffering. A hand-made watcher that alerted on
// load fired at 72 during an ordinary compile with swap at 0 MB and half the RAM
// free. So load may ASK the question (it is allowed to make the watcher run the
// probe) and it may never BE the answer.
// ---------------------------------------------------------------------------

const CACHE_DIR = path.join(os.homedir(), '.cache', 'reckon');
const STATE_FILE = path.join(CACHE_DIR, 'watch.json');
const LOG_FILE = path.join(CACHE_DIR, 'watch.log');
const LOG_MAX_BYTES = 256 * 1024;

const TUNING = Object.freeze({
  intervalMs: 30_000,
  minIntervalMs: 10_000,
  // Swap: where it is, and where it is going. Measured against this machine's RAM,
  // NOT against the swap file's own size. macOS grows its swap files on demand: after
  // a restart the total is 1 GB, and "72% of 1 GB" is 740 MB, which is nothing. The
  // day that produced this file it read 12.7 of 13.3 GB on a 16 GB machine, and only
  // the second number says anything.
  swapWarn: 0.50,          // swap in use as a share of physical RAM (8 GB on a 16 GB Mac)
  swapWatch: 0.30,         // enough to go and look
  slopeStep: 0.06,         // gaining this much of RAM inside slopeWindowMs (about 1 GB)
  slopeWindowMs: 10 * 60_000,
  // Seconds stolen: the probe against this machine's earned best.
  stolenWarn: 4,           // 4x slower than its best
  // Load only asks the question.
  loadStreak: 3,
  loadPerCore: 2,
  // The probe burns about a third of a second of CPU on purpose, so it does not
  // run on a timer: only on suspicion, and never more than this often.
  deepEveryMs: 2 * 60_000,
  // One alert per problem, not one per reading.
  cooldownMs: 10 * 60_000,
  clearAfter: 2,           // calm readings in a row before "cleared" is announced
  worseFactor: 2,          // a probe factor that doubles is worth a second word
  worseSwap: 0.10,
  // Swap ACTIVITY, not swap size. Five GB that just sits in swap costs nothing: it is where
  // old pages went to rest. What hurts is pages going in and out, so size alone is "resting"
  // and the alert waits for movement. 100 pages/s is about 1.6 MB/s of swap-outs on a 16 KB-page
  // Mac, which is the machine paging against itself continuously, and it has to hold for two
  // readings in a row so one burst (a compile, a build) does not ring.
  swapOutPagesPerSec: 100,
  swapMovingReadings: 2,
  // Leaks: see lib/leak.js. The window is a count of readings' worth of hours, not a wait.
  leak: leak.LEAK,
  rowCostPct: 25,          // a named row must be costing a quarter of a core...
  rowKB: 1024 * 1024,      // ...or holding a gigabyte, or it is not an alert
});

const clamp01 = (n) => Math.max(0, Math.min(1, n));

// ---------------------------------------------------------------------------
// The one number the lantern is fed with. 0 is calm and 1 is as bad as it draws.
// Swap is level 0 at a tenth of RAM and 1 at three quarters of it; seconds stolen is 0 at the best this
// machine has done and 1 at sixteen times it. A reading that was not taken
// contributes nothing: `null` means "did not measure", never "zero".
// ---------------------------------------------------------------------------
//
// `moving` is what makes swap SIZE count. false means the page counters were read and
// nothing is moving, so swap that is merely held reads as resting (capped under the
// lantern's first cut-off, 0.15). true or undefined keeps the old scale: a reading
// without counters (the first one, or another platform) must not hide a full swap.
function levelOf({ swapOfRam = null, factor = null, rising = false, moving } = {}) {
  let swap = swapOfRam == null ? 0 : clamp01((swapOfRam - 0.10) / 0.65) + (rising && swapOfRam >= TUNING.swapWatch ? 0.15 : 0);
  if (moving === false) swap = Math.min(swap, 0.14);
  const stolen = factor == null ? 0 : clamp01(Math.log2(Math.max(1, factor)) / 4);
  return +clamp01(Math.max(swap, stolen)).toFixed(3);
}

// The same cut-offs the drawing uses (web/pet.js, `resolve`). They are written
// twice on purpose — lib/ must not reach into web/ — and a check compares them.
function stateOf(level) {
  return level < 0.15 ? 'resting' : level < 0.45 ? 'watching' : level < 0.8 ? 'uneasy' : 'strained';
}

// ---------------------------------------------------------------------------
// Swap activity. `memoryStats()` publishes CUMULATIVE page counters (swapins, swapouts);
// a rate is two readings and the seconds between them. Pure. Returns null, never 0, when
// either reading has no counter (another platform), when time did not pass, or when the
// counter went backwards (a reboot): "could not measure" must not read as "nothing moves".
// ---------------------------------------------------------------------------
function swapRate(prev, cur) {
  if (!prev || !cur || prev.swapouts == null || cur.swapouts == null || prev.swapins == null || cur.swapins == null) return null;
  const secs = (cur.t - prev.t) / 1000;
  if (!(secs > 0)) return null;
  const out = cur.swapouts - prev.swapouts;
  const inn = cur.swapins - prev.swapins;
  if (out < 0 || inn < 0) return null;
  return { outPerSec: out / secs, inPerSec: inn / secs, secs };
}

// ---------------------------------------------------------------------------
// What counts as a problem. Pure: a reading goes in, a list of kinds comes out.
//   stolen   the probe took a multiple of this machine's best
//   swap     pages are MOVING (swap-outs per second above the line for two readings), or
//            swap is held in quantity AND the probe says the machine is slow. Size alone
//            is "resting" and never alerts.
//   leak:<f> a process family has climbed steadily for hours (lib/leak.js)
//   row:<id> a named cause from the Pressure tab that is costing real time
// Load appears nowhere in this function. That is the point of it.
// ---------------------------------------------------------------------------
function detect(r) {
  const out = [];
  if (r.factor != null && r.factor >= TUNING.stolenWarn) out.push({ kind: 'stolen', magnitude: r.factor });
  if (r.swapOfRam != null) {
    const moving = (r.swapMovingStreak || 0) >= TUNING.swapMovingReadings;
    const slow = r.factor != null && r.factor >= TUNING.stolenWarn;
    if (moving || (slow && r.swapOfRam >= TUNING.swapWatch)) out.push({ kind: 'swap', magnitude: r.swapOfRam });
  }
  for (const l of r.leaks || []) out.push({ kind: `leak:${l.family}`, magnitude: l.slopeMBPerHour, leak: l });
  for (const row of r.rows || []) {
    if (row.confidence !== 'high') continue;
    if (!(row.costPct >= TUNING.rowCostPct || row.kb >= TUNING.rowKB)) continue;
    out.push({ kind: `row:${row.id}`, magnitude: Math.max(row.costPct || 0, 1), row });
  }
  return out;
}

// Which kinds a reading is able to speak about. A kind whose measurement was not
// taken this time is UNKNOWN, not calm: an active "stolen" must not clear just
// because the probe did not run on this tick.
function measured(r, kind) {
  if (kind === 'stolen') return r.factor != null;
  if (kind === 'swap') return r.swapOfRam != null;
  if (kind.startsWith('leak:')) return r.leaks != null;
  return r.rows != null;
}

const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) || null;

// The best command on offer: the costliest high-confidence row. Never invented —
// with no row, there is no command, and the alert says to open the tab instead.
function topCommand(rows) {
  const best = (rows || []).filter((x) => x.confidence === 'high' && x.command)
    .sort((a, b) => (b.costPct || 0) - (a.costPct || 0) || (b.kb || 0) - (a.kb || 0))[0];
  return best ? { command: best.command, why: best.title } : null;
}

// The house rule, unchanged: how much it costs, the proof of that number, and what
// you lose if the verdict is wrong. An alert that cannot fill all three is not
// sent, so this returns null instead of a sentence with a gap in it.
function describe(kind, r) {
  const top = topCommand(r.rows);
  if (kind === 'stolen') {
    if (r.factor == null || !r.probe) return null;
    const f = r.factor >= 10 ? Math.round(r.factor) : +r.factor.toFixed(1);
    return {
      title: `Things are running about ${f}x slower than this machine's best`,
      cost: `Whatever you are waiting on takes about ${f} times as long as it does when this machine is at its best.`,
      proof: `A fixed piece of work took ${r.probe.nowMs} ms; the fastest this machine has ever run it is ${r.probe.bestMs} ms.`,
      lose: 'Nothing. This is a reading, not an action, and the alert clears itself when the machine recovers.',
      command: top ? top.command : null,
      hint: top ? top.why : 'Open the Pressure tab to see what is doing it.',
    };
  }
  if (kind === 'swap') {
    if (r.swapOfRam == null || r.swapUsedMB == null || !r.ramMB) return null;
    const pct = Math.round(r.swapOfRam * 100);
    const measuredRate = r.swapOutPerSec != null;
    const outs = measuredRate ? Math.round(r.swapOutPerSec) : null;
    const ins = r.swapInPerSec != null ? Math.round(r.swapInPerSec) : null;
    const rate = measuredRate
      ? `${outs} pages/s going out to swap${ins != null ? ` and ${ins} pages/s coming back` : ''}`
      : 'the page counters could not be compared this reading, so the rate is not known';
    const moving = measuredRate && (r.swapMovingStreak || 0) >= TUNING.swapMovingReadings;
    return {
      title: moving
        ? `Swap is moving: ${outs} pages/s going out (${mb(r.swapUsedMB)} held)`
        : `Swap holds ${mb(r.swapUsedMB)} and the machine is slow${measuredRate ? ` (${outs} pages/s going out)` : ''}`,
      cost: moving
        ? 'Pages are being written out and read back while you work, which is the stutter you feel when an app you left alone comes back and every click waits on the disk.'
        : 'Swap is large and the machine is measurably slower than its best, so the pauses you feel when an app you left alone comes back are likely paging.',
      proof: `${rate}; ${mb(r.swapUsedMB)} in swap, ${pct}% of ${mb(r.ramMB)} of RAM. A rate counts as moving above ${TUNING.swapOutPagesPerSec} pages/s for ${TUNING.swapMovingReadings} readings in a row.`,
      lose: 'Nothing by reading this. Swap is not freed; you stop asking for memory. A restart clears it, and closing what holds the most does most of the same.',
      command: top ? top.command : null,
      hint: top ? top.why : 'Open the Memory tab to see what holds the most.',
    };
  }
  if (kind.startsWith('leak:')) {
    const l = (r.leaks || []).find((x) => `leak:${x.family}` === kind);
    if (!l) return null;
    const slope = Math.round(l.slopeMBPerHour);
    const hours = +l.hours.toFixed(1);
    return {
      title: `${l.family} has grown about ${slope} MB an hour for ${hours} h`,
      cost: `It holds ${mb(l.lastMB)} now and, at this pace, about ${mb(l.lastMB + 3 * l.slopeMBPerHour)} three hours from now, memory other apps could have used.`,
      proof: `Resident memory went from ${mb(l.firstMB)} to ${mb(l.lastMB)} over ${hours} h (${l.points} readings), a straight-line climb of ${slope} MB per hour, above ${TUNING.leak.slopeMBPerHour} MB per hour in each of ${TUNING.leak.windowHours} consecutive hours (fit ${l.r2.toFixed(2)}).`,
      lose: 'Restarting it loses its in-memory state: whatever is open and unsaved in it. A climb is a measurement, not proof of a bug; a large project being indexed climbs the same way.',
      command: top ? top.command : null,
      hint: top ? top.why : 'Open the Memory tab to see this family. reckon does not guess a command for it.',
    };
  }
  if (kind.startsWith('row:')) {
    const row = (r.rows || []).find((x) => `row:${x.id}` === kind);
    if (!row || !row.proof || !row.lose) return null;
    return {
      title: row.title,
      cost: `${Math.round(row.costPct || 0)}% of a core and ${mb((row.kb || 0) / 1024)} held.`,
      proof: row.proof,
      lose: row.lose,
      command: row.command || null,
      hint: row.title,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The alert engine. Pure: (state, reading, now) -> { state, events }.
//
// An alert is keyed by KIND, never by value. The hand-made watcher's worst flaw
// was treating a changing number as a new problem: it rang five times for one
// compile. Here a kind speaks once, stays quiet until it WORSENS by a step or
// CLEARS, announces the clearing once, and after a clear it may not speak again
// for a cooldown, so a reading that flaps around a line cannot ring forever.
// ---------------------------------------------------------------------------
function emptyState() { return { kinds: {} }; }

function worse(kind, magnitude, last) {
  if (last == null) return false;
  if (kind === 'swap') return magnitude >= Math.min(1, last + TUNING.worseSwap);
  return magnitude >= last * TUNING.worseFactor;
}

function step(prev, reading, now) {
  const state = { kinds: { ...prev.kinds } };
  for (const k of Object.keys(state.kinds)) state.kinds[k] = { ...state.kinds[k] };
  const events = [];
  const seen = new Set();

  for (const d of detect(reading)) {
    seen.add(d.kind);
    const e = state.kinds[d.kind] || (state.kinds[d.kind] = { active: false, calm: 0, lastAlertAt: null, lastMag: null, since: null });
    e.calm = 0;
    if (!e.active) {
      e.active = true;
      e.since = now;
      e.lastMag = d.magnitude;
      const cooling = e.lastAlertAt != null && now - e.lastAlertAt < TUNING.cooldownMs;
      const text = cooling ? null : describe(d.kind, reading);
      if (text) { events.push({ type: 'alert', kind: d.kind, at: now, magnitude: d.magnitude, ...text }); e.lastAlertAt = now; }
    } else if (worse(d.kind, d.magnitude, e.lastMag)) {
      const text = describe(d.kind, reading);
      e.lastMag = d.magnitude;
      if (text) events.push({ type: 'worse', kind: d.kind, at: now, magnitude: d.magnitude, ...text });
    }
  }

  for (const [kind, e] of Object.entries(state.kinds)) {
    if (seen.has(kind) || !e.active || !measured(reading, kind)) continue;
    e.calm += 1;
    if (e.calm >= TUNING.clearAfter) {
      e.active = false;
      e.calm = 0;
      events.push({ type: 'clear', kind, at: now, title: `Cleared: ${kind === 'stolen' ? 'the machine is back near its best' : kind === 'swap' ? 'swap has stopped moving' : kind.startsWith('leak:') ? `${kind.slice(5)} has stopped climbing` : 'no longer costing time'}` });
    }
  }
  return { state, events };
}

// ---------------------------------------------------------------------------
// Readings. The cheap sample is free: swap and the load average, no probe. The
// deep one is the Pressure tab's own `collect()`, which runs the probe.
// ---------------------------------------------------------------------------
async function sampleCheap(history, now, mem = {}) {
  const [swap, vm] = await Promise.all([platform.swapStats(), platform.memoryStats().catch(() => null)]);
  const [l1, l5] = os.loadavg();
  const ramMB = os.totalmem() / 1048576;
  const swapOfRam = swap && ramMB ? swap.usedMB / ramMB : null;
  if (swapOfRam != null) {
    history.push({ t: now, swapOfRam });
    while (history.length > 60) history.shift();
  }
  // The slope: how much of RAM's worth of swap was gained across the oldest sample
  // still inside the window. Level says where it is; slope says where it is going.
  const inWindow = history.filter((h) => now - h.t <= TUNING.slopeWindowMs);
  const oldest = inWindow[0];
  const gainedOfRam = oldest && swapOfRam != null && oldest !== history[history.length - 1] ? swapOfRam - oldest.swapOfRam : null;
  // Swap ACTIVITY: the counters' difference since the last reading. `mem` is the caller's
  // memory between readings: the previous counters and how many readings in a row were moving.
  const cur = vm ? { t: now, swapouts: vm.swapouts, swapins: vm.swapins } : null;
  const rate = swapRate(mem.prev, cur);
  if (cur) mem.prev = cur;
  mem.movingStreak = rate && rate.outPerSec >= TUNING.swapOutPagesPerSec ? (mem.movingStreak || 0) + 1 : 0;

  // Leaks: one process-list sample every `pointEveryMs`, not every reading (it costs two
  // commands). Between samples the last verdict stands.
  let leaks = mem.leaks || null;
  if (mem.series && (mem.series.lastT == null || now - mem.series.lastT >= TUNING.leak.pointEveryMs)) {
    try {
      const procs = await platform.processList();
      const fam = {}, famRec = {};
      for (const p of procs) {
        if (!(p.rssKB > 0) || p.family === 'macOS (system)') continue;
        fam[p.family] = (fam[p.family] || 0) + p.rssKB / 1024;
        const e = famRec[p.family] || (famRec[p.family] = { mb: 0, n: 0 });
        e.mb += p.rssKB / 1024; e.n += 1;
      }
      if (leak.push(mem.series, fam, now, TUNING.leak)) {
        leaks = mem.leaks = leak.leaks(mem.series, TUNING.leak);
        const top = Object.entries(famRec).sort((a, b) => b[1].mb - a[1].mb).slice(0, TUNING.leak.maxFamilies);
        history.recordFamilies({ t: now, fam: Object.fromEntries(top), app: headroom.tally(procs) }, { dir: mem.dir });
      }
    } catch { /* a sample that could not be taken leaves the last verdict standing */ }
  }
  return {
    swapOutPerSec: rate ? rate.outPerSec : null, swapInPerSec: rate ? rate.inPerSec : null,
    swapMovingStreak: mem.movingStreak, leaks,
    swapOfRam, swapUsedMB: swap ? swap.usedMB : null, swapTotalMB: swap ? swap.totalMB : null, ramMB,
    gainedOfRam, spanMs: oldest ? now - oldest.t : null,
    load1: l1, load5: l5, ncpu: os.cpus().length,
    factor: null, probe: null, rows: null,
  };
}

// Load asks the question. It never answers it.
function suspicious(cheap, ctx) {
  // Held swap still ASKS for the probe: only the probe can say the machine is slow.
  if (cheap.swapOfRam != null && cheap.swapOfRam >= TUNING.swapWatch) return true;
  if ((cheap.swapMovingStreak || 0) >= 1) return true;
  if (cheap.leaks && cheap.leaks.length) return true;
  ctx.loadStreak = cheap.load5 >= TUNING.loadPerCore * cheap.ncpu ? ctx.loadStreak + 1 : 0;
  return ctx.loadStreak >= TUNING.loadStreak;
}

async function sampleDeep(cheap) {
  const d = await pressure.collect();
  return { ...cheap, factor: d.probe.fresh ? null : d.probe.factor, probe: d.probe, rows: d.rows };
}

// ---------------------------------------------------------------------------
// Where it writes. Only inside ~/.cache/reckon/, and it says so.
// ---------------------------------------------------------------------------
function ensureCache() { fs.mkdirSync(CACHE_DIR, { recursive: true }); }

function writeAtomic(file, text) {
  ensureCache();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function appendLog(entry) {
  ensureCache();
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      const keep = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean).slice(-100);
      fs.writeFileSync(LOG_FILE, keep.join('\n') + '\n');
    }
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch { /* a log that cannot be written must not stop the watching */ }
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The words on the banner. One line of cost and the command, if there is one.
function banner(ev) {
  const cmd = firstLine(ev.command);
  return { title: `reckon: ${ev.title}`, body: cmd ? `${ev.hint || ev.cost}  ·  ${cmd}` : (ev.hint || ev.cost) };
}

const HEAD = { alert: '!', worse: '!!', clear: 'ok' };

function summarise(state, reading, level) {
  const active = Object.entries(state.kinds).filter(([, e]) => e.active).map(([k]) => k);
  return { level, state: stateOf(level), active, reading };
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------
async function tick(ctx) {
  const now = Date.now();
  let reading = await sampleCheap(ctx.history, now, ctx.mem);
  const wasActive = Object.values(ctx.alerts.kinds).some((e) => e.active);
  const dueDeep = ctx.forceDeep || now - ctx.lastDeepAt >= TUNING.deepEveryMs;
  if ((ctx.forceDeep || suspicious(reading, ctx) || wasActive) && dueDeep) {
    reading = await sampleDeep(reading);
    ctx.lastDeepAt = now;
    ctx.lastDeep = { factor: reading.factor, probe: reading.probe, rows: reading.rows };
  } else if (ctx.lastDeep && now - ctx.lastDeepAt < TUNING.deepEveryMs) {
    // Carry the last probe forward for the LEVEL only. It is not re-fed to the
    // alert engine as a new reading, so a stale factor cannot raise or clear anything.
    reading = { ...reading, carried: ctx.lastDeep };
  }

  const { state, events } = step(ctx.alerts, reading, now);
  ctx.alerts = state;

  const useFactor = reading.factor != null ? reading.factor : (reading.carried ? reading.carried.factor : null);
  const rising = reading.gainedOfRam != null && reading.gainedOfRam >= TUNING.slopeStep;
  // Moving is known only when the counters could be compared; then held swap reads as resting.
  const swapMoving = reading.swapOutPerSec == null ? null : reading.swapMovingStreak >= TUNING.swapMovingReadings;
  const level = levelOf({ swapOfRam: reading.swapOfRam, factor: useFactor, rising, moving: swapMoving == null ? undefined : swapMoving });

  for (const ev of events) {
    appendLog({ ...ev, level });
    ctx.recent.unshift({ type: ev.type, kind: ev.kind, title: ev.title, at: ev.at });
    ctx.recent.length = Math.min(ctx.recent.length, 8);
    if (ctx.onEvent) ctx.onEvent(ev);
    if (ctx.notify && ev.type !== 'clear') {
      const b = banner(ev);
      await platform.notify(b.title, b.body);
    }
  }

  const me = await self.measure().catch(() => null);
  // The pet is a second process, and this tool states its own cost: measure it too.
  const petMe = ctx.petPid ? await platform.selfProcess(ctx.petPid).catch(() => null) : null;
  const headline = events.find((e) => e.type !== 'clear') || null;
  const snapshot = {
    running: true, pid: process.pid, startedAt: ctx.startedAt, at: now, intervalMs: ctx.intervalMs,
    ...summarise(state, { swapOfRam: reading.swapOfRam, swapOutPerSec: reading.swapOutPerSec, swapInPerSec: reading.swapInPerSec, swapMoving, factor: useFactor, load5: reading.load5, probeRan: reading.factor != null || Boolean(reading.probe) }, level),
    headline: headline ? { title: headline.title, cost: headline.cost, command: firstLine(headline.command) } : (ctx.snapshot && ctx.snapshot.headline) || null,
    recent: ctx.recent,
    cost: me ? { rssMB: me.rssMB, cpuPct: me.cpuPct, ...(petMe && petMe.rssKB != null ? { petMB: +(petMe.rssKB / 1024).toFixed(1) } : {}) } : null,
  };
  // The headline stays while something is still active, and goes when the last kind clears.
  if (!snapshot.active.length) snapshot.headline = null;
  ctx.snapshot = snapshot;
  writeAtomic(STATE_FILE, JSON.stringify(snapshot));
  // phase 4: the swap reading is kept across restarts, so the Memory tab does not start empty.
  if (reading.swapUsedMB != null) history.recordMemory({ t: now, swapMB: reading.swapUsedMB, ramMB: reading.ramMB }, { dir: CACHE_DIR });
  await maybeOpenCorner(ctx, now);
  return { reading, events, level };
}

function stopState(ctx) {
  const last = ctx.snapshot || {};
  try { writeAtomic(STATE_FILE, JSON.stringify({ ...last, running: false, level: 0, state: 'resting', active: [], headline: null, at: Date.now() })); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// The corner window. Off unless asked for (`--corner`), and it lives inside the
// watcher: the dashboard server is not involved. It serves three static files and
// one JSON answer — the snapshot the watcher already holds in memory — to the
// loopback address only, and the page in it measures nothing itself.
//
// The page polls that answer every few seconds. That is a browser asking a local
// process what it already knows, not a collection, and it exists only while the
// person chose `--corner`. It is the one place this project polls, and this is
// where that is said.
// ---------------------------------------------------------------------------
const CORNER_PORT = 4128;
const WEB = path.join(__dirname, '..', 'web');
const CORNER_FILES = Object.freeze({
  '/corner': ['corner.html', 'text/html; charset=utf-8'],
  '/pet.js': ['pet.js', 'text/javascript; charset=utf-8'],
  '/tokens.css': ['tokens.css', 'text/css; charset=utf-8'],
});
const CORNER_REOPEN_AFTER_CALM_MS = 2 * 60_000;

// The request handler on its own, so a test can drive it without a port.
function cornerHandler(ctx) {
  return (req, res) => {
    // Same rule as the dashboard: the page must not be readable from the network.
    const ip = req.socket.remoteAddress || '';
    if (!ip.includes('127.0.0.1') && !ip.includes('::1')) { res.writeHead(403); return res.end('local only'); }
    // A page on another site can be made to resolve its own name to 127.0.0.1 and then read
    // /api/watch. The Host header still carries that other name, so only ours is answered.
    if (req.headers.host !== `127.0.0.1:${CORNER_PORT}`) { res.writeHead(403); return res.end('wrong host'); }
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/api/watch') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(ctx.snapshot || { running: true, level: 0, state: 'resting', active: [], headline: null }));
    }
    const file = CORNER_FILES[route];
    if (!file) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(path.join(WEB, file[0]), (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': file[1], 'cache-control': 'no-store' });
      res.end(data);
    });
  };
}

function startCorner(ctx) {
  return new Promise((resolve) => {
    const server = http.createServer(cornerHandler(ctx));
    server.on('error', (e) => {
      appendLog({ type: 'note', at: Date.now(), title: `the corner server could not listen on port ${CORNER_PORT} (${e && e.code || 'error'})` });
      resolve(null);
    });
    server.listen(CORNER_PORT, '127.0.0.1', () => resolve(server));
  });
}

// Opens the window once when things turn bad, and lets it be opened again only after
// the machine has been calm for a while. The page closes itself when calm; this only
// decides when to ask for it, so a flapping line cannot open a window every minute.
async function maybeOpenCorner(ctx, now) {
  if (!ctx.corner) return;
  const bad = ctx.snapshot && (ctx.snapshot.state === 'uneasy' || ctx.snapshot.state === 'strained');
  if (bad) ctx.calmSince = null;
  else if (ctx.cornerOpenedAt) ctx.calmSince = ctx.calmSince || now;
  if (!bad && ctx.cornerOpenedAt && ctx.calmSince && now - ctx.calmSince > CORNER_REOPEN_AFTER_CALM_MS) {
    ctx.cornerOpenedAt = null;
  }
  if (bad && !ctx.cornerOpenedAt) {
    ctx.cornerOpenedAt = now;
    const ok = await platform.openWindow(`http://127.0.0.1:${CORNER_PORT}/corner`);
    if (ok === false) appendLog({ type: 'note', at: now, title: 'the browser refused to open the corner window' });
    if (ok === null) appendLog({ type: 'note', at: now, title: platform.id === 'win32'
      ? 'the corner window is not available on Windows; the log and the state file still work'
      : 'no Chromium-family browser found for the corner window; the banner and the log still work' });
  }
}

// `--pet`: the native lantern, above everything. It is started ONCE, here, as a child of this
// process, and it never opens a window through the browser: `maybeOpenCorner` is for `--corner`.
// The pet reads watch.json itself, so nothing is served and nothing is polled for it.
// Returns the handle to stop it, or null; what went wrong is said on screen and in the log.
async function startPetFor(ctx, sink) {
  const log = sink || ((msg) => { console.log(`  pet: ${msg}`); appendLog({ type: 'note', at: Date.now(), title: `pet: ${msg}` }); });
  if (platform.id !== 'darwin') {
    log('the native pet is macOS only. On this system reckon watch keeps the log and the state file.');
    return null;
  }
  const handle = await platform.startPet({
    cacheDir: CACHE_DIR, log,
    onExit: (code, signal) => { ctx.petPid = null; log(`the pet closed${signal ? ` (${signal})` : code ? ` (exit ${code})` : ''}. It does not come back until the next reckon watch --pet.`); },
  });
  if (!handle) { log('not started. The banner and the log still work.'); return null; }
  ctx.petPid = handle.pid;
  return handle;
}

function parse(argv) {
  const o = { once: false, notify: true, corner: false, pet: false, intervalMs: TUNING.intervalMs, help: false, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.once = true;
    else if (a === '--no-notify') o.notify = false;
    else if (a === '--corner') o.corner = true;
    else if (a === '--pet') o.pet = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--interval') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n * 1000 < TUNING.minIntervalMs) o.bad = `--interval needs a number of seconds, ${TUNING.minIntervalMs / 1000} or more`;
      else o.intervalMs = Math.round(n * 1000);
    } else o.bad = `unknown option: ${a}`;
  }
  if (o.pet && o.corner && !o.bad) o.bad = '--pet and --corner both show the lantern; choose one';
  return o;
}

const USAGE = `reckon watch — a companion that speaks only when the machine is struggling

  reckon watch                 watch until you press ctrl+c
  reckon watch --once          take one full reading, print it, and exit
  reckon watch --interval 60   seconds between readings (10 or more; default 30)
  reckon watch --no-notify     no native banner; the log and the state file still update
  reckon watch --corner        also show the lantern in a small window, opened only when things turn
                               bad. A page in it asks this process for its numbers every 3 s.
  reckon watch --pet           show the lantern as a small native pet that stays above every window,
                               full-screen apps too (macOS). Compiles one small file the first time.
                               Right-click it to hide or quit; it leaves when this watcher does.

It never starts by itself, writes only inside ~/.cache/reckon/, and never runs the
command it shows you.
`;

async function main(argv) {
  const o = parse(argv || []);
  if (o.help) { console.log(USAGE); return; }
  if (o.bad) { console.error(o.bad + '\n\n' + USAGE); process.exitCode = 1; return; }
  if (!platform.supported) { console.error(platform.unsupportedReason); process.exitCode = 1; return; }

  const other = readState();
  if (!o.once && other && other.running && other.pid !== process.pid && alive(other.pid)) {
    console.error(`reckon watch is already running (pid ${other.pid}). Stop it first, or read ${STATE_FILE}.`);
    process.exitCode = 1;
    return;
  }

  const ctx = {
    history: [], alerts: emptyState(), recent: [], snapshot: null, lastDeep: null, lastDeepAt: 0,
    loadStreak: 0, mem: { prev: null, movingStreak: 0, leaks: null, dir: CACHE_DIR, series: leak.emptySeries() }, forceDeep: o.once, notify: o.notify && !o.once, corner: o.corner && !o.once, pet: o.pet && !o.once, petPid: null, cornerOpenedAt: null, calmSince: null, intervalMs: o.intervalMs, startedAt: Date.now(),
    onEvent: (ev) => console.log(`  ${HEAD[ev.type] || '?'}  ${ev.title}${ev.type === 'clear' ? '' : `\n      ${ev.proof}${ev.command ? `\n      ${firstLine(ev.command)}` : ''}`}`),
  };

  // A restart does not forget the families' climb: the series is rebuilt from what was appended.
  try { leak.seed(ctx.mem.series, history.readFamilies({ dir: CACHE_DIR, limit: 400 }), TUNING.leak); } catch { /* no history yet */ }

  if (o.once) {
    const { reading, level } = await tick(ctx);
    const r = reading;
    console.log(`level ${level}  (${stateOf(level)})`);
    console.log(`swap   ${r.swapOfRam == null ? 'not readable' : `${mb(r.swapUsedMB)} in use, ${Math.round(r.swapOfRam * 100)}% of ${mb(r.ramMB)} of RAM  (the swap file itself is ${mb(r.swapTotalMB)} today; it grows on demand)`}`);
    console.log(`pages  ${r.swapOutPerSec == null ? 'one reading cannot show a rate; run the watcher to see whether swap is moving' : `${Math.round(r.swapOutPerSec)} out/s, ${Math.round(r.swapInPerSec)} in/s: swap is ${r.swapOutPerSec >= TUNING.swapOutPagesPerSec ? 'moving' : 'resting'}`}`);
    console.log(`load   ${r.load1.toFixed(1)} now, ${r.load5.toFixed(1)} over 5 min, on ${r.ncpu} cores  (never an alert on its own)`);
    console.log(`probe  ${r.probe ? `${r.probe.nowMs} ms against a best of ${r.probe.bestMs} ms = ${r.probe.factor}x${r.probe.fresh ? '  (baseline just created, not compared)' : ''}` : 'did not run'}`);
    const active = Object.entries(ctx.alerts.kinds).filter(([, e]) => e.active).map(([k]) => k);
    console.log(active.length ? `active ${active.join(', ')}` : 'nothing crossed a line');
    stopState(ctx);
    return;
  }

  const me = await self.measure().catch(() => null);
  console.log('\n  reckon watch');
  console.log(`  reads every ${o.intervalMs / 1000} s. The probe (about a third of a second of CPU) only runs when something looks off.`);
  console.log(`  this process now: ${me ? `${me.rssMB} MB` : 'not measured'} of RAM.`);
  console.log(`  writes only inside ${CACHE_DIR}  (watch.json, watch.log)`);
  console.log(`  banners: ${o.notify ? 'on' : 'off (--no-notify)'}.`);
  let corner = null;
  if (ctx.corner) {
    corner = await startCorner(ctx);
    console.log(corner
      ? `  corner window: opens by itself when things turn bad, and closes when calm. Served at http://127.0.0.1:${CORNER_PORT}/corner, this machine only.`
      : `  corner window: port ${CORNER_PORT} is busy, so it is off. The banner and the log still work.`);
    if (!corner) ctx.corner = false;
  }
  let pet = null;
  if (ctx.pet) {
    pet = await startPetFor(ctx);
    if (pet) console.log(`  pet: on screen (pid ${pet.pid}), above every window. It reads ${STATE_FILE} and runs nothing.`);
  }
  console.log('  ctrl+c stops it.\n');

  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; stopState(ctx); if (corner) corner.close(); if (pet) pet.stop(); console.log('\n  stopped.'); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);   // the terminal was closed

  // A tick that throws must not end the watching: log it and go on.
  const loop = async () => {
    try { await tick(ctx); } catch (e) { appendLog({ type: 'error', at: Date.now(), title: String(e && e.message || e).slice(0, 200) }); }
    if (!stopping) setTimeout(loop, ctx.intervalMs);
  };
  loop();
}

module.exports = { main, TUNING, CORNER_PORT, CORNER_FILES, startCorner, cornerHandler, maybeOpenCorner, startPetFor, levelOf, stateOf, swapRate, sampleCheap, detect, describe, step, emptyState, measured, parse,
  CACHE_DIR, STATE_FILE, LOG_FILE };
