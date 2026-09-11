/**
 * sell-v4.js — sell fee tokens in the Uniswap v4 pool they came from.
 *
 * Launchpad tokens (LAPTOP, Bucket, CRUMBS, ...) have no v3 route, so the
 * collector used to hand them back to the wallet unsold. This module sells
 * them through the Universal Router's V4_SWAP command into the same hookless
 * pool the position earned them from, so the proceeds (ETH or USDG) join the
 * normal sweep: USDG, the vault split, the rest to the earning wallet.
 *
 * Policy (settings.json `risk.sell`, approved 2026-09-10):
 *   enabled          off = old behaviour (hand back)
 *   minUsd           sell only when the batch is worth at least this (default 25)
 *   maxImpactPct     price impact cap vs the pool's spot price (default 3); a
 *                    batch over the cap is trimmed to the largest slice under it,
 *                    and if that slice is under minUsd nothing is sold this run
 *   hold             token symbols/addresses never to sell
 *   hooked pools     never, unless a dry-run proves the sell passes
 *   best pool        every hookless pool the token was earned in, plus the live
 *                    ETH-quoted pools found by tier enumeration, are quoted and
 *                    the highest USD proceeds under the cap wins
 *   the collector's own maxSwapValueWeth and slippageBps still apply
 *
 * Router layout (this chain's Universal Router build, read from a swap the
 * Uniswap app sent on 2026-09-10): the V4 exact-input struct carries an extra
 * empty `bytes` field between the path and the amounts, so the stock
 * single-pool encoding is decoded as garbage and reverts with no data. The
 * working form is the path variant with that field, then SETTLE(currency, 0,
 * payerIsUser) and TAKE(currency, recipient, 0), 0 meaning the full delta.
 *
 * Every sale and every skip (with the reason) is appended to token-sales.json.
 *
 * Mechanics, all standard v4-periphery / universal-router:
 *   quote      V4Quoter.quoteExactInputSingle((PoolKey,bool,uint128,bytes))
 *   spot       StateView.getSlot0 -> sqrtPriceX96 -> expected output before fees
 *   swap       UniversalRouter.execute(commands=[V4_SWAP], inputs=[(actions, params)])
 *              actions = SWAP_EXACT_IN (one hop), SETTLE, TAKE
 *              ERC-20 input is pulled through Permit2: exact-amount ERC-20
 *              approval to Permit2, then Permit2.approve(token, router, amount,
 *              1 h); native ETH output lands in the operator's ETH balance,
 *              USDG output in its USDG balance.
 *   dry-run    eth_call of the exact execute() from the operator before sending.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const SALES_FILE = path.join(__dirname, "token-sales.json");
const PENDING_FILE = path.join(__dirname, "sales-pending.json");
const Q96 = 2n ** 96n;

// v4-periphery Actions and universal-router Commands
const ACT = { SWAP_EXACT_IN: 0x07, SETTLE: 0x0b, TAKE: 0x0e };
const CMD_V4_SWAP = 0x10;
const PERMIT2_DEFAULT = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const QUOTER_ABI = [
  "function quoteExactInputSingle((tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
];
const STATE_VIEW_ABI = ["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"];
const ROUTER_ABI = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"];
const PERMIT2_ABI = [
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
];
const ERC20_ABI = ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const coder = ethers.AbiCoder.defaultAbiCoder();
const POOL_KEY_T = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";

const poolIdOf = (k) => ethers.keccak256(coder.encode(["address", "address", "uint24", "int24", "address"], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
// Fee / tick-spacing pairs seen on this chain (standard tiers plus the launchpad's), for pool discovery.
const TIERS = [[100, 1], [500, 10], [2500, 50], [3000, 60], [10000, 200], [15000, 300], [20000, 400], [29988, 300], [30000, 600], [50000, 200], [100000, 1000]];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = ["function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[])"];
const LIQ_ABI = ["function getLiquidity(bytes32 poolId) view returns (uint128)"];
const isNative = (a) => a === ethers.ZeroAddress;

/** Output expected at the current spot price, before the pool fee, for selling `amountIn` of one side. */
function spotOut(sqrtPriceX96, zeroForOne, amountIn) {
  // price1per0 = (sqrtP / 2^96)^2 in raw units; token0 -> token1 multiplies, token1 -> token0 divides.
  const sq = BigInt(sqrtPriceX96);
  return zeroForOne ? (amountIn * sq * sq) / (Q96 * Q96) : (amountIn * Q96 * Q96) / (sq * sq);
}

