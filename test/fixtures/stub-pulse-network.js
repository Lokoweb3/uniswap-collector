// Preloaded into a spawned process (node --require): a small PulseChain answered from memory, with the addresses
// of settings.pulsechain.example.json, behind ethers' JSON-RPC transport; fetch() answers the explorer's token list
// (JSON, or an HTML page when STUB_EXPLORER=html) and refuses everything else. No socket is opened.
// What was attempted is appended to $STUB_LOG as JSON lines: { kind, host, auth }.
"use strict";
const fs = require("fs");
const { ethers } = require("ethers");
const { world, units } = require("./mock-pulse");

const WPLS = "0xA1077a294dDE1B09bB078844df40758a5D0f9a27", DAI = "0xefD766cCb38EaF1dfd701853BFCe31359239F305";
const USDC = "0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07", USDT = "0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f";
const V1 = "0x1715a3E4A142d8b698131108995174F37aEBA10D", V2 = "0x29eA7545DEf87022BAdc76323F373EA1e707C523";
const REF = "0xE56043671df55dE5CDf8459710433C10324DE0aE";
const FARM = "0xB2Ca4A66d3e57a5a9A12043B6bAD28249fE302d4";
const WALLET12 = "0xAAB445f2846476A31Aaed66112B0f3e2ad82c50A";
const MEME = "0x00000000000000000000000000000000000a0001", INC = "0x2fa878Ab3F87CC1C9737Fc071108F904c0B0C95d";
const MEME_WPLS = "0x00000000000000000000000000000000000b0001", MEME_DAI = "0x00000000000000000000000000000000000b0002";
const THIN = "0x00000000000000000000000000000000000a0003", THIN_DAI = "0x00000000000000000000000000000000000b0004", THIN_WPLS = "0x00000000000000000000000000000000000b0005";
const EVIL = "0x00000000000000000000000000000000000a0002", EVIL_DAI = "0x00000000000000000000000000000000000b0003";

const note = (o) => { if (process.env.STUB_LOG) { try { fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(o) + "\n"); } catch { /* ignore */ } } };

const w = world({ chainId: 369 });
w.token(WPLS, "WPLS", 18); w.token(DAI, "DAI", 18); w.token(USDC, "USDC", 6); w.token(USDT, "USDT", 6); w.token(INC, "INC", 18); w.token(MEME, "MEME", 18);
w.token(THIN, "THIN", 18);
w.token(EVIL, "<img src=x onerror=alert(1)>", 18);
w.factory(V1); w.factory(V2);
w.pair(REF, V1, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18));                     // WPLS = $0.05
w.pair(MEME_DAI, V1, MEME, DAI, units(10_000, 18), units(20_000, 18), units(1_000, 18));                    // MEME = $2
w.pair(MEME_WPLS, V2, MEME, WPLS, units(5_000, 18), units(200_000, 18), units(1_000, 18), { [WALLET12]: units(100, 18) });
w.pair(EVIL_DAI, V2, EVIL, DAI, units(1_000, 18), units(1_000, 18), units(10, 18), { [WALLET12]: units(1, 18) });
w.pair(THIN_DAI, V1, THIN, DAI, units(1_000, 18), units(2_000, 18), units(1_000, 18));                       // THIN = $2, deep enough to price it
w.pair(THIN_WPLS, V2, THIN, WPLS, units(10, 18), units(400, 18), units(100, 18), { [WALLET12]: units(10, 18) }); // a thin pool: $20 a side
w.farm(FARM, INC, [MEME_WPLS]);
w.native[WALLET12.toLowerCase()] = units(1_000, 18);
w.setBalance(MEME, WALLET12, units(50, 18));

const dispatch = (req) => {
  try { return { jsonrpc: "2.0", id: req.id, result: w.rpc(req.method, req.params) }; }
  catch (e) { return { jsonrpc: "2.0", id: req.id, error: { code: 3, message: "execution reverted", data: "0x" } }; }
};
ethers.FetchRequest.registerGetUrl(async (req) => {
  note({ kind: "rpc", host: new URL(req.url).host });
  const body = JSON.parse(Buffer.from(req.body || new Uint8Array()).toString("utf8") || "null");
  const out = Array.isArray(body) ? body.map(dispatch) : dispatch(body);
  return { statusCode: 200, statusMessage: "OK", headers: { "content-type": "application/json" }, body: Uint8Array.from(Buffer.from(JSON.stringify(out))) };
});

global.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const h = init.headers || {};
  note({ kind: "fetch", host: u.host, auth: !!(h.Authorization || h.authorization) });
  const m = u.pathname.match(/\/api\/v2\/addresses\/(0x[0-9a-fA-F]{40})\/token-balances$/);
  if (u.host === "api.scan.pulsechain.com" && m) {
    if (process.env.STUB_EXPLORER === "html") return new Response("<html>Just a moment...</html>", { status: 200, headers: { "content-type": "text/html" } });
    const items = m[1].toLowerCase() === WALLET12.toLowerCase()
      ? [{ token: { address_hash: MEME_WPLS, type: "ERC-20", symbol: "PLP" }, value: "100" }, { token: { address_hash: EVIL_DAI, type: "ERC-20", symbol: "PLP" }, value: "1" }, { token: { address_hash: THIN_WPLS, type: "ERC-20", symbol: "PLP" }, value: "10" }, { token: { address_hash: DAI, type: "ERC-20" }, value: "5" }]
      : [];
    return new Response(JSON.stringify(items), { status: 200, headers: { "content-type": "application/json" } });
  }
  const t = u.pathname.match(/\/api\/v2\/addresses\/(0x[0-9a-fA-F]{40})\/tokens$/);
  if (u.host === "api.scan.pulsechain.com" && t) {
    // the portfolio's loose-token discovery (existing code path): a page of ERC-20 holdings
    const items = t[1].toLowerCase() === WALLET12.toLowerCase() ? [{ token: { address_hash: MEME, type: "ERC-20" }, value: "1" }, { token: { address_hash: MEME_WPLS, type: "ERC-20" }, value: "100" }] : [];
    return new Response(JSON.stringify({ items, next_page_params: null }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`fetch failed: ${String(url)}`);
};
