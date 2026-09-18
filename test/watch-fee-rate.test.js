// node test/watch-fee-rate.test.js — the per-wallet fee rate is measured, not projected.
//
// Each watched wallet keeps hourly USD accrual buckets, so "fees / hour" can be a
// real average rather than a total divided by an assumed period. The trap is the
// denominator: a wallet watched for three hours, divided by a flat 24, reads as
// earning almost nothing and would make a healthy position look dead. So the rate is
// taken over the hours actually observed, and under an hour of history is not a rate
// at all — the page says nothing rather than something wrong.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const HOUR = 3600 * 1000;
const src = fs.readFileSync(path.join(__dirname, "..", "watch.js"), "utf8");

// earnedFor closes over the module's accrual store, so it is lifted out and given
// one: the arithmetic is what matters here, not how the file is wired together.
const from = src.indexOf("  function earnedFor(address) {");
assert.ok(from >= 0, "earnedFor is gone from watch.js");
const body = src.slice(from, src.indexOf("\n  }\n", from) + 4);
const make = (hours) => new Function("accrual", "HOUR", "dayOf",
  body + "; return earnedFor;")(
  { hours: { "0xw": hours } }, HOUR,
  (t) => new Date(t).toISOString().slice(0, 10));

const now = Date.now();
const hoursAgo = (n) => String(Math.floor((now - n * HOUR) / HOUR) * HOUR);

// ---- 1. a long-running wallet averages over a full day ------------------------
{
  const buckets = {};
  for (let i = 1; i <= 48; i++) buckets[hoursAgo(i)] = 1;   // $1/hour for two days
  const e = make(buckets)("0xw");
  assert.ok(Math.abs(e.perHour - 1) < 0.05, `about $1/hour, got ${e.perHour}`);
  assert.strictEqual(e.rateWindowH, 24, "over a 24 hour window");
  assert.ok(Math.abs(e.h24 - 24) < 1.5, "and the 24h total agrees with it");
}

// ---- 2. a wallet watched for three hours is not divided by a day --------------
{
  // $3 earned over 3 hours is $1/hour. Divided by 24 it would read as $0.125 and
  // the wallet would look like it had stopped earning.
  const buckets = { [hoursAgo(1)]: 1, [hoursAgo(2)]: 1, [hoursAgo(3)]: 1 };
  const e = make(buckets)("0xw");
  // Buckets are floored to the hour, so the oldest of three "hours ago" began
  // anywhere up to 59 minutes before that: the observed window is 3 to 4 hours
  // depending on the time of day, and $3 over it is $0.75 to $1.00 an hour. Pinning
  // this tighter would pass or fail on the minute the suite happened to run.
  assert.ok(e.perHour > 0.7 && e.perHour <= 1.01, `the rate reflects the hours lived, got ${e.perHour}`);
  assert.ok(e.rateWindowH >= 2.9 && e.rateWindowH <= 4.1, `the window is stated: ${e.rateWindowH}h`);
  assert.ok(e.rateWindowH < 24, "and is not claimed to be a day");
  // The point of the window: a flat 24 would have read this as $0.125 an hour.
  assert.ok(e.perHour > (e.h24 / 24) * 5, "and is far above what dividing by a full day would give");
}

// ---- 3. too little history is no rate at all ----------------------------------
{
  const e = make({ [hoursAgo(0)]: 0.5 })("0xw");
  assert.strictEqual(e.perHour, null, "under an hour of history reports no rate");
  assert.strictEqual(e.rateWindowH, null, "and no window");
  assert.ok(e.all > 0, "while the amount earned is still reported");
}

// ---- 4. a wallet that has never accrued says nothing ---------------------------
{
  const e = make({})("0xw");
  assert.strictEqual(e.perHour, null, "no buckets, no rate");
  assert.strictEqual(e.all, 0);
  assert.strictEqual(e.since, null, "and nothing is claimed about when it started");
}

// ---- 5. a wallet that has stopped earning reports zero, not silence ------------
{
  // Buckets exist but all fall outside the last day: it was tracked, and it is
  // earning nothing now. That is a measurement and must be shown as one.
  const buckets = {};
  for (let i = 30; i <= 40; i++) buckets[hoursAgo(i)] = 2;
  const e = make(buckets)("0xw");
  assert.strictEqual(e.perHour, 0, "a tracked wallet earning nothing reads as zero");
  assert.strictEqual(e.rateWindowH, 24, "over the full window");
  assert.ok(e.all > 0, "even though it has earned in the past");
}

// ---- 6. the page shows it, and only when it exists -----------------------------
{
  const dash = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
  assert.ok(/e\.perHour != null/.test(dash), "the wallet card shows a rate only when there is one");
  assert.ok(/fees\/hr/.test(dash), "and labels it as a rate per hour");
  assert.ok(/rateWindowH/.test(dash), "the window it was measured over is in reach of the reader");
}

console.log("watch fee rate: measured over the hours actually observed, absent when there is too little history, and zero when a tracked wallet has genuinely stopped");
