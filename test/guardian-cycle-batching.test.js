// node test/guardian-cycle-batching.test.js — a cycle reads its positions together,
// and still decides about them one at a time, in order.
//
// cycle() awaited sample() for one position before starting the next, and each sample
// is six to eight RPC round trips through loadPosition. A cycle therefore cost the
// sum of every position's latency, for readings that do not depend on each other.
//
// What must not change is the order of the deciding. Alerts, the confirmation streak
// that leads to an auto-close, and the state file are all written as the loop walks
// the positions, so the reading is concurrent and the processing is not.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "memecoin-guardian.js"), "utf8");

// ---- 1. the shape: gather, read together, then decide in order -----------------
{
  // appendLog is defined ABOVE cycle() in this file, so it is not an end marker:
  // slicing to it yields nothing and every assertion below passes vacuously.
  const start = src.indexOf("  async function cycle()");
  const end = src.indexOf("async function refresh()", start);
  assert.ok(start > 0 && end > start, "cycle() and the function after it are both found");
  const cycle = src.slice(start, end);
  assert.ok(cycle.length > 1000, "and the slice is the body, not an empty string");
  const gather = cycle.indexOf("due.push({ entry, id, st, interval })");
  const read = cycle.indexOf("await Promise.all(due.slice(i, i + SAMPLE_CONCURRENCY)");
  const decide = cycle.indexOf("for (const { entry, id, st, interval } of due)");
  assert.ok(gather > 0 && read > gather && decide > read,
    "due positions are gathered, then read together, then processed");
  assert.match(cycle, /const SAMPLE_CONCURRENCY = 4;/, "a few at a time, not all at once");
  // The old serial read must be gone, or nothing was gained.
  assert.ok(!/for \(const entry of list\) \{[\s\S]*?s = await sample\(entry, wethUsd\);/.test(cycle),
    "sample is no longer awaited inside the per-position loop");
}

// ---- 2. the batching behaviour it encodes --------------------------------------
async function batching() {
  // The loop, run against a fake sampler that records when each call starts.
  const run = async (n, concurrency, failing = new Set()) => {
    const due = Array.from({ length: n }, (_, i) => ({ id: String(i) }));
    const inFlight = [];
    let peak = 0, live = 0;
    const order = [];
    const sampled = new Map();
    const sample = async (id) => {
      live++; peak = Math.max(peak, live);
      inFlight.push(id);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      if (failing.has(id)) throw new Error("read failed");
      return { id };
    };
    for (let i = 0; i < due.length; i += concurrency) {
      await Promise.all(due.slice(i, i + concurrency).map(async ({ id }) => {
        try { sampled.set(id, { s: await sample(id) }); } catch (err) { sampled.set(id, { err }); }
      }));
    }
    for (const { id } of due) order.push(sampled.get(id).err ? `${id}:failed` : id);
    return { peak, order, sampled };
  };

  const a = await run(8, 4);
  assert.strictEqual(a.peak, 4, "no more than four reads are in flight at once");
  assert.deepStrictEqual(a.order, ["0", "1", "2", "3", "4", "5", "6", "7"],
    "and the positions are processed in their original order regardless of which read finished first");

  // One position failing must not cost the others their cycle: before, a throw
  // inside the loop skipped only that position, and that must still hold.
  const b = await run(4, 4, new Set(["1"]));
  assert.deepStrictEqual(b.order, ["0", "1:failed", "2", "3"], "a failed read loses only its own position");
  assert.strictEqual(b.sampled.get("2").err, undefined, "the others still have their samples");

  // Serial is the degenerate case and must still work.
  assert.strictEqual((await run(3, 1)).peak, 1);
}

// ---- 3. the cycle says how long it took ----------------------------------------
{
  assert.match(src, /const cycleStarted = Date\.now\(\);/, "the cycle is timed");
  assert.match(src, /const cycleMs = Date\.now\(\) - cycleStarted;/, "from start to finish");
  assert.match(src, /cycleMs, sampled: due\.length/, "and reports both in its status");
  assert.match(src, /log\(`cycle: \$\{cycleMs\} ms for \$\{due\.length\} sample\(s\)/,
    "and logs it, so a guardian slower than its own interval is visible");
}

batching().then(() => console.log("guardian cycle: due positions are read a few at a time instead of one after another, processed in their original order, a failed read costs only its own position, and the cycle reports how long it took"))
  .catch((e) => { console.error(e); process.exit(1); });
