#!/usr/bin/env node
/**
 * repair-portfolio-spike.js — drop portfolio samples that are misreads, not values.
 *
 * portfolio-all.json keeps one point per hour forever. A single bad price read gets
 * kept with the rest: on 2026-09-17 one sample recorded the owner at 6.7e37 and a
 * watched wallet at 1.4e38, while the main-wallet series priced the same minute sat
 * at $12,400. Because the chart scales to its maximum, that one point flattened
 * eleven days of real history into the bottom axis and printed an axis label of
 * $2,342,677,137,524,212,700,000,000,000,000,000,000,000.00.
 *
 * A value that large is not a portfolio that grew; it is a token priced wrongly by
 * thirty-odd orders of magnitude. It cannot be corrected -- the prices behind it were
 * never recorded -- so the sample is removed rather than kept or replaced with a
 * guess. Nothing else is touched, and the gap it leaves is an hour with no reading,
 * which is what actually happened.
 *
 * A point is removed only when the series itself says it is impossible: more than
 * 100x the median of the 24 points around it. That needs no absolute ceiling and
 * moves with the portfolio.
 *
 * DRY RUN BY DEFAULT.
 *   node tools/repair-portfolio-spike.js
 *   node tools/repair-portfolio-spike.js --apply
 */
"use strict";

const fs = require("fs");
const path = require("path");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const APPLY = process.argv.includes("--apply");
const DATA = arg("data-dir", process.env.LP_DATA_DIR || path.join(__dirname, ".."));
const FILE = path.join(DATA, "portfolio-all.json");
const FACTOR = Number(arg("factor", 100));

const usd = (n) => (Math.abs(n) >= 1e12 ? `$${n.toExponential(3)}` : `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);

function main() {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const pts = raw.points;
  if (!Array.isArray(pts)) throw new Error("unrecognised shape: no points array");
  console.log(`\n${FILE}`);
  console.log(`  ${pts.length} point(s)\n`);

  // Each point is judged against its own neighbourhood, so a portfolio that really
  // grew over months is never mistaken for a spike.
  const suspect = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!Number.isFinite(p.total)) { suspect.push({ p, i, why: "total is not a number" }); continue; }
    const near = pts.slice(Math.max(0, i - 12), i + 13)
      .filter((q, j) => j !== Math.min(i, 12) && Number.isFinite(q.total) && q.total > 0)
      .map((q) => q.total).sort((a, b) => a - b);
    if (near.length < 6) continue;
    const median = near[Math.floor(near.length / 2)];
    if (median > 0 && p.total > median * FACTOR) {
      suspect.push({ p, i, why: `${usd(p.total)} against a local median of ${usd(median)}` });
    }
  }

  if (!suspect.length) { console.log("Nothing looks impossible. No change."); return; }
  for (const { p, why } of suspect) {
    console.log(`  REMOVE ${new Date(p.t).toISOString()}  ${why}`);
    const worst = Object.entries(p.wallets || {}).sort((a, b) => b[1] - a[1])[0];
    console.log(`         owner ${usd(p.owner)}${worst ? `, largest wallet ${worst[0].slice(0, 10)}… ${usd(worst[1])}` : ""}`);
  }
  const kept = pts.filter((p) => !suspect.some((s) => s.p === p));
  const totals = kept.map((p) => p.total).filter(Number.isFinite);
  console.log(`\n  ${suspect.length} removed, ${kept.length} kept.`);
  console.log(`  Chart range afterwards: ${usd(Math.min(...totals))} to ${usd(Math.max(...totals))}`);
  console.log("  No value is corrected or invented: the hour is left with no reading, which is what happened.");

  if (!APPLY) { console.log("\nNothing written. Re-run with --apply."); return; }
  const backup = `${FILE}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(FILE, backup);
  raw.points = kept;
  fs.writeFileSync(FILE, JSON.stringify(raw));
  console.log(`\nWritten. Previous file kept at ${backup}`);
  console.log("The dashboard reads this file at startup; restart it to pick the change up.");
}

main();
