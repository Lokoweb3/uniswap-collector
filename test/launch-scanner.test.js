// launch-scanner.js: scoring, alert text, dangerous-selector table and swap-direction logic — no network.
const assert = require("assert");
const L = require("../launch-scanner");

const cfg = { contracts: { v4: { poolManager: "0x8366a39C0000000000000000000000000000000000".slice(0, 42), universalRouter: null, quoter: null, stateView: null, pricingHooks: [] }, weth: "0x0bd7d3f3d2d3f3d2d3f3d2d3f3d2d3f3d2d3f3d2" }, usdReference: { stable: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" }, launchScanner: { minScore: 70 } };
const s = L.create({ cfg, provider: {}, alerts: null, dir: require("os").tmpdir(), log() {} });

// scoring: every criterion met = 100; sweet spot vs in-range mcap; nothing = 0
const full = { mcapUsd: 120000, contract: { verified: true }, lpHealthy: true, honeypot: { ok: true }, holdersOk: true, buyPressure: true };
assert.strictEqual(s.score(full).score, 100);
assert.strictEqual(s.score({ ...full, mcapUsd: 400000 }).score, 90, "in range but outside the sweet spot = +10");
assert.strictEqual(s.score({ ...full, honeypot: { ok: false } }).score, 75);
assert.strictEqual(s.score({ mcapUsd: 10, contract: {}, honeypot: {} }).score, 0);

// alert text carries the numbers and the three links
const ev = { ...full, symbol: "TOK", quoteSymbol: "ETH", feePct: 5, ageMin: 23, tokenAgeMin: 40, score: 82, pool: "0xabc", token: "0xdef", tvlUsd: 12000, contract: { clean: true, verified: true, renounced: true, flags: [] }, honeypot: { ok: true, sellTaxPct: 0 }, holders: { count: 47, topPct: 12, devPct: 3 }, volume: { buys: 23, sells: 6, buyRatioPct: 79 } };
const msg = s.message(ev);
assert.match(msg, /🚀 New launch detected!/); assert.match(msg, /TOK\/ETH · Robinhood Chain · 5% pool/); assert.match(msg, /MCap: \$120K · Pool age: 23 min · token 40 min old/); assert.match(msg, /Score: 82\/100/);
assert.match(msg, /✅ Contract clean, verified, ownership renounced/); assert.match(msg, /✅ LP healthy \(\$12K in range\)/); assert.match(msg, /✅ Sellable, sell tax 0%/); assert.match(msg, /✅ 47 holders, top wallet 12%, dev 3%/); assert.match(msg, /✅ 23 buys in last 10 min \(79% buys\)/);
assert.match(msg, /app.uniswap.org\/explore\/pools\/robinhood\/0xabc/); assert.match(msg, /dexscreener.com\/robinhoodchain\/0xabc/); assert.match(msg, /blockscout.com\/token\/0xdef/);
assert.match(msg, /Be first LP at the 5% fee tier/);
const bad = s.message({ ...ev, contract: { clean: false, flags: ["mint(address,uint256)"] }, lpHealthy: false, honeypot: { ok: false, error: "sell reverted" }, holdersOk: false, buyPressure: false });
assert.match(bad, /❌ Contract: mint\(address,uint256\)/); assert.match(bad, /❌ LP thin/); assert.match(bad, /❌ Sell check: sell reverted/);
const follow = s.message({ ...ev, mcapUsd: 360000 }, { from: 120000, at: Date.now() - 3600000 });
assert.match(follow, /📈 TOK\/ETH is up: market cap \$120K → \$360K since the alert 60 min ago/);

// dangerous selectors: mint / pause / blacklist present, transferFrom deliberately absent
assert.ok(L.DANGER["0x40c10f19"] && L.DANGER["0x8456cb59"] && L.DANGER["0xf9f92be4"]);
assert.ok(!L.DANGER["0x23b872dd"], "transferFrom is standard ERC-20, not a flag");
assert.strictEqual(L.DEFAULTS.minScore, 70); assert.strictEqual(L.DEFAULTS.maxSellTaxPct, 10);
console.log("launch-scanner: scoring, alert text, follow-up and selector table assertions passed");
