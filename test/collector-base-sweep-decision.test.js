// node test/collector-base-sweep-decision.test.js -- acceptance 7, 8, 9, 10, 12: the per-token swap decision (D4). Every refusal delivers
// the token unswapped to the owner with the reason logged and signs no approve and no swap. Mocked chain, no network.
"use strict";
const assert = require("assert");
const X = require("./lib/sweep-scene");
const { proveRoute } = require("../collector-base-sweep");

const { sweepScene, decodeSent, OWNER, OP, USDC, WETH, LAPTOP, CBBTC, OTHER, E18, SL, lc, ID_A, MGR_A } = X;
const EVIL = "0x00000000000000000000000000000000000000ee";
/** One WETH-only position of `amount` WETH (18 dec). */
const wethScene = (o = {}, amount = 2n * E18 / 100n) => { const S = sweepScene({ positions: [{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: amount, a1: 0n }], ...o }); S.init(); return S; };
const names = (signer) => decodeSent(signer).map((t) => t.name);

/** The token went to the owner unswapped, for `why`; no approve and no swap was signed. */
function unswapped(S, r, why, amount, token = WETH) {
  const sent = decodeSent(r.signer);
  assert.deepStrictEqual(sent.map((t) => t.name), ["collect", "transfer"], `${why}: only the collect and one transfer\n${r.text}`);
  assert.strictEqual(lc(sent[1].to), lc(token)); assert.strictEqual(sent[1].args[0], OWNER); assert.strictEqual(sent[1].args[1], amount);
  assert.ok(r.text.includes("delivered unswapped") && why.test(r.text), `${why}\n${r.text}`);
  assert.strictEqual(S.balance(token, OP), 0n); assert.strictEqual(S.balance(token, OWNER), amount);
  assert.strictEqual(S.ledger().jobs[0].legs[0].phase, "delivered-unswapped");
  assert.deepStrictEqual(r.res.sweep.report.unswapped.map((u) => u.token), [token === WETH ? "WETH" : "LAPTOP"]);
}
const AMT = 2n * E18 / 100n;

