// node test/attribution.test.js — the decomposition sums to NET and the benchmark math holds, on synthetic ledgers.
const assert = require("assert");
const { compute, benchmarks, dayKey } = require("../attribution");

const HOUR = 3600 * 1000, DAY = 24 * HOUR;
// Fixed "now": 15:00 local on some day; two full days before it.
const now = new Date(2026, 8, 7, 15, 0, 0).getTime();
const d0 = new Date(2026, 8, 5, 0, 0, 0).getTime(); // day 1 start
const d1 = d0 + DAY; // day 2 start
const d2 = d1 + DAY; // today start

// Prices: ETH 2000 -> 2100 -> 2050 -> 2075(now); token X 1.0 -> 1.2 -> 1.1 -> 1.1
const priceHours = {};
const put = (t, eth, x) => { priceHours[String(t)] = { eth, "0xaaa": x }; };
put(d0, 2000, 1.0); put(d1, 2100, 1.2); put(d2, 2050, 1.1); put(now - HOUR, 2075, 1.1);

// Main wallet holds 1 ETH + 1000 X. Value series consistent with fees/staking/vault and an IL of -10 on day 1, +0 on day 2.
// Day 1: price move = 1*(2100-2000) + 1000*(1.2-1.0) = 300; fees 20; staking 5; vault -2 (money left); il -10 => dv = 20 + 5 - 2 + 300 - 10 = 313
// Day 2: price move = 1*(2050-2100) + 1000*(1.1-1.2) = -150; fees 15; staking 0; vault 0; il 0 => dv = -135
const v0 = 5000;
const valueSeries = { main: [{ t: d0, v: v0 }, { t: d1, v: v0 + 313 }, { t: d2, v: v0 + 313 - 135 }, { t: now - HOUR, v: v0 + 313 - 135 + 4 }] };
const feesByHour = { main: { [String(d0 + 3 * HOUR)]: 12, [String(d0 + 9 * HOUR)]: 8, [String(d1 + 2 * HOUR)]: 15, [String(d2 + 2 * HOUR)]: 3 } };
const stakingDaily = { [dayKey(d0)]: 5 };
const vaultSplits = [{ t: d0 + 10 * HOUR, key: "main", usd: 2 }];
const gasSpends = [{ t: d0 + 11 * HOUR, wei: String(0.001e18) }]; // 0.001 ETH at 2000 = $2 (price at d0 row)

const input = {
  wallets: [{ key: "main", label: "Main", main: true }],
  valueSeries, feesByHour, feesByPosition: { "1": feesByHour.main },
  holdings: { main: { eth: 1, "0xaaa": 1000 } },
  priceHours, stakingDaily, vaultSplits, gasSpends,
  positions: [{ key: "main", tokenId: "1", pair: "X / ETH", version: 3, pnlUsd: 40, pnlLegs: { collected: 25, uncollected: 5 }, pnlSince: d0, valueUsd: 4000 }],
};
const r = compute(input, { days: 3, now });
const w = r.wallets[0];
assert.strictEqual(w.rows.length, 3);
const [day1, day2, today] = w.rows;
// Day 1
assert.strictEqual(+day1.fees.toFixed(6), 20);
assert.strictEqual(day1.staking, 5);
assert.strictEqual(day1.vault, -2);
assert.strictEqual(+day1.gas.toFixed(6), -2);
assert.strictEqual(+day1.price.toFixed(6), 300);
assert.strictEqual(+day1.il.toFixed(6), -10);
assert.strictEqual(+day1.dv.toFixed(6), 313);
// NET = dv + gas and equals the sum of the parts
assert.strictEqual(+day1.net.toFixed(6), 311);
assert.strictEqual(+(day1.fees + day1.price + day1.il + day1.staking + day1.vault + day1.gas).toFixed(6), +day1.net.toFixed(6));
// Day 2
assert.strictEqual(+day2.price.toFixed(6), -150);
assert.strictEqual(Math.abs(+day2.il.toFixed(6)), 0);
assert.strictEqual(+day2.net.toFixed(6), -135);
assert.ok(day2.exact);
// Today: partial day, value sample at now-1h exists so exact; price move uses the last hour row
assert.strictEqual(+today.fees.toFixed(6), 3);
assert.strictEqual(+today.price.toFixed(6), 25); // eth +25, X flat
assert.strictEqual(+today.dv.toFixed(6), 4);
assert.strictEqual(+today.il.toFixed(6), 4 - 3 - 25);
// Totals sum to net
const T = w.totals;
assert.strictEqual(+(T.fees + T.price + T.il + T.staking + T.vault + T.gas).toFixed(6), +T.net.toFixed(6));
assert.strictEqual(T.incomplete, 0);
// Book equals the single wallet
assert.strictEqual(+r.book.totals.net.toFixed(6), +T.net.toFixed(6));
// Per position: fees from legs, priceAndIl = pnl - fees, feesToday from the position's hourly buckets
assert.strictEqual(r.positions[0].fees, 30);
assert.strictEqual(r.positions[0].priceAndIl, 10);
assert.strictEqual(r.positions[0].feesToday, 3);

