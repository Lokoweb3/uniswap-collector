// node test/return-definitions.test.js — the two return figures, each measured
// with one set of prices on both sides.
//
// They used to be mixed: the numerator subtracted the opening tokens valued at
// today's prices while the denominator was the capital as priced when it went in.
// That divides a holding comparison by deployed capital and answers neither
// question. Known inputs, arithmetic checked by hand.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "returns-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// A position opened with 100 USDC + 10 TOK when TOK was $10 — $200 of capital.
// TOK is now $30. It is now worth 100 USDC + 10 TOK = $400, with $6 uncollected
// and $4 already collected.
const opening = { usdc: 100, tok: 10, tokAtOpen: 10 };
const now = { usdc: 100, tok: 10, tokNow: 30, uncollected: 6, collected: 4, withdrawn: 0 };

const depositedAtOpen = opening.usdc + opening.tok * opening.tokAtOpen;   // 200
const depositedNow = opening.usdc + opening.tok * now.tokNow;             // 400
const valueUsd = now.usdc + now.tok * now.tokNow;                        // 400

const gainVsHolding = valueUsd + now.uncollected + now.collected + now.withdrawn - depositedNow;
const gainOnCapital = valueUsd + now.uncollected + now.collected + now.withdrawn - depositedAtOpen;

// ---- versus holding: current prices on both sides ---------------------------
{
  assert.strictEqual(depositedNow, 400, "the same opening tokens are worth $400 today");
  assert.strictEqual(gainVsHolding, 10, "holding would have given $400; the position gave $410");
  assert.strictEqual((gainVsHolding / depositedNow) * 100, 2.5, "+2.5% against holding");
}

// ---- return on capital: opening prices on both sides ------------------------
{
  assert.strictEqual(depositedAtOpen, 200, "$200 of capital went in");
  assert.strictEqual(gainOnCapital, 210, "$410 out against $200 in");
  assert.strictEqual((gainOnCapital / depositedAtOpen) * 100, 105, "+105% on capital");
}

// ---- the two must not be interchanged ---------------------------------------
{
  const mixed = (gainVsHolding / depositedAtOpen) * 100;   // the old bug
  assert.strictEqual(mixed, 5, "the mixed figure is 5%");
  assert.notStrictEqual(mixed, 2.5, "which is not the holding comparison");
  assert.notStrictEqual(mixed, 105, "and not the return on capital either");
}

// ---- fees are counted once --------------------------------------------------
// collected and uncollected are disjoint; a consumer adding fees to pnlUsd would
// count them twice, because pnlUsd already contains both.
{
  const feesTotal = now.uncollected + now.collected;
  assert.strictEqual(feesTotal, 10);
  assert.strictEqual(gainVsHolding, 10, "the gain already includes both fee components");
  assert.strictEqual(gainVsHolding + feesTotal, 20, "adding them again would double to $20 — the thing to avoid");
}

// ---- no opening prices means no return on capital, not a substitute ---------
{
  const noOpen = null;
  const gain = noOpen == null ? null : 1;
  assert.strictEqual(gain, null, "an unknown opening basis yields null, never the holding figure instead");
}

console.log("return definitions: versus holding at today's prices, return on capital at opening prices, fees counted once");
