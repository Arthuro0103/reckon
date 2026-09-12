#!/usr/bin/env node
'use strict';
/* ---------------------------------------------------------------------------
   `reckon report` — one plain-text file describing what worked and what did not.

   This exists for a specific person: somebody testing reckon on a platform its
   author cannot reach, who has never opened a terminal and cannot read a stack
   trace. Handed a binary and asked "does it work?", they can only answer yes or
   no, and a no is unusable. Handed this, they produce a file that answers the
   question properly.

   So the rules it holds are the rules of that situation:
   - It never fails. Every probe is caught; a crash becomes a line in the report,
     because a report that dies on the first problem describes nothing.
   - It writes ONE file, next to the program, and says where. No hunting.
   - It contains no personal data. Paths are reduced to their shape, hostnames
     are never resolved, no file name from the user's disk appears. Somebody has
     to be able to send this to a stranger without reading it first.
   - It is readable by the person who ran it. They should be able to see for
     themselves that it holds nothing they would mind sending.
--------------------------------------------------------------------------- */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
// A path's SHAPE is diagnostic; its contents are the user's business. Depth and
// whether it resolved is what tells you a port is broken — the folder names do not.
const shape = (p) => {
  if (typeof p !== 'string' || !p) return String(p);
  const rel = p.startsWith(HOME) ? p.slice(HOME.length) : p;
  const parts = rel.split(/[\\/]/).filter(Boolean);
  return (p.startsWith(HOME) ? '~' : '<root>') + '/' + parts.map((s, i) =>
    i < 2 ? s : `<${s.length} chars>`).join('/');
};

const lines = [];
const say = (s = '') => lines.push(s);
const head = (t) => { say(''); say(t); say('-'.repeat(t.length)); };

// Every probe is wrapped. The point of this file is to survive whatever it finds.
async function probe(label, fn) {
  const t0 = process.hrtime.bigint();
  try {
    const value = await fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    say(`  ok    ${label.padEnd(34)} ${Math.round(ms)}ms   ${value == null ? '(null — could not find out)' : value}`);
    return value;
  } catch (e) {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    say(`  FAIL  ${label.padEnd(34)} ${Math.round(ms)}ms   ${String((e && e.message) || e).split('\n')[0].slice(0, 120)}`);
    return null;
  }
}

