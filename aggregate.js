/**
 * aggregate.js -- one read-only cross-chain view, built from what each chain's own
 * dashboard already computed.
 *
 * Pure apart from the injectable `fetchJson`: no HTTP server, no RPC, no price lookups,
 * no files. The chain router (chain-router.js) calls it with its fixed chain list; the
 * only things it ever asks an instance for are the four GET paths in PATHS, with no query
 * string and no cookies. Nothing in a request chooses a target.
 *
 * Three stages, so each can be tested alone:
 *   1. ingest   raw upstream JSON -> a small whitelisted copy. Every field that leaves
 *               this stage was named here; operator, unlock, ops, rpc, explorer, series,
 *               pnl and upstream error text never get past it.
 *   2. compose  one chain's four parts (fresh, or last-good) -> items, status, problems.
 *   3. build    all chains -> totals, breakdowns, merged wallets.
 *
 * Honesty rules (the reason this is not just a sum): a down, slow or stale chain is never
 * shown as $0; an unpriced value is null, never 0; nothing is counted twice (see dedupe
 * keys in compose); the figures an instance has not counted (thin pool, price gap,
 * unpriced) stay out of the total and are reported separately.
 */
"use strict";

const http = require("http");

const PATHS = Object.freeze({
  positions: "/api/positions",
  watch: "/api/watch",
  portfolio: "/api/portfolio",
  staking: "/api/staking",
});
const PART_NAMES = Object.freeze(Object.keys(PATHS));
const MAX_ITEMS_PER_KIND = 5000;
const SOURCE_STALE_MS = 15 * 60 * 1000;     // the instance's own staleness rule for /api/watch
const FORCE_GAP_MS = 5000;
const STR_MAX = 80;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

// ---- small helpers -------------------------------------------------------------
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
/** A finite, non-negative number or null. Strings, NaN, Infinity and negatives are not numbers here. */
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const str = (v, n = STR_MAX) => (typeof v === "string" ? v.slice(0, n) : "");
const addrOf = (v) => (typeof v === "string" && ADDR.test(v) ? v : null);
const lc = (v) => (typeof v === "string" ? v.toLowerCase() : null);
const round = (x) => Math.round(x * 1e6) / 1e6;

/** Short deterministic id; the full key stays out of the output (it is longer than 80 chars). */
function hash(s) {
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = (h1 * 33) ^ c; h2 = (h2 * 31 + c) | 0; }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

// ---- fetching ------------------------------------------------------------------
/**
 * GET one path from 127.0.0.1:<port>. Resolves, never rejects:
 *   { status, data }   an HTTP answer (data is the parsed JSON, or undefined when it did not parse)
 *   { code }           timeout | unreachable | too-large
 * The whole exchange has one deadline, and a body past maxBytes is aborted, not buffered.
 */
function defaultFetchJson(port, path, { timeoutMs = 8000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const abort = (code) => { finish({ code }); try { if (req) req.destroy(); } catch { /* already gone */ } };
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    try {
      req = http.request({ host: "127.0.0.1", port, path, method: "GET", headers: { accept: "application/json" } }, (res) => {
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) { abort("too-large"); res.destroy(); return; }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) { abort("too-large"); res.destroy(); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          let data;
          try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { data = undefined; }
          finish({ status: res.statusCode, data });
        });
        res.on("error", () => abort("unreachable"));
        res.on("aborted", () => abort("unreachable"));
      });
      req.on("error", () => abort("unreachable"));
      req.end();
    } catch { abort("unreachable"); }
  });
}

/** One upstream answer -> "ok" or a fixed code. Upstream error text is never carried. */
function classify(r) {
  if (!r || r.code) return (r && r.code) || "unreachable";
  const { status, data } = r;
  const loading = status === 202 || (status === 503 && isObj(data) && (data.refreshing === true || /loading/i.test(String(data.error || ""))));
  if (loading) return "loading";
  if (status !== 200) return `http-${Number.isInteger(status) ? status : 0}`;
  if (!isObj(data)) return "bad-json";
  if (data.ok === false) return data.refreshing === true ? "loading" : "upstream-error";
  return "ok";
}

