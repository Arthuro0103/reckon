---
name: reckon-scan
description: Runs reckon's deep scan and summarises what can be freed, with the proof for each item. Use when the user says "scan my disk", "what can I delete", "where did my space go" or "what is taking space".
allowed-tools: Bash(node bin/reckon scan), Read(~/.cache/reckon/scan.json)
---

# reckon-scan

Runs the deep scan and explains the result item by item. It never deletes anything, and neither do you.

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
node bin/reckon scan
```

It takes about two minutes. Progress goes to stderr. At the end stdout prints one small JSON object with `totalGB`, `out` (how many items can go) and `stay` (how many are left alone). The full result is written to `~/.cache/reckon/scan.json`.

## Read the result

Read `~/.cache/reckon/scan.json`.

- `panel.out[]`: items the scan can prove are rebuildable. Each has `title`, `gb`, `proof`, `lose`, `command`, `confidence` and sometimes `warning`.
- `panel.stay[]`: items that stay, each with a `why`.
- `targets[].verdict`: `disposable` or `unknown`. The screen shows `unknown` as "cannot judge".

## Report

1. Start with the number: the total in `totalGB`, and how many items are behind it.
2. For each item in `panel.out[]`, largest first: title, size, then its `proof` and its `lose` in the words the file uses. Repeat any `warning`.
3. Show each `command` as plain text, labelled "for you to run, if you agree". Never run it.
4. Then the items in `panel.stay[]` with their `why`. Say that "cannot judge" means the scan will not guess.

## Never

- Treat `unknown` as `disposable`.
- Skip an item's `warning` or its `lose` to make the answer shorter.
- Run a scan again just because the result looks small. Ask first: it reads the whole disk.
