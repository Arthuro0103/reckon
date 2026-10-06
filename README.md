<p align="center">
  <img src="docs/img/banner.svg" alt="reckon: your computer is full, this tells you what to do about it. Local, read-only, never deletes." width="100%">
</p>

**reckon tells you what to do about a full or struggling computer, and never deletes anything itself.** It runs on your machine, on macOS and Windows, with no dependencies and no telemetry.

## Why it exists

It started because my computer felt painfully slow. An AI assistant went through it and found about 50 GB I could free. I built reckon to go deeper than that, and to work for any machine instead of only mine. On the same computer it found roughly another 100 GB, almost all of it Docker data sitting in caches nobody knew about.

That is one machine and one author, so read it as the story of why the tool exists, not as a benchmark. Three decisions came out of it:

1. **A decision, not a treemap.** Most disk tools draw the folders and leave the thinking to you. reckon opens with what you can free, and why each item is safe.
2. **It never deletes anything.** It reads your machine, works out what it thinks, hands you the command, and stops. You run it.
3. **"Cannot judge" is an answer.** It only calls something disposable when it can prove the machine rebuilds it. Everything else it names and leaves alone.

![The Overview tab: "You can free 9.95 GB", the items behind that number, and what changed since the last scan](docs/img/overview.png)

*The Overview, captured 2026-10-06 on the author's machine. One private project name is covered.*

## What it is

Every item carries three things, always: **how much it frees**, **the proof of that number**, and **what you lose if the verdict is wrong**. Without all three it does not become a row.

![How reckon works: it reads your machine, judges every item, hands you the command, and you run it](docs/img/flow.svg)

### It never deletes anything

Not a safety toggle, a design constraint. `reckon` writes only inside `~/.cache/reckon/`. It reads your machine, works out what it thinks, hands you the command, and stops. You run it.

That rule is why the interesting work is in the *judgement*, not in the deleting. A tool that deletes has to be conservative to be safe. A tool that only recommends can afford to say exactly what it found and exactly how sure it is.

### It measures itself

A panel that runs all the time spends the memory it is measuring. So the footer shows, always, how much RAM and CPU `reckon` itself is using and how that compares to what it found. In the Overview above: 94.8 MB of RAM (0.58% of the machine) and 4.8% CPU, pointing at 9.95 GB. If that ever inverts, the footer says so instead of hiding it.

The architecture follows from that. No framework, no bundler, **no dependencies at all**. Collection happens on demand: between your clicks the process sits at 0% CPU. There is no background daemon and no telemetry; nothing leaves the machine. The one thing that watches is `reckon watch`, below, and it never starts unless you run it.

## Who it is for

Anyone with a full disk. reckon first knew only developer leftovers (package caches, `node_modules`, container logs), so on a machine that had never run `npm` it had little to say. It now also knows what any computer accumulates on its own: browser caches and offline site data for eight browsers, Windows Update leftovers, `Windows.old`, temporary files, the Recycle Bin, thumbnail and preview caches, Mail attachment copies, and iPhone backups. The last is listed and never offered for deletion, because it is often the only copy of photos from before the last iCloud sync.

---

## Install

```bash
npx @arthurparis/reckon          # http://127.0.0.1:4127
```

Or from a clone:

```bash
git clone https://github.com/Arthuro0103/reckon.git
cd reckon
node server.js          # http://127.0.0.1:4127
```

Node 18+. There is no `npm install` for a clone: the project has no dependencies.

```bash
node bin/scan.js        # deep scan from the terminal (~2 min)
node bin/check.js       # the test suite
```

The first visit asks for a scan. It reads the disk folder by folder, enters the Docker VM, and
runs `git` in every repository — about two minutes, cached afterwards in `~/.cache/reckon/`.
Nothing is measured again until you ask.

