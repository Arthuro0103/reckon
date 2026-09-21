# The platform contract

Everything `reckon` learns about the machine comes through `lib/platform`. A collector
that shells out on its own is a bug: the next port has to find it, and what gets lost is
never the easy part — it is a guard, silently, on a screen that still looks correct.

To add a platform: write `lib/platform/<process.platform>.js` exporting all 30 names
below, then add a slot to `lib/platform/index.js`. Nothing else changes.
`lib/platform/darwin.js` is the working reference.

---

## The rule, both halves of it

**A measurement never throws.** When the tool is missing or the command fails it returns
`null` — or `[]` where the caller expects a list. `null` means *could not find out*, which
is not zero. A caller that renders a failed check as a clean result has silently dropped a
guard, and that is the worst outcome this project has.

**A command builder never returns `null`.** It validates its arguments and throws
`TypeError`. A half-built command does not show a wrong number: `networksetup
-setdnsservers null` takes the internet down, and whoever pasted it can no longer search
for how to fix it. There are exactly three builders: `setDnsCommand`, `dnsFlushCommand`,
`hostsCommands`.

On an **unsupported platform** there is no implementation, so both halves are moot: every
capability throws `UnsupportedPlatform` (code `RECKON_PLATFORM_UNSUPPORTED`) carrying a
readable message and no stack. `require('lib/platform')` itself never throws.

## Units, because they have caused bugs here

| suffix | meaning |
|---|---|
| `…KB` | kibibytes, 1024 bytes. `du -sk` units. |
| `…MB` | mebibytes. Only swap uses this, because `vm.swapusage` reports it. |
| `…Bytes` | bytes. Only `memoryStats` uses this. |
| `…Pct` | a **number** 0-100. Never the string `"64%"`. |
| `…Days` | whole days, floor. |
| `ms` | milliseconds. |

A field with no suffix is not a quantity. Never return a pre-formatted string for a number
the panel has to chart.

## Cost

| tag | meaning |
|---|---|
| **free** | a table or a path. No process runs. |
| **light** | tens of milliseconds. Safe on every tab switch. |
| **deep** | seconds to minutes. Deep scan only, behind an explicit request. |

---

## Identity

`id` (string, `process.platform`) · `label` (string, e.g. `"macOS"`) ·
`capabilities` (frozen array of the 30 names) · `supported` (boolean) ·
`unsupportedReason` (string or `null`).

---

## Memory and processes

### `memoryStats()` → object | null · **light**
```js
{
  pageSizeBytes: 16384,
  totalBytes: 17179869184,       // physical RAM
  freeBytes, activeBytes, inactiveBytes, wiredBytes, compressedBytes,
  compressions: 41203911,        // counters accumulated SINCE BOOT, not a reading of now
  decompressions, swapins, swapouts
}
```
`null` when the memory tool is missing. The counters are the proof the machine has been
suffering; the `…Bytes` fields are its state right now. Do not mix them on one chart.

### `swapStats()` → object | null · **light**
```js
{ totalMB: 3072, usedMB: 1894.5, freeMB: 1177.5 }
```
**MB, not KB.** Converting twice is how a number ends up a thousand times too big.
`null` when swap cannot be read — which is not the same as a machine with no swap.

### `processList()` → array · **light**
```js
[ { pid: 4711, ppid: 1, rssKB: 224188, cpuPct: 1.4, ageS: 88231, tty: null,
    command: '/Applications/…/Chrome', family: 'Chrome',
    orphaned: false, systemManaged: true } ]
```
Every process, unfiltered — the "under 2 MB changes nothing on screen" cut is a product
decision and belongs to the caller. `[]` on failure.

`ageS` is seconds since the process started, as a number to compute with — unlike
`selfProcess().elapsed`, which is a display string. `null` where the platform does not
publish a start time.

`tty` is the controlling terminal, or **`null` for none**. Never the literal `??` that `ps`
prints: a caller reading that sees a terminal named `??`.

The last two fields are the ones that cost the most to get right, and the reason they live
here instead of in a collector is that each platform reaches them by a different road.

