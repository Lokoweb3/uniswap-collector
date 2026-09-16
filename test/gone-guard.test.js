// node test/gone-guard.test.js — an RPC that answers with nothing must never be
// read as "this position was burned or transferred away".
//
// loadPosition marks a position `gone` when ownerOf reverts, and watch.js then
// deletes the id from discovery permanently. Ethers words an empty eth_call
// response as "missing revert data", which contains "revert" and so matched the
// burn test. On Arc, entries inside a batched call come back empty, and live
// positions were being forgotten for good.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "goneguard-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const v4 = require("../univ4");

(async () => {
const cfg = { ownerAddress: "0x" + "22".repeat(20), contracts: { v4: {} }, denylist: [] };
const posmThatFails = (message) => ({ ownerOf: async () => { const e = new Error(message); e.shortMessage = message; throw e; } });

// ---- an empty answer is an error, never a burn ------------------------------
for (const msg of ["missing revert data", "missing revert data (action=\"call\", data=null)"]) {
  let threw = null, result = null;
  try {
    result = await (v4.loadPosition({ provider: {}, posm: posmThatFails(msg), stateView: {}, cfg }, 1n));
  } catch (e) { threw = e; }
  assert.ok(threw, "an empty answer must surface as an error, not a result: got " + JSON.stringify(result));
  assert.ok(!result || !result.gone, "and must never be reported as gone");
  assert.ok(/missing revert data/i.test(threw.message), "the reason is preserved: " + threw.message);
}

// ---- a genuine burn is still a burn -----------------------------------------
for (const msg of ["execution reverted", "ERC721: invalid token ID", "nonexistent token"]) {
  const r = await (v4.loadPosition({ provider: {}, posm: posmThatFails(msg), stateView: {}, cfg }, 2n));
  assert.strictEqual(r.gone, true, "a real revert still means gone: " + msg);
}

// ---- a transient failure is still an error, not a burn ----------------------
for (const msg of ["timeout", "429 Too Many Requests", "network error"]) {
  let threw = null;
  try { await (v4.loadPosition({ provider: {}, posm: posmThatFails(msg), stateView: {}, cfg }, 3n)); }
  catch (e) { threw = e; }
  assert.ok(threw, "a transient failure must throw, not report gone: " + msg);
}

})().then(() => console.log("gone guard: an empty RPC answer is an error, a real revert is still a burn")).catch((e) => { console.error(e); process.exit(1); });

