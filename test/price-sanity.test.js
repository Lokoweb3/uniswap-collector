// node test/price-sanity.test.js — a price someone has just pushed is not a reference.
//
// The sell path measures its impact cap against the pool's own spot price and derives
// minOut from the same quote, so a price that has already been moved satisfies both
// by construction: the cap compares the trade against the pushed price rather than
// against the price before it was pushed. The guardian's stability check compares one
// cycle to the one before it, so a steady 9%-a-minute push passes while adding up to
// the drawdown that triggers an auto-close.
//
// price-log.json is written on its own schedule by another path, so it is a genuinely
// separate reading rather than the same pool a moment later. It does not prove a price
// correct; it shows when the live one has left the recent record behind.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const ps = require("../price-sanity");

const HOUR = 3600 * 1000;
const now = Date.now();
const log = (entries) => ({ hours: Object.fromEntries(entries.map(([ago, row]) => [String(now - ago), row])) });
const TOK = "0xtok";

// ---- 1. the deviation itself ---------------------------------------------------
{
  const l = log([[30 * 60000, { [TOK]: 100 }]]);
  assert.strictEqual(ps.deviation(l, TOK, 100, now).deviationPct, 0, "a matching price deviates by nothing");
  assert.strictEqual(Math.round(ps.deviation(l, TOK, 130, now).deviationPct), 30, "a 30% push reads as 30%");
  assert.strictEqual(Math.round(ps.deviation(l, TOK, 70, now).deviationPct), 30, "and so does a 30% drop — direction is not the question");
  assert.strictEqual(ps.deviation(l, TOK, 0, now), null, "a live price of zero is not a comparison");
  // The newest reading wins, not merely any.
  const two = log([[30 * 60000, { [TOK]: 100 }], [3 * HOUR, { [TOK]: 500 }]]);
  assert.strictEqual(ps.latestHourly(two, TOK, now).usd, 100, "the most recent hourly reading is the reference");
}

// ---- 2. a sale is skipped when the live price has left the record behind -------
{
  const l = log([[30 * 60000, { [TOK]: 100 }]]);
  const bad = ps.check(l, TOK, 130, 15, now);
  assert.strictEqual(bad.ok, false, "30% out with a 15% limit is refused");
  assert.match(bad.reason, /30\.0% from the hourly log's \$100 \(limit 15%/, `the reason carries both figures: ${bad.reason}`);
  assert.match(bad.reason, /reading 30 min old/, "and how old the record is, since a stale one is weaker evidence");

  assert.strictEqual(ps.check(l, TOK, 110, 15, now).ok, true, "a move inside the limit is allowed");
  assert.strictEqual(ps.check(l, TOK, 115, 15, now).ok, true, "exactly at the limit is allowed — it is a limit, not a bound");
}

// ---- 3. no entry is not agreement, and does not block ---------------------------
{
  // The brief's third case. A token the log has never priced must not be unsellable,
  // but the result must not claim it was checked either.
  for (const [what, l] of [
    ["no log at all", null],
    ["an empty log", { hours: {} }],
    ["no entry for this token", log([[30 * 60000, { "0xother": 5 }]])],
    ["a reading too old to mean anything", log([[9 * HOUR, { [TOK]: 100 }]])],
    ["a malformed row", log([[30 * 60000, { [TOK]: "not a number" }]])],
  ]) {
    const r = ps.check(l, TOK, 130, 15, now);
    assert.strictEqual(r.ok, true, `${what}: the sale is not blocked`);
    assert.strictEqual(r.compared, false, `${what}: and the result says no comparison was made`);
    assert.strictEqual(r.deviationPct, null, `${what}: with no figure invented`);
  }
  // A reading from the future is ignored rather than trusted.
  assert.strictEqual(ps.latestHourly({ hours: { [String(now + HOUR)]: { [TOK]: 100 } } }, TOK, now), null,
    "an hour stamped ahead of now is not a reading");
}

// ---- 4. the callers use it, and only where price level is the question ---------
{
  const sell = fs.readFileSync(path.join(__dirname, "..", "sell-v4.js"), "utf8");
  assert.match(sell, /priceSanity\.check\(readPriceLog\(\), token, livePerToken, st\.maxDeviationPct\)/,
    "the sell path checks the live price against the log");
  assert.match(sell, /maxDeviationPct: Number\(s\.maxDeviationPct \?\? 15\)/, "with a default of 15%");
  assert.ok(sell.indexOf("priceSanity.check") > sell.indexOf("st.minUsd) return skip"),
    "checked after the cheap thresholds, so a sale skipped for size costs no extra read");

  const guard = fs.readFileSync(path.join(__dirname, "..", "memecoin-guardian.js"), "utf8");
  // The guardian works in tokens-per-quote. Comparing the log's USD figure against
  // that directly is a units error that would defer closes at random, so it goes
  // through priceLogAt, which returns the same unit.
  assert.match(guard, /const hourly = priceLogAt\(s\.tokenAddress, s\.quoteAddress, t\)/,
    "the guardian converts through the helper that speaks its own unit");
  assert.ok(!/priceSanity\.deviation\([^)]*d\.price/.test(guard),
    "and never compares a USD reading against a tokens-per-quote price");
  assert.match(guard, /if \(reason && \/from entry\/\.test\(reason\)/,
    "only a drawdown close is gated — an out-of-range close depends on ticks, not price level");
  assert.match(guard, /st\.confirm = \{ n: 0/, "and a deferral restarts the confirmation streak");
}

// ---- 5. the drawdown arithmetic the guardian applies ---------------------------
{
  // tokenValue(p) = 1/p, so a fall in token value is (entry / hourly - 1).
  const drawdown = (entry, hourly) => Math.max(0, -((entry / hourly - 1) * 100));
  assert.strictEqual(Math.round(drawdown(100, 200)), 50, "the token halving in value reads as 50% down");
  assert.strictEqual(Math.round(drawdown(100, 100)), 0, "unchanged is no drawdown");
  assert.strictEqual(drawdown(100, 50), 0, "and a gain is not a drawdown");
  // A close at the 50% limit stands only if the hourly record is also past it.
  assert.ok(drawdown(100, 220) >= 50, "the record agreeing allows the close");
  assert.ok(!(drawdown(100, 120) >= 50), "the record disagreeing defers it");
}

console.log("price sanity: a live price far from the hourly record skips a sale and defers a drawdown close, no record is not agreement, and the guardian compares in its own unit");
