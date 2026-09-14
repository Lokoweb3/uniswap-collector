"use strict";
// The MCP server built for a read role must not register the three tools that change something.
const assert = require("assert");
const WRITE = ["record_strategy_proposal", "approve_sale", "run_tasks"];
(async () => {
  const { createServer } = await import("../lp-mcp.mjs");
  const names = (s) => Object.keys(s._registeredTools || {});
  const all = names(createServer());
  const read = names(createServer({ role: "read" }));
  for (const t of WRITE) {
    assert.ok(all.includes(t), `default (write) role registers ${t}`);
    assert.ok(!read.includes(t), `read role must not register ${t}`);
  }
  assert.strictEqual(read.length, all.length - WRITE.length, "read role drops exactly the three write tools");
  assert.ok(read.includes("positions") && read.includes("health"), "read tools stay");
  console.log(`mcp-roles: ${all.length} tools for write, ${read.length} for read (no ${WRITE.join("/")}) — assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
