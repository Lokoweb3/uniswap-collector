// node test/claims-collector-record.test.js — what the collector wrote down, shown
// beside what the chain can prove, and never merged into it.
//
// Nineteen of thirty-three positions can never be reconstructed from logs: their
// pools pay a native-asset leg by plain value transfer, which emits nothing to read.
// The claims page correctly showed "none" and said why. But the collector was the
// thing doing the collecting, and it recorded what it took — eight of those
// positions have real amounts in its own ledger, including 512,699 LAPTOP over
// seventeen runs on #2218686.
//
// The two must not be added together. The chain reconstruction is evidence about
// every settlement of a position; the collector's ledger is a record of its own runs
// only, and knows nothing about fees the wallet settled itself. Summing them would
// produce a figure that is neither.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const dash = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");

// ---- 1. both paths carry it ---------------------------------------------------
{
  // The first version attached it only where a verified history already existed,
  // so it appeared on one position out of twelve — and never on the native-asset
  // ones, which are the whole reason it exists.
  assert.strictEqual((server.match(/collector: collectorRunsFor\(base\.tokenId\)/g) || []).length, 2,
    "attached on both the included and the excluded position paths");
  const excluded = server.slice(server.indexOf("positions.push({ ...base, tokens: [], usdHistorical: null"), server.indexOf("positions.push({ ...base, tokens: [], usdHistorical: null") + 500);
  assert.ok(/collectorRunsFor/.test(excluded), "including the path the unsupported positions take");
}

// ---- 2. an unmeasured leg is never a zero -------------------------------------
{
  // ledger-v4 used to write a leg it could not read as 0n, and a repair tool had to
  // put those back to null. Summing null as zero here would reintroduce the same
  // understatement by another route.
  const fn = server.slice(server.indexOf("function collectorRunsByPosition()"), server.indexOf("const collectorRunsFor ="));
  assert.ok(/if \(amt == null \|\| !meta \|\| !meta\.address\) \{ e\.unknownLegs\+\+; continue; \}/.test(fn),
    "a null leg is counted as unknown and skipped, not added as zero");
  assert.ok(/r\.principal === true\) continue/.test(fn),
    "principal withdrawals are not fees and are excluded");

  // The arithmetic it encodes, run directly.
  const rows = [
    { tokenId: "v4-9", t: 10, fee0: "1000", fee1: null, t0: { address: "0xa", symbol: "A", decimals: 3 }, t1: { address: "0xb", symbol: "B", decimals: 3 } },
    { tokenId: "v4-9", t: 20, fee0: "500", fee1: "250", t0: { address: "0xa", symbol: "A", decimals: 3 }, t1: { address: "0xb", symbol: "B", decimals: 3 } },
    { tokenId: "v4-9", t: 30, principal: true, fee0: "999999", fee1: "999999", t0: { address: "0xa", symbol: "A", decimals: 3 }, t1: { address: "0xb", symbol: "B", decimals: 3 } },
  ];
  const e = { records: 0, unknownLegs: 0, tok: new Map() };
  for (const r of rows) {
    if (r.principal === true) continue;
    e.records++;
    for (const [amt, meta] of [[r.fee0, r.t0], [r.fee1, r.t1]]) {
      if (amt == null || !meta || !meta.address) { e.unknownLegs++; continue; }
      const prev = e.tok.get(meta.address) || { symbol: meta.symbol, raw: 0n };
      prev.raw += BigInt(amt);
      e.tok.set(meta.address, prev);
    }
  }
  assert.strictEqual(e.records, 2, "the principal row is not a fee record");
  assert.strictEqual(e.unknownLegs, 1, "the null leg is counted as unknown");
  assert.strictEqual(e.tok.get("0xa").raw, 1500n, "known legs add up");
  assert.strictEqual(e.tok.get("0xb").raw, 250n, "and the unknown one contributes nothing rather than zero");
}

// ---- 3. it is never folded into the verified totals ---------------------------
{
  // The verified columns must read exactly as the chain supports them.
  const fn = server.slice(server.indexOf("const collectorRunsFor ="), server.indexOf("const collectorRunsFor =") + 700);
  assert.ok(/this collector's own runs only/.test(fn), "the record says whose it is");
  assert.ok(!/hist \+=|pricedSubtotal \+=/.test(fn), "and contributes to no total");
  // Nothing anywhere adds a collector figure into the claimed sums.
  assert.ok(!/hist \+= .*collector/.test(server) && !/tokenTotals.*collector/.test(server),
    "the claimed totals are untouched by it");
}

// ---- 4. the page distinguishes the two ----------------------------------------
{
  assert.ok(/const ctCollectorNote = \(p\) =>/.test(dash), "the table renders it");
  const note = dash.slice(dash.indexOf("const ctCollectorNote"), dash.indexOf("const ps = Array.isArray(d.positions)"));
  assert.ok(/verified \? 'collector also recorded' : 'collector recorded'/.test(note),
    "wording differs where a verified history already exists, so the two are not confused");
  assert.ok(/not reconstructed from the chain/.test(note), "and the tooltip names the provenance");
  assert.ok(/fees the wallet settled itself are not counted here/.test(note),
    "and the limit of what it covers");
  assert.ok(/unmeasured leg/.test(note), "an unmeasured leg is disclosed rather than hidden behind a total");
  assert.ok(/filter\(t => Number\(t\.amount\) > 0\)/.test(note),
    "a run that recorded nothing readable shows no amounts rather than a row of zeros");
}

console.log("claims collector record: the collector's own figures appear on positions the chain cannot reconstruct, labelled as its own runs, with unmeasured legs disclosed and nothing merged into the verified totals");
