'use strict';

const kb2gb = (kb) => +(kb / 1048576).toFixed(2);
const b2gb = (b) => +(b / 1073741824).toFixed(2);
const short = (p) => String(p).replace(process.env.HOME, '~');

// ---------------------------------------------------------------------------
// Every decision carries three things: how much it frees, the PROOF of that
// number, and what you lose if the verdict is wrong. Without all three it does
// not become a card.
//
// This tool never deletes: it hands you the command and you run it.
// ---------------------------------------------------------------------------

// What KIND each item is. Not decoration: grouping by kind answers a question
// the ranked list cannot — "what is filling this machine?" — and the answer
// changes what you do next. Clearing caches is a routine; a parked VM is a
// one-time decision.
const KINDS = {
  cache: 'Package cache',
  log: 'Container log',
  vm: 'Image and VM',
  dependency: 'Project dependency',
  browser: 'Test browser',
  build: 'Build output',
  other: 'Other',
};

function classify(id) {
  if (/^docker-log-/.test(id)) return 'log';
  if (/^nm-|^wt-/.test(id)) return 'dependency';
  if (/claude-vm|docker-raw-slack|docker-volumes|simulators/.test(id)) return 'vm';
  if (/playwright|puppeteer/.test(id)) return 'browser';
  if (/xcode-derived|go-build|gradle/.test(id)) return 'build';
  if (/npm-|hf-|pip|brew|uv|pnpm|cargo|trash/.test(id)) return 'cache';
  return 'other';
}

// Two collectors can describe the same path. Repeating it on screen makes the
// total lie and the list look careless.
function dedupe(list) {
  const seen = new Set();
  return list.filter((x) => { if (seen.has(x.id)) return false; seen.add(x.id); return true; });
}

function decision({ id, title, kb, proof, lose, command, confidence = 'high', warning = null, source }) {
  return { id, title, kb, gb: kb2gb(kb), proof, lose, command, confidence, warning, source,
    kind: classify(id), kindLabel: KINDS[classify(id)] };
}

function fromDocker(d) {
  const out = [], stay = [];
  if (!d || !d.running) return { out, stay };

  // 1) Container logs. The blind spot: `docker system df` shows the writable
  //    layer (kilobytes) and never the -json.log (gigabytes).
  for (const l of (d.logs || [])) {
    const kb = Math.round(l.bytes / 1024);
    if (kb < 102400) continue;
    const looping = l.restarts >= 5;
    out.push(decision({
      id: `docker-log-${l.id}`,
      title: `Log of container ${l.name}`,
      kb,
      proof: `${l.name}: a -json.log of ${kb2gb(kb)} GB inside the Docker VM. `
        + '`docker system df` reports this container as a few kilobytes because it only measures the writable layer — the log never enters that count. '
        + (looping ? `The container has restarted ${l.restarts} times under policy '${l.policy}': every cycle writes the startup log again.` : 'No rotation limit is configured.'),
      lose: 'That container\'s log history. No application data, no volume, no database.',
      command: '# 1. find out why it restarts (before erasing the evidence):\n'
        + `docker logs --tail 80 ${l.name}\n\n`
        + '# 2. truncate with the container running (truncate does not break the open handle):\n'
        + 'docker run --rm --privileged --pid=host alpine \\\n'
        + `  nsenter -t 1 -m -u -n -i -- sh -c 'truncate -s 0 /var/lib/docker/containers/${l.id}*/*-json.log'\n\n`
        + '# 3. stop it coming back: in the service\'s docker-compose.yml\n'
        + '#   logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }',
      warning: 'Truncating erases the evidence of why it is restarting. Read the log first (step 1).',
      source: 'docker + reading the VM directly',
    }));
  }

  // 2) Slack inside Docker.raw: space the VM already freed internally that
  //    macOS has not recovered. Not new garbage — the same space, stuck.
  if (d.rawKB && d.vmUsage) {
    const slackKB = d.rawKB - d.vmUsage.usedKB;
    if (slackKB > 1048576) {
      out.push(decision({
        id: 'docker-raw-slack',
        title: 'Slack trapped in the Docker virtual disk',
        kb: slackKB,
        proof: `Docker.raw occupies ${kb2gb(d.rawKB)} GB of real space on your SSD, but inside it the VM only uses ${kb2gb(d.vmUsage.usedKB)} GB. `
          + 'The difference is space Docker already released internally and never handed back to macOS.',
        lose: 'Nothing. No image, container or volume is touched — the file just shrinks to the size of its contents.',
        command: '# Docker Desktop > Settings > Resources > Advanced > Disk usage > "Reclaim space"\n'
          + '# Or from the command line, with Docker running:\n'
          + 'docker run --rm --privileged --pid=host alpine \\\n'
          + '  nsenter -t 1 -m -u -n -i -- fstrim -v /var/lib/docker',
        confidence: 'medium',
        warning: 'It only shrinks AFTER you free whatever is occupying the VM (the log above). Do the log first, the trim second.',
        source: 'stat of Docker.raw + df inside the VM',
      }));
    }
  }

  // 3) GUARD: a NAMED volume is not removed by prune, and pruning while a
  //    container is stopped deletes that container's volume. Separating the
  //    cases is what prevents the damage.
  const orphans = (d.volumes || []).filter((v) => v.situation === 'orphan');
  const attached = (d.volumes || []).filter((v) => v.situation === 'attached_to_stopped');
  if (orphans.length) {
    out.push(decision({
      id: 'docker-volumes-orphan', title: `${orphans.length} Docker volumes with no owner`, kb: 0,
      proof: `No container points at them: ${orphans.map((v) => v.name).join(', ')}. `
        + 'This item frees no gigabytes; it is here so you do not go hunting for space where there is none.',
      lose: 'The data in those volumes.',
      command: "# name them one by one. `docker volume prune` skips NAMED volumes,\n"
        + "# and `prune --volumes` with a stopped container deletes THAT container's volume too.\n"
        + orphans.map((v) => `docker volume rm ${v.name}`).join('\n'),
      source: 'docker volume ls + inspect of every container',
    }));
  }
  if (attached.length) {
    stay.push({
      id: 'docker-volumes-attached', title: `${attached.length} volume(s) attached to a stopped container`,
      why: `${attached.map((v) => v.name).join(', ')}. Running \`docker system prune --volumes\` while those containers are stopped deletes the volumes with them. Start the containers first, or do not prune.`,
      kb: 0,
    });
  }
  for (const v of (d.volumes || []).filter((x) => x.situation === 'in_use')) {
    stay.push({ id: `vol-${v.name}`, title: `Volume ${v.name}`,
      why: `In use by ${v.uses.map((u) => u.container).join(', ')} (running now). This is a live project's database.`, kb: 0 });
  }
  return { out, stay };
}

