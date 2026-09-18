// node test/tax-csv.test.js — the tax export: one row per economic settlement.
//
// Two records can describe one settlement: this collector's ledger entry for a
// collect it performed, and the chain scan's reading of the same event. A tax file
// must hold that settlement once. The matching is on the settlement's identity —
// chain, position manager, position, transaction, and the log index of the event
// inside the transaction — because a transaction hash is not one settlement: it can
// settle several positions, and it can settle one position twice.
//
// Where identity cannot decide the question, the records are flagged and left out
// of the reconciled total rather than guessed at. And a failed claims read must not
// hand back a normal-looking file that is silently missing every fee the wallet
// settled itself.
//
// reconcileIncome() and incomeCsv() are pure and are lifted out of dashboard.js;
// the click handler is sliced out and run against stubs.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
function fnSource(decl) {
  const f = src.indexOf(decl);
  assert.ok(f > 0, `${decl} is still in dashboard.js`);
  const end = src.indexOf("\n}\n", f);
  assert.ok(end > f, `${decl} ends at a top-level brace`);
  return src.slice(f, end + 2);
}
const COLUMNS_SRC = src.match(/^const INCOME_CSV_COLUMNS = .*$/m);
assert.ok(COLUMNS_SRC, "the column list is still declared");
const { reconcileIncome, incomeCsv, INCOME_CSV_COLUMNS } = new Function(
  `${fnSource("function reconcileIncome({")}\n${COLUMNS_SRC[0]}\n${fnSource("function incomeCsv({")}\n` +
  "return { reconcileIncome, incomeCsv, INCOME_CSV_COLUMNS };")();

const CHAIN_ID = 5042;
const PM4 = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b";
const PM3 = "0xc36442b4a4522e871399cd717abdd847ab11fe88";
const MANAGERS = { 4: PM4, 3: PM3 };
const T = (h) => Date.UTC(2026, 8, 16, h, 0, 0);

const chainRow = (o) => ({
  positionKey: `${CHAIN_ID}:${PM4}:${o.tokenId}:0xb1cd`, tokenId: String(o.tokenId), wallet: "0xb1cd",
  walletLabel: "Arc LP", t: o.t, tx: o.tx, logIndex: o.logIndex, usd: o.usd === undefined ? 10 : o.usd,
  priceSrc: o.priceSrc || "block", tokens: o.tokens || [{ symbol: "USDC", amount: 10 }], status: "open", kind: "collect",
});
const ledgerRow = (o) => ({
  t: o.t, type: "LP fees", wallet: o.wallet || "Arc LP", what: o.what || `USDC/ARGUS`, amounts: o.amounts || "10 USDC",
  usd: o.usd === undefined ? 10 : o.usd, approx: !!o.approx, tx: o.tx === undefined ? "0xaa" : o.tx,
  tokenId: o.tokenId === undefined ? "8240" : o.tokenId, version: o.version === undefined ? 4 : o.version,
});
const chainOf = (rows, positions = [{ tokenId: "8240", pair: "USDC / ARGUS" }]) => ({ ok: true, rows, positions });
const run = (events, chain, splits = []) => reconcileIncome({ events, chain, splits, chainId: CHAIN_ID, managers: MANAGERS });
const lp = (out) => out.rows.filter((r) => r.type === "LP fees");

// ---- 1. overlapping sources: one settlement, two records, one row --------------
{
  const out = run([ledgerRow({ t: T(10), tx: "0xaa", usd: 9.5 })],
    chainOf([chainRow({ t: T(10), tx: "0xaa", logIndex: 18, tokenId: 8240, usd: 10 })]));
  assert.strictEqual(lp(out).length, 1, "the settlement is exported once, not twice");
  const r = lp(out)[0];
  assert.strictEqual(r.matchStatus, "matched");
  assert.strictEqual(r.source, "chain + collector ledger", "both provenances ride on the canonical row");
  assert.strictEqual(r.usd, 10, "the chain's valuation at the settlement is the one used");
  assert.strictEqual(r.collectorUsd, 9.5, "and the collector's own figure is retained beside it");
  assert.strictEqual(r.logIndex, 18);
  assert.strictEqual(r.manager, PM4);
  assert.strictEqual(r.counted, true);
  assert.strictEqual(out.totals.reconciledUsd, 10, "counted once");
  assert.strictEqual(out.totals.matched, 1);
  assert.match(r.note, /value this settlement differently/, "the two valuations disagree, and the row says so");
  // rounding between the two sources is not a disagreement worth flagging
  const penny = run([ledgerRow({ t: T(10), tx: "0xaa", usd: 9.995 })],
    chainOf([chainRow({ t: T(10), tx: "0xaa", logIndex: 18, tokenId: 8240, usd: 10 })]));
  assert.strictEqual(lp(penny)[0].note, "");
}