/** Price impact of a quote in percent, net of the pool fee (fee in hundredths of a bip). */
function impactPct(quotedOut, spot, feePips) {
  if (spot <= 0n) return null;
  const afterFee = (spot * BigInt(1000000 - feePips)) / 1000000n;
  if (afterFee <= 0n) return null;
  const ratio = Number((quotedOut * 1000000n) / afterFee) / 1000000;
  return Math.max(0, (1 - ratio) * 100);
}

/**
 * Universal Router calldata for one exact-input v4 swap through `key`, output
 * to `recipient` (the caller when omitted). This chain's router layout: the
 * exact-input struct has an extra empty bytes field before the amounts.
 */
function buildSwapCalldata({ key, zeroForOne, amountIn, minOut, deadline, recipient = null }) {
  const actions = ethers.concat([new Uint8Array([ACT.SWAP_EXACT_IN]), new Uint8Array([ACT.SETTLE]), new Uint8Array([ACT.TAKE])]);
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;
  const to = recipient || "0x0000000000000000000000000000000000000001"; // ActionConstants.MSG_SENDER
  const params = [
    coder.encode(["tuple(address currencyIn,tuple(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)[] path,bytes extra,uint128 amountIn,uint128 amountOutMinimum)"],
      [{ currencyIn, path: [{ intermediateCurrency: currencyOut, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, hookData: "0x" }], extra: "0x", amountIn, amountOutMinimum: minOut }]),
    coder.encode(["address", "uint256", "bool"], [currencyIn, 0n, true]), // settle the full debt, paid by the caller (Permit2 / msg.value)
    coder.encode(["address", "address", "uint256"], [currencyOut, to, 0n]), // take the full credit to the recipient
  ];
  const input = coder.encode(["bytes", "bytes[]"], [actions, params]);
  const iface = new ethers.Interface(ROUTER_ABI);
  return { data: iface.encodeFunctionData("execute", [new Uint8Array([CMD_V4_SWAP]), [input], deadline]), value: isNative(currencyIn) ? amountIn : 0n, currencyIn, currencyOut };
}

/**
 * Largest slice of `amount` whose impact stays under the cap. The quote is
 * monotonic in size, so a short binary search (7 quotes) is enough; returns
 * { amountIn, quotedOut, impactPct } or null when even a small slice is over.
 */
async function fitSlice({ quote, spot, feePips, amount, maxImpactPct, steps = 7 }) {
  const check = async (amt) => {
    const out = await quote(amt);
    return { amountIn: amt, quotedOut: out, impactPct: impactPct(out, spot(amt), feePips) };
  };
  const full = await check(amount);
  if (full.impactPct != null && full.impactPct <= maxImpactPct) return full;
  let lo = 0n, hi = amount, best = null;
  for (let i = 0; i < steps; i++) {
    const mid = (lo + hi) / 2n;
    if (mid === 0n) break;
    const r = await check(mid);
    if (r.impactPct != null && r.impactPct <= maxImpactPct) { best = r; lo = mid; } else hi = mid;
  }
  return best;
}

function appendSale(row) {
  let rows = [];
  try { rows = JSON.parse(fs.readFileSync(SALES_FILE, "utf8")); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = [];
  rows.push(row);
  const tmp = SALES_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows));
  fs.renameSync(tmp, SALES_FILE);
}

