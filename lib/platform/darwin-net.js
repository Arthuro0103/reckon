'use strict';
const os = require('node:os');
const { run } = require('../sh');

// ---------------------------------------------------------------------------
// macOS — the network half of the seam.
//
// It lives in its own file for the same reason the DNS tab lives in its own
// tab: everything here is read-only measurement of a link that somebody is
// using right now, and one of these calls (speedTest) SPENDS the user's data.
// Keeping it apart makes that one obvious instead of buried among thirty
// filesystem calls.
//
// THE RULE, unchanged from CONTRACT.md:
//   - A measurement never throws. Missing tool or failed command -> null (or
//     [] for a list). null means "could not find out", which is not zero: a
//     round trip of `null` must never render as 0 ms, because 0 ms reads as
//     "instant" on a chart of a link that in fact answered nothing.
//   - There is no command BUILDER in this file, so the other half of the rule
//     does not apply here. Nothing below produces text for somebody to paste.
//
// COST, stated per function because one of them is not free:
//   defaultRoute, linkInterfaces   ~50 ms   safe on tab open
//   pingHost                       ~1 s per packet, sends ICMP only
//   radioLink                      ~12 s    reads the radio, spends no data
//   speedTest                      ~20 s    SATURATES THE LINK. Explicit only.
// ---------------------------------------------------------------------------

// Same helpers as darwin.js, same reasons: a command that failed because the
// binary is absent is a different answer from a command that ran and disagreed.
const toolMissing = (r) => !r.ok && /ENOENT|not found|No such file or directory/i.test(r.erro || '');
const numOr = (v, fallback = null) => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

// Several networkQuality fields come back as an ARRAY of samples, one per
// flow: the handshake timings are eight numbers, not one. Number([26,25]) is
// NaN, which would quietly become null — correct, but it would throw away a
// measurement that exists. The median is the single honest figure, and taking
// it here means a port is not left guessing what shape the caller wants.
function median(v) {
  const xs = (Array.isArray(v) ? v : [v]).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : +((xs[mid - 1] + xs[mid]) / 2).toFixed(1);
}

// An interface name goes into argv, so it cannot become an injection — but it
// CAN become a flag. `ifconfig -a` where a name was expected dumps every
// interface on the machine and the parse below would attribute the first one's
// media to whatever the caller asked about.
const IFACE_SAFE = /^[a-z][a-z0-9._]{0,14}$/i;
// A host likewise: a leading '-' turns the argument into an option.
const HOST_SAFE = /^[a-z0-9][a-z0-9._:-]{0,254}$/i;

// Tailscale's address space. This is the same knowledge effectiveResolver()
// uses to set `intercepted`, and it stays in the platform file for the same
// reason: which prefixes belong to a mesh is a fact about the network stack,
// not a product decision.
function meshLabel(ipv4, ipv6) {
  if (ipv4) {
    const o = ipv4.split('.').map(Number);
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'Tailscale';
  }
  if (ipv6 && /^fd7a:/i.test(ipv6)) return 'Tailscale';
  return null;
}

// `en0` is a Wi-Fi card on a laptop and a wired port on a Mac mini, and only
// networksetup knows which. When it cannot be asked the answer is 'unknown',
// never a guess: the whole Wi-Fi half of the tab is built on this, and calling
// a wired link "Wi-Fi" would have the panel recommend moving a router that is
// not in the path.
function kindOf(name, port) {
  if (/^lo\d/.test(name)) return 'loopback';
  if (/^(utun|ipsec|ppp|tun|tap|wg)\d*$/i.test(name)) return 'tunnel';
  if (/^(awdl|llw)\d/.test(name)) return 'other';        // AirDrop's own radio, not a link
  if (port && /wi-?fi|airport/i.test(port)) return 'wi-fi';
  if (port) return 'wired';
  return 'unknown';
}

// device -> hardware port name ('Wi-Fi', 'Ethernet Adapter (en3)', …)
async function hardwarePorts() {
  const r = await run('networksetup', ['-listallhardwareports'], { timeout: 15000 });
  const map = new Map();
  if (!r.ok) return map;
  let port = null;
  for (const l of r.out.split('\n')) {
    const p = l.match(/^Hardware Port:\s*(.+?)\s*$/);
    if (p) { port = p[1]; continue; }
    const d = l.match(/^Device:\s*(\S+)/);
    if (d && port) map.set(d[1], port);
  }
  return map;
}

// status and negotiated media for one interface. Wi-Fi reports no rate here —
// that costs radioLink() and twelve seconds — so linkRateMbps is null on a
// radio, and null is the honest answer rather than the wired number.
async function linkDetail(iface) {
  if (!IFACE_SAFE.test(iface)) return { status: null, media: null, linkRateMbps: null };
  const r = await run('ifconfig', [iface], { timeout: 8000 });
  if (!r.ok) return { status: null, media: null, linkRateMbps: null };
  const status = (r.out.match(/^\s*status:\s*(\w+)/m) || [])[1] || null;
  const media = (r.out.match(/^\s*media:\s*(.+?)\s*$/m) || [])[1] || null;
  // 'autoselect (1000baseT <full-duplex>)' · '10Gbase-T' · 'none'
  const m = media && media.match(/(\d+(?:\.\d+)?)\s*(G)?base/i);
  const linkRateMbps = m ? numOr(m[1]) * (m[2] ? 1000 : 1) : null;
  return { status, media, linkRateMbps };
}

