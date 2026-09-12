'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('./platform');

// ---------------------------------------------------------------------------
// A blocklist applied through the system hosts file.
//
// This tool NEVER writes to that file. It keeps the list in a file of its own,
// generates the block ready to paste, and shows the command — undo first.
// Getting the hosts file wrong does not show a wrong number: it takes sites off
// the air for the whole machine, and months later nobody remembers why.
//
// THE LIMIT, WHICH BELONGS ON SCREEN: a hosts file matches EXACT names. Blocking
// "doubleclick.net" does not block "ad.doubleclick.net". There are no wildcards.
// To block a domain and everything under it you need a filtering resolver —
// which is the other half of this tab.
// ---------------------------------------------------------------------------

const DIR = path.join(os.homedir(), '.cache', 'reckon');
const LIST = path.join(DIR, 'blocklist.json');
const SNIPPET = path.join(DIR, 'hosts-block.txt');
const BEGIN = '# >>> reckon blocklist (do not edit between the markers)';
const END = '# <<< reckon';
// The short patterns the platform uses to address the block inside the file.
// They must appear in the two lines above and nowhere else in it.
const MARK_BEGIN = '>>> reckon';
const MARK_END = '<<< reckon';
// Called lazily, never at module scope: a capability that throws on an
// unimplemented platform would kill `require` before the server ever listens,
// and the seam's whole promise is that a missing piece breaks one reading
// rather than the program.
let HOSTS_CACHE;
const hostsPath = () => {
  if (HOSTS_CACHE === undefined) {
    try { HOSTS_CACHE = platform.hostsFilePath(); } catch { HOSTS_CACHE = null; }
  }
  return HOSTS_CACHE;
};

// Ready-made sets. Every entry is an exact host, subdomain variants included,
// because without them the block simply does not catch anything.
const SETS = {
  ads: {
    label: 'Ads',
    description: 'The most common ad networks. May leave a blank rectangle on the page.',
    domains: [
      'doubleclick.net', 'ad.doubleclick.net', 'static.doubleclick.net', 'stats.g.doubleclick.net',
      'googleadservices.com', 'www.googleadservices.com', 'pagead2.googlesyndication.com',
      'googlesyndication.com', 'tpc.googlesyndication.com', 'adservice.google.com',
      'ads.yahoo.com', 'advertising.com', 'adnxs.com', 'ib.adnxs.com',
      'criteo.com', 'static.criteo.net', 'casalemedia.com', 'pubmatic.com', 'rubiconproject.com',
    ],
  },
  trackers: {
    label: 'Trackers',
    description: 'They measure what you do across sites. Blocking these can break newsletter links, which travel through a redirector.',
    domains: [
      'google-analytics.com', 'www.google-analytics.com', 'ssl.google-analytics.com',
      'analytics.google.com', 'googletagmanager.com', 'www.googletagmanager.com',
      'connect.facebook.net', 'graph.facebook.com', 'pixel.facebook.com',
      'hotjar.com', 'static.hotjar.com', 'script.hotjar.com',
      'mixpanel.com', 'api.mixpanel.com', 'segment.io', 'cdn.segment.com',
      'amplitude.com', 'api.amplitude.com', 'fullstory.com', 'branch.io',
    ],
  },
  malicious: {
    label: 'Malicious',
    description: 'Domains used by tech-support scams and in-browser cryptomining.',
    domains: [
      'coinhive.com', 'coin-hive.com', 'cryptoloot.pro', 'webminepool.com',
      'jsecoin.com', 'crypto-loot.com', 'minero.cc', 'authedmine.com',
    ],
  },
  distraction: {
    label: 'Distraction',
    description: 'For an afternoon of focus. This takes the whole site down, not just its ads — the set most likely to bite you if you forget it is on.',
    domains: [
      'instagram.com', 'www.instagram.com', 'tiktok.com', 'www.tiktok.com',
      'reddit.com', 'www.reddit.com', 'x.com', 'www.x.com', 'twitter.com', 'www.twitter.com',
      'facebook.com', 'www.facebook.com', 'news.ycombinator.com',
    ],
  },
};

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(LIST, 'utf8'));
    if (Array.isArray(d.domains)) return d;
  } catch {}
  return { domains: [] };
}

function write(d) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(LIST, JSON.stringify({ ...d, at: Date.now() }, null, 2));
}

// Hostnames only: no slashes, spaces, scheme or wildcard. Anything unexpected
// here would become a line in the hosts file, so the sieve is tight.
function cleanDomain(raw) {
  let d = String(raw || '').trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '').replace(/\.$/, '');
  if (!d || d.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d)) return null;
  if (/^(localhost|broadcasthost)$/.test(d)) return null;
  return d;
}

function add(raw, category = 'Manual') {
  const d = cleanDomain(raw);
  if (!d) return { ok: false, error: 'That does not look like a domain. Use the form example.com, without http:// and without a path.' };
  const list = read();
  if (list.domains.some((x) => x.name === d)) return { ok: false, error: `${d} is already on the list.` };
  list.domains.push({ name: d, category, at: Date.now() });
  write(list);
  return { ok: true, domain: d };
}

