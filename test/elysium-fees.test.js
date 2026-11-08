// node test/elysium-fees.test.js -- orbit-fees.js against a mocked RPC: no network, no signing, no send.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const orbit = require("../orbit-fees");
const logic = require("../collector-logic");

const NI = "0x00000000000000000000000000000000000000C8";
const IFACE = new ethers.Interface(["function gasEstimateComponents(address to,bool contractCreation,bytes data) returns (uint64,uint64,uint256,uint256)"]);
const hex = (n) => "0x" + BigInt(n).toString(16);
/** A provider with provider.send(method, params) answered by `handlers`; every method asked is recorded. */
const mock = (handlers) => {
  const calls = [];
  return { calls, send: async (method, params) => {
    calls.push({ method, params });
    const h = handlers[method];
    if (!h) throw new Error(`no handler for ${method}`);
    return typeof h === "function" ? h(params) : h;
  } };
};
const TO = "0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8";

(async () => {
  // ---- readFees (24)
  {
    const p = mock({ eth_gasPrice: hex(100_000_000), eth_getBlockByNumber: { baseFeePerGas: hex(90_000_000) }, eth_feeHistory: { reward: [["0x0"], ["0x0"], ["0x0"], ["0x0"]], baseFeePerGas: [] } });
    const f = await orbit.readFees(p);
    assert.strictEqual(f.eip1559, true); assert.strictEqual(f.baseFeePerGas, 90_000_000n); assert.strictEqual(f.gasPrice, 100_000_000n);
    assert.strictEqual(f.maxPriorityFeePerGas, 0n, "priority fee is 0 on Orbit unless the RPC reports otherwise");
    assert.strictEqual(f.maxFeePerGas, 180_000_000n);
    const tip = await orbit.readFees(mock({ eth_gasPrice: hex(1), eth_getBlockByNumber: { baseFeePerGas: hex(10) }, eth_feeHistory: { reward: [["0x5"], ["0x5"], ["0x5"]] } }));
    assert.strictEqual(tip.maxPriorityFeePerGas, 5n, "reported, so used");
    // legacy: no baseFeePerGas
    const legacy = await orbit.readFees(mock({ eth_gasPrice: hex(7), eth_getBlockByNumber: { number: "0x1" } }));
    assert.deepStrictEqual(legacy, { gasPrice: 7n, baseFeePerGas: null, eip1559: false, maxFeePerGas: null, maxPriorityFeePerGas: null });
    // eth_feeHistory erroring: still answers from gasPrice and the block
    const broken = await orbit.readFees(mock({ eth_gasPrice: hex(7), eth_getBlockByNumber: { baseFeePerGas: hex(3) } }));
    assert.strictEqual(broken.eip1559, true); assert.strictEqual(broken.baseFeePerGas, 3n); assert.strictEqual(broken.maxPriorityFeePerGas, 0n); assert.strictEqual(broken.gasPrice, 7n);
    // garbage never becomes NaN
    await assert.rejects(orbit.readFees(mock({ eth_gasPrice: "nope", eth_getBlockByNumber: {} })), /not a hex quantity/);
    await assert.rejects(orbit.readFees(mock({ eth_gasPrice: hex(1), eth_getBlockByNumber: { baseFeePerGas: "12" } })), /not a hex quantity/);
  }

  // ---- estimateGas (25)
  {
    const ret = IFACE.encodeFunctionResult("gasEstimateComponents", [100000n, 30000n, 90_000_000n, 5_000_000n]);
    const p = mock({ eth_call: ret, eth_estimateGas: hex(21000) });
    const g = await orbit.estimateGas(p, { to: TO, data: "0x", from: TO });
    assert.strictEqual(g.source, "nodeinterface");
    assert.strictEqual(g.gasForL1, 30000n);
    assert.strictEqual(g.raw, 100000n, "the NodeInterface gasEstimate is the total, L1 component included");
    assert.strictEqual(g.gas, logic.gasEstimate(100000n, 1n, 25), "headroom is collector-logic.gasEstimate");
    assert.strictEqual(g.gas, 125000n);
    assert.deepStrictEqual(p.calls.map((c) => c.method), ["eth_call"]);
    assert.strictEqual(p.calls[0].params[0].to.toLowerCase(), NI.toLowerCase(), "the call goes to exactly 0x...C8");
    assert.strictEqual(p.calls[0].params[0].data.slice(0, 10), IFACE.getFunction("gasEstimateComponents").selector);
    assert.strictEqual((await orbit.estimateGas(p, { to: TO }, { headroomPct: 0 })).gas, 100000n);
    // value reaches the NodeInterface eth_call (as a hex quantity) as well as from; absent value adds no key
    const pv = mock({ eth_call: ret, eth_estimateGas: hex(21000) });
    await orbit.estimateGas(pv, { to: TO, from: TO, value: 1000000000000000000n });
    assert.deepStrictEqual(Object.keys(pv.calls[0].params[0]).sort(), ["data", "from", "to", "value"]);
    assert.strictEqual(pv.calls[0].params[0].value, "0xde0b6b3a7640000"); assert.strictEqual(pv.calls[0].params[0].from, TO);
    assert.ok(!("value" in p.calls[0].params[0]), "no value, no key");
    const pf = mock({ eth_call: "0x", eth_estimateGas: hex(21000) });
    await orbit.estimateGas(pf, { to: TO, from: TO, value: 5 });
    assert.strictEqual(pf.calls[1].params[0].value, "0x5", "the eth_estimateGas fallback carries it too");
    // every way NodeInterface can fail falls back to eth_estimateGas
    for (const [label, handler] of [["revert", () => { throw new Error("execution reverted"); }], ["empty data", "0x"], ["null", null], ["undecodable", "0x1234"], ["zero estimate", IFACE.encodeFunctionResult("gasEstimateComponents", [0n, 0n, 1n, 1n])]]) {
      const q = mock({ eth_call: handler, eth_estimateGas: hex(21000) });
      const r = await orbit.estimateGas(q, { to: TO, data: "0x", from: TO, value: 1n });
      assert.strictEqual(r.source, "eth_estimateGas", label);
      assert.strictEqual(r.gas, 26250n, label); assert.strictEqual(r.gasForL1, null);
      assert.deepStrictEqual(q.calls.map((c) => c.method), ["eth_call", "eth_estimateGas"], label);
    }
    // a non-hex answer is a clear error, not NaN
    await assert.rejects(orbit.estimateGas(mock({ eth_call: "0x", eth_estimateGas: "twenty" }), { to: TO }), /eth_estimateGas: not a hex quantity/);
    await assert.rejects(orbit.estimateGas(mock({}), { to: "nope" }), /not an address/);
    // overflow: a gasEstimate above uint64 cannot be decoded, so the fallback answers
    const big = "0x" + "ff".repeat(32) + "00".repeat(32 * 3);
    assert.strictEqual((await orbit.estimateGas(mock({ eth_call: big, eth_estimateGas: hex(21000) }), { to: TO })).source, "eth_estimateGas");
  }

  // ---- read-only by construction
  {
    const code = fs.readFileSync(path.join(__dirname, "..", "orbit-fees.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/sendTransaction|signTransaction|signMessage|new ethers\.Wallet|sendRawTransaction|eth_send|personal_sign|broadcast/.test(code), "no signing or write path");
    const methods = new Set(code.match(/eth_[A-Za-z]+/g));
    assert.deepStrictEqual([...methods].sort(), ["eth_call", "eth_estimateGas", "eth_feeHistory", "eth_gasPrice", "eth_getBlockByNumber"]);
  }
  console.log("orbit fees: readFees (EIP-1559, legacy, feeHistory down), NodeInterface estimate with fallback, read-only");
})().catch((e) => { console.error(e); process.exit(1); });
