'use strict';
const os = require('node:os');
const { run } = require('./sh');
const platform = require('./platform');

// A command that reaches the screen must not carry somebody's username in it.
// The same shortener decisions.js uses, for the same reason.
//
// os.homedir(), NOT platform.homeDir(). Reaching through the seam here ran a
// required capability at module scope, so merely requiring this file threw on
// a platform with no implementation — and that is what took CI down on Linux.
// This project had already been bitten by exactly that once, with
// hostsFilePath(). Nothing at module scope may touch the seam.
const HOME = os.homedir();
const short = (p) => (HOME ? String(p).split(HOME).join('~') : String(p));

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
    // A ROW WITH ONE FIX YOU CANNOT PERFORM IS A ROW WITH NO FIX.
    //
    // This said "add a backup disk" and stopped. Somebody who does not own one
    // reads that, agrees, and does nothing — and the row has achieved nothing
    // except making them feel bad about a purchase they cannot make today.
    //
    // So it is a ladder now, cheapest rung first. The top rung is still an
    // external disk, because that is the only answer that covers a whole
    // machine. The rungs below it cover less and cost nothing, and covering
    // the irreplaceable part today beats covering everything eventually.
    return { id: 'backup', title: 'No backup configured', serious: true,
      found: `${b.tool} has no destination at all. No copy of this machine exists anywhere.`
        + ' Worth separating two things: what would be annoying to lose, and what could never be rebuilt.'
        + ' Applications reinstall, downloads re-download, caches regenerate. Code you have not pushed, photos that only live here, and documents you wrote cannot be re-derived from anything.',
      fix: `# 1. Free, right now, and it covers the part that is truly irreplaceable.
#    Committed work with no copy elsewhere — see the row about that if it is
#    on this screen. Bundles are kilobytes and restore with \`git clone\`.

# 2. Free, if you already have iCloud, Drive, Dropbox or OneDrive signed in.
#    Put the folders you actually write in inside the synced one. This is NOT
#    a backup — a sync service copies a deletion as faithfully as a file, and
#    ransomware syncs too — but it does survive this disk dying, which is the
#    failure you have no defence against at all today.

# 3. Check your phone photos are already going somewhere.
#    On iPhone: Settings > your name > iCloud > Photos. If that is on, the
#    photo library here is not the only copy and the problem is smaller than
#    it looks.

# 4. The real answer, when you can: any external disk, then
#    ${b.tool === 'Time Machine' ? 'System Settings > General > Time Machine > Add Backup Disk' : 'point ' + b.tool + ' at it'}.
#    It is the only option here that covers a whole machine, including the
#    things you would not think to copy by hand. A used one is enough.`,
      cost: 'Rungs 1 to 3 cost nothing and cover less than everything. Rung 4 costs the price of a disk and covers everything. Doing 1 today is worth more than planning 4 indefinitely.' };
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

