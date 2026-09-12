# Installing reckon

reckon is a program that runs on your own Mac or Windows machine and shows you a page in
your browser. It never sends your data anywhere. Pick the tier that matches how comfortable
you are with a terminal — all three end up at the same page, `http://127.0.0.1:4127`.

If a step below doesn't match what you see, the tool changed after this page was written —
check the [README](../README.md) or open an issue rather than guessing.

## Tier 1 — npx (you already have Node)

If you can open a terminal and run `node -v` and see `v18` or higher, this is the fastest
way in:

```bash
npx @arthuro0103/reckon
```

This downloads reckon, runs it, and opens `http://127.0.0.1:4127` in your browser. Nothing
is installed permanently — the next time you run it, `npx` fetches the current version
again. There is no account, no sign-in, and no configuration required to start.

To stop it, go back to the terminal and press `Ctrl+C`.

## Tier 2 — single binary (you don't have Node, and don't want it)

Download the file for your operating system from the
[releases page](https://github.com/Arthuro0103/reckon/releases) and run it. It contains a
full copy of Node, so nothing else needs to be installed first.

**On macOS**, the file has not been notarized by Apple — that costs money reckon's author
doesn't spend on a free tool, and paying it wouldn't change anything the tool does. The
first time you open it, macOS Gatekeeper will refuse, usually with a dialog that says the
file "cannot be opened because it is from an unidentified developer" or "is damaged and
can't be opened."

That warning means exactly one thing: nobody paid Apple to vouch for this specific file.
It does not mean the file is unsafe, and it does not mean it's safe either — it means
Apple hasn't checked. The safe path is to decide for yourself, the same way you'd decide
whether to run code from GitHub in the first place: the source is public, read it, or
build the binary yourself from source (see Tier 3) so nothing unverified ever runs.

If you've made that decision and still want to run the downloaded binary specifically,
the way to tell macOS you're overriding Gatekeeper for this one file, not disabling it
system-wide, is: macOS 15 and later removed the Control-click → Open shortcut for unsigned
software. The current path is: try to open the file, let it be blocked, then go
to **System Settings → Privacy & Security**, scroll to the bottom, and click
**Open Anyway** next to the message naming the file. You will be asked to
confirm once more.

This is a real security prompt and it is telling you the truth: nobody has paid
Apple to vouch for this binary. If that is not a trade you want to make, use the
clone-and-run tier instead — it runs the same code from source you can read.
turning the protection off — do not use System Settings to disable Gatekeeper entirely
just to run one program.

**On Windows**, expect Microsoft Defender SmartScreen to show "Windows protected your PC"
because the binary isn't signed with a certificate SmartScreen recognizes yet — the same
situation as most small open-source tools, not a sign anything is wrong with this build
specifically. Reading the source before you decide is always the safer option than
clicking through a warning. If you still want to proceed after that: click **More info**,
then **Run anyway**. Do not turn SmartScreen off in Windows Security to get past this —
that removes the check for every program on the machine, not just this one.

## Tier 3 — clone and run with Node (see exactly what runs)

This is the only tier where you're running the source directly, with nothing built or
packaged in between.

```bash
git clone https://github.com/Arthuro0103/reckon.git
cd reckon
node server.js
```

Requires Node 18 or newer (`node -v` to check) — [nodejs.org](https://nodejs.org) if you
need it. There is no `npm install` step: the project has zero dependencies, so cloning it
is the whole install.

This works identically on macOS and Windows; the only difference is what the tool can see
on Windows today may be narrower than on macOS while that support is still new — the
[README](../README.md) states current platform coverage.

## After install, on either OS

The first time you open the page, it asks for a scan. That reads your disk, checks Docker
if it's running, and looks at your repositories — a couple of minutes, after which the
result is cached in `~/.cache/reckon/` (or the Windows equivalent) and nothing is measured
again until you ask for another scan.

Configuration is optional. reckon guesses where you keep code and notes; to override the
guess, copy `reckon.config.example.json` to `reckon.config.json` in the project folder.

## What installing this does *not* do

No tier creates an account, phones home, or asks for a network permission beyond the
loopback address the page itself opens. Uninstalling is deleting the binary, the cloned
npx keeps its downloads in a cache folder. To clear it, delete the folder
directly — `~/.npm/_npx` on macOS and Linux, `%LOCALAPPDATA%
pm-cache\_npx` on
Windows. An earlier draft of this page told you to run a third-party package to
do it, two paragraphs after promising nothing here runs unaudited code. Deleting
a folder yourself needs no such trust.
`rm -rf ~/.cache/reckon` (macOS) or the equivalent folder on Windows.
