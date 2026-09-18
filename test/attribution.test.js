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
{
  // A watched position's "fees today" comes from its own accrual, keyed wallet:tokenId — never a bare id.
  const wk = "0xabc";
  const todayHour = String(Math.floor((now - HOUR) / HOUR) * HOUR); // the last full hour of today (sumHours is [from, to))
  const rw = compute({ ...input, wallets: [...input.wallets, { key: wk, label: "Trading", main: false }], feesByHour: { ...feesByHour, [wk]: { [todayHour]: 3.5 } },
    feesByPosition: { ...input.feesByPosition, [`${wk}:v4-9`]: { [todayHour]: 3.5 }, "9": { [todayHour]: 99 } },
    positions: [...input.positions, { key: wk, tokenId: "v4-9", pair: "B / USDG", version: 4, pnlUsd: 1, pnlLegs: { collected: 1, uncollected: 0 }, pnlSince: d0, valueUsd: 100 }] }, { days: 3, now });
  const wp = rw.positions.find((x) => x.tokenId === "v4-9");
  assert.strictEqual(wp.feesToday, 3.5, `watched position fees today from its own accrual, got ${wp && wp.feesToday}`);
}
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

// Benchmarks: portfolio +10% over a window where ETH went +5% and staking earned 0.06 on a 3.0 principal (+2%).
// A 5-token stake deposit mid-window moves the balance 3.0 -> 8.06 but is not a return: only the rebase
// rewards count, so stakingPct is 2%, not 168%.
const bookSeries = [{ t: now - 10 * DAY, v: 1000 }, { t: now - 5 * DAY, v: 1050 }, { t: now, v: 1100 }];
const ethSeries = [{ t: now - 10 * DAY, p: 2000 }, { t: now, p: 2100 }];
const stakingSamples = [{ t: now - 10 * DAY, bal: 3.0 }, { t: now - 4 * DAY, bal: 8.03 }, { t: now, bal: 8.06 }];
const stakingRewards = [{ t: now - 6 * DAY, amount: 0.03 }, { t: now - 2 * DAY, amount: 0.03 }];
const b = benchmarks({ bookSeries, ethSeries, stakingSamples, stakingRewards, principal: 3.0, now, windows: [7, 30] });
assert.strictEqual(+b[0].stakingPct.toFixed(6), 1, "7d window counts only the reward inside it (0.03 / 3.0)");
const noPrincipal = benchmarks({ bookSeries, ethSeries, stakingSamples, stakingRewards, principal: null, now, windows: [30] });
assert.strictEqual(+noPrincipal[0].stakingPct.toFixed(6), 2, "no principal: base is the balance at the window start");
const noRewardsYet = benchmarks({ bookSeries, ethSeries, stakingSamples: [{ t: now - 2 * DAY, bal: 8.0 }, { t: now, bal: 8.06 }], stakingRewards: [{ t: now - DAY, amount: 0.06 }], principal: 3.0, now, windows: [30] });
assert.strictEqual(noRewardsYet[0].stakingPct, null, "staking history that starts inside the window gives no benchmark");
assert.match(noRewardsYet[0].note, /staking history starts/);
assert.strictEqual(b[0].windowDays, 7);
assert.ok(Math.abs(b[0].portfolioPct - (1100 / 1050 - 1) * 100) < 1e-9, "7d window starts at the first point inside it");
assert.strictEqual(+b[1].portfolioPct.toFixed(6), 10);
assert.strictEqual(+b[1].ethPct.toFixed(6), 5);
assert.strictEqual(+b[1].stakingPct.toFixed(6), 2);
assert.strictEqual(b[1].usdgPct, 0);
assert.strictEqual(b[1].actualDays, 10);
assert.match(b[1].note, /only 10.0 days/);
// ---- a percentage return must describe performance, not funding ----------------
{
  const eth = [{ t: now - 10 * DAY, p: 2000 }, { t: now, p: 2100 }];
  // priced transfers inside the window are netted out of the return
  const withFlows = benchmarks({ bookSeries: [{ t: now - 10 * DAY, v: 1000 }, { t: now, v: 1200 }], ethSeries: eth,
    flows: [{ t: now - 3 * DAY, key: "main", kind: "received", usd: 100 }], now, windows: [30] });
  assert.strictEqual(+withFlows[0].portfolioPct.toFixed(6), 10, "a $100 deposit is not a $200 gain");
  assert.strictEqual(withFlows[0].netFlowsUsd, 100);
  assert.match(withFlows[0].note, /netted out/);
  // a transfer with no price cannot be netted: no percentage at all
  const unpriced = benchmarks({ bookSeries: [{ t: now - 10 * DAY, v: 1000 }, { t: now, v: 1200 }], ethSeries: eth,
    flows: [{ t: now - 3 * DAY, key: "main", kind: "received", usd: null }], now, windows: [30] });
  assert.strictEqual(unpriced[0].portfolioPct, null);
  assert.match(unpriced[0].note, /no recorded price/);
  // transfers that dwarf the starting value describe funding, not performance
  const funded = benchmarks({ bookSeries: [{ t: now - 10 * DAY, v: 100 }, { t: now, v: 620 }], ethSeries: eth,
    flows: [{ t: now - 3 * DAY, key: "main", kind: "received", usd: 500 }], now, windows: [30] });
  assert.strictEqual(funded[0].portfolioPct, null);
  assert.match(funded[0].note, /dominate/);
  // the real case: a book that went from $6.42 to $2,500 with no transfer recorded
  const unexplained = benchmarks({ bookSeries: [{ t: now - 1.5 * DAY, v: 6.42 }, { t: now, v: 2500 }], ethSeries: eth, flows: [], now, windows: [7, 30, 90] });
  for (const b of unexplained) {
    assert.strictEqual(b.portfolioPct, null, "no 8,000 % return from funding");
    assert.match(b.note, /transfer history is incomplete/);
  }
}

