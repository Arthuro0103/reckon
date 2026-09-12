# Contributing to reckon

The constraints below aren't style preferences. Each one exists because breaking it makes
the tool something other than what it claims to be. A pull request that breaks one gets
declined regardless of how good the rest of it is — say so in the review rather than
merging it and fixing it later, because "later" is how the constraint quietly stops being
true.

## 1. Nothing deletes, moves, or overwrites anything outside `~/.cache/reckon/`

This is the rule the whole project is built to prove, not a default that can be relaxed
for one feature. reckon reads your machine, works out what it thinks, hands you the exact
command, and stops. You run it.

**A pull request that adds an execute button will be declined, however convenient it
looks** — "just this once, behind a confirmation dialog" is still an execute button. If a
feature needs to write something to make itself useful (a generated snippet, a cache, a
config template), it writes inside `~/.cache/reckon/` and nowhere else. If it needs to
write outside that folder — including `/etc/hosts`, DNS settings, or anything under a
user's home directory — it produces the shell command as text and stops there, the same
way the DNS tab and the blocklist already do.

## 2. Zero dependencies

`package.json` has an empty `dependencies` object, and it stays that way. No npm package,
no bundler, no framework — plain Node 18+ and hand-written HTML/CSS/JS. This isn't
purism: every dependency is something a person has to trust, and this tool asks for zero
trust beyond reading its own source. If a feature seems to need a library, the answer is
to write the smaller thing the library would have done, not to add the dependency.

## 3. No network calls from the server to any third party

No API keys, no telemetry, no LLM of any kind. The one standing exception is the
user-initiated speed test on the Internet tab, and that exception has two hard
conditions that must never be loosened: it runs from the **browser**, not the server, and
only on an **explicit click** — never on page load, a timer, or any code path a user
didn't just trigger. A pull request that adds a second network call, or that makes the
speed test start itself, breaks this constraint even if the call looks harmless.

## 4. Everything user-facing is in English

Copy, labels, error messages, and code comments too. This project was bitten once by
copy edits that silently corrupted contract identifiers — see rule 8 — so a change that
touches user-facing or comment text should be reviewed with that history in mind, not
just for language.

## 5. Status is never a colour

There is no green/red traffic light anywhere in this project, and there will not be one.
`disposable` vs. `stays` is told apart by position and label; urgency in Checks is the
word "now" or "later", never a colour. The only colour allowed outside the eight-slot
categorical palette (`web/tokens.css`) is `--edge` (amber), and it may only do one of two
jobs: link a number to its proof, or mark a boundary between two classes of thing. A pull
request that reaches for red or green to mean "bad" or "good" is reintroducing the exact
signal this project was built to remove — see the README for why.

## 6. Chart rules

- **One axis per chart, never two.** Two measures on different scales become two small
  charts, or one chart with both series rebased to index 100. Dividing one measure to
  make it visually fit the other's axis is a dual axis wearing a disguise.
- **Every chart shape has a table twin** behind a `show table` button.
- **Direct labels are selective** — the top two or three, or the extreme value. Never a
  number on every point.
- **A nominal category gets one colour.** Don't spend the identity channel repeating what
  position or length already communicates.
- **Never fabricate a number in a label.** If a value wasn't measured — a resolver that
  didn't answer, say — the label says what happened (`no answer`), not a placeholder
  number that looks measured.
- Colours come from `web/tokens.css`: `--s1`..`--s8` are a validated categorical series in
  a **fixed order** that must not be reordered (reordering breaks the colour-vision
  validation the sequence was built against); `--q1`..`--q6` a sequential ramp;
  `--n1`..`--n3` neutrals. Shapes where any mark can touch any other (scatter, treemap)
  use at most 3 series, because the all-pairs distinguishability check is stricter than
  the adjacent-pair one the full set passes.

## 7. `node bin/check.js` must pass

Read it before you touch anything it checks. It exists because adding accents to this
project's copy once silently corrupted six names that are contracts — a require path, a
tab id, an API key, a query parameter — and `node --check` passed on every one of them.
The worst produced `networksetup -setdnsservers null`, which doesn't show a wrong number:
it takes the internet down.

It enforces, among other things: every `require` resolves; `charts.js` and `app.js` load
in one shared global scope without colliding; every `$('#id')` used in the front end
exists in `index.html`; no accented identifier sits in a contract position; every CSS
class and variable used is defined in `web/tokens.css` or `web/style.css`; the DNS
command pair never emits `null`; the hosts blocklist domain sieve behaves; the server is
loopback-only; and no hardcoded home directory appears anywhere in `lib/`, `server.js`, or
`web/app.js`. Run it before opening a pull request, not after someone else finds the
failure in review.

## 8. Platform code lives behind the seam

Everything reckon learns about the machine goes through `lib/platform/` — see
`lib/platform/CONTRACT.md` for the exact contract. A collector that shells out to a
platform-specific binary directly, instead of calling through the seam, is a bug: the
next platform port has to go find it, and what breaks silently is a guard, not a feature.
If you're adding a new platform, implement the full capability list in
`lib/platform/<process.platform>.js`; if you're adding a collector, call the seam, never
`sh.js`, for anything platform-specific.

The two halves of the seam's own rule apply to any code added there too: a
**measurement** never throws — it returns `null` (or `[]` for a list) when the tool is
missing or the command fails, because `null` means "could not find out," which is not
zero. A **command builder** never returns `null` — it validates and throws `TypeError`,
because a half-built shell command doesn't show a wrong number, it can take the network
down or corrupt a file it was never supposed to touch.

## Before you open a pull request

1. Read the README's constraints section — this file draws from it and doesn't replace
   it.
2. Run `node bin/check.js`. It has to pass.
3. Run `node --check` on every file you touched. It catches syntax errors, not the
   contract corruption in rule 7 — that's what `bin/check.js` is for.
4. If your change touches anything outside `~/.cache/reckon/`, outside the loopback
   server, or outside the categorical palette, expect to be asked which of the eight
   numbered rules above you checked against, because the review will ask exactly that.
