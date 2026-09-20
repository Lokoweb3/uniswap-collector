#!/usr/bin/env node
/**
 * move-split-row.js — put a split row in the ledger of the chain it belongs to.
 *
 * A split row names the vault it paid. Every row in a chain's fee-split-ledger.json
 * should name that chain's vault, and a row naming another one is misfiled: it
 * inflates "split to vault, all time" on a page whose vault never received it, and
 * makes the vault look as though it has been withdrawn from. On 2026-09-20 an Arc
 * split of 10.717929 sat in Robinhood's ledger for that reason -- the recovery tool
 * read Arc's settings while running from this checkout, and treasury.js resolves its
 * ledger from the process's own data directory. Robinhood then reported 521.347721
 * split all time against a balance of 510.629792, a difference that was exactly the
 * Arc row.
 *
 * This moves such rows. It does not invent, merge or alter them: the same object is
 * removed from one file and inserted into the other in timestamp order, both files
 * are backed up first, and a row is only moved when its vault matches the
 * destination's and not the source's.
 *
 * DRY RUN BY DEFAULT.
 *   node tools/move-split-row.js --from=fee-split-ledger.json --to=/home/steven/arc-data/fee-split-ledger.json --tba=0x56dfE4aB…
 *   node tools/move-split-row.js --from=… --to=… --tba=… --apply
 */
"use strict";

const fs = require("fs");
const path = require("path");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const APPLY = process.argv.includes("--apply");
const log = (...m) => console.log(...m);

const load = (file) => {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return { raw, rows: Array.isArray(raw) ? raw : raw.rows || [] };
};
const save = (file, raw, rows) => fs.writeFileSync(file, JSON.stringify(Array.isArray(raw) ? rows : { ...raw, rows }, null, 1));
const sum = (rows) => rows.reduce((t, r) => t + (Number(r.splitUsdg) || 0), 0);

function main() {
  const fromFile = arg("from");
  const toFile = arg("to");
  const tba = String(arg("tba") || "").toLowerCase();
  if (!fromFile || !toFile || !tba) throw new Error("--from, --to and --tba are all required");
  if (fromFile === toFile) throw new Error("--from and --to are the same file");

  const from = load(fromFile);
  const to = load(toFile);
  const belongs = (r) => String(r.tbaAddress || "").toLowerCase() === tba;

  const moving = from.rows.filter(belongs);
  log(`\nMove split rows — ${APPLY ? "APPLY" : "dry run"}`);
  log(`  from   : ${fromFile}  (${from.rows.length} row(s), ${sum(from.rows).toFixed(6)} split all time)`);
  log(`  to     : ${toFile}  (${to.rows.length} row(s), ${sum(to.rows).toFixed(6)} split all time)`);
  log(`  vault  : ${tba}`);
  if (!moving.length) { log("\nNo row in the source names that vault. Nothing to move."); return; }

  // The destination must be that vault's chain. Its existing rows are the wrong
  // test: a chain's ledger legitimately holds rows for successive vaults, and Arc's
  // holds the previous vault's because it was replaced. What settles it is the
  // settings file beside the ledger, which names the chain's current vault -- and
  // that is also the check that would have caught the misfiling in the first place,
  // since Robinhood's settings name 0x4941943B and never named an Arc vault.
  const settingsPath = path.join(path.dirname(path.resolve(toFile)), "settings.json");
  let named = null;
  try { named = String((JSON.parse(fs.readFileSync(settingsPath, "utf8")).vault || {}).tba || "").toLowerCase(); } catch { named = null; }
  if (named && named !== tba) {
    throw new Error(`${settingsPath} names vault ${named}, not ${tba}; refusing to move a row into another chain's ledger`);
  }
  if (!named) {
    log(`  note   : no settings.json beside the destination, so the chain could not be confirmed from configuration`);
  } else {
    log(`  checked: ${settingsPath} names this vault`);
  }
  // And the source must NOT be that vault's chain, or nothing is misfiled.
  const fromSettings = path.join(path.dirname(path.resolve(fromFile)), "settings.json");
  try {
    const srcVault = String((JSON.parse(fs.readFileSync(fromSettings, "utf8")).vault || {}).tba || "").toLowerCase();
    if (srcVault && srcVault === tba) throw new Error(`${fromSettings} names vault ${tba} as its own; these rows are not misfiled`);
  } catch (err) { if (/names vault/.test(err.message)) throw err; }

  log("");
  for (const r of moving) log(`  MOVE ${r.timestamp}  ${r.splitUsdg} -> vault ${r.tbaAddress}  (${r.source || "collector"})`);
  const keep = from.rows.filter((r) => !belongs(r));
  const merged = [...to.rows, ...moving].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  log(`\n  ${fromFile}: ${from.rows.length} -> ${keep.length} row(s), split all time ${sum(from.rows).toFixed(6)} -> ${sum(keep).toFixed(6)}`);
  log(`  ${toFile}: ${to.rows.length} -> ${merged.length} row(s), split all time ${sum(to.rows).toFixed(6)} -> ${sum(merged).toFixed(6)}`);
  // Nothing may go missing in the move.
  if (Math.abs(sum(keep) + sum(merged) - (sum(from.rows) + sum(to.rows))) > 1e-9) throw new Error("the totals do not reconcile; nothing was written");
  log("  totals reconcile: nothing is created or lost, only moved.");

  if (!APPLY) { log("\nDry run: nothing written. Re-run with --apply."); return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(fromFile, `${fromFile}.bak-${stamp}`);
  fs.copyFileSync(toFile, `${toFile}.bak-${stamp}`);
  save(fromFile, from.raw, keep);
  save(toFile, to.raw, merged);
  log(`\nWritten. Previous files kept as .bak-${stamp}`);
  log("Restart the dashboards to pick the change up.");
}

main();
