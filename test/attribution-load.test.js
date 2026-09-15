// node test/attribution-load.test.js
// Drives create().load() with on-disk ledgers to check the price-move leg end to end,
// especially the disk-fallback path (live portfolio view null) + normAddr keying.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const localDay = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
// A fixed local-noon clock: with Date.now() the three day boundaries fall exactly on an
// hourly price key during the first hour after local midnight, priceRowAt() then returns the
// same row for both ends of the day and the price leg reads "incomplete" instead of +100.
const now = new Date(2026, 8, 10, 12, 0, 0).getTime();
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
  // Every day's snapshot holds only an unpriced token (per-day holdings are used since TASK-79,
  // so the earlier days must be unpriced too, not just the newest point).
  for (const pt of pj.series) pt.a = { "0x00000000000000000000000000000000000000bb": 5 };
  fs.writeFileSync(path.join(dir2, "portfolio.json"), JSON.stringify(pj));
  const attr2 = require("../attribution").create({
    cfg, getPortfolio: () => null, getWatch: () => ({ wallets: [] }),
    getPositions: () => ({ positions: [] }), getStaking: () => null, dir: dir2,
  });
  const row2 = attr2.load({ days: 4, now }).wallets[0].rows.find((x) => x.day === localDay(d1));
  assert.equal(row2.price, null, "no held token priced on both boundaries -> null, never a fabricated 0");
  console.log("genuinely-unpriced: price =", row2.price, "(expected null)");

  // ---- Case: ledger rows with ISO-string timestamps count the same as numeric ones; an unreadable one is skipped. ----
  const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "lp-attrload3-"));
  make(dir3);
  const noonOfD1 = new Date(d1).setHours(12, 0, 0, 0); // inside d1's local day whatever the time of day now
  const gasWei = String(0.001e18);
  fs.writeFileSync(path.join(dir3, "state.json"), JSON.stringify({ gasSpends: [
    { t: new Date(noonOfD1).toISOString(), wei: gasWei },        // ISO string
    { t: "not-a-date", wei: gasWei },                             // unreadable: skipped, warned once
  ] }));
  fs.writeFileSync(path.join(dir3, "token-disposals.json"), JSON.stringify({ rows: [
    { t: new Date(noonOfD1).toISOString(), kind: "received", to: OWNER, usd: 50 },
  ] }));
  const warned = [];
  const origWarn = console.warn; console.warn = (m) => warned.push(String(m));
  let row3;
  try {
    const attr3 = require("../attribution").create({
      cfg, getPortfolio: () => null, getWatch: () => ({ wallets: [] }),
      getPositions: () => ({ positions: [] }), getStaking: () => null, dir: dir3,
    });
    row3 = attr3.load({ days: 4, now }).wallets[0].rows.find((x) => x.day === localDay(d1));
  } finally { console.warn = origWarn; }
  // 0.001 ETH at the hourly price in force at noon (2000 or 2100 depending on where d1's hour falls): -$2 or -$2.1.
  assert.ok(row3.gas < 0 && (Math.abs(row3.gas + 2) < 1e-9 || Math.abs(row3.gas + 2.1) < 1e-9), `ISO gas timestamp counted, got ${row3.gas}`);
  assert.equal(row3.flows, 50, `ISO disposal timestamp counted, got ${row3.flows}`);
  assert.equal(warned.filter((m) => m.includes("unreadable timestamp")).length, 1, `one warning for the unreadable row, got ${warned.length}`);
  console.log("iso-timestamps: gas =", row3.gas, "flows =", row3.flows, "(unreadable row skipped with one warning)");

  // ---- Case: a partially priced point (a held token lost its price for one hour) is a pricing gap, not a value drop. ----
  const dir4 = fs.mkdtempSync(path.join(os.tmpdir(), "lp-attrload4-"));
  make(dir4);
  const pj4 = JSON.parse(fs.readFileSync(path.join(dir4, "portfolio.json"), "utf8"));
  // The live writer keys prices and amounts alike ("eth" or the lower-case address); the point before the gap
  // needs the amount under the same key as its price for the > 1 % test.
  pj4.series[pj4.series.length - 1].a = { eth: 1 };
  // Newest point: ETH (the whole holding) has no price, so `total` collapses to 400 with no `partial` flag on disk.
  pj4.series.push({ t: now - 1 * HOUR, total: 400, p: {}, a: { eth: 1 } });
  fs.writeFileSync(path.join(dir4, "portfolio.json"), JSON.stringify(pj4));
  const attr4 = require("../attribution").create({
    cfg, getPortfolio: () => null, getWatch: () => ({ wallets: [] }),
    getPositions: () => ({ positions: [] }), getStaking: () => null, dir: dir4,
  });
  const r4 = attr4.load({ days: 4, now });
  const b7 = r4.mainBenchmarks.find((b) => b.windowDays === 7);
  // Good points run 1500 -> 1750 (+16.7 %); with the gap counted the window would read -73 %.
  assert.ok(b7.portfolioPct > 16 && b7.portfolioPct < 17, `partial point ignored by the benchmark, got ${b7.portfolioPct}`);
  const row4 = r4.wallets[0].rows.find((x) => x.day === localDay(d1));
  assert.equal(row4.price, 100, `earlier day's price leg unaffected, got ${row4.price}`);
  console.log("partial-point: 7d =", b7.portfolioPct.toFixed(2), "% (expected ~16.67, not -73)");

  // ---- TASK-79: the price leg uses THAT day's holdings (holdingsByDay wired into compute). ----
  // 1 WETH on the earlier days, 10 WETH today: the d0->d1 price leg is 1 * (2100 - 2000) = 100,
  // never 10 * 100 = 1000 (today's holdings applied to an earlier day).
  const dir5 = fs.mkdtempSync(path.join(os.tmpdir(), "lp-attrload5-"));
  make(dir5);
  const pj5 = JSON.parse(fs.readFileSync(path.join(dir5, "portfolio.json"), "utf8"));
  pj5.series[2].a = { [WETH]: 10 }; pj5.series[2].total = 21000;
  fs.writeFileSync(path.join(dir5, "portfolio.json"), JSON.stringify(pj5));
  const attr5 = require("../attribution").create({ cfg, getPortfolio: () => null, getWatch: () => ({ wallets: [] }), getPositions: () => ({ positions: [] }), getStaking: () => null, dir: dir5 });
  const row5 = attr5.load({ days: 4, now }).wallets[0].rows.find((x) => x.day === localDay(d1));
  assert.equal(row5.price, 100, `earlier day's price leg uses that day's 1 WETH, not today's 10, got ${row5.price}`);
  fs.rmSync(dir5, { recursive: true, force: true });

  // ---- TASK-80: the long-term ledgers load from `dir` (bare filenames, not dir/dir/...). ----
  // A position-values.json with full coverage makes the basis "twa"; if the file silently
  // loaded as empty (the doubled-path bug) the basis would fall back to "open" = deposited.
  const dir6 = fs.mkdtempSync(path.join(os.tmpdir(), "lp-attrload6-"));
  make(dir6);
  const OPEN_AT = now - 3 * DAY;
  const vals = [];
  for (let t = OPEN_AT; t <= now; t += 6 * HOUR) vals.push({ t, usd: 100, fees: 0 });
  fs.writeFileSync(path.join(dir6, "position-values.json"), JSON.stringify({ [`${OWNER}:7`]: vals }));
  fs.writeFileSync(path.join(dir6, "range-log.json"), JSON.stringify({ positions: {} }));
  const attr6 = require("../attribution").create({
    cfg, getPortfolio: () => null, getWatch: () => ({ wallets: [] }), getStaking: () => null, dir: dir6,
    getPositions: () => ({ positions: [{ tokenId: "7", version: 3, pair: "WETH / USDG", pnlSince: OPEN_AT, valueUsd: 100, feesUsd: 0, pnlUsd: 0, pnlLegs: { deposited: 200, collected: 0, uncollected: 0 } }] }),
    getHistory: () => [],
  });
  const lt6 = attr6.load({ days: 4, now }).positions[0].longTerm;
  const direct6 = require("../longterm").compute({
    open: [{ p: { tokenId: "7", version: 3, pair: "WETH / USDG", pnlSince: OPEN_AT, valueUsd: 100, feesUsd: 0, pnlUsd: 0, pnlLegs: { deposited: 200, collected: 0, uncollected: 0 } }, walletAddress: OWNER }],
    collects: [], rangeLog: {}, values: JSON.parse(fs.readFileSync(path.join(dir6, "position-values.json"), "utf8")), now,
  }).get(`${OWNER}:7`);
  assert.ok(lt6, "attribution carries a longTerm block for the open position");
  assert.equal(lt6.sinceOpen.basis, "twa", `ledger loaded -> twa basis, got ${lt6.sinceOpen.basis}`);
  assert.equal(lt6.sinceOpen.basisUsd, direct6.sinceOpen.basisUsd, "attribution and longterm.compute agree on the basis");
  assert.equal(lt6.chainId, direct6.chainId, "and on the chain");
  fs.rmSync(dir6, { recursive: true, force: true });

  console.log("attribution-load: live-null disk fallback + normAddr keying + null-not-zero guard passed");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(dir2, { recursive: true, force: true });
  fs.rmSync(dir4, { recursive: true, force: true });
  fs.rmSync(dir3, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exitCode = 1; });
