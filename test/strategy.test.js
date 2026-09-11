// node test/strategy.test.js — token lots: hand-backs parsed from collector.log, priced from the hourly log.
const assert = require("assert");
const { ethers } = require("ethers");
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
  
// proceedsFromReceipt: what a router sale actually brought back, from the receipt's logs.
{
  const { proceedsFromReceipt } = require("../strategy");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const T = ethers.id("Transfer(address,address,uint256)"), S = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
  const W = "0x0bd7d308f8e1639fab988df18a8011f41eacad73", U = "0x5fc5360d0400a0fd4f2af552add042d716f1d168", X = "0x92fd660000000000000000000000000000000000";
  const wallet = "0xadf94a20558e1e6d64c429f8f9f017169bf3d743", router = "0x8876789976decbfcbbbe364623c63652db8c0904", pm = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
  const pad = (a) => ethers.zeroPadValue(a, 32);
  const xfer = (token, from, to, amount) => ({ address: token, topics: [T, pad(from), pad(to)], data: ethers.toBeHex(amount, 32) });
  const swap = (a0, a1) => ({ address: pm, topics: [S, ethers.ZeroHash, pad(router)], data: coder.encode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], [a0, a1, 1n, 1n, 0, 0]) });
  const lap = 657664157433652676245746n;
  // The real 2026-09-08 sale: LAPTOP -> X -> USDG -> WETH, unwrapped to the wallet. Proceeds = 0.252 ETH, not the 6.26 of the first hop.
  const logs = [swap(-lap, 6261995803353978955n), xfer(X, pm, "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044", 62619958033539789n), swap(626813128n, -6199375845320439166n), swap(252165889604076828n, -626813128n),
    xfer("0x76ed1e2a8fc3873fcb5c514688ca2fe8a3600b7f", wallet, pm, lap), xfer(W, pm, router, 252165889604076828n), xfer(W, router, ethers.ZeroAddress, 252165889604076828n)];
  const r = proceedsFromReceipt({ logs, wallet, tokenRaw: lap, ethPx: 2485, weth: W, stable: U, refUsd: 657664 * 0.000956 });
  assert.strictEqual(r.sold, true); assert.strictEqual(r.priced, "eth"); assert.ok(Math.abs(r.usd - 0.252165889604076828 * 2485) < 0.01, "usd " + r.usd);
  // USDG straight to the wallet.
  const r2 = proceedsFromReceipt({ logs: [swap(-264128686770618665766639n, 2486048847981251505n), swap(248846659n, -2461188359501438990n), xfer(U, pm, wallet, 248846659n)], wallet, tokenRaw: 264128686770618665766639n, ethPx: 2485, weth: W, stable: U, refUsd: 264128 * 0.000956 });
  assert.strictEqual(r2.priced, "usdg"); assert.strictEqual(r2.usd, 248.8467);
  // A native-ETH last hop pays without a log: follow the chain to its output.
  const r3 = proceedsFromReceipt({ logs: [swap(-1000n, 5000n), swap(-5000n, 2n * 10n ** 17n)], wallet, tokenRaw: 1000n, ethPx: 2000, weth: W, stable: U, refUsd: 400 });
  assert.strictEqual(r3.priced, "eth (last hop)"); assert.strictEqual(r3.usd, 400);
  // The old mistake (first hop read as ETH) is caught by the 3x sanity bound: the hourly price wins.
  const r4 = proceedsFromReceipt({ logs: [swap(-lap, 6261995803353978955n)], wallet, tokenRaw: lap, ethPx: 2485, weth: W, stable: U, refUsd: 628.7 });
  assert.match(r4.priced, /^hourly log \(proceeds unmatched/); assert.strictEqual(r4.usd, 628.7);
  // A stored amount is a double: legs match within 1e-9.
  const r5 = proceedsFromReceipt({ logs, wallet, tokenRaw: lap + 1000n, ethPx: 2485, weth: W, stable: U, refUsd: null });
  assert.strictEqual(r5.priced, "eth");
  // Two transfers of the token in one transaction (a sale in slices): each row gets its share of the proceeds.
  const C = "0xc0ffee0000000000000000000000000000000000";
  const split = [xfer(C, wallet, pm, 18616n * 10n ** 18n), xfer(C, wallet, pm, 43438n * 10n ** 18n), swap(-62054n * 10n ** 18n, 8n * 10n ** 16n), xfer(W, pm, router, 8n * 10n ** 16n), xfer(W, router, ethers.ZeroAddress, 8n * 10n ** 16n)];
  const s1 = proceedsFromReceipt({ logs: split, wallet, tokenRaw: 18616n * 10n ** 18n, ethPx: 2500, weth: W, stable: U, tokenAddr: C });
  const s2 = proceedsFromReceipt({ logs: split, wallet, tokenRaw: 43438n * 10n ** 18n, ethPx: 2500, weth: W, stable: U, tokenAddr: C });
  assert.ok(Math.abs(s1.usd + s2.usd - 200) < 0.01, "shares add up to the tx's $200"); assert.ok(Math.abs(s1.usd - 200 * 18616 / 62054) < 0.01); assert.match(s1.priced, /^eth\+30% of the tx$/);
  // The chain starts from the total when the wallet sold both slices in one hop.
  const s3 = proceedsFromReceipt({ logs: split.slice(0, 3), wallet, tokenRaw: 43438n * 10n ** 18n, ethPx: 2500, weth: W, stable: U, tokenAddr: C });
  assert.match(s3.priced, /^eth \(last hop\)\+70% of the tx$/); assert.ok(Math.abs(s3.usd - 140) < 0.01);
  // No swap at all: a liquidity deposit, not a sale.
  assert.deepStrictEqual(proceedsFromReceipt({ logs: [xfer(U, pm, wallet, 1n)], wallet, tokenRaw: 1n, ethPx: 1, weth: W, stable: U }), { sold: false });
}

console.log("strategy: token lots parsing, pricing and FIFO disposal assertions passed");
});
