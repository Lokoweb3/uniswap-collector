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
 *   4. compute the fees ourselves (clamped to maxGasPriceGwei), apply the caps (collects per run, gas per transaction,
 *      gas per run, rolling 24 h, all against the worst case signed), re-read ownerOf, reserve the worst case in
 *      state.json, then sign, record the hash and nonce, and only then broadcast
 *      collect({tokenId, recipient: owner, amount0Max: MAX, amount1Max: MAX}).
 * Collect only. The recipient is always the NFT's owner. Nothing in this file requests, sets or changes an
 * approval, moves an NFT or touches a token balance; the manager ABI below has exactly three functions (plus one read-only oracle fragment).
 *
 * simulate: reads only. No signer is created and no keystore is decrypted (the operator address comes from the
 * keystore's public `address` field, as server.js does). collect: the keystore is decrypted only when the first
 * transaction is about to be sent.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const logic = require("./collector-base-logic");

const MAX128 = (1n << 128n) - 1n;
/** Exactly these three. Anything else is a bug. */
const MANAGER_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
];
/** The one read-only fragment besides the manager's: the OP-stack oracle's quote of the L1 data fee of a serialized transaction. */
const ORACLE_ABI = ["function getL1Fee(bytes _data) view returns (uint256)"];
const IFACE = new ethers.Interface(MANAGER_ABI);
const GAS_UNITS_FALLBACK = 400000n;
const REFETCH_TRIES = 3;

const short = (err) => String((err && (err.shortMessage || err.message)) || err).split("\n")[0].slice(0, 200);
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The SKIP line for a manager the operator is not approved on (exact wording is part of the contract with the README). */
function skipLine({ manager, owner, operator }) {
  return `SKIP ${manager.name} ${owner.label} ${owner.address}: operator ${operator} is not approved for all on ${manager.positionManager} (isApprovedForAll=false); no transaction sent, no approval requested`;
}

const isTimeout = (err) => !!err && (err.code === "TIMEOUT" || err.name === "WaitTimeout");
const isRevertClass = (err) => !!err && (err.code === "CALL_EXCEPTION" || /revert/i.test(String(err.shortMessage || err.message || "")));

/** Reject with a TIMEOUT error after `ms`. */
function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error(`no receipt within ${ms} ms`); e.code = "TIMEOUT"; e.name = "WaitTimeout"; reject(e); }, ms);
  });
  return Promise.race([Promise.resolve(promise), t]).finally(() => clearTimeout(timer));
}

/** The reservation of an entry, as a bigint; throws on a malformed value. */
const big = (v) => BigInt(v);

/**
 * Settle one reserved/unknown entry of an earlier run from the chain. Returns true when the entry changed (the caller saves).
 * A receipt is used only when it is provably this transaction; no receipt and the nonce used means replaced or dropped
 * (closed once at the worst case); no receipt and the nonce unused means still pending (stays counted).
 */
