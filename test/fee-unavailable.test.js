// node test/fee-unavailable.test.js — a fee read that failed must say so on the
// card face, not render as $0.00.
//
// On Arc the position loads fine and only the fee sub-call comes back empty. The
// card used to print "$0.00 uncollected", which reads as "this position has
// earned nothing" — the one thing it does not mean. The position stays visible;
// only the figure is replaced.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "feeface-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

// dashboard.js is browser code; lift the one function out of the source the way
// test/arc-phase1.test.js lifts chainRef.
const src = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
const from = src.indexOf("function feeFace(p) {");
assert.ok(from > 0, "feeFace is gone from dashboard.js — the card face no longer has a single place to fix");
const to = src.indexOf("\n}", from) + 2;
const usd = (n) => "$" + Number(n || 0).toFixed(2);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const feeFace = new Function("usd", "esc", src.slice(from, to) + "; return feeFace;")(usd, esc);

// ---- a successful read is unchanged -----------------------------------------
{
  const html = feeFace({ feesOk: true, feesUsd: 12.3456 });
  assert.ok(html.includes("$12.35 uncollected"), "a good read still shows the figure: " + html);
  assert.ok(!/unavail/.test(html), "and is not marked unavailable");
}

// ---- a genuine zero is still a zero -----------------------------------------
{
  const html = feeFace({ feesOk: true, feesUsd: 0 });
  assert.ok(html.includes("$0.00 uncollected"), "a real zero is reported as zero: " + html);
  assert.ok(html.includes('class="f zero"'), "and keeps its muted styling");
}

// ---- a failed read says so, and never prints a number -----------------------
{
  const html = feeFace({ feesOk: false, feesUsd: 0, feesError: "missing revert data" });
  assert.ok(html.includes("Fees unavailable"), "the face must say the fees are unavailable: " + html);
  assert.ok(!/\$\d/.test(html), "a failed read must not print a dollar figure at all: " + html);
  assert.ok(html.includes("missing revert data"), "the reason is carried in the tooltip");
  assert.ok(html.includes("unavail"), "and it is styled as a gap, not a value");
}

// ---- a failed read with no reason still refuses to show zero ----------------
{
  const html = feeFace({ feesOk: false, feesUsd: 0 });
  assert.ok(html.includes("Fees unavailable"), "no reason is not a reason to print zero: " + html);
  assert.ok(!/\$\d/.test(html));
}

// ---- the reason is escaped ---------------------------------------------------
{
  const html = feeFace({ feesOk: false, feesError: '"><img src=x onerror=bad()>' });
  assert.ok(!html.includes("<img"), "the error text is attacker-shaped data and must be escaped: " + html);
}

// ---- undefined feesOk is treated as a good read, not a failure --------------
// Older payloads and the risk cards do not set the flag; they must not all turn
// into "unavailable".
{
  const html = feeFace({ feesUsd: 3 });
  assert.ok(html.includes("$3.00 uncollected"), "an absent flag is not a failure: " + html);
}

// ---- both card faces route through it ---------------------------------------
{
  const uses = (src.match(/\$\{feeFace\(p\)\}/g) || []).length;
  assert.strictEqual(uses, 2, "the owner card and the watched card must both use it, found " + uses);
  // The helper itself legitimately contains that template; check everything else.
  const outside = src.slice(0, from) + src.slice(to);
  assert.ok(!/usd\(p\.feesUsd\)\} uncollected/.test(outside),
    "a card face is still printing the raw figure without the failure check");
}

console.log("fee display: a failed read says Fees unavailable and never prints zero, a real zero still does");