const none = benchmarks({ bookSeries: [], ethSeries, stakingSamples, now });
assert.strictEqual(none[0].portfolioPct, null);

// An instance that records no independent ETH price history -- it prices in a unit
// fixed at $1.00 by configuration -- has no ETH or USDG benchmark to report. It is
// withheld rather than printed as +0.00 %, which would pass a configured rate off
// as a measured market result. The stablecoin column, where it is shown, is that
// configured $1.00 baseline and not a measurement either.
{
  const flat = [{ t: now - 10 * DAY, p: 1 }, { t: now, p: 1 }];   // what priceHours.eth is there
  const untracked = benchmarks({ bookSeries, ethSeries: flat, stakingSamples, stakingRewards, principal: 3.0, ethTracked: false, now, windows: [7, 30] });
  for (const bb of untracked) {
    assert.strictEqual(bb.ethPct, null, "no ETH benchmark without a measured ETH history");
    assert.strictEqual(bb.usdgPct, null, "and no USDG baseline to compare against either");
  }
  assert.strictEqual(+untracked[1].portfolioPct.toFixed(6), 10, "the portfolio's own return is unaffected");
  const tracked = benchmarks({ bookSeries, ethSeries: flat, stakingSamples, stakingRewards, principal: 3.0, now, windows: [30] });
  assert.strictEqual(tracked[0].usdgPct, 0, "where a history is tracked, the baseline is shown");
  assert.strictEqual(+tracked[0].ethPct.toFixed(6), 0, "and a genuinely flat ETH price is 0 %, not withheld");
}

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

