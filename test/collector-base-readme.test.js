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
// the README does not claim the whole Base instance cannot sign any more
assert.ok(!/It cannot sign: it runs/.test(readme), "the old absolute wording is gone");
// the example ships collect:false everywhere
const ex = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "settings.base.example.json"), "utf8"));
assert.strictEqual(ex.wallets.main.collect, false);
assert.ok(ex.wallets.watched.every((w) => w.collect === false));
console.log("collector-base-readme tests passed");
