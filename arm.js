/**
 * Wallet-signature arming for the collector (arm.html).
 *
 * The collector can only sign when the operator keystore's passphrase sits in
 * the RAM cache (/dev/shm, same files unlock.sh writes). Today the owner types
 * that passphrase for every window. Here the owner's wallet signature replaces
 * it:
 *
 *   setup (once): owner signs a fixed message; the signature bytes are hashed
 *   into an AES-256-GCM key; the passphrase is verified against the keystore
 *   and stored encrypted under that key in ~/.lp-collector/arm-secret.json.
 *
 *   arm: owner signs the same message again (EOA signatures are deterministic
 *   for the same key and message), the server recreates the key, decrypts the
 *   passphrase, checks it still opens the keystore, and writes the RAM cache
 *   with the requested TTL.
 *
 * So nothing on disk can be decrypted without the owner's wallet, and the
 * signature is only ever accepted over loopback (the public gate refuses
 * /api/arm). The message names the chain, owner and operator so a signature
 * made for one setup cannot arm another; replacing the keystore changes the
 * message and requires a fresh setup.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");

const SECRET_FILE = path.join(process.env.HOME || "", ".lp-collector", "arm-secret.json");

function keystorePath() {
  return process.env.LP_KEYSTORE_PATH || path.join(process.env.HOME || "", ".lp-collector", "operator-keystore.json");
}
function operatorAddress() {
  try {
    return ethers.getAddress("0x" + JSON.parse(fs.readFileSync(keystorePath(), "utf8")).address.replace(/^0x/, ""));
  } catch {
    return null;
  }
}

/** The fixed message the owner signs. Tied to chain, owner and operator. */
/**
 * The text the owner signs.
 *
 * Everything in it used to be public: the template is in this repository, and the
 * chain id, owner and operator are on chain. Anyone could therefore compose the
 * exact string and ask the owner to sign it on some unrelated page -- a signature
 * request that looks harmless, costs nothing and moves no funds, which is precisely
 * what the text says. That signature is the key to arm-secret.json.
 *
 * The salt is 16 random bytes made at setup and kept in that file, so the string
 * cannot be composed by anyone who has not already read it. It is not a secret in
 * the cryptographic sense -- it is shown to the owner before signing -- but it is
 * not guessable, and that is what breaks the phishing path.
 *
 * The first line names who is asking, so a signature prompt that says something
 * else is visibly not this dashboard.
 */
const DEFAULT_ORIGIN = "127.0.0.1:8787";
function message(cfg, salt, origin = DEFAULT_ORIGIN) {
  if (!salt) throw new Error("arm message needs a salt; run setup again");
  return [
    `${origin} wants you to sign this message`,
    "",
    "LP collector arm key v1",
    `chain: ${cfg.chainId}`,
    `owner: ${cfg.ownerAddress}`,
    `operator: ${operatorAddress() || "none"}`,
    `nonce: ${salt}`,
    "",
    "Signing this lets the local dashboard arm the fee collector for a limited time. It costs nothing and moves no funds.",
  ].join("\n");
}

// The salt offered for a setup that has not happened yet. Held in memory only: it
// becomes permanent when setup stores it, and a restart before that simply offers a
// new one, since nothing has been signed against the old one.
let pendingSalt = null;
const newSalt = () => crypto.randomBytes(16).toString("hex");
function storedRecord() {
  try { return JSON.parse(fs.readFileSync(SECRET_FILE, "utf8")); } catch { return null; }
}
/**
 * The salt in force: the stored one once set up, otherwise a pending one. A record
 * written before salting has none, and cannot be armed -- the signature it holds was
 * made over the old text, so there is nothing to recompute it from.
 */
function currentSalt() {
  const rec = storedRecord();
  if (rec) {
    if (!rec.salt) throw new Error("this arm-secret.json predates the signed-message nonce; run setup again to replace it");
    return rec.salt;
  }
  if (!pendingSalt) pendingSalt = newSalt();
  return pendingSalt;
}
/** The exact text to sign right now, salt included. */
const currentMessage = (cfg, origin) => message(cfg, currentSalt(), origin);

/** Recover the signer of `signature` over the current message; throws unless it is the owner. */
function verify(cfg, signature, origin) {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("malformed signature");
  const signer = ethers.verifyMessage(currentMessage(cfg, origin), signature);
  if (signer.toLowerCase() !== String(cfg.ownerAddress).toLowerCase()) throw new Error("signature is not from the owner wallet");
  return signer;
}
const keyFrom = (signature) => Buffer.from(ethers.keccak256(ethers.getBytes(signature)).slice(2), "hex");

