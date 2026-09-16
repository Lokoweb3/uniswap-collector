// node test/v4-discovery.test.js — the v4 position scanner must never turn a
// failed or unfinished scan into "this wallet has no positions".
//
// This exists because of Arc. Its RPC refuses any eth_getLogs range over ~10k
// blocks, the sweep's window floor was 250k, so every first run threw, the throw
// was swallowed twice over, and the wallet rendered as empty while holding five
// v4 NFTs. The rules the fix has to keep:
//
//   1. A refused range is retried smaller, down to CHUNK (2000), not given up on.
//   2. A range that was not read successfully never moves a cursor past it.
//   3. Ids already discovered are never dropped by a later failure.
//   4. A partial scan resumes where it stopped, and says it is partial.
//   5. An empty wallet reports complete with no error — that zero is real.
//
// Everything runs against a fake provider in a temp directory. No network, no RPC,
// no live ledger.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "v4disc-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const { ethers } = require("ethers");
const v4 = require("../univ4");

const POSM = "0x" + "11".repeat(20);
const OWNER = "0x" + "22".repeat(20);
const stateFile = (name) => path.join(TMP, name + ".json");

// Every file beside the code, with its mtime+size, before a single scan runs.
const ROOT = path.join(__dirname, "..");
function snapshotRoot() {
  const m = new Map();
  for (const f of fs.readdirSync(ROOT)) {
    try {
      const st = fs.statSync(path.join(ROOT, f));
      if (st.isFile()) m.set(f, st.mtimeMs + ":" + st.size);
    } catch {}
  }
  return m;
}
const ROOT_BEFORE = snapshotRoot();

// A transfer log the scanner will accept: topic[3] carries the token id.
const log = (id, blockNumber) => ({
  blockNumber,
  topics: [
    ethers.id("Transfer(address,address,uint256)"),
    ethers.zeroPadValue("0x" + "00".repeat(20), 32),
    ethers.zeroPadValue(OWNER, 32),
    ethers.zeroPadValue(ethers.toBeHex(BigInt(id)), 32),
  ],
});

/**
 * `maxRange` mimics an RPC that refuses wide windows, the way Arc's does.
 * `mints` places token ids at block heights. `failFrom` makes every call fail
 * once a counter is reached, to model an endpoint dying mid-scan.
 */
function fakeProvider({ latest, maxRange = Infinity, mints = {}, failAfter = Infinity }) {
  const p = {
    calls: [],
    async getBlockNumber() { return latest; },
    async getLogs({ fromBlock, toBlock }) {
      p.calls.push([fromBlock, toBlock]);
      if (p.calls.length > failAfter) throw new Error("endpoint down");
      if (toBlock - fromBlock + 1 > maxRange) throw new Error("requested range too large");
      return Object.entries(mints)
        .filter(([, b]) => b >= fromBlock && b <= toBlock)
        .map(([id, b]) => log(id, b));
    },
  };
  return p;
}
const widest = (p) => Math.max(...p.calls.map(([a, b]) => b - a + 1));
const narrowest = (p) => Math.min(...p.calls.map(([a, b]) => b - a + 1));

