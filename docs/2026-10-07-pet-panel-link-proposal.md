# Proposal: a "fix it in the panel" link on the native pet

**Status:** proposal for the owner. Agents may not edit `native/pet.swift` (AGENTS.md), so nothing
here is applied.
**Date:** 2026-10-07

## What and why

The browser corner (`web/corner.html`) now has a "fix it in the panel" link to
`http://127.0.0.1:4127/#pressure`. The native pet shows the same card (title, cost, command) but
offers only "copy the command". The same link would let a person go from the pet to the panel's
Pressure tab, where a fix can be previewed, confirmed and counted down. The pet itself still never
runs anything.

## The change

In the card that already holds the copy button, add a second button next to it that opens that URL
in the default browser, and show it only while the card has a headline (the same condition that
shows the command).

```swift
// Opens the panel's Pressure tab. The pet runs nothing; the panel asks for a click and a countdown.
@objc func openPanel() {
    if let url = URL(string: "http://127.0.0.1:4127/#pressure") { NSWorkspace.shared.open(url) }
}
```

## What `bin/check.js` has to learn

`bin/check.js` lints `native/pet.swift` for four things it must never do: spawn a process, open a
URL, reach the network, delete a file. This change opens a URL, so the lint needs one narrow
exception, in this order of preference:

1. Allow `NSWorkspace.shared.open` only with a literal string that starts with
   `http://127.0.0.1:` (loopback, nothing else).
2. Or keep the lint as it is and leave the pet without the link.

The first keeps the promise that the pet reaches nothing outside this machine. Both are the owner's
call, since the lint and `pet.swift` are both his.

## Not proposed

- A link with `?act=<id>` that opens a preview directly. The panel's tab already lists the fix; a
  deep link into a preview would let a notification-sized window start the preview flow.
- Any button that runs the command.
