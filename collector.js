#!/usr/bin/env node
/**
 * Uniswap v3 fee collector.
 *
 * Modes:
 *   simulate  (default) - read-only. Reports what it would collect. Sends nothing.
 *   collect             - collects fees to the operator wallet. No swapping.
 *   full                - collect, swap non-WETH to WETH, then either unwrap and
 *                         sweep ETH to the owner (sweep.target "ETH", the default)
 *                         or swap the WETH to a stable and send that to the owner
 *                         (sweep.target "USDG"), keeping a gas float in ETH.
 *
 * Run simulate for several days and reconcile against Revert before going live.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_UINT128 = (1n << 128n) - 1n;
const treasury = require("./treasury");
// === pool-scout-and-IL: --compound (fees back into the position; compound.js) ===
const compound = require("./compound");
const COMPOUND = process.argv.includes("--compound");
// === end pool-scout-and-IL ===
const STATE_FILE = path.join(__dirname, "state.json");
const LOG_FILE = path.join(__dirname, "collector.log");

const NPM_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function getApproved(uint256 tokenId) view returns (address)",
];

const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

// SwapRouter02's ExactInputSingleParams has no deadline field (unlike SwapRouter01).
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const WETH_ABI = [...ERC20_ABI, "function withdraw(uint256 wad)", "function deposit() payable"];

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (_) {
    /* logging must never crash the run */
  }
}

// ---------------------------------------------------------------------------
// Rolling 24h gas budget
// ---------------------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { gasSpends: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function gasSpentLast24h(state) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  state.gasSpends = state.gasSpends.filter((s) => s.t > cutoff);
  return state.gasSpends.reduce((acc, s) => acc + BigInt(s.wei), 0n);
}

function recordGas(state, weiSpent) {
  state.gasSpends.push({ t: Date.now(), wei: weiSpent.toString() });
  saveState(state);
}

// ---------------------------------------------------------------------------
// Token metadata cache
// ---------------------------------------------------------------------------

const tokenCache = new Map();

async function tokenInfo(address, provider) {
  const key = address.toLowerCase();
  if (tokenCache.has(key)) return tokenCache.get(key);
  const c = new ethers.Contract(address, ERC20_ABI, provider);
  let symbol = "???";
  let decimals = 18;
  try {
    symbol = await c.symbol();
  } catch {
    /* non-standard token */
  }
  try {
    decimals = Number(await c.decimals());
  } catch {
    /* assume 18 */
  }
  const info = { address, symbol, decimals };
  tokenCache.set(key, info);
  return info;
}

