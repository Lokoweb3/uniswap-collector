// Preloaded into a spawned server (node --require) so a test can run it with no network:
// every JSON-RPC request answers HTTP 500 (ethers puts the request URL in that error's
// text, which is exactly what must not leak) and every fetch() fails. What was attempted
// is appended to $STUB_LOG as JSON lines: { kind, host, auth }.
"use strict";
const fs = require("fs");
const { ethers } = require("ethers");

const note = (o) => { if (process.env.STUB_LOG) { try { fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(o) + "\n"); } catch { /* ignore */ } } };

ethers.FetchRequest.registerGetUrl(async (req) => {
  const u = new URL(req.url);
  note({ kind: "rpc", host: u.host, path: u.pathname + u.search });
  return { statusCode: 500, statusMessage: "Internal Server Error", headers: {}, body: Uint8Array.from(Buffer.from("stubbed upstream failure")) };
});

global.fetch = async (url, init = {}) => {
  const h = init.headers || {};
  const u = new URL(String(url));
  note({ kind: "fetch", host: u.host, path: u.pathname + u.search, auth: !!(h.Authorization || h.authorization) });
  throw new Error(`fetch failed: ${String(url)}`);   // carries the URL, as undici's errors can
};
