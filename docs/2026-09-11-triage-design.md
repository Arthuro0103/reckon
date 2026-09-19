# Triage tab — sorting what exists only on this machine

**Status:** approved design, not yet implemented
**Date:** 2026-09-11
**Scope:** sub-project A of four (A triage → B history → D single script + verify → C live slowness)

## Problem

The panel is good at photographing the machine and bad at remembering anything. Every
scan starts from zero, so it re-asks the same questions forever and it cannot use the
one thing it can never compute on its own: whether a given pile of bytes matters to its
owner.

Measured on this machine (2026-09-11):

- 4 repositories under `~/www` have **no remote at all** — `bass`, `quiron`,
  `simulation`, and `reckon` itself. Deleting any of them is permanent.
- 15 commits exist nowhere but here — `ShieldID` (8), `apolo` (5), `astraken` (1),
  `LibreChat` (1).
- 2 folders hold real content under no version control at all — `ImLazy` (489 MB) and
  `Vaults` (277 MB). Three more (`apollo`, `autopilot`, `new-level`) are empty.
- 0 stashes. That risk is simply absent, which is worth stating.
- Time Machine has **no destination configured**. There is no backup of any of this.

The first framing of this feature was "loss risk — warn him before the SSD dies." The
owner corrected it: most of those unique-to-this-machine repos are **trash he has not
thrown away yet**. `quiron` is new and matters; `bass` might be scrapped for parts
someday; the rest can go.

That correction is the whole design. Unique ≠ precious. The panel structurally cannot
tell the two apart — which is exactly the `não sei` verdict it already uses elsewhere.
So the feature is not an alarm. It is a **sorting workflow with memory**: the panel
lists what exists only here, the owner classifies each item once, and the panel never
asks again.

## Why this is worth building

It gives the panel something it does not have: **a record of the owner's judgment**.
Once `simulation` is marked as trash, the whole repository becomes reclaimable space in
Panorama — not just its `node_modules`. Once `quiron` is marked keep, it becomes a
standing to-do with the command that gets it off this machine.

## Architecture

A new tab, plus a state file that is deliberately kept out of the scan.

```
lib/triagem.js          inventory + verdict storage + fingerprinting
  ~/.cache/reckon/triage.json     the owner's answers (not the machine's measurements)
server.js               GET /api/triagem · POST /api/triagem/marcar
web/app.js              the tab, and the propagation into Panorama
lib/decisoes.js         reads verdicts; a `lixo` repo becomes a removable item
```

**The state file is separate from `scan.json` on purpose.** Folding a human verdict
into the scan output would force every new scan to choose between discarding the
owner's answers and no longer being a faithful record of what was measured. Measurement
and judgment are different kinds of fact and they get different files.

### Inventory — what gets listed

Three families, each answering a different question. Everything here is already
collected or is one `git` call away from what `lib/repos.js` collects today.

| family | condition | why it is on the list |
|---|---|---|
| repo with no remote | `git remote` is empty | this machine is the only copy |
| repo ahead of its upstream | `git rev-list --count @{u}..HEAD` > 0 | part of it exists only here |
| repo with uncommitted changes | `git status --porcelain` non-empty | not in any commit, so no clone has it |
| repo with stashes | `git stash list` non-empty | invisible work; zero today, cheap to check |
| folder with no git at all | no `.git` and size > 1 MB | no history, no remote, nothing |
| worktree | already collected | same rules as a repo |

**Out of scope for this version:** the Obsidian vault and the Docker volumes holding dev
databases. Both are real local-only data, and both are listed under "what it still does
not do" in the README so they enter when they are actually missed rather than on a guess.

### Verdicts

Four states: `guardar`, `lixo`, `talvez`, and the implicit *unanswered*.

```json
{
  "itens": {
    "/Users/arthurparis/www/bass": {
      "veredito": "talvez",
      "em": 1789154694515,
      "impressao": { "commit": "3bed4a8", "sujos": 62, "temRemoto": false }
    }
  },
  "em": 1789154694515
}
```

### The fingerprint — the forcing function

