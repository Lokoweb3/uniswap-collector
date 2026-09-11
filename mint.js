/**
 * mint.js — open a Uniswap v4 (hookless) or v3 position, or move an open one to
 * a new range, from the Wallet page's Mint tab. Same shape as the Sell tab:
 * the dashboard reads the pool and builds the calldata, the position's own
 * wallet signs it in Rabby, and nothing here holds a key or sends anything.
 *
 *   v4 mint    PositionManager.modifyLiquidities(unlockData, deadline)
 *              actions = MINT_POSITION, SETTLE_PAIR (+ SWEEP of leftover ETH when
 *              one side is native). ERC-20 sides are pulled through Permit2, so the
 *              wallet first approves the token for Permit2 (once) and Permit2 for the
 *              PositionManager (per amount), exactly like the Sell tab does for the router.
 *   v4 move    step 1: DECREASE_LIQUIDITY (all) + TAKE_PAIR back to the wallet;
 *              step 2: a fresh mint with the tokens that came back.
 *   v3 mint    NonfungiblePositionManager.mint(...) — ERC-20 approvals go straight to
 *              the NPM; an ETH side is paid as msg.value with refundETH() in one multicall.
 *   v3 move    step 1: multicall(decreaseLiquidity(all), collect(max)) — one signature;
 *              step 2: a fresh mint.
 *
 * Pure helpers (liquidity math, tick rounding, calldata) are exported for the tests.
 */
"use strict";
const { ethers } = require("ethers");
const u = require("./univ3");
const v4 = require("./univ4");

const coder = ethers.AbiCoder.defaultAbiCoder();
const Q96 = 2n ** 96n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MIN_TICK = -887272, MAX_TICK = 887272;
const ACT = { DECREASE_LIQUIDITY: 0x01, MINT_POSITION: 0x02, SETTLE_PAIR: 0x0d, TAKE_PAIR: 0x11, SWEEP: 0x14 };
// Fee tiers (pips, tick spacing) the chain's v4 pools use, same list the sell path enumerates; v3 has the four canonical tiers.
const V4_TIERS = [[100, 1], [500, 10], [2500, 50], [3000, 60], [10000, 200], [15000, 300], [20000, 400], [29988, 300], [30000, 600], [50000, 200], [100000, 1000]];
const V3_TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MULTICALL_ABI = ["function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) view returns (tuple(bool success,bytes returnData)[])"];
const POOL_KEY_T = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const POSM_ABI = [...v4.POSM_ABI, "function modifyLiquidities(bytes unlockData, uint256 deadline) payable"];
const NPM_ABI = [
  ...u.NPM_ABI,
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)",
  "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns (uint256 amount0,uint256 amount1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function refundETH() payable",
  "function ownerOf(uint256 tokenId) view returns (address)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const posmIface = new ethers.Interface(POSM_ABI);
const npmIface = new ethers.Interface(NPM_ABI);
const isNative = (a) => !a || a === ethers.ZeroAddress || String(a).toLowerCase() === "eth";

/* ---------- tick and liquidity math (pure) ---------- */

/** Nearest usable tick at or below (dir -1) / at or above (dir +1) `tick`, inside the pool's bounds. */
function alignTick(tick, spacing, dir = -1) {
  const s = Number(spacing);
  let t = dir < 0 ? Math.floor(tick / s) * s : Math.ceil(tick / s) * s;
  const lo = Math.ceil(MIN_TICK / s) * s, hi = Math.floor(MAX_TICK / s) * s;
  if (t < lo) t = lo;
  if (t > hi) t = hi;
  return t;
}

/** The tick whose price (token1 per token0, human units) is `price`; not aligned. */
function tickFromPrice(price, decimals0, decimals1) {
  const raw = Number(price) * Math.pow(10, decimals1 - decimals0);
  if (!(raw > 0)) throw new Error("price must be positive");
  const t = Math.floor(Math.log(raw) / Math.log(1.0001));
  return Math.max(MIN_TICK, Math.min(MAX_TICK, t));
}

/** Liquidity the pool gives for these amounts at the current price (LiquidityAmounts.getLiquidityForAmounts). */
function liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const l0 = (a, b) => (b - a) === 0n ? 0n : (amount0 * ((a * b) / Q96)) / (b - a);
  const l1 = (a, b) => (b - a) === 0n ? 0n : (amount1 * Q96) / (b - a);
  if (sqrtP <= sqrtA) return l0(sqrtA, sqrtB);
  if (sqrtP < sqrtB) { const x = l0(sqrtP, sqrtB), y = l1(sqrtA, sqrtP); return x < y ? x : y; }
  return l1(sqrtA, sqrtB);
}

