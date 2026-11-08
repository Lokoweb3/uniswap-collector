#!/usr/bin/env node
/**
 * base-vault-txs.js -- prints the UNSIGNED transactions that create a LOKOVault on Base from Main.
 * It never signs, sends or touches a key. The only network use is read-only (--predict): eth_chainId,
 * eth_getTransactionCount and an eth_call to the registry.
 *
 *   node tools/base-vault-txs.js --predict                 # all 4 steps with predicted addresses
 *   node tools/base-vault-txs.js --impl=0x.. --nft=0x..    # explicit addresses
 *   node tools/base-vault-txs.js --predict --format=json   # EIP-1193 ready array
 *   node tools/base-vault-txs.js --predict --raw --step=2  # only the data hex
 *   node tools/base-vault-txs.js --verify-artifact         # recompile and compare with the artifact
 */
"use strict";

const { ethers } = require("ethers");
const core = require("./base-vault-core");

const parseArgs = (argv) => {
  const o = {};
  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const i = a.indexOf("=");
    if (i < 0) o[a.slice(2)] = true; else o[a.slice(2, i)] = a.slice(i + 1);
  }
  return o;
};

async function run(argv, deps = {}) {
  const out = deps.out || ((s) => process.stdout.write(s + "\n"));
  const err = deps.err || ((s) => process.stderr.write(s + "\n"));
  const o = parseArgs(argv);
  let art;
  try { art = core.loadArtifact(deps.artifactPath || core.ARTIFACT_PATH); } catch (e) { err(`ARTIFACT REFUSED: ${e.message}`); return 2; }
  if (o["verify-artifact"]) {
    let r;
    try { r = core.verifyReproducible(art); } catch (e) { err(`cannot recompile: ${e.message}`); return 2; }
    out(r.ok ? "artifact reproduces from the current .sol sources" : "artifact does NOT reproduce:\n  " + r.problems.join("\n  "));
    return r.ok ? 0 : 2;
  }
  const only = o.step ? Number(o.step) : undefined;
  if (only !== undefined && ![1, 2, 3, 4].includes(only)) { err("--step must be 1, 2, 3 or 4"); return 1; }
  let impl = o.impl; let nft = o.nft; let prediction = null;
  for (const [k, v] of [["impl", impl], ["nft", nft]]) if (v !== undefined && !ethers.isAddress(v)) { err(`--${k} is not an address`); return 1; }
  const needsAddr = (!only || only >= 2);
  if (o.predict && needsAddr) {
    const rpc = o.rpc || process.env.LP_BASE_RPC || core.DEFAULT_RPC;
    try {
      const provider = deps.provider || new ethers.JsonRpcProvider(rpc);
      prediction = await core.predict(provider);
    } catch (e) { err(`prediction failed (read-only RPC): ${e.shortMessage || e.message}`); return 1; }
    impl = impl || prediction.impl; nft = nft || prediction.nft;
  }
  let steps;
  try { steps = core.buildSteps({ art, impl: impl && ethers.getAddress(impl), nft: nft && ethers.getAddress(nft), only }); } catch (e) { err(e.message); return 1; }

  if (o.raw) { if (!only) { err("--raw needs --step=N"); return 1; } out(steps[0].data); return 0; }
  if (prediction) err(`PREDICTED addresses (depend on Main's nonce at send time, verify on-chain). ${core.PREDICTION_NOTE}`);
  if (o.format === "json") {
    out(JSON.stringify(steps.map((s) => { const t = { step: s.step, name: s.name, from: s.from }; if (s.to) t.to = s.to; t.data = s.data; t.value = s.value; t.chainId = s.chainId; return t; }), null, 2));
    return 0;
  }
  out("Base (chain 8453) LOKOVault: UNSIGNED transactions. Nothing here signs or sends.");
  out(`solc ${art.solcVersion}; artifact sha256 ${core.PINNED.artifactFileSha256}`);
  if (prediction) {
    out(`\nPREDICTED addresses (depend on Main's nonce at send time; verify on-chain; the signing page goes by code hashes):`);
    out(`  Main nonce latest=${prediction.nonceLatest} pending=${prediction.noncePending}${prediction.nonceLatest !== prediction.noncePending ? "   WARNING: a transaction is pending" : ""}`);
    out(`  implementation  ${prediction.impl}  PREDICTED`);
    out(`  NFT             ${prediction.nft}  PREDICTED`);
    out(`  token-bound acc ${prediction.tba}  PREDICTED`);
    out(`  ${core.PREDICTION_NOTE}`);
  }
  for (const s of steps) {
    out(`\n=== Step ${s.step}: ${s.name} ===`);
    out(`from     ${s.from}`);
    out(`to       ${s.to || "null (contract creation)"}`);
    out(`value    ${s.value}`);
    out(`chainId  ${s.chainId} (8453)`);
    out(`decoded  ${s.decoded}`);
    if (s.initCodeKeccak) { out(`keccak256(initCode)        ${s.initCodeKeccak}`); out(`expected runtime keccak256 ${s.expectedRuntimeKeccak}`); }
    out(`effects  ${s.effects}`);
    out(`gas      about ${s.gas} (informational; the wallet estimates)`);
    out(`data     ${s.data}`);
  }
  return 0;
}

module.exports = { run, parseArgs };

if (require.main === module) {
  run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
}
