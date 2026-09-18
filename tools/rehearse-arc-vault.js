// Rehearsal only: deploys the whole LOKOVault stack on a LOCAL FORK of Arc and tries
// to break it. Nothing here touches the real chain — the RPC is anvil on 127.0.0.1.
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const { ethers } = require("ethers");

const ROOT = require("path").join(__dirname, "..");
const RPC = "http://127.0.0.1:8545";
const USDC = "0x3600000000000000000000000000000000000000";   // Arc's unit of account (ERC-20 view, 6 dec)
const ARCLP = "0xB1cdC09B4C7F28365a8E7BFA2332aF54f5462aF5";  // a real Arc holder, impersonated for funds
const MAIN = "0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8";   // the wallet that would hold the vault NFT
const ok = (c, m) => { if (!c) { console.error("  FAIL:", m); process.exitCode = 1; } else console.log("  ok:", m); };

function compile(name) {
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { [`${name}.sol`]: { content: fs.readFileSync(path.join(ROOT, `${name}.sol`), "utf8") } },
    // viaIR: TreasuryNFT builds its SVG inline and overflows the stack on the legacy
    // pipeline. evmVersion paris: never emit an opcode newer than Arc might accept.
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts[`${name}.sol`][name];
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
}

(async () => {
  const p = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const net = await p.getNetwork();
  if (Number(net.chainId) !== 5042) throw new Error("not an Arc fork");
  if (!RPC.includes("127.0.0.1")) throw new Error("refusing to run anywhere but the local fork");
  console.log(`Fork of Arc ${net.chainId} at block ${await p.getBlockNumber()} — local only, nothing is sent to Arc.\n`);
  const deployer = await p.getSigner(0);
  const stranger = await p.getSigner(1);

  console.log("1. registry (the code Arc is missing; executable code identical to Robinhood's)");
  const initcode = fs.readFileSync(path.join(__dirname, "erc6551", "registry-initcode.txt"), "utf8").trim();
  let tx = await deployer.sendTransaction({ data: initcode });
  const registry = (await tx.wait()).contractAddress;
  console.log("   registry:", registry);
  ok((await p.getCode(registry)) !== "0x", "registry has code");

  console.log("2. TreasuryAccount implementation");
  const accArt = compile("TreasuryAccount");
  const impl = await (await new ethers.ContractFactory(accArt.abi, accArt.bytecode, deployer).deploy()).waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log("   implementation:", implAddr);

  console.log("3. TreasuryNFT (LOKOVault), registry and chain name passed in");
  const nftArt = compile("TreasuryNFT");
  const nft = await (await new ethers.ContractFactory(nftArt.abi, nftArt.bytecode, deployer).deploy(implAddr, registry, "Arc")).waitForDeployment();
  const nftAddr = await nft.getAddress();
  console.log("   nft:", nftAddr);
  ok((await nft.REGISTRY()).toLowerCase() === registry.toLowerCase(), "the NFT points at the registry we deployed");
  try {
    await new ethers.ContractFactory(nftArt.abi, nftArt.bytecode, deployer).deploy(implAddr, MAIN, "Arc");
    ok(false, "a registry address with no code must be rejected");
  } catch { ok(true, "a registry address with no code is rejected at deployment"); }
  try {
    await new ethers.ContractFactory(nftArt.abi, nftArt.bytecode, deployer).deploy(implAddr, registry, "");
    ok(false, "a nameless chain must be rejected");
  } catch { ok(true, "an empty chain name is rejected at deployment"); }

  console.log("4. mint #1 to the main wallet");
  const r = await (await nft.mint(MAIN)).wait();
  const tba = await nft.tbaAddress();
  console.log("   TBA:", tba, `(mint used ${r.gasUsed} gas)`);
  ok((await p.getCode(tba)) !== "0x", "the token-bound account is deployed on this chain");
  const reg = new ethers.Contract(registry, ["function account(address,bytes32,uint256,address,uint256) view returns (address)"], p);
  ok((await reg.account(implAddr, ethers.ZeroHash, 5042, nftAddr, 1)).toLowerCase() === tba.toLowerCase(),
    "the registry derives the same address for it");

  console.log("5. the token says which chain it is on");
  {
    const meta = JSON.parse(Buffer.from((await nft.tokenURI(1)).split(",")[1], "base64").toString("utf8"));
    const trait = (t) => (meta.attributes.find((x) => x.trait_type === t) || {}).value;
    ok(trait("Chain") === "Arc", `the Chain trait reads "${trait("Chain")}"`);
    ok(trait("Chain ID") === "5042", `the Chain ID trait reads "${trait("Chain ID")}" — from block.chainid, not a literal`);
    ok(/ on Arc\./.test(meta.description), "the description names Arc");
    ok(!/Robinhood|4663/.test(JSON.stringify(meta)), "nothing anywhere still claims Robinhood Chain");
    const svg = Buffer.from(meta.image.split(",")[1], "base64").toString("utf8");
    ok(svg.includes("Chain 5042") && svg.includes("#1 Arc"), "the artwork agrees with the metadata");
  }

  console.log("6. control");
  const acct = new ethers.Contract(tba, accArt.abi, p);
  const [cid, tc, tid] = await acct.token();
  ok(Number(cid) === 5042 && tc.toLowerCase() === nftAddr.toLowerCase() && Number(tid) === 1,
    `bound to (chain ${cid}, ${tc.slice(0, 10)}…, #${tid}) — its own chain, not another`);
  ok((await acct.owner()).toLowerCase() === MAIN.toLowerCase(), "controlled by whoever holds the NFT (the main wallet)");

  // Arc's USDC at 0x3600… is backed by the native balance through a precompile the
  // fork does not reproduce: its ERC-20 transfer reverts here but succeeds on the
  // real chain (checked by eth_call against Arc: returns true, and reverts with
  // "transfer amount exceeds balance" when overdrawn). So the ERC-20 path is
  // rehearsed with ARGUS, a plain token the fork handles faithfully, and the native
  // path with value transfers — the same two code paths a sweep and a withdrawal use.
  console.log("7. money in, money out");
  const ARGUS = "0xece5ca8bf9220718e5727754026757512212cb3c";
  await p.send("anvil_impersonateAccount", [ARCLP]);
  await p.send("anvil_setBalance", [ARCLP, "0x56BC75E2D63100000"]);
  const arclp = await p.getSigner(ARCLP);
  const erc20 = new ethers.Contract(ARGUS, ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"], arclp);
  const amount = ethers.parseUnits("1.5", 18);
  await (await erc20.transfer(tba, amount)).wait();
  ok((await erc20.balanceOf(tba)) === amount, "the vault received an ERC-20 fee token, as a sweep would deliver it");
  await (await arclp.sendTransaction({ to: tba, value: ethers.parseUnits("2.5", 18) })).wait();
  ok((await p.getBalance(tba)) === ethers.parseUnits("2.5", 18), "and a native-currency delivery (Arc's USDC) arrived too");

  const strangerAddr = await stranger.getAddress();
  const asStranger = new ethers.Contract(tba, accArt.abi, stranger);
  try { await (await asStranger.withdrawAll(ARGUS, strangerAddr)).wait(); ok(false, "a stranger must not be able to withdraw"); }
  catch (e) { ok(/Not NFT holder/.test(e.message || ""), "a stranger cannot withdraw the tokens (Not NFT holder)"); }
  try { await (await asStranger.withdrawAllETH(strangerAddr)).wait(); ok(false, "a stranger must not be able to withdraw the native balance"); }
  catch (e) { ok(/Not NFT holder/.test(e.message || ""), "nor the native balance"); }

  await p.send("anvil_impersonateAccount", [MAIN]);
  await p.send("anvil_setBalance", [MAIN, "0x56BC75E2D63100000"]);
  const holder = await p.getSigner(MAIN);
  await (await new ethers.Contract(tba, accArt.abi, holder).withdrawAll(ARGUS, MAIN)).wait();
  ok((await erc20.balanceOf(tba)) === 0n, "the NFT holder withdrew the token balance");
  const natBefore = await p.getBalance(MAIN);
  await (await new ethers.Contract(tba, accArt.abi, holder).withdrawAllETH(MAIN)).wait();
  ok((await p.getBalance(tba)) === 0n && (await p.getBalance(MAIN)) > natBefore - ethers.parseUnits("0.1", 18),
    "and the native balance, to itself");

  console.log("8. the NFT carries control: transfer it, and the new holder controls the vault");
  await (await new ethers.Contract(nftAddr, nftArt.abi, holder).transferFrom(MAIN, strangerAddr, 1)).wait();
  ok((await acct.owner()).toLowerCase() === strangerAddr.toLowerCase(), "control followed the NFT");
  try { await (await new ethers.Contract(tba, accArt.abi, holder).withdrawAllETH(MAIN)).wait(); ok(false, "the old holder must lose control"); }
  catch (e) { ok(/Not NFT holder|transaction execution reverted|CALL_EXCEPTION/.test(e.message || e.code || ""), "and the previous holder lost it"); }
  ok((await new ethers.Contract(tba, accArt.abi, p).owner.staticCall()).toLowerCase() === strangerAddr.toLowerCase(),
    "the vault answers to the new holder only");

  console.log(process.exitCode ? "\nREHEARSAL FAILED" : "\nRehearsal passed — on a fork. Nothing was sent to Arc.");
})().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
