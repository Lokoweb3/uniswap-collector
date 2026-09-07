/**
 * Uniswap v3 read helpers: tick math, liquidity -> token amounts, and pricing
 * straight from pool slot0. No external price API, no quoter gas simulation --
 * every number here comes from pool state we have to read anyway.
 */

const { ethers } = require("ethers");

const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT128 = Q128 - 1n;

const FACTORY_ABI = [
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
];

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
];

const NPM_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

// ---------------------------------------------------------------------------
// TickMath
// ---------------------------------------------------------------------------

const MIN_TICK = -887272;
const MAX_TICK = 887272;

// 1.0001 in Q128.128, exact to within one ulp (10001/10000 is a clean ratio).
const BASE_Q128 = (10001n << 128n) / 10000n;

/** Integer square root by Newton's method, seeded from bit length. */
function isqrt(n) {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  // Seed at 2^ceil(bits/2) so convergence takes a handful of iterations even
  // for 300-bit inputs.
  let x = 1n << (BigInt(n.toString(2).length) / 2n + 1n);
  let y = (x + n / x) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/** 1.0001^exp in Q128.128, by binary exponentiation. */
function powBaseQ128(exp) {
  let result = 1n << 128n;
  let b = BASE_Q128;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) >> 128n;
    b = (b * b) >> 128n;
    e >>= 1n;
  }
  return result;
}

/**
 * sqrt(1.0001^tick) * 2^96 -- Uniswap's TickMath.getSqrtRatioAtTick.
 *
 * Derived rather than table-driven: computes 1.0001^tick in Q128.128 then takes
 * an integer square root. Verified against Uniswap's published anchors at tick
 * 0, MIN_TICK and MAX_TICK. May differ from the on-chain version by a couple of
 * ulps at extreme ticks, which is immaterial for display but means this should
 * not be used to build transaction calldata.
 */
function getSqrtRatioAtTick(tick) {
  const t = Number(tick);
  if (t < MIN_TICK || t > MAX_TICK) throw new Error(`tick ${t} out of bounds`);
  if (t === 0) return Q96;

  const absTick = BigInt(Math.abs(t));
  const p = powBaseQ128(absTick);

  // We want X = 1.0001^tick * 2^192, so that isqrt(X) = sqrt(1.0001^tick) * 2^96.
  //
  // Positive ticks just shift p up. Negative ticks must divide at the full
  // 2^320 scale rather than inverting at 2^256 first -- at large |tick| the
  // divisor exceeds 2^256 and the quotient truncates to zero.
  const x = t > 0 ? p << 64n : (1n << 320n) / p;

  return isqrt(x);
}

// ---------------------------------------------------------------------------
// LiquidityAmounts
// ---------------------------------------------------------------------------

function amount0ForLiquidity(sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA === 0n) return 0n;
  return ((liquidity << 96n) * (sqrtB - sqrtA)) / sqrtB / sqrtA;
}

function amount1ForLiquidity(sqrtA, sqrtB, liquidity) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

/** Split a position's liquidity into its two underlying token amounts. */
function getAmountsForLiquidity(sqrtCurrent, sqrtLower, sqrtUpper, liquidity) {
  if (sqrtLower > sqrtUpper) [sqrtLower, sqrtUpper] = [sqrtUpper, sqrtLower];

  if (sqrtCurrent <= sqrtLower) {
    // Price below the range: position is entirely token0.
    return { amount0: amount0ForLiquidity(sqrtLower, sqrtUpper, liquidity), amount1: 0n };
  }
  if (sqrtCurrent < sqrtUpper) {
    return {
      amount0: amount0ForLiquidity(sqrtCurrent, sqrtUpper, liquidity),
      amount1: amount1ForLiquidity(sqrtLower, sqrtCurrent, liquidity),
    };
  }
  // Price above the range: entirely token1.
  return { amount0: 0n, amount1: amount1ForLiquidity(sqrtLower, sqrtUpper, liquidity) };
}

// ---------------------------------------------------------------------------
// Price helpers
// ---------------------------------------------------------------------------

/**
 * Human-readable price of token0 denominated in token1, adjusted for decimals.
 * Uses Number at the end: fine for display, never for value arithmetic.
 */
function priceFromSqrt(sqrtPriceX96, decimals0, decimals1) {
  const s = Number(sqrtPriceX96) / Number(Q96);
  return s * s * Math.pow(10, decimals0 - decimals1);
}

