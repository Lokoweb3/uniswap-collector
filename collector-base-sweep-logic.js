/**
 * collector-base-sweep-logic.js -- the pure decisions of the Base sweep (collector-base-sweep.js).
 * No I/O except the ledger file helpers at the bottom, which take an injectable fs. Everything fails closed: a
 * missing or odd number means "do not send". The allowlists below are code constants; settings can only DISABLE.
 */
"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const base = require("./collector-base-logic");
const u = require("./univ3");

const CHAIN_ID = 8453;
const USDC = ethers.getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const USDC_DECIMALS = 6;
const ROUTER = ethers.getAddress("0x2626664c2603336E57B271c5C0b26F421741e481");
const QUOTER = ethers.getAddress("0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a");
const FACTORY = ethers.getAddress("0x33128a8fC17869897dcE68Ed026d694621f6FDfD");
/** Single-hop token -> USDC routes. The only ones that exist. */
const ROUTES = Object.freeze({
  WETH: Object.freeze({ symbol: "WETH", token: ethers.getAddress("0x4200000000000000000000000000000000000006"), decimals: 18, pool: ethers.getAddress("0xd0b53D9277642d899DF5C87A3966A349A798F224"), fee: 500 }),
  cbBTC: Object.freeze({ symbol: "cbBTC", token: ethers.getAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"), decimals: 8, pool: ethers.getAddress("0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef"), fee: 500 }),
  LAPTOP: Object.freeze({ symbol: "LAPTOP", token: ethers.getAddress("0xB095274743941e953c746F9C228DA9c18Bb6ec29"), decimals: 18, pool: ethers.getAddress("0x7702411B3893ea4F6Ab96C50231cFEc65448AB9F"), fee: 10000 }),
});
/** The canonical ERC-6551 registry. Hard-coded: settings cannot change it (D7). */
const ERC6551_REGISTRY = ethers.getAddress("0x000000006551c19487814612e58FE06813775758");
/**
 * Allowlisted ERC-6551 account implementations for the vault split (D7). EMPTY by default: until a reviewed implementation address
 * is added here, in code, the vault can never verify and 100% goes to the owner. Settings cannot add to it. Frozen (deeply): tests inject their
 * own list through collector-base-sweep.create({ vaultImplementations }) / verifyVault ctx.implementations, never by mutating this.
 */
const deepFreeze = (o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const VAULT_IMPLEMENTATIONS = deepFreeze([]);
const OPS = Object.freeze(["collect", "approve", "approve-reset", "swap", "transfer"]);
const PHASES = Object.freeze(["collected", "approved", "swapped", "delivered", "delivered-unswapped", "held", "stuck"]);
const TERMINAL_PHASES = Object.freeze(["delivered", "delivered-unswapped"]);
const SWEEP_STATE_VERSION = 1;
const KEEP_TERMINAL_MS = 30 * 24 * 60 * 60 * 1000;
const FINISHED_SKEW_MS = 10 * 60 * 1000; // tolerated clock skew for a finishedAt that is "now"
/** A lagging RPC may report a head a little below the newest block the ledger saw: ledger blocks up to head + this are accepted. */
const HEAD_SLACK_BLOCKS = 64;
const MAX_UINT256 = (1n << 256n) - 1n;

const eq = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const addr = (a) => { try { return ethers.getAddress(a); } catch { return null; } };

// ---------------------------------------------------------------------------------------------------------------------
// Config: baseSweep. Defaults and HARD bounds live here. Out of bound = clamped and noted; not a number = the default.
// ---------------------------------------------------------------------------------------------------------------------

const NUMBERS = Object.freeze({
  slippageBps: { def: 50, min: 1, max: 100, int: true },
  maxPriceImpactBps: { def: 100, min: 1, max: 300, int: true },
  maxSwapValueUsdc: { def: 250, min: 1, max: 1000 },
  maxUnswappedValueUsdc: { def: 5000, min: 1, max: 50000 },
  minSwapValueUsdc: { def: 1, min: 0.01, max: 1000 },
  minPoolUsdc: { def: 2000, min: 2000, max: 1e9 },
  maxPoolShareBps: { def: 300, min: 1, max: 1000, int: true },
  twapSeconds: { def: 1800, min: 60, max: 86400, int: true },
  twapMaxDeviationBps: { def: 200, min: 1, max: 500, int: true },
  minOperatorEthReserve: { def: 0.0005, min: 0.0005, max: 0.1 },
  maxAttemptsPerLeg: { def: 3, min: 1, max: 10, int: true },
  maxTxPerRun: { def: 20, min: 1, max: 50, int: true },
  dailyTxCap: { def: 40, min: 1, max: 100, int: true },
  maxGasPerTxEth: { def: 0.0007, min: 1e-9, max: 0.0035 },
  maxGasPerRunEth: { def: 0.002, min: 1e-9, max: 0.01 },
  dailyGasCapEth: { def: 0.004, min: 1e-9, max: 0.02 },
});
/** Gas-limit ceiling per op. `collect` keeps baseCollect.maxGasLimit (500000 by default); settings can only lower these. */
const GAS_CEILINGS = Object.freeze({ collect: 500000, approve: 100000, "approve-reset": 100000, swap: 350000, transfer: 120000 });

/**
 * The effective sweep config. `enabled` is true only for the boolean true. { enabled, targetOk, numbers..., routes, vault, notes }.
 * Unknown keys (and any routes.X.pool/router/quoter) are ignored: nothing here can add an address.
 */
function config(raw) {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const notes = [];
  const out = { enabled: b.enabled === true, notes };
  const t = b.targetToken;
  out.targetOk = t === undefined || t === null || (typeof t === "string" && addr(t) === USDC);
  out.targetToken = USDC;
  for (const [k, s] of Object.entries(NUMBERS)) {
    const v = b[k];
    let n = v === undefined || v === null || v === "" || typeof v === "boolean" ? NaN : Number(v);
    if (!Number.isFinite(n) || n <= 0) { out[k] = s.def; if (v !== undefined && v !== null) notes.push(`${k}: ${JSON.stringify(v)} is not a usable number; default ${s.def}`); continue; }
    if (s.int) n = Math.floor(n);
    if (n > s.max) { notes.push(`${k}: ${n} above the hard maximum ${s.max}; clamped`); n = s.max; }
    if (n < s.min) { notes.push(`${k}: ${n} below the hard minimum ${s.min}; clamped`); n = s.min; }
    out[k] = n;
  }
  const ceil = {};
  const given = b.maxGasLimitByOp && typeof b.maxGasLimitByOp === "object" ? b.maxGasLimitByOp : {};
  for (const [op, d] of Object.entries(GAS_CEILINGS)) {
    const n = Number(given[op]);
    ceil[op] = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), d) : d;
  }
  out.maxGasLimitByOp = ceil;
  out.routes = {};
  for (const sym of Object.keys(ROUTES)) {
    const r = b.routes && typeof b.routes === "object" ? b.routes[sym] : null;
    out.routes[sym] = !(r && typeof r === "object" && r.enabled === false);
  }
  const v = b.vault && typeof b.vault === "object" ? b.vault : {};
  out.vault = {
    tba: v.tba === undefined || v.tba === null || v.tba === "" ? null : String(v.tba),
    nft: v.nft ?? null, tokenId: v.tokenId ?? null, implementation: v.implementation ?? null, registry: v.registry ?? null, salt: v.salt ?? ethers.ZeroHash,
    expectedOwner: v.expectedOwner ?? null,
    splitPct: Number.isFinite(Number(v.splitPct)) ? Number(v.splitPct) : 0,
    maxSplitPct: Number.isFinite(Number(v.maxSplitPct)) ? Number(v.maxSplitPct) : 20,
  };
  return out;
}

/** The gas fields the sweep replaces in the baseCollect limits while it is active. */
function limitOverrides(sw) {
  return { maxGasPerTxEth: sw.maxGasPerTxEth, maxGasPerRunEth: sw.maxGasPerRunEth, dailyGasCapEth: sw.dailyGasCapEth };
}

/** The route of `token` when it exists and is enabled, else null. */
function routeFor(sw, token) {
  for (const [sym, r] of Object.entries(ROUTES)) if (eq(r.token, token) && sw.routes[sym] !== false) return r;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Swap maths and the per-token decision (D4)
// ---------------------------------------------------------------------------------------------------------------------

/** Fee-free mid output (raw USDC) for `amountIn` of `tokenIn`, from sqrtPriceX96. token0 is the lower address of the pair. */
function midOut({ sqrtPriceX96, amountIn, tokenIn, token0 }) {
  const s = BigInt(sqrtPriceX96), a = BigInt(amountIn);
  if (s <= 0n) return 0n;
  const q192 = 1n << 192n, p = s * s;
  return eq(tokenIn, token0) ? (a * p) / q192 : (a * q192) / p;
}
const afterFee = (mid, fee) => (BigInt(mid) * (1_000_000n - BigInt(fee))) / 1_000_000n;
/** (mid - quote) / mid in whole basis points, rounded up (conservative); 0 when the quote is at or above mid. */
function impactBps(midAfterFee, quote) {
  const m = BigInt(midAfterFee), q = BigInt(quote);
  if (m <= 0n || q >= m) return 0;
  const num = (m - q) * 10000n;
  return Number((num + m - 1n) / m);
}
const minOutOf = (quote, slippageBps) => (BigInt(quote) * BigInt(10000 - slippageBps)) / 10000n;
const usdcRaw = (units) => BigInt(Math.round(Number(units) * 10 ** USDC_DECIMALS));

/**
 * Every D4 check on facts already read from the chain. facts = { route, amountIn, quote, sqrtPriceX96, tick, liquidity,
 * poolUsdc, twapTick (null = observe failed) }. { swap:true, ...numbers } or { swap:false, reason, ...numbers }.
 */
function decideSwap(sw, f) {
  const no = (reason, extra = {}) => ({ swap: false, reason, ...extra });
  const quote = typeof f.quote === "bigint" ? f.quote : null;
  if (quote === null || quote <= 0n) return no("the quoter returned 0 (or nothing)");
  const sqrt = BigInt(f.sqrtPriceX96 ?? 0);
  const token0 = BigInt(f.route.token) < BigInt(USDC) ? f.route.token : USDC;
  const mid = midOut({ sqrtPriceX96: sqrt, amountIn: f.amountIn, tokenIn: f.route.token, token0 });
  const midAfter = afterFee(mid, f.route.fee);
  const impact = impactBps(midAfter, quote);
  const num = { quote, mid, midAfterFee: midAfter, impactBps: impact, valueRaw: quote };
  if (quote < usdcRaw(sw.minSwapValueUsdc)) return no(`leg value ${fmtUsdc(quote)} USDC is below minSwapValueUsdc ${sw.minSwapValueUsdc}`, num);
  if (quote > usdcRaw(sw.maxSwapValueUsdc)) return no(`leg value ${fmtUsdc(quote)} USDC is above maxSwapValueUsdc ${sw.maxSwapValueUsdc}`, num);
  if (sqrt === 0n) return no("pool sqrtPriceX96 is 0", num);
  if (BigInt(f.liquidity ?? 0) === 0n) return no("pool in-range liquidity is 0", num);
  const poolUsdc = BigInt(f.poolUsdc ?? 0);
  if (poolUsdc < usdcRaw(sw.minPoolUsdc)) return no(`pool holds ${fmtUsdc(poolUsdc)} USDC, below minPoolUsdc ${sw.minPoolUsdc}`, num);
  if (quote * 10000n > poolUsdc * BigInt(sw.maxPoolShareBps)) return no(`quote ${fmtUsdc(quote)} USDC exceeds maxPoolShareBps ${sw.maxPoolShareBps} of the pool's USDC`, num);
  if (midAfter <= 0n) return no("mid price is 0", num);
  if (quote * 1000n > midAfter * 1001n) return no("quote is above the mid price after fee by more than 0.1% (inflated or stale quoter)", num);
  if (impact > sw.maxPriceImpactBps) return no(`price impact ${impact} bps exceeds maxPriceImpactBps ${sw.maxPriceImpactBps}`, num);
  if (f.twapTick === null || f.twapTick === undefined || !Number.isFinite(Number(f.twapTick))) return no("no usable TWAP (observe failed): fail closed", num);
  const dev = Math.abs(Number(f.tick) - Number(f.twapTick));
  if (dev > sw.twapMaxDeviationBps) return no(`spot tick ${f.tick} differs from the ${sw.twapSeconds} s TWAP tick ${f.twapTick} by ${dev} > twapMaxDeviationBps ${sw.twapMaxDeviationBps}`, num);
  // L2: the floor is the lower of the quoter and the TWAP-priced output after fee, so a skewed quote cannot raise it.
  let ref = quote;
  try { const tw = afterFee(midOut({ sqrtPriceX96: u.getSqrtRatioAtTick(Math.round(Number(f.twapTick))), amountIn: f.amountIn, tokenIn: f.route.token, token0 }), f.route.fee); if (tw > 0n && tw < ref) ref = tw; } catch { /* the quote stands */ }
  const minOut = minOutOf(ref, sw.slippageBps);
  if (minOut <= 0n) return no("minOut would be 0", num);
  return { swap: true, ...num, minOut };
}
const fmtUsdc = (raw) => ethers.formatUnits(raw, USDC_DECIMALS);

/** The TWAP tick from observe() cumulatives [then, now] over `seconds` (rounds toward negative infinity, as the pool does). */
function twapTick(cumulatives, seconds) {
  const d = BigInt(cumulatives[1]) - BigInt(cumulatives[0]);
  const s = BigInt(seconds);
  let t = d / s;
  if (d < 0n && d % s !== 0n) t -= 1n;
  return Number(t);
}

// ---------------------------------------------------------------------------------------------------------------------
// Split (identical integer maths to treasury.split) and the vault percentage
// ---------------------------------------------------------------------------------------------------------------------

/** Integer split of a raw amount at pct percent; the same arithmetic as treasury.split (parity is tested). */
function split(amountRaw, pct) {
  const bp = BigInt(Math.round(pct * 100));
  const toVault = (BigInt(amountRaw) * bp) / 10000n;
  return { toVault, toOwner: BigInt(amountRaw) - toVault };
}
/** clamp(splitPct, 0, min(maxSplitPct, 20)); anything not a number is 0. */
function vaultPct(v) {
  const hi = Math.min(Number.isFinite(Number(v.maxSplitPct)) ? Number(v.maxSplitPct) : 20, 20);
  const p = Number(v.splitPct);
  return Number.isFinite(p) ? Math.max(0, Math.min(Math.max(0, hi), p)) : 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// The last look before signing a sweep transaction
// ---------------------------------------------------------------------------------------------------------------------

const ERC20_IFACE = new ethers.Interface(["function approve(address spender, uint256 amount) returns (bool)", "function transfer(address to, uint256 amount) returns (bool)"]);
const ROUTER_IFACE = new ethers.Interface(["function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)"]);

/** The calldata of each sweep op. */
const calldata = {
  approve: (spender, amount) => ERC20_IFACE.encodeFunctionData("approve", [spender, amount]),
  transfer: (to, amount) => ERC20_IFACE.encodeFunctionData("transfer", [to, amount]),
  swap: (p) => ROUTER_IFACE.encodeFunctionData("exactInputSingle", [{ tokenIn: p.tokenIn, tokenOut: p.tokenOut, fee: p.fee, recipient: p.recipient, amountIn: p.amountIn, amountOutMinimum: p.amountOutMinimum, sqrtPriceLimitX96: p.sqrtPriceLimitX96 }]),
};

/**
 * Throws unless `tx` is exactly the sweep transaction `op` described by `expect`:
 *   approve / approve-reset  { token, legTokens, amount }                       to = token of the active leg; approve(ROUTER, amount | 0)
 *   swap                     { params }  to = ROUTER; exactInputSingle == params, tokenOut USDC, recipient = operator, minOut > 0
 *   transfer                 { token, legTokens, amount, recipients, operator }  to = token of the leg; transfer(owner | vault, amount)
 * Common to all: type 2, chainId 8453, value 0, fee and tip within the caps, gas limit within the op's ceiling.
 */
function assertSignableSweep(tx, lim, op, expect) {
  const bad = (m) => { throw new Error(`refusing to sign: ${m}`); };
  if (!tx || typeof tx !== "object") bad("no transaction");
  if (!OPS.includes(op) || op === "collect") bad(`op ${op} is not a sweep op`);
  if (!expect || typeof expect !== "object") bad("no expectation to check against");
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0) bad(`nonce ${tx.nonce} is not a non-negative integer`);
  if (tx.type !== 2) bad(`type ${tx.type} is not 2`);
  if ("gasPrice" in tx) bad("a gasPrice field is present");
  if (tx.value !== 0n) bad("value is not 0");
  const ceiling = BigInt(lim.maxGasLimitByOp && lim.maxGasLimitByOp[op] ? lim.maxGasLimitByOp[op] : GAS_CEILINGS[op]);
  if (typeof tx.gasLimit !== "bigint" || tx.gasLimit <= 0n || tx.gasLimit > ceiling) bad(`gasLimit ${tx.gasLimit} exceeds the ${op} ceiling ${ceiling}`);
  const capWei = base.gweiToWei(lim.maxGasPriceGwei);
  if (typeof tx.maxFeePerGas !== "bigint" || tx.maxFeePerGas <= 0n || tx.maxFeePerGas > capWei) bad(`maxFeePerGas ${tx.maxFeePerGas} exceeds maxGasPriceGwei ${lim.maxGasPriceGwei}`);
  if (typeof tx.maxPriorityFeePerGas !== "bigint" || tx.maxPriorityFeePerGas <= 0n || tx.maxPriorityFeePerGas > tx.maxFeePerGas) bad("maxPriorityFeePerGas is not in (0, maxFeePerGas]");
  if (tx.maxPriorityFeePerGas > base.gweiToWei(lim.maxPriorityFeeGwei)) bad(`maxPriorityFeePerGas exceeds maxPriorityFeeGwei ${lim.maxPriorityFeeGwei}`);
  if (Number(tx.chainId) !== CHAIN_ID) bad(`chainId ${tx.chainId} is not ${CHAIN_ID}`);
  const exact = (iface, name) => {
    let d;
    try { d = iface.parseTransaction({ data: tx.data, value: 0n }); } catch { d = null; }
    if (!d || d.name !== name) bad(`calldata is not ${name}`);
    if (iface.encodeFunctionData(d.fragment, d.args).toLowerCase() !== String(tx.data).toLowerCase()) bad("calldata has extra or non-canonical bytes");
    return d.args;
  };
  const legTokens = Array.isArray(expect.legTokens) ? expect.legTokens : [];
  if (op === "swap") {
    if (!eq(tx.to, ROUTER)) bad(`to ${tx.to} is not the router ${ROUTER}`);
    const p = expect.params;
    if (!p) bad("no decided swap parameters");
    const a = exact(ROUTER_IFACE, "exactInputSingle")[0];
    if (!eq(a.tokenIn, p.tokenIn) || !Object.values(ROUTES).some((r) => eq(r.token, a.tokenIn) && Number(a.fee) === r.fee)) bad(`tokenIn/fee ${a.tokenIn}/${a.fee} is not an allowlisted route`);
    if (!eq(a.tokenOut, USDC)) bad(`tokenOut ${a.tokenOut} is not USDC`);
    if (!eq(a.recipient, p.recipient) || !eq(a.recipient, expect.operator)) bad(`swap recipient ${a.recipient} is not the operator`);
    if (BigInt(a.amountIn) !== BigInt(p.amountIn) || BigInt(a.amountIn) <= 0n) bad("amountIn is not the decided amount");
    if (BigInt(a.amountOutMinimum) !== BigInt(p.amountOutMinimum) || BigInt(a.amountOutMinimum) <= 0n) bad("amountOutMinimum is not the decided minOut");
    if (BigInt(a.sqrtPriceLimitX96) !== 0n) bad("sqrtPriceLimitX96 is not 0");
    return;
  }
  if (!tx.to || !legTokens.some((t) => eq(t, tx.to)) || !eq(tx.to, expect.token)) bad(`to ${tx.to} is not a token of the active leg`);
  const routeToken = Object.values(ROUTES).some((r) => eq(r.token, tx.to));
  if (op === "approve" || op === "approve-reset") {
    if (op === "approve" && !routeToken) bad(`approve target ${tx.to} is not a swap-route token`);
    if (op === "approve-reset" && !routeToken && !eq(tx.to, USDC)) bad(`approve-reset target ${tx.to} is not a route token or USDC`);
    const [spender, amount] = exact(ERC20_IFACE, "approve");
    if (!eq(spender, ROUTER)) bad(`approve spender ${spender} is not the router`);
    const want = op === "approve-reset" ? 0n : BigInt(expect.amount);
    if (BigInt(amount) === MAX_UINT256) bad("approve of the maximum amount");
    if (BigInt(amount) !== want) bad(`approve amount ${amount} is not ${want}`);
    if (op === "approve" && want <= 0n) bad("approve of 0 is a reset");
    return;
  }
  // transfer: the target is already pinned above (tx.to is in legTokens AND equals expect.token), which is stricter than any
  // "route token / USDC / leg token" test; a second check here could only be weaker or equal, so it was removed as dead code.
  const [to, amount] = exact(ERC20_IFACE, "transfer");
  if (!(expect.recipients || []).some((r) => eq(r, to)) || eq(to, expect.operator)) bad(`transfer recipient ${to} is not a verified owner or vault`);
  if (BigInt(amount) !== BigInt(expect.amount) || BigInt(amount) <= 0n) bad(`transfer amount ${amount} is not the attributed ${expect.amount}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Caps over every transaction (D6)
// ---------------------------------------------------------------------------------------------------------------------

/** Transactions recorded with an `op` in the trailing 24 h (unsettled ones always count). */
function opCount24h(state, nowMs) {
  const cutoff = nowMs - 24 * 3600 * 1000;
  return (state.gasSpends || []).filter((e) => e && e.op && (e.kind === "unknown" || e.kind === "reserved" || e.t > cutoff)).length;
}
/** maxTxPerRun, dailyTxCap, then the per-tx / per-run / 24 h gas caps of the ordinary capCheck (collects are not counted here). */
function txCapCheck({ lim, sw, worstCaseWei, txCount, dayTxCount, spentRunWei, spent24hWei }) {
  if (txCount >= sw.maxTxPerRun) return { ok: false, cap: "maxTxPerRun", reason: `maxTxPerRun ${sw.maxTxPerRun} reached` };
  if (dayTxCount >= sw.dailyTxCap) return { ok: false, cap: "dailyTxCap", reason: `dailyTxCap ${sw.dailyTxCap} reached (${dayTxCount} in 24 h)` };
  return base.capCheck({ lim, worstCaseWei, sentCount: 0, spentRunWei, spent24hWei });
}

// ---------------------------------------------------------------------------------------------------------------------
// The ledger: sweep-state.json (D9). Fails closed, written atomically with the same writer as state.json.
// ---------------------------------------------------------------------------------------------------------------------

const DEC = /^\d{1,60}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const TOKEN_ID = /^(0|[1-9]\d{0,59})$/;
/** A leg keeps at most this many transfer hashes (the validator's bound). payOut holds the leg before it could exceed it; nothing is ever dropped. */
const MAX_TRANSFERS_PER_LEG = 100;
const isAddr = (a) => typeof a === "string" && ethers.isAddress(a);

/** The first problem of a pending intent / leg / job, or null. */
function pendingProblem(p) {
  if (p === null || p === undefined) return null;
  if (typeof p !== "object") return "pending is not an object";
  if (!OPS.includes(p.op)) return "pending.op is not a known op";
  if (p.tx !== null && p.tx !== undefined && !(typeof p.tx === "string" && HASH.test(p.tx))) return "pending.tx is not a hash";
  if (!(Number.isSafeInteger(p.nonce) && p.nonce >= 0)) return "pending.nonce is not a non-negative integer";
  for (const k of ["raw", "to"]) if (p[k] !== undefined && p[k] !== null && !(k === "raw" ? DEC.test(String(p[k])) : isAddr(p[k]))) return `pending.${k} is malformed`;
  return null;
}
function legProblem(l) {
  if (!l || typeof l !== "object") return "leg is not an object";
  if (!isAddr(l.token)) return "token is not an address";
  if (!PHASES.includes(l.phase)) return "phase is unknown";
  for (const k of ["owedRaw", "doneRaw"]) if (!(typeof l[k] === "string" && DEC.test(l[k]))) return `${k} is not a decimal string`;
  if (!(Number.isSafeInteger(l.attempts) && l.attempts >= 0)) return "attempts is not a non-negative integer";
  if (BigInt(l.doneRaw) > BigInt(l.owedRaw)) return "doneRaw exceeds owedRaw";
  if (l.swap && l.swap.outRaw !== undefined && l.swap.outRaw !== null && !DEC.test(String(l.swap.outRaw))) return "swap.outRaw is malformed";
  if (l.swap && l.swap.tx !== undefined && l.swap.tx !== null && !(typeof l.swap.tx === "string" && HASH.test(l.swap.tx))) return "swap.tx is not a hash";
  // swap.txs (every swap hash of the leg) is optional: ledgers written before it existed carry only the single swap.tx.
  if (l.swap && l.swap.txs !== undefined && !(Array.isArray(l.swap.txs) && l.swap.txs.every((h) => typeof h === "string" && HASH.test(h)) && new Set(l.swap.txs.map((h) => h.toLowerCase())).size === l.swap.txs.length)) return "swap.txs is not a list of distinct hashes";
  if (l.outDone !== undefined && !(typeof l.outDone === "string" && DEC.test(l.outDone))) return "outDone is not a decimal string";
  // transferTxs (every transfer hash of the leg, kept so a retired job's transfers can be refused as proof later) is optional for older ledgers.
  if (l.transferTxs !== undefined && !(Array.isArray(l.transferTxs) && l.transferTxs.length <= MAX_TRANSFERS_PER_LEG && l.transferTxs.every((h) => typeof h === "string" && HASH.test(h)) && new Set(l.transferTxs.map((h) => h.toLowerCase())).size === l.transferTxs.length)) return "transferTxs is not a list of distinct hashes";
  return pendingProblem(l.pending);
}
function jobProblem(j) {
  if (!j || typeof j !== "object") return "job is not an object";
  if (typeof j.id !== "string" || !j.id) return "id is missing";
  // canonical decimal only ("007" would make a second spelling of position 7 and dodge the per-position high-water)
  if (!(typeof j.tokenId === "string" && TOKEN_ID.test(j.tokenId))) return "tokenId is not a canonical decimal string";
  if (!isAddr(j.manager) || !base.ALLOWED_MANAGERS.some((m) => eq(m, j.manager))) return "manager is not an allowlisted manager";
  if (!isAddr(j.owner)) return "owner is not an address";
  if (!Array.isArray(j.legs)) return "legs is not an array";
  if (!isAddr(j.token0)) return "token0 is not an address";
  if (!isAddr(j.token1)) return "token1 is not an address";
  if (eq(j.token0, j.token1)) return "token0 equals token1";
  // priceUsd (per-side USD price at plan time) is optional: absent, or a pair of null / finite non-negative numbers.
  if (j.priceUsd !== undefined && j.priceUsd !== null && !(Array.isArray(j.priceUsd) && j.priceUsd.length === 2 && j.priceUsd.every((x) => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0)))) return "priceUsd is not a pair of null or finite non-negative numbers";
  // tokenDecimals (pinned at job creation) is optional for older ledgers: absent, or a pair of null / integers 0..36.
  if (j.tokenDecimals !== undefined && j.tokenDecimals !== null && !(Array.isArray(j.tokenDecimals) && j.tokenDecimals.length === 2 && j.tokenDecimals.every((x) => x === null || (Number.isInteger(x) && x >= 0 && x <= 36)))) return "tokenDecimals is not a pair of null or integers 0..36";
  if (!j.collect || typeof j.collect !== "object" || !["intent", "mined", "voided", "reverted", "unattributed"].includes(j.collect.status)) return "collect.status is unknown";
  if (j.collect.block !== undefined && !(Number.isSafeInteger(j.collect.block) && j.collect.block > 0)) return "collect.block is not a positive integer";
  if (j.maxBlock !== undefined && !(Number.isSafeInteger(j.maxBlock) && j.maxBlock > 0)) return "maxBlock is not a positive integer";
  if (!(typeof j.createdAt === "number" && Number.isFinite(j.createdAt))) return "createdAt is not a timestamp";
  // finishedAt (set when the job turns terminal) decides pruning: absent, or a positive finite timestamp not in the future (Low-2).
  if (j.finishedAt !== undefined && !(typeof j.finishedAt === "number" && Number.isFinite(j.finishedAt) && j.finishedAt > 0 && j.finishedAt <= Date.now() + FINISHED_SKEW_MS)) return "finishedAt is not a past timestamp";
  const p = pendingProblem(j.pending);
  if (p) return p;
  for (const [i, l] of j.legs.entries()) {
    const m = legProblem(l); if (m) return `legs[${i}].${m}`;
    if (!eq(l.token, j.token0) && !eq(l.token, j.token1)) return `legs[${i}].token ${l.token} is not token0 or token1 of the position`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The retired list: receipts of pruned or finished jobs can never again back a credit (security L-1 of 08afeee)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * ledger.retired = { hashes:[{hash, block}], floor, collectBlock:{ "<manager>:<tokenId>": block } }, persisted in sweep-state.json.
 *  - hashes: the collect, swap and transfer hashes of every job pruned from the ledger (terminal and older than KEEP_TERMINAL_MS), oldest
 *    first. `block` is the highest block the job is known to have a receipt in (job.maxBlock, else its collect block, else 0).
 *  - collectBlock: per position (manager:tokenId, lowercase) the highest collect block of any retired job. NEVER pruned and never lowered
 *    (one small integer per position ever swept, capped at MAX_RETIRED_POSITIONS).
 *  - floor: the highest `block` of any hash evicted from `hashes`. No receipt at or below it is accepted as proof any more.
 * BOUND AND POLICY. MAX_RETIRED_HASHES = 2000 (about 200 KB of JSON). A job leaves 1 collect + about 2 swap/transfer hashes per leg, so
 * this is several hundred jobs, far more than the 30-day KEEP_TERMINAL_MS window can produce at dailyTxCap (hard max 100/day), so
 * eviction only ever drops hashes that have been retired for months. Eviction is FIFO among KNOWN-block entries (block > 0): an evicted
 * hash is NOT forgotten, its job's block raises `floor`, and the replay rules refuse every receipt with blockNumber <= floor, so a pruned
 * list entry cannot re-open replay for any receipt it covered (a receipt of a job cannot be above that job's own highest block).
 * An entry whose block is UNKNOWN (0: a legacy job with no maxBlock, or one with receipts beyond a known collect block) can never be
 * covered by the floor, so it is NEVER evicted. If only such entries remain over the bound, serializeSweepState throws and save() stops
 * the run (fail closed); an operator must resolve it. For the same position, the strictly-newer-collect rule against collectBlock (never
 * pruned) covers a replayed collect too. The price of the floor is fail-closed: a job still open after 2000 later hashes whose receipts
 * sit at or below `floor` is held, not credited.
 */
const MAX_RETIRED_HASHES = 2000;
const MAX_RETIRED_POSITIONS = 10000;
const POS_KEY = /^0x[0-9a-f]{40}:\d{1,60}$/;
const emptyRetired = () => ({ hashes: [], floor: 0, collectBlock: {} });
/** manager:tokenId, lowercase, tokenId normalized ("007" and "7" are the same position). */
const posKey = (manager, tokenId) => { let id = String(tokenId); try { id = BigInt(id).toString(); } catch { /* not a number: the raw text, which no real position has */ } return `${manager}:${id}`.toLowerCase(); };

/** The first problem of a retired block, or null. `r` undefined (older ledger) is fine and means empty. */
function retiredProblem(r) {
  if (r === undefined) return null;
  if (!r || typeof r !== "object" || Array.isArray(r)) return "retired is not an object";
  if (!Array.isArray(r.hashes)) return "retired.hashes is not an array";
  if (r.hashes.length > MAX_RETIRED_HASHES) return `retired.hashes has ${r.hashes.length} entries, over the bound ${MAX_RETIRED_HASHES}`;
  if (!(Number.isSafeInteger(r.floor) && r.floor >= 0)) return "retired.floor is not a non-negative integer";
  const seen = new Set();
  for (const [i, e] of r.hashes.entries()) {
    if (!e || typeof e !== "object" || Array.isArray(e)) return `retired.hashes[${i}] is not an object`;
    if (!(typeof e.hash === "string" && HASH.test(e.hash))) return `retired.hashes[${i}].hash is not a hash`;
    if (!(Number.isSafeInteger(e.block) && e.block >= 0)) return `retired.hashes[${i}].block is not a non-negative integer`;
    const h = e.hash.toLowerCase();
    if (seen.has(h)) return `retired.hashes[${i}] duplicates an earlier retired hash`;
    seen.add(h);
  }
  const cb = r.collectBlock;
  if (!cb || typeof cb !== "object" || Array.isArray(cb)) return "retired.collectBlock is not an object";
  const keys = Object.keys(cb);
  if (keys.length > MAX_RETIRED_POSITIONS) return `retired.collectBlock has ${keys.length} positions, over the bound ${MAX_RETIRED_POSITIONS}`;
  for (const k of keys) {
    if (!POS_KEY.test(k)) return `retired.collectBlock key ${k.slice(0, 80)} is not manager:tokenId`;
    if (!(Number.isSafeInteger(cb[k]) && cb[k] > 0)) return `retired.collectBlock[${k}] is not a positive integer`;
  }
  return null;
}
/**
 * Security M-1: every block number the ledger carries must exist. A tampered floor / collect block / maxBlock far above the chain head
 * would refuse every legitimate receipt (holding all jobs) while the sweep keeps collecting. First problem text, or null.
 */
function ledgerAheadProblem(ledger, head, slack = HEAD_SLACK_BLOCKS) {
  const h = Number(head);
  if (!Number.isSafeInteger(h) || h <= 0) return `the chain head ${String(head)} is not usable`;
  const r = ledger.retired;
  const over = (what, v) => (Number.isFinite(Number(v)) && Number(v) > h + slack ? `${what} ${v} is above the chain head ${h} (slack ${slack})` : null);
  let m = r && over("retired.floor", r.floor); if (m) return m;
  for (const [k, v] of Object.entries((r && r.collectBlock) || {})) { m = over(`retired.collectBlock[${k}]`, v); if (m) return m; }
  for (const [i, e] of ((r && r.hashes) || []).entries()) { m = over(`retired.hashes[${i}].block`, e.block); if (m) return m; }
  for (const [i, j] of (ledger.jobs || []).entries()) {
    m = over(`jobs[${i}].collect.block`, j.collect && j.collect.block) || over(`jobs[${i}].maxBlock`, j.maxBlock);
    if (m) return m;
  }
  return null;
}

/**
 * Security M-2 (independent of the ledger file): pruning only happens KEEP_TERMINAL_MS after a job finishes, so every pruned job's collect
 * is at least KEEP_TERMINAL_MS old. Base makes a block every 2 s: 30 days = 1,296,000 blocks. A collect is accepted only if it is younger than
 * that minus a 10% safety margin (129,600 blocks, about 3 days, which covers block times up to about 2.2 s): the accepted window
 * (about 27 days) then lies strictly inside the 30 days, so no pruned job's collect can ever pass, even if the whole retired block was
 * deleted from the file. A legitimately long-open job (a collect older than that) is refused: unattributed, needs operator resolution.
 */
const BASE_BLOCK_MS = 2000;
const KEEP_TERMINAL_BLOCKS = Math.ceil(KEEP_TERMINAL_MS / BASE_BLOCK_MS);
const COLLECT_MAX_AGE_BLOCKS = Math.ceil(KEEP_TERMINAL_MS / BASE_BLOCK_MS) - Math.ceil(Math.ceil(KEEP_TERMINAL_MS / BASE_BLOCK_MS) * 0.1);
/** Days of collect age from which a warning is logged and sent (the hold comes at about day 27). */
const COLLECT_WARN_BLOCKS = 20 * 86400 * 1000 / BASE_BLOCK_MS;
function collectAgeWarning(head, blockNumber) {
  const h = Number(head), b = Number(blockNumber);
  if (!Number.isSafeInteger(h) || h <= 0 || !Number.isSafeInteger(b)) return null;
  if (b < h - COLLECT_MAX_AGE_BLOCKS) return null; // already held by collectAgeProblem
  if (b < h - COLLECT_WARN_BLOCKS) return `collect block ${b} is about ${Math.floor((h - b) * BASE_BLOCK_MS / 86400000)} days old; at about day 27 the leg is held (never swept) until an operator resolves it`;
  return null;
}
function collectAgeProblem(head, blockNumber) {
  const h = Number(head), b = Number(blockNumber);
  if (!Number.isSafeInteger(h) || h <= 0) return `the chain head ${String(head)} is not usable`;
  if (b < h - COLLECT_MAX_AGE_BLOCKS) return `collect is in block ${b}, more than ${COLLECT_MAX_AGE_BLOCKS} blocks (about 27 days) before the head ${h}; it is as old as a job that may already have been pruned, so it cannot be told from a replayed receipt; the leg is held and reported (not unattributed, other collects go on) until an operator resolves it`;
  return null;
}

/** A normalized copy (hashes lowercased), or the empty retired block when `r` is absent. Call only after retiredProblem(r) === null. */
function normRetired(r) {
  if (!r) return emptyRetired();
  return { hashes: r.hashes.map((e) => ({ hash: e.hash.toLowerCase(), block: e.block })), floor: r.floor, collectBlock: { ...r.collectBlock } };
}
const retiredHas = (retired, hash) => typeof hash === "string" && !!retired && retired.hashes.some((e) => e.hash === hash.toLowerCase());

/** Every collect, swap (incl. pending swap) and transfer hash on a job, lowercase and distinct. */
function jobHashes(job) {
  const out = new Set();
  const add = (h) => { if (typeof h === "string" && HASH.test(h)) out.add(h.toLowerCase()); };
  add(job.collect && job.collect.tx);
  add(job.pending && job.pending.tx);
  for (const l of job.legs || []) {
    if (l.swap) { add(l.swap.tx); for (const h of Array.isArray(l.swap.txs) ? l.swap.txs : []) add(h); }
    for (const h of Array.isArray(l.transferTxs) ? l.transferTxs : []) add(h);
    add(l.deliver && l.deliver.tx); add(l.vault && l.vault.tx); add(l.pending && l.pending.tx);
  }
  return [...out];
}
/**
 * The highest block a job is known to have receipts in, or 0 when that is unknown. Known: job.maxBlock; or, for a job whose only hash is
 * its collect (reverted collect), the collect block. A legacy job with other hashes and no maxBlock is UNKNOWN (0): its swap/transfer
 * receipts may sit above its collect block, so its hashes must never be evicted into the floor.
 */
function jobEndBlock(job) {
  const cb = Number.isSafeInteger(job.collect && job.collect.block) ? job.collect.block : 0;
  if (Number.isSafeInteger(job.maxBlock) && job.maxBlock > 0) return Math.max(job.maxBlock, cb);
  const hs = jobHashes(job);
  const onlyCollect = hs.length === 0 || (hs.length === 1 && typeof job.collect.tx === "string" && hs[0] === job.collect.tx.toLowerCase());
  return onlyCollect ? cb : 0;
}

/**
 * Why a receipt at `blockNumber` with `hash` cannot back a credit for a job whose verified collect is at `collectBlock`, or null.
 * Rules: not on the retired list; a real block number; at or above the job's own collect block; above the eviction floor.
 */
function receiptReplayProblem(retired, hash, blockNumber, collectBlock) {
  if (retiredHas(retired, hash)) return `${hash} belongs to a retired job; a retired receipt is never proof for a new credit`;
  const b = Number(blockNumber);
  if (!Number.isSafeInteger(b) || b <= 0) return `${hash} has no usable block number`;
  if (Number.isSafeInteger(collectBlock) && b < collectBlock) return `${hash} is in block ${b}, before the job's collect in block ${collectBlock}; it cannot belong to this job`;
  if (retired && b <= retired.floor) return `${hash} is in block ${b}, at or below the retired floor ${retired.floor}; it is too old to back a credit`;
  return null;
}
/** Why a collect in `blockNumber` for this position cannot be a new job's collect, or null: retired hash, or not strictly newer than a retired collect of the same position. */
function collectReplayProblem(retired, hash, blockNumber, manager, tokenId) {
  if (retiredHas(retired, hash)) return `collect ${hash} belongs to a retired job; refusing`;
  const b = Number(blockNumber);
  if (!Number.isSafeInteger(b) || b <= 0) return `collect ${hash} has no usable block number`;
  const hi = retired && retired.collectBlock[posKey(manager, tokenId)];
  if (Number.isSafeInteger(hi) && b <= hi) return `collect ${hash} is in block ${b}, not newer than the retired collect of this position in block ${hi}; refusing`;
  if (retired && b <= retired.floor) return `collect ${hash} is in block ${b}, at or below the retired floor ${retired.floor}; refusing`;
  return null;
}

/** { ok:true, ledger:{jobs} } | { ok:false, kind:"missing"|"corrupt", reason, file }. Never touches the file. */
function readSweepState(file, fsm = fs) {
  let text;
  try { text = fsm.readFileSync(file, "utf8"); } catch (err) {
    if (err && err.code === "ENOENT") return { ok: false, kind: "missing", reason: "file does not exist", file };
    return { ok: false, kind: "corrupt", reason: `cannot be read: ${(err && (err.code || err.message)) || err}`, file };
  }
  const corrupt = (reason) => ({ ok: false, kind: "corrupt", reason, file });
  let j;
  try { j = JSON.parse(text); } catch (err) { return corrupt(`not valid JSON (${String(err.message).slice(0, 80)})`); }
  if (!j || typeof j !== "object" || Array.isArray(j)) return corrupt("not a JSON object");
  if (j.version !== SWEEP_STATE_VERSION) return corrupt(`unknown version ${JSON.stringify(j.version)}`);
  if (!Array.isArray(j.jobs)) return corrupt("jobs is not an array");
  const rp = retiredProblem(j.retired); if (rp) return corrupt(rp);
  const retired = normRetired(j.retired);
  const collectTxs = new Set();
  const jobIds = new Set();
  const swapHashes = new Set(); // every leg's swap.tx and swap.txs across ALL jobs: one swap receipt may back exactly one leg
  for (const [i, job] of j.jobs.entries()) {
    const m = jobProblem(job); if (m) return corrupt(`jobs[${i}].${m}`);
    // One collect transaction belongs to exactly one job: a duplicate would let one Collect receipt vouch for two jobs' amounts.
    if (jobIds.has(job.id)) return corrupt(`jobs[${i}].id duplicates an earlier job`);
    jobIds.add(job.id);
    const tx = typeof job.collect.tx === "string" ? job.collect.tx.toLowerCase() : null;
    if (tx) { if (collectTxs.has(tx)) return corrupt(`jobs[${i}].collect.tx ${job.collect.tx} duplicates the collect of an earlier job`); collectTxs.add(tx); }
    const seen = new Set();
    for (const [k, l] of job.legs.entries()) { const t = l.token.toLowerCase(); if (seen.has(t)) return corrupt(`jobs[${i}].legs[${k}].token ${l.token} duplicates an earlier leg of the same job`); seen.add(t); }
  }
  for (const [i, job] of j.jobs.entries()) {
    for (const [k, l] of job.legs.entries()) {
      // every swap hash of the leg, including a pending op:"swap" hash (it becomes a recorded swap hash once resolved)
      const pend = l.pending && l.pending.op === "swap" && typeof l.pending.tx === "string" ? [l.pending.tx] : [];
      const own = new Set([...(l.swap && Array.isArray(l.swap.txs) ? l.swap.txs : []), ...(l.swap && l.swap.tx ? [l.swap.tx] : []), ...pend].map((h) => h.toLowerCase()));
      for (const h of own) {
        if (collectTxs.has(h)) return corrupt(`jobs[${i}].legs[${k}] swap hash ${h} equals a collect transaction`);
        if (swapHashes.has(h)) return corrupt(`jobs[${i}].legs[${k}] swap hash ${h} is already recorded for another leg`);
        swapHashes.add(h);
      }
    }
  }
  // Security L-3: one transfer receipt may back exactly one leg (deliver.tx, vault.tx, transferTxs, pending transfer); transfer against transfer here, the recovery path also checks collect and swap hashes.
  const transferHashes = new Set();
  for (const [i, job] of j.jobs.entries()) {
    for (const [k, l] of job.legs.entries()) {
      const own = new Set([l.deliver && l.deliver.tx, l.vault && l.vault.tx, ...(Array.isArray(l.transferTxs) ? l.transferTxs : []), ...(l.pending && l.pending.op === "transfer" ? [l.pending.tx] : [])].filter((h) => typeof h === "string" && HASH.test(h)).map((h) => h.toLowerCase()));
      for (const h of own) {
        if (transferHashes.has(h)) return corrupt(`jobs[${i}].legs[${k}] transfer hash ${h} is already recorded for another leg`);
        transferHashes.add(h);
      }
    }
  }
  // A live job never owns a retired hash: that is a pruned job's receipt pointed at a live leg (replay), so the ledger is corrupt.
  for (const [i, job] of j.jobs.entries()) {
    const hit = jobHashes(job).find((h) => retiredHas(retired, h));
    if (hit) return corrupt(`jobs[${i}] uses ${hit}, a hash retired with a pruned job`);
  }
  return { ok: true, ledger: { jobs: j.jobs, retired } };
}

const legTerminal = (l) => TERMINAL_PHASES.includes(l.phase);
/** A job is finished when it never produced a collect, or every leg is delivered. */
function jobTerminal(job) {
  if (job.collect.status === "voided" || job.collect.status === "reverted") return true;
  return job.collect.status === "mined" && !job.pending && job.legs.every(legTerminal);
}
/**
 * Text of the ledger: version 1, terminal jobs older than 30 days dropped. A dropped job is RETIRED: its hashes join retired.hashes, its
 * collect block raises retired.collectBlock for its position, and the list is cut to MAX_RETIRED_HASHES (oldest first, raising retired.floor).
 * Pure and idempotent: it starts from ledger.retired as loaded, so saving the same in-memory ledger twice gives the same text.
 */
function serializeSweepState(ledger, nowMs = Date.now(), head = null) {
  const all = ledger.jobs || [];
  // Low-2: pruning needs the clock AND the chain to agree. Without a known head nothing is pruned (fail closed); a job whose end block is
  // unknown (nothing mined to replay) is judged by the clock alone.
  const h = Number(head);
  const chainOld = (j) => { if (!Number.isSafeInteger(h) || h <= 0) return false; const b = jobEndBlock(j); return b > 0 ? h - b >= KEEP_TERMINAL_BLOCKS : true; };
  const keep = (j) => !jobTerminal(j) || (j.finishedAt ?? j.createdAt) > nowMs - KEEP_TERMINAL_MS || !chainOld(j);
  const jobs = all.filter(keep);
  const r = normRetired(ledger.retired);
  const known = new Set(r.hashes.map((e) => e.hash));
  const pruned = all.filter((j) => !keep(j)).sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
  for (const j of pruned) {
    const block = jobEndBlock(j);
    for (const h of jobHashes(j)) if (!known.has(h)) { known.add(h); r.hashes.push({ hash: h, block }); }
    const cb = j.collect && j.collect.block;
    if (Number.isSafeInteger(cb) && cb > 0) { const k = posKey(j.manager, j.tokenId); r.collectBlock[k] = Math.max(r.collectBlock[k] || 0, cb); }
  }
  // Evict oldest KNOWN-block entries only (their block raises the floor). An unknown-block entry is never dropped: fail closed instead.
  while (r.hashes.length > MAX_RETIRED_HASHES) {
    const at = r.hashes.findIndex((e) => e.block > 0);
    if (at < 0) throw new Error(`retired.hashes holds ${r.hashes.length} entries with no known block, over the bound ${MAX_RETIRED_HASHES}; they cannot be evicted safely (an operator must resolve the legacy jobs)`);
    const [e] = r.hashes.splice(at, 1); r.floor = Math.max(r.floor, e.block);
  }
  if (Object.keys(r.collectBlock).length > MAX_RETIRED_POSITIONS) throw new Error(`retired.collectBlock would hold ${Object.keys(r.collectBlock).length} positions, over the bound ${MAX_RETIRED_POSITIONS}`);
  const bad = retiredProblem(r); if (bad) throw new Error(`the retired block would not read back: ${bad}`); // never write a file the reader rejects
  const empty = !r.hashes.length && r.floor === 0 && !Object.keys(r.collectBlock).length; // an empty list is omitted: the file stays as it was before the list existed
  return JSON.stringify(empty ? { version: SWEEP_STATE_VERSION, jobs } : { version: SWEEP_STATE_VERSION, jobs, retired: r }, null, 2) + "\n";
}
/** Creates an empty ledger only if none exists. "created" | "exists". */
function initSweepStateFile(file, fsm = fs) {
  const text = serializeSweepState({ jobs: [] });
  const tmp = `${file}.${process.pid}.init.tmp`;
  try {
    fsm.writeFileSync(tmp, text, { mode: 0o600 });
    try { fsm.linkSync(tmp, file); return "created"; } catch (err) {
      if (err && err.code === "EEXIST") return "exists";
      try { fsm.writeFileSync(file, text, { mode: 0o600, flag: "wx" }); return "created"; } catch (e2) {
        if (e2 && e2.code === "EEXIST") return "exists";
        throw e2;
      }
    }
  } finally { try { fsm.rmSync(tmp, { force: true }); } catch { /* nothing to remove */ } }
}

module.exports = {
  CHAIN_ID, ERC6551_REGISTRY, VAULT_IMPLEMENTATIONS, USDC, USDC_DECIMALS, ROUTER, QUOTER, FACTORY, ROUTES, OPS, PHASES, TERMINAL_PHASES, GAS_CEILINGS, NUMBERS, SWEEP_STATE_VERSION, MAX_UINT256, ERC20_IFACE, ROUTER_IFACE,
  config, limitOverrides, routeFor, midOut, afterFee, impactBps, minOutOf, usdcRaw, fmtUsdc, decideSwap, twapTick, split, vaultPct, calldata, assertSignableSweep,
  MAX_RETIRED_HASHES, MAX_RETIRED_POSITIONS, MAX_TRANSFERS_PER_LEG, COLLECT_MAX_AGE_BLOCKS, COLLECT_WARN_BLOCKS, KEEP_TERMINAL_BLOCKS, HEAD_SLACK_BLOCKS, FINISHED_SKEW_MS, ledgerAheadProblem, collectAgeProblem, collectAgeWarning, emptyRetired, posKey, retiredHas, jobHashes, receiptReplayProblem, collectReplayProblem,
  opCount24h, txCapCheck, readSweepState, serializeSweepState, initSweepStateFile, jobTerminal, legTerminal, jobProblem, eq, addr,
};
