// node test/ops.test.js — collector.log parsing, per-wallet failure attribution.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseLastRun } = require("../ops");

const lines = fs.readFileSync(path.join(__dirname, "collector-log.fixture.txt"), "utf8").split("\n");
const run = parseLastRun(lines);
assert.strictEqual(run.t, "2026-09-07T09:00:01.000Z");
assert.strictEqual(run.mode, "full");
assert.deepStrictEqual(run.owners, ["Main", "SEAL wallet", "Trading", "LP Rewards"]);
assert.strictEqual(run.result, "collected 2 positions, 4 failed", run.result);
assert.deepStrictEqual(run.failures, [
  { wallet: "Main", count: 1 },       // treasury split failed
  { wallet: "Trading", count: 1 },    // the whole pass threw
  { wallet: "LP Rewards", count: 2 }, // v3 + v4 collect failed
]);

// A locked run after that run wins.
const locked = parseLastRun([...lines, "2026-09-08T09:00:01-04:00 locked, skipping full run. Run ./unlock.sh first."]);
assert.strictEqual(locked.result, "locked — skipped");
assert.deepStrictEqual(locked.failures, []);

// Old single-owner logs (no pass headers) still parse, failures land on Main.
const legacy = ["[2026-09-06T09:00:00Z] === mode=full chainId=4663 ===", "[2026-09-06T09:00:05Z]   ! collect failed for #1: boom", "[2026-09-06T09:00:06Z] Nothing above threshold. Done."];
const lr = parseLastRun(legacy);
assert.strictEqual(lr.result, "nothing above threshold, 1 failed");
assert.deepStrictEqual(lr.failures, [{ wallet: "Main", count: 1 }]);

// No run at all.
assert.strictEqual(parseLastRun(["nothing here"]), null);
console.log("ops: collector.log parsing assertions passed");
