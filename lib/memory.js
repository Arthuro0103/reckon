'use strict';
const { run, sh } = require('./sh');

// Group processes by what they actually are, not by PID. Fourteen processes
// named `claude` are ONE thing to the person looking at the screen.
function family(comm) {
  const c = comm.trim();
  const base = c.split('/').pop();
  if (/^claude$/.test(base) || c.endsWith('/claude')) return 'Claude Code (CLI)';
  if (c.includes('/Claude.app/') || c.includes('Claude Helper')) return 'Claude Desktop';
  if (c.includes('Virtualization.framework')) return 'Apple VM (Docker/Claude)';
  if (c.includes('com.docker') || base.startsWith('docker')) return 'Docker Desktop';
  if (c.includes('Google Chrome')) return 'Chrome';
  if (c.includes('/Opera.app/') || c.includes('Opera Helper')) return 'Opera';
  if (c.includes('Firefox')) return 'Firefox';
  if (c.includes('Safari')) return 'Safari';
  if (c.includes('/Discord.app/') || c.includes('Discord Helper')) return 'Discord';
  if (c.includes('/Slack.app/') || c.includes('Slack Helper')) return 'Slack';
  if (c.includes('/Code Helper') || c.includes('Visual Studio Code')) return 'VS Code';
  if (c.includes('Steam')) return 'Steam';
  if (c.includes('Spotify')) return 'Spotify';
  if (c.includes('Obsidian')) return 'Obsidian';
  if (base === 'node' || c.endsWith('/node')) return 'node (dev servers)';
  if (base === 'python3' || base.startsWith('python')) return 'python';
  if (base === 'ruby' || base === 'java' || base === 'go') return base;
  if (c.startsWith('/System/') || c.startsWith('/usr/libexec/') || c.startsWith('/usr/sbin/')) return 'macOS (system)';
  return base;
}

async function vmstat() {
  const r = await run('vm_stat', [], { timeout: 5000 });
  if (!r.ok) return null;
  const lines = r.out.split('\n');
  const pageSize = parseInt((lines[0].match(/page size of (\d+)/) || [])[1] || '4096', 10);
  const m = {};
  for (const l of lines.slice(1)) {
    const mt = l.match(/^(.+?):\s+(\d+)\.?$/);
    if (mt) m[mt[1].trim()] = parseInt(mt[2], 10);
  }
  const bytes = (k) => ((m[k] || 0) * pageSize);
  return {
    pageSize,
    free: bytes('Pages free') + bytes('Pages speculative'),
    active: bytes('Pages active'),
    inactive: bytes('Pages inactive'),
    wired: bytes('Pages wired down'),
    compressed: bytes('Pages occupied by compressor'),
    // Counters accumulated since boot. These are the proof that the machine
    // has been suffering, not a reading of how it is right now.
    compressions: m['Compressions'] || 0,
    decompressions: m['Decompressions'] || 0,
    swapins: m['Swapins'] || 0,
    swapouts: m['Swapouts'] || 0,
  };
}

async function swap() {
  const r = await run('sysctl', ['-n', 'vm.swapusage'], { timeout: 5000 });
  if (!r.ok) return null;
  const g = (k) => { const mt = r.out.match(new RegExp(k + '\\s*=\\s*([\\d.]+)M')); return mt ? +mt[1] : 0; };
  return { totalMB: g('total'), usedMB: g('used'), freeMB: g('free') };
}

async function processes() {
  // One `ps`, once. No polling: the panel measures when you look.
  const r = await sh('ps -Axo rss,pid,%cpu,comm | tail -n +2', { timeout: 15000 });
  if (!r.ok) return [];
  const list = [];
  for (const l of r.out.split('\n')) {
    const mt = l.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!mt) continue;
    const rssKB = parseInt(mt[1], 10);
    if (rssKB < 2048) continue;   // under 2 MB changes nothing on screen
    list.push({ rssKB, pid: +mt[2], cpu: +mt[3], comm: mt[4], family: family(mt[4]) });
  }
  return list;
}

function group(list) {
  const map = new Map();
  for (const p of list) {
    const g = map.get(p.family) || { name: p.family, rssKB: 0, cpu: 0, n: 0, biggestPid: null, biggestKB: 0 };
    g.rssKB += p.rssKB; g.cpu += p.cpu; g.n++;
    if (p.rssKB > g.biggestKB) { g.biggestKB = p.rssKB; g.biggestPid = p.pid; }
    map.set(p.family, g);
  }
  return [...map.values()].sort((a, b) => b.rssKB - a.rssKB);
}

async function collect() {
  const [vm, sw, procs] = await Promise.all([vmstat(), swap(), processes()]);
  const totalBytes = parseInt((await run('sysctl', ['-n', 'hw.memsize'], { timeout: 5000 })).out.trim(), 10) || 0;
  return {
    totalBytes, vm, swap: sw,
    groups: group(procs).slice(0, 18),
    processCount: procs.length,
    rssSumKB: procs.reduce((s, p) => s + p.rssKB, 0),
    // Summed RSS exceeds physical RAM because shared memory is counted in every
    // process. Saying so on screen heads off "why does a 16 GB Mac show 20?".
    note: 'Summed RSS counts shared memory more than once — do not compare the total against physical RAM.',
    at: Date.now(),
  };
}

module.exports = { collect, family };
