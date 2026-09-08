// node test/guardian.test.js — memecoin guardian decision logic with synthetic samples.
const assert = require("assert");
const { derive, alertsFor, shouldClose } = require("../guardian-logic");

const cfg = { tokenId: "1", pair: "LAPTOP/ETH", wallet: "Trading", walletAddress: "0x1", entryPrice: 1000000, maxDrawdownPct: 50, autoClose: false, outOfRangeCloseMinutes: 120 };
const t0 = Date.parse("2026-09-08T00:00:00Z");
// price is TOKEN per ETH: a bigger number = the token is worth less.
const mk = (minutes, price, extra = {}) => ({ t: t0 + minutes * 60000, price, liq: 1000, feeUsd: minutes * 0.5, inRange: true, valueUsd: 1700, ...extra });

// 1. steady: green, 0% vs entry, fees/h = 30 $/h
let s = []; for (let m = 0; m <= 90; m += 5) s.push(mk(m, 1000000));
let d = derive(cfg, s);
assert.strictEqual(d.status, "green"); assert.strictEqual(Math.round(d.priceVsEntryPct), 0); assert.ok(Math.abs(d.feesPerHour - 30) < 0.01, "fees/h " + d.feesPerHour);
assert.strictEqual(d.inRange, true); assert.strictEqual(d.outMinutes, 0);
const sent = {};
assert.deepStrictEqual(alertsFor(d, sent), []);

// 2. dump: token loses 25% in the last hour (price token/ETH rises 33%) -> red + one dump alert, no repeat within cooldown
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000)); for (let m = 65; m <= 120; m += 5) s.push(mk(m, 1000000 / 0.75));
d = derive(cfg, s);
assert.strictEqual(d.status, "red"); assert.ok(d.change1hPct < -20, "change1h " + d.change1hPct);
let out = alertsFor(d, sent); assert.strictEqual(out.length, 1); assert.match(out[0], /DUMP ALERT LAPTOP\/ETH -2\d% in 1h/);
assert.deepStrictEqual(alertsFor(d, sent), []);

// 3. out of range then back: one alert each, keyed per episode
s = []; for (let m = 0; m <= 30; m += 5) s.push(mk(m, 1000000, { inRange: m >= 20 ? false : true }));
d = derive(cfg, s); assert.strictEqual(d.inRange, false); assert.strictEqual(Math.round(d.outMinutes), 10);
const sent2 = {};
out = alertsFor(d, sent2); assert.strictEqual(out.length, 1); assert.match(out[0], /OUT OF RANGE/);
assert.deepStrictEqual(alertsFor(d, sent2), []);
s.push(mk(35, 1000000, { inRange: true })); d = derive(cfg, s);
out = alertsFor(d, sent2); assert.strictEqual(out.length, 1); assert.match(out[0], /back in range/);
assert.deepStrictEqual(alertsFor(d, sent2), []);

// 4. volume dying: fees flat for the last 30 min after 30 $/h before
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000)); for (let m = 65; m <= 95; m += 5) s.push(mk(m, 1000000, { feeUsd: 30 }));
d = derive(cfg, s); assert.ok(d.feeRateChangePct <= -70, "fee rate change " + d.feeRateChangePct); assert.strictEqual(d.status, "yellow");
out = alertsFor(d, {}); assert.ok(out.some((x) => /volume dying/.test(x)));

// 5. LPs leaving: active liquidity -60% from its max -> red + alert
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000, { liq: m >= 40 ? 400 : 1000 }));
d = derive(cfg, s); assert.ok(d.liqDropFromMaxPct >= 50); assert.strictEqual(d.status, "red");
out = alertsFor(d, {}); assert.ok(out.some((x) => /LPs leaving/.test(x)));

// 6. close-now at -45% from entry (price token/ETH = entry / 0.55); autoClose off -> no close
s = []; for (let m = 0; m <= 10; m += 5) s.push(mk(m, 1000000 / 0.55));
d = derive(cfg, s); assert.ok(d.drawdownPct > 40 && d.drawdownPct < 50, "drawdown " + d.drawdownPct);
out = alertsFor(d, {}); assert.ok(out.some((x) => /CLOSE NOW \(-45% from entry\)/.test(x)), out.join("|"));
assert.strictEqual(shouldClose(d), null);

// 7. autoClose on: -50% from entry triggers; out of range 2h triggers; otherwise not
const cfgA = { ...cfg, autoClose: true };
d = derive(cfgA, [mk(0, 1000000 / 0.5)]); assert.match(shouldClose(d), /from entry/);
s = []; for (let m = 0; m <= 130; m += 5) s.push(mk(m, 1000000, { inRange: false }));
d = derive(cfgA, s); assert.match(shouldClose(d), /out of range for 130 min/);
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000, { inRange: false }));
d = derive(cfgA, s); assert.strictEqual(shouldClose(d), null);

// 8. a gain shows positive: token worth 2x -> +100%
d = derive(cfg, [mk(0, 500000)]); assert.strictEqual(Math.round(d.priceVsEntryPct), 100); assert.strictEqual(d.status, "green");

console.log("guardian: 8 scenarios passed (steady, dump, range, volume, liquidity, close-now, auto-close, gains)");
