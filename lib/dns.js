'use strict';
const platform = require('./platform');

// ---------------------------------------------------------------------------
// A separate tab on purpose. A bug in the monitor shows a wrong number; a bug
// here leaves the machine WITHOUT INTERNET, and nobody connects the two.
// So: nothing runs by itself, no silent privilege escalation, and every command
// ships with its undo written BEFORE it — on screen, not in your shell history.
//
// Every command below is built by lib/platform, which throws rather than emit
// one it could not build cleanly. This file holds the product knowledge: which
// providers exist, who owns an address, what counts as slow, and the prose that
// tells a person what they are about to do.
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
// A resolver list is FAILOVER, not a combination. No operating system merges
// filters: it asks whichever server answers first. Stacking five filtering
// providers does not give you five filters — it gives you an unpredictable one
// of them, and a single dead entry poisons every lookup on the machine.
//
// This is not hypothetical. Five providers from the list above were once
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

// ---------------------------------------------------------------------------
// The prose around the commands, which is the only part of this tab that is
// platform-specific — the commands themselves come from lib/platform.
//
// It is here rather than there because it is product copy: it explains what a
// person is about to do and what to do when it goes wrong. `sep` is not copy:
// `&&` is a syntax error in Windows PowerShell 5.1, so joining two commands
// with it there produces a line that cannot run at all.
// ---------------------------------------------------------------------------
const PROSE = {
  darwin: {
    sep: ' && ',
    applyNote: 'it will ask for your password. this panel does not type sudo for you.',
    verify: (ip) => `dig +short doubleclick.net @${ip}   # 0.0.0.0 or empty means blocked`,
    showResolvers: 'scutil --dns | grep nameserver | head -4',
  },
  win32: {
    sep: '\n',
    applyNote: 'run it in a PowerShell you started with "Run as administrator". there is no sudo here, and an ordinary shell fails with a permission error rather than a wrong result.',
    verify: (ip) => `Resolve-DnsName doubleclick.net -Server ${ip} -DnsOnly -NoHostsFile   # 0.0.0.0 or no answer means blocked`,
    showResolvers: 'Get-DnsClientServerAddress -AddressFamily IPv4 | Format-List InterfaceAlias, ServerAddresses',
  },
};
const prose = PROSE[platform.id] || {
  sep: '\n',
  applyNote: 'this command needs administrator rights. this panel does not run it for you.',
  verify: (ip) => `# ask ${ip} for doubleclick.net — 0.0.0.0 or no answer means blocked`,
  showResolvers: '# read the resolver list back from the system',
};

// The caller adds what the platform cannot know: which provider owns an address,
// and what counts as slow. Anything past ~250 ms will be felt on a page that
// pulls from several hostnames, even though it technically works.
async function probe(ip) {
  const r = await platform.probeResolver(ip);
  if (!r) return { ip, ms: null, answered: false, owner: OWNER.get(ip) || null, slow: false };
  return { ...r, owner: OWNER.get(r.ip) || null, slow: r.answered && r.ms > 250 };
}

// Build the (apply, undo) pair WITHOUT running anything. The panel never does.
//
// The builders throw rather than return a half-built command. That is on
// purpose and it is the most important behaviour in this file: `service`
// arrives from a query parameter, and a command with a hole in it does not show
// a wrong number — it takes the internet down, and whoever pasted it can no
// longer search for how to fix it.
function recipe(service, providerId, currentIps) {
  const p = PROVIDERS.find((x) => x.id === providerId);
  if (!p || !p.ips.length) return null;

  const apply = platform.setDnsCommand(service, p.ips);
  const undo = platform.setDnsCommand(service, currentIps || []);
  const flush = platform.dnsFlushCommand();

  return {
    provider: p.name,
    blocks: p.blocks,
    apply: apply.command + prose.sep + flush,
    undo: undo.command + prose.sep + flush,
    applyNote: prose.applyNote,
    undoExplained: undo.resetsToDhcp
      ? 'This hands the service back to whatever DNS your router supplies — which is how it was.'
      : `This restores exactly the addresses set right now: ${undo.ips.join(' ')}.`,
    verify: prose.verify(p.ips[0]),
    ifItBreaks: 'If name resolution stops working, paste the undo command. It does not depend on DNS to run.',
  };
}

