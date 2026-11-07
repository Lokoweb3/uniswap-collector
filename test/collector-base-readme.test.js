// node test/collector-base-readme.test.js -- the README tells the operator how to approve, verify, revoke, and what the risk is.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
const start = readme.indexOf("## Auto-collect on Base");
assert.ok(start > 0, "section 'Auto-collect on Base'");
const section = readme.slice(start, readme.indexOf("\n## ", start + 5));
for (const a of ["0x827922686190790b37229fd06084350E74485b72", "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53"]) assert.ok(section.includes(a), `${a} in the section`);
for (const word of ["setApprovalForAll", "isApprovedForAll", "Rabby", "approved` = `true", "approved` = `false", "wallets.main.collect", "collect: true", "windows-task.ps1 -At 8am", "#writeContract", "Approve all NFTs"]) {
  assert.ok(section.includes(word), `${word} in the section`);
}
const risk = section.slice(section.indexOf("**RISK"));
assert.ok(/transfer/.test(risk) && /every/i.test(risk) && /\*\*every\*\*/.test(risk), "the risk paragraph says the operator can transfer EVERY position");
for (const d of ["minFeesUsd", "minFeesToGasRatio", "maxGasPerRunEth", "maxGasPriceGwei", "maxCollectsPerRun"]) assert.ok(section.includes(d), `${d} documented`);
// the fixed gas accounting, state and risk statements
for (const d of ["maxGasPerTxEth", "maxGasLimit", "maxPriorityFeeGwei", "waitTimeoutSec"]) assert.ok(section.includes(d), `${d} documented`);
for (const word of ["POST /api/collect", "Collect button", "exit", "LP_DATA_DIR", "maxFeePerGas", "getL1Fee", "L1 fee", "state.json", "--init-state", "/proc/", "LP_KEYSTORE_PASS",
  "0x7C5f5A4bBd8fD63184577525326123B519429bDc", "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", "later", "run-collector-arc.sh", "simulate", "reverted", "timeout", "by design", "isApprovedForAll(owner, operator)"]) {
  assert.ok(section.includes(word), `${word} in the section`);
}
for (const word of ["minL1AllowanceEth", "not a hard bound", "Unknown entries do not expire", "system clock", "forward jump", "exits 0 in `collect` or `full` mode", "no TTY", "`--quiet`", "LP_DATA_DIR=$HOME/base-data node collector-base.js --init-state", "negative"]) {
  assert.ok(section.includes(word), `${word} in the section`);
}
assert.ok(!/exits 0 in collect mode/.test(section), "the skip/exit wording was corrected");
assert.ok(/min\(maxGasPriceGwei,\s+2 x block base fee \+ tip\)/.test(section), "the signed fee formula");
const F = "max(2 x L1 quote, minL1AllowanceEth)";
assert.ok(section.includes(`gasLimit x maxFeePerGas + ${F}`), "the worst case formula (gas-accounting paragraph)");
assert.ok(section.includes(`gasUsed x effective gas price + ${F}`), "the settled-amount sentence");
assert.ok(/\| `baseCollect\.maxGasPerTxEth` \|[^\n]*max\(2 x L1 quote, minL1AllowanceEth\)/.test(section), "the maxGasPerTxEth row");
assert.ok(!/\+ 2 x L1 (fee )?quote/.test(section), "no old formula");
for (const word of ["nonce", "replaced or dropped", "pending", "legacy", "--init-state"]) assert.ok(section.includes(word), `${word} in the section`);
assert.ok(!/\$HOME\/base-data\/state\.json/.test(section), "no hand-editing of state.json");
assert.ok(!/edit `?\$HOME/.test(section) && !/sendTransaction/.test(section));
assert.ok(/all four must read `false`/.test(section), "revocation covers all four managers");
// the README does not claim the whole Base instance cannot sign any more
assert.ok(!/It cannot sign: it runs/.test(readme), "the old absolute wording is gone");
// the example ships collect:false everywhere
const ex = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "settings.base.example.json"), "utf8"));
assert.strictEqual(ex.wallets.main.collect, false);
assert.ok(ex.wallets.watched.every((w) => w.collect === false));
console.log("collector-base-readme tests passed");