// ===========================================================================
// WHICH LINK IS CARRYING TRAFFIC
// ===========================================================================

// The interface the machine actually sends through, which is the only one
// worth judging. `route -n get default` and nothing heavier.
async function defaultRoute() {
  const r = await run('route', ['-n', 'get', 'default'], { timeout: 8000 });
  if (!r.ok) return null;
  const field = (k) => {
    const m = r.out.match(new RegExp('^\\s*' + k + ':\\s*(\\S+)', 'm'));
    return m ? m[1] : null;
  };
  const iface = field('interface');
  if (!iface) return null;
  // On a point-to-point route this line carries the INTERFACE NAME where an
  // address belongs ('gateway: utun4'). Pinging that as a host is a hostname
  // lookup, not a measurement of the first hop, so it is dropped instead.
  const raw = field('gateway');
  const gateway = raw && /^[0-9a-f.:]+$/i.test(raw) && /[.:]/.test(raw) ? raw : null;
  const ports = await hardwarePorts();
  const port = ports.get(iface) || null;
  const link = await linkDetail(iface);
  return {
    interface: iface,
    gateway,
    gatewayIsInterface: Boolean(raw && !gateway),
    hardwarePort: port,
    kind: kindOf(iface, port),
    status: link.status,
    media: link.media,
    linkRateMbps: link.linkRateMbps,
  };
}

// Every interface carrying an address. No process runs: os.networkInterfaces()
// is the same data ifconfig prints, and shelling out for it would put a second
// parser in the way of the tunnel detection below.
async function linkInterfaces() {
  const ports = await hardwarePorts();
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces() || {})) {
    const kind = kindOf(name, ports.get(name));
    if (kind === 'loopback') continue;
    const list = addrs || [];
    const ipv4 = (list.find((a) => (a.family === 'IPv4' || a.family === 4) && !a.internal) || {}).address || null;
    // link-local addresses say nothing about reachability and every tunnel has
    // one, so a tunnel with only fe80:: is not evidence that anything uses it.
    const ipv6 = (list.find((a) => (a.family === 'IPv6' || a.family === 6) && !a.internal && !/^fe80/i.test(a.address)) || {}).address || null;
    if (!ipv4 && !ipv6) continue;
    out.push({ name, kind, ipv4, ipv6, label: meshLabel(ipv4, ipv6), hardwarePort: ports.get(name) || null });
  }
  return out;
}

// ===========================================================================
// LATENCY AND LOSS
// ===========================================================================

// ICMP to one address, `count` packets, one per second.
//
// GUARD — a lost packet has no round trip. When `received` is 0 every timing
// field is null, never 0: a bar drawn at 0 ms reads as "instant" for a host
// that answered nothing at all. The caller labels that case in words.
//
// `-n` also matters: without it ping does a reverse lookup on every address,
// which puts a DNS query inside a measurement of the network.
async function pingHost(host, { count = 5, waitMs = 1000, timeout } = {}) {
  const h = String(host || '');
  if (!HOST_SAFE.test(h)) return null;
  const n = Math.max(1, Math.min(20, Math.floor(count)));
  const wait = Math.max(100, Math.min(5000, Math.floor(waitMs)));
  const r = await run('ping', ['-n', '-q', '-c', String(n), '-W', String(wait), h],
    { timeout: timeout || n * 1000 + wait + 5000 });
  if (toolMissing(r)) return null;
  // 100% loss exits non-zero but still prints the statistics block, so the
  // parse comes before any check on the exit status.
  const stats = r.out.match(/(\d+)\s+packets transmitted,\s*(\d+)\s+packets received/);
  if (!stats) return null;
  const sent = parseInt(stats[1], 10);
  const received = parseInt(stats[2], 10);
  const t = r.out.match(/=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)\s*ms/);
  const timed = received > 0 && t;
  return {
    host: h,
    sent,
    received,
    lossPct: sent ? +(((sent - received) / sent) * 100).toFixed(1) : null,
    minMs: timed ? +(+t[1]).toFixed(1) : null,
    avgMs: timed ? +(+t[2]).toFixed(1) : null,
    maxMs: timed ? +(+t[3]).toFixed(1) : null,
    stddevMs: timed ? +(+t[4]).toFixed(1) : null,
  };
}

// ===========================================================================
// THE RADIO
// ===========================================================================

