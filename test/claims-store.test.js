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

  // ---- 8. a verified zero needs whole coverage AND every relevant payout read ---
  // "No records" alone is not zero: each case below finds no usable record, and
  // only the first may be reported as a verified zero.
  {
    const RANGE = [-887200, 887200];
    const sqrtP = u.getSqrtRatioAtTick(0);
    const run = async (world, extra = {}) => {
      const d = tmp(), f = path.join(d, "claims.json");
      const p = fakeProvider(world);
      const s = cs.create(ARGS(p, f, extra.args || {}));
      let err = null;
      try { await s.scan((id) => (extra.meta || META)[id], { ids: extra.ids || ["8240"], chunk: 500, budget: 5, floor: 0 }); }
      catch (e) { err = e; }
      const sum = s.summary("8240", SUM);
      fs.rmSync(d, { recursive: true, force: true });
      return { sum, err, rows: s.rows("8240") };
    };
    const zero = (r) => r.sum.status === "ok" && r.sum.count === 0;
    const from = (addr, to, token, v) => ({ address: token, topics: [cs.TRANSFER, pad(addr), pad(to)], data: ethers.zeroPadValue(ethers.toBeHex(v), 32) });
    const ROUTER = "0x9999999999999999999999999999999999999999";

    // a) mint observed, nothing else: the one honest zero.
    const ok = await run({ logs: [mintLog(700, "8240")], transfers: {} });
    assert.ok(zero(ok), `mint covered and no changes is a verified zero, got ${JSON.stringify(ok.sum)}`);

    // b) the mint was never reached: no zero, however empty the range.
    const noMint = await run({ logs: [], transfers: {} });
    assert.strictEqual(noMint.sum.status, "partial", "no observed mint, no verified zero");

    // c) the RPC drops a receipt: the chunk fails, the cursor does not move past it.
    {
      const d = tmp(), f = path.join(d, "claims.json");
      const world = { logs: [mintLog(700, "8240"), modLog(900, 3, 0n, "8240", "0xgone")], transfers: {} };
      const p = fakeProvider(world);
      p.getTransactionReceipt = async () => null;
      const s = cs.create(ARGS(p, f));
      await assert.rejects(s.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 0 }), /no receipt/);
      const sum = s.summary("8240", SUM);
      assert.ok(!(sum.status === "ok" && sum.count === 0), "a dropped receipt must never read as a verified zero");
      assert.ok(!sum.coverage || sum.coverage.fromBlock > 900, "and the range holding it is not marked scanned");
      fs.rmSync(d, { recursive: true, force: true });
    }

    // d) a log from our manager that cannot be decoded fails the chunk.
    {
      const bad = { ...modLog(900, 3, 0n, "8240", "0xbad"), data: "0x1234" };
      const r = await run({ logs: [mintLog(700, "8240"), bad], transfers: {} });
      assert.ok(r.err, "an undecodable ModifyLiquidity is an error, not an absence");
      assert.ok(!zero(r), "and never a verified zero");
    }

    // e) the payout went to someone other than the owner.
    {
      const r = await run({ logs: [mintLog(700, "8240"), modLog(900, 3, 0n, "8240", "0xaa")],
        transfers: { "0xaa": [from(PM, ROUTER, USDC, 5000000n)] } });
      assert.strictEqual(r.sum.status, "unavailable", `a payout to another address cannot be read as zero, got ${r.sum.status}`);
      assert.match(r.sum.reason, /cannot be attributed/);
    }

    // f) a transfer to the owner that did not come from the pool manager is not a fee.
    {
      const r = await run({ logs: [mintLog(700, "8240"), modLog(900, 3, 0n, "8240", "0xaa")],
        transfers: { "0xaa": [xfer(USDC, 100n), from(ROUTER, OWNER, USDC, 999999n)] } });
      assert.strictEqual(r.sum.raw0, "100", `only pool-manager payouts count, got ${r.sum.raw0}`);
    }

    // g) two changes in one transaction paying the same wallet in the same tokens.
    {
      const meta = { ...META, "8241": META["8240"] };
      const r = await run({ logs: [mintLog(700, "8240"), mintLog(701, "8241"),
        modLog(900, 3, 0n, "8240", "0xaa"), modLog(900, 4, 0n, "8241", "0xaa")],
        transfers: { "0xaa": [xfer(USDC, 100n), xfer(USDC, 50n)] } }, { meta, ids: ["8240", "8241"] });
      assert.strictEqual(r.sum.status, "unavailable", "a shared payout is not credited twice, nor guessed");
      assert.match(r.sum.reason, /cannot be split/);
    }

    // h) another change in the same transaction whose pair is unknown.
    {
      const r = await run({ logs: [mintLog(700, "8240"), modLog(900, 3, 0n, "8240", "0xaa"), modLog(900, 4, 0n, "5555", "0xaa")],
        transfers: { "0xaa": [xfer(USDC, 100n)] } });
      assert.strictEqual(r.sum.status, "unavailable", "an unknown neighbour could share the payout");
    }

    // i) adding liquidity realises fees netted against the deposit.
    {
      const L = 1000000000n;
      // what the pool takes for the add: rounded up
      const need = cs.amountsFor(sqrtP, RANGE[0], RANGE[1], L, true);
      const r = await run({ logs: [mintLog(700, "8240"), modLog(900, 3, L, "8240", "0xad")],
        transfers: { "0xad": [from(OWNER, PM, USDC, need.amount0 - 700n), from(OWNER, PM, ARGUS, need.amount1)] } });
      assert.strictEqual(r.sum.status, "ok");
      assert.strictEqual(r.sum.count, 1, "an add that realised fees is a claim");
      assert.strictEqual(r.rows[0].kind, "increase");
      assert.strictEqual(r.sum.raw0, "700", `fees = principal − deposit paid, got ${r.sum.raw0}`);
      assert.strictEqual(r.sum.raw1, "0");

      // the same add with the full deposit paid (one unit of rounding) is not a claim
      const plain = await run({ logs: [mintLog(700, "8240"), modLog(900, 3, L, "8240", "0xad")],
        transfers: { "0xad": [from(OWNER, PM, USDC, need.amount0), from(OWNER, PM, ARGUS, need.amount1)] } });
      assert.ok(zero(plain), `a plain top-up (exactly the rounded-up deposit) is a verified zero, got ${JSON.stringify(plain.sum)}`);
      // the pool rounds adds up: a round-down principal would call this 1 unit of fees
      const down = u.getAmountsForLiquidity(sqrtP, u.getSqrtRatioAtTick(RANGE[0]), u.getSqrtRatioAtTick(RANGE[1]), L);
      assert.ok(need.amount0 - down.amount0 <= 1n && need.amount1 - down.amount1 <= 1n);

      // the opening deposit, in the mint's own transaction, is never a record
      const opening = await run({ logs: [{ ...mintLog(700, "8240"), transactionHash: "0xop" }, modLog(700, 5, L, "8240", "0xop")],
        transfers: { "0xop": [from(OWNER, PM, USDC, need.amount0 - 700n)] } });
      assert.ok(zero(opening), "a new position has no fees to realise");

      // a deposit paid by someone else cannot be netted
      const other = await run({ logs: [mintLog(700, "8240"), modLog(900, 3, L, "8240", "0xad")],
        transfers: { "0xad": [from(ROUTER, PM, USDC, need.amount0)] } });
      assert.strictEqual(other.sum.status, "unavailable");

      // flows that do not fit the change are not forced into a number
      const misfit = await run({ logs: [mintLog(700, "8240"), modLog(900, 3, L, "8240", "0xad")],
        transfers: { "0xad": [from(OWNER, PM, USDC, need.amount0 + 5000n)] } });
      assert.strictEqual(misfit.sum.status, "unavailable");
      assert.match(misfit.sum.reason, /do not match/);
    }
  }

  // ---- 9. a file written under older decoding rules is rescanned ---------------
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const scope = "5042:" + POSM_A;
    fs.writeFileSync(f, JSON.stringify({ v: 1, scopes: { [scope]: {
      events: { "0xold:1": { key: "0xold:1", tokenId: "8240", chainId: 5042, positionManager: POSM_A, block: 900, fee0: "999", fee1: "0", kind: "collect" } },
      tokens: { "8240": { from: 1, to: 1000, mint: 10 } },
      meta: { "8240": META["8240"] },
    } } }));
    const s = cs.create(ARGS(fakeProvider({ logs: [], transfers: {} }), f));
    assert.strictEqual(s.summary("8240", SUM).status, "unavailable", "old coverage is not trusted");
    assert.strictEqual(s.rows("8240").length, 0, "old records are not counted");
    assert.deepStrictEqual(s.knownIds(), ["8240"], "tracked positions are kept, so the rescan starts at once");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 10. principal uses the price at the transaction, not the end of its block --
  // Real Arc case (#11989, block 21104381): a swap later in the same block moved the
  // price, and the end-of-block read made a plain top-up look unreadable.
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const lo = -600, hi = 600, L = 10n ** 12n;
    const pTx = u.getSqrtRatioAtTick(0), pLater = u.getSqrtRatioAtTick(300), pEarlier = u.getSqrtRatioAtTick(-200);
    const need = (p) => cs.amountsFor(p, lo, hi, L, true);
    const swapLog = (index, sqrt, tx = "0xsw" + index) => ({
      address: PM, blockNumber: 900, index, transactionHash: tx,
      topics: [cs.SWAP, "0x" + "ab".repeat(32), pad(POSM_B)],
      data: coder.encode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], [1n, -1n, sqrt, L, 0, 3000]),
    });
    const pay = (a) => [
      { address: USDC, topics: [cs.TRANSFER, pad(OWNER), pad(PM)], data: ethers.zeroPadValue(ethers.toBeHex(a.amount0), 32) },
      { address: ARGUS, topics: [cs.TRANSFER, pad(OWNER), pad(PM)], data: ethers.zeroPadValue(ethers.toBeHex(a.amount1), 32) },
    ];
    // slot0 answers per block: the end of block 899 is the price at the transaction.
    const sv = { getSlot0: async (_id, { blockTag }) => [blockTag >= 900 ? pLater : pTx, 0, 0, 0] };
    const inc = modLog(900, 5, L, "8240", "0xinc", POSM_A, lo, hi);

    const later = cs.create(ARGS(fakeProvider({ logs: [mintLog(10, "8240"), inc, swapLog(9, pLater)], transfers: { "0xinc": pay(need(pTx)) } }), f, { stateView: sv }));
    await later.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 0 });
    const a = later.summary("8240", SUM);
    assert.strictEqual(a.status, "ok", `a swap after the add must not change its principal, got ${a.reason}`);
    assert.strictEqual(a.count, 0, "a plain top-up is not a claim");
    assert.strictEqual(later.rows("8240").length, 0);

    // A swap earlier in the block is the price the add actually saw.
    const f2 = path.join(d, "b.json");
    const earlier = cs.create(ARGS(fakeProvider({ logs: [mintLog(10, "8240"), swapLog(2, pEarlier), inc], transfers: { "0xinc": pay(need(pEarlier)) } }), f2, { stateView: sv }));
    await earlier.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 0 });
    const b = earlier.summary("8240", SUM);
    assert.strictEqual(b.status, "ok", `the price after the earlier swap is used, got ${b.reason}`);
    assert.strictEqual(b.count, 0);
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 11. one explicit state per history; a zero only when it is a finding -----
  {
    const d = tmp();
    const st = async (world, opts) => {
      const s = cs.create(ARGS(fakeProvider(world), path.join(d, `${Math.random()}.json`)));
      if (opts) await s.scan((id) => META[id], { ...IDS, chunk: 100, ...opts });
      return s.summary("8240", SUM);
    };
    const notScanned = await st({ logs: [], transfers: {} }, null);
    assert.strictEqual(notScanned.state, "not-scanned");
    assert.strictEqual(notScanned.verifiedZero, false);

    // mint far back, budget runs out: still scanning, and nothing found is not $0
    const scanning = await st({ logs: [mintLog(10, "8240")], transfers: {} }, { budget: 2, floor: 0 });
    assert.strictEqual(scanning.state, "scanning");
    assert.strictEqual(scanning.verifiedZero, false);
    assert.strictEqual(scanning.usd, null, "an incomplete range with nothing in it is not a $0 floor");
    assert.match(scanning.reason, /not yet reached/);

    const lookback = await st({ logs: [mintLog(10, "8240"), modLog(950, 1, 0n, "8240", "0xaa")], transfers: { "0xaa": [xfer(USDC, 7n)] } }, { budget: 20, floor: 800 });
    assert.strictEqual(lookback.state, "lookback-reached");
    assert.strictEqual(lookback.status, "partial");
    assert.strictEqual(lookback.raw0, "7", "the floor figure is still shown as what was found");
    assert.match(lookback.reason, /lookback/);

    // an undecodable record wins over every coverage state, even an incomplete one
    const undecodable = await st({ logs: [mintLog(10, "8240"), modLog(950, 1, 0n, "8240", "0xaa")],
      transfers: { "0xaa": [{ address: USDC, topics: [cs.TRANSFER, pad(PM), pad("0x9999999999999999999999999999999999999999")], data: ethers.zeroPadValue("0x05", 32) }] } }, { budget: 2, floor: 0 });
    assert.strictEqual(undecodable.state, "undecodable");
    assert.strictEqual(undecodable.verifiedZero, false);
    assert.strictEqual(undecodable.usd, undefined);

    const zero = await st({ logs: [mintLog(900, "8240")], transfers: {} }, { budget: 20, floor: 0 });
    assert.strictEqual(zero.state, "complete");
    assert.strictEqual(zero.verifiedZero, true);
    assert.strictEqual(zero.usd, 0);

    // a collect that paid nothing is a decoded event with a zero fee: still a verified zero
    const paidNothing = await st({ logs: [mintLog(900, "8240"), modLog(950, 1, 0n, "8240", "0xaa")], transfers: {} }, { budget: 20, floor: 0 });
    assert.strictEqual(paidNothing.state, "complete");
    assert.strictEqual(paidNothing.count, 1);
    assert.strictEqual(paidNothing.verifiedZero, true);

    const earned = await st({ logs: [mintLog(900, "8240"), modLog(950, 1, 0n, "8240", "0xaa")], transfers: { "0xaa": [xfer(USDC, 3n)] } }, { budget: 20, floor: 0 });
    assert.strictEqual(earned.state, "complete");
    assert.strictEqual(earned.verifiedZero, false);
    assert.deepStrictEqual(earned.priceSources, { block: 0, pricelog: 0, today: 1, none: 0 }, "valued at today's price, and counted as such");
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 12. a price keeps the moment it was observed -------------------------------
  {
    const d = tmp(), f = path.join(d, "claims.json");
    const s = cs.create(ARGS(fakeProvider({ logs: [mintLog(900, "8240"), modLog(950, 1, 0n, "8240", "0xaa")], transfers: { "0xaa": [xfer(USDC, 3n)] } }), f));
    await s.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 0 });
    const [r] = s.rows("8240");
    s.setPrice(r.key, { p0: 1, p1: 2, src: "pricelog", t: 1789000000000 });
    assert.deepStrictEqual(s.rows("8240")[0].px, { p0: 1, p1: 2, src: "pricelog", t: 1789000000000 });
    assert.deepStrictEqual(s.summary("8240", SUM).priceSources, { block: 0, pricelog: 1, today: 0, none: 0 });
    fs.rmSync(d, { recursive: true, force: true });
  }

  // ---- 13. v4 rounding: adds up, removals down --------------------------------
  // Real Arc fee-free add (#8240, tx 0xb297aed9…, block 21093628): the pool took
  // exactly the rounded-up principal on both legs.
  {
    const sq = (x) => BigInt(x);
    const lo = -887200, hi = 887200;
    const up = cs.amountsFor(sq(u.getSqrtRatioAtTick(0)), lo, hi, 819041172569578n, true);
    const down = cs.amountsFor(sq(u.getSqrtRatioAtTick(0)), lo, hi, 819041172569578n, false);
    const ref = u.getAmountsForLiquidity(u.getSqrtRatioAtTick(0), u.getSqrtRatioAtTick(lo), u.getSqrtRatioAtTick(hi), 819041172569578n);
    assert.deepStrictEqual(down, ref, "round-down matches the existing removal math");
    assert.ok(up.amount0 - down.amount0 <= 1n && up.amount0 >= down.amount0 && up.amount1 - down.amount1 <= 1n && up.amount1 >= down.amount1);
    // below / above the range: single-sided, same rounding rules
    const below = cs.amountsFor(u.getSqrtRatioAtTick(-887210), -600, 600, 10n ** 12n, true);
    assert.strictEqual(below.amount1, 0n);
    const above = cs.amountsFor(u.getSqrtRatioAtTick(887000), -600, 600, 10n ** 12n, false);
    assert.strictEqual(above.amount0, 0n);
    // summary keeps sub-cent precision: rounding to cents made $0.0361 read as $0.04
    const d = tmp(), f = path.join(d, "claims.json");
    const s = cs.create(ARGS(fakeProvider({ logs: [mintLog(900, "8240"), modLog(950, 1, 0n, "8240", "0xaa")], transfers: { "0xaa": [xfer(USDC, 36149n)] } }), f));
    await s.scan((id) => META[id], { ...IDS, chunk: 500, budget: 5, floor: 0 });
    assert.strictEqual(s.summary("8240", SUM).usd, 0.036149);
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log("claims store: scoped by chain and manager, principal excluded, rescans cannot inflate, coverage per position from its mint, block time measured, USD basis stated");
}
main().catch((e) => { console.error(e); process.exit(1); });
