// node test/rpc-dashboard-retry.test.js — the dashboards survive throttling, and
// never send a transaction twice.
//
// rpc.js already retried, but only what it could see. Its retry sits in _send, which
// handles TRANSPORT failures: a reset socket, a timeout, a 429 at the HTTP layer. A
// JSON-RPC error response is a perfectly successful HTTP exchange, and ethers turns
// it into an error further up, after _send has returned. Arc throttles exactly that
// way — {"code":-32005,"message":"rate limit exceeded"}, and empty eth_call data
// that ethers reports as "missing revert data" — so none of it was ever retried.
// It reached the pages instead: a vault card reading "Not answering on
// 127.0.0.1:8787" while the dashboard answered other routes in six milliseconds, a
// claims scan logging "could not coalesce error", the assistant reporting that
// watched wallets could not be loaded.
//
// The second half matters more. _send retried EVERY method, including
// eth_sendRawTransaction, and the guardian's auto-close signs through this provider.
// A socket that fails after the node has already broadcast would have been retried:
// a second close of the same position, or a second collect.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { carriesSend, SENDS, isTransient } = require("../rpc");
const { withRetry, RETRYABLE } = require("../rpc-retry");
let behaviour = async () => {};

// ---- 1. a payload carrying a send is recognised, batched or not ----------------
{
  assert.strictEqual(carriesSend({ method: "eth_call" }), false, "a read is not a send");
  assert.strictEqual(carriesSend({ method: "eth_sendRawTransaction" }), true, "a send is");
  assert.strictEqual(carriesSend([{ method: "eth_call" }, { method: "eth_getBalance" }]), false,
    "a batch of reads is not");
  assert.strictEqual(carriesSend([{ method: "eth_call" }, { method: "eth_sendRawTransaction" }]), true,
    "a batch is a send if ANY member is — batching must not smuggle one past the guard");
  assert.strictEqual(carriesSend([]), false);
  assert.strictEqual(carriesSend(null), false, "a malformed payload is not treated as a send-free one by accident");
  for (const m of ["eth_sendRawTransaction", "eth_sendTransaction", "eth_signTransaction"]) {
    assert.ok(SENDS.has(m), `${m} counts as a send`);
    assert.ok(!RETRYABLE.has(m), "and is absent from the read list the method-level retry uses");
  }
}

// ---- 2. _send stops retrying when the payload sends ----------------------------
{
  const src = fs.readFileSync(path.join(__dirname, "..", "rpc.js"), "utf8");
  assert.match(src, /const attempts = carriesSend\(payload\) \? 0 : RETRY_MS\.length;/,
    "the transport retry is disabled for a payload that changes state");
  assert.match(src, /for \(let attempt = 0; attempt <= attempts; attempt\+\+\)/,
    "and the loop uses that, so a send is attempted exactly once");
  assert.ok(!/attempt === RETRY_MS\.length/.test(src),
    "the old unconditional bound is gone, or sends would still be retried");
}

// ---- 3. the method-level retry is attached, where throttling is visible --------
{
  const src = fs.readFileSync(path.join(__dirname, "..", "rpc.js"), "utf8");
  assert.match(src, /require\("\.\/rpc-retry"\)\.withRetry\(this, \{ attempts: 3/,
    "every RetryingProvider gets the method-level retry as well");

  // What that catches and the transport layer does not: a JSON-RPC error response.
  const rate = Object.assign(new Error("could not coalesce error"), { code: -32005 });
  assert.strictEqual(isTransient(rate), true, "rpc.js's own classifier now sees a rate limit, so failover can act on one");
  // But a bare revert must still not look transient at the transport layer, which
  // is the rule rpc.js was written around: retrying an answer we dislike turns a
  // clear "no" into a slower, wandering "no".
  assert.strictEqual(isTransient(new Error("missing revert data")), false,
    "an empty revert is not classed as transient down here; the read-only retry above handles it");

  // Behaviour, on a provider-shaped object.
  behaviour = async () => {
    const calls = [];
    const p = { send: async (m) => { calls.push(m); if (calls.length < 3) throw rate; return `ok:${m}`; } };
    withRetry(p, { attempts: 4, baseMs: 1, sleepFn: async () => {} });
    assert.strictEqual(await p.send("eth_call", []), "ok:eth_call");
    assert.strictEqual(calls.length, 3, "a throttled read is asked again until it answers");
  };
}

// ---- 4. the failures this was built from ---------------------------------------
{
  // Each of these appeared on a page or in a log during one session, and each is a
  // throttled read rather than an answer.
  for (const message of [
    "could not coalesce error",
    "missing revert data",
    "rate limit exceeded",
  ]) assert.strictEqual(require("../rpc-retry").isTransient(new Error(message)), true,
    `"${message}" is treated as throttling, not as a result`);

  // And what must still fail immediately, because retrying changes nothing.
  for (const message of [
    'execution reverted: "Not NFT holder"',
    "nonce too low",
    "insufficient funds for intrinsic transaction cost",
  ]) assert.strictEqual(require("../rpc-retry").isTransient(new Error(message)), false,
    `"${message}" is an answer, not a throttle`);
}

behaviour().then(() => console.log("dashboard rpc: throttling is retried at the layer where it is visible, a send is never retried, and a batch containing one is treated as a send"))
  .catch((e) => { console.error(e); process.exit(1); });
