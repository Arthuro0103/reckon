# Packaging reckon

Three ways to get reckon onto a Mac (or a Windows box, for the tab that opens
it — the panel itself only understands macOS, see `lib/platform/`), cheapest
to build first. All three ship the exact same server and web/ code; nothing
about the product changes, only how it arrives.

| tier | what the person runs | needs installed already |
|---|---|---|
| 1. `npx` | `npx @arthuro0103/reckon` | Node 18+ |
| 2. single executable | double-click, or run it from a terminal | nothing |
| 3. same executable | double-click — a browser tab opens for you | nothing |

Tier 3 is not a separate build: it's the same binary tier 2 produces, and the
"opens a browser tab" behavior is in that binary already (see
`build/build-sea.js`'s generated bootstrap). There's nothing further to do for
it beyond building tier 2 and telling people to double-click instead of piping
it into a terminal.

---

## Tier 1 — `npx @arthuro0103/reckon`

Nothing to build. Publishing is the packaging.

```bash
npm publish
```

For that to work correctly:

- `package.json`'s `"files"` field must list exactly what ships: `bin/`,
  `lib/`, `server.js`, `web/`, and the example config — not `build/`, `docs/`
  (screenshots), or the SEA binaries. See the `package.json` patch that ships
  with this task.
- `bin/reckon` checks `process.versions.node` before requiring anything else,
  so someone on an old Node gets `reckon needs Node 18 or newer` instead of a
  cryptic syntax error three requires deep. That's already in `bin/reckon`.
- `npm pack --dry-run` from the repo root shows exactly what would be
  published — run it before every publish and read the file list, not just
  the tarball size.

No build step, no CI job needed for this tier beyond what already runs on
every push (`node bin/check.js`).

---

## Tier 2 — single executable (`node:sea`)

```bash
node build/build-sea.js darwin-arm64   # Apple Silicon Mac
node build/build-sea.js darwin-x64     # Intel Mac
node build/build-sea.js win32-x64      # Windows
node build/build-sea.js                # (no argument) = whatever machine you're on
```

Output lands in `build/dist/`: `reckon-macos-arm64`, `reckon-macos-x64`,
`reckon-windows-x64.exe`. Each one is fully standalone — no Node, no npm, no
files sitting next to it. `web/index.html`, `app.js`, `charts.js`, `style.css`
and `tokens.css` are embedded in the binary through the SEA assets map;
`server.js` and everything under `lib/` are concatenated into one generated
main script. Nothing is read from disk at runtime except your machine itself
(disk, memory, Docker, git, DNS) and, if you keep one, `reckon.config.json` in
the directory you launch it from.

**One machine can build all three targets.** The script downloads an official
Node build for each target platform from nodejs.org and only ever shells out
to `tar`/`unzip` to extract it and `codesign`/`npx postject` to prepare it —
none of that needs to run *as* the target OS or CPU, so a Mac can produce the
Windows `.exe` too. The one thing that genuinely needs to run on macOS is
`codesign`, so build the macOS binaries there.

### Why it downloads a fresh Node instead of using yours

**This is the part that will bite you if you skip it.** Building against a
Homebrew-installed Node fails during injection with:

```
Multiple occurences of sentinel found, don't know which occurence to use.
```

Homebrew's packaging duplicates a section of the binary that contains
`postject`'s fuse sentinel string, so the injector finds it twice and refuses
to guess. The binary published directly on nodejs.org contains it exactly
once. `build-sea.js` therefore always downloads
`https://nodejs.org/dist/v<version>/node-v<version>-<platform>.<ext>` into
`build/.cache/` and injects into *that* copy — never into `process.execPath`
or anything found on `$PATH`. If you ever see the sentinel error again, look
for a `node` that came from somewhere other than nodejs.org in the path this
script used.

### Pinning the Node version

`build-sea.js` pins `NODE_VERSION` at the top of the file (currently
`22.15.1`, matching the machine this task was built against). Override it
per-run with `RECKON_BUILD_NODE_VERSION=22.x.x node build/build-sea.js …` if
you need a different one, and bump the constant in the file (and
`"engines"` in `package.json`) together when you move the floor.

### What actually happened when this was run here

Ran on macOS 15, Apple Silicon, against Node v22.15.1:

```
node build/build-sea.js darwin-arm64
  downloading https://nodejs.org/dist/v22.15.1/node-v22.15.1-darwin-arm64.tar.gz
  extracting node-v22.15.1-darwin-arm64.tar.gz
  official node binary: build/.cache/node-v22.15.1-darwin-arm64/node-v22.15.1-darwin-arm64/bin/node
  wrote bundle: build/.gen/sea-main.js
  generating SEA blob
  removing existing signature
  injecting SEA blob with postject (via npx, not a project dependency)
  applying ad-hoc signature
  done: build/dist/reckon-macos-arm64 (103.8 MB)
```

Then, with `PATH=/usr/bin:/bin` — no `node`, no `npm`, nothing this project
ships reachable — the binary was started, and it served the full app:
`GET /`, `/app.js`, `/style.css` all returned `200` with the embedded assets,
and `/api/self` returned real numbers from the running process. Also built
and smoke-tested `darwin-x64` the same way (run under Rosetta on the same Apple
Silicon Mac — Intel Macs will run it natively) and built (not run — no
Windows machine available in this environment) `win32-x64`; `file` confirms
it as a genuine `PE32+ executable (console) x86-64, for MS Windows`, and
`postject`'s own log shows the injection completing.

### macOS: what a downloader will actually see, and how to get past it

An ad-hoc-signed binary (this script signs with `codesign --sign -`, meaning
"signed, but by nobody in particular") is not enough on its own to satisfy
**Gatekeeper** once the file has crossed the internet — macOS stamps
downloaded files with a quarantine attribute, and Gatekeeper checks that
against Apple's notarization service regardless of the ad-hoc signature.
Concretely, someone who downloads `reckon-macos-arm64` and double-clicks it
will see:

> **"reckon-macos-arm64" cannot be opened because the developer cannot be
> verified.**

The honest way past that, in order of least to most involved:

1. **Right-click (or Control-click) the file → Open**, then click **Open**
   again in the dialog that appears. This is the one Apple actually designed
   for exactly this case — it bypasses Gatekeeper for that one file, once,
   without touching any system-wide setting.
2. Or from a terminal, clear the quarantine flag on the file you downloaded:
   `xattr -d com.apple.quarantine reckon-macos-arm64` — this is scoped to
   that one file, not a system setting, and is the right thing to tell
   someone comfortable with a terminal rather than "turn off Gatekeeper."
3. **Do not** tell people to disable Gatekeeper globally
   (`spctl --master-disable`) or "allow apps from anywhere" in System
   Settings — that is a real, standing reduction in the security of the whole
   machine to solve a one-file problem, and it is not this project's call to
   ask for it.

The only way to remove the warning entirely is an Apple Developer ID
certificate ($99/year) plus notarizing every release through Apple's
service — genuinely out of scope for a project with this budget, and nothing
above requires it. Document option 1 prominently in the release notes; it is
one right-click and costs a downloader nothing.

### Windows: what a downloader will see

The `.exe` is unsigned (no code-signing certificate involved anywhere in this
pipeline). SmartScreen will show:

> **Windows protected your PC** — Microsoft Defender SmartScreen prevented an
> unrecognized app from starting.

The way past it, same spirit as the macOS case — a per-file, deliberate
click, not a system-wide setting: click **More info**, then **Run anyway**.
As with Gatekeeper, the only way to remove this warning is a paid code-signing
certificate with enough download reputation built up over time; not in scope
here.

### The `node:sea` fuse, briefly

`postject` writes the blob into the binary and flips a "fuse" — a marker
string (`NODE_SEA_FUSE_…`) that Node's own bootstrap checks at startup to
decide whether it's running as a single executable app or as plain Node. This
is also *why* the sentinel-duplication problem above breaks the whole build:
the fuse is found by locating that same sentinel, so a binary with it twice
can't be trusted to have it flipped in the right place.

### Re-running

Downloads are cached under `build/.cache/` — re-running for a target you've
already built reuses the cached archive/binary and just regenerates the
bundle, blob and injected copy. Delete `build/.cache/` to force a fresh
download (e.g. after bumping `NODE_VERSION`). `build/.gen/` and `build/dist/`
are regenerated every run and are gitignored, same as `build/.cache/` — none
of the three should ever be committed.

---

## CI (`.github/workflows/release.yml`)

Two jobs:

- **`check`** — runs `node bin/check.js` on every push and pull request, on
  Node 18 and Node 22, so a change that only breaks the floor version doesn't
  slip through on the maintainer's newer local Node. This gate matters more
  than the release job below: it runs on every push, not just tags.
- **`release`** — on pushing a tag matching `v*`, builds all three targets on
  their native runners (`macos-14` for arm64, `macos-13` for Intel, so
  `codesign` runs on real macOS rather than being skipped or cross-signed;
  `windows-latest` for the `.exe`) and attaches the three binaries to a GitHub
  Release for that tag.

## What to hand someone who has never opened a terminal

Link them straight to the release asset for their platform (not the repo, not
`npm`, not a terminal command) and, for macOS, mention the one right-click
from the Gatekeeper section above in the release notes — that's the entire
support burden this adds.
