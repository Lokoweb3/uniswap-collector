// node test/digest.test.js — weekly digest text from mock payloads, once-per-week logic, QR self-test.
const assert = require("assert");
const { build, due, isoWeek } = require("../digest");
const QR = require("../qr");

const now = new Date("2026-09-14T09:05:00").getTime(); // a Monday, 09:05 local
const H = 3600000, D = 24 * H;
const mock = {
  now,
  positions: {
    ownerLabel: "Main", wethUsd: 2500,
    positions: [
      { tokenId: "1", nftId: "1", pair: "WETH / USDG", version: 3, inRange: true, dailyUsd: 4, aprPct: 70, valueUsd: 2100, feesUsd: 8, toUpperPct: 3.1, toLowerPct: 6.5, pnlUsd: 5, pnlLegs: { deposited: 2000, collected: 30, uncollected: 8 } },
    ],
  },
  watch: {
    wallets: [
      { label: "LP Rewards", positions: [{ tokenId: "2", nftId: "2", pair: "WETH / Index", version: 3, inRange: true, dailyUsd: 11, aprPct: 120, valueUsd: 3300, feesUsd: 1, toUpperPct: 40, toLowerPct: 40, pnlUsd: -120, pnlLegs: { deposited: 3000, collected: 25, uncollected: 1 } }], earned: { daily: [{ day: "2026-09-12", usd: 30 }, { day: "2026-09-02", usd: 50 }] } },
      { label: "Trading", positions: [{ tokenId: "v4-3", nftId: "2134854", pair: "ETH / LAPTOP", version: 4, inRange: false, dailyUsd: 0, valueUsd: 300, feesUsd: 0, priceCurrent: 900000, toUpperPct: null, toLowerPct: null }], earned: { daily: [] } },
    ],
  },
  history: { rows: [{ t: now - 2 * D, usd: 25 }, { t: now - 3 * D, usd: 10 }, { t: now - 9 * D, usd: 100 }, { t: now - 20 * D, usd: 999 }] },
  daily: { hours: [{ h: now - 1 * D, p: { 1: 4 } }, { h: now - 8 * D, p: { 1: 3 } }] },
  staking: { tokens: [{ symbol: "sNET", rewards: { d7Usd: 42.5 } }] },
  treasury: { totalSplitUsdg: 12.5, recent: [{ status: "ok", splitUsdg: 2.5, timestamp: new Date(now - D).toISOString() }, { status: "ok", splitUsdg: 10, timestamp: new Date(now - 10 * D).toISOString() }] },
  portfolioAll: { points: [{ t: now - 8 * D, total: 20000 }, { t: now - 7 * D - H, total: 21000 }, { t: now, total: 22050 }] },
  priceLog: { hours: { [String(now - 7 * D - H)]: { eth: 2400, "0xusdg": 1.0 }, [String(now - H)]: { eth: 2500, "0xusdg": 1.0 } } },
  gasSpends: [{ t: now - D, wei: "1000000000000000" }, { t: now - 30 * D, wei: "5000000000000000" }],
  memecoins: [{ tokenId: "2134854", pair: "LAPTOP/ETH", entryPrice: 1181520 }],
  usdgAddress: "0xUSDG",
};

const text = build(mock);
console.log(text + "\n");
const lines = text.split("\n");
assert.match(lines[0], /^📊 Weekly LP Report — /);
assert.strictEqual(lines[1], "");
// fees: collected this week 35 + (accrued 4 + watched 30 - 35 -> 0 floor) = 35; previous week: collected 100 + max(0, 3+50-100)=100 -> -$65
assert.match(lines[2], /^💰 Fees: \$35\.00 \(-\$65\.00 vs last week\)$/);
assert.match(lines[3], /^🏆 Best: WETH \/ Index \$11\.00\/day at 120% APR$/);
// IL for LP Rewards: -120 - 26 = -146 on 3000 deposited = 4.9%
assert.match(lines[4], /^📉 Worst: WETH \/ Index 4\.9% IL \(-\$146\.00\)$/);
assert.match(lines[5], /^🔐 LOKOVault: \$12\.50 \(\+\$2\.50 this week\)$/);
assert.match(lines[6], /^📈 sNET: \$42\.50 rewards$/);
assert.match(lines[7], /^🎰 Memecoin plays: ETH \/ LAPTOP \$300\.00 -23\.8% vs entry \(out of range\)$/);
assert.match(lines[8], /^⛽ Gas: \$2\.50$/); // 0.001 ETH * 2500
assert.strictEqual(lines[9], "");
assert.match(lines[10], /^Portfolio: \$22,050\.00 \(\+5\.0% vs last week\)$/);
assert.match(lines[11], /^ETH benchmark: \+4\.2% \| USDG benchmark: \+0\.0%$/);
assert.strictEqual(lines[12], "");
assert.match(lines[13], /^⚠️ Watch: WETH \/ USDG \(Main\) near the edge, ETH \/ LAPTOP \(Trading\) out of range$/);

// Empty data must still produce a well-formed report.
const empty = build({ now });
assert.strictEqual(empty.split("\n").length, 14);
assert.match(empty, /💰 Fees: \$0\.00/);
assert.match(empty, /Portfolio: \$— \(n\/a vs last week\)/);

// Once-per-week scheduling.
assert.strictEqual(isoWeek(new Date("2026-09-14T12:00:00")), "2026-W38");
assert.strictEqual(due(new Date("2026-09-14T08:59:00"), {}), false, "before Monday 09:00");
assert.strictEqual(due(new Date("2026-09-14T09:00:00"), {}), true, "Monday 09:00");
assert.strictEqual(due(new Date("2026-09-16T15:00:00"), {}), true, "later in the week, never sent");
assert.strictEqual(due(new Date("2026-09-16T15:00:00"), { lastSentWeek: "2026-W38" }), false, "already sent this week");
assert.strictEqual(due(new Date("2026-09-13T15:00:00"), { lastSentWeek: "2026-W37" }), false, "Sunday waits for Monday");
assert.strictEqual(due(new Date("2026-09-21T09:10:00"), { lastSentWeek: "2026-W38" }), true, "next Monday");

// QR self-test: square matrix, every module set, finder patterns, both format copies identical and equal to level L / mask 0.
for (const t of ["https://<your-node>.<your-tailnet>.ts.net:8443/vault", "https://<your-node>.<your-tailnet>.ts.net:8444/vault"]) {
  const m = QR.qrMatrix(t);
  const n = m.length;
  assert.strictEqual((n - 17) % 4, 0);
  assert.ok(m.every((r) => r.length === n && r.every((x) => x === 0 || x === 1)));
  assert.ok(m[0][0] === 1 && m[3][3] === 1 && m[1][1] === 0 && m[0][n - 1] === 1 && m[n - 1][0] === 1);
  const posA = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const copy1 = posA.map(([r, c]) => m[r][c]).join("");
  let copy2 = "";
  for (let i = 0; i < 7; i++) copy2 += m[n - 1 - i][8];
  for (let i = 7; i < 15; i++) copy2 += m[8][n - 15 + i];
  assert.strictEqual(copy1, "111011111000100");
  assert.strictEqual(copy2, copy1);
  assert.ok(QR.qrSvg(t, 150).startsWith("<svg"));
}
// Known-answer test of the Reed-Solomon coder (HELLO WORLD, 1-M, from the QR spec tutorial) via the exported encoder.
assert.deepStrictEqual(QR.encode("hello").codewords.slice(0, 7), [64, 86, 134, 86, 198, 198, 240]);

console.log("digest: format, scheduling and QR assertions passed");
