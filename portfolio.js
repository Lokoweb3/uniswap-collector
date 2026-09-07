/**
 * Portfolio tracker: every token the owner holds, where it sits (wallet,
 * inside pools, or as uncollected fees), what it is worth, and how the total
 * has moved over time.
 *
 * Discovery is Blockscout's ERC-20 holdings list for the wallet (a hint,
 * refreshed every six hours, unioned with every token seen in a position and
 * any listed under `portfolio.tokens` in config.json); balances and prices
 * are always read from the chain. A token is priced through the deepest v3
 * pool it shares with WETH, else with the reference stable; tokens with no
 * such pool are shown unpriced rather than guessed at.
 *
 * State lives in portfolio.json: the token list, the chosen pricing pool per
 * token, and an hourly series of {wallet, pools, fees, total} in USD with the
 * per-token prices of the hour, kept forever (a few KB a day).
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const u = require("./univ3");
const v4 = require("./univ4");
const { bsFetch } = require("./blockscout");

const FILE = path.join(__dirname, "portfolio.json");
const DISCOVER_MS = 6 * 3600 * 1000;
const POOL_RECHECK_MS = 6 * 3600 * 1000;
const SERIES_STEP_MS = 3600 * 1000;
const FEE_TIERS = [100, 500, 3000, 10000];
const ERC20_BAL = ["function balanceOf(address) view returns (uint256)"];
const V2_FACTORY_ABI = ["function getPair(address,address) view returns (address)"];
// Uniswap v4 has no factory: a pool is found by hashing its key. These are
// the (fee, tickSpacing) pairs seen on this chain; hooks come from config.
const V4_TIERS = [[100, 1], [500, 10], [2500, 50], [3000, 60], [10000, 200], [15000, 300], [20000, 400], [30000, 600]];
const V4_STATE_ABI = [
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
];
const Q96 = 2n ** 96n;
// Multicall3 (same address on every chain it is deployed to) batches the key checks.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"];
const V2_PAIR_ABI = [
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
];
const CONCURRENCY = 6;
// A pricing pool must hold at least this much of the quote token, or a dust
// token would be valued off a pool nobody trades.
const MIN_QUOTE_WETH = 0.005;
const MIN_QUOTE_STABLE = 10;

/** Run fn over items with bounded concurrency; results in order, errors as null. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        try {
          out[k] = await fn(items[k], k);
        } catch {
          out[k] = null;
        }
      }
    })
  );
  return out;
}

function create({ provider, factory, cfg, explorerApi }) {
  let state = { discoveredAt: 0, tokens: {}, pools: {}, series: [], wallets: {} };
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (s.series) state = { ...state, ...s };
  } catch {}
  const save = () => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(state));
    } catch {}
  };

  const WETH = cfg.contracts.weth.toLowerCase();
  const STABLE = ((cfg.usdReference && cfg.usdReference.stable) || "").toLowerCase();
  const owner = cfg.ownerAddress;
  const manual = ((cfg.portfolio && cfg.portfolio.tokens) || []).filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  // Tokens priced as another token, 1:1 (staked / wrapped receipts such as
  // sNET -> NET). Keys and values are addresses; see config.json.
  const priceVia = Object.fromEntries(
    Object.entries((cfg.portfolio && cfg.portfolio.priceVia) || {})
      .filter(([k, v]) => /^0x[0-9a-fA-F]{40}$/.test(k) && /^0x[0-9a-fA-F]{40}$/.test(v))
      .map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]),
  );
  // Uniswap v2 factory, for tokens whose only real market is a v2 pair.
  const v2Factory = cfg.contracts.v2Factory && ethers.isAddress(cfg.contracts.v2Factory)
    ? new ethers.Contract(cfg.contracts.v2Factory, V2_FACTORY_ABI, provider)
    : null;
  // Uniswap v4: StateView for slot0/liquidity, plus the hook addresses whose
  // pools are worth checking (launchpad hooks); the hookless key is always tried.
  const V4 = cfg.contracts.v4 && cfg.contracts.v4.stateView
    ? {
        stateView: new ethers.Contract(cfg.contracts.v4.stateView, V4_STATE_ABI, provider),
        hooks: [ethers.ZeroAddress, ...((cfg.contracts.v4.pricingHooks || []).filter((h) => ethers.isAddress(h)))],
      }
    : null;
  const multicall = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
  const stateIface = new ethers.Interface(V4_STATE_ABI);
  let multicallOk = null; // null = untested

  /**
   * Deepest v4 pool pairing `addr` with native ETH, WETH or the stable, by
   * enumerating pool keys. Depth is the quote-side virtual reserve at the
   * current price (liquidity * sqrtP), a fair proxy for a launchpad pool.
   */
  async function v4PoolFor(addr, wethUsd) {
    if (!V4) return null;
    const quotes = [ethers.ZeroAddress, WETH, STABLE].filter((q) => q && q !== addr);
    const keys = [];
    for (const quote of quotes)
      for (const [fee, tickSpacing] of V4_TIERS)
        for (const hooks of V4.hooks) {
          const [c0, c1] = addr.toLowerCase() < quote.toLowerCase() ? [addr, quote] : [quote, addr];
          keys.push({ currency0: c0, currency1: c1, fee, tickSpacing, hooks, quote });
        }
    // One batched call answers "which of these keys has liquidity"; only the
    // live ones get a slot0 read. Falls back to per-key calls without Multicall3.
    const ids = keys.map((k) => v4.poolIdOf(k));
    let liq = null;
    if (multicallOk !== false) {
      try {
        const res = await multicall.aggregate3(ids.map((id) => ({ target: V4.stateView.target, allowFailure: true, callData: stateIface.encodeFunctionData("getLiquidity", [id]) })));
        liq = res.map((r) => (r.success && r.returnData.length >= 66 ? BigInt(r.returnData) : 0n));
        multicallOk = true;
      } catch {
        multicallOk = false;
      }
    }
    const found = await mapLimit(keys, 8, async (k, i) => {
      const id = ids[i];
      const L = liq ? liq[i] : await V4.stateView.getLiquidity(id);
      if (L === 0n) return null;
      const [sqrtP] = await V4.stateView.getSlot0(id);
      const qMeta = k.quote === ethers.ZeroAddress ? v4.NATIVE : await u.getToken(k.quote, provider);
      const tokenIs0 = k.currency0.toLowerCase() === addr.toLowerCase();
      // Quote-side virtual reserve: token1 = L * sqrtP / 2^96, token0 = L * 2^96 / sqrtP.
      const raw = tokenIs0 ? (L * sqrtP) / Q96 : (L * Q96) / sqrtP;
      const depth = Number(ethers.formatUnits(raw, qMeta.decimals));
      const quoteIsEth = k.quote === ethers.ZeroAddress || k.quote === WETH;
      if (depth < (quoteIsEth ? MIN_QUOTE_WETH : MIN_QUOTE_STABLE)) return null;
      const depthUsd = depth * (quoteIsEth ? wethUsd || 0 : 1);
      return { pool: id, quote: k.quote, fee: k.fee, depth, depthUsd, v4: true, key: { currency0: k.currency0, currency1: k.currency1 } };
    });
    let best = null;
    for (const c of found) if (c && (!best || c.depthUsd > best.depthUsd)) best = c;
    return best;
  }

  let latest = null; // last computed view

  /** Blockscout's ERC-20 holdings list for an address, as lower-case token addresses. Throws on failure. */
  async function fetchHoldings(address) {
    let params = new URLSearchParams({ type: "ERC-20" });
    const found = [];
    for (let page = 0; page < 20; page++) {
      const r = await bsFetch(`/v2/addresses/${address}/tokens?${params}`);
      const j = await r.json();
      if (!Array.isArray(j.items)) throw new Error("unexpected holdings response");
      for (const it of j.items) {
        if (it.token?.type && it.token.type !== "ERC-20") continue; // NFTs are positions, not holdings
        const addr = (it.token?.address_hash || it.token?.address || "").toLowerCase();
        if (/^0x[0-9a-f]{40}$/.test(addr)) found.push(addr);
      }
      if (!j.next_page_params) break;
      params = new URLSearchParams(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)]));
    }
    return found;
  }

  /** Refresh the owner's holdings hint (every six hours). */
  async function discover() {
    if (Date.now() - state.discoveredAt < DISCOVER_MS) return;
    try {
      const found = await fetchHoldings(owner);
      for (const a of found) state.tokens[a] = state.tokens[a] || { seenAt: Date.now() };
      state.discoveredAt = Date.now();
      save();
    } catch {
      /* Blockscout down or throttled: the position tokens still cover the important ones */
    }
  }

  /**
   * Value of the tokens sitting in any wallet (not positions): native ETH plus
   * every ERC-20 Blockscout lists for it, balances and prices read from the
   * chain the same way as the owner's portfolio. Used for watched wallets.
   * `extraTokens` are addresses to check regardless of the holdings list
   * (the wallet's position tokens); `prices` are known USD prices to prefer.
   */
  async function holdingsOf(address, { wethUsd, extraTokens = [], prices = {} } = {}) {
    const key = address.toLowerCase();
    const hint = (state.wallets[key] = state.wallets[key] || { discoveredAt: 0, tokens: [] });
    let discoveryOk = hint.discoveredAt > 0;
    // Anonymous Blockscout allows ~10 requests per 15 minutes; after a failure
    // wait that long before asking again rather than failing every refresh.
    if (Date.now() - hint.discoveredAt >= DISCOVER_MS && Date.now() >= (hint.retryAt || 0)) {
      try {
        hint.tokens = await fetchHoldings(address);
        hint.discoveredAt = Date.now();
        discoveryOk = true;
      } catch {
        hint.retryAt = Date.now() + 15 * 60 * 1000;
        discoveryOk = hint.tokens.length > 0; // stale list is better than none
      }
      save();
    }
    const addrs = new Set([...hint.tokens, ...extraTokens.map((a) => a.toLowerCase())]);
    const rows = [];
    const native = await provider.getBalance(address).catch(() => null);
    if (native != null) {
      const bal = Number(ethers.formatEther(native));
      if (bal > 0) rows.push({ symbol: "ETH", address: null, native: true, amount: bal, price: wethUsd });
    }
    const held = await mapLimit([...addrs], CONCURRENCY, async (addr) => {
      const meta = await u.getToken(addr, provider);
      const raw = await new ethers.Contract(addr, ERC20_BAL, provider).balanceOf(address);
      const amount = Number(ethers.formatUnits(raw, meta.decimals));
      return amount > 0 ? { addr, meta, amount } : null;
    });
    const priced = await mapLimit(held.filter(Boolean), CONCURRENCY, async (x) => {
      let price = prices[x.addr], depthUsd = null, via = null;
      if (price == null) ({ price, depthUsd, via = null } = await priceOf(x.addr, wethUsd));
      return { symbol: x.meta.symbol, address: x.meta.address, native: false, amount: x.amount, price, depthUsd, via: via ? (await u.getToken(via, provider)).symbol : null };
    });
    rows.push(...priced.filter(Boolean));
    save(); // pool choices made above
    for (const r of rows) {
      r.usd = r.price == null ? null : r.amount * r.price;
      r.thin = r.depthUsd != null && r.usd != null && r.usd > r.depthUsd;
    }
    rows.sort((a, b) => (b.usd || 0) - (a.usd || 0));
    return {
      ok: discoveryOk,
      walletUsd: rows.reduce((s, r) => s + (r.usd || 0), 0),
      unpricedCount: rows.filter((r) => r.usd == null).length,
      rows,
    };
  }

  /**
   * Pick the deepest pool pairing this token with WETH (else the stable),
   * remembered for six hours. Returns null when there is none.
   */
  async function poolFor(addr, wethUsd) {
    const cached = state.pools[addr];
    if (cached && Date.now() - cached.at < POOL_RECHECK_MS) return cached.pool ? cached : null;
    let best = null;
    for (const quote of [WETH, STABLE].filter(Boolean)) {
      if (quote === addr) continue;
      const qMeta = await u.getToken(quote, provider);
      const qMin = quote === WETH ? MIN_QUOTE_WETH : MIN_QUOTE_STABLE;
      const candidates = await mapLimit(FEE_TIERS, FEE_TIERS.length, async (fee) => {
        const pool = await factory.getPool(addr, quote, fee);
        if (pool === ethers.ZeroAddress) return null;
        // Depth = how much of the quote token sits in the pool.
        const raw = await new ethers.Contract(quote, ERC20_BAL, provider).balanceOf(pool);
        const depth = Number(ethers.formatUnits(raw, qMeta.decimals));
        return depth >= qMin ? { pool, quote, fee, depth } : null;
      });
      for (const c of candidates) if (c && (!best || c.depth > best.depth)) best = c;
      if (best) break; // a WETH pool wins over any stable pool
    }
    // No v3 pool deep enough: the deepest of the v4 pools and the v2 pairs, in USD terms.
    if (!best) {
      const cands = [];
      try { const c = await v4PoolFor(addr, wethUsd); if (c) cands.push(c); } catch {}
      if (v2Factory) {
        for (const quote of [WETH, STABLE].filter(Boolean)) {
          if (quote === addr) continue;
          try {
            const pair = await v2Factory.getPair(addr, quote);
            if (pair === ethers.ZeroAddress) continue;
            const qMeta = await u.getToken(quote, provider);
            const qMin = quote === WETH ? MIN_QUOTE_WETH : MIN_QUOTE_STABLE;
            const raw = await new ethers.Contract(quote, ERC20_BAL, provider).balanceOf(pair);
            const depth = Number(ethers.formatUnits(raw, qMeta.decimals));
            if (depth >= qMin) cands.push({ pool: pair, quote, fee: null, depth, depthUsd: depth * (quote === WETH ? wethUsd || 0 : 1), v2: true });
          } catch {}
        }
      }
      for (const c of cands) if (!best || c.depthUsd > best.depthUsd) best = c;
      if (best) delete best.depthUsd; // recomputed at price time from the live WETH price
    }
    state.pools[addr] = { at: Date.now(), ...(best || { pool: null }) };
    return best;
  }

  /** USD price of one token via its pricing pool, and that pool's depth in USD. */
  async function priceOf(addr, wethUsd, hops = 0) {
    if (addr === WETH) return { price: wethUsd, depthUsd: null };
    if (addr === STABLE) return { price: 1, depthUsd: null };
    if (priceVia[addr] && hops < 3) {
      const r = await priceOf(priceVia[addr], wethUsd, hops + 1);
      return { ...r, via: priceVia[addr] };
    }
    const pc = await poolFor(addr, wethUsd);
    if (!pc || !pc.pool) return { price: null, depthUsd: null };
    const quoteIsEth = pc.quote === WETH || pc.quote === ethers.ZeroAddress;
    const depthUsd = pc.depth == null ? null : pc.depth * (quoteIsEth ? wethUsd || 0 : 1);
    if (pc.v4) {
      try {
        const [sqrtP] = await V4.stateView.getSlot0(pc.pool);
        const t = await u.getToken(addr, provider);
        const q = pc.quote === ethers.ZeroAddress ? v4.NATIVE : await u.getToken(pc.quote, provider);
        const tokenIs0 = pc.key.currency0.toLowerCase() === addr;
        const p = u.priceFromSqrt(sqrtP, tokenIs0 ? t.decimals : q.decimals, tokenIs0 ? q.decimals : t.decimals);
        const inQuote = tokenIs0 ? p : 1 / p;
        const quoteUsd = quoteIsEth ? wethUsd : 1;
        return { price: quoteUsd == null ? null : inQuote * quoteUsd, depthUsd };
      } catch {
        return { price: null, depthUsd };
      }
    }
    if (pc.v2) {
      try {
        const pair = new ethers.Contract(pc.pool, V2_PAIR_ABI, provider);
        const [t0, [r0, r1]] = await Promise.all([pair.token0(), pair.getReserves()]);
        const [t, q] = await Promise.all([u.getToken(addr, provider), u.getToken(pc.quote, provider)]);
        const tokenIs0 = t0.toLowerCase() === addr;
        const rt = Number(ethers.formatUnits(tokenIs0 ? r0 : r1, t.decimals));
        const rq = Number(ethers.formatUnits(tokenIs0 ? r1 : r0, q.decimals));
        if (!(rt > 0)) return { price: null, depthUsd };
        const quoteUsd = pc.quote === WETH ? wethUsd : 1;
        return { price: quoteUsd == null ? null : (rq / rt) * quoteUsd, depthUsd };
      } catch {
        return { price: null, depthUsd };
      }
    }
    try {
      const pool = new ethers.Contract(pc.pool, u.POOL_ABI, provider);
      const slot0 = await pool.slot0();
      const [t, q] = await Promise.all([u.getToken(addr, provider), u.getToken(pc.quote, provider)]);
      const tokenIs0 = addr < pc.quote;
      // price = token1 per token0
      const p = u.priceFromSqrt(slot0.sqrtPriceX96, tokenIs0 ? t.decimals : q.decimals, tokenIs0 ? q.decimals : t.decimals);
      const inQuote = tokenIs0 ? p : 1 / p;
      const quoteUsd = pc.quote === WETH ? wethUsd : 1;
      return { price: quoteUsd == null ? null : inQuote * quoteUsd, depthUsd };
    } catch {
      return { price: null, depthUsd };
    }
  }

  /**
   * Recompute the view. `positionTokens` is addr -> {symbol, decimals} for
   * every token in a position; `poolHoldings` is addr -> {amount, fees} in
   * token units summed across open positions; `lpUsd`/`feesUsd` are the
   * position totals already priced by the dashboard; `prices` its per-token
   * USD prices (preferred, since they come from the pools actually held).
   */
  async function refresh({ positionTokens, poolHoldings, lpUsd, feesUsd, wethUsd, prices }) {
    await discover();
    const addrs = new Set([...Object.keys(state.tokens), ...positionTokens.keys(), ...manual.map((a) => a.toLowerCase())]);
    const rows = [];

    // Native ETH first.
    const native = await provider.getBalance(owner).catch(() => null);
    if (native != null) {
      const bal = Number(ethers.formatEther(native));
      rows.push({ symbol: "ETH", address: null, native: true, wallet: bal, pools: 0, fees: 0, price: wethUsd, source: "wallet" });
    }

    const held = await mapLimit([...addrs], CONCURRENCY, async (addr) => {
      let meta = positionTokens.get(addr);
      if (!meta) meta = await u.getToken(addr, provider);
      const raw = await new ethers.Contract(addr, ERC20_BAL, provider).balanceOf(owner);
      const wallet = Number(ethers.formatUnits(raw, meta.decimals));
      const h = poolHoldings.get(addr) || { amount: 0, fees: 0 };
      if (wallet === 0 && h.amount === 0 && h.fees === 0) return null;
      return { addr, meta, wallet, h };
    });
    const priced = await mapLimit(held.filter(Boolean), CONCURRENCY, async (x) => {
      // Position tokens are priced off the pools actually held (deep by
      // construction); anything else goes through the deepest pool found.
      let price = prices[x.addr], depthUsd = null, via = null;
      if (price == null) ({ price, depthUsd, via = null } = await priceOf(x.addr, wethUsd));
      return {
        symbol: x.meta.symbol, address: x.meta.address, native: false,
        wallet: x.wallet, pools: x.h.amount, fees: x.h.fees, price, depthUsd,
        via: via ? (await u.getToken(via, provider)).symbol : null,
        source: positionTokens.has(x.addr) ? "pools" : "wallet",
      };
    });
    rows.push(...priced.filter(Boolean));
    save(); // pool choices made above

    for (const r of rows) {
      r.total = r.wallet + r.pools + r.fees;
      r.walletUsd = r.price == null ? null : r.wallet * r.price;
      r.usd = r.price == null ? null : r.total * r.price;
      // Worth more than the pool that prices it holds: the number is a
      // quote, not something you could sell for.
      r.thin = r.depthUsd != null && r.usd != null && r.usd > r.depthUsd;
    }
    const walletUsd = rows.reduce((s, r) => s + (r.walletUsd || 0), 0);
    const totalUsd = walletUsd + (lpUsd || 0) + (feesUsd || 0);
    const grand = rows.reduce((s, r) => s + (r.usd || 0), 0);
    for (const r of rows) r.share = grand > 0 && r.usd != null ? (r.usd / grand) * 100 : null;
    rows.sort((a, b) => (b.usd || 0) - (a.usd || 0));

    // 24h price change from the hourly series.
    const now = Date.now();
    const ago = state.series.filter((s) => s.t <= now - 24 * 3600 * 1000).pop();
    for (const r of rows) {
      const key = r.native ? "eth" : r.address.toLowerCase();
      const then = ago && ago.p ? ago.p[key] : null;
      r.change24h = then > 0 && r.price != null ? ((r.price - then) / then) * 100 : null;
    }

    // Hourly series point, kept forever.
    const last = state.series[state.series.length - 1];
    if (lpUsd != null && (!last || now - last.t >= SERIES_STEP_MS)) {
      const p = {};
      for (const r of rows) if (r.price != null) p[r.native ? "eth" : r.address.toLowerCase()] = +r.price.toPrecision(6);
      state.series.push({ t: now, wallet: +walletUsd.toFixed(2), lp: +(lpUsd || 0).toFixed(2), fees: +(feesUsd || 0).toFixed(2), total: +totalUsd.toFixed(2), p });
      save();
    }

    latest = {
      ok: true, at: now, owner, wethUsd,
      totals: { walletUsd, lpUsd: lpUsd || 0, feesUsd: feesUsd || 0, totalUsd, unpricedCount: rows.filter((r) => r.usd == null).length },
      rows,
      series: decimate(state.series.map((s) => ({ t: s.t, wallet: s.wallet, lp: s.lp, fees: s.fees, total: s.total }))),
      explorer: explorerApi.replace(/\/api$/, ""),
    };
    return latest;
  }

  function decimate(pts, max = 240) {
    const step = Math.max(1, Math.ceil(pts.length / max));
    return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  }

  return {
    refresh,
    holdingsOf,
    get latest() {
      return latest;
    },
  };
}

module.exports = { create };
