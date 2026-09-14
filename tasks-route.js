"use strict";
// POST /api/tasks/run: which task scripts may be started and how. Kept out of server.js so the
// rule is unit-testable without booting the dashboard. The names match `run_tasks` in lp-mcp.mjs.
// Name -> script, relative to the repo root (pool-scan.js lives at the root, the others under tasks/).
const SCRIPTS = {
  "improvement-loop": "tasks/improvement-loop.js",
  "code-scan": "tasks/code-scan.js",
  "code-review": "tasks/code-review.js",
  "pool-scan": "pool-scan.js",
};
const TASKS = Object.keys(SCRIPTS);

/** Returns { cmd, args, all } for an allowed request or { error } for anything else. Never a shell. */
function planTaskRun(task) {
  if (task == null || task === "") return { cmd: "bash", args: ["tasks/run-all.sh"], all: true };
  if (typeof task !== "string" || !Object.prototype.hasOwnProperty.call(SCRIPTS, task)) return { error: "unknown task" };
  return { cmd: process.execPath, args: [SCRIPTS[task]], all: false };
}

module.exports = { TASKS, SCRIPTS, planTaskRun };
