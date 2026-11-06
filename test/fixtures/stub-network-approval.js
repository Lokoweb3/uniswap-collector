// Like stub-network.js, but the chain answers just enough for /api/approval: eth_call returns
// `true`, eth_chainId the configured id, eth_getLogs an empty list, everything else HTTP 500.
// fetch() still fails. No network is touched.
"use strict";
const { ethers } = require("ethers");

ethers.FetchRequest.registerGetUrl(async (req) => {
  const reply = (obj) => ({ statusCode: 200, statusMessage: "OK", headers: { "content-type": "application/json" }, body: Uint8Array.from(Buffer.from(JSON.stringify(obj))) });
  let calls = [];
  try { const b = JSON.parse(Buffer.from(req.body || []).toString()); calls = Array.isArray(b) ? b : [b]; } catch { /* not JSON */ }
  if (!calls.length) return { statusCode: 500, statusMessage: "Internal Server Error", headers: {}, body: Uint8Array.from(Buffer.from("stubbed upstream failure")) };
  const one = (c) => {
    const result = c.method === "eth_call" ? "0x" + "0".repeat(63) + "1"
      : c.method === "eth_chainId" ? "0x" + Number(process.env.STUB_CHAIN_ID || 1).toString(16)
      : c.method === "eth_getLogs" ? []
      : c.method === "eth_blockNumber" ? "0x100000" : undefined;
    return result === undefined ? { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "stubbed" } } : { jsonrpc: "2.0", id: c.id, result };
  };
  return reply(Array.isArray(JSON.parse(Buffer.from(req.body).toString())) ? calls.map(one) : one(calls[0]));
});

global.fetch = async (url) => { throw new Error(`fetch failed: ${String(url)}`); };
