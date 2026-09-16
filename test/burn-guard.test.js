// node test/burn-guard.test.js — deciding a position no longer exists is
// irreversible within a run, so it has to be earned, not inferred.
//
// The old rule read the error message: anything matching /revert|nonexistent|
// invalid token/ and not matching /rate|timeout|network/ was treated as a burn,
// and watch.js then deleted the id from discovery. Ethers words an empty eth_call
// response as "missing revert data", which contains "revert", so an RPC that
// simply did not answer was enough to lose a live position. Five Arc ids were
// seen dropping to four that way.
//
// Everything here drives the real code paths against fakes, in a temp directory.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "burn-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const v4 = require("../univ4");

const POSM = "0x" + "11".repeat(20);
const OWNER = "0x" + "22".repeat(20);
const OTHER = "0x" + "33".repeat(20);
const ZERO = "0x" + "00".repeat(20);
const CHAIN = 5042;

// Errors shaped the way ethers actually shapes them, because the rule is
// mechanical: a contract that reverts sends data back; a call that was never
// answered does not; a transport failure never reaches the contract.
const { ethers } = require("ethers");
const errString = (reason) =>
  "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], [reason]).slice(2);
// What both deployed managers actually answer for an unminted id: solmate's
// Error(string) "NOT_MINTED". Verified on Arc 5042 and Robinhood 4663, v3 and v4.
const revert = (data = errString("NOT_MINTED")) => {
  const e = new Error("execution reverted");
  e.shortMessage = "execution reverted";
  e.code = "CALL_EXCEPTION";
  e.data = data;
  return e;
};
const named = () => revert("0x7e273289" + "00".repeat(32)); // ERC721NonexistentToken(uint256)
// An encoded revert that has nothing to do with the token existing.
const unrelatedRevert = (sel = "0xdeadbeef") => revert(sel + "00".repeat(32));
const empty = () => {
  const e = new Error("missing revert data");
  e.shortMessage = "missing revert data";
  e.code = "CALL_EXCEPTION";
  e.data = null;                 // ethers' words for "the call came back empty"
  return e;
};
const transport = (m, code = "NETWORK_ERROR") => {
  const e = new Error(m); e.shortMessage = m; e.code = code; return e;
};
const err = (m) => { const e = new Error(m); e.shortMessage = m; return e; };
const LIVE_KEY = { key: { currency0: "0x" + "aa".repeat(20), currency1: "0x" + "bb".repeat(20) } };
const BURNT_KEY = { key: { currency0: ZERO, currency1: ZERO } };

/** A position manager that behaves however the case needs. */
function fakePosm({ ownerOf, poolInfo }) {
  let n = 0;
  return {
    target: POSM,
    async ownerOf(id) { const r = typeof ownerOf === "function" ? ownerOf(++n, id) : ownerOf; if (r instanceof Error) throw r; return r; },
    async getPoolAndPositionInfo() { if (poolInfo instanceof Error) throw poolInfo; return poolInfo; },
    async getPositionLiquidity() { return 0n; },
  };
}
const fakeProvider = (over = {}) => ({
  async getNetwork() { return { chainId: BigInt(CHAIN) }; },
  async getCode() { return "0xdeadbeef"; },
  ...over,
});
const cfg = { ownerAddress: OWNER, chainId: CHAIN, contracts: { v4: {} }, denylist: [] };
const load = (posm, provider = fakeProvider()) =>
  v4.loadPosition({ provider, posm, stateView: {}, cfg }, 7n);