**Configuration is optional.** `reckon` looks for your code in the usual places (`~/code`,
`~/dev`, `~/src`, `~/Projects`, `~/repos`, `~/git`, `~/work`, `~/www`, `~/Developer`) and finds
Obsidian vaults by their marker directory. To override any of it, copy
`reckon.config.example.json` to `reckon.config.json` — that name is gitignored, so your paths
never end up in a commit.

---

## The tabs

| tab | what it does |
|---|---|
| **Overview** | the decisions, ordered by how much they free. The screen that opens |
| **Memory** | what is using RAM now, grouped by app, and how much each changed since you opened |
| **Pressure** | what is stealing time from the machine right now, counted in seconds instead of bytes: orphaned swarms, stale sessions, dev servers nobody is using |
| **Disk** | where the space went, folder by folder, with a verdict: `disposable` · `yours` · `cannot judge` |
| **Internet** | which link is carrying traffic, the round trip to your router and to the resolvers you already use, and — behind their own buttons, with the cost stated first — throughput and the Wi-Fi radio |
| **Checks** | what is broken and has a fix |
| **DNS** | two halves: a blocklist you build, and the resolver your machine asks |

![The Disk tab: a treemap of every cache this tool can name, colour is the verdict](docs/img/disk.png)

*Disk. Area is size, colour is the verdict, and "cannot judge" is a real answer. Captured 2026-10-06.*

![The Memory tab: what is using RAM right now, grouped by app](docs/img/memory.png)

*Memory. Fifty processes named Opera count as one thing, because that is what the person looking sees. Captured 2026-10-06.*

![The Pressure tab: how much slower the machine runs than at its best, and how much swap is in use](docs/img/pressure.png)

*Pressure. Time instead of bytes: the same fixed piece of arithmetic, now against the fastest the machine has ever done it. Captured 2026-10-06.*

DNS is a **separate tab on purpose**. A bug in the monitor shows a wrong number; a bug in DNS
leaves you without internet, and you will not connect the two. Neither can take the other down,
and neither imports the other's code.

---

## Watching, if you ask

`reckon watch` is a separate command for the case where the machine starts to struggle while
nobody has the panel open. It never starts by itself, and the dashboard server does not change.

```bash
node bin/reckon watch             # until ctrl+c
node bin/reckon watch --once      # one full reading, printed, then exit
node bin/reckon watch --corner    # also show the lantern in a small window, only when things turn bad
```

It says what it costs when it starts (about 50 MB, one cheap reading every 30 seconds), writes only
inside `~/.cache/reckon/` (`watch.json`, `watch.log`), and stops when you press ctrl+c. It never runs
the command it shows you.

**It does not alert on load.** Load counts runnable work, and a machine doing a lot of legitimate work
looks the same as one that is suffering: an ordinary parallel compile read a load of 72 on ten cores
with swap at zero and half the RAM free, and the probe said the machine was 1.1x its best. So it
watches three things: **seconds stolen** (the probe from the Pressure tab, against the best this machine
has ever done), **swap against RAM** and how fast it is filling (not against the swap file's own size,
which macOS grows on demand), and **orphaned swarms** that are costing real time. Load may make it go
and look; it is never the answer.

An alert says how much it costs, the proof of the number, and what you lose if it is wrong. One problem
rings once, again only if it gets worse by a step, and is announced once when it clears. The banner is
a native macOS notification; if you never see one, check System Settings > Notifications for Script Editor. Banners and the corner window are macOS features, and `watch` has not been tested on Windows.

![The four expressions of the lantern: resting, watching, uneasy, strained](docs/img/lanterns.svg)

The **corner window** is the lantern from `/pet`, fed with the real number. It opens when things turn
bad, closes by itself when they calm, shows the command as text with a copy button, and is served from
the watcher itself on `127.0.0.1:4128`. The page in it asks the watcher for its numbers every three
seconds; that is the one place this project polls, and it exists only if you asked for `--corner`. It is
a browser window, so it is not always on top: over a full-screen app, the banner is what reaches you.

---

## The guards, and what each one cost somebody

**Symlinks.** Before suggesting you delete a directory, `reckon` looks for a symlink pointing at
it. `ls` and `du` follow symlinks, which makes the target and the link look like two independent
things.

