// node test/tax-csv.test.js — the "Download tax CSV" export, executed.
//
// The file this button produces is the record someone files taxes from, so what
// matters is that it contains the income that exists. On an instance where the
// collector has never run, its ledger is empty while the wallet has settled fees
// all year: exporting the ledger alone hands back a header row and nothing else.
//
// The handler is browser code registered on an element, so it is sliced out of
// dashboard.js and run here against stubs. Every source it reads is faked, and the
// CSV text it would have downloaded is captured and parsed.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
const START = "$('#taxcsv').addEventListener('click', async e => {";
const from = src.indexOf(START);
assert.ok(from > 0, "the tax CSV handler is still registered on #taxcsv");
const end = src.indexOf("\n});\n", from);
assert.ok(end > from, "the handler's end was found");
const body = src.slice(from + START.length, end);

// One chain settlement, priced at its own transaction; one unpriced.
const CHAIN = {
  ok: true,
  positions: [{ tokenId: "8240", pair: "USDC / ARGUS" }],
  rows: [
    { t: Date.UTC(2026, 8, 16, 10, 0, 0), tokenId: "8240", wallet: "0xb1cd", walletLabel: "Arc LP",
      tx: "0xac8b", priceSrc: "block", usd: 12.34,
      tokens: [{ symbol: "USDC", amount: 12 }, { symbol: "ARGUS", amount: 0.5416899489695307 }] },
    { t: Date.UTC(2026, 8, 17, 11, 0, 0), tokenId: "8240", wallet: "0xb1cd", walletLabel: "Arc LP",
      tx: "0xbe12", priceSrc: "pool", usd: null, tokens: [{ symbol: "ARGUS", amount: 3 }] },
  ],
};

async function runExport({ events = [], ledger = [], chainFeesD = null, chainFetch = CHAIN } = {}) {
  let csv = null;
  const scope = {
    e: { preventDefault() {} },
    incomeEvents: () => events,
    chainFeesD,
    fetch: async (url) => {
      if (url === "/fee-split-ledger.json") return { json: async () => ledger };
      if (url.startsWith("/api/claims/total")) {
        if (!chainFetch) throw new Error("claims unavailable");
        return { json: async () => chainFetch };
      }
      throw new Error("unexpected fetch " + url);
    },
    Blob: function (parts) { csv = parts.join(""); },
    URL: { createObjectURL: () => "blob:x" },
    document: { createElement: () => ({ click() {} }) },
  };
  const fn = new Function(...Object.keys(scope), `return (async () => {${body}})();`);
  await fn(...Object.values(scope));
  assert.ok(csv != null, "a CSV was produced");
  const lines = csv.split("\n");
  const cells = (l) => l.match(/"(?:[^"]|"")*"/g).map((c) => c.slice(1, -1).replace(/""/g, '"'));
  return { header: lines[0].split(","), rows: lines.slice(1).map(cells) };
}

(async () => {
  // ---- 1. the real case: nothing in the ledger, a year of settlements on chain ----
  {
    const { header, rows } = await runExport({ events: [], ledger: [] });
    assert.ok(header.includes("source"), "every row names the source it came from");
    assert.strictEqual(rows.length, 2, `an empty collector ledger still exports the chain's income: ${rows.length} rows`);
    const src0 = header.indexOf("source"), usdC = header.indexOf("usd_at_receipt"), txC = header.indexOf("tx_hash");
    assert.deepStrictEqual(rows.map((r) => r[src0]), ["chain", "chain"]);
    assert.strictEqual(rows[0][usdC], "12.34", "valued at its own transaction, not today");
    assert.strictEqual(rows[0][txC], "0xac8b", "the tx hash is there to reconcile against the ledger");
    assert.match(rows[0][header.indexOf("price_basis")], /at settlement/);
    assert.strictEqual(rows[1][usdC], "", "an unpriced settlement exports no dollar figure");
    assert.strictEqual(rows[1][header.indexOf("price_basis")], "unpriced");
    assert.match(rows[0][header.indexOf("description")], /#8240 USDC \/ ARGUS/);
    assert.match(rows[0][header.indexOf("amounts")], /12 USDC \+ 0\.5416899489695307 ARGUS/);
    assert.strictEqual(rows[0][header.indexOf("wallet")], "Arc LP");
  }

  // ---- 2. both sources appear, each labelled, and nothing is silently merged ------
  {
    const events = [{ t: Date.UTC(2026, 8, 16, 10, 0, 0), type: "LP fees", wallet: "Main", what: "USDC / ARGUS",
      amounts: "12 USDC", usd: 12.34, approx: false, tx: "0xac8b" }];
    const { header, rows } = await runExport({ events, chainFeesD: CHAIN });
    const src0 = header.indexOf("source"), txC = header.indexOf("tx_hash");
    assert.deepStrictEqual(rows.map((r) => r[src0]), ["collector ledger", "chain", "chain"]);
    // The same settlement seen from both sides stays as two rows keyed by tx hash:
    // summing the column would double it, and that is the reader's call to make.
    const dupe = rows.filter((r) => r[txC] === "0xac8b");
    assert.strictEqual(dupe.length, 2, "a collector collect is also a chain settlement");
    assert.deepStrictEqual(dupe.map((r) => r[src0]), ["collector ledger", "chain"]);
  }

  // ---- 3. a vault split is ledger-side, and a failed claims read degrades ---------
  {
    const ledger = [{ timestamp: "2026-09-16T10:00:00.000Z", wallet: "Main", pair: "USDC / ARGUS",
      splitPct: 10, totalCollectedUsdg: 100, splitUsdg: "10", splitTxHash: "0xspl", status: "ok" }];
    const { header, rows } = await runExport({ ledger, chainFetch: null });
    assert.strictEqual(rows.length, 1, "the chain read failed, so only the ledger row is exported");
    assert.strictEqual(rows[0][header.indexOf("source")], "collector ledger");
    assert.strictEqual(rows[0][header.indexOf("type")], "Vault split");
    assert.strictEqual(rows[0][header.indexOf("vault_split_usdg")], "10.00");
  }

  console.log("tax CSV: chain settlements and the collector ledger both exported, each row naming its source and tx");
})().catch((e) => { console.error(e); process.exit(1); });
