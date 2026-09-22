// node test/watchdog-public.test.js — the watchdog's self-test, run as part of the suite,
// with the public-path probe as its subject.
//
// On 2026-09-21 the site was unreachable from the internet for hours while every local
// check was green: the dashboard answered on loopback, the funnel listed every mapping and
// the cert was valid. The watchdog probed 127.0.0.1 only, so it saw nothing and did nothing;
// the outage was found by a person opening the page. The probe added for that failure has to
// be patient (the public path crosses a relay, and ingress takes ~25 s to propagate after a
// restart) and it must repair the TUNNEL, never the dashboard, which was never at fault.
"use strict";
const assert = require("assert");
const { execFileSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let out;
try {
  out = execFileSync("bash", [path.join(ROOT, "watchdog.sh"), "--self-test"], {
    encoding: "utf8", timeout: 120000, cwd: ROOT,
  });
} catch (e) {
  console.error(e.stdout || "", e.stderr || "");
  throw new Error("watchdog --self-test exited non-zero");
}

// The self-test asserts its own invariants and exits non-zero on failure; these pin the
// public-probe lines so a silent removal of that section cannot pass unnoticed.
assert.match(out, /public probe/, "the self-test exercises the public probe");
assert.match(out, /answering: +fails=0 \(want 0\) repaired=no/, "a healthy public path repairs nothing");
assert.match(out, /down x2: +fails=2 \(want 2\) repaired=no/, "two failures are not yet an outage");
assert.match(out, /down x3: +fails=0 \(want 0\) repaired=yes/, "three consecutive failures restart the tunnel");
assert.match(out, /inside gap: repaired again=no/, "and it will not restart the tunnel again straight away");
assert.match(out, /recovered: +fails=0/, "recovery clears the counter");

// The other halves of the self-test must keep passing too.
assert.match(out, /wedged recovery:.*alive=no.*port free=yes.*start called=yes/,
  "a wedged dashboard is still stopped and started");
assert.match(out, /watchdogs before=(\d+) after=\1/, "and recovery never leaves a second watchdog behind");

console.log("watchdog: the public path is probed through the relay on its own slower clock, three failures restart the tunnel (not the dashboard), and one repair per gap");
