/**
 * base-vault-core.js -- pure helpers for preparing a LOKOVault on Base (8453). Reads one committed artifact
 * (checked against pinned hashes) and an optional injected read-only provider. No keys, no signing, no sending.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const flow = require("./base-vault/flow");

const ARTIFACT_PATH = path.join(__dirname, "artifacts", "base-vault.json");
const CHAIN_ID = 8453;
const CHAIN_ID_HEX = "0x2105";
const MAIN = "0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8";
const REGISTRY = "0x000000006551c19487814612e58FE06813775758";
const CHAIN_NAME = "Base";
const TOKEN_ID = 1;
const SALT = ethers.ZeroHash;
const TARGET_SPLIT = 20;
const NONCE_WINDOW = 8;
const DEFAULT_RPC = "https://mainnet.base.org";
// Informational only (research, eth_estimateGas from Main on Base). The wallet estimates for real.
const GAS = Object.freeze({ 1: 719433, 2: 2545368, 3: 197105, 4: 30637 });
// Canonical ERC-6551 registry runtime, as read from Base / Robinhood / Arc.
const REGISTRY_RUNTIME_KECCAK = "0xda1d5b06e579f9e42e59b00fbc22939896ecb38dc8830d40de0a2508fecd6735";
// The Arc implementation (identical build, metadata included).
const ARC_IMPL_RUNTIME_KECCAK = "0x4019de98b57e19d75b5891f785eb53ad8bdaa8508b8cfc6db7fea9c1a0334a07";
const SOLC_SETTINGS = Object.freeze({ optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris" });
const PREDICTION_NOTE = "If Main's Base nonce is 0, the research predicted impl 0x9932381F27f720DC1131349c4b4459F306d42DC7, NFT 0x094126611290c5EC8660e8f5dCa708e35aCA573C, TBA 0x86bb62E40EDe744BBC50bC873d7294Bf0Ec854a5.";

const PINNED = Object.freeze({
  solcVersion: "0.8.36+commit.8a079791.Emscripten.clang",
  account: Object.freeze({
    initCodeKeccak: "0x45129d8e74a094efe12798bd2e8ef25023d555b69d03267894f41df06c941b40",
    runtimeKeccak: "0x4019de98b57e19d75b5891f785eb53ad8bdaa8508b8cfc6db7fea9c1a0334a07",
  }),
  nft: Object.freeze({
    initCodeKeccak: "0x10c5c84bf8a6b1c5f56ea50df00b0fe2eb593bbc43f604780ac488c92a1e0594",
    runtimeKeccak: "0x2da581859890cea9d143a438e7ccbefee9ebcabe70d892575a0b2c4a4a3028c4", // registry slot zero-masked
  }),
  artifactFileSha256: "59860ad3107b12decdcc07333fabfb42045a7ed949f65c5a8b5f7bdad3ae59d4",
});

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const k256 = (hex) => ethers.keccak256(hex);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

class ArtifactError extends Error {}

/** Load the artifact and refuse anything that does not match the pins. Throws ArtifactError. */
function loadArtifact(file = ARTIFACT_PATH, pins = PINNED) {
  let raw;
  try { raw = fs.readFileSync(file); } catch (e) { throw new ArtifactError(`cannot read artifact: ${e.message}`); }
  if (sha256(raw) !== pins.artifactFileSha256) throw new ArtifactError("artifact file sha256 does not match the pinned value");
  let art;
  try { art = JSON.parse(raw.toString("utf8")); } catch (e) { throw new ArtifactError("artifact is not valid JSON"); }
  if (art.solcVersion !== pins.solcVersion) throw new ArtifactError(`artifact solcVersion ${art.solcVersion} is not the pinned ${pins.solcVersion}`);
  if (JSON.stringify(art.settings) !== JSON.stringify(SOLC_SETTINGS)) throw new ArtifactError("artifact compiler settings differ from the pinned settings");
  for (const w of ["account", "nft"]) {
    const c = art[w];
    if (!c || !/^0x[0-9a-f]+$/.test(c.initCode || "") || !/^0x[0-9a-f]+$/.test(c.runtime || "")) throw new ArtifactError(`artifact ${w} bytecode is malformed`);
    if (k256(c.initCode) !== pins[w].initCodeKeccak) throw new ArtifactError(`${w} initCode keccak256 does not match the pin`);
    if (k256(c.runtime) !== pins[w].runtimeKeccak) throw new ArtifactError(`${w} runtime keccak256 does not match the pin`);
  }
  return art;
}

/** Expected deployed code of a contract. For the NFT the immutable REGISTRY word is filled with `registry`. */
function expectedRuntime(which, registry = REGISTRY, art = loadArtifact()) {
  const c = art[which];
  if (!c) throw new Error(`unknown contract ${which}`);
  const hex = which === "nft" ? flow.fillImmutables(c.runtime, c.immutableReferences, registry) : c.runtime;
  return { hex, keccak: k256(hex) };
}

/** Recompile the .sol sources with the recorded settings and compare to the artifact. { ok, problems[] }. */
function verifyReproducible(art = loadArtifact(), solc = require("solc")) {
  const { compileArtifact } = require("./compile-base-vault");
  const fresh = compileArtifact(solc);
  const problems = [];
  if (fresh.solcVersion !== art.solcVersion) problems.push(`solc version ${fresh.solcVersion} != ${art.solcVersion}`);
  for (const w of ["account", "nft"]) {
    if (fresh[w].initCode !== art[w].initCode) problems.push(`${w} initCode differs`);
    if (fresh[w].runtime !== art[w].runtime) problems.push(`${w} runtime differs`);
    if (fresh.sourceSha256[w] !== art.sourceSha256[w]) problems.push(`${w} source sha256 differs`);
  }
  return { ok: problems.length === 0, problems };
}

