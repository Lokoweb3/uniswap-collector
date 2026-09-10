/**
 * sell-v4.js — sell fee tokens in the Uniswap v4 pool they came from.
 *
 * Launchpad tokens (LAPTOP, Bucket, CRUMBS, ...) have no v3 route, so the
 * collector used to hand them back to the wallet unsold. This module sells
 * them through the Universal Router's V4_SWAP command into the same hookless
 * pool the position earned them from, so the proceeds (ETH or USDG) join the
 * normal sweep: USDG, the vault split, the rest to the earning wallet.
 *
 * Policy (config.json `memecoinSell`, approved 2026-09-10):
 *   enabled          off = old behaviour (hand back)
 *   minUsd           sell only when the batch is worth at least this (default 25)
 *   maxImpactPct     price impact cap vs the pool's spot price (default 3); a
 *                    batch over the cap is trimmed to the largest slice under it,
 *                    and if that slice is under minUsd nothing is sold this run
 *   hold             token symbols/addresses never to sell
 *   hooked pools     never, unless a dry-run proves the sell passes
 *   the collector's own maxSwapValueWeth and slippageBps still apply
 *
 * Every sale and every skip (with the reason) is appended to token-sales.json.
 *
 * Mechanics, all standard v4-periphery / universal-router:
 *   quote      V4Quoter.quoteExactInputSingle((PoolKey,bool,uint128,bytes))
 *   spot       StateView.getSlot0 -> sqrtPriceX96 -> expected output before fees
 *   swap       UniversalRouter.execute(commands=[V4_SWAP], inputs=[(actions, params)])
 *              actions = SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
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
const Q96 = 2n ** 96n;

// v4-periphery Actions and universal-router Commands
const ACT = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE_ALL: 0x0c, TAKE_ALL: 0x0f };
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

/** Universal Router calldata for one exact-input v4 swap; output to the caller. */
function buildSwapCalldata({ key, zeroForOne, amountIn, minOut, deadline }) {
  const actions = ethers.concat([new Uint8Array([ACT.SWAP_EXACT_IN_SINGLE]), new Uint8Array([ACT.SETTLE_ALL]), new Uint8Array([ACT.TAKE_ALL])]);
  const currencyIn = zeroForOne ? key.currency0 : key.currency1;
  const currencyOut = zeroForOne ? key.currency1 : key.currency0;
  const params = [
    coder.encode([`tuple(${POOL_KEY_T} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`], [{ poolKey: key, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: "0x" }]),
    coder.encode(["address", "uint256"], [currencyIn, amountIn]),
    coder.encode(["address", "uint256"], [currencyOut, minOut]),
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

function settings(cfg) {
  const s = (cfg && cfg.memecoinSell) || {};
  const v4 = (cfg && cfg.contracts && cfg.contracts.v4) || {};
  return {
    enabled: s.enabled === true,
    minUsd: Number(s.minUsd ?? 25),
    maxImpactPct: Number(s.maxImpactPct ?? 3),
    hold: new Set((s.hold || []).map((x) => String(x).toLowerCase())),
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
  async function sell({ token, symbol, decimals, amount, key, wallet, owner, usdOf, maxSwapWeth = null, wethOf = null, slippageBps = 100n, recordGas = () => {} }) {
    const skip = async (reason, extra = {}) => {
      log(`  sell ${symbol}: skipped — ${reason}`);
      try { appendSale({ t: Date.now(), wallet: owner.label, walletAddress: owner.address, token: symbol, tokenAddress: token, amount: Number(ethers.formatUnits(amount, decimals)), skipped: true, reason, ...extra }); } catch {}
      return { sold: false, reason, remaining: amount };
    };
    if (!ready) return { sold: false, reason: "disabled", remaining: amount };
    if (st.hold.has(String(symbol).toLowerCase()) || st.hold.has(String(token).toLowerCase())) return skip("on the hold list");
    if (!key) return skip("no v4 pool key for this token");
    if (key.hooks && key.hooks !== ethers.ZeroAddress) return skip(`pool has a hook (${key.hooks.slice(0, 10)}…); sells not proven`);
    const zeroForOne = key.currency0.toLowerCase() === String(token).toLowerCase();
    if (!zeroForOne && key.currency1.toLowerCase() !== String(token).toLowerCase()) return skip("token is not in the pool key");
    const currencyOut = zeroForOne ? key.currency1 : key.currency0;
    const feePips = Number(key.fee);

    let sqrtPriceX96;
    try { sqrtPriceX96 = (await stateView.getSlot0(poolIdOf(key)))[0]; } catch (err) { return skip(`pool state unreadable (${err.shortMessage || err.message})`); }
    const spot = (amt) => spotOut(sqrtPriceX96, zeroForOne, amt);
    let fit;
    try { fit = await fitSlice({ quote: (amt) => quoteOut(key, zeroForOne, amt), spot, feePips, amount, maxImpactPct: st.maxImpactPct }); } catch (err) { return skip(`quote failed (${err.shortMessage || err.message})`); }
    if (!fit) return skip(`even a small slice moves the pool more than ${st.maxImpactPct}%`);

    const usd = await usdOf(currencyOut, fit.quotedOut);
    const full = fit.amountIn === amount;
    if (usd == null) return skip("cannot value the proceeds");
    if (usd < st.minUsd) return skip(`${full ? "batch" : "slice under the impact cap"} worth $${usd.toFixed(2)}, below the $${st.minUsd} threshold`, { usd: +usd.toFixed(2), impactPct: fit.impactPct != null ? +fit.impactPct.toFixed(2) : null });
    if (maxSwapWeth != null && wethOf) {
      const w = await wethOf(currencyOut, fit.quotedOut);
      if (w != null && w > maxSwapWeth) return skip(`proceeds ${ethers.formatEther(w)} WETH over maxSwapValueWeth`);
    }

    const minOut = (fit.quotedOut * (10000n - slippageBps)) / 10000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const call = buildSwapCalldata({ key, zeroForOne, amountIn: fit.amountIn, minOut, deadline });

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
      return { sold: true, amountIn: fit.amountIn, amountOut: fit.quotedOut, currencyOut, tx: tx.hash, remaining: amount - fit.amountIn, usd };
    } catch (err) {
      return skip(`swap failed (${err.shortMessage || err.message})`);
    }
  }

  return { ready: !!ready, settings: st, sell, quoteOut };
}

module.exports = { create, settings, buildSwapCalldata, fitSlice, spotOut, impactPct, poolIdOf, ACT, CMD_V4_SWAP };
