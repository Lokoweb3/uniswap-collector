/**
 * Concentrated-liquidity positions on Slipstream-style DEXes (Aerodrome's CL
 * design; on Robinhood Chain, "up"), read-only, for the watched wallets.
 *
 * The maths is Uniswap v3's -- same ticks, same liquidity formula -- so amounts
 * come from univ3.js. Three things differ, and each is why the v3 reader cannot
 * simply be pointed at another manager:
 *
 *   positions() carries tickSpacing where v3 has the fee, and the factory looks a
 *   pool up by (token0, token1, tickSpacing).
 *   slot0() returns six fields, not seven (no feeProtocol).
 *   A position is usually STAKED: the NFT is deposited in the pool's gauge, which
 *   then owns it. The wallet's own NFT list shows only what is not staked. A
 *   staked position earns the gauge's reward token instead of trading fees (those
 *   go to voters), so its "fees" are rewards and are reported as such.
 *
 * Staked positions are found from the wallet's own NFT transfers out of the
 * manager (Blockscout), and from the gauges of pools the wallet still holds an
 * NFT in; each candidate gauge is confirmed on chain (its nft() is this manager)
 * and asked which ids it holds for the wallet. Nothing is sent: every call is a
 * view or a static call.
 *
 * These positions are kept apart from the Uniswap ones (watch.js puts them in
 * `external`, not `positions`): the collector, the guardian and the Sell tab act
 * on `positions`, and none of them can act on a gauge-held NFT.
 */
"use strict";
const { ethers } = require("ethers");
const u = require("./univ3");

const NPM_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
];
const FACTORY_ABI = ["function getPool(address,address,int24) view returns (address)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
  "function gauge() view returns (address)",
];
const GAUGE_ABI = [
  "function nft() view returns (address)",
  "function rewardToken() view returns (address)",
  "function stakedValues(address) view returns (uint256[])",
  "function earned(address,uint256) view returns (uint256)",
];
const V2_FACTORY_ABI = ["function getPool(address,address,bool) view returns (address)"];
const V2_POOL_ABI = ["function token0() view returns (address)", "function getReserves() view returns (uint256,uint256,uint256)"];

// A reward price read from a pool holding less than this much of its quote is a quote, not a value.
const MIN_QUOTE_USD = 100;
const MAX_OWNED = 50;     // wallet-held NFTs read per refresh, newest first
const GAUGE_TTL = 6 * 3600e3;

/**
 * spec: { name, positionManager, factory, poolFactory? } from settings.json
 * contracts.slipstream. bsFetch: blockscout.js's fetch, or null.
 */
