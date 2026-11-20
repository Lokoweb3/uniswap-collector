// earn-log.js: per-day earnings, start value and last claim per position, from position rows.
const assert = require("assert");
const { create, sizeOf } = require("../earn-log");

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} ${a} vs ${b}`);
const H = 3600000, T0 = Date.UTC(2026, 10, 19, 12);
let clock = T0;
const log = create({ now: () => clock, dayKey: (t) => new Date(t).toISOString().slice(0, 10) });

// A Uniswap row (fees in both tokens) and a staked row (gauge rewards).
const uni = (o = {}) => ({ tokenId: "v4-1", nftId: "1", version: 4, pair: "USDG / ANT", feeTierLabel: "0.3%", inRange: true, feesOk: true,
  fee0: 1, fee1: 0.01, usd0: 1, usd1: 100, valueUsd: 200, amount0: 100, amount1: 1, priceCurrent: 0.01, priceLower: 0.005, priceUpper: 0.02, ...o });
const up = (o = {}) => ({ tokenId: "up-9", nftId: "9", version: "up", protocol: "up", staked: true, pair: "WETH / AI", feeTierLabel: "tick 10", inRange: true, feesOk: true,
  fee0: 0, fee1: 0, usd0: 2000, usd1: 1, valueUsd: 1000, rewards: { symbol: "UP", amount: 50, priceUsd: 0.1, usd: 5 }, ...o });
const sample = (rows, at = clock) => log.record({ source: "watch", at, wallets: [{ address: "0xABC", label: "Trading", rows }] });

// first sight: a baseline. What was already waiting is not earned.
let r = sample([uni(), up()]);
assert.strictEqual(r.opened.length, 2);
let v = log.view();
assert.strictEqual(v.totals.earnedUsd, 0);
near(v.totals.startUsd, 1200); near(v.totals.netUsd, 0);

// the same data again is ignored
assert.ok(sample([uni({ fee0: 99 }), up()]).skipped);

// an hour later: fees and rewards grew, the price moved the value
clock += H;
r = sample([uni({ fee0: 1.5, fee1: 0.02, valueUsd: 190 }), up({ rewards: { symbol: "UP", amount: 70, priceUsd: 0.1 } })]);
near(r.earnedUsd, 0.5 + 1 + 2);
v = log.view();
const a = v.positions.find((p) => p.tokenId === "v4-1");
near(a.earnedUsd, 1.5); near(a.changeUsd, -10); near(a.netUsd, -8.5); near(a.netPct, -4.25);
assert.strictEqual(a.lastClaimT, null);
near(v.totals.todayUsd, 3.5); near(v.days[v.days.length - 1].usd, 3.5);
assert.strictEqual(v.days.length, 1, "the chart starts on the first tracked day");

// the rewards are claimed: the waiting amount drops, what is there now accrued since
clock += H;
r = sample([uni({ fee0: 1.5, fee1: 0.02 }), up({ rewards: { symbol: "UP", amount: 4, priceUsd: 0.1 } })]);
assert.strictEqual(r.claims.length, 1);
let b = log.view().positions.find((p) => p.tokenId === "up-9");
assert.strictEqual(b.lastClaimT, clock); near(b.lastClaimUsd, 6.6); near(b.earnedUsd, 2 + 0.4);
assert.strictEqual(b.claims, 1);

// a failed fee read (feesOk false) is neither a claim nor earnings, and the baseline holds
clock += H;
sample([uni({ feesOk: false, fee0: 0, fee1: 0 }), up({ rewards: { symbol: "UP", amount: 4, priceUsd: 0.1 } })]);
clock += H;
r = sample([uni({ fee0: 1.6, fee1: 0.02 }), up({ rewards: { symbol: "UP", amount: 4, priceUsd: 0.1 } })]);
near(r.earnedUsd, 0.1); assert.strictEqual(r.claims.length, 0);

// the chain's own claim time is used when it is later than anything seen here
clock += H;
sample([uni({ fee0: 1.6, fee1: 0.02, claimed: { status: "ok", last: clock - 1000 } }), up({ rewards: { symbol: "UP", amount: 4, priceUsd: 0.1 } })]);
assert.strictEqual(log.view().positions.find((p) => p.tokenId === "v4-1").lastClaimT, clock - 1000);

// liquidity doubled: the start value moves by the capital added, so it is not profit
clock += H;
const before = log.view().positions.find((p) => p.tokenId === "v4-1");
sample([uni({ fee0: 1.6, fee1: 0.02, amount0: 200, amount1: 2, valueUsd: 400 }), up({ rewards: { symbol: "UP", amount: 4, priceUsd: 0.1 } })]);
let c = log.view().positions.find((p) => p.tokenId === "v4-1");
near(c.startUsd, before.startUsd + 200); assert.strictEqual(c.capitalMoves, 1);
near(c.netUsd, before.earnedUsd, "net is unchanged by the deposit");
// ...and half taken out again
clock += H;
sample([uni({ fee0: 1.6, fee1: 0.02, valueUsd: 200 }), up({ rewards: { symbol: "UP", amount: 4, priceUsd: 0.1 } })]);
c = log.view().positions.find((p) => p.tokenId === "v4-1");
near(c.startUsd, 200); near(c.netUsd, before.earnedUsd);
assert.ok(sizeOf({}) === null && sizeOf(uni()) > 0);

// next day: earnings land on the new day; a position that is gone is closed, and returns
clock += 24 * H;
sample([up({ rewards: { symbol: "UP", amount: 14, priceUsd: 0.1 } })]);
v = log.view();
assert.strictEqual(v.days.length, 2); near(v.days[1].usd, 1); near(v.totals.yesterdayUsd, v.days[0].usd);
const gone = v.positions.find((p) => p.tokenId === "v4-1");
assert.ok(!gone.open && gone.closedT === clock && gone.netUsd === null);
assert.strictEqual(v.totals.open, 1, "totals count open positions only");
clock += H;
sample([uni({ fee0: 1.6, fee1: 0.02 }), up({ rewards: { symbol: "UP", amount: 14, priceUsd: 0.1 } })]);
assert.ok(log.view().positions.find((p) => p.tokenId === "v4-1").open);

// another source's wallets are independent: a main-wallet sample closes nothing in Trading
log.record({ source: "main", at: clock, wallets: [{ address: "0xDEF", label: "Main", rows: [] }] });
assert.strictEqual(log.view().totals.open, 2);

console.log("earn-log.test.js ok");
