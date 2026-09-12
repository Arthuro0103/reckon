'use strict';
const platform = require('./platform');
const dns = require('./dns');

// ---------------------------------------------------------------------------
// The Internet tab: what the connection is doing, and what to do about it.
//
// Two speeds of collection, and the line between them is the whole design:
//
//   CHEAP, runs when you open the tab. Which link is carrying traffic, the
//   round trip to three addresses, packet loss, what the resolver costs. It
//   sends a handful of ICMP packets and reads configuration. Call it free.
//
//   PAID, never runs by itself. `speedTest()` saturates the link in both
//   directions — it MOVES REAL DATA, hundreds of megabytes of it on a fast
//   connection — and `radio()` costs twelve seconds of the Wi-Fi card's
//   attention. Neither one is called from collect(), from the light scan, or
//   from anything with a timer on it. Each has its own route behind a button
//   that states the cost before the click.
//
// That split is not decoration. This panel's promise is that collection is
// cheap and happens when you ask; a throughput test breaks the first half of
// that promise, so it has to be held to the second half absolutely.
//
// It reads lib/dns.js rather than probing resolvers again: one dig per
// resolver is already paid for on the DNS tab, and two copies of that probe
// would drift. The direction is one-way — nothing here touches the command
// builders in there, and a failure over there becomes a missing paragraph
// here, never a broken tab.
//
// Nothing in this file knows it is running on macOS. Every reading comes from
// lib/platform; a port writes lib/platform/<platform>-net.js and this file
// does not change.
// ---------------------------------------------------------------------------

// --- the three addresses, and why each one is worth a packet ----------------
// The gateway isolates the leg between this machine and the router — the part
// a person can actually do something about. The resolver is the address every
// new hostname goes to before anything loads. The public anchor is the only
// address outside the user's own network that this tab contacts without being
// asked, and the screen names it: it is a DNS resolver this machine is already
// free to query, it is answered by ICMP in under a millisecond of its time,
// and without it there is no way to tell a bad Wi-Fi link from a bad ISP.
// THE RULE THIS TAB HOLDS: reckon only ever sends a packet to a machine your
// computer was ALREADY configured to use — your gateway, and the resolvers you
// or your network chose. It never contacts an address picked by this tool.
//
// An earlier draft pinged 1.1.1.1 on every tab open as a generic "is the
// internet there" anchor. That reaches a third party the user never chose,
// every time a tab opens, and it made this project's own privacy page untrue.
// The off-network reading now comes from a resolver already in use, and when
// none of them is off-network the honest answer is "not measured" rather than
// a packet to somebody else's server.
function isPrivateV4(ip) {
  const o = String(ip || '').split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n))) return false;
  return o[0] === 10
    || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
    || (o[0] === 192 && o[1] === 168)
    || (o[0] === 100 && o[1] >= 64 && o[1] <= 127)   // CGNAT, and Tailscale's range
    || o[0] === 127 || o[0] === 169;
}

// Five packets at one per second: about four seconds of waiting, which is what
// makes this affordable on tab open. It is enough to see a dead path and NOT
// enough to measure a small loss rate, and the screen says so rather than
// turning one missing packet into "20% packet loss".
const PING_COUNT = 5;
const LOSS_IS_EVIDENCE = 40;   // 2 of 5. Below this a gap is a hint, not a rate.

// Apple's own tool calls responsiveness under 200 RPM low and over 800 high.
// RPM is round trips per minute achieved WHILE the link is saturated, so it is
// the number that answers "my internet is fast but everything feels slow".
const RPM_LAGGY = 200;
const RPM_GOOD = 800;

// A consumer link is upload-limited: download is the bigger number, usually by
// a lot. When upload is several times download, something is holding the
// download side back that is not the plan being paid for.
const BACKWARDS_RATIO = 2.5;

// lib/dns.js draws its slow line at 250 ms; the same line is used here so the
// two tabs cannot disagree about the same measurement.
const SLOW_RESOLVER_MS = 250;
// A resolver that is 10 ms away by ICMP and takes 200 ms to answer is spending
// that time on its own work, not on the path. Worth separating: one is fixed
// by changing resolver, the other by changing network.
const RESOLVER_OWN_WORK_MS = 150;

// Radio thresholds. -70 dBm is where a Wi-Fi link starts dropping to lower
// rates, and under 20 dB of signal-to-noise it will not hold a high one.
const WEAK_RSSI = -70;
const LOW_SNR = 20;
// Half of what the channel width allows is the point where the link, not the
// line, is the thing to look at.
const LINK_SHORTFALL = 0.5;

