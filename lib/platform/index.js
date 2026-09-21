'use strict';

// ---------------------------------------------------------------------------
// The platform seam.
//
// Every command this tool runs against the machine goes through one of the
// capabilities below. A collector must not shell out on its own: the moment it
// does, the next port has to find it, and what gets lost is never the easy
// part — it is a guard, silently, on a screen that still looks correct.
//
// Picking an implementation:
//   - a platform we have and can load   -> its module, plus the identity fields
//   - a platform we have a slot for but
//     no file for yet                   -> every capability throws, with the
//                                          message below, and `supported` is
//                                          false so a caller can say so first
//
// Requiring this module NEVER throws. The panel boots, the page loads, and the
// first collector call surfaces one readable sentence — in the UI, where
// somebody is looking — instead of a stack trace in a terminal nobody opened.
// ---------------------------------------------------------------------------

// The contract. A name missing from an implementation is a hole in a screen,
// so it is checked at load instead of at the moment a collector reaches for it.
const CAPABILITIES = Object.freeze([
  'memoryStats', 'swapStats', 'processList', 'selfProcess',
  'pathExists', 'isDirectory', 'listDirectory',
  'volumeUsage', 'dirSizeKB', 'realSizeKB', 'fileCount', 'hardlinkRatio',
  'findSymlinksUnder', 'homeTopLevelSizes', 'cloudPlaceholders',
  'knownCacheTargets', 'dockerDiskImagePath', 'likelyCodeDirs', 'vaultSearchRoots',
  'backupStatus', 'failedServices',
  'dnsServices', 'dnsForService', 'effectiveResolver', 'probeResolver',
  'setDnsCommand', 'dnsFlushCommand',
  'hostsFilePath', 'hostsBackupPath', 'hostsCommands',
]);

// OPTIONAL capabilities. A platform is allowed not to have these, and saying so
// is not the same as being unsupported: a Windows build with all 30 required
// capabilities and no speed test should light up the tabs it can answer and tell
// the truth about the one it cannot, rather than declare the platform unfit.
//
// The difference in behaviour is the point. A missing REQUIRED capability throws,
// because a collector reaching for it has no honest fallback. A missing OPTIONAL
// one returns null — which already means "could not find out" everywhere else in
// this codebase, and every caller already handles it.
const OPTIONAL = Object.freeze([
  'defaultRoute', 'linkInterfaces', 'pingHost', 'radioLink', 'speedTest',
  // Measure many paths in ONE call. A platform where starting the measuring
  // tool is expensive — Windows pays about a second per PowerShell — spends
  // more time launching processes than walking folders, and the cost grows
  // with every target added. A platform without it loses nothing: the caller
  // falls back to measuring one at a time, which is what it did before.
  'dirSizesKB',
  // Who is listening, and on what. The Pressure tab needs it for exactly one
  // sentence — "what you lose is localhost:3010" — and that sentence is most of
  // what makes the row safe to act on. A platform without it still gets the
  // row, naming the process instead of the port.
  'listeningPorts',
]);

// DATA a platform declares, as opposed to a capability it implements. These are
// frozen objects, not functions, so they are listed separately: a platform that
// exports one is not exporting "a name the contract does not list", and a
// platform that omits one gets null rather than a throw.
//
// COMMAND_SHELL exists because a correct command pasted into the wrong shell
// fails with an error that does not hint at the answer. The screen has to be
// able to say which shell, and only the platform knows.
const DECLARATIONS = Object.freeze(['COMMAND_SHELL']);

const CONTRACT_DOC = 'lib/platform/CONTRACT.md';
const REFERENCE = 'lib/platform/darwin.js';

// Slots, not a lookup of files on disk: an unknown platform should be told it
// is unknown, and a known one that is simply not written yet should be told
// exactly which file to write.
const SLOTS = {
  darwin: { label: 'macOS', file: 'darwin.js', load: () => require('./darwin') },
  win32: { label: 'Windows', file: 'win32.js', load: () => optional('./win32') },
  linux: { label: 'Linux', file: 'linux.js', load: () => optional('./linux') },
};

