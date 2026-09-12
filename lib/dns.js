'use strict';
const { run, sh } = require('./sh');

// ---------------------------------------------------------------------------
// A separate tab on purpose. A bug in the monitor shows a wrong number; a bug
// here leaves the machine WITHOUT INTERNET, and nobody connects the two.
// So: nothing runs by itself, no silent sudo, and every command ships with its
// undo written BEFORE it — on screen, not in your shell history.
// ---------------------------------------------------------------------------

const PROVIDERS = [
  { id: 'current', name: 'Whatever is set right now', ips: [], blocks: '—',
    note: 'Reference only. Changes nothing.' },
  { id: 'cloudflare-family', name: 'Cloudflare 1.1.1.3', ips: ['1.1.1.3', '1.0.0.3'],
    blocks: 'Malware and adult content',
    note: 'Does not block ads. Fast, no signup. A low-risk first step that rarely breaks a site.' },
  { id: 'cloudflare-malware', name: 'Cloudflare 1.1.1.2', ips: ['1.1.1.2', '1.0.0.2'],
    blocks: 'Malware only',
    note: 'The most conservative option that still filters anything. Almost never breaks a legitimate site.' },
  { id: 'adguard', name: 'AdGuard DNS', ips: ['94.140.14.14', '94.140.15.15'],
    blocks: 'Ads, trackers and malware',
    note: 'Blocks ads for real. Can break newsletter links and checkouts that route through a tracker.' },
  { id: 'quad9', name: 'Quad9', ips: ['9.9.9.9', '149.112.112.112'],
    blocks: 'Malicious domains (threat-intelligence list)',
    note: 'Security-focused rather than ad-focused. Does not log your IP.' },
  { id: 'mullvad', name: 'Mullvad DNS (adblock)', ips: ['194.242.2.3', '193.19.108.3'],
    blocks: 'Ads and trackers',
    note: 'No logs, no signup. Servers in Europe, so it may add a few milliseconds.' },
];

// ---------------------------------------------------------------------------
// A resolver list is FAILOVER, not a combination. macOS does not merge filters:
// it asks whichever server answers first. Stacking five filtering providers
// does not give you five filters — it gives you an unpredictable one of them,
// and a single dead entry poisons every lookup on the machine.
//
// This is not hypothetical. Five providers from the list below were once
// stacked onto one interface; one of them had stopped answering, and every
// hostname on the machine started taking 500-900 ms to resolve. Pages still
// loaded — their HTML came from an already-cached host — but stylesheets,
// served from other hostnames, timed out. One browser rendered every site
// unstyled while the others, using DNS-over-HTTPS, were unaffected.
//
// So the tab measures the list it finds instead of trusting it.
// ---------------------------------------------------------------------------

// Every IP this tool knows about, mapped back to the provider that owns it.
const OWNER = (() => {
  const m = new Map();
  for (const p of PROVIDERS) for (const ip of p.ips) m.set(ip, p.name);
  // Resolvers this tool does not offer but will certainly meet.
  m.set('8.8.8.8', 'Google'); m.set('8.8.4.4', 'Google');
  m.set('1.1.1.1', 'Cloudflare (unfiltered)'); m.set('1.0.0.1', 'Cloudflare (unfiltered)');
  m.set('100.100.100.100', 'Tailscale MagicDNS');
  return m;
})();

// Ask one resolver a question and time it. `dig` gets a hard 3s ceiling, so a
// dead server costs three seconds here instead of poisoning the whole page.
async function probe(ip) {
  const t0 = Date.now();
  const r = await run('dig', ['+short', '+time=3', '+tries=1', 'example.com', `@${ip}`], { timeout: 6000 });
  const ms = Date.now() - t0;
  const answered = r.ok && /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/m.test(r.out.trim());
  return {
    ip, ms, answered,
    owner: OWNER.get(ip) || null,
    // Anything past ~250 ms will be felt on a page that pulls from several
    // hostnames, even though it technically works.
    slow: answered && ms > 250,
  };
}

async function services() {
  const r = await run('networksetup', ['-listallnetworkservices'], { timeout: 15000 });
  if (!r.ok) return [];
  return r.out.split('\n').slice(1).map((s) => s.trim()).filter(Boolean).filter((s) => !s.startsWith('*'));
}

