/**
 * Pool statistics from the Robinhood LP pool scanner (the separate project on
 * port 3847, GeckoTerminal-backed): TVL, 24h volume and fees, fee APR, and the
 * sibling pools for the same pair, so a position card can show how its pool
 * compares. Cached for five minutes; when the scanner is down the payload
 * simply carries no pool stats.
 */
"use strict";
const { ethers } = require("ethers");

const fs = require("fs");
const path = require("path");
const SCANNER = process.env.LP_SCANNER_URL || "http://127.0.0.1:3847";
const TTL_MS = 5 * 60 * 1000;
// Direct v4 pool reads (for pools the scanner has not indexed yet): fee-growth
// samples per pool are kept here so fees over the last 24h can be derived.
const SAMPLES_FILE = path.join(__dirname, "pool-samples.json");
const STATE_ABI = [
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
  "function getFeeGrowthGlobals(bytes32) view returns (uint256 feeGrowthGlobal0, uint256 feeGrowthGlobal1)",
];
const Q96 = 2n ** 96n, Q128 = 2n ** 128n;

function create({ cfg, provider }) {
  const WETH = (cfg.contracts.weth || "").toLowerCase();
  const stateView = provider && cfg.contracts.v4 && cfg.contracts.v4.stateView ? new ethers.Contract(cfg.contracts.v4.stateView, STATE_ABI, provider) : null;
  let samples = {};
  try {
    samples = JSON.parse(fs.readFileSync(SAMPLES_FILE, "utf8"));
  } catch {}
  const saveSamples = () => {
    try {
      fs.writeFileSync(SAMPLES_FILE, JSON.stringify(samples));
    } catch {}
  };
  const direct = new Map(); // poolId -> { at, row }

  /**
   * Pool statistics straight from the v4 PoolManager state, for a position
   * whose pool the scanner does not list. TVL is the virtual reserve of the
   * active liquidity at the current price (what a swap sees); fees come from
   * the growth of feeGrowthGlobal between samples taken on each call
   * (kept hourly, 3 days), scaled to 24h once an hour of history exists.
   */
  async function directV4({ poolId, token0, token1, usd0, usd1, decimals0, decimals1, feePct, symbol0, symbol1 }) {
    if (!stateView || !poolId) return null;
    const id = String(poolId).toLowerCase();
    const cached = direct.get(id);
    if (cached && Date.now() - cached.at < TTL_MS) return cached.row;
    const [L, slot0, growth] = await Promise.all([stateView.getLiquidity(poolId), stateView.getSlot0(poolId), stateView.getFeeGrowthGlobals(poolId)]);
    const sqrtP = slot0.sqrtPriceX96;
    if (L === 0n || sqrtP === 0n) return null;
    // Virtual reserves of the active liquidity: x = L * 2^96 / sqrtP, y = L * sqrtP / 2^96.
    const x = Number(ethers.formatUnits((L * Q96) / sqrtP, decimals0 || 18));
    const y = Number(ethers.formatUnits((L * sqrtP) / Q96, decimals1 || 18));
    const tvl = usd0 != null && usd1 != null ? x * usd0 + y * usd1 : null;
    // Fee samples.
    const now = Date.now();
    const hourKey = String(Math.floor(now / 3600000) * 3600000);
    const arr = (samples[id] = samples[id] || []);
    if (!arr.length || arr[arr.length - 1].h !== hourKey) {
      arr.push({ h: hourKey, t: now, g0: growth.feeGrowthGlobal0.toString(), g1: growth.feeGrowthGlobal1.toString(), L: L.toString() });
      while (arr.length > 72) arr.shift();
      saveSamples();
    }
    let fees24h = null, feesWindowH = null;
    const first = arr.find((s) => now - s.t <= 24 * 3600000) || arr[0];
    if (first && now - first.t >= 30 * 60000) {
      // Fees paid to the liquidity that was active, approximated with the current liquidity.
      const d0 = growth.feeGrowthGlobal0 - BigInt(first.g0), d1 = growth.feeGrowthGlobal1 - BigInt(first.g1);
      const f0 = Number(ethers.formatUnits((d0 * L) / Q128, decimals0 || 18));
      const f1 = Number(ethers.formatUnits((d1 * L) / Q128, decimals1 || 18));
      const hours = (now - first.t) / 3600000;
      feesWindowH = hours;
      if (usd0 != null && usd1 != null) fees24h = ((f0 * usd0 + f1 * usd1) / hours) * 24;
    }
    const row = {
      key: `v4:${id}`, version: "v4", name: `${symbol0} / ${symbol1} ${feePct != null ? feePct + "%" : ""}`.trim(), feePct: feePct ?? null, tag: null,
      tvl, vol24h: fees24h != null && feePct ? fees24h / (feePct / 100) : null, fees24h,
      aprPct: fees24h != null && tvl > 0 ? (fees24h / tvl) * 365 * 100 : null,
      turnover: null, priceChange24h: null, stale: false, direct: true, feesWindowH,
    };
    direct.set(id, { at: now, row });
    return row;
  }
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
  async function forPosition({ version, poolAddress, token0, token1, ...rest }) {
    if (!poolAddress) return null;
    const key = `v${version === 4 ? 4 : 3}:${String(poolAddress).toLowerCase()}`;
    let pool = cache.byKey.get(key) || null;
    if (!pool && version === 4) {
      try {
        pool = await directV4({ poolId: poolAddress, token0, token1, ...rest });
      } catch {}
    }
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
