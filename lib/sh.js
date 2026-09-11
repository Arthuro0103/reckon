'use strict';
const { execFile } = require('node:child_process');

// Run a command and return stdout. Never throws: a failure becomes { erro }.
// No shell by default, so a path with spaces can't turn into an injection.
function run(cmd, args = [], { timeout = 20000, shell = false, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(shell ? '/bin/sh' : cmd, shell ? ['-c', cmd] : args, { timeout, maxBuffer, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && !stdout) return resolve({ ok: false, out: '', erro: (stderr || err.message || '').trim().slice(0, 400) });
        resolve({ ok: true, out: String(stdout), erro: err ? (stderr || '').trim().slice(0, 200) : null });
      });
  });
}

const sh = (cmdline, opts) => run(cmdline, [], { ...opts, shell: true });

// `du -sk` on a single path. Returns KB, or null.
async function duKB(target, timeout = 60000) {
  const r = await run('du', ['-sk', target], { timeout });
  if (!r.ok) return null;
  const n = parseInt(String(r.out).trim().split(/\s+/)[0], 10);
  return Number.isFinite(n) ? n : null;
}

// Size actually ON DISK (allocated blocks), not the apparent size.
// A sparse file lies about the latter: Docker.raw reports 1 TB and occupies 20.
// For a directory the blocks of every file have to be summed — reading the
// folder's own inode is how a 9.57 GB bundle once measured as zero.
async function realKB(target, timeout = 120000) {
  const isDir = await run('test', ['-d', target], { timeout: 4000 });
  if (isDir.ok) {
    const r = await run('find', [target, '-type', 'f', '-exec', 'stat', '-f', '%b', '{}', '+'], { timeout });
    if (!r.ok) return null;
    let blocks = 0;
    for (const l of r.out.split('\n')) { const n = parseInt(l, 10); if (Number.isFinite(n)) blocks += n; }
    return Math.round((blocks * 512) / 1024);
  }
  const r = await run('stat', ['-f', '%b', target], { timeout });
  if (!r.ok) return null;
  const blocks = parseInt(String(r.out).trim(), 10);
  return Number.isFinite(blocks) ? Math.round((blocks * 512) / 1024) : null;
}

const GB = (kb) => (kb == null ? null : +(kb / 1048576).toFixed(2));
const MB = (kb) => (kb == null ? null : +(kb / 1024).toFixed(1));

module.exports = { run, sh, duKB, realKB, GB, MB };
