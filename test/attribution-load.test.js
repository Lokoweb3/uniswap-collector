// node test/attribution-load.test.js
// Drives create().load() with on-disk ledgers to check the price-move leg end to end,
// especially the disk-fallback path (live portfolio view null) + normAddr keying.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const now = Date.now();
const OWNER = "0x00000000000000000000000000000000000000a1";
const WETH = "0x00000000000000000000000000000000000000ee";

function make(dir) {
  const d0 = now - 3 * DAY, d1 = now - 2 * DAY, d2 = now - 1 * DAY;
  // price-log.json: 'eth' priced on both day boundaries (d0 and d1).
  fs.writeFileSync(path.join(dir, "price-log.json"), JSON.stringify({
    hours: {
      [String(Math.floor(d0 / HOUR) * HOUR)]: { eth: 2000 },
      [String(Math.floor(d1 / HOUR) * HOUR)]: { eth: 2100 },
    },
  }));
  // portfolio.json: the newest series point carries per-token amounts `a`, with the
  // holding keyed by the WETH ADDRESS (as the live portfolio lists it); only the
  // normAddr normalisation in load() turns it into the 'eth' key that matches price rows.
  fs.writeFileSync(path.join(dir, "portfolio.json"), JSON.stringify({
    series: [
      { t: d0, total: 1500, p: { eth: 2000 }, a: { [WETH]: 1 } },
      { t: d1, total: 1600, p: { eth: 2100 }, a: { [WETH]: 1 } },
      { t: d2, total: 1750, p: { eth: 2100 }, a: { [WETH]: 1 } },
    ],
  }));
  fs.writeFileSync(path.join(dir, "portfolio-all.json"), JSON.stringify({ points: [] }));
  for (const f of ["fee-daily.json", "watch-accrual.json"])
    fs.writeFileSync(path.join(dir, f), JSON.stringify({ hours: {} }));
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({}));
  fs.writeFileSync(path.join(dir, "fee-split-ledger.json"), JSON.stringify([]));
  fs.writeFileSync(path.join(dir, "token-disposals.json"), JSON.stringify({ rows: [] }));
  return { d1 };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-attrload-"));
const { d1 } = make(dir);
const cfg = { ownerAddress: OWNER, contracts: { weth: WETH }, usdReference: { stable: "0xdd" } };

(async () => {
  // ---- Case: live portfolio view NULL, WETH holding on disk. ----
  // price over d0->d1 is 2100-2000 = +100; holding 1 WETH => price move should be +100.
  const attr = require("../attribution").create({
    cfg,
    getPortfolio: () => null,           // live view absent
    getWatch: () => ({ wallets: [] }),
    getPositions: () => ({ positions: [] }),
    getStaking: () => null,
    dir,
  });
  const r = attr.load({ days: 4, now });
  // The row for d1's day. Day keys follow the process's local calendar (attribution.js dayKey),
  // so the lookup uses the same local-date formatting rather than UTC midnight.
  const row = r.wallets[0].rows.find((x) => x.day === localDay(d1));
  assert.equal(row.price, 100, `price is the REAL move (+100) via disk fallback + normAddr, got ${row.price}`);
  console.log("live-null + WETH-on-disk: price =", row.price, "(expected 100)");

  // ---- Case: genuinely unpriced (no hold priced on both boundaries) -> null, not 0. ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "lp-attrload2-"));
  make(dir2);
  const pj = JSON.parse(fs.readFileSync(path.join(dir2, "portfolio.json"), "utf8"));
  pj.series[pj.series.length - 1].a = { "0x00000000000000000000000000000000000000bb": 5 };
  fs.writeFileSync(path.join(dir2, "portfolio.json"), JSON.stringify(pj));
  const attr2 = require("../attribution").create({
    cfg, getPortfolio: () => null, getWatch: () => ({ wallets: [] }),
    getPositions: () => ({ positions: [] }), getStaking: () => null, dir: dir2,
  });
  const row2 = attr2.load({ days: 4, now }).wallets[0].rows.find((x) => x.day === localDay(d1));
  assert.equal(row2.price, null, "no held token priced on both boundaries -> null, never a fabricated 0");
  console.log("genuinely-unpriced: price =", row2.price, "(expected null)");

  console.log("attribution-load: live-null disk fallback + normAddr keying + null-not-zero guard passed");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exitCode = 1; });
