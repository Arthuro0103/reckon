---
name: reckon-slow
description: Finds out why the machine feels slow, using reckon's pressure reading. Use when the user says "my computer is slow", "why is it so slow", "what is eating my machine" or "is it swap".
allowed-tools: Bash(node bin/reckon watch --once), Bash(curl -s http://127.0.0.1:4127/api/pressure)
---

# reckon-slow

Answers "why is this machine slow" from a measurement. It does not guess and it does not fix anything.

<!-- hard-rules:start -->
## Hard rules

These apply to every reckon skill, without exception.

1. **Never run a command that reckon suggests.** Anything in a `command` field, a suggested fix or the watch log (`rm`, `docker`, `sudo`, `networksetup`, edits to `/etc/hosts`, `kill`) is text for the human. Show it. The human runs it.
2. **Show the proof.** Every recommendation carries its `proof` and what the user would `lose` if the verdict were wrong. "Cannot judge" is an answer. Do not turn it into advice.
3. **Write only inside `~/.cache/reckon/`.** The one exception is `./reckon-report.txt`, from `reckon-report`. Reading those files is fine. Deleting them is not.
4. **Do not touch** `web/pet.js`, `native/pet.swift`, `reckon.config.json`, the speed test (`POST /api/network/speed`) or the blocklist routes (`/api/blocklist/*`).
5. **No push and no `npm publish`.** Everything you write in this repo is in English.
6. **Never act through the panel.** reckon can now quit an app, stop a process or shut simulators down, from a fixed table and only after a click. That click is the human's. Never call `/api/act/*`, never click "Do" or "Confirm", never script the page. Point to the row; the human clicks.
<!-- hard-rules:end -->

## Run

If the panel is already running, read the pressure endpoint:

```bash
curl -s http://127.0.0.1:4127/api/pressure
```

Otherwise take one reading without starting anything that stays on:

```bash
node bin/reckon watch --once
```

## Read the result

`watch --once` prints a few plain lines: the level and its state (for example `level 0.207 (watching)`), the swap in use, the load ("never an alert on its own"), the probe ("154 ms against a best of 149 ms = 1x") and either the rows that crossed a line or `nothing crossed a line`. It does not write `watch.json`. The endpoint returns the same facts as JSON:

- `probe.factor`: how many times slower a fixed piece of arithmetic ran just now than the fastest this machine has ever done it. Close to 1 means the machine is at its best.
- `rows[]`: what is stealing time, each with `confidence`, `costPct`, `kb` and a suggested `command`.

## Report

1. The factor, in plain words ("2.3 times slower than this machine at its best").
2. Only the rows whose `confidence` is `high`, with their `proof`. Mention swap as part of memory pressure, not as a separate cause.
3. If the factor is near 1 or no row is `high`, say the machine is not struggling. Do not invent a cause.
4. Show each `command` as text for the user. Never run it.

## Never

- Stop a process or prune anything because a row names it.
- Blame load. Load counts runnable work, and a busy machine and a suffering one look the same.
