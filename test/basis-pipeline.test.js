// node test/basis-pipeline.test.js — the whole path, not the pieces.
//
// token reader -> metadata cache -> basis capture. A failed decimals() call must
// produce no basis at all, and must not poison the cache; a later successful read
// must then record the right one. This is the sequence that actually happened on
// Arc: one swallowed decimals() failure cached 18 for a 6-decimal token and froze
// an opening amount 10^12 too small into the ledger.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

const u = require("../univ3");
const basis = require("../position-basis");

const USDC_ADDR = "0x3600000000000000000000000000000000000000";
const CHAIN = 5042;

/** A provider whose decimals() fails the first `failFirst` times, then returns 6. */
function providerWhere(failFirst) {
  let calls = 0;
  return {
    calls: () => calls,
    // ethers Contract calls through here; univ3 builds the contract itself, so
    // intercept at the JSON-RPC level the same way ethers would reach the chain.
    async call({ data }) {
      // decimals() selector 0x313ce567, symbol() 0x95d89b41
      if (String(data).startsWith("0x313ce567")) {
        calls++;
        if (calls <= failFirst) { const e = new Error("missing revert data"); e.code = "CALL_EXCEPTION"; e.data = null; throw e; }
        return "0x" + (6).toString(16).padStart(64, "0");
      }
      if (String(data).startsWith("0x95d89b41")) {
        // abi-encoded "USDC"
        return "0x" + "20".padStart(64, "0") + "4".toString(16).padStart(64, "0") +
          Buffer.from("USDC").toString("hex").padEnd(64, "0");
      }
      return "0x";
    },
    async getNetwork() { return { chainId: BigInt(CHAIN) }; },
    async resolveName(x) { return x; },
    _isProvider: true,
  };
}

(async () => {
  // ---- a failed decimals read: unverified, uncached, and no basis ------------
  {
    const p = providerWhere(1);
    const t = await u.getToken(USDC_ADDR, p, CHAIN);
    assert.strictEqual(t.decimalsOk, false, "a failed decimals() must not be reported as verified");
    assert.ok(t.decimalsError, "and must carry the reason: " + JSON.stringify(t.decimalsError));

    const built = basis.buildRecord({
      chainId: CHAIN, token0: t, token1: { ...t, address: "0x" + "22".repeat(20), decimals: 18, decimalsOk: true },
      raw0: "361273065", raw1: "1",
    });
    assert.strictEqual(built.record, null, "no basis may be recorded from unverified decimals");
    assert.ok(/were not read from the chain/.test(built.why), "with the reason: " + built.why);

    // ---- and the next read recovers, because nothing bad was cached ----------
    const t2 = await u.getToken(USDC_ADDR, p, CHAIN);
    assert.strictEqual(t2.decimalsOk, true, "the retry must succeed rather than inherit the guess");
    assert.strictEqual(t2.decimals, 6, "and read the real value: " + t2.decimals);

    const ok = basis.buildRecord({
      chainId: CHAIN, token0: t2, token1: { ...t2, address: "0x" + "22".repeat(20), decimals: 18, decimalsOk: true },
      raw0: "361273065", raw1: "1",
    });
    assert.ok(ok.record, "the recovered read must record: " + ok.why);
    assert.strictEqual(ok.record.dec0, 6);
    const read = basis.readRecord(ok.record, { chainId: CHAIN, token0: t2, token1: { ...t2, address: "0x" + "22".repeat(20), decimals: 18, decimalsOk: true } });
    assert.ok(read.ok, read.reason);
    assert.strictEqual(Number(read.a0.toFixed(6)), 361.273065,
      "the opening amount is 361.273065, not 3.61e-10 — the whole point of this test");
  }

  // ---- a verified read is cached; a chain change is a different key ----------
  {
    const p = providerWhere(0);
    const a = await u.getToken(USDC_ADDR, p, CHAIN);
    const before = p.calls();
    await u.getToken(USDC_ADDR, p, CHAIN);
    assert.strictEqual(p.calls(), before, "a verified read is cached, so no second call");
    await u.getToken(USDC_ADDR, p, 4663);
    assert.ok(p.calls() > before, "a different chain is a different cache key");
    assert.strictEqual(a.decimalsOk, true);
  }

  console.log("basis pipeline: a failed decimals read records no basis and is not cached, and the retry recovers 6 decimals");
})().catch((e) => { console.error(e); process.exit(1); });
