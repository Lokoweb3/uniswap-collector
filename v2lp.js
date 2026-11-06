/**
 * Uniswap-v2-style LP positions (PulseX v1 and v2 on PulseChain), read-only.
 *
 * A v2 position is not an NFT: it is a balance of the pair's own ERC-20. Its worth is
 *     lpBalance / totalSupply x (reserve0 x price0 + reserve1 x price1)
 * and the trading fees it earned are inside the reserves, realised only when liquidity
 * is removed, so fee0 / fee1 are 0 with a note rather than an invented figure.
 *
 * What is trusted and what is not (PulseChain is full of look-alikes):
 *   - A pair counts only if pair.factory() is THE configured factory of this reader
 *     (PulseX v1 and v2 are told apart by it, never by the LP's symbol: both are "PLP",
 *     and an unrelated "PLP" token exists). A Blockscout token list is only a list of
 *     candidates; every one is confirmed on chain.
 *   - Stablecoins are keyed by ADDRESS (contracts.pulsex.stables, plus usdReference.stable). The
 *     forked "pDAI" is not a dollar and is priced like any other token.
 *   - A token is priced against WPLS or a configured stable through a DIFFERENT pair
 *     than the one being valued; a pair's own ratio never prices its own tokens, and a
 *     pool whose quote side holds less than MIN_QUOTE_USD (default 100) is not a price
 *     source. No price gives valueUsd null with a reason, never 0.
 *   - The claimed factory must list the pair back: factory().getPair(token0, token1) has to
 *     return the very address, so a forged contract claiming factory() is rejected. A balance
 *     larger than totalSupply is rejected too.
 *   - An LP is valued as 2 x min(side0Usd, side1Usd), each side capped at what selling it through its
 *     price-source pool would realise (x*y=k, never above that pool's quote depth). When the sides
 *     disagree by more than 10% the value is kept but flagged (priceGapPct, valueNote). Only LPs that
 *     are not thin, not flagged and have a WPLS/stable side count in the liquidity totals (p.counted);
 *     the rest stay on the cards with a countNote.
 *
 * Reads are batched through Multicall3 (one eth_call for ~150 sub-calls), so a wallet
 * with ~200 LPs costs a handful of requests, and the work per refresh is bounded:
 * candidate pairs, new price look-ups and enumeration calls all have budgets, and what
 * is left over is reported as partial and resumes on the next refresh.
 *
 * Discovery of the pairs a wallet holds, in order, as a union: pinned `pairs` in settings;
 * the chain's Blockscout token list (JSON only; an HTML/Cloudflare page is "unavailable");
 * and, when Blockscout is unavailable (or `scan: true`), a resumable enumeration of the
 * factory's allPairs(i) with balanceOf(wallet) and a cursor in the data directory.
 *
 * Farms: contracts.pulsex.farms [{ name, address, kind: "pulsex-masterchef" }] adds the LP
 * a wallet has staked there (userInfo / pendingInc, view calls only), valued like unstaked LP.
 *
 * Nothing is signed or sent: every call is a view. The results go to `external`, never
 * `positions`, so the collector, the guardian and the Sell tab cannot act on them.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { redactText } = require("./endpoint");

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MC_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)"];
const ERC20_I = new ethers.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const PAIR_I = new ethers.Interface([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const FACTORY_I = new ethers.Interface(["function getPair(address,address) view returns (address)", "function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"]);
const FARM_I = new ethers.Interface([
  "function poolLength() view returns (uint256)",
  "function poolInfo(uint256) view returns (address lpToken, uint256 allocPoint, uint256 lastRewardTime, uint256 accIncPerShare)",
  "function userInfo(uint256,address) view returns (uint256 amount, uint256 rewardDebt)",
  "function pendingInc(uint256,address) view returns (uint256)",
  "function inc() view returns (address)",
]);

const MIN_QUOTE_USD = 100;           // a quote side holding less than this is a quote, not a value
const CALL_CHUNK = 150;              // sub-calls per Multicall3 request
const SOLO_CHUNK = 16;               // concurrent plain eth_calls when there is no Multicall3
const PRICE_TTL = 5 * 60e3;          // a token's price candidates are re-read this often
const NEG_TTL = 6 * 3600e3;          // "not one of our pairs" is remembered this long, but only for a definite answer
const RETRY_TTL = 60e3;              // a failed sub-call is not an answer: it is retried after this long
const RECHECK_CHUNK = 10;           // sub-calls per re-run of failed sub-calls after a completed aggregate3
const MAX_EXTRA_REQUESTS = 64;       // extra requests one batch may spend splitting failed chunks
const LIST_MAX_ITEMS = 2000;         // explorer token list: items read
const LIST_MAX_BYTES = 4 * 1024 * 1024; // explorer token list: body size read before parsing
const AGREE_PCT = 10;                // the two sides of an LP must agree within this to be valued
const FARM_TTL = 6 * 3600e3;         // a farm's pool list
const LISTING_TTL = 60e3;            // one Blockscout listing per wallet per minute
const DEFAULT_MAX_PAIRS = 300;       // pairs read in full per wallet per refresh
const DEFAULT_PRICE_BUDGET = 80;     // tokens looked up for the first time per refresh
const DEFAULT_SCAN_BUDGET = 40;      // RPC requests per wallet per reader per refresh for the enumeration
const DEFAULT_SCAN_MS = 10_000;
const FEES_NOTE = "fees accrue inside the reserves and are realised when liquidity is removed";
const lc = (a) => String(a).toLowerCase();
const cleanSymbol = (raw, fallback) => String(raw == null ? "" : raw).replace(/[^A-Za-z0-9 ._$+-]/g, "").trim().slice(0, 16) || fallback;
/** Parse a fetch Response as JSON, refusing a body over `max` bytes (declared or actually read) before parsing it. */
async function readJsonCapped(r, max) {
  const declared = Number(r.headers && r.headers.get && r.headers.get("content-length"));
  if (declared > max) throw new Error(`body too large (${declared} bytes)`);
  if (r.body && typeof r.body.getReader === "function") {
    const reader = r.body.getReader(), chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length;
      if (got > max) { try { await reader.cancel(); } catch { /* already closed */ } throw new Error("body too large"); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  if (typeof r.text === "function") {
    const text = await r.text();
    if (text.length > max) throw new Error("body too large");
    return JSON.parse(text);
  }
  return r.json();
}
const reasonOf = (err) => redactText(String((err && (err.shortMessage || err.message)) || err || "error")).slice(0, 140);

/**
 * State shared by the readers of one chain (v1, v2, the farms): batching, token and pair
 * metadata, price look-ups and the Blockscout listing, so a token read for one is not read for the next.
 */
function makeShared({ provider, cfg, bsFetch = null, log = console, dataDir = null, persist = true }) {
  const px = (cfg.contracts && cfg.contracts.pulsex) || {};
  const mcAddr = ethers.getAddress(px.multicall || MULTICALL3);
  const mc = new ethers.Contract(mcAddr, MC_ABI, provider);
  const WPLS = lc(cfg.contracts && cfg.contracts.weth || (cfg.numeraire && cfg.numeraire.address) || "");
  const stables = new Set([...(px.stables || []), cfg.usdReference && cfg.usdReference.stable].filter(Boolean).map(lc));
  const minQuoteUsd = Number(px.minQuoteUsd) > 0 ? Number(px.minQuoteUsd) : MIN_QUOTE_USD;
  const priceBudget = Number(px.priceBudget) > 0 ? Number(px.priceBudget) : DEFAULT_PRICE_BUDGET;
  const specs = Array.isArray(cfg.contracts && cfg.contracts.v2lp) ? cfg.contracts.v2lp.filter((s) => s && s.factory) : [];
  const factories = new Map(specs.map((s) => [lc(s.factory), String(s.name || "v2")]));   // factory -> reader name
  const S = {
    provider, cfg, log, dataDir, persist, mcAddr, WPLS, stables, minQuoteUsd, specs, factories, rpcCalls: 0, bsFetch,
    meta: new Map(),      // token -> { address, symbol, decimals, decimalsOk }
    pairs: new Map(),     // pair  -> { ok, factory, token0, token1, at }
    prices: new Map(),    // token -> { cands:[{pair, quote, ratio, depthQuote, depthToken}], at }
    listings: new Map(),  // wallet -> { at, value }
    warned: false,
    hasMc: undefined,
  };

  S.multicall = async () => {
    if (S.hasMc !== undefined) return S.hasMc;
    try { const code = await provider.getCode(mcAddr); S.hasMc = !!code && code !== "0x"; } catch { S.hasMc = false; }
    return S.hasMc;
  };

  /**
   * Run view calls [{ target, data }] and return [{ ok, data }] in order. One Multicall3
   * request per CALL_CHUNK (allowFailure: a reverting pair costs nothing else); plain
   * eth_calls when the chain has no Multicall3.
   */
  S.batch = async (calls) => {
    const out = new Array(calls.length);
    if (!calls.length) return out;
    // A call result is { ok, data } plus: `empty` (the call succeeded with no data: no contract there) or
    // `transient` (the request failed, so nothing is known about the target and the caller must retry).
    // `reverted`: the call itself reverted (a plain eth_call said so): a definite answer from a contract.
    // `unconfirmed`: an aggregate3 sub-call failed, which may be a revert or a starved sub-call; re-run below.
    const fail = (transient) => ({ ok: false, data: "0x", ...(transient ? { transient: true } : {}) });
    const one = async (c) => { // a single plain eth_call: a revert is an answer, anything else is transient
      S.rpcCalls++;
      try {
        const v = await provider.call({ to: c.target, data: c.data });
        return v && v !== "0x" ? { ok: true, data: v } : { ok: false, data: "0x", empty: true };
      } catch (err) {
        return err && (err.code === "CALL_EXCEPTION" || err.code === 3) ? { ok: false, data: "0x", reverted: true } : fail(true);
      }
    };
    if (await S.multicall()) {
      let extra = MAX_EXTRA_REQUESTS;
      // When aggregate3 itself throws (gas, size, a flaky node), halve the chunk and retry, down to plain calls.
      const run = async (slice, at) => {
        S.rpcCalls++;
        try {
          const res = await mc.aggregate3(slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.data })));
          res.forEach((r, k) => { out[at + k] = r.success ? (r.returnData === "0x" ? { ok: false, data: "0x", empty: true } : { ok: true, data: r.returnData }) : { ok: false, data: "0x", unconfirmed: true }; });
        } catch {
          if (extra <= 0) { slice.forEach((_, k) => { out[at + k] = fail(true); }); return; }
          extra--;
          if (slice.length === 1) { out[at] = await one(slice[0]); return; }
          const half = slice.length >> 1;
          await run(slice.slice(0, half), at);
          await run(slice.slice(half), at + half);
        }
      };
      for (let i = 0; i < calls.length; i += CALL_CHUNK) await run(calls.slice(i, i + CALL_CHUNK), i);
      // A completed aggregate3 can still hold sub-calls that failed for want of gas rather than by reverting. Re-run those
      // in small chunks, then singly (a plain eth_call tells a revert from a transport failure), within the extra budget.
      let redo = out.map((o, i) => (o && o.unconfirmed ? i : -1)).filter((i) => i >= 0);
      for (let i = 0; i < redo.length && extra > 0; i += RECHECK_CHUNK) {
        const ids = redo.slice(i, i + RECHECK_CHUNK);
        extra--; S.rpcCalls++;
        try {
          const res = await mc.aggregate3(ids.map((j) => ({ target: calls[j].target, allowFailure: true, callData: calls[j].data })));
          res.forEach((r, k) => { if (r.success) out[ids[k]] = r.returnData === "0x" ? { ok: false, data: "0x", empty: true } : { ok: true, data: r.returnData }; });
        } catch { /* settled singly below */ }
      }
      redo = redo.filter((j) => out[j].unconfirmed);
      for (const j of redo) {
        if (extra <= 0) break;
        extra--;
        out[j] = await one(calls[j]);
      }
      for (const j of redo) if (out[j].unconfirmed) out[j] = fail(true); // budget spent: not known, so retried later
      return out;
    }
    for (let i = 0; i < calls.length; i += SOLO_CHUNK) {
      const slice = calls.slice(i, i + SOLO_CHUNK);
      const got = await Promise.all(slice.map(one));
      got.forEach((g, k) => { out[i + k] = g; });
    }
    return out;
  };
  S.chunkSize = async () => ((await S.multicall()) ? CALL_CHUNK : SOLO_CHUNK);
  const dec = (iface, fn, r) => { if (!r || !r.ok) return null; try { const d = iface.decodeFunctionResult(fn, r.data); return d.length === 1 ? d[0] : d; } catch { return null; } };
  S.dec = dec;

  /** symbol / decimals of tokens, cached when decimals were really read (decimalsOk, as univ3.getToken). */
  S.tokenMeta = async (addrs) => {
    const need = [...new Set(addrs.map(lc))].filter((a) => !S.meta.has(a));
    if (need.length) {
      const calls = need.flatMap((a) => [{ target: a, data: ERC20_I.encodeFunctionData("symbol") }, { target: a, data: ERC20_I.encodeFunctionData("decimals") }]);
      const res = await S.batch(calls);
      need.forEach((a, i) => {
        const address = ethers.getAddress(a);
        const sym = dec(ERC20_I, "symbol", res[2 * i]);
        const d = dec(ERC20_I, "decimals", res[2 * i + 1]);
        const decimals = d == null ? NaN : Number(d);
        const ok = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36;
        const m = { address, symbol: cleanSymbol(sym, address.slice(0, 6)), decimals: ok ? decimals : null, decimalsOk: ok };
        if (ok) S.meta.set(a, m); else S.meta.set(a, { ...m, at: Date.now() }); // retried after a minute
      });
    }
    return addrs.map((a) => {
      const m = S.meta.get(lc(a));
      if (m && m.decimalsOk === false && Date.now() - m.at > 60e3) S.meta.delete(lc(a));
      return m;
    });
  };

  /**
   * pair.factory() / token0 / token1 for candidate addresses. A pair is `ok` only when its claimed
   * factory is a configured one AND that factory's own getPair(token0, token1) returns this very
   * address: a forged contract can claim any factory(), but cannot make the real factory list it.
   * Negative answers are cached for NEG_TTL only when definite (factory() decoded to a foreign address,
   * the target has no code, factory() reverts, getPair names another pair); a transport failure is retried after RETRY_TTL.
   */
  S.pairInfo = async (addrs) => {
    const want = [...new Set(addrs.map(lc))];
    const now = Date.now();
    const stale = want.filter((a) => { const c = S.pairs.get(a); return !c || (!c.ok && now - c.at > (c.definite ? NEG_TTL : RETRY_TTL)); });
    const no = (a, extra) => S.pairs.set(a, { ok: false, factory: null, at: Date.now(), definite: false, ...extra });
    if (stale.length) {
      const f = await S.batch(stale.map((a) => ({ target: a, data: PAIR_I.encodeFunctionData("factory") })));
      const mine = [];
      stale.forEach((a, i) => {
        const fac = dec(PAIR_I, "factory", f[i]);
        if (fac && factories.has(lc(fac))) mine.push([a, lc(fac)]);
        else if (fac) no(a, { factory: lc(fac), definite: true });          // some other factory
        else if (f[i] && f[i].empty) no(a, { definite: true });             // no contract at that address
        else if (f[i] && f[i].reverted) no(a, { definite: true });          // factory() reverts on a contract: not a pair, a definite answer
        else no(a);                                                         // failed request: retry soon
      });
      if (mine.length) {
        const t = await S.batch(mine.flatMap(([a]) => [{ target: a, data: PAIR_I.encodeFunctionData("token0") }, { target: a, data: PAIR_I.encodeFunctionData("token1") }]));
        const toks = mine.map(([a, fac], i) => ({ a, fac, t0: dec(PAIR_I, "token0", t[2 * i]), t1: dec(PAIR_I, "token1", t[2 * i + 1]) }));
        const readable = toks.filter((x) => { if (x.t0 && x.t1) return true; no(x.a, { factory: x.fac }); return false; });
        const g = readable.length ? await S.batch(readable.map((x) => ({ target: ethers.getAddress(x.fac), data: FACTORY_I.encodeFunctionData("getPair", [x.t0, x.t1]) }))) : [];
        readable.forEach((x, i) => {
          const back = dec(FACTORY_I, "getPair", g[i]);
          if (!back) no(x.a, { factory: x.fac });                              // getPair failed: retry soon
          else if (lc(back) !== x.a) no(x.a, { factory: x.fac, definite: true, forged: true }); // the factory does not list this contract
          else S.pairs.set(x.a, { ok: true, factory: x.fac, token0: ethers.getAddress(x.t0), token1: ethers.getAddress(x.t1), at: Date.now() });
        });
      }
    }
    return addrs.map((a) => S.pairs.get(lc(a)));
  };

  /** The USD price of an anchor token (WPLS through wethUsd, a configured stable at 1), else undefined. */
  S.anchorUsd = (token, wethUsd) => {
    const t = lc(token);
    if (stables.has(t)) return 1;
    if (t === WPLS) return wethUsd == null ? null : Number(wethUsd);
    return undefined;
  };
  S.isAnchor = (token) => stables.has(lc(token)) || lc(token) === WPLS;

  /**
   * Price candidates for non-anchor tokens: for each, the pair against WPLS and each stable on each
   * configured factory, with its quote-side depth. At most `priceBudget` tokens per call are looked
   * up for the first time (the rest wait for the next refresh); fresh entries are reused for PRICE_TTL.
   */
  S.primePrices = async (tokens) => {
    const quotes = [...new Set([WPLS, ...stables].filter(Boolean))];
    const need = [...new Set(tokens.map(lc))].filter((t) => !S.isAnchor(t) && (!S.prices.has(t) || Date.now() - S.prices.get(t).at > PRICE_TTL));
    const fresh = need.filter((t) => !S.prices.has(t)).slice(0, priceBudget);
    const refresh = need.filter((t) => S.prices.has(t)).slice(0, priceBudget);
    const todo = [...fresh, ...refresh].slice(0, priceBudget);
    if (!todo.length || !quotes.length || !factories.size) return;
    const facs = [...factories.keys()];
    const lookups = [];
    for (const t of todo) for (const q of quotes) for (const f of facs) lookups.push({ t, q, f });
    const found = await S.batch(lookups.map((l) => ({ target: l.f, data: FACTORY_I.encodeFunctionData("getPair", [l.t, l.q]) })));
    const exist = [];
    lookups.forEach((l, i) => { const p = dec(FACTORY_I, "getPair", found[i]); if (p && p !== ethers.ZeroAddress) exist.push({ ...l, pair: lc(p) }); });
    const info = exist.length ? await S.batch(exist.flatMap((e) => [{ target: e.pair, data: PAIR_I.encodeFunctionData("getReserves") }, { target: e.pair, data: PAIR_I.encodeFunctionData("token0") }])) : [];
    const metas = new Map((await S.tokenMeta([...new Set([...todo, ...quotes])])).filter(Boolean).map((m) => [lc(m.address), m]));
    const byToken = new Map(todo.map((t) => [t, []]));
    exist.forEach((e, i) => {
      const r = dec(PAIR_I, "getReserves", info[2 * i]), t0 = dec(PAIR_I, "token0", info[2 * i + 1]);
      const mt = metas.get(e.t), mq = metas.get(e.q);
      if (!r || !t0 || !mt || !mq || !mt.decimalsOk || !mq.decimalsOk) return;
      const tIs0 = lc(t0) === e.t;
      const rt = tIs0 ? r[0] : r[1], rq = tIs0 ? r[1] : r[0];
      if (rt === 0n || rq === 0n) return;
      const qty = Number(ethers.formatUnits(rq, mq.decimals)), tty = Number(ethers.formatUnits(rt, mt.decimals));
      byToken.get(e.t).push({ pair: e.pair, quote: e.q, ratio: qty / tty, depthQuote: qty, depthToken: tty });
    });
    for (const [t, cands] of byToken) S.prices.set(t, { cands, at: Date.now() });
  };

  /**
   * USD price of a token and where it came from, never from `exclude` (the pair being valued).
   * { usd, source } or { usd: null, reason }.
   */
  S.priceOf = (token, wethUsd, exclude) => {
    const t = lc(token);
    const a = S.anchorUsd(t, wethUsd);
    if (a === null) return { usd: null, reason: "PLS/USD rate unavailable, so WPLS is unpriced" };
    if (a !== undefined) return { usd: a, source: t === WPLS ? "WPLS" : "stable" };
    const entry = S.prices.get(t);
    if (!entry) return { usd: null, reason: "price look-up deferred to the next refresh (per-refresh budget)" };
    let best = null, thin = 0;
    for (const c of entry.cands) {
      if (exclude && c.pair === lc(exclude)) continue;
      const qUsd = S.anchorUsd(c.quote, wethUsd);
      if (qUsd == null) continue;
      if (c.depthQuote * qUsd < minQuoteUsd) { thin++; continue; }
      const d = c.depthQuote * qUsd;
      if (!best || d > best.depth) best = { usd: c.ratio * qUsd, source: c.pair, depth: d, c, qUsd };
    }
    if (best) {
      // What `amt` of this token could realise by selling it through its source pool (x*y=k), in USD, never above that pool's quote-side depth.
      const c = best.c, cap = (amt) => Math.min(c.depthQuote, c.depthQuote * amt / (c.depthToken + amt)) * best.qUsd;
      return { usd: best.usd, source: best.source, cap };
    }
    return { usd: null, reason: thin ? `no pool with at least $${minQuoteUsd} of quote-side liquidity prices it (thin pools are not a price source)` : "no price outside this pair (no WPLS or stable pool of its own)" };
  };

  /**
   * ERC-20 token list of a wallet from the explorer, as candidate addresses. `ok` false when the
   * explorer did not answer JSON (an HTML/Cloudflare page, a 4xx/5xx, a timeout): unavailable,
   * which is not the same as "holds nothing", and said once.
   */
  S.listing = async (wallet) => {
    const key = lc(wallet);
    const hit = S.listings.get(key);
    if (hit && Date.now() - hit.at < LISTING_TTL) return hit.value;
    const unavailable = (why) => {
      if (!S.warned) { S.warned = true; log.warn(`v2lp: explorer token list unavailable (${why}); LPs come from pinned pairs and the factory enumeration`); }
      return { ok: false, tokens: [] };
    };
    let value;
    if (!bsFetch) value = unavailable("no explorer client");
    else {
      try {
        const r = await bsFetch(`/v2/addresses/${wallet}/token-balances`, { timeoutMs: 20000 });
        const ctype = String((r.headers && r.headers.get && r.headers.get("content-type")) || "");
        if (!r.ok) value = unavailable(`HTTP ${r.status}`);
        else if (r.headers && r.headers.get && !/json/i.test(ctype)) value = unavailable("not JSON");
        else {
          const d = await readJsonCapped(r, LIST_MAX_BYTES);
          const items = (Array.isArray(d) ? d : (d && d.items) || []).slice(0, LIST_MAX_ITEMS);
          const out = new Set(), plp = new Set();
          let unchecked = 0;
          for (const it of items) {
            const tok = it && it.token;
            const a = tok && (tok.address_hash || tok.address);
            if (!tok || (tok.type && tok.type !== "ERC-20") || !a || !ethers.isAddress(a)) continue;
            try { if (it.value != null && BigInt(it.value) === 0n) continue; } catch { /* keep: confirmed on chain anyway */ }
            out.add(ethers.getAddress(a));
            // "PLP" and tokens with no symbol at all are probed (still confirmed by factory() and getPair); the rest are skipped, and counted.
            if (tok.symbol === "PLP" || tok.symbol == null || String(tok.symbol).trim() === "") plp.add(ethers.getAddress(a));
            else unchecked++;
          }
          value = { ok: true, tokens: [...out], plp: [...plp], unchecked };
        }
      } catch (err) {
        value = unavailable(reasonOf(err).slice(0, 60));
      }
    }
    S.listings.set(key, { at: Date.now(), value });
    return value;
  };
  return S;
}

