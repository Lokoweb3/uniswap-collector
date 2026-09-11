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
// Empty holdings -> no price leg (null, previously a fabricated 0) and thus il unknown.
assert.strictEqual(ww.price, null, "empty-holdings watched wallet prices null, not 0");
assert.strictEqual(ww.il, null);
assert.strictEqual(+ww.net.toFixed(6), 20); // dv 20, no gas for a watched wallet
assert.strictEqual(+two.book.rows[0].net.toFixed(6), +(day1.net + ww.net).toFixed(6));

// Price leg is UNKNOWN (null), never a fabricated 0, when no held token prices out
// on both day-boundary rows -- empty holdings (live portfolio view absent at load()
// time) or a key mismatch (WETH-address holding vs 'eth' price row).
const emptyHolding = compute({ ...input, holdings: { main: {} } }, { days: 3, now });
const e0 = emptyHolding.wallets[0].rows[0];
assert.strictEqual(e0.price, null, "empty holdings -> price null, not 0");
assert.strictEqual(e0.il, null, "il is null when price is unknown");
assert.strictEqual(e0.exact, false, "day is inexact when price is unknown");
const wethAddrHolding = compute({ ...input, holdings: { main: { "0x00000000000000000000000000000000000000ee": 3 } } }, { days: 3, now });
assert.strictEqual(wethAddrHolding.wallets[0].rows[0].price, null, "WETH-address holding vs 'eth' price -> null, not 0");
// But it stays EXACT (price = null) when there is genuinely no price series for the day at all.
const noPrices = compute({ ...input, priceHours: { [String(d0)]: { eth: 2000, "0xaaa": 1.0 } } }, { days: 3, now });
assert.strictEqual(noPrices.wallets[0].rows[0].price, null);

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

// Flows only count wallet-boundary transfers: sent (out, -) and received (in, +).
// A transfer out of $100 on day 1 increases il by 100 (value drops but that drop is
// not profit), keeping the sum intact.
const sentFlow = [{ t: d0 + 4 * HOUR, key: "main", usd: -100, kind: "sent" }];
const rSent = compute({ ...input, flows: sentFlow, valueSeries: { main: [{ t: d0, v: v0 }, { t: d1, v: v0 + 313 - 100 }, { t: d2, v: v0 + 313 - 100 - 135 }, { t: now - HOUR, v: v0 + 313 - 100 - 135 + 4 }] } }, { days: 3, now });
const wSent = rSent.wallets[0].rows[0];
assert.strictEqual(+wSent.flows.toFixed(6), -100);
assert.strictEqual(+wSent.dv.toFixed(6), 213); // 313 - 100 sent
assert.strictEqual(+wSent.il.toFixed(6), -10, "IL unchanged: the sent flow is separated out");
assert.strictEqual(+wSent.net.toFixed(6), 211); // 213 - 2 gas
assert.strictEqual(+(wSent.fees + wSent.price + wSent.il + wSent.staking + wSent.vault + wSent.flows + wSent.gas).toFixed(6), +wSent.net.toFixed(6));

// A transfer in of $50 on day 1 (received) increases value; il drops by 50 to keep the sum.
const recvFlow = [{ t: d0 + 4 * HOUR, key: "main", usd: 50, kind: "received" }];
const rRecv = compute({ ...input, flows: recvFlow, valueSeries: { main: [{ t: d0, v: v0 }, { t: d1, v: v0 + 313 + 50 }, { t: d2, v: v0 + 313 + 50 - 135 }, { t: now - HOUR, v: v0 + 313 + 50 - 135 + 4 }] } }, { days: 3, now });
const wRecv = rRecv.wallets[0].rows[0];
assert.strictEqual(+wRecv.flows.toFixed(6), 50);
assert.strictEqual(+wRecv.dv.toFixed(6), 363); // 313 + 50 received
assert.strictEqual(+wRecv.il.toFixed(6), -10, "IL unchanged: the received flow is separated out");
assert.strictEqual(+wRecv.net.toFixed(6), 361); // 363 - 2 gas
assert.strictEqual(+(wRecv.fees + wRecv.price + wRecv.il + wRecv.staking + wRecv.vault + wRecv.flows + wRecv.gas).toFixed(6), +wRecv.net.toFixed(6));

// A same-wallet sale (kind "sold") is internal: it must leave flows at 0.
const soldFlow = [{ t: d0 + 4 * HOUR, key: "main", usd: -300, kind: "sold" }];
const rSold = compute({ ...input, flows: soldFlow, valueSeries }, { days: 3, now });
const wSold = rSold.wallets[0].rows[0];
assert.strictEqual(+wSold.flows.toFixed(6), 0, "a sale is not a flow");
assert.strictEqual(+wSold.dv.toFixed(6), 313, "value unchanged by an internal sale");
assert.strictEqual(+wSold.il.toFixed(6), -10, "IL unchanged by an internal sale");

// An LP deposit is internal (no wallet-boundary crossing): flows stay 0, value unchanged.
const depositFlow2 = [{ t: d0 + 4 * HOUR, key: "main", usd: 500, kind: "deposit" }];
const rDep2 = compute({ ...input, flows: depositFlow2, valueSeries }, { days: 3, now });
const wDep2 = rDep2.wallets[0].rows[0];
assert.strictEqual(+wDep2.flows.toFixed(6), 0, "an LP deposit is not a flow");
assert.strictEqual(+wDep2.dv.toFixed(6), 313, "value unchanged by an internal LP deposit");
assert.strictEqual(+wDep2.il.toFixed(6), -10, "IL unchanged by an internal LP deposit");

console.log("attribution: decomposition sums to NET on 3 scenarios + transfer out/in + internal sale/deposit, benchmarks math ok");
