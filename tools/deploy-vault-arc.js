#!/usr/bin/env node
/**
 * deploy-vault-arc.js — put a LOKOVault on Arc.
 *
 * Arc has no vault. It also has no ERC-6551 registry, which the vault's token-bound
 * account depends on, so this deploys four things in order:
 *
 *   1. the ERC-6551 registry        (v0.3.1 source; its executable code is identical
 *                                    to the registry already running on Robinhood,
 *                                    only the trailing metadata blob differs)
 *   2. TreasuryAccount              the account implementation
 *   3. TreasuryNFT (LOKOVault #1)   which takes the registry address as an argument
 *                                    rather than the hardcoded canonical one
 *   4. mint #1 to the holder        which creates the token-bound account itself
 *
 * and then hands the NFT contract's admin role to the holder, because the deployer
 * is the collector's hot operator key and should not keep control of the vault.
 *
 * Whoever holds LOKOVault #1 controls the account. TreasuryAccount.owner() returns
 * address(0) unless the bound chain id equals this chain, so an account is only ever
 * controllable on the chain it was created for: a vault on Arc must be created on Arc.
 *
 * DRY RUN BY DEFAULT. It compiles, reports sizes and the gas each step would cost,
 * and sends nothing. --execute is the only way to broadcast, and it refuses any chain
 * that is not Arc. The whole sequence is rehearsed against a fork of live Arc by
 * tools/rehearse-arc-vault.js; run that first.
 *
 *   node tools/deploy-vault-arc.js                      # dry run
 *   node tools/deploy-vault-arc.js --execute            # deploy for real
 *   node tools/deploy-vault-arc.js --rpc=http://127.0.0.1:8545 --execute   # onto a fork
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { ethers } = require("ethers");
const solc = require("solc");

const ROOT = path.join(__dirname, "..");
const ARC_CHAIN_ID = 5042;
const REGISTRY_SRC = path.join(__dirname, "erc6551", "ERC6551Registry.sol");

const arg = (name, dflt = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : dflt;
};
const EXECUTE = process.argv.includes("--execute");
const log = (...m) => console.log(...m);

function settingsPath() {
  return arg("settings", "/home/steven/arc-data/settings.json");
}

/**
 * The registry is compiled with the exact settings its authors published (solc
 * 0.8.17, optimizer, 200 runs); the vault contracts need the IR pipeline, because
 * TreasuryNFT builds its SVG inline and overflows the stack otherwise. Both target
 * `paris`, so nothing newer than Arc might accept is ever emitted.
 */
