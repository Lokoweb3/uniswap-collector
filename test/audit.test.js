// node test/audit.test.js — the ledger audit's checks on synthetic rows, no network.
const assert = require("assert");
const { auditRows, auditLots, reconcile, summarise, summaryLine } = require("../audit");

const H = 3600000, t0 = Date.parse("2026-09-08T23:39:00Z");
const LAP = "0x76ed1e2a8fc3873fcb5c514688ca2fe8a3600b7f", W = "0xadf94a20558e1e6d64c429f8f9f017169bf3d743";
const hours = { [String(Date.parse("2026-09-08T23:00:00Z"))]: { [LAP]: 0.000956, eth: 2485 } };
const row = (o) => ({ t: t0, tx: "0xaa", logIndex: "0x1", from: W, token: "LAPTOP", tokenAddress: LAP, amount: 657664, usd: 626.6, kind: "sold", priced: "eth", shape: "3hop:weth", units: { usdg: "0", eth: "252165889604076828" }, ...o });

// A row near the hourly price passes; the old 25x mistake is "off" and bad; 0 with a price is "unpriced".
assert.deepStrictEqual(auditRows([row()], hours, { knownShapes: ["3hop:weth"] }), []);
let f = auditRows([row({ usd: 15560.25 })], hours, { knownShapes: ["3hop:weth"] });
assert.strictEqual(f.length, 1); assert.strictEqual(f[0].kind, "off"); assert.strictEqual(f[0].severity, "bad"); assert.ok(f[0].ratio > 24, "ratio " + f[0].ratio);
f = auditRows([row({ usd: 0 })], hours, { knownShapes: ["3hop:weth"] });
assert.strictEqual(f[0].kind, "unpriced");
// 52% under the hourly price is only a warning (under 50% off is tolerated); 1% is nothing.
assert.strictEqual(auditRows([row({ usd: 300 })], hours, { knownShapes: ["3hop:weth"] })[0].severity, "warn");
assert.strictEqual(auditRows([row({ usd: 622 })], hours, { knownShapes: ["3hop:weth"] }).length, 0);
// The valuer's own fallback is reported, and a route shape not accepted yet is an info finding.
f = auditRows([row({ priced: "hourly log (proceeds unmatched: eth (last hop) gave $1423.19)", usd: 53.7, shape: "2hop:native" })], hours, { knownShapes: ["3hop:weth"] });
assert.deepStrictEqual(f.map((x) => x.kind), ["unmatched", "unfamiliar"]);
// A row with no price on record is left alone (nothing to compare against); sent / received rows are not sales.
assert.strictEqual(auditRows([row({ t: t0 - 30 * 24 * H })], hours).length, 1, "only the shape finding without knownShapes");
assert.strictEqual(auditRows([row({ kind: "received" })], hours).length, 0);

// Lots: proceeds or realized out of proportion to the basis.
assert.strictEqual(auditLots([{ token: "LAPTOP", basisUsd: 682.08, proceedsUsd: 11157.56, realizedUsd: 10475.49 }])[0].severity, "bad");
assert.deepStrictEqual(auditLots([{ token: "LAPTOP", basisUsd: 682.08, proceedsUsd: 455.34, realizedUsd: -226.74 }, { token: "MEME", basisUsd: 2.81, proceedsUsd: null }]), []);

// Inflows: booked units must have arrived that day.
const inflows = [{ wallet: W, t: t0 + 60000, currency: "eth", amount: "252165889604076828" }, { wallet: W, t: t0, currency: "usdg", amount: "248846659" }];
assert.deepStrictEqual(reconcile([row(), row({ units: { usdg: "248846659", eth: "0" } })], inflows), []);
f = reconcile([row({ units: { usdg: "0", eth: "6261995803353978955" } })], inflows);
assert.strictEqual(f.length, 1); assert.strictEqual(f[0].kind, "inflow"); assert.match(f[0].note, /booked 6\.2620 ETH .* shows 0\.2522 ETH/);
// A sale younger than a day is not reconciled yet (the explorer indexes recent internal transactions late).
assert.deepStrictEqual(reconcile([row({ units: { usdg: "0", eth: "6261995803353978955" } })], [], { now: t0 + 3600000 }), []);
assert.strictEqual(reconcile([row({ units: { usdg: "0", eth: "6261995803353978955" } })], [], { now: t0 + 2 * 24 * 3600000 }).length, 1);
// Rows without units (hourly-log fallback) do not take part; a different wallet's inflow does not cover this one.
assert.deepStrictEqual(reconcile([row({ units: null })], []), []);
assert.strictEqual(reconcile([row()], [{ ...inflows[0], wallet: "0x00000000000000000000000000000000000000bb" }]).length, 1);

// Summary and the morning line.
const s = summarise([{ severity: "bad", token: "LAPTOP" }, { severity: "warn", token: "LAPTOP" }, { severity: "info" }]);
assert.deepStrictEqual(s, { total: 3, bad: 1, warn: 1, info: 1, byToken: { LAPTOP: 2 }, clean: false });
assert.match(summaryLine({ at: t0, findings: [], summary: summarise([]) }), /^🧾 Ledger audit \(Sep 8\): clean$/);
assert.match(summaryLine({ at: t0, findings: [{ severity: "bad", token: "LAPTOP", note: "booked $15560 is 25x the hourly price ($615)" }], summary: summarise([{ severity: "bad" }]) }), /1 finding — LAPTOP booked \$15560 is 25x/);
assert.match(summaryLine(null), /not run yet/);
console.log("audit: row, lots, inflow reconciliation and summary assertions passed");
