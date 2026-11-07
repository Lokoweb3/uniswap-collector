/**
 * collector-base-logic.js -- the pure decisions of the Base fee-collect pass (collector-base.js).
 * No I/O: thresholds, gas caps and which wallets are enabled. Everything here fails closed: a
 * missing or unusable number means "do not send".
 */
"use strict";
const fs = require("fs");
const path = require("path");
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
  // Per transaction, checked against the worst case actually signed (gasLimit x maxFeePerGas + the L1 allowance).
  maxGasPerTxEth: 0.0002,
  // Absolute ceiling on the gas limit of one collect; an estimate above it is skipped, never clamped.
  maxGasLimit: 500000,
  // Cap on the signed tip. Base is an OP-stack L2: tips are about zero.
  maxPriorityFeeGwei: 0.01,
  // How long to wait for one transaction's receipt before the run stops.
  waitTimeoutSec: 120,
  // Floor of the L1 data-fee allowance (ETH). The oracle is an RPC answer, so 2 x its quote is only an estimate: the
  // allowance is max(2 x quote, this floor). Not a hard bound on the real L1 fee.
  minL1AllowanceEth: 0.00002,
});
/** Tip used when the RPC gives no usable hint: 0.001 gwei. */
const DEFAULT_PRIORITY_WEI = 1_000_000n;
/** OP-stack GasPriceOracle predeploy (read-only getL1Fee). */
const L1_ORACLE = ethers.getAddress("0x420000000000000000000000000000000000000f");
const STATE_VERSION = 1;
const STATE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const COLLECT_IFACE = new ethers.Interface(["function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)"]);
const MAX128 = (1n << 128n) - 1n;

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
  out.maxGasLimit = Math.floor(out.maxGasLimit) || DEFAULTS.maxGasLimit;
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

/** A positive amount of gwei (a JS number) as wei, exact for any magnitude a setting can reasonably have. */
function gweiToWei(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return 0n;
  try { return ethers.parseUnits(String(x), "gwei"); } catch { return BigInt(Math.round(x * 1e9)); }
}
/** A positive amount of ETH (a JS number) as wei. */
function ethToWei(n) {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return 0n;
  try { return ethers.parseUnits(String(x), 18); } catch { return ethers.parseUnits(x.toFixed(18), 18); }
}
const gw = (wei) => Number(ethers.formatUnits(wei, "gwei")).toString();

/**
 * The fee fields we sign, computed by us and hard-clamped to the operator's caps, whatever the RPC says.
 * baseFeeWei must be the latest block's baseFeePerGas (a bigint > 0); rpcPriorityWei is only a hint.
 * { ok:true, maxFeePerGas, maxPriorityFeePerGas, baseFeeWei, expectedPriceWei } or { ok:false, reason }.
 */
function buildFees({ baseFeeWei, rpcPriorityWei, lim }) {
  const capWei = gweiToWei(lim.maxGasPriceGwei);
  if (typeof baseFeeWei !== "bigint" || baseFeeWei <= 0n) return { ok: false, reason: "block base fee is unavailable (fail closed)" };
  if (capWei <= 0n) return { ok: false, reason: "maxGasPriceGwei is not a positive number (fail closed)" };
  const tipCap = gweiToWei(lim.maxPriorityFeeGwei);
  const hint = typeof rpcPriorityWei === "bigint" && rpcPriorityWei > 0n ? rpcPriorityWei : DEFAULT_PRIORITY_WEI;
  let priority = hint < tipCap ? hint : tipCap;
  if (priority <= 0n) return { ok: false, reason: "maxPriorityFeeGwei leaves no tip (fail closed)" };
  if (baseFeeWei + priority > capWei) {
    return { ok: false, reason: `base fee ${gw(baseFeeWei)} gwei + tip ${gw(priority)} gwei exceeds maxGasPriceGwei ${lim.maxGasPriceGwei} (cap ${gw(capWei)} gwei)` };
  }
  const twice = baseFeeWei * 2n + priority;
  const maxFee = twice < capWei ? twice : capWei;
  if (priority > maxFee) priority = maxFee;
  if (!(priority > 0n && priority <= maxFee && maxFee <= capWei && maxFee >= baseFeeWei + priority)) {
    return { ok: false, reason: "fee invariants violated (fail closed)" };
  }
  const price = baseFeeWei + priority;
  return { ok: true, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority, baseFeeWei, expectedPriceWei: price < maxFee ? price : maxFee };
}