// A day without a value sample on one side: il null, net = exact parts + price
const gappy = compute({ ...input, valueSeries: { main: [{ t: d1, v: 100 }, { t: now - HOUR, v: 110 }] } }, { days: 3, now });
assert.strictEqual(gappy.wallets[0].rows[0].il, null);
assert.strictEqual(gappy.wallets[0].rows[0].exact, false);
assert.strictEqual(+gappy.wallets[0].rows[0].net.toFixed(6), +(20 + 5 - 2 - 2 + 300).toFixed(6));
assert.strictEqual(gappy.wallets[0].totals.incomplete, 3); // only one sample per side is missing on each of the three days

// A watched wallet gets no staking/gas, only its own splits
const two = compute({
  ...input,
  wallets: [{ key: "main", label: "Main", main: true }, { key: "0xw", label: "W", main: false }],
  valueSeries: { ...valueSeries, "0xw": [{ t: d0, v: 100 }, { t: d1, v: 120 }, { t: d2, v: 120 }, { t: now - HOUR, v: 120 }] },
  feesByHour: { ...feesByHour, "0xw": { [String(d0 + HOUR)]: 10 } },
  holdings: { ...input.holdings, "0xw": {} },
  vaultSplits: [...vaultSplits, { t: d0 + HOUR, key: "0xw", usd: 1 }],
}, { days: 3, now });
const ww = two.wallets[1].rows[0];
assert.strictEqual(ww.staking, 0); assert.strictEqual(ww.gas, 0); assert.strictEqual(ww.vault, -1); assert.strictEqual(ww.fees, 10);
assert.strictEqual(+ww.il.toFixed(6), 20 - 10 + 1); // dv 20 = fees 10 - vault 1 + il 11
assert.strictEqual(+two.book.rows[0].net.toFixed(6), +(day1.net + ww.net).toFixed(6));

// Benchmarks: portfolio +10% over a window where ETH went +5% and staking +2% on principal
const bookSeries = [{ t: now - 10 * DAY, v: 1000 }, { t: now - 5 * DAY, v: 1050 }, { t: now, v: 1100 }];
const ethSeries = [{ t: now - 10 * DAY, p: 2000 }, { t: now, p: 2100 }];
const stakingSamples = [{ t: now - 10 * DAY, bal: 3.0 }, { t: now, bal: 3.06 }];
const b = benchmarks({ bookSeries, ethSeries, stakingSamples, principal: 3.0, now, windows: [7, 30] });
assert.strictEqual(b[0].windowDays, 7);
assert.ok(Math.abs(b[0].portfolioPct - (1100 / 1050 - 1) * 100) < 1e-9, "7d window starts at the first point inside it");
assert.strictEqual(+b[1].portfolioPct.toFixed(6), 10);
assert.strictEqual(+b[1].ethPct.toFixed(6), 5);
assert.strictEqual(+b[1].stakingPct.toFixed(6), 2);
assert.strictEqual(b[1].usdgPct, 0);
assert.strictEqual(b[1].actualDays, 10);
assert.match(b[1].note, /only 10.0 days/);
const none = benchmarks({ bookSeries: [], ethSeries, stakingSamples, now });
assert.strictEqual(none[0].portfolioPct, null);

console.log("attribution: decomposition sums to NET on 3 scenarios, benchmarks math ok");
