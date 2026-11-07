// node test/collector-base-logic.test.js -- the pure decisions of the Base collect pass.
"use strict";
const assert = require("assert");
const { ethers } = require("ethers");
const L = require("../collector-base-logic");

// defaults when baseCollect is absent, partial or junk
assert.deepStrictEqual(L.limits(undefined), { minFeesUsd: 2, minFeesToGasRatio: 5, maxGasPerRunEth: 0.0003, maxGasPriceGwei: 1, maxCollectsPerRun: 6, dailyGasCapEth: 0.001, maxGasPerTxEth: 0.0002, maxGasLimit: 500000, maxPriorityFeeGwei: 0.01, waitTimeoutSec: 120, minL1AllowanceEth: 0.00002 });
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
assert.strictEqual(L.gasCostUsd(1n, 3n * 10n ** 15n, 2000), 6, "a wei amount priced as one unit");

// caps: worst case in, in order: count, per tx, per run, rolling 24 h
const gwei = (n) => ethers.parseUnits(String(n), "gwei"), eth = (n) => ethers.parseUnits(String(n), 18);
const base = { lim, worstCaseWei: eth("0.0001"), sentCount: 0, spentRunWei: 0n, spent24hWei: 0n };
assert.deepStrictEqual(L.capCheck(base), { ok: true });
let c = L.capCheck({ ...base, sentCount: 6 });
assert.ok(!c.ok && c.cap === "maxCollectsPerRun" && /maxCollectsPerRun 6/.test(c.reason));
assert.ok(L.capCheck({ ...base, sentCount: 5 }).ok);
c = L.capCheck({ ...base, worstCaseWei: eth("0.00020001") });
assert.ok(!c.ok && c.cap === "maxGasPerTxEth" && /maxGasPerTxEth 0.0002/.test(c.reason), "per tx cap");
assert.ok(L.capCheck({ ...base, worstCaseWei: eth("0.0002") }).ok, "exactly the per-tx cap is allowed");
c = L.capCheck({ ...base, spentRunWei: eth("0.0002"), worstCaseWei: eth("0.00011") });
assert.ok(!c.ok && c.cap === "maxGasPerRunEth" && /maxGasPerRunEth 0.0003/.test(c.reason), "spent + worst case over the per-run cap stops it");
assert.ok(L.capCheck({ ...base, spentRunWei: eth("0.0002"), worstCaseWei: eth("0.0001") }).ok, "exactly the cap is allowed");
c = L.capCheck({ ...base, spent24hWei: eth("0.00095") });
assert.ok(!c.ok && c.cap === "dailyGasCapEth" && /24 h gas cap 0.001/.test(c.reason));
assert.ok(L.capCheck({ ...base, lim: L.limits({ maxGasPerRunEth: 0.01, dailyGasCapEth: 0.1, maxGasPerTxEth: 0.01 }), worstCaseWei: eth("0.005") }).ok, "caps are configurable");

// buildFees (F1)
{
  const bf = (baseGwei, hintGwei, over = {}) => L.buildFees({ baseFeeWei: baseGwei == null ? undefined : gwei(baseGwei), rpcPriorityWei: hintGwei == null ? undefined : gwei(hintGwei), lim: L.limits(over) });
  let f = bf("0.005", "1");
  assert.ok(f.ok);
  assert.strictEqual(f.maxPriorityFeePerGas, gwei("0.01"), "a 1 gwei hint is clamped to maxPriorityFeeGwei");
  assert.strictEqual(f.maxFeePerGas, 2n * gwei("0.005") + gwei("0.01"));
  assert.ok(f.maxFeePerGas <= gwei(1) && f.maxPriorityFeePerGas <= f.maxFeePerGas);
  f = bf("0.005", null);
  assert.strictEqual(f.maxPriorityFeePerGas, gwei("0.001"), "no hint: 0.001 gwei, never 1 gwei, never 0");
  assert.strictEqual(L.buildFees({ baseFeeWei: gwei("0.005"), rpcPriorityWei: 0n, lim }).maxPriorityFeePerGas, gwei("0.001"));
  f = bf("0.9", "1");
  assert.ok(f.ok && f.maxFeePerGas === gwei(1) && f.maxPriorityFeePerGas === gwei("0.01"), "2x base + tip is clamped to the cap");
  assert.strictEqual(f.expectedPriceWei, gwei("0.91"));
  f = bf("5", "0.001");
  assert.ok(!f.ok && /exceeds maxGasPriceGwei 1/.test(f.reason) && /base fee/.test(f.reason) && /cap/.test(f.reason));
  assert.ok(!bf("0.995", "1").ok, "base + tip over the cap by a hair");
  assert.ok(bf("0.99", "1").ok, "base + tip exactly at the cap");
  for (const bad of [undefined, 0n, -1n, 5, "1", null]) assert.ok(!L.buildFees({ baseFeeWei: bad, rpcPriorityWei: 1n, lim }).ok, `base fee ${String(bad)} refused`);
  f = L.buildFees({ baseFeeWei: 10n ** 18n, rpcPriorityWei: 10n ** 18n, lim });
  assert.ok(!f.ok);
}

