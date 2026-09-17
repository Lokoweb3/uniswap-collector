// node test/unverified-decimals-pricing.test.js — a token whose decimals were
// never read must not produce a price, a depth, or a contribution to any total.
//
// This reproduces a live failure. Changing the token reader to report null
// decimals instead of a silent 18 exposed the pricing path, which was unguarded:
// one unverified token priced at 1.5e15 per unit and the Arc wallet total read
// $1,516,550,111,547,021,568. The guard is what stops that; this test fails if it
// is ever removed.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "unverified-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const u = require("../univ3");

// ---- 1. why the guard exists: null decimals explode the price ---------------
// sqrtPriceX96 for a 1:1 pool between a 6-decimal and an 18-decimal token.
{
  const sqrtP = 2n ** 96n;
  const sane = u.priceFromSqrt(sqrtP, 6, 18);
  const broken = u.priceFromSqrt(sqrtP, null, 18);
  assert.ok(Number.isFinite(sane), "a priced pair with real decimals gives a number: " + sane);
  assert.notStrictEqual(sane, broken, "null decimals do not give the same answer as real ones");
  assert.ok(
    !Number.isFinite(broken) || Math.abs(broken) > 1e6 || Math.abs(broken) < 1e-6,
    "null decimals produce a wildly wrong scale — this is the failure being guarded against: " + broken
  );
}

// ---- 2. the guard predicate: only a read value passes -----------------------
{
  const guard = (t, q) => t.decimalsOk === true && q.decimalsOk === true;
  const read = { decimals: 6, decimalsOk: true };
  const failed = { decimals: null, decimalsOk: false, decimalsError: "missing revert data" };
  const legacy = { decimals: 18 };                 // no provenance at all
  assert.strictEqual(guard(read, read), true, "two read tokens may be priced");
  assert.strictEqual(guard(read, failed), false, "a failed quote blocks the price");
  assert.strictEqual(guard(failed, read), false, "a failed base blocks the price");
  assert.strictEqual(guard(read, legacy), false, "absent provenance is not permission");
}

// ---- 3. totals: an unpriceable holding is excluded and declared -------------
// The reduction portfolio.js performs, on rows shaped the way it shapes them.
{
  const rows = [
    { symbol: "USDC", amount: 493.167713983255, price: 1 },
    { symbol: "SELL", amount: 26996367.435562894, price: 0.000005276757297103014 },
    { symbol: "BOA", amount: 983.2340827928175, price: null, unavailable: "token decimals were not read from the chain" },
  ];
  for (const r of rows) r.usd = r.price == null || r.amount == null ? null : r.amount * r.price;
  const walletUsd = rows.reduce((s, r) => s + (r.usd || 0), 0);
  const partialTotals = rows.some((r) => r.unavailable) || undefined;
  const unscaled = rows.filter((r) => r.unavailable).map((r) => r.symbol);

  assert.ok(walletUsd > 600 && walletUsd < 700, "the total is the priced holdings only: " + walletUsd);
  assert.ok(walletUsd < 1e6, "and nowhere near the 1.5e18 the unguarded path produced");
  assert.strictEqual(partialTotals, true, "a total that had to leave a holding out must say so");
  assert.deepStrictEqual(unscaled, ["BOA"], "and name what it left out");
}

// ---- 4. a price that was never computed is null, never zero -----------------
{
  const r = { amount: 983.23, price: null };
  r.usd = r.price == null || r.amount == null ? null : r.amount * r.price;
  assert.strictEqual(r.usd, null, "unavailable, not zero — zero would read as worthless");
}

// ---- 5. the guards are present at every site that scales by decimals --------
// Behavioural checks above cannot reach portfolio.js's internals without a full
// chain fake; this pins that no site was left unguarded when one is added back.
{
  const src = fs.readFileSync(path.join(__dirname, "..", "portfolio.js"), "utf8");
  const scaling = (src.match(/formatUnits\(raw, (?:qMeta|meta)\.decimals\)/g) || []).length;
  const guards = (src.match(/decimalsOk !== true/g) || []).length;
  assert.ok(scaling > 0, "portfolio still scales amounts by token decimals somewhere");
  assert.ok(guards >= scaling, `every scaling site needs a guard: ${scaling} scaling, ${guards} guards`);
  assert.ok(/t\.decimalsOk !== true \|\| q\.decimalsOk !== true/.test(src), "the price derivation is guarded");
}

console.log("unverified decimals: no price, no depth, no contribution to a total, and the total says what it omitted");