// ---- 2. one transaction, several settlements ----------------------------------
{
  // (a) two positions settled in one transaction: the position tells them apart,
  //     so both match and neither is ambiguous. Matching on tx alone would collide.
  const out = run(
    [ledgerRow({ t: T(11), tx: "0xbb", tokenId: "8240", usd: 5 }), ledgerRow({ t: T(11), tx: "0xbb", tokenId: "9001", usd: 7 })],
    chainOf([chainRow({ t: T(11), tx: "0xbb", logIndex: 4, tokenId: 8240, usd: 5 }),
             chainRow({ t: T(11), tx: "0xbb", logIndex: 9, tokenId: 9001, usd: 7 })],
      [{ tokenId: "8240", pair: "USDC / ARGUS" }, { tokenId: "9001", pair: "USDC / EURC" }]));
  assert.strictEqual(lp(out).length, 2, "two settlements, two rows");
  assert.deepStrictEqual(lp(out).map((r) => r.matchStatus), ["matched", "matched"]);
  assert.deepStrictEqual(lp(out).map((r) => r.tokenId).sort(), ["8240", "9001"]);
  assert.strictEqual(out.totals.reconciledUsd, 12);
  assert.strictEqual(out.totals.ambiguous, 0);

  // (b) the same position settled twice in one transaction (a decrease and a
  //     collect). The ledger carries no log index, so which record is which cannot
  //     be established: flagged, and out of the reconciled total.
  const crowded = run([ledgerRow({ t: T(12), tx: "0xcc", tokenId: "8240", usd: 3 })],
    chainOf([chainRow({ t: T(12), tx: "0xcc", logIndex: 2, tokenId: 8240, usd: 3 }),
             chainRow({ t: T(12), tx: "0xcc", logIndex: 7, tokenId: 8240, usd: 4 })]));
  assert.strictEqual(crowded.totals.ambiguous, 3, "both chain records and the ledger record are flagged");
  assert.strictEqual(crowded.totals.reconciledUsd, 0, "nothing ambiguous is claimed as reconciled");
  assert.strictEqual(crowded.totals.settlements, 0);
  for (const r of lp(crowded)) {
    assert.strictEqual(r.counted, false);
    assert.match(r.note, /no log index/);
  }
  assert.ok(lp(crowded).some((r) => r.source === "chain") && lp(crowded).some((r) => r.source === "collector ledger"),
    "the reader still gets both raw records, labelled");
}

// ---- 3. unmatched records on either side --------------------------------------
{
  const out = run([ledgerRow({ t: T(9), tx: "0xdd", tokenId: "8240", usd: 4 })],
    chainOf([chainRow({ t: T(13), tx: "0xee", logIndex: 1, tokenId: 8240, usd: 6 })]));
  assert.deepStrictEqual(lp(out).map((r) => r.matchStatus), ["collector only", "chain only"]);
  assert.strictEqual(out.totals.reconciledUsd, 10, "each is a settlement in its own right");
  assert.strictEqual(out.totals.ambiguous, 0);
  // a ledger row with no transaction hash cannot be shown to be a distinct
  // settlement, so it is flagged rather than added to the total
  const noTx = run([ledgerRow({ t: T(9), tx: "", usd: 4 })], chainOf([]));
  assert.strictEqual(noTx.totals.ambiguous, 1);
  assert.strictEqual(noTx.totals.reconciledUsd, 0);
  assert.match(lp(noTx)[0].note, /no transaction hash/);
  // the chain knows this position and transaction under a different manager: a
  // disagreement about identity, not a second settlement
  const mgr = reconcileIncome({ events: [ledgerRow({ t: T(10), tx: "0xaa", tokenId: "8240", version: 3 })],
    chain: chainOf([chainRow({ t: T(10), tx: "0xaa", logIndex: 3, tokenId: 8240, usd: 10 })]),
    splits: [], chainId: CHAIN_ID, managers: MANAGERS });
  assert.strictEqual(mgr.totals.ambiguous, 1, "the mismatched ledger record is flagged");
  assert.strictEqual(mgr.totals.reconciledUsd, 10, "the chain settlement still stands on its own");
  assert.match(lp(mgr).find((r) => r.matchStatus === "ambiguous").note, /position manager/);
}

