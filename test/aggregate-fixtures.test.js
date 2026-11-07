// node test/aggregate-fixtures.test.js -- the aggregate fixtures hold synthetic ids and generic labels only.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "fixtures", "aggregate");
const ALLOW = new Set([]);                           // public contract addresses allowed in fixtures (lower case)
const SYNTH = [/^0xa{30,}[0-9a-f]{1,8}$/, /^0xb{60,}[0-9a-f]{1,4}$/];
const LABEL = /^(Main|Wallet \d+|NET staking)$/;
const SYM = /^(TKN[A-Z0-9]*|USDC|WETH|ETH|cbBTC|sNET)$/;   // generic token symbols plus the kept real ones
const LABEL_KEY = new Set(["label", "ownerLabel", "name", "alias", "aliases"]);
const SYM_KEYS = /"(pair|symbol0|symbol1|symbol)"\s*:\s*"([^"]*)"/g;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));
assert.ok(files.length >= 3, "fixtures found");
const bad = [];
const labelsValues = (node, out) => {
  if (Array.isArray(node)) node.forEach((n) => labelsValues(n, out));
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "labels" && v && typeof v === "object") for (const x of Object.values(v)) if (typeof x === "string") out.push(x);
      if (LABEL_KEY.has(k)) {
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
      }
      labelsValues(v, out);
    }
  }
};
for (const f of files) {
  const text = fs.readFileSync(path.join(DIR, f), "utf8");
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/0x[0-9a-fA-F]{40,}/g)) {
      const id = m[0];
      const hex = id.length - 2;
      if (hex !== 40 && hex !== 64) { bad.push(`${f}:${i + 1} ${id.slice(0, 10)}... has ${hex} hex chars`); continue; }
      if (ALLOW.has(id.toLowerCase()) || SYNTH.some((re) => re.test(id))) continue;
      bad.push(`${f}:${i + 1} ${id.slice(0, 10)}... is not a synthetic id`);
    }
    for (const m of line.matchAll(/(?<![0-9a-fA-Fx])[0-9a-fA-F]{64,}/g)) bad.push(`${f}:${i + 1} bare hex run ${m[0].slice(0, 6)}...`);
    for (const m of line.matchAll(SYM_KEYS)) {
      const parts = m[1] === "pair" ? m[2].split(" / ") : [m[2]];
      for (const v of parts) if (v !== "" && !SYM.test(v)) bad.push(`${f}:${i + 1} ${m[1]} "${v}"`);
    }
  });
  const vals = [];
  labelsValues(JSON.parse(text), vals);
  for (const v of vals) if (v !== "" && !LABEL.test(v)) bad.push(`${f} labels value "${v}"`);
}
assert.deepStrictEqual(bad, [], "fixture hygiene");
console.log("aggregate-fixtures.test.js ok");
