// node test/service-port.test.js — a supervised service gets its own port, never the
// dashboard's.
//
// The pool scanner reads `process.env.PORT || 3847`. It is spawned by the dashboard,
// which has PORT=8787 in its own environment, so it inherited 8787, bound a port
// already in use, and exited two seconds later. Every fifteen minutes, forty-six
// times, while :3847 stayed empty and the public scanner URL had nothing behind it.
// The supervisor reported the crash loop honestly; nothing said the cause was a
// variable it was handing down itself.
//
// Inheriting the environment is right — the child needs the secrets in it. Inheriting
// the parent's own port never is.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// The spawn for supervised services, isolated from the other spawns in the file.
const at = src.indexOf("const child = spawn(svc.cmd, svc.args,");
assert.ok(at >= 0, "the service supervisor's spawn is gone from server.js");
const block = src.slice(at - 400, at + 300);

// ---- 1. the child's port is set from the service, not inherited ---------------
{
  assert.ok(/if \(svc\.port\) env\.PORT = String\(svc\.port\); else delete env\.PORT;/.test(block),
    "a service with a port is given that port, and one without gets no PORT at all");
  assert.ok(/const env = \{ \.\.\.process\.env \};/.test(block),
    "the rest of the environment is still inherited, secrets included");
  assert.ok(/spawn\(svc\.cmd, svc\.args, \{[^}]*env \}\)/.test(block),
    "and the spawn uses that environment, not process.env directly");
  assert.ok(!/spawn\(svc\.cmd, svc\.args, \{[^}]*env: process\.env/.test(block),
    "handing process.env straight down is what passed 8787 to a service that wanted 3847");
}

// ---- 2. the behaviour it encodes ----------------------------------------------
{
  // The two lines above, run against the cases that matter. A service declaring a
  // port must see its own; one declaring none must not see the dashboard's, or it
  // would bind 8787 the moment it defaulted to process.env.PORT.
  const envFor = (svc, parent) => {
    const env = { ...parent };
    if (svc.port) env.PORT = String(svc.port); else delete env.PORT;
    return env;
  };
  const parent = { PORT: "8787", ANTHROPIC_API_KEY: "secret", HOME: "/home/steven" };

  assert.strictEqual(envFor({ name: "scanner", port: 3847 }, parent).PORT, "3847",
    "the scanner is told 3847, which is what it would have defaulted to unaided");
  assert.strictEqual(envFor({ name: "portless" }, parent).PORT, undefined,
    "a service with no port of its own inherits none");
  assert.strictEqual(envFor({ name: "scanner", port: 3847 }, parent).ANTHROPIC_API_KEY, "secret",
    "everything else is still handed down");
  // The parent's environment is not modified in passing.
  assert.strictEqual(parent.PORT, "8787", "the dashboard's own PORT is untouched");
}

// ---- 3. the scanner really does default to the parent's PORT ------------------
{
  // If this ever stops being true the bug is gone, but so is the reason for the
  // fix -- and someone should see that here rather than rediscover it in a log.
  const dir = (/^SCANNER_DIR=(.*)$/m.exec(fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8").trim()) || [])[1];
  if (dir && fs.existsSync(path.join(dir.replace(/^["']|["']$/g, ""), "server.js"))) {
    const scanner = fs.readFileSync(path.join(dir.replace(/^["']|["']$/g, ""), "server.js"), "utf8");
    assert.ok(/process\.env\.PORT \|\| 3847/.test(scanner),
      "the scanner still takes PORT from its environment, so the parent must not leak its own");
  }
}

console.log("service ports: a supervised child is given its own port and the rest of the environment, never the dashboard's port");