/**
 * The last look before signing. Throws unless the transaction is exactly what this pass is allowed to send.
 * `expect` = { tokenId, owner }: the calldata must decode to collect(tokenId, owner, MAX, MAX).
 */
function assertSignable(tx, lim, expect) {
  const bad = (m) => { throw new Error(`refusing to sign: ${m}`); };
  if (!tx || typeof tx !== "object") bad("no transaction");
  if (!expect || expect.tokenId === undefined || !expect.owner) bad("no expected token and owner to check the calldata against");
  if (tx.type !== 2) bad(`type ${tx.type} is not 2`);
  if ("gasPrice" in tx) bad("a gasPrice field is present");
  if (!tx.to || !ALLOWED_MANAGERS.some((a) => a.toLowerCase() === String(tx.to).toLowerCase())) bad(`to ${tx.to} is not an allowlisted manager`);
  if (tx.value !== 0n) bad("value is not 0");
  if (typeof tx.gasLimit !== "bigint" || tx.gasLimit <= 0n || tx.gasLimit > BigInt(lim.maxGasLimit)) bad(`gasLimit ${tx.gasLimit} exceeds maxGasLimit ${lim.maxGasLimit}`);
  const capWei = gweiToWei(lim.maxGasPriceGwei);
  if (typeof tx.maxFeePerGas !== "bigint" || tx.maxFeePerGas <= 0n || tx.maxFeePerGas > capWei) bad(`maxFeePerGas ${tx.maxFeePerGas} exceeds maxGasPriceGwei ${lim.maxGasPriceGwei}`);
  if (typeof tx.maxPriorityFeePerGas !== "bigint" || tx.maxPriorityFeePerGas <= 0n || tx.maxPriorityFeePerGas > tx.maxFeePerGas) bad("maxPriorityFeePerGas is not in (0, maxFeePerGas]");
  if (tx.maxPriorityFeePerGas > gweiToWei(lim.maxPriorityFeeGwei)) bad(`maxPriorityFeePerGas ${tx.maxPriorityFeePerGas} exceeds maxPriorityFeeGwei ${lim.maxPriorityFeeGwei}`);
  if (Number(tx.chainId) !== BASE_CHAIN_ID) bad(`chainId ${tx.chainId} is not ${BASE_CHAIN_ID}`);
  let d;
  try { d = COLLECT_IFACE.parseTransaction({ data: tx.data, value: 0n }); } catch { d = null; }
  if (!d || d.name !== "collect") bad("calldata is not collect");
  const a = d.args[0];
  if (BigInt(a.tokenId) !== BigInt(expect.tokenId)) bad(`calldata tokenId ${a.tokenId} is not ${expect.tokenId}`);
  if (String(a.recipient).toLowerCase() !== String(expect.owner).toLowerCase()) bad(`calldata recipient ${a.recipient} is not the checked owner ${expect.owner}`);
  if (BigInt(a.amount0Max) !== MAX128 || BigInt(a.amount1Max) !== MAX128) bad("calldata amounts are not the uint128 maximum");
}

/** The L1 data-fee allowance: max(2 x oracle quote, minL1AllowanceEth). An estimate, not a hard bound. */
function l1Allowance(quoteWei, lim) {
  const twice = BigInt(quoteWei) * 2n, floor = ethToWei(lim.minL1AllowanceEth);
  return twice > floor ? twice : floor;
}

