// node test/gone-guard.test.js — the narrow rule this file was written for: an
// RPC that answers with nothing must never be read as "burned".
//
// The full matrix now lives in test/burn-guard.test.js, which replaced message
// matching with verification. This keeps the original case pinned, and pins the
// part of the old contract that changed deliberately: a bare revert is no longer
// enough on its own, because a revert is what an unrelated failure looks like too.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "goneguard-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const v4 = require("../univ4");

const ZERO = "0x" + "00".repeat(20);
const OWNER = "0x" + "22".repeat(20);
const cfg = { ownerAddress: OWNER, chainId: 5042, contracts: { v4: {} }, denylist: [] };
const provider = { async getNetwork() { return { chainId: 5042n }; }, async getCode() { return "0xbeef"; } };
const boom = (m) => { const e = new Error(m); e.shortMessage = m; return e; };
const { ethers } = require("ethers");
const errString = (r) => "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], [r]).slice(2);
const revert = () => { const e = boom("execution reverted"); e.code = "CALL_EXCEPTION"; e.data = errString("NOT_MINTED"); return e; };
const empty = () => { const e = boom("missing revert data"); e.code = "CALL_EXCEPTION"; e.data = null; return e; };
const posmFor = (ownerOfErr, poolInfo) => ({
  target: "0x" + "11".repeat(20),
  async ownerOf() { throw typeof ownerOfErr === "function" ? ownerOfErr() : boom(ownerOfErr); },
  async getPoolAndPositionInfo() { if (poolInfo instanceof Error) throw poolInfo; return poolInfo; },
  async getPositionLiquidity() { return 0n; },
});
const load = (posm) => v4.loadPosition({ provider, posm, stateView: {}, cfg }, 1n);

(async () => {
  // ---- an empty answer is an error, never a burn ----------------------------
  for (const msg of ["missing revert data", 'missing revert data (action="call", data=null)']) {
    let threw = null, result = null;
    try { result = await load(posmFor(empty, empty())); } catch (e) { threw = e; }
    assert.ok(threw, "an empty answer must surface as an error: got " + JSON.stringify(result));
    assert.ok(!result || !result.gone, "and must never be reported as gone");
    assert.ok(threw.unverified, "and must be marked unverified");
  }

  // ---- a revert alone is no longer enough -----------------------------------
  // This is the deliberate change: the token still has a pool key, so whatever
  // reverted, it was not the token ceasing to exist.
  for (const msg of ["execution reverted", "ERC721: invalid token ID", "nonexistent token"]) {
    let threw = null, result = null;
    try { result = await load(posmFor(revert, { key: { currency0: "0x" + "aa".repeat(20), currency1: "0x" + "bb".repeat(20) } })); } catch (e) { threw = e; }
    assert.ok(!result || !result.gone, `"${msg}" with a live pool key must not be a burn`);
    assert.ok(threw && threw.unverified, "it is an unverified read");
  }

  // ---- a revert plus an empty pool key still is a burn ----------------------
  {
    const r = await load(posmFor(revert, { key: { currency0: ZERO, currency1: ZERO } }));
    assert.strictEqual(r.gone, true, "no owner and no pool key is a real burn");
    assert.strictEqual(r.verified, true, "and it is marked verified");
  }

  // ---- transport failures are still errors ----------------------------------
  for (const msg of ["timeout", "429 Too Many Requests", "network error"]) {
    let threw = null;
    try { await load(posmFor(() => { const e = boom(msg); e.code = "NETWORK_ERROR"; return e; }, boom(msg))); } catch (e) { threw = e; }
    assert.ok(threw, "a transient failure must throw, not report gone: " + msg);
  }

  console.log("gone guard: an empty RPC answer is an error, and a burn needs more than a revert");
})().catch((e) => { console.error(e); process.exit(1); });