function priceAtTick(tick, decimals0, decimals1) {
  return priceFromSqrt(getSqrtRatioAtTick(tick), decimals0, decimals1);
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

const tokenCache = new Map();

async function getToken(address, provider) {
  const key = address.toLowerCase();
  if (tokenCache.has(key)) return tokenCache.get(key);
  const c = new ethers.Contract(address, ERC20_ABI, provider);
  let symbol = address.slice(0, 6);
  let decimals = 18;
  try {
    // A token's symbol is attacker-controlled text that ends up in HTML and
    // in tool output; keep it to plain printable characters and a sane length.
    const raw = String(await c.symbol());
    const clean = raw.replace(/[^A-Za-z0-9 ._$+-]/g, "").trim().slice(0, 16);
    symbol = clean || address.slice(0, 6);
  } catch {}
  try {
    decimals = Number(await c.decimals());
  } catch {}
  const info = { address, symbol, decimals };
  tokenCache.set(key, info);
  return info;
}

async function listTokenIds(npm, owner, explicit) {
  if (explicit && explicit.length) return explicit.map((i) => BigInt(i));
  const count = await npm.balanceOf(owner);
  const ids = [];
  for (let i = 0n; i < count; i++) ids.push(await npm.tokenOfOwnerByIndex(owner, i));
  return ids;
}

/**
 * Uncollected fees. collect() pokes the pool with burn(0) before computing
 * tokensOwed, so a staticCall returns fees accrued to the current block rather
 * than the stale struct values. The position manager checks authorisation, so
 * `from` must be the owner or an approved operator -- with the default zero
 * address this reverts.
 */
async function readUncollectedFees(npm, tokenId, owner) {
  try {
    const res = await npm.collect.staticCall(
      { tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
      { from: owner }
    );
    return { amount0: res[0], amount1: res[1], ok: true };
  } catch (err) {
    return { amount0: 0n, amount1: 0n, ok: false, error: err.shortMessage || err.message };
  }
}

/** Build the full picture for one position. */
async function loadPosition(ctx, tokenId) {
  const { provider, npm, factory, cfg } = ctx;
  const pos = await npm.positions(tokenId);

  // Bail out before the expensive work. A wallet accumulates closed positions
  // because the manager keeps the NFT after withdrawal, and each one would
  // otherwise cost two symbol lookups, a getPool, a slot0 and a collect
  // static call.
  //
  // Zero liquidity alone is not sufficient: withdrawing without collecting
  // leaves a real balance in tokensOwed. Only skip when both are empty.
  if (pos.liquidity === 0n && pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n) {
    return { tokenId: tokenId.toString(), closed: true };
  }

  const [t0, t1] = await Promise.all([
    getToken(pos.token0, provider),
    getToken(pos.token1, provider),
  ]);

  const poolAddress = await factory.getPool(pos.token0, pos.token1, pos.fee);
  if (poolAddress === ethers.ZeroAddress) throw new Error(`no pool for #${tokenId}`);

  const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);
  const slot0 = await pool.slot0();

  const tickLower = Number(pos.tickLower);
  const tickUpper = Number(pos.tickUpper);
  const currentTick = Number(slot0.tick);
  const sqrtCurrent = slot0.sqrtPriceX96;
  const sqrtLower = getSqrtRatioAtTick(tickLower);
  const sqrtUpper = getSqrtRatioAtTick(tickUpper);

  const { amount0, amount1 } = getAmountsForLiquidity(
    sqrtCurrent,
    sqrtLower,
    sqrtUpper,
    pos.liquidity
  );

  const fees = await readUncollectedFees(npm, tokenId, cfg.ownerAddress);

  const inRange = currentTick >= tickLower && currentTick < tickUpper;

  return {
    tokenId: tokenId.toString(),
    poolAddress,
    feeTier: Number(pos.fee),
    liquidity: pos.liquidity.toString(),
    token0: t0,
    token1: t1,
    tickLower,
    tickUpper,
    currentTick,
    inRange,
    closed: pos.liquidity === 0n,
    amounts: { amount0: amount0.toString(), amount1: amount1.toString() },
    fees: {
      amount0: fees.amount0.toString(),
      amount1: fees.amount1.toString(),
      ok: fees.ok,
      error: fees.error || null,
    },
    prices: {
      current: priceFromSqrt(sqrtCurrent, t0.decimals, t1.decimals),
      lower: priceAtTick(tickLower, t0.decimals, t1.decimals),
      upper: priceAtTick(tickUpper, t0.decimals, t1.decimals),
    },
  };
}

module.exports = {
  Q96,
  MAX_UINT128,
  FACTORY_ABI,
  POOL_ABI,
  NPM_ABI,
  ERC20_ABI,
  getSqrtRatioAtTick,
  getAmountsForLiquidity,
  amount0ForLiquidity,
  amount1ForLiquidity,
  priceFromSqrt,
  priceAtTick,
  getToken,
  listTokenIds,
  readUncollectedFees,
  loadPosition,
};
