---
name: reckon-report
description: Writes reckon's diagnostic report to a text file that the user can read before they share it. Use when the user says "make a report", "I want to file an issue", "what should I send you" or "diagnose reckon".
allowed-tools: Bash(node bin/reckon report), Read(./reckon-report.txt)
---

# reckon-report

Produces one text file that describes this machine, so a problem can be reported. The file is the user's to read first.

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
node bin/reckon report
```

It stops after 180 seconds if something hangs. The file is written to `./reckon-report.txt` in the **current directory**, which is outside `~/.cache/reckon/`. In this repo it is already in `.gitignore`.

## Read the result

Open `./reckon-report.txt` and summarise it for the user: the platform, what reckon could and could not read, and what looks wrong.

## Report

Tell the user where the file is and what kind of detail it holds (it describes the machine). Let them read it. Whether and where to share it is their decision.

## Never

- Commit the file, attach it to an issue or paste it into a public place.
- Run the report from a directory that is not gitignored.
- Edit the file to remove lines: a report that has been edited is not a report.
