"use strict";
/**
 * jsonl.js — append-only records, appended.
 *
 * token-sales.json and memecoin-guardian-log.json are written once per event and
 * never edited, but each write read the whole file, pushed one row and wrote it all
 * back. That is O(file) per event for a file that only grows, and a process killed
 * mid-write leaves a truncated array that parses as nothing — losing every row, not
 * the last one.
 *
 * As JSON Lines each row is one appendFileSync of one line. A torn write costs the
 * line being written, and the lines before it are still readable, which is the
 * property that matters for a record of what was done with money.
 *
 * Reading accepts both: a .jsonl if it exists, otherwise the legacy .json array, so
 * a reader works before and after the migration and an old file is never silently
 * read as empty.
 */

const fs = require("fs");

const jsonlPath = (file) => (file.endsWith(".jsonl") ? file : file.replace(/\.json$/, "") + ".jsonl");
const legacyPath = (file) => (file.endsWith(".jsonl") ? file.replace(/\.jsonl$/, ".json") : file);

/**
 * Append one row. Creates the file if needed. Never rewrites what is already there.
 *
 * If the file does not end in a newline the previous append was cut short, and
 * writing straight after it would glue this row onto that fragment -- making one
 * unparseable line out of two rows and losing this one as well as the torn one. A
 * newline is written first so the damage stays with the line that was damaged.
 */
function appendRow(file, row) {
  const target = jsonlPath(file);
  let prefix = "";
  try {
    const size = fs.statSync(target).size;
    if (size > 0) {
      const fd = fs.openSync(target, "r");
      try {
        const last = Buffer.alloc(1);
        fs.readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      } finally { fs.closeSync(fd); }
    }
  } catch { /* no file yet: nothing to heal */ }
  fs.appendFileSync(target, prefix + JSON.stringify(row) + "\n");
}

/**
 * Every row, oldest first.
 *
 * A line that does not parse is skipped rather than throwing: a torn final line from
 * a killed process must not make the whole history unreadable. `onBadLine` reports
 * them so they are not silent.
 */
function readRows(file, { onBadLine = null } = {}) {
  const jsonl = jsonlPath(file);
  let text = null;
  try { text = fs.readFileSync(jsonl, "utf8"); } catch { text = null; }
  if (text != null) {
    const rows = [];
    let bad = 0;
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try { rows.push(JSON.parse(s)); } catch { bad++; }
    }
    if (bad && onBadLine) onBadLine(bad);
    return rows;
  }
  // Not migrated yet (or never written): the array is still the record.
  try {
    const arr = JSON.parse(fs.readFileSync(legacyPath(file), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/**
 * One-time conversion of a legacy array into JSON Lines.
 *
 * The array is left on disk, renamed with a .migrated suffix rather than deleted:
 * these are records of sales and closes, and a conversion that loses one because of
 * a bug in this function should be recoverable by hand. Does nothing if the .jsonl
 * already exists, so it is safe to call on every start.
 *
 * @returns {{migrated: boolean, rows: number, from?: string}}
 */
function migrate(file, { log = null } = {}) {
  const jsonl = jsonlPath(file);
  const legacy = legacyPath(file);
  if (fs.existsSync(jsonl)) return { migrated: false, rows: 0 };
  let arr;
  try { arr = JSON.parse(fs.readFileSync(legacy, "utf8")); } catch { return { migrated: false, rows: 0 }; }
  if (!Array.isArray(arr)) return { migrated: false, rows: 0 };
  const tmp = `${jsonl}.tmp${process.pid}`;
  fs.writeFileSync(tmp, arr.map((r) => JSON.stringify(r) + "\n").join(""));
  fs.renameSync(tmp, jsonl);
  try { fs.renameSync(legacy, `${legacy}.migrated`); } catch { /* keeping the original is best effort */ }
  if (log) log(`${legacy}: ${arr.length} row(s) converted to ${jsonl}; the original is kept as ${legacy}.migrated`);
  return { migrated: true, rows: arr.length, from: legacy };
}

module.exports = { appendRow, readRows, migrate, jsonlPath, legacyPath };
