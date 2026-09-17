// node test/pool-rate.test.js — the on-chain pool fee-rate estimate (pools.js
// directV4): its numerator, denominator, window and the liquidity it assumes.
// A fake StateView answers; samples live in a temporary data directory.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pool-rate-"));
process.env.LP_DATA_DIR = DIR;
process.env.LP_SCANNER_URL = "http://127.0.0.1:9";          // no scanner: direct reads only
process.on("exit", () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });
const { ethers } = require("ethers");

const POOL = "0x" + "ab".repeat(32);
const Q96 = 2n ** 96n, Q128 = 2n ** 128n;
const L = 10n ** 18n;
const now = Date.now();
// fee growth per unit of liquidity: +1 token0-unit per Q128 per liquidity over 20 h
const G0 = 10n ** 30n, G1 = 0n, D0 = Q128 * 7n * 10n ** 6n / L; // 7 USDC of fees on L over the window
const iface = new ethers.Interface([
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
  "function getFeeGrowthGlobals(bytes32) view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)",
]);
const runner = {
  provider: null,
  async call(tx) {
    const f = iface.getFunction(tx.data.slice(0, 10));
    if (f.name === "getSlot0") return iface.encodeFunctionResult(f, [Q96 * 1000000n, 0, 0, 0]); // price 1 at 6/18 decimals scale not needed
    if (f.name === "getLiquidity") return iface.encodeFunctionResult(f, [L]);
    return iface.encodeFunctionResult(f, [G0 + D0, G1]);
  },
};
// hourly samples over 20 h; liquidity was 0.6x..1.5x today's
const samples = [];
for (let i = 20; i >= 1; i--) {
  const ratio = i > 15 ? 1.5 : i > 10 ? 0.6 : 1;
  samples.push({ h: String(Math.floor((now - i * 3600000) / 3600000) * 3600000), t: now - i * 3600000,
    g0: (i === 20 ? G0 : G0 + D0 / 2n).toString(), g1: "0", L: BigInt(Math.round(Number(L) * ratio)).toString() });
}
fs.writeFileSync(path.join(DIR, "pool-samples.json"), JSON.stringify({ [POOL]: samples }));

const pools = require("../pools").create({
  cfg: { contracts: { weth: "", v4: { stateView: "0x" + "11".repeat(20) } } },
  provider: runner,
});

(async () => {
  const q = await pools.forPosition({ version: 4, poolAddress: POOL, token0: "0x" + "01".repeat(20), token1: "0x" + "02".repeat(20),
    usd0: 1, usd1: 1, decimals0: 6, decimals1: 18, feePct: 0.05, symbol0: "USDC", symbol1: "X" });
  assert.ok(q && q.direct, "a v4 pool with no scanner row is read from chain");
  assert.ok(Math.abs(q.feesWindowH - 20) < 0.05, `window is the earliest sample within 24 h: ${q.feesWindowH}`);
  // numerator: Δg0 × current L / 2^128 = 7 USDC over 20 h -> 8.4 USDC / 24 h, at current prices
  assert.ok(Math.abs(q.fees24h - 8.4) < 1e-3, `fees24h ${q.fees24h}`);
  // denominator: virtual reserves of the current active liquidity at the current price
  const x = Number(ethers.formatUnits((L * Q96) / (Q96 * 1000000n), 6));
  const y = Number(ethers.formatUnits((L * Q96 * 1000000n) / Q96, 18));
  assert.ok(Math.abs(q.tvl - (x + y)) < 1e-6, `tvl ${q.tvl} vs ${x + y}`);
  assert.ok(Math.abs(q.aprPct - (q.fees24h / q.tvl) * 365 * 100) < 1e-9, "rate = fees24h / tvl × 365, uncapped");
  // the liquidity the estimate assumes, against what was sampled
  assert.deepStrictEqual(q.liqRange, { min: 0.6, max: 1.5, samples: 21 }, `the stored samples plus the one this read takes: ${JSON.stringify(q.liqRange)}`);
  console.log("pool rate: numerator, denominator and window traced; the liquidity range behind the estimate is reported");
})().catch((e) => { console.error(e); process.exit(1); });