async function settleEarlier(e, { provider, operator, log, now, findByNonce }) {
  const label = e.tx || "(no hash)";
  const hasHash = typeof e.tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(e.tx);
  const hasNonce = Number.isSafeInteger(e.nonce) && e.nonce >= 0;
  const worst = big(e.wei);
  const settleAt = (rc, why) => {
    const paid = logic.settledWei({ gasUsed: rc.gasUsed, price: rc.gasPrice ?? rc.effectiveGasPrice, gasLimit: big(e.gasLimit), maxFeePerGas: big(e.maxFeePerGas), maxPriorityFeePerGas: e.maxPriorityFeePerGas, l1AllowanceWei: big(e.l1), worstCaseWei: worst });
    e.kind = "settled"; e.wei = paid.toString();
    // Gas paid late must count in the current window: an entry older than 24 h would otherwise drop out of it unseen.
    if (!(e.t > now() - 24 * 3600 * 1000)) e.t = now();
    log(`  earlier transaction ${label} settled ${why}: ${ethers.formatEther(paid)} ETH`);
    return true;
  };
  const closeAt = (reason, msg) => {
    e.kind = "settled"; e.t = now(); e.closed = reason;
    log(`  earlier transaction ${label} ${msg}; closed once at its worst case ${ethers.formatEther(worst)} ETH (counts 24 h from now)`);
    return true;
  };
  const complete = ["gasLimit", "maxFeePerGas", "l1"].every((k) => typeof e[k] === "string");
  let rc = null;
  if (hasHash) {
    try { rc = (await provider.getTransactionReceipt(e.tx)) || null; } catch (err) { log(`  earlier transaction ${label}: receipt lookup failed (${short(err)}); it stays counted`); return false; }
  }
  if (rc) {
    if (!complete) return hasNonce ? (log(`  earlier transaction ${label} lacks gasLimit/maxFeePerGas/l1; it stays counted`), false) : closeAt("legacy-unsettled", "has a receipt but no recorded limits");
    const bad = logic.checkReceipt(rc, { hash: e.tx, operator, entry: e });
    if (bad) {
      const was = e.kind; e.kind = "unknown";
      log(`  earlier transaction ${label}: receipt rejected (${bad}); the worst case ${ethers.formatEther(worst)} ETH stays counted`);
      if (hasNonce) {
        // A receipt that keeps failing validation must not stay counted forever: once the nonce is used on chain, close it once.
        let used;
        try { used = Number(await provider.getTransactionCount(operator, "latest")) > e.nonce; } catch (err) { log(`  earlier transaction ${label}: nonce lookup failed (${short(err)}); it stays counted`); used = false; }
        if (used) return closeAt("receipt-rejected", `has a rejected receipt and nonce ${e.nonce} is used`);
      }
      return was !== "unknown";
    }
    return settleAt(rc, "from its receipt");
  }
  if (!hasNonce) return closeAt("legacy-unsettled", "is a legacy entry that cannot be proven");
  let latest;
  try { latest = await provider.getTransactionCount(operator, "latest"); } catch (err) { log(`  earlier transaction ${label}: nonce lookup failed (${short(err)}); it stays counted`); return false; }
  if (!(Number(latest) > e.nonce)) { log(`  earlier transaction ${label} is pending: nonce ${e.nonce} not used yet; its worst case ${ethers.formatEther(worst)} ETH stays counted`); return false; }
  let found = null;
  try { found = typeof findByNonce === "function" ? await findByNonce(operator, e.nonce) : null; } catch (err) { log(`  earlier transaction ${label}: lookup by nonce failed (${short(err)}); it stays counted`); return false; }
  if (found && found.receipt && found.tx && complete) {
    let bad = null;
    if (!found.tx.hash || String(found.tx.nonce) !== String(e.nonce)) bad = "replacement nonce does not match";
    else if (!eq(found.tx.from, operator)) bad = "replacement is not from the operator";
    else if (typeof found.tx.gasLimit !== "bigint" && !(typeof found.tx.gasLimit === "string" && /^\d{1,30}$/.test(found.tx.gasLimit)) && !(Number.isSafeInteger(found.tx.gasLimit) && found.tx.gasLimit >= 0)) bad = "replacement has no gasLimit";
    else bad = logic.checkReceipt(found.receipt, { hash: found.tx.hash, operator, entry: e, txGasLimit: found.tx.gasLimit });
    if (!bad) return settleAt(found.receipt, `at the replacing transaction ${found.tx.hash}`);
    log(`  earlier transaction ${label}: replacement rejected (${bad})`);
  }
  return closeAt("replaced-or-dropped", `was replaced or dropped (nonce ${e.nonce} is used)`);
}

/**
 * One pass. Everything outside the process is injected so a test can run it on a mocked chain:
 *   cfg, mode ("simulate"|"collect"), provider (getNetwork, getFeeData, getBlock, getTransactionCount, call,
 *   estimateGas, getTransactionReceipt, broadcastTransaction), operatorAddress, getSigner() -> signer with .address and
 *   a signing method (collect mode only), findByNonce(operator, nonce) -> {receipt, tx}|null (default: null),
 *   tweakTxFields (tests only: may alter the fields just before the last look), getEthUsd() -> number|null, state ({gasSpends}) or readState() -> logic.readState result,
 *   saveState(state) (must throw when it cannot persist), log(line), now() -> ms, sleep(ms), buildFees (default
 *   logic.buildFees), logsProvider (optional), dataDir (slipstream scan cursor), readers (optional: {name: {positionsOf}}).
 * Returns { collected, skipped, wouldCollect, spentWei, aborted }.
 */
