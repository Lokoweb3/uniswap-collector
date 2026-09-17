// node test/claims-store.test.js — the chain-derived claim store: scoped identity,
// principal kept out of fees, and totals that cannot inflate on a rescan.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const u = require("../univ3");
const cs = require("../claims-store");

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const POSM_A = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b";
const POSM_B = "0x1111111111111111111111111111111111111111";
const USDC = "0x3600000000000000000000000000000000000000";
const ARGUS = "0xece5ca8bf9220718e5727754026757512212cb3c";
const NATIVE = "0xfffffffffffffffffffffffffffffffffffffffe";
const OWNER = "0xb1cdc09b4c7f28365a8e7bfa2332af54f5462af5";
const POOL = "0x" + "ab".repeat(32);
const coder = ethers.AbiCoder.defaultAbiCoder();
const pad = (a) => ethers.zeroPadValue(a, 32);

const modLog = (block, index, delta, tokenId, tx, sender = POSM_A, lo = -887200, hi = 887200) => ({
  address: PM, blockNumber: block, index, transactionHash: tx,
  topics: [cs.MODIFY_LIQUIDITY, POOL, pad(sender)],
  data: coder.encode(["int24", "int24", "int256", "bytes32"],
    [lo, hi, delta, ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32)]),
});
const xfer = (token, value) => ({
  address: token, topics: [cs.TRANSFER, pad(PM), pad(OWNER)],
  data: ethers.zeroPadValue(ethers.toBeHex(value), 32),
});

// A provider serving a fixed world; counts how often each receipt was fetched.
function fakeProvider(world, head = 1000) {
  const receiptCalls = [];
  return {
    receiptCalls,
    async getBlockNumber() { return head; },
    async getBlock(n) { return { timestamp: Math.floor(1789000000 + n) }; },
    async getLogs({ fromBlock, toBlock }) {
      return world.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    },
    async getTransactionReceipt(h) {
      receiptCalls.push(h);
      const logs = world.logs.filter((l) => l.transactionHash === h)
        .concat(world.transfers[h] || []);
      return logs.length ? { hash: h, logs } : null;
    },
  };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "claims-"));
const META = { "8240": { token0: USDC, token1: ARGUS, owner: OWNER } };
const ARGS = (provider, file, over = {}) => ({
  provider, file, chainId: 5042, positionManager: POSM_A, poolManager: PM,
  stateView: { getSlot0: async () => [u.getSqrtRatioAtTick(0), 0, 0, 0] },
  log: { log() {}, error() {} }, ...over,
});