function create({ provider, cfg, spec, priceSides, toFloat, bsFetch = null }) {
  const name = String(spec.name || "cl");
  const npmAddr = ethers.getAddress(spec.positionManager);
  const npm = new ethers.Contract(npmAddr, NPM_ABI, provider);
  const factory = new ethers.Contract(ethers.getAddress(spec.factory), FACTORY_ABI, provider);
  const v2 = spec.poolFactory ? new ethers.Contract(ethers.getAddress(spec.poolFactory), V2_FACTORY_ABI, provider) : null;
  const STABLE = cfg.usdReference && cfg.usdReference.stable ? cfg.usdReference.stable.toLowerCase() : null;
  const WETH = cfg.contracts && cfg.contracts.weth ? cfg.contracts.weth.toLowerCase() : null;
  const gauges = new Map();       // gauge address -> { ok, rewardToken, at }
  const rewardPrices = new Map(); // token -> { usd, at }

  /** A gauge of THIS manager, or null. Cached; a refused read is retried next time. */
  async function gaugeInfo(addr) {
    const key = addr.toLowerCase();
    const c = gauges.get(key);
    if (c && Date.now() - c.at < GAUGE_TTL) return c.ok ? c : null;
    const g = new ethers.Contract(addr, GAUGE_ABI, provider);
    try {
      const [nft, rewardToken] = await Promise.all([g.nft(), g.rewardToken()]);
      const ok = nft.toLowerCase() === npmAddr.toLowerCase();
      const info = { ok, address: ethers.getAddress(addr), rewardToken, at: Date.now() };
      gauges.set(key, info);
      return ok ? info : null;
    } catch {
      gauges.set(key, { ok: false, at: Date.now() }); // not a gauge (a wallet, a marketplace...)
      return null;
    }
  }

  /** Addresses the wallet sent this manager's NFTs to: the gauges it staked in, among others. */
  async function sentTo(wallet) {
    if (!bsFetch) return [];
    try {
      const r = await bsFetch(`/v2/addresses/${wallet}/token-transfers?type=ERC-721&filter=from&token=${npmAddr}`, { timeoutMs: 20000 });
      if (!r.ok) return [];
      const d = await r.json();
      const out = new Set();
      for (const i of d.items || []) {
        const to = i.to && i.to.hash;
        if (to && to !== ethers.ZeroAddress && i.token && String(i.token.address_hash || i.token.address || "").toLowerCase() === npmAddr.toLowerCase()) out.add(ethers.getAddress(to));
      }
      return [...out];
    } catch {
      return [];
    }
  }

  /** USD per reward token, from its classic pool against the stable (or WETH). Null when too thin or absent. */
  async function rewardUsd(token, wethUsd) {
    const key = token.toLowerCase();
    if (key === STABLE) return 1;
    if (key === WETH) return wethUsd;
    const c = rewardPrices.get(key);
    if (c && Date.now() - c.at < 10 * 60e3) return c.usd;
    let usd = null;
    for (const [quote, qUsd] of [[STABLE, 1], [WETH, wethUsd]]) {
      if (!v2 || !quote || qUsd == null) continue;
      try {
        const pool = await v2.getPool(token, quote, false);
        if (pool === ethers.ZeroAddress) continue;
        const p = new ethers.Contract(pool, V2_POOL_ABI, provider);
        const [t0, res] = await Promise.all([p.token0(), p.getReserves()]);
        const [tm, qm] = await Promise.all([u.getToken(token, provider), u.getToken(quote, provider)]);
        if (tm.decimalsOk !== true || qm.decimalsOk !== true) continue;
        const tokenIs0 = t0.toLowerCase() === key;
        const rt = toFloat(tokenIs0 ? res[0] : res[1], tm.decimals), rq = toFloat(tokenIs0 ? res[1] : res[0], qm.decimals);
        if (!(rt > 0) || rq * qUsd < MIN_QUOTE_USD) continue;
        usd = (rq / rt) * qUsd;
        break;
      } catch { /* next quote */ }
    }
    rewardPrices.set(key, { usd, at: Date.now() });
    return usd;
  }

  async function readPosition(id, wallet, gauge, wethUsd) {
    const pos = await npm.positions(id);
    if (pos.liquidity === 0n && pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n) return { closed: true };
    const [t0, t1] = await Promise.all([u.getToken(pos.token0, provider), u.getToken(pos.token1, provider)]);
    for (const [side, t] of [["token0", t0], ["token1", t1]]) {
      if (!t || t.decimalsOk !== true) throw new Error(`#${id}: ${side} decimals were not read from the chain, so this position cannot be valued`);
    }
    const poolAddress = await factory.getPool(pos.token0, pos.token1, pos.tickSpacing);
    if (poolAddress === ethers.ZeroAddress) throw new Error(`no pool for #${id}`);
    const slot0 = await new ethers.Contract(poolAddress, POOL_ABI, provider).slot0();
    const tickLower = Number(pos.tickLower), tickUpper = Number(pos.tickUpper), currentTick = Number(slot0.tick);
    const { amount0, amount1 } = u.getAmountsForLiquidity(slot0.sqrtPriceX96, u.getSqrtRatioAtTick(tickLower), u.getSqrtRatioAtTick(tickUpper), pos.liquidity);
    const p = {
      token0: t0, token1: t1,
      prices: {
        current: u.priceFromSqrt(slot0.sqrtPriceX96, t0.decimals, t1.decimals),
        lower: u.priceAtTick(tickLower, t0.decimals, t1.decimals),
        upper: u.priceAtTick(tickUpper, t0.decimals, t1.decimals),
      },
    };
    const { usd0, usd1 } = priceSides(p, wethUsd);
    const a0 = toFloat(amount0, t0.decimals), a1 = toFloat(amount1, t1.decimals);
    // Unstaked: trading fees accrue to the position, read as v3 does. Staked: they go
    // to the gauge's voters, and the position earns the gauge's reward instead.
    let f0 = 0, f1 = 0, feesOk = true, feesError = null, rewards = null;
    if (gauge) {
      const g = new ethers.Contract(gauge.address, GAUGE_ABI, provider);
      const rt = await u.getToken(gauge.rewardToken, provider);
      try {
        const raw = await g.earned(wallet, id);
        const amount = rt.decimalsOk === true ? toFloat(raw, rt.decimals) : null;
        const px = amount == null ? null : await rewardUsd(gauge.rewardToken, wethUsd);
        rewards = { token: gauge.rewardToken, symbol: rt.symbol, amount, usd: px == null || amount == null ? null : amount * px, priceUsd: px };
      } catch (err) {
        rewards = { token: gauge.rewardToken, symbol: rt.symbol, amount: null, usd: null, error: err.shortMessage || err.message };
      }
    } else {
      try {
        const res = await npm.collect.staticCall({ tokenId: id, recipient: wallet, amount0Max: u.MAX_UINT128, amount1Max: u.MAX_UINT128 }, { from: wallet });
        f0 = toFloat(res[0], t0.decimals); f1 = toFloat(res[1], t1.decimals);
      } catch (err) {
        feesOk = false; feesError = err.shortMessage || err.message;
      }
    }
    const priced = usd0 != null && usd1 != null;
    const span = tickUpper - tickLower, raw = (currentTick - tickLower) / span;
    return {
      protocol: name,
      tokenId: `${name}-${id}`,
      nftId: id.toString(),
      version: name,
      positionManager: npmAddr,
      staked: !!gauge,
      gauge: gauge ? gauge.address : null,
      rewards,
      pair: `${t0.symbol} / ${t1.symbol}`,
      symbol0: t0.symbol, symbol1: t1.symbol,
      token0: t0.address, token1: t1.address,
      tickSpacing: Number(pos.tickSpacing),
      feeTierLabel: `tick ${Number(pos.tickSpacing)}`,
      inRange: currentTick >= tickLower && currentTick < tickUpper,
      poolAddress,
      amount0: a0, amount1: a1, fee0: f0, fee1: f1, usd0, usd1,
      feesOk, feesError,
      valueUsd: priced ? a0 * usd0 + a1 * usd1 : null,
      feesUsd: priced ? f0 * usd0 + f1 * usd1 : null,
      priceCurrent: p.prices.current, priceLower: p.prices.lower, priceUpper: p.prices.upper,
      railPos: Math.max(0, Math.min(1, raw)), rawPos: raw,
      toUpperPct: (p.prices.upper / p.prices.current - 1) * 100,
      toLowerPct: (1 - p.prices.lower / p.prices.current) * 100,
      tickLower, tickUpper, currentTick,
      claimed: { status: "unavailable", reason: `the claim history covers Uniswap positions; this one is on ${name}` },
    };
  }

  /** Every open position the wallet holds on this DEX, staked or not. */
  async function positionsOf(wallet, wethUsd) {
    const errors = [];
    const owned = [];
    const n = Number(await npm.balanceOf(wallet));
    for (let i = Math.max(0, n - MAX_OWNED); i < n; i++) owned.push(await npm.tokenOfOwnerByIndex(wallet, i));
    // Candidate gauges: where the wallet sent its NFTs, and the gauges of the pools it still holds NFTs in.
    const cands = new Set(await sentTo(wallet));
    const poolsSeen = new Set();
    for (const id of owned.slice(-10)) {
      try {
        const pos = await npm.positions(id);
        const pool = await factory.getPool(pos.token0, pos.token1, pos.tickSpacing);
        if (pool !== ethers.ZeroAddress && !poolsSeen.has(pool)) {
          poolsSeen.add(pool);
          const g = await new ethers.Contract(pool, POOL_ABI, provider).gauge().catch(() => ethers.ZeroAddress);
          if (g !== ethers.ZeroAddress) cands.add(ethers.getAddress(g));
        }
      } catch { /* a gauge missed here can still come from the transfers */ }
    }
    const staked = [];
    for (const addr of cands) {
      const g = await gaugeInfo(addr);
      if (!g) continue;
      try {
        for (const id of await new ethers.Contract(g.address, GAUGE_ABI, provider).stakedValues(wallet)) staked.push({ id, gauge: g });
      } catch (err) {
        errors.push({ tokenId: `${name}-gauge`, error: `could not read the gauge ${g.address}: ${err.shortMessage || err.message}` });
      }
    }
    const positions = [];
    let closed = 0;
    for (const { id, gauge } of [...staked, ...owned.map((id) => ({ id, gauge: null }))]) {
      try {
        const p = await readPosition(id, wallet, gauge, wethUsd);
        if (p.closed) closed++;
        else positions.push(p);
      } catch (err) {
        errors.push({ tokenId: `${name}-${id}`, error: err.shortMessage || err.message });
      }
    }
    return { positions, closed, errors };
  }

  return { name, positionManager: npmAddr, positionsOf };
}

module.exports = { create };
