// node test/hermetic-audit.test.js — every test that spawns server.js or chain-router.js
// must go through test/lib/hermetic (blanked secrets, empty cwd, no-network preload).
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// smoke.js is a live smoke test; the other two only read server.js as source text (their "spawn(" is inside a string).
const ALLOW = new Set(["smoke.js", "hermetic-audit.test.js", "service-port.test.js", "tasks-route.test.js"]);
const SPAWN_CALL = /\b(spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)\(/g;
const TARGETS = /server\.js|chain-router\.js/;

/** The text of the call whose "(" is at `open`: paren matching that skips string literals. */
function callText(src, open) {
  let depth = 0, q = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Names the problem with a test file's source, or null: every spawn/exec call naming server.js or chain-router.js must itself use hermeticEnv( and PRELOAD. */
function problem(name, src) {
  if (ALLOW.has(name)) return null;
  SPAWN_CALL.lastIndex = 0;
  let m;
  while ((m = SPAWN_CALL.exec(src))) {
    const call = callText(src, m.index + m[0].length - 1);
    if (!TARGETS.test(call)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    if (!/hermeticEnv\(/.test(call) || !/\bPRELOAD\b/.test(call)) return `${name}:${line} ${m[1]}() names server.js / chain-router.js without hermeticEnv( and PRELOAD in the call`;
  }
  return null;
}

const bad = fs.readdirSync(__dirname).filter((f) => f.endsWith(".js"))
  .map((f) => problem(f, fs.readFileSync(path.join(__dirname, f), "utf8"))).filter(Boolean);
assert.deepStrictEqual(bad, []);

// the check itself: it flags a call without the helper, accepts one with it, and importing the helper is not enough
const spawning = 'const { spawn } = require("child_process");\nspawn(process.execPath, ["server.js"]);\n';
assert.ok(/fake\.test\.js:2/.test(problem("fake.test.js", spawning)));
assert.ok(problem("fake.test.js", spawning + 'const h = require("./lib/hermetic");\n'), "importing the helper is not enough");
assert.ok(problem("fake.test.js", 'execSync("node server.js", { env: process.env })'));
assert.ok(problem("fake.test.js", 'spawn(process.execPath, ["--require", PRELOAD, "chain-router.js"], { env: process.env })'), "PRELOAD without hermeticEnv");
assert.ok(problem("fake.test.js", 'spawn(process.execPath, ["server.js"], { env: hermeticEnv() })'), "hermeticEnv without PRELOAD");
assert.strictEqual(problem("fake.test.js", 'spawn(process.execPath, ["--require", PRELOAD, "server.js"], { env: hermeticEnv({ A: (1) }) });\nspawn("git", ["status"]);'), null);
assert.strictEqual(problem("fake.test.js", 'const x = "server.js";'), null, "mentions only: not a spawn");
assert.strictEqual(problem("smoke.js", spawning), null, "allow-listed");

console.log("hermetic audit passed");
