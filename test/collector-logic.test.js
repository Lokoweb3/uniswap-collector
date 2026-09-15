// node test/collector-logic.test.js — the pure decision logic lifted out of collector.js,
// so the eligibility threshold, the "could not quote" hand-back, the vault split, the 24h
// gas budget and the per-pass balance deltas are covered without a live chain.
const assert = require("assert");
const { ethers } = require("ethers");
const cl = require("../collector-logic");

// 1. Eligibility: collectable WETH value crosses minWethPerPosition.
{
  const min = ethers.parseEther("0.001");
  assert.strictEqual(cl.isPositionEligible(ethers.parseEther("0.0005"), min), false, "below threshold excluded");
  assert.strictEqual(cl.isPositionEligible(ethers.parseEther("0.001"), min), true, "at threshold included");
  assert.strictEqual(cl.isPositionEligible(ethers.parseEther("2"), min), true, "well above included");
  assert.strictEqual(cl.isPositionEligible(0n, min), false, "zero excluded");
}

// 2. Hand-back: an unquotable token (no v3 route / zero quote) is handed back, never
//    stranded in the operator wallet; a quotable one below the cap is swapped.
{
  const max = ethers.parseEther("5");
  assert.strictEqual(cl.handBackReason({ feeTier: null, quotedWeth: 1n, maxSwapWeth: max }), "no known fee tier");
  assert.strictEqual(cl.handBackReason({ feeTier: 3000, quotedWeth: 0n, maxSwapWeth: max }), "could not quote on a v3 pool");
  assert.strictEqual(cl.handBackReason({ feeTier: 3000, quotedWeth: ethers.parseEther("6"), maxSwapWeth: max }), "swap over maxSwapValueWeth");
  assert.strictEqual(cl.handBackReason({ feeTier: 3000, quotedWeth: ethers.parseEther("3"), maxSwapWeth: max }), null, "quotable under the cap is swapped");
}

// 3. Vault split: pct% to the vault, the rest to the owner; pct 0 and 100.
{
  const raw = 10000n;
  const s10 = cl.splitAmount(raw, 10);
  assert.strictEqual(s10.toVault, 1000n);
  assert.strictEqual(s10.toOwner, 9000n);
  assert.deepStrictEqual(cl.splitAmount(raw, 0), { toVault: 0n, toOwner: 10000n });
  const s100 = cl.splitAmount(raw, 100);
  assert.strictEqual(s100.toVault, 10000n);
  assert.strictEqual(s100.toOwner, 0n);
}

// 4. 24h gas budget: prunes entries older than 24 h; cap comparison.
{
  const now = Date.now();
  const HOUR = 3600 * 1000;
  const state = { gasSpends: [
    { t: now - 25 * HOUR, wei: String(ethers.parseEther("1")) }, // pruned (too old)
    { t: now - 2 * HOUR, wei: String(ethers.parseEther("0.5")) },
    { t: now - 1 * HOUR, wei: String(ethers.parseEther("0.25")) },
    { t: now, wei: String(ethers.parseEther("0.25")) },
  ]};
  const spent = cl.gasSpentLast24h(state);
  assert.strictEqual(spent, ethers.parseEther("1"), "old entry pruned, the rest sum to 1 ETH");
  assert.strictEqual(state.gasSpends.length, 3, "state pruned in place");
  assert.strictEqual(cl.gasCapHit(state, "0.999"), true, "at/over the cap");
  assert.strictEqual(cl.gasCapHit(state, "1.5"), false, "under the cap");
}

// 5. Per-pass balance deltas: a pass only moves what THIS pass produced; a second
//    owner's delta must not include the first owner's proceeds.
{
  // WETH pass delta: the pass's share = balance above the pass-start balance.
  assert.strictEqual(cl.passDelta(ethers.parseEther("1"), ethers.parseEther("1.5")), ethers.parseEther("0.5"));
  assert.strictEqual(cl.passDelta(ethers.parseEther("1"), ethers.parseEther("1")), 0n, "no gain -> nothing from this pass");
  assert.strictEqual(cl.passDelta(ethers.parseEther("1"), ethers.parseEther("0.8")), 0n, "balance fell -> nothing");

  // ETH pass: the MAIN wallet always gets its whole current ETH balance (it owns the
  // gas), even if it fell during the pass; a WATCHED owner gets its balance only once
  // it grew above the pass-start (this pass produced something), else 0.
  assert.strictEqual(cl.ethPassDelta(ethers.parseEther("2"), ethers.parseEther("2.3"), true), ethers.parseEther("2.3"), "main: whole current balance");
  assert.strictEqual(cl.ethPassDelta(ethers.parseEther("2"), ethers.parseEther("1.8"), true), ethers.parseEther("1.8"), "main: still gets ethNow even when it fell below start");
  assert.strictEqual(cl.ethPassDelta(ethers.parseEther("2"), ethers.parseEther("2.3"), false), ethers.parseEther("2.3"), "watched: current balance once it grew");
  assert.strictEqual(cl.ethPassDelta(ethers.parseEther("2"), ethers.parseEther("1.8"), false), 0n, "watched: balance fell -> nothing");

  // Two-owner isolation: owner B's pass starts after owner A's collect landed, so B's
  // delta is B's gain only — A's 0.5 ETH sits in the starting balance, not in B's delta.
  const aCollects = ethers.parseEther("0.5");
  const bBefore = ethers.parseEther("2") + aCollects; // A's fees are in the wallet before B's pass
  const bNow = bBefore + ethers.parseEther("0.05");  // B collects 0.05
  assert.strictEqual(cl.passDelta(bBefore, bNow), ethers.parseEther("0.05"), "B's token delta excludes A's proceeds");
}

// 6. Config decoding: sweep target + gas float.
{
  const eth = cl.sweepTarget({ sweep: {} });
  assert.deepStrictEqual(eth, { kind: "eth" });
  const tok = cl.sweepTarget({ sweep: { target: "usdg", targetToken: "0x00000000000000000000000000000000000000aa", targetFeeTier: 3000 } });
  assert.strictEqual(tok.kind, "token");
  assert.strictEqual(tok.feeTier, 3000);
  assert.throws(() => cl.sweepTarget({ sweep: { target: "usdg" } }), /targetToken/);
  assert.strictEqual(cl.gasFloat({ sweep: { keepGasReserveEth: "0.01", gasTargetEth: "0.05" } }).target, ethers.parseEther("0.05"));
  assert.strictEqual(cl.gasFloat({ sweep: { keepGasReserveEth: "0.05", gasTargetEth: "0.01" } }).target, ethers.parseEther("0.05"), "target never below the reserve");
}

console.log("collector-logic: eligibility, hand-back, split, gas budget, pass deltas — all assertions passed");
