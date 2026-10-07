'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const scan = require('./lib/scan');
const self = require('./lib/self');
const dns = require('./lib/dns');
const blocklist = require('./lib/blocklist');
const network = require('./lib/network');
const pressure = require('./lib/pressure');
// ---- phase 2: action engine (requires) -------------------------------------
const act = require('./lib/act');
// ---- end phase 2 requires ---------------------------------------------------

// ---- phase 1: open-only actions (separate block, to ease merging)
const opener = require('./lib/open');
// ---- end phase 1 require

const PORT = process.env.PORT || 4127;
const WEB = path.join(__dirname, 'web');

// The three guards in front of every request. Loopback alone is not enough: any
// page open in the same browser can make that browser talk to 127.0.0.1.
//  - Host: a site that points its own name at 127.0.0.1 (DNS rebinding) still
//    sends its own name in Host. Only ours is answered, as the corner does.
//  - Origin: a POST from another site carries that site's Origin. A browser
//    always sends it on a cross-site POST, so a foreign one is refused.
//  - Token: drawn fresh on every launch, written into the page this server
//    serves, and required on every request that changes state. Another site
//    cannot read our page, so it cannot learn the token.
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const TOKEN = crypto.randomBytes(32).toString('hex');
const TOKEN_META = '<meta name="reckon-token" content="">';

function tokenOk(req) {
  const given = Buffer.from(String(req.headers['x-reckon-token'] || ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

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

// The page itself, with this launch's token written into it.
function index(res) {
  fs.readFile(path.join(WEB, 'index.html'), 'utf8', (err, text) => {
    if (err) { res.writeHead(404); return res.end('not found: index.html'); }
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
    res.end(text.replace(TOKEN_META, `<meta name="reckon-token" content="${TOKEN}">`));
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

  if (!HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end('wrong host'); }
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin !== undefined && !ORIGINS.has(origin)) { res.writeHead(403); return res.end('wrong origin'); }
    if (!tokenOk(req)) { res.writeHead(403); return res.end('missing or wrong token'); }
  }

  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;

  try {
    if (route === '/') return index(res);
    if (/^\/(app|charts|pet)\.js$/.test(route) || /^\/(style|tokens|pet)\.css$/.test(route)) return static_(res, route.slice(1));
    // The companion's preview: the drawing, reviewed up close before it is wired to anything.
    if (route === '/pet') return static_(res, 'pet.html');

    if (route === '/api/self') return json(res, await self.measure());

    if (route === '/api/light') {
      const d = await scan.light();
      const groups = d.memory.groups.map((g) => ({ name: g.name, rssKB: g.rssKB, n: g.n, cpu: g.cpu }));
      if (!OPENED.groups) OPENED.groups = groups;   // the zero mark for "what grew since you opened"
      HISTORY.push({ t: Date.now(), vm: d.memory.vm, swap: d.memory.swap, groups });
      while (HISTORY.length > MAX_POINTS) HISTORY.shift();
      act.remember('memory', [...(d.memory.groups || []), ...(d.memory.rows || [])]);   // phase 2
      return json(res, { ...d, history: HISTORY, opened: OPENED });
    }

    // The Pressure tab. Cheap — one `ps`, one `launchctl list`, one `lsof` and
    // a third of a second of deliberate arithmetic — but the arithmetic is the
    // point, so it is behind its own route and never runs on load.
    // POST because a new best time is written to the baseline file: a GET must not write.
    if (route === '/api/pressure' && req.method === 'GET') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' });
      return res.end('use POST: this reading can update the baseline file');
    }
    if (route === '/api/pressure') {
      const d = await pressure.collect();
      act.remember('pressure', d.rows);   // phase 2: the ids a click may name
      return json(res, d);
    }

    // ---- phase 2: action engine routes ---------------------------------------
    // The browser sends { action, id } and nothing else; lib/act.js finds the id
    // in the readings above, measures it again and runs only from its own table.
    // Agents never call these: only a person clicking "Do" in the panel does.
    // Host, Origin and the token are checked for every POST at the top of the handler.
    if (route === '/api/act/preview' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, await act.preview(body));
    }
    if (route === '/api/act/run' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, await act.run(body));
    }
    // ---- end phase 2 routes ----------------------------------------------------

    if (route === '/api/cache') {
      const c = scan.readCache();
      if (!c) return json(res, { hasCache: false });
      // The difference against the scan before this one, when there is one.
      return json(res, { hasCache: true, ...c, changed: scan.changed(c, scan.readPrevious()) });
    }

    if (route === '/api/deep' && req.method === 'POST') {
      if (running) return json(res, { alreadyRunning: true }, 409);
      // The steps the scan is already computing, kept where the screen can ask
      // for them. Two minutes of a frozen page is the moment a person decides
      // the tool is broken and closes it — and this scan genuinely takes that
      // long, so the honest fix is to show what it is doing, not to hurry it.
      progress = { step: 'starting', at: Date.now(), n: 0 };
      running = scan.deep((step) => { progress = { step, at: Date.now(), n: progress.n + 1 }; });
      try { return json(res, await running); } finally { running = null; progress = null; }
    }

    // A GET is something a link, a prefetch or a history restore can trigger.
    // Two minutes of disk reading is not something to start by accident.
    if (route === '/api/deep') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ error: 'the deep scan starts with POST /api/deep (the Scan button), not GET' }));
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

    // ---- phase 1: open-only actions. The body is { id, target? }; only `reveal` takes a
    // target, and only a path the last scan measured. Nothing here modifies anything.
    if (route === '/api/open' && req.method === 'GET') return json(res, { available: opener.available() });
    if (route === '/api/open' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await opener.open(body.id, body.target, { scanData: scan.readCache() });
      return json(res, r, r.ok ? 200 : 400);
    }
    // ---- end phase 1 route

    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, { error: e.message }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  reckon  ->  http://127.0.0.1:${PORT}`);
  console.log('  collects on demand. no polling. ctrl+c to stop.\n');
});
