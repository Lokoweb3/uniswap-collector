// The body of the stub `node` that test/collector-golden.test.js puts first on PATH: it records what the
// script would have run (argv and whether key material was passed, never its value) and runs nothing.
"use strict";
const fs = require("fs");

const here = process.env.STUB_HERE || "", home = process.env.HOME || "", base = process.env.STUB_BASE || "";
const norm = (s) => String(s).split(here).join("$HERE").split(home).join("$HOME");
const argv = process.argv.slice(2).map(norm);
const rec = {
  argv,
  keystorePath: norm(process.env.LP_KEYSTORE_PATH || ""),
  pass: process.env.LP_KEYSTORE_PASS ? "set" : "unset",
  dataDir: base && process.env.LP_DATA_DIR === base ? "$BASE" : norm(process.env.LP_DATA_DIR || ""),
};
fs.appendFileSync(process.env.STUB_CALLS, JSON.stringify(rec) + "\n");
console.log(`stub-node ${argv.join(" ")}`);
process.exit(process.env.STUB_FAIL_BASE && argv.some((a) => a.endsWith("collector-base.js")) ? 1 : 0);