/**
 * One reader per PulseX factory.
 * spec: { name: "pulsex-v1"|"pulsex-v2", factory, pairs?: [..], scan?, scanBudget?, scanMs?, maxPairs? }
 * (scan: false switches the enumeration off, true forces it, unset = only while the explorer list is unavailable.)
 * priceOf is built from `cfg` and the shared price cache; the position's own pair is never a price source.
 */
function create({ provider, cfg, spec, toFloat = (v, d) => Number(ethers.formatUnits(v, d)), bsFetch = null, dataDir = null, persist = true, log = console, shared = null }) {
  const S = shared || makeShared({ provider, cfg: { ...cfg, contracts: { ...(cfg.contracts || {}), v2lp: cfg.contracts && cfg.contracts.v2lp && cfg.contracts.v2lp.length ? cfg.contracts.v2lp : [spec] } }, bsFetch, log, dataDir, persist });
  const name = String(spec.name || "v2");
  const factoryAddr = ethers.getAddress(spec.factory);
  const FAC = lc(factoryAddr);
  const pinned = (Array.isArray(spec.pairs) ? spec.pairs : []).filter((a) => ethers.isAddress(a)).map((a) => ethers.getAddress(a));
  const scanBudget = Math.max(2, Number(spec.scanBudget) || DEFAULT_SCAN_BUDGET);
  const scanMs = Number(spec.scanMs) > 0 ? Number(spec.scanMs) : DEFAULT_SCAN_MS;
  const maxPairs = Math.max(1, Number(spec.maxPairs) || DEFAULT_MAX_PAIRS);
  const factory = new ethers.Contract(factoryAddr, ["function allPairsLength() view returns (uint256)"], provider);
  const stateFile = path.join(dataDir || require("./data-dir").DATA_DIR, `v2lp-scan-${name.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.json`);

  // ---- resumable enumeration cursor ----
  let state = null;
  const loadState = () => {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { state = null; }
    if (!state || typeof state !== "object" || !state.wallets || lc(state.factory || "") !== FAC) state = { version: 1, factory: factoryAddr, wallets: {} };
    return state;
  };
  const saveState = () => {
    if (!S.persist) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, stateFile);
    } catch { /* a cursor that cannot be saved only costs a rescan */ }
  };

  /**
   * allPairs(i) for the next indexes, then balanceOf(wallet) on each, within the call and time budget.
   * Held pairs are kept in the cursor; `partial` while the end of the list has not been reached.
   */
  async function enumerate(wallet) {
    const st = loadState();
    const key = lc(wallet);
    const ws = st.wallets[key] || (st.wallets[key] = { next: 0, length: null, held: [] });
    const t0 = Date.now(), calls0 = S.rpcCalls;
    let error = null;
    try {
      ws.length = Number(await factory.allPairsLength());
      S.rpcCalls++;
      const chunk = await S.chunkSize();
      while (ws.next < ws.length && S.rpcCalls - calls0 + 2 <= scanBudget && Date.now() - t0 < scanMs) {
        const n = Math.min(chunk, ws.length - ws.next);
        const idx = Array.from({ length: n }, (_, k) => ws.next + k);
        const got = await S.batch(idx.map((i) => ({ target: factoryAddr, data: FACTORY_I.encodeFunctionData("allPairs", [i]) })));
        const addrs = got.map((g) => S.dec(FACTORY_I, "allPairs", g));
        if (addrs.some((a) => !a)) { error = "allPairs() failed for part of a range"; break; }
        const bal = await S.batch(addrs.map((a) => ({ target: a, data: PAIR_I.encodeFunctionData("balanceOf", [wallet]) })));
        addrs.forEach((a, k) => { const b = S.dec(PAIR_I, "balanceOf", bal[k]); if (b && b > 0n) ws.held = [...new Set([...ws.held, ethers.getAddress(a)])]; });
        ws.next += n;
      }
    } catch (err) {
      error = reasonOf(err);
    }
    ws.at = Date.now();
    saveState();
    return { pairs: ws.held.slice(), partial: error != null || ws.next < ws.length, scanned: ws.next, length: ws.length, error };
  }

  /**
   * Read, validate and value the given pair addresses for `wallet`. `staked` maps pair (lowercase)
   * to { amount, farm, pid, pending, rewardToken } for LP held in a farm. Pairs of another factory,
   * or not pairs at all, are ignored here.
   */
  async function readPairs(wallet, candidates, wethUsd, staked = new Map()) {
    const errors = [], positions = [];
    const closed = 0;
    const infos = await S.pairInfo(candidates);
    const mine = candidates.map((a, i) => ({ a: ethers.getAddress(a), i: infos[i] })).filter((x) => x.i && x.i.ok && x.i.factory === FAC);
    if (!mine.length) return { positions, closed, errors };
    const dyn = await S.batch(mine.flatMap((x) => [
      { target: x.a, data: PAIR_I.encodeFunctionData("getReserves") },
      { target: x.a, data: PAIR_I.encodeFunctionData("totalSupply") },
      { target: x.a, data: PAIR_I.encodeFunctionData("balanceOf", [wallet]) },
    ]));
    const rows = [];
    mine.forEach((x, k) => {
      const r = S.dec(PAIR_I, "getReserves", dyn[3 * k]), ts = S.dec(PAIR_I, "totalSupply", dyn[3 * k + 1]), bal = S.dec(PAIR_I, "balanceOf", dyn[3 * k + 2]);
      const st = staked.get(lc(x.a)) || [];
      if (bal == null && !st.length) { errors.push({ tokenId: `${name}-${x.a}`, error: "balanceOf() failed" }); return; }
      if ((!bal || bal === 0n) && !st.length) return;       // a candidate that is not held (an LP the explorer still lists at zero)
      if (!r || ts == null) { errors.push({ tokenId: `${name}-${x.a}`, error: "getReserves()/totalSupply() failed" }); return; }
      if (ts === 0n) { errors.push({ tokenId: `${name}-${x.a}`, error: "totalSupply() is 0" }); return; }
      const held = (bal || 0n) + st.reduce((sum, f) => sum + (f.amount > 0n ? f.amount : 0n), 0n);
      if (held > ts) { errors.push({ tokenId: `${name}-${x.a}`, error: "LP balance exceeds totalSupply(): not a genuine pair, ignored" }); return; }
      rows.push({ pair: x.a, info: x.i, reserve0: r[0], reserve1: r[1], ts, wallet: bal || 0n, stakes: st });
    });
    if (!rows.length) return { positions, closed, errors };
    const tokens = [...new Set(rows.flatMap((r) => [r.info.token0, r.info.token1]))];
    const rewardTokens = [...new Set(rows.flatMap((r) => r.stakes.map((f) => f.rewardToken)).filter(Boolean))];
    const metaList = await S.tokenMeta([...tokens, ...rewardTokens]);
    const meta = new Map(metaList.filter(Boolean).map((m) => [lc(m.address), m]));
    await S.primePrices([...tokens, ...rewardTokens]);
    for (const r of rows) {
      const m0 = meta.get(lc(r.info.token0)), m1 = meta.get(lc(r.info.token1));
      if (!m0 || !m0.decimalsOk || !m1 || !m1.decimalsOk) {
        errors.push({ tokenId: `${name}-${r.pair}`, error: "token decimals were not read from the chain, so this position cannot be valued" });
        continue;
      }
      if (r.wallet > 0n) positions.push(build(r, null, m0, m1, r.wallet, wethUsd, meta));
      for (const f of r.stakes) if (f.amount > 0n) positions.push(build(r, f, m0, m1, f.amount, wethUsd, meta));
    }
    return { positions, closed, errors };
  }

  function build(r, farm, m0, m1, lp, wethUsd, meta) {
    const a0raw = r.reserve0 * lp / r.ts, a1raw = r.reserve1 * lp / r.ts;
    const amount0 = toFloat(a0raw, m0.decimals), amount1 = toFloat(a1raw, m1.decimals);
    const reserve0 = toFloat(r.reserve0, m0.decimals), reserve1 = toFloat(r.reserve1, m1.decimals);
    const p0 = S.priceOf(m0.address, wethUsd, r.pair), p1 = S.priceOf(m1.address, wethUsd, r.pair);
    const usd0 = p0.usd, usd1 = p1.usd;
    // A side priced from a pool (not an anchor) is worth at most what selling it through that pool would realise.
    const capSide = (amt, usd, p) => (usd == null ? null : (p.cap ? Math.min(amt * usd, p.cap(amt)) : amt * usd));
    const side0Usd = capSide(amount0, usd0, p0), side1Usd = capSide(amount1, usd1, p1);
    const priced = side0Usd != null && side1Usd != null;
    // Both sides priced: a pool's two sides are worth the same, so take 2 x the smaller. When they disagree by more
    // than AGREE_PCT one price is off: the 2 x min value is still shown, but flagged and not counted in totals.
    const hi = priced ? Math.max(side0Usd, side1Usd) : 0;
    const gapPct = priced && hi > 0 ? (hi - Math.min(side0Usd, side1Usd)) / hi * 100 : 0;
    const disagree = priced && gapPct > AGREE_PCT;
    const valued = priced;
    // thin: the smaller priced side of the pool's reserves is worth less than the quote guard.
    const sides = [usd0 != null ? reserve0 * usd0 : null, usd1 != null ? reserve1 * usd1 : null].filter((x) => x != null);
    const thin = sides.length ? Math.min(...sides) < S.minQuoteUsd : null;
    const reasons = [];
    if (usd0 == null) reasons.push(`${m0.symbol}: ${p0.reason}`);
    if (usd1 == null) reasons.push(`${m1.symbol}: ${p1.reason}`);
    if (disagree) reasons.push(`the two sides are priced ${gapPct.toFixed(0)}% apart (${m0.symbol} $${side0Usd.toFixed(2)} vs ${m1.symbol} $${side1Usd.toFixed(2)}), so the prices are inconsistent; shown as 2 x the smaller side, an approximation`);
    const anchored = S.isAnchor(m0.address) || S.isAnchor(m1.address);
    const notCounted = [];
    if (valued && thin) notCounted.push("thin pool");
    if (valued && disagree) notCounted.push("the two sides disagree on price");
    if (valued && !anchored) notCounted.push("neither side is WPLS or a stablecoin, so the price rests on pool ratios alone");
    const counted = valued && notCounted.length === 0;
    const staked = !!farm;
    let rewards = null;
    if (staked) {
      const f = farm, rt = f.rewardToken ? meta.get(lc(f.rewardToken)) : null;
      if (rt && rt.decimalsOk && f.pending != null) {
        const amount = toFloat(f.pending, rt.decimals);
        const pr = S.priceOf(rt.address, wethUsd);
        rewards = { token: rt.address, symbol: rt.symbol, amount, usd: pr.usd == null ? null : amount * pr.usd, priceUsd: pr.usd };
      } else rewards = { token: f.rewardToken || null, symbol: rt ? rt.symbol : null, amount: null, usd: null, error: "pending reward not read" };
    }
    return {
      protocol: name,
      kind: "v2lp",
      tokenId: staked ? `${name}-${r.pair}-farm-${farm.pid}` : `${name}-${r.pair}`,
      nftId: null,
      version: name,
      pair: `${m0.symbol} / ${m1.symbol}`,
      pairAddress: r.pair,
      symbol0: m0.symbol, symbol1: m1.symbol,
      token0: m0.address, token1: m1.address,
      feeTierLabel: "v2 0.29%",
      lpBalance: toFloat(lp, 18), lpBalanceRaw: lp.toString(),
      totalSupply: toFloat(r.ts, 18), totalSupplyRaw: r.ts.toString(),
      sharePct: Number(lp * 10_000_000n / r.ts) / 100_000,
      reserve0, reserve1,
      amount0, amount1, fee0: 0, fee1: 0, usd0, usd1, side0Usd, side1Usd,
      price0Source: p0.source || null, price1Source: p1.source || null,
      feesOk: true, feesError: null, feesUsd: 0, feesNote: FEES_NOTE,
      valueUsd: valued ? 2 * Math.min(side0Usd, side1Usd) : null,
      ...(valued && !disagree ? {} : { valueNote: reasons.join("; ") }),
      ...(disagree ? { priceGapPct: gapPct } : {}),
      counted,
      ...(valued && !counted ? { countNote: `not counted in the liquidity total: ${notCounted.join("; ")}` } : {}),
      thin,
      ...(thin ? { thinNote: `thin pool: the smaller side of its reserves is worth under $${S.minQuoteUsd}, so the value is an estimate that one trade can move` } : {}),
      staked,
      gauge: null,
      ...(staked ? { farm: farm.farm, farmAddress: farm.farmAddress, pid: farm.pid, rewards } : {}),
      claimed: { status: "unavailable", reason: `the claim history covers Uniswap positions; this one is on ${name}` },
    };
  }

  /** Every LP position `wallet` holds on this factory (plus the farm stakes in `stakedEntries`). */
  async function positionsOf(wallet, wethUsd, stakedEntries = []) {
    const notes = [], errors = [];
    const cands = new Set(pinned.map(lc));
    const stakedMap = new Map();
    for (const e of stakedEntries) { stakedMap.set(lc(e.pair), [...(stakedMap.get(lc(e.pair)) || []), e]); cands.add(lc(e.pair)); }
    const list = await S.listing(wallet);
    const known = new Set(cands);                       // pinned and staked: probed first, in their own batch
    // Only the explorer's "PLP" (or symbol-less) tokens are worth a factory() probe; everything else is a plain token.
    for (const t of (list.plp || [])) cands.add(lc(t));
    if (list.unchecked > 0) notes.push(`${list.unchecked} explorer token(s) with another symbol than "PLP" were not checked as LPs`);
    let partial = false;
    if (spec.scan === true || (spec.scan !== false && !list.ok)) {
      const sc = await enumerate(wallet);
      for (const p of sc.pairs) cands.add(lc(p));
      if (sc.partial) {
        partial = true;
        notes.push(`${name}: LP discovery is partial: ${sc.error ? sc.error : `scanned ${sc.scanned} of ${sc.length} pairs`}; pinned pairs and the explorer list were still checked, and the scan resumes on the next refresh`);
      }
    }
    // The explorer's token list is mostly not LPs: confirm each by factory() (cached; foreign and
    // non-pair tokens are remembered), and only then bound the number read in full.
    const candList = [...known, ...[...cands].filter((a) => !known.has(a))];
    const infos = [...(known.size ? await S.pairInfo([...known]) : []), ...(candList.length > known.size ? await S.pairInfo(candList.slice(known.size)) : [])];
    let all = candList.filter((_, i) => infos[i] && infos[i].ok && infos[i].factory === FAC);
    for (const pa of pinned) {
      const i = candList.indexOf(lc(pa));
      const inf = infos[i];
      if (inf && !(inf.ok && inf.factory === FAC) && !(inf.ok && S.factories.has(inf.factory))) errors.push({ tokenId: `${name}-${pa}`, error: `pinned pair ${pa} is not a pair of any configured PulseX factory (factory() = ${inf.factory || "unreadable"})` });
    }
    if (all.length > maxPairs) {
      // Known holdings (pinned, farms) first; the rest is cut, and said.
      const first = new Set([...pinned.map(lc), ...stakedMap.keys()]);
      all = [...all.filter((a) => first.has(a)), ...all.filter((a) => !first.has(a))];
      const cut = all.length - maxPairs;
      all = all.slice(0, maxPairs);
      notes.push(`${name}: ${cut} pair(s) were not read this refresh (limit ${maxPairs} per wallet)`);
      partial = true;
    }
    const res = await readPairs(wallet, all, wethUsd, stakedMap);
    return { positions: res.positions, closed: res.closed, errors: [...errors, ...res.errors], notes, partial };
  }

  return { name, factory: factoryAddr, positionsOf, readPairs, enumerate, shared: S };
}

