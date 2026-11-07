// node test/collector-base-logic.test.js -- the pure decisions of the Base collect pass.
"use strict";
const assert = require("assert");
const { ethers } = require("ethers");
const L = require("../collector-base-logic");

// defaults when baseCollect is absent, partial or junk
assert.deepStrictEqual(L.limits(undefined), { minFeesUsd: 2, minFeesToGasRatio: 5, maxGasPerRunEth: 0.0003, maxGasPriceGwei: 1, maxCollectsPerRun: 6, dailyGasCapEth: 0.001 });
assert.deepStrictEqual(L.limits({}), L.limits(null));
assert.strictEqual(L.limits({ minFeesUsd: 7 }).minFeesUsd, 7);
assert.strictEqual(L.limits({ minFeesUsd: 7 }).maxCollectsPerRun, 6);
assert.strictEqual(L.limits({ minFeesUsd: "x", maxCollectsPerRun: -1, maxGasPriceGwei: 0 }).minFeesUsd, 2, "junk falls back");
assert.strictEqual(L.limits({ maxCollectsPerRun: -1 }).maxCollectsPerRun, 6);
assert.strictEqual(L.limits({ maxGasPriceGwei: 0 }).maxGasPriceGwei, 1, "zero would disable the cap: falls back");
assert.strictEqual(L.limits({ _comment: "x", minFeesUsd: 3 }).minFeesUsd, 3);

// threshold table
const lim = L.limits();
const d = (feesUsd, gasUsd) => L.decide({ feesUsd, gasUsd, lim });
assert.ok(!d(1.99, 0.01).collect && /below minFeesUsd/.test(d(1.99, 0.01).reason));
assert.ok(!d(10, 2.5).collect && /fees < 5x gas/.test(d(10, 2.5).reason));
assert.ok(d(10, 2).collect, "exactly 5x gas collects");
assert.ok(d(2, 0.1).collect, "exactly minFeesUsd collects");
assert.ok(!d(null, 1).collect && /unpriced/.test(d(null, 1).reason));
assert.ok(!d(undefined, 1).collect && !d(NaN, 1).collect);
assert.ok(!d(10, null).collect && /gas cost is unknown/.test(d(10, null).reason), "unknown gas fails closed");
assert.ok(L.decide({ feesUsd: 10, gasUsd: 2.5, lim: L.limits({ minFeesToGasRatio: 3 }) }).collect, "ratio is configurable");
assert.ok(!L.decide({ feesUsd: 4, gasUsd: 0.1, lim: L.limits({ minFeesUsd: 5 }) }).collect, "minFeesUsd is configurable");

// gas cost
assert.strictEqual(L.gasCostUsd(150000n, 50_000_000n, 2000), Number(ethers.formatEther(150000n * 50_000_000n)) * 2000);
assert.strictEqual(L.gasCostUsd(150000n, null, 2000), null);
assert.strictEqual(L.gasCostUsd(150000n, 1n, 0), null);
assert.strictEqual(L.effectiveGasPrice({ maxFeePerGas: 10n, gasPrice: 4n }), 4n, "the lower of the two");
assert.strictEqual(L.effectiveGasPrice({ maxFeePerGas: 10n, gasPrice: null }), 10n);
assert.strictEqual(L.effectiveGasPrice({}), null);

// caps
const gwei = (n) => ethers.parseUnits(String(n), "gwei"), eth = (n) => ethers.parseUnits(String(n), 18);
const base = { lim, gasPriceWei: gwei("0.05"), estimateWei: eth("0.0001"), sentCount: 0, spentRunWei: 0n, spent24hWei: 0n };
assert.deepStrictEqual(L.capCheck(base), { ok: true });
let c = L.capCheck({ ...base, gasPriceWei: gwei("1.01") });
assert.ok(!c.ok && c.cap === "maxGasPriceGwei" && /maxGasPriceGwei 1/.test(c.reason));
assert.ok(L.capCheck({ ...base, gasPriceWei: gwei("1") }).ok, "exactly the cap is allowed");
c = L.capCheck({ ...base, sentCount: 6 });
assert.ok(!c.ok && c.cap === "maxCollectsPerRun" && /maxCollectsPerRun 6/.test(c.reason));
assert.ok(L.capCheck({ ...base, sentCount: 5 }).ok);
c = L.capCheck({ ...base, spentRunWei: eth("0.0002"), estimateWei: eth("0.00011") });
assert.ok(!c.ok && c.cap === "maxGasPerRunEth" && /maxGasPerRunEth 0.0003/.test(c.reason), "spent + estimated over the per-run cap stops it");
assert.ok(L.capCheck({ ...base, spentRunWei: eth("0.0002"), estimateWei: eth("0.0001") }).ok, "exactly the cap is allowed");
c = L.capCheck({ ...base, spent24hWei: eth("0.00095"), estimateWei: eth("0.0001") });
assert.ok(!c.ok && c.cap === "dailyGasCapEth" && /24 h gas cap 0.001/.test(c.reason));
assert.ok(L.capCheck({ ...base, lim: L.limits({ maxGasPerRunEth: 0.01, dailyGasCapEth: 0.1 }), estimateWei: eth("0.005") }).ok, "caps are configurable");

// owners: collect must be literally true; main and watched; duplicates merge
const cfg = {
  ownerAddress: "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743", ownerLabel: "Trading", ownerCollect: false,
  wallets: { list: [{ address: "0xFc1235E6523Becf4b329ed9ADf21750cfAF65Bfb", label: "W11", collect: "true" }, { address: "0xAAB445f2846476A31Aaed66112B0f3e2ad82c50A", label: "W12", collect: true }, { address: "nonsense", collect: true }] },
};
let o = L.owners(cfg);
assert.deepStrictEqual(o.map((x) => [x.label, x.enabled, x.main]), [["Trading", false, true], ["W11", false, false], ["W12", true, false]], "only boolean true enables; bad addresses are dropped");
assert.strictEqual(L.owners({ ...cfg, ownerCollect: undefined }).find((x) => x.main).enabled, false, "absent means off");
o = L.owners({ ...cfg, ownerCollect: true });
assert.ok(o[0].enabled);
o = L.owners({ ...cfg, wallets: { list: [{ address: cfg.ownerAddress.toLowerCase(), label: "dup", collect: true }] } });
assert.strictEqual(o.length, 1); assert.ok(o[0].enabled, "same address twice is one wallet, enabled if either asks");

// managers: the allowlist is exact
const A = "0x827922686190790b37229fd06084350E74485b72", B = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53", EVIL = "0x00000000000000000000000000000000000000ee";
assert.deepStrictEqual(L.ALLOWED_MANAGERS, [A, B]);
const m = L.managers({ contracts: { slipstream: [{ name: "a", positionManager: A.toLowerCase() }, { name: "evil", positionManager: EVIL }, { name: "b", positionManager: B }, { name: "x" }] } });
assert.deepStrictEqual(m.used.map((x) => x.positionManager), [A, B]);
assert.deepStrictEqual(m.refused, [EVIL, "(none)"]);
console.log("collector-base-logic tests passed");
