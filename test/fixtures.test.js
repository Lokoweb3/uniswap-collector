// node test/fixtures.test.js — every accepted receipt fixture (test/fixtures/receipts) still values the same.
// The disposal scanner saves a receipt when it meets a route shape the ledger audit has not accepted;
// accepting the shape stamps the valuation as expected. A change to the valuer that moves one of
// these numbers fails here before it reaches the lots table.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { proceedsFromReceipt } = require("../strategy");

const DIR = path.join(__dirname, "fixtures", "receipts");
const cfg = (() => { try { return require("../settings").load(); } catch { return null; } })();
const WETH = (cfg && cfg.contracts && cfg.contracts.weth) || "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const STABLE = (cfg && cfg.usdReference && cfg.usdReference.stable) || "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".json")) : [];
let checked = 0, pending = 0;
for (const f of files) {
  const fx = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8"));
  if (!fx.accepted || !fx.expected) { pending++; continue; }
  const r = proceedsFromReceipt({ logs: fx.logs, wallet: fx.wallet, tokenRaw: BigInt(fx.tokenRaw), ethPx: fx.ethPx, weth: WETH, stable: STABLE, refUsd: fx.refUsd, tokenAddr: fx.tokenAddr });
  assert.strictEqual(r.sold, true, `${f}: no longer read as a sale`);
  assert.strictEqual(r.priced, fx.expected.priced, `${f}: priced ${r.priced} != ${fx.expected.priced}`);
  assert.strictEqual(r.shape, fx.shape, `${f}: shape ${r.shape} != ${fx.shape}`);
  if (fx.expected.usd == null) assert.strictEqual(r.usd, null, `${f}: expected no value`);
  else assert.ok(Math.abs(r.usd - fx.expected.usd) < 0.01, `${f}: usd ${r.usd} != ${fx.expected.usd}`);
  checked++;
}
console.log(`fixtures: ${checked} accepted receipt(s) value as expected${pending ? `, ${pending} awaiting acceptance` : ""}`);
