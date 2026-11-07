// node test/pulse-wiring.test.js -- the PulseChain instance as a whole, no network and no real process or port:
// the example settings, the router (--chains), start-all.sh / stop-all.sh under a stub harness, the read-only
// guarantee of an LP_READONLY=1 server, endpoint secrecy (LP_PULSE_RPC_URL), the v2 LP positions end to end
// through /api/watch (a PulseChain answered from memory), the v2 card, and tools/verify-pulsechain-wallets.js.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawn, spawnSync } = require("child_process");
const { hermeticEnv, hermeticCwd, PRELOAD } = require("./lib/hermetic");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-pw-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });
const EXAMPLE_FILE = path.join(ROOT, "settings.pulsechain.example.json");
const example = fs.readFileSync(EXAMPLE_FILE, "utf8");
const STUB = path.join(__dirname, "fixtures", "stub-pulse-network.js");
const freePort = () => new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const request = (port, p, { method = "GET", headers = {} } = {}) => new Promise((resolve) => {
  const r = http.request({ host: "127.0.0.1", port, path: p, method, headers, timeout: 20000 }, (res) => {
    let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, body: "" }); }); r.on("error", () => resolve({ status: 0, headers: {}, body: "" }));
  r.end();
});
const upstream = (key, port) => new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    res.setHeader("Set-Cookie", `csrf=${key}-token; Path=/`);
    if (req.url.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ chain: key, path: req.url, cookie: req.headers.cookie || "" })); }
    res.setHeader("Content-Type", "text/html"); res.end(`<html><body>UPSTREAM-${key}</body></html>`);
  }).listen(port, "127.0.0.1", () => resolve(s));
});
/** Start server.js on `dir` under the PulseChain stub; resolves { child, out, port, stop }. */
async function startServer(dir, env = {}, port = null) {
  port = port || await freePort();
  const out = [];
  const child = spawn(process.execPath, ["--require", PRELOAD, "--require", STUB, path.join(ROOT, "server.js"), `--data-dir=${dir}`, `--port=${port}`, "--no-loops", "--no-services"], {
    cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: "", LP_READONLY: "1", HOME: dir, LP_BIND: "127.0.0.1", ...env }),
  });
  child.stdout.on("data", (d) => out.push(String(d))); child.stderr.on("data", (d) => out.push(String(d)));
  const t0 = Date.now();
  while (!out.join("").includes("Dashboard running")) {
    if (child.exitCode != null) throw new Error(`server exited early: ${out.join("").slice(-400)}`);
    if (Date.now() - t0 > 30000) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, out, port, stop: async () => { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); } };
}
/** /api/watch answers 202 while the first read of the watched wallets is running: poll until it has. */
async function watchOf(port, headers) {
  for (let i = 0; i < 100; i++) {
    const r = await request(port, "/api/watch", { headers });
    const j = JSON.parse(r.body);
    if (j.ok) return j;
    await new Promise((res) => setTimeout(res, 300));
  }
  throw new Error("/api/watch never became ready");
}
const mkDir = (settings = example) => { const d = fs.mkdtempSync(path.join(TMP, "inst-")); fs.writeFileSync(path.join(d, "settings.json"), settings); return d; };

