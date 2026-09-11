// node test/guardian.test.js — risk guardian decision logic with synthetic samples (one rule block per position).
const assert = require("assert");
const { derive, alertsFor, shouldClose, rulesOf, RULE_DEFAULTS } = require("../guardian-logic");

const cfg = { tokenId: "1", pair: "LAPTOP/ETH", wallet: "Trading", walletAddress: "0x1", entryPrice: 1000000, alertPct: 20, closePct: 50, outOfRangeMinutes: 120, tvlDropPct: 50, autoClose: false, alertOnly: true };
const t0 = Date.parse("2026-09-08T00:00:00Z");
// price is TOKEN per quote: a bigger number = the token is worth less.
const mk = (minutes, price, extra = {}) => ({ t: t0 + minutes * 60000, price, liq: 1000, feeUsd: minutes * 0.5, inRange: true, valueUsd: 1700, ...extra });

// 0. rule block: entry values over defaults, bad numbers ignored, null switches a floor off
assert.deepStrictEqual(rulesOf({}, {}), RULE_DEFAULTS);
// The pool key (from the dashboard payload) rides along for the shared per-pool alert cool-down.
assert.strictEqual(derive({ tokenId: "1", pair: "X/Y", poolKey: "v4:0xabc" }, [{ t: 1, price: 1, liq: 1, feeUsd: 0, inRange: true, valueUsd: 1 }]).poolKey, "v4:0xabc");
assert.strictEqual(derive({ tokenId: "1", pair: "X/Y" }, [{ t: 1, price: 1, liq: 1, feeUsd: 0, inRange: true, valueUsd: 1 }]).poolKey, null);
let r = rulesOf({ alertPct: 30, feeFloorPerHour: 10, closePct: "abc" }, { closePct: 40, tvlDropPct: 60 });
assert.strictEqual(r.alertPct, 30); assert.strictEqual(r.feeFloorPerHour, 10); assert.strictEqual(r.closePct, 40, "bad number -> the configured default"); assert.strictEqual(r.tvlDropPct, 60);
assert.strictEqual(rulesOf({ feeFloorPerHour: null }, { feeFloorPerHour: 10 }).feeFloorPerHour, null);
assert.strictEqual(rulesOf({ autoClose: true, alertOnly: false }).autoClose, true); assert.strictEqual(rulesOf({ autoClose: true }).alertOnly, true, "alertOnly stays on unless switched off");

// 1. steady: green, 0% vs entry, fees/h = 30 $/h
let s = []; for (let m = 0; m <= 90; m += 5) s.push(mk(m, 1000000));
let d = derive(cfg, s);
assert.strictEqual(d.status, "green"); assert.strictEqual(Math.round(d.priceVsEntryPct), 0); assert.ok(Math.abs(d.feesPerHour - 30) < 0.01, "fees/h " + d.feesPerHour);
assert.strictEqual(d.inRange, true); assert.strictEqual(d.outMinutes, 0); assert.strictEqual(d.canClose, false);
const sent = {};
assert.deepStrictEqual(alertsFor(d, sent), []);

// 2. MOCK DUMP: token loses 25% in the last hour (price token/ETH rises 33%) -> red + exactly ONE alert, no repeat within the cool-down
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000)); for (let m = 65; m <= 120; m += 5) s.push(mk(m, 1000000 / 0.75));
d = derive(cfg, s);
assert.strictEqual(d.status, "red"); assert.ok(d.change1hPct < -20, "change1h " + d.change1hPct);
let out = alertsFor(d, sent); assert.strictEqual(out.length, 1, "one message for a dump: " + JSON.stringify(out)); assert.match(out[0], /DUMP ALERT LAPTOP\/ETH -2\d% in 1h/);
assert.deepStrictEqual(alertsFor(d, sent), []);
// the same dump seen on the next cycles: still nothing more
for (let m = 125; m <= 150; m += 5) s.push(mk(m, 1000000 / 0.75));
assert.deepStrictEqual(alertsFor(derive(cfg, s), sent), []);
// a dump that also crosses the drawdown limit: dump + close-now are two events, one message each
const cfgD = { ...cfg, closePct: 20 };
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000)); for (let m = 65; m <= 120; m += 5) s.push(mk(m, 1000000 / 0.75));
out = alertsFor(derive(cfgD, s), {}); assert.strictEqual(out.length, 2); assert.ok(out.some((x) => /DUMP ALERT/.test(x)) && out.some((x) => /CLOSE NOW \(-25% from entry, limit -20%\)/.test(x)), out.join("|"));

