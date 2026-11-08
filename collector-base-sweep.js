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

// URLs are redacted first: an RPC URL may carry an API key and must never reach the log or Telegram (security S3).
const short = (err) => String((err && (err.shortMessage || err.message)) || err).split("\n")[0].replace(/https?:\/\/\S+/gi, "<url>").slice(0, 160);
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
  // The registry is the hard-coded canonical ERC-6551 registry; a settings value that differs is refused, never used.
  if (v.registry !== null && v.registry !== undefined && v.registry !== "" && !eq(v.registry, S.ERC6551_REGISTRY)) return no(`vault.registry ${v.registry} is not the canonical ERC-6551 registry ${S.ERC6551_REGISTRY}`);
  const need = { nft: S.addr(v.nft), implementation: S.addr(v.implementation), registry: S.ERC6551_REGISTRY, expectedOwner: S.addr(v.expectedOwner) };
  for (const [k, a] of Object.entries(need)) if (!a) return no(`vault.${k} is not an address`);
  if (!(Array.isArray(ctx.implementations) ? ctx.implementations : S.VAULT_IMPLEMENTATIONS).some((i) => eq(i, need.implementation))) return no(`vault.implementation ${need.implementation} is not in the code allowlist of ERC-6551 implementations (empty by default); the vault cannot verify`);
  if (!(ctx.owners || []).some((o) => eq(o, need.expectedOwner))) return no(`vault.expectedOwner ${need.expectedOwner} is not one of the configured owner addresses`);
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
 * env = { sw, provider, operator, log, now, io:{exists,read,save}|null, owners:[configured owner address addresses], send(op, {to,data,label}, expect, onSigned) -> {outcome,receipt,hash,reason,kind},
 *         halted() -> bool, findGasEntry(hash) -> entry|null, notify|null }
 * send outcomes: "ok" | "reverted" | "skip" (nothing broadcast; kind "cap" for a cap) | "unknown" (broadcast, outcome unknown) | "stop".
 */