- **`orphaned`** — no living parent is responsible for this process. On macOS that is
  `ppid === 1`, because the kernel reparents. On Windows nothing reparents, so it is
  "the parent id points at a pid that has exited"; Windows reuses ids, so a recycled
  number reads `false`. It errs toward silence, which is right for a field whose only job
  is to put a `kill` on somebody's screen.
- **`systemManaged`** — something other than a shell started this and is responsible for
  it. **`orphaned` is not evidence of a leak until you have checked this**, and the two
  look identical in a process table. macOS unions three nets, and needs all three:
  `launchctl list`, the daemon directories, and **any executable inside an `.app`
  bundle** — every GUI helper reports PID 1 as its parent because LaunchServices started
  it that way.

  The failure this prevents is not hypothetical. The first build of the Pressure collector
  offered to kill 21 copies of `distnoted`, the macOS notification agent, on nothing but
  "PID 1 and no terminal". Exactly **one** of those 21 appears in `launchctl list` — the
  other twenty live in per-session domains the current domain does not enumerate.

  `/usr/bin` is deliberately **not** a daemon directory on macOS: `yes`, `sleep`, `dd` and
  `cat` live there, and those are precisely what a leaked load generator is built from.

`family` is the grouping label the Memory tab renders, and **the vocabulary is part of the
contract**: fourteen processes named `claude` are one thing to the person looking at the
screen, and a port that invents its own labels stops grouping. Produce these where they
apply: `Claude Code (CLI)`, `Claude Desktop`, `Apple VM (Docker/Claude)`, `Docker Desktop`,
`Chrome`, `Opera`, `Firefox`, `Safari`, `Discord`, `Slack`, `VS Code`, `Steam`, `Spotify`,
`Obsidian`, `node (dev servers)`, `python`, `<platform> (system)`. Anything unrecognised
falls back to the executable's own name.

Summed RSS exceeds physical RAM because shared memory is counted in every process. The
caller says so on screen; do not try to correct for it here.

### `listeningPorts()` → array | null · **light** · OPTIONAL
```js
[ { pid: 83905, port: 3010 } ]
```
Every TCP socket in LISTEN state this user can see. One process may appear more than once.

**`null` and `[]` are different answers and both are real.** `null` is "I could not find
out"; `[]` is "nothing is listening". A caller that treats them the same tells somebody
their orphaned dev server is harmless when it never checked.

Unprivileged scope is correct here, not a shortfall — the server somebody forgot to stop
is running as them.

---

### `selfProcess(pid)` → object | null · **light**
```js
{ pid: 8412, cpuPct: 0.28, rssKB: 47104, elapsed: '02:14:07' }
```
The panel measuring itself. `cpuPct` is cumulative, the number Activity Monitor shows.
`elapsed` is a display string, not a duration to compute with.

---

## Filesystem primitives

These exist for one reason: `test -e` and `ls -1` were scattered through the collectors,
and on a platform without them every call answers "false" — the panel would report an
empty machine rather than an unsupported one. Implement with the language's own `fs`; do
not shell out.

### `pathExists(path)` → boolean · **light**
Follows symlinks. `false` also covers *exists but I may not stat it*, so never read `false`
as proof of absence for a path under another user.

### `isDirectory(path)` → boolean · **light**

### `listDirectory(path)` → array of names · **light**
Names, not paths. `[]` when missing or unreadable.

---

## Size, and the guards that make a size trustworthy

### `volumeUsage()` → object | null · **light**
```js
{ device: '/dev/disk3s5', mount: '/System/Volumes/Data',
  totalKB: 482797652, usedKB: 288384724, freeKB: 165457872, usedPct: 64 }
```
The volume holding **user data**, not a read-only system volume. On Apple Silicon the
sealed system volume reads 7% full and tells you nothing. `usedKB + freeKB` does not equal
`totalKB` — reserved space is real, so never compute one from the other two.
`usedPct` is a number. `null` on failure; the caller must handle it, because this one is on
the light path and a throw here takes the whole panel down.

### `dirSizeKB(path, timeout?)` → number | null · **deep**
Apparent size, `du -sk` semantics. Minutes on a large tree.