/** Amounts a liquidity value needs, rounded up so the mint never comes up one wei short. */
function amountsForLiquidityUp(sqrtP, sqrtA, sqrtB, liquidity) {
  const { amount0, amount1 } = u.getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liquidity);
  return { amount0: amount0 > 0n ? amount0 + 1n : 0n, amount1: amount1 > 0n ? amount1 + 1n : 0n };
}

const withSlippage = (x, bps, up) => (up ? (x * (10000n + BigInt(bps))) / 10000n : (x * (10000n - BigInt(bps))) / 10000n);

/* ---------- calldata (pure) ---------- */

/** v4: MINT_POSITION + SETTLE_PAIR (+ SWEEP of the native leftover). Returns { to, data, value, unlockData }. */
function buildV4Mint({ posm, key, tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, deadline, hookData = "0x" }) {
  const native0 = isNative(key.currency0);
  const acts = [ACT.MINT_POSITION, ACT.SETTLE_PAIR];
  const params = [
    coder.encode([POOL_KEY_T, "int24", "int24", "uint256", "uint128", "uint128", "address", "bytes"], [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks], tickLower, tickUpper, liquidity, amount0Max, amount1Max, owner, hookData]),
    coder.encode(["address", "address"], [key.currency0, key.currency1]),
  ];
  if (native0) { acts.push(ACT.SWEEP); params.push(coder.encode(["address", "address"], [ethers.ZeroAddress, owner])); }
  const unlockData = coder.encode(["bytes", "bytes[]"], [ethers.concat(acts.map((a) => new Uint8Array([a]))), params]);
  return { to: posm, data: posmIface.encodeFunctionData("modifyLiquidities", [unlockData, deadline]), value: native0 ? BigInt(amount0Max) : 0n, unlockData };
}

/** v4: DECREASE_LIQUIDITY (all of it) + TAKE_PAIR to the owner — the same layout the guardian's close uses. */
function buildV4Close({ posm, key, tokenId, liquidity, amount0Min, amount1Min, owner, deadline }) {
  const acts = ethers.concat([new Uint8Array([ACT.DECREASE_LIQUIDITY]), new Uint8Array([ACT.TAKE_PAIR])]);
  const params = [
    coder.encode(["uint256", "uint256", "uint128", "uint128", "bytes"], [BigInt(tokenId), liquidity, amount0Min, amount1Min, "0x"]),
    coder.encode(["address", "address", "address"], [key.currency0, key.currency1, owner]),
  ];
  const unlockData = coder.encode(["bytes", "bytes[]"], [acts, params]);
  return { to: posm, data: posmIface.encodeFunctionData("modifyLiquidities", [unlockData, deadline]), value: 0n, unlockData };
}

/** v3: mint(...) — wrapped in multicall with refundETH() when a WETH side is paid as ETH. */
function buildV3Mint({ npm, weth, token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient, deadline, payEth = false }) {
  const p = { token0, token1, fee, tickLower, tickUpper, amount0Desired, amount1Desired, amount0Min, amount1Min, recipient, deadline };
  const mintData = npmIface.encodeFunctionData("mint", [p]);
  const ethSide = weth && token0.toLowerCase() === weth.toLowerCase() ? 0 : weth && token1.toLowerCase() === weth.toLowerCase() ? 1 : -1;
  if (!payEth || ethSide < 0) return { to: npm, data: mintData, value: 0n };
  const value = ethSide === 0 ? BigInt(amount0Desired) : BigInt(amount1Desired);
  return { to: npm, data: npmIface.encodeFunctionData("multicall", [[mintData, npmIface.encodeFunctionData("refundETH", [])]]), value };
}

/** v3: decreaseLiquidity(all) + collect(max) in one multicall, tokens to the recipient (WETH stays WETH). */
function buildV3Close({ npm, tokenId, liquidity, amount0Min, amount1Min, recipient, deadline }) {
  const dec = npmIface.encodeFunctionData("decreaseLiquidity", [{ tokenId: BigInt(tokenId), liquidity, amount0Min, amount1Min, deadline }]);
  const col = npmIface.encodeFunctionData("collect", [{ tokenId: BigInt(tokenId), recipient, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }]);
  return { to: npm, data: npmIface.encodeFunctionData("multicall", [[dec, col]]), value: 0n };
}

