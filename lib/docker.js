'use strict';
const { run } = require('./sh');
const platform = require('./platform');

// ---------------------------------------------------------------------------
// Docker speaks the same CLI everywhere, so its own commands are run directly.
// What is NOT the same everywhere is where the disk image lives and how a
// sparse file is measured, and both of those come through lib/platform.
//
// Every docker call goes through argv, never a shell line: `sh()` runs /bin/sh,
// which does not exist on Windows, and a collector that reaches for it there
// reports a machine with no Docker on it rather than saying so.
// ---------------------------------------------------------------------------

async function version() {
  const r = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 12000 });
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

// Run a command INSIDE the Docker VM. It is the only way to see what
// `docker system df` hides: that command measures Docker objects, not the disk.
async function inVM(cmdline, timeout = 90000) {
  const r = await run('docker', ['run', '--rm', '--privileged', '--pid=host', 'alpine',
    'nsenter', '-t', '1', '-m', '-u', '-n', '-i', '--', 'sh', '-c', cmdline], { timeout });
  return r.ok ? r.out : null;
}

// '5.777GB' -> KB. Docker hands back text; a chart needs a number.
function toKB(txt) {
  const m = String(txt || '').match(/([\d.]+)\s*([KMGT]?)B/i);
  if (!m) return 0;
  const mult = { '': 1 / 1024, K: 1, M: 1024, G: 1048576, T: 1073741824 };
  return Math.round(parseFloat(m[1]) * (mult[m[2].toUpperCase()] ?? 1));
}

async function countedByDocker() {
  const r = await run('docker', ['system', 'df', '--format', '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}'], { timeout: 25000 });
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l) => {
    const [type, size, reclaimable] = l.split('\t');
    return { type, size, reclaimable, kb: toKB(size), reclaimableKB: toKB(reclaimable) };
  });
}

// ---------------------------------------------------------------------------
// GUARD: `docker system df` does NOT list named volumes as reclaimable, and
// pruning while a container is stopped deletes that container's volume along
// with it. These three cases have to stay apart:
//   - genuinely orphaned (dangling, nobody references it)
//   - attached to a STOPPED container -> `docker start` before any prune
//   - in use by a RUNNING container   -> do not touch
// ---------------------------------------------------------------------------
async function volumes() {
  const r = await run('docker', ['volume', 'ls', '--format', '{{.Name}}'], { timeout: 20000 });
  if (!r.ok) return [];
  const names = r.out.split('\n').filter(Boolean);
  const dang = await run('docker', ['volume', 'ls', '-qf', 'dangling=true'], { timeout: 20000 });
  const orphans = new Set((dang.ok ? dang.out : '').split('\n').filter(Boolean));

  const usage = new Map();
  const ps = await run('docker', ['ps', '-a', '--format', '{{.ID}}\t{{.Names}}\t{{.State}}'], { timeout: 20000 });
  for (const l of (ps.ok ? ps.out : '').split('\n').filter(Boolean)) {
    const [id, name, state] = l.split('\t');
    const m = await run('docker', ['inspect', id, '--format', '{{range .Mounts}}{{.Name}} {{end}}'], { timeout: 15000 });
    if (!m.ok) continue;
    for (const v of m.out.trim().split(/\s+/).filter(Boolean)) {
      if (!usage.has(v)) usage.set(v, []);
      usage.get(v).push({ container: name, state });
    }
  }

  const out = [];
  for (const name of names) {
    const uses = usage.get(name) || [];
    const running = uses.filter((u) => u.state === 'running');
    const stopped = uses.filter((u) => u.state !== 'running');
    let situation = 'orphan';
    if (running.length) situation = 'in_use';
    else if (stopped.length) situation = 'attached_to_stopped';
    else if (!orphans.has(name)) situation = 'named_no_container';
    out.push({ name, situation, uses, named: !/^[0-9a-f]{64}$/.test(name) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Container logs are the blind spot: `docker system df` reports a container's
// SIZE (its writable layer, a few kB) and never the -json.log, which can hold
// gigabytes. This is where the tool earns its keep.
// ---------------------------------------------------------------------------
async function logs() {
  const out0 = await inVM("ls -l /var/lib/docker/containers/*/*-json.log 2>/dev/null | awk '{print $5\"\\t\"$9}' | sort -rn | head -12");
  if (!out0) return [];
  const out = [];
  for (const l of out0.split('\n').filter(Boolean)) {
    const [bytes, file] = l.split('\t');
    const id = (file || '').split('/')[5] || '';
    if (!id) continue;
    const n = parseInt(bytes, 10);
    if (!Number.isFinite(n) || n < 102400) continue;   // under 100 kB earns no row
    const info = await run('docker', ['inspect', id.slice(0, 12), '--format',
      '{{.Name}}\t{{.RestartCount}}\t{{.State.Status}}\t{{.HostConfig.RestartPolicy.Name}}\t{{index .HostConfig.LogConfig.Config "max-size"}}'],
      { timeout: 15000 });
    const [name, restarts, status, policy, maxSize] = info.ok ? info.out.trim().split('\t') : [];
    out.push({
      id: id.slice(0, 12), bytes,
      name: (name || id.slice(0, 12)).replace(/^\//, ''),
      restarts: parseInt(restarts, 10) || 0,
      status, policy,
      noRotation: !maxSize || maxSize === '<no value>' || maxSize === '',
    });
  }
  return out.map((l) => ({ ...l, bytes: Number(l.bytes) }));
}

async function vmSpace() {
  const df = await inVM('df -k /var/lib/docker | tail -1');
  const du = await inVM('du -sk /var/lib/docker/* 2>/dev/null | sort -rn | head -8');
  let vmUsage = null;
  if (df) {
    const c = df.trim().split(/\s+/);
    vmUsage = { totalKB: +c[1], usedKB: +c[2], freeKB: +c[3] };
  }
  const folders = (du || '').split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('\t');
    return { kb: parseInt(l.slice(0, i), 10), path: l.slice(i + 1) };
  }).filter((x) => Number.isFinite(x.kb));
  return { vmUsage, folders };
}

async function collect({ deep = false } = {}) {
  const v = await version();
  if (!v) return { running: false, why: 'Docker is not responding (stopped, or still starting).' };

  // null here is two different things and both are honest: this platform keeps
  // no single-file disk image, or the file is sparse in a way the platform
  // cannot measure. Either way nothing is claimed about trapped space.
  const RAW = platform.dockerDiskImagePath();
  const rawKB = RAW ? await platform.realSizeKB(RAW) : null;
  const counted = await countedByDocker();
  const vols = await volumes();
  const extra = deep ? { logs: await logs(), ...(await vmSpace()) } : {};

  return { running: true, version: v, rawKB, rawPath: RAW, counted, volumes: vols, ...extra, at: Date.now() };
}

module.exports = { collect, inVM, toKB };
