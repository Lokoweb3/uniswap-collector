#!/usr/bin/env node
/**
 * compile-base-vault.js -- dev-time, offline. Compiles TreasuryAccount.sol and TreasuryNFT.sol with the repo's
 * own solc, using the exact recipe of tools/deploy-vault-arc.js, and writes ONLY tools/artifacts/base-vault.json.
 * No network, no keys, no transactions. The user never runs this; base-vault-core pins the result.
 *
 *   node tools/compile-base-vault.js            # (re)write the artifact
 *   node tools/compile-base-vault.js --check    # recompile and compare, write nothing
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const ARTIFACT_PATH = path.join(__dirname, "artifacts", "base-vault.json");
const SETTINGS = Object.freeze({ optimizer: Object.freeze({ enabled: true, runs: 200 }), viaIR: true, evmVersion: "paris" });
const SOURCES = { account: ["TreasuryAccount.sol", "TreasuryAccount"], nft: ["TreasuryNFT.sol", "TreasuryNFT"] };

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function compileOne(solc, file, want) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources: { [file]: { content: source } },
    settings: { optimizer: { ...SETTINGS.optimizer }, viaIR: SETTINGS.viaIR, evmVersion: SETTINGS.evmVersion,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "evm.deployedBytecode.immutableReferences"] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = (out.contracts[file] || {})[want];
  if (!c || !c.evm.bytecode.object) throw new Error(`${want} not found or has no bytecode in ${file}`);
  const refs = Object.values(c.evm.deployedBytecode.immutableReferences || {}).flat().map((r) => ({ start: r.start, length: r.length }));
  refs.sort((a, b) => a.start - b.start);
  return { abi: c.abi, initCode: "0x" + c.evm.bytecode.object, runtime: "0x" + c.evm.deployedBytecode.object, immutableReferences: refs, sourceSha256: sha256(Buffer.from(source, "utf8")) };
}

/** Compile in memory; returns the artifact object (deterministic, no timestamps). */
function compileArtifact(solc = require("solc")) {
  const a = compileOne(solc, ...SOURCES.account);
  const n = compileOne(solc, ...SOURCES.nft);
  return {
    solcVersion: solc.version(),
    settings: { optimizer: { ...SETTINGS.optimizer }, viaIR: SETTINGS.viaIR, evmVersion: SETTINGS.evmVersion },
    sourceSha256: { account: a.sourceSha256, nft: n.sourceSha256 },
    account: { abi: a.abi, initCode: a.initCode, runtime: a.runtime, immutableReferences: a.immutableReferences },
    nft: { abi: n.abi, initCode: n.initCode, runtime: n.runtime, immutableReferences: n.immutableReferences },
  };
}
const serialize = (art) => JSON.stringify(art, null, 2) + "\n";

module.exports = { compileArtifact, serialize, ARTIFACT_PATH, SETTINGS, sha256 };

if (require.main === module) {
  const art = compileArtifact();
  const text = serialize(art);
  if (process.argv.includes("--check")) {
    const same = fs.existsSync(ARTIFACT_PATH) && fs.readFileSync(ARTIFACT_PATH, "utf8") === text;
    console.log(same ? "artifact matches a fresh compile" : "artifact DIFFERS from a fresh compile");
    process.exit(same ? 0 : 1);
  }
  fs.writeFileSync(ARTIFACT_PATH, text);
  console.log(`wrote ${path.relative(ROOT, ARTIFACT_PATH)} (solc ${art.solcVersion}, sha256 ${sha256(Buffer.from(text))})`);
}
