// node test/host-guard.test.js — the server answers only to its own address.
//
// DNS rebinding: a page on evil.example, whose name has been rebound to 127.0.0.1,
// reaches this server with Origin and Host both reading evil.example:8787. Two
// existing checks let it through.
//
//   - Every "localhost-only" endpoint tests HOST, which is `process.env.LP_BIND ||
//     "127.0.0.1"` — the address the server binds, a constant. It says nothing about
//     who is asking, and is true for the rebound page as much as for the owner.
//   - csrf.isCrossSite compares the request's Origin to its own Host header, and
//     those agree, so the request counts as same-origin.
//
// Together they reach arm, unlock, approve, close and the rest. The Host header is
// the one part of that chain an attacker cannot forge away — the browser sends the
// name it was told to fetch — so it is checked before routing, for every method.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const csrf = require("../csrf");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ---- 1. the hole this closes, still demonstrable ------------------------------
{
  // If this ever stops being true the guard may be redundant — but it should be
  // seen here rather than assumed.
  assert.strictEqual(csrf.isCrossSite({ origin: "http://evil.example:8787", host: "evil.example:8787", secFetchSite: "same-origin" }), false,
    "a rebound page still reads as same-origin to the cross-site guard");
  assert.match(src, /const HOST = process\.env\.LP_BIND \|\| "127\.0\.0\.1"/,
    "and HOST is still the bind address, not the requester");
}

// ---- 2. the guard itself, lifted out and given hosts to judge -----------------
const from = src.indexOf("const EXTRA_HOSTS =");
assert.ok(from >= 0, "the host allowlist is gone from server.js");
const body = src.slice(from, src.indexOf("const refusedHosts = new Set();"));
const make = ({ port = 8787, extra = "", pub = null } = {}) => new Function("process", "PORT", "publicHost",
  body + "; return hostAllowed;")(
  { env: { LP_ALLOWED_HOSTS: extra } }, port, () => pub);

{
  const allowed = make({ port: 8787, pub: "lp-dashboard.taileaa1a0.ts.net" });

  // Its own address, the loopback spellings.
  for (const h of ["127.0.0.1:8787", "localhost:8787", "[::1]:8787", "127.0.0.1", "LOCALHOST:8787"]) {
    assert.strictEqual(allowed(h), true, `answers to ${h}`);
  }
  // The gate and the chain router both rewrite Host to 127.0.0.1:<upstream>.
  assert.strictEqual(allowed("127.0.0.1:8787"), true, "a proxied request arrives under this instance's own address");

  // The rebinding case, and its relatives.
  for (const h of ["evil.example:8787", "evil.example", "127.0.0.1.nip.io:8787", "attacker.localhost:8787", ""]) {
    assert.strictEqual(allowed(h), false, `refuses ${h || "(no Host)"}`);
  }
  // A loopback name on someone else's port is not this instance.
  assert.strictEqual(allowed("127.0.0.1:8797"), false, "the Arc instance's address is not this one's");

  // The tailnet name, on whatever port the serve mapping uses.
  assert.strictEqual(allowed("lp-dashboard.taileaa1a0.ts.net:8444"), true, "the tailnet name on :8444");
  assert.strictEqual(allowed("lp-dashboard.taileaa1a0.ts.net:8443"), true, "and on :8443");
  assert.strictEqual(allowed("lp-dashboard.taileaa1a0.ts.net"), true, "and with no port");
  assert.strictEqual(allowed("lp-dashboard.taileaa1a0.ts.net.evil.example"), false, "but not a name that merely ends with it");

  // Nothing is allowed by the tailnet rule when there is no tailnet.
  const noTailnet = make({ port: 8787, pub: null });
  assert.strictEqual(noTailnet("lp-dashboard.taileaa1a0.ts.net:8444"), false, "with no public name, none is trusted");
}

// ---- 3. an operator can name more, and only what they named -------------------
{
  const allowed = make({ port: 8787, extra: "dash.internal:8787, box.lan" });
  assert.strictEqual(allowed("dash.internal:8787"), true, "a configured host is answered");
  assert.strictEqual(allowed("box.lan:8787"), true, "with or without the port it was written with");
  assert.strictEqual(allowed("other.internal:8787"), false, "and nothing else");
}

// ---- 4. it runs before routing, for every method ------------------------------
{
  const handler = src.slice(src.indexOf("async function handleRequest(req, res) {"), src.indexOf("const url = new URL(req.url,"));
  assert.ok(/if \(!hostAllowed\(req\.headers\.host\)\)/.test(handler),
    "the check is the first thing handleRequest does");
  assert.ok(/res\.writeHead\(421/.test(handler), "and answers 421 Misdirected Request");
  // A GET is how rebinding reads data back out, so the guard must not be limited to
  // writes the way the cross-site guard is.
  assert.ok(!/req\.method/.test(handler), "with no exemption by method");
}

console.log("host guard: the server answers to its own address and the tailnet name, refuses a rebound Host with 421 before routing, and says so once per host");
