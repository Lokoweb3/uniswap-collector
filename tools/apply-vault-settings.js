#!/usr/bin/env node
/**
 * apply-vault-settings.js — record a deployed Arc vault in settings.json.
 *
 * Deployment and configuration are kept apart on purpose: the deploy script writes
 * no settings, and this one sends no transactions. Before it changes anything it
 * checks the chain, because a wrong address here is where the money would go:
 *
 *   - the account has code on this chain
 *   - it is bound to (this chain id, this NFT, token 1)
 *   - it answers to the wallet that holds the NFT, and that is the holder given
 *   - the NFT contract's admin is no longer the hot operator key
 *
 * It prints a diff and writes nothing without --apply.
 *
 *   node tools/apply-vault-settings.js --nft=0x… --tba=0x… --implementation=0x… --registry=0x…
 *   node tools/apply-vault-settings.js --nft=0x… … --apply
 */
"use strict";

const fs = require("fs");
const { ethers } = require("ethers");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const APPLY = process.argv.includes("--apply");
const SETTINGS = arg("settings", "/home/steven/arc-data/settings.json");

// A diff a person can read: only the lines that change, with their path.
function diff(before, after, path = "") {
  const out = [];
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const k of keys) {
    const a = (before || {})[k], b = (after || {})[k];
    const p = path ? `${path}.${k}` : k;
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) out.push(...diff(a, b, p));
    else {
      if (a !== undefined) out.push(`  - ${p}: ${JSON.stringify(a)}`);
      if (b !== undefined) out.push(`  + ${p}: ${JSON.stringify(b)}`);
    }
  }
  return out;
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  const nft = ethers.getAddress(arg("nft"));
  const tba = ethers.getAddress(arg("tba"));
  const implementation = ethers.getAddress(arg("implementation"));
  const registry = ethers.getAddress(arg("registry"));
  const holder = ethers.getAddress(arg("holder", cfg.wallets.main.address));
  const provider = new ethers.JsonRpcProvider(arg("rpc", cfg.chain.rpcUrl), undefined, { staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);

  console.log(`\nChecking the vault on chain ${chainId} before recording it\n`);
  const acct = new ethers.Contract(tba, [
    "function token() view returns (uint256,address,uint256)",
    "function owner() view returns (address)",
  ], provider);
  const nftC = new ethers.Contract(nft, [
    "function owner() view returns (address)",
    "function ownerOf(uint256) view returns (address)",
    "function tbaAddress() view returns (address)",
    "function REGISTRY() view returns (address)",
  ], provider);

  const checks = [];
  const check = (ok, what) => { checks.push(ok); console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); };
  check((await provider.getCode(tba)) !== "0x", "the account has code on this chain");
  const [cid, tc, tid] = await acct.token();
  check(Number(cid) === chainId, `it is bound to this chain (${cid})`);
  check(tc.toLowerCase() === nft.toLowerCase() && Number(tid) === 1, `it is bound to ${nft} #1`);
  check((await nftC.tbaAddress()).toLowerCase() === tba.toLowerCase(), "the NFT agrees this is its account");
  check((await nftC.REGISTRY()).toLowerCase() === registry.toLowerCase(), "the NFT was built against this registry");
  const nftHolder = await nftC.ownerOf(1);
  check(nftHolder.toLowerCase() === holder.toLowerCase(), `LOKOVault #1 is held by ${holder}`);
  check((await acct.owner()).toLowerCase() === holder.toLowerCase(), "the account answers to that holder");
  const admin = await nftC.owner();
  check(admin.toLowerCase() === holder.toLowerCase(), `the NFT contract's admin is the holder, not the operator (${admin})`);

  if (checks.some((c) => !c)) throw new Error("a check failed — settings were not touched");

  const after = JSON.parse(JSON.stringify(cfg));
  after.vault = { ...(cfg.vault || {}), nft, tokenId: 1, tba, implementation, registry,
    feeSplitPct: cfg.vault && cfg.vault.feeSplitPct ? cfg.vault.feeSplitPct : 0,
    feeSplitMax: 20 };
  delete after.vault._comment;
  after.vault._comment = "LOKOVault on Arc. feeSplitPct is the share of each swept amount that goes to the vault's token-bound account; 0 means the split is off even though the vault exists.";

  const lines = diff(cfg, after);
  console.log(`\n${SETTINGS}`);
  console.log(lines.length ? lines.join("\n") : "  (no change)");
  // treasury.js reads feeSplitPct() from the NFT and lets it override settings.json
  // whenever the vault is configured, so printing the settings number alone would
  // state a split that is not the one in force.
  let onChain = null;
  try { onChain = Number(await new ethers.Contract(nft, ["function feeSplitPct() view returns (uint256)"], provider).feeSplitPct()); } catch {}
  console.log("\nThis records where the vault is. It does not enable collection or sweeping:");
  console.log(`  collector.v4Collect.enabled : ${cfg.collector.v4Collect.enabled}`);
  console.log(`  collector.sweep.enabled     : ${cfg.collector.sweep.enabled}`);
  console.log(`  vault.feeSplitPct (settings): ${after.vault.feeSplitPct}%`);
  if (onChain != null) {
    console.log(`  feeSplitPct() on the NFT    : ${onChain}%   <- this is the one in force`);
    if (onChain !== after.vault.feeSplitPct) {
      console.log(`  NOTE: once the vault is recorded and sweeping is on, ${onChain}% of each swept amount`);
      console.log(`        goes to the vault, not ${after.vault.feeSplitPct}%. To change it, the NFT's admin calls`);
      console.log(`        setFeeSplitPct(<pct>) on ${nft} (capped at ${after.vault.feeSplitMax}%).`);
    }
  }

  if (!APPLY) { console.log("\nNothing written. Re-run with --apply to write it."); return; }
  const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(SETTINGS, backup);
  // Same shape settings.js writes: two spaces and a trailing newline, so a small
  // change does not land as a whole-file reformat.
  fs.writeFileSync(SETTINGS, JSON.stringify(after, null, 2) + "\n");
  console.log(`\nWritten. Previous file kept at ${backup}`);
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