function fromDisk(targets) {
  const out = [], stay = [];
  for (const t of targets || []) {
    if (t.verdict === 'disposable') {
      out.push(decision({
        id: `disk-${t.id}`, title: t.label, kb: t.kb,
        proof: `${kb2gb(t.kb)} GB in ${short(t.path)}`
          + (t.sparse ? ' (measured in real blocks: a sparse file lies about its apparent size).' : '.')
          + (t.symlinks && t.symlinks.length ? ` WARNING: ${t.symlinks.length} symlink(s) point here.` : ' No symlink points here.')
          + (t.hardlinks && t.hardlinks.suspect ? ` ${t.hardlinks.withHardlink} of ${t.hardlinks.files} files have hard links: deleting may free less than the number says.` : ''),
        lose: t.lose, command: t.command,
        confidence: (t.symlinks && t.symlinks.length) || (t.hardlinks && t.hardlinks.suspect) ? 'medium' : 'high',
        warning: t.symlinks && t.symlinks.length
          ? `A symlink points at this path: ${t.symlinks.map((s) => short(s.link)).join(', ')}. Deleting the target breaks the link.`
          : null,
        source: 'du -sk + a search for symlinks and hard links',
      }));
    } else {
      stay.push({ id: `disk-${t.id}`, title: t.label, kb: t.kb, gb: kb2gb(t.kb), why: t.lose, verdict: t.verdict });
    }
  }
  return { out, stay };
}

