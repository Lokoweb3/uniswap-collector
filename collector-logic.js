"use strict";
/**
 * collector-logic.js — the pure, testable decision logic lifted out of collector.js.
 *
 * Everything here is pure: no RPC, no signer, no fs, no network. The collector and
 * its tests share these exact functions, so the eligibility threshold, the
 * "could not quote" hand-back, the gas budget, the sweep-target / gas-float
 * config decoding and the per-pass balance deltas are all covered by tests
 * without a live chain.
 */
const { ethers } = require("ethers");

/* ---------------------------------------------------------------------------
 * Rolling 24h gas budget
 * --------------------------------------------------------------------------- */

/**
 * The gas (wei) spent in the trailing 24 h, pruning older entries from `state`
 * in place (same prune-then-sum the collector already did). Returns a BigInt.
 */
function gasSpentLast24h(state) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  state.gasSpends = state.gasSpends.filter((s) => s.t > cutoff);
  return state.gasSpends.reduce((acc, s) => acc + BigInt(s.wei), 0n);
}

/** The 24 h gas cap was reached (spent >= cap). Pure threshold comparison. */
function gasCapHit(state, capEth, cfg = null) {
  // The cap is an amount of the chain's native currency, so it is parsed in that
  // currency's decimals — 18 everywhere this runs today, but never assumed.
  const cap = ethers.parseUnits(String(capEth), nativeDecimals(cfg));
  return gasSpentLast24h(state) >= cap;
}

/**
 * Is there room in the 24-hour gas budget for one more transaction?
 *
 * Checking only what has already been spent lets the next transaction cross the
 * cap: the guard has to include a conservative estimate of what that transaction
 * will cost. `estimateWei` is gas units x gas price plus headroom, and the answer
 * is recomputed from recorded spend each time, so a run that has just paid for a
 * swap sees the smaller remaining budget before the next one.
 */
function budgetAllows({ spentWei, capWei, estimateWei }) {
  const spent = BigInt(spentWei), cap = BigInt(capWei), est = BigInt(estimateWei);
  return spent + est <= cap;
}
/** Conservative cost of a transaction of `gasUnits` at `gasPrice`, with headroom. */
function gasEstimate(gasUnits, gasPrice, headroomPct = 25) {
  return (BigInt(gasUnits) * BigInt(gasPrice) * BigInt(100 + headroomPct)) / 100n;
}
/** Rough gas units per kind of transaction this collector sends. */
const GAS_UNITS = { collect: 400000n, swap: 250000n, approve: 60000n, transfer: 80000n, wrap: 60000n, unwrap: 60000n };

/* ---------------------------------------------------------------------------
 * Config decoding (pure; throws on a bad sweep target config, never reads fs)
 * --------------------------------------------------------------------------- */

/**
 * The ETH the operator keeps for gas. `keepGasReserveEth` is the floor it must
 * never sweep below; `gasTargetEth` (optional, >= the floor) is the float it
 * refills itself to out of collected fees before anything is swapped or sent.
 */
function gasFloat(cfg) {
  const dec = nativeDecimals(cfg);
  const reserve = ethers.parseUnits(String(cfg.sweep.keepGasReserveEth || "0"), dec);
  let target = cfg.sweep.gasTargetEth != null ? ethers.parseUnits(String(cfg.sweep.gasTargetEth), dec) : reserve;
  if (target < reserve) target = reserve;
  return { reserve, target };
}

/** The sweep target: ETH (unwrap and send) or a stable token (swap and send). */
function sweepTarget(cfg) {
  const t = String((cfg.sweep && cfg.sweep.target) || "ETH").toUpperCase();
  if (t === "ETH") return { kind: "eth" };
  if (!cfg.sweep.targetToken || !cfg.sweep.targetFeeTier) {
    throw new Error(`sweep.target is ${t} but sweep.targetToken / sweep.targetFeeTier are not set`);
  }
  return { kind: "token", address: ethers.getAddress(cfg.sweep.targetToken), feeTier: Number(cfg.sweep.targetFeeTier), symbol: t };
}

/* ---------------------------------------------------------------------------
 * Eligibility threshold in WETH per position
 * --------------------------------------------------------------------------- */

/**
 * A position's collectable fees (as a WETH-value BigInt) cross the
 * minWethPerPosition threshold? Same comparison the collector applies when
 * deciding whether to queue a position for collection.
 */
function isPositionEligible(wethValue, minWethWei) {
  return wethValue >= minWethWei;
}

/* ---------------------------------------------------------------------------
 * "Could not quote" hand-back decision
 * --------------------------------------------------------------------------- */

