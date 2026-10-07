'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const platform = require('./platform');
const docker = require('./docker');

// ---------------------------------------------------------------------------
// The Memory tab's collector. Everything it knows about the machine arrives
// through lib/platform; what it adds is the product decisions — which processes
// are too small to matter, and how they are grouped for a person to act on.
// ---------------------------------------------------------------------------

// The wire format the front end reads. It is NOT the contract's field names,
// and the translation happens here, once, in one object literal: web/app.js
// reads `memory.vm.free`, `.active`, `.inactive`, `.wired`, `.compressed`, and
// renaming those in a port would empty the ring chart on every platform at
// once.
function wire(m) {
  if (!m) return null;
  return {
    pageSize: m.pageSizeBytes,
    free: m.freeBytes,
    active: m.activeBytes,
    inactive: m.inactiveBytes,
    wired: m.wiredBytes,
    compressed: m.compressedBytes,
    // Counters accumulated since boot. These are the proof that the machine has
    // been suffering, not a reading of how it is right now. A platform that
    // publishes no counter for one of them reports null, and null here means
    // "this machine does not keep that number" — never zero, which would read
    // on screen as a machine that has never been under pressure.
    compressions: m.compressions,
    decompressions: m.decompressions,
    swapins: m.swapins,
    swapouts: m.swapouts,
  };
}

// Under 2 MB changes nothing on screen. This cut is a product decision and it
// lives here: the platform returns every process, unfiltered, and both the
// count and the summed RSS below are taken AFTER the cut.
const FLOOR_KB = 2048;

// The outermost .app a command lives in, as { appPath, name }, or null. Pure string work: the
// bundle id (which a quit needs) is read later, from the app's own Info.plist.
function appOf(command) {
  const c = String(command || '');
  const i = c.indexOf('.app/');
  if (i < 0 || !c.startsWith('/')) return null;
  const appPath = c.slice(0, i + 4);
  return { appPath, name: appPath.slice(appPath.lastIndexOf('/') + 1, -4) };
}

// A helper belongs to its parent app. The platform names a process by its own executable unless it
// knows the app ("Chrome", "Discord"), which leaves "Orca", "Orca Helper" and "Orca Helper
// (Renderer)" as three groups of one app. A process that sits inside an .app and carries only the
// name of its own executable is regrouped under that app's name; a family the platform recognised
// is kept, because that family already is the app.
function familyOf(p) {
  const app = appOf(p.command);
  if (!app) return p.family;
  const own = String(p.command).slice(String(p.command).lastIndexOf('/') + 1).trim();
  return p.family === own ? app.name : p.family;
}

function processes(list) {
  return list
    .filter((p) => p.rssKB >= FLOOR_KB)
    .map((p) => ({ rssKB: p.rssKB, pid: p.pid, ppid: p.ppid, cpu: p.cpuPct, comm: p.command, family: familyOf(p), ageS: p.ageS, startedAt: p.startedAt ?? null }));
}

// Each group keeps the processes it is made of, biggest first, so the screen can open a group
// and show them. Capped: a browser with 80 helpers needs the first screenful, not all 80.
const PROCS_SHOWN = 30;

function group(list) {
  const map = new Map();
  for (const p of list) {
    const g = map.get(p.family) || { name: p.family, rssKB: 0, cpu: 0, n: 0, biggestPid: null, biggestKB: 0, members: [] };
    g.rssKB += p.rssKB;
    // A process whose CPU share could not be read contributes nothing to the
    // group's, rather than turning the whole sum into NaN.
    g.cpu += (p.cpu || 0);
    g.n++;
    if (p.rssKB > g.biggestKB) { g.biggestKB = p.rssKB; g.biggestPid = p.pid; }
    g.members.push(p);
    map.set(p.family, g);
  }
  return [...map.values()].sort((a, b) => b.rssKB - a.rssKB);
}

// ---------------------------------------------------------------------------
// What a person can DO about each group, in the same shape as a Pressure row:
// proof, what you lose, the command as text, a confidence, and, only when the
// confidence earns it, an `action` that a click alone can start (lib/act.js).
// ---------------------------------------------------------------------------
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const mbOf = (kb) => Math.round(kb / 1024);
const BROWSER = /^(Chrome|Opera|Firefox|Safari|Brave Browser|Microsoft Edge|Arc|Chromium)$/;
// A process's own executable lives in ONE bundle; a helper lives in a bundle inside a bundle.
const isMainOfApp = (comm) => comm.indexOf('.app/') === comm.lastIndexOf('.app/');

