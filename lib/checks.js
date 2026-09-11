'use strict';
const { run, sh } = require('./sh');

// Nothing gets a row here unless it has a FIX. A diagnosis with no action is noise.

async function backup() {
  const dest = await run('tmutil', ['destinationinfo'], { timeout: 15000 });
  const noDestination = !dest.ok || /No destinations configured/i.test(dest.out + (dest.erro || ''));
  if (noDestination) {
    return { id: 'backup', title: 'No backup configured', serious: true,
      found: 'Time Machine has no destination at all. No copy of this machine exists anywhere.',
      fix: 'System Settings > General > Time Machine > Add Backup Disk. An external SSD is enough.',
      cost: 'Nothing to set it up. Without it, one disk failure takes everything that is not on a remote or in the cloud.' };
  }
  const latest = await run('tmutil', ['latestbackup'], { timeout: 20000 });
  const name = (latest.out || '').trim().split('/').pop() || null;
  let days = null;
  const m = name && name.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) days = Math.floor((Date.now() - new Date(`${m[1]}-${m[2]}-${m[3]}`).getTime()) / 86400000);
  return { id: 'backup', title: days > 7 ? `Last backup was ${days} days ago` : 'Backup is current',
    serious: days > 7, found: `Last backup: ${name || 'unknown'}.`,
    fix: days > 7 ? 'tmutil startbackup' : null, cost: 'Nothing.' };
}

async function space() {
  const r = await sh('df -k /System/Volumes/Data | tail -1', { timeout: 8000 });
  const c = r.out.trim().split(/\s+/);
  const pct = parseInt(c[4], 10);
  const freeGB = (c[3] / 1048576).toFixed(1);
  return { id: 'space', title: pct >= 85 ? `Disk at ${pct}%` : `Disk at ${pct}% — comfortable`,
    serious: pct >= 85,
    found: `${freeGB} GB free of ${(c[1] / 1048576).toFixed(0)} GB.`,
    fix: pct >= 85 ? 'See the Overview tab: it lists what goes first.' : null, cost: 'Nothing.' };
}

// Swap and compression tell the story the user experiences as "it's slow".
async function pressure() {
  const sw = await run('sysctl', ['-n', 'vm.swapusage'], { timeout: 6000 });
  const g = (k) => { const m = sw.out.match(new RegExp(k + '\\s*=\\s*([\\d.]+)M')); return m ? +m[1] : 0; };
  const used = g('used'), total = g('total');
  const pct = total ? Math.round((used / total) * 100) : 0;
  return { id: 'swap', title: pct >= 60 ? `Swap at ${pct}% — the disk is standing in for RAM` : `Swap at ${pct}%`,
    serious: pct >= 60,
    found: `${(used / 1024).toFixed(1)} GB of swap in use (of ${(total / 1024).toFixed(1)} GB). Swap is disk pretending to be memory: this is what the machine feels like when it stalls.`,
    fix: pct >= 60 ? 'Open the Memory tab and quit the largest group you are not using right now.' : null,
    cost: 'Whatever is unsaved in the app you quit.' };
}

// A container restarting in a loop burns CPU and fills the disk with log, quietly.
async function restartLoops() {
  const r = await sh("docker ps -a --format '{{.ID}}\t{{.Names}}' 2>/dev/null", { timeout: 20000 });
  if (!r.ok || !r.out.trim()) return null;
  const bad = [];
  for (const l of r.out.split('\n').filter(Boolean)) {
    const [id, name] = l.split('\t');
    const i = await run('docker', ['inspect', id, '--format', '{{.RestartCount}}\t{{.State.Status}}\t{{.HostConfig.RestartPolicy.Name}}'], { timeout: 12000 });
    if (!i.ok) continue;
    const [rc, status, policy] = i.out.trim().split('\t');
    if ((parseInt(rc, 10) || 0) >= 5) bad.push({ name, restarts: +rc, status, policy });
  }
  if (!bad.length) return null;
  const worst = bad.sort((a, b) => b.restarts - a.restarts)[0];
  return { id: 'restart-loop', title: `${worst.name} has restarted ${worst.restarts} times`, serious: true,
    found: `${bad.length} container(s) in a restart cycle. ${worst.name} leads with ${worst.restarts} restarts under policy '${worst.policy}'. Every cycle burns CPU and writes a fresh startup log.`,
    fix: `docker logs --tail 50 ${worst.name}   # find out why it dies before stopping the cycle`,
    cost: 'Nothing to read the log. If you stop the container, whatever depends on it stops too.',
    extra: bad };
}

// A container log with no rotation grows until the disk runs out. Silently.
async function unboundedLogs() {
  const r = await sh("docker ps -a --format '{{.ID}}\t{{.Names}}' 2>/dev/null", { timeout: 20000 });
  if (!r.ok || !r.out.trim()) return null;
  const without = [];
  for (const l of r.out.split('\n').filter(Boolean)) {
    const [id, name] = l.split('\t');
    const i = await run('docker', ['inspect', id, '--format', '{{index .HostConfig.LogConfig.Config "max-size"}}'], { timeout: 12000 });
    if (!i.ok) continue;
    const v = i.out.trim();
    if (!v || v === '<no value>') without.push(name);
  }
  if (!without.length) return null;
  return { id: 'log-unbounded', title: `${without.length} containers with no log limit`, serious: false,
    found: `Without 'max-size' the -json.log file grows with no ceiling. They are: ${without.slice(0, 6).join(', ')}${without.length > 6 ? '…' : ''}.`,
    fix: 'In each docker-compose.yml:\n  logging:\n    driver: json-file\n    options: { max-size: "10m", max-file: "3" }\nThen: docker compose up -d',
    cost: 'Log history beyond the new limit. No application data.' };
}

async function failedServices() {
  const r = await sh("launchctl list 2>/dev/null | awk 'NR>1 && $2 != 0 && $2 != \"-\" {print $2\"\\t\"$3}' | head -12", { timeout: 15000 });
  if (!r.ok || !r.out.trim()) return null;
  const failed = r.out.split('\n').filter(Boolean).map((l) => { const [code, label] = l.split('\t'); return { code, label }; })
    .filter((s) => s.label && !s.label.startsWith('com.apple.'));   // system noise is not actionable
  if (!failed.length) return null;
  return { id: 'launchd', title: `${failed.length} user service(s) exited with an error`, serious: false,
    found: failed.slice(0, 6).map((f) => `${f.label} (code ${f.code})`).join('\n'),
    fix: 'launchctl print gui/$(id -u)/<label>   # read the reason before changing anything',
    cost: 'Nothing to inspect.' };
}

async function collect() {
  const raw = await Promise.all([backup(), space(), pressure(), restartLoops(), unboundedLogs(), failedServices()]);
  const items = raw.filter(Boolean);
  return { items: items.sort((a, b) => (b.serious ? 1 : 0) - (a.serious ? 1 : 0)), at: Date.now() };
}

module.exports = { collect };