async function runPass(deps) {
  const { cfg, mode, provider, operatorAddress, getSigner, saveState = () => {}, log, now = Date.now } = deps;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const buildFees = deps.buildFees || logic.buildFees;
  const simulate = mode !== "collect";
  const tag = simulate ? " (simulate)" : "";
  const result = { collected: 0, skipped: 0, wouldCollect: 0, spentWei: 0n, aborted: false };
  const abort = (msg) => { log(`ABORT: ${msg}`); result.aborted = true; return result; };
  const done = () => log(`=== base done: ${result.collected} collected, ${result.skipped} skipped, gas ${ethers.formatEther(result.spentWei)} ETH ===${simulate ? ` (simulate: ${result.wouldCollect} would collect, nothing sent)` : ""}`);

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

  // The budget file fails closed: unreadable or missing means today's budget is spent.
  const st = deps.readState ? deps.readState() : { ok: true, state: deps.state || { gasSpends: [] } };
  const state = st.ok ? st.state : { gasSpends: [] };
  state.gasSpends = Array.isArray(state.gasSpends) ? state.gasSpends : [];
  let stateRefusal = null;
  if (!st.ok) {
    if (st.kind === "missing") {
      log(`STATE MISSING ${st.file}: refusing to send; create it once with: LP_DATA_DIR=${path.dirname(st.file)} node collector-base.js --init-state`);
      stateRefusal = "state missing";
    } else {
      log(`STATE UNREADABLE (${st.reason}): today's budget is treated as spent; no transaction sent`);
      log(`  state file: ${st.file}`);
      stateRefusal = "state unreadable";
    }
    if (!simulate) { result.aborted = true; done(); return result; }
  }

  // Entries of earlier runs that are not settled: ask the chain, close what cannot be proven. Nothing in here may throw.
  if (!simulate && st.ok) {
    for (const e of state.gasSpends) {
      if (!e || (e.kind !== "reserved" && e.kind !== "unknown")) continue;
      let changed = false;
      try { changed = await settleEarlier(e, { provider, operator, lim, log, now, findByNonce: deps.findByNonce }); } catch (err) { log(`  ! earlier entry could not be examined (${short(err)}); it stays counted`); }
      if (!changed) continue;
      try { saveState(state); } catch (err) { log(`STOP: the budget cannot be recorded (settlement of ${e.tx || "an earlier entry"}: ${short(err)}); nothing is sent this run`); result.aborted = true; done(); return result; }
    }
  }

  let feeData = {};
  try { feeData = (await provider.getFeeData()) || {}; } catch { /* the tip hint is optional */ }
  log(`Fee policy: signed maxFeePerGas = min(${lim.maxGasPriceGwei} gwei, 2 x block base fee + tip), tip <= ${lim.maxPriorityFeeGwei} gwei, gasLimit <= ${lim.maxGasLimit}`);
  const ethUsd = await deps.getEthUsd();
  if (!(ethUsd > 0)) {
    log("ETH/USD is unavailable; every position is skipped (fail closed)");
    log(`=== base done: 0 collected, 0 skipped, gas 0.0 ETH ===`);
    return result;
  }

  const readers = deps.readers || makeReaders(deps);
  const contracts = new Map(managers.map((m) => [m.positionManager, new ethers.Contract(m.positionManager, MANAGER_ABI, provider)]));
  const oracle = new ethers.Contract(logic.L1_ORACLE, ORACLE_ABI, provider);
  let signer = null, signerError = null;
  let sent = 0, spentRun = 0n;

  /** Persist the state; false (and a log line) when it cannot be written. */
  const persist = (what) => {
    try { saveState(state); return true; } catch (err) { log(`  ! state.json could not be saved (${what}: ${short(err)})`); return false; }
  };

  outer:
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
        if (typeof units !== "bigint") { skip(null, "gas estimate is not a number (fail closed)"); continue; }
        if (!(units > 0n)) units = GAS_UNITS_FALLBACK;
        const maxGasLimit = BigInt(lim.maxGasLimit);
        if (units > maxGasLimit) { skip(null, `gas estimate ${units} exceeds maxGasLimit ${maxGasLimit}`); continue; }
        const scaled = (units * 125n) / 100n;
        const gasLimit = scaled < maxGasLimit ? scaled : maxGasLimit;

        // The fees we sign: computed here from the block's base fee, clamped to the caps, whatever feeData says.
        let block;
        try { block = await provider.getBlock("latest"); } catch (err) { skip(null, `latest block could not be read (${short(err)})`); continue; }
        const fees = buildFees({ baseFeeWei: block && block.baseFeePerGas, rpcPriorityWei: feeData.maxPriorityFeePerGas, lim });
        if (!fees.ok) { skip(null, fees.reason); continue; }
        // The nonce is read once: the oracle quotes, and the signer signs, exactly these fields.
        let nonce;
        try { nonce = await provider.getTransactionCount(operator, "pending"); } catch (err) { skip(null, `nonce unreadable (${short(err)})`); continue; }
        let txFields = { type: 2, chainId: logic.BASE_CHAIN_ID, to: manager.positionManager, data: IFACE.encodeFunctionData("collect", [params]), value: 0n, nonce, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };

        // The L1 data fee, quoted by the OP-stack oracle for this exact (unsigned) transaction.
        let l1FeeWei;
        try {
          if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("nonce is not a non-negative integer");
          const raw = ethers.Transaction.from(txFields).unsignedSerialized;
          l1FeeWei = await oracle.getL1Fee(raw);
          if (typeof l1FeeWei !== "bigint" || l1FeeWei < 0n) throw new Error("not a number");
        } catch (err) { skip(null, `L1 fee unreadable (${short(err)})`); continue; }
        const l1AllowanceWei = logic.l1Allowance(l1FeeWei, lim);
        const worstCaseWei = gasLimit * fees.maxFeePerGas + l1AllowanceWei;
        const expectedWei = units * fees.expectedPriceWei + l1FeeWei;
        const gasUsd = logic.gasCostUsd(1n, expectedWei, ethUsd);
        const d = logic.decide({ feesUsd: p.feesUsd, gasUsd, lim });
        if (!d.collect) { skip(gasUsd, d.reason); continue; }

        const cap = logic.capCheck({ lim, worstCaseWei, sentCount: sent, spentRunWei: spentRun, spent24hWei: logic.spentWindowWei(state, now()) });
        if (!cap.ok) { skip(gasUsd, cap.reason); continue; }

        if (simulate) { line(gasUsd, "collect", `${d.reason}; not sent${stateRefusal ? ` (would be refused: ${stateRefusal})` : ""}`); result.wouldCollect++; continue; }

        // Last look before sending: the recipient is the owner as the chain says right now.
        let recipient;
        try { recipient = await mgr.ownerOf(id); } catch (err) { skip(gasUsd, `ownerOf failed just before sending (${short(err)})`); continue; }
        if (!eq(recipient, owner.address)) { skip(gasUsd, `ownerOf changed to ${recipient} just before sending`); continue; }
        line(gasUsd, "collect", d.reason);
        log(`  sending #${id}: gasLimit ${gasLimit}, maxFeePerGas ${ethers.formatUnits(fees.maxFeePerGas, "gwei")} gwei, tip ${ethers.formatUnits(fees.maxPriorityFeePerGas, "gwei")} gwei, worst case ${ethers.formatEther(worstCaseWei)} ETH`);

        try {
          if (signerError) throw signerError;
          if (!signer) {
            try {
              signer = await getSigner();
              if (!signer || !eq(signer.address, operator)) throw new Error("the unlocked key is not the operator whose approval was checked");
            } catch (err) { signer = null; signerError = err; throw err; }
          }
          if (deps.tweakTxFields) txFields = deps.tweakTxFields({ ...txFields }, { manager, tokenId: id });
          logic.assertSignable(txFields, lim, { tokenId: id, owner: owner.address, manager: manager.positionManager });
        } catch (err) {
          log(`  ! #${id} collect failed: ${short(err)}; continuing`);
          result.skipped++;
          continue;
        }

        // Sign first: the hash is known before anything leaves the process, and what was signed is checked field by field.
        let raw, hash;
        try {
          raw = await signer.signTransaction(txFields);
          const parsed = ethers.Transaction.from(raw);
          const mismatch = [
            ["from", eq(parsed.from, operator)], ["to", eq(parsed.to, manager.positionManager)], ["nonce", parsed.nonce === nonce],
            ["gasLimit", parsed.gasLimit === gasLimit], ["maxFeePerGas", parsed.maxFeePerGas === fees.maxFeePerGas], ["maxPriorityFeePerGas", parsed.maxPriorityFeePerGas === fees.maxPriorityFeePerGas],
            ["value", parsed.value === 0n], ["data", parsed.data === txFields.data], ["chainId", parsed.chainId === BigInt(logic.BASE_CHAIN_ID)], ["type", parsed.type === 2],
            ["accessList", !parsed.accessList || parsed.accessList.length === 0],
          ].filter(([, ok]) => !ok).map(([k]) => k);
          if (mismatch.length) throw new Error(`the signed transaction differs from the one asked for (${mismatch.join(", ")}); nothing recorded, nothing broadcast`);
          hash = parsed.hash;
        } catch (err) {
          log(`  ! #${id} signing refused: ${short(err)}; continuing`);
          result.skipped++;
          continue;
        }

        // Record the worst case, hash and nonce on disk BEFORE broadcasting; no durable reservation, no broadcast.
        const entry = { t: now(), wei: worstCaseWei.toString(), kind: "reserved", tx: hash, nonce, from: operator, to: manager.positionManager, gasLimit: gasLimit.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), l1: l1AllowanceWei.toString() };
        state.gasSpends.push(entry);
        if (!persist("reservation")) {
          state.gasSpends.splice(state.gasSpends.indexOf(entry), 1);
          log(`STOP: the budget cannot be recorded, nothing more is sent this run`);
          result.skipped++; result.aborted = true;
          break outer;
        }
        const noRecord = () => { log("STOP: the budget cannot be recorded; nothing more is sent this run"); result.aborted = true; };
        const keepUnknown = (why) => {
          entry.kind = "unknown";
          spentRun += worstCaseWei; result.spentWei += worstCaseWei;
          const saved = persist("unknown outcome");
          log(`  ! #${id} outcome unknown (${why}); the worst case ${ethers.formatEther(worstCaseWei)} ETH stays counted until the transaction is settled`);
          if (!saved) noRecord();
        };
        /** Replace the reservation by what the receipt says it cost. false when that cannot be saved. */
        const settle = (receipt) => {
          const paid = logic.settledWei({ gasUsed: receipt.gasUsed, price: receipt.gasPrice ?? receipt.effectiveGasPrice, gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, l1AllowanceWei, worstCaseWei });
          entry.kind = "settled"; entry.wei = paid.toString();
          spentRun += paid; result.spentWei += paid;
          return { paid, saved: persist("settlement") };
        };
        const stopRun = (msg) => { log(`STOP: ${msg}; nothing more is sent this run`); result.aborted = true; };

        let tx;
        try {
          tx = await provider.broadcastTransaction(raw);
        } catch (err) {
          // The broadcast may have reached the network: the reservation stays on disk and is settled at the next run start.
          sent++;
          spentRun += worstCaseWei; result.spentWei += worstCaseWei;
          log(`  ! #${id} broadcast failed (${short(err)}); not ruled out that it was sent; the reservation of tx ${hash} stays and is settled next run`);
          result.skipped++; stopRun("a broadcast of unknown outcome");
          break outer;
        }
        sent++;
        if (!tx || typeof tx.hash !== "string" || !eq(tx.hash, hash)) {
          keepUnknown(`broadcast returned ${!tx || typeof tx.hash !== "string" ? "no hash" : `hash ${tx.hash}`}, signed hash ${hash}`);
          result.skipped++; stopRun("broadcast returned no/mismatching hash");
          break outer;
        }
        if (!persist("transaction hash")) { noRecord(); result.skipped++; break outer; }

        let receipt = null, revertedErr = null;
        try {
          receipt = await withTimeout(tx.wait(1, lim.waitTimeoutSec * 1000), lim.waitTimeoutSec * 1000);
        } catch (err) {
          if (isTimeout(err)) {
            keepUnknown(`no receipt within ${lim.waitTimeoutSec} s, tx ${tx.hash}`);
            result.skipped++; stopRun("a transaction is unconfirmed");
            break outer;
          }
          if (err && err.code === "TRANSACTION_REPLACED") {
            // Never settle at the replacement's receipt here; the next run start settles it by nonce.
            keepUnknown(`transaction replaced or cancelled, tx ${tx.hash}`);
            result.skipped++; stopRun("a transaction was replaced");
            break outer;
          }
          if (err && err.receipt) { receipt = err.receipt; revertedErr = err; }
          else if (isRevertClass(err)) {
            for (let n = 0; n < REFETCH_TRIES && !receipt; n++) {
              if (n > 0) await sleep(2000);
              try { receipt = (await provider.getTransactionReceipt(tx.hash)) || null; } catch { receipt = null; }
            }
            if (!receipt) { keepUnknown(`reverted, receipt not found, tx ${hash}`); result.skipped++; if (result.aborted) break outer; continue; }
            revertedErr = err;
          } else {
            keepUnknown(`${short(err)}, tx ${tx.hash}`);
            result.skipped++; stopRun("a broadcast transaction failed in an unknown way");
            break outer;
          }
        }
        if (!receipt || receipt.gasUsed == null) {
          keepUnknown(`receipt without gasUsed, tx ${tx.hash}`);
          result.skipped++; stopRun("a receipt without gasUsed");
          break outer;
        }
        const badReceipt = logic.checkReceipt(receipt, { hash, operator, entry });
        if (badReceipt) {
          keepUnknown(`receipt rejected: ${badReceipt}, tx ${tx.hash}`);
          result.skipped++; stopRun("a receipt failed validation");
          break outer;
        }
        const { paid, saved } = settle(receipt);
        if (!saved) { result.skipped++; stopRun("the budget cannot be recorded"); break outer; }
        if (receipt.status === 0 || revertedErr) { log(`  ! #${id} collect reverted on-chain: tx ${tx.hash}, gas used ${receipt.gasUsed}, counted ${ethers.formatEther(paid)} ETH`); result.skipped++; continue; }
        log(`  collected #${id} to ${recipient}: tx ${tx.hash}, simulated amounts ${amounts[0]} / ${amounts[1]} (raw), gas used ${receipt.gasUsed}, paid ${ethers.formatEther(paid)} ETH`);
        result.collected++;
      }
    }
  }
  done();
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

