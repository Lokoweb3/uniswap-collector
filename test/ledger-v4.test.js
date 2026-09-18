// node test/ledger-v4.test.js — a batched owner collect (several positions' zero-liquidity
// events in ONE transaction) has one receipt: its transfers are credited once per token, to
// the first position that carries the token; later positions in the batch get null for that
// leg (TASK-87). Pure helpers, no RPC.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { zeroDeltaIdsByTx, allocateBatch } = require("../ledger-v4");

const IFACE = new ethers.Interface(["event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)"]);
const POOL = "0x" + "ab".repeat(32), SENDER = "0x" + "11".repeat(20);
const salt = (id) => ethers.zeroPadValue(ethers.toBeHex(BigInt(id)), 32);
const modLog = (tx, id, delta, index) => { const e = IFACE.encodeEventLog("ModifyLiquidity", [POOL, SENDER, -100, 100, delta, salt(id)]); return { transactionHash: tx, index, blockNumber: 5, topics: e.topics, data: e.data }; };

{
  const TX = "0x" + "cd".repeat(32), OTHER = "0x" + "ef".repeat(32);
  const logs = [modLog(TX, 1, 0n, 0), modLog(TX, 2, 0n, 1), modLog(TX, 3, 500n, 2), modLog(OTHER, 4, 0n, 0), modLog(TX, 9, 0n, 3)];
  const g = zeroDeltaIdsByTx(logs, new Set(["1", "2", "3", "4"]));
  assert.deepStrictEqual(g.get(TX), ["1", "2"], "two zero-delta positions of ours in the batch tx, in log order; the liquidity change and the foreign id are not collects");
  assert.deepStrictEqual(g.get(OTHER), ["4"], "a lone collect is a batch of one");
}
{
  // Same pool (same two tokens): the second position gets neither leg.
  const X = { address: "0x" + "01".repeat(20), symbol: "X" }, Y = { address: "0x" + "02".repeat(20), symbol: "Y" }, Z = { address: "0x" + "03".repeat(20), symbol: "Z" };
  const cred = new Set();
  assert.deepStrictEqual(allocateBatch(cred, X, Y), { fee0Known: true, fee1Known: true }, "first position takes both tokens");
  assert.deepStrictEqual(allocateBatch(cred, X, Y), { fee0Known: false, fee1Known: false }, "second position in the same pool: both already credited");
  // A pool sharing only Y with the first: Y unknown, Z known.
  assert.deepStrictEqual(allocateBatch(cred, Y, Z), { fee0Known: false, fee1Known: true }, "shared token unknown, new token credited");
  // Case-insensitive on the address.
  assert.deepStrictEqual(allocateBatch(cred, { address: Z.address.toUpperCase() }, null), { fee0Known: false, fee1Known: true });
}

// ---- an unreadable leg is unknown, never zero --------------------------------
//
// fee0/fee1 begin at 0n and are only filled from the receipt's Transfer logs, so a
// receipt that fails to fetch, a pool key that will not resolve, or a native leg
// (which moves no ERC-20 and logs nothing) used to persist "0 fees collected" as
// though it were measured. Downstream treats only null as unknown, and the dedupe
// means the row is never revisited, so the wrong figure was permanent.
{
  const rows = [];
  const mkRecorder = require("../ledger-v4");
  assert.strictEqual(typeof mkRecorder.create, "function");
  const src = fs.readFileSync(path.join(__dirname, "..", "ledger-v4.js"), "utf8");
  // The guards, asserted on the source because recordOwnerCollect is internal.
  assert.ok(/if \(!rcpt\) \{\s*\n\s*fee0Known = false; fee1Known = false;/.test(src),
    "a missing receipt marks both legs unknown");
  assert.ok(/if \(!t0\) \{ fee0Known = false;/.test(src) && /if \(!t1\) \{ fee1Known = false;/.test(src),
    "an unresolved token marks its own leg unknown");
  assert.ok(/if \(t0 && t0\.address === ethers\.ZeroAddress\) fee0Known = false;/.test(src),
    "a native leg is unknown: it leaves no Transfer log");
  assert.ok(/fee0Known = fee0Known && alloc\.fee0Known;/.test(src) && /fee1Known = fee1Known && alloc\.fee1Known;/.test(src),
    "batch allocation can only reduce certainty, never restore it");
  assert.ok(!/\(\{ fee0Known, fee1Known \} = allocateBatch/.test(src),
    "and it no longer overwrites the flags wholesale");
  assert.ok(/fee0: fee0Known \? fee0\.toString\(\) : null/.test(src), "an unknown leg is written as null");
  void rows;
}

console.log("ledger-v4: batch collects credit each token once, and an unreadable leg is recorded as unknown rather than as zero");
