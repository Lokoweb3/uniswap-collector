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
 *   3. TreasuryNFT (LOKOVault #1)   which takes the registry address and this
 *                                    chain's name as arguments rather than the
 *                                    hardcoded canonical registry and "Robinhood
 *                                    Chain" its metadata used to claim
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
 * Replacing a vault: --replace=<current tba> re-deploys only the NFT and mints #1,
 * reusing the registry and account implementation already on Arc. The old vault is
 * not touched and does not disappear -- whatever is still in it must be moved out
 * first, because nothing here moves money.
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
// The name the token will describe itself by, forever, in metadata no setter reaches.
// The id inside the contract comes from block.chainid and cannot be wrong; this is
// only the human label beside it.
const KNOWN_CHAIN_NAMES = { 4663: "Robinhood Chain", 5042: "Arc" };
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
  const chainName = arg("chain-name", cfg.chainName || KNOWN_CHAIN_NAMES[ARC_CHAIN_ID]);
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);
  const local = /127\.0\.0\.1|localhost/.test(rpc);

  log(`\nLOKOVault on Arc — ${EXECUTE ? "EXECUTE" : "dry run"}`);
  log(`  rpc            : ${rpc}${local ? "  (local fork)" : ""}`);
  log(`  chain id       : ${chainId}`);
  log(`  settings       : ${settingsPath()}`);
  log(`  vault holder   : ${holder}   <- whoever holds LOKOVault #1 controls the money`);
  log(`  chain name     : ${chainName}   <- baked into the metadata permanently`);
  if (!chainName) throw new Error("refusing to run: no chain name (pass --chain-name=)");
  if (chainId !== ARC_CHAIN_ID) throw new Error(`refusing to run: chain ${chainId} is not Arc (${ARC_CHAIN_ID})`);

  // Replacing an existing vault is a different job from creating the first one: the
  // registry and the account implementation on Arc are already right and are reused,
  // so only the NFT is deployed again. Naming the vault being replaced is what
  // distinguishes "deliberately replacing it" from "forgot one already exists".
  const replacing = arg("replace");
  const current = (cfg.vault && cfg.vault.tba) || null;
  if (current && !replacing) throw new Error(`refusing to run: settings already record a vault at ${current} (pass --replace=${current} to deploy a replacement)`);
  if (replacing) {
    if (!current) throw new Error("--replace was given but settings record no vault to replace");
    if (ethers.getAddress(replacing) !== ethers.getAddress(current)) throw new Error(`--replace names ${replacing}, but the recorded vault is ${current}`);
  }
  const reuse = {
    registry: replacing ? ethers.getAddress(arg("registry", cfg.vault.registry)) : null,
    implementation: replacing ? ethers.getAddress(arg("implementation", cfg.vault.implementation)) : null,
  };
  if (replacing) {
    log(`  replacing      : ${current}   <- left in place; move its balance out yourself first`);
    log(`  reusing        : registry ${reuse.registry}, implementation ${reuse.implementation}`);
    for (const [what, addr] of Object.entries(reuse)) {
      if ((await provider.getCode(addr)) === "0x") throw new Error(`the ${what} at ${addr} has no code on this chain`);
    }
  }

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
    const steps = replacing
      ? [["TreasuryNFT (LOKOVault)", 2413573n], ["mint #1 + create the account", 194373n], ["hand admin to the holder", 27290n]]
      : [["ERC-6551 registry", 176589n], ["TreasuryAccount implementation", 712610n], ["TreasuryNFT (LOKOVault)", 2413573n],
        ["mint #1 + create the account", 194373n], ["hand admin to the holder", 27290n]];
    const total = steps.reduce((t, [, g]) => t + g, 0n);
    log(`\nDry run: nothing was sent. The ${steps.length} steps and their measured cost on a fork of live Arc:`);
    for (const [what, gas] of steps) log(`  ${what.padEnd(32)}~${gas.toLocaleString()} gas`);
    log(`  TOTAL ~${total.toLocaleString()} gas  =  ${ethers.formatUnits(total * price, 18).slice(0, 8)} ${cfg.chain.nativeCurrency.symbol} at this gas price`);
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
  const need = (replacing ? 2635236n : 3524435n) * price * 2n;
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

  let r;
  const n = replacing ? 2 : 4;
  if (replacing) {
    sent.registry = reuse.registry;
    sent.implementation = reuse.implementation;
    log(`\nReusing the registry and implementation already on Arc; only the NFT is new.`);
  } else {
    log("\n1/4 ERC-6551 registry…");
    r = await (await wallet.sendTransaction({ data: art.registry.bytecode, nonce: nonce++ })).wait();
    sent.registry = r.contractAddress; log(`    ${sent.registry}  (${r.gasUsed} gas)`);
    if (!sent.registry || (await provider.getCode(sent.registry)) === "0x") throw new Error("the registry has no code — stopping");

    log("2/4 TreasuryAccount implementation…");
    const impl = await new ethers.ContractFactory(art.account.abi, art.account.bytecode, wallet).deploy({ nonce: nonce++ });
    await impl.waitForDeployment(); sent.implementation = await impl.getAddress();
    log(`    ${sent.implementation}`);
  }

  log(`${n - 1}/${n} TreasuryNFT (LOKOVault)…`);
  const nft = await new ethers.ContractFactory(art.nft.abi, art.nft.bytecode, wallet).deploy(sent.implementation, sent.registry, chainName, { nonce: nonce++ });
  await nft.waitForDeployment(); sent.nft = await nft.getAddress();
  log(`    ${sent.nft}`);

  log(`${n}/${n} mint #1 to ${holder}…`);
  r = await (await nft.mint(holder, { nonce: nonce++ })).wait();
  sent.tba = await nft.tbaAddress();
  log(`    account: ${sent.tba}  (${r.gasUsed} gas)`);
  if ((await provider.getCode(sent.tba)) === "0x") throw new Error("the account has no code — stopping before settings are touched");

  const acct = new ethers.Contract(sent.tba, art.account.abi, provider);
  const [cid, tc, tid] = await acct.token();
  if (Number(cid) !== chainId || tc.toLowerCase() !== sent.nft.toLowerCase() || Number(tid) !== 1) throw new Error("the account is not bound to this chain's NFT — stopping");
  if ((await acct.owner()).toLowerCase() !== holder.toLowerCase()) throw new Error("the account does not answer to the holder — stopping");
  log(`    verified: bound to (chain ${cid}, ${tc}, #${tid}), controlled by ${holder}`);

  // The whole point of this deployment: the token must say which chain it is on.
  const meta = JSON.parse(Buffer.from((await nft.tokenURI(1)).split(",")[1], "base64").toString("utf8"));
  const trait = (t) => (meta.attributes.find((x) => x.trait_type === t) || {}).value;
  if (trait("Chain ID") !== String(chainId) || trait("Chain") !== chainName) {
    throw new Error(`the token describes itself as ${trait("Chain")} (${trait("Chain ID")}) — stopping`);
  }
  log(`    metadata: "${trait("Chain")}", chain id ${trait("Chain ID")}`);

  // A fresh NFT starts at the contract's 10% default. The collector reads the split
  // from the NFT, so a replacement that kept the default would quietly halve what the
  // vault receives. Carry the split across while the deployer is still admin.
  const wantSplit = replacing ? Number(cfg.vault.feeSplitPct) : null;
  if (wantSplit !== null && Number(await nft.feeSplitPct()) !== wantSplit) {
    log(`    carrying the fee split across: ${await nft.feeSplitPct()}% -> ${wantSplit}%…`);
    await (await nft.setFeeSplitPct(wantSplit, { nonce: nonce++ })).wait();
    if (Number(await nft.feeSplitPct()) !== wantSplit) throw new Error("the fee split did not take — stopping");
  }

  if (wallet.address.toLowerCase() !== holder.toLowerCase()) {
    log("    handing the NFT contract's admin role to the holder…");
    await (await nft.transferOwnership(holder, { nonce: nonce++ })).wait();
    log(`    admin: ${await nft.owner()}`);
  }

  if (replacing && sent.tba.toLowerCase() === current.toLowerCase()) throw new Error("the new account has the old address — stopping");
  log("\nDeployed. Nothing in settings.json has been changed — the vault section to apply:");
  log(JSON.stringify({ vault: { nft: sent.nft, tokenId: 1, tba: sent.tba, implementation: sent.implementation, registry: sent.registry, feeSplitPct: Number(await nft.feeSplitPct()), feeSplitMax: 20, withdrawAlertUsdg: 1000 } }, null, 2));
  if (replacing) log(`\nThe old vault ${current} still exists and still holds whatever was in it. Move that out before the collector points anywhere new.`);
  log("\nReview it, then apply it yourself or with tools/apply-vault-settings.js. The collector stays disabled either way.");
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
