// node tools/seed-receipt-fixtures.js — one receipt fixture per route shape already on record.
// New shapes are saved by the scanner as they appear; this seeds the ones that predate it.
"use strict";
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const ROOT = path.join(__dirname, "..");
const cfg = require(path.join(ROOT, "settings")).load();
const { proceedsFromReceipt } = require(path.join(ROOT, "strategy"));
const { priceAt } = require(path.join(ROOT, "audit"));
const DIR = path.join(ROOT, "test", "fixtures", "receipts");
const WETH = String(cfg.contracts.weth).toLowerCase(), STABLE = String(cfg.usdReference.stable).toLowerCase();
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, "token-disposals.json"), "utf8")).rows.filter((r) => r.kind === "sold" && r.shape && r.usd != null);
const pl = JSON.parse(fs.readFileSync(path.join(ROOT, "price-log.json"), "utf8")).hours;
const hours = {};
for (const [h, row] of Object.entries(pl)) { const r = {}; for (const [a, p] of Object.entries(row)) r[a.toLowerCase()] = p; if (r.eth != null) { r[ethers.ZeroAddress] = r.eth; r[WETH] = r.eth; } r[STABLE] = 1; hours[h] = r; }
const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, cfg.chainId, { staticNetwork: true });
(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const seen = new Set();
  let n = 0;
  for (const r of rows.sort((a, b) => a.t - b.t)) {
    if (seen.has(r.shape)) continue;
    const f = path.join(DIR, `${r.tx}.json`);
    if (fs.existsSync(f)) { seen.add(r.shape); continue; }
    const rc = await provider.getTransactionReceipt(r.tx);
    if (!rc) continue;
    const dec = 18; // every fee token handed back so far is 18-decimal; the row's raw amount is derived from the double
    const tokenRaw = ethers.parseUnits(Number(r.amount).toFixed(12), dec);
    const ethPx = priceAt(hours, ethers.ZeroAddress, r.t), ref = priceAt(hours, r.tokenAddress, r.t);
    const refUsd = ref != null ? r.amount * ref : null;
    const sp = proceedsFromReceipt({ logs: rc.logs, wallet: r.from, tokenRaw, ethPx, weth: WETH, stable: STABLE, refUsd, tokenAddr: r.tokenAddress });
    if (!sp.sold || sp.shape !== r.shape || Math.abs((sp.usd || 0) - (r.usd || 0)) > 0.01) { console.log(`skip ${r.tx.slice(0, 10)} ${r.token}: valuer gives ${sp.usd} ${sp.priced} (${sp.shape}) vs row ${r.usd} (${r.shape})`); continue; }
    fs.writeFileSync(f, JSON.stringify({ tx: r.tx, wallet: r.from, token: r.token, tokenAddr: r.tokenAddress, tokenRaw: tokenRaw.toString(), t: r.t, ethPx, refUsd, shape: sp.shape, valuation: { usd: sp.usd, priced: sp.priced, units: sp.units }, accepted: true, acceptedAt: new Date().toISOString(), expected: { usd: sp.usd, priced: sp.priced, units: sp.units },
      logs: rc.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })) }, null, 1));
    seen.add(r.shape); n++;
    console.log(`saved ${r.tx.slice(0, 10)} ${r.token} ${sp.shape} $${sp.usd} ${sp.priced}`);
  }
  console.log(`${n} fixture(s) written for ${seen.size} shape(s)`);
})();