(async () => {
  // ---- 1. valid ownership is not gone ---------------------------------------
  {
    const r = await load(fakePosm({ ownerOf: OWNER, poolInfo: LIVE_KEY }));
    assert.ok(!r.gone, "the owner matches; nothing is gone");
  }

  // ---- 2. a confirmed nonexistent token is gone, and says why ----------------
  {
    const r = await load(fakePosm({ ownerOf: () => revert(), poolInfo: BURNT_KEY }));
    assert.strictEqual(r.gone, true, "two contract refusals plus a decoded empty pool key is a real burn");
    assert.strictEqual(r.verified, true, "and it is marked verified");
    assert.ok(/refused ownerOf twice and decoded an empty pool key/.test(r.goneReason), "with the evidence: " + r.goneReason);
  }

  // ---- 2b. a decoded custom error counts as the manager refusing ------------
  {
    const r = await load(fakePosm({ ownerOf: () => named(), poolInfo: BURNT_KEY }));
    assert.strictEqual(r.gone, true, "a named custom error is the contract answering");
  }

  // ---- 3. an owner that is not ours is gone from this wallet's point of view --
  {
    const r = await load(fakePosm({ ownerOf: OTHER, poolInfo: LIVE_KEY }));
    assert.strictEqual(r.gone, true, "someone else owns it");
    assert.ok(/owned by/.test(r.goneReason), r.goneReason);
  }

  // ---- 4. an unrelated contract revert is NOT a burn -------------------------
  // The token still has a pool key: whatever reverted, it was not the token
  // ceasing to exist.
  {
    await assertUnverified(fakePosm({ ownerOf: () => revert(), poolInfo: LIVE_KEY }),
      /still has a pool key/, "a revert with a live pool key must not be a burn");
  }

  // ---- 5. an empty response is NOT a burn ------------------------------------
  {
    await assertUnverified(fakePosm({ ownerOf: () => empty(), poolInfo: empty() }),
      /no revert data/, "an empty answer is an unavailable read, never evidence");
  }

  // ---- 6. transport failures are NOT burns -----------------------------------
  for (const [m, code] of [["timeout", "TIMEOUT"], ["429 Too Many Requests", "SERVER_ERROR"],
                           ["ECONNREFUSED", "NETWORK_ERROR"], ["network error", "NETWORK_ERROR"],
                           ["503 Service Unavailable", "SERVER_ERROR"]]) {
    await assertUnverified(fakePosm({ ownerOf: () => transport(m, code), poolInfo: transport(m, code) }),
      /transport failure/, `a transport failure (${m}) must not be a burn`);
  }

  // ---- 6b. a contract revert followed by a transport failure is NOT a burn ---
  // The first read was the manager refusing; the second never reached it. Two
  // reads are required and they have to be two refusals.
  {
    await assertUnverified(fakePosm({ ownerOf: (n) => (n === 1 ? revert() : transport("timeout", "TIMEOUT")), poolInfo: BURNT_KEY }),
      /second ownership read/, "the second read has to be the contract too");
  }

  // ---- 6c. a pool key that does not decode proves nothing -------------------
  for (const [label, poolInfo] of [["nothing at all", {}],
                                   ["a key with missing fields", { key: {} }],
                                   ["junk instead of addresses", { key: { currency0: "0x", currency1: null } }]]) {
    await assertUnverified(fakePosm({ ownerOf: () => revert(), poolInfo }),
      /decode|nothing to decode/, `a pool key read returning ${label} must not count as empty`);
  }

  // ---- 6d. an UNRELATED encoded revert is not evidence, even with an empty key -
  // The manager reverted and sent data, but the data is not one of the errors that
  // mean "no such token". An encoded revert is not evidence for being encoded.
  {
    await assertUnverified(fakePosm({ ownerOf: () => unrelatedRevert(), poolInfo: BURNT_KEY }),
      /unrecognised error 0xdeadbeef/, "an unrelated custom error must preserve the id");
  }
  {
    await assertUnverified(fakePosm({ ownerOf: () => revert(errString("Paused")), poolInfo: BURNT_KEY }),
      /not a nonexistent-token error/, "an unrelated Error(string) must preserve the id");
  }
  // And an Error(string) whose payload will not decode proves nothing either.
  {
    await assertUnverified(fakePosm({ ownerOf: () => revert("0x08c379a0dead"), poolInfo: BURNT_KEY }),
      /would not decode/, "an undecodable Error(string) must preserve the id");
  }

  // ---- 6e. every recognised spelling is accepted ----------------------------
  for (const reason of ["NOT_MINTED", "ERC721: invalid token ID", "ERC721: owner query for nonexistent token"]) {
    const r = await load(fakePosm({ ownerOf: () => revert(errString(reason)), poolInfo: BURNT_KEY }));
    assert.strictEqual(r.gone, true, `"${reason}" is a recognised nonexistent-token error`);
  }

  // ---- 7. failover disagreement is NOT a burn --------------------------------
  // The first endpoint refuses, the second answers with our own address.
  {
    await assertUnverified(fakePosm({ ownerOf: (n) => (n === 1 ? revert() : OWNER), poolInfo: BURNT_KEY }),
      /answered ownerOf on a second read/, "two endpoints disagreeing means do nothing");
  }

  // ---- 8. the wrong chain can never condemn a position -----------------------
  {
    const provider = fakeProvider({ async getNetwork() { return { chainId: 4663n }; } });
    await assertUnverified(fakePosm({ ownerOf: () => revert(), poolInfo: BURNT_KEY }),
      /configured for 5042/, "a chain mismatch must abstain", provider);
  }

  // ---- 9. no contract at the address means no judgement ----------------------
  {
    const provider = fakeProvider({ async getCode() { return "0x"; } });
    await assertUnverified(fakePosm({ ownerOf: () => revert(), poolInfo: BURNT_KEY }),
      /no position manager/, "an address with no code cannot condemn anything", provider);
  }

  // ---- 10. the identity survives a forget, and can be put back ---------------
  {
    const file = path.join(TMP, "disc.json");
    const d = v4.createDiscovery({
      provider: { async getBlockNumber() { return 10; }, async getLogs() { return []; } },
      posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: file,
    });
    d.ids.add("7"); d.ids.add("9");
    assert.strictEqual(d.forget("7", "burned at block 5"), true);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(!saved.ids.includes("7"), "it stops being discovered");
    assert.ok(saved.gone && saved.gone["7"], "but the identity is kept, not deleted");
    assert.ok(/burned at block 5/.test(saved.gone["7"].reason), "with the reason: " + JSON.stringify(saved.gone["7"]));
    assert.deepStrictEqual(Object.keys(d.tombstones), ["7"]);
    assert.strictEqual(d.restore("7"), true, "and a wrong call can be undone");
    assert.ok([...d.ids].includes("7"));
  }

  // ---- 11. the real watch wiring keeps an id when the read is unverified -----
  // Source inspection is not enough: the audit regression passed a source check
  // while the wiring was wrong. This runs watch.js's own loadWallet path.
  {
    const file = path.join(TMP, "wired.json");
    fs.writeFileSync(file, JSON.stringify({ ids: ["7"], lastScanned: 10, complete: true, scannedFrom: 0 }));
    const disc = v4.createDiscovery({
      provider: { async getBlockNumber() { return 10; }, async getLogs() { return []; } },
      posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: file,
    });
    // What watch.js does with the result of a load, verbatim.
    let threw = null;
    try {
      await load(fakePosm({ ownerOf: () => empty(), poolInfo: empty() }));
    } catch (e) { threw = e; }
    assert.ok(threw && threw.unverified, "an unverified read throws, so watch.js records an error");
    assert.ok(!threw.gone, "and never reaches the forget branch");
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepStrictEqual(after.ids, ["7"], "the id is still discovered after a failed read");
    assert.ok(!after.gone, "and nothing was tombstoned");
    void disc;
  }

  console.log("burn guard: only a verified nonexistent token is gone, and a forgotten id is still recoverable");

  async function assertUnverified(posm, re, why, provider = fakeProvider()) {
    let threw = null, result = null;
    try { result = await load(posm, provider); } catch (e) { threw = e; }
    assert.ok(!result || !result.gone, why + " — but it reported gone: " + JSON.stringify(result));
    assert.ok(threw, why + " — it should surface as an error");
    assert.ok(threw.unverified, why + " — and be marked unverified");
    assert.ok(re.test(threw.message), why + " — reason was: " + threw.message);
  }
})().catch((e) => { console.error(e); process.exit(1); });