(async () => {
  // ---- 2. the example settings ---------------------------------------------------------------
  {
    const raw = JSON.parse(example);
    for (const k of ["collector", "vault", "arm", "risk"]) assert.ok(!(k in raw), `no ${k} section`);
    assert.ok(!/privateKey|mnemonic|keystore|passphrase|proapi_|BEGIN [A-Z ]*PRIVATE|apikey|api_key/i.test(example), "no key material in the example");
    assert.strictEqual(raw.noTransactionData, true);
    const cfg = require("../settings").load({ file: EXAMPLE_FILE });
    assert.strictEqual(cfg.chainId, 369);
    assert.ok(/^https:\/\//.test(cfg.rpcUrl) && !/@|\?/.test(cfg.rpcUrl), "a public https RPC");
    assert.strictEqual(cfg.ownerAddress, "0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8"); assert.strictEqual(cfg.ownerLabel, "Main");
    assert.deepStrictEqual(cfg.watchWallets.map((w) => w.label), ["Wallet 11", "Wallet 12", "Wallet 2", "Wallet 3", "Wallet 5"]);
    assert.deepStrictEqual(cfg.watchWallets.map((w) => w.address), ["0xFc1235E6523Becf4b329ed9ADf21750cfAF65Bfb", "0xAAB445f2846476A31Aaed66112B0f3e2ad82c50A", "0x6314077131232f7D8282d07DcB4c31387dDC81DA", "0xA78c81a0b7551BD9a6F6965fB01AafaE9CEf96ca", "0xb4e5753644BAe0dCbB9D6e7B5ea7EaC8d5aF5cf0"]);
    assert.ok(cfg.watchWallets.every((w) => !w.collect), "nothing collects");
    assert.strictEqual(cfg.noTransactionData, true);
    assert.deepStrictEqual(cfg.contracts.v2lp.map((s) => s.name), ["pulsex-v1", "pulsex-v2"]);
    assert.deepStrictEqual(cfg.contracts.pulsex.farms.map((f) => f.kind), ["pulsex-masterchef"]);
    assert.ok(!cfg.contracts.positionManager && !cfg.contracts.factory && !cfg.contracts.v4, "no Uniswap v3/v4 contracts on PulseChain");
    assert.strictEqual(cfg.nativeCurrency.symbol, "PLS");
    // every example address is a checksummed address
    for (const a of example.match(/0x[0-9a-fA-F]{40}\b/g)) assert.strictEqual(ethers.getAddress(a), a, `${a} is checksummed`);
    // the forked pDAI is not a configured stable
    assert.ok(!/0x6B175474E89094C44Da98b954EedeAC495271d0F/i.test(example));
  }

  // ---- 9. the router --------------------------------------------------------------------------
  {
    const R = require("../chain-router");
    assert.deepStrictEqual(R.CHAINS.map((c) => c.key), ["robinhood", "arc"], "the default list is exactly what it was");
    R.server.close();
    const [rh, arc, pulse, router1, router2] = await Promise.all([freePort(), freePort(), freePort(), freePort(), freePort()]);
    const servers = [await upstream("robinhood", rh), await upstream("arc", arc)];
    const pulseServer = await upstream("pulsechain", pulse);
    const argv = (p, chains) => [path.join(ROOT, "chain-router.js"), `--port=${p}`, `--robinhood-port=${rh}`, `--arc-port=${arc}`, `--pulsechain-port=${pulse}`, ...(chains ? [`--chains=${chains}`] : [])];
    const children = [];
    const launch = async (args) => {
      const out = [];
      const c = spawn(process.execPath, ["--require", PRELOAD, ...args], { cwd: hermeticCwd(), env: hermeticEnv({ LP_ROUTER_CHAINS: "" }) });
      c.stdout.on("data", (d) => out.push(String(d))); c.stderr.on("data", (d) => out.push(String(d)));
      children.push(c);
      const t0 = Date.now();
      // the banner is several lines that can arrive in separate chunks: wait for one "->" line per chain asked for
      const want = (args.find((a) => a.startsWith("--chains=")) || "").split("=")[1];
      const lines = want ? want.split(",").length : 1;
      while (!/chain router on/.test(out.join("")) || (out.join("").match(/->\s+127\.0\.0\.1:/g) || []).length < lines) {
        if (Date.now() - t0 > 10000) throw new Error("router did not start");
        await new Promise((r) => setTimeout(r, 50));
      }
      return { out };
    };
    try {
      await launch(argv(router1));
      const home = await request(router1, "/", { headers: { cookie: "lpchain=pulsechain" } });
      assert.ok(home.body.includes("UPSTREAM-robinhood") && !/data-chain="pulsechain"/.test(home.body), "default router: no PulseChain");
      const { out } = await launch(argv(router2, "robinhood,arc,pulsechain"));
      assert.ok(/PulseChain\s+->\s+127\.0\.0\.1:/.test(out.join("")), "the banner lists PulseChain");
      const picked = await request(router2, "/", { headers: { cookie: "lpchain=pulsechain" } });
      assert.ok(picked.body.includes("UPSTREAM-pulsechain"), "the PulseChain instance answered");
      for (const key of ["robinhood", "arc", "pulsechain"]) assert.ok(picked.body.includes(`data-chain="${key}"`), `the picker lists ${key}`);
      assert.ok(picked.body.includes("#c026d3"), "in PulseChain's accent");
      const sel = await request(router2, "/x?chain=pulsechain");
      assert.strictEqual(sel.status, 302); assert.ok(/lpchain=pulsechain/.test(String(sel.headers["set-cookie"])));
      assert.ok(/c_pulsechain__csrf=pulsechain-token/.test(String(picked.headers["set-cookie"])), String(picked.headers["set-cookie"]));
      const api = JSON.parse((await request(router2, "/api/thing", { headers: { cookie: "lpchain=pulsechain; c_pulsechain__csrf=P; c_arc__csrf=A; c_robinhood__csrf=R" } })).body);
      assert.strictEqual(api.chain, "pulsechain");
      assert.ok(/csrf=P/.test(api.cookie) && !/csrf=A|csrf=R|lpchain|c_pulsechain__/.test(api.cookie), `PulseChain saw only its own cookie: ${api.cookie}`);
      assert.strictEqual(JSON.parse((await request(router2, "/api/who", { headers: { cookie: "lpchain=evil" } })).body).chain, "robinhood");
      for (const p of ["/api/arm/status", "/api/unlock", "/api/lock"]) assert.strictEqual(JSON.parse((await request(router2, p, { headers: { cookie: "lpchain=pulsechain" } })).body).chain, "robinhood", p);
      await new Promise((r) => pulseServer.close(r));
      const down = await request(router2, "/", { headers: { cookie: "lpchain=pulsechain" } });
      assert.strictEqual(down.status, 502); assert.ok(/PulseChain is not answering/.test(down.body));
      const banner = spawnSync(process.execPath, ["--require", PRELOAD, "-e", `process.argv.push("--chains=robinhood,arc,base,pulsechain");const r=require(${JSON.stringify(path.join(ROOT, "chain-router"))});console.log(JSON.stringify(r.CHAINS.map(c=>[c.key,c.port])));r.server.close()`], { cwd: hermeticCwd(), env: hermeticEnv(), encoding: "utf8" });
      assert.deepStrictEqual(JSON.parse(banner.stdout.trim()), [["robinhood", 8787], ["arc", 8797], ["base", 8796], ["pulsechain", 8795]]);
    } finally {
      for (const c of children) c.kill("SIGTERM");
      for (const s of servers) s.close();
      pulseServer.close();
    }
  }

  // ---- 9. start-all.sh / stop-all.sh under a stub harness -------------------------------------------
  {
    for (const f of ["start-all.sh", "stop-all.sh"]) assert.strictEqual(spawnSync("bash", ["-n", path.join(ROOT, f)]).status, 0, `${f} parses`);
    const bin = path.join(TMP, "bin"); fs.mkdirSync(bin);
    const LOG = path.join(TMP, "calls.log");
    const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); };
    stub("node", 'echo "node $*" >> "$STUB_LOG"; exit 0');
    stub("nohup", 'echo "nohup[LP_READONLY=${LP_READONLY:-}] $*" >> "$STUB_LOG"; exit 0');
    stub("pgrep", "exit 1");
    stub("ss", '[ "${1:-}" = "-ltnp" ] && { for p in $STUB_LISTEN; do echo "LISTEN 0 511 127.0.0.1:$p 0.0.0.0:* users:((\\"node\\",pid=$((4000+p%1000)),fd=19))"; done; exit 0; }\nfor p in $STUB_LISTEN; do echo "LISTEN 0 511 127.0.0.1:$p 0.0.0.0:*"; done; exit 0');
    const appDir = path.join(TMP, "app"); fs.mkdirSync(appDir);
    for (const f of ["start-all.sh", "stop-all.sh"]) fs.copyFileSync(path.join(ROOT, f), path.join(appDir, f));
    fs.mkdirSync(path.join(TMP, "emptyproc"));
    fs.writeFileSync(path.join(TMP, "stubfns.sh"), 'kill() { echo "kill $*" >> "$STUB_LOG"; return 0; }\n');
    const run = (script, home, { listen = "", proc = "", env = {} } = {}) => {
      fs.writeFileSync(LOG, "");
      const r = spawnSync("bash", [path.join(appDir, script)], {
        cwd: appDir, encoding: "utf8", timeout: 20000,
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, STUB_LOG: LOG, STUB_LISTEN: listen, LP_TEST: "1", LP_PROC_ROOT: proc || path.join(TMP, "emptyproc"), BASH_ENV: path.join(TMP, "stubfns.sh"), ...env },
      });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      return { r, calls: fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean) };
    };
    const fakeProc = (pid, argv) => { const d = path.join(TMP, `proc-${pid}-${Math.random().toString(36).slice(2)}`); fs.mkdirSync(path.join(d, String(pid)), { recursive: true }); fs.writeFileSync(path.join(d, String(pid), "cmdline"), argv.join("\0") + "\0"); return d; };
    const mkHome = (...dirs) => { const h = fs.mkdtempSync(path.join(TMP, "home-")); for (const d of dirs) { fs.mkdirSync(path.join(h, d)); fs.writeFileSync(path.join(h, d, "settings.json"), "{}"); } return h; };

    // no PulseChain settings: nothing PulseChain-related; the router list is unchanged
    let h = mkHome();
    let x = run("start-all.sh", h);
    assert.strictEqual(x.r.status, 0, x.r.stderr);
    assert.ok(!x.calls.some((c) => /8795|pulse/i.test(c)), `nothing PulseChain-related: ${x.calls.join(" | ")}`);
    assert.ok(!x.calls.some((c) => /chain-router/.test(c)), "no router without a second chain");
    h = mkHome("arc-data", "base-data");
    x = run("start-all.sh", h);
    const r0 = x.calls.filter((c) => /chain-router/.test(c));
    assert.ok(/--chains=robinhood,arc,base(\s|$)/.test(r0[0]) && !/pulse/.test(r0[0]), `unchanged without pulse-data: ${r0[0]}`);
    // PulseChain present: exactly one start, read-only, no loops, no services; the router lists it
    h = mkHome("pulse-data");
    x = run("start-all.sh", h);
    const starts = x.calls.filter((c) => /server\.js/.test(c) && /8795/.test(c));
    assert.strictEqual(starts.length, 1, x.calls.join(" | "));
    assert.ok(starts[0].startsWith("nohup[LP_READONLY=1]"), starts[0]);
    assert.ok(starts[0].includes(`node server.js --data-dir=${h}/pulse-data --port=8795 --no-loops --no-services`), starts[0]);
    assert.ok(!/--claim-scan/.test(starts[0]));
    const r1 = x.calls.filter((c) => /chain-router/.test(c));
    assert.strictEqual(r1.length, 1); assert.ok(/--chains=robinhood,arc,pulsechain(\s|$)/.test(r1[0]), r1[0]);
    h = mkHome("arc-data", "base-data", "pulse-data");
    x = run("start-all.sh", h);
    assert.ok(/--chains=robinhood,arc,base,pulsechain(\s|$)/.test(x.calls.find((c) => /chain-router/.test(c))));
    assert.strictEqual(x.calls.filter((c) => /--port=8795/.test(c)).length, 1);
    // overridden location and port
    const custom = fs.mkdtempSync(path.join(TMP, "custom-")); fs.writeFileSync(path.join(custom, "settings.json"), "{}");
    x = run("start-all.sh", mkHome(), { env: { LP_PULSE_DATA_DIR: custom, LP_PULSE_PORT: "18795" } });
    assert.ok(x.calls.some((c) => c.includes(`--data-dir=${custom} --port=18795 --no-loops --no-services`)), x.calls.join(" | "));
    // already listening: not started twice
    x = run("start-all.sh", h, { listen: "8795" });
    assert.strictEqual(x.calls.filter((c) => /server\.js.*--port=8795/.test(c)).length, 0);
    assert.ok(/pulsechain viewer: already running on :8795/.test(x.r.stdout), x.r.stdout);

    // stop-all.sh stops the PulseChain port, only a process that really is the PulseChain viewer, and nothing on other ports
    const pid = 4000 + 8795 % 1000;
    x = run("stop-all.sh", h, { listen: "8795", proc: fakeProc(pid, ["node", "server.js", `--data-dir=${h}/pulse-data`, "--port=8795", "--no-loops", "--no-services"]) });
    assert.ok(x.calls.filter((c) => /^kill /.test(c)).includes(`kill ${pid}`), `the viewer's pid is stopped: ${x.calls.join(" | ")}`);
    assert.ok(/pulsechain viewer: stopped/.test(x.r.stdout));
    for (const argv of [["python3", "-m", "http.server", "8795"], ["node", "server.js", `--data-dir=${h}/arc-data`, "--port=8795"], ["node", "other.js", `--data-dir=${h}/pulse-data`], ["node", "server.js", `--data-dir=${h}/pulse-data-2`, "--port=8795"]]) {
      x = run("stop-all.sh", h, { listen: "8795", proc: fakeProc(pid, argv) });
      assert.ok(!x.calls.some((c) => c === `kill ${pid}`), `must not kill ${argv.join(" ")}: ${x.calls.join(" | ")}`);
      assert.ok(/not the PulseChain viewer/.test(x.r.stdout), x.r.stdout);
    }
    x = run("stop-all.sh", h, { listen: "8796 8797 8787", proc: fakeProc(4000 + 8796 % 1000, ["node", "server.js", `--data-dir=${h}/pulse-data`, "--port=8795"]) });
    assert.ok(!/pulsechain viewer/.test(x.r.stdout), "other ports never trigger the PulseChain stop");
    x = run("stop-all.sh", h, { listen: "8795" });
    assert.ok(!x.calls.some((c) => c === `kill ${pid}`), "an unknown process is left alone");
    // the instance command line, statically
    const startSh = fs.readFileSync(path.join(ROOT, "start-all.sh"), "utf8");
    const block = startSh.slice(startSh.indexOf("start_pulse() {"), startSh.indexOf("start_pulse\n"));
    assert.ok(/LP_READONLY=1 nohup node server\.js --data-dir="\$dir" --port="\$port" --no-loops --no-services/.test(block), "LP_READONLY=1 ... --no-loops --no-services");
    assert.ok(/\$\{LP_PULSE_DATA_DIR:-\$HOME\/pulse-data\}/.test(block) && /\$\{LP_PULSE_PORT:-8795\}/.test(block));
  }

  // ---- 9/10. read-only server, LP positions end to end, secrecy, SSRF -------------------------------------
  {
    const dir = mkDir();
    const log = path.join(TMP, "net.log");
    const srv = await startServer(dir, { STUB_LOG: log });
    try {
      const h = { host: `127.0.0.1:${srv.port}`, origin: `http://127.0.0.1:${srv.port}`, "content-type": "application/json" };
      for (const p of ["/api/collect", "/api/arm", "/api/arm/setup", "/api/unlock", "/api/lock"]) {
        const r = await request(srv.port, p, { method: "POST", headers: h });
        assert.strictEqual(r.status, 403, `${p}: ${r.status}`); assert.ok(/read-only/.test(r.body));
      }
      for (const p of ["/api/approval?v=3", "/api/v4-approval", "/api/sell/quote?token=0x0000000000000000000000000000000000000001&amount=1", "/api/mint/context"]) {
        const r = await request(srv.port, p, { headers: h });
        assert.strictEqual(r.status, 403, `${p}: ${r.status}`); assert.ok(/read-only/.test(r.body));
      }
      for (const p of ["/api/tasks/run", "/api/backup", "/api/risk", "/api/memecoins/close", "/api/sell/record", "/api/sell", "/api/approve", "/api/claim", "/api/claims/collect", "/api/stake", "/api/unstake"]) {
        const r = await request(srv.port, p, { method: "POST", headers: h });
        assert.ok(r.status >= 400 || !/"ok":\s*true/.test(r.body), `${p} must not succeed: ${r.status}`);
      }
      const ch = JSON.parse((await request(srv.port, "/api/chain", { headers: h })).body);
      assert.strictEqual(ch.chainId, 369); assert.strictEqual(ch.noTx, true); assert.strictEqual(ch.readOnly, true);
      assert.strictEqual(ch.rpc, "https://rpc.pulsechain.com", "only an origin");
      assert.strictEqual(ch.nativeCurrency.symbol, "PLS");

      // the v2 LP positions of Wallet 12 reach /api/watch in `external`, never `positions`
      const watch = await watchOf(srv.port, h);
      assert.strictEqual(watch.wethUsd, 0.05, "WPLS/USD from the reference pair's reserves");
      const w12 = watch.wallets.find((w) => w.label === "Wallet 12");
      assert.deepStrictEqual(w12.positions, [], "nothing the collector, guardian or Sell tab can act on");
      const meme = w12.external.find((p) => p.pairAddress.toLowerCase().endsWith("b0001"));
      assert.strictEqual(meme.protocol, "pulsex-v2"); assert.strictEqual(meme.kind, "v2lp");
      assert.strictEqual(meme.pair, "MEME / WPLS"); assert.strictEqual(meme.sharePct, 10);
      assert.ok(Math.abs(meme.valueUsd - 2 * (20_000 * 500 / 10_500)) < 1e-6, `MEME priced from the other pool (MEME/DAI) and capped at what 500 MEME realise through it (x*y=k); WPLS from the reference pair: ${meme.valueUsd}`);
      const evil = w12.external.find((p) => p.pairAddress.toLowerCase().endsWith("b0003"));
      assert.ok(!/[<>]/.test(evil.pair + evil.symbol0), `a markup symbol is plain text: ${evil.pair}`);
      assert.strictEqual(evil.valueUsd, null, "an unpriced side: null, not 0");
      assert.strictEqual(w12.totals.idle, 0, "v2 positions are not counted as out of range");
      const thinPos = w12.external.find((p) => p.pairAddress.toLowerCase().endsWith("b0005"));
      assert.ok(thinPos && thinPos.thin === true, "the thin pool is still shown on its card");
      assert.ok(thinPos.valueUsd > 3.9 && thinPos.valueUsd <= 4, `10% of a pool with $20 a side: 2 x min($2, $2), the sides capped by x*y=k: ${thinPos.valueUsd}`);
      assert.strictEqual(w12.totals.liquidityUsd, meme.valueUsd, "a thin pool is left out of the liquidity total");
      assert.strictEqual(w12.totals.uncountedUsd, thinPos.valueUsd, "and reported as shown-but-not-counted");
      assert.ok(!w12.holdings.tokens.some((t) => t.symbol === "PLP" || /b0001$/.test(t.address || "")), "an LP token of a configured factory is not listed as a loose token");
      assert.ok(w12.holdings.tokens.some((t) => t.symbol === "MEME"), "while an ordinary token still is");
      assert.ok(w12.holdings.tokens.some((t) => t.symbol === "PLS" || t.symbol === "ETH"), "native balance is listed");
      for (const w of watch.wallets.filter((x) => x.label !== "Wallet 12")) assert.deepStrictEqual(w.external, [], `${w.label} holds no LP`);
      const main = JSON.parse((await request(srv.port, "/api/positions", { headers: h })).body);
      assert.deepStrictEqual(main.positions, []); assert.strictEqual(main.chainId, 369);
      const net = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const outbound = net.filter((n) => n.kind === "fetch" && !/^127\.0\.0\.1:/.test(n.host));      // the local pool scanner (:3847) is an existing, optional sidecar
      assert.ok(outbound.length > 0 && outbound.every((n) => n.host === "api.scan.pulsechain.com" && n.auth === false), `only the PulseChain explorer is asked, without credentials: ${JSON.stringify([...new Set(outbound.map((n) => n.host + n.auth))])}`);
    } finally { await srv.stop(); }

    // Blockscout answers HTML: the same positions are found by enumerating the factory
    const dir2 = mkDir();
    const srv2 = await startServer(dir2, { STUB_EXPLORER: "html" });
    try {
      const h = { host: `127.0.0.1:${srv2.port}`, origin: `http://127.0.0.1:${srv2.port}` };
      const watch = await watchOf(srv2.port, h);
      const w12 = watch.wallets.find((w) => w.label === "Wallet 12");
      assert.ok(w12.external.some((p) => p.pair === "MEME / WPLS"), "found by enumeration when the explorer list is unavailable");
      assert.ok(fs.existsSync(path.join(dir2, "v2lp-scan-pulsex-v2.json")), "the cursor lives in the instance's data dir");
      assert.ok((srv2.out.join("").match(/explorer token list unavailable/g) || []).length === 1, "unavailable is logged once");
    } finally { await srv2.stop(); }

    // LP_PULSE_RPC_URL: the key never reaches a body, a log line or an error
    const KEY = "0123456789abcdefABCDEF0123456789";
    const dir3 = mkDir();
    const srv3 = await startServer(dir3, { LP_PULSE_RPC_URL: `https://x.example/pulse/${KEY}` });
    try {
      const h = { host: `127.0.0.1:${srv3.port}`, origin: `http://127.0.0.1:${srv3.port}` };
      for (const p of ["/api/chain", "/api/watch", "/api/positions", "/api/wallet", "/api/vault", "/wallet"]) {
        const r = await request(srv3.port, p, { headers: h });
        assert.ok(!r.body.includes(KEY), `${p}: no key in the body`);
      }
      assert.strictEqual(JSON.parse((await request(srv3.port, "/api/chain", { headers: h })).body).rpc, "https://rpc.pulsechain.com", "the page is told the public origin");
      assert.ok(!srv3.out.join("").includes(KEY), "nor in the log");
    } finally { await srv3.stop(); }
    // invalid endpoints fail closed without echoing the URL
    for (const bad of ["http://rpc.example/SECRETPATH?k=SECRETQ", "https://127.0.0.1/SECRETPATH", "https://localhost/SECRETPATH", "https://user:SECRETPW@rpc.example/p", "https://169.254.169.254/SECRETPATH"]) {
      const r = spawnSync(process.execPath, ["--require", PRELOAD, "-e", `require(${JSON.stringify(path.join(ROOT, "settings"))}).load()`], { cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: dir, LP_PULSE_RPC_URL: bad }), encoding: "utf8" });
      assert.notStrictEqual(r.status, 0, `${bad} is refused`);
      assert.ok(/LP_PULSE_RPC_URL rejected/.test(r.stderr), r.stderr.slice(0, 300));
      assert.ok(!/SECRET/.test(r.stdout + r.stderr), "the error carries no part of the URL");
    }
    // the settings file is validated too (369 is a strict chain)
    for (const [field, value] of [["rpcUrl", "http://rpc.pulsechain.com"], ["explorer", "https://10.0.0.1"], ["blockscout", "https://localhost"]]) {
      const c = JSON.parse(example); c.chain[field] = value;
      assert.throws(() => require("../settings").toLegacy(c), new RegExp(`chain\\.${field} rejected`), field);
    }
    // the PRO key is never sent to the PulseChain explorer, and bsFetch refuses a stranger
    const bs = spawnSync(process.execPath, ["--require", PRELOAD, "--require", STUB, "-e", `
      const b = require(${JSON.stringify(path.join(ROOT, "blockscout"))});
      (async () => {
        const r1 = await b.bsFetch("/v2/addresses/0xAAB445f2846476A31Aaed66112B0f3e2ad82c50A/token-balances");
        let refused = false;
        try { await b.bsFetch("https://evil.example/x"); } catch (e) { refused = /not an allowed Blockscout host/.test(e.message); }
        const r2 = await b.bsFetch("https://api.scan.pulsechain.com/api/v2/addresses/0xAAB445f2846476A31Aaed66112B0f3e2ad82c50A/token-balances");
        console.log(JSON.stringify({ ok1: r1.ok, ok2: r2.ok, refused, apiBase: b.apiBase(), auth: !!b.headers().Authorization }));
      })();`], { cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: dir, BLOCKSCOUT_API_KEY: "proapi_SECRETPROKEY", STUB_LOG: path.join(TMP, "bs.log") }), encoding: "utf8" });
    const bsOut = JSON.parse(bs.stdout.trim().split("\n").pop());
    assert.deepStrictEqual(bsOut, { ok1: true, ok2: true, refused: true, apiBase: "https://api.scan.pulsechain.com/api", auth: false });
    const bsNet = fs.readFileSync(path.join(TMP, "bs.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(bsNet.length === 2 && bsNet.every((n) => n.host === "api.scan.pulsechain.com" && n.auth === false), "no Authorization to the explorer, nothing sent to evil.example");
    assert.ok(!(bs.stdout + bs.stderr).includes("SECRETPROKEY"));
    // no route lets a request choose an endpoint
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.ok(!/\.get\(\s*["'](rpc|rpcUrl|url|explorer|blockscout|endpoint|provider)["']\s*\)/.test(src));
    // statically: nothing in the new code signs or sends
    for (const f of ["v2lp.js", "tools/verify-pulsechain-wallets.js", "tools/verify-onchain.js"]) {
      const code = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      assert.ok(!/sendTransaction|signTransaction|signMessage|new ethers\.Wallet|sendRawTransaction|\.approve\(|setApprovalForAll|\.deposit\(|\.withdraw\(|getReward\(|harvest/.test(code), `${f} has no signing or write path`);
    }
  }

  // ---- the v2 card renders text, not markup ------------------------------------------------------------------
  {
    const src = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");
    const fn = src.slice(src.indexOf("function v2Card(p, d, o) {"), src.indexOf("function positionCard(p, d, opts) {"));
    assert.ok(fn.length > 500 && /kind === 'v2lp'/.test(src.slice(src.indexOf("function positionCard(p, d, opts) {"), src.indexOf("function positionCard(p, d, opts) {") + 200)));
    const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const card = vm.runInNewContext(`${fn}; v2Card`, { esc, usd: (n) => (n == null ? "—" : "$" + n), amount: (n) => String(n), chainRef: (b, p2, label) => label, shortA: (a) => a, EXPLORER: "https://scan.pulsechain.com", freshText: () => "fresh" });
    const evil = "<img src=x onerror=alert(1)>";
    const p = { kind: "v2lp", protocol: "pulsex-v2", pair: evil, pairAddress: "0x1", symbol0: evil, symbol1: evil, valueUsd: null, valueNote: evil, usd0: null, usd1: null, amount0: 1, amount1: 1, reserve0: 1, reserve1: 1, lpBalance: 1, totalSupply: 2, sharePct: 50, staked: true, farm: evil, farmAddress: "0x2", rewards: { amount: 1, symbol: evil, usd: null }, thin: true, thinNote: evil, feesNote: evil };
    const html = card(p, {}, { wallet: evil });
    assert.ok(!html.includes("<img"), "markup in a symbol, a label or a note is escaped");
    assert.ok(html.includes("&lt;img"), "and shown as text");
  }

  // ---- 11. tools/verify-pulsechain-wallets.js -------------------------------------------------------------------
  {
    const tool = require("../tools/verify-pulsechain-wallets");
    const { world, units } = require("./fixtures/mock-pulse");
    const cfg0 = require("../settings").load({ file: EXAMPLE_FILE });
    const c = cfg0.contracts;
    const w = world();
    const WPLS = c.weth, DAI = cfg0.usdReference.stable, [, USDC, USDT] = c.pulsex.stables;
    w.token(WPLS, "WPLS", 18); w.token(DAI, "DAI", 18); w.token(USDC, "USDC", 6); w.token(USDT, "USDT", 6);
    const V1 = c.v2lp[0].factory, V2 = c.v2lp[1].factory;
    w.factory(V1); w.factory(V2);
    w.pair(cfg0.usdReference.pair, V1, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18));
    const MEME = ethers.getAddress("0x00000000000000000000000000000000000a0001"); w.token(MEME, "MEME", 18);
    w.pair(ethers.getAddress("0x00000000000000000000000000000000000b0002"), V1, MEME, DAI, units(10_000, 18), units(20_000, 18), units(1, 18));
    const lp = w.pair(ethers.getAddress("0x00000000000000000000000000000000000b0001"), V2, MEME, WPLS, units(5_000, 18), units(200_000, 18), units(1_000, 18), { [cfg0.watchWallets[1].address]: units(100, 18), [cfg0.watchWallets[0].address]: units(10, 18) });
    w.farm(c.pulsex.farms[0].address, ethers.getAddress("0x00000000000000000000000000000000000c0001"), [lp], { [`0:${cfg0.watchWallets[0].address.toLowerCase()}`]: [units(50, 18), units(2, 18)] });
    w.token(ethers.getAddress("0x00000000000000000000000000000000000c0001"), "INC", 18);
    w.native[cfg0.ownerAddress.toLowerCase()] = units(1234, 18);
    const attempts = [];
    const guarded = new Proxy(w.runner, { get(t, k) {
      if (["sendTransaction", "getSigner", "signMessage", "signTransaction", "broadcastTransaction", "send", "sendUncheckedTransaction"].includes(String(k))) { attempts.push(String(k)); throw new Error(`forbidden provider method ${String(k)}`); }
      return t[k];
    } });
    const live = { ...cfg0, rpcUrl: "https://x.example/pulse/0123456789abcdefABCDEF0123456789", rpcPublic: "https://rpc.pulsechain.com", rpcFromEnv: true };
    const data = await tool.run({ provider: guarded, cfg: live, bsFetch: null });
    assert.deepStrictEqual(attempts, [], "no signer, no send");
    assert.strictEqual(data.wallets.length, 6);
    assert.strictEqual(data.wplsUsd, 0.05);
    assert.strictEqual(data.rpc, "https://rpc.pulsechain.com");
    const w11 = data.wallets.find((x) => x.name === "Wallet 11"), w12 = data.wallets.find((x) => x.name === "Wallet 12");
    assert.strictEqual(w12.lp.length, 1); assert.strictEqual(w12.lp[0].sharePct, 10); assert.ok(Math.abs(w12.lp[0].valueUsd - 2 * (20_000 * 500 / 10_500)) < 1e-6, "MEME side capped through its source pool (x*y=k)");
    assert.strictEqual(w11.lp.length, 1); assert.strictEqual(w11.farm.length, 1, "the farm stake is listed");
    assert.strictEqual(w11.farm[0].sharePct, 5); assert.strictEqual(w11.farm[0].pendingReward.amount, 2); assert.strictEqual(w11.farm[0].farm, "pulsex-farm");
    assert.strictEqual(data.wallets[0].pls, 1234);
    const text = tool.render(data);
    for (const label of ["Main", "Wallet 11", "Wallet 12", "Wallet 2", "Wallet 3", "Wallet 5"]) assert.ok(text.includes(`== ${label}`), label);
    assert.ok(!/0123456789abcdef/.test(text + JSON.stringify(data)), "no key in the table or the JSON");
    assert.ok(fs.readdirSync(TMP).every((f) => !/v2lp-scan/.test(f)), "the tool writes no cursor");

    // the CLI, with --json, against the in-memory chain: parseable, holds the LP, and a keyed PULSE_RPC never appears
    const KEY = "0123456789abcdefABCDEF0123456789";
    const before = fs.readdirSync(ROOT).sort().join();
    const cli = spawnSync(process.execPath, ["--require", PRELOAD, "--require", STUB, path.join(ROOT, "tools/verify-pulsechain-wallets.js"), "--json"], { cwd: hermeticCwd(), env: hermeticEnv({ PULSE_RPC: `https://x.example/pulse/${KEY}`, LP_DATA_DIR: TMP }), encoding: "utf8", timeout: 60000 });
    assert.strictEqual(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout);
    assert.strictEqual(parsed.wallets.length, 6); assert.strictEqual(parsed.chainId, 369);
    assert.ok(parsed.wallets.find((x) => x.name === "Wallet 12").lp.some((p) => p.pair === "MEME / WPLS"));
    assert.ok(!(cli.stdout + cli.stderr).includes(KEY), "no keyed URL in the output");
    assert.strictEqual(parsed.rpc, "https://rpc.pulsechain.com", "the RPC is shown as the public origin");
    assert.strictEqual(fs.readdirSync(ROOT).sort().join(), before, "the tool wrote no file into the project");
    const cli2 = spawnSync(process.execPath, ["--require", PRELOAD, "--require", STUB, path.join(ROOT, "tools/verify-pulsechain-wallets.js")], { cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: TMP }), encoding: "utf8", timeout: 60000 });
    assert.strictEqual(cli2.status, 0, cli2.stderr); assert.ok(/== Wallet 12/.test(cli2.stdout) && /MEME \/ WPLS/.test(cli2.stdout));
    const bad = spawnSync(process.execPath, ["--require", PRELOAD, path.join(ROOT, "tools/verify-pulsechain-wallets.js")], { cwd: hermeticCwd(), env: hermeticEnv({ PULSE_RPC: "http://127.0.0.1:1/SECRETPATH" }), encoding: "utf8" });
    assert.notStrictEqual(bad.status, 0); assert.ok(!/SECRETPATH/.test(bad.stdout + bad.stderr), "a rejected RPC is not echoed");
  }

  console.log("pulsechain instance: example settings, router, start/stop scripts, read-only server, LP positions end to end, secrecy and the wallet tool passed");
})().catch((e) => { console.error(e); process.exit(1); });
