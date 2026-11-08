/**
 * collector-base-sweep.js -- the Base sweep: the fees were collected to the OPERATOR; swap every non-USDC token to native Base USDC
 * through the allowlisted Uniswap v3 SwapRouter02 / QuoterV2 single-hop pools, and deliver to the NFT's on-chain owner.
 *
 * Orchestration only. Every side effect is injected (as collector-swap.js does): the provider for reads, `send` for every
 * transaction (collector-base.js sendTracked: assert, sign, ledger intent, gas reservation, broadcast, receipt), the ledger IO,
 * the clock, the log and the notifier. A test therefore proves what was NOT attempted.
 *
 * The only amounts it may move are those recorded in sweep-state.json for a job (collector-base-sweep-logic.js, D3/D9).
 * Nothing here reads a key file, builds a signing object or touches native ETH.
 */
"use strict";
const { ethers } = require("ethers");
const S = require("./collector-base-sweep-logic");
const base = require("./collector-base-logic");

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function decimals() view returns (uint8)"];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
// slot0 declares only the two leading words: a pool may return more (feeProtocol, unlocked) and ethers ignores the tail.
const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)", "function liquidity() view returns (uint128)", "function fee() view returns (uint24)", "function factory() view returns (address)",
  "function token0() view returns (address)", "function token1() view returns (address)", "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
];
const QUOTER_ABI = ["function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)"];
const MGR_ABI = ["function ownerOf(uint256) view returns (address)", "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1)"];
const REGISTRY_ABI = ["function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId) view returns (address)"];
const TBA_ABI = ["function token() view returns (uint256, address, uint256)", "function owner() view returns (address)"];
const NFT_ABI = ["function ownerOf(uint256) view returns (address)"];
const COLLECT_TOPICS = [ethers.id("Collect(uint256,address,uint256,uint256)")];
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const COLLECT_ID = ethers.AbiCoder.defaultAbiCoder();

const short = (err) => String((err && (err.shortMessage || err.message)) || err).split("\n")[0].slice(0, 160);
const eq = S.eq;
const minB = (a, b) => (a < b ? a : b);
const ZERO = ethers.ZeroAddress;

const symbolOf = (token) => {
  if (eq(token, S.USDC)) return "USDC";
  const r = Object.values(S.ROUTES).find((x) => eq(x.token, token));
  return r ? r.symbol : `${String(token).slice(0, 8)}..`;
};
const decimalsOf = (token) => (eq(token, S.USDC) ? 6 : (Object.values(S.ROUTES).find((x) => eq(x.token, token)) || { decimals: 18 }).decimals);
const fmt = (token, raw) => `${ethers.formatUnits(raw, decimalsOf(token))} ${symbolOf(token)}`;

// ---------------------------------------------------------------------------------------------------------------------
// On-chain proofs (read-only, shared with tools/verify-base-sweep.js)
// ---------------------------------------------------------------------------------------------------------------------

/** D4 route proof: router and quoter have code, USDC has 6 decimals, the factory knows the pool, the pool agrees. { ok } | { ok:false, reason }. */
async function proveRoute(provider, route) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    for (const [n, a] of [["router", S.ROUTER], ["quoter", S.QUOTER]]) if ((await provider.getCode(a)) === "0x") return fail(`${n} ${a} has no code`);
    if (Number(await new ethers.Contract(S.USDC, ERC20_ABI, provider).decimals()) !== S.USDC_DECIMALS) return fail("USDC decimals() is not 6");
    const found = await new ethers.Contract(S.FACTORY, FACTORY_ABI, provider).getPool(route.token, S.USDC, route.fee);
    if (!eq(found, route.pool)) return fail(`factory.getPool(${route.symbol}, USDC, ${route.fee}) is ${found}, not the allowlisted pool ${route.pool}`);
    if ((await provider.getCode(route.pool)) === "0x") return fail(`pool ${route.pool} has no code`);
    const pool = new ethers.Contract(route.pool, POOL_ABI, provider);
    const f = await pool.factory();
    if (!eq(f, S.FACTORY)) return fail(`pool.factory() is ${f}, not ${S.FACTORY}`);
    const [t0, t1] = BigInt(route.token) < BigInt(S.USDC) ? [route.token, S.USDC] : [S.USDC, route.token];
    const [p0, p1, pf] = [await pool.token0(), await pool.token1(), await pool.fee()];
    if (!eq(p0, t0) || !eq(p1, t1)) return fail(`pool token0/token1 ${p0}/${p1} do not match ${t0}/${t1}`);
    if (Number(pf) !== route.fee) return fail(`pool.fee() is ${pf}, not ${route.fee}`);
  } catch (err) { return fail(`route proof failed (${short(err)})`); }
  return { ok: true };
}

/** The pool and quoter facts for `amountIn` of the route's token, as `decideSwap` takes them. Throws on an unreadable pool. */
async function readFacts(provider, sw, route, amountIn) {
  const pool = new ethers.Contract(route.pool, POOL_ABI, provider);
  const slot = await pool.slot0();
  const liquidity = await pool.liquidity();
  const poolUsdc = await new ethers.Contract(S.USDC, ERC20_ABI, provider).balanceOf(route.pool);
  let twap = null;
  try { const o = await pool.observe([sw.twapSeconds, 0]); twap = S.twapTick(o[0], sw.twapSeconds); } catch { twap = null; }
  let quote = null;
  try {
    const q = await new ethers.Contract(S.QUOTER, QUOTER_ABI, provider).quoteExactInputSingle.staticCall({ tokenIn: route.token, tokenOut: S.USDC, amountIn, fee: route.fee, sqrtPriceLimitX96: 0 });
    quote = typeof q[0] === "bigint" ? q[0] : null;
  } catch { quote = null; }
  return { route, amountIn, quote, sqrtPriceX96: slot[0], tick: Number(slot[1]), liquidity, poolUsdc, twapTick: twap };
}

