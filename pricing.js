/**
 * pricing.js -- how a position's tokens and the unit of account are valued in USD.
 * Lives apart from server.js so the tests exercise the code the server runs, not a copy.
 *
 *   makePriceSides({ weth, stable })  -> priceSides(p, wethUsd)
 *   makeGetWethUsd({ cfg, unit, factory, provider, u }) -> getWethUsd(blockTag)
 *     reads the reference pool for cfg.usdReference ({ stable, feeTier }): the pool
 *     factory.getPool(weth, stable, feeTier), so fee tier 3000 selects the fee-3000 pool.
 */
"use strict";
const { ethers } = require("ethers");

function makePriceSides({ weth, stable }) {
  const WETH = String(weth || "").toLowerCase();
  const STABLE = String(stable || "").toLowerCase();
  /**
   * Price each side in USD. A token gets a price when its pool pairs it with
   * WETH (or the reference stable); anything else is left null rather than guessed at.
   */
  return function priceSides(p, wethUsd) {
    const a0 = p.token0.address.toLowerCase(), a1 = p.token1.address.toLowerCase();
    // Native ETH (v4 pools) is priced as WETH.
    const t0IsWeth = a0 === WETH || a0 === ethers.ZeroAddress;
    const t1IsWeth = a1 === WETH || a1 === ethers.ZeroAddress;
    if (wethUsd == null) return { usd0: null, usd1: null };

    if (t1IsWeth) return { usd0: p.prices.current * wethUsd, usd1: wethUsd };
    if (t0IsWeth) return { usd0: wethUsd, usd1: (1 / p.prices.current) * wethUsd };
    // Pairs against the reference stable: take it at a dollar.
    if (STABLE && a1 === STABLE) return { usd0: p.prices.current, usd1: 1 };
    if (STABLE && a0 === STABLE) return { usd0: 1, usd1: 1 / p.prices.current };
    return { usd0: null, usd1: null };
  };
}

/**
 * The unit of account's price in USD, read from a reference stable pool's slot0.
 * When the unit is itself a dollar (unit.usdRate, e.g. Arc's USDC) there is nothing
 * to look up and no pool to depend on.
 */
function makeGetWethUsd({ cfg, unit, factory, provider, u }) {
  const V2_PAIR_ABI = ["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)"];
  /**
   * USD per unit token from a v2 pair's reserves: reserveStable / reserveWeth, decimals-adjusted, the
   * stable taken at a dollar. Null (unpriced, never a guess) when the pair is not exactly weth/stable,
   * a side's decimals were not read, or the stable side holds less than ref.minLiquidityUsd.
   */
  async function v2ReferenceRate(ref, blockTag) {
    try {
      const o = blockTag != null ? { blockTag } : {};
      const pair = new ethers.Contract(ref.pair, V2_PAIR_ABI, provider);
      const [t0, t1, res] = await Promise.all([pair.token0(o), pair.token1(o), pair.getReserves(o)]);
      const w = cfg.contracts.weth.toLowerCase(), s = ref.stable.toLowerCase();
      const a0 = t0.toLowerCase(), a1 = t1.toLowerCase();
      if (!((a0 === w && a1 === s) || (a0 === s && a1 === w))) return null;
      const [tw, ts] = await Promise.all([u.getToken(cfg.contracts.weth, provider), u.getToken(ref.stable, provider)]);
      if (!tw || tw.decimalsOk !== true || !ts || ts.decimalsOk !== true) return null;
      const rw = a0 === w ? res[0] : res[1], rs = a0 === w ? res[1] : res[0];
      const stableAmt = Number(ethers.formatUnits(rs, ts.decimals)), wethAmt = Number(ethers.formatUnits(rw, tw.decimals));
      const min = Number(ref.minLiquidityUsd) >= 0 && ref.minLiquidityUsd != null ? Number(ref.minLiquidityUsd) : 1000;
      if (!(wethAmt > 0) || !(stableAmt > 0) || stableAmt < min) return null;
      return stableAmt / wethAmt;
    } catch {
      return null;
    }
  }
  return async function getWethUsd(blockTag) {
    if (unit && unit.usdRate != null) return Number(unit.usdRate);
    const ref = cfg.usdReference;
    if (!ref || !ref.stable || !cfg.contracts.weth) return null;
    // A chain with no Uniswap v3 stable pool (PulseChain: PulseX is Uniswap-v2 style) names the v2
    // pair to read instead: tokens.usdReferencePair. Chains without it never reach this branch.
    if (ref.pair) return v2ReferenceRate(ref, blockTag);
    try {
      const poolAddr = await factory.getPool(cfg.contracts.weth, ref.stable, ref.feeTier);
      if (poolAddr === ethers.ZeroAddress) return null;

      const pool = new ethers.Contract(poolAddr, u.POOL_ABI, provider);
      const slot0 = await pool.slot0(blockTag != null ? { blockTag } : {});
      const [t0, t1] = await Promise.all([
        u.getToken(cfg.contracts.weth, provider),
        u.getToken(ref.stable, provider),
      ]);

      // Pool orders tokens by address; work out which side WETH landed on.
      const wethIsToken0 = cfg.contracts.weth.toLowerCase() < ref.stable.toLowerCase();
      const d0 = wethIsToken0 ? t0.decimals : t1.decimals;
      const d1 = wethIsToken0 ? t1.decimals : t0.decimals;
      const p = u.priceFromSqrt(slot0.sqrtPriceX96, d0, d1);
      return wethIsToken0 ? p : 1 / p;
    } catch {
      return null;
    }
  };
}

module.exports = { makePriceSides, makeGetWethUsd };
