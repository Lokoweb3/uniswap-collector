/**
 * Pool statistics from the Robinhood LP pool scanner (the separate project on
 * port 3847, GeckoTerminal-backed): TVL, 24h volume and fees, fee APR, and the
 * sibling pools for the same pair, so a position card can show how its pool
 * compares. Cached for five minutes; when the scanner is down the payload
 * simply carries no pool stats.
 */
"use strict";
const { ethers } = require("ethers");

const SCANNER = process.env.LP_SCANNER_URL || "http://127.0.0.1:3847";
const TTL_MS = 5 * 60 * 1000;

function create({ cfg }) {
  const WETH = (cfg.contracts.weth || "").toLowerCase();
  let cache = { at: 0, byKey: new Map(), byPair: new Map(), asOf: null };
  let inFlight = null;

  // Native ETH and WETH are the same asset for pair matching.
  const norm = (a) => {
    const x = String(a || "").toLowerCase();
    return x === ethers.ZeroAddress || x === WETH ? "eth" : x;
  };
  const pairKey = (a, b) => [norm(a), norm(b)].sort().join("|");

  async function refresh() {
    if (Date.now() - cache.at < TTL_MS) return;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const r = await fetch(`${SCANNER}/api/pools`, { signal: AbortSignal.timeout(15000) });
        const j = await r.json();
        const byKey = new Map(), byPair = new Map();
        for (const p of j.pools || []) {
          if (!p.base || !p.quote) continue;
          const row = {
            key: p.key,
            version: p.version,
            name: p.name,
            feePct: p.feePct,
            tag: p.tag || null,
            tvl: p.tvl ?? null,
            vol24h: p.vol && p.vol.h24 != null ? p.vol.h24 : null,
            fees24h: p.fees24h ?? null,
            aprPct: p.apr24h ?? (p.fees24h != null && p.tvl > 0 ? (p.fees24h / p.tvl) * 365 * 100 : null),
            turnover: p.turnover ?? null,
            priceChange24h: p.priceChange && p.priceChange.h24 != null ? p.priceChange.h24 : null,
            stale: !!p.stale,
          };
          byKey.set(String(p.key).toLowerCase(), row);
          const pk = pairKey(p.base.address, p.quote.address);
          if (!byPair.has(pk)) byPair.set(pk, []);
          byPair.get(pk).push(row);
        }
        cache = { at: Date.now(), byKey, byPair, asOf: j.asOf || null };
      } catch {
        cache.at = Date.now() - TTL_MS + 60 * 1000; // retry in a minute, keep whatever we had
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** Stats for one position's pool plus its siblings (other pools of the same pair, best APR first). */
  function forPosition({ version, poolAddress, token0, token1 }) {
    if (!poolAddress) return null;
    const key = `v${version === 4 ? 4 : 3}:${String(poolAddress).toLowerCase()}`;
    const pool = cache.byKey.get(key) || null;
    const all = token0 && token1 ? cache.byPair.get(pairKey(token0, token1)) || [] : [];
    const siblings = all
      .filter((r) => r.key.toLowerCase() !== key && r.tvl > 1000)
      .sort((a, b) => (b.aprPct || 0) - (a.aprPct || 0))
      .slice(0, 5);
    if (!pool && !siblings.length) return null;
    return { ...(pool || { key, missing: true }), siblings, asOf: cache.asOf };
  }

  return { refresh, forPosition, get available() { return cache.byKey.size > 0; } };
}

module.exports = { create };
