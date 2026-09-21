'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const scan = require('./lib/scan');
const self = require('./lib/self');
const dns = require('./lib/dns');
const blocklist = require('./lib/blocklist');
const network = require('./lib/network');
const pressure = require('./lib/pressure');

const PORT = process.env.PORT || 4127;
const WEB = path.join(__dirname, 'web');

// A short in-memory history, capped. No database, no file, no polling: a point
// is recorded when YOU open the Memory tab.
const HISTORY = [];
const MAX_POINTS = 120;
const OPENED = { at: Date.now(), groups: null };

let running = null;   // one deep scan at a time
let progress = null;  // what that scan is doing right now, for the screen to read
// A speed test saturates the link. Two at once spend the data twice AND corrupt
// each other's numbers, so the second click is refused rather than queued.
let speedRunning = false;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, data, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

// 8 kB ceiling: a body larger than that is abuse, not use.
function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 8192) { raw = ''; req.destroy(); resolve({}); }
    });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function static_(res, file) {
  const target = path.join(WEB, file);
  if (!target.startsWith(WEB)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(target, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found: ' + file); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  // Loopback only. This panel can see the whole machine: exposing it on the
  // network would hand that map to anyone on the same Wi-Fi.
  const ip = req.socket.remoteAddress || '';
  if (!ip.includes('127.0.0.1') && !ip.includes('::1')) { res.writeHead(403); return res.end('local only'); }

  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  try {
    if (route === '/') return static_(res, 'index.html');
    if (/^\/(app|charts)\.js$/.test(route) || /^\/(style|tokens)\.css$/.test(route)) return static_(res, route.slice(1));

    if (route === '/api/self') return json(res, await self.measure());

    if (route === '/api/light') {
      const d = await scan.light();
      const groups = d.memory.groups.map((g) => ({ name: g.name, rssKB: g.rssKB, n: g.n, cpu: g.cpu }));
      if (!OPENED.groups) OPENED.groups = groups;   // the zero mark for "what grew since you opened"
      HISTORY.push({ t: Date.now(), vm: d.memory.vm, swap: d.memory.swap, groups });
      while (HISTORY.length > MAX_POINTS) HISTORY.shift();
      return json(res, { ...d, history: HISTORY, opened: OPENED });
    }

    // The Pressure tab. Cheap — one `ps`, one `launchctl list`, one `lsof` and
    // a third of a second of deliberate arithmetic — but the arithmetic is the
    // point, so it is behind its own route and never runs on load.
    if (route === '/api/pressure') return json(res, await pressure.collect());

    if (route === '/api/cache') {
      const c = scan.readCache();
      if (!c) return json(res, { hasCache: false });
      // The difference against the scan before this one, when there is one.
      return json(res, { hasCache: true, ...c, changed: scan.changed(c, scan.readPrevious()) });
    }

    if (route === '/api/deep') {
      if (running) return json(res, { alreadyRunning: true }, 409);
      // The steps the scan is already computing, kept where the screen can ask
      // for them. Two minutes of a frozen page is the moment a person decides
      // the tool is broken and closes it — and this scan genuinely takes that
      // long, so the honest fix is to show what it is doing, not to hurry it.
      progress = { step: 'starting', at: Date.now(), n: 0 };
      running = scan.deep((step) => { progress = { step, at: Date.now(), n: progress.n + 1 }; });
      try { return json(res, await running); } finally { running = null; progress = null; }
    }

    // Only meaningful while a scan the user started is running, and it stops
    // being answered the moment that scan ends. This is not the panel polling
    // itself: nothing asks unless somebody pressed the button.
    if (route === '/api/deep/progress') {
      return json(res, progress ? { running: true, ...progress } : { running: false });
    }

    // The Internet tab. collect() only ever touches machines this computer was
    // already configured to use — the gateway and your own resolvers — so it is
    // free to run on tab open. The two readings that COST something are separate
    // routes behind separate buttons, and neither is ever called on load.
    if (route === '/api/network') return json(res, await network.collect());

    if (route === '/api/network/speed' && req.method === 'POST') {
      if (speedRunning) return json(res, { alreadyRunning: true }, 409);
      speedRunning = true;
      try { return json(res, await network.speedTest()); } finally { speedRunning = false; }
    }

    if (route === '/api/network/radio' && req.method === 'POST') {
      return json(res, await network.radio());
    }

    if (route === '/api/dns') return json(res, await dns.collect());

    if (route === '/api/dns/recipe') {
      // Builds the (apply, undo) pair and returns it as TEXT. Never executes.
      const service = url.searchParams.get('service');
      const provider = url.searchParams.get('provider');
      const current = (url.searchParams.get('current') || '').split(',').filter(Boolean);
      const r = dns.recipe(service, provider, current);
      return r ? json(res, r) : json(res, { error: 'unknown provider' }, 400);
    }

    // ---- blocklist. This server writes ONLY inside ~/.cache/reckon;
    // /etc/hosts belongs to the user and to their sudo.
    if (route === '/api/blocklist') return json(res, await blocklist.collect());

    if (route === '/api/blocklist/add' && req.method === 'POST') {
      const body = await readBody(req);
      const r = body.set ? blocklist.addSet(body.set) : blocklist.add(body.domain);
      if (!r.ok) return json(res, r, 400);
      return json(res, { ...r, ...(await blocklist.collect()) });
    }

    if (route === '/api/blocklist/remove' && req.method === 'POST') {
      const body = await readBody(req);
      blocklist.remove(body.domain);
      return json(res, await blocklist.collect());
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  reckon  ->  http://127.0.0.1:${PORT}`);
  console.log('  collects on demand. no polling. ctrl+c to stop.\n');
});
