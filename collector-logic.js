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
function gasCapHit(state, capEth) {
  const cap = ethers.parseEther(String(capEth));
  return gasSpentLast24h(state) >= cap;
}

/* ---------------------------------------------------------------------------
 * Config decoding (pure; throws on a bad sweep target config, never reads fs)
 * --------------------------------------------------------------------------- */

/**
 * The ETH the operator keeps for gas. `keepGasReserveEth` is the floor it must
 * never sweep below; `gasTargetEth` (optional, >= the floor) is the float it
 * refills itself to out of collected fees before anything is swapped or sent.
 */
function gasFloat(cfg) {
  const reserve = ethers.parseEther(String(cfg.sweep.keepGasReserveEth || "0"));
  let target = cfg.sweep.gasTargetEth != null ? ethers.parseEther(String(cfg.sweep.gasTargetEth)) : reserve;
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
/**
 * Which pool to convert a fee token through, decided by what the pools quote.
 *
 * The collector used to take the tier from the position the fees were earned in.
 * That only works where the position and the swap live in the same place: a v4
 * position's fee (4%, 3.881%) is not a v3 tier, so on a v4 chain every quote failed
 * and the token was handed back unconverted. Worse, holding one pair in two tiers
 * made it refuse to swap at all rather than choose.
 *
 * So: quote every candidate and take the best output. An explicit override still
 * wins outright -- but it is quoted too, and reported when it cannot fill, because
 * silently falling back to a pool nobody chose is how a swap ends up somewhere
 * unexpected.
 *
 * `quote(fee)` returns the output amount for that tier, 0n or null when it cannot
 * be quoted. Returns { fee, out, source } or null when nothing can be quoted.
 */
const V3_FEE_TIERS = [100, 500, 3000, 10000];

async function pickSwapRoute({ tiers = V3_FEE_TIERS, override = null, positionFee = null, quote }) {
  const tried = [];
  const ask = async (fee, source) => {
    if (fee == null || tried.some((t) => t.fee === fee)) return null;
    let out = null;
    try { out = await quote(fee); } catch { out = null; }
    const row = { fee, out: out && out > 0n ? out : null, source };
    tried.push(row);
    return row.out ? row : null;
  };

  if (override != null) {
    const hit = await ask(Number(override), "override");
    // An override that cannot fill is reported, not quietly replaced: the whole
    // point of setting one is to pin the pool a swap goes through.
    return hit ? { ...hit, tried } : { fee: null, out: null, source: "override", failedOverride: Number(override), tried };
  }

  const candidates = [...tiers];
  // The position's own fee is worth trying when it happens to be a v3 tier, but it
  // is one candidate among others, never the answer on its own.
  if (positionFee != null && !candidates.includes(Number(positionFee))) candidates.push(Number(positionFee));
  for (const fee of candidates) await ask(fee, "quoted");
  const best = tried.filter((t) => t.out).sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0))[0];
  return best ? { ...best, tried } : null;
}

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

module.exports = {
  pickSwapRoute,
  V3_FEE_TIERS,
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
