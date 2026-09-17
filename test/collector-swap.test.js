// node test/collector-swap.test.js — the money path, executed with mocks.
//
// collector-swap.convertFeeToken() is the sequence the collector runs for each fee
// token sitting in the operator wallet. Every side effect is injected, so these
// cases prove what is NOT attempted: no router call when a quote is over
// maxSwapValueWeth, and nothing sent at all when the 24-hour gas budget cannot
// cover the next transaction (a hand-back is a transfer, not a free fallback).
"use strict";
const assert = require("assert");
const { ethers } = require("ethers");
const { convertFeeToken, RESULT } = require("../collector-swap");

const DEC = 6;                                   // Arc's unit of account: 6-decimal USDC
const MAX = ethers.parseUnits("50", DEC);
const TOKEN = { address: "0xece5ca8bf9220718e5727754026757512212cb3c", symbol: "ARGUS", decimals: 18 };
const WETH = "0x3600000000000000000000000000000000000000";
const OPERATOR = "0x8b650b6e03a87d844f14d499331d54377e9db9df";
const BALANCE = 100n * 10n ** 18n;

// Every mock records its calls; anything that must not happen throws instead.
function rig({ quoted = ethers.parseUnits("10", DEC), feeTier = 3000, allowance = 0n, budgetOk = () => true, swapThrows = null } = {}) {
  const calls = { quote: 0, allowance: 0, approve: [], swap: [], handBack: [], gas: [], logs: [] };
  const receipt = (g) => ({ gasUsed: g, gasPrice: 20000000000n, blockNumber: 1 });
  return {
    calls,
    args: {
      token: TOKEN, balance: BALANCE, feeTier, maxSwap: MAX, slippageBps: 100n, weth: WETH, recipient: OPERATOR,
      quote: async () => { calls.quote++; return quoted; },
      allowanceOf: async () => { calls.allowance++; return allowance; },
      approve: async (amount) => { calls.approve.push(amount); return receipt(60000n); },
      swap: async (params) => {
        calls.swap.push(params);
        if (swapThrows) throw Object.assign(new Error(swapThrows), { shortMessage: swapThrows });
        return receipt(250000n);
      },
      handBack: async (reason) => { calls.handBack.push(reason); },
      budget: (kind) => budgetOk(kind),
      recordGas: (c) => calls.gas.push(c),
      log: (m) => calls.logs.push(String(m)),
      fmtUnit: (v) => ethers.formatUnits(v, DEC),
      fmtToken: (v) => ethers.formatUnits(v, 18),
    },
  };
}

