'use strict';
const os = require('node:os');
const platform = require('./platform');

// ---------------------------------------------------------------------------
// A panel that runs all the time spends the memory it is measuring.
// So it measures itself, and shows the number in the footer, always visible.
// If it ever costs more than it finds, that has to be obvious — not hidden.
// ---------------------------------------------------------------------------
const startedAt = Date.now();
let peakRSS = 0;
let scans = 0;
let msScanning = 0;

function markScan(ms) { scans++; msScanning += ms; }

async function measure() {
  const mem = process.memoryUsage();
  peakRSS = Math.max(peakRSS, mem.rss);

  // The platform's own view of this process: cumulative %CPU, the same number
  // the system's activity monitor would show, and the RSS the system counts
  // rather than the one the runtime reports about itself.
  const me = await platform.selfProcess(process.pid);

  // os.totalmem() is physical RAM on every platform this runs on, so the share
  // below is still right when the platform call above could not be made.
  const totalBytes = os.totalmem();
  const rss = me && me.rssKB != null ? me.rssKB * 1024 : mem.rss;

  return {
    pid: process.pid,
    rssMB: +(rss / 1048576).toFixed(1),
    peakMB: +(peakRSS / 1048576).toFixed(1),
    heapMB: +(mem.heapUsed / 1048576).toFixed(1),
    cpuPct: me ? me.cpuPct : null,
    alive: me ? me.elapsed : null,
    shareOfRam: totalBytes ? +((rss / totalBytes) * 100).toFixed(2) : null,
    scans,
    msPerScan: scans ? Math.round(msScanning / scans) : 0,
    // The design decision that keeps the cost honest: nothing runs unasked.
    policy: 'Collects on demand. Zero background polling: between your clicks this process sits idle.',
    at: Date.now(), since: startedAt,
  };
}

module.exports = { measure, markScan };
