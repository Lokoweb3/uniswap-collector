"use strict";
// tasks/dashboard-review.js: the DOM reducer, the model-JSON normaliser, the cross-run dedupe and
// the read-only allow-list. No model call and no Chrome here.
const assert = require("assert");
const dr = require("../tasks/dashboard-review");

// 1. DOM reducer: a trimmed dashboard with fake numbers.
const html = `<!doctype html><html><head><title>LP</title><style>.x{color:red}</style><script>window.SECRET="do not ship";</script></head>
<body><header><h1>LP Dashboard</h1></header>
<section class="summary" id="summary"><div class="stat hero"><div class="n" id="networth">$12,345.67</div><div class="l">Held by this wallet</div></div>
<div class="stat pair"><div class="n sm fees" id="fees">$8.40</div><div class="l">Uncollected fees</div></div></section>
<section class="earnings" id="watchsec"><h3>Positions</h3><nav><a class="tab" href="#arm">Arm</a><a class="tab" href="#sell">Sell</a></nav>
<main id="list"><div class="empty">Reading positions from the chain…</div></main>
<span class="unpriced">2 unpriced</span><span class="stale">scanner data is stale</span>
<a href="/address/0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8">owner 0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8</a>
<button>Collect now</button><button disabled>Lock</button>
<form><input type="password" name="p" value="hunter2"></form>
<table><thead><tr><th>Token</th><th>Lots</th></tr></thead><tbody>${Array.from({ length: 9 }, (_, i) => `<tr><td>TOK${i}</td><td>${i}</td></tr>`).join("")}</tbody></table>
<svg><path d="M0 0 L100 100"/></svg></section></body></html>`;
const sk = dr.reduceDom(html);
assert.ok(sk.includes("# LP Dashboard") && sk.includes("### Positions"), "headings kept");
assert.ok(sk.includes("SECTIONS summary, watchsec"), `section ids kept: ${sk.split("\n").find((l) => l.startsWith("SECTIONS"))}`);
assert.ok(sk.includes("TABS Arm | Sell"), "tab order kept");
assert.ok(sk.includes("$12,345.67") && sk.includes("Held by this wallet"), "numbers keep their labels");
assert.ok(sk.includes("Reading positions from the chain"), "empty state kept");
assert.ok(sk.includes("! (unpriced)") && sk.includes("! (stale)"), "flagged elements listed");
assert.ok(sk.includes("Collect now") && sk.includes("Lock (disabled)"), "buttons with disabled state");
assert.ok(sk.includes("TABLE 1: Token | Lots (9 rows, first 5)") && sk.includes("  TOK4 | 4") && !sk.includes("TOK5 | 5"), "tables: headers and first five rows");
assert.ok(!sk.includes("<script") && !sk.includes("do not ship") && !sk.includes("color:red") && !sk.includes("M0 0 L100"), "scripts, styles and svg stripped");
assert.ok(!sk.includes("hunter2"), "password input stripped");
assert.ok(!sk.includes("0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8") && sk.includes("0x698C…48d8"), "long hex shortened");
assert.ok(Buffer.byteLength(sk) < dr.MAX_SKELETON, `skeleton under 6 KB (${Buffer.byteLength(sk)})`);
const big = dr.reduceDom("<div>" + Array.from({ length: 4000 }, (_, i) => `<p>line ${i} of a long page</p>`).join("") + "</div>");
assert.ok(Buffer.byteLength(big) <= dr.MAX_SKELETON && big.endsWith("(skeleton truncated)"), "oversized skeleton truncated with a note");

// 2. Normaliser: malformed model JSON never throws and yields the coerced shape.
const n1 = dr.normalizeReview('```json\n{"score":"7.4","findings":[{"severity":"bad","element":"summary","msg":"x"},{"msg":"no element"},{"element":"e","msg":"","severity":"HIGH"},{"element":"e2","msg":"ok","severity":"high","fix":5}],"keep":["a",3,"b"]}\n```', "/", 1280);
assert.strictEqual(n1.score, 7);
assert.strictEqual(n1.findings.length, 2, "findings without msg or element dropped");
assert.strictEqual(n1.findings[0].severity, "LOW", "unknown severity -> LOW");
assert.strictEqual(n1.findings[1].severity, "HIGH", "case-insensitive severity");
assert.strictEqual(n1.findings[1].fix, null, "non-string fix -> null");
assert.deepStrictEqual(n1.keep, ["a", "b"]);
assert.strictEqual(dr.normalizeReview("not json at all", "/", 375), null);
assert.strictEqual(dr.normalizeReview({ score: 99, findings: "nope" }, "/", 375).score, null);
const many = dr.normalizeReview({ findings: Array.from({ length: 10 }, (_, i) => ({ element: "e", msg: "m" + i })) }, "/", 375);
assert.strictEqual(many.findings.length, dr.MAX_FINDINGS, "capped at six");

// 3. Dedupe across runs.
const f = { page: "/", width: 1280, element: "summary", msg: "Net worth shown before fees", severity: "MEDIUM" };
const run1 = dr.applyDedupe([f], {}, 1000);
assert.strictEqual(run1.findings[0].isNew, true);
const run2 = dr.applyDedupe([f], run1.seen, 2000);
assert.strictEqual(run2.findings[0].isNew, false, "same finding on the next run is not new");
assert.strictEqual(run2.findings[0].since, 1000, "keeps its first-seen time");
const run3 = dr.applyDedupe([{ ...f, msg: "Net worth label is ambiguous" }], run2.seen, 3000);
assert.strictEqual(run3.findings[0].isNew, true, "a changed message is a new finding");
assert.strictEqual(dr.statusFor({ newHigh: 1, newAny: 3, succeeded: 12, attempted: 12 }), "🔴 UI ISSUES");
assert.strictEqual(dr.statusFor({ newHigh: 0, newAny: 3, succeeded: 12, attempted: 12 }), "🟡 UI WATCH");
assert.strictEqual(dr.statusFor({ newHigh: 0, newAny: 0, succeeded: 12, attempted: 12 }), "🟢 UI OK");
assert.strictEqual(dr.statusFor({ newHigh: 0, newAny: 0, succeeded: 0, attempted: 12 }), "⚠️ UI REVIEW FAILED");

// 4. Allow-list: a write route throws before any request is made.
(async () => {
  let called = 0;
  const fetchSpy = async () => { called++; return { ok: true, json: async () => ({}) }; };
  for (const bad of ["/api/collect", "/api/arm", "/api/tasks/run?task=pool-scan", "/api/sales/approve", "/api/positions/../collect"]) {
    await assert.rejects(dr.get(bad, fetchSpy), /not on the read-only allow-list/, `${bad} refused`);
  }
  assert.strictEqual(called, 0, "no request was made for a refused path");
  await dr.get("/api/attribution?days=7", fetchSpy);
  assert.strictEqual(called, 1, "an allowed path is fetched");
  assert.throws(() => dr.assertAllowed("/api/collect"));
  console.log("dashboard-review: reducer, normaliser, dedupe, status and read-only allow-list — all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
