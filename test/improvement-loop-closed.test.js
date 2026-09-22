// node test/improvement-loop-closed.test.js — the loop must not propose moving a position
// that is already closed.
//
// The pool scout's window is historical. A position closed days ago still has rows in it,
// and its final observation can still show a sibling pool earning many times more. Nothing
// checked whether the position still existed, so on 2026-09-22 the loop's single HIGH
// action was "Move ETH / USDG #2302341 → USDG / WETH 1% — earning 50.5x more", for a
// position that had been closed for days. Two of its four move proposals were for
// positions the wallets no longer held. An unactionable item ranked first is worse than
// no item: it teaches the reader that the report is not worth reading.
"use strict";
const assert = require("assert");
const { analyseScout, openTokenIds } = require("../tasks/improvement-loop.js");

// A scout row good enough to clear every other filter: beating, long streak, deep sibling.
const row = (tokenId, pair, t) => ({
  tokenId, pair, wallet: "Main", t,
  beats: true, streakDays: 5, bestTvl: 131_000,
  bestSibling: "USDG / WETH 1%", bestAprPct: 283, ownAprPct: 6,
});
const rowsFor = (id, pair) => [1, 2, 3].map((n) => row(id, pair, `2026-09-2${n}T00:00:00Z`));

const SCOUT = [...rowsFor("2302341", "ETH / USDG"), ...rowsFor("3010813", "ETH / CASHCAT")];

// ---- openTokenIds -------------------------------------------------------------
{
  const ids = openTokenIds({ positions: [
    { tokenId: "3010813", status: "open" },
    { tokenId: "2302341", status: "closed" },
  ] });
  assert.ok(ids.has("3010813"), "an open position is in the set");
  assert.ok(!ids.has("2302341"), "a closed one is not");

  // Numeric ids from one source and string ids from the other must still match.
  assert.ok(openTokenIds({ positions: [{ tokenId: 3010813, status: "open" }] }).has("3010813"),
    "ids are compared as strings");

  // Unknown must not read as "everything is closed".
  assert.strictEqual(openTokenIds(null), null, "no data means unknown");
  assert.strictEqual(openTokenIds({ positions: [] }), null, "no rows means unknown");
  assert.strictEqual(openTokenIds({ positions: [{ tokenId: "1" }] }), null,
    "rows carrying no status at all mean unknown, not none-open");
}

// ---- analyseScout --------------------------------------------------------------
{
  // Without the open set, both positions are proposed — the old behaviour.
  const before = analyseScout(SCOUT);
  assert.strictEqual(before.moveOpps.length, 2, "unfiltered, both are proposed");

  const open = openTokenIds({ positions: [
    { tokenId: "3010813", status: "open" },
    { tokenId: "2302341", status: "closed" },
  ] });
  const after = analyseScout(SCOUT, open);
  assert.strictEqual(after.moveOpps.length, 1, "the closed position is dropped");
  assert.strictEqual(after.moveOpps[0].tokenId, "3010813", "and the open one is kept");
  assert.ok(!after.suggestions.some((x) => /ETH \/ USDG/.test(x)),
    "no suggestion names the closed position");
  assert.ok(!after.issues.some((x) => /2302341/.test(x.msg)),
    "and neither does any issue");

  // Unknown status leaves the list alone rather than emptying it.
  assert.strictEqual(analyseScout(SCOUT, null).moveOpps.length, 2,
    "an unknown open-set is not treated as nothing-open");
}

console.log("improvement loop: move proposals are filtered to positions that are still open, and an unknown position list leaves them in rather than emptying the report");
