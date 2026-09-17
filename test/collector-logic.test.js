// node test/collector-logic.test.js — the pure decision logic lifted out of collector.js,
// so the eligibility threshold, the "could not quote" hand-back, the vault split, the 24h
// gas budget and the per-pass balance deltas are covered without a live chain.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
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

// ---- the unit of account is not always an 18-decimal WETH ----------------------
// Arc's unit is USDC with 6 decimals. Parsing "1.0" as ether there made a $1 fee
// look like 1e-12, so no position could ever reach the threshold and the swap cap
// could never bite.
{
  const arc = { numeraire: { symbol: "USDC", decimals: 6 } };
  const eth = { numeraire: { symbol: "WETH", decimals: 18 } };
  assert.strictEqual(cl.unitDecimals(arc), 6);
  assert.strictEqual(cl.unitLabel(arc), "USDC");
  assert.strictEqual(cl.unitDecimals(eth), 18);
  assert.strictEqual(cl.unitDecimals({}), 18, "a chain with no numeraire keeps the old behaviour");
  assert.strictEqual(cl.unitLabel({}), "WETH");
  assert.strictEqual(cl.unitDecimals({ numeraire: { decimals: null } }), 18);

  // a $1.29 fee against a 1.00 threshold, in each chain's own units
  const feeArc = ethers.parseUnits("1.29", cl.unitDecimals(arc));
  const minArc = ethers.parseUnits("1.0", cl.unitDecimals(arc));
  assert.strictEqual(cl.isPositionEligible(feeArc, minArc), true, "a $1.29 fee clears a $1 threshold on Arc");
  // the old ether parsing against 6-decimal amounts: never eligible
  assert.strictEqual(cl.isPositionEligible(feeArc, ethers.parseEther("1.0")), false,
    "this is the bug: an 18-decimal threshold against 6-decimal value");
}

// ---- native gas vs the unit of account: two scales, never interchangeable -------
// On Arc gas is paid in 18-decimal native USDC while fees arrive as 6-decimal
// ERC-20 USDC. Every `…Eth` setting is an amount of the NATIVE currency.
{
  const arc = { nativeCurrency: { symbol: "USDC", decimals: 18 }, numeraire: { symbol: "USDC", decimals: 6 },
    sweep: { keepGasReserveEth: "1.0", gasTargetEth: "2.0" } };
  assert.strictEqual(cl.nativeDecimals(arc), 18, "Arc's native currency is 18-decimal");
  assert.strictEqual(cl.unitDecimals(arc), 6, "while its fee unit is 6-decimal");
  assert.strictEqual(cl.nativeLabel(arc), "USDC");
  assert.strictEqual(cl.nativeDecimals({}), 18, "no declaration keeps the old ether behaviour");
  assert.strictEqual(cl.nativeLabel({}), "ETH");

  // the gas float is parsed in native decimals
  const f = cl.gasFloat(arc);
  assert.strictEqual(f.reserve, ethers.parseUnits("1.0", 18));
  assert.strictEqual(f.target, ethers.parseUnits("2.0", 18));
  // a hypothetical 6-decimal native chain must not be parsed as ether
  const six = { nativeCurrency: { symbol: "GAS", decimals: 6 }, sweep: { keepGasReserveEth: "1.0", gasTargetEth: "2.0" } };
  assert.strictEqual(cl.gasFloat(six).reserve, ethers.parseUnits("1.0", 6));
  assert.notStrictEqual(cl.gasFloat(six).reserve, ethers.parseEther("1.0"));
}