// ---- TASK-51: long-term per-position returns (longterm.js) ---------------------------------
{
  const lt = require("../longterm");
  const W = "0xabc";
  const t0 = now - 10 * DAY;                 // position A opened
  const tClose = now - 4 * DAY;              // A closed
  const tOpenB = tClose + 3 * HOUR;          // B minted 3 h later: same wallet, same pair -> one chain
  const collects = [
    { t: t0 + 2 * DAY, usd: 20, tokenId: "v4-1", version: 4, walletAddress: W, pair: "USDG/Bucket" },
    { t: tClose - HOUR, usd: 30, tokenId: "v4-1", version: 4, walletAddress: W, pair: "USDG/Bucket" },
    { t: tOpenB + DAY, usd: 40, tokenId: "v4-2", version: 4, walletAddress: W, pair: "USDG/Bucket" },
    { t: tOpenB + 2 * DAY, usd: null, tokenId: "v4-2", version: 4, walletAddress: W, pair: "USDG/Bucket" }, // unpriced
  ];
  const rangeLog = { "1": { segments: [{ from: t0, to: tClose, inRange: true }] } };
  const B = { tokenId: "v4-2", version: 4, pair: "USDG / Bucket", pnlSince: tOpenB, valueUsd: 1100, feesUsd: 5, pnlUsd: 50, pnlApprox: false,
    pnlLegs: { deposited: 1000, depositedAtOpen: 1000, collected: 40, uncollected: 5, withdrawn: 0, held: 1100 } }; // depositedAtOpen is the basis (TASK-82)
  const r = lt.compute({ open: [{ p: B, walletAddress: W }], collects, rangeLog, now });
  const b = r.get(`${W}:v4-2`);
  assert.ok(b, "longTerm block for the open position");
  assert.strictEqual(b.chained, true, "A -> B is one chain (3 h gap)");
  assert.strictEqual(b.chainId, "v4-1", "chainId is the first tokenId");
  assert.strictEqual(b.chainSince, t0, "chainSince is the first open");
  assert.strictEqual(b.members, 2);
  // Own numbers: fees = priced collects (40) + uncollected (5) on the open basis (1000) over the actual days.
  const daysB = (now - tOpenB) / DAY;
  assert.strictEqual(b.sinceOpen.feesUsd, 45);
  assert.strictEqual(b.sinceOpen.basis, "open");
  assert.strictEqual(b.sinceOpen.basisUsd, 1000);
  assert.strictEqual(b.sinceOpen.feeAprPct, +((45 / 1000) * (365 / daysB) * 100).toFixed(1), "APR annualised over the actual elapsed days on the open basis");
  assert.strictEqual(b.sinceOpen.unpricedCollects, 1, "the unpriced collect is counted, not valued as 0");
  assert.strictEqual(b.sinceOpen.netUsd, 50, "net return since open = pnlUsd");
  assert.strictEqual(b.sinceOpen.netPct, 5);
  assert.strictEqual(b.d30.days, b.sinceOpen.days, "30 d window is min(30, age)");
  // Chain: fees accumulate (20 + 30 + 40 + 5), days run from A's open; A's deposit is unknown so the
  // chain basis and APR are null, never a fabricated number.
  assert.strictEqual(b.chain.sinceOpen.feesUsd, 95);
  assert.strictEqual(b.chain.sinceOpen.days, +((now - t0) / DAY).toFixed(2));
  assert.strictEqual(b.chain.sinceOpen.feeAprPct, null, "chain APR unknown without A's deposit");
  assert.strictEqual(b.chain.sinceOpen.netUsd, null, "chain net unknown without A's withdrawal");
  // With A's deposit known the chain basis is the open-time-weighted deposit.
  const r2 = lt.compute({ open: [{ p: B, walletAddress: W }], collects, rangeLog, closedDeposits: { "v4-1": 800 }, now });
  const b2 = r2.get(`${W}:v4-2`);
  assert.strictEqual(b2.chain.sinceOpen.basis, "open");
  const dA = tClose - t0, dB = now - tOpenB;
  assert.strictEqual(b2.chain.sinceOpen.basisUsd, +((800 * dA + 1000 * dB) / (dA + dB)).toFixed(2));
  assert.ok(b2.chain.sinceOpen.feeAprPct > 0);
  // No price leg (no pnlLegs) -> net return null, fees still measured.
  const Bnoleg = { ...B, pnlLegs: null, pnlUsd: null };
  const r3 = lt.compute({ open: [{ p: Bnoleg, walletAddress: W }], collects, rangeLog, now });
  const b3 = r3.get(`${W}:v4-2`);
  assert.strictEqual(b3.sinceOpen.netUsd, null, "unknown legs -> null net, never 0");
  assert.strictEqual(b3.sinceOpen.feeAprPct, null, "no deposit -> no basis -> null APR");
  assert.strictEqual(b3.sinceOpen.feesUsd, 45);
  // A 50 h gap breaks the chain.
  const Blate = { ...B, pnlSince: tClose + 50 * HOUR };
  const r4 = lt.compute({ open: [{ p: Blate, walletAddress: W }], collects, rangeLog, now });
  assert.strictEqual(r4.get(`${W}:v4-2`).chained, false, "a gap of 50 h is a new position, not a re-mint");
  // Time-weighted basis: a daily value ledger covering the whole life switches the basis to "twa".
  const values = { [`${W}:v4-2`]: [{ t: tOpenB, usd: 1000, fees: 0 }, { t: tOpenB + DAY, usd: 1200, fees: 1 }, { t: tOpenB + 2 * DAY, usd: 1200, fees: 2 }, { t: now - HOUR, usd: 1100, fees: 5 }] };
  const r5 = lt.compute({ open: [{ p: B, walletAddress: W }], collects, rangeLog, values, now });
  const b5 = r5.get(`${W}:v4-2`);
  assert.strictEqual(b5.sinceOpen.basis, "twa");
  assert.ok(b5.sinceOpen.basisUsd > 1000 && b5.sinceOpen.basisUsd < 1200, `twa basis between the samples, got ${b5.sinceOpen.basisUsd}`);
  // A position older than the window: the 30 d net return needs the ledger at the window start.
  const Old = { ...B, pnlSince: now - 40 * DAY };
  const oldValues = { [`${W}:v4-2`]: [{ t: now - 31 * DAY, usd: 900, fees: 3 }, { t: now - 20 * DAY, usd: 950, fees: 4 }, { t: now - HOUR, usd: 1100, fees: 5 }] };
  const r6 = lt.compute({ open: [{ p: Old, walletAddress: W }], collects: collects.filter((c) => c.tokenId === "v4-2"), values: oldValues, now });
  const b6 = r6.get(`${W}:v4-2`);
  assert.strictEqual(b6.d30.days, 30);
  assert.strictEqual(b6.d30.netUsd, +(1100 + 5 + 40 - (900 + 3)).toFixed(2), "30 d net = value + fees now + collects in window - value + fees at the window start");
  assert.strictEqual(b6.sinceOpen.netUsd, 50, "since-open net is still pnlUsd");
  console.log("longterm: chain, open/twa basis, actual-day APR, null-not-zero legs, 30 d window — all assertions passed");
}

