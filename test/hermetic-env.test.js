// node test/hermetic-env.test.js — the helper behind every server-spawning test: secrets
// blanked, dotenv cannot refill them, outbound network refused, loopback allowed.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { hermeticEnv, hermeticCwd, scrubbedEnv, PRELOAD } = require("./lib/hermetic");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hermetic-env-"));
const POLLUTED = { TELEGRAM_TOKEN: "abc", TELEGRAM_CHAT_ID: "1", ANTHROPIC_API_KEY: "k", LP_BASE_RPC_URL: "https://x.example/KEY",
  BLOCKSCOUT_API_KEY: "b", LP_KEYSTORE_PASS: "p", MY_VENDOR_API_KEY: "z" };

(async () => {
  try {
    // 5. env: every secret-looking name is "", PATH survives, `extra` wins
    const saved = { ...process.env };
    Object.assign(process.env, POLLUTED);
    try {
      const e = hermeticEnv();
      for (const k of Object.keys(POLLUTED)) assert.strictEqual(e[k], "", `${k} blanked`);
      assert.strictEqual(e.PATH, process.env.PATH);
      assert.strictEqual(e.LOOKS_SAFE, undefined);
      assert.strictEqual(hermeticEnv({ LP_BASE_RPC_URL: "https://fake.example" }).LP_BASE_RPC_URL, "https://fake.example");
      assert.strictEqual(hermeticEnv({ HOME: "/h" }).HOME, "/h");
      const realHome = process.env.HOME;
      assert.ok(e.HOME && e.HOME !== realHome, "HOME is a fresh temp dir, not the real one");
      assert.ok(hermeticEnv().HOME !== realHome && hermeticEnv().HOME !== e.HOME, "and a new one each time");
      assert.ok(e.LP_KEYSTORE_PATH && !path.resolve(e.LP_KEYSTORE_PATH).startsWith(path.resolve(realHome) + path.sep), "the keystore path is not under the real HOME");
      assert.ok(!fs.existsSync(e.LP_KEYSTORE_PATH), "and does not exist");
      assert.ok(e.NODE_OPTIONS.includes(`"${PRELOAD}"`) && e.NODE_OPTIONS.startsWith("--require "), "node grandchildren inherit the guard");
      for (const k of ["BASE_RPC", "BASE_LOGS_RPC", "PULSE_RPC"]) assert.strictEqual(e[k], "", k);
      for (const k of ["TELEGRAM_AGENT_TOKEN", "LP_PULSE_RPC_URL", "OLLAMA_API_KEY"]) assert.strictEqual(e[k], "", k);
      assert.ok(!("npm_config_cache" in e) && !("LP_DATA_DIR" in e), "nothing outside the allow-list leaks");
      const s = scrubbedEnv();
      assert.strictEqual(s.TELEGRAM_TOKEN, ""); assert.strictEqual(s.PATH, process.env.PATH);
      assert.strictEqual(scrubbedEnv({ PATH: "p", MY_PASS: "x", LP_KEYSTORE_PASS: "y", ANTHROPIC_API_KEY: "k" }).MY_PASS, "", "PASS names are scrubbed");
    } finally { for (const k of Object.keys(POLLUTED)) { if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; } }

    // 6. dotenv in the child finds no .env and cannot refill a blanked name
    const dot = JSON.stringify(path.join(ROOT, "node_modules", "dotenv"));
    const probe = `require(${dot}).config({ quiet: true }); process.stdout.write(JSON.stringify(process.env.TELEGRAM_TOKEN))`;
    const withEnvFile = path.join(tmp, "withenv"); fs.mkdirSync(withEnvFile);
    fs.writeFileSync(path.join(withEnvFile, ".env"), "TELEGRAM_TOKEN=fromfile\n");
    const raw = spawnSync(process.execPath, ["-e", probe], { cwd: withEnvFile, env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.strictEqual(raw.stdout, '"fromfile"', "control: dotenv does load a .env from the cwd");
    const viaHelper = spawnSync(process.execPath, ["-e", probe], { cwd: hermeticCwd(), env: hermeticEnv(), encoding: "utf8" });
    assert.strictEqual(viaHelper.stdout, '""');
    const sameCwd = spawnSync(process.execPath, ["-e", probe], { cwd: withEnvFile, env: hermeticEnv(), encoding: "utf8" });
    assert.strictEqual(sameCwd.stdout, '""', "even with a .env present the blanked name stays empty");
    assert.deepStrictEqual(fs.readdirSync(hermeticCwd()), [], "the cwd is empty");

    // 7. the preload: outbound refused and logged, loopback allowed
    const log = path.join(tmp, "nn.log");
    const srv = http.createServer((q, r) => r.end("pong")).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = srv.address().port;
    const child = `
      (async () => {
        let msg = "";
        try { await fetch("https://api.telegram.org/botX/sendMessage"); } catch (e) { msg = e.message; }
        let msg2 = "";
        try { require("https").get("https://rpc.example.org/x").on("error", () => {}); } catch (e) { msg2 = e.message; }
        const body = await new Promise((res, rej) => require("http").get({ host: "127.0.0.1", port: ${port} }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(b)); }).on("error", rej));
        const f = await (await fetch("http://127.0.0.1:${port}/")).text();
        console.log(JSON.stringify({ msg, msg2, body, f }));
      })();`;
    // async spawn: the parent's own loopback server must keep answering while the child runs
    const r7 = await new Promise((resolve) => {
      const c = spawn(process.execPath, ["--require", PRELOAD, "-e", child], { cwd: hermeticCwd(), env: hermeticEnv({ NO_NETWORK_LOG: log }) });
      let stdout = "", stderr = "";
      c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
      const t = setTimeout(() => c.kill("SIGTERM"), 20000);
      c.on("exit", (status) => { clearTimeout(t); resolve({ status, stdout, stderr }); });
    });
    srv.close();
    assert.strictEqual(r7.status, 0, r7.stderr);
    const o = JSON.parse(r7.stdout);
    assert.ok(o.msg.startsWith("no-network:") && o.msg.includes("api.telegram.org"), o.msg);
    assert.ok(o.msg2.startsWith("no-network:"), o.msg2);
    assert.strictEqual(o.body, "pong"); assert.strictEqual(o.f, "pong");
    const logged = fs.readFileSync(log, "utf8");
    assert.ok(logged.includes("api.telegram.org") && logged.includes("rpc.example.org"), logged);
    assert.ok(!logged.includes("127.0.0.1"), "loopback is not logged");

    // 7b. every other way out is refused and logged (192.0.2.1 is TEST-NET-1, never routable), loopback still works
    const log2 = path.join(tmp, "nn2.log");
    const srv2 = http.createServer((q, r) => r.end("pong")).listen(0, "127.0.0.1");
    await new Promise((r) => srv2.once("listening", r));
    const port2 = srv2.address().port;
    const probes = `
      const net = require("net"), http = require("http"), https = require("https"), tls = require("tls"), dns = require("dns");
      const out = {};
      const attempt = async (name, fn) => { try { await fn(); out[name] = "allowed"; } catch (e) { out[name] = e.message; } };
      (async () => {
        await attempt("socket", () => { const s = new net.Socket(); s.on("error", () => {}); s.connect(443, "192.0.2.1"); s.destroy(); });
        await attempt("socketOpts", () => { const s = new net.Socket(); s.on("error", () => {}); s.connect({ port: 443, host: "192.0.2.2" }); s.destroy(); });
        await attempt("numericString", () => { const s = net.connect("443", "192.0.2.3"); s.on("error", () => {}); s.destroy(); });
        await attempt("tls", () => { const s = tls.connect(443, "192.0.2.4"); s.on("error", () => {}); s.destroy(); });
        await attempt("urlOptions", () => { http.request("http://127.0.0.1:1/", { host: "192.0.2.5" }).on("error", () => {}).destroy(); });
        await attempt("clientRequest", () => { new http.ClientRequest("http://192.0.2.6/").on("error", () => {}).destroy(); });
        await attempt("lookup", () => new Promise((res, rej) => dns.lookup("remote.example.org", (e) => (e ? rej(e) : res()))));
        await attempt("plookup", () => dns.promises.lookup("remote2.example.org"));
        await attempt("resolve", () => { new dns.Resolver().resolve4("remote3.example.org", () => {}); });
        // loopback: still fine
        out.loop = await new Promise((res, rej) => http.get({ host: "127.0.0.1", port: ${port2} }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res(b)); }).on("error", rej));
        await new Promise((res, rej) => dns.lookup("localhost", (e) => (e ? rej(e) : res())));
        out.loopDns = "ok";
        const s = net.connect("${port2}", "127.0.0.1"); s.on("error", () => {}); s.destroy();
        console.log(JSON.stringify(out));
        process.exit(0);
      })();`;
    const pr = await new Promise((resolve) => {   // async: the parent's loopback server must keep answering
      const c = spawn(process.execPath, ["-e", probes], { cwd: hermeticCwd(), env: hermeticEnv({ NO_NETWORK_LOG: log2 }) });
      let stdout = "", stderr = "";
      c.stdout.on("data", (d) => (stdout += d)); c.stderr.on("data", (d) => (stderr += d));
      const t = setTimeout(() => c.kill("SIGTERM"), 30000);
      c.on("exit", (status, signal) => { clearTimeout(t); resolve({ status, signal, stdout, stderr }); });
    });
    srv2.close();
    assert.strictEqual(pr.status, 0, `${pr.signal} ${pr.stdout} ${pr.stderr}`);   // the guard comes in through NODE_OPTIONS alone
    const po = JSON.parse(pr.stdout);
    for (const k of ["socket", "socketOpts", "numericString", "tls", "urlOptions", "clientRequest", "lookup", "plookup", "resolve"]) assert.ok(String(po[k]).startsWith("no-network:"), `${k}: ${po[k]}`);
    assert.strictEqual(po.loop, "pong"); assert.strictEqual(po.loopDns, "ok");
    const l2 = fs.readFileSync(log2, "utf8");
    for (const h of ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4", "192.0.2.5", "192.0.2.6", "remote.example.org", "remote2.example.org", "remote3.example.org"]) assert.ok(l2.includes(h), `${h} logged: ${l2}`);
    assert.ok(!l2.includes("127.0.0.1"), "loopback is not logged");

    // 8. the real server under a polluted parent env: it runs against the stub network, and nothing from the parent reaches
    //    the network attempts or the output (the stub records host and path/query, so a leaked value would show)
    {
      const srvDir = fs.mkdtempSync(path.join(tmp, "inst-"));
      fs.copyFileSync(path.join(ROOT, "settings.base.example.json"), path.join(srvDir, "settings.json"));
      const stubLog = path.join(tmp, "stub.log"), nnLog = path.join(tmp, "rep-nn.log");
      const port = await new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
      const savedEnv = { ...process.env };
      Object.assign(process.env, POLLUTED, { TELEGRAM_TOKEN: "fake", LP_BASE_RPC_URL: "https://x.example/SECRET", BLOCKSCOUT_API_KEY: "proapi_x", BASE_RPC: "https://x.example/SECRET", PULSE_RPC: "https://x.example/SECRET" });
      const out = [];
      let child;
      try {
        child = spawn(process.execPath, ["--require", PRELOAD, "--require", path.join(__dirname, "fixtures", "stub-network.js"), path.join(ROOT, "server.js"), `--data-dir=${srvDir}`, `--port=${port}`, "--no-loops", "--no-services"], {
          cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: "", LP_READONLY: "1", LP_BIND: "127.0.0.1", STUB_LOG: stubLog, NO_NETWORK_LOG: nnLog }),
        });
      } finally { for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]; Object.assign(process.env, savedEnv); }
      child.stdout.on("data", (d) => out.push(String(d))); child.stderr.on("data", (d) => out.push(String(d)));
      try {
        const t0 = Date.now();
        while (!out.join("").includes("Dashboard running")) {
          if (child.exitCode != null) throw new Error(`server exited early: ${out.join("").slice(0, 700)}`);
          if (Date.now() - t0 > 30000) throw new Error("server did not start");
          await new Promise((r) => setTimeout(r, 100));
        }
        const body = await new Promise((resolve) => {
          const r = http.get({ host: "127.0.0.1", port, path: "/api/positions", timeout: 25000 }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b)); });
          r.on("timeout", () => { r.destroy(); resolve(""); }); r.on("error", () => resolve(""));
        });
        await new Promise((r) => setTimeout(r, 1000));
        const stubText = fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8") : "";
        assert.ok(stubText.trim().length > 0, "the server did attempt network use, and the stub saw it");
        const nnText = fs.existsSync(nnLog) ? fs.readFileSync(nnLog, "utf8") : "";
        for (const [name, t] of [["stub.log", stubText], ["no-network.log", nnText], ["server output", out.join("")], ["/api/positions", body]]) {
          for (const bad of ["api.telegram.org", "SECRET", "proapi_x", "x.example"]) assert.ok(!t.includes(bad), `${name} contains ${bad}: ${t.slice(0, 300)}`);
        }
      } finally { child.kill("SIGTERM"); await new Promise((r) => (child.exitCode != null ? r() : child.once("exit", r))); }
    }
    console.log("hermetic env passed");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