(async () => {
  // ---- 7. a route that fails a proof is delivered unswapped; no approve and no swap
  {
    const cases = [
      ["factory.getPool differs", { getPool: () => EVIL }, null, /factory\.getPool\(WETH, USDC, 500\) is 0x0+ee, not the allowlisted pool/i],
      ["factory.getPool returns zero", { getPool: () => "0x0000000000000000000000000000000000000000" }, null, /is 0x0+, not the allowlisted pool/],
      ["pool.factory differs", {}, (S) => { S.pools.WETH.factoryActual = EVIL; }, /pool\.factory\(\) is 0x0+ee/i],
      ["pool.fee differs", {}, (S) => { S.pools.WETH.feeActual = 3000; }, /pool\.fee\(\) is 3000, not 500/],
      ["pool.token0 differs", {}, (S) => { S.pools.WETH.token0Override = EVIL; }, /pool token0\/token1 .* do not match/],
      ["router has no code", {}, (S) => { delete S.w.code[lc(SL.ROUTER)]; }, /router 0x2626664c2603336E57B271c5C0b26F421741e481 has no code/],
      ["quoter has no code", {}, (S) => { delete S.w.code[lc(SL.QUOTER)]; }, /quoter 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a has no code/],
      ["pool has no code", {}, (S) => { delete S.w.code[lc(SL.ROUTES.WETH.pool)]; }, /pool 0xd0b53D9277642d899DF5C87A3966A349A798F224 has no code/],
    ];
    for (const [name, so, mutate, why] of cases) {
      const S = wethScene(so); if (mutate) mutate(S);
      const r = await S.run({});
      unswapped(S, r, why, AMT);
      assert.strictEqual(r.res.aborted, false, name);
    }
    // a pool that is not the allowlisted constant, proven directly
    const S = wethScene();
    const bad = await proveRoute(S.w.runner, { ...SL.ROUTES.WETH, pool: EVIL });
    assert.strictEqual(bad.ok, false); assert.ok(/not the allowlisted pool/.test(bad.reason));
    assert.strictEqual((await proveRoute(S.w.runner, SL.ROUTES.WETH)).ok, true);
    // the signer-side backstop: a swap whose `to` is not the router is refused whatever decided it (see the gas/caps test for the matrix)
  }

  // ---- 8. quoter 0, inflated quote, impact above the cap (settings above the hard max are clamped to 300)
  {
    let S = wethScene(); S.quoteFor.WETH = 0n;
    unswapped(S, await S.run({}), /quoter returned 0/, AMT);
    S = wethScene(); S.quoteFor.WETH = (a) => (S.mid("WETH", a) * 1002n) / 1000n; // 0.2% above mid after fee
    unswapped(S, await S.run({}), /inflated or stale quoter/, AMT);
    S = wethScene(); S.quoteFor.WETH = (a) => (S.mid("WETH", a) * 9800n) / 10000n; // 200 bps under
    let r = await S.run({});
    unswapped(S, r, /price impact 20[01] bps exceeds maxPriceImpactBps 100/, AMT);
    // the settings value 1000 is clamped to the hard max 300: 250 bps passes, 350 bps does not
    assert.strictEqual(SL.config({ maxPriceImpactBps: 1000 }).maxPriceImpactBps, 300);
    assert.ok(SL.config({ maxPriceImpactBps: 1000 }).notes.some((n) => /above the hard maximum 300/.test(n)));
    S = wethScene(); S.quoteFor.WETH = (a) => (S.mid("WETH", a) * 9650n) / 10000n;
    r = await S.run({ sweep: { maxPriceImpactBps: 1000 } });
    unswapped(S, r, /price impact 35[01] bps exceeds maxPriceImpactBps 300/, AMT);
    S = wethScene(); S.quoteFor.WETH = (a) => (S.mid("WETH", a) * 9750n) / 10000n;
    r = await S.run({ sweep: { maxPriceImpactBps: 1000 } });
    assert.deepStrictEqual(names(r.signer), ["collect", "approve", "exactInputSingle", "transfer"], "250 bps is within the clamped 300");
    assert.ok(/impact 25[01] bps/.test(r.text));
  }

  // ---- 9. impact math, minOut, clamps
  {
    // sqrtPriceX96 = 2^96 (price 1), LAPTOP (token1 of the pair), fee 10000: mid after fee of 100 USDC = 99 USDC exactly
    const route = SL.ROUTES.LAPTOP, amountIn = 100_000_000n;
    const sw = SL.config({ enabled: true });
    const facts = (quote) => ({ route, amountIn, quote, sqrtPriceX96: 1n << 96n, tick: 0, liquidity: 1n, poolUsdc: 5_000_000n * 10n ** 6n, twapTick: 0 });
    assert.strictEqual(SL.midOut({ sqrtPriceX96: 1n << 96n, amountIn, tokenIn: route.token, token0: USDC }), amountIn);
    assert.strictEqual(SL.afterFee(amountIn, 10000), 99_000_000n);
    const quote = (99_000_000n * 9984n) / 10000n; // 0.16% below midOutAfterFee
    assert.strictEqual(quote, 98_841_600n);
    const d = SL.decideSwap(sw, facts(quote));
    assert.strictEqual(d.swap, true, d.reason); assert.strictEqual(d.impactBps, 16, "the 1% pool fee is not counted as impact");
    assert.strictEqual(d.minOut, (quote * (10000n - 50n)) / 10000n); assert.strictEqual(d.minOut, 98_347_392n);
    // the same pool but a quote that is only the fee below the fee-free mid (about 1%) is fee, not impact
    assert.strictEqual(SL.decideSwap(sw, facts(99_000_000n)).impactBps, 0);
    // slippageBps 500 in settings is clamped to 100
    const wide = SL.config({ slippageBps: 500 }); assert.strictEqual(wide.slippageBps, 100);
    assert.strictEqual(SL.decideSwap(wide, facts(quote)).minOut, (quote * 9900n) / 10000n);
    // minOut is never 0
    assert.strictEqual(SL.minOutOf(1n, 50), 0n);
    const tiny = { ...sw, minSwapValueUsdc: 0.000001 };
    const z = SL.decideSwap(tiny, { ...facts(1n), amountIn: 2n, sqrtPriceX96: 1n << 96n });
    assert.strictEqual(z.swap, false); assert.ok(/minOut would be 0|quote is above|price impact/.test(z.reason));
    assert.ok(SL.decideSwap(sw, facts(quote)).minOut > 0n);
    // the real send: minOut in the calldata is exactly quote * (10000 - slippageBps) / 10000 for a configured slippage
    const S = wethScene(); const r = await S.run({ sweep: { slippageBps: 500 } });
    const sw1 = decodeSent(r.signer).find((t) => t.name === "exactInputSingle");
    const q = S.quote("WETH", AMT);
    assert.strictEqual(sw1.args[0].amountOutMinimum, (q * 9900n) / 10000n, "500 -> 100 bps");
    assert.ok(r.lines.some((l) => /minOut 39\.\d+, impact \d+ bps/.test(l)));
  }

  // ---- 10. depth, share, liquidity, price, value, TWAP, observe, minimum
  {
    const cases = [
      ["pool USDC below minPoolUsdc", { poolUsdc: 1000n * 10n ** 6n }, null, AMT, /pool holds 1000\.0 USDC, below minPoolUsdc 2000/],
      ["quote above maxPoolShareBps", { poolUsdc: 5000n * 10n ** 6n }, null, 10n * E18 / 100n, /exceeds maxPoolShareBps 300 of the pool's USDC/],
      ["liquidity 0", { liquidity: 0n }, null, AMT, /in-range liquidity is 0/],
      ["leg value above maxSwapValueUsdc", {}, null, 4n * E18 / 10n, /above maxSwapValueUsdc 250/],
      ["spot/TWAP deviation", {}, (S) => { S.pools.WETH.twapTick += 300; }, AMT, /differs from the 1800 s TWAP tick .* by 300 > twapMaxDeviationBps 200/],
      ["observe reverts", {}, (S) => { S.pools.WETH.observeFails = true; }, AMT, /no usable TWAP \(observe failed\): fail closed/],
      ["leg value below minSwapValueUsdc", {}, null, E18 / 10000n, /below minSwapValueUsdc 1/],
    ];
    for (const [name, so, mutate, amt, why] of cases) {
      const S = wethScene(so, amt); if (mutate) mutate(S);
      const r = await S.run({});
      unswapped(S, r, why, amt);
      assert.ok(true, name);
    }
    // sqrtPriceX96 == 0 (pure: the real quoter cannot answer on such a pool)
    const sw = SL.config({ enabled: true });
    const f = { route: SL.ROUTES.WETH, amountIn: AMT, quote: 40_000_000n, sqrtPriceX96: 0n, tick: 0, liquidity: 1n, poolUsdc: 5n * 10n ** 12n, twapTick: 0 };
    assert.ok(/sqrtPriceX96 is 0/.test(SL.decideSwap(sw, f).reason));
    // maxSwapValueUsdc: the settings value is clamped to the hard max 1000
    assert.strictEqual(SL.config({ maxSwapValueUsdc: 100000 }).maxSwapValueUsdc, 1000);
    let S = wethScene({}, 3n * E18 / 10n); // 600 USDC
    let r = await S.run({ sweep: { maxSwapValueUsdc: 100000 } });
    assert.deepStrictEqual(names(r.signer), ["collect", "approve", "exactInputSingle", "transfer"], "600 USDC passes under the clamped 1000");
    S = wethScene({}, 1n * E18); // 2000 USDC
    r = await S.run({ sweep: { maxSwapValueUsdc: 100000 } });
    unswapped(S, r, /above maxSwapValueUsdc 1000/, 1n * E18);
    // twapMaxDeviationBps in settings can loosen only up to its bound
    assert.strictEqual(SL.config({ twapMaxDeviationBps: 9999 }).twapMaxDeviationBps, 500);
    // minPoolUsdc can only be raised
    assert.strictEqual(SL.config({ minPoolUsdc: 1 }).minPoolUsdc, 2000);
  }

  // ---- 12. a USDC fee leg: no quote, no approve, no swap, one transfer; a token with no route: an unswapped transfer
  {
    const S = sweepScene({ positions: [{ id: ID_A, mgr: X.MGR_A, t0: USDC, t1: OTHER, a0: 5_000_000n, a1: 7n * E18 }] }); S.init();
    const r = await S.run({});
    const sent = decodeSent(r.signer);
    assert.deepStrictEqual(sent.map((t) => t.name), ["collect", "transfer", "transfer"], r.text);
    assert.strictEqual(lc(sent[1].to), lc(USDC)); assert.strictEqual(sent[1].args[0], OWNER); assert.strictEqual(sent[1].args[1], 5_000_000n);
    assert.strictEqual(lc(sent[2].to), lc(OTHER)); assert.strictEqual(sent[2].args[0], OWNER); assert.strictEqual(sent[2].args[1], 7n * E18);
    assert.strictEqual(S.w.callsTo(SL.QUOTER).length, 0, "no quote was asked for"); assert.strictEqual(S.w.callsTo(SL.ROUTES.WETH.pool).length, 0);
    assert.ok(/no allowlisted route for this token/.test(r.text));
    assert.deepStrictEqual(r.res.sweep.report.unswapped.map((u) => u.token), [OTHER.slice(0, 8) + ".."], "only the routeless token is reported as unswapped");
    assert.strictEqual(S.balance(USDC, OP), 0n); assert.strictEqual(S.balance(OTHER, OP), 0n);
    // cbBTC and LAPTOP routes exist and the pools are the constants
    assert.strictEqual(SL.routeFor(SL.config({}), CBBTC).fee, 500); assert.strictEqual(SL.routeFor(SL.config({}), LAPTOP).fee, 10000);
  }
  console.log("collector-base-sweep-decision tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