(async () => {
  say('reckon — self report');
  say('====================');
  say('');
  say('Send this whole file back to whoever asked you to run it. It describes what');
  say('this program could and could not measure on this machine. It contains no file');
  say('names, no addresses you visit, and nothing from inside your documents — you');
  say('are welcome to read it first, and you should.');

  head('This machine');
  say(`  platform            ${process.platform} ${process.arch}`);
  say(`  os release          ${os.release()}`);
  say(`  node                ${process.version}`);
  say(`  packaged binary     ${process.execPath.endsWith('node') || process.execPath.endsWith('node.exe') ? 'no — running from a Node install' : 'yes'}`);
  say(`  cpus                ${os.cpus().length}`);
  say(`  total ram           ${(os.totalmem() / 1073741824).toFixed(1)} GB`);

  head('Platform layer');
  let platform = null;
  try {
    platform = require('../lib/platform');
    say(`  implementation      ${platform.label} (${platform.id})`);
    say(`  supported           ${platform.supported}`);
    if (platform.unsupportedReason) {
      say('  reason:');
      for (const l of String(platform.unsupportedReason).split('\n')) say(`    ${l}`);
    }
    const absent = platform.notImplemented || [];
    say(`  optional missing    ${absent.length ? absent.join(', ') : 'none'}`);
  } catch (e) {
    say(`  FAIL  the platform layer would not load: ${(e && e.message) || e}`);
    say('  Nothing below this line will mean much.');
  }

  if (platform) {
    head('Capabilities, one at a time');
    say('  A capability that returns null did not find out — that is a valid answer.');
    say('  A capability that FAILs is the bug worth reporting.');
    say('');
    const n = (v) => (v == null ? null : typeof v === 'number' ? v : Array.isArray(v) ? `${v.length} entries` : 'ok');
    await probe('memoryStats', async () => n(await platform.memoryStats()));
    await probe('swapStats', async () => n(await platform.swapStats()));
    await probe('processList', async () => n(await platform.processList()));
    await probe('volumeUsage', async () => {
      const v = await platform.volumeUsage();
      return v ? `${Math.round(v.totalKB / 1048576)} GB total, ${v.usedPct}% used` : null;
    });
    await probe('listDirectory(home)', async () => n(await platform.listDirectory(HOME)));
    await probe('dirSizeKB(home/.cache)', async () => {
      const v = await platform.dirSizeKB(path.join(HOME, '.cache'), 20000);
      return v == null ? null : `${Math.round(v / 1024)} MB`;
    });
    await probe('likelyCodeDirs', async () => {
      const v = await platform.likelyCodeDirs();
      return v ? `${v.length} candidate(s): ${v.map(shape).join(', ')}` : null;
    });
    await probe('findSymlinksUnder', async () => {
      // The roots the PRODUCT uses, not the raw candidate list, and the limit the
      // product uses. A probe with its own smaller cap reports truncated=true on a
      // healthy machine — a report that cries wolf is worse than no report, because
      // the person reading it cannot tell the false alarm from the real one.
      const cfg = await require('../lib/config').load();
      const roots = [...cfg.codeDirs, ...cfg.worktreeDirs];
      if (!roots.length) return 'no code directories found on this machine — nothing to search';
      const r = await platform.findSymlinksUnder(roots, { limit: 400, timeout: 20000 });
      if (!r) return null;
      // The reading that must never claim more than it did.
      const provable = r.roots.length > 0 && !r.truncated;
      return `searched ${r.roots.length} of ${roots.length}, skipped ${(r.skipped || []).length}, truncated=${r.truncated} → can prove "nothing points here": ${provable}`;
    });
    await probe('backupStatus', async () => {
      const v = await platform.backupStatus();
      return v ? (v.configured === null ? 'cannot tell' : `configured=${v.configured}`) : null;
    });
    await probe('dnsServices', async () => n(await platform.dnsServices()));
    await probe('effectiveResolver', async () => {
      const v = await platform.effectiveResolver();
      return v ? `${(v.ips || []).length} resolver(s), intercepted=${v.intercepted}` : null;
    });
    await probe('hostsFilePath', async () => shape(platform.hostsFilePath()));
    await probe('setDnsCommand (built, not run)', async () => {
      const c = platform.setDnsCommand('Wi-Fi', ['1.1.1.1', '1.0.0.1']);
      const text = (c && c.command) || String(c);
      if (/null|undefined/.test(text)) throw new Error('the command came out with null in it');
      return text.slice(0, 60) + '…';
    });
  }

  head('The product itself');
  await probe('light scan', async () => {
    const scan = require('../lib/scan');
    const d = await scan.light();
    return `${(d.memory && d.memory.groups || []).length} process groups, volume=${d.volume ? 'read' : 'null'}`;
  });
  await probe('server starts on a free port', async () => {
    const http = require('node:http');
    return await new Promise((resolve, reject) => {
      const s = http.createServer(() => {});
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(`yes (tried port ${p})`)); });
    });
  });

  head('What to do with this');
  say('  Send the whole file. If reckon also showed you a screen, a photo of it');
  say('  alongside this file answers almost any question at once.');

  const out = path.join(process.cwd(), 'reckon-report.txt');
  const text = lines.join('\n') + '\n';
  try {
    fs.writeFileSync(out, text);
    console.log(text);
    console.log(`\nSaved to: ${out}`);
    console.log('Send that file back to whoever asked you to run this.');
  } catch (e) {
    // Even the write can fail — a read-only folder, a locked file. Print it all
    // to the screen so the run is never wasted.
    console.log(text);
    console.log(`\nCould not save a file here (${(e && e.message) || e}).`);
    console.log('Copy everything above this line and send it instead.');
  }
})();
