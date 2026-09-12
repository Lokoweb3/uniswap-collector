// node test/rpc.test.js — the retrying provider: throttled answers are retried, real errors are not.
const assert = require("assert");
const { RetryingProvider, isTransient } = require("../rpc");

assert.ok(isTransient(new Error("server response 429 Too Many Requests")));
assert.ok(isTransient(new Error("server response 403 Forbidden")));
assert.ok(isTransient({ shortMessage: "fetch failed" }));
assert.ok(!isTransient(new Error("execution reverted")));
assert.ok(!isTransient(new Error("invalid argument 0: hex string")));

// Stub the transport: the parent's _send is replaced per instance so no network is touched.
function stubbed(answers) {
  const p = new RetryingProvider("http://127.0.0.1:1", 1, { staticNetwork: true });
  let i = 0;
  Object.getPrototypeOf(RetryingProvider.prototype)._send = async function () { const a = answers[Math.min(i++, answers.length - 1)]; if (a instanceof Error) throw a; return a; };
  return p;
}
(async () => {
  // Two throttled answers, then success: the caller sees the success and the stats show the retries.
  let p = stubbed([new Error("server response 429 Too Many Requests"), new Error("server response 403 Forbidden"), [{ id: 1, result: "0x1" }]]);
  const r = await p._send([{ id: 1, method: "eth_blockNumber", params: [] }]);
  assert.deepStrictEqual(r, [{ id: 1, result: "0x1" }]);
  assert.deepStrictEqual({ calls: p.rpcStats.calls, retries: p.rpcStats.retries, throttled: p.rpcStats.throttled, failed: p.rpcStats.failed }, { calls: 1, retries: 2, throttled: 2, failed: 0 });
  assert.ok(p.rpcStats.lastThrottleAt > 0);
  // Three throttled answers: the third failure is final.
  p = stubbed([new Error("server response 429"), new Error("server response 429"), new Error("server response 429")]);
  await assert.rejects(() => p._send([{ id: 1, method: "eth_blockNumber", params: [] }]), /429/);
  assert.strictEqual(p.rpcStats.failed, 1); assert.strictEqual(p.rpcStats.retries, 2);
  // A revert is not retried.
  p = stubbed([new Error("execution reverted"), [{ id: 1, result: "0x2" }]]);
  await assert.rejects(() => p._send([{ id: 1, method: "eth_call", params: [] }]), /reverted/);
  assert.strictEqual(p.rpcStats.retries, 0);
  console.log("rpc: transient detection, retry on 429/403, final failure and no-retry on revert — all assertions passed");
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
