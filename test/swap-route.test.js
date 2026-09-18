// node test/swap-route.test.js — which pool a fee token is converted through.
//
// The collector used to take the tier from the position the fees were earned in.
// On Arc every LP position is v4, whose fee (4%, 3.881%) is not a v3 tier, so every
// quote failed and the fee tokens were handed back unconverted — and holding one
// pair in two tiers made it refuse to swap at all rather than choose between them.
//
// The rule now is: quote the candidates, take the best output, and let an explicit
// override win outright. These are the real Arc numbers: ARGUS quotes 0.014816 USDC
// in the 0.01% pool and 0.014164 in the 1% pool, EURC 1.147243 in 0.05% and 1.143311
// in 0.3%; the other tiers exist with zero liquidity and cannot quote.
"use strict";
const assert = require("assert");
const { pickSwapRoute, V3_FEE_TIERS } = require("../collector-logic");

const usdc = (s) => BigInt(Math.round(Number(s) * 1e6));
// Quotes for one whole token, by tier, as Arc answers them today.
const ARGUS = { 100: usdc("0.014816"), 500: null, 3000: null, 10000: usdc("0.014164") };
const EURC = { 100: null, 500: usdc("1.147243"), 3000: usdc("1.143311"), 10000: null };
const quoterFor = (table, calls = []) => (fee) => { calls.push(fee); const v = table[fee]; return v == null ? 0n : v; };

(async () => {
  // ---- 1. the best pool wins, not the first that answers ------------------------
  {
    const calls = [];
    const r = await pickSwapRoute({ positionFee: 40000, quote: quoterFor(ARGUS, calls) });
    assert.strictEqual(r.fee, 100, "ARGUS converts through the 0.01% pool");
    assert.strictEqual(r.out, usdc("0.014816"));
    assert.strictEqual(r.source, "quoted");
    assert.ok(calls.includes(10000), "the 1% pool was quoted too, and lost on output");
    assert.ok(calls.includes(40000), "the position's own fee was tried as a candidate");
    assert.strictEqual(r.tried.filter((t) => t.out).length, 2, "two pools could fill; the better one was taken");

    const e = await pickSwapRoute({ positionFee: 500, quote: quoterFor(EURC) });
    assert.strictEqual(e.fee, 500, "EURC converts through the 0.05% pool");
    assert.strictEqual(e.out, usdc("1.147243"));
  }

  // ---- 2. a v4 position's fee never decides the route on its own -----------------
  {
    // The old behaviour: tier = the position's fee, 4%, which no v3 pool has.
    const onlyPositionFee = await pickSwapRoute({ positionFee: 40000, tiers: [], quote: quoterFor(ARGUS) });
    assert.strictEqual(onlyPositionFee, null, "a 4% v4 fee alone converts nothing");
    // With the standard tiers in play, the same token converts.
    const r = await pickSwapRoute({ positionFee: 40000, quote: quoterFor(ARGUS) });
    assert.strictEqual(r.fee, 100);
  }

  // ---- 3. one token, two position tiers: decided, not refused --------------------
  {
    // #8240 is 4% and #170828 is 3.881%; neither is a v3 tier and both are ARGUS.
    for (const positionFee of [40000, 38810]) {
      const r = await pickSwapRoute({ positionFee, quote: quoterFor(ARGUS) });
      assert.strictEqual(r.fee, 100, `position fee ${positionFee} still routes through the best pool`);
    }
  }

  // ---- 4. an override wins, and is reported when it cannot fill -------------------
  {
    const calls = [];
    const r = await pickSwapRoute({ override: 10000, quote: quoterFor(ARGUS, calls) });
    assert.strictEqual(r.fee, 10000, "the pinned pool is used even though 0.01% quotes better");
    assert.strictEqual(r.source, "override");
    assert.deepStrictEqual(calls, [10000], "and no other pool is quoted — pinning means pinning");

    const dead = await pickSwapRoute({ override: 3000, quote: quoterFor(ARGUS) });
    assert.strictEqual(dead.fee, null, "an override that cannot quote does not silently fall back");
    assert.strictEqual(dead.failedOverride, 3000, "it is reported as the override that failed");
  }

  // ---- 5. no route at all -------------------------------------------------------
  {
    const none = await pickSwapRoute({ positionFee: 40000, quote: () => 0n });
    assert.strictEqual(none, null, "a token no pool can quote has no route");
    const throws = await pickSwapRoute({ quote: () => { throw new Error("RPC down"); } });
    assert.strictEqual(throws, null, "a quoter that throws is a missing route, not a crash");
  }

  // ---- 6. the amount decides, so the route is resolved per swap ------------------
  {
    // A thin pool that wins on dust and loses on size: quoting with the real amount
    // is what picks the right one.
    const deep = 10000, thin = 100;
    const table = (amount) => (fee) => (fee === thin ? (amount > 10n ? usdc("0.5") : usdc("2")) : fee === deep ? usdc("1") : 0n);
    const small = await pickSwapRoute({ quote: table(1n) });
    const large = await pickSwapRoute({ quote: table(100n) });
    assert.strictEqual(small.fee, thin, "the thin pool is better for a small amount");
    assert.strictEqual(large.fee, deep, "and worse for a large one");
  }

  assert.deepStrictEqual(V3_FEE_TIERS, [100, 500, 3000, 10000], "the candidate tiers are the standard v3 set");
  console.log("swap route: chosen by quote across every candidate pool; overrides pin and report; a v4 position fee no longer decides or blocks the swap");
})().catch((e) => { console.error(e); process.exit(1); });
