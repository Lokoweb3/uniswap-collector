// node test/claims-scanner.test.js — the background claim scan: it finishes what
// panel clicks never would, resumes after a restart, steps aside for requests,
// never runs alongside a request's scan, and backs off when the RPC fails.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const u = require("../univ3");
const cs = require("../claims-store");
const scanner = require("../claims-scanner");

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const POSM = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b";
const USDC = "0x3600000000000000000000000000000000000000";
const ARGUS = "0xece5ca8bf9220718e5727754026757512212cb3c";
const OWNER = "0xb1cdc09b4c7f28365a8e7bfa2332af54f5462af5";
const coder = ethers.AbiCoder.defaultAbiCoder();
const pad = (a) => ethers.zeroPadValue(a, 32);
const META = { token0: USDC, token1: ARGUS, owner: OWNER };

const modLog = (block, tokenId, tx) => ({
  address: PM, blockNumber: block, index: 1, transactionHash: tx,
  topics: [cs.MODIFY_LIQUIDITY, "0x" + "ab".repeat(32), pad(POSM)],
  data: coder.encode(["int24", "int24", "int256", "bytes32"], [-887200, 887200, 0n, pad(ethers.toBeHex(BigInt(tokenId)))]),
});
const mintLog = (block, tokenId) => ({
  address: POSM, blockNumber: block, index: 0, transactionHash: "0xm" + tokenId,
  topics: [cs.TRANSFER, pad(cs.ZERO), pad(OWNER), pad(ethers.toBeHex(BigInt(tokenId)))], data: "0x",
});
const xfer = (token, value) => ({ address: token, topics: [cs.TRANSFER, pad(PM), pad(OWNER)], data: pad(ethers.toBeHex(value)) });

