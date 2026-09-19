// node test/jsonl.test.js — append-only records are appended, and an old file is
// never read as empty.
//
// token-sales.json and memecoin-guardian-log.json are written once per event and
// never edited, but each write read the whole file, pushed a row and wrote it all
// back. Two costs: O(file) per event for a file that only grows, and a process
// killed mid-write leaves a truncated array that parses as nothing — losing every
// row rather than the last one. These are records of what was done with money.
//
// The risk in the change is the readers. A reader that only knows .jsonl reports an
// unmigrated file as no sales at all, which is a zero where there was history.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const jsonl = require("../jsonl");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-"));
const file = path.join(dir, "token-sales.json");
const lines = path.join(dir, "token-sales.jsonl");

// ---- 1. appending, and what a torn line costs ----------------------------------
{
  jsonl.appendRow(file, { t: 1, token: "A" });
  jsonl.appendRow(file, { t: 2, token: "B" });
  assert.deepStrictEqual(jsonl.readRows(file).map((r) => r.token), ["A", "B"], "rows come back in order");
  assert.ok(fs.existsSync(lines), "written to the .jsonl, not the array");

  // A process killed mid-append leaves half a line. Everything before it survives,
  // which is the whole reason for the format.
  fs.appendFileSync(lines, '{"t":3,"token":"C"');
  let badLines = 0;
  const rows = jsonl.readRows(file, { onBadLine: (n) => { badLines = n; } });
  assert.deepStrictEqual(rows.map((r) => r.token), ["A", "B"], "the complete rows are still readable");
  assert.strictEqual(badLines, 1, "and the torn one is reported rather than passed over in silence");

  // Appending after a torn line still works and does not rewrite what is there.
  jsonl.appendRow(file, { t: 4, token: "D" });
  assert.deepStrictEqual(jsonl.readRows(file).map((r) => r.token), ["A", "B", "D"]);
}

// ---- 2. an unmigrated array is still the record --------------------------------
{
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-old-"));
  const old = path.join(d2, "token-sales.json");
  fs.writeFileSync(old, JSON.stringify([{ t: 1, token: "OLD1" }, { t: 2, token: "OLD2" }]));
  assert.deepStrictEqual(jsonl.readRows(old).map((r) => r.token), ["OLD1", "OLD2"],
    "a reader sees the legacy array before any migration — not an empty history");

  // Migrating keeps every row and keeps the original.
  const r = jsonl.migrate(old);
  assert.strictEqual(r.migrated, true);
  assert.strictEqual(r.rows, 2);
  assert.deepStrictEqual(jsonl.readRows(old).map((r2) => r2.token), ["OLD1", "OLD2"], "the rows survive the conversion");
  assert.ok(fs.existsSync(`${old}.migrated`), "and the original array is kept rather than deleted");

  // Running it again is a no-op: it is called on every append.
  jsonl.appendRow(old, { t: 3, token: "NEW" });
  assert.strictEqual(jsonl.migrate(old).migrated, false, "a second migration does nothing");
  assert.deepStrictEqual(jsonl.readRows(old).map((r2) => r2.token), ["OLD1", "OLD2", "NEW"],
    "and does not duplicate or drop anything");
  fs.rmSync(d2, { recursive: true, force: true });
}

// ---- 3. nothing to read is an empty list, not a throw --------------------------
{
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-none-"));
  assert.deepStrictEqual(jsonl.readRows(path.join(d3, "token-sales.json")), [], "no file at all");
  fs.writeFileSync(path.join(d3, "token-sales.json"), "{not json");
  assert.deepStrictEqual(jsonl.readRows(path.join(d3, "token-sales.json")), [], "an unreadable legacy file");
  fs.writeFileSync(path.join(d3, "token-sales.json"), JSON.stringify({ rows: [] }));
  assert.deepStrictEqual(jsonl.readRows(path.join(d3, "token-sales.json")), [], "a legacy file that is not an array");
  fs.rmSync(d3, { recursive: true, force: true });
}

// ---- 4. every reader and writer went with it -----------------------------------
{
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", f), "utf8");

  const sell = read("sell-v4.js");
  assert.match(sell, /jsonl\.appendRow\(SALES_FILE, row\)/, "sales are appended");
  assert.ok(!/JSON\.parse\(fs\.readFileSync\(SALES_FILE/.test(sell), "and no longer read back to be rewritten");

  const guard = read("memecoin-guardian.js");
  assert.match(guard, /jsonl\.appendRow\(LOG_FILE, entry\)/, "guardian rows are appended");
  assert.match(guard, /recent: recentLog\(10\)/, "and the status view takes them from memory");
  assert.ok(!/readJson\(LOG_FILE/.test(guard), "rather than re-reading the whole log every cycle");

  for (const f of ["daily.js", "strategy.js"]) {
    assert.match(read(f), /jsonl"\)\.readRows\(/, `${f} reads through the helper, so an unmigrated file is not read as empty`);
  }

  const backup = read("backup-ledgers.sh");
  for (const name of ["token-sales.jsonl", "memecoin-guardian-log.jsonl"]) {
    assert.ok(backup.includes(name), `${name} is backed up`);
  }
  assert.ok(backup.includes("token-sales.json "), "and the legacy name stays while old copies exist");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("jsonl: one line per event, a torn line costs only itself, an unmigrated array still reads, migration keeps the original, and every reader was moved with it");