// ---- 4. missing prices ---------------------------------------------------------
{
  const out = run([], chainOf([
    chainRow({ t: T(14), tx: "0xf1", logIndex: 1, tokenId: 8240, usd: null, priceSrc: "pool", tokens: [{ symbol: "ARGUS", amount: 3 }] }),
    chainRow({ t: T(15), tx: "0xf2", logIndex: 1, tokenId: 8240, usd: 8 })]));
  const un = lp(out).find((r) => r.usd == null);
  assert.strictEqual(un.priceBasis, "unpriced");
  assert.strictEqual(un.counted, false, "an unpriced settlement is not valued at zero");
  assert.strictEqual(un.amounts, "3 ARGUS", "its amount is still on the record");
  assert.strictEqual(out.totals.unpriced, 1);
  assert.strictEqual(out.totals.reconciledUsd, 8);
  assert.match(incomeCsv(out), /1 settlement\(s\) have no price record/);
  // an approximate collector valuation says so in the basis column
  const approx = run([ledgerRow({ t: T(9), tx: "0xz1", usd: 2, approx: true })], chainOf([]));
  assert.match(lp(approx)[0].priceBasis, /today's price/);
}

// ---- 4b. the stated total is the sum of the column as printed -------------------
{
  // Three settlements whose exact values each round up by a fraction of a cent: a
  // total taken before rounding would not match the column a reader adds up.
  const out = run([], chainOf([
    chainRow({ t: T(1), tx: "0xr1", logIndex: 1, tokenId: 8240, usd: 0.105507 }),
    chainRow({ t: T(2), tx: "0xr2", logIndex: 1, tokenId: 8240, usd: 0.024999 }),
    chainRow({ t: T(3), tx: "0xr3", logIndex: 1, tokenId: 8240, usd: 2.794999 })]));
  const printed = lp(out).map((r) => Number(r.usd.toFixed(2)));
  assert.strictEqual(out.totals.reconciledUsd, +printed.reduce((a, b) => a + b, 0).toFixed(2),
    `the header total must equal the exported column: ${out.totals.reconciledUsd} vs ${printed}`);
  assert.strictEqual(out.totals.reconciledUsd, 2.92, "0.11 + 0.02 + 2.79 as the file prints them");
  assert.match(incomeCsv(out), /Reconciled LP fee income: 2\.92 USD/);
}

// ---- 5. staking and vault splits stay distinct ---------------------------------
{
  const out = run(
    [ledgerRow({ t: T(10), tx: "0xaa", usd: 10 }), { t: T(16), type: "Staking reward", wallet: "Main", what: "stUSDC", amounts: "0.5 stUSDC", usd: 0.5, approx: false, tx: "" }],
    chainOf([chainRow({ t: T(10), tx: "0xaa", logIndex: 1, tokenId: 8240, usd: 10 })]),
    [{ timestamp: new Date(T(17)).toISOString(), wallet: "Main", pair: "USDC / ARGUS", splitPct: 10, totalCollectedUsdg: 100, splitUsdg: "10", splitTxHash: "0xspl", status: "ok" },
     { timestamp: new Date(T(18)).toISOString(), wallet: "Main", splitUsdg: "5", status: "failed" }]);
  const stake = out.rows.find((r) => r.type === "Staking reward");
  assert.strictEqual(stake.matchStatus, "not applicable", "staking is never matched against fees");
  assert.strictEqual(stake.counted, false, "and never inside the LP fee total");
  assert.strictEqual(out.totals.stakingUsd, 0.5, "it is reported on its own");
  assert.strictEqual(out.totals.reconciledUsd, 10);
  const split = out.rows.filter((r) => r.type === "Vault split");
  assert.strictEqual(split.length, 1, "a failed split is not a movement that happened");
  assert.strictEqual(split[0].counted, false, "a split moves income already counted; it is not income again");
  assert.strictEqual(split[0].splitUsdg, 10);
}

// ---- 6. the CSV text ------------------------------------------------------------
{
  const out = run([ledgerRow({ t: T(10), tx: "0xaa", usd: 10 })],
    chainOf([chainRow({ t: T(10), tx: "0xaa", logIndex: 18, tokenId: 8240, usd: 10 })]));
  const text = incomeCsv(out);
  const lines = text.split("\n");
  const head = lines.find((l) => l.startsWith("date_utc"));
  assert.ok(head, "the column row is there");
  for (const c of ["match_status", "chain_id", "position_manager", "position_id", "tx_hash", "log_index", "collector_recorded_usd", "in_reconciled_total", "note"]) {
    assert.ok(head.includes(c), `the export carries ${c}`);
  }
  assert.match(lines[0], /Reconciled LP fee income: 10\.00 USD across 1 settlements/);
  assert.ok(!/INCOMPLETE/.test(text), "a complete export says nothing about being incomplete");
  const row = lines[lines.indexOf(head) + 1].split('","').map((s) => s.replace(/^"|"$/g, ""));
  assert.strictEqual(row[INCOME_CSV_COLUMNS.indexOf("in_reconciled_total")], "yes");
  assert.strictEqual(row[INCOME_CSV_COLUMNS.indexOf("log_index")], "18");
  assert.strictEqual(row[INCOME_CSV_COLUMNS.indexOf("position_manager")], PM4);
}

// ---- 7. a failed claims read never downloads a normal-looking file --------------
(async () => {
  const START = "$('#taxcsv').addEventListener('click', async e => {";
  const from = src.indexOf(START);
  assert.ok(from > 0, "the handler is still registered on #taxcsv");
  const body = src.slice(from + START.length, src.indexOf("\n});\n", from));

  async function click({ claims, confirmAnswer }) {
    const noteEl = { textContent: "both sources below", classList: { add() { this.on = true; }, remove() { this.on = false; }, on: false } };
    const got = { downloads: [], confirms: [] };
    const scope = {
      e: { preventDefault() {} },
      $: (sel) => (sel === "#taxcsvnote" ? noteEl : null),
      incomeEvents: () => [ledgerRow({ t: T(10), tx: "0xaa", usd: 10 })],
      chainFeesD: null,
      lastRender: { chainId: CHAIN_ID, positionManagerV4: PM4, positionManager: PM3 },
      CHAIN: { id: CHAIN_ID },
      reconcileIncome, incomeCsv,
      confirm: (m) => { got.confirms.push(m); return confirmAnswer; },
      fetch: async (url) => {
        if (url === "/fee-split-ledger.json") return { json: async () => [] };
        if (url.startsWith("/api/claims/total")) {
          if (claims === "throw") throw new Error("network down");
          if (claims === "notok") return { json: async () => ({ ok: false, error: "scan not started" }) };
          return { json: async () => chainOf([chainRow({ t: T(10), tx: "0xaa", logIndex: 18, tokenId: 8240, usd: 10 })]) };
        }
        throw new Error("unexpected fetch " + url);
      },
      Blob: function (parts) { this.text = parts.join(""); got.blob = this; },
      URL: { createObjectURL: () => "blob:x" },
      document: { createElement: () => ({ click() { got.downloads.push(this.download); } }) },
    };
    const fn = new Function(...Object.keys(scope), `return (async () => {${body}})();`);
    await fn(...Object.values(scope));
    return { ...got, note: noteEl };
  }

  // declined: nothing is downloaded at all
  const declined = await click({ claims: "throw", confirmAnswer: false });
  assert.deepStrictEqual(declined.downloads, [], "a declined partial export downloads nothing");
  assert.strictEqual(declined.blob, undefined, "and no file is even built");
  assert.strictEqual(declined.confirms.length, 1, "the reader was asked");
  assert.match(declined.confirms[0], /missing every fee the wallet settled itself/);
  assert.match(declined.confirms[0], /network down/, "the reason is quoted, not swallowed");
  assert.match(declined.note.textContent, /incomplete/, "and the page says so afterwards");
  assert.strictEqual(declined.note.classList.on, true);

  // accepted: the file is marked incomplete, in its name and in its first lines
  const forced = await click({ claims: "notok", confirmAnswer: true });
  assert.strictEqual(forced.downloads.length, 1);
  assert.match(forced.downloads[0], /^lp-income-INCOMPLETE-ledger-only-/, "the filename carries the warning");
  assert.match(forced.blob.text, /INCOMPLETE EXPORT — the chain-derived settlements could not be read \(scan not started\)/);
  assert.match(forced.blob.text, /collector ledger/, "the ledger rows the reader asked for are there");

  // an ok:false answer is a failure, not an empty chain history
  assert.match(forced.confirms[0], /scan not started/);

  // the ordinary path asks nothing and produces a complete file
  const fine = await click({ claims: "ok", confirmAnswer: false });
  assert.deepStrictEqual(fine.confirms, [], "nothing to confirm when both sources are in hand");
  assert.strictEqual(fine.downloads.length, 1);
  assert.match(fine.downloads[0], /^lp-income-\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(!/INCOMPLETE/.test(fine.blob.text));
  assert.match(fine.blob.text, /1 recorded by both sources/, "the settlement reconciled across both records");
  assert.strictEqual(fine.note.textContent, "both sources below");

  console.log("tax CSV: settlements exported once on identity (chain, manager, position, tx, log index); ambiguity flagged and excluded; a failed claims read requires an explicit choice");
})().catch((e) => { console.error(e); process.exit(1); });
