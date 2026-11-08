// Preloaded into a spawned process (node --require): a tiny Elysium testnet answered from memory behind ethers'
// JSON-RPC transport. No socket is opened; fetch() refuses everything. Every JSON-RPC method asked is appended
// to $STUB_LOG as { kind: "rpc", method, host }, so a test can assert only read methods were used.
// Native balances: WALLET_BALANCES = { "0xaddr": "wei decimal string" } in the environment (STUB_BALANCES JSON).
"use strict";
const fs = require("fs");
const { ethers } = require("ethers");

const CHAIN_ID = Number(process.env.STUB_CHAIN_ID || 99801);
const balances = {};
for (const [a, v] of Object.entries(JSON.parse(process.env.STUB_BALANCES || "{}"))) balances[a.toLowerCase()] = BigInt(v);
const note = (o) => { if (process.env.STUB_LOG) { try { fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(o) + "\n"); } catch { /* ignore */ } } };
const hex = (n) => "0x" + BigInt(n).toString(16);

function answer(method, params) {
  switch (method) {
    case "eth_chainId": return hex(CHAIN_ID);
    case "net_version": return String(CHAIN_ID);
    case "eth_blockNumber": return hex(26_000_000);
    case "eth_gasPrice": return hex(100_000_000);
    case "eth_getBalance": return hex(balances[String(params[0]).toLowerCase()] ?? 0n);
    case "eth_getCode": return "0x";
    case "eth_feeHistory": return { oldestBlock: hex(1), reward: [["0x0"]], baseFeePerGas: [hex(100_000_000), hex(100_000_000)], gasUsedRatio: [0.5] };
    case "eth_estimateGas": return hex(21000);
    case "eth_getBlockByNumber": return { number: hex(26_000_000), hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), timestamp: hex(Math.floor(Date.now() / 1000)), baseFeePerGas: hex(100_000_000), gasLimit: hex(1_000_000_000), gasUsed: "0x0", miner: ethers.ZeroAddress, transactions: [], nonce: "0x0000000000000000", difficulty: "0x1", extraData: "0x", stateRoot: "0x" + "00".repeat(32), receiptsRoot: "0x" + "00".repeat(32), transactionsRoot: "0x" + "00".repeat(32), sha3Uncles: "0x" + "00".repeat(32), logsBloom: "0x" + "00".repeat(256), mixHash: "0x" + "00".repeat(32) };
    default: throw new Error("execution reverted");
  }
}
const dispatch = (req) => {
  note({ kind: "rpc", method: req.method });
  try { return { jsonrpc: "2.0", id: req.id, result: answer(req.method, req.params || []) }; }
  catch { return { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted", data: "0x" } }; }
};
ethers.FetchRequest.registerGetUrl(async (req) => {
  note({ kind: "http", host: new URL(req.url).host });
  const body = JSON.parse(Buffer.from(req.body || new Uint8Array()).toString("utf8") || "null");
  const out = Array.isArray(body) ? body.map(dispatch) : dispatch(body);
  return { statusCode: 200, statusMessage: "OK", headers: { "content-type": "application/json" }, body: Uint8Array.from(Buffer.from(JSON.stringify(out))) };
});
global.fetch = async (url) => { note({ kind: "fetch", host: new URL(String(url)).host }); throw new Error("fetch failed"); };
