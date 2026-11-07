#!/usr/bin/env node
/**
 * collector-base.js -- the daily fee collect on Base (Aerodrome Slipstream), signed by the operator.
 *
 *   node collector-base.js --mode=simulate|collect [--data-dir=DIR]
 *
 * Started by run-collector.sh after the Robinhood pass, in the same unlocked context (same flock, same
 * unlock window), with LP_DATA_DIR pointing at the Base data directory ($HOME/base-data). It is NOT the Base
 * server: the server stays read-only (LP_READONLY=1) and never imports this file. This process does not read
 * or care about LP_READONLY.
 *
 * What it does, per wallet that has `collect: true` (wallets.main.collect or wallets.watched[].collect):
 *   1. isApprovedForAll(owner, operator) on each configured position manager; not approved -> SKIP, nothing else.
 *   2. read the wallet's positions; skip staked ones, unreadable fees, unpriced fees, and tokens whose ownerOf
 *      is not the configured owner;
 *   3. simulate collect() as the operator, estimate gas, apply the thresholds (minFeesUsd, fees versus gas);
 *   4. apply the caps (gas price, collects per run, gas per run, rolling 24 h), re-read ownerOf, then send
 *      collect({tokenId, recipient: owner, amount0Max: MAX, amount1Max: MAX}).
 * Collect only. The recipient is always the NFT's owner. Nothing in this file requests, sets or changes an
 * approval, moves an NFT or touches a token balance; the contract ABI below has exactly three functions.
 *
 * simulate: reads only. No signer is created and no keystore is decrypted (the operator address comes from the
 * keystore's public `address` field, as server.js does). collect: the keystore is decrypted only when the first
 * transaction is about to be sent.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const cl = require("./collector-logic");
const logic = require("./collector-base-logic");

const MAX128 = (1n << 128n) - 1n;
/** Exactly these three. Anything else is a bug. */
const MANAGER_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
];
const IFACE = new ethers.Interface(MANAGER_ABI);
const GAS_UNITS_FALLBACK = 400000n;

const short = (err) => String((err && (err.shortMessage || err.message)) || err).split("\n")[0].slice(0, 200);
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The SKIP line for a manager the operator is not approved on (exact wording is part of the contract with the README). */
function skipLine({ manager, owner, operator }) {
  return `SKIP ${manager.name} ${owner.label} ${owner.address}: operator ${operator} is not approved for all on ${manager.positionManager} (isApprovedForAll=false); no transaction sent, no approval requested`;
}

/**
 * One pass. Everything outside the process is injected so a test can run it on a mocked chain:
 *   cfg, mode ("simulate"|"collect"), provider (getNetwork, getFeeData, call, estimateGas),
 *   operatorAddress, getSigner() -> signer with .address and .sendTransaction (collect mode only),
 *   getEthUsd() -> number|null, state ({gasSpends}), saveState(state), log(line), now() -> ms,
 *   logsProvider (optional), dataDir (slipstream scan cursor), readers (optional: {name: {positionsOf}}).
 * Returns { collected, skipped, wouldCollect, spentWei, aborted }.
 */