// Best PHY rate per spatial stream, in Mbps, at the highest MCS each mode
// defines for that channel width. THESE ARE THE STANDARD'S NUMBERS, not a
// reading of anybody's link, and every place they reach the screen says so.
const PER_STREAM_CEILING = {
  n: { 20: 72.2, 40: 150 },                          // 802.11n,  MCS 7
  ac: { 20: 86.7, 40: 200, 80: 433.3, 160: 866.7 },  // 802.11ac, MCS 9
  ax: { 20: 143.4, 40: 286.8, 80: 600.4, 160: 1201 },// 802.11ax, MCS 11
};
// Rate at MCS i as a fraction of the top MCS, per mode. The ratio is the same
// at every channel width — width changes the number of subcarriers, not the
// modulation — which is what makes the spatial-stream count below inferable
// from two numbers the card already reports.
const MCS_FRACTION = {
  n: [0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 0.9, 1],
  ac: [0.075, 0.15, 0.225, 0.3, 0.45, 0.6, 0.675, 0.75, 0.9, 1],
  ax: [0.06, 0.12, 0.18, 0.24, 0.36, 0.48, 0.54, 0.6, 0.72, 0.8, 0.9, 1],
};

// Session memory, exactly like the Memory tab's history: it lives in this
// process, it dies with it, and a point exists because somebody looked. The
// paid readings are kept here too, so that opening the tab again shows what
// was already measured instead of asking for the data to be spent twice.
const HISTORY_MAX = 60;
const HISTORY = [];
const LAST = { speed: null, radio: null };

const mbps = (bps) => (bps == null ? null : +(bps / 1e6).toFixed(1));
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(String(s || '')) && String(s).split('.').every((o) => +o <= 255);

// A capability that is missing — an unfinished port, or a seam that has not
// been wired yet — has to read as "could not find out" on the screen, not as a
// stack trace on a tab. The reason is kept and shown once, at the top, naming
// the file somebody has to write.
function reader() {
  const problems = [];
  const call = async (name, ...args) => {
    const fn = platform[name];
    if (typeof fn !== 'function') {
      problems.push(`lib/platform has no ${name}() on ${platform.label || platform.id}.`);
      return null;
    }
    try {
      return await fn(...args);
    } catch (e) {
      problems.push(String((e && e.message) || e).split('\n')[0]);
      return null;
    }
  };
  return { call, problems };
}

// ===========================================================================
// THE CHEAP READ
// ===========================================================================