// ---- stage 1: ingest (whitelist) -------------------------------------------------
function ingestEntry(e) {
  if (!isObj(e)) return null;
  const tokenId = str(e.tokenId, 60) || str(e.nftId, 60);
  if (!tokenId) return null;
  const rw = isObj(e.rewards)
    ? { symbol: str(e.rewards.symbol, 24), usd: num(e.rewards.usd), killed: e.rewards.killed === true }
    : null;
  return {
    tokenId,
    protocolName: typeof e.protocol === "string" && e.protocol ? e.protocol.slice(0, 60) : null,
    version: e.version === 3 || e.version === 4 ? e.version : null,
    pair: str(e.pair) || [str(e.symbol0, 24), str(e.symbol1, 24)].filter(Boolean).join(" / "),
    inRange: typeof e.inRange === "boolean" ? e.inRange : null,
    poolAddress: lc(addrOf(e.poolAddress)),
    pairAddress: lc(addrOf(e.pairAddress)),
    valueUsd: num(e.valueUsd),
    feesUsd: num(e.feesUsd),
    feesOk: e.feesOk !== false,
    thin: e.thin === true,
    counted: e.counted !== false,
    priceGap: typeof e.priceGapPct === "number" && Number.isFinite(e.priceGapPct),
    staked: e.staked === true,
    gaugeKilled: e.gaugeKilled === true,
    rewards: rw,
  };
}
const ingestEntries = (o) => [...arr(o && o.positions), ...arr(o && o.external)].map(ingestEntry).filter(Boolean);

function ingestToken(t) {
  if (!isObj(t)) return null;
  const address = lc(addrOf(t.address));
  return {
    symbol: str(t.symbol, 40),
    address,
    native: t.native === true || !address,
    amount: num(t.amount),
    price: num(t.price),
    usd: num(t.usd),
    thin: t.thin === true,
    assumed: t.assumed === true,
    unavailable: !!t.unavailable,
  };
}

function ingestStakingToken(t) {
  if (!isObj(t)) return null;
  const token = lc(addrOf(t.token));
  if (!token) return null;
  const r = isObj(t.rewards) ? t.rewards : {};
  return {
    token, symbol: str(t.symbol, 40), balance: num(t.balance), price: num(t.price), usd: num(t.usd), aprPct: num(t.aprPct),
    rewards: { d7Usd: num(r.d7Usd), d30Usd: num(r.d30Usd), totalUsd: num(r.totalUsd) },
  };
}

/** Raw upstream JSON for one part -> { data, at } (data holds only whitelisted fields). */
function ingest(name, raw) {
  const at = num(raw.at);
  if (name === "positions") {
    return { at, data: { owner: addrOf(raw.owner), ownerLabel: str(raw.ownerLabel), entries: ingestEntries(raw) } };
  }
  if (name === "watch") {
    const wallets = [];
    for (const w of arr(raw.wallets)) {
      if (!isObj(w)) continue;
      const address = addrOf(w.address);
      if (!address) continue;
      const h = isObj(w.holdings) ? w.holdings : null;
      wallets.push({
        address, label: str(w.label),
        ok: w.ok !== false && w.totals !== null,
        stale: w.stale === true, staleSince: num(w.staleSince),
        entries: ingestEntries(w),
        holdings: h ? {
          ok: h.ok !== false,
          tokens: arr(h.tokens).map(ingestToken).filter(Boolean),
          unscaled: arr(h.unscaled).filter(isObj).map((u) => ({ symbol: str(u.symbol, 40), address: lc(addrOf(u.address)) })),
        } : null,
      });
    }
    return { at, data: { wallets } };
  }
  if (name === "portfolio") {
    // Only what sits in the wallet: `pools`, `fees`, `total` and `usd` of a row include the
    // LP positions and uncollected fees that /api/positions already values.
    const tokens = [];
    for (const r of arr(raw.rows)) {
      if (!isObj(r)) continue;
      const address = lc(addrOf(r.address));
      const amount = num(r.wallet);
      const price = num(r.price);
      let usd = num(r.walletUsd);
      if (usd === null && amount !== null && price !== null) usd = amount * price;
      tokens.push({
        symbol: str(r.symbol, 40), address, native: r.native === true || !address,
        amount, price, usd, thin: r.thin === true, assumed: r.assumed === true, unavailable: !!r.unavailable,
      });
    }
    return { at, data: { owner: addrOf(raw.owner), tokens } };
  }
  const wallets = arr(raw.wallets).filter(isObj).map((w) => ({
    address: addrOf(w.address), label: str(w.label), tokens: arr(w.tokens).map(ingestStakingToken).filter(Boolean),
  })).filter((w) => w.address);
  return { at, data: { tokens: arr(raw.tokens).map(ingestStakingToken).filter(Boolean), wallets } };
}