**Hard links and APFS clones.** `du` counts the same block twice when pnpm or APFS share files,
so deleting one copy can free nothing. On any target above 1 GB, `reckon` counts files with
`nlink > 1` and warns when the number may be inflated.

**Sparse files.** `Docker.raw` reports 1 TB and occupies 20 GB. `reckon` measures allocated
blocks (`stat -f %b`), not apparent size. For a directory it sums the blocks of every file:
reading the folder's own inode is how a 9.57 GB bundle once measured as zero.

**Docker volumes.** `docker volume prune` does not touch **named** volumes, and
`prune --volumes` while a container is stopped deletes that container's volume with it. `reckon`
separates the three cases — genuinely orphaned, attached to a stopped container, in use by a
running one — and only ever recommends removing the first group, one at a time, by name.

**Commits off the main branch.** Before calling any folder garbage, `reckon` runs
`git rev-list --count main..HEAD`. Then it goes further and checks whether those commits exist
on any remote. Commits off your local `main` that were also pushed to `origin` are one kind of risk;
the same commits existing only on this disk are another. The screen keeps them apart.

**Obsidian vaults are minefields.** Inside an iCloud-backed vault `ls` lies: iCloud evicts file
contents and leaves placeholders, so a directory listing can report fewer files than the vault
holds. The count you can trust is `git ls-files`. And `.git` is never garbage — it is the only
copy of everything you have written **and deleted**.

**DNS.** Every change ships with the undo built from what is configured right now, and the undo
appears **before** the apply, numbered as step 1. If DNS breaks, you cannot search for how to
fix it. No silent `sudo`: the panel writes the text, you read it and type it.

**The blocklist.** You build the list on screen — ready-made sets, or one domain at a time.
`reckon` keeps it in a file of its own, generates the snippet at
`~/.cache/reckon/hosts-block.txt`, and shows the command. It never writes a line to
`/etc/hosts`. The snippet is delimited by markers, so the undo removes exactly that and leaves
the rest of the file intact, and the first apply saves a copy to `/etc/hosts.before-reckon`.

The limit sits on screen above the buttons: **`/etc/hosts` matches exact names.** Blocking
`doubleclick.net` does not block `ad.doubleclick.net`, and there are no wildcards. To catch a
domain and everything under it you need a filtering resolver — the other half of the tab.
Without that warning somebody builds the list, applies it, still sees an ad, and concludes the
tool is broken.

---

## The charts

All hand-drawn in SVG. A panel that measures RAM should not load 300 kB of library to draw a bar.

| shape | answers |
|---|---|
| cumulative steps | do these in order — where does free space land? |
| pie | what *kind* the leftovers are — half of it is package cache, which comes back on its own |
| columns | the biggest ones side by side, judged by height |
| donut with emphasis | how the whole splits, and which slice needs a decision |
| horizontal bars | who is biggest, when names are too long to sit under a column |
| grouped bars | what Docker *counts* against what it *occupies* — the blind spot, measured |
| treemap | area is size, colour is verdict, the whole disk on one screen |
| scatter | age against weight per project, ringed where commits sit off `main` |
| indexed line | swap and compression on one plot, both rebased to 100 |
| area with crosshair | swap and compression over the session |
| gauge | how much disk, swap and RAM is spoken for |

Rules that hold in every one of them:

- **One axis. Never two.** Swap (MB) and compressed memory (GB) appear either as two small
  charts or as one chart with both rebased to **index 100**. What does not happen is dividing one
  measure by 100 so it "fits" the other — that is a dual axis in disguise, and the alignment
  would be mine rather than the data's.
- **Every shape has a table twin**, behind a `show table` button. A tooltip improves reading; it
  is never the only way to read a value.
- **Direct labels are selective.** The two or three largest, or the extreme. A number on every
  point is chaos and goes unread.
- **A nominal category gets one colour.** Shading each bar by its size spends the identity
  channel repeating what length already says.
