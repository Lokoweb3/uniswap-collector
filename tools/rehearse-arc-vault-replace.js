// Rehearsal only: replaces the LIVE Arc vault on a LOCAL FORK of Arc.
//
// The vault deployed on Arc reports itself as "Robinhood Chain", chain 4663, in
// tokenURI text that no setter can reach. The money and the control are sound — the
// token-bound account is bound to chain 5042 and answers to the NFT holder — so the
// only fix is a new NFT whose metadata reads block.chainid, and moving the balance
// across. That is what this rehearses, against the real deployed contracts, on a fork.
//
// Everything here runs against 127.0.0.1. Nothing is sent to Arc.
//   anvil --fork-url <arc rpc> --port 8545
//   node tools/rehearse-arc-vault-replace.js
"use strict";

const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const RPC = "http://127.0.0.1:8545";
const SETTINGS = process.env.LP_ARC_SETTINGS || "/home/steven/arc-data/settings.json";
const USDC = "0x3600000000000000000000000000000000000000";  // Arc's unit of account, native-backed
const ok = (c, m) => { if (!c) { console.error("  FAIL:", m); process.exitCode = 1; } else console.log("  ok:", m); };

// ethers caches eth_getBalance for 250ms, which is long enough to read a stale figure
// straight after a transfer and conclude the money never arrived. Ask the node.
const bal = async (p, a) => BigInt(await p.send("eth_getBalance", [a, "latest"]));

