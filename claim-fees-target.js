/**
 * Read-only facts for the "Claim fees" button: which manager, who owns the NFT, what a collect
 * would return now. Pure and provider-injected. It builds no transaction: the answer has no
 * `to`, no calldata. The browser wallet builds and signs; this server never does.
 *
 * The manager comes ONLY from the settings entry named by `protocol` (the allowlist is exactly
 * cfg.contracts.slipstream). Query parameters other than protocol and id are never read. The id
 * must be a position already in the server's payload (the main or a watched wallet).
 */
"use strict";
const { ethers } = require("ethers");
const u = require("./univ3");
const { redactText } = require("./endpoint");

const NPM_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
];
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;
const fail = (status, error) => ({ status, body: { ok: false, error } });
const asNumber = (raw, decimals) => Number(ethers.formatUnits(raw, decimals));

/**
 * @param {object} a
 * @param {object} a.cfg        flat settings (cfg.contracts.slipstream, chainId, chainName, explorer)
 * @param {object} a.provider   ethers provider or runner
 * @param {object[]} a.positions every Slipstream position of the current payload (main and watched wallets)
 * @param {string} a.protocol   settings name, e.g. aerodrome-v1
 * @param {string} a.id         digits
 * @param {string} [a.chainName]
 * @returns {Promise<{status:number, body:object}>}
 */
async function resolveTarget({ cfg, provider, positions, protocol, id, chainName }) {
  if (typeof protocol !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(protocol)) return fail(400, "protocol is required");
  if (typeof id !== "string" || !/^\d{1,78}$/.test(id) || BigInt(id) > MAX_UINT256) return fail(400, "id must be a token id (digits)");
  const spec = ((cfg.contracts && cfg.contracts.slipstream) || []).find((s) => s && s.name === protocol && s.positionManager);
  if (!spec) return fail(404, "unknown protocol");
  const pos = (positions || []).find((p) => p && p.protocol === protocol && String(p.nftId) === id);
  if (!pos) return fail(404, "that position is not in this dashboard's current view");
  let manager;
  try { manager = ethers.getAddress(spec.positionManager); } catch { return fail(500, "the configured manager is not an address"); }
  const tokenId = BigInt(id);
  const npm = new ethers.Contract(manager, NPM_ABI, provider);
  let owner;
  try { owner = ethers.getAddress(await npm.ownerOf(tokenId)); } catch (err) { return fail(502, `ownerOf failed: ${redactText(err.shortMessage || err.message)}`); }
  const base = {
    ok: true, chainId: Number(cfg.chainId), chainName: chainName || cfg.chainName || null, explorer: cfg.explorer || null,
    manager, tokenId: id, owner, protocol,
    symbol0: pos.symbol0 || null, symbol1: pos.symbol1 || null, pair: pos.pair || null,
  };
  const staked = !!pos.staked || (pos.gauge && owner.toLowerCase() === String(pos.gauge).toLowerCase());
  if (staked) return { status: 200, body: { ...base, staked: true, fee0: 0, fee1: 0, feesUsd: null, feesOk: false } };
  let t0, t1;
  try { [t0, t1] = await Promise.all([u.getToken(pos.token0, provider), u.getToken(pos.token1, provider)]); } catch { t0 = null; }
  if (!t0 || !t1 || t0.decimalsOk !== true || t1.decimalsOk !== true) return { status: 200, body: { ...base, staked: false, fee0: 0, fee1: 0, feesUsd: null, feesOk: false, feesError: "token decimals were not read from the chain" } };
  const out = { ...base, staked: false, decimals0: t0.decimals, decimals1: t1.decimals };
  try {
    const res = await npm.collect.staticCall({ tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }, { from: owner });
    out.fee0 = asNumber(res[0], t0.decimals); out.fee1 = asNumber(res[1], t1.decimals);
    out.fee0Raw = res[0].toString(); out.fee1Raw = res[1].toString();
    out.feesUsd = pos.usd0 != null && pos.usd1 != null ? out.fee0 * pos.usd0 + out.fee1 * pos.usd1 : null;
    out.feesOk = true;
  } catch (err) {
    out.fee0 = 0; out.fee1 = 0; out.feesUsd = null; out.feesOk = false;
    out.feesError = redactText(err.shortMessage || err.message);
  }
  return { status: 200, body: out };
}

/**
 * Wraps resolveTarget with a short per-(protocol,id) cache of successful answers and in-flight dedupe, so a
 * burst of requests costs at most one ownerOf plus one collect.staticCall pair. Failures are never cached.
 */
function cached(resolve, { ttlMs = 12000, now = Date.now, max = 200 } = {}) {
  const done = new Map(), flying = new Map();
  return async function (args) {
    const { protocol, id } = args;
    if (typeof protocol !== "string" || typeof id !== "string" || protocol.length > 40 || id.length > 78) return resolve(args);
    const key = `${protocol}\n${id}`;
    const hit = done.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.r;
    if (flying.has(key)) return flying.get(key);
    const p = resolve(args).then((r) => {
      if (r && r.status === 200) { if (done.size >= max) done.delete(done.keys().next().value); done.set(key, { at: now(), r }); }
      return r;
    }).finally(() => { flying.delete(key); });
    flying.set(key, p);
    return p;
  };
}

module.exports = { resolveTarget, cached };
