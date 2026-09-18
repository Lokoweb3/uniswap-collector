#!/usr/bin/env node
/**
 * propose-collector-settings.js — the settings a collector run needs before it can
 * run at all, checked against the chain it will run on.
 *
 * Three of them are not preferences:
 *
 *   maxGasPriceGwei           the run aborts above this. The guard compares it to
 *                             maxFeePerGas, not the base fee, so it must clear what
 *                             the chain actually quotes, with headroom.
 *   dailyGasCapEth            absent, collector.js parses String(undefined) and dies
 *                             with "invalid FixedNumber string value" before doing
 *                             anything. Same for minOperatorGasBalanceEth on a live
 *                             run. Neither has a default.
 *
 * The `…Eth` suffixes are historical: both are amounts of the chain's NATIVE
 * currency, which is ether on Robinhood and USDC on Arc. The names are not changed
 * here because the collector reads them by those names; the printed units are the
 * real ones.
 *
 * This enables nothing. Collection, sweeping and per-wallet collect flags are left
 * exactly as they are. It prints a diff and writes nothing without --apply.
 *
 *   node tools/propose-collector-settings.js
 *   node tools/propose-collector-settings.js --apply
 *   node tools/propose-collector-settings.js --ceiling=150 --daily-cap=2.0 --min-float=1.0
 */
"use strict";

const fs = require("fs");
const { ethers } = require("ethers");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const APPLY = process.argv.includes("--apply");
const SETTINGS = arg("settings", "/home/steven/arc-data/settings.json");

async function main() {
  const cfg = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  const provider = new ethers.JsonRpcProvider(arg("rpc", cfg.chain.rpcUrl), undefined, { staticNetwork: true });
  const chainId = Number((await provider.getNetwork()).chainId);
  const nat = cfg.chain.nativeCurrency || null;
  const unit = nat ? nat.symbol : "native";
  const dec = nat ? nat.decimals : 18;

  const fee = await provider.getFeeData();
  const quoted = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const quotedGwei = Number(quoted) / 1e9;

  // A ceiling is only useful if it clears what the chain quotes today with room for
  // it to move; the daily cap is what actually bounds spending.
  const ceiling = Number(arg("ceiling", Math.max(100, Math.ceil((quotedGwei * 2.5) / 50) * 50)));
  const dailyCap = arg("daily-cap", "1.0");
  const minFloat = arg("min-float", "0.5");

  const t = cfg.collector.thresholds;
  const before = { maxGasPriceGwei: t.maxGasPriceGwei, dailyGasCapEth: t.dailyGasCapEth, minOperatorGasBalanceEth: t.minOperatorGasBalanceEth };
  const after = { maxGasPriceGwei: ceiling, dailyGasCapEth: String(dailyCap), minOperatorGasBalanceEth: String(minFloat) };

  console.log(`\nchain ${chainId}, native currency ${unit} (${dec} decimals)`);
  console.log(`gas quoted now: ${quotedGwei.toFixed(2)} gwei (maxFeePerGas — the figure the guard compares against)\n`);
  console.log(`${SETTINGS}  ->  collector.thresholds`);
  for (const k of Object.keys(after)) {
    const b = before[k], a = after[k];
    if (JSON.stringify(b) === JSON.stringify(a)) { console.log(`    ${k}: ${JSON.stringify(a)} (unchanged)`); continue; }
    console.log(`  - ${k}: ${b === undefined ? "(not set)" : JSON.stringify(b)}`);
    console.log(`  + ${k}: ${JSON.stringify(a)}`);
  }

  console.log("\nwhat each one does on this chain");
  console.log(`  maxGasPriceGwei ${ceiling}: a run aborts above ${ceiling} gwei. At ${quotedGwei.toFixed(2)} gwei today it proceeds;`);
  console.log(`    the old ${before.maxGasPriceGwei} aborted every run.`);
  const collect = 400000n * quoted;
  const capWei = ethers.parseUnits(String(dailyCap), dec);
  console.log(`  dailyGasCapEth ${dailyCap}: ${dailyCap} ${unit} of gas per rolling 24 h. One v4 collect costs about`);
  console.log(`    ${ethers.formatUnits(collect, dec).slice(0, 10)} ${unit} at today's price, so roughly ${(capWei / (collect || 1n)).toString()} collects a day.`);
  const bal = await provider.getBalance(arg("operator", "0x8B650B6E03a87d844f14D499331D54377E9db9dF"));
  console.log(`  minOperatorGasBalanceEth ${minFloat}: warn below ${minFloat} ${unit}. The operator holds ${ethers.formatUnits(bal, dec).slice(0, 10)} ${unit}.`);

  console.log("\nthis enables nothing:");
  console.log(`  collector.v4Collect.enabled : ${cfg.collector.v4Collect.enabled}`);
  console.log(`  collector.sweep.enabled     : ${cfg.collector.sweep.enabled}`);
  for (const w of cfg.wallets.watched || []) console.log(`  ${(w.label + " collect flag").padEnd(28)}: ${!!w.collect}`);

  if (!APPLY) { console.log("\nNothing written. Re-run with --apply to write it."); return; }
  const backup = `${SETTINGS}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(SETTINGS, backup);
  const next = JSON.parse(JSON.stringify(cfg));
  Object.assign(next.collector.thresholds, after);
  // Same shape settings.js writes: two spaces and a trailing newline, so a three
  // line change does not land as a whole-file reformat.
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2) + "\n");
  console.log(`\nWritten. Previous file kept at ${backup}`);
}

main().catch((e) => { console.error("\nFAILED:", e.shortMessage || e.message); process.exit(1); });
