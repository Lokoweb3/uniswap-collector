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

// The probe targets the PUBLIC Funnel address (tailscaled runs in userspace-networking, so the
// tailnet IP the WSL resolver returns can never be reached from this host). All resolution and
// curl calls are stubs; nothing here touches the network.
assert.match(out, /probe target: pinned to 209\.177\.145\.137/, "curl is pinned to the public IP with --resolve");
assert.match(out, /log has probed ip: yes/, "the probed IP and HTTP code are in the log line");
assert.match(out, /401 is up: +fails=0/, "the gate's 401 counts as up");
assert.match(out, /5xx x3: +repaired=yes/, "a real down (public IP, 5xx/000) still restarts after the threshold");
assert.match(out, /tailnet-only: curl calls=0 \(want 0\) fails=0 \(want 0\) repaired=no/,
  "tailnet/private answers are never probed, never counted, never restart tailscaled");
assert.match(out, /dns failure: fails=2 \(want 2, unchanged\) curl calls=0 \(want 0\) repaired=no/,
  "a DNS failure is unknown: no restart and the failure counter is left alone");
assert.match(out, /500 is up: +fails=0 \(want 0\) repaired=no/, "a 500 is the app answering: up, no repair");
assert.match(out, /gate down: +fails=0 \(want 0\) repaired=no \(want no\) notifies=1/,
  "502 with lp-gate not listening is not counted, never restarts tailscaled, notifies once");
assert.match(out, /curl rc 60: +fails=2 \(want 2, unchanged\) repaired=no/,
  "a TLS/cert mismatch at the pinned IP is unknown: fails unchanged, no repair");
assert.match(out, /unknown x7: notifies=1 \(want 1\) repaired=no/, "six UNKNOWNs in a row give one alert and no repair");
assert.match(out, /glob cname: rc=0 ip=209\.177\.145\.137/, "a glob-like CNAME line is never expanded");
assert.match(out, /reserved 198\.18\.0\.1: rejected/, "reserved-range answers are rejected");
assert.match(out, /missing dig: logged and notified/, "a missing dig is loud at startup");
assert.match(out, /fallback resolver: used/, "a non-public answer from one resolver falls through to the next");

// The other halves of the self-test must keep passing too.
assert.match(out, /wedged recovery:.*alive=no.*port free=yes.*start called=yes/,
  "a wedged dashboard is still stopped and started");
assert.match(out, /watchdogs before=(\d+) after=\1/, "and recovery never leaves a second watchdog behind");

console.log("watchdog: the public path is probed through the relay on its own slower clock, three failures restart the tunnel (not the dashboard), and one repair per gap");