(async () => {
  // ---- 1. a quote over the ceiling never reaches the router --------------------
  {
    const r = rig({ quoted: MAX + 1n });
    const out = await convertFeeToken(r.args);
    assert.strictEqual(out.action, RESULT.HANDED_BACK);
    assert.strictEqual(out.reason, "swap over maxSwapValueWeth");
    assert.deepStrictEqual(r.calls.swap, [], "no swap was attempted");
    assert.deepStrictEqual(r.calls.approve, [], "and no allowance was granted to the router");
    assert.strictEqual(r.calls.handBack.length, 1, "the token went back to its owner");
    assert.match(r.calls.handBack[0], /over maxSwapValueWeth/);
    assert.deepStrictEqual(r.calls.gas, [], "nothing was recorded as spent");
  }

  // ---- 2. exactly at the ceiling is allowed, just under is allowed -------------
  for (const q of [MAX, MAX - 1n]) {
    const r = rig({ quoted: q });
    const out = await convertFeeToken(r.args);
    assert.strictEqual(out.action, RESULT.SWAPPED, `quote ${q} should swap`);
    assert.strictEqual(r.calls.swap.length, 1);
    assert.deepStrictEqual(r.calls.handBack, []);
    const p = r.calls.swap[0];
    assert.strictEqual(p.tokenIn, TOKEN.address);
    assert.strictEqual(p.tokenOut, WETH);
    assert.strictEqual(p.recipient, OPERATOR, "the router pays the operator, not a third party");
    assert.strictEqual(p.amountIn, BALANCE);
    assert.strictEqual(p.amountOutMinimum, (q * 9900n) / 10000n, "1% slippage floor on the fresh quote");
    assert.strictEqual(p.sqrtPriceLimitX96, 0);
    assert.deepStrictEqual(r.calls.approve, [BALANCE], "approval is exact, never unlimited");
    assert.strictEqual(r.calls.gas.length, 2, "approval and swap are both charged to the budget");
  }

  // ---- 3. an existing allowance is not re-approved -----------------------------
  {
    const r = rig({ allowance: BALANCE });
    await convertFeeToken(r.args);
    assert.deepStrictEqual(r.calls.approve, []);
    assert.strictEqual(r.calls.swap.length, 1);
  }

  // ---- 4. no fee tier, and an unquotable pool: handed back, never swapped -------
  {
    const r = rig({ feeTier: null });
    const out = await convertFeeToken(r.args);
    assert.strictEqual(out.action, RESULT.HANDED_BACK);
    assert.strictEqual(r.calls.quote, 0, "no tier means there is nothing to quote");
    assert.deepStrictEqual(r.calls.swap, []);
    const r2 = rig({ quoted: 0n });
    const out2 = await convertFeeToken(r2.args);
    assert.strictEqual(out2.action, RESULT.HANDED_BACK);
    assert.match(r2.calls.handBack[0], /could not quote/);
    assert.deepStrictEqual(r2.calls.swap, []);
  }

  // ---- 5. the gas budget stops everything, including the hand-back --------------
  {
    // no room for a swap: nothing is sent, and the token is reported where it is
    const r = rig({ budgetOk: (kind) => kind !== "swap" });
    const out = await convertFeeToken(r.args);
    assert.strictEqual(out.action, RESULT.SKIPPED_BUDGET);
    assert.strictEqual(r.calls.quote, 0, "not even a quote is fetched once the budget is gone");
    assert.deepStrictEqual(r.calls.swap, []);
    assert.deepStrictEqual(r.calls.handBack, [], "a hand-back is itself a transfer, so it is not a fallback");
    assert.ok(r.calls.logs.some((l) => /gas budget cannot cover another swap/.test(l)), r.calls.logs.join(" | "));

    // room for a swap but not for a transfer, and the quote comes back over the cap
    const r2 = rig({ quoted: MAX + 1n, budgetOk: (kind) => kind !== "transfer" });
    const out2 = await convertFeeToken(r2.args);
    assert.strictEqual(out2.action, RESULT.SKIPPED_BUDGET);
    assert.deepStrictEqual(r2.calls.swap, [], "still no swap");
    assert.deepStrictEqual(r2.calls.handBack, [], "and no transfer it cannot pay for");

    // no tier and no budget for the hand-back: nothing at all
    const r3 = rig({ feeTier: undefined, budgetOk: () => false });
    const out3 = await convertFeeToken(r3.args);
    assert.strictEqual(out3.action, RESULT.SKIPPED_BUDGET);
    assert.deepStrictEqual(r3.calls.handBack, []);
  }

  // ---- 6. a failed swap leaves the tokens put and does not throw ----------------
  {
    const r = rig({ swapThrows: "execution reverted: STF" });
    const out = await convertFeeToken(r.args);
    assert.strictEqual(out.action, RESULT.FAILED);
    assert.strictEqual(r.calls.swap.length, 1);
    assert.deepStrictEqual(r.calls.handBack, [], "a failed swap is not retried as a hand-back in the same pass");
    assert.ok(r.calls.logs.some((l) => /remain in the operator wallet/.test(l)));
  }

  console.log("collector-swap: over-cap and budget-exhausted branches executed with mocks — no swap, no approval, no transfer attempted");
})().catch((e) => { console.error(e); process.exit(1); });
