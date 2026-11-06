// node test/portfolio-realisable.test.js -- a loose token priced through a v2 pool is worth no more than x*y=k
// through that pool, even when its face value is below the pool's depth. No network (an in-memory chain).
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pf-real-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const { world, units } = require("./fixtures/mock-pulse");
const cfg = require("../settings").load({ file: path.join(__dirname, "..", "settings.pulsechain.example.json") });
const c = cfg.contracts;
const w = world();
const WPLS = c.weth, DAI = cfg.usdReference.stable;
const POOL = ethers.getAddress("0x00000000000000000000000000000000000b0002");
w.token(WPLS, "WPLS", 18); w.token(DAI, "DAI", 18, { [POOL]: units(20_000, 18) });   // the pool's DAI is its depth
const V1 = c.v2lp[0].factory;
w.factory(V1);
const MEME = ethers.getAddress("0x00000000000000000000000000000000000a0001");
w.token(MEME, "MEME", 18, { [cfg.ownerAddress]: units(3000, 18) });
// 10,000 MEME against 20,000 DAI: price 2, depth $20,000
w.pair(POOL, V1, MEME, DAI, units(10_000, 18), units(20_000, 18), units(1, 18));

(async () => {
  const pf = require("../portfolio").create({ provider: w.runner, cfg: { ...cfg, contracts: { ...c, v2Factory: V1 } } });
  const h = await pf.holdingsOf(cfg.ownerAddress, { wethUsd: 0.00005, extraTokens: [MEME], prices: {} });
  const row = h.rows.find((r) => r.symbol === "MEME");
  assert.ok(row, "the loose token is listed");
  assert.strictEqual(row.price, 2);
  assert.strictEqual(row.depthUsd, 20_000);
  const want = row.depthUsd * row.amount / (10_000 + row.amount);
  assert.ok(Math.abs(row.usd - want) < 1e-6, `usd ${row.usd} equals depthUsd*amount/(depthTok+amount) = ${want}`);
  assert.ok(row.usd < row.amount * row.price, "below face value");
  const sum = (hh) => hh.rows.reduce((a, r) => a + (r.usd || 0), 0);
  assert.ok(Math.abs(h.walletUsd - sum(h)) < 1e-6, "and the total is the sum of the rows");

  // Regression: a chain with no v2 LP readers (Robinhood-like) keeps face value for a non-thin row.
  const cfg2 = { ...cfg, contracts: { ...c, v2Factory: V1 } };
  delete cfg2.contracts.v2lp;
  const pf2 = require("../portfolio").create({ provider: w.runner, cfg: cfg2 });
  const h2 = await pf2.holdingsOf(cfg.ownerAddress, { wethUsd: 0.00005, extraTokens: [MEME], prices: {} });
  const row2 = h2.rows.find((r) => r.symbol === "MEME");
  assert.ok(row2 && row2.thin === false, "not thin");
  assert.strictEqual(row2.usd, row2.amount * row2.price, "face value without v2 LP readers");
  console.log("portfolio-realisable: loose tokens are capped at x*y=k through their price pool passed");
})().catch((e) => { console.error(e); process.exit(1); });
