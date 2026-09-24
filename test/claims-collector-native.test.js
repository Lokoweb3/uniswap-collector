// node test/claims-collector-native.test.js — the two reasons a settlement this wallet
// really received was refused, and what changed.
//
// On 2026-09-22 only 7 of 40 positions could be reconstructed. Twenty were refused for
// "the native ETH leg is paid by a plain value transfer, which emits no log", and the
// rest largely because "the pair's tokens also moved between the pool manager and
// 0x8b65…b9df, not this position's owner". Both were the same money: 0x8b65 is this
// collector's own operator, which takes the fees and sweeps them to the owner, and the
// native amounts were sitting in each transaction's internal transfers all along.
//
// Fixing one without the other would have changed nothing: reading the native amount
// still left it paid to the "stranger" operator, and accepting the operator still left
// the native amount unknown. Both together, or neither.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const u = require("../univ3");
const cs = require("../claims-store");

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const POSM = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b";
const ARGUS = "0xece5ca8bf9220718e5727754026757512212cb3c";
const USDC = "0x3600000000000000000000000000000000000000";
const OWNER = "0xb1cdc09b4c7f28365a8e7bfa2332af54f5462af5";
const OPERATOR = "0x8b650b6e03a87d844f14d499331d54377e9db9df";
const STRANGER = "0x00000000000000000000000000000000deadbeef";
const POOL = "0x" + "ab".repeat(32);
const coder = ethers.AbiCoder.defaultAbiCoder();
const pad = (a) => ethers.zeroPadValue(a, 32);

const modLog = (block, index, delta, tokenId, tx) => ({
  address: PM, blockNumber: block, index, transactionHash: tx,
  topics: [cs.MODIFY_LIQUIDITY, POOL, pad(POSM)],
  data: coder.encode(["int24", "int24", "int256", "bytes32"],
    [-887200, 887200, delta, ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32)]),
});
const xferTo = (token, value, to) => ({
  address: token, topics: [cs.TRANSFER, pad(PM), pad(to)],
  data: ethers.zeroPadValue(ethers.toBeHex(value), 32),
});

function fakeProvider(world, head = 1000) {
  const ownerIface = new ethers.Interface(["function ownerOf(uint256) view returns (address)"]);
  const match = (l, address, topics) =>
    (!address || l.address.toLowerCase() === address.toLowerCase()) &&
    (topics || []).every((t, i) => t == null || [].concat(t).map((x) => x.toLowerCase()).includes((l.topics[i] || "").toLowerCase()));
  return {
    async getBlockNumber() { return head; },
    async getBlock(n) { return { timestamp: 1789000000 + n }; },
    async getLogs({ address, topics, fromBlock, toBlock }) {
      return world.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && match(l, address, topics));
    },
    async call(tx) {
      const [id] = ownerIface.decodeFunctionData("ownerOf", tx.data);
      return ownerIface.encodeFunctionResult("ownerOf", [OWNER]);
    },
    async getTransactionReceipt(h) {
      const logs = world.logs.filter((l) => l.transactionHash === h).concat(world.transfers[h] || []);
      return logs.length ? { hash: h, from: (world.from || {})[h] || null, logs } : null;
    },
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "claims-native-"));
const ARGS = (provider, file, over = {}) => ({
  provider, file, chainId: 5042, positionManager: POSM, poolManager: PM,
  stateView: { getSlot0: async () => [u.getSqrtRatioAtTick(0), 0, 0, 0] },
  log: { log() {}, error() {} }, ...over,
});
// One collect, "8240" is an ERC-20 pair and "9100" has a native leg.
const META = {
  8240: { token0: USDC, token1: ARGUS, owner: OWNER },
  9100: { token0: cs.ZERO, token1: ARGUS, owner: OWNER },
};
const run = async (world, id, over) => {
  const d = tmp(), f = path.join(d, "claims.json");
  const s = cs.create(ARGS(fakeProvider(world), f, over));
  let threw = null;
  try {
    await s.scan((x) => META[x], { ids: [String(id)], chunk: 500, budget: 5, floor: 800 });
  } catch (e) { threw = e; }
  const rows = s.rows(String(id));
  fs.rmSync(d, { recursive: true, force: true });
  return { rows, threw };
};

