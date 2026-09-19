// node test/mcp-failure-reason.test.js — the assistant is told what actually went
// wrong, so it can say something true.
//
// Asked for an LP summary shortly after a restart, the assistant answered "watched
// wallets could not be loaded ... please try again later or check the dashboard
// directly". That looked like an invented excuse: the dashboard was running and
// answering other routes in milliseconds, and calling the tool by hand returned all
// three wallets.
//
// It had invented nothing. The tool handed it, verbatim: "Dashboard not reachable at
// http://127.0.0.1:8787: /api/watch -> watched wallets still loading. Start it with
// ./run-dashboard.sh." Every endpoint answering ok:false produced that same sentence,
// whether nothing was listening or the instance was simply building its first read.
// The model relayed a wrong reason; it did not make one up.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "lp-mcp.mjs"), "utf8");

// ---- 1. the three outcomes are distinguished at the source --------------------
{
  assert.match(src, /throw Object\.assign\(new Error\([^)]*\), \{ unreachable: true \}\)/,
    "a failed connection is marked unreachable");
  assert.match(src, /if \(j\.ok === false && j\.refreshing\)/,
    "an instance still building its first answer is recognised as warming");
  assert.match(src, /\{ refused: true \}/, "and an answered-but-unable response is its own case");
  // The old sentence must not be reachable for a warming instance.
  const failFn = src.slice(src.indexOf("const fail = (err)"), src.indexOf("const fail = (err)") + 900);
  assert.ok(/err && err\.warming/.test(failFn), "fail() branches on it");
  assert.ok(/do not suggest restarting anything/.test(failFn),
    "and tells the assistant not to send someone to restart a running dashboard");
}

// ---- 2. end to end, against servers that behave each way ----------------------
(async () => {
  const call = async (handler) => {
    const server = handler ? http.createServer(handler) : null;
    const port = await new Promise((res) => {
      if (!server) return res(8912);            // nothing listening on this one
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    process.env.LP_DASHBOARD_URL = `http://127.0.0.1:${port}`;
    // Fresh module each time: BASE is read at import.
    const { createServer } = await import(`${path.join(ROOT, "lp-mcp.mjs")}?t=${Date.now()}${Math.random()}`);
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer().connect(s);
    const cl = new Client({ name: "t", version: "1" });
    await cl.connect(c);
    const r = await cl.callTool({ name: "watched_wallets", arguments: {} });
    if (server) await new Promise((done) => server.close(done));
    return r.content[0].text;
  };
  const json = (body) => (q, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify(body)); };

  // Warming: running, first read in progress. This is the case that misled everyone.
  const warming = await call(json({ ok: false, refreshing: true, error: "watched wallets still loading", wallets: [] }));
  assert.ok(/still warming up/.test(warming), `says it is warming: ${warming}`);
  assert.ok(!/not reachable/.test(warming), "and not that the dashboard is unreachable");
  assert.ok(!/run-dashboard/.test(warming), "and does not tell anyone to start what is already running");
  assert.ok(/do not report it as missing or as zero/.test(warming),
    "an unavailable figure must not be turned into a zero downstream");

  // Answered, but cannot help: the dashboard is up and said why.
  const refused = await call(json({ ok: false, error: "no watched wallets configured" }));
  assert.ok(/it is running/.test(refused), `says it is running: ${refused}`);
  assert.ok(/no watched wallets configured/.test(refused), "and passes on what it actually said");

  // Genuinely unreachable: nothing is listening.
  const dead = await call(null);
  assert.ok(/not reachable/.test(dead), `names it unreachable: ${dead}`);
  assert.ok(/run-dashboard/.test(dead), "and here, and only here, suggests starting it");

  console.log("mcp failure reasons: warming, answered-but-unable and unreachable are three different messages, so the assistant can report the true one");
})().catch((e) => { console.error(e); process.exit(1); });
