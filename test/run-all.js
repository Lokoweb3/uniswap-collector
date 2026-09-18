#!/usr/bin/env node
/**
 * Runs every test in this directory, discovered rather than listed.
 *
 * The npm "test" script was a hand-written chain of 60-odd filenames. Four tests
 * written on 2026-09-18 were never added to it, so they passed only when someone ran
 * them directly — including the one covering the bug that had just cost a live run.
 * A list you have to remember to update is a list that silently shrinks.
 *
 * Each file runs in its own process, because several set LP_DATA_DIR or otherwise
 * expect a clean module registry. Output is shown only for failures; the summary
 * always says how many ran.
 *
 *   node test/run-all.js            # everything
 *   node test/run-all.js claims     # only files matching "claims"
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DIR = __dirname;
const filter = process.argv[2] || "";
// isolation.test.js first: it checks that tests cannot touch the real data
// directory, and a failure there makes every later result suspect.
const FIRST = ["isolation.test.js"];

const found = fs.readdirSync(DIR)
  .filter((f) => f.endsWith(".test.js") || f === "smoke.js")
  .filter((f) => !filter || f.includes(filter))
  .sort((a, b) => (FIRST.indexOf(b) - FIRST.indexOf(a)) || a.localeCompare(b));

if (!found.length) {
  console.error(filter ? `no test matches "${filter}"` : "no tests found");
  process.exit(1);
}

const failures = [];
const started = Date.now();
for (const file of found) {
  const r = spawnSync(process.execPath, [path.join(DIR, file)], { encoding: "utf8", timeout: 10 * 60 * 1000 });
  const ok = r.status === 0;
  if (!ok) {
    failures.push(file);
    console.log(`\n--- FAIL ${file} ---`);
    process.stdout.write((r.stdout || "").split("\n").slice(-25).join("\n"));
    process.stderr.write((r.stderr || "").split("\n").slice(-25).join("\n"));
    if (r.error) console.error(`  ${r.error.message}`);
  }
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length) {
  console.error(`\n${failures.length} of ${found.length} test file(s) failed in ${secs}s: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\n${found.length} test file(s) passed in ${secs}s`);