const NFT_CTOR = ["address", "address", "string"];
const nftIface = new ethers.Interface(flow.NFT_ABI);

function buildSteps({ art, main = MAIN, impl, nft, registry = REGISTRY, only } = {}) {
  const base = { from: main, value: "0x0", chainId: CHAIN_ID_HEX };
  const steps = [];
  const want = (n) => !only || only === n;
  if (want(1)) {
    steps.push({ step: 1, name: "Deploy TreasuryAccount (implementation)", ...base, to: null, data: art.account.initCode,
      decoded: "contract creation, constructor takes no arguments",
      initCodeKeccak: k256(art.account.initCode), expectedRuntimeKeccak: expectedRuntime("account", registry, art).keccak,
      effects: "Creates the account implementation at CREATE(Main, nonce). Its deployed code hash must equal the expected runtime keccak256.", gas: GAS[1] });
  }
  if (want(2)) {
    if (!impl) throw new Error("step 2 needs --impl=<address> (or --predict)");
    const args = ethers.AbiCoder.defaultAbiCoder().encode(NFT_CTOR, [impl, registry, CHAIN_NAME]);
    steps.push({ step: 2, name: "Deploy TreasuryNFT (LOKOVault)", ...base, to: null, data: art.nft.initCode + args.slice(2),
      decoded: `contract creation, constructor(address _implementation=${impl}, address _registry=${registry}, string _chainName="${CHAIN_NAME}")`,
      initCodeKeccak: k256(art.nft.initCode), expectedRuntimeKeccak: expectedRuntime("nft", registry, art).keccak,
      effects: "Creates the LOKOVault NFT contract with Main as owner/admin. Its code hash must equal the expected runtime keccak256 (registry immutable filled).", gas: GAS[2] });
  }
  if (want(3)) {
    if (!nft) throw new Error("step 3 needs --nft=<address> (or --predict)");
    steps.push({ step: 3, name: "mint(Main) on the NFT", ...base, to: nft, data: nftIface.encodeFunctionData("mint", [main]),
      decoded: `mint(address to=${main})`,
      effects: "Mints LOKOVault #1 to Main and creates the ERC-6551 token-bound account through the canonical registry.", gas: GAS[3] });
  }
  if (want(4)) {
    if (!nft) throw new Error("step 4 needs --nft=<address> (or --predict)");
    steps.push({ step: 4, name: "setFeeSplitPct(20) (OPTIONAL)", optional: true, ...base, to: nft, data: nftIface.encodeFunctionData("setFeeSplitPct", [TARGET_SPLIT]),
      decoded: `setFeeSplitPct(uint256 pct=${TARGET_SPLIT})`,
      effects: "Raises the NFT's fee split from the default 10% to the 20% maximum. Skip to stay at 10%.", gas: GAS[4] });
  }
  return steps;
}

/** Read-only: Main's nonce and the addresses its next two CREATEs would produce. All of it is a prediction. */
async function predict(provider, main = MAIN, registry = REGISTRY) {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`RPC reports chain ${net.chainId}, not ${CHAIN_ID}; refusing`);
  const latest = await provider.getTransactionCount(main, "latest");
  const pending = await provider.getTransactionCount(main, "pending");
  const impl = ethers.getCreateAddress({ from: main, nonce: latest });
  const nft = ethers.getCreateAddress({ from: main, nonce: latest + 1 });
  const reg = new ethers.Contract(registry, flow.REG_ABI, provider);
  const tba = await reg.account(impl, SALT, CHAIN_ID, nft, TOKEN_ID);
  return { nonceLatest: latest, noncePending: pending, impl, nft, tba };
}

/** What the signing page receives at /plan.json. Everything in it comes from the verified artifact. */
function buildPlan(art = loadArtifact()) {
  return {
    constants: { main: MAIN, registry: REGISTRY, chainId: CHAIN_ID, chainIdHex: CHAIN_ID_HEX, chainName: CHAIN_NAME, tokenId: TOKEN_ID, salt: SALT, targetSplit: TARGET_SPLIT, K: NONCE_WINDOW },
    account: { initCode: art.account.initCode, runtimeKeccak: PINNED.account.runtimeKeccak },
    nft: { initCode: art.nft.initCode, runtime: art.nft.runtime, immutableReferences: art.nft.immutableReferences, runtimeKeccakMasked: PINNED.nft.runtimeKeccak },
    pins: PINNED, gas: GAS, solcVersion: art.solcVersion,
  };
}

module.exports = {
  ARTIFACT_PATH, CHAIN_ID, CHAIN_ID_HEX, MAIN, REGISTRY, CHAIN_NAME, TOKEN_ID, SALT, TARGET_SPLIT, NONCE_WINDOW, DEFAULT_RPC, GAS,
  REGISTRY_RUNTIME_KECCAK, ARC_IMPL_RUNTIME_KECCAK, SOLC_SETTINGS, PINNED, PREDICTION_NOTE, ArtifactError,
  loadArtifact, expectedRuntime, verifyReproducible, buildSteps, predict, buildPlan, same, sha256, flow,
};