/**
 * Should the fee token be handed back to the owner as-is instead of swapped?
 * True when there is no usable fee tier, or the fresh quote is zero (no v3 pool
 * / unquotable), or the quote exceeds the max-swap cap. Returns the reason
 * string (truthy => hand back) or null (swap it).
 */
function handBackReason({ feeTier, quotedWeth, maxSwapWeth }) {
  if (feeTier === undefined || feeTier === null) return "no known fee tier";
  if (quotedWeth === 0n) return "could not quote on a v3 pool";
  if (quotedWeth > maxSwapWeth) return "swap over maxSwapValueWeth";
  return null;
}

/* ---------------------------------------------------------------------------
 * Vault split maths (thin wrapper over treasury.split so tests need no fs)
 * --------------------------------------------------------------------------- */

/** Split a raw amount at `pct` percent; returns { toVault, toOwner }. */
function splitAmount(amountRaw, pct) {
  const bp = BigInt(Math.round(pct * 100)); // hundredths of a percent
  const toVault = (amountRaw * bp) / 10000n;
  return { toVault, toOwner: amountRaw - toVault };
}

/* ---------------------------------------------------------------------------
 * Per-pass balance deltas
 * --------------------------------------------------------------------------- */

/**
 * Only what THIS pass produced leaves the operator: balances above what the
 * wallet held when the pass started stay put (another owner's pass, or leftover
 * to sort out by hand). Returns the pass's share of the wallet's current token
 * balance, 0 when it holds nothing above the starting balance.
 */
function passDelta(beforeAmount, nowAmount) {
  return nowAmount > beforeAmount ? nowAmount - beforeAmount : 0n;
}

/**
 * ETH (gas-token) balance a pass may treat as its own, lifted EXACTLY from the
 * collector's sweep gate:
 *
 *     owner.main ? ethNow
 *                : (ethNow > before.eth ? ethNow : 0n)
 *
 * The MAIN wallet is always handed its whole current ETH balance (it owns the gas
 * and must never be emptied below its start point to a watched wallet); a WATCHED
 * owner is handed its balance only once it has grown above the pass-start balance
 * (i.e. this pass produced something), else 0. The two branches are NOT the same:
 * if the main wallet's ETH fell during the pass, it still gets `ethNow` back.
 */
function ethPassDelta(beforeEth, nowEth, main) {
  return main ? nowEth : (nowEth > beforeEth ? nowEth : 0n);
}

/**
 * The unit of account the fee thresholds are written in.
 *
 * `minWethPerPosition` and `maxSwapValueWeth` are amounts of `contracts.weth` —
 * the chain's unit of account, not always an 18-decimal WETH. On Arc it is USDC
 * with 6 decimals, so parsing those settings as ether made every position look
 * 1e12 times smaller than it is: nothing ever reached the threshold, and the
 * swap safety cap could never bite. The decimals come from the configured
 * numeraire; 18 when a chain does not declare one.
 */
function unitDecimals(cfg) {
  const d = cfg && cfg.numeraire && cfg.numeraire.decimals;
  return Number.isInteger(d) ? d : 18;
}
/** What to call that unit in the log ("WETH", "USDC", …). */
function unitLabel(cfg) {
  return (cfg && cfg.numeraire && cfg.numeraire.symbol) || "WETH";
}

/**
 * Decimals of the chain's NATIVE currency — what gas is paid in, and what every
 * `…Eth` setting is an amount of (minOperatorGasBalanceEth, dailyGasCapEth,
 * keepGasReserveEth, gasTargetEth).
 *
 * This is a different question from unitDecimals(): on Arc the native currency is
 * USDC with 18 decimals while the ERC-20 USDC the fees arrive in has 6, and the
 * two must never be parsed with the same scale. 18 when a chain does not declare
 * its native currency, which is what every EVM chain used here does.
 */
function nativeDecimals(cfg) {
  const d = cfg && cfg.nativeCurrency && cfg.nativeCurrency.decimals;
  return Number.isInteger(d) ? d : 18;
}
/** What to call the gas currency in the log ("ETH", "USDC", …). */
function nativeLabel(cfg) {
  return (cfg && cfg.nativeCurrency && cfg.nativeCurrency.symbol) || "ETH";
}


module.exports = {
  unitDecimals,
  unitLabel,
  nativeDecimals,
  nativeLabel,
  budgetAllows,
  gasEstimate,
  GAS_UNITS,
  gasSpentLast24h,
  gasCapHit,
  gasFloat,
  sweepTarget,
  isPositionEligible,
  handBackReason,
  splitAmount,
  passDelta,
  ethPassDelta,
};
