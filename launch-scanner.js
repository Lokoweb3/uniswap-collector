/**
 * launch-scanner.js — find new tokens on Robinhood Chain before the pump, and
 * say whether they are safe enough to LP.
 *
 * Every 5 minutes (a timer in server.js):
 *   1. New pools: Uniswap v4 PoolManager `Initialize` events since the last
 *      scan (the first run looks back maxAgeMinutes), plus pools the pool
 *      scanner's cache (http://127.0.0.1:3847/api/pools) lists as created
 *      inside the window. ETH- or USDG-quoted, hookless or on a known
 *      launchpad hook; a token that spawns more than 20 pools is spam.
 *   2. For each token (newest first, a bounded number per scan): age, price
 *      and market cap (supply from Blockscout, price from the pool), an
 *      estimate of the pool's in-range value, holders (Blockscout: count, top
 *      holder, creator), the contract (verified, proxy, owner, dangerous
 *      selectors in the bytecode), a buy-and-sell round trip simulated with
 *      eth_call (honeypot / sell tax), and the last 10 minutes of swaps
 *      (buys, sells, buy ratio).
 *   3. Score 0-100; alert on Telegram (group, fallback personal) at
 *      minScore; never the same token twice in alertCooldownHours; a
 *      follow-up when an alerted token's market cap triples.
 *
 * Read-only: no key, no transaction. State in launch-scanner-state.json,
 * a heartbeat + the last results in launch-scanner-status.json.
 *
 * Honeypot round trip (eth_call with a state override, no funds involved):
 * a scratch address is given 1 ETH, calls Multicall3.aggregate3Value with
 * [router.execute(buy 0.01 ETH -> token, tokens kept in the router),
 *  token.balanceOf(router), router.execute(sell those tokens -> ETH to the
 *  scratch, router pays), Multicall3.getEthBalance(scratch)]. Both swaps run
 * through the real PoolManager and the token's own transfer code; the ETH
 * that comes back against the quoter's figure gives the effective sell tax.
 * USDG-quoted pools go ETH -> USDG -> token and back through the WETH/USDG
 * pool.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const STATE_FILE = "launch-scanner-state.json";
const STATUS_FILE = "launch-scanner-status.json";
const SCANNER_URL = process.env.LP_SCANNER_URL || "http://127.0.0.1:3847";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const INIT_TOPIC = ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const SWAP_TOPIC = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const INIT_IFACE = new ethers.Interface(["event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)"]);
const SWAP_IFACE = new ethers.Interface(["event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)"]);
const ERC20_ABI = ["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function balanceOf(address) view returns (uint256)", "function owner() view returns (address)"];
const STATE_VIEW_ABI = ["function getSlot0(bytes32) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)", "function getLiquidity(bytes32) view returns (uint128)"];
const MULTICALL_ABI = ["function aggregate3Value((address target,bool allowFailure,uint256 value,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])", "function getEthBalance(address) view returns (uint256)", "function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])"];
const QUOTER_ABI = ["function quoteExactInput((address exactCurrency,(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,uint128 exactAmount) params) returns (uint256 amountOut,uint256 gasEstimate)"];
const ROUTER_ABI = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"];
const coder = ethers.AbiCoder.defaultAbiCoder();
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002"; // ActionConstants.ADDRESS_THIS in the router's v4 actions
const SCRATCH = "0x" + "0".repeat(34) + "c0ffee"; // a keyless scratch address; eth_call gives it ETH by state override

/** Selectors that let an owner change the rules after launch. (transferFrom 0x23b872dd is standard ERC-20, not a flag.) */
const DANGER = {
  "0x40c10f19": "mint(address,uint256)", "0xa0712d68": "mint(uint256)",
  "0x8456cb59": "pause()", "0x3f4ba83a": "unpause()",
  "0xf9f92be4": "blacklist(address)", "0x1a695230": "addToBlacklist", "0x44337ea1": "addBot", "0x8a8c523c": "enableTrading",
  "0xe47d6060": "setMaxTx", "0xec28438a": "setMaxTxAmount", "0x8c0b5e22": "setMaxWalletAmount", "0x751039fc": "removeLimits",
  "0xafa4f3b2": "setTax", "0x8f9a55c0": "setSellFee", "0x6d1e6e1f": "setBuyFee",
};
const OWNERSHIP = { "0xf2fde38b": "transferOwnership(address)", "0x715018a6": "renounceOwnership()" };