function configured() {
  try {
    const s = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
    return { configured: true, operator: s.operator, createdAt: s.createdAt };
  } catch {
    return { configured: false };
  }
}

/** Verify the passphrase opens the keystore (slow: scrypt). */
async function checkPassphrase(passphrase) {
  const json = fs.readFileSync(keystorePath(), "utf8");
  await ethers.Wallet.fromEncryptedJson(json, passphrase); // throws on a wrong passphrase
}

async function setup(cfg, { signature, passphrase, origin }) {
  // The salt is fixed before the signature is checked, so the text verified here is
  // the text that gets stored: a setup racing a restart cannot store one salt and
  // verify another.
  const salt = currentSalt();
  verify(cfg, signature, origin);
  if (!passphrase) throw new Error("passphrase required");
  await checkPassphrase(passphrase);
  const key = keyFrom(signature);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(passphrase, "utf8"), cipher.final()]);
  const rec = { version: 2, salt, owner: cfg.ownerAddress, operator: operatorAddress(), iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ct.toString("hex"), createdAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SECRET_FILE, JSON.stringify(rec, null, 2), { mode: 0o600 });
  fs.chmodSync(SECRET_FILE, 0o600);
  pendingSalt = null;   // it is the stored one now
}

/** Decrypt the passphrase with the owner's signature. Throws if not set up or the signature does not fit. */
function decrypt(cfg, signature, origin) {
  verify(cfg, signature, origin);
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
  } catch {
    throw new Error("not set up yet: save the passphrase once with a wallet signature");
  }
  if (rec.operator && operatorAddress() && rec.operator.toLowerCase() !== operatorAddress().toLowerCase()) {
    throw new Error("the operator keystore changed since setup; run setup again");
  }
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", keyFrom(signature), Buffer.from(rec.iv, "hex"));
    d.setAuthTag(Buffer.from(rec.tag, "hex"));
    return Buffer.concat([d.update(Buffer.from(rec.ciphertext, "hex")), d.final()]).toString("utf8");
  } catch {
    throw new Error("this signature does not unlock the saved passphrase (different wallet, or setup was made with another signature)");
  }
}

/** Arm: write the RAM cache the collector reads. Returns minutes. */
async function arm(cfg, { signature, minutes, origin }, cacheFile) {
  // Clamped to settings arm.maxMinutes (default 24 h, hard cap 7 days); /dev/shm clears on a WSL restart anyway.
  const maxMins = Math.max(1, Math.min(10080, Number(cfg.armMaxMinutes) || 1440));
  const mins = Math.max(1, Math.min(maxMins, Number(minutes) || 120));
  const passphrase = decrypt(cfg, signature, origin);
  await checkPassphrase(passphrase); // keystore may have been re-encrypted
  fs.writeFileSync(cacheFile, passphrase, { mode: 0o600 });
  fs.writeFileSync(`${cacheFile}.ttl`, String(Math.floor(Date.now() / 1000) + mins * 60), { mode: 0o600 });
  fs.chmodSync(cacheFile, 0o600);
  fs.chmodSync(`${cacheFile}.ttl`, 0o600);
  return mins;
}

function forget() {
  fs.rmSync(SECRET_FILE, { force: true });
}

// The intended arm window, kept on disk. /dev/shm is wiped by a WSL restart,
// so comparing this with the cache tells "expired" apart from "lost".
const WINDOW_FILE = path.join(process.env.HOME || "", ".lp-collector", "arm-window.json");
function rememberWindow(untilEpochSec) {
  try {
    fs.mkdirSync(path.dirname(WINDOW_FILE), { recursive: true, mode: 0o700 });
    fs.writeFileSync(WINDOW_FILE, JSON.stringify({ until: Number(untilEpochSec), at: Date.now() }), { mode: 0o600 });
  } catch {}
}
function expectedWindow() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_FILE, "utf8"));
  } catch {
    return null;
  }
}
function clearWindow() {
  fs.rmSync(WINDOW_FILE, { force: true });
}

module.exports = { message, currentMessage, currentSalt, verify, configured, setup, arm, forget, operatorAddress, SECRET_FILE, rememberWindow, expectedWindow, clearWindow };