/** Full per-token decision (D4). { swap:true, route, minOut, ... } | { swap:false, reason, route? }. */
async function decideLeg(provider, sw, token, amountIn) {
  if (eq(token, S.USDC)) return { swap: false, usdc: true, reason: "USDC needs no swap" };
  const route = S.routeFor(sw, token);
  if (!route) {
    const known = Object.values(S.ROUTES).find((r) => eq(r.token, token));
    return { swap: false, reason: known ? `${known.symbol} route is disabled in settings` : "no allowlisted route for this token" };
  }
  const proof = await proveRoute(provider, route);
  if (!proof.ok) return { swap: false, route, reason: proof.reason, proof };
  let facts;
  try { facts = await readFacts(provider, sw, route, amountIn); } catch (err) { return { swap: false, route, reason: `pool unreadable (${short(err)})` }; }
  const d = S.decideSwap(sw, facts);
  return { ...d, route, proof, facts };
}

/** D7: every on-chain check of the configured vault. { configured, ok, pct, tba, reason } -- pct is 0 unless everything passes. */
async function verifyVault(provider, sw, ctx = {}) {
  const v = sw.vault;
  const no = (reason, configured = true) => ({ configured, ok: false, pct: 0, tba: null, reason });
  if (v.tba === null) return no("vault.tba not set", false);
  const tba = S.addr(v.tba);
  if (!tba) return no("vault.tba is not an address");
  const need = { nft: S.addr(v.nft), implementation: S.addr(v.implementation), registry: S.addr(v.registry), expectedOwner: S.addr(v.expectedOwner) };
  for (const [k, a] of Object.entries(need)) if (!a) return no(`vault.${k} is not an address`);
  let tokenId;
  try { tokenId = BigInt(v.tokenId); if (tokenId < 0n) throw new Error("negative"); } catch { return no("vault.tokenId is not a non-negative integer"); }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(v.salt))) return no("vault.salt is not a bytes32");
  const banned = [[ctx.operator, "the operator"], [ZERO, "the zero address"], [S.ROUTER, "the router"], [S.QUOTER, "the quoter"], [S.FACTORY, "the factory"], [S.USDC, "a token"], ...Object.values(S.ROUTES).flatMap((r) => [[r.token, "a token"], [r.pool, "a pool"]]), ...(ctx.tokens || []).map((t) => [t, "a token"])];
  for (const [a, what] of banned) if (a && eq(a, tba)) return no(`tba equals ${what}`);
  try {
    for (const [n, a] of [["registry", need.registry], ["nft", need.nft], ["tba", tba]]) if ((await provider.getCode(a)) === "0x") return no(`${n} ${a} has no code`);
    const derived = await new ethers.Contract(need.registry, REGISTRY_ABI, provider).account(need.implementation, v.salt, S.CHAIN_ID, need.nft, tokenId);
    if (!eq(derived, tba)) return no(`registry.account(...) is ${derived}, not tba ${tba}`);
    const acct = new ethers.Contract(tba, TBA_ABI, provider);
    const t = await acct.token();
    if (BigInt(t[0]) !== BigInt(S.CHAIN_ID)) return no(`tba.token() chainId is ${t[0]}, not ${S.CHAIN_ID}`);
    if (!eq(t[1], need.nft)) return no(`tba.token() nft is ${t[1]}, not ${need.nft}`);
    if (BigInt(t[2]) !== tokenId) return no(`tba.token() tokenId is ${t[2]}, not ${tokenId}`);
    const o = await acct.owner();
    if (!eq(o, need.expectedOwner)) return no(`tba.owner() is ${o}, not expectedOwner ${need.expectedOwner}`);
    const no2 = await new ethers.Contract(need.nft, NFT_ABI, provider).ownerOf(tokenId);
    if (!eq(no2, need.expectedOwner)) return no(`nft.ownerOf(${tokenId}) is ${no2}, not expectedOwner ${need.expectedOwner}`);
  } catch (err) { return no(`a vault call reverted or failed (${short(err)})`); }
  return { configured: true, ok: true, pct: S.vaultPct(v), tba, reason: null };
}

// ---------------------------------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------------------------------

/**
 * env = { sw, provider, operator, log, now, io:{exists,read,save}|null, send(op, {to,data,label}, expect, onSigned) -> {outcome,receipt,hash,reason,kind},
 *         halted() -> bool, findGasEntry(hash) -> entry|null, notify|null }
 * send outcomes: "ok" | "reverted" | "skip" (nothing broadcast; kind "cap" for a cap) | "unknown" (broadcast, outcome unknown) | "stop".
 */