- **Thin marks, 1px solid gridlines** (never dashed), a 2px gap in the surface colour between
  touching marks — separation by gap, not by a border drawn around things.

### Colour

Cyan `#19a2b8` on deep ocean blue `#0b1a26`. The eight series colours were not picked by eye —
they pass all six checks of a categorical-palette validator against the real surface:

```
lightness band        PASS   all 8 inside OKLCH L 0.48–0.67
chroma floor          PASS   all 8 at C >= 0.10
CVD separation        PASS   worst adjacent pair dE 10.3 (protanopia)
normal-vision floor   PASS   worst adjacent pair dE 20.0
contrast vs surface   PASS   all 8 above 3:1
```

Shapes where any mark can touch any other — scatter, treemap — use at most three of them,
because the all-pairs check is stricter. The slot order is the colour-vision safety mechanism:
it does not change, and a ninth series does not exist.

**Status never becomes a colour.** There is no green or red anywhere in this project.
`disposable` and `stays` are told apart by position and label; urgency in Checks is the word
"now" or "later". Colour from outside the palette appears in exactly two places, and always
because it **links** a number to its proof or marks the **boundary** between what goes and what
stays.

To rebrand: replace the values in `web/tokens.css` and re-run a palette validator against your
surface. Nothing else needs to change.

---

## What it does not do yet

- **It deletes nothing, and that is permanent.** There is no execute button and there will not
  be one.
- **It follows up by comparison, not by watching.** It keeps exactly one scan back. Scan again
  and the Overview states free space then and now, and names the items that were on the list and
  are not any more. It does NOT claim to have caused the difference: free space moves because a
  download finished or a snapshot expired too, and the screen says so rather than taking credit.
- **It only knows the folders somebody taught it.** The Disk tab has a fixed list of known
  targets (npm, pip, uv, Homebrew, HuggingFace, Playwright, Xcode, Gradle, Cargo, Go…). A 30 GB
  folder outside that list shows up in the "top of your home folder" table with no verdict, and
  the tool says **"cannot judge"** rather than guessing.
- **It judges a project only by commit date.** Sixty days quiet marks its `node_modules`
  disposable. An active project that simply receives no commits is not told apart from an
  abandoned one.
- **No external disks or other volumes.** Only this machine's data volume.
- **The DNS tab applies nothing and verifies nothing afterwards.** It writes the three commands
  — undo, apply, check — and stops.
- **The blocklist cannot tell whether you applied it.** It counts what is live inside its own
  markers in `/etc/hosts`; edit the file by hand outside them and it will not see it.
- **The ready-made sets are small and hand-written.** Dozens of domains, not the hundreds of
  thousands in a community-maintained list. For real coverage the answer is a filtering
  resolver, not `/etc/hosts`.
- **Memory history dies with the process.** It lives in server memory, capped at 120 points.
- **No authentication** — and none is needed: the server refuses any connection that is not
  loopback, and listens on `127.0.0.1` only. Do not expose it. This panel can see the whole
  machine, and that is a map of it.
- **macOS and Windows. Linux is not written yet.** Every reading goes through `lib/platform`,
  which has 30 required capabilities and a handful of optional ones; `darwin.js` and `win32.js`
  implement all 30, and `lib/platform/linux.js` does not exist — the panel says so by name
  rather than half-working. Tested on Apple Silicon running macOS 26. The Windows build is
  tested on Windows 11; Intel Macs should work and have not been verified.

## Contributing

The one rule: **nothing in this repository may delete, move or overwrite anything outside
`~/.cache/reckon/`.** A pull request that adds an execute button will be declined, however
convenient it looks.

`node bin/check.js` has to pass. It exists because adding accents to this project's copy once
silently corrupted six names that are contracts — a require path, a tab id, an API key, a query
parameter — and `node --check` passed on every one of them. The worst produced
`networksetup -setdnsservers null`, which does not show a wrong number: it takes the internet
down.

## License

MIT.
