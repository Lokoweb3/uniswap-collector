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
// ERC-721 mint: Transfer(0, owner, tokenId) on the position manager.
const mintLog = (block, tokenId, tx = "0xm" + tokenId, posm = POSM_A) => ({
  address: posm, blockNumber: block, index: 0, transactionHash: tx,
  topics: [cs.TRANSFER, pad(cs.ZERO), pad(OWNER), pad(ethers.toBeHex(BigInt(tokenId)))], data: "0x",
});
const xfer = (token, value) => ({
  address: token, topics: [cs.TRANSFER, pad(PM), pad(OWNER)],
  data: ethers.zeroPadValue(ethers.toBeHex(value), 32),
});

// A provider serving a fixed world; counts how often each receipt was fetched.
function fakeProvider(world, head = 1000, secPerBlock = 1) {
  const receiptCalls = [];
  const match = (l, address, topics) =>
    (!address || l.address.toLowerCase() === address.toLowerCase()) &&
    (topics || []).every((t, i) => t == null || (l.topics[i] || "").toLowerCase() === t.toLowerCase());
  return {
    receiptCalls,
    async getBlockNumber() { return head; },
    async getBlock(n) { return { timestamp: Math.floor(1789000000 + n * secPerBlock) }; },
    async getLogs({ address, topics, fromBlock, toBlock }) {
      return world.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && match(l, address, topics));
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
const IDS = { ids: ["8240"] };
const SUM = { dec0: 6, dec1: 18, sym0: "USDC", sym1: "ARGUS", usd0: 1, usd1: 0 };
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
    await s.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
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
    await s.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
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
    await s1.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
    const first = s1.summary("8240", { dec0: 6, dec1: 18, sym0: "USDC", sym1: "ARGUS", usd0: 1, usd1: 0, openedBlock: 850 });
    assert.strictEqual(first.count, 2);
    assert.strictEqual(first.raw0, "1500000");

    // Rescan the very same range in the same process.
    const st = JSON.parse(fs.readFileSync(f, "utf8")).scopes["5042:" + POSM_A];
    st.tokens["8240"] = { from: 1001, to: 1000, mint: null };   // rewind the cursor, keep the records
    fs.writeFileSync(f, JSON.stringify({ v: 1, scopes: { ["5042:" + POSM_A]: st } }));
    const s2 = cs.create(ARGS(p, f));                 // a restart: state re-read from disk
    await s2.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
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
    await a.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
    assert.strictEqual(a.rows("8240").length, 1, "the other manager's ModifyLiquidity must not be folded in");

    // Same file, same id, different chain: separate scope, separate records.
    const other = cs.create(ARGS(p, f, { chainId: 4663 }));
    assert.strictEqual(other.rows("8240").length, 0, "chain 4663 must not see chain 5042's records");
    await other.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
    assert.strictEqual(a.rows("8240").length, 1, "and scanning one scope must not disturb the other");
    const saved = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.ok(saved.scopes["5042:" + POSM_A] && saved.scopes["4663:" + POSM_A],
      "both scopes are stored side by side, keyed by chain and manager");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 5. coverage comes from scanned blocks, and "covers opening" is earned --
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = { logs: [mintLog(10, "8240"), modLog(900, 3, 0n, "8240", "0xaa")], transfers: { "0xaa": [xfer(USDC, 1000000n)] } };
    const s = cs.create(ARGS(fakeProvider(world), f));
    await s.scan((id) => META[id], { ...IDS, chunk: 100, budget: 2, floor: 0 });   // budget runs out
    const partial = s.summary("8240", SUM);
    assert.strictEqual(partial.status, "partial", "the scan never reached the opening block");
    assert.ok(partial.coverage.fromBlock > 10, "and coverage says where it actually starts");
    assert.ok(partial.coverage.fromT > 0 && partial.coverage.toT > 0, "timestamps come from the boundary blocks");
    assert.strictEqual(partial.coverage.coversOpening, false);
    assert.strictEqual(partial.coverage.reachedLookbackFloor, false);
    assert.match(partial.reason, /not yet reached/);

    // Keep scanning: the mint is found, and the same figure is now whole.
    const r = await s.scan((id) => META[id], { ...IDS, chunk: 100, budget: 50, floor: 0 });
    assert.strictEqual(r.pending, 0, "nothing is left to scan once the mint is covered");
    assert.ok(r.chunks < 50, "and scanning stopped there rather than spending the budget");
    const whole = s.summary("8240", SUM);
    assert.strictEqual(whole.status, "ok", "the scan reached the mint, so the history is complete");
    assert.strictEqual(whole.coverage.openedBlock, 10, "the opening block is the observed mint, not a guess");
    assert.strictEqual(whole.coverage.coversOpening, true);
    assert.ok(whole.coverage.fromBlock <= 10, "coverage reaches back past the mint");
    assert.strictEqual(whole.raw0, "1000000");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 5b. a position with no claims and an observed mint is a verified zero ---
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = { logs: [mintLog(700, "11989")], transfers: {} };
    const meta = { "11989": META["8240"] };
    const s = cs.create(ARGS(fakeProvider(world), f));
    await s.scan((id) => meta[id], { ids: ["11989"], chunk: 500, budget: 5, floor: 0 });
    const z = s.summary("11989", SUM);
    assert.strictEqual(z.status, "ok", `scanned from its mint with nothing found is complete, got ${z.status}`);
    assert.strictEqual(z.count, 0);
    assert.strictEqual(z.usd, 0);
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 5c. older than the lookback: floor reached, opening not covered --------
  // The two flags mean different things and must never read as one.
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = { logs: [mintLog(100, "8240"), modLog(900, 3, 0n, "8240", "0xaa")], transfers: { "0xaa": [xfer(USDC, 1000000n)] } };
    const s = cs.create(ARGS(fakeProvider(world, 1000, 2), f));
    // 2 s per block, a 400 s lookback: the floor must be 200 blocks back, measured.
    const r = await s.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, lookbackMs: 400000 });
    assert.strictEqual(r.blockMs, 2000, `block time is measured from the chain, got ${r.blockMs}`);
    assert.strictEqual(r.floor, 800, `the lookback floor follows the measured block time, got ${r.floor}`);
    const sum = s.summary("8240", SUM);
    assert.strictEqual(sum.coverage.reachedLookbackFloor, true);
    assert.strictEqual(sum.coverage.coversOpening, false);
    assert.strictEqual(sum.coverage.blockMs, 2000);
    assert.strictEqual(sum.status, "partial");
    assert.match(sum.reason, /opened before the lookback window/);
    assert.ok(sum.since > 0, "a partial figure says since when");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 5d. a position tracked later gets its own backwards scan ----------------
  // One shared cursor would call its earlier claims covered without ever looking.
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const meta = { ...META, "27627": META["8240"] };
    const world = {
      logs: [mintLog(850, "27627"), modLog(900, 1, 0n, "27627", "0xdd")],
      transfers: { "0xdd": [xfer(USDC, 777n)] },
    };
    const p = fakeProvider(world);
    const s = cs.create(ARGS(p, f));
    await s.scan((id) => meta[id], { ids: ["8240"], chunk: 500, budget: 5, floor: 800 });
    assert.strictEqual(s.summary("27627", SUM).status, "unavailable", "an untracked position has no coverage at all");
    await s.scan((id) => meta[id], { ids: ["8240", "27627"], chunk: 500, budget: 5, floor: 800 });
    const late = s.summary("27627", SUM);
    assert.strictEqual(late.raw0, "777", "the claim before tracking began is found by the position's own scan");
    assert.strictEqual(late.status, "ok");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 5e. a native-ETH leg is unreadable from logs, so no figure ------------
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const meta = { "8240": { token0: cs.ZERO, token1: ARGUS, owner: OWNER } };
    const world = { logs: [modLog(900, 3, 0n, "8240", "0xaa")], transfers: { "0xaa": [xfer(ARGUS, 5n)] } };
    const s = cs.create(ARGS(fakeProvider(world), f));
    await s.scan((id) => meta[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
    const sum = s.summary("8240", SUM);
    assert.strictEqual(sum.status, "unavailable", "a zero for the ETH leg would be a false verified figure");
    assert.match(sum.reason, /native ETH/);
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 5f. USD at each collection's own price, and the basis says so ----------
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = {
      logs: [modLog(900, 3, 0n, "8240", "0xaa"), modLog(950, 2, 0n, "8240", "0xcc")],
      transfers: { "0xaa": [xfer(USDC, 1000000n), xfer(ARGUS, 10n ** 18n)], "0xcc": [xfer(USDC, 1000000n), xfer(ARGUS, 10n ** 18n)] },
    };
    const s = cs.create(ARGS(fakeProvider(world), f));
    await s.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
    const [r1, r2] = s.rows("8240");
    assert.ok(r1.sqrtP, "the pool price at the record's block is kept for valuation");
    const today = { ...SUM, usd0: 1, usd1: 3 };
    assert.strictEqual(s.summary("8240", today).usdBasis, "today");
    assert.strictEqual(s.summary("8240", today).usd, 8);
    s.setPrice(r1.key, { p0: 1, p1: 10, src: "block" });
    const mixed = s.summary("8240", today);
    assert.strictEqual(mixed.usdBasis, "mixed");
    assert.strictEqual(mixed.usd, 15, "one at its own price (11) plus one at today's (4)");
    s.setPrice(r2.key, { p0: 1, p1: 20, src: "pricelog" });
    const locked = s.summary("8240", { ...SUM, usd0: null, usd1: null });
    assert.strictEqual(locked.usdBasis, "at-claim", "every record at its own price needs no price today");
    assert.strictEqual(locked.usd, 32);
    const none = cs.create(ARGS(fakeProvider(world), path.join(d, "b.json")));
    await none.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
    const unpriced = none.summary("8240", { ...SUM, usd0: 1, usd1: null });
    assert.strictEqual(unpriced.usd, null);
    assert.ok(unpriced.usdMissing, "a missing total says why, distinct from not priced yet");
    // A rescan keeps a price already fixed for the record's block.
    s.state.tokens["8240"] = { from: 1001, to: 1000, mint: null };
    await s.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
    assert.strictEqual(s.summary("8240", today).usdBasis, "at-claim");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 6. an unseparable withdrawal withholds the whole figure --------------
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const world = { logs: [modLog(900, 1, -1000n, "8240", "0xbb")], transfers: { "0xbb": [xfer(USDC, 5n)] } };
    const s = cs.create(ARGS(fakeProvider(world), f, {
      stateView: { getSlot0: async () => { throw new Error("no archive state"); } } }));
    await s.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
    const sum = s.summary("8240", { dec0: 6, dec1: 18, sym0: "USDC", sym1: "ARGUS", usd0: 1, usd1: 0, openedBlock: 850 });
    assert.strictEqual(sum.status, "unavailable", "a total built on an unseparated payout would be a guess");
    assert.match(sum.reason, /pool price at block 900 could not be read/);
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
    await s.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 800 });
    assert.ok(!p.receiptCalls.includes("0xzz"),
      "a position we do not track must not cost a receipt fetch — that is what made a real chunk take minutes");
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log("claims store: scoped by chain and manager, principal excluded, rescans cannot inflate, coverage per position from its mint, block time measured, USD basis stated");
}
main().catch((e) => { console.error(e); process.exit(1); });