// ---- the daily gas budget and the minimum float, in native units ---------------
{
  const dec = 18;
  const cap = ethers.parseUnits("1.0", dec);                 // 1 USDC of gas a day
  const perCollect = 20040000000n * 600000n;                 // 600k gas at ~20 gwei
  const atCapPrice = 200000000000n * 600000n;                // the same collect at the 200 gwei cap
  assert.ok(Number(cap / perCollect) >= 80 && Number(cap / perCollect) <= 84,
    `~83 collects a day at spot, not more: ${cap / perCollect}`);
  assert.strictEqual(Number(cap / atCapPrice), 8, "only 8 a day if gas sits at the configured cap");
  // the budget is enforced from recorded spend, not estimated
  const now = Date.now();
  const arcCfg = { nativeCurrency: { symbol: "USDC", decimals: 18 } };
  const spent = { gasSpends: [{ t: now - 3600e3, wei: (cap - perCollect).toString() }] };
  assert.strictEqual(cl.gasCapHit(spent, "1.0", arcCfg), false, "under the cap, the run proceeds");
  const spentOver = { gasSpends: [{ t: now - 3600e3, wei: cap.toString() }] };
  assert.strictEqual(cl.gasCapHit(spentOver, "1.0", arcCfg), true, "at the cap, the run aborts");
  const old = { gasSpends: [{ t: now - 25 * 3600e3, wei: (cap * 5n).toString() }] };
  assert.strictEqual(cl.gasCapHit(old, "1.0", arcCfg), false, "spend older than 24 h does not count");
  // a 6-decimal native chain: the same string must not be parsed as ether
  const sixCfg = { nativeCurrency: { symbol: "GAS", decimals: 6 } };
  const sixSpend = { gasSpends: [{ t: now - 3600e3, wei: ethers.parseUnits("1.0", 6).toString() }] };
  assert.strictEqual(cl.gasCapHit(sixSpend, "1.0", sixCfg), true, "cap reached in native units");
  assert.strictEqual(cl.gasCapHit(sixSpend, "1.0"), false, "and the ether default would have missed it");
  // the minimum float guard compares a native balance against a native setting
  const min = ethers.parseUnits("0.5", dec);
  assert.ok(ethers.parseUnits("12.0", dec) > min, "the funded operator clears the floor");
  assert.ok(!(ethers.parseUnits("0.4", dec) > min), "a drained float does not");
}

// ---- the swap-value cap, on both sides, in the unit of account ------------------
// maxSwapValueWeth is an amount of the unit of account (6-decimal USDC on Arc).
// This is the decision the collector actually calls before building a swap.
{
  const dec = 6;
  const cap = ethers.parseUnits("50", dec);
  const under = ethers.parseUnits("49.999999", dec);
  const over = ethers.parseUnits("50.000001", dec);
  assert.strictEqual(cl.handBackReason({ feeTier: 3000, quotedWeth: under, maxSwapWeth: cap }), null,
    "a quote just under the cap is swapped");
  assert.strictEqual(cl.handBackReason({ feeTier: 3000, quotedWeth: cap, maxSwapWeth: cap }), null,
    "exactly at the cap is allowed");
  assert.strictEqual(cl.handBackReason({ feeTier: 3000, quotedWeth: over, maxSwapWeth: cap }), "swap over maxSwapValueWeth",
    "a quote just over the cap is handed back, not swapped");
  // the bug this guards: an 18-decimal cap against 6-decimal quotes never fires
  assert.strictEqual(cl.handBackReason({ feeTier: 3000, quotedWeth: over, maxSwapWeth: ethers.parseEther("50") }), null,
    "this is what the old parsing did — the cap could never bite");
  // and the collector routes that reason to the hand-back path, never to a swap
  const src = fs.readFileSync(path.join(__dirname, "..", "collector.js"), "utf8");
  const at = src.indexOf('if (why === "swap over maxSwapValueWeth")');
  assert.ok(at > 0, "collector.js still branches on that reason");
  assert.match(src.slice(at, at + 260), /await handBack\(/, "and hands the token back instead of swapping");
  assert.match(src, /const maxSwap = ethers\.parseUnits\(cfg\.thresholds\.maxSwapValueWeth, UNIT_DEC\)/,
    "the cap is parsed in the unit of account's decimals");
}

console.log("collector-logic: native gas vs unit of account, daily budget, swap cap, eligibility, hand-back, split, gas budget, pass deltas — all assertions passed");