function fakeProvider(world, head) {
  const p = {
    head, getLogsCalls: 0,
    async getBlockNumber() { return p.head; },
    async getBlock(n) { return { timestamp: 1789000000 + n }; },
    async getLogs({ address, topics, fromBlock, toBlock }) {
      p.getLogsCalls++;
      if (p.fail) throw new Error("429 too many requests");
      return world.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock &&
        l.address === address && topics.every((t, i) => t == null || l.topics[i] === t));
    },
    async getTransactionReceipt(h) {
      return { hash: h, logs: world.logs.filter((l) => l.transactionHash === h).concat(world.transfers[h] || []) };
    },
  };
  return p;
}
const mkStore = (provider, file) => cs.create({
  provider, file, chainId: 4663, positionManager: POSM, poolManager: PM,
  stateView: { getSlot0: async () => [u.getSqrtRatioAtTick(0), 0, 0, 0] }, log: { log() {}, error() {} },
});
const quiet = { log() {}, error() {} };
const tick = () => new Promise((r) => setImmediate(r));
async function until(cond, max = 5000) {
  for (let i = 0; i < max && !cond(); i++) await tick();
  assert.ok(cond(), "condition never became true");
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claims-scan-"));

  // ---- 1. a long history is walked to the mint in the background, and resumes --
  {
    const file = path.join(dir, "a.json");
    // 1 s blocks, a 30-day lookback: the floor is far below the mint at 20,000.
    const world = { logs: [mintLog(20000, "7"), modLog(25000, "7", "0xaa")], transfers: { "0xaa": [xfer(USDC, 5000000n)] } };
    const prov = fakeProvider(world, 60000);
    const store = mkStore(prov, file);
    store.remember("7", META);
    let steps = 0;
    const sc = scanner.create({
      store, meta: (id) => store.metaOf(id), ids: () => store.knownIds(), log: quiet,
      chunk: 1000, lookbackMs: 30 * 86400 * 1000, pauseMs: 1, sleep: tick,
      onFolded: async () => {},
    });
    const origScan = store.scan;
    store.scan = async (...a) => { steps++; return origScan(...a); };
    sc.start();
    await until(() => steps >= 10);
    sc.stop();
    await until(() => !sc.status().running);
    const mid = store.coverage("7");
    assert.ok(mid && !mid.coversOpening, "ten one-chunk steps cannot reach a mint 40 chunks back");
    const savedFrom = mid.fromBlock;
    assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".tmp")), "writes are atomic and leave no temporary file");

    // A restart: new store and scanner from the same file, no card has rendered.
    const store2 = mkStore(prov, file);
    assert.deepStrictEqual(store2.knownIds(), ["7"], "the tracked position is persisted with its progress");
    assert.strictEqual(store2.coverage("7").fromBlock, savedFrom, "and the restart starts where the last chunk ended");
    const firstRanges = [];
    const origLogs = prov.getLogs;
    prov.getLogs = async (q) => { if (q.address === PM) firstRanges.push(q.toBlock); return origLogs(q); };
    const sc2 = scanner.create({
      store: store2, meta: (id) => store2.metaOf(id), ids: () => store2.knownIds(), log: quiet,
      chunk: 1000, lookbackMs: 30 * 86400 * 1000, pauseMs: 1, sleep: tick, forwardEveryMs: 1e12,
    });
    sc2.start();
    await until(() => store2.coverage("7").coversOpening, 20000);
    sc2.stop();
    assert.ok(firstRanges.length && firstRanges.every((to) => to < savedFrom),
      "nothing already scanned is scanned again after the restart");
    const sum = store2.summary("7", { dec0: 6, dec1: 18, sym0: "USDC", sym1: "ARGUS", usd0: 1, usd1: 0 });
    assert.strictEqual(sum.status, "ok");
    assert.strictEqual(sum.raw0, "5000000", "the claim found along the way is in the total");
    assert.ok(sc2.status().idle, "and the scanner goes idle once nothing is left");
    prov.getLogs = origLogs;
  }

  // ---- 2. requests come first, but cannot stall the scan forever ----------------
  {
    let t = 0, scans = 0, busy = true;
    const store = { scan: async () => { scans++; return { chunks: 1, folded: 0, pending: 1, lag: 0 }; } };
    const sc = scanner.create({
      store, meta: () => META, ids: () => ["1"], busy: () => busy, log: quiet,
      pauseMs: 100, maxWaitMs: 2000, now: () => t,
      sleep: async (ms) => { t += ms; await tick(); },
    });
    sc.start();
    await until(() => t >= 1000);
    assert.strictEqual(scans, 0, "no chunk is scanned while requests are in flight");
    await until(() => scans >= 1);
    assert.ok(t >= 2000, "a request that never ends only delays the scan by maxWaitMs");
    busy = false;
    const at = scans;
    await until(() => scans >= at + 3);
    sc.stop();
  }

  // ---- 3. one scan at a time: a request never runs alongside the loop -----------
  {
    let release;
    const gate = new Promise((r) => { release = r; });
    const store = { scan: async () => { await gate; return { chunks: 1, folded: 0, pending: 0, lag: 0 }; } };
    const sc = scanner.create({ store, meta: () => META, ids: () => ["1"], log: quiet, sleep: tick });
    sc.start();
    await until(() => sc.scanning);
    const r = await sc.tryExclusive(async () => "request scan");
    assert.strictEqual(r.ran, false, "the request answers from saved progress instead of scanning concurrently");
    release();
    await until(() => !sc.scanning);
    sc.stop();
    const r2 = await sc.tryExclusive(async () => "request scan");
    assert.deepStrictEqual(r2, { ran: true, value: "request scan" });
  }

  // ---- 4. a failing RPC is backed off from, not hammered -----------------------
  {
    const delays = [];
    const errors = [];
    let calls = 0;
    const store = { scan: async () => { calls++; throw new Error("429 too many requests"); } };
    const sc = scanner.create({
      store, meta: () => META, ids: () => ["1"], log: { log() {}, error: (m) => errors.push(m) },
      pauseMs: 500, maxBackoffMs: 8000,
      sleep: async (ms) => { delays.push(ms); await tick(); },
    });
    sc.start();
    await until(() => calls >= 6);
    sc.stop();
    assert.deepStrictEqual(delays.slice(0, 5), [1000, 2000, 4000, 8000, 8000], `exponential, capped: ${delays}`);
    assert.match(sc.status().lastError, /429/, "the last error is reported in the status");
    assert.ok(errors.length >= 5, "and every failure is logged");
  }

  // ---- 5. with nothing to track it idles instead of spinning --------------------
  {
    const delays = [];
    let calls = 0;
    const store = { scan: async () => { calls++; return {}; } };
    const sc = scanner.create({ store, meta: () => null, ids: () => [], log: quiet, idleMs: 30000,
      sleep: async (ms) => { delays.push(ms); await tick(); } });
    sc.start();
    await until(() => delays.length >= 3);
    sc.stop();
    assert.strictEqual(calls, 0, "no scan without positions");
    assert.ok(delays.every((d) => d === 30000), `idle waits are long: ${delays}`);
  }

  // ---- 6. one writer per file: a second server reads, never overwrites ---------
  {
    const file = path.join(dir, "shared.json"), lock = file + ".lock";
    const prov = fakeProvider({ logs: [], transfers: {} }, 1000);
    // Another live process (our parent) holds the file.
    fs.writeFileSync(lock, String(process.ppid));
    const reader = mkStore(prov, file);
    assert.strictEqual(reader.acquireWriter(), false, "a live holder keeps the file");
    assert.strictEqual(reader.readOnly, true);
    reader.remember("5", META);
    assert.ok(!fs.existsSync(file), "a reader's remember() writes nothing");

    // The owner's writes (simulated: lock briefly ours, then handed back) reach the reader.
    fs.unlinkSync(lock);
    const writer = mkStore(prov, path.join(dir, "shared.json"));
    assert.strictEqual(writer.acquireWriter(), true);
    writer.remember("8", META);
    fs.writeFileSync(lock, String(process.ppid));
    assert.deepStrictEqual(reader.knownIds(), ["8"], "the reader re-reads the owner's progress");

    // A lock left by a process that is gone is taken over.
    const { spawnSync } = require("child_process");
    const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
    fs.writeFileSync(lock, dead);
    const next = mkStore(prov, file);
    assert.strictEqual(next.acquireWriter(), true, "a stale lock does not block the scan forever");
    assert.strictEqual(fs.readFileSync(lock, "utf8"), String(process.pid));
    fs.unlinkSync(lock);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("claims scanner: walks to the mint in the background, resumes after restart, yields to requests, one scan at a time, backs off, one writer per file");
}
main().catch((e) => { console.error(e); process.exit(1); });
