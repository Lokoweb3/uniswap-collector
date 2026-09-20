// node test/rpc-retry.test.js — a throttled read is asked again; a send never is.
//
// Arc's RPC throttles a collector's burst, and does not always say so. One pass was
// refused outright with {"code":-32005,"message":"rate limit exceeded"} on its first
// eth_getBalance and died before signing anything. Another kept going while eth_call
// came back empty — which ethers reports as "missing revert data", the same words a
// contract reverting without a reason produces. That run read the sweep target's
// symbol as "???" and skipped a position holding $44 of fees, and said "done".
//
// Unattended that is the dangerous shape: a scheduled pass that silently skips a
// position and reports success. So reads are retried.
//
// The thing that must never happen is a retried send. eth_sendRawTransaction may
// have reached the node and been broadcast before the response was lost; sending it
// again risks a second transaction on the same nonce — two collects, or a swap done
// twice. A failed send goes back to the caller, which already knows how to stop.
"use strict";
const assert = require("assert");
const { withRetry, isTransient, RETRYABLE } = require("../rpc-retry");

/** A provider that fails the first `failures` calls with `err`, then answers. */
function fake(failures, err, { attempts = 4 } = {}) {
  const calls = [];
  const p = {
    send: async (method, params) => {
      calls.push(method);
      if (calls.length <= failures) throw err;
      return `ok:${method}`;
    },
  };
  withRetry(p, { attempts, baseMs: 1, log: () => {}, sleepFn: async () => {} });
  return { p, calls };
}

const rateLimit = Object.assign(new Error("rate limit exceeded"), { code: -32005 });
const emptyData = new Error("missing revert data (action=\"call\")");
const realRevert = new Error('execution reverted: "Not NFT holder"');

(async () => {
  // ---- 1. a throttled read is retried until it answers -------------------------
  {
    const { p, calls } = fake(2, rateLimit);
    assert.strictEqual(await p.send("eth_call", []), "ok:eth_call", "the third attempt answers");
    assert.strictEqual(calls.length, 3, "and it took three attempts");
    assert.deepStrictEqual(p.retryStats(), { retried: 2 }, "the retries are counted, not hidden");
  }

  // ---- 2. an empty response is treated as throttling, not as an answer ---------
  {
    // This is the case that skipped a position. "missing revert data" is ambiguous
    // — a genuine revert with no reason string looks the same — and retrying costs
    // one read and returns the same refusal. Treating it as a contract's considered
    // answer costs a position's fees.
    const { p, calls } = fake(1, emptyData);
    assert.strictEqual(await p.send("eth_call", []), "ok:eth_call", "the second attempt answers");
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(isTransient(emptyData), true, "and it is classed as transient deliberately");
  }

  // ---- 3. a send is never retried ----------------------------------------------
  {
    for (const method of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_signTransaction"]) {
      const { p, calls } = fake(1, rateLimit);
      await assert.rejects(() => p.send(method, ["0xdeadbeef"]), /rate limit/, `${method} fails through to the caller`);
      assert.strictEqual(calls.length, 1, `${method} is attempted exactly once, whatever the error`);
    }
    // An unknown method is treated as a send: not on the read list, not assumed safe.
    const { p, calls } = fake(1, rateLimit);
    await assert.rejects(() => p.send("eth_someNewThing", []), /rate limit/);
    assert.strictEqual(calls.length, 1, "an unrecognised method is never retried");
    assert.ok(!RETRYABLE.has("eth_sendRawTransaction"), "and sends are not on the read list");
  }

  // ---- 4. a real failure is not retried into a delay ---------------------------
  {
    const { p, calls } = fake(1, realRevert);
    await assert.rejects(() => p.send("eth_call", []), /Not NFT holder/, "a contract's refusal is returned as it is");
    assert.strictEqual(calls.length, 1, "without wasting attempts on an answer that will not change");
    assert.strictEqual(isTransient(realRevert), false);
  }

  // ---- 5. it gives up rather than retrying for ever -----------------------------
  {
    const { p, calls } = fake(99, rateLimit, { attempts: 4 });
    await assert.rejects(() => p.send("eth_call", []), /rate limit/, "a persistently throttled endpoint fails the call");
    assert.strictEqual(calls.length, 4, "after exactly the configured number of attempts");
  }

  // ---- 6. what counts as transient ---------------------------------------------
  {
    for (const err of [
      Object.assign(new Error("x"), { code: -32005 }),
      Object.assign(new Error("x"), { status: 429 }),
      Object.assign(new Error("x"), { status: 503 }),
      new Error("could not coalesce error"),
      new Error("request timed out"),
      Object.assign(new Error("connection reset"), { message: "ECONNRESET" }),
      new Error("fetch failed"),
    ]) assert.strictEqual(isTransient(err), true, `transient: ${err.message} ${err.code || err.status || ""}`);

    for (const err of [
      null,
      new Error(""),
      new Error("execution reverted: insufficient balance"),
      new Error("nonce too low"),
      new Error("replacement fee too low"),
      new Error("intrinsic gas too low"),
    ]) assert.strictEqual(isTransient(err), false, `not transient: ${err && err.message}`);
  }

  // ---- 7. the collector actually uses it ----------------------------------------
  {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(path.join(__dirname, "..", "collector.js"), "utf8");
    assert.match(src, /require\("\.\/rpc-retry"\)\.withRetry\(/, "the collector's provider is wrapped");
    assert.match(src, /new ethers\.JsonRpcProvider\(cfg\.rpcUrl, cfg\.chainId\)/, "around its own provider");
    assert.match(src, /log,/, "and retries are logged, so a struggling endpoint is visible rather than absorbed");
  }

  console.log("rpc retry: a throttled or empty read is asked again with backoff, a real revert is not, a send is never retried, and an unknown method is treated as a send");
})().catch((e) => { console.error(e); process.exit(1); });