async function runPass(deps) {
  const { cfg, mode, provider, operatorAddress, getSigner, state, saveState = () => {}, log, now = Date.now } = deps;
  const simulate = mode !== "collect";
  const tag = simulate ? " (simulate)" : "";
  const result = { collected: 0, skipped: 0, wouldCollect: 0, spentWei: 0n, aborted: false };
  const abort = (msg) => { log(`ABORT: ${msg}`); result.aborted = true; return result; };

  // Chain first: nothing is read from a wrong chain, nothing is sent.
  if (Number(cfg.chainId) !== logic.BASE_CHAIN_ID) return abort(`settings chainId is ${cfg.chainId}, this pass only runs on Base (${logic.BASE_CHAIN_ID}).`);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== logic.BASE_CHAIN_ID) return abort(`the RPC reports chainId ${net.chainId}, this pass only runs on Base (${logic.BASE_CHAIN_ID}).`);
  log(`=== base collect mode=${mode} chainId=${logic.BASE_CHAIN_ID} ===`);

  // Always shown, even when nothing is enabled: this is the address to approve (README: Auto-collect on Base).
  log(operatorAddress ? `Operator: ${ethers.getAddress(operatorAddress)}` : "Operator: unknown (no keystore with a public address was found)");
  const lim = logic.limits(cfg.baseCollect);
  const all = logic.owners(cfg);
  const enabled = all.filter((o) => o.enabled);
  for (const o of all) if (!o.enabled) log(`- ${o.label} (${o.address}): collect is not enabled (collect:false); skipped, nothing read or sent`);
  const { used: managers, refused } = logic.managers(cfg);
  for (const r of refused) log(`- manager ${r} is not on the allowlist; ignored`);
  if (!enabled.length) {
    log("no wallet has collect:true; nothing to do");
    log(`=== base done: 0 collected, 0 skipped, gas 0.0 ETH ===`);
    return result;
  }
  if (!operatorAddress) {
    if (simulate) {
      log("SKIP: no keystore with a public address was found, so the operator is unknown and approvals cannot be checked; nothing read or sent");
      log("=== base done: 0 collected, 0 skipped, gas 0.0 ETH === (simulate: 0 would collect, nothing sent)");
      return result;
    }
    return abort("the operator address is unknown (no keystore address); nothing can be checked or sent.");
  }
  const operator = ethers.getAddress(operatorAddress);

  const feeData = await provider.getFeeData();
  const gasPrice = logic.effectiveGasPrice(feeData);
  if (gasPrice == null) return abort("the network gas price is unavailable; nothing sent.");
  log(`Network gas: ${Number(ethers.formatUnits(gasPrice, "gwei")).toFixed(6)} gwei (cap ${lim.maxGasPriceGwei})`);
  const ethUsd = await deps.getEthUsd();
  if (!(ethUsd > 0)) {
    log("ETH/USD is unavailable; every position is skipped (fail closed)");
    log(`=== base done: 0 collected, 0 skipped, gas 0.0 ETH ===`);
    return result;
  }

  const readers = deps.readers || makeReaders(deps);
  const contracts = new Map(managers.map((m) => [m.positionManager, new ethers.Contract(m.positionManager, MANAGER_ABI, provider)]));
  let signer = null, signerError = null;
  let sent = 0, spentRun = 0n;
  state.gasSpends = Array.isArray(state.gasSpends) ? state.gasSpends : [];

  for (const owner of enabled) {
    log(`--- ${owner.label} (${owner.address}) ---`);
    for (const manager of managers) {
      const mgr = contracts.get(manager.positionManager);
      let approved;
      try {
        approved = await mgr.isApprovedForAll(owner.address, operator);
      } catch (err) {
        log(`SKIP ${manager.name} ${owner.label} ${owner.address}: isApprovedForAll could not be read on ${manager.positionManager} (${short(err)}); no transaction sent, no approval requested`);
        result.skipped++;
        continue;
      }
      if (approved !== true) { log(skipLine({ manager, owner, operator })); result.skipped++; continue; }

      let read;
      try {
        read = await readers[manager.name].positionsOf(owner.address, ethUsd);
      } catch (err) {
        log(`  ! ${manager.name}: positions of ${owner.address} could not be read (${short(err)}); skipped`);
        result.skipped++;
        continue;
      }
      for (const e of read.errors || []) log(`  ! ${e.tokenId}: ${e.error}; skipped`);
      for (const p of read.positions || []) {
        const id = BigInt(p.nftId);
        const line = (gasUsd, verdict, reason) => log(`#${id} ${p.pair} fees ${logic.usd(p.feesUsd)} gas ${logic.usd(gasUsd)} -> ${verdict}: ${reason}${tag}`);
        const skip = (gasUsd, reason) => { line(gasUsd, "skip", reason); result.skipped++; };

        if (p.staked) { skip(null, "staked in a gauge: the NFT is held by the gauge, the operator cannot collect it"); continue; }
        if (p.feesOk === false) { skip(null, `fees could not be read (${p.feesError || "unknown"})`); continue; }
        if (p.feesUsd == null) { skip(null, "fees are unpriced (fail closed)"); continue; }
        let onChainOwner;
        try { onChainOwner = await mgr.ownerOf(id); } catch (err) { skip(null, `ownerOf failed (${short(err)})`); continue; }
        if (!eq(onChainOwner, owner.address)) { skip(null, `ownerOf is ${onChainOwner}, not the configured owner ${owner.address}`); continue; }

        const params = { tokenId: id, recipient: owner.address, amount0Max: MAX128, amount1Max: MAX128 };
        let amounts, units;
        try {
          amounts = await mgr.collect.staticCall(params, { from: operator });
        } catch (err) { skip(null, `collect simulation as the operator reverted (${short(err)})`); continue; }
        try {
          units = await mgr.collect.estimateGas(params, { from: operator });
        } catch (err) { skip(null, `gas estimate failed (${short(err)})`); continue; }
        if (!(units > 0n)) units = GAS_UNITS_FALLBACK;
        const gasUsd = logic.gasCostUsd(units, gasPrice, ethUsd);
        const d = logic.decide({ feesUsd: p.feesUsd, gasUsd, lim });
        if (!d.collect) { skip(gasUsd, d.reason); continue; }

        const estimateWei = cl.gasEstimate(units, gasPrice);
        const cap = logic.capCheck({ lim, gasPriceWei: gasPrice, estimateWei, sentCount: sent, spentRunWei: spentRun, spent24hWei: cl.gasSpentLast24h(state) });
        if (!cap.ok) { skip(gasUsd, cap.reason); continue; }

        if (simulate) { line(gasUsd, "collect", `${d.reason}; not sent`); result.wouldCollect++; continue; }

        // Last look before sending: the recipient is the owner as the chain says right now.
        let recipient;
        try { recipient = await mgr.ownerOf(id); } catch (err) { skip(gasUsd, `ownerOf failed just before sending (${short(err)})`); continue; }
        if (!eq(recipient, owner.address)) { skip(gasUsd, `ownerOf changed to ${recipient} just before sending`); continue; }
        line(gasUsd, "collect", d.reason);
        try {
          if (signerError) throw signerError;
          if (!signer) {
            try {
              signer = await getSigner();
              if (!signer || !eq(signer.address, operator)) throw new Error("the unlocked key is not the operator whose approval was checked");
            } catch (err) { signer = null; signerError = err; throw err; }
          }
          const tx = await signer.sendTransaction({
            to: manager.positionManager,
            data: IFACE.encodeFunctionData("collect", [{ tokenId: id, recipient, amount0Max: MAX128, amount1Max: MAX128 }]),
            value: 0n,
            gasLimit: (units * 125n) / 100n,
            maxFeePerGas: feeData.maxFeePerGas ?? gasPrice,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n,
          });
          sent++;
          const receipt = await tx.wait();
          const paid = BigInt(receipt.gasUsed) * BigInt(receipt.gasPrice ?? receipt.effectiveGasPrice ?? gasPrice);
          spentRun += paid; result.spentWei += paid;
          state.gasSpends.push({ t: now(), wei: paid.toString() });
          saveState(state);
          if (receipt.status === 0) { log(`  ! #${id} collect reverted on-chain: tx ${tx.hash}, gas used ${receipt.gasUsed}`); result.skipped++; continue; }
          log(`  collected #${id} to ${recipient}: tx ${tx.hash}, simulated amounts ${amounts[0]} / ${amounts[1]} (raw), gas used ${receipt.gasUsed}, paid ${ethers.formatEther(paid)} ETH`);
          result.collected++;
        } catch (err) {
          log(`  ! #${id} collect failed: ${short(err)}; continuing`);
          result.skipped++;
        }
      }
    }
  }
  log(`=== base done: ${result.collected} collected, ${result.skipped} skipped, gas ${ethers.formatEther(result.spentWei)} ETH ===${simulate ? ` (simulate: ${result.wouldCollect} would collect, nothing sent)` : ""}`);
  return result;
}

