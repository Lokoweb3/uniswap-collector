// node test/position-basis.test.js — the opening basis is the denominator of every
// return figure, so a wrong one is worse than a missing one.
//
// Arc's USDC has an 18-decimal native interface and a 6-decimal ERC-20 interface
// over one balance. A refresh that resolved 18 for the 6-decimal token wrote an
// opening amount 10^12 too small, that value was frozen in the ledger, and
// position #27627 reported a fee APR of 2,498,656,364,155,007%.
//
// Known inputs, known expected outputs. Temp directory only.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "basis-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const basis = require("../position-basis");

const USDC = { address: "0x3600000000000000000000000000000000000000", decimals: 6, symbol: "USDC", decimalsOk: true };
const ARGUS = { address: "0xece5ca8bf9220718e5727754026757512212cb3c", decimals: 18, symbol: "ARGUS", decimalsOk: true };
const CHAIN = 5042;

// Every file beside the code, with mtime and size, before anything below runs.
const ROOT = path.join(__dirname, "..");
function snapshotRoot() {
  const m = new Map();
  for (const f of fs.readdirSync(ROOT)) {
    try { const st = fs.statSync(path.join(ROOT, f)); if (st.isFile()) m.set(f, st.mtimeMs + ":" + st.size); } catch {}
  }
  return m;
}
const ROOT_BEFORE = snapshotRoot();

// ---- 1. a 6/18 pair round-trips exactly -------------------------------------
{
  const { record, why } = basis.buildRecord({
    chainId: CHAIN, token0: USDC, token1: ARGUS,
    raw0: "361273065", raw1: "10065753535674154000000",
    liquidity: "6431396504655574", blockNumber: 21130614, now: 1789548617857,
  });
  assert.ok(record, "a good read must record: " + why);
  assert.strictEqual(record.v, 2);
  assert.strictEqual(record.raw0, "361273065", "raw amounts are stored as integers, not converted");
  assert.strictEqual(record.dec0, 6);
  assert.strictEqual(record.dec1, 18);
  assert.strictEqual(record.chainId, CHAIN);
  assert.strictEqual(record.token0, USDC.address);

  const r = basis.readRecord(record, { chainId: CHAIN, token0: USDC, token1: ARGUS, liquidity: "6431396504655574" });
  assert.ok(r.ok, r.reason);
  assert.strictEqual(Number(r.a0.toFixed(6)), 361.273065, "the USDC leg reads back at 6 decimals");
  assert.strictEqual(Number(r.a1.toFixed(6)), 10065.753536, "the ARGUS leg reads back at 18 decimals");
  assert.strictEqual(r.liquidityChanged, false);
}

// ---- 2. a failed metadata read records nothing at all -----------------------
for (const [label, bad] of [
  ["decimals undefined", { address: USDC.address, decimals: undefined, symbol: "USDC", decimalsOk: true }],
  ["decimals not actually read", { address: USDC.address, decimals: 18, symbol: "USDC", decimalsOk: false, decimalsError: "missing revert data" }],
  ["decimals with no provenance at all", { address: USDC.address, decimals: 6, symbol: "USDC" }],
  ["decimals as a string", { address: USDC.address, decimals: "6", symbol: "USDC", decimalsOk: true }],
  ["decimals absurd", { address: USDC.address, decimals: 99, symbol: "USDC", decimalsOk: true }],
  ["address missing", { address: null, decimals: 6, symbol: "USDC", decimalsOk: true }],
]) {
  const { record, why } = basis.buildRecord({ chainId: CHAIN, token0: bad, token1: ARGUS, raw0: "1", raw1: "1" });
  assert.strictEqual(record, null, `${label} must not be recorded`);
  assert.ok(why && why.length > 10, `${label} must say why: ${why}`);
}
{
  const { record, why } = basis.buildRecord({ chainId: null, token0: USDC, token1: ARGUS, raw0: "1", raw1: "1" });
  assert.strictEqual(record, null, "an unknown chain must not be recorded");
  assert.ok(/chain id/i.test(why), why);
}

// ---- 3. a legitimate one-sided position is fine -----------------------------
// All of one token is ordinary for a range sitting entirely on one side.
{
  const { record } = basis.buildRecord({ chainId: CHAIN, token0: USDC, token1: ARGUS, raw0: "0", raw1: "500000000000000000000" });
  const r = basis.readRecord(record, { chainId: CHAIN, token0: USDC, token1: ARGUS });
  assert.ok(r.ok, "a zero leg is legitimate: " + r.reason);
  assert.strictEqual(r.a0, 0);
  assert.strictEqual(r.a1, 500);
}
{
  // and the same through the legacy shape, which is where the rule has to be careful
  const r = basis.readRecord({ t: 1, a0: 0, a1: 500 }, { token0: USDC, token1: ARGUS });
  assert.ok(r.ok, "a legacy zero leg is legitimate too: " + r.reason);
}

