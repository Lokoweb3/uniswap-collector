// node test/isolation.test.js — the suite must never read or write the real data
// directory. This exists because it once did: after the ledgers moved behind
// data-dir.js, test/advisor.test.js kept rewriting `path.join(__dirname, "pool-scout-
// state.json")` in the scout's source, that string no longer existed, the rewrite
// became a silent no-op, and the test wrote its synthetic pools into the live
// pool-scout-state.json and pool-scout-log.json — then failed on its own second run
// by reading them back.
//
// Two checks, one static and one live:
//   1. No module resolves a .json data file from its own directory any more.
//   2. With LP_DATA_DIR set, a child process writes into that directory and its file
//      never appears beside the code.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

// ---- 1. static: ledgers are addressed through dataPath(), never __dirname --------
{
  // settings.js keeps one deliberate fallback: a data directory with no settings.json
  // of its own falls back to the one beside the code, so a bare --data-dir still boots.
  const ALLOWED = new Set(["settings.js"]);
  const offenders = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (!f.endsWith(".js") || ALLOWED.has(f)) continue;
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const re = /path\.join\(\s*__dirname\s*,\s*["'`][A-Za-z0-9._-]+\.json["'`]\s*\)/g;
    for (const m of src.match(re) || []) offenders.push(`${f}: ${m}`);
  }
  assert.deepStrictEqual(offenders, [],
    "these resolve a data file from the checkout instead of the instance's data directory");
}

// ---- 2. live: a child honours LP_DATA_DIR and writes nowhere near the code ------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "isolation-"));
  // A name no instance would ever write, so this cannot be confused with the live
  // server writing its own ledgers while the suite runs. Snapshotting mtimes instead
  // would flake for exactly that reason.
  const probe = `isolation-probe-${process.pid}-${Date.now()}.json`;

  const child = `
    const dd = require(${JSON.stringify(path.join(ROOT, "data-dir.js"))});
    const fs = require("fs");
    if (dd.DATA_DIR !== ${JSON.stringify(tmp)}) {
      console.error("child resolved " + dd.DATA_DIR); process.exit(3);
    }
    fs.writeFileSync(dd.dataPath(${JSON.stringify(probe)}), "{}");
    process.stdout.write("ok");
  `;
  const out = execFileSync(process.execPath, ["-e", child], {
    env: { ...process.env, LP_DATA_DIR: tmp }, encoding: "utf8", timeout: 20000,
  });
  assert.strictEqual(out, "ok", "the child should resolve and write through LP_DATA_DIR");
  assert.ok(fs.existsSync(path.join(tmp, probe)),
    "the child's write belongs in the temp data directory");
  assert.ok(!fs.existsSync(path.join(ROOT, probe)),
    "a child given LP_DATA_DIR wrote into the checkout instead");

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("isolation: ledgers go through the data directory, and an isolated child leaves the checkout alone");
