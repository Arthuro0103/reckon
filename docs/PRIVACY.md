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
  even reach it; see the README for why that means no login is needed either). Because
  another page open in the same browser can still make that browser talk to `127.0.0.1`,
  the server also answers only when the `Host` header is `127.0.0.1:<port>` or
  `localhost:<port>`, refuses a `POST` whose `Origin` is any other site, and requires on
  every `POST` a random token it draws at each launch and writes only into the page it serves.
- Caches what it measured in `~/.cache/reckon/` so it doesn't re-measure on every click.
- For the memory measurements it reads the `vm_stat` counters (free, inactive and purgeable pages,
  and the cumulative swap-in and swap-out page counts), the process list (name, family and resident
  size, never the contents of any process), and its own history files in `~/.cache/reckon/`.
  `reckon watch` appends the resident size of each big process family, and of the known heavy apps
  (the AI CLIs, Godot, Electron apps, the Docker VM, Xcode simulators), to
  `~/.cache/reckon/family-history.jsonl`, trimmed to its last 1,000 lines. Only names and megabytes
  are kept; `GET /api/headroom` reads that file and writes nothing.
- If you run `reckon watch --pet` on a Mac, compiles one Swift file (`native/pet.swift`) on your own
  machine and runs it as a child of the watcher. The pet reads `~/.cache/reckon/watch.json`, draws a
  small window above your other windows, and writes one file, `~/.cache/reckon/pet.json`, with which
  display it sits on and where. It opens no port, makes no request, starts no program and deletes
  nothing: `bin/check.js` fails if the file names an address, starts a process, deletes a file or
  writes outside that folder.
- Writes command **text** to the screen for you to read and run yourself — DNS changes
  and `/etc/hosts` blocklist entries included. It does not run those commands.
- Runs a command, or removes a file, itself in exactly one case: you clicked **Do** on a row,
  read the preview, clicked Confirm and let a five-second countdown finish. What runs comes from
  a fixed table in `lib/act.js` and never needs `sudo`:
  - memory: quit an app, stop processes, shut simulators down, quit an idle Docker Desktop,
    end an idle AI session (`kill -TERM` of one `claude` process), stop orphaned MCP or tool
    servers (`kill -TERM` of the group), unload a model from Ollama (`ollama stop <model>`);
  - disk (macOS): clear a cache reckon's table names (with the tool's own cleaner when there is
    one: `npm`, `brew`, `go`, `pip`, `uv`, `qlmanage`; otherwise reckon's own `safeRemove()`),
    remove the `node_modules` of a parked repository, `git worktree remove` a merged worktree
    (never `--force`), move iPhone backups or Mail attachment copies to the Trash, remove unused
    Docker volumes, prune Docker build cache older than 48 hours or `docker system prune` (no
    `-a`, no `--volumes`), delete simulators that can no longer boot, and empty the Trash (two
    confirmations).

  Every one is recorded on your own disk in `~/.cache/reckon/actions.log`: when, what, on which
  process, app or folder, where the Trash put it, and memory or free space before and after.
  That file stays on your machine like everything else here. Moving to the Trash and emptying it
  go through Finder when `/usr/bin/trash` is missing, so macOS may ask once whether the app that
  runs reckon may control Finder.
- To judge the AI-tool rows on the Pressure and Memory tabs, reads, on your machine only:
  - **When a terminal was last used**: the access and modification times of its device file in
    `/dev` (`ttys003`), with `stat`. Nothing is read from the terminal itself.
  - **Which folder an AI session runs in**: `lsof -d cwd` on that one process.
  - **When a Claude Code conversation was last written**: the modification time (`stat`) of the
    `*.jsonl` files in `~/.claude/projects/<that folder>/`. reckon lists the names in that folder
    and stats them; it **never opens a transcript and never reads a word of a conversation**.
    `bin/check.js` fails if `lib/aitools.js` ever opens a file.
  - **The command line of an orphaned process** (parent gone, older than an hour), to recognise an
    MCP server, `npx`, `uvx` or a language server. It is matched in memory and dropped: only a
    tool name (`mcp-server-filesystem`) reaches the screen, and nothing of it is stored.
  - **The command lines of an idle AI session's child processes** (every descendant, at any
    depth), only for a session that is already a candidate, to prove each one is an idle MCP or
    tool server of its own. Matched in memory and dropped the same way: a recognised child shows
    only its tool name, and a child that is not recognised (a shell, `git`, a build) is named on
    screen by its executable's name alone (`zsh`, `git`), never by its arguments.
  - **Which models Ollama has loaded**, when an Ollama process is running: one `GET` to
    `http://127.0.0.1:11434/api/ps`, the loopback address Ollama itself listens on. The address is
    a constant in the code, never read from a setting or an environment variable; no redirect is
    followed; it gives up after two seconds. Nothing is sent to Ollama but that request, and no
    prompt or measurement ever is.

  Whether a session is ended, which one, its terminal, its folder and its resume command go into
  `~/.cache/reckon/actions.log` on your disk, like every other action.
