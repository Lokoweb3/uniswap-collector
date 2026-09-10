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
  "",
].join("\n"));
const hour = String(Date.parse("2026-09-09T20:00:00Z"));
fs.writeFileSync(path.join(dir, "price-log.json"), JSON.stringify({ hours: { [hour]: { eth: 2400, "0x00000000000000000000000000000000000000b1": 0.0044 } } }));
fs.writeFileSync(path.join(dir, "v4-collects.json"), JSON.stringify([{ tx: "0x1", tokenId: "v4-1", block: 1, t: 1, fee0: "0", fee1: "0", t0: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 }, t1: { address: "0x00000000000000000000000000000000000000B1", symbol: "Bucket", decimals: 18 } }]));

// Stub the dashboard: every view empty.
const http = require("http");
const srv = http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, rows: [], positions: [], wallets: [] })); });
srv.listen(0, "127.0.0.1", async () => {
  const cfg = { ownerAddress: owner, contracts: { weth: "0x00000000000000000000000000000000000000ee" }, usdReference: { stable: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" } };
  const strategy = require("../strategy").create({ cfg, dir, port: srv.address().port });
  const out = await strategy.tokenLots({});
  assert.strictEqual(out.lots.length, 1, "only the completed hand-back is a lot");
  const l = out.lots[0];
  assert.strictEqual(l.token, "Bucket"); assert.strictEqual(l.wallet, "Trading"); assert.strictEqual(l.amount, 30566.599875);
  assert.strictEqual(l.usdPerToken, 0.0044); assert.strictEqual(l.usd, 134.4930); assert.strictEqual(l.basis, "hourly log");
  assert.strictEqual(out.tokens.length, 1); assert.strictEqual(out.tokens[0].basisUsd, 134.49); assert.strictEqual(out.tokens[0].avgCostUsd, 0.0044);
  const filtered = await strategy.tokenLots({ token: "laptop" });
  assert.strictEqual(filtered.lots.length, 0);
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("strategy: token lots parsing and pricing assertions passed");
});