async function main() {
  // ---- 1. a pure collect, and the dual-interface duplicate counted once ------
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = {
      logs: [modLog(900, 3, 0n, "8240", "0xaa")],
      transfers: { "0xaa": [xfer(NATIVE, 42499934n), xfer(USDC, 42499934n), xfer(ARGUS, 1266966450000000000000n)] },
    };
    const s = cs.create(ARGS(fakeProvider(world), f));
    await s.scan((id) => META[id], { chunk: 500, budget: 5, floor: 800 });
    const r = s.rows("8240");
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].fee0, "42499934", "the native pseudo-token duplicate must not be added");
    assert.strictEqual(r[0].kind, "collect");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 2. a withdrawal contributes only the excess over principal -----------
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const L = 3736665557929942n, sqrtP = u.getSqrtRatioAtTick(0);
    const { amount0, amount1 } = u.getAmountsForLiquidity(sqrtP, u.getSqrtRatioAtTick(-887200), u.getSqrtRatioAtTick(887200), L);
    const world = {
      logs: [modLog(900, 1, -L, "8240", "0xbb")],
      transfers: { "0xbb": [xfer(USDC, amount0 + 2743337n), xfer(ARGUS, amount1 + 56358300000000000000n)] },
    };
    const s = cs.create(ARGS(fakeProvider(world), f));
    await s.scan((id) => META[id], { chunk: 500, budget: 5, floor: 800 });
    const r = s.rows("8240")[0];
    assert.strictEqual(r.kind, "withdrawal");
    assert.strictEqual(r.fee0, "2743337", `only the excess is a fee, got ${r.fee0}`);
    assert.strictEqual(r.principal0, amount0.toString(), "principal is recorded, not discarded");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 3. rescanning and restarting cannot inflate a total -----------------
  // The record key is tx:logIndex, so folding the same range again rewrites the
  // same entries. This is the failure an append-only ledger would have.
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = {
      logs: [modLog(900, 3, 0n, "8240", "0xaa"), modLog(950, 2, 0n, "8240", "0xcc")],
      transfers: { "0xaa": [xfer(USDC, 1000000n)], "0xcc": [xfer(USDC, 500000n)] },
    };
    const p = fakeProvider(world);
    const s1 = cs.create(ARGS(p, f));
    await s1.scan((id) => META[id], { chunk: 500, budget: 5, floor: 800 });
    const first = s1.summary("8240", { dec0: 6, dec1: 18, sym0: "USDC", sym1: "ARGUS", usd0: 1, usd1: 0, openedBlock: 850 });
    assert.strictEqual(first.count, 2);
    assert.strictEqual(first.raw0, "1500000");

    // Rescan the very same range in the same process.
    const st = JSON.parse(fs.readFileSync(f, "utf8")).scopes["5042:" + POSM_A];
    st.scannedFrom = 1001; st.scannedTo = 1000;      // rewind the cursor, keep the records
    fs.writeFileSync(f, JSON.stringify({ v: 1, scopes: { ["5042:" + POSM_A]: st } }));
    const s2 = cs.create(ARGS(p, f));                 // a restart: state re-read from disk
    await s2.scan((id) => META[id], { chunk: 500, budget: 5, floor: 800 });
    const again = s2.summary("8240", { dec0: 6, dec1: 18, sym0: "USDC", sym1: "ARGUS", usd0: 1, usd1: 0, openedBlock: 850 });
    assert.strictEqual(again.count, 2, `a rescan must not add records, got ${again.count}`);
    assert.strictEqual(again.raw0, "1500000", `and must not inflate the total, got ${again.raw0}`);
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 4. the same token id on another chain or manager is another position --
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = {
      logs: [modLog(900, 3, 0n, "8240", "0xaa"), modLog(900, 4, 0n, "8240", "0xaa", POSM_B)],
      transfers: { "0xaa": [xfer(USDC, 1000000n)] },
    };
    const p = fakeProvider(world);
    const a = cs.create(ARGS(p, f));
    await a.scan((id) => META[id], { chunk: 500, budget: 5, floor: 800 });
    assert.strictEqual(a.rows("8240").length, 1, "the other manager's ModifyLiquidity must not be folded in");

    // Same file, same id, different chain: separate scope, separate records.
    const other = cs.create(ARGS(p, f, { chainId: 4663 }));
    assert.strictEqual(other.rows("8240").length, 0, "chain 4663 must not see chain 5042's records");
    await other.scan((id) => META[id], { chunk: 500, budget: 5, floor: 800 });
    assert.strictEqual(a.rows("8240").length, 1, "and scanning one scope must not disturb the other");
    const saved = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.ok(saved.scopes["5042:" + POSM_A] && saved.scopes["4663:" + POSM_A],
      "both scopes are stored side by side, keyed by chain and manager");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 5. coverage comes from scanned blocks, and "complete" is earned ------
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = { logs: [modLog(900, 3, 0n, "8240", "0xaa")], transfers: { "0xaa": [xfer(USDC, 1000000n)] } };
    const s = cs.create(ARGS(fakeProvider(world), f));
    await s.scan((id) => META[id], { chunk: 100, budget: 2, floor: 0 });   // budget runs out
    const partial = s.summary("8240", { dec0: 6, dec1: 18, sym0: "USDC", sym1: "ARGUS", usd0: 1, usd1: 0, openedBlock: 10 });
    assert.strictEqual(partial.status, "partial", "the scan never reached the opening block");
    assert.ok(partial.coverage.fromBlock > 10, "and coverage says where it actually starts");
    assert.ok(partial.coverage.fromT > 0 && partial.coverage.toT > 0, "timestamps come from the boundary blocks");
    assert.strictEqual(partial.coverage.complete, false);

    const unknownOpen = s.summary("8240", { dec0: 6, dec1: 18, sym0: "USDC", sym1: "ARGUS", usd0: 1, usd1: 0, openedBlock: null });
    assert.strictEqual(unknownOpen.status, "partial",
      "with no known opening block, completeness cannot be claimed");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 6. an unseparable withdrawal withholds the whole figure --------------
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = { logs: [modLog(900, 1, -1000n, "8240", "0xbb")], transfers: { "0xbb": [xfer(USDC, 5n)] } };
    const s = cs.create(ARGS(fakeProvider(world), f, {
      stateView: { getSlot0: async () => { throw new Error("no archive state"); } } }));
    await s.scan((id) => META[id], { chunk: 500, budget: 5, floor: 800 });
    const sum = s.summary("8240", { dec0: 6, dec1: 18, sym0: "USDC", sym1: "ARGUS", usd0: 1, usd1: 0, openedBlock: 850 });
    assert.strictEqual(sum.status, "unavailable", "a total built on an unseparated payout would be a guess");
    assert.match(sum.reason, /principal separated/);
    assert.strictEqual(sum.usd, undefined, "and no number is produced");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 7. only our positions cost a receipt fetch ---------------------------
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = {
      logs: [modLog(900, 3, 0n, "8240", "0xaa"), modLog(901, 1, 0n, "999999", "0xzz")],
      transfers: { "0xaa": [xfer(USDC, 1000000n)], "0xzz": [xfer(USDC, 9n)] },
    };
    const p = fakeProvider(world);
    const s = cs.create(ARGS(p, f));
    await s.scan((id) => META[id], { chunk: 500, budget: 5, floor: 800 });
    assert.ok(!p.receiptCalls.includes("0xzz"),
      "a position we do not track must not cost a receipt fetch — that is what made a real chunk take minutes");
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log("claims store: scoped by chain and manager, principal excluded, rescans cannot inflate, coverage earned");
}
main().catch((e) => { console.error(e); process.exit(1); });
