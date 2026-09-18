// node test/portfolio-spike.test.js — a misread price must not become portfolio history.
//
// portfolio-all.json keeps one point an hour forever, and the chart scales to its
// maximum. One sample on 2026-09-17 recorded the owner at 6.7e37 and a watched wallet
// at 2.1e39, while the main-wallet series priced the same minute sat at $12,400: one
// token priced wrongly by thirty-odd orders of magnitude. It flattened eleven days of
// real history into the bottom axis and put
// $2,342,677,137,524,212,700,000,000,000,000,000,000,000.00 on the page.
//
// The guard is relative, not an absolute ceiling: a portfolio that genuinely grows,
// or one denominated in a cheap unit, must never trip it, and no constant could be
// right for both. What it rejects is a sample out of step with the ones around it.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// The writer is inside server.js and closes over module state, so the decision is
// lifted out and exercised directly.
const from = src.indexOf("  const recent = allSeries.points.slice(-24)");
assert.ok(from >= 0, "the spike guard is gone from recordAllWallets");
const to = src.indexOf("  allSeries.points.push({", from);
assert.ok(to > from, "the guard no longer sits before the push");
const guard = src.slice(from, to);
assert.ok(/return;/.test(guard), "a refused sample is not stored");

// `total` and `allSeries` are the only things the excerpt reads; `console.error` is
// captured so the reason can be checked as well as the decision.
function accepts(points, total) {
  const logged = [];
  const fn = new Function("allSeries", "total", "console",
    guard + "\n return { stored: true };")({ points }, total, { error: (m) => logged.push(m) });
  return { stored: !!(fn && fn.stored), why: logged.join(" ") };
}

const steady = (n, v) => Array.from({ length: n }, (_, i) => ({ t: i, total: v + (i % 3) }));

// ---- 1. the sample that caused this -------------------------------------------
{
  const r = accepts(steady(24, 24000), 2.343e39);
  assert.strictEqual(r.stored, false, "a value 1e35 times the portfolio is refused");
  assert.ok(/misread/.test(r.why), `and says what it is: ${r.why}`);
  assert.ok(/median/.test(r.why), "naming what it was judged against");
}

// ---- 2. ordinary movement is kept ---------------------------------------------
{
  // Real portfolios move, sometimes sharply. None of this may be thrown away.
  for (const [total, what] of [[24000, "unchanged"], [48000, "doubled"], [12000, "halved"],
    [240000, "up tenfold in an hour"], [1, "collapsed to nearly nothing"], [0, "gone to zero"]]) {
    assert.strictEqual(accepts(steady(24, 24000), total).stored, true, `a portfolio that ${what} is recorded`);
  }
}

// ---- 3. a young series is not judged against too little -----------------------
{
  // With five points there is not enough to call anything an outlier, and refusing
  // early samples would leave a new instance with no history at all.
  assert.strictEqual(accepts(steady(5, 24000), 2.343e39).stored, true, "too little history to judge: the sample is kept");
  assert.strictEqual(accepts([], 2.343e39).stored, true, "and the first sample of all is always kept");
  assert.strictEqual(accepts(steady(6, 24000), 2.343e39).stored, false, "six points are enough to judge against");
}

// ---- 4. a broken number never reaches the file --------------------------------
{
  const src2 = src.slice(src.indexOf("function recordAllWallets()"), to);
  assert.ok(/if \(!Number\.isFinite\(total\)\)/.test(src2), "a total that is not a number is refused outright");
  // NaN and Infinity compare false against every threshold, so without that check
  // they would sail past the median test and poison the axis permanently.
  for (const bad of [NaN, Infinity]) {
    const r = accepts(steady(24, 24000), bad);
    assert.ok(!r.stored || /not a number/.test(r.why), `${bad} does not become history`);
  }
}

// ---- 5. the repair tool is dry by default -------------------------------------
{
  const tool = fs.readFileSync(path.join(__dirname, "..", "tools", "repair-portfolio-spike.js"), "utf8");
  assert.ok(/const APPLY = process\.argv\.includes\("--apply"\)/.test(tool), "it writes nothing without --apply");
  assert.ok(/copyFileSync\(FILE, backup\)/.test(tool), "and keeps the previous file");
  assert.ok(/No value is corrected or invented/.test(tool),
    "it removes the reading rather than replacing it with a guess");
}

console.log("portfolio spike: an impossible sample is refused and said to be a misread, while real movement — tenfold, halved, zero — is recorded untouched");
