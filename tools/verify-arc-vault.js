// Read-only verification of the deployed Arc vault, against the chain itself.
const fs = require("fs");
const { ethers } = require("ethers");
const NFT  = "0xD94008e9CC868b98A790cB7208f9e32E65B0a856";
const TBA  = "0x507aFB73bd6e6624F65C6768F9a3F5E8107133d2";
const IMPL = "0xE07510f95DDCe14e2DE199245D3E5eb19BebbCaA";
const REG  = "0x06fe91de63e6216b9D40644298b454adc18d130d";
const HOLDER   = "0xB1cdC09B4C7F28365a8E7BFA2332aF54f5462aF5";
const OPERATOR = "0x8B650B6E03a87d844f14D499331D54377E9db9dF";
const CANON = "0x000000006551c19487814612e58FE06813775758";
let bad = 0;
const check = (ok, what) => { if (!ok) bad++; console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`); };
const strip = (hex) => { const b = Buffer.from(hex.slice(2), "hex"); const n = b.readUInt16BE(b.length - 2); return b.subarray(0, b.length - n - 2).toString("hex"); };
(async () => {
  const cfg = JSON.parse(fs.readFileSync("/home/steven/arc-data/settings.json", "utf8"));
  const rh  = JSON.parse(fs.readFileSync("/home/steven/uniswap-collector/settings.json", "utf8"));
  const arc = new ethers.JsonRpcProvider(cfg.chain.rpcUrl, 5042, { staticNetwork: true });
  const rob = new ethers.JsonRpcProvider(rh.chain.rpcUrl, Number(rh.chain.chainId), { staticNetwork: true });
  console.log(`Arc ${(await arc.getNetwork()).chainId} at block ${await arc.getBlockNumber()}\n`);

  console.log("code is where it should be");
  for (const [n, a] of [["registry", REG], ["implementation", IMPL], ["LOKOVault NFT", NFT], ["token-bound account", TBA]]) {
    const c = await arc.getCode(a);
    check(c !== "0x", `${n} ${a} — ${c === "0x" ? "NO CODE" : (c.length / 2 - 1) + " bytes"}`);
  }

  console.log("\nthe registry is the one Robinhood runs");
  const [mine, theirs] = [await arc.getCode(REG), await rob.getCode(CANON)];
  check(strip(mine) === strip(theirs), "executable code identical to the canonical registry on Robinhood (metadata aside)");

  console.log("\nthe account is bound to this chain and this NFT");
  const acct = new ethers.Contract(TBA, ["function token() view returns (uint256,address,uint256)", "function owner() view returns (address)", "function getNativeBalance() view returns (uint256)"], arc);
  const [cid, tc, tid] = await acct.token();
  check(Number(cid) === 5042, `bound chain id is 5042 (got ${cid}) — controllable on Arc, not elsewhere`);
  check(tc.toLowerCase() === NFT.toLowerCase(), `bound to the NFT we deployed (${tc})`);
  check(Number(tid) === 1, `bound to token #${tid}`);

  console.log("\ncontrol");
  const nft = new ethers.Contract(NFT, ["function owner() view returns (address)", "function ownerOf(uint256) view returns (address)", "function tbaAddress() view returns (address)", "function REGISTRY() view returns (address)", "function name() view returns (string)", "function symbol() view returns (string)", "function feeSplitPct() view returns (uint256)"], arc);
  check((await nft.ownerOf(1)).toLowerCase() === HOLDER.toLowerCase(), `LOKOVault #1 is held by Arc LP ${HOLDER}`);
  check((await acct.owner()).toLowerCase() === HOLDER.toLowerCase(), "the account answers to that holder");
  const admin = await nft.owner();
  check(admin.toLowerCase() === HOLDER.toLowerCase(), `the NFT contract's admin is Arc LP (${admin})`);
  check(admin.toLowerCase() !== OPERATOR.toLowerCase(), "the hot operator key kept no control");
  check((await nft.REGISTRY()).toLowerCase() === REG.toLowerCase(), "the NFT was built against the deployed registry");
  check((await nft.tbaAddress()).toLowerCase() === TBA.toLowerCase(), "the NFT agrees this is its account");

  console.log("\nthe registry derives the same address independently");
  const reg = new ethers.Contract(REG, ["function account(address,bytes32,uint256,address,uint256) view returns (address)"], arc);
  check((await reg.account(IMPL, ethers.ZeroHash, 5042, NFT, 1)).toLowerCase() === TBA.toLowerCase(), "registry.account(...) == the deployed account");

  console.log("\nstate");
  console.log(`  ${await nft.name()} (${await nft.symbol()}), fee split ${await nft.feeSplitPct()}%`);
  console.log(`  vault balance: ${ethers.formatUnits(await acct.getNativeBalance(), 18)} USDC (native)`);
  console.log(`  operator gas : ${ethers.formatUnits(await arc.getBalance(OPERATOR), 18)} USDC (was 12.0)`);
  console.log(`\n${bad ? bad + " CHECK(S) FAILED" : "All checks passed."}`);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error("ERR", e.shortMessage || e.message); process.exit(1); });