// What the Wi-Fi card negotiated with the access point.
//
// This costs about twelve seconds, which is why it is not on the tab-open
// path. The fast interface (`airport -I`) was removed in macOS 14 and the only
// thing left that reports a PHY rate without root rescans the band on its way
// out. The caller states the price before the click.
//
// The SSID and BSSID are deliberately NOT returned. They identify where this
// machine is; the judgement here is about the rate and the signal, and a name
// that adds nothing to it has no business travelling into a screenshot.
async function radioLink(iface) {
  const name = String(iface || '');
  if (!IFACE_SAFE.test(name)) return null;
  const r = await run('system_profiler', ['SPAirPortDataType', '-json'], { timeout: 45000 });
  if (!r.ok) return null;
  let doc = null;
  try { doc = JSON.parse(r.out); } catch { return null; }
  const cards = (doc && doc.SPAirPortDataType) || [];
  let cur = null;
  for (const card of cards) {
    for (const i of card.spairport_airport_interfaces || []) {
      if (i._name === name) cur = i.spairport_current_network_information || null;
    }
  }
  if (!cur) return null;

  // '36 (5GHz, 80MHz)'
  const ch = String(cur.spairport_network_channel || '');
  const chNum = (ch.match(/^(\d+)/) || [])[1];
  const band = (ch.match(/(\d+)\s*GHz/i) || [])[1];
  const width = (ch.match(/,\s*(\d+)\s*MHz/i) || [])[1];
  // '-64 dBm / -94 dBm'
  const sn = String(cur.spairport_signal_noise || '').match(/(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm/);
  const mode = String(cur.spairport_network_phymode || '');

  return {
    interface: name,
    phyMode: mode || null,
    // 'ax' before 'ac' before 'n': a mode string can list several and the
    // last one is the one in use.
    phyFamily: /ax|be/i.test(mode) ? 'ax' : /ac/i.test(mode) ? 'ac' : /n/i.test(mode) ? 'n' : null,
    channel: chNum ? parseInt(chNum, 10) : null,
    bandGHz: band ? parseInt(band, 10) : null,
    widthMHz: width ? parseInt(width, 10) : null,
    mcs: Number.isFinite(cur.spairport_network_mcs) ? cur.spairport_network_mcs : null,
    rateMbps: numOr(cur.spairport_network_rate),
    rssiDbm: sn ? parseInt(sn[1], 10) : null,
    noiseDbm: sn ? parseInt(sn[2], 10) : null,
  };
}

// ===========================================================================
// THE SPEED TEST — the one call in this project that spends the user's data
// ===========================================================================

// `networkQuality` saturates the link in both directions and reports both the
// throughput and how badly the queues stalled while it did. It must never run
// on its own: no tab open, no page load, no timer. The only caller is an
// explicit route behind a button that states the cost first.
//
// Throughput comes back in BITS per second. Converting it as bytes is how a
// 15.9 Mbps link is reported as 127 Mbps, so the caller divides by 1e6 and
// nothing here pre-formats anything.
async function speedTest({ timeout = 180000 } = {}) {
  const t0 = Date.now();
  const r = await run('networkQuality', ['-c'], { timeout });
  if (!r.ok && !r.out) return null;
  const raw = String(r.out || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let d = null;
  try { d = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }

  // A full run reports one combined responsiveness. A sequential or
  // one-direction run reports one per direction instead, and the worse of the
  // two is what a person feels — but a figure whose meaning changed between
  // runs has to say so, hence `responsivenessFrom`.
  let rpm = numOr(d.responsiveness);
  let from = rpm != null ? 'both directions at once' : null;
  if (rpm == null) {
    const parts = [numOr(d.dl_responsiveness), numOr(d.ul_responsiveness)].filter((x) => x != null);
    if (parts.length) {
      rpm = Math.min(...parts);
      from = parts.length === 2 ? 'the worse of the two directions' : 'the download phase only';
    }
  }

  // Every field is optional. A test that finished without a responsiveness
  // number must report null for it, not a zero that would read as the worst
  // possible reading.
  return {
    downBps: numOr(d.dl_throughput),
    upBps: numOr(d.ul_throughput),
    responsivenessRpm: rpm,
    responsivenessFrom: from,
    baseRttMs: numOr(d.base_rtt),
    dlFlows: numOr(d.dl_flows),
    ulFlows: numOr(d.ul_flows),
    // What the test actually moved. Reported by the tool, so the screen can
    // print the data it spent instead of an estimate of it.
    downBytes: numOr(d.dl_bytes_transferred),
    upBytes: numOr(d.ul_bytes_transferred),
    tcpHandshakeMs: median(d.il_tcp_handshake_443),
    tlsHandshakeMs: median(d.il_tls_handshake),
    interfaceName: typeof d.interface_name === 'string' ? d.interface_name : null,
    // Where the data went. A test that contacts a server should name it.
    endpoint: typeof d.test_endpoint === 'string' ? d.test_endpoint : null,
    durationMs: Date.now() - t0,
  };
}

module.exports = { defaultRoute, linkInterfaces, pingHost, radioLink, speedTest };