// ---- confirm-before-sell ---------------------------------------------------
// With memecoinSell.confirm on, a sale is announced (Telegram) with the exact
// numbers and waits for an approval written by the approve_sale MCP tool or
// POST /api/sales/approve. No approval within confirmWaitMinutes = handed back.
function readPending() { try { const j = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")); return Array.isArray(j) ? j : []; } catch { return []; } }
function writePending(rows) { const tmp = PENDING_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(rows, null, 1)); fs.renameSync(tmp, PENDING_FILE); }
/** Record a decision on a pending sale; returns the row or null when unknown. */
function decideSale(id, decision, by = "api") {
  const rows = readPending();
  const row = rows.find((r) => r.id === String(id));
  if (!row) return null;
  if (row.status === "pending") { row.status = decision === "approve" ? "approved" : "rejected"; row.decidedAt = Date.now(); row.decidedBy = by; writePending(rows); }
  return row;
}
/** Pending sales (and the last few decided), for the tools and the page. */
function pendingSales() {
  const rows = readPending();
  const cutoff = Date.now() - 24 * 3600 * 1000;
  return rows.filter((r) => r.status === "pending" || (r.decidedAt || r.createdAt) > cutoff).sort((a, b) => b.createdAt - a.createdAt);
}

function settings(cfg) {
  const s = (cfg && cfg.memecoinSell) || {};
  const v4 = (cfg && cfg.contracts && cfg.contracts.v4) || {};
  return {
    enabled: s.enabled === true,
    minUsd: Number(s.minUsd ?? 25),
    maxImpactPct: Number(s.maxImpactPct ?? 3),
    hold: new Set((s.hold || []).map((x) => String(x).toLowerCase())),
    nativeQuoteOnly: s.nativeQuoteOnly === true, // off by default: ERC-20-quoted pools work with the router's real layout
    confirm: s.confirm === true,
    confirmWaitMinutes: Number(s.confirmWaitMinutes ?? 10),
    router: s.router || v4.universalRouter || null,
    quoter: s.quoter || v4.quoter || null,
    permit2: s.permit2 || v4.permit2 || PERMIT2_DEFAULT,
    stateView: v4.stateView || null,
  };
}

function create({ provider, cfg, log = console.log }) {
  const st = settings(cfg);
  const quoter = st.quoter ? new ethers.Contract(st.quoter, QUOTER_ABI, provider) : null;
  const stateView = st.stateView ? new ethers.Contract(st.stateView, STATE_VIEW_ABI, provider) : null;
  const ready = st.enabled && st.router && quoter && stateView;

  /**
   * Hookless pools pairing `token` with native ETH that hold liquidity, found by
   * enumerating the known fee tiers (one Multicall3 batch). Lets a token be sold
   * even when no open position of ours sits in its ETH pool.
   */
  const discovered = new Map(); // token -> { at, keys }
  async function discoverEthPools(token) {
    const cached = discovered.get(token.toLowerCase());
    if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.keys;
    const keys = TIERS.map(([fee, tickSpacing]) => ({ currency0: ethers.ZeroAddress, currency1: ethers.getAddress(token), fee, tickSpacing, hooks: ethers.ZeroAddress }));
    const liqIface = new ethers.Interface(LIQ_ABI);
    let live = [];
    try {
      const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
      const res = await mc.aggregate3(keys.map((k) => ({ target: st.stateView, allowFailure: true, callData: liqIface.encodeFunctionData("getLiquidity", [poolIdOf(k)]) })));
      live = keys.filter((k, i) => res[i].success && res[i].returnData.length >= 66 && BigInt(res[i].returnData) > 0n);
    } catch {
      for (const k of keys) { try { if ((await new ethers.Contract(st.stateView, LIQ_ABI, provider).getLiquidity(poolIdOf(k))) > 0n) live.push(k); } catch {} }
    }
    discovered.set(token.toLowerCase(), { at: Date.now(), keys: live });
    return live;
  }

  /** Like discoverEthPools, plus the USDG-quoted tiers (currencies sorted as the PoolManager keys them). */
  async function discoverPools(token) {
    const eth = await discoverEthPools(token);
    const stable = cfg.usdReference && cfg.usdReference.stable;
    if (!stable || stable.toLowerCase() === String(token).toLowerCase()) return eth;
    const ck = `usdg:${String(token).toLowerCase()}`;
    const cached = discovered.get(ck);
    if (cached && Date.now() - cached.at < 60 * 60 * 1000) return [...eth, ...cached.keys];
    const [c0, c1] = [ethers.getAddress(stable), ethers.getAddress(token)].sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
    const keys = TIERS.map(([fee, tickSpacing]) => ({ currency0: c0, currency1: c1, fee, tickSpacing, hooks: ethers.ZeroAddress }));
    const liqIface = new ethers.Interface(LIQ_ABI);
    let live = [];
    try {
      const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);
      const res = await mc.aggregate3(keys.map((k) => ({ target: st.stateView, allowFailure: true, callData: liqIface.encodeFunctionData("getLiquidity", [poolIdOf(k)]) })));
      live = keys.filter((k, i) => res[i].success && res[i].returnData.length >= 66 && BigInt(res[i].returnData) > 0n);
    } catch {}
    discovered.set(ck, { at: Date.now(), keys: live });
    return [...eth, ...live];
  }

  /**
   * quote({ token, amount, usdOf, maxImpactPct, slippageBps, recipient }) — the
   * best hookless pool for selling `amount` (raw) of `token`, the slice that fits
   * under the impact cap, and the Universal Router calldata a wallet can sign
   * itself (the Wallet page's Sell tab). Nothing is sent.
   */
  async function quote({ token, amount, usdOf, maxImpactPct = st.maxImpactPct, slippageBps = 100n, recipient = null, keys = [] }) {
    if (!quoter || !stateView || !st.router) return { ok: false, error: "v4 router / quoter not configured" };
    const candidates = [...(keys || [])];
    for (const k of await discoverPools(token)) if (!candidates.some((c) => poolIdOf(c) === poolIdOf(k))) candidates.push(k);
    const usable = candidates.filter((k) => !(k.hooks && k.hooks !== ethers.ZeroAddress));
    if (!usable.length) return { ok: false, error: candidates.length ? "only hooked pools hold this token; sells there are not proven" : "no v4 pool with liquidity for this token" };
    let best = null;
    const tried = [];
    for (const k of usable) {
      const zfo = k.currency0.toLowerCase() === String(token).toLowerCase();
      const out = zfo ? k.currency1 : k.currency0;
      let sqrtPriceX96;
      try { sqrtPriceX96 = (await stateView.getSlot0(poolIdOf(k)))[0]; } catch { continue; }
      let f;
      try { f = await fitSlice({ quote: (amt) => quoteOut(k, zfo, amt), spot: (amt) => spotOut(sqrtPriceX96, zfo, amt), feePips: Number(k.fee), amount, maxImpactPct }); } catch (e) { tried.push({ fee: Number(k.fee), error: e.shortMessage || e.message }); continue; }
      if (!f) { tried.push({ fee: Number(k.fee), error: "over the impact cap even for a small slice" }); continue; }
      const u = usdOf ? await usdOf(out, f.quotedOut) : null;
      tried.push({ fee: Number(k.fee), out, amountIn: f.amountIn.toString(), quotedOut: f.quotedOut.toString(), impactPct: f.impactPct, usd: u });
      if (!best || (u != null && (best.usd == null || u > best.usd))) best = { key: k, zeroForOne: zfo, currencyOut: out, fit: f, usd: u };
    }
    if (!best) return { ok: false, error: `no pool can take a slice under ${maxImpactPct}% impact`, tried };
    const minOut = (best.fit.quotedOut * (10000n - BigInt(slippageBps))) / 10000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    const call = buildSwapCalldata({ key: best.key, zeroForOne: best.zeroForOne, amountIn: best.fit.amountIn, minOut, deadline, recipient });
    return {
      ok: true, token, pool: { currency0: best.key.currency0, currency1: best.key.currency1, fee: Number(best.key.fee), tickSpacing: Number(best.key.tickSpacing), hooks: best.key.hooks },
      zeroForOne: best.zeroForOne, currencyOut: best.currencyOut, amountIn: best.fit.amountIn.toString(), quotedOut: best.fit.quotedOut.toString(), minOut: minOut.toString(),
      impactPct: best.fit.impactPct != null ? +best.fit.impactPct.toFixed(3) : null, usd: best.usd != null ? +best.usd.toFixed(2) : null, partial: best.fit.amountIn < amount,
      slippageBps: Number(slippageBps), deadline: deadline.toString(), router: st.router, permit2: st.permit2, calldata: call.data, value: call.value.toString(), tried,
    };
  }

  async function quoteOut(key, zeroForOne, amountIn) {
    const r = await quoter.quoteExactInputSingle.staticCall({ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" });
    return BigInt(r[0]);
  }

  /**
   * Try to sell `amount` (raw) of `token` in pool `key`. `usdOf(currencyOut, amountOut)`
   * values the output in USD (the collector knows the WETH and USDG prices).
   * Returns { sold, amountIn, amountOut, currencyOut, tx } or { sold:false, reason, remaining }.
   * Whatever is not sold is left for the caller's hand-back.
   */
  async function sell({ token, symbol, decimals, amount, key = null, keys = null, wallet, owner, usdOf, maxSwapWeth = null, wethOf = null, slippageBps = 100n, recordGas = () => {}, notify = null, splitPct = null }) {
    const skip = async (reason, extra = {}) => {
      log(`  sell ${symbol}: skipped — ${reason}`);
      try { appendSale({ t: Date.now(), wallet: owner.label, walletAddress: owner.address, token: symbol, tokenAddress: token, amount: Number(ethers.formatUnits(amount, decimals)), skipped: true, reason, ...extra }); } catch {}
      return { sold: false, reason, remaining: amount };
    };
    if (!ready) return { sold: false, reason: "disabled", remaining: amount };
    if (st.hold.has(String(symbol).toLowerCase()) || st.hold.has(String(token).toLowerCase())) return skip("on the hold list");
    let candidates = (keys && keys.length ? keys : key ? [key] : []).filter((k) => k && [k.currency0, k.currency1].some((c) => String(c).toLowerCase() === String(token).toLowerCase()));
    // Add every live ETH-quoted hookless pool for the token, so a closed position does not take its sell route with it.
    try {
      const found = await discoverEthPools(token);
      for (const k of found) if (!candidates.some((c) => poolIdOf(c) === poolIdOf(k))) candidates.push(k);
    } catch {}
    if (!candidates.length) return skip("no v4 pool for this token");
    const usable = candidates.filter((k) => !(k.hooks && k.hooks !== ethers.ZeroAddress) && (!st.nativeQuoteOnly || isNative(k.currency0) || isNative(k.currency1)));
    if (!usable.length) {
      const why = candidates.every((k) => k.hooks && k.hooks !== ethers.ZeroAddress) ? "its pools have hooks; sells not proven" : "its pools are ERC-20-quoted; this chain's PoolManager rejects router swaps there (only ETH-quoted pools work)";
      return skip(why);
    }

    // Best ETH-quoted pool: fit the batch under the impact cap in each and take the highest USD proceeds.
    let best = null;
    for (const k of usable) {
      const zfo = k.currency0.toLowerCase() === String(token).toLowerCase();
      const out = zfo ? k.currency1 : k.currency0;
      let sqrtPriceX96;
      try { sqrtPriceX96 = (await stateView.getSlot0(poolIdOf(k)))[0]; } catch { continue; }
      let f;
      try { f = await fitSlice({ quote: (amt) => quoteOut(k, zfo, amt), spot: (amt) => spotOut(sqrtPriceX96, zfo, amt), feePips: Number(k.fee), amount, maxImpactPct: st.maxImpactPct }); } catch { continue; }
      if (!f) continue;
      const u = await usdOf(out, f.quotedOut);
      if (u == null) continue;
      if (!best || u > best.usd) best = { key: k, zeroForOne: zfo, currencyOut: out, fit: f, usd: u };
    }
    if (!best) return skip(`even a small slice moves every usable pool more than ${st.maxImpactPct}% (or no quote)`);
    key = best.key;
    const { zeroForOne, currencyOut, fit, usd } = best;
    const full = fit.amountIn === amount;
    if (usd < st.minUsd) return skip(`${full ? "batch" : "slice under the impact cap"} worth $${usd.toFixed(2)}, below the $${st.minUsd} threshold`, { usd: +usd.toFixed(2), impactPct: fit.impactPct != null ? +fit.impactPct.toFixed(2) : null });
    if (maxSwapWeth != null && wethOf) {
      const w = await wethOf(currencyOut, fit.quotedOut);
      if (w != null && w > maxSwapWeth) return skip(`proceeds ${ethers.formatEther(w)} WETH over maxSwapValueWeth`);
    }

    // Confirmation: announce the sale with its numbers and wait for a decision.
    if (st.confirm) {
      const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
      const outSym = isNative(currencyOut) ? "ETH" : currencyOut.toLowerCase() === String((usdOf.stable || "")).toLowerCase() ? "USDG" : "the quote token";
      const outHuman = isNative(currencyOut) ? `${Number(ethers.formatEther(fit.quotedOut)).toFixed(5)} ETH` : outSym === "USDG" ? `${Number(ethers.formatUnits(fit.quotedOut, 6)).toFixed(2)} USDG` : `${fit.quotedOut} raw`;
      const vaultUsd = splitPct != null ? usd * splitPct / 100 : null;
      const row = { id, createdAt: Date.now(), status: "pending", wallet: owner.label, walletAddress: owner.address, token: symbol, tokenAddress: token,
        amount: Number(ethers.formatUnits(fit.amountIn, decimals)), ofBatch: Number(ethers.formatUnits(amount, decimals)), quotedOut: outHuman, usd: +usd.toFixed(2),
        impactPct: +fit.impactPct.toFixed(2), pool: `${key.currency0 === ethers.ZeroAddress ? "ETH" : "USDG"}/${symbol} ${(key.fee / 10000).toFixed(2)}%`, slippageBps: Number(slippageBps),
        vaultUsd: vaultUsd != null ? +vaultUsd.toFixed(2) : null, walletUsd: vaultUsd != null ? +(usd - vaultUsd).toFixed(2) : null, expiresAt: Date.now() + st.confirmWaitMinutes * 60000 };
      writePending([...readPending(), row]);
      const text = `💱 Sale pending #${id}\n${owner.label}: sell ${row.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${symbol}${full ? "" : ` of ${row.ofBatch.toLocaleString("en-US", { maximumFractionDigits: 0 })} (the rest is handed back)`} in ${row.pool}\nQuote: ${outHuman} ≈ $${row.usd.toFixed(2)} · impact ${row.impactPct}% · slippage ${(Number(slippageBps) / 100).toFixed(1)}%${vaultUsd != null ? `\nAfter the ${splitPct}% vault split: ≈ $${row.walletUsd.toFixed(2)} to ${owner.label}, $${row.vaultUsd.toFixed(2)} to the vault` : ""}\nTell Loko_AI "approve sale ${id}" within ${st.confirmWaitMinutes} min, or "reject sale ${id}". Unanswered = handed back unsold.`;
      log(`  sale #${id} awaiting approval (${row.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${symbol} ≈ $${row.usd.toFixed(2)})`);
      if (notify) { try { await notify(text); } catch (err) { log(`  ! could not send the approval request: ${err.message}`); } }
      const deadline = Date.now() + st.confirmWaitMinutes * 60000;
      let decision = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        const cur = readPending().find((r) => r.id === id);
        if (cur && cur.status !== "pending") { decision = cur.status; break; }
      }
      if (decision !== "approved") {
        const rows = readPending(); const cur = rows.find((r) => r.id === id);
        if (cur && cur.status === "pending") { cur.status = "expired"; cur.decidedAt = Date.now(); writePending(rows); }
        if (notify) { try { await notify(decision === "rejected" ? `❌ Sale #${id} rejected — ${symbol} handed back to ${owner.label}.` : `⌛ Sale #${id} not approved in ${st.confirmWaitMinutes} min — ${symbol} handed back to ${owner.label}.`); } catch {} }
        return skip(decision === "rejected" ? `rejected by you (#${id})` : `not approved within ${st.confirmWaitMinutes} min (#${id})`, { usd: row.usd, impactPct: row.impactPct });
      }
      log(`  sale #${id} approved`);
    }

    const minOut = (fit.quotedOut * (10000n - slippageBps)) / 10000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const call = buildSwapCalldata({ key, zeroForOne, amountIn: fit.amountIn, minOut, deadline, recipient: wallet.address });

    // Permit2: exact-amount ERC-20 allowance to Permit2, then a 1-hour Permit2 allowance to the router.
    try {
      const erc20 = new ethers.Contract(token, ERC20_ABI, wallet);
      const permit2 = new ethers.Contract(st.permit2, PERMIT2_ABI, wallet);
      if ((await erc20.allowance(wallet.address, st.permit2)) < fit.amountIn) {
        const tx = await erc20.approve(st.permit2, fit.amountIn);
        log(`  approve ${symbol} -> Permit2 -> ${tx.hash}`);
        const r = await tx.wait();
        recordGas(r.gasUsed * r.gasPrice);
      }
      const [pAmt, pExp] = await permit2.allowance(wallet.address, token, st.router);
      const now = Math.floor(Date.now() / 1000);
      if (BigInt(pAmt) < fit.amountIn || Number(pExp) <= now + 60) {
        const tx = await permit2.approve(token, st.router, fit.amountIn, now + 3600);
        log(`  Permit2.approve ${symbol} -> router (1h) -> ${tx.hash}`);
        const r = await tx.wait();
        recordGas(r.gasUsed * r.gasPrice);
      }
    } catch (err) {
      return skip(`approval failed (${err.shortMessage || err.message})`);
    }

    // Dry-run the exact call from the operator before sending.
    try {
      await provider.call({ from: wallet.address, to: st.router, data: call.data, value: call.value });
    } catch (err) {
      return skip(`dry-run reverted (${(err.shortMessage || err.message).slice(0, 120)})`, { impactPct: +fit.impactPct.toFixed(2) });
    }

    try {
      const outSym = isNative(currencyOut) ? "ETH" : currencyOut;
      log(`  sell ${ethers.formatUnits(fit.amountIn, decimals)} ${symbol} -> v4 pool (impact ${fit.impactPct.toFixed(2)}%, quote ${fit.quotedOut} raw ${outSym}, min ${minOut})${full ? "" : " [slice; rest handed back]"}`);
      const tx = await wallet.sendTransaction({ to: st.router, data: call.data, value: call.value });
      log(`    -> ${tx.hash}`);
      const rcpt = await tx.wait();
      recordGas(rcpt.gasUsed * rcpt.gasPrice);
      const row = {
        t: Date.now(), block: rcpt.blockNumber, wallet: owner.label, walletAddress: owner.address, token: symbol, tokenAddress: token,
        amount: Number(ethers.formatUnits(fit.amountIn, decimals)), amountRaw: fit.amountIn.toString(),
        currencyOut, quotedOut: fit.quotedOut.toString(), minOut: minOut.toString(), usd: +usd.toFixed(2),
        impactPct: +fit.impactPct.toFixed(2), slippageBps: Number(slippageBps), poolId: poolIdOf(key), tx: tx.hash, skipped: false,
      };
      try { appendSale(row); } catch {}
      if (notify && st.confirm) { try { await notify(`✅ Sold ${row.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${symbol} for ≈ $${usd.toFixed(2)} — tx ${tx.hash.slice(0, 12)}… Proceeds go through the normal split this run.`); } catch {} }
      return { sold: true, amountIn: fit.amountIn, amountOut: fit.quotedOut, currencyOut, tx: tx.hash, remaining: amount - fit.amountIn, usd };
    } catch (err) {
      return skip(`swap failed (${err.shortMessage || err.message})`);
    }
  }

  return { ready: !!ready, settings: st, sell, quote, quoteOut, discoverEthPools, discoverPools };
}

module.exports = { create, settings, buildSwapCalldata, fitSlice, spotOut, impactPct, poolIdOf, ACT, CMD_V4_SWAP, decideSale, pendingSales, readPending, appendSale };