/* ---------- chain reads ---------- */

function create({ provider, cfg }) {
  const c = cfg.contracts || {};
  const v4c = c.v4 || {};
  const weth = c.weth;
  const posm = v4c.positionManager ? new ethers.Contract(v4c.positionManager, POSM_ABI, provider) : null;
  const stateView = v4c.stateView ? new ethers.Contract(v4c.stateView, [...v4.STATE_VIEW_ABI, "function getLiquidity(bytes32 poolId) view returns (uint128)"], provider) : null;
  const npm = c.positionManager ? new ethers.Contract(c.positionManager, NPM_ABI, provider) : null;
  const factory = c.factory ? new ethers.Contract(c.factory, u.FACTORY_ABI, provider) : null;
  const mc = new ethers.Contract(MULTICALL3, MULTICALL_ABI, provider);

  const sortPair = (a, b) => (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]);
  async function tokenMeta(addr) {
    if (isNative(addr)) return { address: ethers.ZeroAddress, symbol: "ETH", decimals: 18, native: true };
    const t = await u.getToken(ethers.getAddress(addr), provider);
    return { address: ethers.getAddress(addr), symbol: t.symbol, decimals: Number(t.decimals), native: false };
  }

  /**
   * Every initialised pool for the pair: v4 hookless tiers (native ETH for the ETH
   * side) and v3 tiers (WETH for the ETH side), each with its price and liquidity.
   */
  async function pools({ tokenA, tokenB }) {
    const [mA, mB] = await Promise.all([tokenMeta(tokenA), tokenMeta(tokenB)]);
    if (mA.address.toLowerCase() === mB.address.toLowerCase()) throw new Error("pick two different tokens");
    const out = [];
    const calls = [];
    const v4keys = [];
    if (posm && stateView) {
      const [c0, c1] = sortPair(mA.address, mB.address);
      for (const [fee, tickSpacing] of V4_TIERS) {
        const key = { currency0: c0, currency1: c1, fee, tickSpacing, hooks: ethers.ZeroAddress };
        v4keys.push(key);
        const id = v4.poolIdOf(key);
        calls.push({ target: stateView.target, allowFailure: true, callData: stateView.interface.encodeFunctionData("getSlot0", [id]) });
        calls.push({ target: stateView.target, allowFailure: true, callData: stateView.interface.encodeFunctionData("getLiquidity", [id]) });
      }
    }
    const v3addrs = [];
    if (npm && factory && weth) {
      const a = mA.native ? weth : mA.address, b = mB.native ? weth : mB.address;
      const [t0, t1] = sortPair(a, b);
      for (const [fee] of V3_TIERS) { v3addrs.push({ t0, t1, fee }); calls.push({ target: factory.target, allowFailure: true, callData: factory.interface.encodeFunctionData("getPool", [t0, t1, fee]) }); }
    }
    const res = await mc.aggregate3(calls);
    let i = 0;
    const metaOf = (addr) => (isNative(addr) ? { ...mA, ...mB, ...(mA.native ? mA : mB) } : mA.address.toLowerCase() === addr.toLowerCase() ? mA : mB);
    for (const key of v4keys) {
      const s = res[i++], l = res[i++];
      if (!s.success || s.returnData.length < 66) continue;
      const slot = stateView.interface.decodeFunctionResult("getSlot0", s.returnData);
      if (slot[0] === 0n) continue; // not initialised
      const m0 = metaOf(key.currency0), m1 = metaOf(key.currency1);
      out.push({ version: 4, key, poolId: v4.poolIdOf(key), fee: key.fee, feePct: key.fee / 10000, tickSpacing: key.tickSpacing, sqrtPriceX96: slot[0].toString(), tick: Number(slot[1]), liquidity: l.success && l.returnData.length >= 66 ? BigInt(l.returnData).toString() : "0",
        token0: m0, token1: m1, price: u.priceFromSqrt(slot[0], m0.decimals, m1.decimals), label: `${m0.symbol} / ${m1.symbol} ${key.fee / 10000}% v4` });
    }
    const v3live = [];
    for (const p of v3addrs) {
      const r = res[i++];
      if (!r.success || r.returnData.length < 66) continue;
      const addr = ethers.getAddress("0x" + r.returnData.slice(-40));
      if (addr === ethers.ZeroAddress) continue;
      v3live.push({ ...p, addr });
    }
    if (v3live.length) {
      const poolIface = new ethers.Interface(u.POOL_ABI);
      const r2 = await mc.aggregate3(v3live.flatMap((p) => [{ target: p.addr, allowFailure: true, callData: poolIface.encodeFunctionData("slot0", []) }, { target: p.addr, allowFailure: true, callData: poolIface.encodeFunctionData("liquidity", []) }]));
      v3live.forEach((p, j) => {
        const s = r2[2 * j], l = r2[2 * j + 1];
        if (!s.success || s.returnData.length < 66) return;
        const slot = poolIface.decodeFunctionResult("slot0", s.returnData);
        if (slot[0] === 0n) return;
        const wethMeta = { address: ethers.getAddress(weth), symbol: "WETH", decimals: 18, native: false, isWeth: true };
        const m = (addr) => (addr.toLowerCase() === weth.toLowerCase() ? wethMeta : mA.address.toLowerCase() === addr.toLowerCase() ? mA : mB);
        const m0 = m(p.t0), m1 = m(p.t1);
        const tickSpacing = V3_TIERS.find(([f]) => f === p.fee)[1];
        out.push({ version: 3, pool: p.addr, token0: m0, token1: m1, fee: p.fee, feePct: p.fee / 10000, tickSpacing, sqrtPriceX96: slot[0].toString(), tick: Number(slot[1]), liquidity: l.success && l.returnData.length >= 66 ? BigInt(l.returnData).toString() : "0",
          price: u.priceFromSqrt(slot[0], m0.decimals, m1.decimals), label: `${m0.symbol} / ${m1.symbol} ${p.fee / 10000}% v3` });
      });
    }
    out.sort((a, b) => Number(BigInt(b.liquidity) > BigInt(a.liquidity)) - Number(BigInt(b.liquidity) < BigInt(a.liquidity)));
    return { tokenA: mA, tokenB: mB, pools: out };
  }

  /** ETH plus the two tokens' balances of `wallet`, raw and human. */
  async function balances({ wallet, tokens }) {
    const eth = await provider.getBalance(wallet);
    const rows = [{ address: ethers.ZeroAddress, symbol: "ETH", decimals: 18, raw: eth.toString(), balance: Number(ethers.formatEther(eth)) }];
    const erc = new ethers.Interface(ERC20_ABI);
    const list = tokens.filter((t) => !isNative(t)).map((t) => ethers.getAddress(t));
    if (list.length) {
      const res = await mc.aggregate3(list.map((t) => ({ target: t, allowFailure: true, callData: erc.encodeFunctionData("balanceOf", [wallet]) })));
      for (let i = 0; i < list.length; i++) {
        const m = await tokenMeta(list[i]);
        const raw = res[i].success && res[i].returnData.length >= 66 ? BigInt(res[i].returnData) : 0n;
        rows.push({ address: list[i], symbol: m.symbol, decimals: m.decimals, raw: raw.toString(), balance: Number(ethers.formatUnits(raw, m.decimals)) });
      }
    }
    return rows;
  }

  /** eth_call a built transaction as the wallet: { ok } or { ok: false, error }. No key involved. */
  async function dry(from, tx) {
    try { await provider.call({ from, to: tx.to, data: tx.data, value: tx.value }); return { ok: true }; }
    catch (err) { return { ok: false, error: err.shortMessage || err.message }; }
  }

  /** Fresh price for a pool description (as returned by pools()). */
  async function slot0Of(pool) {
    if (pool.version === 4) { const s = await stateView.getSlot0(v4.poolIdOf(pool.key)); return { sqrtPriceX96: s[0], tick: Number(s[1]) }; }
    const s = await new ethers.Contract(pool.pool, u.POOL_ABI, provider).slot0();
    return { sqrtPriceX96: s.sqrtPriceX96, tick: Number(s.tick) };
  }

  /**
   * quote({ wallet, pool, tickLower, tickUpper, amount0, amount1, slippageBps })
   * amount0/amount1 are raw units the wallet is willing to put in; the pool's
   * price decides how much of each is actually used (the smaller side binds).
   * Returns the position that would result and the transaction to sign.
   */
  async function quote({ wallet, pool, tickLower, tickUpper, amount0, amount1, slippageBps = 100, deadlineMinutes = 20, payEth = true }) {
    wallet = ethers.getAddress(wallet);
    const spacing = Number(pool.tickSpacing);
    tickLower = alignTick(Number(tickLower), spacing, -1);
    tickUpper = alignTick(Number(tickUpper), spacing, +1);
    if (!(tickLower < tickUpper)) throw new Error("the range is empty after rounding to the pool's tick spacing");
    const { sqrtPriceX96, tick } = await slot0Of(pool);
    const sqrtA = u.getSqrtRatioAtTick(tickLower), sqrtB = u.getSqrtRatioAtTick(tickUpper);
    const a0 = BigInt(amount0 || 0), a1 = BigInt(amount1 || 0);
    const liquidity = liquidityForAmounts(sqrtPriceX96, sqrtA, sqrtB, a0, a1);
    if (liquidity <= 0n) throw new Error(sqrtPriceX96 <= sqrtA ? `the price is below the range: only ${pool.token0.symbol} goes in` : sqrtPriceX96 >= sqrtB ? `the price is above the range: only ${pool.token1.symbol} goes in` : "amounts too small for this range");
    const need = amountsForLiquidityUp(sqrtPriceX96, sqrtA, sqrtB, liquidity);
    const max0 = withSlippage(need.amount0, slippageBps, true), max1 = withSlippage(need.amount1, slippageBps, true);
    const min0 = withSlippage(need.amount0, slippageBps, false), min1 = withSlippage(need.amount1, slippageBps, false);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineMinutes * 60);
    const d0 = pool.token0.decimals, d1 = pool.token1.decimals;
    const bal = await balances({ wallet, tokens: [pool.token0.address, pool.token1.address] });
    const balOf = (m) => bal.find((b) => (m.native ? b.address === ethers.ZeroAddress : b.address.toLowerCase() === m.address.toLowerCase()));
    const warnings = [];
    // What the wallet will actually pay: native ETH for a v4 ETH side, ETH for a v3 WETH side when payEth, else the token.
    const pays = (m, amountMax) => {
      const ethPaid = m.native || (pool.version === 3 && m.isWeth && payEth);
      const b = ethPaid ? bal[0] : balOf(m);
      if (b && BigInt(b.raw) < amountMax) warnings.push(`${m.symbol}: wallet holds ${b.balance.toLocaleString("en-US", { maximumFractionDigits: 6 })}, needs up to ${Number(ethers.formatUnits(amountMax, m.decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })}`);
      return ethPaid;
    };
    const eth0 = pays(pool.token0, max0), eth1 = pays(pool.token1, max1);
    let tx, approvals;
    if (pool.version === 4) {
      tx = buildV4Mint({ posm: posm.target, key: pool.key, tickLower, tickUpper, liquidity, amount0Max: max0, amount1Max: max1, owner: wallet, deadline });
      approvals = [pool.token0, pool.token1].map((m, i) => (m.native ? null : { token: m.address, symbol: m.symbol, amount: (i ? max1 : max0).toString(), via: "permit2", spender: posm.target })).filter(Boolean);
    } else {
      tx = buildV3Mint({ npm: npm.target, weth, token0: pool.token0.address, token1: pool.token1.address, fee: pool.fee, tickLower, tickUpper, amount0Desired: need.amount0, amount1Desired: need.amount1, amount0Min: min0, amount1Min: min1, recipient: wallet, deadline, payEth: eth0 || eth1 });
      approvals = [pool.token0, pool.token1].map((m, i) => ((i ? eth1 : eth0) ? null : { token: m.address, symbol: m.symbol, amount: (i ? need.amount1 : need.amount0).toString(), via: "erc20", spender: npm.target })).filter(Boolean);
    }
    const poolLiq = BigInt(pool.liquidity || 0);
    const inRange = tick >= tickLower && tick < tickUpper;
    return {
      ok: true, version: pool.version, pool: pool.version === 4 ? pool.key : { address: pool.pool, token0: pool.token0.address, token1: pool.token1.address, fee: pool.fee }, label: pool.label,
      tickLower, tickUpper, tick, inRange, liquidity: liquidity.toString(),
      amount0: need.amount0.toString(), amount1: need.amount1.toString(), amount0Max: max0.toString(), amount1Max: max1.toString(),
      human: { amount0: Number(ethers.formatUnits(need.amount0, d0)), amount1: Number(ethers.formatUnits(need.amount1, d1)), price: u.priceFromSqrt(sqrtPriceX96, d0, d1), priceLower: u.priceAtTick(tickLower, d0, d1), priceUpper: u.priceAtTick(tickUpper, d0, d1) },
      shareInRangePct: inRange && poolLiq + liquidity > 0n ? Number((liquidity * 1000000n) / (poolLiq + liquidity)) / 10000 : null,
      slippageBps: Number(slippageBps), deadline: deadline.toString(), approvals, permit2: v4c.permit2 || "0x000000000022D473030F116dDEE9F6B43aC78BA3", tx: { to: tx.to, data: tx.data, value: tx.value.toString() }, warnings, balances: bal,
    };
  }

  /**
   * closeQuote({ wallet, version, tokenId, slippageBps }) — step 1 of a move: the
   * transaction that returns the whole position (liquidity and fees) to its wallet,
   * plus the pool it sat in so the mint form can be pre-filled.
   */
  async function closeQuote({ wallet, version, tokenId, slippageBps = 100 }) {
    wallet = ethers.getAddress(wallet);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);
    if (Number(version) === 4) {
      const p = await v4.loadPosition({ provider, posm, stateView, cfg: { ...cfg, ownerAddress: wallet } }, tokenId);
      if (p.gone) throw new Error(`#${tokenId} is not owned by this wallet`);
      if (p.closed) throw new Error(`#${tokenId} has no liquidity`);
      const { key } = await posm.getPoolAndPositionInfo(BigInt(tokenId));
      if (key.hooks !== ethers.ZeroAddress) throw new Error("hooked pools are not supported here yet");
      const k = { currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks };
      const a0 = BigInt(p.amounts.amount0), a1 = BigInt(p.amounts.amount1);
      const tx = buildV4Close({ posm: posm.target, key: k, tokenId, liquidity: BigInt(p.liquidity), amount0Min: withSlippage(a0, slippageBps, false), amount1Min: withSlippage(a1, slippageBps, false), owner: wallet, deadline });
      const [m0, m1] = await Promise.all([tokenMeta(k.currency0), tokenMeta(k.currency1)]);
      const dryRun = await dry(wallet, tx);
      return { ok: true, version: 4, tokenId: String(tokenId), key: k, token0: m0, token1: m1, dryRun, tickLower: p.tickLower, tickUpper: p.tickUpper, expect: { amount0: (a0 + BigInt(p.fees.amount0 || 0)).toString(), amount1: (a1 + BigInt(p.fees.amount1 || 0)).toString() }, tx: { to: tx.to, data: tx.data, value: "0" }, deadline: deadline.toString() };
    }
    const pos = await npm.positions(BigInt(tokenId));
    if ((await npm.ownerOf(BigInt(tokenId))).toLowerCase() !== wallet.toLowerCase()) throw new Error(`#${tokenId} is not owned by this wallet`);
    if (pos.liquidity === 0n && pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n) throw new Error(`#${tokenId} has no liquidity`);
    const poolAddr = await factory.getPool(pos.token0, pos.token1, pos.fee);
    const slot0 = await new ethers.Contract(poolAddr, u.POOL_ABI, provider).slot0();
    const { amount0, amount1 } = u.getAmountsForLiquidity(slot0.sqrtPriceX96, u.getSqrtRatioAtTick(Number(pos.tickLower)), u.getSqrtRatioAtTick(Number(pos.tickUpper)), pos.liquidity);
    const tx = buildV3Close({ npm: npm.target, tokenId, liquidity: pos.liquidity, amount0Min: withSlippage(amount0, slippageBps, false), amount1Min: withSlippage(amount1, slippageBps, false), recipient: wallet, deadline });
    const [m0, m1] = await Promise.all([tokenMeta(pos.token0), tokenMeta(pos.token1)]);
    const wethify = (m) => (weth && m.address.toLowerCase() === weth.toLowerCase() ? { ...m, symbol: "WETH", isWeth: true } : m);
    const dryRun = await dry(wallet, tx);
    return { ok: true, version: 3, tokenId: String(tokenId), pool: poolAddr, fee: Number(pos.fee), token0: wethify(m0), token1: wethify(m1), dryRun, tickLower: Number(pos.tickLower), tickUpper: Number(pos.tickUpper), expect: { amount0: (amount0 + pos.tokensOwed0).toString(), amount1: (amount1 + pos.tokensOwed1).toString() }, tx: { to: tx.to, data: tx.data, value: "0" }, deadline: deadline.toString() };
  }

  return { pools, balances, quote, closeQuote, tokenMeta };
}

module.exports = { create, alignTick, tickFromPrice, liquidityForAmounts, amountsForLiquidityUp, withSlippage, buildV4Mint, buildV4Close, buildV3Mint, buildV3Close, ACT, V4_TIERS, V3_TIERS, MIN_TICK, MAX_TICK };