### `realSizeKB(path, timeout?)` → number | null · **deep**
> **GUARD — sparse files.** Size actually **on disk**, allocated blocks, not apparent size.
> `Docker.raw` reports 1 TB and occupies 20 GB. For a directory, sum the blocks of every
> file: reading the folder's own inode is how a 9.57 GB bundle once measured as zero.

Any target flagged `sparse` in `knownCacheTargets()`, and the Docker disk image, must be
measured with this and never with `dirSizeKB`.

### `fileCount(path, { skip = [], timeout? })` → number | null · **deep**
`skip` prunes directory **names** anywhere in the tree (`['.git']` for a vault). `null`
means the count failed and must be shown as unknown.

Do not count by piping a listing into a line counter. `find /gone | wc -l` succeeds and
prints `0`, and a zero that means *the path is not there* renders exactly like a zero that
was measured. Count the lines yourself so the search tool's exit status survives.

### `hardlinkRatio(path, timeout?)` → object | null · **deep**
```js
{ files: 113350, withHardlink: 2, ratio: 0.0000176, suspect: false }
```
> **GUARD — hard links and APFS clones.** `du` counts the same block twice when a package
> manager or the filesystem shares files, so deleting one copy can free nothing. `suspect`
> is `ratio > 0.2`.

Worth running only above ~1 GB. The screen states the check was made either way — a real
number, including a tiny one, is the point.

### `findSymlinksUnder(roots, { limit = 400, maxDepth = 4, timeout? })` → object · **deep**
```js
{ links: [ { link: '/Applications/Foo', target: '/opt/foo' } ],
  roots: ['/Applications', …],   // the roots actually read
  truncated: false }
```
> **GUARD — symlinks.** Before recommending a delete, look for a symlink pointing at the
> target. `ls` and `du` follow symlinks, which makes the target and the link look like two
> independent things.

Enumerate **once**; the caller filters with
`links.filter((l) => l.target.startsWith(target))`. `truncated` is load-bearing: it is true
when the cap was hit **or a root could not be read**, and while it is true "no link points
here" is not something this answer proves. Say so instead of recommending the delete.

### `homeTopLevelSizes({ limit = 30, timeout? })` → array · **deep**
```js
[ { path: '/…/Library', kb: 128773420, hidden: false } ]  // biggest first
```
Must include entries whose name starts with a dot. A shell glob does not expand them, and
that is how tens of GB stay out of every count people make by hand. `hidden` drives the one
out-of-palette mark on that table: it links the number to the reason it was invisible.
`[]` on failure. The slowest call in the contract.

### `cloudPlaceholders(path, { timeout? })` → object | null · **deep**
```js
{ count: 412, kind: 'icloud', label: 'iCloud Drive' }
```
> **GUARD — cloud-synced vaults.** A file whose contents the sync service has evicted still
> appears in a listing. A count of files on disk under-reports what the vault holds; the
> count you can trust is `git ls-files`, which the caller runs.

`null` means *could not check*, and the caller must print that rather than "no
placeholders" — a failed count that reads as a clean result is how the warning quietly
disappears from a screen that still shows the vault. `kind` names the service
(`icloud`, `onedrive`, …); `label` is what the screen says.

---

## Where things live on this platform

### `knownCacheTargets()` → array · **free**
```js
[ { id: 'npm-cacache',
    path: '/…/.npm/_cacache',
    label: 'npm cache',
    verdict: 'disposable',        // 'disposable' | 'yours' | 'unknown'
    lose: 'Nothing permanent. The next `npm install` re-downloads what it needs…',
    command: 'npm cache clean --force',   // or null when nothing may be recommended
    sparse: true } ]                      // optional; measure with realSizeKB
```
A frozen table; nothing is measured here. `verdict` is the whole product:
`disposable` = the machine rebuilds it on its own · `yours` = only you can recreate it ·
`unknown` = cannot judge, so **`command` must be `null`** and nothing is recommended.
`lose` is what the person loses if the verdict is wrong, and an entry without it does not
belong on the list. Build paths from the home directory at runtime — a hardcoded home
directory fails `node bin/check.js`.