function addSet(id) {
  const s = SETS[id];
  if (!s) return { ok: false, error: 'unknown set' };
  const list = read();
  const have = new Set(list.domains.map((x) => x.name));
  let n = 0;
  for (const d of s.domains) {
    const clean = cleanDomain(d);
    if (clean && !have.has(clean)) { list.domains.push({ name: clean, category: s.label, at: Date.now() }); have.add(clean); n++; }
  }
  write(list);
  return { ok: true, added: n, total: s.domains.length };
}

function remove(raw) {
  const d = cleanDomain(raw);
  const list = read();
  const before = list.domains.length;
  list.domains = list.domains.filter((x) => x.name !== d);
  write(list);
  return { ok: list.domains.length < before, left: list.domains.length };
}

// Writes the snippet to a file owned by THIS TOOL — never to the hosts file.
function generate() {
  const list = read();
  const lines = [BEGIN, `# ${list.domains.length} domains · generated ${new Date().toISOString()}`];
  for (const d of list.domains) {
    lines.push(`0.0.0.0 ${d.name}`);
    // The IPv6 line is required: without it the system resolves the AAAA record
    // and the block quietly fails.
    lines.push(`:: ${d.name}`);
  }
  lines.push(END, '');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SNIPPET, lines.join('\n'));
  return { path: SNIPPET, lines: lines.length, domains: list.domains.length };
}

// ---------------------------------------------------------------------------
// What is already in effect inside this tool's markers in the hosts file.
//
// Read with fs, not through a command: the file is world-readable on every
// platform this runs on, and a pipeline of three programs to count lines is
// three more things that can be missing. A file that cannot be read at all
// reports nothing active rather than failing — the screen then says the block
// is not applied, which is the safe direction to be wrong in.
// ---------------------------------------------------------------------------
async function active() {
  let text = '';
  try { text = fs.readFileSync(hostsPath(), 'utf8'); } catch { text = ''; }
  let inside = false, n = 0, hasBlock = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes(MARK_BEGIN)) { inside = true; hasBlock = true; continue; }
    if (line.includes(MARK_END)) { inside = false; continue; }
    if (inside && /^0\.0\.0\.0\s/.test(line)) n++;
  }
  const hasBackup = await platform.pathExists(platform.hostsBackupPath());
  return { activeNow: n, hasBlock, hasBackup };
}

// ---------------------------------------------------------------------------
// The prose around the commands. The commands themselves are built by
// lib/platform, which throws rather than emit one it could not build cleanly.
//
// This half is here because it is the part that has to be true about the
// PERSON, not the machine: what the privilege looks like where they are, and
// what they will see if they skip it.
// ---------------------------------------------------------------------------
const PROSE = {
  darwin: {
    elevation: 'every line starts with sudo and will ask for your password. this panel does not type it for you.',
    verify: (hosts) => `dig +short doubleclick.net @127.0.0.1 ; grep -c '>>> reckon' ${hosts}`,
  },
  win32: {
    elevation: 'run these in a PowerShell you started with "Run as administrator". there is no sudo here: in an ordinary shell they fail with a permission error, which at least fails loudly.',
    verify: (hosts) => `Select-String -Path '${hosts}' -Pattern '>>> reckon' | Measure-Object | Select-Object -ExpandProperty Count`,
  },
};
const prose = PROSE[platform.id] || {
  elevation: 'these commands need administrator rights. this panel does not run them for you.',
  verify: (hosts) => `# count the lines between the markers in ${hosts}`,
};

// The (apply, undo) pair, as TEXT. This tool executes none of it.
function recipe(state) {
  const c = platform.hostsCommands({ snippetPath: SNIPPET, begin: MARK_BEGIN, end: MARK_END });
  const reload = platform.dnsFlushCommand();
  const sep = platform.id === 'win32' ? '\n' : ' && ';
  return {
    undo: state.hasBackup ? `${c.restore}${sep}${reload}` : `${c.strip}${sep}${reload}`,
    undoExplained: state.hasBackup
      ? `Restores ${hostsPath()} exactly as it was before the first block (the copy at ${c.backupPath}).`
      : `Removes only the section between this tool's markers. The rest of your ${hostsPath()} is untouched.`,
    apply: [
      '# keep one copy of the original, once',
      c.backupOnce,
      '',
      '# replace the old block with the new one',
      c.strip,
      c.append,
      '',
      '# make the system reload',
      reload,
    ].join('\n'),
    applyNote: prose.elevation,
    verify: prose.verify(hostsPath()),
    ifItBreaks: 'If a site you use stops loading, paste the undo command. It does not need the network.',
  };
}

async function collect() {
  const list = read();
  const state = await active();
  const snippet = generate();
  const byCategory = {};
  for (const d of list.domains) byCategory[d.category] = (byCategory[d.category] || 0) + 1;
  return {
    domains: list.domains, byCategory,
    sets: Object.entries(SETS).map(([id, s]) => ({ id, ...s, count: s.domains.length })),
    state, snippet, recipe: recipe(state),
    hostsPath: hostsPath(),
    limit: `${hostsPath()} matches EXACT names: blocking "doubleclick.net" does not block "ad.doubleclick.net". There are no wildcards here. To catch a domain and everything under it, use a filtering resolver — the other half of this tab.`,
    at: Date.now(),
  };
}

module.exports = { collect, add, addSet, remove, cleanDomain, SETS, SNIPPET };