function fromRepos(r) {
  const out = [], stay = [];
  for (const repo of (r.repos || [])) {
    const nmKB = repo.nodeModulesKB || 0;

    // node_modules of a PARKED project: one command rebuilds it.
    if (repo.stale && nmKB > 102400) {
      const cmd = repo.manager === 'pnpm' ? 'pnpm install'
        : repo.manager === 'bun' ? 'bun install'
        : repo.manager === 'yarn' ? 'yarn install' : 'npm install';
      out.push(decision({
        id: `nm-${repo.name}`, title: `node_modules of ${repo.name}`, kb: nmKB,
        proof: `Last commit ${repo.lastCommit} (${repo.days} days ago). `
          + `${kb2gb(nmKB)} GB of dependencies that \`${cmd}\` rebuilds.`
          + (repo.off > 0 ? ` The REPO stays: it holds ${repo.off} commit(s) that are not on ${repo.base}.` : ''),
        lose: `None of your code. To run the project again: cd ${short(repo.path)} && ${cmd}`
          + (repo.dirtyCount > 0 ? ` — note: ${repo.dirtyCount} file(s) here are modified without a commit; they are NOT inside node_modules and will not be touched.` : ''),
        command: `rm -rf ${short(repo.path)}/node_modules   # only the dependency folder, nothing from the repo`,
        source: 'git log + du',
      }));
    }

    // GUARD: commits off the main branch mean the folder is NOT garbage,
    // however long it has sat still.
    if (repo.off > 0) {
      stay.push({
        id: `repo-${repo.name}`, title: `Repo ${repo.name}`, kb: 0,
        why: `${repo.off} commit(s) on branch '${repo.branch}' that are not on '${repo.base}'`
          + (repo.pushed ? `. They are pushed to ${repo.remotes[0]} — a copy exists off this machine, but your local ${repo.base} does not have them.` : '. They are on NO remote: this machine is the only copy.'),
        verdict: 'yours', critical: !repo.pushed,
      });
    } else if (!repo.git) {
      stay.push({ id: `repo-${repo.name}`, title: `Folder ${repo.name}`, kb: 0, why: repo.why, verdict: 'unknown' });
    } else if (!repo.hasRemote) {
      stay.push({ id: `repo-${repo.name}`, title: `Repo ${repo.name}`, kb: 0,
        why: 'No remote at all. Whatever is here exists nowhere else.', verdict: 'yours', critical: true });
    } else if (repo.dirtyCount > 20) {
      stay.push({ id: `repo-${repo.name}`, title: `Repo ${repo.name}`, kb: 0,
        why: `${repo.dirtyCount} files modified without a commit. Changes that exist only here.`, verdict: 'yours' });
    }
  }

  // Worktrees: only the merge base decides. And a merged worktree you are still
  // working in is not garbage either.
  for (const w of (r.worktrees || [])) {
    if (w.off > 0) {
      stay.push({ id: `wt-${w.name}`, title: `Worktree ${w.name}`, kb: w.sizeKB || 0,
        why: `${w.off} commit(s) off ${w.base}. Not disposable, whatever its size.`, verdict: 'yours', critical: !w.pushed });
    } else if (w.days != null && w.days <= 7) {
      stay.push({ id: `wt-${w.name}`, title: `Worktree ${w.name}`, kb: w.sizeKB || 0,
        why: `Already merged into ${w.base} (0 commits off it), but you committed here ${w.days} day(s) ago. This is live workspace.`, verdict: 'yours' });
    } else if (w.sizeKB > 204800) {
      out.push(decision({
        id: `wt-${w.name}`, title: `Worktree ${w.name}`, kb: w.sizeKB,
        proof: `git rev-list --count ${w.base}..HEAD = 0 (everything that was here is already on ${w.base}). Last commit ${w.days} days ago.`,
        lose: `Uncommitted files inside it (${w.dirtyCount} right now). The commits are already on ${w.base}.`,
        command: `git -C ${short(w.path)} status   # check what is dirty\n`
          + `git worktree remove ${short(w.path)}   # NEVER rm -rf: it leaves the worktree registered as a ghost`,
        confidence: 'medium',
        warning: 'Use `git worktree remove`. A plain `rm -rf` leaves a phantom entry in the parent repository.',
        source: 'git rev-list + git worktree list',
      }));
    }
  }

  // Vaults are minefields. They always stay, and always with the reason written.
  for (const v of (r.vaults || [])) {
    if (!v.git) {
      stay.push({ id: `vault-${v.name}`, title: `Vault ${v.name}`, kb: 0,
        why: `${v.onDisk} files under no version control. ${v.warning}`, verdict: 'yours', critical: true });
      continue;
    }
    stay.push({
      id: `vault-${v.name}`, title: `.git of vault ${v.name}`, kb: v.gitKB || 0, gb: kb2gb(v.gitKB || 0),
      why: `${((v.gitKB || 0) / 1024).toFixed(0)} MB of history for ${v.tracked} tracked files. `
        + '.git is never garbage: it is the only copy of everything you have written AND deleted. '
        + `Inside a vault the count you can trust is \`git ls-files\` (${v.tracked}), not \`ls\` — iCloud leaves files as placeholders with no local content.`,
      verdict: 'yours',
    });
  }
  return { out, stay };
}

function build({ docker, targets, repos }) {
  const parts = [fromDocker(docker), fromDisk(targets), fromRepos(repos)];
  const out = dedupe(parts.flatMap((p) => p.out)).sort((a, b) => b.kb - a.kb);
  // Everything that stays needs its size computed too: the screen gives what
  // does NOT go the same weight as what does — that half is what prevents damage.
  const stay = dedupe(parts.flatMap((p) => p.stay))
    .map((f) => ({ ...f, kb: f.kb || 0, gb: kb2gb(f.kb || 0) }))
    .sort((a, b) => b.kb - a.kb);
  const totalKB = out.reduce((s, d) => s + d.kb, 0);
  return {
    totalKB, totalGB: kb2gb(totalKB),
    // How much of the total rests on an item marked 'medium': the panel does
    // not pretend everything carries the same certainty.
    uncertainKB: out.filter((d) => d.confidence !== 'high').reduce((s, d) => s + d.kb, 0),
    out, stay,
  };
}

module.exports = { build, kb2gb, b2gb, KINDS };