- Never gets a button, whatever the row says: anything that needs `sudo`, DNS, `/etc/hosts`,
  Time Machine snapshots, `purge`, an automatic `kill -9`, `--force` on a worktree, `-a` or
  `--volumes` on a Docker prune, truncating a container log, a repository or a vault, and any
  folder that is not on reckon's table.

## What reckon does not do

- **reckon only contacts machines your computer was already configured to use.**
That is the rule, and it is narrower and more checkable than "no outbound requests"
— which was never true of this tool and should not have been claimed.
- **The pet is a window like any other.** If you share or record your screen, it can be part of what is
  shared. Its card can name processes, so it starts closed and closes itself after 15 seconds; "Hide" in
  its right-click menu removes it until the next run.
- **No telemetry.** Nothing about your usage, your machine, or what the tool found is
  recorded anywhere but your own disk.
- **No accounts, no sign-in, no API keys.** There is nothing to leak because there is
  nothing issued.
- **No LLM of any kind.** No prompt, no measurement, and no scan result is ever sent to a
  language model, local or remote. (reckon asks a local Ollama which models it has loaded, and
  can ask it to unload one after your click; it never sends it a prompt.)
- **No third-party dependencies.** `package.json` has an empty dependencies list. There is
  no supply chain to audit because there is no supply.
- **No data leaves the machine**, except the one case below.

## The one exception: the speed test

The Internet tab includes a speed test you start by clicking a button. It does not run on
page load, on a timer, or in the background — only on that explicit click.

When you click it, the page sends `POST /api/network/speed` to reckon's own loopback
server, and that server runs `networkQuality`, the measurement tool built into macOS. It is
`networkQuality` that talks to Apple's public measurement endpoints (the same infrastructure
macOS itself uses for its own Wi-Fi speed checks), not your browser and not any code of
reckon's. Those requests carry your IP address, as any network request must, and exchange
data sized to measure throughput and latency. The result reckon shows you is the number
`networkQuality` reports, nothing more, and it is not sent anywhere else.

This is the only feature in the project that contacts a server outside your machine, it
is off by default, and clicking it is the only thing that turns it on. If you never open
the Internet tab and click the speed test, this exception never applies to you.

## How to verify any of this yourself

- `package.json` — dependencies field is empty.
- The server binds to `127.0.0.1`, not `0.0.0.0`, and checks Host, Origin and its
  per-launch token — check `server.js`; `node bin/check.js` asks it over a real socket.
- Search the codebase for any hostname other than a loopback address or the speed-test
  endpoint; there isn't one.
- Nothing in `lib/` makes an HTTP request to another machine. The only network code is the DNS
  resolver probe (which queries the resolvers already configured on your machine, not a third
  party), the speed test described above, which `lib/platform` runs as the `networkQuality`
  command, and one loopback request in `lib/aitools.js` to a local Ollama
  (`http://127.0.0.1:11434/api/ps`), made only when an Ollama process is running. That request
  never leaves the machine.

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
addresses listed in the DNS tab, plus the one loopback address of a local Ollama
(`http://127.0.0.1:11434/api/ps` in `lib/aitools.js`), which never leaves the machine. Apart from
that one loopback read, there is no HTTP client in the server: `lib/sh.js` runs local commands,
and that is the only way this program reaches anything.
