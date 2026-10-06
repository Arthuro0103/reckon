# Watch — a companion that speaks only when the machine is struggling

**Status:** implemented (2026-09-29): `reckon watch`, the banner and the corner window. The lantern is the chosen creature.
**Date:** 2026-09-29
**Scope:** sub-project C of four ("live slowness"), reserved in `2026-09-11-triage-design.md`

## Problem

Every reading reckon takes happens when somebody looks. That is a stated virtue —
"between your clicks the process sits at 0% CPU" — and it is also the gap: the machine
degrades while nobody is looking, and by the time somebody opens the Pressure tab the
afternoon is already lost.

Measured on the machine this was designed on (2026-09-29, 16 GB, 10 cores):

- Swap climbed from 10.9 GB to **12.7 of 13.3 GB** in about ninety minutes. The system
  had to grow the swap file by 1 GB on its own. The load average read **245**. Nothing
  in reckon said a word, because nobody had it open.
- A hand-made watcher that alerted on **load average** fired at load 72 during an ordinary
  parallel compile: swap 0 MB, 49% RAM free, nothing orphaned, nothing wrong. It fired
  four times in all (72, 61, 50, 44) as the same compile wound down.

The second finding is the design. **Load is the wrong signal.** It counts runnable work,
and a machine doing a lot of legitimate work looks identical to a machine that is
suffering. The first reading was a real emergency and the second was a healthy machine
busy, and load average told them apart only by degree.

## The principle that has to bend, and how

The README says: *no background daemon, no polling.* A watcher is exactly that. Rather
than quietly break the sentence, the feature follows the same rule the speed test
already lives under (`CONTRIBUTING.md` §3):

- It is **its own command**, `reckon watch`. The dashboard server stays exactly as it is.
- It **never starts by itself** — not on install, not on page load, not on a timer.
- It **states its own cost** on screen, the way the footer already does for the panel.
- It writes only inside `~/.cache/reckon/`, and stops with ctrl+c.

## What counts as a problem

Three signals, none of them load:

| signal | source | why this one |
|---|---|---|
| **Seconds stolen** | `pressure.probe()` against the earned baseline | Measures what the person feels: the same fixed work taking longer. The baseline is "this machine at its best", never a typed threshold. |
| **Swap against RAM, and its slope** | `platform.swapStats()` | Measured against physical RAM, **not** against the swap file's own size: macOS grows its swap on demand, so right after a restart the total is 1 GB and "72% full" was 740 MB, which is nothing (the first version of the watcher made exactly that mistake). 12.7 GB on a 16 GB machine says something. Level says where it is; slope says where it is going. |
| **Orphaned swarms** | `pressure.swarms()` / `orphanServers()` | Already solves "is this an orphan or a system agent" — the 21 copies of `distnoted` mistake is documented in `lib/platform/CONTRACT.md`. |

**The probe burns CPU on purpose** (40M iterations, about a third of a second), so the
watcher cannot run it on a timer without becoming the thing it warns about. Two tiers:

1. **Cheap sample every 30 s** — swap, free memory and loadavg through the seam. No probe.
2. **The probe only on suspicion** — when swap gains ground, free memory drops under a
   floor, or loadavg has stayed high for several samples. Load is allowed to *ask the
   question*. It is never allowed to *be the answer*: a busy machine with a probe factor
   near 1.0 and swap flat is dismissed.

## What an alert contains

The house rule, unchanged: **how much it costs, the proof of that number, and what you
lose if the verdict is wrong.** An alert that cannot fill all three is not sent. In this
project's currency the cost is seconds stolen, not gigabytes.

> **Things are running about 6× slower than this machine's best.** Swap is at 12.7 of
> 13.3 GB and gained 1.8 GB in the last ten minutes. Proof: the probe took 1.9 s against
> a best of 0.30 s. If this is wrong: nothing is lost, the alert clears itself.
> `kill 36695` — the biggest orphan, idle since it was orphaned 17 days ago.

The command is **text**. The watcher never runs it (`CONTRIBUTING.md` §1).

### One alert per problem, not one per reading

The hand-made watcher's worst flaw was that it treated a changing number as a new
problem. The rules here:

- An alert is keyed by **kind** (`swap`, `stolen`, `swarm:<command>`), never by value.
- A kind speaks once, then stays quiet until it **worsens by a step** (probe factor
  doubles; swap gains another 10% of its total) or **clears**.
- Clearing is announced once, with the number that cleared it. Silence is not
  "resolved"; it is only silence.
- A cooldown of ten minutes per kind, so a reading that flaps around a threshold cannot
  ring the doorbell forever.

## Surfaces, in order of cost

1. **A native notification** (`osascript`, no dependency, nothing written outside the
   cache). This alone answers "warn me". It ships first.
2. **The companion**: a small window in the corner of the screen that is **absent until
   there is something to say**. It is a page served by the existing loopback server
   (`/pet`), opened chromeless by the user's own browser (`--app=`). No native code, no
   Electron, no dependency — which is the only way to have a window and keep
   `package.json` empty. The limit, stated up front: a browser window is not
   always-on-top, so on a full-screen app the notification still does the job the window
   cannot.

The window is never the only way to learn something. Every alert is also a line in
`~/.cache/reckon/watch.log`, the same way every chart has a table twin.

## The companion's design

