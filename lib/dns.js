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
  return {
    providers: PROVIDERS,
    services: perService,
    effective,
    // Without these, this tab would be a pretty button that kills your internet.
    warnings: [
      effective.intercepted
        ? `${effective.interceptedBy} is answering ahead of everything else (${effective.ips[0]}). While it is running, changing the Wi-Fi DNS may change nothing.`
        : null,
      'This panel never runs sudo on its own. It shows the command; you are the one who applies it.',
      'Copy the undo command BEFORE the one that changes anything. If DNS breaks, you will not be able to search for how to fix it.',
    ].filter(Boolean),
    at: Date.now(),
  };
}

module.exports = { collect, recipe, PROVIDERS };
