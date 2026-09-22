// node test/arm-salt.test.js — the arm message cannot be composed by a stranger.
//
// The key that decrypts arm-secret.json is keccak(signature), and the signature is
// over a message built entirely from public facts: a template in this repository,
// the chain id, the owner address and the operator address. Anyone could therefore
// compose the exact string and put it in front of the owner on an unrelated page.
// The text itself reassures them — "It costs nothing and moves no funds" — which is
// true, and beside the point: that signature is the key to the stored passphrase.
//
// A 16-byte nonce, made at setup and kept in that file, breaks the composition. It
// is not secret from the owner, who sees it before signing; it is simply not
// guessable by someone who has not read the file.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const OLD_HOME = process.env.HOME;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arm-salt-"));
process.env.HOME = dir;
fs.mkdirSync(path.join(dir, ".lp-collector"), { recursive: true });
const SECRET = path.join(dir, ".lp-collector", "arm-secret.json");
const CACHE = path.join(dir, "cache");

const arm = require("../arm");
const ORIGIN = "127.0.0.1:8787";

// The message built the old way, which anyone could reproduce.
const oldMessage = (cfg) => [
  "LP collector arm key v1",
  `chain: ${cfg.chainId}`,
  `owner: ${cfg.ownerAddress}`,
  `operator: ${arm.operatorAddress() || "none"}`,
  "",
  "Signing this lets the local dashboard arm the fee collector for a limited time. It costs nothing and moves no funds.",
].join("\n");

(async () => {
  const wallet = ethers.Wallet.createRandom();
  const passphrase = "test-only-passphrase";
  fs.writeFileSync(path.join(dir, ".lp-collector", "operator-keystore.json"), await wallet.encrypt(passphrase));
  const cfg = { chainId: 4663, ownerAddress: wallet.address, armMaxMinutes: 120 };

  // ---- 1. a salted setup, then arming with the same signature -----------------
  const msg = arm.currentMessage(cfg, ORIGIN);
  assert.strictEqual(msg.split("\n")[0], `${ORIGIN} wants you to sign this message`,
    "the first line names who is asking, so a prompt claiming otherwise is visibly not this dashboard");
  assert.match(msg, /^nonce: [0-9a-f]{32}$/m, "and the message carries a 16-byte nonce");
  assert.ok(msg.indexOf("nonce:") < msg.indexOf("\n\nSigning this"), "before the blank line, with the other facts");

  const sig = await wallet.signMessage(msg);
  await arm.setup(cfg, { signature: sig, passphrase, origin: ORIGIN });
  const rec = JSON.parse(fs.readFileSync(SECRET, "utf8"));
  assert.match(rec.salt, /^[0-9a-f]{32}$/, "the nonce is stored");
  assert.strictEqual(rec.version, 2, "and the record says which format it is");
  assert.strictEqual(await arm.arm(cfg, { signature: sig, minutes: 5, origin: ORIGIN }, CACHE), 5,
    "the same signature arms, because the message is the same");
  assert.strictEqual(fs.readFileSync(CACHE, "utf8"), passphrase, "and the passphrase reaches the cache");

  // The nonce is stable once stored: a second read offers the same message, or the
  // owner would be asked to re-sign on every page load.
  assert.strictEqual(arm.currentMessage(cfg, ORIGIN), msg, "the message does not change under a configured setup");

  // ---- 2. a signature over the old, guessable message is refused --------------
  const forged = await wallet.signMessage(oldMessage(cfg));
  await assert.rejects(() => arm.arm(cfg, { signature: forged, minutes: 5, origin: ORIGIN }, CACHE),
    /not from the owner/, "a signature over the unsalted text does not arm, even from the owner's own key");

  // Nor does one made for a different asker.
  const elsewhere = await wallet.signMessage(arm.currentMessage(cfg, "evil.example"));
  await assert.rejects(() => arm.arm(cfg, { signature: elsewhere, minutes: 5, origin: ORIGIN }, CACHE),
    /not from the owner/, "nor one whose first line names somewhere else");

  // ---- 3. a record from before salting says to run setup again ----------------
  delete rec.salt;
  fs.writeFileSync(SECRET, JSON.stringify(rec));
  // It still cannot be armed -- that is the guarantee -- but the refusal now lives in
  // decrypt() rather than in the message builder. Throwing there wedged the page: setup
  // and forget also need a signable message, so the only advertised way out raised the
  // very error it told the owner to clear.
  await assert.rejects(() => arm.arm(cfg, { signature: sig, minutes: 5, origin: ORIGIN }, CACHE),
    /run setup again/, "an old record cannot be armed until it is replaced");
  const replacement = arm.currentMessage(cfg, ORIGIN);
  assert.match(replacement, /nonce: [0-9a-f]{32}/, "but it still offers a signable message, so setup can replace it");
  assert.notStrictEqual(replacement, msg, "and that message carries a new nonce, not the one it was stored with");
  assert.strictEqual(arm.configured().configured, false,
    "and it reports as unconfigured, so the page offers setup instead of an Arm button that can only fail");

  // ---- 4. the nonce is fresh per setup ----------------------------------------
  fs.rmSync(SECRET);
  const second = arm.currentMessage(cfg, ORIGIN);
  assert.notStrictEqual(second, msg, "a new setup offers a new nonce rather than reusing the last one");

  fs.rmSync(dir, { recursive: true, force: true });
  process.env.HOME = OLD_HOME;
  console.log("arm salt: the signed message names the asker and carries a stored 16-byte nonce, a signature over the old public text no longer arms, and a pre-salt record says to run setup again");
})().catch((e) => {
  process.env.HOME = OLD_HOME;
  console.error(e);
  process.exit(1);
});
