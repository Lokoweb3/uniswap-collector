#!/usr/bin/env node
/**
 * One-shot: approve the operator wallet on specific position NFTs, signed by
 * the OWNER wallet.
 *
 *   node approve-operator.js 780078 780092 834424
 *   node approve-operator.js --check          # read-only, no key needed
 *
 * The owner key is prompted with echo off, kept only in process memory, and
 * never written anywhere. This is still your main wallet's key passing through
 * a hot machine — type it here, run the script, and treat the moment as brief.
 * The operator keystore under this project is not involved at all.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { ethers } = require("ethers");

const NPM_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function approve(address to, uint256 tokenId)",
];

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const onData = (ch) => {
      // Redraw the prompt without the typed characters so the key never shows.
      if (ch.toString() !== "\n" && ch.toString() !== "\r") {
        readline.moveCursor(process.stdout, 0, 0);
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(question);
      }
    };
    process.stdin.on("data", onData);
    rl.question(question, (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  const checkOnly = process.argv.includes("--check");
  const ids = process.argv.slice(2).filter((a) => /^\d+$/.test(a));

  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(cfg.chainId)) {
    console.error(`RPC is chain ${net.chainId}, config says ${cfg.chainId}. Stopping.`);
    process.exit(1);
  }

  // Operator address comes from the collector's keystore file, read-only —
  // the address field needs no passphrase.
  const keystorePath =
    process.env.LP_KEYSTORE_PATH ||
    path.join(process.env.HOME || "", ".lp-collector", "operator-keystore.json");
  let operator;
  if (fs.existsSync(keystorePath)) {
    const ks = JSON.parse(fs.readFileSync(keystorePath, "utf8"));
    operator = ethers.getAddress("0x" + ks.address.replace(/^0x/, ""));
  } else {
    console.error(`Operator keystore not found at ${keystorePath}; cannot determine the operator address.`);
    process.exit(1);
  }

  const npm = new ethers.Contract(cfg.contracts.positionManager, NPM_ABI, provider);

  if (ids.length === 0 && !checkOnly) {
    console.error("Usage: node approve-operator.js <tokenId> [tokenId...]   (or --check)");
    process.exit(1);
  }

  console.log(`chain      ${net.chainId}`);
  console.log(`positions  ${cfg.contracts.positionManager}`);
  console.log(`owner      ${cfg.ownerAddress}`);
  console.log(`operator   ${operator}`);
  console.log("");

  if (checkOnly) {
    // With no ids given, --check has nothing to enumerate cheaply; require ids.
    const list = ids.length ? ids : [];
    if (!list.length) {
      console.error("--check needs tokenIds to check: node approve-operator.js --check 780078 ...");
      process.exit(1);
    }
    for (const id of list) {
      const approved = await npm.getApproved(id);
      const ok = approved.toLowerCase() === operator.toLowerCase();
      console.log(`#${id}  approved: ${ok ? "operator ✓" : approved === ethers.ZeroAddress ? "none" : approved}`);
    }
    return;
  }

  const key = await promptHidden("Owner wallet private key (echo off, memory only): ");
  let wallet;
  try {
    wallet = new ethers.Wallet(key, provider);
  } catch {
    console.error("That does not parse as a private key.");
    process.exit(1);
  }
  if (wallet.address.toLowerCase() !== cfg.ownerAddress.toLowerCase()) {
    console.error(`Key is for ${wallet.address}, but ownerAddress is ${cfg.ownerAddress}. Stopping.`);
    process.exit(1);
  }

  const npmWrite = npm.connect(wallet);

  for (const id of ids) {
    const owner = await npm.ownerOf(id).catch(() => null);
    if (!owner || owner.toLowerCase() !== cfg.ownerAddress.toLowerCase()) {
      console.log(`#${id}  not owned by ${cfg.ownerAddress} — skipping`);
      continue;
    }
    const already = await npm.getApproved(id);
    if (already.toLowerCase() === operator.toLowerCase()) {
      console.log(`#${id}  already approved — skipping`);
      continue;
    }
    const tx = await npmWrite.approve(operator, id);
    process.stdout.write(`#${id}  approve -> ${tx.hash}`);
    const rcpt = await tx.wait();
    console.log(`  confirmed in block ${rcpt.blockNumber}`);
  }

  console.log("\nDone. Verify with: node approve-operator.js --check " + ids.join(" "));
}

main().catch((e) => {
  console.error("failed:", e.shortMessage || e.message);
  process.exit(1);
});
