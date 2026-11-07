// node test/aggregate-fixtures.test.js -- the aggregate fixtures hold synthetic ids and generic labels only.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "fixtures", "aggregate");
const ALLOW = new Set([]);                           // public contract addresses allowed in fixtures (lower case)
const SYNTH = [/^0xa{30,}[0-9a-f]{1,8}$/, /^0xb{60,}[0-9a-f]{1,4}$/];
const LABEL = /^(Main|Wallet \d+|NET staking)$/;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
assert.ok(files.length >= 3, "fixtures found");
const bad = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(DIR, f), "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?(?![0-9a-fA-F])/g)) {
      const id = m[0];
      if (ALLOW.has(id.toLowerCase()) || SYNTH.some((re) => re.test(id))) continue;
      bad.push(`${f}:${i + 1} ${id.slice(0, 10)}... is not a synthetic id`);
    }
    const lm = /"(?:label|ownerLabel)":\s*"([^"]*)"/.exec(line);
    if (lm && lm[1] !== "" && !LABEL.test(lm[1])) bad.push(`${f}:${i + 1} label "${lm[1]}"`);
  });
}
assert.deepStrictEqual(bad, [], "fixture hygiene");
console.log("aggregate-fixtures.test.js ok");