// An implementation that is not written yet is `null`. An implementation that
// IS written and blows up on load is a real error and must not be disguised as
// "this platform is not supported" — that sends somebody off to write a file
// that already exists. `require.resolve` separates the two cleanly: it fails
// only for the module itself, never for something the module requires.
function optional(id) {
  try { require.resolve(id); } catch { return null; }
  return require(id);
}

// A one-screen message with no stack. Node prints `.stack` for an uncaught
// error, so replacing it is what turns a wall of frames into a sentence
// somebody can act on.
function readable(message) {
  const err = new Error(message);
  err.name = 'UnsupportedPlatform';
  err.code = 'RECKON_PLATFORM_UNSUPPORTED';
  err.stack = message;
  return err;
}

function unsupportedMessage(id, slot) {
  const known = Boolean(slot);
  const file = known ? slot.file : `${id}.js`;
  const label = known ? slot.label : id;
  return [
    `reckon does not run on ${label} yet.`,
    '',
    `  platform   ${id}`,
    `  missing    lib/platform/${file}`,
    `  contract   ${CONTRACT_DOC}   (${CAPABILITIES.length} capabilities, exact return shapes and units)`,
    `  reference  ${REFERENCE}     (the macOS implementation, one function per capability)`,
    '',
    known
      ? `Write lib/platform/${file} against the contract and reckon runs.`
      : `Write lib/platform/${file} against the contract, then add a '${id}' slot to\nlib/platform/index.js.`,
    'Nothing else reads the machine directly — every collector goes through this seam.',
  ].join('\n');
}

function incompleteMessage(id, slot, missing) {
  return [
    `lib/platform/${slot.file} does not implement the whole contract.`,
    '',
    `  missing    ${missing.join(', ')}`,
    `  contract   ${CONTRACT_DOC}`,
    `  reference  ${REFERENCE}`,
    '',
    'A capability that is absent takes a panel down at the moment somebody',
    'opens the tab that needs it. Export every name, even as a stub that',
    'returns null — null is a documented answer here and reads as "could not',
    'find out"; undefined is a crash.',
  ].join('\n');
}

// The named capabilities replaced by the same readable failure, so the message
// arrives wherever the first call happens to be.
function stubs(names, message) {
  const out = {};
  for (const name of names) out[name] = () => { throw readable(message); };
  return out;
}

const id = process.platform;
const slot = SLOTS[id] || null;
const impl = slot ? slot.load() : null;

let api;
if (!impl) {
  const message = unsupportedMessage(id, slot);
  api = { supported: false, unsupportedReason: message, notImplemented: [...OPTIONAL],
    ...stubs(CAPABILITIES, message),
    ...Object.fromEntries(OPTIONAL.map((n) => [n, async () => null])),
    ...Object.fromEntries(DECLARATIONS.map((n) => [n, null])) };
} else {
  // An absent optional capability becomes a function returning null, so a
  // collector can name WHICH reading did not happen instead of crashing.
  const absentOptional = OPTIONAL.filter((name) => typeof impl[name] !== 'function');
  const optionalStubs = Object.fromEntries(absentOptional.map((n) => [n, async () => null]));
  const declared = Object.fromEntries(DECLARATIONS.map((n) => [n, impl[n] || null]));

  const missing = CAPABILITIES.filter((name) => typeof impl[name] !== 'function');
  if (missing.length) {
    // Only the holes throw. A port that is 28 capabilities in should light up
    // the tabs it can already answer, and fail on exactly the one it cannot.
    const message = incompleteMessage(id, slot, missing);
    api = { ...declared, supported: false, unsupportedReason: message, notImplemented: absentOptional,
      ...impl, ...optionalStubs, ...stubs(missing, message) };
  } else {
    api = { ...declared, supported: true, unsupportedReason: null, notImplemented: absentOptional,
      ...impl, ...optionalStubs };
  }
}

module.exports = {
  id,
  label: slot ? slot.label : id,
  capabilities: CAPABILITIES,
  optionalCapabilities: OPTIONAL,
  ...api,
};