console.log("attribution: decomposition sums to NET on 3 scenarios + transfer out/in + internal sale/deposit, benchmarks math ok");

// ---- item 3: the price leg uses that DAY's holdings, not today's (attribution.js) ----
// A holdings change mid-window (an added 1000 X on day 2) must change the price leg
// ONLY from day 2 on; day 1 keeps the day-1 (2000 X) holdings.
{
  const priceHours2 = {};
  const pput = (t, eth, x) => { priceHours2[String(t)] = { eth, "0xaaa": x }; };
  pput(d0, 2000, 1.0); pput(d1, 2100, 1.2); pput(d2, 2075, 1.1); pput(now - HOUR, 2075, 1.1);
  const valueSeries2 = { main: [
    { t: d0, v: 10000 }, { t: d1, v: 10400 }, { t: d2, v: 10380 }, { t: now - HOUR, v: 10360 },
  ] };
  const base2 = { wallets: [{ key: "main", label: "Main", main: true }], valueSeries: valueSeries2, priceHours: priceHours2, gasSpends: [], flows: [], positions: [] };

  // Holdings ledger: day1 = 2000 X; the 1000 X buy lands at d1 (day-2 start) -> day2 onwards = 3000 X.
  const holdingsByDay = { main: { [dayKey(d0)]: { eth: 1, "0xaaa": 2000 }, [dayKey(d1)]: { eth: 1, "0xaaa": 3000 } } };
  const r3 = compute({ ...base2, holdingsByDay }, { days: 3, now });
  const rows = r3.wallets[0].rows;
  // Day 1 (d0->d1): price leg = 1*(2100-2000) + 2000*(1.2-1.0) = 500.
  assert.strictEqual(+rows[0].price.toFixed(6), 500, "day-1 price leg uses day-1 holdings (2000 X)");
  // Day 2 (d1->d2): price leg = 1*(2075-2100) + 3000*(1.1-1.2) = -325 (now 3000 X).
  assert.strictEqual(+rows[1].price.toFixed(6), -325, "day-2 price leg uses the new (3000 X) holdings");
  // Today (d2->now): flat ETH/X -> 0 price leg (with real priced hold).
  assert.strictEqual(+rows[2].price.toFixed(6), 0, "today's leg over flat prices is 0 (both prices known)");

  // A day with no holdings snapshot at all prices as UNKNOWN (null, never today's / never 0).
  const r4 = compute({ ...base2, holdingsByDay: {} }, { days: 3, now });
  assert.strictEqual(r4.wallets[0].rows[0].price, null, "no snapshot -> price leg stays null, not today's holdings, not 0");
}

