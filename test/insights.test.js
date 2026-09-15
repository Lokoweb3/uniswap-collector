"use strict";
const assert = require("assert/strict");
const { build, weeks, complete } = require("../insights");
const { dayKey } = require("../daykey");
const HOUR = 3600000, now = Date.parse("2026-09-15T16:00:00Z");
const windows = weeks(now), start = windows[0].start, end = windows[1].end;
assert.equal(windows.length, 2);
assert.equal(dayKey(start), "2026-08-31");
assert.equal(dayKey(end), "2026-09-14");
assert.equal(windows[0].end, windows[1].start);
const series = [];
for (let t = start; t <= end; t += HOUR) series.push({ t, total: t < windows[1].start ? 100 : 120, a: { token: 1 }, p: { token: 100 } });
const d = {
  positions: { at: now, owner: "main", ownerLabel: "Main", positions: [
    { tokenId: "1", pair: "ETH / USDG", inRange: false },
  ], unlock: { armed: true, minutesLeft: 30 }, operatorGas: { low: true, eth: 0.001 },
    totals: { eligibleCount: 1, collectableUsd: 40 } },
  history: [{ t: now - HOUR, usd: 12, locked: true }], series,
  ranges: { 1: { segments: [{ from: start, to: windows[0].end, inRange: true },
    { from: windows[1].start, to: end, inRange: false }] } },
  fees: { [start + HOUR]: { 1: 10 }, [windows[1].start + HOUR]: { 1: 20 } },
  gas: [{ t: start + HOUR, wei: "1000000000000000" }], prices: { [start + HOUR]: { eth: 2000 } },
  flows: [{ t: start + HOUR, kind: "received", to: "MAIN", usd: 20 }],
};
let result = build(d, { now, since: now - 2 * HOUR });
assert.equal(result.attention.length, 3);
assert.match(result.attention[0].title, /gas/);
assert.match(result.changes[0], /1 collects.*12.00/);
assert.equal(result.weeks[0].feesUsd, 10);
assert.equal(result.weeks[1].feesUsd, 20);
assert.equal(result.weeks[0].gasUsd, 2);
assert.equal(result.weeks[0].recordedTransfersUsd, 20);
assert.equal(result.weeks[0].valueChangeUsd, 20);
assert.equal(result.weeks[0].resultUsd, 0, "deposit is not earnings; gas must not be subtracted twice");
assert.equal(result.weeks[0].timeInRangePct, 100);
assert.equal(result.weeks[1].timeInRangePct, 0);
assert.equal(result.weeks[0].observedPositionHours, (windows[0].end - start) / HOUR);
// A sustained price outage is rejected even when the old producer cleared partial.
const missing = series.map(p => ({ ...p, p: p.t >= start + HOUR && p.t < start + 5 * HOUR ? {} : p.p }));
result = build({ ...d, series: missing }, { now });
assert.equal(result.weeks[0].resultUsd, null);
assert.equal(result.weeks[0].feesUsd, null);
assert.ok(result.weeks[0].coveragePct < 100);
assert.equal(complete({ total: 100, a: { token: 1 }, p: {} }), false);
result = build({ ...d, flows: null, gas: [{ t: start + HOUR, wei: "1000" }], prices: {} }, { now });
assert.equal(result.weeks[0].returnPct, null, "missing transfer ledger must not be assumed zero");
assert.equal(result.weeks[0].gasUsd, null, "unpriced gas must not be zero");
assert.equal(build({}, { now }).freshness.stale, true);
assert.equal(build({}, { now }).weeks[0].resultUsd, null);
assert.equal(build(d, { now, since: now + HOUR }).since, now - 24 * HOUR);
// Local-week boundaries remain Monday at midnight through the fall DST transition.
const dst = weeks(Date.parse("2026-11-03T17:00:00Z"));
assert.equal(dayKey(dst[1].end), "2026-11-02");
if (process.env.LP_TZ === "America/New_York") assert.equal((dst[1].end - dst[1].start) / HOUR, 169);
console.log("insights: attention, fixed windows, deposits, price gaps, unknown data, gas and DST passed");

// Exercise the actual API adapter without starting server.js or reading runtime files.
{
  const fs = require("fs"), path = require("path"), vm = require("vm");
  const source = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  const from = source.indexOf('  if (url.pathname === "/api/insights"');
  const to = source.indexOf('  if (url.pathname === "/api/daily-check"', from);
  const fixture = { "portfolio.json": { series }, "fee-daily.json": { hours: d.fees },
    "state.json": { gasSpends: d.gas }, "price-log.json": { hours: d.prices },
    "token-disposals.json": { rows: d.flows } };
  let response, status;
  vm.runInNewContext('(function(){' + source.slice(from, to) + '})()', {
    url: new URL("http://fixture/api/insights?since=" + (Date.now() - HOUR)), req: { method: "GET" },
    res: { setHeader() {}, writeHead(code) { status = code; }, end(body) { response = JSON.parse(body); } },
    path, __dirname: "/synthetic", fs: { readFileSync(file) {
      assert.ok(file.startsWith("/synthetic/")); assert.ok(Object.hasOwn(fixture, path.basename(file)));
      return JSON.stringify(fixture[path.basename(file)]);
    } }, require: name => { assert.equal(name, "./insights"); return { build }; },
    cache: { payload: d.positions }, unlockState: () => d.positions.unlock, opsInfo: () => ({}), loopHealth: () => ({}),
    watch: { latest: null }, portfolio: { latest: null }, lastHistoryAt: now, lastHistoryRows: d.history,
    rangeLog: { positions: d.ranges },
  });
  assert.equal(status, 200); assert.equal(response.ok, true);
  assert.ok(response.since > Date.now() - 2 * HOUR, "since passes through the actual route");
  assert.equal(response.weeks.length, 2);
  console.log("insights: actual API adapter uses only the expected ledgers and forwards the baseline");
}