// ---- protocol / reasons -----------------------------------------------------------
function protocolOf(e) {
  if (e.protocolName) {
    const n = e.protocolName.toLowerCase();
    if (n.includes("aerodrome") || n.includes("slipstream")) return "aerodrome";
    if (n.includes("pulsex")) return "pulsex-v2";
    return `other:${n}`.slice(0, STR_MAX);
  }
  if (e.version === 4) return "uniswap-v4";
  if (e.version === 3) return "uniswap-v3";
  return "other:unknown";
}

// ---- stage 2: one chain ------------------------------------------------------------
function blankState(chain) {
  return { chain, parts: {}, inflight: null, roundAt: 0, forcedAt: 0 };
}

/**
 * Items, status and problems for one chain.
 * state.parts[name] = { data, at, fetchedAt, code }: data is the last good ingest of that part
 * (kept when a later round fails), code is the latest failure ("ok"-equivalent null).
 */
function compose(state, now) {
  const chain = state.chain;
  const problems = [];
  const notes = [];                         // per-wallet remarks that do not make the chain partial
  const partsOut = {};
  const items = [];
  const wallets = [];                       // { address, key, label } seen on this chain
  const usable = {};
  let freshCount = 0, lastGoodAt = null, dataAt = null;

  for (const name of PART_NAMES) {
    const p = state.parts[name];
    if (!p) { partsOut[name] = "loading"; if (state.roundAt) problems.push({ part: name, code: "loading" }); continue; }
    if (p.code) {
      partsOut[name] = p.code;
      problems.push(p.data ? { part: name, code: p.code, since: p.fetchedAt } : { part: name, code: p.code });
    } else { partsOut[name] = "ok"; }
    if (!p.data) continue;
    const old = p.at !== null && now - p.at > SOURCE_STALE_MS;
    if (!p.code && old) problems.push({ part: name, code: "stale-source", since: p.at });
    const stale = !!p.code || old;
    if (!p.code) freshCount++;
    usable[name] = { data: p.data, stale, asOf: stale ? (p.code ? p.fetchedAt : p.at) : (p.at || p.fetchedAt) };
    lastGoodAt = Math.max(lastGoodAt || 0, p.fetchedAt || 0) || lastGoodAt;
    if (p.at !== null) dataAt = dataAt === null ? p.at : Math.min(dataAt, p.at);
  }
  if (!state.roundAt && !Object.keys(state.parts).length) {
    for (const n of PART_NAMES) partsOut[n] = "loading";
    problems.length = 0; problems.push({ part: "*", code: "loading" });
  }

  const have = Object.keys(usable);

  const pos = usable.positions, wat = usable.watch, pf = usable.portfolio, stk = usable.staking;
  const mainAddr = (pos && pos.data.owner) || (pf && pf.data.owner) || null;
  const mainKey = lc(mainAddr);
  const walletKeys = new Set();
  const walletOf = (address, label) => {
    const w = { address: address.slice(0, STR_MAX), key: address.toLowerCase(), label: label || "" };
    if (!walletKeys.has(w.key)) { walletKeys.add(w.key); wallets.push(w); }
    return w;
  };
  const mainWallet = mainAddr ? walletOf(mainAddr, (pos && pos.data.ownerLabel) || "Main") : null;

  const seenLp = new Set();
  const lpPairs = new Map();                // chain|wallet -> Set of pool/pair addresses
  const link = `/?chain=${encodeURIComponent(chain.key)}`;

  const addEntries = (wallet, entries, source, asOf, stale) => {
    for (const e of entries) {
      const protocol = protocolOf(e);
      const key = `${chain.key}|${wallet.key}|${protocol}|${e.tokenId}`;
      if (seenLp.has(key)) continue;        // first wins: /api/positions is read before /api/watch
      seenLp.add(key);
      const pairSet = lpPairs.get(`${wallet.key}`) || new Set();
      for (const a of [e.poolAddress, e.pairAddress]) if (a) pairSet.add(a);
      lpPairs.set(`${wallet.key}`, pairSet);

      const reason = e.valueUsd === null ? "unpriced"
        : e.thin ? "thin-pool"
          : !e.counted ? (e.priceGap ? "price-gap" : "unanchored") : null;
      const counted = reason === null;
      const r = e.rewards;
      let rewardsUsd = null, rewardsCounted = false, rewardsReason = null;
      if (r) {
        rewardsUsd = r.usd;
        if (r.killed || e.gaugeKilled) rewardsReason = "gauge-killed";
        else if (r.usd === null) rewardsReason = "unpriced";
        else rewardsCounted = true;
      }
      const feesUnavailable = !e.feesOk || (e.feesUsd === null && !e.staked);
      items.push({
        id: `${chain.key}-${hash(key)}`, kind: "lp", chain: chain.key,
        wallet: { ...wallet }, protocol, name: e.pair || e.tokenId,
        valueUsd: e.valueUsd, feesUsd: e.feesUsd, rewardsUsd, rewardsCounted, rewardsReason,
        rewardSymbol: r ? r.symbol : "",
        counted, reason,
        flags: { thin: e.thin, assumed: false, staked: e.staked, killedGauge: !!(e.gaugeKilled || (r && r.killed)), feesUnavailable, stale, staking: false },
        inRange: e.inRange, amount: null, price: null, asOf, source, link,
        _feesCounted: counted && e.feesOk && e.feesUsd !== null,
      });
    }
  };

  if (pos && mainWallet) addEntries(mainWallet, pos.data.entries, "positions", pos.asOf, pos.stale);
  if (wat) {
    for (const w of wat.data.wallets) {
      if (mainKey && w.address.toLowerCase() === mainKey) continue;     // the main wallet is read from /api/positions
      const wallet = walletOf(w.address, w.label);
      if (!w.ok) { problems.push({ wallet: wallet.key, code: "unavailable" }); continue; }
      const wStale = wat.stale || w.stale;
      const asOf = w.stale && w.staleSince ? w.staleSince : wat.asOf;
      if (w.stale) problems.push({ wallet: wallet.key, code: "stale", since: w.staleSince || undefined });
      addEntries(wallet, w.entries, "watch", asOf, wStale);
    }
  }

  // ---- tokens ----
  const tokenItems = [];
  const unknownWallets = new Set();         // token discovery never succeeded: the token list is incomplete, not empty
  const tokenByAddr = new Map();            // wallet|address -> first non-native row (staking tags it)
  const pushToken = (row) => {
    tokenItems.push(row);
    if (!row._native) { const k = `${row.wallet.key}|${row._addr}`; if (!tokenByAddr.has(k)) tokenByAddr.set(k, row); }
  };
  const seenTok = new Set();
  const tokenKeyOf = (walletKey, t) => `${chain.key}|${walletKey}|${t.native ? "native" : t.address}`;
  const addTokens = (wallet, tokens, source, asOf, stale, unscaled = []) => {
    const mine = [];
    const mineAddrs = new Set();           // _addr of rows added from tokens (the unscaled pass skips these)
    const pairSet = lpPairs.get(wallet.key) || new Set();
    for (const t of tokens) {
      let reason = null, counted = false, valueUsd = null;
      if (t.unavailable) reason = "decimals-unverified";
      else if (!(t.amount > 0)) continue;
      else if (!t.native && t.address && pairSet.has(t.address)) reason = "duplicate-of-holdings";
      else if (t.usd === null) reason = "unpriced";
      else { counted = true; valueUsd = t.usd; }
      const key = tokenKeyOf(wallet.key, t);
      if (seenTok.has(key)) continue;
      seenTok.add(key);
      if (t.address) mineAddrs.add(t.address);
      mine.push({
        id: `${chain.key}-${hash(key)}`, kind: "token", chain: chain.key, wallet: { ...wallet },
        protocol: "token", name: t.symbol || (t.native ? "native" : "token"),
        valueUsd, feesUsd: null, rewardsUsd: null, rewardsCounted: false, rewardsReason: null,
        counted, reason,
        flags: { thin: t.thin, assumed: t.assumed, staked: false, killedGauge: false, feesUnavailable: false, stale, staking: false },
        inRange: null, amount: t.amount, price: t.price, asOf, source, link,
        _addr: t.address, _native: t.native,
      });
    }
    for (const u of unscaled) {
      if (!u.address || mineAddrs.has(u.address)) continue;
      const key = `${chain.key}|${wallet.key}|${u.address}`;
      if (seenTok.has(key)) continue;
      seenTok.add(key);
      mineAddrs.add(u.address);
      mine.push({
        id: `${chain.key}-${hash(key)}`, kind: "token", chain: chain.key, wallet: { ...wallet },
        protocol: "token", name: u.symbol || "token", valueUsd: null, feesUsd: null, rewardsUsd: null, rewardsCounted: false, rewardsReason: null,
        counted: false, reason: "decimals-unverified",
        flags: { thin: false, assumed: false, staked: false, killedGauge: false, feesUnavailable: false, stale, staking: false },
        inRange: null, amount: null, price: null, asOf, source, link, _addr: u.address, _native: false,
      });
    }
    // The native coin and its ERC-20 twin (Arc's USDC) are one asset: keep the native row.
    const nativesByName = new Map();
    for (const n of mine) if (n._native) { const k = n.name.toLowerCase(); if (!nativesByName.has(k)) nativesByName.set(k, []); nativesByName.get(k).push(n); }
    for (const m of mine) {
      if (m._native) continue;
      const twin = (nativesByName.get(m.name.toLowerCase()) || []).find((n) => n.amount !== null && m.amount !== null && Math.abs(n.amount - m.amount) <= 1e-6 * Math.max(1, n.amount));
      if (!twin) pushToken(m);
    }
    for (const m of mine) if (m._native) pushToken(m);
  };

  if (pf && mainWallet) addTokens(mainWallet, pf.data.tokens, "portfolio", pf.asOf, pf.stale);
  if (wat) {
    for (const w of wat.data.wallets) {
      if (mainKey && w.address.toLowerCase() === mainKey) continue;
      if (!w.ok) continue;
      const wallet = walletOf(w.address, w.label);
      if (!w.holdings) continue;
      if (!w.holdings.ok) { notes.push({ wallet: wallet.key, code: "holdings-unavailable" }); unknownWallets.add(wallet.key); }
      const asOf = w.stale && w.staleSince ? w.staleSince : wat.asOf;
      addTokens(wallet, w.holdings.tokens, "watch", asOf, wat.stale || w.stale, w.holdings.unscaled);
    }
  }
  if (!pf) problems.push(...(mainWallet && partsOut.portfolio !== "ok" ? [{ wallet: mainWallet.key, code: "tokens-unavailable" }] : []));
  // the tokens problem above duplicates the part problem for a reader: keep it, it names the wallet.

  // ---- staking: tag the holdings row; add a balance only when no row carries it ----
  if (stk) {
    const applyStaking = (wallet, tokens) => {
      for (const s of tokens) {
        const row = tokenByAddr.get(`${wallet.key}|${s.token}`);
        if (row) {
          row.flags.staking = true;
          row.stakingRewards = { d7Usd: s.rewards.d7Usd, d30Usd: s.rewards.d30Usd, totalUsd: s.rewards.totalUsd };
          row.aprPct = s.aprPct;
          continue;
        }
        if (!(s.balance > 0)) continue;
        const key = `${chain.key}|${wallet.key}|staking|${s.token}`;
        if (seenTok.has(key)) continue;
        seenTok.add(key);
        pushToken({
          id: `${chain.key}-${hash(key)}`, kind: "staking", chain: chain.key, wallet: { ...wallet },
          protocol: "staking", name: s.symbol || "staking",
          valueUsd: s.usd, feesUsd: null, rewardsUsd: null, rewardsCounted: false, rewardsReason: null,
          counted: s.usd !== null, reason: s.usd === null ? "unpriced" : null,
          flags: { thin: false, assumed: false, staked: false, killedGauge: false, feesUnavailable: false, stale: stk.stale, staking: true },
          inRange: null, amount: s.balance, price: s.price, asOf: stk.asOf, source: "staking", link,
          stakingRewards: { d7Usd: s.rewards.d7Usd, d30Usd: s.rewards.d30Usd, totalUsd: s.rewards.totalUsd }, aprPct: s.aprPct,
          _addr: s.token, _native: false,
        });
      }
    };
    if (mainWallet) applyStaking(mainWallet, stk.data.tokens);
    else if (stk.data.tokens.length) problems.push({ part: "staking", code: "no-owner" });
    for (const w of stk.data.wallets) {
      if (mainKey && w.address.toLowerCase() === mainKey) continue;
      applyStaking(walletOf(w.address, w.label), w.tokens);
    }
  }
  for (const it of tokenItems) if (unknownWallets.has(it.wallet.key)) it.flags.holdingsUnknown = true;
  items.push(...tokenItems);

  // Decided last: a wallet that could not be read makes the chain partial, like a missing part.
  let status;
  if (!have.length) status = Object.values(partsOut).some((c) => c === "loading") ? "loading" : "down";
  else if (!freshCount) status = "stale";
  else status = problems.length ? "partial" : "ok";

  return {
    chain, status, problems, notes, parts: partsOut, items, wallets,
    fetchedAt: state.roundAt || null, dataAt, lastGoodAt: have.length ? lastGoodAt : null,
  };
}

