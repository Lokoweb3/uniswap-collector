#!/usr/bin/env node
/**
 * `npm run approve`: serve approve-v4.html on http://127.0.0.1:3333 with the
 * same /api/v4-approval endpoint the dashboard offers, for when the dashboard
 * is not running. Serves nothing else (no directory listing, no .env).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, Number(cfg.chainId));
function operatorAddress() {
  try {
    const ksPath = process.env.LP_KEYSTORE_PATH || path.join(process.env.HOME || "", ".lp-collector", "operator-keystore.json");
    return ethers.getAddress("0x" + JSON.parse(fs.readFileSync(ksPath, "utf8")).address.replace(/^0x/, ""));
  } catch {
    return null;
  }
}
const operator = operatorAddress();
const PORT = Number(process.env.PORT || 3333);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/api/approval" || url.pathname === "/api/v4-approval") {
      res.setHeader("Content-Type", "application/json");
      try {
        const v = url.pathname === "/api/v4-approval" ? 4 : Number(url.searchParams.get("v")) === 3 ? 3 : 4;
        const mgr = v === 3 ? cfg.contracts.positionManager : cfg.contracts.v4 && cfg.contracts.v4.positionManager;
        const op = operatorAddress();
        const c = new ethers.Contract(mgr, ["function isApprovedForAll(address,address) view returns (bool)"], provider);
        const approved = op ? await c.isApprovedForAll(cfg.ownerAddress, op) : null;
        return res.end(JSON.stringify({ ok: true, version: v, owner: cfg.ownerAddress, operator: op, posm: ethers.getAddress(mgr), chainId: Number(cfg.chainId), chainName: "Robinhood Chain", rpc: cfg.rpcUrl, explorer: "https://robinhoodchain.blockscout.com", approved }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
      }
    }
    if (url.pathname === "/" || /^\/approve-v[34](\.html)?$/.test(url.pathname)) {
      const file = url.pathname.includes("v3") ? "approve-v3.html" : "approve-v4.html";
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(__dirname, file)));
    }
    res.writeHead(404);
    res.end("not found");
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`v3: http://127.0.0.1:${PORT}/approve-v3   v4: http://127.0.0.1:${PORT}/approve-v4   (open in the browser with your wallet extension)`);
    console.log(`Owner ${cfg.ownerAddress}, operator ${operator || "(no keystore found)"}.`);
  });
