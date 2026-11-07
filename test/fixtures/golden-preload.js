// Preloaded into a spawned collector.js (node --require) by test/collector-golden.test.js:
// collector.js appends every log line to <source tree>/collector.log; a test must not write
// there, so appends to a file named collector.log are dropped. Stdout is untouched.
"use strict";
const fs = require("fs");

const real = fs.appendFileSync;
fs.appendFileSync = function appendFileSync(file, ...rest) {
  if (typeof file === "string" && /(^|[\\/])collector\.log$/.test(file)) return undefined;
  return real.call(this, file, ...rest);
};