async function dnsFor(name) {
  const r = await run('networksetup', ['-getdnsservers', name], { timeout: 12000 });
  if (!r.ok) return { service: name, ips: [], inherited: true };
  const lines = r.out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (lines.some((l) => /aren't any DNS Servers/i.test(l))) return { service: name, ips: [], inherited: true };
  return { service: name, ips: lines.filter((l) => /^[\d.:a-f]+$/i.test(l)), inherited: false };
}

// What the system is ACTUALLY querying right now, which may not be what
// networksetup reports: a VPN or mesh network can intercept first.
async function effectiveResolver() {
  const r = await run('scutil', ['--dns'], { timeout: 12000 });
  if (!r.ok) return { ips: [], intercepted: false };
  const ips = [];
  for (const l of r.out.split('\n')) {
    const m = l.match(/nameserver\[\d+\]\s*:\s*(\S+)/);
    if (m && !ips.includes(m[1])) ips.push(m[1]);
  }
  // 100.100.100.100 is Tailscale MagicDNS. If it answers first, changing the
  // Wi-Fi DNS may do nothing at all — worth saying before you try.
  const tailscale = ips.some((i) => i.startsWith('100.100.100.100') || i.startsWith('fd7a:'));
  return { ips: ips.slice(0, 6), intercepted: tailscale, interceptedBy: tailscale ? 'Tailscale (MagicDNS)' : null };
}

// Build the (apply, undo) pair WITHOUT running anything. The panel never does.
function recipe(service, providerId, currentIps) {
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p || !p.ips.length) return null;
  const q = JSON.stringify(service);
  const back = currentIps && currentIps.length ? currentIps.join(' ') : 'empty';
  return {
    provider: p.name,
    blocks: p.blocks,
    apply: `sudo networksetup -setdnsservers ${q} ${p.ips.join(' ')} && sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder`,
    undo: `sudo networksetup -setdnsservers ${q} ${back} && sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder`,
    // 'empty' is the word networksetup understands for "go back to DHCP".
    undoExplained: back === 'empty'
      ? 'This hands the service back to whatever DNS your router supplies — which is how it was.'
      : `This restores exactly the addresses set right now: ${back}.`,
    verify: `dig +short doubleclick.net @${p.ips[0]}   # 0.0.0.0 or empty means blocked`,
    ifItBreaks: 'If name resolution stops working, paste the undo command. It does not depend on DNS to run.',
  };
}

async function collect() {
  const svcs = await services();
  const perService = [];
  for (const s of svcs) perService.push(await dnsFor(s));
  const effective = await effectiveResolver();

  // Probe every distinct IPv4 resolver that is actually configured. IPv6 and
  // link-local entries are skipped: `dig @` on those is unreliable enough that
  // a red mark would be the tool's fault, not the network's.
  const configured = [...new Set(perService.flatMap((s) => s.ips))]
    .filter((ip) => /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(ip));
  const health = await Promise.all(configured.map(probe));
  const dead = health.filter((h) => !h.answered);
  const slow = health.filter((h) => h.slow);

  // More than one provider on a single interface is the stacking mistake.
  const owners = [...new Set(health.map((h) => h.owner).filter(Boolean))];
  const stacked = owners.length > 1;

  return {
    providers: PROVIDERS,
    services: perService,
    effective,
    health, dead, slow, owners, stacked,
    // Without these, this tab would be a pretty button that kills your internet.
    // The measured findings come first: a generic caution nobody reads is worth
    // less than "this specific address on your machine is not answering."
    warnings: [
      dead.length
        ? `${dead.map((d) => d.ip).join(', ')} ${dead.length === 1 ? 'is' : 'are'} configured on this machine and ${dead.length === 1 ? 'does' : 'do'} not answer. Every lookup that lands there stalls, which is felt as pages loading without their stylesheets. Remove ${dead.length === 1 ? 'it' : 'them'}.`
        : null,
      stacked
        ? `This interface lists ${owners.length} different providers at once (${owners.join(', ')}). A resolver list is failover, not a combination: macOS asks whichever answers first, so this does not give you every filter — it gives you an unpredictable one of them. Keep one provider, both of its addresses.`
        : null,
      slow.length
        ? `${slow.map((d) => `${d.ip} (${d.ms} ms)`).join(', ')} answer, but slowly. A page pulling from several hostnames will feel it.`
        : null,
      effective.intercepted
        ? `${effective.interceptedBy} is answering ahead of everything else (${effective.ips[0]}). While it is running, changing the Wi-Fi DNS may change nothing.`
        : null,
      'This panel never runs sudo on its own. It shows the command; you are the one who applies it.',
      'Copy the undo command BEFORE the one that changes anything. If DNS breaks, you will not be able to search for how to fix it.',
      'Applying any option below REPLACES the whole list for that service — it does not add to it. That is deliberate: two addresses from one provider is a working setup, and addresses from several providers is not.',
    ].filter(Boolean),
    at: Date.now(),
  };
}

module.exports = { collect, recipe, PROVIDERS };