// ---- 4. the corrupted legacy record is refused, with the reason -------------
// The real one from Arc: a0 is 10^12 too small, smaller than one raw unit of a
// 6-decimal token, which no deposit can be.
{
  const corrupt = { t: 1789548617857, a0: 3.61273065e-10, a1: 10065.753535674154 };
  const r = basis.readRecord(corrupt, { token0: USDC, token1: ARGUS });
  assert.strictEqual(r.ok, false, "the #27627 record must be refused");
  assert.ok(/smaller than one raw unit/.test(r.reason), "with a specific reason: " + r.reason);
  assert.ok(/USDC/.test(r.reason), "naming the token: " + r.reason);
  assert.strictEqual(r.a0, undefined, "and offering no amounts to divide by");
}
{
  // A legacy record that passes the rule is usable but flagged as unverifiable —
  // passing one check is not proof the value is right.
  const r = basis.readRecord({ t: 1, a0: 361.273065, a1: 10065.75 }, { token0: USDC, token1: ARGUS });
  assert.ok(r.ok);
  assert.strictEqual(r.legacy, true, "it must be marked legacy, not treated as verified");
}
{
  // The rule is per-token: 1e-10 is impossible for 6 decimals, ordinary for 18.
  const r = basis.readRecord({ t: 1, a0: 1, a1: 1e-10 }, { token0: USDC, token1: ARGUS });
  assert.ok(r.ok, "1e-10 of an 18-decimal token is above one raw unit: " + r.reason);
  const r2 = basis.readRecord({ t: 1, a0: 1e-10, a1: 1 }, { token0: USDC, token1: ARGUS });
  assert.strictEqual(r2.ok, false, "the same figure is impossible for a 6-decimal token");
}

// ---- 5. metadata that changed after recording is caught ---------------------
{
  const { record } = basis.buildRecord({ chainId: CHAIN, token0: USDC, token1: ARGUS, raw0: "1000000", raw1: "1" });
  const wrongDecimals = basis.readRecord(record, { chainId: CHAIN, token0: { ...USDC, decimals: 18 }, token1: ARGUS });
  assert.strictEqual(wrongDecimals.ok, false, "a decimals change must invalidate the basis");
  assert.ok(/6 decimals, the position now reports 18/.test(wrongDecimals.reason), wrongDecimals.reason);

  const wrongChain = basis.readRecord(record, { chainId: 4663, token0: USDC, token1: ARGUS });
  assert.strictEqual(wrongChain.ok, false, "a chain change must invalidate the basis");
  assert.ok(/chain 5042.*on 4663/.test(wrongChain.reason), wrongChain.reason);

  const wrongToken = basis.readRecord(record, { chainId: CHAIN, token0: { ...USDC, address: "0x" + "11".repeat(20) }, token1: ARGUS });
  assert.strictEqual(wrongToken.ok, false, "a token address change must invalidate the basis");
}

// ---- 6. liquidity changes are reported, not hidden --------------------------
{
  const { record } = basis.buildRecord({ chainId: CHAIN, token0: USDC, token1: ARGUS, raw0: "1000000", raw1: "1", liquidity: "1000" });
  const same = basis.readRecord(record, { chainId: CHAIN, token0: USDC, token1: ARGUS, liquidity: "1000" });
  assert.strictEqual(same.liquidityChanged, false, "unchanged liquidity");
  const added = basis.readRecord(record, { chainId: CHAIN, token0: USDC, token1: ARGUS, liquidity: "1500" });
  assert.strictEqual(added.liquidityChanged, true, "an add must be visible");
  const removed = basis.readRecord(record, { chainId: CHAIN, token0: USDC, token1: ARGUS, liquidity: "500" });
  assert.strictEqual(removed.liquidityChanged, true, "a removal must be visible");
  const unknown = basis.readRecord(record, { chainId: CHAIN, token0: USDC, token1: ARGUS });
  assert.strictEqual(unknown.liquidityChanged, null, "unknown is null, never false");
}

// ---- 7. nothing was written outside the temp directory ----------------------
// A checkout can legitimately already hold these ledgers, so compare against the
// snapshot taken before any of the above ran rather than asserting the directory
// is bare — the same mistake this check made on its first attempt.
{
  const now = snapshotRoot();
  const added = [...now.keys()].filter((f) => !ROOT_BEFORE.has(f));
  const touched = [...now.keys()].filter((f) => ROOT_BEFORE.has(f) && ROOT_BEFORE.get(f) !== now.get(f));
  assert.deepStrictEqual(added, [], "this test created files beside the code: " + added.join(", "));
  assert.deepStrictEqual(touched, [], "this test modified files beside the code: " + touched.join(", "));
}

console.log("position basis: raw amounts with verified decimals, a corrupt record refused with its reason, zero legs allowed");