// The chain of processes this server runs inside: its shell, its terminal, the app that
// hosts them. Quitting any of those quits reckon too, mid-answer.
function ancestorsOfSelf(all, pid = process.pid) {
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const out = new Set();
  let cur = byPid.get(pid);
  while (cur && !out.has(cur.pid) && cur.pid > 1) { out.add(cur.pid); cur = byPid.get(cur.ppid); }
  return out;
}

const identity = (list, now) => list.map((p) => ({ pid: p.pid, comm: p.comm,
  startedAt: p.startedAt != null ? p.startedAt : p.ageS == null ? null : now - p.ageS * 1000 }));

// Docker Desktop is quit only through its own row (dockerIdle below), which first proves that
// no container is running. Quitting it as "just an app" would stop every container with it.
const DOCKER_BUNDLE = 'com.docker.docker';

// Per app, across EVERY group: one app often lands in several groups ("Orca Helper", "Orca
// Helper (Renderer)"), and quitting it from any of them quits all of it. Also which apps run
// this server, wherever their processes were grouped.
async function appTotals(procs, hostPids) {
  const totals = new Map();
  const hosting = new Set();
  for (const p of procs) {
    const b = await platform.appBundle(p.comm);
    if (!b) continue;
    const t = totals.get(b.appPath) || { n: 0, kb: 0 };
    t.n++; t.kb += p.rssKB;
    totals.set(b.appPath, t);
  }
  for (const pid of hostPids) {
    const p = procs.find((x) => x.pid === pid);
    const b = p && await platform.appBundle(p.comm);
    if (b) hosting.add(b.appPath);
  }
  return { totals, hosting };
}

async function describeGroup(g, ctx, now) {
  const base = {
    id: `group-${slug(g.name)}`, title: g.name, kb: g.rssKB, mb: mbOf(g.rssKB),
    // `helper` marks a process that lives in a bundle inside the app's own. The screen shows it as a
    // helper under the app; there is no action for one helper, only for the app row.
    procs: g.members.slice().sort((a, b) => b.rssKB - a.rssKB).slice(0, PROCS_SHOWN)
      .map((p) => ({ pid: p.pid, rssKB: p.rssKB, cpu: p.cpu, ageS: p.ageS, comm: p.comm, helper: !isMainOfApp(p.comm) })),
    helpers: g.members.filter((p) => !isMainOfApp(p.comm)).length,
  };
  if (/\(system\)$/.test(g.name)) {
    return { ...base, confidence: 'low',
      proof: `${g.n} processes that live in the system's own directories.`,
      lose: 'The operating system. These are not yours to quit, and nothing here offers to.' };
  }

  // Which app the group's memory lives in. Only processes inside an app bundle count; the
  // biggest app wins, and whatever is outside it is named as staying.
  const apps = new Map();
  for (const p of g.members) {
    const b = await platform.appBundle(p.comm);
    if (!b) continue;
    const a = apps.get(b.appPath) || { ...b, kb: 0, members: [] };
    a.kb += p.rssKB; a.members.push(p);
    apps.set(b.appPath, a);
  }
  const app = [...apps.values()].sort((a, b) => b.kb - a.kb)[0];
  if (!app) {
    return { ...base, confidence: 'low',
      proof: `${g.n} processes grouped by name; none of them lives inside an app bundle, so there is no single app to quit.`,
      lose: 'Unknown from here. Open the group and look at each process; orphaned servers and swarms are judged on the Pressure tab.' };
  }

  const command = `osascript -e 'tell application id "${app.bundleId}" to quit'`;
  // The app whose terminal or shell is running this very server, wherever it was grouped.
  const hosts = ctx.hosting.has(app.appPath);
  const systemApp = /^\/System\/Library\//.test(app.appPath);
  const outside = g.n - app.members.length;
  const whole = ctx.totals.get(app.appPath) || { n: app.members.length, kb: app.kb };
  const proof = `${app.members.length} of ${g.n} processes in this group run from ${app.appPath} `
    + `(bundle ${app.bundleId}) and hold ${mbOf(app.kb)} MB between them.`
    + (whole.n > app.members.length ? ` Quitting the app quits all ${whole.n} of its processes, ${mbOf(whole.kb)} MB, including those grouped elsewhere on this tab.` : '')
    + (outside ? ` ${outside} other process(es) in the group are not part of that app and stay.` : '');
  const lose = `Whatever is open in ${app.name}. This is a graceful quit: ${app.name} asks to save `
    + 'anything unsaved, and Cancel in that dialog stops the quit. Open the app again to get it back.'
    + (BROWSER.test(g.name) ? ' If this panel is open in this browser, the panel closes with it; the result is still written to ~/.cache/reckon/actions.log.' : '');
  const sized = { ...base, kb: app.kb, mb: mbOf(app.kb), command, proof };

  if (hosts || systemApp || app.bundleId === DOCKER_BUNDLE) {
    return { ...sized, confidence: 'low',
      lose: hosts ? `${app.name} is running reckon itself (its terminal or its shell). Quitting it stops this panel mid-answer, so there is no button for it.`
        : systemApp ? 'This app lives in /System/Library and is part of macOS. There is no button for it.'
          : 'Every running container stops with Docker Desktop. There is a button only on the "Docker Desktop is holding a VM" row, which appears when no container is running.' };
  }

  // A graceful quit asks before it loses anything, so the verdict "you can quit this" is
  // `medium`: the panel knows what the app holds, not whether you are using it.
  const main = app.members.find((p) => isMainOfApp(p.comm)) || app.members[0];
  return { ...sized, confidence: 'medium', lose,
    action: { id: 'quit-app', label: `Quit ${app.name}` },
    target: { kind: 'app', appPath: app.appPath, bundleId: app.bundleId, name: app.name,
      main: identity([main], now)[0], pids: identity(app.members, now) } };
}