// ---------------------------------------------------------------------------
// WORK THAT EXISTS ON THIS DISK AND NOWHERE ELSE.
//
// The backup check above answers "is this machine copied anywhere". This one
// answers a narrower question with a much cheaper fix: how much committed work
// has no copy off this disk, and where. A repository with no remote holds every
// commit it has ever had in one place; a repository with a remote that is
// simply behind holds only what was never pushed. Both are lost by the same
// disk failure and both are fixed in one command.
//
// It is separate from the backup row on purpose. Somebody with no Time Machine
// destination and no external disk to hand cannot act on that row today. They
// can act on this one in thirty seconds, and code is the part of a machine that
// is genuinely irreplaceable — a photo library can be re-downloaded from a
// phone, an unpushed branch cannot be re-derived from anything.
//
// The count is `git rev-list --count --all --not --remotes`: commits reachable
// from a local ref and from no remote ref. A repository where git could not
// answer is counted as unknown rather than as zero, because "nothing is at
// risk" is the one claim on this screen that must never be invented.
// ---------------------------------------------------------------------------
function onlyOnThisDisk(repoData) {
  const repos = (repoData && repoData.repos) || [];
  if (!repos.length) return null;

  const unknown = repos.filter((r) => r.git && r.onlyHere == null);
  const atRisk = repos.filter((r) => r.onlyHere > 0).sort((a, b) => b.onlyHere - a.onlyHere);
  if (!atRisk.length) {
    if (unknown.length) {
      return { id: 'only-here', title: `Could not tell whether ${unknown.length} ${unknown.length === 1 ? 'repository has' : 'repositories have'} a copy elsewhere`, serious: false,
        found: `git could not be asked in ${unknown.map((r) => r.name).slice(0, 6).join(', ')}. That is not the same as "everything is pushed", and this row exists so it does not read like it.`,
        fix: 'Run `git rev-list --count --all --not --remotes` inside one of them to see what it says.',
        cost: 'Nothing to check.' };
    }
    return { id: 'only-here', title: 'Every commit here exists somewhere else too', serious: false,
      found: `All ${repos.filter((r) => r.git).length} repositories have their commits on a remote. A disk failure today would cost no committed work.`,
      fix: null, cost: 'Nothing.' };
  }

  const total = atRisk.reduce((n, r) => n + r.onlyHere, 0);
  const noRemote = atRisk.filter((r) => !r.hasRemote);
  const behind = atRisk.filter((r) => r.hasRemote);
  const worst = atRisk[0];

  return {
    id: 'only-here',
    title: `${total} commit${total === 1 ? '' : 's'} in ${atRisk.length} ${atRisk.length === 1 ? 'repository exists' : 'repositories exist'} only on this disk`,
    // Serious once there is real history at stake. A single unpushed commit is
    // a reason to push, not a reason to shout.
    serious: total >= 10,
    found: atRisk.slice(0, 6).map((r) => `${r.name}: ${r.onlyHere} commit${r.onlyHere === 1 ? '' : 's'}`
        + (r.hasRemote ? ' never pushed' : ' — and no remote at all')
        + (r.lastCommit ? `, last one ${r.days === 0 ? 'today' : r.days === 1 ? 'yesterday' : `${r.days} days ago`}` : '')).join('. ')
      + (atRisk.length > 6 ? `. And ${atRisk.length - 6} more.` : '.')
      + (noRemote.length
        ? ` ${noRemote.length === 1 ? 'One of them has' : `${noRemote.length} of them have`} no remote configured, so ${noRemote.length === 1 ? 'its entire history' : 'their entire histories'} — ${noRemote.reduce((n, r) => n + r.onlyHere, 0)} commits — exists in exactly one place.`
        : '')
      + (unknown.length ? ` A further ${unknown.length} could not be asked, and are not counted here.` : '')
      + ` Counted with \`git rev-list --count --all --not --remotes\`: commits on a local branch and on no remote branch.`,
    fix: behind.length && noRemote.length
      ? `The ones with a remote just need pushing:\n${behind.slice(0, 4).map((r) => `cd ${short(r.path)} && git push`).join('\n')}\n\n# The ones without a remote need a copy made. A bundle is the whole history\n# in one file, and \`git clone that-file\` gives the repository back:\nmkdir -p ~/Backups/repos\n${noRemote.slice(0, 4).map((r) => `git -C ${short(r.path)} bundle create ~/Backups/repos/${r.name}-$(date +%F).bundle --all`).join('\n')}\n\n# Then put the bundles somewhere that is not this disk — that is the part\n# that makes them a backup rather than a second copy on the same drive.`
      : behind.length
        ? `${behind.slice(0, 5).map((r) => `cd ${short(r.path)} && git push`).join('\n')}`
        : `# A bundle is the whole history in one file. \`git clone that-file\` gives\n# the repository back, and it is measured in kilobytes.\nmkdir -p ~/Backups/repos\n${noRemote.slice(0, 5).map((r) => `git -C ${short(r.path)} bundle create ~/Backups/repos/${r.name}-$(date +%F).bundle --all`).join('\n')}\n\n# Then copy them off this disk. On the same drive they are not a backup.`,
    cost: `Pushing publishes work that is currently private to this machine — check what is in it first if that matters. A bundle publishes nothing; it is a file. ${worst.name} alone is ${worst.onlyHere} commits.`,
  };
}

async function collect({ unmeasuredTargets = [], repos = null } = {}) {
  const raw = await Promise.all([backup(), space(), pressure(), restartLoops(), unboundedLogs(), failedServices()]);
  const items = [...raw, unmeasured(unmeasuredTargets), onlyOnThisDisk(repos)].filter(Boolean);
  return { items: items.sort((a, b) => (b.serious ? 1 : 0) - (a.serious ? 1 : 0)), at: Date.now() };
}

module.exports = { collect };
