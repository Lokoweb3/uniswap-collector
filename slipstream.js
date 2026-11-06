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
 * Staked positions are found, in this order and as a union, from: the wallet's
 * own NFT transfers out of the manager (Blockscout, when it answers JSON);
 * `tokenIds` pinned in settings (ownerOf: a contract owner is a gauge candidate);
 * the gauges of pools the wallet still holds an NFT in; and, when Blockscout is
 * unavailable, a resumable eth_getLogs scan of the manager's Transfer events to
 * and from the wallet. Each candidate gauge is confirmed on chain (its nft() is
 * THIS manager) and asked which ids it holds for the wallet. Nothing is sent:
 * every call is a view or a static call.
 *
 * Several managers can coexist on one chain (Aerodrome on Base has three NPMs
 * that all answer name() "Slipstream Position NFT v1"): a reader is identified
 * by its configured address and `name`, never by what the contract calls itself,
 * and a gauge whose nft() is another manager is rejected.
 *
 * A gauge can be killed (voter.isAlive false): earned() then reverts, and the
 * reward is reported as zero with a "gauge killed" note rather than as an error.
 *
 * These positions are kept apart from the Uniswap ones (watch.js puts them in
 * `external`, not `positions`): the collector, the guardian and the Sell tab act
 * on `positions`, and none of them can act on a gauge-held NFT.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const u = require("./univ3");
const { redactText } = require("./endpoint");

const NPM_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
];
const FACTORY_ABI = ["function getPool(address,address,int24) view returns (address)", "function voter() view returns (address)"];
const VOTER_ABI = ["function isAlive(address) view returns (bool)"];
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)",
  "function gauge() view returns (address)",
];
const GAUGE_ABI = [
  "function nft() view returns (address)",
  "function rewardToken() view returns (address)",
  "function stakedValues(address) view returns (uint256[])",
  "function stakedContains(address,uint256) view returns (bool)",
  "function earned(address,uint256) view returns (uint256)",
];
const V2_FACTORY_ABI = ["function getPool(address,address,bool) view returns (address)"];
const V2_POOL_ABI = ["function token0() view returns (address)", "function getReserves() view returns (uint256,uint256,uint256)"];

// A reward price read from a pool holding less than this much of its quote is a quote, not a value.
const MIN_QUOTE_USD = 100;
const MAX_OWNED = 50;     // wallet-held NFTs read per refresh, newest first
const GAUGE_TTL = 6 * 3600e3;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const DEFAULT_LOG_RANGE = 2_000_000;  // when neither the spec nor chain.maxLogRange says (Robinhood's RPC answers this)
const MIN_LOG_RANGE = 1000;           // the narrowest window a refused scan shrinks to
const DEFAULT_SCAN_BUDGET = 200;      // getLogs calls per wallet per refresh
const DEFAULT_SCAN_MS = 10_000;       // wall-clock per wallet per refresh: a slow RPC must not stall the page
const DEFAULT_BACKOFF_MS = 3600e3;    // after a range the RPC will not serve (archive limit), history is not retried for this long
const MAX_KEPT = 200;                 // recipients / ids remembered per wallet in the scan state

/** Code that makes an address a contract. An EOA, and an EIP-7702 delegated EOA (0xef0100 + 20 bytes), are not. */
const isContractCode = (code) => !!code && code !== "0x" && !/^0xef0100/i.test(code);

/**
 * spec: { name, positionManager, factory, poolFactory?, tokenIds?, fromBlock?, scanRange?, scanBudget?, scanMs?, scan? }
 * (scan: false switches the log scan off; true forces it; unset = only when Blockscout is unavailable)
 * from settings.json contracts.slipstream. bsFetch: blockscout.js's fetch, or null.
 * logsProvider: where eth_getLogs goes when the main RPC refuses it (chain.logsRpcUrl).
 * dataDir: where the scan cursor lives (the instance's data directory by default).
 */