async function collect() {
  const { call, problems } = reader();

  const route = await call('defaultRoute');
  const interfaces = (await call('linkInterfaces')) || [];

  // The DNS tab's measurement, borrowed. If it fails, this tab loses one
  // paragraph and keeps the rest — it must not take the page down.
  let resolvers = null;
  let resolverError = null;
  try {
    const d = await dns.collect();
    resolvers = {
      effective: d.effective || { ips: [], intercepted: false, interceptedBy: null },
      health: d.health || [],
      dead: d.dead || [],
      slow: d.slow || [],
    };
  } catch (e) {
    resolverError = String((e && e.message) || e);
  }

  // The addresses worth a packet, deduplicated: on a home network the gateway
  // and the resolver are usually the same box, and pinging it twice would put
  // the same number on the chart under two names.
  const wanted = [];
  const add = (ip, role, name) => {
    if (!ip || !isIPv4(ip)) return;
    const already = wanted.find((w) => w.ip === ip);
    if (already) { already.role += ` and ${role}`; return; }
    wanted.push({ ip, role, name });
  };
  if (route) add(route.gateway, 'your router', 'The first hop');
  const effectiveFirst = (resolvers && resolvers.effective.ips || []).find(isIPv4) || null;
  add(effectiveFirst, 'the resolver this machine asks', 'The resolver');
  // Every configured resolver that lives off this network doubles as the
  // off-network anchor: it is a machine already in use, so measuring it adds no
  // contact that was not already happening.
  for (const ip of ((resolvers && resolvers.effective.ips) || []).filter(isIPv4)) {
    if (!isPrivateV4(ip)) add(ip, 'outside your network', 'A resolver beyond your router');
  }

  const measured = await Promise.all(wanted.map(async (w) => {
    const p = await call('pingHost', w.ip, { count: PING_COUNT });
    // A ping that could not run at all is not a ping of zero packets.
    if (!p) return { ...w, ran: false, sent: null, received: null, lossPct: null, avgMs: null, minMs: null, maxMs: null, stddevMs: null };
    return { ...w, ran: true, ...p };
  }));

  const gateway = measured.find((m) => /router/.test(m.role)) || null;
  // null here means "nothing this machine was configured to use lives off the
  // network" — which is NOT "the internet is unreachable". Downstream has to
  // keep those two apart.
  const outside = measured.find((m) => !isPrivateV4(m.ip) && !/router/.test(m.role)) || null;
  const noOffNetworkHost = !outside;
  const resolverHop = measured.find((m) => m.ip === effectiveFirst) || null;

  // One point per look, same rule as the Memory tab. A reading that measured
  // nothing is not recorded: an empty point drawn at zero would claim the
  // internet went away at the moment somebody opened a tab.
  if (outside && outside.received > 0) {
    HISTORY.push({
      t: Date.now(),
      outsideMs: outside.avgMs,
      gatewayMs: gateway && gateway.received > 0 ? gateway.avgMs : null,
      lossPct: outside.lossPct,
    });
    while (HISTORY.length > HISTORY_MAX) HISTORY.shift();
  }

  const tunnels = interfaces
    .filter((i) => i.kind === 'tunnel')
    .map((i) => ({
      name: i.name,
      label: i.label || 'a VPN or tunnel',
      ipv4: i.ipv4,
      // The honest test for "is it in the path": does the default route leave
      // through it? A tunnel that is merely up carries only its own subnet,
      // and blaming it for the link would send somebody to disconnect the one
      // thing that was not involved.
      inPath: Boolean(route && route.interface === i.name),
    }));

  const radio = LAST.radio;
  const speed = LAST.speed;
  const findings = judge({ route, gateway, outside, resolverHop, resolvers, tunnels, radio, speed, problems, noOffNetworkHost });

  return {
    at: Date.now(),
    supported: platform.supported !== false,
    problems,
    route,
    interfaces,
    anchors: measured,
    pingCount: PING_COUNT,
    noOffNetworkHost,
    resolvers,
    resolverError,
    tunnels,
    history: HISTORY,
    radio,
    speed,
    cost: COST,
    findings,
    verdict: verdict(findings, { route, outside, speed, radio }),
    unmeasured: unmeasured({ speed, radio, route }),
  };
}

// What the two paid readings cost, in the words that go above their buttons.
const COST = {
  speed: {
    seconds: '15 to 30 seconds',
    data: 'It saturates the link in both directions, so it moves as much data as the link can carry for as long as it runs — about 2 MB for every Mbps of capacity, in each direction. On a 100 Mbps line that is a few hundred megabytes; on a gigabit line it is measured in gigabytes.',
    warning: 'Do not run it on a metered connection, on a phone hotspot, or while somebody else is on a call.',
  },
  radio: {
    seconds: 'about 12 seconds',
    data: 'No data at all — it reads the Wi-Fi card. It is slow because the fast way to ask was removed in macOS 14 and the tool that is left rescans the band on its way out.',
    warning: null,
  },
};

// What the last run actually spent. The tool counts the bytes it moved, so
// this is a measurement and the screen says so; the throughput-times-duration
// fallback is an estimate and the screen says that instead. The difference
// matters on a metered plan, where a number labelled wrongly is the reason
// somebody runs it a second time.
function dataSpent(speed) {
  if (!speed) return { dataMB: null, dataMeasured: false };
  const bytes = (speed.downBytes || 0) + (speed.upBytes || 0);
  if (bytes > 0) return { dataMB: Math.round(bytes / 1e6), dataMeasured: true };
  if (speed.downBps == null || speed.upBps == null || !speed.durationMs) return { dataMB: null, dataMeasured: false };
  return { dataMB: Math.round(((speed.downBps + speed.upBps) / 8) * (speed.durationMs / 1000) / 1e6), dataMeasured: false };
}

function unmeasured({ speed, radio, route }) {
  const out = [];
  if (!speed) out.push('Throughput, and how the link behaves while it is busy. That test moves real data, so it only runs when you ask for it.');
  if (!radio && route && route.kind === 'wi-fi') out.push('The radio: what rate the card negotiated and how strong the signal is. Twelve seconds, no data.');
  if (route && route.kind === 'unknown') out.push(`Whether ${route.interface} is Wi-Fi or a cable — the system did not say which hardware port it belongs to, so nothing here assumes one.`);
  return out;
}

// ===========================================================================
// THE PAID READINGS
// ===========================================================================