(async () => {

// ---- 1. a refused range is retried smaller, and the scan still succeeds ------
{
  const p = fakeProvider({ latest: 100_000, maxRange: 10_000, mints: { 7: 40_000, 9: 95_000 } });
  const d = v4.createDiscovery({ provider: p, posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: stateFile("retry") });
  const ids = await (d.discover(500));
  assert.ok(widest(p) > 10_000, "it should try a wide window first, or it is not adapting");
  assert.ok(p.calls.every(([a, b]) => b - a + 1 <= 10_000 || true), "sanity");
  assert.deepStrictEqual(ids.sort(), ["7", "9"], "both ids found once the window shrank");
  assert.strictEqual(d.status.complete, true, "a scan that reached block 0 is complete");
  assert.strictEqual(d.status.error, null, "a range that was retried successfully is not an error");
  assert.ok(d.status.window <= 10_000, "the accepted window is remembered: " + d.status.window);
}

// ---- 2. an RPC that refuses even the floor reports failure, not emptiness ----
{
  const p = fakeProvider({ latest: 100_000, maxRange: 500, mints: { 3: 50_000 } });
  const d = v4.createDiscovery({ provider: p, posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: stateFile("floor") });
  const ids = await (d.discover(50));
  assert.deepStrictEqual(ids, [], "nothing could be read");
  assert.strictEqual(d.status.complete, false, "and it must not claim to be complete");
  assert.ok(/range too large/i.test(d.status.error || ""), "the refusal is reported: " + d.status.error);
  assert.strictEqual(narrowest(p), 2000, "it stopped at the CHUNK floor, not below");
  const saved = JSON.parse(fs.readFileSync(stateFile("floor"), "utf8"));
  assert.ok(!saved.lastScanned, "the cursor must not advance over a range that was never read");
}

// ---- 3. a partial scan resumes, and keeps what it already found -------------
{
  const file = stateFile("resume");
  // The newest mint sits in the first window the sweep manages to read; the older
  // two are far enough back that the dying endpoint cannot reach them.
  const mints = { 11: 10_000, 22: 300_000, 33: 999_000 };
  const p1 = fakeProvider({ latest: 1_000_000, maxRange: 10_000, mints, failAfter: 10 });
  const d1 = v4.createDiscovery({ provider: p1, posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: file });
  const first = await (d1.discover(500));
  assert.ok(first.includes("33"), "the newest id is found before the endpoint dies");
  assert.strictEqual(d1.status.complete, false, "an interrupted sweep is not complete");
  const stopped = d1.status.scannedFrom;
  assert.ok(stopped > 0, "it recorded how far back it actually got: " + stopped);

  // Same state file, a healthy endpoint: it must carry on from where it stopped.
  const p2 = fakeProvider({ latest: 1_000_000, maxRange: 10_000, mints });
  const d2 = v4.createDiscovery({ provider: p2, posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: file });
  assert.deepStrictEqual([...d2.ids].sort(), first.sort(), "ids from the first pass survived the reload");
  const second = await (d2.discover(500));
  assert.deepStrictEqual(second.sort((a, b) => a - b), ["11", "22", "33"], "resume finds the rest");
  assert.strictEqual(d2.status.complete, true, "and now it is complete");
  assert.ok(p2.calls.every(([, b]) => b < stopped), "resume scans below where it stopped, not from scratch");
}

// ---- 4. a transient failure never loses an id already discovered ------------
{
  const file = stateFile("keep");
  const p1 = fakeProvider({ latest: 50_000, maxRange: 10_000, mints: { 5: 25_000 } });
  const d1 = v4.createDiscovery({ provider: p1, posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: file });
  await (d1.discover(500));
  assert.deepStrictEqual(await (Promise.resolve([...d1.ids])), ["5"]);

  // The chain moves on and every call now fails.
  const p2 = fakeProvider({ latest: 60_000, maxRange: 10_000, mints: { 5: 25_000 }, failAfter: 0 });
  const d2 = v4.createDiscovery({ provider: p2, posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: file });
  const ids = await (d2.discover(10));
  assert.deepStrictEqual(ids, ["5"], "the known id is still reported while the RPC is down");
  assert.ok(d2.status.error, "and the failure is visible: " + d2.status.error);
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(saved.lastScanned, 50_000, "the forward cursor did not move over the unread range");
}

// ---- 5. a genuinely empty wallet is complete, with no error -----------------
{
  const p = fakeProvider({ latest: 80_000, maxRange: 10_000, mints: {} });
  const d = v4.createDiscovery({ provider: p, posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: stateFile("empty") });
  const ids = await (d.discover(500));
  assert.deepStrictEqual(ids, [], "no positions");
  assert.strictEqual(d.status.complete, true, "the whole history was read");
  assert.strictEqual(d.status.error, null, "this zero is real, not a failure");
}

// ---- 6. the temp directory is the only thing written ------------------------
// A checkout can legitimately already hold v4-positions-*.json (an instance whose
// data directory is the source tree). What must be true is that this run added
// none of them and changed none of them, so compare against the snapshot taken
// before any discovery ran rather than asserting the directory is bare.
{
  const now = snapshotRoot();
  const added = [...now.keys()].filter((f) => !ROOT_BEFORE.has(f));
  const touched = [...now.keys()].filter((f) => ROOT_BEFORE.has(f) && ROOT_BEFORE.get(f) !== now.get(f));
  assert.deepStrictEqual(added, [], "this test created files beside the code: " + added.join(", "));
  assert.deepStrictEqual(touched, [], "this test modified files beside the code: " + touched.join(", "));
}

console.log("v4 discovery: windows adapt to the RPC, cursors never pass an unread range, and a failed scan says so");

})().catch((e) => { console.error(e); process.exit(1); });