Every verdict carries `{commit, sujos, temRemoto}` captured at the moment it was given.
On each scan the panel recomputes those three values and compares.

**If any of them changed, the verdict expires.** The item returns to the tab carrying
the reason — *"you marked this as trash on 11/09, but you have committed to it since"* —
and asks again. Without this rule, a three-month-old mark silently authorises deleting
work that did not exist when the mark was made. This is the one invariant in the feature
that, if dropped, turns it from useful into dangerous.

A verdict whose path no longer exists is dropped from the file on the next write.

### What each verdict does

| verdict | in the Triage tab | in Panorama |
|---|---|---|
| `guardar` | becomes a standing to-do with the command that gets it off this machine | nothing changes |
| `lixo` | archive and removal shown side by side, with both sizes | the **whole repository** becomes reclaimable space, not just its `node_modules` |
| `talvez` | stays listed, no nagging, counted in the tab header | nothing changes |
| unanswered | this is what the tab is asking for | nothing changes |

### Archive before delete — and the trap inside it

`git bundle create <file> --all` packs a repository's entire history into a single file.
Measured here:

| repo | folder on disk | bundle | commits preserved |
|---|---|---|---|
| `bass` | 1.0 GB | **901 KB** | 212 |
| `simulation` | 120 MB | **710 KB** | 261 |
| `quiron` | 732 KB | 67 KB | 7 |

Verified round-trip: cloning `simulation`'s bundle restored all 261 commits.

This removes the tension between keeping and reclaiming — for `bass`, everything that
matters keeps for 901 KB while 1 GB comes back.

**The trap:** `git bundle --all` packs only what is **committed**. `bass` has 62
modified files with no commit; its 901 KB bundle would contain none of them. Offering
"archive for 901 KB, delete 1 GB" without saying so would be recommending the loss of
real work wearing the costume of safety.

So: for any item with a dirty tree, the panel shows the commit-or-stash step **before**
the bundle, and the "what you lose" line counts the two separately — what the bundle
saves, and what it does not.

Both commands are shown side by side with the archive path recommended and both sizes
written. There is no gate forcing the archive first: the owner is the one running the
commands and an extra step on something he is certain about is friction, not safety.

## Safety rails

1. **The panel deletes nothing.** Unchanged from the rest of the product. It writes only
   to `~/.cache/reckon/`.
2. **It never runs `gh repo create` on its own.** That creates something in his account.
3. **Path allowlist.** Only paths under `~/www` and `~/orca/workspaces` can be marked or
   can produce a removal command. The state file is a file on disk; a path read from it
   must never be able to steer an `rm -rf` at an arbitrary location.
4. **A dirty tree blocks nothing but is always stated.** The count of uncommitted files
   appears in the "what you lose" line for every item that has one.
5. **Expired verdicts never act.** An item whose fingerprint changed contributes nothing
   to Panorama's total until it is reconfirmed.

## Testing

Added to `bin/testar.js`:

- a verdict outside `{guardar, lixo, talvez}` is rejected
- a changed fingerprint marks a verdict expired (construct a stored verdict, change the
  commit, assert expiry)
- a path outside the allowlist is refused, both for marking and for command generation
- an expired verdict contributes zero to the Panorama total
- the existing shared-scope and CSS-class checks cover the new tab's markup

## Acceptance criteria

1. The tab lists the 4 repos with no remote, the 2 unversioned folders with content, and
   the 4 repos holding unpushed commits.
2. Marking an item and reloading the page preserves the mark.
3. Committing into a repo marked `lixo` invalidates the mark, and the tab says why.
4. Marking a repo `lixo` increases Panorama's reclaimable total by the whole repo.
5. An item with uncommitted changes shows the commit-or-stash step above the bundle, and
   its "what you lose" line counts committed and uncommitted work separately.
6. `node bin/testar.js` passes.

## Deliberately not in this version

- the vault and the Docker volumes holding dev databases
- anything touching GitHub remotely (the owner noted his GitHub needs its own cleanup;
  that is a different product that reaches off this machine)
- bulk actions — every item is classified one at a time