// Explicit only. The route that reaches this is a POST behind a button, and
// the button's label carries the cost. Never called from collect().
async function speedTest() {
  const { call, problems } = reader();
  const raw = await call('speedTest', {});
  if (!raw) {
    return { ...(await collect()), speedError: problems[0] || 'The speed test did not produce a reading.' };
  }
  LAST.speed = { ...raw, at: Date.now(), ...dataSpent(raw) };
  return collect();
}

async function radio() {
  const { call, problems } = reader();
  const route = await call('defaultRoute');
  if (!route) return { ...(await collect()), radioError: problems[0] || 'Could not tell which interface is carrying traffic.' };
  if (route.kind === 'wired') {
    return { ...(await collect()), radioError: `${route.interface} is a cable (${route.hardwarePort}). There is no radio to read.` };
  }
  const raw = await call('radioLink', route.interface);
  if (!raw) {
    return { ...(await collect()), radioError: problems[0] || `The Wi-Fi card reported no current network on ${route.interface}.` };
  }
  LAST.radio = { ...raw, at: Date.now(), ...interpretRadio(raw) };
  return collect();
}

// The product half of the radio reading, kept out of the platform file for the
// same reason probeResolver() leaves `owner` to its caller: the standard's
// tables and what counts as "far below" are judgement, not measurement.
function interpretRadio(r) {
  const fam = r.phyFamily, w = r.widthMHz;
  const perStream = fam && w && PER_STREAM_CEILING[fam] ? PER_STREAM_CEILING[fam][w] || null : null;
  const fraction = fam && r.mcs != null && MCS_FRACTION[fam] ? MCS_FRACTION[fam][r.mcs] || null : null;
  // Spatial streams are not reported anywhere. They are inferred: the rate at
  // a known MCS is proportional to the number of streams, so the rate divided
  // by the single-stream rate at that MCS rounds to the stream count. Labelled
  // as inferred wherever it is shown, because it is arithmetic on two readings
  // and not a third reading.
  let streams = null;
  if (perStream && fraction && r.rateMbps) {
    streams = Math.max(1, Math.min(8, Math.round(r.rateMbps / (perStream * fraction))));
  }
  const ceilingMbps = perStream && streams ? +(perStream * streams).toFixed(0) : null;
  const snrDb = r.rssiDbm != null && r.noiseDbm != null ? r.rssiDbm - r.noiseDbm : null;
  // Why the ceiling is missing, when it is. A card that reports MCS 10 while
  // naming the mode 802.11ac is describing something the tables here cannot
  // price — 802.11ac stops at MCS 9 — and "could not be derived" with no reason
  // reads like a bug in this panel rather than a disagreement in the reading.
  let ceilingUnknown = null;
  if (!ceilingMbps) {
    if (!fam) ceilingUnknown = `the card did not name a mode this panel has a table for (it reported ${r.phyMode || 'nothing'}).`;
    else if (r.mcs != null && MCS_FRACTION[fam] && r.mcs >= MCS_FRACTION[fam].length) {
      ceilingUnknown = `the card reports MCS ${r.mcs} while naming the mode ${r.phyMode}, which only defines up to MCS ${MCS_FRACTION[fam].length - 1}. The two readings disagree, so no ceiling is claimed from them.`;
    } else if (!perStream) ceilingUnknown = `${r.phyMode} at ${r.widthMHz} MHz is not in the tables this panel carries.`;
    else ceilingUnknown = 'the spatial-stream count could not be inferred from the rate and the MCS index.';
  }
  return { streams, ceilingMbps, ceilingUnknown, snrDb, ceilingIsReference: true };
}

// ===========================================================================
// THE JUDGEMENTS
// Same shape as lib/checks.js: nothing gets a row without a fix, and every row
// carries the proof of its number and what it costs to be wrong.
// ===========================================================================

function judge(x) {
  return [
    reachability(x), loss(x), bufferbloat(x), asymmetry(x),
    resolverCost(x), meshInPath(x), wifi(x), notTheBottleneck(x),
  ].filter(Boolean).sort((a, b) => (b.serious ? 1 : 0) - (a.serious ? 1 : 0));
}

