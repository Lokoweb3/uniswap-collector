/**
 * The opening basis of a position: what capital went in, recorded once and read
 * back for as long as the position lives.
 *
 * It has to survive a bad metadata read. Arc's USDC exposes an 18-decimal native
 * interface and a 6-decimal ERC-20 interface over one balance, and a refresh that
 * resolved 18 for a 6-decimal token wrote an opening amount 10^12 too small. That
 * value was then frozen in the ledger and divided into every return figure, which
 * is how position #27627 came to report a fee APR of 2,498,656,364,155,007%.
 *
 * Two defences, and neither is a cap on the output:
 *   - record raw integer amounts with the decimals, chain and token addresses
 *     used to read them, so nothing derived is stored and a later mismatch is
 *     detectable;
 *   - refuse to use a record that cannot be true, and say why, rather than
 *     dividing by it.
 */
"use strict";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RAW = /^[0-9]+$/;

/** Is the token metadata solid enough to record a basis against? */
function metadataOk(token) {
  if (!token) return { ok: false, why: "no token metadata" };
  if (!ADDRESS.test(String(token.address || ""))) {
    return { ok: false, why: `token address ${JSON.stringify(token.address)} is not an address` };
  }
  // Provenance first: "not read" is the useful answer, and a failed read now
  // carries decimals null, which would otherwise be reported only as a bad shape.
  if (token.decimalsOk !== true) {
    return {
      ok: false,
      why: `decimals for ${token.symbol || token.address} were not read from the chain` +
        (token.decimalsError ? ` (${token.decimalsError})` : " (no successful decimals() call)"),
    };
  }
  const d = token.decimals;
  if (!Number.isInteger(d) || d < 0 || d > 36) {
    return { ok: false, why: `decimals ${JSON.stringify(d)} for ${token.symbol || token.address} are not a usable integer` };
  }
  return { ok: true };
}

/**
 * Build the record to store. Returns null when the metadata is not trustworthy,
 * so the caller leaves the basis unrecorded and tries again next refresh — an
 * absent basis is recoverable, a wrong one is not.
 */
function buildRecord({ chainId, token0, token1, raw0, raw1, liquidity, blockNumber, now = Date.now() }) {
  const m0 = metadataOk(token0), m1 = metadataOk(token1);
  if (!m0.ok) return { record: null, why: m0.why };
  if (!m1.ok) return { record: null, why: m1.why };
  if (!RAW.test(String(raw0)) || !RAW.test(String(raw1))) {
    return { record: null, why: "raw amounts are not integers" };
  }
  if (chainId == null) return { record: null, why: "the chain id is unknown" };
  return {
    record: {
      v: 2,
      t: now,
      block: blockNumber == null ? null : Number(blockNumber),
      chainId: Number(chainId),
      token0: String(token0.address).toLowerCase(),
      token1: String(token1.address).toLowerCase(),
      dec0: token0.decimals,
      dec1: token1.decimals,
      raw0: String(raw0),
      raw1: String(raw1),
      liquidity: liquidity == null ? null : String(liquidity),
    },
    why: null,
  };
}

const toFloat = (raw, dec) => Number(raw) / Math.pow(10, dec);

/**
 * Read a stored record back, refusing anything that cannot be true.
 *
 * Returns { ok, reason, a0, a1, legacy, liquidityChanged }.
 *
 * The sub-raw-unit rule is one check among several, not a proof of correctness:
 * a non-zero leg smaller than a single raw unit of its own token cannot have come
 * from a real deposit, because chains cannot move a fraction of a raw unit. A leg
 * that is exactly zero is legitimate — one-sided positions are ordinary — and a
 * leg that passes the rule is not thereby verified, only not caught by it.
 */
function readRecord(stored, { chainId, token0, token1, liquidity } = {}) {
  if (!stored) return { ok: false, reason: "no opening basis has been recorded yet" };

  if (stored.v === 2) {
    if (chainId != null && Number(stored.chainId) !== Number(chainId)) {
      return { ok: false, reason: `the basis was recorded on chain ${stored.chainId}, this instance is on ${chainId}` };
    }
    for (const [side, want, got] of [["token0", token0, stored.token0], ["token1", token1, stored.token1]]) {
      if (want && want.address && String(want.address).toLowerCase() !== String(got)) {
        return { ok: false, reason: `the basis recorded ${side} as ${got}, the position now reports ${String(want.address).toLowerCase()}` };
      }
    }
    for (const [side, want, got] of [["token0", token0, stored.dec0], ["token1", token1, stored.dec1]]) {
      if (want && Number.isInteger(want.decimals) && want.decimals !== got) {
        return { ok: false, reason: `the basis recorded ${side} with ${got} decimals, the position now reports ${want.decimals}` };
      }
    }
    if (!RAW.test(String(stored.raw0)) || !RAW.test(String(stored.raw1))) {
      return { ok: false, reason: "the stored raw amounts are not integers" };
    }
    return {
      ok: true, legacy: false,
      a0: toFloat(stored.raw0, stored.dec0),
      a1: toFloat(stored.raw1, stored.dec1),
      liquidityChanged: liquidityChanged(stored.liquidity, liquidity),
    };
  }

  // Legacy v1: { t, a0, a1 } — already-converted floats, with nothing recorded
  // about how they were converted. Cannot be verified, only sanity-checked.
  const a0 = Number(stored.a0), a1 = Number(stored.a1);
  if (!Number.isFinite(a0) || !Number.isFinite(a1)) {
    return { ok: false, reason: "the stored opening amounts are not numbers" };
  }
  if (a0 < 0 || a1 < 0) return { ok: false, reason: "the stored opening amounts are negative" };
  for (const [side, amount, token] of [["token0", a0, token0], ["token1", a1, token1]]) {
    if (amount === 0) continue;                       // a one-sided open is ordinary
    const dec = token && Number.isInteger(token.decimals) ? token.decimals : null;
    if (dec == null) continue;                        // nothing to check against
    const oneRawUnit = Math.pow(10, -dec);
    if (amount < oneRawUnit) {
      return {
        ok: false,
        reason: `the recorded opening ${side} amount ${amount} is smaller than one raw unit of ` +
          `${(token && token.symbol) || "the token"} (1e-${dec}), which no real deposit can be — ` +
          "the record predates decimals being stored and looks mis-scaled",
      };
    }
  }
  return { ok: true, legacy: true, a0, a1, liquidityChanged: liquidityChanged(stored.liquidity, liquidity) };
}

function liquidityChanged(recorded, current) {
  if (recorded == null || current == null) return null;   // unknown, not "no"
  try { return BigInt(recorded) !== BigInt(current); } catch { return null; }
}

module.exports = { metadataOk, buildRecord, readRecord, toFloat };
