// node test/verdict.test.js — keep / watch / close / hold from a guardian row and
// the collect history (verdict.js), and the per-position lines of the daily summary.
const assert = require("assert");
const { verdictFor, idleText, THRESHOLDS } = require("../verdict");
const daily = require("../daily");

const H = 3600000, D = 24 * H;
const now = new Date("2026-09-14T12:00:00Z").getTime();
const base = { status: "green", reasons: [], feesPerHour: 2.2, feesPerHour15m: 2.5, valueUsd: 1700, inRange: true, outMinutes: 0, rules: { outOfRangeMinutes: 120 }, collected: { usd: 40, usd7d: 20, last: now - 2 * D } };

// Green, in range, fees coming in -> keep, earning now.
let v = verdictFor(base, { now });
assert.strictEqual(v.verdict, "keep"); assert.deepStrictEqual(v.why, []); assert.strictEqual(v.idleHours, 0); assert.strictEqual(idleText(v), "earning now");
assert.strictEqual(v.feesPerHour, 2.2, "live rate wins over the realised 7-day rate when higher");

// Yellow carries the guardian's reasons.
v = verdictFor({ ...base, status: "yellow", reasons: ["liquidity thinning"] }, { now });
assert.strictEqual(v.verdict, "watch"); assert.deepStrictEqual(v.why, ["liquidity thinning"]);

// Red = a close trigger holds.
v = verdictFor({ ...base, status: "red", reasons: ["LPs leaving"] }, { now });
assert.strictEqual(v.verdict, "close"); assert.deepStrictEqual(v.why, ["LPs leaving"]);

// Out of range: watch at first, close once the rule's minutes have passed.
v = verdictFor({ ...base, inRange: false, outMinutes: 30 }, { now });
assert.strictEqual(v.verdict, "watch"); assert.ok(v.why.includes("out of range"));
v = verdictFor({ ...base, inRange: false, outMinutes: 200 }, { now });
assert.strictEqual(v.verdict, "close"); assert.deepStrictEqual(v.why, ["out of range 200 min"]);

// Idle: no live fees, last collect 3 days ago -> watch; 9 days -> close.
const idle = { ...base, feesPerHour: 0, feesPerHour15m: 0, collected: { usd: 40, usd7d: 0, last: now - 3 * D } };
v = verdictFor(idle, { now });
assert.strictEqual(v.verdict, "watch"); assert.deepStrictEqual(v.why, ["no fees for 3d"]); assert.strictEqual(idleText(v), "earned 3.0d ago");
v = verdictFor({ ...idle, collected: { usd: 40, usd7d: 0, last: now - 9 * D } }, { now });
assert.strictEqual(v.verdict, "close"); assert.deepStrictEqual(v.why, ["no fees for 9d"]);
// Nothing ever collected and nothing coming in -> watch, never earned.
v = verdictFor({ ...idle, collected: null }, { now });
assert.strictEqual(v.verdict, "watch"); assert.deepStrictEqual(v.why, ["never seen earning"]); assert.strictEqual(idleText(v), "never earned");

// Hourly accrual (fee-daily.json) counts as earning, newer than the last collect.
v = verdictFor(idle, { now, feeHours: { [String(now - 5 * H)]: 5, [String(now - 30 * H)]: 0, [String(now - 10 * D)]: 99 } });
assert.strictEqual(v.verdict, "keep"); assert.strictEqual(Math.round(v.idleHours), 4); assert.strictEqual(idleText(v), "earned 4h ago");
assert.strictEqual(+v.feesPerHour.toFixed(4), +(5 / 168).toFixed(4), "accrual this week sets the realised rate; older hours do not count");
// Accrual that has since been collected is the same money: the larger of the two, not the sum.
v = verdictFor({ ...idle, collected: { usd: 40, usd7d: 8, last: now - 3 * D } }, { now, feeHours: { [String(now - 5 * H)]: 5 } });
assert.strictEqual(+v.feesPerHour.toFixed(4), +(8 / 168).toFixed(4));