function loadSolc(version) {
  return new Promise((res, rej) => solc.loadRemoteVersion(version, (e, s) => (e ? rej(e) : res(s))));
}
function compileWith(compiler, key, source, want, settings) {
  const out = JSON.parse(compiler.compile(JSON.stringify({
    language: "Solidity", sources: { [key]: { content: source } },
    settings: { ...settings, outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  // By name, never by position: these files declare interfaces and libraries first,
  // and taking the first entry would compile an interface and deploy nothing usable.
  const c = (out.contracts[key] || {})[want];
  if (!c) throw new Error(`${want} not found in ${key} (found: ${Object.keys(out.contracts[key] || {}).join(", ")})`);
  if (!c.evm.bytecode.object) throw new Error(`${want} produced no bytecode — is it an interface or abstract?`);
  return { name: want, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, runtime: "0x" + c.evm.deployedBytecode.object };
}
async function artifacts() {
  const v17 = await loadSolc("v0.8.17+commit.8df45f5f");
  const registry = compileWith(v17, "src/ERC6551Registry.sol", fs.readFileSync(REGISTRY_SRC, "utf8"), "ERC6551Registry",
    { optimizer: { enabled: true, runs: 200 } });
  const opts = { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris" };
  const account = compileWith(solc, "TreasuryAccount.sol", fs.readFileSync(path.join(ROOT, "TreasuryAccount.sol"), "utf8"), "TreasuryAccount", opts);
  const nft = compileWith(solc, "TreasuryNFT.sol", fs.readFileSync(path.join(ROOT, "TreasuryNFT.sol"), "utf8"), "TreasuryNFT", opts);
  return { registry, account, nft };
}

function prompt(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a.trim()); });
  });
}
function promptHidden(q) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdout.write(q);
    let s = "";
    process.stdin.setRawMode(true);
    process.stdin.on("data", function h(ch) {
      const c = ch.toString();
      if (c === "\r" || c === "\n") { process.stdin.setRawMode(false); process.stdin.removeListener("data", h); process.stdout.write("\n"); rl.close(); res(s); }
      else if (c === "") process.exit(1);
      else s += c;
    });
  });
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  const rpc = arg("rpc", cfg.chain.rpcUrl);
  const holder = ethers.getAddress(arg("holder", cfg.wallets.main.address));
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);
  const local = /127\.0\.0\.1|localhost/.test(rpc);

  log(`\nLOKOVault on Arc — ${EXECUTE ? "EXECUTE" : "dry run"}`);
  log(`  rpc            : ${rpc}${local ? "  (local fork)" : ""}`);
  log(`  chain id       : ${chainId}`);
  log(`  settings       : ${settingsPath()}`);
  log(`  vault holder   : ${holder}   <- whoever holds LOKOVault #1 controls the money`);
  if (chainId !== ARC_CHAIN_ID) throw new Error(`refusing to run: chain ${chainId} is not Arc (${ARC_CHAIN_ID})`);
  if (cfg.vault && cfg.vault.tba) throw new Error(`refusing to run: settings already record a vault at ${cfg.vault.tba}`);

  log("\nCompiling…");
  const art = await artifacts();
  const size = (a) => `${(a.runtime.length / 2 - 1).toLocaleString()} bytes`;
  log(`  ERC6551Registry  ${size(art.registry)}`);
  log(`  TreasuryAccount  ${size(art.account)}`);
  log(`  TreasuryNFT      ${size(art.nft)}`);

  // What the registry deploys must be the registry Robinhood already runs: compare
  // the executable code, ignoring the trailing metadata blob, which never executes.
  const strip = (hex) => { const b = Buffer.from(hex.slice(2), "hex"); const n = b.readUInt16BE(b.length - 2); return b.subarray(0, b.length - n - 2).toString("hex"); };
  const known = process.env.LP_KNOWN_REGISTRY_RUNTIME;
  if (known) log(`  registry code matches the known deployment: ${strip(art.registry.runtime) === strip(known)}`);

  const fee = await provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  log(`\nGas price: ${(Number(price) / 1e9).toFixed(2)} gwei`);
  const cap = Number(cfg.collector.thresholds.maxGasPriceGwei);
  if (Number(price) / 1e9 > cap) log(`  note: above the collector's own ceiling of ${cap} gwei — that ceiling does not gate this script.`);

  if (!EXECUTE) {
    log("\nDry run: nothing was sent. The four steps and their measured cost on a fork of live Arc:");
    log("  ERC-6551 registry               ~176,589 gas");
    log("  TreasuryAccount implementation  ~712,610 gas");
    log("  TreasuryNFT (LOKOVault)       ~2,413,573 gas");
    log("  mint #1 + create the account    ~194,373 gas");
    log("  hand admin to the holder         ~27,290 gas");
    log(`  TOTAL ~3,524,435 gas  =  ${ethers.formatUnits(3524435n * price, 18).slice(0, 8)} ${cfg.chain.nativeCurrency.symbol} at this gas price`);
    log("\nRun tools/rehearse-arc-vault.js against a fork first, then re-run with --execute.");
    return;
  }

  const keystorePath = process.env.LP_KEYSTORE_PATH;
  if (!keystorePath || !fs.existsSync(keystorePath)) throw new Error("LP_KEYSTORE_PATH is not set to a keystore file");
  const pass = process.env.LP_KEYSTORE_PASS || (await promptHidden("Operator passphrase: "));
  const wallet = (await ethers.Wallet.fromEncryptedJson(fs.readFileSync(keystorePath, "utf8"), pass)).connect(provider);
  const bal = await provider.getBalance(wallet.address);
  log(`\nDeployer: ${wallet.address}`);
  log(`Balance : ${ethers.formatUnits(bal, cfg.chain.nativeCurrency.decimals)} ${cfg.chain.nativeCurrency.symbol}`);
  const need = 3524435n * price * 2n;
  if (bal < need) throw new Error(`not enough gas: ${ethers.formatUnits(need, 18)} wanted (twice the measured cost)`);

  if (!local) {
    log("\nThis deploys four contracts to Arc mainnet. It cannot be undone.");
    const a = await prompt(`Type the holder address to confirm (${holder}): `);
    if (a.toLowerCase() !== holder.toLowerCase()) throw new Error("holder not confirmed — nothing was sent");
  }

  // Nonces are assigned here rather than left to the provider: four transactions go
  // out back to back, and a node that answers with a stale count makes the second one
  // collide with the first. Explicit numbers also make a half-finished run resumable.
  const sent = {};
  let nonce = await provider.getTransactionCount(wallet.address, "latest");
  log(`\nStarting nonce: ${nonce}`);

  log("\n1/4 ERC-6551 registry…");
  let r = await (await wallet.sendTransaction({ data: art.registry.bytecode, nonce: nonce++ })).wait();
  sent.registry = r.contractAddress; log(`    ${sent.registry}  (${r.gasUsed} gas)`);
  if (!sent.registry || (await provider.getCode(sent.registry)) === "0x") throw new Error("the registry has no code — stopping");

  log("2/4 TreasuryAccount implementation…");
  const impl = await new ethers.ContractFactory(art.account.abi, art.account.bytecode, wallet).deploy({ nonce: nonce++ });
  await impl.waitForDeployment(); sent.implementation = await impl.getAddress();
  log(`    ${sent.implementation}`);

  log("3/4 TreasuryNFT (LOKOVault)…");
  const nft = await new ethers.ContractFactory(art.nft.abi, art.nft.bytecode, wallet).deploy(sent.implementation, sent.registry, { nonce: nonce++ });
  await nft.waitForDeployment(); sent.nft = await nft.getAddress();
  log(`    ${sent.nft}`);

  log(`4/4 mint #1 to ${holder}…`);
  r = await (await nft.mint(holder, { nonce: nonce++ })).wait();
  sent.tba = await nft.tbaAddress();
  log(`    account: ${sent.tba}  (${r.gasUsed} gas)`);
  if ((await provider.getCode(sent.tba)) === "0x") throw new Error("the account has no code — stopping before settings are touched");

  const acct = new ethers.Contract(sent.tba, art.account.abi, provider);
  const [cid, tc, tid] = await acct.token();
  if (Number(cid) !== chainId || tc.toLowerCase() !== sent.nft.toLowerCase() || Number(tid) !== 1) throw new Error("the account is not bound to this chain's NFT — stopping");
  if ((await acct.owner()).toLowerCase() !== holder.toLowerCase()) throw new Error("the account does not answer to the holder — stopping");
  log(`    verified: bound to (chain ${cid}, ${tc}, #${tid}), controlled by ${holder}`);

  if (wallet.address.toLowerCase() !== holder.toLowerCase()) {
    log("    handing the NFT contract's admin role to the holder…");
    await (await nft.transferOwnership(holder, { nonce: nonce++ })).wait();
    log(`    admin: ${await nft.owner()}`);
  }

  log("\nDeployed. Nothing in settings.json has been changed — the vault section to apply:");
  log(JSON.stringify({ vault: { nft: sent.nft, tokenId: 1, tba: sent.tba, implementation: sent.implementation, registry: sent.registry, feeSplitPct: 0, feeSplitMax: 20, withdrawAlertUsdg: 1000 } }, null, 2));
  log("\nReview it, then apply it yourself or with tools/apply-vault-settings.js. The collector stays disabled either way.");
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