function create(env) {
  const { sw, provider, operator, log, now, io } = env;
  const owners = Array.isArray(env.owners) ? env.owners : [];
  // The ERC-6551 implementation allowlist: the frozen code constant, unless a caller (tests) injects its own list. Never from settings.
  const vaultImplementations = Array.isArray(env.vaultImplementations) ? Object.freeze([...env.vaultImplementations]) : S.VAULT_IMPLEMENTATIONS;
  const ownerConfigured = (a) => owners.some((o) => eq(o, a));
  const sideDecimals = new Map(); // same key -> [dec0, dec1] read at plan time, pinned on the job at newJob
  const sidePrices = new Map(); // `${manager}:${tokenId}` (lowercase) -> [usd0, usd1] seen at plan time, copied to the job at the collect intent
  const collectChecks = new Map(); // manager:tokenId:collect.tx (lowercased) -> { amounts, tokens } read back from the chain this run
  let ledger = { jobs: [], retired: S.emptyRetired() };
  let ledgerBroken = false;
  const report = { positions: 0, deliveredUsdcRaw: 0n, unswapped: [], stuck: [], held: [], unattributed: [], vault: [], pending: 0, refused: null, txs: 0, warnings: [] };
  const erc20 = (a) => new ethers.Contract(a, ERC20_ABI, provider);
  const halted = () => ledgerBroken || !!(env.halted && env.halted());
  const balanceOf = (token) => erc20(token).balanceOf(operator);

  function save() {
    try { io.save(ledger, knownHead); return true; } catch (err) {
      log(`STOP: the sweep ledger cannot be written (${short(err)}); nothing more is sent this run`);
      ledgerBroken = true;
      return false;
    }
  }
  /** Notes the highest block a job has a receipt in (the retired list keeps it when the job is pruned). */
  const noteBlock = (job, rc) => { const b = Number(rc && rc.blockNumber); if (Number.isSafeInteger(b) && b > 0 && !(job.maxBlock >= b)) job.maxBlock = b; };
  const addTransferTx = (leg, hash) => { const t = Array.isArray(leg.transferTxs) ? leg.transferTxs : []; if (typeof hash === "string" && !t.some((h) => eq(h, hash))) t.push(hash); leg.transferTxs = t; }; // never truncated: payOut holds the leg before it can pass S.MAX_TRANSFERS_PER_LEG
  let knownHead = null; // the chain head read at start; pruning of old terminal jobs needs it (chain age as well as clock age)
  const warned = new Set();
  const agedLogged = new Set();
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
    // Security M-1: a block number above the chain head can only be a tamper (it would hold every job while new collects continue).
    let head;
    try { head = Number(await provider.getBlockNumber()); } catch (err) { return { ok: false, reason: `sweep-state.json cannot be checked against the chain head (the RPC failed: ${short(err)}); refusing everything (${r.file || "ledger"})`, kind: "rpc" }; }
    const ahead = S.ledgerAheadProblem(r.ledger, head);
    if (ahead) return { ok: false, reason: `sweep-state.json is unreadable (${ahead}; tampered ledger); refusing everything`, kind: "corrupt" };
    ledger = r.ledger;
    for (const w of r.warnings || []) { log(`  WARNING ${w}`); report.warnings.push(w); }
    if (Number.isSafeInteger(head) && head > 0) knownHead = head;
    return { ok: true, active: true };
  }

  const openJobs = () => ledger.jobs.filter((j) => !S.jobTerminal(j));
  const hasOpenJob = (manager, tokenId) => openJobs().some((j) => eq(j.manager, manager) && j.tokenId === String(tokenId));
  /** Why no new collect may start, or null. */
  function blocker() {
    for (const j of ledger.jobs) {
      if (!S.jobTerminal(j) && !ownerConfigured(j.owner)) return `job ${j.id} names an owner that is not a configured owner address`;
      if (j.collect.status === "unattributed") return `job ${j.id} is unattributed`;
      if (j.legs.some((l) => l.phase === "stuck")) return `job ${j.id} has a stuck leg`;
      if (j.legs.some((l) => l.unattributed)) return `job ${j.id} has an unattributed leg`;
    }
    return null;
  }

  // ---- reading helpers -------------------------------------------------------------------------------------------
  async function ownerCheck(job) {
    if (!ownerConfigured(job.owner)) return { ok: false, reason: `the ledger owner ${job.owner} is not a configured owner address (tampered or stale ledger)` };
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
  async function sendOp(holder, op, spec, expect, extra = {}, whenSigned = null) {
    const onSigned = ({ hash, nonce }) => {
      if (whenSigned) whenSigned();
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

  /** A leg whose outcome cannot be established from the chain: held and unattributed. It blocks new collects and is never resent. */
  function unattribute(job, leg, reason) {
    if (leg.phase !== "held") leg.heldFrom = leg.phase;
    leg.phase = "held"; leg.unattributed = true; leg.reason = reason; leg.pending = null;
    report.unattributed.push(`#${job.tokenId} ${symbolOf(leg.token)}: ${reason}`);
    log(`  UNATTRIBUTED ${symbolOf(leg.token)} of #${job.tokenId}: ${reason}; nothing is resent`);
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
  async function sendTransfer(job, leg, token, to, amount, recipients, kind, whenSigned = null) {
    const r = await sendOp(leg, "transfer", { to: token, data: S.calldata.transfer(to, amount), label: `#${job.tokenId} transfer ${fmt(token, amount)} to ${to}` }, { token, legTokens: [token], amount, recipients, operator }, { raw: amount.toString(), to, kind }, whenSigned);
    if (r.outcome === "ok") {
      clearPending(leg);
      const pr = await transferProof(r.receipt, token, to, amount);
      if (!pr.ok) {
        log(`  ! transfer of ${fmt(token, amount)} to ${to} (tx ${r.hash}): ${pr.log}`);
        return { unattributed: true, hash: r.hash, reason: `transfer ${r.hash} ${pr.reason}` };
      }
      leg.deliver = { to, raw: amount.toString(), tx: r.hash };
      addTransferTx(leg, r.hash); noteBlock(job, r.receipt);
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
    // up to two transfers (vault share + owner) can be recorded in one call; no hash is ever dropped, so the leg stops here instead
    if ((Array.isArray(leg.transferTxs) ? leg.transferTxs.length : 0) + 2 > S.MAX_TRANSFERS_PER_LEG) return hold(job, leg, `the leg already has ${leg.transferTxs.length} recorded transfers (limit ${S.MAX_TRANSFERS_PER_LEG}); an operator must resolve it`);
    let bal;
    try { bal = await balanceOf(token); } catch (err) { return hold(job, leg, `operator balance could not be read (${short(err)})`); }
    let amount = minB(wanted, bal);
    if (amount <= 0n) return hold(job, leg, `operator balance of ${symbolOf(token)} is 0 but ${wanted} raw remain attributed`);
    let vaultTba = null, toVault = 0n;
    if (splitAllowed && !leg.vaultTried) {
      const v = await verifyVault(provider, sw, { operator, owners, tokens: [leg.token], implementations: vaultImplementations });
      if (v.configured && !v.ok) { log(`  VAULT split refused: ${v.reason}; 100% goes to the owner`); report.vault.push(v.reason); }
      if (v.ok && v.pct > 0) { vaultTba = v.tba; toVault = S.split(amount, v.pct).toVault; }
    }
    const recipients = [o.owner, vaultTba].filter(Boolean);
    if (toVault > 0n) {
      // vaultTried is set only once a signed intent exists (in onSigned): a transfer skipped before signing is retried next run.
      const r = await sendTransfer(job, leg, token, vaultTba, toVault, recipients, kind, () => { leg.vaultTried = true; });
      if (r.unattributed) return unattribute(job, leg, r.reason);
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
    if (r.unattributed) return unattribute(job, leg, r.reason);
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

  /** Every swap hash of a leg: swap.txs, plus the single legacy swap.tx when it is not listed. */
  const swapTxs = (leg) => { const t = leg.swap ? [...(Array.isArray(leg.swap.txs) ? leg.swap.txs : [])] : []; if (leg.swap && leg.swap.tx && !t.some((h) => eq(h, leg.swap.tx))) t.push(leg.swap.tx); return t; };
  const addSwapTx = (leg, hash) => { const t = swapTxs(leg); if (!t.some((h) => eq(h, hash))) t.push(hash); leg.swap.txs = t; };
  const outstanding = (leg) => BigInt(leg.owedRaw) - BigInt(leg.doneRaw);
  const proceedsLeft = (leg) => BigInt((leg.swap && leg.swap.outRaw) || "0") - BigInt(leg.outDone || "0");

  /**
   * True when `hash` is already on record anywhere else in the ledger: any job's collect.tx, any other leg's swap hashes or pending swap
   * hash, or a swap hash this leg has already been credited with. A recovered receipt for such a hash must not be credited again.
   */
  /** Security L-3: true when a transfer hash is already on record anywhere else (any collect, swap or transfer hash, retired or live). */
  function transferCollision(leg, hash) {
    if (S.retiredHas(ledger.retired, hash)) return true;
    for (const j of ledger.jobs) {
      if (j.collect && typeof j.collect.tx === "string" && eq(j.collect.tx, hash)) return true;
      for (const l of j.legs) {
        if (swapTxs(l).some((h) => eq(h, hash))) return true;
        if (l.pending && l.pending.op === "swap" && typeof l.pending.tx === "string" && eq(l.pending.tx, hash)) return true;
        if ([l.deliver && l.deliver.tx, l.vault && l.vault.tx, ...(Array.isArray(l.transferTxs) ? l.transferTxs : [])].some((h) => typeof h === "string" && eq(h, hash))) return true;
        if (l !== leg && l.pending && l.pending.op === "transfer" && typeof l.pending.tx === "string" && eq(l.pending.tx, hash)) return true;
      }
    }
    return false;
  }
  function hashCollision(leg, hash) {
    if (S.retiredHas(ledger.retired, hash)) return true;
    for (const j of ledger.jobs) {
      if (j.collect && typeof j.collect.tx === "string" && eq(j.collect.tx, hash)) return true;
      for (const l of j.legs) {
        if (swapTxs(l).some((h) => eq(h, hash))) return true;
        if (l !== leg && l.pending && l.pending.op === "swap" && typeof l.pending.tx === "string" && eq(l.pending.tx, hash)) return true;
      }
    }
    return false;
  }

  /** True when the receipt holds `token`'s own Transfer(operator -> to, amount) log. */
  function hasTransferLog(receipt, token, to, amount) {
    for (const l of (receipt && receipt.logs) || []) {
      if (l.removed === true) continue;
      if (!eq(l.address, token) || !l.topics || l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
      try {
        if (eq(ethers.getAddress(ethers.dataSlice(l.topics[1], 12)), operator) && eq(ethers.getAddress(ethers.dataSlice(l.topics[2], 12)), to) && BigInt(l.data) === BigInt(amount)) return true;
      } catch { /* not this log */ }
    }
    return false;
  }

  /**
   * Proof that a mined transfer moved `amount` of `token` from the operator to `to`. When the receipt's logs are available (a non-empty
   * list: a successful ERC-20 transfer always emits one) the token's own Transfer(operator -> to, amount) log is REQUIRED, because another
   * outflow of the operator in the same block could satisfy a balance fall. Only when the logs are unavailable (and the token is not USDC or a route token, whose empty logs are never proof) is the balance fall at the
   * receipt's block (before = the block before) accepted. { ok:true } | { ok:false, reason, log }.
   */
  async function transferProof(receipt, token, to, amount) {
    const logs = receipt && receipt.logs;
    // A known token (USDC or a route token) always emits a Transfer log on success: an empty list is not proof and never falls back to a balance fall.
    const known = eq(token, S.USDC) || Object.values(S.ROUTES).some((x) => eq(x.token, token));
    if (known && !(Array.isArray(logs) && logs.length > 0)) return { ok: false, reason: "mined but the receipt has no matching Transfer log", log: `the receipt of a ${symbolOf(token)} transfer has no logs; empty logs are not proof for this token` };
    if (Array.isArray(logs) && logs.length > 0) {
      if (hasTransferLog(receipt, token, to, amount)) return { ok: true };
      return { ok: false, reason: "mined but the receipt has no matching Transfer log", log: `the receipt has no matching ${symbolOf(token)} Transfer log` };
    }
    const bn = receipt && Number.isSafeInteger(Number(receipt.blockNumber)) && Number(receipt.blockNumber) > 0 ? Number(receipt.blockNumber) : null;
    let before = null, after = null;
    if (bn !== null) {
      try { before = await erc20(token).balanceOf(operator, { blockTag: bn - 1 }); after = await erc20(token).balanceOf(operator, { blockTag: bn }); } catch { before = null; after = null; }
    }
    if (before === null || after === null) return { ok: false, reason: "mined but neither the block balances nor a matching Transfer log could confirm it", log: `receipt logs unavailable and block balances unreadable` };
    if (after > before - BigInt(amount)) return { ok: false, reason: "mined but the operator balance did not fall by the amount", log: `receipt logs unavailable and the operator balance did not fall by the amount at block ${bn} (${before} -> ${after})` };
    return { ok: true };
  }

  /** The USDC the swap receipt paid to the operator (pool -> operator), 0 when none is found. */
  function swapOut(receipt, route) {
    let total = 0n;
    for (const l of (receipt && receipt.logs) || []) {
      if (l.removed === true) continue;
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
    leg.swap = { ...(leg.swap || {}), txs: swapTxs(leg), amountIn: amount.toString(), quoteRaw: d.quote.toString(), minOutRaw: d.minOut.toString(), outRaw: (leg.swap && leg.swap.outRaw) || "0", tx: null };
    log(`  swap ${fmt(leg.token, amount)}: quote ${S.fmtUsdc(d.quote)} USDC, minOut ${S.fmtUsdc(d.minOut)}, impact ${d.impactBps} bps`);
    const r = await sendOp(leg, "swap", { to: S.ROUTER, data: S.calldata.swap(params), label: `#${job.tokenId} swap ${fmt(leg.token, amount)}` }, { params, operator }, { raw: amount.toString() });
    if (r.outcome === "ok") {
      clearPending(leg);
      let out = swapOut(r.receipt, route);
      try { const b = await balanceOf(S.USDC); if (out > b) out = b; } catch { /* the receipt amount stands */ }
      leg.doneRaw = (BigInt(leg.doneRaw) + amount).toString();
      leg.swap.outRaw = (BigInt(leg.swap.outRaw) + out).toString();
      leg.swap.tx = r.hash; addSwapTx(leg, r.hash); noteBlock(job, r.receipt);
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

  /** Decimals of a token: the known constants, else decimals() on-chain; null when unreadable or implausible. */
  async function tokenDecimals(token) {
    if (eq(token, S.USDC) || Object.values(S.ROUTES).some((x) => eq(x.token, token))) return decimalsOf(token);
    try { const d = Number(await erc20(token).decimals()); return Number.isInteger(d) && d >= 0 && d <= 36 ? d : null; } catch { return null; }
  }
  /** USDC raw value of `raw` units of a token priced at `usd` per whole unit; null unless the price is a finite number above 0 and decimals are known. */
  function sideValue(raw, usd, dec) {
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || !Number.isInteger(dec)) return null;
    const v = Number(ethers.formatUnits(raw, dec)) * usd;
    return Number.isFinite(v) && v >= 0 ? S.usdcRaw(v) : null;
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
    {
      // Every unswapped delivery is value-capped here, whatever the reason it is unswapped (declined, attempts used up, decision lost its mid).
      // Value: USDC 1:1; else a FRESH pool mid price (re-read now when the decision carries none); else the leg's own raw amount times its
      // per-side USD price recorded at plan time (job.priceUsd). That price is the pool spot price, so this is a best-effort cap, not a
      // guarantee; tokens only ever go to the verified owner. With no value at all the leg is HELD, never delivered.
      let value = d.usdc ? amount : (typeof d.mid === "bigint" ? d.mid : null);
      if (value === null) {
        try { const f = await decideLeg(provider, sw, leg.token, amount); if (typeof f.mid === "bigint") value = f.mid; } catch { /* no fresh mid */ }
        if (halted()) return false;
      }
      if (value === null) {
        const i = eq(leg.token, job.token0) ? 0 : (eq(leg.token, job.token1) ? 1 : -1);
        // The decimals pinned on the job at creation are used; the live read must agree (a token that changes decimals() is refused).
        const pinned = i >= 0 && Array.isArray(job.tokenDecimals) ? job.tokenDecimals[i] : null;
        const live = Number.isInteger(pinned) ? await tokenDecimals(leg.token) : null;
        if (Number.isInteger(pinned) && live !== pinned) return hold(job, leg, live === null ? `decimals() of ${symbolOf(leg.token)} cannot be read now (${pinned} was pinned on the job); refusing` : `decimals() of ${symbolOf(leg.token)} is ${live} now but ${pinned} was pinned on the job; refusing`);
        const dec = Number.isInteger(pinned) ? pinned : null;
        const px = i >= 0 && Array.isArray(job.priceUsd) ? job.priceUsd[i] : null;
        value = i < 0 ? null : sideValue(amount, px, dec);
        if (value === null) {
          // BOTH missing facts are listed, not just the first
          const why = i < 0 ? "the token is not token0/token1 of the job" : [dec === null ? "no pinned decimals" : null, !(typeof px === "number" && Number.isFinite(px) && px > 0) ? "no per-side USD price" : null].filter(Boolean).join(" and ") || "the value is not finite";
          return hold(job, leg, `${symbolOf(leg.token)} would be delivered unswapped (${d.reason}) but no value can be established (no pool mid price, ${why}), so maxUnswappedValueUsdc cannot be applied`);
        }
      }
      if (value > S.usdcRaw(sw.maxUnswappedValueUsdc)) return hold(job, leg, `unswapped value ${S.fmtUsdc(value)} USDC is above maxUnswappedValueUsdc ${sw.maxUnswappedValueUsdc}`);
    }
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

  /**
   * The ledger's swap.outRaw is not trusted: before USDC proceeds move, every swap receipt of the leg is fetched again from the chain
   * and outRaw is capped at the USDC those receipts show the pool paying the operator. Returns null (ok), a hold reason, or "unattributed".
   */
  const proceedsChecked = new WeakMap();
  async function capProceedsToReceipts(job, leg) {
    // Keyed on the leg's joined lowercased swap hashes: a leg that swaps again in the same run gets its receipts read again.
    const key = swapTxs(leg).map((h) => h.toLowerCase()).join(",");
    const seenCheck = proceedsChecked.get(leg);
    let cap = seenCheck && seenCheck.key === key ? seenCheck.cap : undefined;
    if (cap === undefined) {
      const route = Object.values(S.ROUTES).find((x) => eq(x.token, leg.token));
      const hashes = swapTxs(leg);
      if (!route || !hashes.length) return "the swap proceeds cannot be checked: the leg has no swap transaction on record; refusing";
      cap = 0n;
      for (const h of hashes) {
        try {
          const rc = await provider.getTransactionReceipt(h);
          if (!rc) return `the swap receipt ${h} cannot be found; proceeds are not delivered unchecked`;
          const replay = S.receiptReplayProblem(ledger.retired, h, rc.blockNumber, job.collect.block);
          if (replay) return `the swap receipt ${replay}; refusing`;
          if (rc.status === 0) return `the swap receipt ${h} shows a revert; refusing`;
          if (!rc.to || !eq(rc.to, S.ROUTER)) return `the swap receipt ${h} target ${rc.to} is not the router; refusing`;
          if (!rc.from || !eq(rc.from, operator)) return `the swap receipt ${h} sender ${rc.from} is not the operator; refusing`;
          cap += swapOut(rc, route);
        } catch (err) { return `the swap receipt ${h} could not be read (${short(err)}); refusing`; }
      }
      proceedsChecked.set(leg, { key, cap });
    }
    if (BigInt(leg.swap.outRaw || "0") > cap) {
      log(`  ! ledger swap output ${leg.swap.outRaw} exceeds the ${cap} the swap receipt(s) show; capped (tampered ledger)`);
      leg.swap.outRaw = cap.toString();
      save();
    }
    if (cap === 0n) { unattribute(job, leg, "the swap receipt(s) show no USDC paid to the operator"); return "unattributed"; }
    return null;
  }

  async function stepProceeds(job, leg) {
    if (proceedsLeft(leg) > 0n) {
      const bad = await capProceedsToReceipts(job, leg);
      if (bad) return bad === "unattributed" ? false : hold(job, leg, bad);
    }
    const left = proceedsLeft(leg);
    if (left <= 0n) { leg.phase = outstanding(leg) > 0n ? "collected" : "delivered"; return save(); }
    const ok = await payOut(job, leg, S.USDC, left, { splitAllowed: true, kind: "proceeds", credit: (x) => { leg.outDone = (BigInt(leg.outDone || "0") + x).toString(); } });
    if (proceedsLeft(leg) === 0n && leg.phase === "swapped") { leg.phase = outstanding(leg) > 0n ? "collected" : "delivered"; save(); }
    return ok && leg.phase !== "held" && leg.phase !== "stuck";
  }

  /**
   * The ledger is not trusted: before a leg's first send its owed amount must not exceed what the job's own Collect receipt paid to the
   * operator for that token (manager, topic, tokenId and recipient parsed from the chain), and the token must be one of the position's.
   * Returns null, or { reason, fatal }: fatal (a replayed receipt, security L-1) means the caller marks the leg
   * UNATTRIBUTED (it blocks new collects); otherwise the leg is only held. Read once per job per run. A collect older than COLLECT_MAX_AGE_BLOCKS returns { aged: true } and is only held.
   */
  async function verifyAgainstCollect(job, leg) {
    if (!ownerConfigured(job.owner)) return { reason: `the ledger owner ${job.owner} is not a configured owner address (tampered ledger)` };
    const ckey = `${job.manager}:${job.tokenId}:${job.collect && job.collect.tx}`.toLowerCase();
    let c = collectChecks.get(ckey);
    if (!c) {
      try {
        if (!job.collect || typeof job.collect.tx !== "string") throw new Error("the job has no collect transaction");
        const rc = await provider.getTransactionReceipt(job.collect.tx);
        if (!rc) throw new Error("the collect receipt cannot be found");
        if (rc.status === 0) throw new Error("the collect receipt shows a revert");
        if (rc.to && !eq(rc.to, job.manager)) throw new Error(`the collect receipt target ${rc.to} is not the manager`);
        if (rc.from && !eq(rc.from, operator)) throw new Error(`the collect receipt sender ${rc.from} is not the operator`);
        const amounts = parseCollect(rc, job);
        if (!amounts) throw new Error("the collect receipt has no Collect event for this position paying the operator");
        const block = Number(rc.blockNumber);
        if (!Number.isSafeInteger(block) || block <= 0) throw new Error("the collect receipt has no block number");
        const head = Number(await provider.getBlockNumber());
        c = { amounts, tokens: await positionTokens(job.manager, job.tokenId), block, head };
      } catch (err) { return { reason: `the ledger amounts cannot be checked against the collect receipt (${short(err)}); refusing` }; }
      collectChecks.set(ckey, c);
    }
    // The block comes from the chain, never the ledger. A collect that is a retired job's, or not newer than a retired collect of this
    // position, is a replayed receipt (security L-1): refused.
    const replay = S.collectReplayProblem(ledger.retired, job.collect.tx, c.block, job.manager, job.tokenId);
    if (replay) return { reason: `${replay} (replayed receipt of a pruned job, or a tampered ledger)`, fatal: true };
    // M-2: independent of the ledger file, a collect as old as a possibly-pruned job's is refused too.
    const aged = S.collectAgeProblem(c.head, c.block, leg.agedAt);
    // An old collect is only HELD (reported, retried, never unattributed): it must not block other collects. Replays above stay fatal.
    if (aged) {
      // Sticky (S1): the first hold records the head; later runs stay held even if the RPC reports a lower head.
      if (!Number.isSafeInteger(leg.agedAt) && Number.isSafeInteger(c.head) && c.head > 0) { leg.agedAt = c.head; save(); }
      if (!agedLogged.has(ckey)) { agedLogged.add(ckey); log(`  age hold: #${job.tokenId} collect block ${c.block}, chain head seen ${c.head}${leg.agedAt ? `, first held at head ${leg.agedAt}` : ""}`); }
      return { reason: `collect ${job.collect.tx}: ${aged}`, aged: true };
    }
    const warn = S.collectAgeWarning(c.head, c.block);
    if (warn && !warned.has(ckey)) { warned.add(ckey); const w = `#${job.tokenId} collect ${job.collect.tx}: ${warn}`; report.warnings.push(w); log(`  WARNING ${w}`); }
    if (job.collect.block !== c.block) job.collect.block = c.block;
    if (!eq(job.token0, c.tokens[0]) || !eq(job.token1, c.tokens[1])) return { reason: `the ledger tokens ${job.token0}/${job.token1} are not the tokens of position #${job.tokenId}; tampered ledger, refusing` };
    const i = c.tokens.findIndex((t) => eq(t, leg.token));
    if (i < 0) return { reason: `${leg.token} is not a token of position #${job.tokenId}; refusing` };
    // Token0 and token1 are distinct for a pool; the cap is the Collect amount of this token.
    if (BigInt(leg.owedRaw) > c.amounts[i]) return { reason: `ledger owes ${leg.owedRaw} raw ${symbolOf(leg.token)} but the Collect receipt paid ${c.amounts[i]}; tampered ledger, refusing` };
    return null;
  }

  async function advanceLeg(job, leg) {
    for (let i = 0; i < 40 && !halted(); i++) {
      if (leg.pending) { report.pending++; return; }
      if (leg.unattributed) { report.unattributed.push(`#${job.tokenId} ${symbolOf(leg.token)} swap output`); log(`  UNATTRIBUTED ${symbolOf(leg.token)} of #${job.tokenId}: the swap output is unknown; nothing is sent`); return; }
      if (S.legTerminal(leg)) return;
      if (leg.phase === "stuck") { report.stuck.push(`#${job.tokenId} ${symbolOf(leg.token)}`); log(`  STUCK ${symbolOf(leg.token)} of #${job.tokenId}: transfer failed repeatedly; reported, never redirected`); return; }
      const v = await verifyAgainstCollect(job, leg);
      const bad = v && v.reason;
      if (v && v.fatal) { unattribute(job, leg, bad); return; }
      if (bad) { if (leg.phase !== "held" || leg.reason !== bad) hold(job, leg, bad); else { report.held.push(`#${job.tokenId} ${symbolOf(leg.token)}: ${bad}`); log(`  HELD ${symbolOf(leg.token)} of #${job.tokenId}: ${bad}`); } return; }
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
    const dec = sideDecimals.get(`${manager}:${tokenId}`.toLowerCase());
    return { id: `${manager}:${tokenId}:${now()}`, tokenId: String(tokenId), manager, owner, token0, token1, tokenDecimals: Array.isArray(dec) ? [...dec] : [null, null], expect: { a0: String(amounts[0]), a1: String(amounts[1]) }, collect: { tx: null, nonce: null, status: "intent" }, pending: null, legs: [], createdAt: now() };
  }
  /** The onSigned hook of the collect: the pending intent goes to the ledger before the gas reservation. */
  function collectIntent(job) {
    return ({ hash, nonce }) => {
      job.pending = { op: "collect", tx: hash, nonce };
      job.collect.tx = hash; job.collect.nonce = nonce;
      const px = sidePrices.get(`${job.manager}:${job.tokenId}`.toLowerCase()); if (px) job.priceUsd = px;
      ledger.jobs.push(job);
      if (!save()) { ledger.jobs.splice(ledger.jobs.indexOf(job), 1); throw new Error("the sweep ledger cannot be written"); }
    };
  }
  /** The Collect event of a validated receipt: [amount0, amount1] or null. */
  function parseCollect(receipt, job) {
    for (const l of (receipt && receipt.logs) || []) {
      if (l.removed === true) continue;
      if (!eq(l.address, job.manager) || !l.topics || !COLLECT_TOPICS.includes(l.topics[0]) || l.topics.length !== 2) continue;
      if (BigInt(l.topics[1]) !== BigInt(job.tokenId)) continue;
      try {
        const [rcp, a0, a1] = COLLECT_ID.decode(["address", "uint256", "uint256"], l.data);
        if (eq(rcp, operator)) return [a0, a1];
      } catch { /* not this event */ }
    }
    return null;
  }
  /** Legs from the receipt's Collect event; with no such event the job is unattributed (no fallback to simulated amounts). */
  async function attribute(job, receipt) {
    const amounts = parseCollect(receipt, job);
    const how = "Collect event";
    if (!amounts) { job.collect.status = "unattributed"; job.pending = null; log(`  ! #${job.tokenId}: the collected amounts cannot be attributed; nothing is sent, reported`); return save(); }
    job.collect.status = "mined"; job.pending = null; job.legs = [];
    { const b = Number(receipt && receipt.blockNumber); if (Number.isSafeInteger(b) && b > 0) { job.collect.block = b; noteBlock(job, receipt); } }
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
    if (!p.tx) return { state: "void", safe: true, why: "the intent has no transaction hash: it was never signed" };
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
    if (!entry) return { state: "void", safe: true, why: "the intent has no gas reservation: it was never broadcast" };
    try {
      const latest = Number(await provider.getTransactionCount(operator, "latest"));
      if (latest > p.nonce) {
        // A used nonce with no receipt is not proof of replacement: a lagging RPC may simply not have the receipt yet. Ask for the
        // transaction itself; void only when neither the receipt nor the transaction is found on two separate runs.
        if (typeof provider.getTransaction !== "function") return { state: "waiting", why: "the provider cannot look up transactions; waiting" };
        let tx;
        try { tx = (await provider.getTransaction(p.tx)) || null; } catch (err) { return { state: "waiting", why: `transaction lookup failed (${short(err)})` }; }
        if (tx) { p.notFoundRuns = 0; return { state: "waiting", why: `nonce ${p.nonce} is used and transaction ${p.tx} is known to the node but its receipt is not available yet` }; }
        p.notFoundRuns = (Number.isSafeInteger(p.notFoundRuns) ? p.notFoundRuns : 0) + 1;
        save();
        if (p.notFoundRuns >= 2) return { state: "void", why: `nonce ${p.nonce} is used by another transaction; neither a receipt nor the transaction was found on ${p.notFoundRuns} runs` };
        return { state: "waiting", why: `nonce ${p.nonce} is used but neither a receipt nor the transaction was found (run ${p.notFoundRuns} of 2); waiting` };
      }
    } catch (err) { return { state: "waiting", why: `nonce lookup failed (${short(err)})` }; }
    return { state: "waiting", why: `nonce ${p.nonce} is not used yet; the transaction is still pending` };
  }

  async function recoverJob(job) {
    if (!ownerConfigured(job.owner)) { const m = `job ${job.id} names owner ${job.owner}, which is not a configured owner address (tampered or stale ledger)`; log(`  REFUSED: ${m}; nothing is sent for it`); report.held.push(m); return; }
    if (job.collect.status === "unattributed") { report.unattributed.push(`#${job.tokenId}`); return; }
    if (job.pending) {
      const r = await resolve(job.pending, job.manager);
      if (r.state === "mined") {
        if (r.receipt.status === 0) { job.pending = null; job.collect.status = "reverted"; mark(job); save(); log(`  recovery: collect of #${job.tokenId} reverted`); }
        else { log(`  recovery: collect of #${job.tokenId} was mined; attributing from its receipt`); await attribute(job, r.receipt); }
      } else if (r.state === "void" && !r.safe) {
        // Signed and broadcast but not found anywhere: it might still land or already have. Not "voided" (which frees the position for
        // a new collect): unattributed, reported, and it blocks new collects until an operator resolves it.
        job.pending = null; job.collect.status = "unattributed"; save();
        log(`  recovery: collect ${job.collect.tx} of #${job.tokenId} was broadcast but is not found (${r.why}); unattributed, new collects are blocked`);
      } else if (r.state === "void") { job.pending = null; job.collect.status = "voided"; mark(job); save(); log(`  recovery: collect intent of #${job.tokenId} voided (${r.why})`); }
      else { log(`  recovery: collect of #${job.tokenId} waits (${r.why})`); report.pending++; return; }
      if (job.collect.status === "unattributed") { report.unattributed.push(`#${job.tokenId}`); return; }
    }
    for (const leg of job.legs) {
      if (!leg.pending) continue;
      const p = leg.pending;
      const r = await resolve(p, p.op === "swap" ? S.ROUTER : (p.op === "transfer" && p.kind === "proceeds" ? S.USDC : leg.token));
      if (r.state === "waiting") { log(`  recovery: ${p.op} of ${symbolOf(leg.token)} (#${job.tokenId}) waits (${r.why}); the leg is skipped this run`); continue; }
      if (r.state === "void") {
        // Never signed / never broadcast: nothing can have happened, re-evaluate. A swap or transfer that WAS broadcast but cannot be found
        // is held + unattributed instead of being re-evaluated from balances (it might still land or already have landed).
        if (!r.safe && (p.op === "swap" || p.op === "transfer")) { unattribute(job, leg, `${p.op} ${p.tx} has no receipt and is not found on the node (${r.why})`); continue; }
        leg.pending = null; save(); log(`  recovery: ${p.op} intent of ${symbolOf(leg.token)} (#${job.tokenId}) voided (${r.why}); re-evaluated from balances`); continue;
      }
      const ok = r.receipt.status !== 0;
      if (ok && (p.op === "swap" || p.op === "transfer")) {
        // A mined receipt is credited only if it is not a retired job's and is not older than this job's own verified collect (L-1).
        const v = await verifyAgainstCollect(job, leg);
        if (v && v.fatal) { unattribute(job, leg, `${v.reason} (mined ${p.op} ${p.tx})`); continue; }
        if (v) { log(`  recovery: ${p.op} ${p.tx} of ${symbolOf(leg.token)} (#${job.tokenId}) is not credited yet: ${v.reason}`); report.held.push(`#${job.tokenId} ${symbolOf(leg.token)}: ${v.reason}`); continue; }
        const replay = S.receiptReplayProblem(ledger.retired, p.tx, r.receipt.blockNumber, job.collect.block);
        if (replay) { unattribute(job, leg, `recovered ${p.op} ${replay}; not credited`); continue; }
      }
      leg.pending = null;
      const raw = BigInt(p.raw || "0");
      if (p.op === "approve") { if (ok) leg.phase = "approved"; else leg.attempts++; }
      else if (p.op === "swap") {
        if (ok && hashCollision(leg, p.tx)) { unattribute(job, leg, `recovered swap ${p.tx} is already recorded for another leg or job (or is a collect transaction); not credited`); continue; }
        if (ok) {
          const route = S.routeFor(sw, leg.token) || Object.values(S.ROUTES).find((x) => eq(x.token, leg.token));
          const out = route ? swapOut(r.receipt, route) : 0n;
          leg.doneRaw = (BigInt(leg.doneRaw) + raw).toString();
          leg.swap = { ...(leg.swap || {}), txs: swapTxs(leg), outRaw: (BigInt((leg.swap && leg.swap.outRaw) || "0") + out).toString(), tx: p.tx };
          addSwapTx(leg, p.tx); noteBlock(job, r.receipt);
          leg.phase = out > 0n ? "swapped" : "held";
          if (out === 0n) { leg.heldFrom = "collected"; leg.unattributed = true; leg.reason = "swap receipt has no USDC transfer to the operator"; report.unattributed.push(`#${job.tokenId} ${symbolOf(leg.token)} swap output`); }
        } else { leg.attempts++; leg.phase = "collected"; }
      } else if (p.op === "transfer") {
        if (ok) {
          // A mined transfer is credited only with proof: the token's own Transfer(operator -> to, amount) log when the receipt logs are
          // available, else the operator balance fall at the receipt's block. USDC for proceeds, the leg's token otherwise.
          const ptoken = p.kind === "proceeds" ? S.USDC : leg.token;
          if (transferCollision(leg, p.tx)) { unattribute(job, leg, `recovered transfer ${p.tx} is already recorded for another leg or job (or is a collect or swap transaction); not credited`); continue; }
          if (!(await transferProof(r.receipt, ptoken, p.to, raw)).ok) { unattribute(job, leg, `recovered transfer ${p.tx} is mined but neither the block balances nor a matching Transfer log prove it`); continue; }
          if (p.kind === "proceeds") leg.outDone = (BigInt(leg.outDone || "0") + raw).toString();
          else leg.doneRaw = (BigInt(leg.doneRaw) + raw).toString();
          leg.deliver = { to: p.to, raw: raw.toString(), tx: p.tx };
          addTransferTx(leg, p.tx); noteBlock(job, r.receipt);
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
    for (const job of openJobs()) { if (halted()) return; if (!ownerConfigured(job.owner)) continue; await advanceJob(job); }
  }

  // ---- plan (simulate and preflight) --------------------------------------------------------------------------------
  /** Everything a collect would do, from chain reads only. Never writes. */
  async function plan({ manager, tokenId, amounts, usd }) {
    const [t0, t1] = await positionTokens(manager, tokenId);
    const legs = [];
    const px = [0, 1].map((i) => (Array.isArray(usd) && typeof usd[i] === "number" && Number.isFinite(usd[i]) && usd[i] > 0 ? usd[i] : null));
    sidePrices.set(`${manager}:${tokenId}`.toLowerCase(), px);
    const pinDec = [];
    for (const t of [t0, t1]) pinDec.push(await tokenDecimals(t));
    sideDecimals.set(`${manager}:${tokenId}`.toLowerCase(), pinDec);
    for (const [i, [token, amt]] of [[t0, amounts[0]], [t1, amounts[1]]].entries()) {
      if (BigInt(amt) <= 0n) continue;
      const d = await decideLeg(provider, sw, token, BigInt(amt));
      // the per-side USD price and decimals, read only for a leg that has no pool mid price (see unswappedProblem)
      const unpriced = !d.usdc && typeof d.mid !== "bigint";
      legs.push({ token, amount: BigInt(amt), d, usd: px[i], decimals: unpriced ? pinDec[i] : null });
    }
    const vault = await verifyVault(provider, sw, { operator, owners, tokens: [t0, t1], implementations: vaultImplementations });
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
   * The cap reason for a planned leg, or null. Every leg is capped, swapped or not (a forced swap failure must not get around the cap):
   * USDC is valued 1:1, a priced token at the pool mid price (d.mid, also present when the swap was declined for size).
   * A leg with no mid price (no route, route disabled, proof failed, pool/quoter unreadable) is valued from its OWN raw amount times its own
   * per-side USD price (usd0/usd1 of the position, passed through from the price readers), never from the position-wide fee value, which a
   * second token could inflate or deflate. With no such price the leg is REFUSED. The per-side price is the pool spot price, so this is a
   * best-effort cap, not a guarantee; tokens only ever go to the verified owner.
   */
  function unswappedProblem(l) {
    const d = l.d;
    const cap = S.usdcRaw(sw.maxUnswappedValueUsdc);
    const value = d.usdc ? l.amount : (typeof d.mid === "bigint" ? d.mid : sideValue(l.amount, l.usd, l.decimals));
    if (value === null) return `${symbolOf(l.token)} has no pool price (${d.reason || "no mid price"}) and no per-side USD price, so maxUnswappedValueUsdc cannot be applied`;
    if (value > cap) return `${d.swap ? "planned swap of " : "unswapped "}${symbolOf(l.token)} value ${S.fmtUsdc(value)} USDC is above maxUnswappedValueUsdc ${sw.maxUnswappedValueUsdc}`;
    return null;
  }

  /**
   * D2 preflight for one position, before anything moves onto the operator. perOpWei(op) is the worst case of one tx of that op;
   * run = { txCount, dayTxCount, spentRunWei, spent24hWei, lim }.
   */
  async function preflight(pl, { collectWorstWei, perOpWei, run }) {
    // maxUnswappedValueUsdc is applied BEFORE anything is collected, to swap-planned legs too: once the fees are on the operator they can only be
    // swapped or sent on, and a swap that fails on every attempt ends in an unswapped delivery.
    for (const l of pl.legs) { const why = unswappedProblem(l); if (why) return { ok: false, reason: `${why}; the fees stay in the NFT` }; }
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
    for (const w of report.warnings) out.push(`WARNING: ${w}`);
    if (report.pending) out.push(`${report.pending} pending transaction(s) waiting`);
    if (aborted) out.push("run ABORTED");
    return out.join("\n");
  }

  return { start, recover, plan, describe, preflight, newJob, collectIntent, afterCollect, blocker, hasOpenJob, summaryLine, summaryText, problems, report, ledger: () => ledger, openJobs, halted };
}

module.exports = { create, proveRoute, decideLeg, verifyVault, readFacts, symbolOf, fmt, ERC20_ABI, POOL_ABI, QUOTER_ABI, MGR_ABI, COLLECT_TOPICS, TRANSFER_TOPIC };
