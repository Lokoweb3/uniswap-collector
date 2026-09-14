"use strict";
/**
 * tasks/dashboard-review.js — the dashboard reviewed as a product, every 6 h from run-all.sh.
 *
 * Loads each page at desktop and phone width from the LIVE dashboard (real data is the point),
 * reduces the rendered page to a text skeleton, saves a screenshot for the human reader, and
 * asks the review model for at most six ranked, element-tied findings per page-width. Findings
 * are fingerprinted across runs so the same six suggestions do not repeat every 6 h: only new
 * ones count toward the status. Output: tasks/output/dashboard-review.json, a section in
 * brain/proposals.md, tasks/output/screens/*.png.
 *
 * Read-only by construction: every request goes through get(), which refuses any path not on
 * ALLOW before a byte is sent, and there is no POST helper. Nothing is clicked or submitted.
 * Exit 0 without OLLAMA_API_KEY (one line), and the JSON is still written when Chrome or the
 * model is unavailable (failedPages says which page-widths were skipped).
 */
require("dotenv").config({ quiet: true });
const fs = require("fs");
const path = require("path");
const { PAGES, loadPage, CHROME } = require("../test/smoke-lib");
const { appendWithRotation, createModel, stripFence, normSeverity } = require("./lib");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(__dirname, "output");
const OUT = path.join(OUT_DIR, "dashboard-review.json");
const SEEN = path.join(OUT_DIR, "dashboard-review-seen.json");
const SCREENS = path.join(OUT_DIR, "screens");
const BRAIN = path.join(ROOT, "brain", "proposals.md");
const BASE = (process.env.LP_DASHBOARD_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const WIDTHS = [1280, 375];
const TIME_CAP_MS = 20 * 60 * 1000;
const MAX_SKELETON = 6 * 1024;
const MAX_FINDINGS = 6;

// The only routes this script may read. A path outside the list throws before any request.
const ALLOW = new Set(["/api/daily", "/api/risk", "/api/positions", "/api/attribution", "/api/sales/pending", "/api/watch"]);
function assertAllowed(p) {
  const base = String(p).split("?")[0];
  if (!ALLOW.has(base)) throw new Error(`dashboard-review: ${p} is not on the read-only allow-list`);
  return p;
}
async function get(p, fetchImpl = globalThis.fetch) {
  assertAllowed(p);
  const r = await fetchImpl(`${BASE}${p}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${p}`);
  return r.json();
}

// ---- DOM -> text skeleton -------------------------------------------------------------------
const strip = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#8646;|&#[0-9]+;/g, "").replace(/\s+/g, " ").trim();
const shortHex = (s) => s.replace(/0x[0-9a-fA-F]{13,}/g, (m) => `${m.slice(0, 6)}…${m.slice(-4)}`);
function reduceDom(html, { max = MAX_SKELETON } = {}) {
  let h = String(html || "");
  h = h.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["script", "style", "svg", "noscript", "template"]) h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  h = h.replace(/<input\b[^>]*type=["']?password["']?[^>]*>/gi, " ");
  const out = [];
  // Headings, in order.
  const heads = [];
  for (const m of h.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) { const t = strip(m[2]); if (t) heads.push(`${"#".repeat(Number(m[1]))} ${t}`); }
  if (heads.length) out.push("HEADINGS", ...heads);
  // Landmarks and tabs.
  const ids = [...new Set([...h.matchAll(/<(?:section|main|article|nav)\b[^>]*\sid=["']([^"']+)["']/gi)].map((m) => m[1]))];
  if (ids.length) out.push("SECTIONS " + ids.join(", "));
  const tabs = [...h.matchAll(/<(?:a|button)\b[^>]*(?:role=["']tab["']|class=["'][^"']*\btab\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:a|button)>/gi)].map((m) => strip(m[1])).filter(Boolean);
  if (tabs.length) out.push("TABS " + tabs.join(" | "));
  // Tables: headers and the first five rows.
  let ti = 0;
  for (const tm of h.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    ti++;
    const th = [...tm[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => strip(m[1]));
    const rows = [...tm[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => strip(c[1]))).filter((r) => r.length);
    if (!th.length && !rows.length) continue;
    out.push(`TABLE ${ti}${th.length ? ": " + th.join(" | ") : ""}${rows.length > 5 ? ` (${rows.length} rows, first 5)` : ""}`);
    for (const r of rows.slice(0, 5)) out.push("  " + r.join(" | "));
  }
  // Flagged elements: warnings, stale markers, empty states, errors.
  const flagged = [];
  for (const m of h.matchAll(/<([a-z]+)\b[^>]*class=["']([^"']*\b(?:warn|alert|stale|error|empty|unpriced|approx|neg|out|bad)\b[^"']*)["'][^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = strip(m[3]); if (t && t.length < 200) flagged.push(`! (${m[2].trim().split(/\s+/).slice(0, 2).join(" ")}) ${t}`);
    if (flagged.length >= 20) break;
  }
  if (flagged.length) out.push("FLAGGED", ...[...new Set(flagged)]);
  // Controls.
  const buttons = [...h.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)].map((m) => `${strip(m[2])}${/\bdisabled\b/i.test(m[1]) ? " (disabled)" : ""}`).filter((b) => b.trim() && b.length < 60);
  if (buttons.length) out.push("BUTTONS " + [...new Set(buttons)].join(" | "));
  // Everything visible, as lines: numbers with their labels survive here.
  const text = strip(h.replace(/<\/(?:div|p|li|tr|section|article|h[1-6]|span|td|th|label)>/gi, "\n"));
  const lines = [...new Set(text.split(/\s*\n\s*|\s{2,}/).map((l) => shortHex(l.trim())).filter((l) => l.length > 1))];
  if (lines.length) out.push("TEXT", ...lines);
  let s = out.join("\n");
  if (Buffer.byteLength(s) > max) s = Buffer.from(s).subarray(0, max - 40).toString().replace(/[^\n]*$/, "") + "\n… (skeleton truncated)";
  return s;
}

// ---- context from the data the page is built from -------------------------------------------
async function contextFor(pagePath, fetchImpl) {
  const safe = async (p, pick) => { try { return pick(await get(p, fetchImpl)); } catch (e) { return `unavailable: ${e.message}`; } };
  const lines = [];
  if (pagePath === "/") {
    lines.push("Daily text: " + (await safe("/api/daily", (d) => String(d.text || "").slice(0, 1500))));
    lines.push("Risk rows: " + (await safe("/api/risk", (d) => (d.positions || []).map((p) => `${p.wallet} ${p.pair} #${p.tokenId} ${p.status}${p.inRange ? "" : " out-of-range"} fees/h $${Number(p.feesPerHour || 0).toFixed(2)} verdict ${p.verdict && p.verdict.verdict}`).join("; ") || "none")));
  } else if (pagePath === "/analytics") {
    lines.push("Attribution 7 d totals: " + (await safe("/api/attribution?days=7", (d) => JSON.stringify(d.book && d.book.totals ? Object.fromEntries(Object.entries(d.book.totals).map(([k, v]) => [k, typeof v === "number" ? +v.toFixed(2) : v])) : null))));
    lines.push("Benchmarks: " + (await safe("/api/attribution?days=7", (d) => JSON.stringify((d.benchmarks || []).map((b) => ({ windowDays: b.windowDays, actualDays: b.actualDays, portfolioPct: b.portfolioPct, ethPct: b.ethPct, stakingPct: b.stakingPct, note: b.note }))))));
  } else {
    lines.push("Open positions (main): " + (await safe("/api/positions", (d) => (d.positions || []).map((p) => `${p.pair} #${p.tokenId} value $${Math.round(p.valueUsd || 0)} fees $${(p.feesUsd || 0).toFixed(2)} ${p.inRange ? "in range" : "OUT of range"}`).join("; ") || "none")));
    lines.push("Pending fee-token sales: " + (await safe("/api/sales/pending", (d) => { const rows = d.rows || d.pending || d.sales || []; return rows.length ? rows.slice(0, 3).map((r) => `${r.symbol || r.token} ${r.amount || ""} ≈ $${r.usd || "?"} ${r.status || ""}`).join("; ") + (rows.length > 3 ? ` (+${rows.length - 3})` : "") : "none"; })));
    const tab = pagePath.includes("#") ? pagePath.split("#")[1] : "arm";
    lines.push(`Wallet tab open: ${tab}`);
  }
  return lines.join("\n");
}

// ---- the model call and its untrusted JSON --------------------------------------------------
function prompt(pagePath, width, skeleton, context) {
  return `You are reviewing one page of a private dashboard used by a single Uniswap LP operator on Robinhood Chain to watch positions, fees, risk and a treasury vault, and to sell fee tokens and mint positions from their wallet. Below is the page's visible text skeleton at ${width} px, and the data the page is built from. Judge only what the operator sees: hierarchy (is the most important number first?), clarity of labels, stale or missing data, dead ends (a state with no next action), mobile layout at 375 px, and anything shown that the data contradicts.

Page: ${pagePath} at ${width} px

=== PAGE SKELETON ===
${skeleton}

=== DATA THE PAGE IS BUILT FROM ===
${context}

Respond ONLY as JSON: {"page":"${pagePath}","width":${width},"score":1-10,"findings":[{"severity":"HIGH|MEDIUM|LOW","element":"section id or heading","msg":"what is wrong","fix":"one concrete change"}],"keep":["what works and must not change"]}. Max ${MAX_FINDINGS} findings; HIGH only for wrong or misleading information, never for taste.`;
}
function normalizeReview(raw, pagePath, width) {
  let r = raw;
  if (typeof raw === "string") { try { r = JSON.parse(stripFence(raw)); } catch { r = null; } }
  if (!r || typeof r !== "object") return null;
  const score = Math.round(Number(r.score));
  const findings = (Array.isArray(r.findings) ? r.findings : []).filter((f) => f && typeof f.msg === "string" && f.msg.trim() && typeof f.element === "string" && f.element.trim())
    .map((f) => ({ severity: normSeverity(f.severity), element: f.element.trim().slice(0, 120), msg: f.msg.trim().slice(0, 500), fix: typeof f.fix === "string" ? f.fix.trim().slice(0, 500) : null }))
    .slice(0, MAX_FINDINGS);
  const keep = (Array.isArray(r.keep) ? r.keep : []).filter((k) => typeof k === "string" && k.trim()).map((k) => k.trim().slice(0, 200)).slice(0, 8);
  return { page: pagePath, width, score: Number.isInteger(score) && score >= 1 && score <= 10 ? score : null, findings, keep };
}

// ---- dedupe across runs -----------------------------------------------------------------------
const fingerprint = (f) => `${f.page}|${f.width}|${f.element.toLowerCase()}|${f.msg.toLowerCase().slice(0, 40)}`;
function applyDedupe(findings, seen, now) {
  const next = { ...seen };
  const out = findings.map((f) => {
    const k = fingerprint(f);
    const first = next[k];
    if (!first) next[k] = now;
    return { ...f, isNew: !first, since: first || now };
  });
  return { findings: out, seen: next };
}
function statusFor({ newHigh, newAny, succeeded, attempted }) {
  if (attempted > 0 && succeeded === 0) return "⚠️ UI REVIEW FAILED";
  if (newHigh > 0) return "🔴 UI ISSUES";
  if (newAny > 0) return "🟡 UI WATCH";
  return "🟢 UI OK";
}
const slug = (p) => (p === "/" ? "home" : p.replace(/^\//, "").replace(/#/, "-").replace(/[^a-z0-9-]/gi, "")) || "home";
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

// ---- main ------------------------------------------------------------------------------------
async function main() {
  const started = Date.now();
  const model = createModel();
  if (!model.enabled) { console.log("[dashboard-review] OLLAMA_API_KEY not set — skipping"); return 0; }
  fs.mkdirSync(SCREENS, { recursive: true });
  const seen0 = readJson(SEEN, {});
  let seen = seen0;
  const ts = new Date().toISOString();
  const pages = [];
  const failedPages = [];
  const chromeOk = fs.existsSync(CHROME);
  if (!chromeOk) console.warn(`[dashboard-review] Chrome not found at ${CHROME}; pages cannot be captured`);
  console.log(`[dashboard-review] ${PAGES.length} pages × ${WIDTHS.length} widths from ${BASE} (${model.model})`);
  for (const p of PAGES) for (const width of WIDTHS) {
    const label = `${p.path}@${width}`;
    if (Date.now() - started > TIME_CAP_MS) { failedPages.push({ page: p.path, width, reason: "time cap" }); continue; }
    if (!chromeOk) { failedPages.push({ page: p.path, width, reason: "chrome missing" }); continue; }
    const shot = path.join(SCREENS, `${slug(p.path)}-${width}.png`);
    let cap = loadPage(`${BASE}${p.path}`, width, { screenshot: shot });
    if (cap.status !== 0 || !cap.dom.includes(p.marker)) cap = loadPage(`${BASE}${p.path}`, width, { screenshot: shot }); // one retry, like smoke.js
    if (cap.status !== 0 || !cap.dom.includes(p.marker)) { failedPages.push({ page: p.path, width, reason: cap.status !== 0 ? `chrome exited ${cap.status}` : "marker missing" }); console.warn(`[dashboard-review] ${label}: capture failed`); continue; }
    const skeleton = reduceDom(cap.dom);
    const context = await contextFor(p.path);
    const pr = prompt(p.path, width, skeleton, context);
    const linesSent = pr.split("\n").length;
    console.log(`[dashboard-review] ${label}: ${Buffer.byteLength(skeleton)} B skeleton, ${linesSent} lines to the model...`);
    let review = null, error = null;
    try { review = normalizeReview(await model.call(pr, { timeoutMs: model.budgetForLines(linesSent) }), p.path, width); if (!review) error = "model reply was not a JSON object"; }
    catch (e) { error = e.message; }
    if (!review) { failedPages.push({ page: p.path, width, reason: error }); console.warn(`[dashboard-review] ${label}: ${error}`); continue; }
    const dd = applyDedupe(review.findings, seen, Date.now());
    seen = dd.seen;
    pages.push({ ...review, findings: dd.findings, screenshot: cap.screenshotOk ? path.relative(ROOT, shot) : null, consoleErrors: cap.errors.length });
  }
  const allFindings = pages.flatMap((pg) => pg.findings.map((f) => ({ ...f, page: pg.page, width: pg.width })));
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  allFindings.sort((a, b) => (a.isNew === b.isNew ? 0 : a.isNew ? -1 : 1) || order[a.severity] - order[b.severity]);
  const newAny = allFindings.filter((f) => f.isNew).length;
  const newHigh = allFindings.filter((f) => f.isNew && f.severity === "HIGH").length;
  const attempted = PAGES.length * WIDTHS.length;
  const status = statusFor({ newHigh, newAny, succeeded: pages.length, attempted });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ ts, status, base: BASE, model: model.model, pages, allFindings, failedPages, newFindings: newAny, elapsedMs: Date.now() - started }, null, 2));
  fs.writeFileSync(SEEN, JSON.stringify(seen));
  // proposals.md section
  const lines = ["", "---", `## Dashboard Review — ${ts}`, `**${status}** | ${allFindings.length} findings (${newAny} new) across ${pages.length}/${attempted} page-widths${failedPages.length ? ` · ${failedPages.length} skipped` : ""}`, ""];
  if (pages.length) {
    lines.push("### Page scores", "| Page | Width | Score | Findings | Screenshot |", "|---|---|---|---|---|");
    for (const pg of pages) lines.push(`| ${pg.page} | ${pg.width} | ${pg.score ?? "?"}/10 | ${pg.findings.length} | ${pg.screenshot || "—"} |`);
    lines.push("");
  }
  if (allFindings.length) {
    lines.push("### Findings");
    for (const f of allFindings) lines.push(`- ${f.isNew ? "**NEW** " : ""}[${f.severity}] ${f.page}@${f.width} · ${f.element} — ${f.msg}${f.fix ? `\n  → ${f.fix}` : ""}${f.isNew ? "" : ` _(since ${new Date(f.since).toISOString().slice(0, 10)})_`}`);
    lines.push("");
  }
  const keeps = pages.filter((pg) => pg.keep.length).map((pg) => `- ${pg.page}@${pg.width}: ${pg.keep.join("; ")}`);
  if (keeps.length) lines.push("### Keep", ...keeps, "");
  if (failedPages.length) lines.push("### Skipped", ...failedPages.map((f) => `- ${f.page}@${f.width}: ${f.reason}`), "");
  lines.push(`Screens: ${path.relative(ROOT, SCREENS)}/`, "---", "");
  appendWithRotation(BRAIN, lines.join("\n"), { tag: "dashboard-review" });
  console.log(`[dashboard-review] ${status} — ${allFindings.length} findings (${newAny} new), ${pages.length}/${attempted} page-widths, ${Math.round((Date.now() - started) / 1000)}s`);
  for (const f of allFindings.filter((x) => x.isNew).slice(0, 5)) console.log(`  [${f.severity}] ${f.page}@${f.width} · ${f.element}: ${f.msg}`);
  return 0;
}

module.exports = { reduceDom, contextFor, prompt, normalizeReview, applyDedupe, fingerprint, statusFor, assertAllowed, get, ALLOW, slug, MAX_SKELETON, MAX_FINDINGS };

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => { console.error("[dashboard-review] fatal:", e.message); process.exit(1); });
}
