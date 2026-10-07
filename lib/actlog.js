'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------------------------------------------------------------------------
// actions.log: one line per thing reckon did, or refused to do, after a click.
//
// Append-only JSON lines inside ~/.cache/reckon/, in the style of the watcher's
// log (lib/watch.js). Each line is ONE write with O_APPEND, so two writers cannot
// interleave half lines. When the file grows past its cap it is cut to the last
// lines through a temporary file and a rename, so a crash in the middle leaves
// either the old file or the new one, never half of each.
//
// The directory is read when the log is written, not when this module loads:
// a test that points HOME at a temporary folder must get a log in THAT folder.
// ---------------------------------------------------------------------------

const MAX_BYTES = 1024 * 1024;
const KEEP_LINES = 500;

const defaultDir = () => path.join(os.homedir(), '.cache', 'reckon');

function createLog({ dir } = {}) {
  const where = () => dir || defaultDir();
  const file = () => path.join(where(), 'actions.log');

  function trim(f) {
    try {
      if (!fs.existsSync(f) || fs.statSync(f).size <= MAX_BYTES) return;
      const keep = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES);
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, keep.join('\n') + '\n');
      fs.renameSync(tmp, f);
    } catch { /* a log that cannot be trimmed is still a log */ }
  }

  // Never throws: an action that ran must report its result even when the log
  // could not be written, and the result says so.
  function append(entry) {
    try {
      fs.mkdirSync(where(), { recursive: true });
      const f = file();
      trim(f);
      fs.appendFileSync(f, JSON.stringify({ at: Date.now(), ...entry }) + '\n', { flag: 'a' });
      return true;
    } catch { return false; }
  }

  function read(limit = 100) {
    try {
      return fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean).slice(-limit)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  return { append, read, file };
}

module.exports = { createLog, ...createLog() };