// Bursty earner: live rate 0 but $120 collected this week, last 3 h ago -> keep at the realised rate.
v = verdictFor({ ...base, feesPerHour: 0, feesPerHour15m: null, valueUsd: 3800, collected: { usd: 500, usd7d: 120, last: now - 3 * H } }, { now });
assert.strictEqual(v.verdict, "keep"); assert.strictEqual(+v.feesPerHour.toFixed(4), +(120 / 168).toFixed(4)); assert.strictEqual(idleText(v), "earned 3h ago");
// Minted 2 days ago: the realised window is the position's age.
v = verdictFor({ ...base, feesPerHour: 0, feesPerHour15m: null, entryAt: now - 2 * D, collected: { usd: 24, usd7d: 24, last: now - H } }, { now });
assert.strictEqual(+v.feesPerHour.toFixed(4), 0.5);

// Low yield: $0.02/h on $5,000 is 3.5% APR -> watch.
v = verdictFor({ ...base, feesPerHour: 0.02, feesPerHour15m: 0.02, valueUsd: 5000, collected: { usd: 1, usd7d: 1, last: now - H } }, { now });
assert.strictEqual(v.verdict, "watch"); assert.deepStrictEqual(v.why, ["3.5% APR"]);

// Hold by choice beats everything, alerts untouched (status stays red on the row).
v = verdictFor({ ...base, status: "red", reasons: ["LPs leaving"], rules: { outOfRangeMinutes: 120, hold: true } }, { now });
assert.strictEqual(v.verdict, "hold"); assert.deepStrictEqual(v.why, ["held by choice"]);

// Daily summary: one line per open position, worst first, unwatched positions marked.
const all = [
  { nftId: "1", tokenId: "1", pair: "ETH / USDG", wallet: "Main", dailyUsd: 48 },
  { nftId: "2", tokenId: "v4-2", pair: "ETH / MEME", wallet: "Main", dailyUsd: 6 },
  { nftId: "3", tokenId: "3", pair: "WETH / Index", wallet: "LP Rewards", dailyUsd: null },
  { nftId: "9", tokenId: "9", pair: "OLD / POOL", wallet: "Main", dailyUsd: 2.4 },
];
const memecoins = { positions: [
  { tokenId: "1", ...base },
  { tokenId: "2", ...base, status: "red", reasons: ["LPs leaving"], rules: { outOfRangeMinutes: 120, hold: true }, feesPerHour: 0.28 },
  { tokenId: "3", ...base, feesPerHour: 0, feesPerHour15m: 0, valueUsd: 3800, collected: { usd: 500, usd7d: 0, last: now - 3 * D } },
  { tokenId: "7", ...base, closed: true },
] };
const lines = daily.verdictLines(all, memecoins, now);
console.log(lines.join("\n"));
assert.strictEqual(lines.length, 4);
assert.match(lines[0], /^   WATCH WETH \/ Index #3 \(LP Rewards\) · \$0\.00\/h · earned 3\.0d ago — no fees for 3d$/);
assert.match(lines[1], /^   HOLD  ETH \/ MEME #2 \(Main\) · \$0\.28\/h · earning now — held by choice$/);
assert.match(lines[2], /^   KEEP  ETH \/ USDG #1 \(Main\) · \$2\.20\/h · earning now$/);
assert.match(lines[3], /^   —     OLD \/ POOL #9 \(Main\) · \$0\.10\/h · not watched$/);
// A server that already computed the verdict is trusted as is.
const pre = daily.verdictLines([all[0]], { positions: [{ tokenId: "1", ...base, verdict: { verdict: "close", why: ["x"], feesPerHour: 1, idleHours: 50 } }] }, now);
assert.match(pre[0], /^   CLOSE ETH \/ USDG #1 \(Main\) · \$1\.00\/h · earned 2\.1d ago — x$/);
// The lines sit in the daily summary right after the open-positions count.
const text = daily.build({ now, positions: { ownerLabel: "Main", positions: [{ nftId: "1", tokenId: "1", pair: "ETH / USDG", inRange: true, feesUsd: 1, dailyUsd: 48 }] }, memecoins, history: { rows: [] } });
const at = text.split("\n");
const i = at.findIndex((l) => l.startsWith("📊 1 open position"));
assert.ok(i > 0); assert.match(at[i + 1], /^   KEEP  ETH \/ USDG #1/);
assert.ok(THRESHOLDS.idleCloseHours > THRESHOLDS.idleWatchHours);
console.log("verdict: keep/watch/close/hold rules, idle text, realised rate and daily lines — all assertions passed");
