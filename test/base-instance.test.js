// node test/base-instance.test.js -- the Base instance as a whole: the router (--chains), the
// start/stop scripts under a stub harness (no real process or port is touched), and the
// read-only guarantee of an LP_READONLY=1 server with the Base settings.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-inst-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });
const freePort = () => new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const request = (port, p, { method = "GET", headers = {} } = {}) => new Promise((resolve) => {
  const r = http.request({ host: "127.0.0.1", port, path: p, method, headers, timeout: 15000 }, (res) => {
    let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, body: "" }); }); r.on("error", () => resolve({ status: 0, headers: {}, body: "" }));
  r.end();
});
const upstream = (key, port) => new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    res.setHeader("Set-Cookie", `csrf=${key}-token; Path=/`);
    if ((req.headers["content-type"] || "") === "x") return res.end();
    if (req.url.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ chain: key, path: req.url, cookie: req.headers.cookie || "" })); }
    res.setHeader("Content-Type", "text/html"); res.end(`<html><body>UPSTREAM-${key}</body></html>`);
  }).listen(port, "127.0.0.1", () => resolve(s));
});

(async () => {
  // ---- 11. the router ---------------------------------------------------------
  {
    const R = require("../chain-router");
    assert.deepStrictEqual(R.CHAINS.map((c) => c.key), ["robinhood", "arc"], "the default list is exactly what it was");
    assert.deepStrictEqual(R.KNOWN_CHAINS.map((c) => c.key), ["robinhood", "arc", "base"]);
    assert.strictEqual(R.KNOWN_CHAINS.find((c) => c.key === "base").port, 8796);
    assert.strictEqual(R.KNOWN_CHAINS.find((c) => c.key === "base").accent, "#0052ff");
    R.server.close();

    const [rh, arc, base, router1, router2] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    const servers = [await upstream("robinhood", rh), await upstream("arc", arc)];
    const baseServer = await upstream("base", base);
    const argv = (p, chains) => ["chain-router.js", `--port=${p}`, `--robinhood-port=${rh}`, `--arc-port=${arc}`, `--base-port=${base}`, ...(chains ? [`--chains=${chains}`] : [])];
    const children = [];
    const launch = async (args) => {
      const out = [];
      const c = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, LP_ROUTER_CHAINS: "" } });
      c.stdout.on("data", (d) => out.push(String(d))); c.stderr.on("data", (d) => out.push(String(d)));
      children.push(c);
      const t0 = Date.now();
      while (!out.join("").includes("chain router on")) { if (Date.now() - t0 > 10000) throw new Error("router did not start"); await new Promise((r) => setTimeout(r, 50)); }
      return { out };
    };
    try {
      // default: Base is not in the picker, and ?chain=base / a base cookie fall back to Robinhood
      await launch(argv(router1));
      const home = await request(router1, "/", { headers: { cookie: "lpchain=base" } });
      assert.ok(home.body.includes("UPSTREAM-robinhood") && !/data-chain="base"/.test(home.body), "default router: no Base");
      assert.strictEqual(JSON.parse((await request(router1, "/api/who", { headers: { cookie: "lpchain=base" } })).body).chain, "robinhood");

      // --chains=robinhood,arc,base
      const { out } = await launch(argv(router2, "robinhood,arc,base"));
      assert.ok(/Base\s+->\s+127\.0\.0\.1:/.test(out.join("")), "the banner lists Base");
      const picked = await request(router2, "/", { headers: { cookie: "lpchain=base" } });
      assert.strictEqual(picked.status, 200);
      assert.ok(picked.body.includes("UPSTREAM-base"), "the Base instance answered");
      for (const key of ["robinhood", "arc", "base"]) assert.ok(picked.body.includes(`data-chain="${key}"`), `the picker lists ${key}`);
      assert.ok(/aria-current="page"[^>]*>[\s\S]{0,400}Base/.test(picked.body.replace(/\n/g, " ")) || picked.body.includes("Showing Base"), "and marks Base as current");
      assert.ok(picked.body.includes("#0052ff"), "in Base's accent");
      // ?chain=base sets the cookie and redirects
      const sel = await request(router2, "/x?chain=base");
      assert.strictEqual(sel.status, 302);
      assert.ok(/lpchain=base/.test(String(sel.headers["set-cookie"])));
      // cookie namespacing: base's csrf cookie is stored as c_base__csrf, and only that one is sent back to base
      assert.ok(/c_base__csrf=base-token/.test(String(picked.headers["set-cookie"])), String(picked.headers["set-cookie"]));
      const api = JSON.parse((await request(router2, "/api/thing", { headers: { cookie: "lpchain=base; c_base__csrf=B; c_arc__csrf=A; c_robinhood__csrf=R; plain=1" } })).body);
      assert.strictEqual(api.chain, "base");
      assert.ok(/csrf=B/.test(api.cookie) && !/csrf=A|csrf=R|lpchain|c_base__/.test(api.cookie), `base saw only its own cookie: ${api.cookie}`);
      // an unknown key is rejected, both ways
      assert.strictEqual(JSON.parse((await request(router2, "/api/who", { headers: { cookie: "lpchain=evil" } })).body).chain, "robinhood");
      assert.strictEqual((await request(router2, "/x?chain=http://evil")).status, 200, "an unknown ?chain= is ignored, not followed");
      // the arm routes go to ARM_CHAIN (robinhood), whatever is picked
      for (const p of ["/api/arm/status", "/api/unlock", "/api/lock"]) {
        assert.strictEqual(JSON.parse((await request(router2, p, { headers: { cookie: "lpchain=base" } })).body).chain, "robinhood", p);
      }
      // a Base instance that is down behaves like Arc down: its own 502 page, the other chains unaffected
      await new Promise((r) => baseServer.close(r));
      const down = await request(router2, "/", { headers: { cookie: "lpchain=base" } });
      assert.strictEqual(down.status, 502);
      assert.ok(/Base is not answering/.test(down.body) && down.body.includes("lp-chain-picker"));
      assert.strictEqual(JSON.parse((await request(router2, "/api/who", { headers: { cookie: "lpchain=arc" } })).body).chain, "arc");
      const vaults = JSON.parse((await request(router2, "/api/vaults")).body);
      assert.deepStrictEqual(vaults.chains.map((c) => c.key), ["robinhood", "arc", "base"]);
      assert.strictEqual(vaults.chains.find((c) => c.key === "base").reachable, false);
      // the default ports, as shipped
      const banner = spawnSync(process.execPath, ["-e", 'process.argv.push("--chains=robinhood,arc,base");const r=require("./chain-router");console.log(JSON.stringify(r.CHAINS.map(c=>[c.key,c.port])));r.server.close()'], { cwd: ROOT, encoding: "utf8" });
      assert.deepStrictEqual(JSON.parse(banner.stdout.trim()), [["robinhood", 8787], ["arc", 8797], ["base", 8796]]);
    } finally {
      for (const c of children) c.kill("SIGTERM");
      for (const s of servers) s.close();
      baseServer.close();
    }
  }

  // ---- 12. start-all.sh / stop-all.sh under a stub harness -----------------------
  {
    for (const f of ["start-all.sh", "stop-all.sh"]) assert.strictEqual(spawnSync("bash", ["-n", path.join(ROOT, f)]).status, 0, `${f} parses`);
    const bin = path.join(TMP, "bin"); fs.mkdirSync(bin);
    const LOG = path.join(TMP, "calls.log");
    const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); };
    stub("node", 'echo "node $*" >> "$STUB_LOG"; exit 0');
    stub("nohup", 'echo "nohup[LP_READONLY=${LP_READONLY:-}] $*" >> "$STUB_LOG"; exit 0');
    stub("pgrep", "exit 1");
    stub("ss", '[ "${1:-}" = "-ltnp" ] && { for p in $STUB_LISTEN; do echo "LISTEN 0 511 127.0.0.1:$p 0.0.0.0:* users:((\\"node\\",pid=$((4000+p%1000)),fd=19))"; done; exit 0; }\nfor p in $STUB_LISTEN; do echo "LISTEN 0 511 127.0.0.1:$p 0.0.0.0:*"; done; exit 0');
    const appDir = path.join(TMP, "app"); fs.mkdirSync(appDir);       // the scripts run from here: no .env, no real watchdog
    for (const f of ["start-all.sh", "stop-all.sh"]) fs.copyFileSync(path.join(ROOT, f), path.join(appDir, f));
    const run = (script, home, { listen = "", proc = "" } = {}) => {
      fs.writeFileSync(LOG, "");
      const r = spawnSync("bash", [path.join(appDir, script)], {
        cwd: appDir, encoding: "utf8", timeout: 20000,
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, STUB_LOG: LOG, STUB_LISTEN: listen, LP_TEST: "1", LP_PROC_ROOT: proc || path.join(TMP, "emptyproc"), BASH_ENV: path.join(TMP, "stubfns.sh") },
      });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);      // the stubs are backgrounded by the scripts
      return { r, calls: fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean) };
    };
    fs.mkdirSync(path.join(TMP, "emptyproc"));
    /** A fake /proc: pid -> argv, so stop-all.sh can be shown what holds a port without touching a real process. */
    const fakeProc = (pid, argv) => { const d = path.join(TMP, `proc-${pid}-${Math.random().toString(36).slice(2)}`); fs.mkdirSync(path.join(d, String(pid)), { recursive: true }); fs.writeFileSync(path.join(d, String(pid), "cmdline"), argv.join("\0") + "\0"); return d; };
    // `kill` is a builtin, so a PATH stub cannot replace it: a function from BASH_ENV does.
    fs.writeFileSync(path.join(TMP, "stubfns.sh"), 'kill() { echo "kill $*" >> "$STUB_LOG"; return 0; }\n');
    const mkHome = (...dirs) => { const h = fs.mkdtempSync(path.join(TMP, "home-")); for (const d of dirs) { fs.mkdirSync(path.join(h, d)); fs.writeFileSync(path.join(h, d, "settings.json"), "{}"); } return h; };

    // no Base settings: nothing Base-related, and no router (Arc absent too)
    let h = mkHome();
    let x = run("start-all.sh", h);
    assert.strictEqual(x.r.status, 0, x.r.stderr);
    assert.ok(!x.calls.some((c) => /8796|base/i.test(c)), `nothing Base-related: ${x.calls.join(" | ")}`);
    assert.ok(!x.calls.some((c) => /chain-router/.test(c)), "no router without a second chain");
    assert.ok(x.calls.some((c) => /server\.js --port=8787/.test(c)), `the main dashboard still starts: ${x.calls.join(" | ")} | ${x.r.stdout} ${x.r.stderr}`);
    // Arc only: the router list is exactly the old one
    h = mkHome("arc-data");
    x = run("start-all.sh", h);
    const router = x.calls.filter((c) => /chain-router/.test(c));
    assert.strictEqual(router.length, 1); assert.ok(/--chains=robinhood,arc(\s|$)/.test(router[0]) && !/base/.test(router[0]), router[0]);
    assert.ok(!x.calls.some((c) => /8796/.test(c)));
    // Base present: exactly one Base start, with the read-only flags; the router lists it
    h = mkHome("base-data");
    x = run("start-all.sh", h);
    const starts = x.calls.filter((c) => /server\.js/.test(c) && /8796/.test(c));
    assert.strictEqual(starts.length, 1, x.calls.join(" | "));
    assert.ok(starts[0].startsWith("nohup[LP_READONLY=1]"), starts[0]);
    assert.ok(starts[0].includes(`node server.js --data-dir=${h}/base-data --port=8796 --no-loops --no-services`), starts[0]);
    assert.ok(!/--claim-scan/.test(starts[0]), "the Uniswap claim scan is not part of the Base instance");
    const r2 = x.calls.filter((c) => /chain-router/.test(c));
    assert.strictEqual(r2.length, 1); assert.ok(/--chains=robinhood,arc,base/.test(r2[0]), r2[0]);
    // both, and overridden locations
    h = mkHome("arc-data", "base-data");
    x = run("start-all.sh", h);
    assert.strictEqual(x.calls.filter((c) => /--port=8796/.test(c)).length, 1);
    // already listening on 8796: not started twice
    x = run("start-all.sh", h, { listen: "8796" });
    assert.strictEqual(x.calls.filter((c) => /server\.js.*--port=8796/.test(c)).length, 0);
    assert.ok(/base viewer: already running on :8796/.test(x.r.stdout), x.r.stdout);

    // stop-all.sh stops the Base port (and only that one for Base)
    const basePid = 4000 + 8796 % 1000;
    x = run("stop-all.sh", h, { listen: "8796", proc: fakeProc(basePid, ["node", "server.js", `--data-dir=${h}/base-data`, "--port=8796", "--no-loops", "--no-services"]) });
    const kills = x.calls.filter((c) => /^kill /.test(c));
    assert.ok(kills.includes(`kill ${basePid}`), `the Base viewer's pid is stopped: ${kills.join(" | ")}`);
    assert.ok(/base viewer: stopped/.test(x.r.stdout));
    // Something else on 8796 (another program, or a server with another data dir) is left alone.
    for (const argv of [["python3", "-m", "http.server", "8796"], ["node", "server.js", `--data-dir=${h}/arc-data`, "--port=8796"], ["node", "other.js", `--data-dir=${h}/base-data`], ["node", "server.js", `--data-dir=${h}/base-data-2`, "--port=8796"]]) {
      x = run("stop-all.sh", h, { listen: "8796", proc: fakeProc(basePid, argv) });
      assert.ok(!x.calls.some((c) => c === `kill ${basePid}`), `must not kill ${argv.join(" ")}: ${x.calls.join(" | ")}`);
      assert.ok(/not the Base viewer/.test(x.r.stdout), x.r.stdout);
    }
    // a pid that has vanished from the process table is not killed either
    x = run("stop-all.sh", h, { listen: "8796" });
    assert.ok(!x.calls.some((c) => c === `kill ${basePid}`), "unknown process: left alone");
    x = run("stop-all.sh", h, { listen: "" });
    assert.ok(!/base viewer/.test(x.r.stdout), "nothing running, nothing stopped");

    // the instance command line, statically
    const startSh = fs.readFileSync(path.join(ROOT, "start-all.sh"), "utf8");
    const block = startSh.slice(startSh.indexOf("start_base() {"), startSh.indexOf("start_base\n"));
    assert.ok(/LP_READONLY=1 nohup node server\.js --data-dir="\$dir" --port="\$port" --no-loops --no-services/.test(block), "LP_READONLY=1 ... --no-loops --no-services");
  }

  // ---- 10. read-only ------------------------------------------------------------
  {
    const example = fs.readFileSync(path.join(ROOT, "settings.base.example.json"), "utf8");
    assert.ok(!/privateKey|mnemonic|keystore|passphrase|proapi_|BEGIN [A-Z ]*PRIVATE/i.test(example), "no key material in the Base example");
    const raw = JSON.parse(example);
    for (const k of ["collector", "vault", "arm", "risk"]) assert.ok(!(k in raw), `no ${k} section`);

    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(TMP, "ro-"));
    fs.writeFileSync(path.join(dir, "settings.json"), example);
    const out = [];
    const child = spawn(process.execPath, ["--require", path.join(__dirname, "fixtures", "stub-network.js"), "server.js", `--data-dir=${dir}`, `--port=${port}`, "--no-loops", "--no-services"], {
      cwd: ROOT, env: { ...process.env, LP_DATA_DIR: "", LP_READONLY: "1", HOME: dir, LP_BIND: "127.0.0.1" },
    });
    child.stdout.on("data", (d) => out.push(String(d))); child.stderr.on("data", (d) => out.push(String(d)));
    try {
      const t0 = Date.now();
      while (!out.join("").includes("Dashboard running")) {
        if (child.exitCode != null) throw new Error(`server exited early: ${out.join("").slice(-300)}`);
        if (Date.now() - t0 > 30000) throw new Error("server did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
      const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" };
      // What the Arc tests rely on: arm / unlock / lock / collect refuse outright, with the reason.
      for (const p of ["/api/collect", "/api/arm", "/api/arm/setup", "/api/unlock", "/api/lock"]) {
        const r = await request(port, p, { method: "POST", headers: h });
        assert.strictEqual(r.status, 403, `${p}: ${r.status} ${r.body.slice(0, 100)}`);
        assert.ok(/read-only/.test(r.body), `${p} says why`);
      }
      // Approval and quote routes would read the operator keystore / build tx data: refused on GET too.
      for (const p of ["/api/approval?v=3", "/api/v4-approval", "/api/sell/quote?token=0x0000000000000000000000000000000000000001&amount=1", "/api/mint/context"]) {
        const r = await request(port, p, { headers: h });
        assert.strictEqual(r.status, 403, `${p}: ${r.status} ${r.body.slice(0, 100)}`);
        assert.ok(/read-only/.test(r.body) && !/"operator":"0x/.test(r.body), `${p} says why, no operator`);
      }
      // Every other state-changing route is refused too (read-only, localhost-only, or not found), never accepted.
      for (const p of ["/api/tasks/run", "/api/backup", "/api/risk", "/api/memecoins/close", "/api/sell/record", "/api/sell", "/api/approve", "/api/claim", "/api/claims/collect", "/api/stake", "/api/unstake"]) {
        const r = await request(port, p, { method: "POST", headers: h });
        assert.ok(r.status >= 400 || !/"ok":\s*true/.test(r.body), `${p} must not succeed: ${r.status} ${r.body.slice(0, 120)}`);
        assert.ok(!/"ok":\s*true/.test(r.body), `${p} must not report success`);
      }
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
    // And statically: nothing in the new code signs or sends.
    for (const f of ["slipstream.js", "endpoint.js", "tools/verify-onchain.js"]) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.ok(!/sendTransaction|signTransaction|signMessage|new ethers\.Wallet|sendRawTransaction|\.approve\(|setApprovalForAll|\.deposit\(|\.withdraw\(|getReward\(/.test(src), `${f} has no signing or write path`);
    }
  }

  // ---- LP_READONLY alone does not remove calldata or the operator (Arc viewer, Robinhood VM) ----------
  {
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(TMP, "ro-arc-"));
    fs.writeFileSync(path.join(dir, "settings.json"), fs.readFileSync(path.join(ROOT, "settings.example.json"), "utf8"));
    assert.ok(Number(JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")).chain.chainId) !== 8453);
    const OPERATOR = require("ethers").getAddress("0x00000000000000000000000000000000000000ab");
    const ks = path.join(dir, "ks.json");
    fs.writeFileSync(ks, JSON.stringify({ address: OPERATOR.slice(2) }));
    const out = [];
    const child = spawn(process.execPath, ["--require", path.join(__dirname, "fixtures", "stub-network-approval.js"), "server.js", `--data-dir=${dir}`, `--port=${port}`, "--no-loops", "--no-services"], {
      cwd: ROOT, env: { ...process.env, LP_DATA_DIR: "", LP_READONLY: "1", STUB_CHAIN_ID: "4663", LP_KEYSTORE_PATH: ks, HOME: dir, LP_BIND: "127.0.0.1" },
    });
    child.stdout.on("data", (d) => out.push(String(d))); child.stderr.on("data", (d) => out.push(String(d)));
    try {
      const t0 = Date.now();
      while (!out.join("").includes("Dashboard running")) {
        if (child.exitCode != null) throw new Error(`server exited early: ${out.join("").slice(-300)}`);
        if (Date.now() - t0 > 30000) throw new Error("server did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
      const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
      for (const p of ["/api/sell/quote?token=0x0000000000000000000000000000000000000001&amount=1", "/api/mint/context"]) {
        const r = await request(port, p, { headers: h });
        assert.notStrictEqual(r.status, 403, `${p} is served on a read-only, non-noTransactionData instance: ${r.status} ${r.body.slice(0, 100)}`);
      }
      const ap = await request(port, "/api/approval?v=3", { headers: h });
      assert.ok(ap.body.includes(OPERATOR), `the fixture operator is shown: ${ap.body.slice(0, 200)}`);
      const ch = JSON.parse((await request(port, "/api/chain", { headers: h })).body);
      assert.strictEqual(ch.readOnly, true);
      assert.strictEqual(ch.noTx, false, "read-only is not noTx");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
  }

  // ---- an env RPC URL's key is redacted, a static file is not rewritten ----------------------------
  {
    const KEY = "0123456789abcdefABCDEF0123456789";
    const port = await freePort();
    const dir = fs.mkdtempSync(path.join(TMP, "ro-env-"));
    fs.writeFileSync(path.join(dir, "settings.json"), fs.readFileSync(path.join(ROOT, "settings.base.example.json"), "utf8"));
    const out = [];
    const child = spawn(process.execPath, ["--require", path.join(__dirname, "fixtures", "stub-network.js"), "server.js", `--data-dir=${dir}`, `--port=${port}`, "--no-loops", "--no-services"], {
      cwd: ROOT, env: { ...process.env, LP_DATA_DIR: "", LP_READONLY: "1", LP_BASE_RPC_URL: `https://x.example/ethereum/${KEY}`, HOME: dir, LP_BIND: "127.0.0.1" },
    });
    child.stdout.on("data", (d) => out.push(String(d))); child.stderr.on("data", (d) => out.push(String(d)));
    try {
      const t0 = Date.now();
      while (!out.join("").includes("Dashboard running")) {
        if (child.exitCode != null) throw new Error(`server exited early: ${out.join("").slice(-300)}`);
        if (Date.now() - t0 > 30000) throw new Error("server did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
      const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
      const js = await request(port, "/dashboard.js", { headers: h });
      assert.strictEqual(js.body, fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8"), "dashboard.js is served byte for byte");
      const wp = await request(port, "/wallet", { headers: h });
      assert.ok(wp.body.includes("window.ethereum"), "served wallet.html still contains 'ethereum'");
      assert.strictEqual(wp.body, fs.readFileSync(path.join(ROOT, "wallet.html"), "utf8"), "wallet.html is served byte for byte");
      const ch = await request(port, "/api/chain", { headers: h });
      assert.ok(!ch.body.includes(KEY), "the key is not in an API body");
      assert.ok(!out.join("").includes(KEY), "nor in the log");
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
    // A dynamic body that contains the key is redacted on the way out.
    const { redactChunk, registerEndpoint } = require("../endpoint");
    registerEndpoint(`https://x.example/ethereum/${KEY}`, { env: true });
    assert.ok(!String(redactChunk(JSON.stringify({ error: `failed https://x.example/ethereum/${KEY}`, k: KEY }))).includes(KEY));
  }

  console.log("base instance: router --chains, start/stop scripts under a stub harness, and the read-only server passed");
})().catch((e) => { console.error(e); process.exit(1); });
