'use strict';
const { run } = require('./sh');

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

  // Cumulative %CPU of our own process, straight from ps: the same number
  // Activity Monitor would show.
  const r = await run('ps', ['-o', '%cpu,rss,etime', '-p', String(process.pid)], { timeout: 5000 });
  let cpu = null, rssKB = null, alive = null;
  if (r.ok) {
    const l = r.out.split('\n')[1];
    if (l) { const c = l.trim().split(/\s+/); cpu = +c[0]; rssKB = +c[1]; alive = c[2]; }
  }

  const totalBytes = parseInt((await run('sysctl', ['-n', 'hw.memsize'], { timeout: 4000 })).out.trim(), 10) || 0;
  const rss = rssKB != null ? rssKB * 1024 : mem.rss;

  return {
    pid: process.pid,
    rssMB: +(rss / 1048576).toFixed(1),
    peakMB: +(peakRSS / 1048576).toFixed(1),
    heapMB: +(mem.heapUsed / 1048576).toFixed(1),
    cpuPct: cpu,
    alive,
    shareOfRam: totalBytes ? +((rss / totalBytes) * 100).toFixed(2) : null,
    scans,
    msPerScan: scans ? Math.round(msScanning / scans) : 0,
    // The design decision that keeps the cost honest: nothing runs unasked.
    policy: 'Collects on demand. Zero background polling: between your clicks this process sits idle.',
    at: Date.now(), since: startedAt,
  };
}

module.exports = { measure, markScan };
