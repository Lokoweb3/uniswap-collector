"use strict";
// POST /api/tasks/run planner: only the four known task names, spawned from an argument array.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const { TASKS, SCRIPTS, planTaskRun } = require("../tasks-route");

assert.deepEqual(TASKS, ["improvement-loop", "code-scan", "code-review", "pool-scan", "dashboard-review"]);

// Shell metacharacters, path traversal and unknown names never produce a command.
for (const bad of ["pool-scan;id", "../server", "pool-scan.js", "$(id)", "pool-scan && rm x", "", null, 42, "IMPROVEMENT-LOOP", "toString", "__proto__"]) {
  const plan = planTaskRun(bad);
  if (bad === "" || bad === null) continue; // empty = run-all, tested below
  assert.equal(plan.error, "unknown task", `rejects ${JSON.stringify(bad)}`);
  assert.equal(plan.cmd, undefined, `no command for ${JSON.stringify(bad)}`);
}

// A known name runs its script with node from an argv array — no shell, no interpolation.
for (const name of TASKS) {
  const plan = planTaskRun(name);
  assert.equal(plan.error, undefined);
  assert.equal(plan.cmd, process.execPath);
  assert.deepEqual(plan.args, [SCRIPTS[name]]);
  assert.equal(plan.all, false);
  assert.ok(fs.existsSync(path.join(__dirname, "..", SCRIPTS[name])), `${SCRIPTS[name]} exists`);
}

// No task = run-all.sh via bash with the script as an argument, not `bash -c`.
for (const empty of ["", null, undefined]) {
  const plan = planTaskRun(empty);
  assert.deepEqual(plan, { cmd: "bash", args: ["tasks/run-all.sh"], all: true });
}

// The route in server.js really uses the planner (guards against a future rewrite bypassing it).
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const route = src.slice(src.indexOf('url.pathname === "/api/tasks/run"'), src.indexOf("// === end tasks ==="));
assert.ok(route.includes('require("./tasks-route").planTaskRun'), "route uses planTaskRun");
assert.ok(!route.includes('"-c"'), "route never spawns bash -c");
assert.ok(route.includes("spawn(plan.cmd, plan.args"), "route spawns from the plan's argv");

console.log("tasks-route: allow-list, argv spawn plan and route wiring assertions passed");
