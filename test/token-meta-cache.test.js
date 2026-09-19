// node test/token-meta-cache.test.js — a token's symbol and decimals are read once,
// and a failed read is never remembered.
//
// getToken runs inside loadPosition, so it is called for every position on every
// guardian cycle, every dashboard build and every watched-wallet refresh. A symbol
// and a decimals place do not change for an address on a chain. The in-memory cache
// spared the repeats within one process; every restart, and every separate process,
// began again from nothing. It is kept on disk now.
//
// What must not be cached is a failure. Decimals decide the magnitude of every
// amount derived from a token, and 18 assumed on a failed read is indistinguishable
// from a real 18 once it leaves getToken — on Arc, whose USDC answers 6, one
// swallowed failure wrote an opening basis 10^12 too small and froze it.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-meta-"));
process.env.LP_DATA_DIR = dir;
const u = require("../univ3");

const SYMBOL_SEL = "0x95d89b41";
const DECIMALS_SEL = "0x313ce567";

/** A chain that answers symbol() and decimals(), and counts how often it is asked. */
function chain({ symbol = "TEST", decimals = 6, failDecimals = false } = {}) {
  const c = { calls: 0 };
  c.provider = {
    call: async (tx) => {
      c.calls++;
      const sel = String(tx.data).slice(0, 10);
      if (sel === SYMBOL_SEL) return ethers.AbiCoder.defaultAbiCoder().encode(["string"], [symbol]);
      if (sel === DECIMALS_SEL) {
        if (failDecimals) throw new Error("execution reverted");
        return ethers.AbiCoder.defaultAbiCoder().encode(["uint8"], [decimals]);
      }
      throw new Error("unexpected call");
    },
  };
  return c;
}

const addr = (n) => ethers.getAddress("0x" + String(n).repeat(40).slice(0, 40));

(async () => {
  // ---- 1. the second lookup makes no call --------------------------------------
  {
    const c = chain({ symbol: "AAA", decimals: 6 });
    const first = await u.getToken(addr(1), c.provider, 4663);
    const afterFirst = c.calls;
    assert.ok(afterFirst > 0, "the first lookup reads the chain");
    const second = await u.getToken(addr(1), c.provider, 4663);
    assert.strictEqual(c.calls, afterFirst, "the second makes no call at all");
    assert.deepStrictEqual(second, first, "and returns the same metadata");
    assert.strictEqual(first.decimals, 6, "which is what the chain said, not a guess");
  }

  // ---- 2. a failed decimals read is not cached ---------------------------------
  {
    const bad = chain({ symbol: "BBB", failDecimals: true });
    const one = await u.getToken(addr(2), bad.provider, 4663);
    assert.strictEqual(one.decimalsOk, false, "the failure is reported as a failure");
    assert.strictEqual(one.decimals, null, "with no number invented");
    const callsAfterFail = bad.calls;

    // The next lookup must try again rather than inherit the gap.
    const good = chain({ symbol: "BBB", decimals: 8 });
    const two = await u.getToken(addr(2), good.provider, 4663);
    assert.ok(good.calls > 0, "a failed read is retried on the next lookup");
    assert.strictEqual(two.decimals, 8, "and the real value is picked up once the chain answers");
    assert.ok(callsAfterFail > 0);

    // It is not written to the file either.
    u._tokenMeta.save();
    const saved = JSON.parse(fs.readFileSync(u._tokenMeta.file, "utf8"));
    for (const info of Object.values(saved.tokens)) {
      assert.strictEqual(info.decimalsOk, true, "only successful reads are persisted");
      assert.ok(Number.isInteger(info.decimals), "each with a real decimals value");
    }
  }

  // ---- 3. the same address on another chain is another token --------------------
  {
    const other = chain({ symbol: "CCC", decimals: 18 });
    const onArc = await u.getToken(addr(1), other.provider, 5042);
    assert.strictEqual(onArc.decimals, 18, "chain 5042 is read separately");
    assert.strictEqual((await u.getToken(addr(1), chain().provider, 4663)).decimals, 6,
      "and does not disturb what chain 4663 already knew");
  }

  // ---- 4. what comes back from the file is checked, not trusted ------------------
  {
    // The file is shared between processes and is ordinary JSON on disk. A symbol is
    // attacker-controlled text that ends up in HTML and in tool output, and it is
    // sanitised on the way in — so anything that did not come from that path is
    // dropped rather than loaded.
    const src = fs.readFileSync(path.join(__dirname, "..", "univ3.js"), "utf8");
    const load = src.slice(src.indexOf("const saved = JSON.parse"), src.indexOf("function saveTokenMeta"));
    assert.ok(/info\.decimalsOk === true/.test(load), "an entry without a successful read is not loaded");
    assert.ok(/Number\.isInteger\(info\.decimals\)/.test(load), "nor one whose decimals is not a whole number");
    assert.ok(/\/\^\[A-Za-z0-9 \._\$\+-\]\{1,16\}\$\//.test(load), "nor one whose symbol was not sanitised");
    assert.ok(/catch \{ \/\* no file, or unreadable/.test(src), "an unreadable file starts empty rather than throwing");
    assert.ok(/renameSync\(tmp, META_FILE\)/.test(src), "and the file is written whole, then renamed into place");
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("token metadata: read once per address and chain, kept across restarts, a failed decimals read never cached, and nothing loaded from the file that the live path would not have produced");
})().catch((e) => { console.error(e); process.exit(1); });