// 3. out of range then back: one alert each, keyed per episode; the "out for long" alert once at the limit
s = []; for (let m = 0; m <= 30; m += 5) s.push(mk(m, 1000000, { inRange: m >= 20 ? false : true }));
d = derive(cfg, s); assert.strictEqual(d.inRange, false); assert.strictEqual(Math.round(d.outMinutes), 10);
const sent2 = {};
out = alertsFor(d, sent2); assert.strictEqual(out.length, 1); assert.match(out[0], /OUT OF RANGE/);
assert.deepStrictEqual(alertsFor(d, sent2), []);
for (let m = 35; m <= 145; m += 5) s.push(mk(m, 1000000, { inRange: false }));
d = derive(cfg, s); assert.ok(d.outMinutes >= 120);
out = alertsFor(d, sent2); assert.strictEqual(out.length, 1); assert.match(out[0], /out of range for 125 min \(limit 120\) — consider closing/);
assert.deepStrictEqual(alertsFor(d, sent2), []);
s.push(mk(150, 1000000, { inRange: true })); d = derive(cfg, s);
out = alertsFor(d, sent2); assert.strictEqual(out.length, 1); assert.match(out[0], /back in range/);
assert.deepStrictEqual(alertsFor(d, sent2), []);

// 4. volume dying: fees flat for the last 30 min after 30 $/h before -> yellow status, but NO alert (the fee floor covers it)
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000)); for (let m = 65; m <= 95; m += 5) s.push(mk(m, 1000000, { feeUsd: 30 }));
d = derive(cfg, s); assert.ok(d.feeRateChangePct <= -70, "fee rate change " + d.feeRateChangePct); assert.strictEqual(d.status, "yellow");
assert.deepStrictEqual(alertsFor(d, {}), []);
// a collect inside the hour (fee balance reset) is not a crash
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000)); for (let m = 65; m <= 95; m += 5) s.push(mk(m, 1000000, { feeUsd: (m - 65) * 0.5 }));
d = derive(cfg, s); assert.strictEqual(d.feeRateChangePct, null, "collect resets the comparison"); assert.strictEqual(d.status, "green");

// 5. LPs leaving: liquidity -60% from its 24h max -> red + ONE alert, no repeat, re-armed after recovery
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000, { liq: m >= 40 ? 400 : 1000 }));
d = derive(cfg, s); assert.ok(d.liqDropFromMaxPct >= 50); assert.strictEqual(d.status, "red");
const sent5 = {};
out = alertsFor(d, sent5); assert.strictEqual(out.length, 1); assert.match(out[0], /LPs leaving — pool liquidity -60% from its 24h high \(limit -50%\)/);
assert.deepStrictEqual(alertsFor(d, sent5), []);
s.push(mk(65, 1000000, { liq: 950 })); assert.deepStrictEqual(alertsFor(derive(cfg, s), sent5), []); assert.ok(!sent5["liq:1"], "re-armed");
// a per-position limit of 60% does not fire at -55%
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000, { liq: m >= 40 ? 450 : 1000 }));
assert.deepStrictEqual(alertsFor(derive({ ...cfg, tvlDropPct: 60 }, s), {}), []);