function reachability({ route, gateway, outside, problems, noOffNetworkHost }) {
  // A capability that is missing is not an outage. Announcing "this machine has
  // no way out" because the seam could not answer would send somebody to reboot
  // a router that was never the problem.
  if (!route && problems && problems.length) {
    return { id: 'route-unknown', title: 'Could not read the routing table', serious: false,
      found: `This build could not ask the system where traffic leaves: ${problems[0]} Nothing on this tab that depends on the route is being claimed.`,
      fix: null, cost: 'Nothing.', measure: 'nothing — the reading did not happen' };
  }
  if (!route) {
    return { id: 'no-route', title: 'No default route — this machine has no way out', serious: true,
      found: 'The routing table has no default entry, which means no interface is carrying general traffic. Wi-Fi is off, the cable is out, or every interface failed to configure.',
      fix: 'Check Wi-Fi or the cable first. Nothing else on this tab means anything until a route exists.',
      cost: 'Nothing to look.', measure: 'the routing table' };
  }
  if (noOffNetworkHost) {
    return { id: 'no-anchor', title: 'Nothing beyond your router was measured', serious: false,
      found: 'Every resolver this machine is configured to use lives on your own network, so there was no host past the router that you had already chosen. reckon does not pick one for you: that would mean contacting a machine you never asked it to.',
      fix: 'Set a resolver you trust in the DNS tab and this reading appears on its own.',
      cost: 'Nothing.', measure: 'nothing — by design' };
  }
  if (!outside || !outside.ran) return null;
  if (outside.received === 0 && gateway && gateway.received > 0) {
    return { id: 'offline-upstream', title: 'Your router answers. The internet does not', serious: true,
      found: `${gateway.sent} of ${gateway.sent} packets came back from ${gateway.ip} in ${gateway.avgMs} ms, and none of ${outside.sent} came back from ${outside.ip}. The link between this machine and the router is fine; the path past it is not.`,
      fix: 'Restart the router before anything else, then check whether the ISP has an outage. Nothing on this machine will fix a path that stops at your own gateway.',
      cost: 'A minute of downtime restarting a router that may not have been the problem.', measure: 'ping' };
  }
  if (outside.received === 0 && (!gateway || gateway.received === 0)) {
    return { id: 'offline', title: 'Nothing answers, including your own router', serious: true,
      found: `No reply from ${[gateway && gateway.ip, outside.ip].filter(Boolean).join(' or ')}. Either the link is down or the machine is on a network that filters ICMP entirely.`,
      fix: 'Check that you are on the network you think you are on, then that the interface has an address.',
      cost: 'Nothing to look. Some networks drop ICMP on purpose, in which case this reads as offline while the web works.', measure: 'ping' };
  }
  return null;
}

function loss({ gateway, outside }) {
  if (!outside || !outside.ran || outside.received === 0) return null;
  const lost = outside.sent - outside.received;
  if (!lost) return null;
  const lanLost = gateway && gateway.ran ? gateway.sent - gateway.received : 0;
  const serious = outside.lossPct >= LOSS_IS_EVIDENCE;
  return {
    id: 'loss',
    title: serious
      ? `${lost} of ${outside.sent} packets never came back`
      : `${lost} packet of ${outside.sent} went missing — a hint, not a rate`,
    serious,
    found: `${outside.ip}: ${outside.received} of ${outside.sent} replies, ${outside.lossPct}% lost`
      + (lanLost
        ? `. Your own router lost ${lanLost} of ${gateway.sent} as well, so the packets are dying on the leg between this machine and it — that is the Wi-Fi or the cable, not the ISP.`
        : gateway && gateway.ran
          ? `. Your router answered all ${gateway.sent} of its packets, so the leg inside your home is clean and the loss is past it.`
          : '.')
      + ` Five packets is enough to see a path that is broken and not enough to measure a small loss rate: ${serious ? 'this much of it is evidence' : 'one missing packet out of five is not a 20% loss rate, it is a reason to look again'}.`,
    fix: serious
      ? (lanLost
        ? 'Move closer to the access point or use a cable, then open this tab again. If the loss follows you, the radio or the cable is the thing to replace.'
        : 'Run it again in a minute. If it repeats, it is upstream and the fix is a call to the ISP with these numbers.')
      : 'Open the tab again and see whether it repeats. One packet is not evidence.',
    cost: 'Nothing to re-measure.', measure: 'ping',
  };
}