function fmt(amount, decimals, places = 6) {
  const s = ethers.formatUnits(amount, decimals);
  const n = Number(s);
  if (!isFinite(n)) return s;
  return n.toFixed(places);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function discoverTokenIds(npm, owner, cfg) {
  if (cfg.tokenIds && cfg.tokenIds.length > 0) {
    log(`Using ${cfg.tokenIds.length} token ID(s) from config.`);
    return cfg.tokenIds.map((id) => BigInt(id));
  }
  const count = await npm.balanceOf(owner);
  log(`Auto-discovering: owner holds ${count} position NFT(s) (open and closed).`);
  const ids = [];
  for (let i = 0n; i < count; i++) {
    ids.push(await npm.tokenOfOwnerByIndex(owner, i));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Simulation: what would each position pay out?
// ---------------------------------------------------------------------------

/**
 * staticCall on collect() gives the true accrued amount. The position manager
 * pokes the pool with burn(0) internally before computing tokensOwed, so this
 * reflects fees earned right up to the current block -- not the stale
 * tokensOwed0/1 values stored on the position struct.
 */
async function simulatePosition(npm, tokenId, recipient, provider, sender) {
  const pos = await npm.positions(tokenId);

  // The position manager keeps the NFT after you withdraw, so a wallet
  // accumulates closed positions. Skip them before spending a staticCall.
  //
  // Zero liquidity alone is not enough: you can withdraw and leave fees
  // uncollected, in which case tokensOwed still holds a real balance. Only
  // skip when both are empty. For a burnt position tokensOwed is accurate --
  // decreaseLiquidity already credited it -- so it needs no poke to be trusted.
  if (pos.liquidity === 0n && pos.tokensOwed0 === 0n && pos.tokensOwed1 === 0n) {
    return { tokenId, closed: true };
  }

  const t0 = await tokenInfo(pos.token0, provider);
  const t1 = await tokenInfo(pos.token1, provider);

  let amount0 = 0n;
  let amount1 = 0n;
  try {
    // `from` must be the owner or an approved operator. The position manager's
    // isAuthorizedForToken check rejects the default zero address, so omitting
    // this makes every simulation revert.
    const res = await npm.collect.staticCall(
      {
        tokenId,
        recipient,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      },
      { from: sender }
    );
    amount0 = res[0];
    amount1 = res[1];
  } catch (err) {
    log(`  ! simulate failed for #${tokenId}: ${err.shortMessage || err.message}`);
    return null;
  }

  return { tokenId, pos, t0, t1, amount0, amount1, fee: Number(pos.fee) };
}

// ---------------------------------------------------------------------------
// Valuation: express a position's fees in WETH so we can apply a threshold
// ---------------------------------------------------------------------------

async function quoteToWeth(quoter, tokenIn, amountIn, feeTier, wethAddress) {
  if (amountIn === 0n) return 0n;
  if (tokenIn.toLowerCase() === wethAddress.toLowerCase()) return amountIn;
  try {
    const res = await quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut: wethAddress,
      amountIn,
      fee: feeTier,
      sqrtPriceLimitX96: 0,
    });
    return res[0];
  } catch (err) {
    log(`  ! quote failed (${tokenIn} -> WETH @ ${feeTier}): ${err.shortMessage || err.message}`);
    return 0n;
  }
}

async function quoteSingle(quoter, tokenIn, tokenOut, amountIn, feeTier) {
  if (amountIn === 0n) return 0n;
  try {
    const res = await quoter.quoteExactInputSingle.staticCall({ tokenIn, tokenOut, amountIn, fee: feeTier, sqrtPriceLimitX96: 0 });
    return res[0];
  } catch (err) {
    log(`  ! quote failed (${tokenIn} -> ${tokenOut} @ ${feeTier}): ${err.shortMessage || err.message}`);
    return 0n;
  }
}

/** The sweep target: ETH (unwrap and send) or a stable token (swap and send). */
function sweepTarget(cfg) {
  const t = String((cfg.sweep && cfg.sweep.target) || "ETH").toUpperCase();
  if (t === "ETH") return { kind: "eth" };
  if (!cfg.sweep.targetToken || !cfg.sweep.targetFeeTier) {
    throw new Error(`sweep.target is ${t} but sweep.targetToken / sweep.targetFeeTier are not set`);
  }
  return { kind: "token", address: ethers.getAddress(cfg.sweep.targetToken), feeTier: Number(cfg.sweep.targetFeeTier), symbol: t };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mode = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=simulate").split("=")[1];
  if (!["simulate", "collect", "full"].includes(mode)) {
    console.error(`Unknown mode "${mode}". Use simulate | collect | full.`);
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId);

  // Confirm we're on the chain we think we're on.
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(cfg.chainId)) {
    log(`ABORT: RPC reports chainId ${net.chainId}, config expects ${cfg.chainId}.`);
    process.exit(1);
  }

  log(`=== mode=${mode} chainId=${net.chainId} ===`);

  // -- Load operator wallet (not needed for simulate) ------------------------
  let wallet = null;
  if (mode !== "simulate") {
    const keystorePath = process.env.LP_KEYSTORE_PATH;
    const passphrase = process.env.LP_KEYSTORE_PASS;
    if (!keystorePath || !passphrase) {
      log("ABORT: LP_KEYSTORE_PATH and LP_KEYSTORE_PASS must be set. Use run-collector.ps1.");
      process.exit(1);
    }
    const json = fs.readFileSync(keystorePath, "utf8");
    wallet = (await ethers.Wallet.fromEncryptedJson(json, passphrase)).connect(provider);
    log(`Operator: ${wallet.address}`);

    const bal = await provider.getBalance(wallet.address);
    log(`Operator gas float: ${ethers.formatEther(bal)} ETH`);
    if (bal < ethers.parseEther(cfg.thresholds.minOperatorGasBalanceEth)) {
      log(`WARNING: operator gas float is below ${cfg.thresholds.minOperatorGasBalanceEth} ETH. Top it up.`);
    }
  }

  // -- Gas price guard -------------------------------------------------------
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const gasGwei = Number(ethers.formatUnits(gasPrice, "gwei"));
  log(`Network gas: ${gasGwei.toFixed(4)} gwei`);
  if (gasGwei > Number(cfg.thresholds.maxGasPriceGwei)) {
    log(`ABORT: gas ${gasGwei.toFixed(4)} gwei exceeds cap ${cfg.thresholds.maxGasPriceGwei}.`);
    return;
  }

  // -- Daily gas budget ------------------------------------------------------
  const state = loadState();
  const spent24h = gasSpentLast24h(state);
  const cap = ethers.parseEther(cfg.thresholds.dailyGasCapEth);
  if (mode !== "simulate" && spent24h >= cap) {
    log(`ABORT: 24h gas cap reached (${ethers.formatEther(spent24h)} / ${cfg.thresholds.dailyGasCapEth} ETH).`);
    return;
  }

  // -- Contracts -------------------------------------------------------------
  const npmRead = new ethers.Contract(cfg.contracts.positionManager, NPM_ABI, provider);
  const quoter = new ethers.Contract(cfg.contracts.quoterV2, QUOTER_ABI, provider);
  const weth = cfg.contracts.weth;

  const target = sweepTarget(cfg);
  const treasurySettings = await treasury.effectiveSettings(cfg, provider);
  if (treasurySettings.tba) log(`LOKOVault: split ${treasurySettings.pct}% (${treasurySettings.pctSource}) -> ${treasurySettings.tba}`);
  const ctx = { mode, cfg, provider, wallet, npmRead, quoter, weth, state, cap, gasPrice, target, treasurySettings };

  // Owners: the main wallet, then every wallets.json entry marked collect: true
  // (their fees are delivered back to their own address).
  const owners = [{ address: cfg.ownerAddress, label: "Main wallet", sweepTo: cfg.sweepDestination, main: true }];
  try {
    const wj = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets.json"), "utf8"));
    if (wj.owner && wj.owner.label) owners[0].label = wj.owner.label;
    for (const w of wj.watched || []) {
      if (!w || !w.collect || !ethers.isAddress(w.address)) continue;
      const address = ethers.getAddress(w.address);
      if (address.toLowerCase() === cfg.ownerAddress.toLowerCase()) continue;
      owners.push({ address, label: w.label || address, sweepTo: address, main: false });
    }
  } catch {}
  log(`Owners in this run: ${owners.map((o) => o.label).join(", ")}`);

  for (const owner of owners) {
    try {
      await runOwner(ctx, owner);
    } catch (err) {
      log(`  ! ${owner.label}: ${err.shortMessage || err.message}`);
    }
    if (mode !== "simulate" && gasSpentLast24h(state) >= cap) {
      log("24h gas cap reached; remaining owners skipped.");
      break;
    }
  }
  log("=== done ===");
}