### The rule that constrains it most: status is never a colour — with one exception

`CONTRIBUTING.md` §5 forbids red and green as signals, and a virtual pet that goes red
when the machine is in trouble is the first thing everybody would draw. The owner chose
the lantern and asked for it to glow in different colours, so §5 now carries one narrow,
dated exception, and the test suite holds it in place:

| state | flame | glow | rays | the words beside it |
|---|---|---|---|---|
| resting | a dot, unlit | none | none | — (the window is not shown) |
| watching | small | cyan | one pair | "keeping an eye on something" |
| uneasy | medium | yellow | three pairs | names the kind: swap, slow, swarm |
| strained | tall | orange | five pairs, outline trembling, a drop | says how many seconds it is costing |

Never red, never green (`--s6` and `--s8` are off limits and `bin/check.js` fails on them).
Colour is never the only signal: the flame, the rays, the tremor and the sentence carry
the same information, so a reader who cannot tell the hues apart loses nothing. Amber
(`--edge`) keeps its two legal jobs only: linking the number to its proof, and marking a
boundary.

### How the art gets made

Adopted from how the sibling project `a sibling project` makes its art (its `DESIGN.md`,
decision 13, 2026-09-27):

1. **The owner makes the base design** — a sketch and the images that inspired it.
2. **The final art is drawn in code**, on top of that base. Here the code is hand-written
   SVG (`web/pet.js`), the same no-dependency method as `web/charts.js`, where a sibling project
   uses Godot draw calls.
3. **The owner looks at it up close and approves it** before it enters. Nothing ships on
   the strength of a description.

The style, also carried over: *simple shapes with a marked outline, that grow by
adjusting the drawing* — not a sprite sheet. Concretely, every state is a handful of
numbers (eye size, brow angle, mouth curve, outline tremor) fed to one drawing function,
so a new expression is a new row of numbers, not a new file.

The first draft is the starting point and not the end. It borrows the only mascot this
project already has: the italic cyan **o** in the logotype, `reck`**`o`**`n`.

## How it decides (as built)

The rules live in `lib/watch.js` as pure functions, and `bin/check.js` tests them as rules,
each case being something that actually happened on the machine:

- **Load alone is silent.** A load of 72 with nothing else wrong raises nothing.
- **The bad afternoon raises exactly two alerts** (seconds stolen, swap), each with its cost,
  its proof and what you lose.
- **Twelve identical readings ring twice**, not twenty-four times; a 5x reading alerts, 6x stays
  quiet, 11x says it got worse.
- **It clears after two calm readings**, not one, and stays quiet for ten minutes after a clear.
- **A reading not taken is unknown, not calm**: a probe that did not run cannot clear an alert.
- **An alert with no proof to show is not sent.**

The level fed to the lantern is `max(swap, stolen)`: swap is 0 at a tenth of RAM and 1 at three
quarters; stolen is 0 at the machine's best and 1 at sixteen times it. A reading that was not taken
contributes nothing.

## What was left out on purpose

- **The binary.** `build/build-sea.js` embeds a fixed list of `web/` files and dispatches only
  `report`, so `/pet`, `/corner` and `reckon watch` are not in the packaged binary yet. From a clone,
  they work.
- **Windows.** `notify` and `openWindow` are optional capabilities and `win32.js` does not implement
  them, so a Windows run still gets the log and the state file, and no banner or window.
- **Always-on-top.** A browser window cannot promise it. Decided on 2026-10-06 to be solved with one
  optional native file; see "Decision: a native pet" below.

## Decision: a native pet (2026-10-06)

The browser window cannot sit above a full-screen app, and a companion that disappears exactly when
someone is deep in a full-screen app is the case it was meant for. So `reckon watch --pet` (macOS
only) draws the lantern in a small borderless panel written in Swift, `native/pet.swift`.

- **Source, not a binary.** reckon compiles the file on the person's machine with `swiftc` the first
  time, into `~/.cache/reckon`. Nothing is downloaded and nothing prebuilt is shipped.
- **No port, no polling of its own.** The pet reads `~/.cache/reckon/watch.json`, which the watcher
  already writes atomically. `--pet` starts no server.
- **Lives and dies with `watch`.** It exits when its parent goes away. There is no login item and no
  LaunchAgent: reckon still never starts by itself.
- **Never runs the command.** Like the corner window, it shows the command as text and offers a copy
  button, nothing else.
- **Windows** keeps what it has: the log and the state file.

CONTRIBUTING §2 records why this is the one exception to "plain Node and hand-written web files".

## Non-goals

- **No killing.** The pet may show `kill 36695`. It will never offer a button that does it.
- **No history database.** That is sub-project B. The watcher keeps a short in-memory
  window for the slope and one log file.
- **No cloud, no push to a phone.** Nothing leaves the machine (`docs/PRIVACY.md`).
- **No alert on load alone.** See "Problem".

## Open questions

- The owner's own base sketch and references for the pet. The first draft is a
  placeholder for that conversation, not a substitute for it.
- Whether a browser `--app=` window is an acceptable window, or whether the always-on-top
  gap justifies a native shell later. Decided by trying it, not by arguing it.
- Windows: `listeningPorts()` and the orphan fields exist on both platforms, but a
  chromeless window and a native notification need their own row in
  `lib/platform/CONTRACT.md` before this ships there.
