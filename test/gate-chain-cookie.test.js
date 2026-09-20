// node test/gate-chain-cookie.test.js — the public gate lets the chain choice through,
// and nothing else.
//
// The gate strips cookies in both directions: nothing a client holds reaches the
// dashboard, and nothing behind the gate sets state on the public origin. That is
// right, except for one cookie. The chain router decides which chain to proxy to
// from `lpchain`, so with it stripped the public URL served Robinhood and only
// Robinhood: the cookie was set on a switch, stored by the browser, sent back, and
// thrown away at the gate. Arc was unreachable from outside the machine.
//
// What must not change: the gate's own session cookie never goes upstream, and no
// other upstream cookie reaches the browser.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "lp-gate.mjs"), "utf8");

// The two decisions are one-line filters inside proxy(). Rather than assert the
// source reads a certain way, the patterns themselves are lifted out and exercised:
// a test that only greps would pass against a regex that matched the wrong thing.
const outbound = new RegExp(/\.filter\(\(c\) => (\/.+?\/)\.test\(String\(c\)\.trim\(\)\)\)/.exec(src)[1]
  .replace(/^\//, "").replace(/\/$/, ""));
const inbound = new RegExp(/\.find\(\(c\) => (\/.+?\/)\.test\(c\)\)/.exec(src)[1]
  .replace(/^\//, "").replace(/\/$/, ""));

// ---- 1. upstream -> browser: the chain choice survives -------------------------
{
  const keep = (cookies) => cookies.filter((c) => outbound.test(String(c).trim()));
  assert.deepStrictEqual(keep(["lpchain=arc; Path=/; SameSite=Lax"]), ["lpchain=arc; Path=/; SameSite=Lax"],
    "the router's chain cookie reaches the browser");
  assert.deepStrictEqual(keep(["lpchain=robinhood; Path=/"]), ["lpchain=robinhood; Path=/"]);

  // Everything else the dashboard might set stays behind the gate.
  assert.deepStrictEqual(keep(["c_arc__csrf=abc; Path=/", "session=zzz; HttpOnly"]), [],
    "no other upstream cookie is forwarded");
  assert.deepStrictEqual(keep(["lpgate=forged; Path=/"]), [],
    "and upstream can never overwrite the gate's own session cookie");
  // A name that merely starts the same way is a different cookie.
  assert.deepStrictEqual(keep(["lpchainx=arc; Path=/", "xlpchain=arc"]), [],
    "the match is on the cookie's name, not a prefix of the line");
}

// ---- 2. browser -> upstream: only the chain choice is passed on ----------------
{
  const pick = (header) => String(header).split(";").map((c) => c.trim()).find((c) => inbound.test(c)) || null;
  assert.strictEqual(pick("lpgate=secret; lpchain=arc"), "lpchain=arc",
    "the chain choice reaches the router");
  assert.strictEqual(pick("lpchain=arc"), "lpchain=arc");
  assert.strictEqual(pick("lpchain=robinhood; other=1"), "lpchain=robinhood");

  // The session must not travel, whatever order it arrives in or how it is named.
  assert.strictEqual(pick("lpgate=secret"), null, "the gate's session never goes upstream");
  assert.strictEqual(pick("session=abc; csrf=def"), null, "nor does anything else the client holds");
  assert.ok(!String(pick("lpgate=secret; lpchain=arc")).includes("secret"),
    "and no part of the session rides along with the chain choice");

  // A value is a chain key, not a place to smuggle a second cookie or a header.
  for (const nasty of ["lpchain=arc; lpgate=secret", "lpchain=a\rb", "lpchain=../../etc", "lpchain=a b"]) {
    const got = pick(nasty);
    assert.ok(got === null || /^lpchain=[A-Za-z0-9_-]*$/.test(got), `refused or clean: ${nasty} -> ${got}`);
  }
}

// ---- 3. the gate fronts the router, not one chain ------------------------------
{
  assert.ok(/LP_GATE_DASHBOARD_UPSTREAM \|\| 8800/.test(src),
    "the public gate proxies to the chain router, so the URL reaches every chain");
  assert.ok(/HOP = new Set\(\[[^\]]*"cookie"/.test(src),
    "cookies are still hop headers: the allowance above is the only way through");
  const startAll = fs.readFileSync(path.join(__dirname, "..", "start-all.sh"), "utf8");
  assert.ok(/node chain-router\.js/.test(startAll),
    "and the router is started with everything else, or the public URL would have nothing to reach");
  const stopAll = fs.readFileSync(path.join(__dirname, "..", "stop-all.sh"), "utf8");
  assert.ok(/node chain-router\.js/.test(stopAll), "and stopped with it");
}

// ---- 4. reads pass, writes do not ---------------------------------------------
{
  // GET /api/risk is the guardian's status and changes nothing; the identical
  // payload is already public under /api/memecoins, from the same handler. Denying
  // one name and not the other emptied the Risk panel on the public URL and
  // answered {"ok":false,"error":"not available through the public gate"}.
  const deny = /!\/\^\\\/api\\\/\(([^)]*)\)/.exec(src);
  assert.ok(deny, "the gate still has a deny list for the dashboard site");
  const denied = deny[1].split("|");
  assert.ok(!denied.includes("risk"), "a read-only status is not denied");
  // What must stay denied: everything that arms, spends, closes or approves.
  for (const path of ["arm", "backup", "collect", "lock", "memecoins\\/close", "sales\\/approve", "unlock"]) {
    assert.ok(denied.includes(path), `${path.replace("\\", "")} is still refused through the gate`);
  }
  // And the write side of risk cannot pass by method: POST admits only these two.
  assert.match(src, /m === "POST" && \/\^\\\/api\\\/\(chat\(\\\/reset\)\?\|tasks\\\/run\)\$\//,
    "POST is limited to chat and the task runner, so POST /api/risk is refused whatever the deny list says");
}

console.log("gate cookies: the chain choice passes in both directions, the gate's session never goes upstream, and no other cookie crosses either way");
