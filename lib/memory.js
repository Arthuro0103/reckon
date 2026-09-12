'use strict';
const os = require('node:os');
const platform = require('./platform');

// ---------------------------------------------------------------------------
// The Memory tab's collector. Everything it knows about the machine arrives
// through lib/platform; what it adds is the product decisions — which processes
// are too small to matter, and how they are grouped for a person to act on.
// ---------------------------------------------------------------------------

// The wire format the front end reads. It is NOT the contract's field names,
// and the translation happens here, once, in one object literal: web/app.js
// reads `memory.vm.free`, `.active`, `.inactive`, `.wired`, `.compressed`, and
// renaming those in a port would empty the ring chart on every platform at
// once.
function wire(m) {
  if (!m) return null;
  return {
    pageSize: m.pageSizeBytes,
    free: m.freeBytes,
    active: m.activeBytes,
    inactive: m.inactiveBytes,
    wired: m.wiredBytes,
    compressed: m.compressedBytes,
    // Counters accumulated since boot. These are the proof that the machine has
    // been suffering, not a reading of how it is right now. A platform that
    // publishes no counter for one of them reports null, and null here means
    // "this machine does not keep that number" — never zero, which would read
    // on screen as a machine that has never been under pressure.
    compressions: m.compressions,
    decompressions: m.decompressions,
    swapins: m.swapins,
    swapouts: m.swapouts,
  };
}

// Under 2 MB changes nothing on screen. This cut is a product decision and it
// lives here: the platform returns every process, unfiltered, and both the
// count and the summed RSS below are taken AFTER the cut.
const FLOOR_KB = 2048;

async function processes() {
  const list = await platform.processList();
  return list
    .filter((p) => p.rssKB >= FLOOR_KB)
    .map((p) => ({ rssKB: p.rssKB, pid: p.pid, cpu: p.cpuPct, comm: p.command, family: p.family }));
}

function group(list) {
  const map = new Map();
  for (const p of list) {
    const g = map.get(p.family) || { name: p.family, rssKB: 0, cpu: 0, n: 0, biggestPid: null, biggestKB: 0 };
    g.rssKB += p.rssKB;
    // A process whose CPU share could not be read contributes nothing to the
    // group's, rather than turning the whole sum into NaN.
    g.cpu += (p.cpu || 0);
    g.n++;
    if (p.rssKB > g.biggestKB) { g.biggestKB = p.rssKB; g.biggestPid = p.pid; }
    map.set(p.family, g);
  }
  return [...map.values()].sort((a, b) => b.rssKB - a.rssKB);
}

async function collect() {
  const [vm, sw, procs] = await Promise.all([platform.memoryStats(), platform.swapStats(), processes()]);
  return {
    // os.totalmem() is the same number the platform reports and it is the same
    // on every platform, so it is read straight rather than through the seam.
    // The fallback matters: a failed memory read must not also take the "total
    // RAM" figure down with it.
    totalBytes: (vm && vm.totalBytes) || os.totalmem(),
    vm: wire(vm),
    swap: sw,
    groups: group(procs).slice(0, 18),
    processCount: procs.length,
    rssSumKB: procs.reduce((s, p) => s + p.rssKB, 0),
    // Summed RSS exceeds physical RAM because shared memory is counted in every
    // process. Saying so on screen heads off "why does a 16 GB machine show 20?".
    note: 'Summed RSS counts shared memory more than once — do not compare the total against physical RAM.',
    at: Date.now(),
  };
}

module.exports = { collect };