// ---- stage 3: all chains --------------------------------------------------------------
function build(composed, { now = Date.now(), ttlMs = 30000 } = {}) {
  const totals = {
    grandUsd: 0, lpUsd: 0, feesUsd: 0, rewardsUsd: 0, tokensUsd: 0, uncountedUsd: 0, uncountedCount: 0,
    rewardsUncountedUsd: 0, rewardsUncountedCount: 0, assumedUsd: 0, staleUsd: 0, staleOldestAsOf: null, itemCount: 0,
  };
  const byChain = {}, byWallet = {}, byProtocol = {};
  const walletMap = new Map();
  const chainsOut = [];
  const all = [];
  const incompleteList = [];
  const add = (obj, k, v) => { obj[k] = (obj[k] || 0) + v; };

  for (const c of composed) {
    const cTotals = { countedUsd: 0, uncountedUsd: 0, staleUsd: 0 };
    for (const w of c.wallets) {
      let m = walletMap.get(w.key);
      if (!m) { m = { key: w.key, address: w.address, label: "", labels: {}, aliases: [], chains: [], countedUsd: 0, unreadable: 0, notes: [] }; walletMap.set(w.key, m); }
      if (!m.chains.includes(c.chain.key)) {
        m.chains.push(c.chain.key);
        // a watched wallet the chain could not read at all has no figure there, not a zero one
        if (c.problems.some((p) => p.wallet === w.key && p.code === "unavailable")) m.unreadable++;
      }
      if (w.label) m.labels[c.chain.key] = w.label;
      for (const n of c.notes || []) if (n.wallet === w.key && !m.notes.includes(n.code)) m.notes.push(n.code);
    }
    for (const it of c.items) {
      all.push(it);
      let contrib = 0;
      if (it.kind === "lp") {
        if (it.counted) { totals.lpUsd += it.valueUsd; contrib += it.valueUsd; }
        if (it._feesCounted) { totals.feesUsd += it.feesUsd; contrib += it.feesUsd; }
        if (it.rewardsCounted) { totals.rewardsUsd += it.rewardsUsd; contrib += it.rewardsUsd; }
        else if (it.rewardsReason) { totals.rewardsUncountedCount++; if (it.rewardsUsd !== null) totals.rewardsUncountedUsd += it.rewardsUsd; }
        if (!it.counted) { totals.uncountedCount++; if (it.valueUsd !== null) { totals.uncountedUsd += it.valueUsd; cTotals.uncountedUsd += it.valueUsd; } }
      } else {
        if (it.counted) {
          totals.tokensUsd += it.valueUsd; contrib += it.valueUsd;
          if (it.flags.assumed) totals.assumedUsd += it.valueUsd;
        } else { totals.uncountedCount++; }
      }
      if (contrib !== 0 || it.counted || it.rewardsCounted) {
        add(byChain, c.chain.key, contrib); add(byWallet, it.wallet.key, contrib); add(byProtocol, it.protocol, contrib);
        cTotals.countedUsd += contrib;
        const m = walletMap.get(it.wallet.key); if (m) m.countedUsd += contrib;
        if (it.flags.stale) {
          cTotals.staleUsd += contrib; totals.staleUsd += contrib;
          if (contrib !== 0 && it.asOf) totals.staleOldestAsOf = totals.staleOldestAsOf === null ? it.asOf : Math.min(totals.staleOldestAsOf, it.asOf);
        }
      }
      it._contrib = contrib;
    }
    const noData = c.status === "down" || c.status === "loading";
    if (noData) byChain[c.chain.key] = null; else if (!(c.chain.key in byChain)) byChain[c.chain.key] = 0;
    if (c.status !== "ok") {
      if (!c.problems.length) incompleteList.push({ chain: c.chain.key, code: c.status });
      for (const p of c.problems) incompleteList.push({ chain: c.chain.key, ...(p.part ? { part: p.part } : { wallet: p.wallet }), code: p.code });
    } else for (const p of c.problems) incompleteList.push({ chain: c.chain.key, ...(p.part ? { part: p.part } : { wallet: p.wallet }), code: p.code });
    const ref = c.status === "stale" ? c.lastGoodAt : (c.dataAt || c.fetchedAt);
    chainsOut.push({
      key: c.chain.key, label: c.chain.label, accent: c.chain.accent, status: c.status,
      fetchedAt: c.fetchedAt, dataAt: c.dataAt, lastGoodAt: c.lastGoodAt, ageMs: ref ? Math.max(0, now - ref) : null,
      problems: c.problems.map((p) => ({ ...p })), notes: (c.notes || []).map((n) => ({ ...n })), parts: c.parts,
      totals: noData ? { countedUsd: null, uncountedUsd: null, staleUsd: null }
        : { countedUsd: round(cTotals.countedUsd), uncountedUsd: round(cTotals.uncountedUsd), staleUsd: round(cTotals.staleUsd) },
    });
  }

  totals.grandUsd = totals.lpUsd + totals.feesUsd + totals.rewardsUsd + totals.tokensUsd;
  totals.itemCount = all.length;
  for (const k of ["grandUsd", "lpUsd", "feesUsd", "rewardsUsd", "tokensUsd", "uncountedUsd", "rewardsUncountedUsd", "assumedUsd", "staleUsd"]) totals[k] = round(totals[k]);
  for (const o of [byChain, byWallet, byProtocol]) for (const k of Object.keys(o)) if (o[k] !== null) o[k] = round(o[k]);

  // wallets: first non-empty label in CHAINS order, the rest as aliases
  const order = composed.map((c) => c.chain.key);
  const walletsOut = [...walletMap.values()].map((m) => {
    const labs = order.map((k) => m.labels[k]).filter(Boolean);
    const label = labs[0] || "";
    return {
      key: m.key, address: m.address, label, aliases: [...new Set(labs.filter((l) => l !== label))],
      labels: m.labels, chains: m.chains,
      ...(m.notes.length ? { notes: m.notes, holdingsUnknown: m.notes.includes("holdings-unavailable") } : {}),
      ...(m.unreadable >= m.chains.length ? { countedUsd: null, unavailable: true } : { countedUsd: round(m.countedUsd) }),
    };
  });
  const labelOf = new Map(walletsOut.map((w) => [w.key, w.label]));
  for (const it of all) it.wallet.label = labelOf.get(it.wallet.key) || it.wallet.label;

  // output: sorted, capped per kind; totals above were computed on the full set
  all.sort((a, b) => (a.valueUsd === null) - (b.valueUsd === null) || (b.valueUsd || 0) - (a.valueUsd || 0));
  const perKind = {};
  let truncated = false;
  const items = [];
  for (const it of all) {
    perKind[it.kind] = (perKind[it.kind] || 0) + 1;
    if (perKind[it.kind] > MAX_ITEMS_PER_KIND) { truncated = true; continue; }
    const out = {};
    for (const k of Object.keys(it)) if (!k.startsWith("_")) out[k] = it[k];
    items.push(out);
  }

  return {
    ok: true, at: now, ttlMs,
    chains: chainsOut, wallets: walletsOut, items, totals,
    breakdown: { byChain, byWallet, byProtocol },
    incomplete: composed.some((c) => c.status !== "ok") || incompleteList.length > 0,
    incompleteList, truncated,
  };
}

