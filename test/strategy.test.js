// node test/strategy.test.js — token lots: hand-backs parsed from collector.log, priced from the hourly log.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-strategy-"));
const owner = "0x0000000000000000000000000000000000000001", trading = "0x0000000000000000000000000000000000000012";
fs.writeFileSync(path.join(dir, "collector.log"), [
  `[2026-09-09T20:16:50.000Z] --- Trading (${trading}) ---`,
  `[2026-09-09T20:17:13.187Z]   ! could not quote Bucket on a v3 pool; sending 30566.599875 Bucket to ${trading} as-is`,
  `[2026-09-09T20:17:18.718Z]   sent Bucket -> ${trading} -> 0x${"ab".repeat(32)}`,
  `[2026-09-09T20:17:40.000Z] === Trading: done ===`,
  `[2026-09-09T21:00:00.000Z]   ! could not quote CRUMBS on a v3 pool; sending 100 CRUMBS to ${owner} as-is`,
  `[2026-09-09T21:00:05.000Z]   ! CRUMBS transfer to owner failed: nope — still in the operator wallet`, // no "sent" line: not a lot
  `[2026-09-10T20:16:50.000Z] --- Trading (${trading}) ---`,
  `[2026-09-10T20:17:13.187Z]   ! could not quote LAPTOP on a v3 pool; sending 100 LAPTOP to ${trading} as-is`,
  `[2026-09-10T20:17:18.718Z]   sent LAPTOP -> ${trading} -> 0x${"cd".repeat(32)}`,
  `[2026-09-11T20:16:50.000Z] --- Trading (${trading}) ---`,
  `[2026-09-11T20:17:13.187Z]   ! could not quote LAPTOP on a v3 pool; sending 100 LAPTOP to ${trading} as-is`,
  `[2026-09-11T20:17:18.718Z]   sent LAPTOP -> ${trading} -> 0x${"ef".repeat(32)}`,
  "",
].join("\n"));
const hour = String(Date.parse("2026-09-09T20:00:00Z"));
const LAPTOP = "0x00000000000000000000000000000000000000c1";
fs.writeFileSync(path.join(dir, "price-log.json"), JSON.stringify({ hours: {
  [hour]: { eth: 2400, "0x00000000000000000000000000000000000000b1": 0.0044 },
  [String(Date.parse("2026-09-10T20:00:00Z"))]: { eth: 2400, [LAPTOP]: 1.0 },
  [String(Date.parse("2026-09-11T20:00:00Z"))]: { eth: 2400, [LAPTOP]: 2.0 },
} }));
// A sale at collect time is NOT a disposal of lots (those tokens never became lots): it must not consume anything.
fs.writeFileSync(path.join(dir, "token-sales.json"), JSON.stringify([{ t: Date.parse("2026-09-12T20:00:00Z"), token: "LAPTOP", tokenAddress: LAPTOP, amount: 999, usd: 999, tx: "0x" + "99".repeat(32), skipped: false }]));
// A disposal of held lots: 150 LAPTOP sent out at $3 each. FIFO: all of lot 1 (100 @ $1) and half of lot 2 (50 @ $2).
fs.writeFileSync(path.join(dir, "token-disposals.json"), JSON.stringify({ lastBlock: {}, rows: [
  { t: Date.parse("2026-09-01T21:00:00Z"), token: "LAPTOP", tokenAddress: LAPTOP, amount: 5000, usd: 5000, tx: "0x" + "22".repeat(32), logIndex: "0x1", from: trading, to: "0x00000000000000000000000000000000000000d2", kind: "sold" }, // before any lot: other holdings, consumes nothing
  { t: Date.parse("2026-09-12T21:00:00Z"), token: "LAPTOP", tokenAddress: LAPTOP, amount: 150, usd: 450, tx: "0x" + "11".repeat(32), logIndex: "0x1", from: trading, to: "0x00000000000000000000000000000000000000d1", kind: "sent" },
  { t: Date.parse("2026-09-05T21:00:00Z"), token: "LAPTOP", tokenAddress: LAPTOP, amount: 25, usd: 30, tx: "0x" + "33".repeat(32), logIndex: "0x1", from: "0x00000000000000000000000000000000000000e1", to: trading, kind: "received" }, // inbound flow, NOT a disposal of lots
] }));
fs.writeFileSync(path.join(dir, "v4-collects.json"), JSON.stringify([{ tx: "0x1", tokenId: "v4-1", block: 1, t: 1, fee0: "0", fee1: "0", t0: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 }, t1: { address: "0x00000000000000000000000000000000000000B1", symbol: "Bucket", decimals: 18 } }]));

