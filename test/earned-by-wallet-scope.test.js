// node test/earned-by-wallet-scope.test.js — "Earned by wallet" lists the wallets this
// instance has tracked on this chain, and nothing else.
//
// The Arc instance is configured with every wallet, but only Arc LP was ever used
// there. The table showed the other four anyway: SEAL, Trading and LP Rewards as
// $0.00 across every column, and Main as "loading…" indefinitely. Both are claims
// that were not true. A zero says "we watched this and it earned nothing"; nothing
// was watched. "Loading…" says a request is still in flight; /api/daily had already
// answered {"ok":true,"hours":[]}, which is an answer, not a wait.
//
// Hiding them silently would be its own fault — a wallet that vanishes looks like a
// wallet that was lost — so they are counted under the table by name.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
const from = src.indexOf("\nfunction renderEarnedByWallet(");
assert.ok(from >= 0, "renderEarnedByWallet is gone from dashboard.js");
const body = src.slice(from, src.indexOf("\n}\n", from) + 3);

// An empty answer must be distinguishable from one that has not arrived.
assert.match(src, /let dailyState = 'loading'/, "the daily series records what came back, not just whether it did");
assert.match(src, /if \(!d\.hours\.length\) \{ dailyState = 'empty'/, "an empty series is recorded as empty, not left looking unfinished");

function run({ dailyState = "ok", dailyD = { hours: [1] }, wallets = [] } = {}) {
  const out = { innerHTML: "" };
  const f = new Function("$", "dailyState", "dailyD", "watchForAnalytics", "ownerName", "dailyModel",
    "dayKey", "dayLabel", "walletName", "usd",
    body + "; return renderEarnedByWallet;")(
    (s) => (s === "#walletearn" ? out : null),
    dailyState, dailyD, { wallets },
    () => "Main (0x698C…48d8)",
    () => ({ all: [{ key: "2026-09-16", total: 12.5 }] }),
    () => "2026-09-16",
    (d) => String(d).slice(5),
    (w) => w.label,
    (n) => "$" + Number(n).toFixed(2));
  f();
  return out.innerHTML;
}

const ARC_LP = { ok: true, label: "Arc LP", earned: { since: "2026-09-16", today: 24.247, d7: 207.46, d30: 207.46, all: 207.46 } };
const NEVER = (label) => ({ ok: true, label, earned: { since: null, today: 0, d7: 0, d30: 0, all: 0 } });

// ---- 1. Arc: one wallet was used, one wallet is listed -------------------------
{
  const html = run({ dailyState: "empty", dailyD: null,
    wallets: [ARC_LP, NEVER("SEAL wallet"), NEVER("Trading"), NEVER("LP Rewards")] });
  assert.ok(html.includes("Arc LP"), "the wallet that was used is listed");
  for (const w of ["SEAL wallet", "Trading", "LP Rewards"]) {
    assert.ok(!new RegExp(`<td class="l">${w}</td>`).test(html), `${w} has no row of zeros`);
    assert.ok(html.includes(w), `${w} is still named under the table, not silently dropped`);
  }
  assert.ok(/4 other wallets are configured but have never been tracked on this chain/.test(html),
    `the hidden wallets are counted, including Main: ${html.slice(-260)}`);
  assert.ok(!/loading…/.test(html), "Main is not described as loading when /api/daily has already answered");
  assert.strictEqual((html.match(/<tr><td/g) || []).length, 1, "exactly one wallet row beneath the header");
}

// ---- 2. Robinhood: a wallet with a tracking date stays, even at zero -----------
{
  // Zero is a measurement when there is a date behind it, and must not be hidden.
  const tracked = { ok: true, label: "Trading", earned: { since: "2026-09-07", today: 0, d7: 0, d30: 0, all: 0 } };
  const html = run({ wallets: [tracked, NEVER("SEAL wallet")] });
  assert.ok(/<td class="l">Trading<\/td>/.test(html), "a tracked wallet stays even when every figure is zero");
  assert.ok(!/<td class="l">SEAL wallet<\/td>/.test(html), "an untracked one does not");
  assert.ok(/One other wallet is configured but has never been tracked/.test(html), "and the count reads as English for one");
  assert.ok(/<td class="l">Main \(0x698C…48d8\)<\/td>/.test(html), "the owner wallet is listed from its own series");
}

// ---- 3. a wallet measured but with no start date is still shown ----------------
{
  // Some sources report figures without a start date. A measured amount is evidence
  // of tracking on its own; dropping it would lose money from the page.
  const odd = { ok: true, label: "Odd", earned: { since: null, today: 0, d7: 0, d30: 0, all: 1.5 } };
  const html = run({ wallets: [odd] });
  assert.ok(/<td class="l">Odd<\/td>/.test(html), "a measured figure keeps the wallet even with no start date");
}

// ---- 4. loading and failure are still told apart ------------------------------
{
  assert.ok(/loading…/.test(run({ dailyState: "loading", dailyD: null })), "a request in flight still says so");
  const failed = run({ dailyState: "failed", dailyD: null });
  assert.ok(/could not be read/.test(failed), "a failed read says that, rather than reporting zero");
  assert.ok(!/\$0\.00/.test(failed), "and never invents a figure for it");
}

// ---- 5. nothing tracked at all: the note stands alone --------------------------
{
  const html = run({ dailyState: "empty", dailyD: null, wallets: [NEVER("SEAL wallet")] });
  assert.ok(!/<table/.test(html), "no table of nothing");
  assert.ok(/never been tracked on this chain/.test(html), "but the page still accounts for the wallets");
}

console.log("earned by wallet: only wallets tracked on this chain are listed, the rest are counted by name, and loading, failed and empty are three different things");