function create({ provider, cfg, spec, priceSides, toFloat, bsFetch = null, logsProvider = null, dataDir = null, log = console }) {
  const name = String(spec.name || "cl");
  const scanProvider = logsProvider || provider;
  const pinned = (Array.isArray(spec.tokenIds) ? spec.tokenIds : []).map((x) => { try { return BigInt(x); } catch { return null; } }).filter((x) => x != null);
  const fromBlock = Math.max(0, Number(spec.fromBlock) || 0);
  // Slipstream's own scan window. chain.maxLogRange is deliberately NOT inherited: it is the
  // limit of the chain's main RPC (v4 discovery, Uniswap readers) and would silently shrink
  // this scan on a chain whose log RPC serves far more (Robinhood: 2,000,000).
  const logRange = Math.max(MIN_LOG_RANGE, Number(spec.scanRange) || Number(spec.maxLogRange) || DEFAULT_LOG_RANGE);
  const scanBudget = Math.max(2, Number(spec.scanBudget) || DEFAULT_SCAN_BUDGET);
  const scanMs = Number(spec.scanMs) > 0 ? Number(spec.scanMs) : DEFAULT_SCAN_MS;
  const backoffMs = spec.scanBackoffMs != null ? Number(spec.scanBackoffMs) : DEFAULT_BACKOFF_MS;
  const stateFile = path.join(dataDir || require("./data-dir").DATA_DIR, `slipstream-scan-${name.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.json`);
  let warnedBlockscout = false;
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

  /**
   * Addresses the wallet sent this manager's NFTs to (the gauges it staked in, among
   * others), from Blockscout. `ok` is false when Blockscout did not answer JSON (a
   * Cloudflare page, a 402/403, a timeout, no client): that is "unavailable", which is
   * not the same as "the wallet sent nothing", and it is said once.
   */
  async function sentTo(wallet) {
    const unavailable = (why) => {
      if (!warnedBlockscout) { warnedBlockscout = true; log.warn(`${name}: Blockscout unavailable (${why}); staked positions come from pinned ids and the RPC log scan`); }
      return { addrs: [], ok: false };
    };
    if (!bsFetch) return unavailable("no explorer client");
    try {
      const r = await bsFetch(`/v2/addresses/${wallet}/token-transfers?type=ERC-721&filter=from&token=${npmAddr}`, { timeoutMs: 20000 });
      const ctype = String((r.headers && r.headers.get && r.headers.get("content-type")) || "");
      if (!r.ok) return unavailable(`HTTP ${r.status}`);
      if (r.headers && r.headers.get && !/json/i.test(ctype)) return unavailable("not JSON");
      const d = await r.json();
      const out = new Set();
      for (const i of d.items || []) {
        const to = i.to && i.to.hash;
        if (to && to !== ethers.ZeroAddress && i.token && String(i.token.address_hash || i.token.address || "").toLowerCase() === npmAddr.toLowerCase()) out.add(ethers.getAddress(to));
      }
      return { addrs: [...out], ok: true };
    } catch (err) {
      return unavailable(redactText(String(err && (err.shortMessage || err.message) || "error")).slice(0, 60));
    }
  }

  /** The contract that owns an NFT, when it is one (not the wallet, not an EOA, not a delegated EOA); else null. */
  async function contractOwnerOf(id, wallet) {
    try {
      const owner = await npm.ownerOf(id);
      if (owner.toLowerCase() === String(wallet).toLowerCase()) return null;
      return isContractCode(await provider.getCode(owner)) ? ethers.getAddress(owner) : null;
    } catch {
      return null;     // burned, or the read failed: nothing to learn from it
    }
  }

  // ---- RPC log scan: the discovery of last resort, resumable across refreshes ----
  let scanState = null;
  const loadState = () => {
    if (scanState) return scanState;
    try { scanState = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { scanState = null; }
    if (!scanState || typeof scanState !== "object" || !scanState.wallets) scanState = { version: 1, manager: npmAddr, wallets: {} };
    return scanState;
  };
  const saveState = () => {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(scanState));
      fs.renameSync(tmp, stateFile);
    } catch { /* a cursor that cannot be saved only costs a rescan */ }
  };
  const asAddr = (topic) => ethers.getAddress(ethers.dataSlice(topic, 12));
  const keep = (arr, add) => [...new Set([...(arr || []), ...add])].slice(-MAX_KEPT);

  /**
   * Transfer logs of this manager to and from the wallet, newest history first: forward
   * from the last block read to the head, then backward from the lowest block read down
   * to `fromBlock`. Both directions (from=wallet finds the gauges it staked into,
   * to=wallet the NFTs it received) are read for each range, and the cursor only moves
   * over a range whose two reads both succeeded. A refused range shrinks the window
   * (a quarter at a time, to MIN_LOG_RANGE) before it counts as a failure; a failure
   * leaves the result partial, never silently empty. At most `scanBudget` getLogs
   * calls per call, so a long history converges over several refreshes.
   */
  async function scanLogs(wallet) {
    const st = loadState();
    const key = wallet.toLowerCase();
    const w = st.wallets[key] = st.wallets[key] || { lo: null, hi: null, recipients: [], ids: [], width: logRange };
    const padded = ethers.zeroPadValue(wallet, 32);
    const out = { calls: 0, partial: false, error: null };
    const deadline = Date.now() + scanMs;
    // Every provider call is raced against the time left, so a hanging RPC cannot hold a refresh past scanMs.
    // Running out of the overall budget is "BUDGET" (no backoff: a slow but answering RPC is
    // not a failing one); only a call that hung through its full per-call cap is "TIMEOUT".
    let answered = false;
    const raceDeadline = (p, isLogs) => {
      const left = deadline - Date.now();
      if (left <= 0) { Promise.resolve(p).catch(() => {}); return Promise.reject(Object.assign(new Error("log scan budget used up"), { code: "BUDGET" })); }
      const cap = Math.min(left, scanMs);
      // TIMEOUT only when nothing in this scan has answered: the RPC hung through the whole cap.
      // Once any call answered, running out of time means a slow RPC, not a dead one: BUDGET.
      const capped = !answered;
      let t;
      const timer = new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(capped ? "log scan timed out" : "log scan budget used up"), { code: capped ? "TIMEOUT" : "BUDGET" })), cap); });
      return Promise.race([p.then((v) => { if (isLogs) answered = true; return v; }), timer]).finally(() => { clearTimeout(t); Promise.resolve(p).catch(() => {}); });
    };
    const paused = !!(w.backoffUntil && Date.now() < w.backoffUntil);   // history refused recently: only catch up forward
    if (paused) { out.partial = true; out.error = `older history was refused by the log RPC (${w.lastError || "error"}); retrying later`; }
    let head;
    try { head = await raceDeadline(scanProvider.getBlockNumber()); } catch (err) { return { ...out, partial: true, error: reasonOf(err) }; }
    if (w.hi == null) { w.hi = head; w.lo = head + 1; }   // nothing read yet: everything is "below lo"
    let width = Math.min(Number(w.width) || logRange, logRange);
    const one = async (lo, hi) => {
      const sent = await raceDeadline(scanProvider.getLogs({ address: npmAddr, topics: [TRANSFER_TOPIC, padded], fromBlock: lo, toBlock: hi }), true);
      const got = await raceDeadline(scanProvider.getLogs({ address: npmAddr, topics: [TRANSFER_TOPIC, null, padded], fromBlock: lo, toBlock: hi }), true);
      out.calls += 2;
      w.recipients = keep(w.recipients, sent.map((l) => asAddr(l.topics[2])).filter((a) => a !== ethers.ZeroAddress));
      w.ids = keep(w.ids, got.map((l) => BigInt(l.topics[3]).toString()));
    };
    const step = async (lo, hi, commit) => {
      while (true) {
        if (out.calls + 2 > scanBudget || Date.now() > deadline) return "budget";
        try { await one(lo, hi); commit(); return "ok"; } catch (err) {
          if (err && err.code === "BUDGET") return "budget";   // overall budget ran out mid-call: stop, no backoff, no shrink
          out.calls += 2;
          // A timeout is the RPC failing to answer at all, not refusing a range: narrowing the
          // window would only repeat the hang. Straight to backoff.
          if (width <= MIN_LOG_RANGE || (err && err.code === "TIMEOUT")) {
            out.partial = true; out.error = reasonOf(err);
            w.lastError = out.error; w.backoffUntil = Date.now() + backoffMs;
            return "fail";
          }
          width = Math.max(MIN_LOG_RANGE, Math.floor(width / 4));
          w.width = width;
          return "shrunk";
        }
      }
    };
    // forward: blocks since the last scan
    while (w.hi < head) {
      const lo = w.hi + 1, hi = Math.min(lo + width - 1, head);
      const r = await step(lo, hi, () => { w.hi = hi; if (w.lo > lo) w.lo = lo; });
      if (r === "budget" || r === "fail") break;
    }
    // backward: history below what has been read
    while (!out.partial && !paused && w.lo > fromBlock) {
      const hi = w.lo - 1, lo = Math.max(fromBlock, hi - width + 1);
      const r = await step(lo, hi, () => { w.lo = lo; });
      if (r === "budget") break;
      if (r === "fail") break;
    }
    if (!out.partial && w.backoffUntil) { delete w.backoffUntil; delete w.lastError; }
    const complete = w.hi >= head && w.lo <= fromBlock;
    // Out of budget is not a failure, but the answer is incomplete until a later refresh finishes it.
    if (!complete) out.partial = true;
    w.head = head;
    saveState();
    return { ...out, recipients: w.recipients.map((a) => ethers.getAddress(a)), ids: w.ids.map((x) => BigInt(x)), complete };
  }
  const reasonOf = (err) => redactText(String((err && (err.shortMessage || err.message)) || err || "unknown")).slice(0, 120);

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

  /** Whether the voter still counts this gauge. Null when it cannot be read (then nothing is assumed). */
  let voterAddr;
  async function gaugeAlive(addr) {
    try {
      if (voterAddr === undefined) voterAddr = await factory.voter().catch(() => null);
      if (!voterAddr || voterAddr === ethers.ZeroAddress) return null;
      return Boolean(await new ethers.Contract(voterAddr, VOTER_ABI, provider).isAlive(addr));
    } catch {
      return null;
    }
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
    let f0 = 0, f1 = 0, feesOk = true, feesError = null, rewards = null, gaugeKilled = null;
    if (gauge) {
      const g = new ethers.Contract(gauge.address, GAUGE_ABI, provider);
      const rt = await u.getToken(gauge.rewardToken, provider);
      const alive = await gaugeAlive(gauge.address);
      gaugeKilled = alive === false;
      try {
        const raw = await g.earned(wallet, id);
        const amount = rt.decimalsOk === true ? toFloat(raw, rt.decimals) : null;
        const px = amount == null ? null : await rewardUsd(gauge.rewardToken, wethUsd);
        rewards = { token: gauge.rewardToken, symbol: rt.symbol, amount, usd: px == null || amount == null ? null : amount * px, priceUsd: px, ...(gaugeKilled ? { killed: true, note: "gauge killed: no new rewards accrue" } : {}) };
      } catch (err) {
        // A killed gauge's earned() reverts ("NA"): nothing is claimable there, which is a
        // known zero with a reason, not a failed read.
        rewards = gaugeKilled
          ? { token: gauge.rewardToken, symbol: rt.symbol, amount: 0, usd: 0, priceUsd: null, killed: true, note: "gauge killed" }
          : { token: gauge.rewardToken, symbol: rt.symbol, amount: null, usd: null, error: err.shortMessage || err.message };
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
      gaugeKilled: gauge ? gaugeKilled : null,
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
    const notes = [];    // informational lines (not position errors), one per reader
    const owned = [];
    const n = Number(await npm.balanceOf(wallet));
    for (let i = Math.max(0, n - MAX_OWNED); i < n; i++) owned.push(await npm.tokenOfOwnerByIndex(wallet, i));
    // Candidate gauges: where the wallet sent its NFTs, where pinned ids sit, and the
    // gauges of the pools it still holds NFTs in. Blockscout first, when it answers.
    const bs = await sentTo(wallet);
    const cands = new Set(bs.addrs);
    const hints = new Map();               // gauge address -> ids that led to it
    const hint = (addr, id) => { cands.add(addr); const k = addr.toLowerCase(); hints.set(k, [...(hints.get(k) || []), id]); };
    for (const id of pinned) {
      const g = await contractOwnerOf(id, wallet);
      if (g) hint(g, id);
    }
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
    // The log scan runs when Blockscout could not answer, or when the spec asks for it.
    if (spec.scan === true || (spec.scan !== false && !bs.ok)) {
      try {
        const sc = await scanLogs(wallet);
        for (const a of sc.recipients || []) cands.add(a);
        for (const id of (sc.ids || []).slice(-MAX_OWNED)) {
          const g = await contractOwnerOf(id, wallet);
          if (g) hint(g, id);
        }
        if (sc.partial) notes.push(`${name}: staked-position discovery is partial: ${sc.error || "the log scan has not covered the whole history yet"} (${sc.calls} log calls this refresh; pinned tokenIds and gauges of held pools were still checked)`);
      } catch (err) {
        notes.push(`${name}: staked-position discovery is partial: ${reasonOf(err)}`);
      }
    }
    const staked = [];
    const seenStaked = new Set();
    for (const addr of cands) {
      const g = await gaugeInfo(addr);
      if (!g) continue;
      const add = (id) => { const k = id.toString(); if (!seenStaked.has(k)) { seenStaked.add(k); staked.push({ id: BigInt(id), gauge: g }); } };
      const gc = new ethers.Contract(g.address, GAUGE_ABI, provider);
      try {
        for (const id of await gc.stakedValues(wallet)) add(id);
      } catch (err) {
        errors.push({ tokenId: `${name}-gauge`, error: `could not read the gauge ${g.address}: ${err.shortMessage || err.message}` });
      }
      for (const id of hints.get(g.address.toLowerCase()) || []) {
        try { if (await gc.stakedContains(wallet, id)) add(id); } catch { /* stakedValues is the primary read */ }
      }
    }
    const positions = [];
    let closed = 0;
    const ownedIds = owned.filter((id) => !seenStaked.has(id.toString()));
    for (const { id, gauge } of [...staked, ...ownedIds.map((id) => ({ id, gauge: null }))]) {
      try {
        const p = await readPosition(id, wallet, gauge, wethUsd);
        if (p.closed) closed++;
        else positions.push(p);
      } catch (err) {
        errors.push({ tokenId: `${name}-${id}`, error: err.shortMessage || err.message });
      }
    }
    return { positions, closed, errors, notes };
  }

  return { name, positionManager: npmAddr, positionsOf };
}

module.exports = { create };