/**
 * View-only farm adapter, kind "pulsex-masterchef" (verified on PulseChain: poolLength, poolInfo(pid) ->
 * (lpToken, allocPoint, lastRewardTime, accIncPerShare), userInfo(pid, user) -> (amount, rewardDebt),
 * pendingInc(pid, user), inc()). Returns the LP a wallet has staked per pool and the pending reward.
 */
function createFarm({ provider, shared: S, spec }) {
  const name = String(spec.name || "farm");
  const address = ethers.getAddress(spec.address);
  if (spec.kind !== "pulsex-masterchef") throw new Error(`farm ${name}: unsupported kind "${spec.kind}" (supported: pulsex-masterchef)`);
  let pools = null, poolsAt = 0, rewardToken;
  const call = (fn, args = []) => ({ target: address, data: FARM_I.encodeFunctionData(fn, args) });
  async function poolList() {
    if (pools && Date.now() - poolsAt < FARM_TTL) return pools;
    const n = Number(S.dec(FARM_I, "poolLength", (await S.batch([call("poolLength")]))[0]) ?? -1);
    if (!(n >= 0 && n <= 1000)) throw new Error(`${name}: poolLength() failed`);
    const info = await S.batch(Array.from({ length: n }, (_, i) => call("poolInfo", [i])));
    pools = info.map((r, pid) => { const d = S.dec(FARM_I, "poolInfo", r); return d ? { pid, lpToken: ethers.getAddress(d[0]), allocPoint: d[1] } : null; }).filter(Boolean);
    poolsAt = Date.now();
    if (rewardToken === undefined) rewardToken = S.dec(FARM_I, "inc", (await S.batch([call("inc")]))[0]) || null;
    return pools;
  }
  /** [{ pair, amount, pid, pending, rewardToken, farm, farmAddress }] for every pool the wallet has LP staked in. */
  async function stakedOf(wallet) {
    const list = await poolList();
    const ui = await S.batch(list.map((p) => call("userInfo", [p.pid, wallet])));
    const held = [];
    list.forEach((p, i) => { const d = S.dec(FARM_I, "userInfo", ui[i]); if (d && d[0] > 0n) held.push({ p, amount: d[0] }); });
    if (!held.length) return [];
    const pend = await S.batch(held.map((h) => call("pendingInc", [h.p.pid, wallet])));
    return held.map((h, i) => ({ pair: h.p.lpToken, amount: h.amount, pid: h.p.pid, pending: S.dec(FARM_I, "pendingInc", pend[i]), rewardToken: rewardToken ? ethers.getAddress(rewardToken) : null, farm: name, farmAddress: address }));
  }
  return { name, address, kind: spec.kind, stakedOf, poolList };
}