/**
 * One full pass for one owner wallet: discover its positions, simulate, collect
 * to the operator, swap to the sweep target and deliver to owner.sweepTo.
 * Extra owners (wallets.json `collect: true`) get their fees sent back to
 * themselves; the main owner keeps the configured sweepDestination.
 */
async function runOwner(ctx, owner) {
  const { mode, cfg, provider, wallet, npmRead, quoter, weth, state, cap, gasPrice, target, treasurySettings } = ctx;
  log(`--- ${owner.label} (${owner.address}) ---`);
  // Fees are collected to the operator so it can swap them. In collect-only
  // mode there is nothing to swap, so send straight to the owner instead and
  // skip the hot-wallet hop entirely.
  const recipient = mode === "full" ? (wallet ? wallet.address : owner.address) : owner.address;
  // eth_call sender for fee simulation: the operator once we have one,
  // otherwise the owner. Either satisfies isAuthorizedForToken.
  const simSender = wallet ? wallet.address : owner.address;
  const before = { weth: 0n, target: 0n, eth: 0n };
  if (wallet) {
    before.weth = await new ethers.Contract(weth, ERC20_ABI, provider).balanceOf(wallet.address);
    before.eth = await provider.getBalance(wallet.address);
    if (target.kind === "token") before.target = await new ethers.Contract(target.address, ERC20_ABI, provider).balanceOf(wallet.address);
  }
  // -- Approval check --------------------------------------------------------
  if (mode !== "simulate") {
    const blanket = await npmRead.isApprovedForAll(owner.address, wallet.address);
    log(`Operator approvalForAll on positions: ${blanket}`);
    if (!blanket) {
      log("  (per-token approvals will be checked individually)");
    }
  }

  // -- Discover and simulate -------------------------------------------------
  const denylist = new Set((cfg.denylist || []).map(String));
  const ids = (await discoverTokenIds(npmRead, owner.address, owner.main ? cfg : { ...cfg, tokenIds: [] })).filter((id) => {
    if (denylist.has(id.toString())) {
      log(`Skipping #${id} (denylisted).`);
      return false;
    }
    return true;
  });

  const minWeth = ethers.parseEther(cfg.thresholds.minWethPerPosition);
  const eligible = [];
  let totalWethValue = 0n;

  let closedCount = 0;

  for (const id of ids) {
    const sim = await simulatePosition(npmRead, id, recipient, provider, simSender);
    if (!sim) continue;
    if (sim.closed) {
      closedCount++;
      continue;
    }

    const { t0, t1, amount0, amount1, fee } = sim;
    const v0 = await quoteToWeth(quoter, t0.address, amount0, fee, weth);
    const v1 = await quoteToWeth(quoter, t1.address, amount1, fee, weth);
    const value = v0 + v1;
    sim.wethValue = value;
    totalWethValue += value;

    const pair = `${t0.symbol}/${t1.symbol}`;
    log(
      `#${id} ${pair} ${fee / 10000}%  ` +
        `${fmt(amount0, t0.decimals)} ${t0.symbol} + ${fmt(amount1, t1.decimals)} ${t1.symbol}  ` +
        `≈ ${ethers.formatEther(value)} WETH`
    );

    if (value < minWeth) {
      log(`  below threshold (${cfg.thresholds.minWethPerPosition} WETH) — skipping`);
      continue;
    }
    eligible.push(sim);
  }

  // -- Uniswap v4 positions (collect-v4.js) -----------------------------------
  // Fees are read the same way the dashboard does; collection needs the
  // operator approved on the v4 PositionManager (node approve-operator.js --v4).
  const v4c = cfg.v4Collect && cfg.v4Collect.enabled ? require("./collect-v4").create({ provider, cfg: { ...cfg, ownerAddress: owner.address }, log }) : null;
  const eligibleV4 = [];
  let v4Open = 0, v4Closed = 0;
  if (v4c) {
    for (const id of v4c.knownIds(owner.main ? null : owner.address)) {
      if (denylist.has(String(id))) continue;
      let sim;
      try {
        sim = await v4c.simulate(id);
      } catch (err) {
        log(`  ! v4 #${id}: ${err.shortMessage || err.message}`);
        continue;
      }
      if (!sim) continue;
      if (sim.closed) { v4Closed++; continue; }
      v4Open++;
      // Value in WETH: native ETH counts 1:1, ERC-20s through the v3 quoter at the pool's own tier.
      const val = async (t, amt) => (amt === 0n ? 0n : t.native || t.address.toLowerCase() === weth.toLowerCase() ? amt : await quoteToWeth(quoter, t.address, amt, sim.fee, weth));
      const v0 = await val(sim.t0, sim.amount0), v1 = await val(sim.t1, sim.amount1);
      sim.wethValue = v0 + v1;
      totalWethValue += sim.wethValue;
      log(`v4 #${id} ${sim.t0.symbol}/${sim.t1.symbol} ${sim.fee / 10000}%${sim.hooks ? " (hooks)" : ""}  ${fmt(sim.amount0, sim.t0.decimals)} ${sim.t0.symbol} + ${fmt(sim.amount1, sim.t1.decimals)} ${sim.t1.symbol}  ≈ ${ethers.formatEther(sim.wethValue)} WETH`);
      if (sim.wethValue < minWeth) { log(`  below threshold (${cfg.thresholds.minWethPerPosition} WETH) — skipping`); continue; }
      eligibleV4.push(sim);
    }
    if (v4Open + v4Closed) log(`v4: ${v4Open} open, ${v4Closed} closed, ${eligibleV4.length} eligible.`);
  }

  const openCount = ids.length - closedCount;
  log(`Skipped ${closedCount} closed position(s); ${openCount} open.`);
  log(`Total collectable across open positions: ≈ ${ethers.formatEther(totalWethValue)} WETH`);
  log(`Eligible for collection: ${eligible.length}/${openCount}${v4c ? ` (v3) + ${eligibleV4.length}/${v4Open} (v4)` : ""}`);

  if (target.kind === "token") {
    const tinfo = await tokenInfo(target.address, provider);
    const eligibleWeth = [...eligible, ...eligibleV4].reduce((s, e) => s + e.wethValue, 0n);
    const out = await quoteSingle(quoter, weth, target.address, eligibleWeth, target.feeTier);
    log(`Sweep target ${tinfo.symbol}: the eligible ≈ ${ethers.formatEther(eligibleWeth)} WETH would convert to ≈ ${fmt(out, tinfo.decimals, 2)} ${tinfo.symbol} at current prices.`);
    const ts = treasurySettings;
    if (ts.enabled) {
      const sp = treasury.split(out, ts.pct);
      log(`Treasury split: ${fmt(sp.toVault, tinfo.decimals, 2)} ${tinfo.symbol} (${ts.pct}%) → LOKOVault TBA ${ts.tba}`);
      log(`Owner receives: ${fmt(sp.toOwner, tinfo.decimals, 2)} ${tinfo.symbol} → ${owner.label}`);
    } else {
      log(`Treasury split: off (treasuryTBA not set in config.json); owner receives ≈ ${fmt(out, tinfo.decimals, 2)} ${tinfo.symbol}.`);
    }
  }

  if (mode === "simulate") {
    // === pool-scout-and-IL: --compound plan in simulate mode ===
    if (COMPOUND) {
      const splitPct = treasurySettings.enabled ? treasurySettings.pct : 0;
      const f = (a, t) => `${fmt(a, t.decimals)} ${t.symbol}`;
      for (const sim of eligible) {
        const pl = compound.plan(sim, splitPct);
        log(`Compound plan #${sim.tokenId}: reinvest ${f(pl.reinvest0, sim.t0)} + ${f(pl.reinvest1, sim.t1)} into the position (if in range; otherwise sent to the owner); vault share ${f(pl.vault0, sim.t0)} + ${f(pl.vault1, sim.t1)} (${splitPct}%) via USDG`);
      }
      if (eligibleV4.length) log(`--compound: ${eligibleV4.length} v4 position(s) would be skipped (run without --compound to collect them).`);
    }
    // === end pool-scout-and-IL ===
    log("Simulate mode — nothing sent. Reconcile the above against Revert before going live.");
    return;
  }
  if (eligible.length === 0 && eligibleV4.length === 0) {
    log("Nothing above threshold. Done.");
    return;
  }

  const npmWrite = npmRead.connect(wallet);

  // -- Collect ---------------------------------------------------------------
  const collected = new Map(); // token address -> amount received

  for (const sim of eligible) {
    try {
      const tx = await npmWrite.collect({
        tokenId: sim.tokenId,
        recipient,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128,
      });
      log(`collect #${sim.tokenId} -> ${tx.hash}`);
      const rcpt = await tx.wait();
      const cost = rcpt.gasUsed * rcpt.gasPrice;
      recordGas(state, cost);
      log(`  confirmed in block ${rcpt.blockNumber}, gas ${ethers.formatEther(cost)} ETH`);
      sim.collectedOk = true;

      for (const [addr, amt] of [
        [sim.t0.address, sim.amount0],
        [sim.t1.address, sim.amount1],
      ]) {
        if (amt > 0n) {
          collected.set(addr, (collected.get(addr) || 0n) + amt);
        }
      }
    } catch (err) {
      log(`  ! collect failed for #${sim.tokenId}: ${err.shortMessage || err.message}`);
    }

    if (gasSpentLast24h(state) >= cap) {
      log("24h gas cap hit mid-run. Stopping.");
      break;
    }
  }

  // === pool-scout-and-IL: v4 positions are not compounded (Permit2 settlement); skip them in --compound runs ===
  if (COMPOUND && eligibleV4.length) {
    log(`--compound: ${eligibleV4.length} v4 position(s) skipped; run without --compound to collect them.`);
    eligibleV4.length = 0;
  }
  // === end pool-scout-and-IL ===
  // -- Collect v4 ------------------------------------------------------------
  if (v4c && eligibleV4.length) {
    for (const sim of eligibleV4) {
      if (gasSpentLast24h(state) >= cap) { log("24h gas cap hit. Stopping."); break; }
      try {
        if (!(await v4c.approved(sim.tokenId, wallet.address))) {
          log(`  ! v4 #${sim.tokenId}: operator is not approved on the v4 PositionManager. Owner: node approve-operator.js --v4`);
          continue;
        }
        const dry = await v4c.dryRun(sim, recipient, wallet.address);
        if (!dry.ok) { log(`  ! v4 #${sim.tokenId}: simulation reverted (${dry.error}); not sending`); continue; }
        const rcpt = await v4c.collect(sim, recipient, wallet);
        const cost = rcpt.gasUsed * rcpt.gasPrice;
        recordGas(state, cost);
        log(`  confirmed in block ${rcpt.blockNumber}, gas ${ethers.formatEther(cost)} ETH`);
        for (const [t, amt] of [[sim.t0, sim.amount0], [sim.t1, sim.amount1]]) {
          if (amt > 0n && !t.native) collected.set(t.address, (collected.get(t.address) || 0n) + amt);
        }
      } catch (err) {
        log(`  ! v4 collect failed for #${sim.tokenId}: ${err.shortMessage || err.message}`);
      }
    }
    // Native ETH fees landed in the operator's ETH balance; wrap what sits
    // above the gas reserve so the sweep below treats it as collected WETH.
    if (mode === "full" && cfg.sweep && cfg.sweep.enabled) {
      const reserveWei = ethers.parseEther(cfg.sweep.keepGasReserveEth);
      const ethBal = await provider.getBalance(wallet.address);
      const excess = ethBal - reserveWei - ethers.parseEther("0.0005");
      if (excess > 0n) {
        try {
          const wtx = await new ethers.Contract(weth, WETH_ABI, wallet).deposit({ value: excess });
          log(`wrap ${ethers.formatEther(excess)} ETH (v4 fees) -> WETH -> ${wtx.hash}`);
          const wr = await wtx.wait();
          recordGas(state, wr.gasUsed * wr.gasPrice);
        } catch (err) {
          log(`  ! wrap failed: ${err.shortMessage || err.message}`);
        }
      }
    }
  }

  // === pool-scout-and-IL: --compound ==========================================
  // Each collected v3 position: the vault's share of both fee tokens stays in
  // the swap-and-sweep pipeline (whose whole USDG output then goes to the
  // vault), the rest is reinvested into the same position when it is in
  // range, or handed to the owner as-is when it is not. The owner therefore
  // receives no USDG in a --compound pass.
  let passSplitPct = null;
  if (COMPOUND) {
    const tsC = treasurySettings;
    const splitPct = tsC.enabled ? tsC.pct : 0;
    for (const sim of eligible) {
      // In range right now? (single-sided increases are legal but the spec sweeps out-of-range fees instead)
      let inRange = true;
      try {
        const factory = new ethers.Contract(cfg.contracts.factory, ["function getPool(address,address,uint24) view returns (address)"], provider);
        const poolAddr = await factory.getPool(sim.t0.address, sim.t1.address, sim.fee);
        const slot0 = await new ethers.Contract(poolAddr, ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)"], provider).slot0();
        const tick = Number(slot0.tick);
        inRange = tick >= Number(sim.pos.tickLower) && tick < Number(sim.pos.tickUpper);
      } catch {}
      const pl = compound.plan({ ...sim, inRange }, splitPct);
      const f = (a, t) => `${fmt(a, t.decimals)} ${t.symbol}`;
      if (mode === "simulate" || !wallet) {
        log(`Compound plan #${sim.tokenId}${inRange ? "" : " (out of range → owner receives the tokens)"}: reinvest ${f(pl.reinvest0, sim.t0)} + ${f(pl.reinvest1, sim.t1)}; vault share ${f(pl.vault0, sim.t0)} + ${f(pl.vault1, sim.t1)} (${splitPct}%) via USDG`);
        continue;
      }
      if (!sim.collectedOk) continue;
      let result = null;
      if (inRange) {
        try {
          result = await compound.compoundV3({ wallet, npmAddress: cfg.contracts.positionManager, plan: pl, owner: owner.address, log });
          if (result.gasUsed) recordGas(state, result.gasUsed);
        } catch (err) {
          log(`  ! compound failed for #${sim.tokenId}: ${err.shortMessage || err.message} — tokens go to the owner instead`);
          result = { ok: false, error: err.shortMessage || err.message };
        }
      }
      if (!inRange || !result || !result.ok) {
        // Not reinvested: the owner's share goes out as raw tokens.
        for (const [t, amt] of [[sim.t0, pl.reinvest0], [sim.t1, pl.reinvest1]]) {
          if (amt <= 0n) continue;
          try {
            const c = new ethers.Contract(t.address, ERC20_ABI, wallet);
            const held = await c.balanceOf(wallet.address);
            const send = held < amt ? held : amt;
            if (send > 0n) {
              const ttx = await c.transfer(owner.address, send);
              log(`send ${f(send, t)} -> ${owner.address} (not compounded) -> ${ttx.hash}`);
              const tr = await ttx.wait();
              recordGas(state, tr.gasUsed * tr.gasPrice);
            }
          } catch (err) {
            log(`  ! transfer of ${t.symbol} to the owner failed: ${err.shortMessage || err.message}`);
          }
        }
      }
      // Only the vault's share of these tokens remains for the pipeline.
      for (const [t, r] of [[sim.t0, pl.reinvest0], [sim.t1, pl.reinvest1]]) {
        const cur = collected.get(t.address) || 0n;
        collected.set(t.address, cur > r ? cur - r : 0n);
      }
      passSplitPct = 100;
      compound.appendLog({
        timestamp: new Date().toISOString(), wallet: owner.label, tokenId: String(sim.tokenId), pair: `${sim.t0.symbol}/${sim.t1.symbol}`, inRange,
        reinvest0: fmt(pl.reinvest0, sim.t0.decimals), reinvest1: fmt(pl.reinvest1, sim.t1.decimals), vault0: fmt(pl.vault0, sim.t0.decimals), vault1: fmt(pl.vault1, sim.t1.decimals), splitPct,
        compounded: !!(result && result.ok), txHash: result && result.txHash, liquidityAdded: result && result.liquidity ? result.liquidity.toString() : null,
        used0: result && result.used0 != null ? fmt(result.used0, sim.t0.decimals) : null, used1: result && result.used1 != null ? fmt(result.used1, sim.t1.decimals) : null, note: (result && (result.note || result.error)) || null,
      });
    }
  }
  // === end pool-scout-and-IL ===

  if (mode === "collect") {
    log(`Collect-only mode. Fees sent to ${recipient}. Done.`);
    return;
  }

  // -- Swap non-WETH balances into WETH --------------------------------------
  const router = new ethers.Contract(cfg.contracts.swapRouter02, ROUTER_ABI, wallet);
  const maxSwap = ethers.parseEther(cfg.thresholds.maxSwapValueWeth);
  const slippageBps = BigInt(cfg.thresholds.slippageBps);

  // Pick the fee tier to route through: use the tier of the position the token
  // came from. That is the pool you are already providing liquidity to, so it
  // is the one you know has depth for this pair.
  const feeTierFor = new Map();

  // Explicit overrides win. Inferring the tier from "whichever eligible
  // position was seen first" is unstable when you hold the same pair in more
  // than one tier: discovery is ordered by token id, so a position crossing
  // the threshold can silently re-route a swap through a different pool.
  const overrides = cfg.swapFeeTierOverrides || {};
  for (const [addr, tier] of Object.entries(overrides)) {
    if (addr.startsWith("_")) continue;
    feeTierFor.set(ethers.getAddress(addr), Number(tier));
  }

  for (const sim of [...eligible, ...eligibleV4]) {
    for (const t of [sim.t0.address, sim.t1.address]) {
      if (t === ethers.ZeroAddress || t.toLowerCase() === weth.toLowerCase()) continue;
      const known = feeTierFor.get(t);
      if (known === undefined) {
        feeTierFor.set(t, sim.fee);
      } else if (known !== sim.fee && overrides[t] === undefined) {
        // Same token, two tiers, no override: refuse rather than guess.
        log(`  ! ${sim.t0.symbol}/${sim.t1.symbol} appears at both ${known / 10000}% and ${sim.fee / 10000}%.`);
        log(`    Set swapFeeTierOverrides for this token in config.json. Not swapping it.`);
        feeTierFor.set(t, null);
      }
    }
  }

  for (const [tokenAddr, collectedAmt] of collected) {
    if (tokenAddr.toLowerCase() === weth.toLowerCase()) continue;
    if (target.kind === "token" && tokenAddr.toLowerCase() === target.address.toLowerCase()) continue; // forwarded as-is below

    const info = await tokenInfo(tokenAddr, provider);
    const erc20 = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
    const held = await erc20.balanceOf(wallet.address);
    // Swap only what this owner's positions paid out in this pass.
    const balance = held < collectedAmt ? held : collectedAmt;
    if (balance === 0n) continue;

    const feeTier = feeTierFor.get(tokenAddr);
    if (feeTier === undefined || feeTier === null) {
      log(`  ! no known fee tier for ${info.symbol}, skipping swap`);
      continue;
    }

    // Fresh quote immediately before the swap, then apply slippage tolerance.
    const quoted = await quoteToWeth(quoter, tokenAddr, balance, feeTier, weth);
    if (quoted === 0n) {
      log(`  ! could not quote ${info.symbol}, skipping swap`);
      continue;
    }
    if (quoted > maxSwap) {
      log(`  ! ${info.symbol} swap would be ${ethers.formatEther(quoted)} WETH, over maxSwapValueWeth. Skipping — swap this one by hand.`);
      continue;
    }

    const minOut = (quoted * (10000n - slippageBps)) / 10000n;

    try {
      const allowance = await erc20.allowance(wallet.address, cfg.contracts.swapRouter02);
      if (allowance < balance) {
        // Exact-amount approval rather than unlimited: the operator is a hot
        // wallet, so leaving a standing infinite allowance is unnecessary risk.
        const atx = await erc20.approve(cfg.contracts.swapRouter02, balance);
        log(`approve ${info.symbol} -> ${atx.hash}`);
        const arcpt = await atx.wait();
        recordGas(state, arcpt.gasUsed * arcpt.gasPrice);
      }

      const stx = await router.exactInputSingle({
        tokenIn: tokenAddr,
        tokenOut: weth,
        fee: feeTier,
        recipient: wallet.address,
        amountIn: balance,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0,
      });
      log(
        `swap ${fmt(balance, info.decimals)} ${info.symbol} -> WETH ` +
          `(quote ${ethers.formatEther(quoted)}, min ${ethers.formatEther(minOut)}) -> ${stx.hash}`
      );
      const srcpt = await stx.wait();
      recordGas(state, srcpt.gasUsed * srcpt.gasPrice);
      log(`  confirmed in block ${srcpt.blockNumber}`);
    } catch (err) {
      log(`  ! swap failed for ${info.symbol}: ${err.shortMessage || err.message}`);
      log(`    tokens remain in the operator wallet — swap manually or rerun.`);
    }
  }

  // -- Unwrap and sweep ------------------------------------------------------
  if (!cfg.sweep.enabled) {
    log("Sweep disabled. WETH left in operator wallet.");
    return;
  }

  const wethC = new ethers.Contract(weth, WETH_ABI, wallet);
  // Only what this pass produced leaves the operator: balances above what it
  // held when the pass started stay put (they belong to another owner's pass,
  // or are leftovers to sort out by hand).
  const wethNow = await wethC.balanceOf(wallet.address);
  let wethBal = wethNow > before.weth ? wethNow - before.weth : 0n;
  const reserve = ethers.parseEther(cfg.sweep.keepGasReserveEth);

  if (target.kind === "token") {
    const tinfo = await tokenInfo(target.address, provider);
    const targetC = new ethers.Contract(target.address, ERC20_ABI, wallet);

    // 1. Gas float first: the operator pays gas in ETH, so if it has slipped
    //    under the reserve, unwrap just enough WETH to refill it.
    const ethBal0 = await provider.getBalance(wallet.address);
    if (ethBal0 < reserve && wethBal > 0n) {
      const topUp = reserve - ethBal0 < wethBal ? reserve - ethBal0 : wethBal;
      try {
        const utx = await wethC.withdraw(topUp);
        log(`gas top-up: unwrap ${ethers.formatEther(topUp)} WETH -> ${utx.hash}`);
        const urcpt = await utx.wait();
        recordGas(state, urcpt.gasUsed * urcpt.gasPrice);
        wethBal -= topUp;
      } catch (err) {
        log(`  ! gas top-up unwrap failed: ${err.shortMessage || err.message}`);
      }
    }

    // 2. The rest of the WETH becomes the target token, delivered straight to
    //    the owner (the router pays out to `recipient`, so no extra transfer).
    if (wethBal > 0n) {
      const quoted = await quoteSingle(quoter, weth, target.address, wethBal, target.feeTier);
      if (quoted === 0n) {
        log(`  ! could not quote WETH -> ${tinfo.symbol}; WETH left in operator wallet.`);
      } else if (wethBal > maxSwap) {
        log(`  ! ${ethers.formatEther(wethBal)} WETH is over maxSwapValueWeth. Left in operator wallet — convert by hand.`);
      } else {
        const minOut = (quoted * (10000n - slippageBps)) / 10000n;
        try {
          const allowance = await wethC.allowance(wallet.address, cfg.contracts.swapRouter02);
          if (allowance < wethBal) {
            const atx = await wethC.approve(cfg.contracts.swapRouter02, wethBal);
            log(`approve WETH -> ${atx.hash}`);
            const arcpt = await atx.wait();
            recordGas(state, arcpt.gasUsed * arcpt.gasPrice);
          }
          // The swap pays out to the operator; the split below decides where it goes.
          const stx = await router.exactInputSingle({
            tokenIn: weth,
            tokenOut: target.address,
            fee: target.feeTier,
            recipient: wallet.address,
            amountIn: wethBal,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0,
          });
          log(
            `swap ${ethers.formatEther(wethBal)} WETH -> ${tinfo.symbol} ` +
              `(quote ${fmt(quoted, tinfo.decimals, 2)}, min ${fmt(minOut, tinfo.decimals, 2)}) -> ${stx.hash}`
          );
          const srcpt = await stx.wait();
          recordGas(state, srcpt.gasUsed * srcpt.gasPrice);
          log(`  confirmed in block ${srcpt.blockNumber}`);
        } catch (err) {
          log(`  ! WETH -> ${tinfo.symbol} swap failed: ${err.shortMessage || err.message}`);
          log(`    WETH remains in the operator wallet — rerun or convert by hand.`);
        }
      }
    }

    // 3. Everything in the sweep token that this pass produced (swap output plus
    //    fees that arrived as the target token) is split: feeSplitPct % to the
    //    LOKOVault TBA, the rest to the owner. A failed vault transfer is logged
    //    and the owner receives the whole amount, so nothing is stranded.
    const tNow = await targetC.balanceOf(wallet.address);
    const tBal = tNow > before.target ? tNow - before.target : 0n;
    if (tBal > 0n) {
      const ts = passSplitPct != null ? { ...treasurySettings, pct: passSplitPct, enabled: true } : treasurySettings; // --compound: the pipeline holds the vault's share only
      const sp = ts.enabled ? treasury.split(tBal, ts.pct) : { toVault: 0n, toOwner: tBal };
      let splitTx = null, ownerTx = null, status = ts.enabled ? "ok" : "off";
      if (sp.toVault > 0n) {
        try {
          const vtx = await targetC.transfer(ts.tba, sp.toVault);
          log(`treasury split ${fmt(sp.toVault, tinfo.decimals, 2)} ${tinfo.symbol} (${ts.pct}%) -> LOKOVault TBA ${ts.tba} -> ${vtx.hash}`);
          const vr = await vtx.wait();
          recordGas(state, vr.gasUsed * vr.gasPrice);
          splitTx = vtx.hash;
        } catch (err) {
          log(`  ! treasury split failed: ${err.shortMessage || err.message} — owner receives the full amount this time`);
          status = "failed";
          sp.toOwner = tBal;
          sp.toVault = 0n;
        }
      }
      try {
        const ttx = await targetC.transfer(owner.sweepTo, sp.toOwner);
        log(`send ${fmt(sp.toOwner, tinfo.decimals, 2)} ${tinfo.symbol} -> ${owner.sweepTo} -> ${ttx.hash}`);
        const trcpt = await ttx.wait();
        recordGas(state, trcpt.gasUsed * trcpt.gasPrice);
        ownerTx = ttx.hash;
      } catch (err) {
        log(`  ! ${tinfo.symbol} transfer failed: ${err.shortMessage || err.message}`);
      }
      if (ts.enabled || ts.tba) {
        try {
          const pos = [...eligible, ...eligibleV4];
          treasury.appendLedger({
            timestamp: new Date().toISOString(),
            wallet: owner.label,
            walletAddress: owner.address,
            positionId: pos.length ? String(pos[0].tokenId) : null,
            positionIds: pos.map((e) => String(e.tokenId)),
            pair: pos.length ? `${pos[0].t0.symbol}/${pos[0].t1.symbol}` : null,
            totalCollectedUsdg: Number(fmt(tBal, tinfo.decimals, 6)),
            splitPct: ts.pct,
            splitUsdg: Number(fmt(sp.toVault, tinfo.decimals, 6)),
            ownerReceived: Number(fmt(sp.toOwner, tinfo.decimals, 6)),
            tbaAddress: ts.tba,
            splitTxHash: splitTx,
            ownerTxHash: ownerTx,
            status,
          });
        } catch (err) {
          log(`  ! could not write fee-split-ledger.json: ${err.message}`);
        }
      }
    }

    log(`Operator gas float now ${ethers.formatEther(await provider.getBalance(wallet.address))} ETH (reserve ${cfg.sweep.keepGasReserveEth}).`);
    log(`24h gas spend now ${ethers.formatEther(gasSpentLast24h(state))} / ${cfg.thresholds.dailyGasCapEth} ETH`);
    log(`=== ${owner.label}: done ===`);
    return;
  }

  if (wethBal > 0n) {
    try {
      const utx = await wethC.withdraw(wethBal);
      log(`unwrap ${ethers.formatEther(wethBal)} WETH -> ${utx.hash}`);
      const urcpt = await utx.wait();
      recordGas(state, urcpt.gasUsed * urcpt.gasPrice);
    } catch (err) {
      log(`  ! unwrap failed: ${err.shortMessage || err.message}`);
    }
  }

  const ethNow = await provider.getBalance(wallet.address);
  const ethBal = owner.main ? ethNow : (ethNow > before.eth ? before.eth + (ethNow - before.eth) : 0n);
  if (ethBal <= reserve) {
    log(`Operator ETH (${ethers.formatEther(ethBal)}) at or below gas reserve. Nothing to sweep.`);
    return;
  }

  // Leave enough for the sweep transaction itself plus the reserve.
  const sweepGas = 21000n;
  const sweepCost = sweepGas * (gasPrice === 0n ? 1n : gasPrice);
  const sendable = ethBal - reserve - sweepCost;
  if (sendable <= 0n) {
    log("Not enough above reserve to cover the sweep transaction. Skipping.");
    return;
  }

  try {
    // sweepDestination is read from config but should be treated as fixed.
    const tx = await wallet.sendTransaction({
      to: owner.sweepTo,
      value: sendable,
      gasLimit: sweepGas,
    });
    log(`sweep ${ethers.formatEther(sendable)} ETH -> ${owner.sweepTo} -> ${tx.hash}`);
    const rcpt = await tx.wait();
    recordGas(state, rcpt.gasUsed * rcpt.gasPrice);
    log(`  confirmed in block ${rcpt.blockNumber}`);
  } catch (err) {
    log(`  ! sweep failed: ${err.shortMessage || err.message}`);
  }

  log(`24h gas spend now ${ethers.formatEther(gasSpentLast24h(state))} / ${cfg.thresholds.dailyGasCapEth} ETH`);
  log(`=== ${owner.label}: done ===`);
}

main().catch((err) => {
  log(`FATAL: ${err.stack || err.message}`);
  process.exit(1);
});