function bufferbloat({ speed }) {
  // A responsiveness of zero is not a reading of the worst possible link, it
  // is a test that did not produce the number. 60000/0 is Infinity, and an
  // Infinity that reaches a chart draws a bar off the end of the world.
  if (!speed || !(speed.responsivenessRpm > 0)) return null;
  const rpm = Math.round(speed.responsivenessRpm);
  if (rpm >= RPM_LAGGY) {
    if (rpm >= RPM_GOOD) return null;
    return { id: 'bufferbloat-ok', title: `Responsiveness ${rpm} RPM — the queues hold up`, serious: false,
      found: `${rpm} round trips per minute while the link was saturated, which is about ${Math.round(60000 / rpm)} ms per round trip under load against ${speed.baseRttMs != null ? speed.baseRttMs + ' ms' : 'the idle figure'} when idle. Under ${RPM_LAGGY} is where a link starts to feel laggy; over ${RPM_GOOD} is where it stops being noticeable at all.`,
      fix: null, cost: 'Nothing.', measure: 'the speed test' };
  }
  const loaded = Math.round(60000 / rpm);
  const base = speed.baseRttMs;
  return {
    id: 'bufferbloat',
    title: 'The connection stalls when it is busy — this is why it feels slow',
    serious: true,
    found: `Responsiveness measured ${rpm} RPM${speed.responsivenessFrom && speed.responsivenessFrom !== 'both directions at once' ? ` (${speed.responsivenessFrom})` : ''}. That is ${loaded} ms for one round trip while the link is loaded`
      + (base != null ? `, against ${Math.round(base)} ms when it is idle — ${Math.round(loaded / Math.max(base, 1))} times worse the moment anything downloads.` : '.')
      + ` ${loaded} ms is 60000 divided by ${rpm}: the same measurement, expressed as time instead of as a rate. Anything under ${RPM_LAGGY} RPM is felt as a call breaking up, a cursor lagging in a terminal, and a page that will not start loading while something else is downloading — even when the speed number looks fine.`,
    fix: 'This is the router, not the Mac: turn on smart queue management (fq_codel or cake, sometimes called "bufferbloat" or "SQM") in the router settings, and cap it slightly below the measured line rate. If the router cannot do it, the ISP\'s box usually can be put in bridge mode behind one that can.',
    cost: 'Smart queueing gives up a few percent of peak throughput to hold latency down. If this reading was wrong you traded a number you would not have noticed for one you would.',
    measure: 'the speed test',
  };
}

function asymmetry({ speed }) {
  if (!speed || speed.downBps == null || speed.upBps == null) return null;
  const down = mbps(speed.downBps), up = mbps(speed.upBps);
  if (!(up > down * BACKWARDS_RATIO)) return null;
  return {
    id: 'asymmetry',
    title: 'Download is slower than upload, which is backwards',
    serious: true,
    found: `${down} Mbps down against ${up} Mbps up — the upload is ${(up / Math.max(down, 0.1)).toFixed(1)} times the download. Every consumer link is built the other way round, because that is what people use. When the download is the small number, something is holding that direction back specifically: a congested channel, an interference source on the receive side, a mis-negotiated link, or shaping applied by whatever sits between this machine and the ISP.`,
    fix: 'Run it once more on a cable if there is one — that separates the radio from the line in one test. If the cable is fast and the radio is not, it is the Wi-Fi; if both are slow, the numbers above are what to read to the ISP.',
    cost: 'Ten minutes and one phone call. The risk of being wrong is that the ISP finds nothing.',
    measure: 'the speed test',
  };
}

function resolverCost({ resolvers, resolverHop }) {
  if (!resolvers || !resolvers.health.length) return null;
  const dead = resolvers.dead;
  if (dead.length) {
    return { id: 'resolver-dead', title: `${dead.length === 1 ? 'A resolver on this machine is not answering' : `${dead.length} resolvers on this machine are not answering`}`, serious: true,
      found: `${dead.map((d) => d.ip).join(', ')} ${dead.length === 1 ? 'is' : 'are'} configured and never replied. A resolver list is failover, not a combination: every lookup that lands on a dead entry waits for it to time out first, which is felt as a page that loads its HTML and then sits there without stylesheets.`,
      fix: 'The DNS tab has the command, with the undo written before it.', cost: 'Nothing — the dead entry is doing no work now.', measure: 'the DNS tab\'s probe' };
  }
  const answering = resolvers.health.filter((h) => h.answered);
  if (!answering.length) return null;
  const worst = answering.reduce((a, b) => (b.ms > a.ms ? b : a));
  if (worst.ms < SLOW_RESOLVER_MS) return null;
  // Only the SAME address may be subtracted. The resolver that answers first
  // is often not one of the configured ones — a mesh network answers ahead of
  // them — and subtracting a ping of one server from a query time of another
  // produces a confident number about nothing.
  const hop = resolverHop && resolverHop.ip === worst.ip && resolverHop.received > 0 ? resolverHop.avgMs : null;
  const ownWork = hop != null ? worst.ms - hop : null;
  return {
    id: 'resolver-slow',
    title: `Name lookups cost ${Math.round(worst.ms)} ms before anything loads`,
    serious: true,
    found: `${worst.ip}${worst.owner ? ` (${worst.owner})` : ''} answered a query in ${worst.ms} ms`
      + (ownWork != null && ownWork > RESOLVER_OWN_WORK_MS
        ? `, while ICMP to the same address comes back in ${hop} ms. The path is ${hop} ms; the other ${Math.round(ownWork)} ms is the resolver's own work. Changing network will not fix that — changing resolver will.`
        : hop != null
          ? `, and ICMP to it takes ${hop} ms, so most of the wait is the distance to it.`
          : '.')
      + ' Every hostname a page has not seen before pays this once, and a modern page pulls from a dozen of them.',
    fix: 'The DNS tab lists resolvers that answer fast, and builds the command with the undo first.',
    cost: 'A resolver change is reversible in one command. The risk of picking a filtering one is a checkout or a newsletter link that stops working.',
    measure: 'the DNS tab\'s probe',
  };
}