/** Same keystore, same two environment variables, same decrypt call as collector.js; only reached to send. */
async function unlockSigner(provider, env = process.env) {
  const pass = env.LP_KEYSTORE_PASS;
  try {
    if (!env.LP_KEYSTORE_PATH || !pass) throw new Error("LP_KEYSTORE_PATH and LP_KEYSTORE_PASS must be set. Use run-collector.sh.");
    const json = fs.readFileSync(env.LP_KEYSTORE_PATH, "utf8");
    return (await ethers.Wallet.fromEncryptedJson(json, pass)).connect(provider);
  } finally {
    delete env.LP_KEYSTORE_PASS; // hygiene only, also on failure: the initial /proc/<pid>/environ is not cleared by this
  }
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
  if (process.argv.includes("--init-state")) {
    // No chain, no keystore: create the budget file once, never overwrite it.
    const r = logic.initStateFile(STATE_FILE);
    log(r === "created" ? `created ${STATE_FILE}` : `${STATE_FILE} already exists; left unchanged`);
    return;
  }
  const mode = (process.argv.find((a) => a.startsWith("--mode=")) || "--mode=simulate").split("=")[1];
  if (!["simulate", "collect"].includes(mode)) { console.error(`Unknown mode "${mode}". Use simulate | collect.`); process.exit(1); }

  const cfg = require("./settings").load({ fresh: true });
  if (Number(cfg.chainId) !== logic.BASE_CHAIN_ID) { log(`ABORT: settings chainId is ${cfg.chainId}, this pass only runs on Base (${logic.BASE_CHAIN_ID}).`); process.exit(1); }
  const provider = require("./rpc-retry").withRetry(new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId), { attempts: Number(cfg.rpcRetryAttempts) || 4, log });
  const logsProvider = require("./rpc").createLogsProvider(cfg);

  const keystorePath = process.env.LP_KEYSTORE_PATH || path.join(process.env.HOME || "", ".lp-collector", "operator-keystore.json");
  const operatorAddress = operatorFromKeystore(keystorePath);

  const getWethUsd = ethUsdOf(cfg, provider);

  const getSigner = () => unlockSigner(provider);

  const res = await runPass({
    cfg, mode, provider, logsProvider, dataDir: require("./data-dir").DATA_DIR, operatorAddress, getSigner,
    getEthUsd: () => getWethUsd(), readState: () => logic.readState(STATE_FILE),
    saveState: (s) => logic.writeFileAtomic(STATE_FILE, logic.serializeState(s)), log,
  });
  if (res.aborted) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => { console.error(`FATAL: ${short(err)}`); process.exit(1); });
}

module.exports = { runPass, unlockSigner, skipLine, makeReaders, ethUsdOf, operatorFromKeystore, MANAGER_ABI, ORACLE_ABI, MAX128 };
