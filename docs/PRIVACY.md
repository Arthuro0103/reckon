# Privacy

This is a statement of fact about what the code does, not a policy someone wrote to sound
reassuring. Every claim below is checkable by reading the source — that's the point of it
being checkable rather than promised.

## The short version

reckon reads your machine and shows you the result on a page only your machine can open.
It does not have anywhere else to send that information, because it has no dependencies,
no accounts, no API keys, and no server it talks to except itself.

## What reckon does

- Reads disk usage, memory, running processes, Docker's disk image, your Git
  repositories, and your DNS configuration — all on the machine it runs on.
- Serves a web page from `127.0.0.1` (loopback only — nothing outside the machine can
  even reach it; see the README for why that means no login is needed either).
- Caches what it measured in `~/.cache/reckon/` so it doesn't re-measure on every click.
- Writes command **text** to the screen for you to read and run yourself — DNS changes
  and `/etc/hosts` blocklist entries included. It does not run those commands.

## What reckon does not do

- **reckon only contacts machines your computer was already configured to use.**
That is the rule, and it is narrower and more checkable than "no outbound requests"
— which was never true of this tool and should not have been claimed.
- **No telemetry.** Nothing about your usage, your machine, or what the tool found is
  recorded anywhere but your own disk.
- **No accounts, no sign-in, no API keys.** There is nothing to leak because there is
  nothing issued.
- **No LLM of any kind.** No prompt, no measurement, and no scan result is ever sent to a
  language model, local or remote.
- **No third-party dependencies.** `package.json` has an empty dependencies list. There is
  no supply chain to audit because there is no supply.
- **No data leaves the machine**, except the one case below.

## The one exception: the speed test

The Internet tab includes a speed test you start by clicking a button. It does not run on
page load, on a timer, or in the background — only on that explicit click.

When you click it, your browser makes network requests directly to Apple's public network
measurement endpoints (the same infrastructure macOS itself uses for its own Wi-Fi speed
checks). These requests carry your IP address, as any network request must, and exchange
data sized to measure throughput and latency. reckon's server is not in that path — it's
your browser talking to Apple, not reckon relaying anything — and the result reckon shows
you is the number that comes back, nothing more.

This is the only feature in the project that contacts a server outside your machine, it
is off by default, and clicking it is the only thing that turns it on. If you never open
the Internet tab and click the speed test, this exception never applies to you.

## How to verify any of this yourself

- `package.json` — dependencies field is empty.
- The server binds to `127.0.0.1`, not `0.0.0.0` — check `server.js`.
- Search the codebase for any hostname other than a loopback address or the speed-test
  endpoint; there isn't one.
- Nothing in `lib/` makes an HTTP request. The only network code is the DNS resolver probe
  (which queries the resolvers already configured on your machine, not a third party) and
  the speed test described above.

If a future version of this document stops matching the code, that's a bug in the
document — file it as one.


## What actually leaves this machine

Three things, and nothing else:

**1. DNS probes, when you open the DNS tab.** reckon asks each resolver your machine
is *already configured to use* a single question (`example.com`) and times the reply.
Those servers already receive every name you look up; this adds one query and no new
counterparty. It is what surfaced a dead resolver that was adding 500-900 ms to every
lookup on the author's machine, which is why it runs on open rather than behind a click.

**2. Ping, when you open the Internet tab.** Same rule: your gateway, and any resolver
you configured that lives off your network. An earlier draft pinged 1.1.1.1 as a generic
"is the internet up" anchor — a third party nobody chose, on every tab open. That was
removed. If none of your resolvers is off-network, the reading simply does not happen
and the tab says so.

**3. The speed test, only when you click it.** This one contacts Apple's measurement
endpoints (`networkQuality`, built into macOS) and deliberately saturates your
connection for 15-30 seconds. It never runs on its own — not on load, not on tab open,
not on a timer. The screen states the cost before the button.

There is no analytics, no crash reporting, no update check, no account, no key, and no
model of any kind. `package.json` has no dependencies, so nothing arrives through the
back door either.

### How to check this yourself

```bash
grep -rn "http://\|https://" lib/ server.js web/app.js
```

Everything it returns is either a comment, a documentation URL, or the DNS-provider
addresses listed in the DNS tab. There is no HTTP client in the server: `lib/sh.js` runs
local commands, and that is the only way this program reaches anything.
