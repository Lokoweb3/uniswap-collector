/**
 * Range advisor and IL forecast.
 *
 * For every open position (main and watched wallets) the pool's swaps are
 * replayed from the RPC's Swap events and folded into hourly buckets: the
 * fee-bearing input volume of each token, the closing sqrt price and the
 * average active liquidity. The scan walks backwards from the chain head in
 * 2000-block chunks under a per-tick budget and keeps its cursors, so the
 * window grows tick by tick up to seven days (advisor-cache.json).
 *
 * Range comparison (method, approximate by design): with the same capital the
 * position would have earned, in each hour whose closing price sits inside a
 * range, volume × fee tier × (position liquidity / pool active liquidity).
 * "Tighter" halves the tick width around the range's midpoint, "wider"
 * doubles it; the liquidity each alternative buys with today's capital comes
 * from the standard liquidity-for-amounts math at the current price. Fees over
 * a window shorter than seven days are scaled to seven.
 *
 * IL forecast: hourly closes give the realised volatility; the next seven days
 * are modelled as a lognormal price (drift 0), and the expected position value
 * minus the expected value of just holding today's token amounts is the
 * expected impermanent loss. Expected fees are the actual-range replay result.
 * The quote token (WETH / ETH / USDG when present, else token0) is assumed to
 * keep its USD price; only the pool price moves.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const u = require("./univ3");

const CACHE_FILE = path.join(__dirname, "advisor-cache.json");
const CHUNK = 2000;
const HOUR = 3600 * 1000;
const WINDOW_MS = 7 * 24 * HOUR;
const BLOCK_MS = 100; // Robinhood Chain: ~0.1 s blocks
const V3_SWAP = new ethers.Interface(["event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"]);
const V4_SWAP = new ethers.Interface(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]);

const abs = (x) => (x < 0n ? -x : x);

function create({ provider, cfg, log = console }) {
  const WETH = (cfg.contracts.weth || "").toLowerCase();
  const STABLE = ((cfg.usdReference && cfg.usdReference.stable) || "").toLowerCase();
  const POOL_MANAGER = cfg.contracts.v4 && cfg.contracts.v4.poolManager ? cfg.contracts.v4.poolManager : null;
  let state = { pools: {}, results: {}, at: 0 };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) };
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(state));
    } catch {}
  };
  const blockTimes = new Map();
  async function blockTime(n) {
    if (blockTimes.has(n)) return blockTimes.get(n);
    const b = await provider.getBlock(n);
    const t = b ? b.timestamp * 1000 : null;
    blockTimes.set(n, t);
    return t;
  }

  /** Fold swap logs into the pool's hourly buckets (keyed by hour ms). */
  function fold(pool, logs, iface, headTime, headBlock) {
    for (const l of logs) {
      let e;
      try {
        e = iface.parseLog(l);
      } catch {
        continue;
      }
      const t = headTime - (headBlock - l.blockNumber) * BLOCK_MS; // block time by offset; hourly resolution is all we need
      const h = String(Math.floor(t / HOUR) * HOUR);
      const b = (pool.buckets[h] = pool.buckets[h] || { in0: "0", in1: "0", liqSum: "0", n: 0, closeBlock: 0, sqrtClose: null });
      const a0 = BigInt(e.args.amount0), a1 = BigInt(e.args.amount1);
      if (a0 > 0n) b.in0 = (BigInt(b.in0) + a0).toString();
      if (a1 > 0n) b.in1 = (BigInt(b.in1) + a1).toString();
      b.liqSum = (BigInt(b.liqSum) + BigInt(e.args.liquidity)).toString();
      b.n++;
      if (l.blockNumber >= b.closeBlock) {
        b.closeBlock = l.blockNumber;
        b.sqrtClose = e.args.sqrtPriceX96.toString();
      }
    }
  }

  /**
   * Extend one pool's swap history backwards (and forwards to the head) under
   * a chunk budget. `key` is "v3:<pool address>" or "v4:<poolId>".
   */
  async function scanPool(key, maxChunks) {
    const [ver, id] = key.split(":");
    const pool = (state.pools[key] = state.pools[key] || { buckets: {}, newest: 0, oldest: 0 });
    const head = await provider.getBlockNumber();
    const headTime = (await blockTime(head)) || Date.now();
    const floorBlock = Math.max(0, head - Math.ceil(WINDOW_MS / BLOCK_MS));
    const filter = ver === "v4" ? { address: POOL_MANAGER, topics: [V4_SWAP.getEvent("Swap").topicHash, id] } : { address: id, topics: [V3_SWAP.getEvent("Swap").topicHash] };
    const iface = ver === "v4" ? V4_SWAP : V3_SWAP;
    let chunks = 0;
    // A busy pool (the WETH/USDG 0.01% pool sees ~1 swap per block) can make
    // the RPC refuse a 2000-block range; on an error the range is split in
    // half down to 250 blocks before giving up.
    const fetch = async (from, to) => {
      try {
        return await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
      } catch (err) {
        if (to - from + 1 <= 250) throw err;
        const mid = Math.floor((from + to) / 2);
        await new Promise((r) => setTimeout(r, 300));
        return [...(await fetch(from, mid)), ...(await fetch(mid + 1, to))];
      }
    };
    // Forward: from newest to head.
    if (pool.newest) {
      let from = pool.newest + 1;
      while (from <= head && chunks < maxChunks) {
        const to = Math.min(from + CHUNK - 1, head);
        fold(pool, await fetch(from, to), iface, headTime, head);
        pool.newest = to;
        from = to + 1;
        chunks++;
      }
    } else {
      pool.newest = head;
      pool.oldest = head + 1;
    }
    // Backward: from oldest down to the 7-day floor.
    while (pool.oldest - 1 >= floorBlock && chunks < maxChunks) {
      const to = pool.oldest - 1;
      const from = Math.max(floorBlock, to - CHUNK + 1);
      fold(pool, await fetch(from, to), iface, headTime, head);
      pool.oldest = from;
      chunks++;
    }
    // Drop buckets older than the window.
    const cutoff = Date.now() - WINDOW_MS - HOUR;
    for (const h of Object.keys(pool.buckets)) if (Number(h) < cutoff) delete pool.buckets[h];
    pool.coveredFrom = pool.oldest;
    pool.coveredTo = pool.newest;
    pool.hours = Object.keys(pool.buckets).length;
    pool.complete = pool.oldest <= floorBlock;
    pool.updatedAt = Date.now();
    return chunks;
  }

  // -- position math -----------------------------------------------------------

  /** Liquidity that `valueUsd` buys for the range at the current price. */
  function liquidityForValue(valueUsd, sqrtP, sqrtA, sqrtB, usd0, usd1, dec0, dec1) {
    const L = 10n ** 18n;
    const { amount0, amount1 } = u.getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, L);
    const per = Number(ethers.formatUnits(amount0, dec0)) * usd0 + Number(ethers.formatUnits(amount1, dec1)) * usd1;
    if (!(per > 0)) return 0n;
    return BigInt(Math.round((valueUsd / per) * 1e18)); // liquidity units: `per` is the value of 1e18 units
  }

  function valueAt(L, sqrtP, sqrtA, sqrtB, usd0, usd1, dec0, dec1) {
    const { amount0, amount1 } = u.getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, L);
    return Number(ethers.formatUnits(amount0, dec0)) * usd0 + Number(ethers.formatUnits(amount1, dec1)) * usd1;
  }

  /**
   * Fees a liquidity `L` would have earned inside [tickLower, tickUpper] over
   * the pool's buckets, in USD at today's prices, plus the covered hours.
   */
  function feesForRange(pool, L, tickLower, tickUpper, feeTier, usd0, usd1, dec0, dec1) {
    const sqrtA = u.getSqrtRatioAtTick(tickLower), sqrtB = u.getSqrtRatioAtTick(tickUpper);
    const fee = Number(feeTier) / 1e6;
    let usd = 0, hours = 0, inRangeHours = 0;
    for (const b of Object.values(pool.buckets)) {
      hours++;
      if (!b.sqrtClose || b.n === 0) continue;
      const sp = BigInt(b.sqrtClose);
      if (sp < sqrtA || sp >= sqrtB) continue;
      inRangeHours++;
      const poolL = BigInt(b.liqSum) / BigInt(b.n);
      if (poolL === 0n) continue;
      const share = Number((L * 10n ** 12n) / poolL) / 1e12;
      const f0 = Number(ethers.formatUnits(BigInt(b.in0), dec0)) * fee * usd0;
      const f1 = Number(ethers.formatUnits(BigInt(b.in1), dec1)) * fee * usd1;
      usd += (f0 + f1) * Math.min(share, 1);
    }
    return { usd, hours, inRangeHours };
  }

  /** Realised hourly volatility of the pool price from bucket closes (log returns). */
  function hourlyVol(pool) {
    const closes = Object.entries(pool.buckets)
      .filter(([, b]) => b.sqrtClose)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([, b]) => Number(BigInt(b.sqrtClose)) / Number(u.Q96));
    if (closes.length < 6) return null;
    const rets = [];
    for (let i = 1; i < closes.length; i++) if (closes[i] > 0 && closes[i - 1] > 0) rets.push(2 * Math.log(closes[i] / closes[i - 1])); // price = sqrt^2
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1);
    return Math.sqrt(varr);
  }

  /**
   * Expected 7-day impermanent loss of a position (USD, negative = loss),
   * lognormal price with hourly vol `sigmaH`, quote token USD price fixed.
   */
  function ilForecast({ L, sqrtP, tickLower, tickUpper, usd0, usd1, dec0, dec1, quoteIs0, sigmaH, days = 7 }) {
    if (!sigmaH || L === 0n) return null;
    const sqrtA = u.getSqrtRatioAtTick(tickLower), sqrtB = u.getSqrtRatioAtTick(tickUpper);
    // A lognormal expectation with very large sigma is dominated by its tail
    // (E[1/P] grows like exp(sigma^2)), so the 7-day volatility is capped at
    // 150 %: beyond that the number stops meaning anything.
    const rawSigma = sigmaH * Math.sqrt(days * 24);
    const sigma = Math.min(rawSigma, 1.5);
    const capped = rawSigma > 1.5;
    const { amount0, amount1 } = u.getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, L);
    const a0 = Number(ethers.formatUnits(amount0, dec0)), a1 = Number(ethers.formatUnits(amount1, dec1));
    let ePos = 0, eHold = 0, wsum = 0;
    for (let z = -3.5; z <= 3.5; z += 0.25) {
      const w = Math.exp(-0.5 * z * z);
      const ratio = Math.exp(sigma * z - 0.5 * sigma * sigma); // P_T / P_0, P = token1 per token0
      const sqrtT = BigInt(Math.round(Number(sqrtP) * Math.sqrt(ratio)));
      // Price moves: the non-quote token's USD price scales with the pool price.
      const usd0T = quoteIs0 ? usd0 : usd0 * ratio;
      const usd1T = quoteIs0 ? usd1 / ratio : usd1;
      const pos = valueAt(L, sqrtT, sqrtA, sqrtB, usd0T, usd1T, dec0, dec1);
      const hold = a0 * usd0T + a1 * usd1T;
      ePos += w * pos;
      eHold += w * hold;
      wsum += w;
    }
    return { ilUsd: ePos / wsum - eHold / wsum, sigma7d: sigma, sigmaRaw7d: rawSigma, capped, sigmaH };
  }

  /** Evaluate one position against its pool's buckets. */
  function evaluate(p, pool) {
    if (!pool || !pool.hours) return { status: "no data yet" };
    const dec0 = p.decimals0 ?? 18, dec1 = p.decimals1 ?? 18;
    if (p.usd0 == null || p.usd1 == null || !p.liquidity) return { status: "unpriced" };
    const L = BigInt(p.liquidity);
    const sqrtP = u.getSqrtRatioAtTick(p.currentTick);
    const width = p.tickUpper - p.tickLower;
    const mid = Math.round((p.tickUpper + p.tickLower) / 2);
    const ts = Number(p.tickSpacing || 1);
    const snap = (t) => Math.round(t / ts) * ts;
    const ranges = {
      actual: [p.tickLower, p.tickUpper],
      tighter: [snap(mid - width / 4), snap(mid + width / 4)],
      wider: [snap(mid - width), snap(mid + width)],
    };
    if (ranges.tighter[1] <= ranges.tighter[0]) ranges.tighter = [snap(mid - ts), snap(mid + ts)];
    const out = {};
    const scale = 168 / Math.max(1, Math.min(168, pool.hours)); // a window shorter than 7 days is scaled up to 7
    for (const [name, [a, b]] of Object.entries(ranges)) {
      const Lr = name === "actual" ? L : liquidityForValue(p.valueUsd, sqrtP, u.getSqrtRatioAtTick(a), u.getSqrtRatioAtTick(b), p.usd0, p.usd1, dec0, dec1);
      const f = feesForRange(pool, Lr, a, b, p.feeTier, p.usd0, p.usd1, dec0, dec1);
      out[name] = { tickLower: a, tickUpper: b, feesWindowUsd: f.usd, fees7dUsd: f.usd * scale, inRangeHours: f.inRangeHours, hours: f.hours };
    }
    const act = out.actual.fees7dUsd;
    const pct = (x) => (act > 0 ? ((x - act) / act) * 100 : null);
    out.tighter.vsActualPct = pct(out.tighter.fees7dUsd);
    out.wider.vsActualPct = pct(out.wider.fees7dUsd);
    let recommendation = "keep the current range";
    if (out.tighter.vsActualPct != null && out.tighter.vsActualPct >= 25) recommendation = "consider tightening";
    else if (out.wider.vsActualPct != null && out.wider.vsActualPct >= 25) recommendation = "consider widening";
    const sigmaH = hourlyVol(pool);
    const quoteIs0 = [WETH, STABLE, ethers.ZeroAddress].includes(String(p.token0 || "").toLowerCase());
    const il = ilForecast({ L, sqrtP, tickLower: p.tickLower, tickUpper: p.tickUpper, usd0: p.usd0, usd1: p.usd1, dec0, dec1, quoteIs0, sigmaH });
    const forecast = il ? { fees7dUsd: act, il7dUsd: il.ilUsd, net7dUsd: act + il.ilUsd, sigma7dPct: il.sigma7d * 100, sigmaRaw7dPct: il.sigmaRaw7d * 100, volCapped: il.capped, worthStaying: act + il.ilUsd >= 0 } : null;
    return {
      status: pool.complete ? "ok" : `partial (${pool.hours}h of 168h scanned)`,
      windowHours: pool.hours,
      ranges: out,
      recommendation,
      forecast,
    };
  }

  /**
   * Refresh: scan pools under the budget, evaluate every position. `positions`
   * carry: key (v3:addr / v4:poolId), tokenId, wallet, pair, liquidity,
   * tickLower, tickUpper, currentTick, tickSpacing, feeTier, usd0, usd1,
   * decimals0/1, token0, valueUsd.
   */
  async function refresh(positions, { maxChunksPerPool = 120 } = {}) {
    const keys = [...new Set(positions.map((p) => p.key).filter(Boolean))];
    for (const key of keys) {
      try {
        const n = await scanPool(key, maxChunksPerPool);
        if (n) log.log(`advisor: ${key.slice(0, 14)}… +${n} chunks, ${state.pools[key].hours}h covered${state.pools[key].complete ? " (7d complete)" : ""}`);
      } catch (err) {
        log.error(`advisor: scan ${key.slice(0, 14)}…: ${err.shortMessage || err.message}`);
      }
    }
    const results = {};
    for (const p of positions) {
      try {
        results[`${p.wallet}:${p.tokenId}`] = { tokenId: p.tokenId, wallet: p.wallet, pair: p.pair, ...evaluate(p, state.pools[p.key]) };
      } catch (err) {
        results[`${p.wallet}:${p.tokenId}`] = { tokenId: p.tokenId, wallet: p.wallet, pair: p.pair, status: `error: ${err.message}` };
      }
    }
    state.results = results;
    state.at = Date.now();
    save();
    return results;
  }

  function view() {
    return { ok: true, at: state.at, results: state.results, pools: Object.fromEntries(Object.entries(state.pools).map(([k, p]) => [k, { hours: p.hours, complete: p.complete, coveredFrom: p.coveredFrom, coveredTo: p.coveredTo }])) };
  }

  return { refresh, view, evaluate, feesForRange, ilForecast, hourlyVol, liquidityForValue, fold, get state() { return state; } };
}

module.exports = { create };
