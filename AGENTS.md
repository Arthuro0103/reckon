# AGENTS.md

reckon is a local dashboard that tells you what to do about disk and memory.
It never deletes anything, and neither may you.

## Hard rules

- Never run a command that reckon suggests (`rm`, `docker`, `sudo`, `networksetup`, `kill`,
  edits to `/etc/hosts`). Show it to the human. The human runs it.
- Every recommendation carries its `proof` and what the user would `lose` if it were wrong.
  "Cannot judge" is an answer, not an invitation to guess.
- reckon writes only inside `~/.cache/reckon/`, plus `./reckon-report.txt` from `reckon report`.
  Do not write anywhere else on the user's machine.
- `reckon watch` in continuous mode fires macOS notifications, `--corner` opens a browser window,
  and `--pet` compiles a Swift file and shows a window above every window. Ask first for each.
  Prefer `--once`.
- Never start the speed test (`POST /api/network/speed`) or touch the blocklist routes.
- Zero dependencies. Everything in English. Do not edit `web/pet.js` or `native/pet.swift`: the two draw the same lantern and `bin/check.js` holds them together.
- No push and no `npm publish` unless the owner says so.

## Commands

| What | Command |
|---|---|
| Test | `node bin/check.js` (exit 0 means pass) |
| Panel | `node bin/reckon`, then open http://127.0.0.1:4127 |
| Deep scan | `node bin/reckon scan` (result in `~/.cache/reckon/scan.json`) |
| One reading | `node bin/reckon watch --once` |
| Diagnostic report | `node bin/reckon report` |

## Procedures

Step-by-step guides are plain Markdown in `.claude/skills/*/SKILL.md`: `reckon-check`,
`reckon-scan`, `reckon-panel`, `reckon-watch`, `reckon-slow`, `reckon-report`. Any agent can
read them, not only Claude Code. Before a pull request, read `CONTRIBUTING.md`.