function meshInPath({ tunnels, resolvers, route }) {
  const up = tunnels.filter((t) => t.ipv4);
  if (!up.length) return null;
  const carrying = up.filter((t) => t.inPath);
  const intercepting = resolvers && resolvers.effective.intercepted;
  if (carrying.length) {
    const t = carrying[0];
    return { id: 'mesh-in-path', title: `${t.label} is carrying everything this machine sends`, serious: false,
      found: `The default route leaves through ${t.name} (${t.ipv4}), so every packet — including the ones measured on this tab — crosses ${t.label} first. The round trips above include its hop, and a speed test run now measures the tunnel, not the link underneath it.`,
      fix: `To measure the link itself, disconnect ${t.label} and open this tab again. To keep it, read every number here as "through the tunnel", which is also how it actually feels.`,
      cost: 'Nothing to disconnect it briefly, unless something you are connected to lives on it.', measure: 'the routing table' };
  }
  const t = up[0];
  return {
    id: 'mesh-beside-path',
    title: `${t.label} is up, but not in the way`,
    serious: false,
    found: `${t.name} holds ${t.ipv4}, and the default route still leaves through ${route ? route.interface : 'another interface'}. Ordinary traffic does not cross it, so it is not what is slowing anything down.`
      + (intercepting ? ` What it does change is DNS: ${resolvers.effective.interceptedBy} answers ahead of everything else, so changing the Wi-Fi resolver may do nothing at all until it is off.` : ''),
    fix: intercepting ? 'The DNS tab says the same thing where the resolver commands are, so nothing there is applied in the belief it took effect.' : null,
    cost: 'Nothing. This row exists so it does not get blamed for a problem it is not causing.',
    measure: 'the routing table',
  };
}

function wifi({ route, radio }) {
  if (!radio || !route || route.kind === 'wired') return null;
  const weak = (radio.rssiDbm != null && radio.rssiDbm <= WEAK_RSSI) || (radio.snrDb != null && radio.snrDb < LOW_SNR);
  const short = radio.ceilingMbps && radio.rateMbps && radio.rateMbps < radio.ceilingMbps * LINK_SHORTFALL;
  if (!weak && !short) return null;
  const where = `${radio.rateMbps} Mbps negotiated on channel ${radio.channel} (${radio.bandGHz} GHz, ${radio.widthMHz} MHz, ${radio.phyMode})`;
  const signal = radio.rssiDbm != null ? `signal ${radio.rssiDbm} dBm over noise ${radio.noiseDbm} dBm, ${radio.snrDb} dB of headroom` : 'signal strength unavailable';
  return {
    id: 'wifi-link',
    title: weak ? 'The Wi-Fi signal is weak enough to be costing you rate' : 'The Wi-Fi link negotiated well below what this channel allows',
    serious: false,
    found: `${where} — ${signal}.`
      + (radio.ceilingMbps
        ? ` The standard allows up to ${radio.ceilingMbps} Mbps at this channel width with ${radio.streams === 1 ? 'one spatial stream' : `${radio.streams} spatial streams`}; that ceiling is the specification's number, not a reading of this link, and the stream count is inferred from the rate and the MCS index rather than reported.`
        : '')
      + (weak ? ` Below ${WEAK_RSSI} dBm, or under ${LOW_SNR} dB of headroom, the card steps down to slower modulations on purpose — it would rather be slow than lose packets.` : ''),
    fix: weak
      ? 'Move closer to the access point, or move the access point off the floor and out of the cabinet. If the band says 2 GHz and the access point also offers 5 GHz, joining that instead is usually worth more than anything else on this list.'
      : 'Check whether the access point is set to a narrower channel width than it could use, and whether a neighbouring network is sitting on the same channel.',
    cost: 'Nothing to try. Moving an access point can make it worse for another room, so change one thing and measure again.',
    measure: 'the radio',
  };
}