// ---------------------------------------------------------------------------
// The repair for a list that is stacked or has a dead entry in it, built from
// what was actually measured rather than from a template.
//
// It is built HERE and not in the front end, which is where it used to be: the
// front end pasted a macOS command together out of string fragments, and on any
// other platform that is a command the user cannot run being shown as the fix.
// The builders throw on anything they cannot construct cleanly, and a repair
// that cannot be built is simply absent — there is no half-built version.
// ---------------------------------------------------------------------------
function repair({ services, health, providers, dead, stacked }) {
  if (!dead.length && !stacked) return null;
  const target = services.find((s) => /wi-?fi|ethernet/i.test(s.service)) || services[0];
  if (!target) return null;

  const alive = health.filter((h) => h.answered && !h.slow);
  // Every provider the user already chose that is also answering. Picking one
  // for them would be guessing at what they wanted blocked; the command needs a
  // concrete pair, so it takes the first and says the rest are one swap away.
  const candidates = providers.filter((p) => p.ips.length && p.ips.some((ip) => alive.some((a) => a.ip === ip)));
  const keep = candidates[0] || { ips: ['1.1.1.1', '1.0.0.1'], name: 'Cloudflare (unfiltered)' };

  try {
    const flush = platform.dnsFlushCommand();
    return {
      service: target.service,
      keep: keep.name,
      keepIps: keep.ips,
      others: candidates.slice(1).map((p) => p.name),
      undo: platform.setDnsCommand(target.service, target.ips).command + prose.sep + flush,
      undoNote: 'this restores the current list, dead entry included. it is here so nothing is lost by trying.',
      apply: platform.setDnsCommand(target.service, keep.ips).command + prose.sep + flush,
      applyNote: prose.applyNote,
      verify: prose.showResolvers,
      verifyNote: 'come back to this tab afterwards and every bar should be short.',
    };
  } catch {
    // A service name the builder refuses is not a repair worth showing. The
    // panel says nothing rather than showing a command with a hole in it.
    return null;
  }
}

async function collect() {
  const svcs = await platform.dnsServices();
  const perService = [];
  for (const s of svcs) {
    const one = await platform.dnsForService(s);
    // A service that could not be read is dropped, not folded in as one with no
    // DNS: an unreadable interface treated as an empty one is a resolver list
    // the panel would then confidently say is short.
    if (one) perService.push(one);
  }

  const effective = (await platform.effectiveResolver())
    || { ips: [], source: null, intercepted: false, interceptedBy: null };

  // Probe every distinct IPv4 resolver that is actually configured. IPv6 and
  // link-local entries are skipped: probing those is unreliable enough that a
  // mark against one would be the tool's fault, not the network's.
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
    repair: repair({ services: perService, health, providers: PROVIDERS, dead, stacked }),
    // Without these, this tab would be a pretty button that kills your internet.
    // The measured findings come first: a generic caution nobody reads is worth
    // less than "this specific address on your machine is not answering."
    warnings: [
      dead.length
        ? `${dead.map((d) => d.ip).join(', ')} ${dead.length === 1 ? 'is' : 'are'} configured on this machine and ${dead.length === 1 ? 'does' : 'do'} not answer. Every lookup that lands there stalls, which is felt as pages loading without their stylesheets. Remove ${dead.length === 1 ? 'it' : 'them'}.`
        : null,
      stacked
        ? `This interface lists ${owners.length} different providers at once (${owners.join(', ')}). A resolver list is failover, not a combination: the system asks whichever answers first, so this does not give you every filter — it gives you an unpredictable one of them. Keep one provider, both of its addresses.`
        : null,
      slow.length
        ? `${slow.map((d) => `${d.ip} (${d.ms} ms)`).join(', ')} answer, but slowly. A page pulling from several hostnames will feel it.`
        : null,
      effective.intercepted
        ? `${effective.interceptedBy} is answering ahead of everything else (${effective.ips[0]}). While it is running, changing the Wi-Fi DNS may change nothing.`
        : null,
      'This panel never runs a privileged command on its own. It shows the command; you are the one who applies it.',
      'Copy the undo command BEFORE the one that changes anything. If DNS breaks, you will not be able to search for how to fix it.',
      'Applying any option below REPLACES the whole list for that service — it does not add to it. That is deliberate: two addresses from one provider is a working setup, and addresses from several providers is not.',
    ].filter(Boolean),
    at: Date.now(),
  };
}

module.exports = { collect, recipe, PROVIDERS };
