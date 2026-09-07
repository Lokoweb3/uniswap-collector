// Called by setup-key.ps1. Generates a fresh operator wallet and writes an
// scrypt-encrypted keystore. The passphrase arrives via env var and is never
// written to disk in plaintext.

const fs = require("fs");
const { ethers } = require("ethers");

async function main() {
  const outPath = process.argv[2];
  const pass = process.env.LP_SETUP_PASS;
  if (!outPath || !pass) {
    console.error("Usage: node make-wallet.js <keystore-path>  (LP_SETUP_PASS must be set)");
    process.exit(1);
  }

  const wallet = ethers.Wallet.createRandom();
  const json = await wallet.encrypt(pass);
  fs.writeFileSync(outPath, json, { mode: 0o600 });

  console.log("");
  console.log("Operator address: " + wallet.address);
  console.log("Keystore written: " + outPath);
  console.log("");
  console.log("This wallet holds only a gas float. It is NOT your position owner.");
  console.log("There is no seed phrase backup by design -- if you lose the keystore,");
  console.log("generate a new operator and re-approve. Nothing of value is lost.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