// assertSignable (F1, S7): each violated invariant throws
{
  const { ethers } = require("ethers");
  const A = L.ALLOWED_MANAGERS[0];
  const OWN = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743";
  const ifc = new ethers.Interface(["function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256, uint256)"]);
  const M = 2n ** 128n - 1n;
  const data = (o = {}) => ifc.encodeFunctionData("collect", [{ tokenId: 5n, recipient: OWN, amount0Max: M, amount1Max: M, ...o }]);
  const exp = { tokenId: 5n, owner: OWN };
  const ok = { type: 2, chainId: 8453, to: A, data: data(), value: 0n, gasLimit: 375000n, maxFeePerGas: gwei("0.5"), maxPriorityFeePerGas: gwei("0.01") };
  L.assertSignable(ok, lim, exp);
  for (const [why, t] of [["type 1", { ...ok, type: 1 }], ["type 0", { ...ok, type: 0 }], ["gasPrice", { ...ok, gasPrice: 1n }], ["maxFee over cap", { ...ok, maxFeePerGas: gwei("1.01") }],
    ["tip over maxFee", { ...ok, maxPriorityFeePerGas: gwei("0.6") }], ["gasLimit over ceiling", { ...ok, gasLimit: 500001n }], ["other manager", { ...ok, to: "0x00000000000000000000000000000000000000ee" }],
    ["value", { ...ok, value: 1n }], ["no maxFee", { ...ok, maxFeePerGas: undefined }], ["wrong chain", { ...ok, chainId: 1 }], ["chainId undefined", { ...ok, chainId: undefined }],
    ["tip zero", { ...ok, maxPriorityFeePerGas: 0n }], ["tip over maxPriorityFeeGwei", { ...ok, maxPriorityFeePerGas: gwei("0.02") }],
    ["wrong token", { ...ok, data: data({ tokenId: 6n }) }], ["wrong recipient", { ...ok, data: data({ recipient: "0x00000000000000000000000000000000000000ee" }) }],
    ["amount0 not max", { ...ok, data: data({ amount0Max: 1n }) }], ["not collect", { ...ok, data: "0x" }], ["other function", { ...ok, data: "0x095ea7b3" + "00".repeat(64) }]]) {
    assert.throws(() => L.assertSignable(t, lim, exp), /refusing to sign/, why);
  }
  assert.throws(() => L.assertSignable(ok, lim), /refusing to sign/, "no expectation given");
  assert.strictEqual(L.limits({ maxPriorityFeeGwei: 0.01 }).maxPriorityFeeGwei, 0.01);
  L.assertSignable({ ...ok, to: A.toLowerCase(), gasLimit: 500000n, chainId: 8453n }, lim, { tokenId: 5, owner: OWN.toLowerCase() });
}

// S3: the L1 allowance is max(2 x quote, floor)
{
  const floor = 20_000_000_000_000n;
  assert.strictEqual(L.l1Allowance(0n, lim), floor, "oracle says 0 -> the floor");
  assert.strictEqual(L.l1Allowance(10n ** 12n, lim), floor);
  assert.strictEqual(L.l1Allowance(10n ** 14n, lim), 2n * 10n ** 14n);
  assert.strictEqual(L.l1Allowance(0n, L.limits({ minL1AllowanceEth: 0.0001 })), 10n ** 14n, "configurable");
}

// S1: settledWei is always within [0, reservation]
{
  const base = { price: 50_000_000n, gasLimit: 187_500n, maxFeePerGas: 61_000_000n, l1AllowanceWei: 20n * 10n ** 12n, worstCaseWei: 187_500n * 61_000_000n + 20n * 10n ** 12n };
  assert.strictEqual(L.settledWei({ ...base, gasUsed: 100_000n }), 100_000n * 50_000_000n + base.l1AllowanceWei);
  for (const bad of [-1n, -(10n ** 30n), 187_501n, 10n ** 30n, "x", undefined, null, 1.5]) assert.strictEqual(L.settledWei({ ...base, gasUsed: bad }), base.worstCaseWei, `gasUsed ${String(bad)}`);
  assert.strictEqual(L.settledWei({ ...base, gasUsed: 100_000n, price: 10n ** 18n }), 100_000n * 61_000_000n + base.l1AllowanceWei, "price clamped to maxFee");
  assert.strictEqual(L.settledWei({ ...base, gasUsed: 100_000n, price: -5n }), 100_000n * 61_000_000n + base.l1AllowanceWei, "negative price counts maxFee");
  assert.strictEqual(L.settledWei({ ...base, gasUsed: 187_500n, price: 61_000_000n }), base.worstCaseWei);
  assert.strictEqual(L.settledWei({ ...base, gasUsed: 0n, price: 0n }), base.l1AllowanceWei);
}

// S5: unknown entries count at any age
{
  const now = Date.now(), old = now - 40 * 86400_000;
  const st = { gasSpends: [{ t: old, wei: "5", kind: "unknown" }, { t: old, wei: "7", kind: "settled" }, { t: now - 2 * 86400_000, wei: "11", kind: "settled" }, { t: now - 1000, wei: "13" }] };
  assert.strictEqual(L.spentWindowWei(st, now), 18n);
  assert.strictEqual(st.gasSpends.length, 4, "not mutated");
  assert.deepStrictEqual(JSON.parse(L.serializeState(st, now)).gasSpends.map((e) => e.wei), ["5", "11", "13"], "unknown survives the 7-day prune");
}

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