console.log("attribution: item-3 per-day-holdings price leg (change mid-window starts on that day; no snapshot -> null)");

// ---- item 4: unpriced gas is carried as gasWei, the day is incomplete, never dropped (attribution.js) ----
{
  // ETH price only from d1 on; a gas spend lands on day 1 at d0+1h where there is no ETH price.
  const priceHours4 = {};
  const qput = (t, eth, x) => { priceHours4[String(t)] = { eth, "0xaaa": x }; };
  qput(d1, 2100, 1.2); qput(d2, 2050, 1.1); qput(now - HOUR, 2075, 1.1);
  const valueSeries4 = { main: [{ t: d0, v: 5000 }, { t: d1, v: 5100 }, { t: d2, v: 5050 }, { t: now - HOUR, v: 5040 }] };
  const gasWei = 1000000000000000n; // 0.001 ETH
  const base4 = {
    wallets: [{ key: "main", label: "Main", main: true }],
    valueSeries: valueSeries4,
    priceHours: priceHours4,
    holdings: { main: { eth: 1, "0xaaa": 1000 } },
    gasSpends: [{ t: d0 + HOUR, wei: String(gasWei) }],
    flows: [], positions: [],
  };
  const r7 = compute(base4, { days: 3, now });
  const day1Row = r7.wallets[0].rows[0];
  // No ETH price at d0 + 1h -> gas is NOT silently dropped: gasUsd stays the priced part
  // (none, so 0 / absent), gasWei carries the wei, and the day is inexact.
  assert.strictEqual(day1Row.gasWei, gasWei.toString(), "unpriced gas carried as gasWei, not dropped");
  assert.strictEqual(day1Row.gas, 0, "no priced part for that gas (USD side stays 0 until a price exists)");
  assert.strictEqual(day1Row.exact, false, "day with unpriced gas is incomplete, like an unpriced price leg");
  // A later day with ETH price prices its (own) gas normally.
  const r8 = compute({ ...base4, gasSpends: [{ t: d2 + HOUR, wei: String(gasWei) }] }, { days: 3, now });
  assert.strictEqual(r8.wallets[0].rows[2].exact, true, "priced gas keeps the day exact");
}

console.log("attribution: item-4 unpriced gas carried as gasWei, day incomplete (never dropped)");