/** One Slipstream reader per allowed manager in settings (the same wiring watch.js uses). */
function makeReaders({ cfg, provider, logsProvider = null, dataDir = null, log }) {
  const slipstream = require("./slipstream");
  const WETH = String((cfg.numeraire && cfg.numeraire.address) || (cfg.contracts && cfg.contracts.weth) || "").toLowerCase();
  const STABLE = String((cfg.usdReference && cfg.usdReference.stable) || "").toLowerCase();
  const priceSides = require("./pricing").makePriceSides({ weth: WETH, stable: STABLE });
  const toFloat = (amount, decimals) => Number(ethers.formatUnits(amount, decimals));
  const quiet = { log() {}, error() {}, warn: (m) => log(`  note: ${m}`) };
  const out = {};
  for (const spec of logic.managers(cfg).used) {
    if (!spec.factory) continue;
    out[spec.name] = slipstream.create({ provider, cfg, spec, priceSides, toFloat, bsFetch: null, logsProvider, dataDir, log: quiet });
  }
  return new Proxy(out, { get: (t, k) => t[k] || { positionsOf: async () => { throw new Error(`manager ${String(k)} has no factory in settings`); } } });
}

/** ETH/USD from the Base pricing path (the v3 WETH/USDC reference pool named in settings), as the server prices it. */
function ethUsdOf(cfg, provider) {
  const u = require("./univ3");
  const factory = new ethers.Contract(cfg.contracts.factory || ethers.ZeroAddress, u.FACTORY_ABI, provider);
  return require("./pricing").makeGetWethUsd({ cfg, unit: cfg.numeraire, factory, provider, u });
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------------

/** The operator's address from the keystore's public `address` field (no passphrase), as server.js reads it. */
function operatorFromKeystore(file) {
  try {
    const ks = JSON.parse(fs.readFileSync(file, "utf8"));
    return ethers.getAddress("0x" + String(ks.address).replace(/^0x/, ""));
  } catch { return null; }
}

async function main() {
  const { dataPath } = require("./data-dir");
  const LOG_FILE = dataPath("collector.log");
  const STATE_FILE = dataPath("state.json");
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* the console line stands */ }
  };
  const mode = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=simulate").split("=")[1];
  if (!["simulate", "collect"].includes(mode)) { console.error(`Unknown mode "${mode}". Use simulate | collect.`); process.exit(1); }

  const cfg = require("./settings").load({ fresh: true });
  if (Number(cfg.chainId) !== logic.BASE_CHAIN_ID) { log(`ABORT: settings chainId is ${cfg.chainId}, this pass only runs on Base (${logic.BASE_CHAIN_ID}).`); process.exit(1); }
  const provider = require("./rpc-retry").withRetry(new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId), { attempts: Number(cfg.rpcRetryAttempts) || 4, log });
  const logsProvider = require("./rpc").createLogsProvider(cfg);

  const keystorePath = process.env.LP_KEYSTORE_PATH || path.join(process.env.HOME || "", ".lp-collector", "operator-keystore.json");
  const operatorAddress = operatorFromKeystore(keystorePath);

  let state;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { state = { gasSpends: [] }; }
  const getWethUsd = ethUsdOf(cfg, provider);

  // Same keystore, same two environment variables, same decrypt call as collector.js; only reached to send.
  const getSigner = async () => {
    const pass = process.env.LP_KEYSTORE_PASS;
    if (!process.env.LP_KEYSTORE_PATH || !pass) throw new Error("LP_KEYSTORE_PATH and LP_KEYSTORE_PASS must be set. Use run-collector.sh.");
    const json = fs.readFileSync(process.env.LP_KEYSTORE_PATH, "utf8");
    return (await ethers.Wallet.fromEncryptedJson(json, pass)).connect(provider);
  };

  const res = await runPass({
    cfg, mode, provider, logsProvider, dataDir: require("./data-dir").DATA_DIR, operatorAddress, getSigner,
    getEthUsd: () => getWethUsd(), state, saveState: (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)), log,
  });
  if (res.aborted) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => { console.error(`FATAL: ${short(err)}`); process.exit(1); });
}

module.exports = { runPass, skipLine, makeReaders, ethUsdOf, operatorFromKeystore, MANAGER_ABI, MAX128 };
