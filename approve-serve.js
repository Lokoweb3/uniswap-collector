#!/usr/bin/env node
/**
 * `npm run approve`: serve the Wallet page (its Approvals tab) on http://127.0.0.1:3333 with the
 * same /api/v4-approval endpoint the dashboard offers, for when the dashboard
 * is not running. Serves nothing else (no directory listing, no .env).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const cfg = require("./settings").load();
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

/** Every operator the owner has ever granted setApprovalForAll on `mgr`, with its current state (from events, re-checked on chain). */
async function approvedOperators(provider, mgr, owner) {
  const iface = new ethers.Interface(["event ApprovalForAll(address indexed owner,address indexed operator,bool approved)"]);
  const c = new ethers.Contract(mgr, ["function isApprovedForAll(address,address) view returns (bool)"], provider);
  let logs = [];
  try {
    logs = await provider.getLogs({ address: mgr, fromBlock: 0, toBlock: "latest", topics: [iface.getEvent("ApprovalForAll").topicHash, ethers.zeroPadValue(owner, 32)] });
  } catch {
    return [];
  }
  const seen = new Map();
  for (const l of logs) seen.set(iface.parseLog(l).args.operator, true);
  const out = [];
  for (const op of seen.keys()) out.push({ address: op, approved: await c.isApprovedForAll(owner, op).catch(() => null) });
  return out;
}


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
        // Allowed owners: the main wallet plus the settings.json wallets.
        const allowed = [{ address: cfg.ownerAddress, label: "Main wallet", main: true }];
        try {
          const wj = { watched: (cfg.wallets && cfg.wallets.list) || [] };
          if (wj.owner && wj.owner.label) allowed[0].label = wj.owner.label;
          for (const w of wj.watched || []) if (w && ethers.isAddress(w.address)) allowed.push({ address: ethers.getAddress(w.address), label: w.label || w.address, main: false, collect: !!w.collect });
        } catch {}
        const want = url.searchParams.get("owner");
        const ownerEntry = want ? allowed.find((a) => a.address.toLowerCase() === want.toLowerCase()) : allowed[0];
        if (!ownerEntry) throw new Error("that wallet is not the main wallet or a wallet listed under wallets in settings.json");
        const approved = op ? await c.isApprovedForAll(ownerEntry.address, op) : null;
        const others = (await approvedOperators(provider, mgr, ownerEntry.address)).filter((o) => o.approved && (!op || o.address.toLowerCase() !== op.toLowerCase()));
        const wallets = [];
        for (const a of allowed) wallets.push({ ...a, approved: op ? await c.isApprovedForAll(a.address, op).catch(() => null) : null });
        return res.end(JSON.stringify({ ok: true, version: v, owner: ownerEntry.address, ownerLabel: ownerEntry.label, operator: op, posm: ethers.getAddress(mgr), chainId: Number(cfg.chainId), chainName: "Robinhood Chain", rpc: cfg.rpcUrl, explorer: "https://robinhoodchain.blockscout.com", approved, others, wallets }));
      } catch (err) {
        res.writeHead(500);
        return res.end(JSON.stringify({ ok: false, error: err.shortMessage || err.message }));
      }
    }
    if (/^\/approve-v[34](\.html)?$/.test(url.pathname)) { res.writeHead(302, { Location: "/wallet#approvals" }); return res.end(); }
    if (url.pathname === "/" || url.pathname === "/wallet" || url.pathname === "/wallet.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(__dirname, "wallet.html")));
    }
    if (url.pathname === "/dashboard.css" || url.pathname === "/qr.js" || url.pathname === "/chat-widget.js") {
      try { res.writeHead(200, { "Content-Type": url.pathname.endsWith(".css") ? "text/css" : "application/javascript" }); return res.end(fs.readFileSync(path.join(__dirname, url.pathname.slice(1)))); } catch {}
    }
    res.writeHead(404);
    res.end("not found");
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`http://127.0.0.1:${PORT}/wallet#approvals   (open in the browser with your wallet extension; only the Approvals tab works here)`);
    console.log(`Owner ${cfg.ownerAddress}, operator ${operator || "(no keystore found)"}.`);
  });
