// node test/login-throttle.test.js - shared login throttle (lp-gate.mjs, lp-mcp-remote.mjs).
// Injected clock, no sockets.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
const MIN = 60_000;

(async () => {
  const { clientKey, clientAddr, createThrottle, loginAttempt } = await import(path.join(ROOT, "login-throttle.mjs"));
  const mk = (o = {}) => { const c = { t: 1_000_000 }; const th = createThrottle({ now: () => c.t, ...o }); return { c, th }; };

  // 1. rotating the first XFF entry does not bypass; other real clients unaffected
  {
    const { th } = mk();
    const key = clientKey(req("127.0.0.1", "198.51.100.7"));
    assert.strictEqual(key, "198.51.100.7");
    for (let i = 0; i < 5; i++) { assert.ok(th.check(key).ok); th.fail(key); }
    for (let i = 0; i < 100; i++) {
      const k = clientKey(req("127.0.0.1", `10.${i}.0.1, 198.51.100.7`));
      assert.strictEqual(k, "198.51.100.7");
      assert.strictEqual(th.check(k).ok, false, "attempt " + (i + 6) + " locked");
    }
    assert.ok(th.check(clientKey(req("127.0.0.1", "1.1.1.1, 203.0.113.9"))).ok, "other client not locked");
  }
  // 2. first entry ignored; garbage falls back to peer
  {
    assert.strictEqual(clientKey(req("127.0.0.1", "1.1.1.1, 198.51.100.7")), "198.51.100.7");
    for (const bad of ["garbage", "", "999.1.1.1", "1.1.1.1, garbage", "1.1.1.1,"]) {
      assert.strictEqual(clientKey(req("127.0.0.1", bad)), "127.0.0.1", JSON.stringify(bad));
    }
    assert.strictEqual(clientKey(req("127.0.0.1")), "127.0.0.1");
    assert.strictEqual(clientKey(req("127.0.0.1", "198.51.100.7"), { trust: false }), "127.0.0.1");
  }
  // 3. non-loopback peer: XFF ignored
  assert.strictEqual(clientKey(req("192.0.2.5", "198.51.100.7")), "192.0.2.5");
  // 4. loopback forms and /64 sharing
  {
    assert.strictEqual(clientKey(req("::ffff:127.0.0.1", "198.51.100.7")), "198.51.100.7");
    assert.strictEqual(clientKey(req("::1", "198.51.100.7")), "198.51.100.7");
    assert.strictEqual(clientKey(req("::ffff:192.0.2.1", "198.51.100.7")), "192.0.2.1");
    const a = clientKey(req("127.0.0.1", "2001:db8:1:2:aaaa::1"));
    const b = clientKey(req("127.0.0.1", "2001:0DB8:1:2:bbbb:cccc:dddd:eeee"));
    const c = clientKey(req("127.0.0.1", "2001:db8:1:3::1"));
    assert.strictEqual(a, b); assert.notStrictEqual(a, c);
    assert.strictEqual(clientKey(req("127.0.0.1", "::ffff:198.51.100.7")), "198.51.100.7");
  }
  // 5. flooding does not wipe lockouts; cap holds; expiry unlocks
  {
    const { c, th } = mk();
    for (let i = 0; i < 5; i++) th.fail("A");
    assert.strictEqual(th.check("A").ok, false);
    for (let i = 0; i < 6000; i++) th.fail("junk" + i);
    assert.strictEqual(th.check("A").ok, false, "A still locked");
    assert.ok(th.size() <= 5000);
    c.t += 15 * MIN + 1;
    assert.ok(th.check("A").ok, "unlocked after expiry");
  }
  // 6. cap full of locked records: new key refused
  {
    const { th } = mk({ cap: 3, globalMax: 1e9 });
    for (const k of ["a", "b", "c"]) for (let i = 0; i < 5; i++) th.fail(k);
    assert.deepStrictEqual(th.check("new"), { ok: false, reason: "full" });
    assert.strictEqual(th.fail("new").ok, false);
    assert.strictEqual(th.check("a").reason, "locked");
    assert.strictEqual(th.size(), 3);
  }
  // 7. global budget
  {
    const { c, th } = mk({ globalMax: 60 });
    for (let i = 0; i < 61; i++) th.fail("k" + i);
    assert.deepStrictEqual(th.check("brand-new"), { ok: false, reason: "global" });
    th.success("k1");
    assert.strictEqual(th.check("brand-new").ok, false, "success does not reset global counter");
    c.t += 15 * MIN + 1;
    assert.ok(th.check("brand-new").ok);
  }
  // 8. TTL
  {
    const { c, th } = mk();
    for (let i = 0; i < 3; i++) th.fail("x");
    assert.strictEqual(th.size(), 1);
    c.t += 14 * MIN; assert.strictEqual(th.size(), 1);
    c.t += 1 * MIN + 1; assert.strictEqual(th.size(), 0);
  }
  // 9. gate proxy forwards the derived key, not the raw header
  const gate = read("lp-gate.mjs");
  assert.ok(/headers\["x-forwarded-for"\] = clientAddr\(req\);/.test(gate));
  assert.ok(/const clientIp = \(req\) => clientKey\(req\);/.test(gate));
  assert.ok(/loginAttempt\(\{ throttle/.test(gate), "gate login goes through loginAttempt (re-check after body)");
  assert.strictEqual(clientAddr(req("127.0.0.1", "1.1.1.1, 2001:db8:1:2:aaaa::1")), "2001:db8:1:2:aaaa::1", "upstream gets full normalized IP, not /64");
  assert.strictEqual(clientAddr(req("127.0.0.1", "9.9.9.9, 198.51.100.7")), "198.51.100.7");
  assert.strictEqual(clientAddr(req("192.0.2.5", "198.51.100.7")), "192.0.2.5");
  assert.strictEqual(clientAddr(req("127.0.0.1", "garbage")), "127.0.0.1");
  assert.ok(!/headers\["x-forwarded-for"\] = req\.headers/.test(gate));
  // 10. remote MCP uses the shared module
  const mcp = read("lp-mcp-remote.mjs");
  assert.ok(/app\.set\("trust proxy", "loopback"\)/.test(mcp));
  assert.ok(!/app\.set\("trust proxy", \d/.test(mcp));
  assert.ok(/from "\.\/login-throttle\.mjs"/.test(mcp));
  assert.ok(!/\bfailures\b/.test(mcp), "failures map is gone");
  assert.ok(/clientKey\(req\)/.test(mcp) && !/loginAllowed|loginFailed|loginSucceeded/.test(mcp));
  assert.ok(/from "\.\/login-throttle\.mjs"/.test(gate));
  // 11. source guard
  assert.ok(!/\.split\(","\)\[0\]/.test(gate), "no first-XFF-entry parsing in lp-gate.mjs");
  assert.ok(!/fails\.clear\(|\.clear\(\)/.test(read("login-throttle.mjs")), "no clear()");

  // 12. XFF port / bracket stripping
  {
    assert.strictEqual(clientAddr(req("127.0.0.1", "1.1.1.1, 198.51.100.7:4433")), "198.51.100.7");
    assert.strictEqual(clientAddr(req("127.0.0.1", "[2001:db8::5]:443")), "2001:db8::5");
    assert.strictEqual(clientAddr(req("127.0.0.1", "[2001:db8::5]")), "2001:db8::5");
    assert.strictEqual(clientKey(req("127.0.0.1", "[2001:db8:1:2:aa::5]:443")), clientKey(req("127.0.0.1", "2001:db8:1:2:bb::9")));
    assert.strictEqual(clientAddr(req("127.0.0.1", "198.51.100.7:99999999")), "127.0.0.1");
    assert.strictEqual(clientAddr(req("127.0.0.1", "[[::1]]:1")), "127.0.0.1");
  }
  // 13. env range checks: invalid -> default, warning does not echo the value
  {
    const warns = []; const ow = console.warn; console.warn = (m) => warns.push(String(m));
    const save = [process.env.LP_GATE_GLOBAL_MAX, process.env.LP_GATE_GLOBAL_WINDOW_MS];
    try {
      const fill = (th) => { let n = 0; while (th.check("k").ok && n < 20000) { th.fail("k" + n); n++; } return n; };
      for (const bad of ["0", "-5", "1e9", "10001", "abc", "2.5", "Infinity"]) {
        process.env.LP_GATE_GLOBAL_MAX = bad;
        assert.strictEqual(fill(createThrottle({ now: () => 1 })), 60, "default for " + bad);
      }
      assert.ok(warns.length >= 7 && warns.every((w) => !/10001|abc|Infinity/.test(w)), "warned without echo");
      process.env.LP_GATE_GLOBAL_MAX = "7";
      assert.strictEqual(fill(createThrottle({ now: () => 1 })), 7);
      delete process.env.LP_GATE_GLOBAL_MAX;
      for (const bad of ["5", "-1", "99999999999", "NaN"]) {
        process.env.LP_GATE_GLOBAL_WINDOW_MS = bad;
        const c = { t: 0 }; const th = createThrottle({ now: () => c.t });
        for (let i = 0; i < 60; i++) th.fail("w" + i);
        c.t += 15 * MIN + 1;
        assert.ok(th.check("z").ok, "window default for " + bad);
      }
      process.env.LP_GATE_GLOBAL_WINDOW_MS = "3600000";
      { const c = { t: 0 }; const th = createThrottle({ now: () => c.t }); for (let i = 0; i < 60; i++) th.fail("w" + i); c.t += 30 * MIN; assert.strictEqual(th.check("z").ok, false); }
    } finally {
      console.warn = ow;
      for (const [i, n] of ["LP_GATE_GLOBAL_MAX", "LP_GATE_GLOBAL_WINDOW_MS"].entries()) { if (save[i] === undefined) delete process.env[n]; else process.env[n] = save[i]; }
    }
  }
  // 14. engagement is announced once per engagement
  {
    let n = 0; const c = { t: 0 };
    const th = createThrottle({ now: () => c.t, globalMax: 3, onEngage: () => n++ });
    for (let i = 0; i < 3; i++) th.fail("a" + i);
    for (let i = 0; i < 10; i++) th.check("x");
    assert.strictEqual(n, 1);
    c.t += 15 * MIN + 1; assert.ok(th.check("x").ok);
    for (let i = 0; i < 3; i++) th.fail("b" + i);
    for (let i = 0; i < 10; i++) th.check("x");
    assert.strictEqual(n, 2);
  }
  // 15. race: bodies arrive after every request already passed the early check
  {
    const mkReqs = (th, ip, count) => {
      const scored = { n: 0 }; const release = [];
      const runs = Array.from({ length: count }, () => loginAttempt({
        throttle: th, ip,
        readForm: () => new Promise((r) => release.push(() => r({ p: "wrong" }))),
        checkPassphrase: () => { scored.n++; return false; },
      }));
      return { scored, release, runs };
    };
    // per-key: 4 prior failures, 5 concurrent requests -> exactly one more guess scored
    {
      const { th } = mk();
      for (let i = 0; i < 4; i++) th.fail("K");
      const { scored, release, runs } = mkReqs(th, "K", 5);
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(release.length, 5, "all five passed the early check");
      release.forEach((f) => f());
      const out = await Promise.all(runs);
      assert.strictEqual(scored.n, 1, "only one more guess scored");
      assert.strictEqual(out.filter((o) => o.status === "throttled").length, 4);
      assert.strictEqual(th.check("K").reason, "locked");
    }
    // global: 100 parallel requests from distinct keys score no more than globalMax
    {
      const { th } = mk({ globalMax: 60 });
      const all = []; const scored = { n: 0 }; const release = [];
      for (let i = 0; i < 100; i++) all.push(loginAttempt({
        throttle: th, ip: "ip" + i,
        readForm: () => new Promise((r) => release.push(() => r({ p: "x" }))),
        checkPassphrase: () => { scored.n++; return false; },
      }));
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(release.length, 100);
      release.forEach((f) => f());
      await Promise.all(all);
      assert.ok(scored.n <= 60 && scored.n > 0, "scored " + scored.n);
      assert.strictEqual(scored.n, 60);
    }
    // success path still works
    {
      const { th } = mk();
      const o = await loginAttempt({ throttle: th, ip: "S", readForm: async () => ({ p: "ok" }), checkPassphrase: () => true });
      assert.strictEqual(o.status, "ok");
    }
  }

  console.log("login-throttle: ok");
})().catch((e) => { console.error(e); process.exit(1); });