// 6. close-now at -45% from entry with closePct 40; autoClose off -> alert, no close
const cfg40 = { ...cfg, closePct: 40 };
s = []; for (let m = 0; m <= 10; m += 5) s.push(mk(m, 1000000 / 0.55));
d = derive(cfg40, s); assert.ok(d.drawdownPct > 40 && d.drawdownPct < 50, "drawdown " + d.drawdownPct);
out = alertsFor(d, {}); assert.strictEqual(out.length, 1); assert.match(out[0], /CLOSE NOW \(-45% from entry, limit -40%\)/);
assert.strictEqual(shouldClose(d), null);
assert.strictEqual(shouldClose(derive({ ...cfg40, autoClose: true }, s)), null, "alertOnly latch wins over autoClose");

// 7. autoClose on (alertOnly off): -50% from entry triggers; out of range 2h triggers; otherwise not; the close path reports instead of the alerts
const cfgA = { ...cfg, autoClose: true, alertOnly: false };
d = derive(cfgA, [mk(0, 1000000 / 0.5)]); assert.match(shouldClose(d), /from entry/);
assert.deepStrictEqual(alertsFor(d, {}, d.at, 3600000, { closing: true }), []);
s = []; for (let m = 0; m <= 130; m += 5) s.push(mk(m, 1000000, { inRange: false }));
d = derive(cfgA, s); assert.match(shouldClose(d), /out of range for 130 min/);
out = alertsFor(d, {}, d.at, 3600000, { closing: true }); assert.strictEqual(out.length, 1); assert.match(out[0], /OUT OF RANGE/);
s = []; for (let m = 0; m <= 60; m += 5) s.push(mk(m, 1000000, { inRange: false }));
d = derive(cfgA, s); assert.strictEqual(shouldClose(d), null);

// 8. a gain shows positive: token worth 2x -> +100%
d = derive(cfg, [mk(0, 500000)]); assert.strictEqual(Math.round(d.priceVsEntryPct), 100); assert.strictEqual(d.status, "green");

// 9. fee floor and collected target
const cfgR = { ...cfg, tokenId: "9", pair: "Bucket/USDG", feeFloorPerHour: 10, collectedTargetUsd: 500, tvlDropPct: 60 };
s = []; for (let m = 0; m <= 30; m += 1) s.push(mk(m, 1000000, { feeUsd: m * (4 / 60) }));
d = derive(cfgR, s); assert.ok(d.feesPerHour15m != null && d.feesPerHour15m < 10, "15m rate " + d.feesPerHour15m); assert.strictEqual(d.status, "yellow");
let sentR = {}; let outR = alertsFor(d, sentR);
assert.strictEqual(outR.length, 1); assert.match(outR[0], /Bucket\/USDG fees dropping — \$4\.00\/hour \(below \$10 floor\)/);
assert.deepStrictEqual(alertsFor(d, sentR), []);
s = []; for (let m = 0; m <= 30; m += 1) s.push(mk(m, 1000000, { feeUsd: m * (30 / 60) }));
d = derive(cfgR, s); assert.deepStrictEqual(alertsFor(d, sentR), []); assert.ok(!sentR["feefloor:9"], "re-armed after recovery");
d = derive({ ...cfgR, collectedUsd: 512.3 }, s); outR = alertsFor(d, sentR);
assert.strictEqual(outR.length, 1); assert.match(outR[0], /hit \$500 collected!\nCurrent fees\/hour: \$30\.00/);
assert.deepStrictEqual(alertsFor(d, sentR), []);

// 10. defaults for a discovered position (no rule fields) come from memecoinDefaults
const disc = { tokenId: "10", pair: "MEME/USDG", entryPrice: 100 };
d = derive(disc, [mk(0, 100, { liq: 1000 }), mk(5, 100, { liq: 300 })], undefined, { tvlDropPct: 60 });
assert.strictEqual(d.rules.tvlDropPct, 60); assert.strictEqual(d.rules.closePct, 50); assert.strictEqual(d.status, "red");

console.log("guardian: 11 scenarios passed (rule block, steady, mock dump = one alert, range, volume, liquidity, close-now, auto-close, gains, fee floor/target, defaults)");
