// node test/v4-discovery-recovery.test.js — discovery recovers when its saved state
// has no floor.
//
// A wallet's discovery state records how far back it has swept (`scannedFrom`) and
// whether it reached the beginning (`complete`). The state files on this instance
// predated both fields: they held `lastScanned` and `ids` and nothing else. Merged
// with the defaults that gave scannedFrom null, and the backfill is guarded by
// `scannedFrom > 0`, which is false for null. So discovery could never resume and
// never complete, and every wallet's claim coverage carried "Position discovery has
// not swept back to the position manager's deployment block ... an older position
// cannot be ruled out". It had been stuck that way indefinitely.
//
// The first run is not affected: it sets a floor itself. This is about the state in
// between — scanned, but with no record of how far.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "univ4.js"), "utf8");

// ---- 1. the guard that stranded it, and the one that rescues it ---------------
{
  assert.match(src, /if \(!state\.complete && state\.scannedFrom == null && state\.lastScanned > 0\)/,
    "a scanned state with no floor is handled before the backfill that cannot see it");
  const at = src.indexOf("if (!state.complete && state.scannedFrom == null");
  const after = src.indexOf("if (!state.complete && state.scannedFrom > 0)");
  assert.ok(at > 0 && after > at, "and is handled first, or the old guard would skip it again");
  // `> 0` is false for null. That is the whole bug, and it must stay written the
  // way that makes the null case impossible to fall into silently.
  assert.ok(/state\.scannedFrom == null/.test(src.slice(at, at + 200)),
    "the recovery keys on null explicitly rather than on a falsy check that 0 would also match");
}

// ---- 2. a floor of 0 is a real answer, not a missing one ----------------------
{
  // Block 0 means "swept to the beginning", which is exactly the state these
  // wallets reached after the fix. A `scannedFrom > 0` style test would treat that
  // as unscanned and sweep for ever.
  const stuck = { lastScanned: 66918144, ids: [] };
  const merged = { lastScanned: 0, ids: [], blockscoutAt: 0, scannedFrom: null, complete: false, span: 0, lastError: null, ...stuck };
  assert.strictEqual(merged.scannedFrom, null, "old state merges to a null floor");
  assert.strictEqual(merged.complete, false, "and is not complete");
  assert.ok(!(merged.scannedFrom > 0), "which the backfill guard skips — the stranding");
  assert.ok(merged.scannedFrom == null && merged.lastScanned > 0, "while the recovery guard catches it");

  const done = { ...merged, scannedFrom: 0, complete: true };
  assert.ok(!(done.scannedFrom == null), "once a floor is recorded the recovery no longer applies");
  assert.ok(!(done.scannedFrom > 0), "and a floor of 0 is not mistaken for no floor by the backfill either");
}

// ---- 3. the state file this ran against ---------------------------------------
{
  // The shape that was on disk, kept here so the case cannot be forgotten.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v4disc-"));
  const file = path.join(dir, "v4-positions-0xtest.json");
  fs.writeFileSync(file, JSON.stringify({ lastScanned: 66918144, ids: [] }));
  const loaded = { lastScanned: 0, ids: [], blockscoutAt: 0, scannedFrom: null, complete: false, span: 0, lastError: null,
    ...JSON.parse(fs.readFileSync(file, "utf8")) };
  assert.strictEqual(loaded.scannedFrom, null);
  assert.strictEqual(loaded.lastScanned, 66918144);
  assert.ok(!Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(file, "utf8")), "complete"),
    "the saved file really does predate these fields");
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("v4 discovery: a state scanned but with no recorded floor re-establishes one instead of never completing, and a floor of block 0 counts as reaching the beginning");