const DEFAULTS = { enabled: true, maxTokenAgeHours: 48, minScore: 70, minMcapUsd: 50000, maxMcapUsd: 500000, minAgeMinutes: 10, maxAgeMinutes: 240, minTvlUsd: 5000, maxTopHolderPct: 30, maxDevPct: 20, minHolders: 20, minBuys10min: 5, minBuyRatioPct: 60, maxSellTaxPct: 10, alertCooldownHours: 24, maxTokensPerScan: 12 };

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const poolIdOf = (k) => ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
const short = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : "—");
const fmtUsd = (n) => (n == null ? "—" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);
const minutes = (ms) => Math.round(ms / 60000);

function create({ cfg, provider, alerts = null, log = (m) => console.log(`launch: ${m}`), dir = __dirname, wethUsd = () => null, blockscout = null, now = () => Date.now(), fetchImpl = fetch } = {}) {
  const st = { ...DEFAULTS, ...(cfg.launchScanner || {}) };
  const v4 = cfg.contracts.v4 || {};
  const PM = v4.poolManager, ROUTER = v4.universalRouter, QUOTER = v4.quoter;
  const stateView = v4.stateView ? new ethers.Contract(v4.stateView, STATE_VIEW_ABI, provider) : null;
  const quoter = QUOTER ? new ethers.Contract(QUOTER, QUOTER_ABI, provider) : null;
  const WETH = String(cfg.contracts.weth || "").toLowerCase();
  const USDG = String((cfg.usdReference && cfg.usdReference.stable) || "").toLowerCase();
  const isEth = (a) => a === ethers.ZeroAddress || String(a).toLowerCase() === WETH;
  const isUsdg = (a) => !!USDG && String(a).toLowerCase() === USDG;
  const launchpadHooks = new Set((v4.pricingHooks || []).map((h) => String(h).toLowerCase()));
  const bs = blockscout || (() => { try { return require("./blockscout"); } catch { return null; } })();

  const stateFile = path.join(dir, STATE_FILE), statusFile = path.join(dir, STATUS_FILE);
  let state = readJson(stateFile, { lastBlock: 0, pools: {}, tokens: {}, alerted: {}, day: null, scannedToday: 0, alertsToday: 0 });
  const save = () => { try { fs.writeFileSync(stateFile, JSON.stringify(state)); } catch {} };
  let lastStatus = readJson(statusFile, { ok: true, at: 0, candidates: [] });

  // ---- step 1: new pools -----------------------------------------------------
  async function blockTime(blockNumber) {
    const b = await provider.getBlock(blockNumber);
    return b ? b.timestamp * 1000 : null;
  }
  async function newPools(head) {
    const t = now();
    const secPerBlock = state.secPerBlock || 0.1;
    let from = state.lastBlock ? state.lastBlock + 1 : head - Math.round((st.maxAgeMinutes * 60) / secPerBlock);
    if (head - from > 400000) from = head - 400000;
    let found = 0;
    for (let f = from; f <= head; f += 2000) {
      const to = Math.min(head, f + 1999);
      let logs;
      try { logs = await provider.getLogs({ address: PM, topics: [INIT_TOPIC], fromBlock: f, toBlock: to }); } catch (err) { log(`getLogs ${f}-${to}: ${err.shortMessage || err.message}`); break; }
      for (const l of logs) {
        const e = INIT_IFACE.parseLog(l);
        const key = { currency0: e.args.currency0, currency1: e.args.currency1, fee: Number(e.args.fee), tickSpacing: Number(e.args.tickSpacing), hooks: e.args.hooks };
        const quoteIs0 = isEth(key.currency0) || isUsdg(key.currency0), quoteIs1 = isEth(key.currency1) || isUsdg(key.currency1);
        if (quoteIs0 === quoteIs1) continue; // token/token or quote/quote pools
        const hooked = key.hooks !== ethers.ZeroAddress;
        if (hooked && !launchpadHooks.has(key.hooks.toLowerCase())) continue;
        const token = quoteIs0 ? key.currency1 : key.currency0;
        if (isEth(token) || isUsdg(token)) continue;
        const id = e.args.id;
        state.pools[id] = { key, token, block: l.blockNumber, tx: l.transactionHash, source: hooked ? "launchpad" : "onchain" };
        found++;
      }
      state.lastBlock = to;
    }
    // The pool scanner's cache: pools it lists as created inside the window (GeckoTerminal data).
    try {
      const r = await fetchImpl(`${SCANNER_URL}/api/pools`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      for (const p of j.pools || []) {
        if (p.version !== "v4" || !p.createdAt) continue;
        const age = t - Date.parse(p.createdAt);
        if (age < 0 || age > st.maxAgeMinutes * 60000) continue;
        const id = String(p.address).toLowerCase();
        if (state.pools[id]) { state.pools[id].cache = { tvl: p.tvl, mcap: p.mcap || p.fdv, vol: p.vol, tx: p.tx }; continue; }
        const base = p.base && p.base.address, quote = p.quote && p.quote.address;
        const token = base && !isEth(base) && !isUsdg(base) ? base : quote && !isEth(quote) && !isUsdg(quote) ? quote : null;
        if (!token) continue;
        state.pools[id] = { key: null, token: ethers.getAddress(token), createdAt: Date.parse(p.createdAt), source: "scanner-cache", cache: { tvl: p.tvl, mcap: p.mcap || p.fdv, vol: p.vol, tx: p.tx } };
        found++;
      }
    } catch {}
    // Forget pools past the window.
    for (const [id, p] of Object.entries(state.pools)) {
      const created = p.createdAt || (p.block ? t - (head - p.block) * secPerBlock * 1000 : t);
      if (t - created > (st.maxAgeMinutes + 60) * 60000) delete state.pools[id];
    }
    return found;
  }

  // ---- step 2: evaluate a token ------------------------------------------------
  async function bsJson(p) {
    if (!bs) return null;
    try { const r = await bs.bsFetch(p, { timeoutMs: 15000 }); if (!r.ok) return null; return await r.json(); } catch { return null; }
  }

  /** Price of the pool's token in USD from slot0, plus an estimate of the value sitting within ±30% of the price. */
  async function poolNumbers(pool, dec) {
    if (!stateView || !pool.key) return { priceUsd: null, tvlUsd: pool.cache ? pool.cache.tvl : null, liquidity: null };
    const id = poolIdOf(pool.key);
    const [slot0, L] = await Promise.all([stateView.getSlot0(id), stateView.getLiquidity(id)]);
    const sqrtP = Number(slot0[0]) / 2 ** 96;
    const quoteIs0 = pool.key.currency0.toLowerCase() !== pool.token.toLowerCase();
    const qAddr = quoteIs0 ? pool.key.currency0 : pool.key.currency1;
    const qDec = isEth(qAddr) ? 18 : 6, qUsd = isEth(qAddr) ? wethUsd() : 1;
    // price = token1 per token0 in raw units; convert to token-per-quote or quote-per-token in human units
    const p1per0 = sqrtP * sqrtP; // raw
    const quotePerToken = quoteIs0 ? (1 / p1per0) * 10 ** (dec - qDec) : p1per0 * 10 ** (dec - qDec);
    const priceUsd = qUsd != null ? quotePerToken * qUsd : null;
    // In-range value within a ±30% band around the price, both sides, in USD (an estimate: v4 pools share the manager's balances).
    const liq = Number(L);
    const sA = sqrtP / Math.sqrt(1.3), sB = sqrtP * Math.sqrt(1.3);
    const amt0 = liq * (1 / sqrtP - 1 / sB), amt1 = liq * (sqrtP - sA);
    const usd0 = quoteIs0 ? (amt0 / 10 ** qDec) * (qUsd || 0) : (amt0 / 10 ** dec) * (priceUsd || 0);
    const usd1 = quoteIs0 ? (amt1 / 10 ** dec) * (priceUsd || 0) : (amt1 / 10 ** qDec) * (qUsd || 0);
    const tvlUsd = pool.cache && pool.cache.tvl != null ? pool.cache.tvl : usd0 + usd1;
    return { priceUsd, tvlUsd, liquidity: liq, sqrtPriceX96: slot0[0], quoteIs0, quoteAddr: qAddr };
  }

  async function holders(token, supply, dec, creator) {
    const info = await bsJson(`/v2/tokens/${token}`);
    const hl = await bsJson(`/v2/tokens/${token}/holders`);
    const items = (hl && hl.items) || [];
    const sup = supply != null ? supply : info && info.total_supply ? Number(info.total_supply) / 10 ** dec : null;
    const skip = new Set([String(PM).toLowerCase(), ethers.ZeroAddress, "0x000000000000000000000000000000000000dead"]);
    let top = null, dev = null;
    for (const h of items) {
      const a = h.address && String(h.address.hash || h.address).toLowerCase();
      if (!a || skip.has(a)) continue;
      const pct = sup ? (Number(h.value) / 10 ** dec / sup) * 100 : null;
      if (top == null || (pct != null && pct > top.pct)) top = { address: a, pct };
      if (creator && a === String(creator).toLowerCase()) dev = { address: a, pct };
    }
    return { count: info ? Number(info.holders_count || info.holders || 0) || null : null, top, dev, mcapBlockscout: info && info.circulating_market_cap ? Number(info.circulating_market_cap) : null, supply: sup };
  }

  async function contractInfo(token) {
    const out = { verified: null, proxy: false, implementationVerified: null, owner: null, renounced: null, flags: [], ownership: [], creator: null };
    const sc = await bsJson(`/v2/smart-contracts/${token}`);
    if (sc) {
      out.verified = !!(sc.is_verified || sc.source_code);
      out.proxy = !!(sc.proxy_type || (sc.implementations && sc.implementations.length));
      if (out.proxy) out.implementationVerified = !!(sc.implementations || []).every((i) => i.name || i.is_verified);
    }
    const addr = await bsJson(`/v2/addresses/${token}`);
    if (addr) {
      out.creator = addr.creator_address_hash || null;
      if (out.verified == null) out.verified = !!addr.is_verified;
      // When the token contract itself was deployed: a new pool for an old token is not a launch.
      const ctx = addr.creation_transaction_hash || addr.creation_tx_hash; if (ctx) { try { const tx = await provider.getTransaction(ctx); if (tx && tx.blockNumber) out.createdAt = await blockTime(tx.blockNumber); } catch {} }
    }
    let code = "0x";
    try { code = await provider.getCode(token); } catch {}
    const hex = code.toLowerCase();
    for (const [sel, name] of Object.entries(DANGER)) if (hex.includes(sel.slice(2))) out.flags.push(name);
    for (const [sel, name] of Object.entries(OWNERSHIP)) if (hex.includes(sel.slice(2))) out.ownership.push(name);
    try { out.owner = await new ethers.Contract(token, ERC20_ABI, provider).owner(); out.renounced = out.owner === ethers.ZeroAddress; } catch { out.owner = null; out.renounced = null; }
    out.clean = out.flags.length === 0 || out.renounced === true;
    if (out.proxy && out.implementationVerified === false) out.clean = false;
    return out;
  }

  /** Router calldata for one exact-input v4 swap along `path` (currencyIn -> ... -> out). */
  function swapInput({ currencyIn, path: hops, amountIn, minOut, recipient, payerIsUser }) {
    const actions = ethers.concat([new Uint8Array([0x07]), new Uint8Array([0x0b]), new Uint8Array([0x0e])]);
    const out = hops[hops.length - 1].intermediateCurrency;
    const params = [
      coder.encode(["tuple(address currencyIn,tuple(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,bytes extra,uint128 amountIn,uint128 amountOutMinimum)"], [{ currencyIn, path: hops, extra: "0x", amountIn, amountOutMinimum: minOut }]),
      coder.encode(["address", "uint256", "bool"], [currencyIn, 0n, payerIsUser]),
      coder.encode(["address", "address", "uint256"], [out, recipient, 0n]),
    ];
    return coder.encode(["bytes", "bytes[]"], [actions, params]);
  }
  const hop = (k, to) => ({ intermediateCurrency: to, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks, hookData: "0x" });

  /** The hookless WETH/USDG v4 pool with the most liquidity, for USDG-quoted routes. */
  let ethUsdgKey = null;
  async function ethUsdgPool() {
    if (ethUsdgKey !== null) return ethUsdgKey;
    const tiers = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
    let best = null;
    for (const [fee, tickSpacing] of tiers) {
      const k = { currency0: ethers.ZeroAddress, currency1: ethers.getAddress(USDG), fee, tickSpacing, hooks: ethers.ZeroAddress };
      try { const L = await stateView.getLiquidity(poolIdOf(k)); if (L > 0n && (!best || L > best.L)) best = { k, L }; } catch {}
    }
    ethUsdgKey = best ? best.k : false;
    return ethUsdgKey;
  }

  /**
   * Buy 0.01 ETH of the token and sell it back, in one eth_call from a scratch
   * address funded by a state override. Returns { ok, bought, ethBack, quotedBack, sellTaxPct, error }.
   */
  async function honeypot(pool, dec) {
    return { ok: null, error: "sell simulation not implemented yet" };
  }

  async function volume(pool, head) {
    if (!pool.key) return pool.cache && pool.cache.tx && pool.cache.tx.h1 ? { buys: null, sells: null, buyRatioPct: null, note: "cache only" } : { buys: null, sells: null, buyRatioPct: null };
    const id = poolIdOf(pool.key);
    const span = Math.round(600 / (state.secPerBlock || 0.1));
    const tokenIs0 = pool.key.currency0.toLowerCase() === pool.token.toLowerCase();
    let buys = 0, sells = 0, buyers = new Set(), sellers = new Set();
    for (let f = head - span; f <= head; f += 2000) {
      let logs;
      try { logs = await provider.getLogs({ address: PM, topics: [SWAP_TOPIC, id], fromBlock: f, toBlock: Math.min(head, f + 1999) }); } catch { continue; }
      for (const l of logs) {
        const e = SWAP_IFACE.parseLog(l);
        const tokenDelta = tokenIs0 ? e.args.amount0 : e.args.amount1; // trader's side: positive = received the token = a buy
        if (tokenDelta > 0n) { buys++; buyers.add(e.args.sender); } else { sells++; sellers.add(e.args.sender); }
      }
    }
    const total = buys + sells;
    return { buys, sells, buyers: buyers.size, buyRatioPct: total ? +((buys / total) * 100).toFixed(0) : null };
  }

  function score(ev) {
    let s = 0; const why = [];
    if (ev.mcapUsd != null && ev.mcapUsd >= 75000 && ev.mcapUsd <= 200000) { s += 20; why.push("mcap sweet spot"); } else if (ev.mcapUsd != null && ev.mcapUsd >= st.minMcapUsd && ev.mcapUsd <= st.maxMcapUsd) { s += 10; }
    if (ev.contract && ev.contract.verified) { s += 15; why.push("verified"); }
    if (ev.lpHealthy) { s += 20; why.push("LP healthy"); }
    if (ev.honeypot && ev.honeypot.ok === true) { s += 25; why.push("sellable"); }
    if (ev.holdersOk) { s += 10; why.push("holders spread"); }
    if (ev.buyPressure) { s += 10; why.push("buy pressure"); }
    return { score: s, why };
  }

  async function evaluate(pool, head) {
    const token = pool.token;
    const erc = new ethers.Contract(token, ERC20_ABI, provider);
    const ev = { token, pool: pool.key ? poolIdOf(pool.key) : null, feePct: pool.key ? pool.key.fee / 10000 : null, source: pool.source, at: now(), checks: {} };
    let dec = 18;
    try { [ev.symbol, dec] = await Promise.all([erc.symbol().catch(() => "?"), erc.decimals().then(Number).catch(() => 18)]); } catch {}
    ev.decimals = dec;
    let supply = null; try { supply = Number(ethers.formatUnits(await erc.totalSupply(), dec)); } catch {}
    const createdAt = pool.createdAt || (pool.block ? await blockTime(pool.block) : null);
    ev.ageMin = createdAt ? minutes(now() - createdAt) : null;
    ev.checks.age = ev.ageMin != null && ev.ageMin >= st.minAgeMinutes && ev.ageMin <= st.maxAgeMinutes;
    const pn = await poolNumbers(pool, dec).catch((e) => ({ priceUsd: null, tvlUsd: null, error: e.shortMessage || e.message }));
    ev.priceUsd = pn.priceUsd; ev.tvlUsd = pn.tvlUsd != null ? +pn.tvlUsd.toFixed(0) : null;
    ev.contract = await contractInfo(token);
    const h = await holders(token, supply, dec, ev.contract.creator);
    ev.mcapUsd = supply != null && ev.priceUsd != null ? supply * ev.priceUsd : h.mcapBlockscout;
    if (ev.mcapUsd != null) ev.mcapUsd = +ev.mcapUsd.toFixed(0);
    ev.checks.mcap = ev.mcapUsd != null && ev.mcapUsd >= st.minMcapUsd && ev.mcapUsd <= st.maxMcapUsd;
    ev.holders = { count: h.count, topPct: h.top ? +h.top.pct.toFixed(1) : null, topAddress: h.top ? h.top.address : null, devPct: h.dev ? +h.dev.pct.toFixed(1) : null };
    ev.holdersOk = ev.holders.count != null && ev.holders.count >= st.minHolders && ev.holders.topPct != null && ev.holders.topPct < st.maxTopHolderPct && (ev.holders.devPct == null || ev.holders.devPct < st.maxDevPct);
    ev.checks.holders = ev.holdersOk;
    ev.checks.contract = !!ev.contract.clean;
    ev.tokenAgeMin = ev.contract.createdAt ? minutes(now() - ev.contract.createdAt) : null;
    ev.checks.newToken = ev.tokenAgeMin == null || ev.tokenAgeMin <= st.maxTokenAgeHours * 60; // a pool for a token older than two days is a listing, not a launch
    // LP: enough value, and the creator does not own the position NFTs that matter (approximated: the creator is not the top token holder either).
    ev.lpHealthy = ev.tvlUsd != null && ev.tvlUsd >= st.minTvlUsd && !(ev.contract.creator && ev.holders.topAddress === String(ev.contract.creator).toLowerCase());
    ev.checks.lp = ev.lpHealthy;
    ev.honeypot = await honeypot(pool, dec).catch((e) => ({ ok: null, error: e.shortMessage || e.message }));
    ev.checks.honeypot = ev.honeypot.ok === true;
    ev.volume = await volume(pool, head).catch(() => ({ buys: null, sells: null, buyRatioPct: null }));
    ev.buyPressure = ev.volume.buys != null && ev.volume.buys >= st.minBuys10min && ev.volume.buyRatioPct != null && ev.volume.buyRatioPct > st.minBuyRatioPct;
    ev.checks.volume = ev.buyPressure;
    const sc = score(ev);
    ev.score = sc.score; ev.why = sc.why;
    ev.pass = Object.values(ev.checks).every(Boolean);
    return ev;
  }

  // ---- step 4: alert ------------------------------------------------------------
  function message(ev, followUp = null) {
    const c = (ok, text) => `${ok ? "✅" : "❌"} ${text}`;
    const pair = `${ev.symbol}/${ev.quoteSymbol || "ETH"}`;
    const links = ev.pool ? `\n💧 Pool: https://app.uniswap.org/explore/pools/robinhood/${ev.pool}\n📈 Chart: https://dexscreener.com/robinhoodchain/${ev.pool}\n🔍 Contract: https://robinhoodchain.blockscout.com/token/${ev.token}` : `\n🔍 Contract: https://robinhoodchain.blockscout.com/token/${ev.token}`;
    if (followUp) return `📈 ${pair} is up: market cap ${fmtUsd(followUp.from)} → ${fmtUsd(ev.mcapUsd)} since the alert ${minutes(now() - followUp.at)} min ago. Score now ${ev.score}/100.${links}`;
    return `🚀 New launch detected!\n\n${pair} · Robinhood Chain${ev.feePct != null ? ` · ${ev.feePct}% pool` : ""}\n💎 MCap: ${fmtUsd(ev.mcapUsd)} · Pool age: ${ev.ageMin} min${ev.tokenAgeMin != null ? ` · token ${ev.tokenAgeMin < 120 ? ev.tokenAgeMin + " min" : Math.round(ev.tokenAgeMin / 60) + " h"} old` : ""}\n📊 Score: ${ev.score}/100\n\n`
      + `${c(ev.contract.clean, ev.contract.clean ? `Contract clean${ev.contract.verified ? ", verified" : ", not verified"}${ev.contract.renounced ? ", ownership renounced" : ""}` : `Contract: ${ev.contract.flags.join(", ") || "unverified proxy"}`)}\n`
      + `${c(ev.lpHealthy, `LP ${ev.lpHealthy ? "healthy" : "thin"} (${fmtUsd(ev.tvlUsd)} in range)`)}\n`
      + `${c(ev.honeypot.ok === true, ev.honeypot.ok === true ? `Sellable, sell tax ${ev.honeypot.sellTaxPct == null ? "n/a" : ev.honeypot.sellTaxPct + "%"}` : `Sell check: ${ev.honeypot.error || "tax " + ev.honeypot.sellTaxPct + "%"}`)}\n`
      + `${c(ev.holdersOk, `${ev.holders.count ?? "?"} holders, top wallet ${ev.holders.topPct ?? "?"}%${ev.holders.devPct != null ? ", dev " + ev.holders.devPct + "%" : ""}`)}\n`
      + `${c(ev.buyPressure, `${ev.volume.buys ?? "?"} buys in last 10 min (${ev.volume.buyRatioPct ?? "?"}% buys)`)}\n`
      + links + `\n\n⚡ Be first LP at the ${ev.feePct != null ? ev.feePct + "%" : "launch"} fee tier to capture launch volume`;
  }
  async function send(text) {
    log(`ALERT ${text.split("\n")[0]} ${text.split("\n")[2] || ""}`);
    if (!alerts || !alerts.enabled) return false;
    try { return alerts.sendGroup ? await alerts.sendGroup(text) : await alerts.send(text); } catch (err) { log(`telegram: ${err.message}`); return false; }
  }

  // ---- the scan -----------------------------------------------------------------
  let busy = false;
  async function scan() {
    if (busy) return lastStatus;
    busy = true;
    const t0 = now();
    try {
      const day = new Date(t0).toISOString().slice(0, 10);
      if (state.day !== day) { state.day = day; state.scannedToday = 0; state.alertsToday = 0; }
      const head = await provider.getBlockNumber();
      if (!state.secPerBlock || state.blockSampleAt == null || t0 - state.blockSampleAt > 6 * 3600 * 1000) {
        const b1 = await provider.getBlock(head), b0 = await provider.getBlock(head - 1000);
        if (b1 && b0 && b1.timestamp > b0.timestamp) { state.secPerBlock = (b1.timestamp - b0.timestamp) / 1000; state.blockSampleAt = t0; }
      }
      const found = await newPools(head);
      // Tokens with a spam of pools are not launches.
      const perToken = {};
      for (const p of Object.values(state.pools)) perToken[p.token.toLowerCase()] = (perToken[p.token.toLowerCase()] || 0) + 1;
      const byToken = new Map();
      for (const p of Object.values(state.pools)) {
        const tk = p.token.toLowerCase();
        if (perToken[tk] > 20) continue;
        const cur = byToken.get(tk);
        if (!cur || (p.key && p.key.fee === 50000 && !(cur.key && cur.key.fee === 50000)) || (p.block || 0) > (cur.block || 0)) byToken.set(tk, p);
      }
      // Evaluate the newest tokens not looked at in the last 10 minutes, a bounded number per scan.
      const due = [...byToken.entries()].filter(([tk]) => !state.tokens[tk] || t0 - state.tokens[tk].at > 10 * 60000).sort((a, b) => (b[1].block || 0) - (a[1].block || 0)).slice(0, st.maxTokensPerScan);
      let evaluated = 0, alerted = 0;
      for (const [tk, pool] of due) {
        let ev;
        try { ev = await evaluate(pool, head); } catch (err) { ev = { token: pool.token, symbol: "?", error: err.shortMessage || err.message, score: 0, at: now(), checks: {} }; }
        ev.quoteSymbol = pool.key ? (isUsdg(pool.key.currency0) || isUsdg(pool.key.currency1) ? "USDG" : "ETH") : "ETH";
        state.tokens[tk] = ev;
        evaluated++;
        state.scannedToday++;
        const a = state.alerted[tk];
        if (ev.score >= st.minScore && ev.pass) {
          if (!a || t0 - a.at > st.alertCooldownHours * 3600 * 1000) {
            if (await send(message(ev))) { state.alerted[tk] = { at: t0, mcap: ev.mcapUsd, score: ev.score, symbol: ev.symbol }; state.alertsToday++; alerted++; }
          } else if (a.mcap && ev.mcapUsd && ev.mcapUsd >= 3 * a.mcap && !a.followUpAt) {
            if (await send(message(ev, { from: a.mcap, at: a.at }))) a.followUpAt = t0;
          }
        }
      }
      for (const [tk, ev] of Object.entries(state.tokens)) if (t0 - ev.at > (st.maxAgeMinutes + 60) * 60000) delete state.tokens[tk];
      for (const [tk, a] of Object.entries(state.alerted)) if (t0 - a.at > 7 * 24 * 3600 * 1000) delete state.alerted[tk];
      save();
      const candidates = Object.values(state.tokens).filter((e) => e.score >= 50 || e.pass).sort((a, b) => b.score - a.score).slice(0, 20)
        .map((e) => ({ token: e.token, symbol: e.symbol, quoteSymbol: e.quoteSymbol, mcapUsd: e.mcapUsd, ageMin: e.ageMin, tokenAgeMin: e.tokenAgeMin, score: e.score, tvlUsd: e.tvlUsd, pool: e.pool, feePct: e.feePct, checks: e.checks, why: e.why, holders: e.holders, volume: e.volume, honeypot: e.honeypot && { ok: e.honeypot.ok, sellTaxPct: e.honeypot.sellTaxPct, error: e.honeypot.error }, alerted: !!state.alerted[e.token.toLowerCase()], at: e.at }));
      lastStatus = { ok: true, at: t0, ms: now() - t0, head, poolsInWindow: Object.keys(state.pools).length, tokensInWindow: byToken.size, evaluated, newPools: found, scannedToday: state.scannedToday, alertsToday: state.alertsToday, candidates, settings: st,
        recentAlerts: Object.entries(state.alerted).sort((a, b) => b[1].at - a[1].at).slice(0, 10).map(([tk, a]) => ({ token: tk, ...a })) };
      try { fs.writeFileSync(statusFile, JSON.stringify(lastStatus)); } catch {}
      log(`${found} new pool(s), ${byToken.size} token(s) in window, ${evaluated} evaluated, ${alerted} alert(s); ${candidates.length} candidate(s) ≥ 50 · ${now() - t0} ms`);
      return lastStatus;
    } finally { busy = false; }
  }

  return { scan, evaluate, honeypot, message, score, get status() { return lastStatus; }, get state() { return state; }, settings: st };
}

module.exports = { create, DEFAULTS, DANGER };