/**
 * Every configured reader and farm of an instance behind one positionsOf(wallet, wethUsd), the
 * shape watch.js merges into `external`. contracts.v2lp is the list of factories, contracts.pulsex.farms the farms.
 */
function createSet({ provider, cfg, toFloat, bsFetch = null, dataDir = null, persist = true, log = console }) {
  const S = makeShared({ provider, cfg, bsFetch, log, dataDir, persist });
  const readers = S.specs.map((spec) => create({ provider, cfg, spec, toFloat, shared: S, dataDir, persist, log }));
  const farms = [];
  for (const f of ((cfg.contracts && cfg.contracts.pulsex && cfg.contracts.pulsex.farms) || [])) {
    try { farms.push(createFarm({ provider, shared: S, spec: f })); } catch (err) { log.warn(`v2lp: ${reasonOf(err)}`); }
  }
  async function positionsOf(wallet, wethUsd) {
    const out = { positions: [], closed: 0, errors: [], notes: [], partial: false };
    const stakedAll = [];
    for (const f of farms) {
      try { stakedAll.push(...await f.stakedOf(wallet)); } catch (err) { out.errors.push({ tokenId: f.name, error: `farm ${f.name} could not be read: ${reasonOf(err)}` }); }
    }
    for (const r of readers) {
      try {
        const x = await r.positionsOf(wallet, wethUsd, stakedAll);
        out.positions.push(...x.positions);
        out.closed += x.closed;
        out.errors.push(...x.errors);
        for (const n of x.notes) if (!out.notes.includes(n)) out.notes.push(n);   // the shared explorer listing yields the same note per reader
        out.partial = out.partial || x.partial;
      } catch (err) {
        out.errors.push({ tokenId: r.name, error: `${r.name} positions could not be read: ${reasonOf(err)}` });
      }
    }
    // A farm stake whose LP token belongs to no configured factory is not valued; say so.
    for (const s of stakedAll) {
      if (!out.positions.some((p) => p.staked && lc(p.pairAddress) === lc(s.pair) && p.farm === s.farm)) {
        out.notes.push(`${s.farm}: ${ethers.formatUnits(s.amount, 18)} LP staked in pool ${s.pid} (${s.pair}) was not valued: not a pair of a configured PulseX factory`);
      }
    }
    return out;
  }
  return { name: "v2lp", readers, farms, shared: S, positionsOf };
}

module.exports = { readJsonCapped, create, createSet, createFarm, makeShared, MULTICALL3, MIN_QUOTE_USD, FEES_NOTE };
