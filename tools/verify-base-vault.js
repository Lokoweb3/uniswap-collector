#!/usr/bin/env node
/**
 * verify-base-vault.js -- READ-ONLY check of a LOKOVault on Base against the chain itself. Writes nothing,
 * sends nothing, holds no key. On success it prints the settings snippet and the (deferred) VAULT_IMPLEMENTATIONS diff.
 *
 *   node tools/verify-base-vault.js --nft=0x.. [--rpc=URL] [--main=0x..] [--impl=0x..] [--expect-split=20] [--require-allowlisted]
 */
"use strict";

const { ethers } = require("ethers");
const core = require("./base-vault-core");
const flow = core.flow;
const S = require("./../collector-base-sweep-logic");

const NFT_ABI = [
  ...flow.NFT_ABI,
  "function name() view returns (string)", "function symbol() view returns (string)", "function paused() view returns (bool)", "function FEE_SPLIT_MAX() view returns (uint256)",
];
const TBA_ABI = ["function token() view returns (uint256,address,uint256)", "function owner() view returns (address)"];

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
  const o = parseArgs(argv);
  const outLine = deps.out || ((s) => process.stdout.write(s + "\n"));
  const log = (s = "") => outLine(s);
  let bad = 0;
  const check = (ok, what) => { if (!ok) bad++; log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); return !!ok; };
  const safe = async (fn) => { try { return await fn(); } catch (e) { return undefined; } };
  const eq = core.same;

  if (!o.nft || !ethers.isAddress(o.nft)) { log("ERR --nft=<address> is required"); return 1; }
  if (o.main !== undefined && !ethers.isAddress(o.main)) { log("ERR --main is not an address"); return 1; }
  const expectSplit = o["expect-split"] === undefined ? core.TARGET_SPLIT : Number(o["expect-split"]);
  const nftAddr = ethers.getAddress(o.nft);
  const main = ethers.getAddress(o.main || core.MAIN);
  const provider = deps.provider || new ethers.JsonRpcProvider(o.rpc || process.env.LP_BASE_RPC || core.DEFAULT_RPC);
  const sweep = deps.sweep || require("./../collector-base-sweep");
  const art = core.loadArtifact(deps.artifactPath || core.ARTIFACT_PATH);

  const net = await provider.getNetwork();
  log(`Base ${net.chainId}`);
  if (!check(Number(net.chainId) === core.CHAIN_ID, `RPC chain id is ${core.CHAIN_ID} (got ${net.chainId})`)) { log(`\n${bad} CHECK(S) FAILED`); return 1; }

  const nft = new ethers.Contract(nftAddr, NFT_ABI, provider);
  const reg = new ethers.Contract(core.REGISTRY, flow.REG_ABI, provider);

  log("\ncode is where it should be");
  const regCode = await safe(() => provider.getCode(core.REGISTRY));
  check(!!regCode && regCode !== "0x" && ethers.keccak256(regCode) === (deps.registryRuntimeKeccak || core.REGISTRY_RUNTIME_KECCAK), `canonical registry ${core.REGISTRY} has the canonical code hash`);
  const nftCode = await safe(() => provider.getCode(nftAddr));
  check(!!nftCode && nftCode !== "0x", `NFT ${nftAddr} has code`);
  const tba = await safe(() => nft.tbaAddress());
  const tbaCode = tba ? await safe(() => provider.getCode(tba)) : undefined;
  check(!!tbaCode && tbaCode !== "0x", `token-bound account ${tba} has code`);

  log("\nthe NFT");
  const want = core.expectedRuntime("nft", core.REGISTRY, art);
  check(!!nftCode && ethers.keccak256(nftCode) === want.keccak, `NFT runtime keccak256 equals the expected build with the canonical registry (${want.keccak})`);
  check((await safe(() => nft.name())) === "LOKOVault", "name() is LOKOVault");
  check((await safe(() => nft.symbol())) === "LKVAULT", "symbol() is LKVAULT");
  check((await safe(() => nft.chainName())) === core.CHAIN_NAME, `chainName() is "${core.CHAIN_NAME}"`);
  check(eq(await safe(() => nft.REGISTRY()), core.REGISTRY), "REGISTRY() is the canonical registry");

  log("\nthe token-bound account");
  const proxy = flow.parseProxy(tbaCode);
  check(!!proxy, "TBA bytecode is exactly the 173-byte ERC-1167 proxy + 128-byte footer");
  check(!!proxy && proxy.salt === ethers.ZeroHash && proxy.chainId === BigInt(core.CHAIN_ID) && eq(proxy.nft, nftAddr) && proxy.tokenId === BigInt(core.TOKEN_ID), "footer is (salt 0, chainId 8453, this NFT, tokenId 1)");
  const impl = proxy ? ethers.getAddress(proxy.impl) : null;
  check(!!tba && !!impl && eq(await safe(() => reg.account(impl, ethers.ZeroHash, core.CHAIN_ID, nftAddr, core.TOKEN_ID)), tba), "registry.account(impl, 0, 8453, nft, 1) equals the TBA, and the NFT agrees it is its account");
  const acct = tba ? new ethers.Contract(tba, TBA_ABI, provider) : null;
  const tok = acct ? await safe(() => acct.token()) : undefined;
  check(!!tok && BigInt(tok[0]) === BigInt(core.CHAIN_ID) && eq(tok[1], nftAddr) && BigInt(tok[2]) === BigInt(core.TOKEN_ID), "TBA.token() is (8453, this NFT, 1)");

  log("\nthe implementation");
  const implCode = impl ? await safe(() => provider.getCode(impl)) : undefined;
  check(!!implCode && implCode !== "0x" && ethers.keccak256(implCode) === core.PINNED.account.runtimeKeccak, `implementation ${impl} runtime keccak256 equals the pinned TreasuryAccount`);
  check(!!impl && eq(await safe(() => nft.implementation()), impl), "NFT.implementation() equals the proxy's implementation");
  if (o.impl) check(!!impl && eq(o.impl, impl), `--impl ${o.impl} equals the proxy's implementation`);

  log("\ncontrol");
  check(eq(acct ? await safe(() => acct.owner()) : undefined, main), `TBA.owner() is Main ${main}`);
  check(eq(await safe(() => nft.ownerOf(core.TOKEN_ID)), main), "NFT.ownerOf(1) is Main");
  const admin = await safe(() => nft.owner());
  check(eq(admin, main), `NFT.owner() is Main (${admin}); no leftover admin`);
  check((await safe(() => nft.paused())) === false, "paused() is false");
  const pct = await safe(() => nft.feeSplitPct());
  check(pct !== undefined && Number(pct) === expectSplit, `feeSplitPct() is ${expectSplit} (got ${pct})${pct !== undefined && Number(pct) === 10 ? "; 10 is the contract default" : ""}`);
  const max = await safe(() => nft.FEE_SPLIT_MAX());
  check(max !== undefined && Number(max) === 20, "FEE_SPLIT_MAX() is 20");

  log("\nthe Base sweep's own acceptance bar");
  const snippet = { nft: nftAddr, tokenId: core.TOKEN_ID, tba: tba ? ethers.getAddress(tba) : null, implementation: impl, registry: core.REGISTRY, salt: ethers.ZeroHash, expectedOwner: main, splitPct: pct === undefined ? 0 : Number(pct), maxSplitPct: 20 };
  let vv = { ok: false, reason: "not run" };
  if (impl && tba) vv = await safe(() => sweep.verifyVault(provider, { vault: S.config({ vault: snippet }).vault }, { operator: null, owners: [main], implementations: [impl] })) || vv;
  check(vv.ok === true, `collector-base-sweep.verifyVault accepts this vault once its implementation is allowlisted${vv.ok ? "" : " (" + vv.reason + ")"}`);

  log("\nallowlist");
  const listed = !!impl && S.VAULT_IMPLEMENTATIONS.some((a) => eq(a, impl));
  if (listed) check(true, "implementation is in VAULT_IMPLEMENTATIONS");
  else if (o["require-allowlisted"]) check(false, "implementation is NOT in VAULT_IMPLEMENTATIONS (--require-allowlisted)");
  else log("  PENDING (expected until the deferred step): implementation is not in VAULT_IMPLEMENTATIONS yet");

  if (bad) { log(`\n${bad} CHECK(S) FAILED`); return 1; }
  log("\nAll checks passed.");
  log(`\n--- settings snippet for ~/base-data/settings.json under "baseSweep" (apply by hand; nothing was written) ---`);
  log(JSON.stringify({ baseSweep: { vault: snippet } }, null, 2));
  log(`\nNote: expectedOwner must be among the Base sweep's configured owner addresses. The Base instance's own main is Trading 0xaDf94A20558E1E6d64c429F8F9f017169BF3d743, so add Main (${main}) to that owner list yourself.`);
  log(`\n--- DEFERRED code change for collector-base-sweep-logic.js (separate reviewed commit; NOT applied) ---`);
  log("-const VAULT_IMPLEMENTATIONS = deepFreeze([]);");
  log(`+const VAULT_IMPLEMENTATIONS = deepFreeze(["${impl}"]);`);
  log("Update in the same change: test/collector-base-sweep-security.test.js:21 and test/collector-base-sweep-reverify.test.js:301 assert the list is [].");
  return 0;
}

module.exports = { run };

if (require.main === module) {
  run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
}