// Not a problem — a row that exists to stop the wrong fix. Somebody with a
// slow download and a Wi-Fi icon on screen will move the router first, and on
// a link like this that is guaranteed to change nothing.
function notTheBottleneck({ route, radio, speed }) {
  if (!radio || !speed || speed.downBps == null || !radio.rateMbps) return null;
  const down = mbps(speed.downBps);
  if (!(down < radio.rateMbps * 0.25)) return null;
  return {
    id: 'wifi-not-bottleneck',
    title: 'The Wi-Fi is not what is limiting your download',
    serious: false,
    found: `The radio negotiated ${radio.rateMbps} Mbps with the access point and the download measured ${down} Mbps — ${Math.round(radio.rateMbps / Math.max(down, 0.1))} times less than the link can carry. Whatever is limiting the download is past ${route ? route.interface : 'this interface'}.`,
    fix: 'Do not move the router, buy an access point, or change the channel for this. Read the download figure to the ISP instead.',
    cost: 'Nothing. This row is here to stop an afternoon being spent on the wrong half of the problem.',
    measure: 'the radio and the speed test',
  };
}

// ===========================================================================
// THE HEADLINE — a decision, not a gauge. When nothing is wrong it says so.
// ===========================================================================

function verdict(findings, { route, outside, speed, radio }) {
  const serious = findings.filter((f) => f.serious);
  const link = route
    ? `${route.kind === 'wi-fi' ? 'Wi-Fi' : route.kind === 'wired' ? 'A cable' : route.kind === 'tunnel' ? 'A tunnel' : 'An interface'} (${route.interface}${route.hardwarePort && route.kind !== 'unknown' ? `, ${route.hardwarePort}` : ''})`
    : 'No interface';

  if (serious.length) {
    const first = serious[0];
    return {
      headline: first.title,
      summary: first.found,
      more: serious.length > 1
        ? `${serious.length - 1} more ${serious.length === 2 ? 'thing needs' : 'things need'} doing, below. Each one carries the measurement it came from.`
        : 'The proof of every number is below it, and so is what it costs if the judgement is wrong.',
      link,
    };
  }

  // A row that carries a fix is something to do. Saying "nothing is wrong"
  // above one is the screen contradicting the list underneath it, and the list
  // is the part that was measured.
  const worthDoing = findings.filter((f) => !f.serious && f.fix);

  const proof = [];
  if (outside && outside.received > 0) proof.push(`${outside.avgMs} ms to ${outside.ip} with ${outside.received} of ${outside.sent} packets back`);
  if (speed) proof.push(`${mbps(speed.downBps)} Mbps down, ${mbps(speed.upBps)} Mbps up, ${Math.round(speed.responsivenessRpm || 0) || '—'} RPM`);
  if (radio && radio.rateMbps) proof.push(`${radio.rateMbps} Mbps negotiated on the radio`);

  if (worthDoing.length) {
    const first = worthDoing[0];
    return {
      headline: `Nothing is broken. ${worthDoing.length === 1 ? 'One thing' : `${worthDoing.length} things`} worth doing.`,
      summary: `${link} is carrying traffic${proof.length ? `: ${proof.join(' \u00b7 ')}` : ''}. Nothing measured is urgent. The first row: ${first.title}.`,
      more: worthDoing.length > 1
        ? `${worthDoing.length} rows below, each with the measurement it came from and what it costs to act on it.`
        : 'The row below carries the measurement it came from and what it costs to act on it.',
      link,
    };
  }

  return {
    headline: speed ? 'Nothing here is wrong.' : 'Nothing cheap to measure is wrong.',
    summary: proof.length
      ? `${link} is carrying traffic: ${proof.join(' \u00b7 ')}. No judgement on this page fires on those numbers.`
      : `${link} is carrying traffic, and nothing measured came back outside its threshold.`,
    more: speed
      ? 'A connection that measures fine and still feels slow is usually the responsiveness figure, and that one is measured above.'
      : 'Throughput is not measured here. That test moves real data, so it waits for you to ask.',
    link,
  };
}

module.exports = { collect, speedTest, radio, isPrivateV4, COST };