/**
 * What a receipt costs, always within [0, reservation]. A gasUsed that is not a number, negative or above the
 * gas limit (a lying RPC) counts the full worst case; the price is clamped to [0, maxFee] (negative or not a number: maxFee).
 */
function settledWei({ gasUsed, price, gasLimit, maxFeePerGas, l1AllowanceWei, worstCaseWei }) {
  let gu;
  try { gu = BigInt(gasUsed); } catch { return worstCaseWei; }
  if (gu < 0n || gu > gasLimit) return worstCaseWei;
  let p;
  try { p = BigInt(price); } catch { p = maxFeePerGas; }
  if (p < 0n || p > maxFeePerGas) p = maxFeePerGas;
  const paid = gu * p + l1AllowanceWei;
  return paid > worstCaseWei ? worstCaseWei : paid;
}

/** The gas counted against the rolling 24 h cap: entries younger than 24 h, plus every unsettled (unknown) one at any age. Does not mutate. */
function spentWindowWei(state, nowMs = Date.now()) {
  const cutoff = nowMs - DAY_MS;
  return (state.gasSpends || []).reduce((acc, e) => (e.kind === "unknown" || e.t > cutoff ? acc + BigInt(e.wei) : acc), 0n);
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
 * May one more transaction be sent? Checks, in order: the per-run count, the per-transaction cap, the per-run
 * gas cap (spent so far + this worst case) and the rolling 24 h cap (state, reservations included).
 *   worstCaseWei  gasLimit x maxFeePerGas + the L1 allowance: the most this transaction can cost as signed
 *   sentCount     collects sent so far this run
 *   spentRunWei   gas counted so far this run
 *   spent24hWei   gas counted in the trailing 24 h, this run included
 */
function capCheck({ lim, worstCaseWei, sentCount, spentRunWei, spent24hWei }) {
  if (sentCount >= lim.maxCollectsPerRun) return { ok: false, cap: "maxCollectsPerRun", reason: `maxCollectsPerRun ${lim.maxCollectsPerRun} reached` };
  const worst = ethers.formatEther(worstCaseWei);
  const txCap = ethToWei(lim.maxGasPerTxEth);
  if (worstCaseWei > txCap) return { ok: false, cap: "maxGasPerTxEth", reason: `maxGasPerTxEth ${lim.maxGasPerTxEth} ETH would be exceeded (worst case ${worst} ETH)` };
  const runCap = ethToWei(lim.maxGasPerRunEth);
  if (!cl.budgetAllows({ spentWei: spentRunWei, capWei: runCap, estimateWei: worstCaseWei })) {
    return { ok: false, cap: "maxGasPerRunEth", reason: `maxGasPerRunEth ${lim.maxGasPerRunEth} ETH would be exceeded (spent ${ethers.formatEther(spentRunWei)} + worst case ${worst} ETH)` };
  }
  const dayCap = ethToWei(lim.dailyGasCapEth);
  if (!cl.budgetAllows({ spentWei: spent24hWei, capWei: dayCap, estimateWei: worstCaseWei })) {
    return { ok: false, cap: "dailyGasCapEth", reason: `24 h gas cap ${lim.dailyGasCapEth} ETH would be exceeded (spent ${ethers.formatEther(spent24hWei)} + worst case ${worst} ETH)` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// state.json: the 24 h budget. Fails closed on anything it cannot read; written atomically.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Read and validate the state file. { ok:true, state:{gasSpends} } | { ok:false, kind:"missing"|"corrupt", reason, file }.
 * The file is never touched here. `fsm` is injectable for tests.
 */
function readState(file, fsm = fs) {
  let text;
  try { text = fsm.readFileSync(file, "utf8"); } catch (err) {
    if (err && err.code === "ENOENT") return { ok: false, kind: "missing", reason: "file does not exist", file };
    return { ok: false, kind: "corrupt", reason: `cannot be read: ${(err && (err.code || err.message)) || err}`, file };
  }
  const corrupt = (reason) => ({ ok: false, kind: "corrupt", reason, file });
  let j;
  try { j = JSON.parse(text); } catch (err) { return corrupt(`not valid JSON (${String(err.message).slice(0, 80)})`); }
  if (!j || typeof j !== "object" || Array.isArray(j)) return corrupt("not a JSON object");
  if (j.version !== undefined && j.version !== STATE_VERSION) return corrupt(`unknown version ${JSON.stringify(j.version)}`);
  if (!Array.isArray(j.gasSpends)) return corrupt("gasSpends is not an array");
  for (const [i, e] of j.gasSpends.entries()) {
    if (!e || typeof e !== "object" || typeof e.t !== "number" || !Number.isFinite(e.t) || e.t < 0) return corrupt(`gasSpends[${i}].t is not a timestamp`);
    if (typeof e.wei !== "string" || !/^\d+$/.test(e.wei)) return corrupt(`gasSpends[${i}].wei is not a non-negative decimal string`);
  }
  return { ok: true, state: { gasSpends: j.gasSpends } };
}

/** The text of a state file: version 1, entries older than 7 days dropped (unsettled "unknown" ones are kept until settled). */
function serializeState(state, nowMs = Date.now()) {
  const keep = (Array.isArray(state && state.gasSpends) ? state.gasSpends : []).filter((e) => e && (e.kind === "unknown" || e.t > nowMs - STATE_KEEP_MS));
  return JSON.stringify({ version: STATE_VERSION, gasSpends: keep }, null, 2) + "\n";
}

/** Write `text` to `file` via a same-directory tmp file: write, fsync, rename. On any error the tmp is removed and the error thrown. */
function writeFileAtomic(file, text, fsm = fs) {
  const tmp = `${file}.${process.pid}.tmp`;
  let fd = null;
  try {
    fd = fsm.openSync(tmp, "w", 0o600);
    fsm.writeFileSync(fd, text);
    fsm.fsyncSync(fd);
    fsm.closeSync(fd); fd = null;
    fsm.renameSync(tmp, file);
    // make the rename itself durable: fsync the directory (not supported everywhere: ignore those errors)
    let dfd = null;
    try { dfd = fsm.openSync(path.dirname(file), "r"); fsm.fsyncSync(dfd); } catch (err) {
      if (!err || !["EISDIR", "EINVAL", "EPERM", "ENOTSUP"].includes(err.code)) throw err;
    } finally { if (dfd !== null) { try { fsm.closeSync(dfd); } catch { /* nothing to close */ } } }
  } catch (err) {
    if (fd !== null) { try { fsm.closeSync(fd); } catch { /* already closed */ } }
    try { fsm.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ }
    throw err;
  }
}

/** Create an empty state file only if none exists (never overwrites). Returns "created" or "exists". */
function initStateFile(file, fsm = fs) {
  const text = serializeState({ gasSpends: [] });
  const tmp = `${file}.${process.pid}.init.tmp`;
  try {
    fsm.writeFileSync(tmp, text, { mode: 0o600 });
    try { fsm.linkSync(tmp, file); return "created"; } catch (err) {
      if (err && err.code === "EEXIST") return "exists";
      // a filesystem without hard links: exclusive create instead (still never overwrites)
      try { fsm.writeFileSync(file, text, { mode: 0o600, flag: "wx" }); return "created"; } catch (e2) {
        if (e2 && e2.code === "EEXIST") return "exists";
        throw e2;
      }
    }
  } finally { try { fsm.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ } }
}

module.exports = {
  BASE_CHAIN_ID, ALLOWED_MANAGERS, DEFAULTS, DEFAULT_PRIORITY_WEI, L1_ORACLE, STATE_VERSION,
  limits, owners, managers, gasCostUsd, decide, capCheck, usd, gweiToWei, ethToWei,
  buildFees, assertSignable, l1Allowance, settledWei, spentWindowWei, readState, serializeState, writeFileAtomic, initStateFile,
};