### `dockerDiskImagePath()` → string | null · **free**
The container runtime's disk image. Sparse: measure with `realSizeKB`. `null` when the
platform has no single-file image.

### `likelyCodeDirs()` → array of absolute paths · **free**
Where people on this platform keep repositories. A guess; the caller checks each one at
runtime, because a folder named `dev` full of PDFs is not a code directory.

### `vaultSearchRoots()` → array of absolute paths · **free**
Where a cloud-synced notes vault can be, most specific first — the sync service's container
directory before the plain documents folder.

---

## Checks

### `backupStatus()` → object | null · **light**
```js
{ tool: 'Time Machine', configured: true, latest: '2026-09-11-024118', ageDays: 1 }
```
`null` = **this platform has no backup tool to ask**, which is not the same as
`{ configured: false }` = the tool is here and reports no destination. Confusing the two
reports a serious finding on a machine that backs up some other way. When `configured` is
false, `latest` and `ageDays` are `null`. `ageDays` may be `null` on a configured machine
whose last backup cannot be dated — the caller must not render `null` as `0`.

### `failedServices({ limit = 12 })` → array · **light**
```js
[ { label: 'com.example.agent', exitCode: 78 } ]
```
User services that exited with an error, worst first is not required. Filter out the
platform's **own** services here, not in the caller: system noise has no fix a person can
apply, and only this file knows what the vendor prefix is. `[]` when none or when the
service manager cannot be asked.

---

## DNS

A bug in the monitor shows a wrong number; a bug here leaves the machine without internet,
and nobody connects the two. Nothing in this section applies a change.

### `dnsServices()` → array of strings · **light**
```js
['Wi-Fi', 'Thunderbolt Bridge', 'iPhone USB']
```
Names that can be set, in the order the system lists them. **Omit disabled interfaces** —
setting DNS on one changes nothing and looks like the panel lied. `[]` on failure.

### `dnsForService(name)` → object | null · **light**
```js
{ service: 'Wi-Fi', ips: ['1.1.1.3', '1.0.0.3'], inherited: false }
```
`inherited: true` with `ips: []` means the service has no DNS of its own and takes whatever
DHCP hands out. `null` means the service could not be read — **the caller must drop nulls**
rather than treat an unreadable service as an empty one.

### `effectiveResolver()` → object | null · **light**
```js
{ ips: ['100.100.100.100', '1.1.1.3'],    // at most 6, in ask order
  source: 'scutil --dns',
  intercepted: true,
  interceptedBy: 'Tailscale (MagicDNS)' }
```
What the system is **actually** querying, which may not be what the service config says: a
VPN or mesh network can intercept first. `intercepted` is true when an address in
`100.64.0.0/10` or `fd7a::/16` appears — that is Tailscale MagicDNS, and while it answers
first, changing the Wi-Fi DNS may do nothing at all. Say it before the user tries, or the
panel appears to hand out a command that fails.

### `probeResolver(ip)` → object | null · **light** (~3 s worst case, per IP)
```js
{ ip: '8.8.8.8', ms: 24, answered: true }
```
One question, timed, with a hard 3 s ceiling — a dead server must cost three seconds here
instead of poisoning the whole page.

> **GUARD — never label a number that was not measured.** When `answered` is `false`, `ms`
> is how long the probe **waited before giving up**. It is not a latency. A dead resolver's
> bar reads `no answer`, never a millisecond figure.

`null` only when there is no probing tool at all. The caller adds `owner` (which provider
an address belongs to) and `slow` (`answered && ms > 250`) — both are product knowledge and
do not belong here.

### `setDnsCommand(service, ips)` → object · **free** · **throws**
```js
{ command: 'sudo networksetup -setdnsservers "Wi-Fi" 1.1.1.3 1.0.0.3',
  service: 'Wi-Fi', ips: ['1.1.1.3', '1.0.0.3'], resetsToDhcp: false }
```
Text for a person to read. **Never runs anything.**

Throws `TypeError` on a service name that is empty or carries a quote, backtick, `$`,
backslash, newline or shell metacharacter, and on anything in `ips` that is not an IP
address. This is the most important validation in the project: `service` arrives from a
query parameter, and when it was missing the old builder produced `-setdnsservers null`,
which does not show a wrong number — it points the machine at a server called "null".

