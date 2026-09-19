// node test/guardian-latch.test.js — the alert-only latch is a latch, and a
// threshold below its floor is refused rather than obeyed.
//
// Two faults, one consequence: the guardian could be configured, through the normal
// UI path, into closing every position it watches.
//
//   - setRule contained `if (next.autoClose) next.alertOnly = false;`. Turning on
//     auto-close silently released the latch that exists to stop it acting. A latch
//     a neighbouring switch can open is not a latch.
//   - rulesOf accepted closePct: 0. shouldClose fires when the drawdown is at or
//     past the limit, so a limit of zero closes a position that has not moved:
//     verified as "price 0% from entry (limit -0%)" on a position with no drawdown,
//     in range, healthy fees.
//
// Together: turn on auto-close, leave a zero in the close field, and everything
// closes.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { rulesOf, shouldClose, RULE_DEFAULTS, RULE_MINIMUMS } = require("../guardian-logic");

// ---- 1. the latch survives auto-close ------------------------------------------
{
  const r = rulesOf({ autoClose: true }, {});
  assert.strictEqual(r.autoClose, true, "auto-close is on");
  assert.strictEqual(r.alertOnly, true, "and the latch is still closed — it was not inferred away");

  // Lowered only by saying so.
  const both = rulesOf({ autoClose: true, alertOnly: false }, {});
  assert.strictEqual(both.alertOnly, false, "explicitly clearing it works");

  // The write path no longer contains the flip at all.
  const guard = fs.readFileSync(path.join(__dirname, "..", "memecoin-guardian.js"), "utf8");
  assert.ok(!/if \(next\.autoClose\) next\.alertOnly = false/.test(guard),
    "setRule does not clear the latch as a side effect");
  // And the page sends both, so the owner's intent still reaches the server.
  const dash = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
  assert.ok(/postRule\(\{ tokenId: nftId, autoClose: on, alertOnly: !on \}\)/.test(dash),
    "the toggle states both fields rather than relying on the server to infer one");
}

// ---- 2. the close limit that closes everything ---------------------------------
{
  // The behaviour, before anything about configuration: a zero limit fires on a
  // position that has not moved.
  const zero = { ...RULE_DEFAULTS, closePct: 0 };
  assert.ok(shouldClose({ canClose: true, rules: zero, drawdownPct: 0, priceVsEntryPct: 0, inRange: true, outMinutes: 0 }),
    "with closePct 0 a healthy position is closeable — which is why 0 must not be settable");
  assert.strictEqual(shouldClose({ canClose: true, rules: RULE_DEFAULTS, drawdownPct: 0, priceVsEntryPct: 0, inRange: true, outMinutes: 0 }), null,
    "at the default it is not");
}

// ---- 3. below-floor values are refused on write --------------------------------
{
  // setRule is bound to settings and the chain, so the rule it enforces is checked
  // here directly, in the same form.
  const guard = fs.readFileSync(path.join(__dirname, "..", "memecoin-guardian.js"), "utf8");
  assert.ok(/const floor = logic\.RULE_MINIMUMS\[k\];/.test(guard), "setRule consults the floors");
  assert.ok(/throw new Error\(`\$\{k\} must be at least \$\{floor\}/.test(guard), "and refuses, rather than clamping");

  assert.deepStrictEqual(RULE_MINIMUMS, { closePct: 5, alertPct: 1, outOfRangeMinutes: 15, tvlDropPct: 5 },
    "the floors are the ones the brief asked for");
  for (const [k, floor] of Object.entries(RULE_MINIMUMS)) {
    assert.ok(RULE_DEFAULTS[k] >= floor, `the default for ${k} is not itself below the floor`);
  }
}

// ---- 4. a configuration already on disk still loads ----------------------------
{
  // Reading must never throw: one bad entry would stop the guardian watching
  // everything else. A below-floor value falls back to the default — the more
  // cautious of the two — and is named, so it is not silently a different number.
  const r = rulesOf({ closePct: 0, autoClose: true, alertOnly: false }, {});
  assert.strictEqual(r.closePct, RULE_DEFAULTS.closePct, "the unsafe close limit reverts to the default");
  assert.deepStrictEqual(r.unsafe, ["closePct"], "and says which value was refused");
  assert.strictEqual(r.autoClose, true, "the rest of the entry is honoured");
  assert.strictEqual(shouldClose({ canClose: true, rules: r, drawdownPct: 0, priceVsEntryPct: 0, inRange: true, outMinutes: 0 }), null,
    "so the loaded config no longer closes a healthy position");

  // Ordinary configurations are untouched and carry no flag.
  const ok = rulesOf({ closePct: 40, alertPct: 15, outOfRangeMinutes: 60, tvlDropPct: 30 }, {});
  assert.strictEqual(ok.closePct, 40);
  assert.strictEqual(ok.unsafe, undefined, "a sound config is not flagged");
  // A value exactly at the floor is allowed: the floor is a minimum, not a bound.
  assert.strictEqual(rulesOf({ closePct: 5 }, {}).closePct, 5);
  assert.strictEqual(rulesOf({ closePct: 5 }, {}).unsafe, undefined);
}

console.log("guardian latch: auto-close no longer releases alert-only, a close limit under 5% is refused on write, and a file already holding one loads with the default and says so");
