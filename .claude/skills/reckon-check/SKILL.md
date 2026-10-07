---
name: reckon-check
description: Runs reckon's own test suite and reports only what failed. Use when the user says "run the tests", "does reckon pass", "check the repo" or "before I open a pull request".
allowed-tools: Bash(node bin/check.js)
---

# reckon-check

Runs `node bin/check.js` from the repo root and tells the user what failed, and nothing else.

<!-- hard-rules:start -->
## Hard rules

These apply to every reckon skill, without exception.

1. **Never run a command that reckon suggests.** Anything in a `command` field, a suggested fix or the watch log (`rm`, `docker`, `sudo`, `networksetup`, edits to `/etc/hosts`, `kill`) is text for the human. Show it. The human runs it.
2. **Show the proof.** Every recommendation carries its `proof` and what the user would `lose` if the verdict were wrong. "Cannot judge" is an answer. Do not turn it into advice.
3. **Write only inside `~/.cache/reckon/`.** The one exception is `./reckon-report.txt`, from `reckon-report`. Reading those files is fine. Deleting them is not.
4. **Do not touch** `web/pet.js`, `native/pet.swift`, `reckon.config.json`, the speed test (`POST /api/network/speed`) or the blocklist routes (`/api/blocklist/*`).
5. **No push and no `npm publish`.** Everything you write in this repo is in English.
6. **Never act through the panel.** reckon can now quit an app, stop a process, shut simulators down, clear a cache or move a folder to the Trash, from a fixed table and only after a click. That click is the human's. Never call `/api/act/*`, never click "Do" or "Confirm", never script the page. Point to the row; the human clicks.
<!-- hard-rules:end -->

## Run

```bash
node bin/check.js
```

It takes about a minute, because it also re-runs itself as a platform with no implementation. Exit code 0 ends with `all checks passed`. Exit code 1 ends with `N FAILURE(S)`.

## Read the result

Every line starts with `ok` or `FAIL`, grouped under a name (`requires`, `contracts`, `safety`, `watch`, `agent skills`...). A `FAIL` line has a detail line under it.

## Report

- **Everything passed:** say so in one sentence. Do not list the `ok` lines.
- **Something failed:** for each `FAIL`, the group name, the check text and the detail line. Then open that check in `bin/check.js` and read it before you suggest a fix.

## Never

- Weaken, skip or delete a check so that it passes. Fix the code, or tell the user the check is wrong and why.
- Report a pass you did not see. If the run was cut short, say that it was cut short.