`ips: []` is **not** an error. It is the reset-to-DHCP form (`empty` on macOS) and it is how
the undo is written for a machine that had no DNS set. `resetsToDhcp` says which form came
back.

Applying replaces the whole list for that service; it never adds to it. That is deliberate,
and the caller says so on screen: a resolver list is failover, not a combination.

### `dnsFlushCommand()` → string · **free**
```
sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder
```
Every cache the platform keeps, in one line. Miss one and the old answer keeps being served
and the change looks like it did not work. Composed by the caller as
`` `${setDnsCommand(…).command} && ${dnsFlushCommand()}` ``.

---

## The hosts file

`reckon` never writes a line into it. These are paths and command text.

### `hostsFilePath()` → string · **free**
Read it with `fs` to count what is live inside the tool's markers. No platform call needed
for that.

### `hostsBackupPath()` → string · **free**
Where the copy taken before the first apply lives. It must sit **next to** the file it
restores, or somebody finds it months later with no idea what it is.

### `hostsCommands({ snippetPath, begin, end })` → object · **free** · **throws**
```js
{ backupPath: '/etc/hosts.before-reckon',
  backupOnce: '[ -f /etc/hosts.before-reckon ] || sudo cp /etc/hosts /etc/hosts.before-reckon',
  strip:      "sudo sed -i '' '/>>> reckon/,/<<< reckon/d' /etc/hosts",
  append:     'sudo tee -a /etc/hosts < "$HOME/.cache/reckon/hosts-block.txt" >/dev/null',
  restore:    'sudo cp /etc/hosts.before-reckon /etc/hosts' }
```
`begin` and `end` are the short marker patterns. Throws `TypeError` when either is empty or
contains a slash, quote or newline: they become addresses in a stream editor running under
`sudo` against `/etc/hosts`, and a stray slash silently ends the address and turns the
delete into something else entirely.

The undo removes **only** what sits between the markers, so the rest of the file survives.
The prose that explains each command to the user stays in `lib/blocklist.js`; only the
shell text is platform.

---

## Wiring notes for whoever moves the collectors onto this seam

These are the places where a mechanical rename would change what reaches the screen.

- **Do not rename the wire format.** `web/app.js` reads `memory.vm.free`, `.active`,
  `.inactive`, `.wired`, `.compressed`. `memoryStats()` returns `freeBytes` and friends, so
  `lib/memory.js` maps once, in one object literal, and keeps emitting the old names.
- **`processList()` costs two commands on macOS**, not one: the `ps` and a `launchctl list`
  for `systemManaged`. It is still on the light path — `launchctl list` is a read of
  launchd's own table and returns in milliseconds.
- **`processList()` is unfiltered.** `lib/memory.js` must keep its own `rssKB < 2048` cut
  before computing `processCount` and `rssSumKB`, or both totals change.
- **`volumeUsage().usedPct` is a number.** `lib/checks.js` currently does
  `parseInt(c[4], 10)` on a `df` column. Drop the parse; do not re-add a `%`.
- **`dnsForService()` can return `null`.** `lib/dns.js` does
  `perService.flatMap((s) => s.ips)` — filter the nulls out first or it throws on an
  unreadable interface.
- **`volumeUsage()` can return `null`** and is on the light path, which `server.js`
  answers on every tab switch. Handle it there rather than letting it 500.
- **`cloudPlaceholders()` returning `null` is not zero.** `lib/repos.js` builds the vault
  warning from this count; the `null` branch has to say the check could not run.
- **`lib/sh.js` still exports `duKB` and `realKB`.** They are the same macOS
  implementations as `dirSizeKB` / `realSizeKB` here, kept only for the callers that have
  not moved yet. Delete them from `sh.js` in the same commit that migrates the last one —
  two copies of the sparse-file guard is exactly how one of them rots.
- **`bin/check.js` walks `lib/` recursively** and reads only `.js`. It used to read every
  entry directly, which throws `EISDIR` the moment `lib/` has a subdirectory.
