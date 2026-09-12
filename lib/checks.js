'use strict';
const { run } = require('./sh');
const platform = require('./platform');

// Nothing gets a row here unless it has a FIX. A diagnosis with no action is noise.
//
// The one exception is a check that could not be made. That still earns a row,
// because the alternative is a screen that looks clean for the wrong reason —
// and the fix on those rows is "find this out yourself, here is where".

// ---------------------------------------------------------------------------
// Backup.
//
// Three different answers, and keeping them apart is the whole value of this
// check. A backup tool that reports no destination is a serious finding. A
// backup tool that reports a destination and a date is a reassurance. A
// platform whose backup state cannot be read is NEITHER, and it must not be
// rendered as either: a person who believes they are backed up does not make a
// backup.
// ---------------------------------------------------------------------------
async function backup() {
  const b = await platform.backupStatus();

  if (b == null) {
    return { id: 'backup', title: 'Cannot tell whether this machine is backed up', serious: false,
      found: 'This platform has no backup tool reckon can ask. It is NOT saying a backup exists, and it is not saying one does not — '
        + 'file-sync folders copy a deletion as faithfully as they copy a file, and a system restore point is not a copy of your work.',
      fix: 'Check it by hand, once: an external disk with a real backup tool pointed at it, or a second copy of anything you could not rewrite.',
      cost: 'Nothing to check. Without a backup, one disk failure takes everything that is not on a remote.' };
  }

  if (!b.configured) {
    return { id: 'backup', title: 'No backup configured', serious: true,
      found: `${b.tool} has no destination at all. No copy of this machine exists anywhere.`,
      fix: 'System Settings > General > Time Machine > Add Backup Disk. An external SSD is enough.',
      cost: 'Nothing to set it up. Without it, one disk failure takes everything that is not on a remote or in the cloud.' };
  }

  // A configured tool whose last run cannot be dated is not a current backup.
  // Rendering that null as "current" is the same lie as rendering it as zero.
  if (b.ageDays == null) {
    return { id: 'backup', title: `${b.tool} is configured, last run unknown`, serious: false,
      found: `${b.tool} has a destination, but the date of the last backup could not be read.`,
      fix: 'Open the backup tool and look at the date before trusting it.', cost: 'Nothing.' };
  }

  const old = b.ageDays > 7;
  return { id: 'backup', title: old ? `Last backup was ${b.ageDays} days ago` : 'Backup is current',
    serious: old, found: `Last backup: ${b.latest || 'unknown'}.`,
    fix: old ? 'tmutil startbackup' : null, cost: 'Nothing.' };
}

async function space() {
  const v = await platform.volumeUsage();
  if (!v) {
    return { id: 'space', title: 'Cannot read how full the disk is', serious: false,
      found: 'The volume holding your home directory did not answer. Every space figure on the other tabs is missing for the same reason.',
      fix: 'Open the system\'s own storage panel and read it there.', cost: 'Nothing.' };
  }
  // usedPct is already a number. Do not re-add a percent sign and do not parse
  // it again: a stray parseInt on a number that is already a number is how a
  // comparison silently becomes NaN and every threshold below stops firing.
  const pct = v.usedPct;
  const freeGB = (v.freeKB / 1048576).toFixed(1);
  return { id: 'space', title: pct >= 85 ? `Disk at ${pct}%` : `Disk at ${pct}% — comfortable`,
    serious: pct >= 85,
    found: `${freeGB} GB free of ${(v.totalKB / 1048576).toFixed(0)} GB.`,
    fix: pct >= 85 ? 'See the Overview tab: it lists what goes first.' : null, cost: 'Nothing.' };
}

// Swap and compression tell the story the user experiences as "it's slow".
async function pressure() {
  const sw = await platform.swapStats();
  if (!sw) return null;
  const used = sw.usedMB, total = sw.totalMB;
  const pct = total ? Math.round((used / total) * 100) : 0;
  return { id: 'swap', title: pct >= 60 ? `Swap at ${pct}% — the disk is standing in for RAM` : `Swap at ${pct}%`,
    serious: pct >= 60,
    found: `${(used / 1024).toFixed(1)} GB of swap in use (of ${(total / 1024).toFixed(1)} GB). Swap is disk pretending to be memory: this is what the machine feels like when it stalls.`,
    fix: pct >= 60 ? 'Open the Memory tab and quit the largest group you are not using right now.' : null,
    cost: 'Whatever is unsaved in the app you quit.' };
}

// Docker speaks the same command line everywhere, so these two ask it directly.
// Through argv, never a shell line: `sh()` runs /bin/sh, and a platform without
// one would report a machine with no containers rather than saying so.
const dockerPs = () => run('docker', ['ps', '-a', '--format', '{{.ID}}\t{{.Names}}'], { timeout: 20000 });

// A container restarting in a loop burns CPU and fills the disk with log, quietly.
async function restartLoops() {
  const r = await dockerPs();
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
  const r = await dockerPs();
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

// The platform's own services are already filtered out before this gets them:
// only the platform knows what its vendor prefix is, and system noise has no
// fix a person can apply.
async function failedServices() {
  const failed = await platform.failedServices({ limit: 12 });
  if (!failed.length) return null;
  return { id: 'services', title: `${failed.length} user service(s) exited with an error`, serious: false,
    found: failed.slice(0, 6).map((f) => `${f.label} (code ${f.exitCode})`).join('\n'),
    fix: 'Read why it failed before changing anything — the service manager records the reason.',
    cost: 'Nothing to inspect.' };
}

// ---------------------------------------------------------------------------
// Folders the panel knows about, found on this machine, and could not measure.
//
// This exists because the failure it reports is invisible everywhere else. A
// folder whose size could not be read is dropped from the Disk tab and from the
// total, so a platform where the measuring tool is missing, too slow or refused
// produces a confident "0 GB can be freed" on a machine that is full. This row
// is what makes that state say so.
// ---------------------------------------------------------------------------
function unmeasured(list) {
  if (!list || !list.length) return null;
  return { id: 'unmeasured', title: `${list.length} known folder(s) could not be measured`, serious: true,
    found: `These exist on this machine and the panel could not read their size, so they are missing from the Disk tab AND from the total on the Overview tab:\n`
      + list.slice(0, 8).map((t) => `${t.label} — ${t.path}`).join('\n')
      + (list.length > 8 ? `\n…and ${list.length - 8} more.` : '')
      + '\nWhatever is in them is not counted anywhere on this screen.',
    fix: 'Measure one by hand to see what stopped it — a permission, a folder too large to walk inside the time limit, or a tool that is not installed.',
    cost: 'Nothing to check.' };
}

async function collect({ unmeasuredTargets = [] } = {}) {
  const raw = await Promise.all([backup(), space(), pressure(), restartLoops(), unboundedLogs(), failedServices()]);
  const items = [...raw, unmeasured(unmeasuredTargets)].filter(Boolean);
  return { items: items.sort((a, b) => (b.serious ? 1 : 0) - (a.serious ? 1 : 0)), at: Date.now() };
}

module.exports = { collect };