// Booted iOS simulators. Every booted device runs its own `launchd_sim` with a whole system
// below it, and nothing in a name-based grouping puts those processes back together.
function simulators(all, now = Date.now()) {
  const roots = all.filter((p) => /(^|\/)launchd_sim$/.test(p.command));
  if (!roots.length) return null;
  const kids = new Map();
  for (const p of all) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const tree = [];
  const seen = new Set();
  const stack = [...roots];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur.pid)) continue;
    seen.add(cur.pid); tree.push(cur);
    for (const k of kids.get(cur.pid) || []) stack.push(k);
  }
  const kb = tree.reduce((s, p) => s + p.rssKB, 0);
  return {
    id: 'simulators', title: `${roots.length} iOS simulator${roots.length > 1 ? 's' : ''} booted`,
    kb, mb: mbOf(kb), costPct: Math.round(tree.reduce((s, p) => s + (p.cpuPct || 0), 0)),
    proof: `${roots.length} launchd_sim process(es), one per booted device, with ${tree.length - roots.length} process(es) below them, ${mbOf(kb)} MB in total.`,
    lose: 'The state of whatever app is running inside each simulator. The devices stay installed; opening Simulator or `xcrun simctl boot` brings one back in about twenty seconds.',
    command: 'xcrun simctl shutdown all',
    confidence: 'medium',
    action: { id: 'shutdown-simulators', label: 'Shut down simulators' },
    target: { kind: 'simulators', roots: identity(roots.map((p) => ({ ...p, comm: p.command })), now) },
  };
}

// Docker Desktop holding a VM in memory with no container running in it.
const VM_FLOOR_KB = 512 * 1024;