async function main() {
  // ---- 1. an ERC-20 payout to the operator ------------------------------------
  const erc20World = {
    logs: [modLog(900, 3, 0n, "8240", "0xaa")],
    transfers: { "0xaa": [xferTo(USDC, 1_000_000n, OPERATOR)] },
  };
  {
    // Before: the operator is nobody, so the payout cannot be attributed.
    const { rows } = await run(erc20World, 8240, {});
    assert.ok(rows[0].unavailable, "without a collector the operator is a stranger");
    assert.match(rows[0].unavailable, /not this position's owner/, "and says so");
    assert.strictEqual(rows[0].fee0, null, "and no figure is invented");
  }
  {
    const { rows } = await run(erc20World, 8240, { collectors: [OPERATOR] });
    assert.strictEqual(rows[0].unavailable, null, "named as a collector, the payout is attributable");
    assert.strictEqual(rows[0].fee0, "1000000", "and the amount is the owner's");
    assert.strictEqual(rows[0].viaCollector, true, "flagged as settled through the collector, not paid direct");
  }
  {
    // An unrelated address is still a stranger: this must not become "anyone".
    const world = { logs: [modLog(900, 3, 0n, "8240", "0xaa")], transfers: { "0xaa": [xferTo(USDC, 1_000_000n, STRANGER)] } };
    const { rows } = await run(world, 8240, { collectors: [OPERATOR] });
    assert.ok(rows[0].unavailable, "a genuine stranger is still refused");
    assert.strictEqual(rows[0].fee0, null, "with no figure");
  }

  // ---- 2. a native leg --------------------------------------------------------
  const nativeWorld = {
    logs: [modLog(900, 3, 0n, "9100", "0xbb")],
    transfers: { "0xbb": [xferTo(ARGUS, 5_000_000_000_000_000_000n, OWNER)] },
  };
  {
    const { rows } = await run(nativeWorld, 9100, {});
    assert.ok(rows[0].unavailable, "with no resolver a native leg is still unreadable");
    assert.match(rows[0].unavailable, /no internal-transfer source/, "and says why");
    assert.strictEqual(rows[0].fee0, null, "never a zero");
  }
  {
    // Paid straight to the owner.
    const internalTransfers = async () => [{ from: PM, to: OWNER, value: "73840620000000000" }];
    const { rows } = await run(nativeWorld, 9100, { internalTransfers });
    assert.strictEqual(rows[0].unavailable, null, "the internal transfers supply the amount");
    assert.strictEqual(rows[0].fee0, "73840620000000000", "which becomes the native fee");
    assert.strictEqual(rows[0].fee1, "5000000000000000000", "and the token leg is unchanged");
    assert.ok(!rows[0].viaCollector, "paid direct, so not flagged as via a collector");
  }
  {
    // Paid to the operator, which is how this collector actually receives it.
    const internalTransfers = async () => [{ from: PM, to: OPERATOR, value: "73840620000000000" }];
    const { rows } = await run(nativeWorld, 9100, { internalTransfers, collectors: [OPERATOR] });
    assert.strictEqual(rows[0].unavailable, null, "both halves together make it readable");
    assert.strictEqual(rows[0].fee0, "73840620000000000", "the native amount is attributed");
    assert.strictEqual(rows[0].viaCollector, true, "and flagged as settled through the collector");
  }
  {
    // Each half alone is not enough — the point of doing both.
    const internalTransfers = async () => [{ from: PM, to: OPERATOR, value: "73840620000000000" }];
    const { rows } = await run(nativeWorld, 9100, { internalTransfers });
    assert.ok(rows[0].unavailable, "reading the amount alone still leaves it paid to a stranger");
    assert.strictEqual(rows[0].fee0, null, "so still no figure");
  }

  // ---- 2b. the position manager moving the sender's own ETH -------------------
  // A native leg is paid with msg.value: the sender hands ETH to the position manager,
  // which settles it with the pool manager. The pool manager's counterparty is then the
  // position manager, which refused every native increase (#3010813, 2026-09-24).
  // The same holds on the way out (take to the position manager, then a sweep): a
  // collect paid through it, in a transaction the owner sent, is the owner's.
  {
    const internalTransfers = async () => [{ from: PM, to: POSM, value: "54373489660421970" }];
    const world = { ...nativeWorld, from: { "0xbb": OWNER } };
    const { rows } = await run(world, 9100, { internalTransfers, collectors: [OPERATOR] });
    assert.strictEqual(rows[0].unavailable, null, "in a transaction the owner sent, the position manager is moving the owner's ETH");
    assert.strictEqual(rows[0].fee0, "54373489660421970", "so the amount is the owner's");
    assert.ok(!rows[0].viaCollector, "and it did not come by way of the operator");
  }
  {
    const internalTransfers = async () => [{ from: PM, to: POSM, value: "54373489660421970" }];
    const world = { ...nativeWorld, from: { "0xbb": STRANGER } };
    const { rows } = await run(world, 9100, { internalTransfers, collectors: [OPERATOR] });
    assert.ok(rows[0].unavailable, "sent by anyone else, the position manager is acting for them, not the owner");
    assert.strictEqual(rows[0].fee0, null, "so still no figure");
  }

  // ---- 3. a transport failure is not an answer --------------------------------
  {
    const internalTransfers = async () => { throw new Error("Blockscout returned HTTP 503"); };
    const { rows, threw } = await run(nativeWorld, 9100, { internalTransfers, collectors: [OPERATOR] });
    // It must NOT persist a decided record: a blip would otherwise freeze into a
    // permanent "cannot be read" on a row nothing revisits until the decoder changes.
    const decided = rows.filter((r) => r.unavailable || r.fee0 != null);
    assert.strictEqual(decided.length, 0, "no record is written from a failed lookup");
    assert.ok(threw, "the chunk fails instead, so the cursor does not advance and it is retried");
  }

  console.log("claims: a payout reaching the owner through the configured collector is the owner's (flagged viaCollector), a native leg's amount comes from the transaction's internal transfers, a genuine stranger is still refused, and a failed lookup fails the chunk rather than recording a zero");
}

main().catch((e) => { console.error(e); process.exit(1); });