function create(env) {
  const { sw, provider, operator, log, now, io } = env;
  let ledger = { jobs: [] };
  let ledgerBroken = false;
  const report = { positions: 0, deliveredUsdcRaw: 0n, unswapped: [], stuck: [], held: [], unattributed: [], vault: [], pending: 0, refused: null, txs: 0 };
  const erc20 = (a) => new ethers.Contract(a, ERC20_ABI, provider);
  const halted = () => ledgerBroken || !!(env.halted && env.halted());
  const balanceOf = (token) => erc20(token).balanceOf(operator);

  function save() {
    try { io.save(ledger); return true; } catch (err) {
      log(`STOP: the sweep ledger cannot be written (${short(err)}); nothing more is sent this run`);
      ledgerBroken = true;
      return false;
    }
  }
  const mark = (job) => { if (S.jobTerminal(job) && job.finishedAt === undefined) job.finishedAt = now(); };

  /** Validate the settings and load the ledger. { ok:true } | { ok:false, reason }. Nothing is written. */
  async function start({ simulate }) {
    if (sw.enabled) {
      log("sweep: enabled; target is baseSweep.targetToken (native Base USDC); the legacy tokens.USDG alias is not consulted");
      for (const n of sw.notes) log(`  sweep config: ${n}`);
      if (!sw.targetOk) return { ok: false, reason: `baseSweep.targetToken is not the Base USDC ${S.USDC}; the sweep refuses to start` };
      try {
        const dec = Number(await erc20(S.USDC).decimals());
        if (dec !== S.USDC_DECIMALS) return { ok: false, reason: `USDC decimals() is ${dec}, not ${S.USDC_DECIMALS}; the sweep refuses to start` };
      } catch (err) { return { ok: false, reason: `USDC decimals() could not be read (${short(err)}); the sweep refuses to start` }; }
    }
    if (!io) return sw.enabled ? { ok: false, reason: "no sweep ledger is configured" } : { ok: true, active: false };
    if (!sw.enabled && !io.exists()) return { ok: true, active: false };
    const r = io.read();
    if (!r.ok) {
      if (r.kind === "missing") return { ok: false, reason: `sweep-state.json is missing (${r.file}); refusing to send anything. Create it once with: LP_DATA_DIR=${require("path").dirname(r.file)} node collector-base.js --init-state`, kind: "missing" };
      return { ok: false, reason: `sweep-state.json is unreadable (${r.reason}); refusing everything (${r.file})`, kind: "corrupt" };
    }
    ledger = r.ledger;
    return { ok: true, active: true };
  }

  const openJobs = () => ledger.jobs.filter((j) => !S.jobTerminal(j));
  const hasOpenJob = (manager, tokenId) => openJobs().some((j) => eq(j.manager, manager) && j.tokenId === String(tokenId));
  /** Why no new collect may start, or null. */
  function blocker() {
    for (const j of ledger.jobs) {
      if (j.collect.status === "unattributed") return `job ${j.id} is unattributed`;
      if (j.legs.some((l) => l.phase === "stuck")) return `job ${j.id} has a stuck leg`;
      if (j.legs.some((l) => l.unattributed)) return `job ${j.id} has an unattributed leg`;
    }
    return null;
  }

  // ---- reading helpers -------------------------------------------------------------------------------------------
  async function ownerCheck(job) {
    try {
      const o = await new ethers.Contract(job.manager, MGR_ABI, provider).ownerOf(BigInt(job.tokenId));
      if (!o || eq(o, ZERO)) return { ok: false, reason: "ownerOf is the zero address" };
      if (eq(o, operator)) return { ok: false, reason: "ownerOf is the operator" };
      if (!eq(o, job.owner)) return { ok: false, reason: `ownerOf is ${o}, not the owner recorded at collect time ${job.owner}` };
      return { ok: true, owner: ethers.getAddress(o) };
    } catch (err) { return { ok: false, reason: `ownerOf could not be read (${short(err)})` }; }
  }
  async function positionTokens(manager, tokenId) {
    const p = await new ethers.Contract(manager, MGR_ABI, provider).positions(BigInt(tokenId));
    const t0 = S.addr(p[2]), t1 = S.addr(p[3]);
    if (!t0 || !t1) throw new Error("position tokens are not addresses");
    return [t0, t1];
  }

  // ---- transactions ----------------------------------------------------------------------------------------------
  /** Send one sweep tx; the pending intent goes to the ledger between signing and the gas reservation. */
  async function sendOp(holder, op, spec, expect, extra = {}) {
    const onSigned = ({ hash, nonce }) => {
      holder.pending = { op, tx: hash, nonce, ...extra };
      if (!save()) { holder.pending = null; throw new Error("the sweep ledger cannot be written"); }
    };
    report.txs++;
    return env.send(op, spec, expect, onSigned);
  }
  const clearPending = (holder) => { holder.pending = null; };

  // ---- legs --------------------------------------------------------------------------------------------------------
  function hold(job, leg, reason) {
    if (leg.phase !== "held") leg.heldFrom = leg.phase;
    leg.phase = "held"; leg.reason = reason;
    log(`  HELD ${symbolOf(leg.token)} of #${job.tokenId}: ${reason}; nothing is sent, retried next run`);
    report.held.push(`#${job.tokenId} ${symbolOf(leg.token)}: ${reason}`);
    save();
    return false;
  }

  async function releaseHeld(job, leg) {
    const o = await ownerCheck(job);
    if (!o.ok) { log(`  HELD ${symbolOf(leg.token)} of #${job.tokenId}: ${o.reason}; still nothing sent`); report.held.push(`#${job.tokenId} ${symbolOf(leg.token)}: ${o.reason}`); return false; }
    leg.phase = leg.heldFrom || "collected"; delete leg.heldFrom; delete leg.reason;
    return save();
  }

  /** transfer(to, amount) of `token` to a verified recipient; credits nothing (the caller does). { ok } | { reverted } | { blocked }. */
  async function sendTransfer(job, leg, token, to, amount, recipients, kind) {
    let before = null;
    try { before = await balanceOf(token); } catch { before = null; }
    const r = await sendOp(leg, "transfer", { to: token, data: S.calldata.transfer(to, amount), label: `#${job.tokenId} transfer ${fmt(token, amount)} to ${to}` }, { token, legTokens: [token], amount, recipients, operator }, { raw: amount.toString(), to, kind });
    if (r.outcome === "ok") {
      let after = null;
      try { after = await balanceOf(token); } catch { after = null; }
      clearPending(leg);
      if (before !== null && after !== null && after > before - amount) {
        log(`  ! transfer of ${fmt(token, amount)} to ${to} was mined but the operator balance did not fall by the amount (${before} -> ${after}); not counted as delivered`);
        save();
        return { reverted: true };
      }
      leg.deliver = { to, raw: amount.toString(), tx: r.hash };
      return { ok: true, hash: r.hash };
    }
    if (r.outcome === "reverted") { clearPending(leg); save(); return { reverted: true }; }
    if (r.outcome === "skip") { log(`  transfer skipped: ${r.reason}`); return { blocked: true, reason: r.reason }; }
    return { blocked: true, reason: r.reason || r.outcome };
  }

  /**
   * Deliver up to `wanted` of `token` from the operator: the owner (re-read now), or the vault share first when `splitAllowed` and verified.
   * credit(raw) records progress. Returns true while something was delivered and the leg can continue.
   */
  async function payOut(job, leg, token, wanted, { splitAllowed, credit, kind }) {
    const o = await ownerCheck(job);
    if (!o.ok) return hold(job, leg, o.reason);
    let bal;
    try { bal = await balanceOf(token); } catch (err) { return hold(job, leg, `operator balance could not be read (${short(err)})`); }
    let amount = minB(wanted, bal);
    if (amount <= 0n) return hold(job, leg, `operator balance of ${symbolOf(token)} is 0 but ${wanted} raw remain attributed`);
    let vaultTba = null, toVault = 0n;
    if (splitAllowed && !leg.vaultTried) {
      const v = await verifyVault(provider, sw, { operator, tokens: [leg.token] });
      if (v.configured && !v.ok) { log(`  VAULT split refused: ${v.reason}; 100% goes to the owner`); report.vault.push(v.reason); }
      if (v.ok && v.pct > 0) { vaultTba = v.tba; toVault = S.split(amount, v.pct).toVault; }
    }
    const recipients = [o.owner, vaultTba].filter(Boolean);
    if (toVault > 0n) {
      leg.vaultTried = true;
      if (!save()) return false;
      const r = await sendTransfer(job, leg, token, vaultTba, toVault, recipients, kind);
      if (r.ok) { credit(toVault); amount -= toVault; leg.vault = { to: vaultTba, raw: toVault.toString(), tx: r.hash }; report.deliveredUsdcRaw += toVault; log(`  delivered ${fmt(token, toVault)} to the vault ${vaultTba} (tx ${r.hash})`); save(); }
      else if (r.reverted) {
        leg.vault = { to: vaultTba, raw: "0", failed: true };
        log("  VAULT transfer failed (reverted); the owner gets the full remaining amount");
        report.vault.push("vault transfer failed; owner received everything");
        save();
      } else {
        // Blocked or unknown (no receipt): the vault transfer may still land. Nothing more is sent for this leg; the pending
        // intent (if one was signed) is resolved from the chain at the next run start, and the owner gets only the remainder.
        log(`  VAULT transfer not confirmed (${r.reason || "no receipt"}); nothing more is sent for this leg this run, resolved at the next run start`);
        report.vault.push("vault transfer unconfirmed; resolved next run");
        save();
        return false;
      }
      if (halted()) return false;
    }
    if (amount <= 0n) return true;
    const r = await sendTransfer(job, leg, token, o.owner, amount, recipients, kind);
    if (r.ok) {
      credit(amount);
      if (S.eq(token, S.USDC)) report.deliveredUsdcRaw += amount;
      log(`  delivered ${fmt(token, amount)} to the owner ${o.owner} (tx ${r.hash})`);
      return save();
    }
    if (r.reverted) {
      leg.tAttempts = (leg.tAttempts || 0) + 1;
      log(`  ! transfer to the owner failed (${leg.tAttempts}/${sw.maxAttemptsPerLeg})`);
      if (leg.tAttempts >= sw.maxAttemptsPerLeg) {
        leg.stuckFrom = leg.phase; leg.phase = "stuck";
        log(`  STUCK ${symbolOf(leg.token)} of #${job.tokenId}: the transfer of ${symbolOf(token)} to the owner failed ${leg.tAttempts} times; never redirected, reported every run`);
        save();
        return false;
      }
      save();
      return true;
    }
    return false;
  }

  const outstanding = (leg) => BigInt(leg.owedRaw) - BigInt(leg.doneRaw);
  const proceedsLeft = (leg) => BigInt((leg.swap && leg.swap.outRaw) || "0") - BigInt(leg.outDone || "0");

  /** The USDC the swap receipt paid to the operator (pool -> operator), 0 when none is found. */
  function swapOut(receipt, route) {
    let total = 0n;
    for (const l of (receipt && receipt.logs) || []) {
      if (!eq(l.address, S.USDC) || !l.topics || l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
      if (!eq(ethers.getAddress(ethers.dataSlice(l.topics[1], 12)), route.pool) || !eq(ethers.getAddress(ethers.dataSlice(l.topics[2], 12)), operator)) continue;
      total += BigInt(l.data);
    }
    return total;
  }

  async function resetAllowance(job, leg, why) {
    let al;
    try { al = await erc20(leg.token).allowance(operator, S.ROUTER); } catch (err) { log(`  allowance could not be read (${short(err)})`); return false; }
    if (al === 0n) return true;
    const r = await sendOp(leg, "approve-reset", { to: leg.token, data: S.calldata.approve(S.ROUTER, 0n), label: `#${job.tokenId} approve-reset ${symbolOf(leg.token)} (${why})` }, { token: leg.token, legTokens: [leg.token], amount: 0n, operator });
    if (r.outcome === "ok" || r.outcome === "reverted") clearPending(leg);
    if (r.outcome !== "ok") { log(`  ! allowance reset for ${symbolOf(leg.token)} was not completed (${r.reason || r.outcome}); it is reset at the next run start`); save(); return false; }
    save();
    return true;
  }

  async function trySwap(job, leg, amount, d) {
    const route = d.route;
    const al = await erc20(leg.token).allowance(operator, S.ROUTER);
    if (!(leg.phase === "approved" && al === amount)) {
      if (al !== 0n && !(await resetAllowance(job, leg, "leftover found"))) return false;
      const a = await sendOp(leg, "approve", { to: leg.token, data: S.calldata.approve(S.ROUTER, amount), label: `#${job.tokenId} approve ${fmt(leg.token, amount)} to the router` }, { token: leg.token, legTokens: [leg.token], amount, operator }, { raw: amount.toString() });
      if (a.outcome === "ok" || a.outcome === "reverted") clearPending(leg);
      if (a.outcome !== "ok") {
        if (a.outcome === "reverted" || (a.outcome === "skip" && (a.kind === "estimate" || a.kind === "ceiling"))) { leg.attempts++; log(`  ! approve attempt ${leg.attempts}/${sw.maxAttemptsPerLeg} failed (${a.outcome === "skip" ? a.reason : "reverted on-chain"})`); save(); return true; }
        save();
        return false;
      }
      leg.phase = "approved";
      if (!save()) return false;
    }
    const params = { tokenIn: route.token, tokenOut: S.USDC, fee: route.fee, recipient: operator, amountIn: amount, amountOutMinimum: d.minOut, sqrtPriceLimitX96: 0 };
    leg.swap = { ...(leg.swap || {}), amountIn: amount.toString(), quoteRaw: d.quote.toString(), minOutRaw: d.minOut.toString(), outRaw: (leg.swap && leg.swap.outRaw) || "0", tx: null };
    log(`  swap ${fmt(leg.token, amount)}: quote ${S.fmtUsdc(d.quote)} USDC, minOut ${S.fmtUsdc(d.minOut)}, impact ${d.impactBps} bps`);
    const r = await sendOp(leg, "swap", { to: S.ROUTER, data: S.calldata.swap(params), label: `#${job.tokenId} swap ${fmt(leg.token, amount)}` }, { params, operator }, { raw: amount.toString() });
    if (r.outcome === "ok") {
      clearPending(leg);
      let out = swapOut(r.receipt, route);
      try { const b = await balanceOf(S.USDC); if (out > b) out = b; } catch { /* the receipt amount stands */ }
      leg.doneRaw = (BigInt(leg.doneRaw) + amount).toString();
      leg.swap.outRaw = (BigInt(leg.swap.outRaw) + out).toString();
      leg.swap.tx = r.hash;
      log(`  swapped: received ${S.fmtUsdc(out)} USDC (tx ${r.hash})`);
      if (halted()) { save(); return false; }
      if (out === 0n) { leg.phase = "held"; leg.heldFrom = "collected"; leg.unattributed = true; leg.reason = "swap receipt has no USDC transfer to the operator"; report.unattributed.push(`#${job.tokenId} ${symbolOf(leg.token)} swap output`); save(); log(`  ! ${leg.reason}; nothing is delivered for it`); return false; }
      await resetAllowance(job, leg, "after the swap");
      leg.phase = "swapped";
      return save();
    }
    if (r.outcome === "reverted" || (r.outcome === "skip" && (r.kind === "estimate" || r.kind === "ceiling"))) {
      if (r.outcome === "reverted") clearPending(leg);
      leg.attempts++;
      log(`  ! swap attempt ${leg.attempts}/${sw.maxAttemptsPerLeg} failed (${r.outcome === "skip" ? r.reason : "reverted on-chain"})`);
      if (!halted()) await resetAllowance(job, leg, "after a failed swap");
      leg.phase = "collected";
      return save();
    }
    return false;
  }

  async function stepConvert(job, leg) {
    const rem = outstanding(leg);
    if (rem > 0n) { const o = await ownerCheck(job); if (!o.ok) return hold(job, leg, o.reason); } // nothing is converted that cannot be delivered
    if (rem === 0n) { leg.phase = proceedsLeft(leg) > 0n ? "swapped" : (leg.swap && BigInt(leg.swap.outRaw || "0") > 0n ? "delivered" : "delivered-unswapped"); return save(); }
    let bal;
    try { bal = await balanceOf(leg.token); } catch (err) { return hold(job, leg, `operator balance could not be read (${short(err)})`); }
    const amount = minB(rem, bal);
    if (amount <= 0n) return hold(job, leg, `operator balance of ${symbolOf(leg.token)} is 0 but ${rem} raw remain attributed`);
    let d;
    if (eq(leg.token, S.USDC)) d = { swap: false, usdc: true };
    else if (leg.attempts >= sw.maxAttemptsPerLeg) d = { swap: false, reason: `swap failed ${leg.attempts} times` };
    else d = await decideLeg(provider, sw, leg.token, amount);
    if (halted()) return false;
    if (d.swap) return trySwap(job, leg, amount, d);
    if (!d.usdc) {
      if (leg.phase === "approved" && !(await resetAllowance(job, leg, "no swap"))) return false;
      if (leg.phase === "approved") { leg.phase = "collected"; if (!save()) return false; }
      log(`  ${symbolOf(leg.token)} ${fmt(leg.token, amount)} delivered unswapped: ${d.reason}`);
      report.unswapped.push({ token: symbolOf(leg.token), reason: d.reason });
    }
    const ok = await payOut(job, leg, leg.token, amount, { splitAllowed: false, kind: "raw", credit: (x) => { leg.doneRaw = (BigInt(leg.doneRaw) + x).toString(); } });
    if (outstanding(leg) === 0n && !leg.pending) { leg.phase = "delivered-unswapped"; save(); }
    return ok && leg.phase !== "held" && leg.phase !== "stuck";
  }

  async function stepProceeds(job, leg) {
    const left = proceedsLeft(leg);
    if (left <= 0n) { leg.phase = outstanding(leg) > 0n ? "collected" : "delivered"; return save(); }
    const ok = await payOut(job, leg, S.USDC, left, { splitAllowed: true, kind: "proceeds", credit: (x) => { leg.outDone = (BigInt(leg.outDone || "0") + x).toString(); } });
    if (proceedsLeft(leg) === 0n && leg.phase === "swapped") { leg.phase = outstanding(leg) > 0n ? "collected" : "delivered"; save(); }
    return ok && leg.phase !== "held" && leg.phase !== "stuck";
  }

  async function advanceLeg(job, leg) {
    for (let i = 0; i < 40 && !halted(); i++) {
      if (leg.pending) { report.pending++; return; }
      if (leg.unattributed) { report.unattributed.push(`#${job.tokenId} ${symbolOf(leg.token)} swap output`); log(`  UNATTRIBUTED ${symbolOf(leg.token)} of #${job.tokenId}: the swap output is unknown; nothing is sent`); return; }
      if (S.legTerminal(leg)) return;
      if (leg.phase === "stuck") { report.stuck.push(`#${job.tokenId} ${symbolOf(leg.token)}`); log(`  STUCK ${symbolOf(leg.token)} of #${job.tokenId}: transfer failed repeatedly; reported, never redirected`); return; }
      let go;
      if (leg.phase === "held") go = await releaseHeld(job, leg);
      else if (leg.phase === "swapped") go = await stepProceeds(job, leg);
      else go = await stepConvert(job, leg);
      if (leg.phase === "stuck") { report.stuck.push(`#${job.tokenId} ${symbolOf(leg.token)}`); return; }
      if (!go) return;
    }
  }
  async function advanceJob(job) {
    for (const leg of job.legs) { if (halted()) return; await advanceLeg(job, leg); }
    mark(job);
    save();
  }

  // ---- jobs --------------------------------------------------------------------------------------------------------
  /** A new job for a position about to be collected. Not in the ledger until `collectIntent` runs (after signing). */
  function newJob({ manager, tokenId, owner, token0, token1, amounts }) {
    return { id: `${manager}:${tokenId}:${now()}`, tokenId: String(tokenId), manager, owner, token0, token1, expect: { a0: String(amounts[0]), a1: String(amounts[1]) }, collect: { tx: null, nonce: null, status: "intent" }, pending: null, legs: [], createdAt: now() };
  }
  /** The onSigned hook of the collect: the pending intent goes to the ledger before the gas reservation. */
  function collectIntent(job) {
    return ({ hash, nonce }) => {
      job.pending = { op: "collect", tx: hash, nonce };
      job.collect.tx = hash; job.collect.nonce = nonce;
      ledger.jobs.push(job);
      if (!save()) { ledger.jobs.splice(ledger.jobs.indexOf(job), 1); throw new Error("the sweep ledger cannot be written"); }
    };
  }
  /** The Collect event of a validated receipt: [amount0, amount1] or null. */
  function parseCollect(receipt, job) {
    for (const l of (receipt && receipt.logs) || []) {
      if (!eq(l.address, job.manager) || !l.topics || !COLLECT_TOPICS.includes(l.topics[0]) || l.topics.length !== 2) continue;
      if (BigInt(l.topics[1]) !== BigInt(job.tokenId)) continue;
      try {
        const [rcp, a0, a1] = COLLECT_ID.decode(["address", "uint256", "uint256"], l.data);
        if (eq(rcp, operator)) return [a0, a1];
      } catch { /* not this event */ }
    }
    return null;
  }
  /** Legs from the receipt's Collect event, else from the pre-signing amounts clamped to the operator balance, else unattributed. */
  async function attribute(job, receipt) {
    let amounts = parseCollect(receipt, job);
    let how = "Collect event";
    if (!amounts) {
      how = "simulated amounts clamped to the operator balance";
      try {
        const want = [BigInt(job.expect.a0), BigInt(job.expect.a1)];
        const have = [await balanceOf(job.token0), await balanceOf(job.token1)];
        amounts = [minB(want[0], have[0]), minB(want[1], have[1])];
      } catch { amounts = null; }
    }
    if (!amounts) { job.collect.status = "unattributed"; job.pending = null; log(`  ! #${job.tokenId}: the collected amounts cannot be attributed; nothing is sent, reported`); return save(); }
    job.collect.status = "mined"; job.pending = null; job.legs = [];
    [[job.token0, amounts[0]], [job.token1, amounts[1]]].forEach(([token, amt]) => {
      if (amt > 0n) job.legs.push({ token, owedRaw: amt.toString(), doneRaw: "0", phase: "collected", attempts: 0, pending: null, swap: { amountIn: null, quoteRaw: null, minOutRaw: null, outRaw: "0", tx: null }, deliver: null });
    });
    log(`  attributed (${how}): ${job.legs.map((l) => fmt(l.token, l.owedRaw)).join(", ") || "nothing"}`);
    if (!job.legs.length) mark(job);
    return save();
  }
  /** After the collect tx: attribute and deliver. `outcome` is the sendTracked result. */
  async function afterCollect(job, outcome) {
    if (outcome.outcome === "ok") {
      report.positions++;
      if (!(await attribute(job, outcome.receipt))) return;
      if (job.collect.status === "unattributed") { report.unattributed.push(`#${job.tokenId}`); return; }
      await advanceJob(job);
    } else if (outcome.outcome === "reverted") {
      job.pending = null; job.collect.status = "reverted"; mark(job); save();
    }
    // skip / unknown / stop: the intent (if written) stays and is resolved from the chain at the next run start
  }

  // ---- recovery (D10) -------------------------------------------------------------------------------------------------
  /** What became of a pending tx: { state:"mined", receipt } | { state:"void", why } | { state:"waiting", why }. */
  async function resolve(p, expectTo) {
    if (!p.tx) return { state: "void", why: "the intent has no transaction hash: it was never signed" };
    const entry = env.findGasEntry(p.tx);
    // The receipt is asked for first, whether or not the gas entry still exists (entries are pruned after 7 days).
    let rc = null;
    try { rc = (await provider.getTransactionReceipt(p.tx)) || null; } catch (err) { return { state: "waiting", why: `receipt lookup failed (${short(err)})` }; }
    if (rc) {
      if (entry && expectTo && !eq(entry.to, expectTo)) return { state: "waiting", why: `receipt rejected (the recorded target ${entry.to} is not the expected ${expectTo})` };
      const target = entry ? entry.to : expectTo;
      if (!target) return { state: "waiting", why: "receipt rejected (no expected target to check it against)" };
      // Without a gas entry the receipt is checked against the operator and the op's target, with the Base block gas limit as the bound.
      const ref = entry || { from: operator, to: target, gasLimit: "30000000" };
      const bad = base.checkReceipt(rc, { hash: p.tx, operator, entry: ref, allowedTo: [target] });
      if (bad) return { state: "waiting", why: `receipt rejected (${bad})` };
      return { state: "mined", receipt: rc };
    }
    if (!entry) return { state: "void", why: "the intent has no gas reservation: it was never broadcast" };
    try {
      const latest = Number(await provider.getTransactionCount(operator, "latest"));
      if (latest > p.nonce) return { state: "void", why: `nonce ${p.nonce} is used by another transaction and there is no receipt` };
    } catch (err) { return { state: "waiting", why: `nonce lookup failed (${short(err)})` }; }
    return { state: "waiting", why: `nonce ${p.nonce} is not used yet; the transaction is still pending` };
  }

  async function recoverJob(job) {
    if (job.collect.status === "unattributed") { report.unattributed.push(`#${job.tokenId}`); return; }
    if (job.pending) {
      const r = await resolve(job.pending, job.manager);
      if (r.state === "mined") {
        if (r.receipt.status === 0) { job.pending = null; job.collect.status = "reverted"; mark(job); save(); log(`  recovery: collect of #${job.tokenId} reverted`); }
        else { log(`  recovery: collect of #${job.tokenId} was mined; attributing from its receipt`); await attribute(job, r.receipt); }
      } else if (r.state === "void") { job.pending = null; job.collect.status = "voided"; mark(job); save(); log(`  recovery: collect intent of #${job.tokenId} voided (${r.why})`); }
      else { log(`  recovery: collect of #${job.tokenId} waits (${r.why})`); report.pending++; return; }
      if (job.collect.status === "unattributed") { report.unattributed.push(`#${job.tokenId}`); return; }
    }
    for (const leg of job.legs) {
      if (!leg.pending) continue;
      const p = leg.pending;
      const r = await resolve(p, p.op === "swap" ? S.ROUTER : (p.op === "transfer" && p.kind === "proceeds" ? S.USDC : leg.token));
      if (r.state === "waiting") { log(`  recovery: ${p.op} of ${symbolOf(leg.token)} (#${job.tokenId}) waits (${r.why}); the leg is skipped this run`); continue; }
      if (r.state === "void") { leg.pending = null; save(); log(`  recovery: ${p.op} intent of ${symbolOf(leg.token)} (#${job.tokenId}) voided (${r.why}); re-evaluated from balances`); continue; }
      const ok = r.receipt.status !== 0;
      leg.pending = null;
      const raw = BigInt(p.raw || "0");
      if (p.op === "approve") { if (ok) leg.phase = "approved"; else leg.attempts++; }
      else if (p.op === "swap") {
        if (ok) {
          const route = S.routeFor(sw, leg.token) || Object.values(S.ROUTES).find((x) => eq(x.token, leg.token));
          const out = route ? swapOut(r.receipt, route) : 0n;
          leg.doneRaw = (BigInt(leg.doneRaw) + raw).toString();
          leg.swap = { ...(leg.swap || {}), outRaw: (BigInt((leg.swap && leg.swap.outRaw) || "0") + out).toString(), tx: p.tx };
          leg.phase = out > 0n ? "swapped" : "held";
          if (out === 0n) { leg.heldFrom = "collected"; leg.unattributed = true; leg.reason = "swap receipt has no USDC transfer to the operator"; report.unattributed.push(`#${job.tokenId} ${symbolOf(leg.token)} swap output`); }
        } else { leg.attempts++; leg.phase = "collected"; }
      } else if (p.op === "transfer") {
        if (ok) {
          if (p.kind === "proceeds") leg.outDone = (BigInt(leg.outDone || "0") + raw).toString();
          else leg.doneRaw = (BigInt(leg.doneRaw) + raw).toString();
          leg.deliver = { to: p.to, raw: raw.toString(), tx: p.tx };
        } else if (eq(p.to, job.owner)) leg.tAttempts = (leg.tAttempts || 0) + 1;
        else if (leg.vault === undefined || (leg.vault && !leg.vault.tx)) leg.vault = { to: p.to, raw: "0", failed: true };
      }
      save();
      log(`  recovery: ${p.op} of ${symbolOf(leg.token)} (#${job.tokenId}) ${ok ? "succeeded" : "reverted"}; leg is ${leg.phase}`);
    }
  }

  /** Stale operator -> router allowances on the four known tokens with no active leg (collect mode, sweep enabled). */
  async function resetStale() {
    const active = new Set(openJobs().flatMap((j) => j.legs.filter((l) => l.phase === "approved").map((l) => l.token.toLowerCase())));
    for (const token of [S.USDC, ...Object.values(S.ROUTES).map((r) => r.token)]) {
      if (halted() || active.has(token.toLowerCase())) continue;
      let al;
      try { al = await erc20(token).allowance(operator, S.ROUTER); } catch (err) { log(`  allowance of ${symbolOf(token)} could not be read (${short(err)})`); continue; }
      if (al === 0n) continue;
      log(`  stale allowance ${al} of ${symbolOf(token)} to the router with no active leg: resetting`);
      const holder = { pending: null };
      const r = await sendOp(holder, "approve-reset", { to: token, data: S.calldata.approve(S.ROUTER, 0n), label: `approve-reset ${symbolOf(token)} (stale)` }, { token, legTokens: [token], amount: 0n, operator });
      if (r.outcome !== "ok") log(`  ! stale allowance reset for ${symbolOf(token)} not completed (${r.reason || r.outcome})`);
    }
  }

  /** Recovery: settle pending intents from the chain, then finish every open leg. Runs before any new collect. */
  async function recover({ resetAllowances }) {
    for (const job of openJobs()) { if (halted()) return; await recoverJob(job); }
    if (resetAllowances) await resetStale();
    for (const job of openJobs()) { if (halted()) return; await advanceJob(job); }
  }

  // ---- plan (simulate and preflight) --------------------------------------------------------------------------------
  /** Everything a collect would do, from chain reads only. Never writes. */
  async function plan({ manager, tokenId, amounts }) {
    const [t0, t1] = await positionTokens(manager, tokenId);
    const legs = [];
    for (const [token, amt] of [[t0, amounts[0]], [t1, amounts[1]]]) {
      if (BigInt(amt) <= 0n) continue;
      const d = await decideLeg(provider, sw, token, BigInt(amt));
      legs.push({ token, amount: BigInt(amt), d });
    }
    const vault = await verifyVault(provider, sw, { operator, tokens: [t0, t1] });
    let owner = null;
    try { owner = await new ethers.Contract(manager, MGR_ABI, provider).ownerOf(BigInt(tokenId)); } catch { owner = null; }
    const withVault = vault.ok && vault.pct > 0 ? 1 : 0;
    const ops = [];
    for (const l of legs) {
      // Budgeted for the whole chain whenever a route exists and is enabled: the decision can flip between the plan and the collect.
      const routeOpen = !l.d.usdc && !!(l.d.swap || (l.d.route && S.routeFor(sw, l.token)));
      if (routeOpen) ops.push("approve-reset", "approve", "swap", "approve-reset", "transfer", ...(withVault ? ["transfer"] : []));
      else ops.push("transfer");
    }
    return { tokens: [t0, t1], legs, vault, owner, ops };
  }
  function describe(pl, id) {
    const lines = [`  sweep plan #${id}: collect to the operator ${operator} (simulated amounts), then per token:`];
    for (const l of pl.legs) {
      const d = l.d, sym = symbolOf(l.token);
      if (d.usdc) { lines.push(`    ${sym} ${fmt(l.token, l.amount)}: USDC fee leg, no quote, no approve, no swap; one transfer to the owner`); continue; }
      const proof = d.route ? (d.proof && d.proof.ok ? "pool/factory proof ok" : `pool/factory proof FAILED (${d.proof ? d.proof.reason : d.reason})`) : "no route";
      const nums = d.quote !== undefined ? `quote ${S.fmtUsdc(d.quote)} USDC, mid ${S.fmtUsdc(d.mid)} (after fee ${S.fmtUsdc(d.midAfterFee)}), impact ${d.impactBps} bps${d.minOut ? `, minOut ${S.fmtUsdc(d.minOut)}` : ""}` : "no quote";
      lines.push(`    ${sym} ${fmt(l.token, l.amount)}: route ${d.route ? `${d.route.pool} fee ${d.route.fee}` : "none"}; ${proof}; ${nums}; decision: ${d.swap ? "swap" : `unswapped to the owner (${d.reason})`}`);
    }
    const v = pl.vault;
    lines.push(`    split: ${v.ok ? `${v.pct}% to the verified vault ${v.tba}` : `0% vault: ${v.reason}`}`);
    lines.push(`    recipients: owner ${pl.owner || "(ownerOf unreadable)"}; estimated sweep txs after the collect: ${pl.ops.length}`);
    return lines;
  }

  /**
   * D2 preflight for one position, before anything moves onto the operator. perOpWei(op) is the worst case of one tx of that op;
   * run = { txCount, dayTxCount, spentRunWei, spent24hWei, lim }.
   */
  async function preflight(pl, { collectWorstWei, perOpWei, run }) {
    let total = collectWorstWei, gasTxs = 1;
    for (const op of pl.ops) { total += perOpWei(op); gasTxs++; }
    if (run.txCount + gasTxs > sw.maxTxPerRun) return { ok: false, reason: `the planned chain needs ${gasTxs} transactions, maxTxPerRun ${sw.maxTxPerRun} (${run.txCount} sent) would be exceeded` };
    if (run.dayTxCount + gasTxs > sw.dailyTxCap) return { ok: false, reason: `the planned chain needs ${gasTxs} transactions, dailyTxCap ${sw.dailyTxCap} (${run.dayTxCount} in 24 h) would be exceeded` };
    for (const op of ["collect", ...pl.ops]) {
      const w = op === "collect" ? collectWorstWei : perOpWei(op);
      const c = base.capCheck({ lim: { ...run.lim, maxCollectsPerRun: 1e9 }, worstCaseWei: w, sentCount: 0, spentRunWei: run.spentRunWei, spent24hWei: run.spent24hWei });
      if (!c.ok) return { ok: false, reason: c.reason };
    }
    const runCap = base.ethToWei(run.lim.maxGasPerRunEth), dayCap = base.ethToWei(run.lim.dailyGasCapEth);
    if (run.spentRunWei + total > runCap) return { ok: false, reason: `the whole planned chain (${ethers.formatEther(total)} ETH worst case) would exceed maxGasPerRunEth ${run.lim.maxGasPerRunEth}` };
    if (run.spent24hWei + total > dayCap) return { ok: false, reason: `the whole planned chain (${ethers.formatEther(total)} ETH worst case) would exceed dailyGasCapEth ${run.lim.dailyGasCapEth}` };
    let eth;
    try { eth = await provider.getBalance(operator); } catch (err) { return { ok: false, reason: `operator ETH balance unreadable (${short(err)})` }; }
    const need = total + base.ethToWei(sw.minOperatorEthReserve);
    if (typeof eth !== "bigint" || eth < need) return { ok: false, reason: `operator ETH ${typeof eth === "bigint" ? ethers.formatEther(eth) : "?"} is below the planned worst case ${ethers.formatEther(total)} + reserve ${sw.minOperatorEthReserve}` };
    return { ok: true, total, txs: gasTxs };
  }

  // ---- reporting -------------------------------------------------------------------------------------------------------
  const problems = () => report.stuck.length + report.held.length + report.unattributed.length;
  function summaryLine(gasWei) {
    return `=== base sweep: ${report.positions} positions, delivered ${S.fmtUsdc(report.deliveredUsdcRaw)} USDC, ${report.unswapped.length} tokens unswapped, ${report.stuck.length} stuck, gas ${ethers.formatEther(gasWei)} ETH ===`;
  }
  function summaryText(gasWei, aborted) {
    const out = [summaryLine(gasWei)];
    for (const u of report.unswapped) out.push(`unswapped ${u.token}: ${u.reason}`);
    out.push(`vault: ${report.vault.length ? report.vault.join("; ") : (sw.vault.tba === null ? "0% (vault.tba not set)" : "ok")}`);
    for (const k of ["stuck", "held", "unattributed"]) for (const x of report[k]) out.push(`${k.toUpperCase()}: ${x}`);
    if (report.pending) out.push(`${report.pending} pending transaction(s) waiting`);
    if (aborted) out.push("run ABORTED");
    return out.join("\n");
  }

  return { start, recover, plan, describe, preflight, newJob, collectIntent, afterCollect, blocker, hasOpenJob, summaryLine, summaryText, problems, report, ledger: () => ledger, openJobs, halted };
}

module.exports = { create, proveRoute, decideLeg, verifyVault, readFacts, symbolOf, fmt, ERC20_ABI, POOL_ABI, QUOTER_ABI, MGR_ABI, COLLECT_TOPICS, TRANSFER_TOPIC };
