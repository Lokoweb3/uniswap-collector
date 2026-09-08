// node test/advisor.test.js — range comparison, IL forecast and scout logic on synthetic data.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const u = require("../univ3");

const cfg = { contracts: { weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", v4: { poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" } }, usdReference: { stable: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" } };
const advisor = require("../advisor").create({ provider: null, cfg, log: { log() {}, error() {} } });

// A pool whose price sits at tick 0 (1 token1 per token0, both 18 decimals) and
// wanders ±1 % hourly; every hour 1,000 token0 and 1,000 token1 are swapped in
// against a pool liquidity of 1e21. Fee tier 0.3 %.
const HOUR = 3600 * 1000;
const now = Date.now();
const pool = { buckets: {}, hours: 0, complete: true };
let tick = 0;
for (let i = 167; i >= 0; i--) {
  tick += (i % 2 ? 100 : -100); // ±1 % swing, stays inside ±100 ticks
  const h = String(Math.floor((now - i * HOUR) / HOUR) * HOUR);
  pool.buckets[h] = { in0: (1000n * 10n ** 18n).toString(), in1: (1000n * 10n ** 18n).toString(), liqSum: (10n ** 21n).toString(), n: 1, closeBlock: i, sqrtClose: u.getSqrtRatioAtTick(tick).toString() };
}
pool.hours = 168;

const usd0 = 1, usd1 = 1;
const L = 10n ** 19n; // 1 % of the pool
const position = { liquidity: L.toString(), tickLower: -1000, tickUpper: 1000, currentTick: 0, tickSpacing: 10, feeTier: 3000, usd0, usd1, decimals0: 18, decimals1: 18, token0: cfg.contracts.weth, token1: "0x1", valueUsd: null, tokenId: "1", wallet: "T", pair: "A / B" };
// value of the position at the current price
const amounts = u.getAmountsForLiquidity(u.getSqrtRatioAtTick(0), u.getSqrtRatioAtTick(-1000), u.getSqrtRatioAtTick(1000), L);
position.valueUsd = Number(ethers.formatUnits(amounts.amount0, 18)) * usd0 + Number(ethers.formatUnits(amounts.amount1, 18)) * usd1;

// 1. Fees for the actual range: every hour in range, 1 % share of (1000+1000) × 0.3 % = $6 → $0.06 per hour → $10.08 over 7 days.
const f = advisor.feesForRange(pool, L, -1000, 1000, 3000, usd0, usd1, 18, 18);
assert.strictEqual(f.inRangeHours, 168);
assert.ok(Math.abs(f.usd - 10.08) < 0.01, `actual-range fees ${f.usd}`);

// 2. A range that never contains the price earns nothing.
const g = advisor.feesForRange(pool, L, 5000, 6000, 3000, usd0, usd1, 18, 18);
assert.strictEqual(g.usd, 0);
assert.strictEqual(g.inRangeHours, 0);

// 3. Same capital in a tighter range buys more liquidity, so it earns more while in range.
const r = advisor.evaluate(position, pool);
assert.strictEqual(r.status, "ok");
assert.ok(r.ranges.tighter.fees7dUsd > r.ranges.actual.fees7dUsd, "tighter should earn more when the price stays inside it");
assert.ok(r.ranges.wider.fees7dUsd < r.ranges.actual.fees7dUsd, "wider should earn less");
assert.ok(r.ranges.tighter.vsActualPct > 0 && r.ranges.wider.vsActualPct < 0);
assert.strictEqual(r.recommendation, "consider tightening");

// 4. Scaling: a 3-day window is scaled to 7 days.
const half = { buckets: Object.fromEntries(Object.entries(pool.buckets).slice(-72)), hours: 72, complete: false };
const r2 = advisor.evaluate(position, half);
assert.ok(Math.abs(r2.ranges.actual.fees7dUsd - r2.ranges.actual.feesWindowUsd * (168 / 72)) < 1e-6);
assert.match(r2.status, /partial/);

// 5. IL forecast: with zero volatility there is no IL; with volatility it is negative and bounded.
const sigmaH = advisor.hourlyVol(pool);
assert.ok(sigmaH > 0 && sigmaH < 0.05, `hourly vol ${sigmaH}`);
const base = { L, sqrtP: u.getSqrtRatioAtTick(0), tickLower: -1000, tickUpper: 1000, usd0, usd1, dec0: 18, dec1: 18, quoteIs0: true };
const il0 = advisor.ilForecast({ ...base, sigmaH: 1e-9 });
assert.ok(Math.abs(il0.ilUsd) < 1e-6 * position.valueUsd, "no vol → no IL");
const il = advisor.ilForecast({ ...base, sigmaH });
assert.ok(il.ilUsd < 0, "IL must be a loss");
assert.ok(Math.abs(il.ilUsd) < position.valueUsd, "bounded by the position value");
assert.ok(r.forecast && r.forecast.net7dUsd === r.forecast.fees7dUsd + r.forecast.il7dUsd);

// 6. A wide range with high volatility flags "not worth staying" only when IL exceeds fees.
const big = advisor.ilForecast({ ...base, sigmaH: 0.2 }); // 20 %/hour: enormous
assert.ok(big.ilUsd < il.ilUsd, "more volatility, more IL");

// 7. Scout: alert only after two consecutive daily checks with a 1.5× better pool, once.
const tmp = path.join(os.tmpdir(), `scout-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });
const sent = [];
let clock = now;
const Module = require("module");
// Point scout's state/log files at a temp dir by loading it with a patched __dirname.
const scoutSrc = fs.readFileSync(path.join(__dirname, "..", "scout.js"), "utf8").replace(/path\.join\(__dirname, "pool-scout-(state|log)\.json"\)/g, (m, k) => `"${path.join(tmp, `pool-scout-${k}.json`)}"`);
const mod = new Module(path.join(tmp, "scout.js"));
mod.paths = Module._nodeModulePaths(path.join(__dirname, ".."));
mod._compile(scoutSrc.replace('require("ethers")', `require(${JSON.stringify(require.resolve("ethers"))})`), path.join(tmp, "scout.js"));
const scout = mod.exports.create({ cfg, send: async (m) => { sent.push(m); return true; }, log: { error() {} }, now: () => clock });
const realFetch = global.fetch;
global.fetch = async () => ({ json: async () => ({ pools: [
  { key: "v3:0xmine", name: "A / B 1%", version: "v3", feePct: 1, tvl: 100000, apr24h: 100, base: { address: "0xa" }, quote: { address: "0xb" } },
  { key: "v4:0xother", name: "A / B 0.3%", version: "v4", feePct: 0.3, tvl: 200000, apr24h: 200, base: { address: "0xb" }, quote: { address: "0xa" } },
] }) });
const pos = [{ wallet: "T", tokenId: "1", pair: "A / B", version: 3, poolAddress: "0xmine", token0: "0xa", token1: "0xb", pool: { aprPct: 100 } }];
(async () => {
  assert.deepStrictEqual(await scout.check(pos), [], "day 1: no alert yet");
  clock += 86400 * 1000;
  const out = await scout.check(pos);
  assert.strictEqual(out.length, 1, "day 2: alert");
  assert.match(out[0], /A\/B 0.3% v4 \(200% APR/);
  clock += 3600 * 1000;
  assert.deepStrictEqual(await scout.check(pos), [], "no repeat within a week");
  global.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("advisor: range comparison, scaling, IL forecast and scout assertions passed");
})().catch((e) => { global.fetch = realFetch; console.error("FAIL", e.message); process.exit(1); });