// ---- the stateful part: cache, one in-flight round per chain ---------------------------
function createAggregator(opts = {}) {
  const chains = opts.chains || [];
  const timeoutMs = opts.timeoutMs ?? 8000;
  const waitMs = opts.waitMs ?? 4000;
  const ttlMs = opts.ttlMs ?? 30000;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const clock = opts.now || Date.now;
  const fetchJson = opts.fetchJson || ((chain, path) => defaultFetchJson(chain.port, path, { timeoutMs, maxBytes }));
  const states = new Map(chains.map((c) => [c.key, blankState(c)]));

  async function fetchPart(chain, name) {
    let r;
    try { r = await fetchJson(chain, PATHS[name]); } catch { r = { code: "unreachable" }; }
    const code = classify(r);
    if (code !== "ok") return { code };
    try { return { code: null, ...ingest(name, r.data) }; } catch { return { code: "bad-json" }; }
  }

  function round(state) {
    const results = Promise.all(PART_NAMES.map((n) => fetchPart(state.chain, n).catch(() => ({ code: "unreachable" }))));
    return results.then((rs) => {
      const t = clock();
      PART_NAMES.forEach((n, i) => {
        const r = rs[i];
        const prev = state.parts[n];
        if (r.code === null) state.parts[n] = { data: r.data, at: r.at, fetchedAt: t, code: null };
        else state.parts[n] = { data: prev ? prev.data : null, at: prev ? prev.at : null, fetchedAt: prev && prev.data ? prev.fetchedAt : t, code: r.code };
      });
      state.roundAt = t;
      state.seq = (state.seq || 0) + 1;     // a finished round, even when the clock did not move
    }).catch(() => { /* a bug in a round must not leave the chain locked */ }).then(() => { state.inflight = null; });
  }

  /** Start (or join) a round for one chain, unless the cache is fresh. */
  function ensure(state, force) {
    if (state.inflight) return state.inflight;
    const t = clock();
    const fresh = state.roundAt && t - state.roundAt < ttlMs;
    const allowForce = force && t - state.forcedAt >= FORCE_GAP_MS;
    if (fresh && !allowForce) return Promise.resolve();
    if (allowForce) state.forcedAt = t;
    state.inflight = round(state);
    return state.inflight;
  }

  async function get({ refresh = false } = {}) {
    const rounds = [...states.values()].map((s) => ensure(s, refresh));
    let timer;
    const deadline = new Promise((res) => { timer = setTimeout(res, waitMs); });
    await Promise.race([Promise.all(rounds), deadline]);
    clearTimeout(timer);
    return snapshot();
  }

  // The payload is rebuilt (compose + build + JSON.stringify) only when a round has finished on some
  // chain; every request in between reuses it. Its `at` and ages are those of the build.
  let cache = null;
  const stats = { builds: 0 };
  const versionOf = () => [...states.values()].map((s) => `${s.roundAt || 0}.${s.seq || 0}`).join("|");

  function cached() {
    const v = versionOf();
    if (cache && cache.v === v) return cache;
    const now = clock();
    const composed = [...states.values()].map((s) => compose(s, now));
    const payload = build(composed, { now, ttlMs });
    stats.builds++;
    cache = { v, payload, json: JSON.stringify(payload) };
    return cache;
  }

  function snapshot() { return cached().payload; }
  async function getJson(opts) { await get(opts); return cached().json; }

  return { get, getJson, snapshot, states, stats };
}

module.exports = {
  PATHS, PART_NAMES, MAX_ITEMS_PER_KIND, SOURCE_STALE_MS, defaultFetchJson, classify, ingest, compose, build,
  blankState, createAggregator, protocolOf,
};
