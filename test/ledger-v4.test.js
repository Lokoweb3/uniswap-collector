// node test/ledger-v4.test.js — a batched owner collect (several positions' zero-liquidity
// events in ONE transaction) has one receipt: its transfers are credited once per token, to
// the first position that carries the token; later positions in the batch get null for that
// leg (TASK-87). Pure helpers, no RPC.
const assert = require("assert");
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
console.log("ledger-v4: batch collects group by tx and credit each token once — all assertions passed");
