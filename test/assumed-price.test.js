// node test/assumed-price.test.js — a price carried from another token is an
// assumption, and the page says how much of the total rests on one.
//
// sNET is 81% of the main wallet — $8,411 of $10,363 — and it is not priced by any
// market. It has no v4 pool against WETH or USDG on this chain, no v2 pair, and no
// exchange-rate function to ask; settings.json says to value it one for one against
// NET, so that is what happens. The holding is real. The ratio is a configured guess,
// and nothing on the page distinguished the two: the largest figure in the portfolio
// looked exactly like the ones read from pools.
//
// The page already says what is missing for want of a price. This says what is
// present on an assumption.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const portfolio = fs.readFileSync(path.join(ROOT, "portfolio.js"), "utf8");
const dash = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");

// ---- 1. the flag is derived from the price's origin, not threaded through -----
{
  // It was first written to ride along from priceOf(). That misses a token whose
  // price came from the `prices` cache instead, which is the common path once one
  // pass has run — the flag would silently be false for the very token it is for.
  assert.match(portfolio, /const assumed = !!\(via && price != null\) \|\| !!\(priceVia\[x\.addr\] && price != null\)/,
    "assumed is decided from `via` and the priceVia map, whichever path found the price");
  assert.strictEqual((portfolio.match(/const assumed = !!\(via/g) || []).length, 2,
    "on both row builders, or one scope would report differently from the other");
}

// ---- 2. the sum, and what it is a sum of --------------------------------------
{
  const rows = [
    { symbol: "sNET", via: "NET", assumed: true, usd: 8411.7 },
    { symbol: "USDG", via: null, assumed: false, usd: 2508.58 },
    { symbol: "ETH", via: null, assumed: false, usd: 294.69 },
    { symbol: "DEAD", via: "NET", assumed: true, usd: null },   // priced via, but unpriced
  ];
  const assumedUsd = +rows.filter((r) => r.assumed).reduce((t, r) => t + (r.usd || 0), 0).toFixed(2);
  assert.strictEqual(assumedUsd, 8411.7, "only the assumed rows are summed, and a null contributes nothing");

  // It is part of the total, not additional to it: the money is held either way.
  const totalUsd = rows.reduce((t, r) => t + (r.usd || 0), 0);
  assert.ok(assumedUsd < totalUsd, "the assumed figure is inside the total");
  assert.strictEqual(Math.round((assumedUsd / totalUsd) * 100), 75, "and its share is of that same total");
}

// ---- 3. it survives the merged view -------------------------------------------
{
  // Scopes other than the owner rebuild totals in the browser. The first version
  // computed assumedUsd only on the server, so choosing "all wallets" — the view
  // where the figure is largest — silently dropped it.
  assert.match(dash, /totals\.assumedUsd = \+rows\.filter\(x => x\.assumed\)/,
    "the merged scope re-sums the assumption rather than losing it");
  assert.match(dash, /totals\.assumedTokens = rows\.filter\(x => x\.assumed\)/,
    "and keeps the list of which tokens they are");
}

// ---- 4. the page states it, with what it rests on ------------------------------
{
  assert.match(dash, /totals\.assumedUsd \? /, "the panel shows the figure only when there is one");
  assert.match(dash, /assumed\$\{totals\.totalUsd \? ` \(\$\{Math\.round\(totals\.assumedUsd \/ totals\.totalUsd \* 100\)\}% of the total\)`/,
    "as a share of the total, since the absolute figure alone does not convey four fifths");
  assert.ok(/function assumedTip\(totals\)/.test(dash), "and a tooltip explains the basis");
  const tip = dash.slice(dash.indexOf("function assumedTip(totals)"), dash.indexOf("function renderPortfolio("));
  assert.ok(/valued as \$\{t\.via/.test(tip), "naming the token it is valued against");
  assert.ok(/Nothing on chain confirms that ratio/.test(tip), "and saying plainly that nothing confirms the ratio");
  assert.ok(/The holding is real/.test(tip), "while not implying the holding itself is in doubt");
}

// ---- 5. nothing is excluded from the total on account of being assumed ---------
{
  // The temptation is to drop it, as unpriced tokens are dropped. That would be
  // wrong: the tokens are held, and removing four fifths of a wallet because its
  // exchange rate is unconfirmed would be a far bigger misstatement than keeping it.
  assert.ok(!/filter\(\(r\) => !r\.assumed\)/.test(portfolio), "assumed rows stay in the totals");
  assert.match(portfolio, /assumedUsd: \+rows\.filter\(\(r\) => r\.assumed\)/, "they are counted, not removed");
}

console.log("assumed price: a carried price is marked wherever it came from, summed into a figure the page shows beside the total, and never quietly dropped from it");
