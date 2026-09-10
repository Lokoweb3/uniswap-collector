#!/usr/bin/env node
/**
 * Works out which chain your positions are on and which contracts to point at,
 * by reading the chain rather than trusting a table of addresses.
 *
 *   node discover.js                          # try the mainnet address
 *   node discover.js 0xYourPositionManager    # verify a candidate from an explorer
 *
 * Set chain.rpcUrl and wallets.main in settings.json first. Nothing here sends a
 * transaction or needs a key.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const MAINNET_NPM = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

// A position manager tells you the rest of the deployment itself.
const NPM_ABI = [
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
];

const ERC20_ABI = ["function symbol() view returns (string)"];

const KNOWN_CHAINS = {
  1: "Ethereum mainnet",
  10: "OP Mainnet",
  56: "BNB Chain",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
  42220: "Celo",
  43114: "Avalanche",
  81457: "Blast",
  7777777: "Zora",
};

async function main() {
  const cfg = require("./settings").load();

  if (!cfg.rpcUrl || cfg.rpcUrl.includes("REPLACE")) {
    console.error("Set chain.rpcUrl in settings.json first.");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const net = await provider.getNetwork();
  const chainId = Number(net.chainId);
  const block = await provider.getBlockNumber();

  console.log("");
  console.log(`  chain id     ${chainId}  ${KNOWN_CHAINS[chainId] || "(not a chain I recognise)"}`);
  console.log(`  head block   ${block.toLocaleString("en-US")}`);
  console.log(`  config says  ${cfg.chainId}${Number(cfg.chainId) === chainId ? "" : "   <-- MISMATCH"}`);
  console.log("");

  const candidate = process.argv[2] || MAINNET_NPM;
  if (!ethers.isAddress(candidate)) {
    console.error(`"${candidate}" is not an address.`);
    process.exit(1);
  }

  const code = await provider.getCode(candidate);
  if (!code || code === "0x") {
    console.log(`  No contract at ${candidate} on this chain.`);
    console.log("");
    console.log("  Find the real one: open your wallet on this chain's block explorer,");
    console.log("  look at its NFT holdings for 'Uniswap V3 Positions', and copy that");
    console.log("  contract address. Then rerun:");
    console.log("");
    console.log("      node discover.js 0xThatAddress");
    console.log("");
    process.exit(1);
  }

  const npm = new ethers.Contract(candidate, NPM_ABI, provider);

  // Ownership is the real proof this is the right contract -- code existing at
  // an address proves nothing about what that code is.
  let owned = null;
  try {
    owned = await npm.balanceOf(cfg.ownerAddress);
  } catch {
    console.log(`  Contract at ${candidate} does not answer balanceOf.`);
    console.log("  It is probably not a Uniswap v3 position manager.");
    process.exit(1);
  }

  console.log(`  position manager  ${candidate}`);
  console.log(`  positions owned   ${owned}  by ${cfg.ownerAddress}`);

  if (owned === 0n) {
    console.log("");
    console.log("  Zero positions. Either ownerAddress is wrong, or this is the");
    console.log("  wrong chain, or the positions moved. Nothing else will work");
    console.log("  until this reads what you expect.");
    console.log("");
  }

  let factory = null;
  let weth = null;
  try {
    factory = await npm.factory();
    weth = await npm.WETH9();
  } catch {
    console.log("  Could not read factory()/WETH9() from it.");
    process.exit(1);
  }

  let wethSymbol = "?";
  try {
    wethSymbol = await new ethers.Contract(weth, ERC20_ABI, provider).symbol();
  } catch {}

  console.log(`  factory           ${factory}`);
  console.log(`  wrapped native    ${weth}  (${wethSymbol})`);
  console.log("");

  // List what is actually there, so you can eyeball it against the UI.
  const ids = [];
  for (let i = 0n; i < owned && i < 20n; i++) {
    ids.push(await npm.tokenOfOwnerByIndex(cfg.ownerAddress, i));
  }
  if (ids.length) {
    console.log("  positions found:");
    for (const id of ids) {
      try {
        const p = await npm.positions(id);
        const [s0, s1] = await Promise.all([
          new ethers.Contract(p.token0, ERC20_ABI, provider).symbol().catch(() => "?"),
          new ethers.Contract(p.token1, ERC20_ABI, provider).symbol().catch(() => "?"),
        ]);
        const dead = p.liquidity === 0n ? "  (closed)" : "";
        console.log(`    #${id}  ${s0}/${s1}  ${Number(p.fee) / 10000}%${dead}`);
      } catch {
        console.log(`    #${id}  (unreadable)`);
      }
    }
    console.log("");
  }

  console.log("  Paste into settings.json (collector.tokenIds):");
  console.log("");
  console.log(`    "chainId": ${chainId},`);
  console.log('    "contracts": {');
  console.log(`      "positionManager": "${candidate}",`);
  console.log(`      "factory": "${factory}",`);
  console.log(`      "weth": "${weth}",`);
  console.log('      "swapRouter02": "<only needed for the swap leg>",');
  console.log('      "quoterV2": "<only needed for the swap leg>"');
  console.log("    }");
  console.log("");
  console.log("  The dashboard needs only the three above. Router and quoter are");
  console.log("  used solely by the collector's swap leg -- get those from Uniswap's");
  console.log("  deployment docs for this chain when you need them.");
  console.log("");

  if (chainId !== 1) {
    console.log("  Also update usdReference.stable to a stablecoin that exists on");
    console.log("  this chain, or ETH pricing will fail and values will show as '-'.");
    console.log("");
  }
}

main().catch((e) => {
  console.error("failed:", e.shortMessage || e.message);
  process.exit(1);
});
