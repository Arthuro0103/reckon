'use strict';
const os = require('node:os');
const platform = require('./platform');
const config = require('./config');

const HOME = os.homedir();

// ---------------------------------------------------------------------------
// The Disk tab's collector. The table of known folders, their verdicts and
// their commands comes from lib/platform: a cache lives somewhere different on
// every platform, and so does the command that clears it. What this file adds
// is the measuring, the guards that make a measurement trustworthy, and the one
// product rule that decides what earns a row.
// ---------------------------------------------------------------------------

// Under 50 MB does not earn a row. A list of forty 12 MB folders is not a
// decision, it is a chore.
const FLOOR_KB = 51200;

// ---------------------------------------------------------------------------
// GUARD: before suggesting you delete a directory, look for a link pointing at
// it. A listing walks straight through a symlink or a junction, which makes the
// target and the link look like two independent things.
//
// The index is built ONCE, for every root, and every target is then tested
// against it. The old code re-walked the application folder for every row.
// ---------------------------------------------------------------------------
// The cap is 2000 and not the contract's default of 400 because the cap is
// reached inside the FIRST root on an ordinary machine — an application folder
// holds several hundred links of its own, and every root after it then
// contributes nothing while the answer still claims to have covered them. This
// machine holds 486 links across every root and enumerating all of them costs
// 1.7 s, so the cap is now what it should be: a ceiling on something going
// wrong, not a limit reached during normal use.
async function symlinkIndex() {
  const c = await config.load();
  return platform.findSymlinksUnder(c.linkRoots, { limit: 2000, maxDepth: 4, timeout: 30000 });
}

// Links whose target is this path or sits inside it. Capped, because the point
// on screen is "something points here", not a catalogue.
function linksTo(index, target) {
  if (!index || !Array.isArray(index.links)) return [];
  return index.links
    .filter((l) => l.target.startsWith(target))
    .slice(0, 5)
    .map((l) => ({ link: l.link, points: l.target }));
}

// pnpm and the filesystem itself share blocks through hard links and clones.
// A size that adds up file lengths counts the same block twice, so deleting one
// copy can free nothing at all.
async function hardlinks(target) {
  return platform.hardlinkRatio(target, 60000);
}

// null is a real answer here and the caller has to carry it: this runs on the
// light path, on every tab switch, and a throw takes the whole panel down.
async function volume() {
  return platform.volumeUsage();
}

// ---------------------------------------------------------------------------
// Measure the known folders that are actually on this machine.
//
// `unmeasured` is the half of the answer that used to be thrown away. A folder
// that exists but whose size could not be read was simply dropped from the
// list, which on a platform where the measuring tool is missing or refused
// means the panel reports an empty machine and a total of zero. It now comes
// back so the Checks tab can say the count is short and by how many.
// ---------------------------------------------------------------------------
async function targets() {
  const list = [];
  const unmeasured = [];
  const all = platform.knownCacheTargets();

  // A sparse file lies about its apparent size, so it is measured on its own
  // and by allocated blocks. Everything else can go in one batch where the
  // platform offers one.
  const sparse = all.filter((t) => t.sparse);
  const plain = all.filter((t) => !t.sparse);

  // Where the platform can measure many roots at once, use it: on Windows the
  // per-target cost is a process launch, and paying it 70 times is why that
  // scan took most of a minute before it walked anything. A platform without
  // the capability gets the original one-at-a-time path, unchanged.
  //
  // IN CHUNKS, not all at once. One call for everything means one timeout for
  // everything: a single slow root — Windows.old and the recycle bin are both
  // candidates — would take the other hundred measurements down with it and
  // the panel would report an empty machine. A chunk that fails takes only its
  // own members, and those fall back to being measured one at a time.
  const CHUNK = 16;
  const measured = new Map();
  const fellBack = new Set();
  const canBatch = typeof platform.dirSizesKB === 'function';
  if (canBatch) {
    for (let i = 0; i < plain.length; i += CHUNK) {
      const slice = plain.slice(i, i + CHUNK);
      const got = await platform.dirSizesKB(slice.map((t) => t.path));
      if (got && typeof got === 'object') {
        for (const t of slice) {
          if (t.path in got) measured.set(t.path, got[t.path]);
          else measured.set(t.path, undefined);   // absent, and known to be absent
        }
      } else {
        for (const t of slice) fellBack.add(t.path);
      }
    }
  }

  for (const t of plain) {
    let kb;
    if (canBatch && !fellBack.has(t.path)) {
      // Absent from the batch means the root is not there — which is not the
      // same as "could not measure it", and must not be reported as one.
      if (measured.get(t.path) === undefined) continue;
      kb = measured.get(t.path);
    } else {
      if (!(await platform.pathExists(t.path))) continue;
      kb = await platform.dirSizeKB(t.path, 90000);
    }
    if (kb == null) { unmeasured.push({ id: t.id, label: t.label, path: t.path }); continue; }
    if (kb < FLOOR_KB) continue;
    list.push({ ...t, kb });
  }

  for (const t of sparse) {
    if (!(await platform.pathExists(t.path))) continue;
    const kb = await platform.realSizeKB(t.path);
    if (kb == null) { unmeasured.push({ id: t.id, label: t.label, path: t.path }); continue; }
    if (kb < FLOOR_KB) continue;
    list.push({ ...t, kb });
  }

  list.sort((a, b) => b.kb - a.kb);
  return { list, unmeasured };
}

// The top of the home directory. Entries whose name starts with a dot, and
// entries the platform marks hidden, are included and marked: they are how tens
// of GB stay out of every count people make by hand.
async function homeTop() {
  return platform.homeTopLevelSizes({ limit: 30, timeout: 180000 });
}

module.exports = { volume, targets, homeTop, symlinkIndex, linksTo, hardlinks, HOME };
