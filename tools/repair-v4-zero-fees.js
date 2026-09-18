#!/usr/bin/env node
/**
 * repair-v4-zero-fees.js — turn "0" back into "unknown" where the ledger never knew.
 *
 * ledger-v4 used to write a fee leg it could not read as 0n: a receipt that failed
 * to fetch, an unresolved pool key, or a native-currency leg, which moves no ERC-20
 * and therefore leaves no Transfer log to read. Downstream treats only null as
 * unknown, so those rows counted as measured zeros, and the dedupe meant a rescan
 * skipped them forever. The writer is fixed; this repairs what it already wrote.
 *
 * It does NOT invent amounts. On Robinhood the real figures are unrecoverable:
 * archive eth_getBalance is refused at those blocks, debug_traceTransaction is not
 * available, and the explorer's API is behind a bot wall. So an unknown leg becomes
 * null, which is what the code would write today, and nothing else changes.
 *
 * Every row is re-verified against the chain before being touched:
 *   - the receipt exists and the transaction succeeded
 *   - the leg being nulled really is the chain's native currency
 *   - there is genuinely no Transfer log for it (so "0" was never measured)
 * A row that fails any of those is left exactly as it is and reported.
 *
 * DRY RUN BY DEFAULT.
 *   node tools/repair-v4-zero-fees.js
 *   node tools/repair-v4-zero-fees.js --apply
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const APPLY = process.argv.includes("--apply");
const DATA = arg("data-dir", process.env.LP_DATA_DIR || __dirname.replace(/\/tools$/, ""));
const SETTINGS = path.join(DATA, "settings.json");
const LEDGER = path.join(DATA, "v4-owner-collects.json");
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

async function main() {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  const provider = new ethers.JsonRpcProvider(cfg.chain.rpcUrl, Number(cfg.chain.chainId), { staticNetwork: true });
  const raw = JSON.parse(fs.readFileSync(LEDGER, "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.rows;
  if (!Array.isArray(rows)) throw new Error("unrecognised ledger shape");

  const pm = String(cfg.contracts.v4.poolManager).toLowerCase();
  const INCLUDE_PARTIAL = process.argv.includes("--include-partial");
  // A leg that is native AND reads as an exact zero was never measured: a native
  // transfer produces no log, so there was nothing to read.
  const nativeZero = (r) => (r.t0 && r.t0.address === ethers.ZeroAddress && r.fee0 === "0")
    || (r.t1 && r.t1.address === ethers.ZeroAddress && r.fee1 === "0");
  // But nulling is not free. Downstream treats a null leg as unpriced and drops the
  // whole row from priced totals, so a row whose OTHER leg holds a real measured
  // amount would lose that amount from the dashboard -- trading an overstated zero
  // for an understated total. Those need a decision, not a default, so by default
  // only rows with nothing measured on any leg are repaired: there the change is
  // purely one of honesty and no figure moves.
  const measuredSomething = (r) => [["fee0", r.t0], ["fee1", r.t1]]
    .some(([k, tok]) => tok && tok.address !== ethers.ZeroAddress && r[k] && r[k] !== "0");
  const all = rows.filter(nativeZero);
  const partial = all.filter(measuredSomething);
  const suspects = INCLUDE_PARTIAL ? all : all.filter((r) => !measuredSomething(r));

  console.log(`\nLedger ${LEDGER}`);
  console.log(`  ${rows.length} row(s); ${all.length} with a native leg recorded as exactly 0`);
  console.log(`  ${partial.length} of those also measured a real amount on their token leg`);
  console.log(INCLUDE_PARTIAL
    ? `  --include-partial: repairing all ${all.length}. Those ${partial.length} rows will become unpriced and their measured token value will leave the priced totals.`
    : `  repairing the ${suspects.length} with nothing measured on any leg; no total moves. Use --include-partial for the rest, knowing what it costs.`);
  console.log("");
  if (!suspects.length) { console.log("Nothing to repair."); return; }

  const repairs = [];
  for (const r of suspects) {
    const rcpt = await provider.getTransactionReceipt(r.tx).catch(() => null);
    const why = [];
    if (!rcpt) why.push("receipt could not be read");
    else if (rcpt.status !== 1) why.push(`transaction status ${rcpt.status}`);
    if (why.length) { console.log(`  SKIP  ${r.tx.slice(0, 14)} #${r.tokenId}: ${why.join("; ")}`); continue; }

    const transfersFromPm = rcpt.logs.filter((l) => l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3
      && `0x${l.topics[1].slice(26)}`.toLowerCase() === pm);
    const legs = [];
    for (const [key, tok] of [["fee0", r.t0], ["fee1", r.t1]]) {
      if (!tok || tok.address !== ethers.ZeroAddress || r[key] !== "0") continue;
      // A native leg has no log by construction; if a Transfer for this token exists,
      // the zero was measured after all and must not be touched.
      const measured = transfersFromPm.some((l) => l.address.toLowerCase() === String(tok.address).toLowerCase());
      if (measured) { console.log(`  SKIP  ${r.tx.slice(0, 14)} #${r.tokenId}: ${key} has a Transfer log; its zero was measured`); continue; }
      legs.push(key);
    }
    if (!legs.length) continue;
    repairs.push({ row: r, legs, otherTransfers: transfersFromPm.length });
    console.log(`  FIX   ${r.tx.slice(0, 14)} #${r.tokenId} block ${r.block}: ${legs.join(", ")} -> null`
      + `  (native ${legs.map((k) => (k === "fee0" ? r.t0.symbol : r.t1.symbol)).join(", ")}; ${transfersFromPm.length} ERC-20 transfer(s) in the receipt)`);
  }

  console.log(`\n${repairs.length} row(s) would change. No amount is invented: an unreadable leg becomes null.`);
  if (!APPLY) { console.log("Nothing written. Re-run with --apply."); return; }

  const backup = `${LEDGER}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(LEDGER, backup);
  for (const { row, legs } of repairs) {
    for (const key of legs) row[key] = null;
    const note = "native leg unreadable: it moves no ERC-20 and leaves no Transfer log, so the amount was never measured (repaired 2026-09-18; it had been recorded as 0)";
    row.note = row.note ? `${row.note}; ${note}` : note;
  }
  fs.writeFileSync(LEDGER, JSON.stringify(Array.isArray(raw) ? rows : raw, null, 1));
  console.log(`\nWritten. Previous file kept at ${backup}`);
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