// Stub the dashboard: every view empty.
const http = require("http");
const srv = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, rows: [], positions: [{ symbol0: "LAPTOP", token0: { address: LAPTOP, decimals: 18 }, symbol1: "ETH", token1: { address: "0x00000000000000000000000000000000000000ee", decimals: 18 } }], wallets: [] })); });
srv.listen(0, "127.0.0.1", async () => {
  const cfg = { ownerAddress: owner, contracts: { weth: "0x00000000000000000000000000000000000000ee" }, usdReference: { stable: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" } };
  const strategy = require("../strategy").create({ cfg, dir, port: srv.address().port });
  const out = await strategy.tokenLots({});
  assert.strictEqual(out.lots.length, 3, "three completed hand-backs are lots");
  const l = out.lots.find((x) => x.token === "Bucket");
  assert.strictEqual(l.wallet, "Trading"); assert.strictEqual(l.amount, 30566.599875);
  assert.strictEqual(l.usdPerToken, 0.0044); assert.strictEqual(l.usd, 134.4930); assert.strictEqual(l.basis, "hourly log");
  const bucket = out.tokens.find((t) => t.token === "Bucket");
  assert.strictEqual(bucket.basisUsd, 134.49); assert.strictEqual(bucket.avgCostUsd, 0.0044);
  assert.strictEqual(bucket.remainingAmount, 30566.599875, "no disposals: everything remains");
  assert.strictEqual(bucket.disposedAmount, 0); assert.strictEqual(bucket.realizedUsd, null);
  const filtered = await strategy.tokenLots({ token: "laptop" });
  assert.strictEqual(filtered.lots.length, 2);

  // FIFO disposal: 150 LAPTOP sent out at $3 consumes lot 1 (100 @ $1) and half of lot 2 (50 @ $2).
  const lap = out.tokens.find((t) => t.token === "LAPTOP");
  assert.strictEqual(lap.amount, 200, "received 200 LAPTOP across two lots");
  assert.strictEqual(lap.basisUsd, 300, "basis = 100*1 + 100*2");
  assert.strictEqual(lap.disposedAmount, 150);
  assert.strictEqual(lap.proceedsUsd, 450, "proceeds = 150 * 3");
  assert.strictEqual(lap.realizedUsd, 250, "realized = 450 - (100*1 + 50*2)");
  assert.strictEqual(lap.remainingAmount, 50);
  assert.strictEqual(lap.remainingBasisUsd, 100, "remaining basis = 50 * 2");
  const lot1 = out.lots.find((x) => x.token === "LAPTOP" && x.tx === "0x" + "cd".repeat(32));
  const lot2 = out.lots.find((x) => x.token === "LAPTOP" && x.tx === "0x" + "ef".repeat(32));
  assert.strictEqual(lot1.disposedAmount, 100); assert.strictEqual(lot1.remainingAmount, 0); assert.strictEqual(lot1.realizedUsd, 200); assert.strictEqual(lot1.disposalKind, "sent");
  assert.strictEqual(lot2.disposedAmount, 50); assert.strictEqual(lot2.remainingAmount, 50); assert.strictEqual(lot2.realizedUsd, 50);
  // A "received" row is an inbound flow (attribution), not a disposal: it must not consume lots.
  assert.strictEqual(lap.disposedAmount, 150, "the received row did not consume any lot");
  assert.strictEqual(out.lots.find((x) => x.token === "LAPTOP").disposalKind, "sent", "disposalKind comes from the sent row, not the received row");
  // The collect-time sale shows under soldAtCollect and consumed no lot.
  assert.strictEqual(out.soldAtCollect.find((x) => x.token === "LAPTOP").amountSold, 999);
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("strategy: token lots parsing, pricing and FIFO disposal assertions passed");
});
