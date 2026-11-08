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
  return pendingProblem(l.pending);
}
function jobProblem(j) {
  if (!j || typeof j !== "object") return "job is not an object";
  if (typeof j.id !== "string" || !j.id) return "id is missing";
  if (!(typeof j.tokenId === "string" && DEC.test(j.tokenId))) return "tokenId is not a decimal string";
  if (!isAddr(j.manager) || !base.ALLOWED_MANAGERS.some((m) => eq(m, j.manager))) return "manager is not an allowlisted manager";
  if (!isAddr(j.owner)) return "owner is not an address";
  if (!Array.isArray(j.legs)) return "legs is not an array";
  if (!j.collect || typeof j.collect !== "object" || !["intent", "mined", "voided", "reverted", "unattributed"].includes(j.collect.status)) return "collect.status is unknown";
  if (!(typeof j.createdAt === "number" && Number.isFinite(j.createdAt))) return "createdAt is not a timestamp";
  const p = pendingProblem(j.pending);
  if (p) return p;
  for (const [i, l] of j.legs.entries()) { const m = legProblem(l); if (m) return `legs[${i}].${m}`; }
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
  const collectTxs = new Set();
  for (const [i, job] of j.jobs.entries()) {
    const m = jobProblem(job); if (m) return corrupt(`jobs[${i}].${m}`);
    // One collect transaction belongs to exactly one job: a duplicate would let one Collect receipt vouch for two jobs' amounts.
    const tx = typeof job.collect.tx === "string" ? job.collect.tx.toLowerCase() : null;
    if (tx) { if (collectTxs.has(tx)) return corrupt(`jobs[${i}].collect.tx ${job.collect.tx} duplicates the collect of an earlier job`); collectTxs.add(tx); }
    const seen = new Set();
    for (const [k, l] of job.legs.entries()) { const t = l.token.toLowerCase(); if (seen.has(t)) return corrupt(`jobs[${i}].legs[${k}].token ${l.token} duplicates an earlier leg of the same job`); seen.add(t); }
  }
  return { ok: true, ledger: { jobs: j.jobs } };
}

const legTerminal = (l) => TERMINAL_PHASES.includes(l.phase);
/** A job is finished when it never produced a collect, or every leg is delivered. */
function jobTerminal(job) {
  if (job.collect.status === "voided" || job.collect.status === "reverted") return true;
  return job.collect.status === "mined" && !job.pending && job.legs.every(legTerminal);
}
/** Text of the ledger: version 1, terminal jobs older than 30 days dropped. */
function serializeSweepState(ledger, nowMs = Date.now()) {
  const jobs = (ledger.jobs || []).filter((j) => !jobTerminal(j) || (j.finishedAt ?? j.createdAt) > nowMs - KEEP_TERMINAL_MS);
  return JSON.stringify({ version: SWEEP_STATE_VERSION, jobs }, null, 2) + "\n";
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
  opCount24h, txCapCheck, readSweepState, serializeSweepState, initSweepStateFile, jobTerminal, legTerminal, jobProblem, eq, addr,
};