function compile(name) {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { [`${name}.sol`]: { content: fs.readFileSync(path.join(ROOT, `${name}.sol`), "utf8") } },
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts[`${name}.sol`][name];
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

const decodeMeta = (uri) => JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
const traitOf = (meta, t) => (meta.attributes.find((x) => x.trait_type === t) || {}).value;

(async () => {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  const old = cfg.vault;
  const p = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  if (Number((await p.getNetwork()).chainId) !== 5042) throw new Error("not an Arc fork");
  if (!RPC.includes("127.0.0.1")) throw new Error("refusing to run anywhere but the local fork");
  console.log(`Fork of Arc at block ${await p.getBlockNumber()} — local only, nothing is sent to Arc.\n`);

  const nftArt = compile("TreasuryNFT");
  const accArt = compile("TreasuryAccount");

  console.log("1. the vault as it stands on Arc today");
  const oldNft = new ethers.Contract(old.nft, nftArt.abi, p);
  const holderAddr = ethers.getAddress(await oldNft.ownerOf(1));
  const oldAcct = new ethers.Contract(old.tba, accArt.abi, p);
  const oldMeta = decodeMeta(await oldNft.tokenURI(1));
  console.log(`   nft ${old.nft}  held by ${holderAddr}`);
  console.log(`   tba ${old.tba}`);
  ok(traitOf(oldMeta, "Chain ID") === "4663", `it calls itself chain ${traitOf(oldMeta, "Chain ID")} — the bug being fixed`);
  const [oldCid] = await oldAcct.token();
  ok(Number(oldCid) === 5042, "while the account is really bound to 5042, so the money was never at risk");
  const oldNative = await bal(p, old.tba);
  console.log(`   balance: ${ethers.formatUnits(oldNative, 18)} USDC (native)`);

  console.log("\n2. the replacement NFT, reusing the registry already on Arc");
  const deployer = await p.getSigner(0);           // stands in for the operator key
  const nft = await (await new ethers.ContractFactory(nftArt.abi, nftArt.bytecode, deployer)
    .deploy(old.implementation, old.registry, "Arc")).waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log(`   nft: ${nftAddr}`);
  ok((await nft.REGISTRY()).toLowerCase() === old.registry.toLowerCase(), "it points at Arc's existing registry — none is deployed again");

  console.log("\n3. mint #1 to the same holder");
  await (await nft.mint(holderAddr)).wait();
  const tba = ethers.getAddress(await nft.tbaAddress());
  console.log(`   tba: ${tba}`);
  ok(tba !== ethers.getAddress(old.tba), "the new account is a different address from the old one");
  ok((await p.getCode(tba)) !== "0x", "and it is deployed");
  const [cid, tc, tid] = await new ethers.Contract(tba, accArt.abi, p).token();
  ok(Number(cid) === 5042 && tc.toLowerCase() === nftAddr.toLowerCase() && Number(tid) === 1, "bound to the new NFT on this chain");
  ok((await new ethers.Contract(tba, accArt.abi, p).owner()).toLowerCase() === holderAddr.toLowerCase(), "and it answers to the same holder");

  console.log("\n4. it says which chain it is on");
  const meta = decodeMeta(await nft.tokenURI(1));
  ok(traitOf(meta, "Chain") === "Arc", `the Chain trait reads "${traitOf(meta, "Chain")}"`);
  ok(traitOf(meta, "Chain ID") === "5042", `the Chain ID trait reads "${traitOf(meta, "Chain ID")}" — from block.chainid`);
  ok(!/Robinhood|4663/.test(JSON.stringify(meta)), "nothing in the token still claims Robinhood Chain");

  console.log("\n5. the fee split follows the vault it replaces");
  ok(Number(await nft.feeSplitPct()) === 10, "a fresh NFT starts at the contract default of 10%");
  await (await nft.setFeeSplitPct(Number(old.feeSplitPct))).wait();
  ok(Number(await nft.feeSplitPct()) === Number(old.feeSplitPct), `carried across to ${old.feeSplitPct}% before admin is handed over`);
  await (await nft.transferOwnership(holderAddr)).wait();
  ok((await nft.owner()).toLowerCase() === holderAddr.toLowerCase(), "admin handed to the holder; the operator key keeps nothing");

  console.log("\n6. moving the balance across (the holder's own transaction)");
  await p.send("anvil_impersonateAccount", [holderAddr]);
  const holder = await p.getSigner(holderAddr);
  const gasFund = await bal(p, holderAddr);
  const asHolder = new ethers.Contract(old.tba, accArt.abi, holder);
  // Arc's USDC is one balance behind two interfaces: the ERC-20 at 0x3600… is backed
  // by the native balance through a precompile the fork cannot reproduce. A withdrawal
  // therefore goes out the native path, which is what the balance actually is.
  ok((await new ethers.Contract(USDC, ["function balanceOf(address) view returns (uint256)"], p).balanceOf(old.tba).catch(() => null)) !== null,
    "the ERC-20 view of the vault balance is readable");
  await (await asHolder.withdrawAllETH(tba)).wait();
  ok((await bal(p, old.tba)) === 0n, "the old vault is empty");
  ok((await bal(p, tba)) === oldNative, `the new vault holds all ${ethers.formatUnits(oldNative, 18)} USDC`);
  ok((await bal(p, holderAddr)) <= gasFund, "nothing was routed through the holder's own wallet on the way");

  console.log("\n7. what the old vault becomes");
  const stranger = await p.getSigner(1);
  try {
    await (await new ethers.Contract(old.tba, accArt.abi, stranger).withdrawAllETH(await stranger.getAddress())).wait();
    ok(false, "a stranger must not be able to touch the empty old vault");
  } catch (e) { ok(/Not NFT holder/.test(e.message || ""), "the old vault still answers only to its holder — an empty orphan, not a hole"); }
  await (await holder.sendTransaction({ to: old.tba, value: ethers.parseUnits("0.01", 18) })).wait();
  ok((await bal(p, old.tba)) === ethers.parseUnits("0.01", 18), "anything sent to the old address later still arrives and is still recoverable");
  await (await asHolder.withdrawAllETH(tba)).wait();
  ok((await bal(p, old.tba)) === 0n, "and can be swept across the same way");

  console.log(process.exitCode
    ? "\nRehearsal FAILED — see the lines above. Nothing was sent to Arc."
    : "\nRehearsal passed — on a fork. Nothing was sent to Arc.");
})().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