async function dockerIdle(all, now) {
  const desktop = all.filter((p) => p.family === 'Docker Desktop' && /\/Docker\.app\//.test(p.command));
  if (!desktop.length) return null;
  const vm = all.filter((p) => p.family === 'Apple VM (Docker/Claude)');
  const claudeToo = all.some((p) => p.family === 'Claude Desktop');
  const desktopKB = desktop.reduce((s, p) => s + p.rssKB, 0);
  const vmKB = vm.reduce((s, p) => s + p.rssKB, 0);
  // The VM is what holds the memory. Below this floor Docker is asleep (Resource Saver), and
  // asking it how many containers run would wake it: the reading would cost what it measures.
  if (vmKB < VM_FLOOR_KB) return null;
  const running = await docker.runningContainers();
  if (running == null || running > 0) return null;   // "could not tell" and "busy" both mean no row
  const app = await platform.appBundle(desktop[0].command);
  if (!app) return null;
  const kb = desktopKB + (claudeToo ? 0 : vmKB);
  const main = desktop.find((p) => isMainOfApp(p.command)) || desktop[0];
  return {
    id: 'docker-idle', title: 'Docker Desktop is holding a VM with no container running',
    kb, mb: mbOf(kb), costPct: 0,
    proof: `\`docker ps\` lists 0 running containers right now. Docker Desktop's own processes hold ${mbOf(desktopKB)} MB `
      + `and the Apple virtualization processes hold ${mbOf(vmKB)} MB.`
      + (claudeToo ? ' Claude Desktop is running too and may own part of that VM memory, so only Docker\'s own processes are counted.' : ''),
    lose: 'Nothing that is running: no container is up. Stopped containers, images and volumes stay on disk. Starting Docker Desktop again takes under a minute.',
    command: `osascript -e 'tell application id "${app.bundleId}" to quit'`,
    confidence: 'medium',
    action: { id: 'quit-docker', label: 'Quit Docker Desktop' },
    target: { kind: 'docker', appPath: app.appPath, bundleId: app.bundleId, name: app.name,
      main: identity([{ ...main, comm: main.command }], now)[0] },
  };
}

// ---------------------------------------------------------------------------
// Docker Desktop's memory limit, as advice. READ-ONLY and TEXT ONLY: no button, no write. The one
// extra file this reads is Docker Desktop's own settings file in the person's home, named in
// docs/PRIVACY.md. A missing file is an answer ("not found"), never a guess.
// ---------------------------------------------------------------------------
const DOCKER_SETTINGS_DIR = ['Library', 'Group Containers', 'group.com.docker'];
const DOCKER_SETTINGS_FILES = ['settings-store.json', 'settings.json'];
const DOCKER_PATH = 'Docker Desktop > Settings > Resources > Advanced > Memory limit';

// memoryMiB out of the file's text: the key's case differs between Docker Desktop versions
// ("MemoryMiB" in settings-store.json, "memoryMiB" in settings.json), and a value that is not a
// plain positive number is not a limit.
function parseDockerSettings(text) {
  let j;
  try { j = JSON.parse(String(text)); } catch { return { ok: false, why: 'unreadable' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, why: 'unreadable' };
  const key = Object.keys(j).find((k) => k.toLowerCase() === 'memorymib');
  const v = key == null ? null : j[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 256 || v > 4194304) return { ok: true, memoryMiB: null, why: 'no-limit-key' };
  return { ok: true, memoryMiB: Math.round(v) };
}

function readDockerSettings({ home = os.homedir(), readFile = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  let seen = null;
  for (const name of DOCKER_SETTINGS_FILES) {
    const file = path.join(home, ...DOCKER_SETTINGS_DIR, name);
    let text;
    try { text = readFile(file); } catch { continue; }
    const r = parseDockerSettings(text);
    if (r.ok && r.memoryMiB != null) return { file, memoryMiB: r.memoryMiB };
    seen = seen || { file, memoryMiB: null, why: r.why };
  }
  return seen || { file: null, memoryMiB: null, why: 'absent' };
}

// The card. `all` is the platform's process list (unfiltered). It appears only while Docker
// Desktop's own processes and a virtualization process are running.
async function dockerAdvice(all, { totalBytes = os.totalmem(), settings = readDockerSettings, containers = () => docker.runningContainers() } = {}) {
  const desktop = all.filter((p) => p.family === 'Docker Desktop' && /\/Docker\.app\//.test(p.command));
  const vm = all.filter((p) => p.family === 'Apple VM (Docker/Claude)');
  if (!desktop.length || !vm.length) return null;
  const vmKB = vm.reduce((s, p) => s + p.rssKB, 0);
  const totalMiB = Math.round((totalBytes || 0) / 1048576);
  const s = settings();
  const limitMiB = s.memoryMiB;
  const limitPct = limitMiB != null && totalMiB ? Math.round((limitMiB / totalMiB) * 100) : null;
  // Below the floor Docker is asleep (Resource Saver). `docker ps` would wake it, so it is not asked.
  const asleep = vmKB < VM_FLOOR_KB;
  const running = asleep ? null : await containers();
  const gbText = (mib) => `${(mib / 1024).toFixed(1).replace(/\.0$/, '')} GB`;
  const lines = [];
  if (limitMiB == null) {
    lines.push(s.file
      ? `Docker Desktop's settings file (${s.file.replace(os.homedir(), '~')}) has no memory limit, so reckon cannot say what the VM is allowed to take.`
      : 'Docker Desktop\'s settings file was not found, so reckon cannot say what the VM is allowed to take.');
  } else {
    lines.push(`The VM may take up to ${gbText(limitMiB)}${limitPct != null ? `, ${limitPct}% of this machine's ${gbText(totalMiB)}` : ''}, whether or not a container needs it.`);
  }
  if (running === 0) lines.push(`No container is running, yet the VM holds ${Math.round(vmKB / 1024)} MB. Turn on Resource Saver (Docker Desktop > Settings > Resources) so Docker Desktop releases it by itself when idle.`);
  else if (running > 0 && limitPct != null && limitPct >= 50) lines.push(`${running} container(s) are running. If they need less than that, lower the limit so the rest stays for your apps.`);
  else if (running > 0) lines.push(`${running} container(s) are running; the limit above is a ceiling on what they can take together.`);
  else if (asleep) lines.push('Docker is asleep (Resource Saver), so reckon did not ask how many containers run: asking would wake it.');
  lines.push(`To change the limit: ${DOCKER_PATH}, then Apply & restart. A lower limit takes effect after the restart; it frees nothing now.`);
  return {
    id: 'docker-advice', title: 'Docker Desktop memory limit', vmMB: Math.round(vmKB / 1024),
    limitMiB, limitPct, totalMiB, containers: running, asleep,
    file: s.file ? s.file.replace(os.homedir(), '~') : null, settingsNote: limitMiB == null ? s.why || 'no-limit-key' : null,
    changeAt: DOCKER_PATH, advice: lines.join(' '),
  };
}

async function collect() {
  const [vm, sw, all, level] = await Promise.all([
    platform.memoryStats(), platform.swapStats(), platform.processList(), platform.memoryPressure(),
  ]);
  const procs = processes(all);
  const now = Date.now();
  const ctx = await appTotals(all.map((p) => ({ pid: p.pid, comm: p.command, rssKB: p.rssKB })), ancestorsOfSelf(all));
  const groups = [];
  for (const g of group(procs).slice(0, 18)) {
    const { members, ...rest } = g;
    groups.push({ ...rest, ...(await describeGroup(g, ctx, now)), name: g.name, rssKB: g.rssKB });
  }
  // Local models (Ollama) come from lib/aitools.js, required here and not at the top: aitools
  // needs ancestorsOfSelf from this file.
  const rows = [simulators(all, now), await dockerIdle(all, now), ...(await require('./aitools').localModels(all))].filter(Boolean);
  return {
    // os.totalmem() is the same number the platform reports and it is the same
    // on every platform, so it is read straight rather than through the seam.
    // The fallback matters: a failed memory read must not also take the "total
    // RAM" figure down with it.
    totalBytes: (vm && vm.totalBytes) || os.totalmem(),
    vm: wire(vm),
    swap: sw,
    // The kernel's own verdict on memory; null when this platform publishes none.
    pressure: level,
    groups,
    // Memory you can give back that is not one app's group.
    rows,
    // Text-only advice on Docker Desktop's memory limit; null when Docker Desktop's VM is not running.
    docker: await dockerAdvice(all).catch(() => null),
    processCount: procs.length,
    rssSumKB: procs.reduce((s, p) => s + p.rssKB, 0),
    // Summed RSS exceeds physical RAM because shared memory is counted in every
    // process. Saying so on screen heads off "why does a 16 GB machine show 20?".
    note: 'Summed RSS counts shared memory more than once — do not compare the total against physical RAM.',
    at: Date.now(),
  };
}

module.exports = { collect, simulators, ancestorsOfSelf, appOf, processes, group, dockerAdvice, parseDockerSettings, readDockerSettings };
