/**
 * collector-base-logic.js -- the pure decisions of the Base fee-collect pass (collector-base.js).
 * No I/O: thresholds, gas caps and which wallets are enabled. Everything here fails closed: a
 * missing or unusable number means "do not send".
 */
"use strict";
const { ethers } = require("ethers");
const cl = require("./collector-logic");

const BASE_CHAIN_ID = 8453;
/** The only position managers the pass will ever touch (Aerodrome Slipstream on Base). */
const ALLOWED_MANAGERS = [
  "0x827922686190790b37229fd06084350E74485b72",
  "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53",
];
/** Used for every key missing from (or unusable in) settings.baseCollect. */
const DEFAULTS = Object.freeze({
  minFeesUsd: 2,
  minFeesToGasRatio: 5,
  maxGasPerRunEth: 0.0003,
  maxGasPriceGwei: 1,
  maxCollectsPerRun: 6,
  // The rolling 24 h ceiling across runs (state.json of the Base data dir). Three full runs' worth.
  dailyGasCapEth: 0.001,
});

/** The effective limits: settings.baseCollect over DEFAULTS. A non-numeric or non-positive value falls back. */
function limits(baseCollect) {
  const b = baseCollect && typeof baseCollect === "object" ? baseCollect : {};
  const out = {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const v = b[k];
    const n = v === undefined || v === null || v === "" ? NaN : Number(v);
    out[k] = Number.isFinite(n) && n > 0 ? n : d;
  }
  out.maxCollectsPerRun = Math.floor(out.maxCollectsPerRun);
  return out;
}

const addr = (a) => { try { return ethers.getAddress(a); } catch { return null; } };

/**
 * The wallets the pass may act on, from the flat settings: the main wallet (wallets.main.collect) and
 * the watched ones (wallets.watched[].collect). Only `collect === true` enables; the rest are listed
 * with enabled:false so the log can say so. The same address twice counts once, enabled if either asks.
 */
function owners(cfg) {
  const list = [];
  const put = (address, label, flag, main) => {
    const a = addr(address);
    if (!a) return;
    const have = list.find((o) => o.address === a);
    if (have) { have.enabled = have.enabled || flag === true; return; }
    list.push({ address: a, label: label || a, enabled: flag === true, main });
  };
  put(cfg.ownerAddress, cfg.ownerLabel || "Main", cfg.ownerCollect, true);
  for (const w of (cfg.wallets && cfg.wallets.list) || []) if (w) put(w.address, w.label, w.collect, false);
  return list;
}

/** The configured managers that are also on the allowlist, and those that are not (reported, never used). */
function managers(cfg) {
  const allow = new Set(ALLOWED_MANAGERS.map((a) => a.toLowerCase()));
  const used = [], refused = [];
  for (const spec of (cfg.contracts && cfg.contracts.slipstream) || []) {
    const a = spec && addr(spec.positionManager);
    if (a && allow.has(a.toLowerCase())) used.push({ ...spec, positionManager: a });
    else refused.push(spec && spec.positionManager ? String(spec.positionManager) : "(none)");
  }
  return { used, refused };
}

/** What the network charges per gas: the lower of maxFeePerGas and gasPrice that exist, or null. */
function effectiveGasPrice(feeData) {
  const c = [feeData && feeData.maxFeePerGas, feeData && feeData.gasPrice].filter((x) => typeof x === "bigint" && x > 0n);
  return c.length ? c.reduce((a, b) => (a < b ? a : b)) : null;
}

const usd = (n) => (n == null || !Number.isFinite(n) ? "n/a" : `$${n.toFixed(4)}`);

/** Cost in USD of `gasUnits` at `gasPriceWei` with the ETH price `ethUsd`; null when any input is missing. */
function gasCostUsd(gasUnits, gasPriceWei, ethUsd) {
  if (gasUnits == null || gasPriceWei == null || !(ethUsd > 0)) return null;
  return Number(ethers.formatEther(BigInt(gasUnits) * BigInt(gasPriceWei))) * ethUsd;
}

/**
 * Should this unstaked, priced position be collected? Pure threshold decision.
 * { collect: true, reason } or { collect: false, reason }.
 */
function decide({ feesUsd, gasUsd, lim }) {
  if (feesUsd == null || !Number.isFinite(feesUsd)) return { collect: false, reason: "fees are unpriced (fail closed)" };
  if (feesUsd < lim.minFeesUsd) return { collect: false, reason: `below minFeesUsd (${usd(feesUsd)} < $${lim.minFeesUsd})` };
  if (gasUsd == null || !Number.isFinite(gasUsd)) return { collect: false, reason: "gas cost is unknown (fail closed)" };
  if (feesUsd < lim.minFeesToGasRatio * gasUsd) return { collect: false, reason: `fees < ${lim.minFeesToGasRatio}x gas (${usd(feesUsd)} < ${lim.minFeesToGasRatio} x ${usd(gasUsd)})` };
  return { collect: true, reason: `fees ${usd(feesUsd)} >= $${lim.minFeesUsd} and >= ${lim.minFeesToGasRatio}x gas` };
}

/**
 * May one more transaction be sent? Checks, in order: the network gas price cap, the per-run count,
 * the per-run gas cap (spent so far + this estimate) and the rolling 24 h cap (state).
 *   gasPriceWei   what the network charges now
 *   estimateWei   conservative cost of the next collect (cl.gasEstimate)
 *   sentCount     collects sent so far this run
 *   spentRunWei   gas actually paid so far this run
 *   spent24hWei   gas paid in the trailing 24 h, this run included
 */
function capCheck({ lim, gasPriceWei, estimateWei, sentCount, spentRunWei, spent24hWei }) {
  const gwei = Number(ethers.formatUnits(gasPriceWei, "gwei"));
  if (gwei > lim.maxGasPriceGwei) return { ok: false, cap: "maxGasPriceGwei", reason: `gas price ${gwei.toFixed(4)} gwei exceeds maxGasPriceGwei ${lim.maxGasPriceGwei}` };
  if (sentCount >= lim.maxCollectsPerRun) return { ok: false, cap: "maxCollectsPerRun", reason: `maxCollectsPerRun ${lim.maxCollectsPerRun} reached` };
  const runCap = ethers.parseUnits(String(lim.maxGasPerRunEth), 18);
  if (!cl.budgetAllows({ spentWei: spentRunWei, capWei: runCap, estimateWei })) {
    return { ok: false, cap: "maxGasPerRunEth", reason: `maxGasPerRunEth ${lim.maxGasPerRunEth} ETH would be exceeded (spent ${ethers.formatEther(spentRunWei)} + estimated ${ethers.formatEther(estimateWei)} ETH)` };
  }
  const dayCap = ethers.parseUnits(String(lim.dailyGasCapEth), 18);
  if (!cl.budgetAllows({ spentWei: spent24hWei, capWei: dayCap, estimateWei })) {
    return { ok: false, cap: "dailyGasCapEth", reason: `24 h gas cap ${lim.dailyGasCapEth} ETH would be exceeded (spent ${ethers.formatEther(spent24hWei)} + estimated ${ethers.formatEther(estimateWei)} ETH)` };
  }
  return { ok: true };
}

module.exports = { BASE_CHAIN_ID, ALLOWED_MANAGERS, DEFAULTS, limits, owners, managers, effectiveGasPrice, gasCostUsd, decide, capCheck, usd };
