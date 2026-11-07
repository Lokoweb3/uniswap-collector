// node test/claim-fees-route.test.js -- the Base server (LP_READONLY=1, settings.base.example.json, a mocked Base chain,
// hermetic child) serves GET /api/claim-fees/target and the two browser modules, and still refuses every transaction route.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { hermeticEnv, hermeticCwd, PRELOAD } = require("./lib/hermetic");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-claim-route-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });
const freePort = () => new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const request = (port, p, { method = "GET", headers = {} } = {}) => new Promise((resolve) => {
  const r = http.request({ host: "127.0.0.1", port, path: p, method, headers, timeout: 60000 }, (res) => {
    let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, body: "" }); }); r.on("error", () => resolve({ status: 0, headers: {}, body: "" }));
  r.end();
});
const MGR_A = "0x827922686190790b37229fd06084350E74485b72", MGR_B = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53";
const WALLET = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743";
const EVIL = "0x00000000000000000000000000000000000000ee";

(async () => {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(TMP, "base-"));
  fs.writeFileSync(path.join(dir, "settings.json"), fs.readFileSync(path.join(ROOT, "settings.base.example.json"), "utf8"));
  const log = path.join(dir, "stub.log");
  const out = [];
  const child = spawn(process.execPath, ["--require", PRELOAD, "--require", path.join(__dirname, "fixtures", "stub-base-network.js"), path.join(ROOT, "server.js"), `--data-dir=${dir}`, `--port=${port}`, "--no-loops", "--no-services"], {
    cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: "", LP_READONLY: "1", HOME: dir, LP_BIND: "127.0.0.1", STUB_LOG: log }),
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
    const get = (p) => request(port, p, { headers: h });

    // a known position on each manager: 200 JSON, manager from settings, owner from the chain
    const a = await get("/api/claim-fees/target?protocol=aerodrome-v1&id=79371151");
    assert.strictEqual(a.status, 200, a.body.slice(0, 300));
    assert.ok(/application\/json/.test(a.headers["content-type"]));
    const ja = JSON.parse(a.body);
    assert.strictEqual(ja.ok, true, a.body);
    assert.strictEqual(ja.manager, MGR_A); assert.strictEqual(ja.owner, WALLET); assert.strictEqual(ja.chainId, 8453);
    assert.strictEqual(ja.staked, false); assert.strictEqual(ja.feesOk, true);
    assert.strictEqual(ja.fee0, 0.002); assert.strictEqual(ja.fee1, 5);
    for (const k of ["data", "calldata", "to", "tx", "rpc", "rpcUrl"]) assert.ok(!(k in ja), `no ${k}`);
    assert.ok(!/https?:\/\/[^"]*(rpc|infura|alchemy|quicknode)/i.test(a.body), "no RPC URL");
    const jb = JSON.parse((await get("/api/claim-fees/target?protocol=aerodrome-cl2&id=8905958")).body);
    assert.strictEqual(jb.manager, MGR_B); assert.strictEqual(jb.owner, WALLET);

    // injected parameters are ignored
    const ev = JSON.parse((await get(`/api/claim-fees/target?protocol=aerodrome-v1&id=79371151&manager=${EVIL}&to=${EVIL}&recipient=${EVIL}&owner=${EVIL}`)).body);
    assert.strictEqual(ev.manager, MGR_A); assert.strictEqual(ev.owner, WALLET);
    assert.ok(!JSON.stringify(ev).toLowerCase().includes(EVIL.slice(2)));
    // unknown / invalid input
    for (const [q, st] of [["protocol=other&id=79371151", 404], ["protocol=aerodrome-v1&id=1", 404], ["protocol=aerodrome-v1&id=abc", 400], [`protocol=aerodrome-v1&id=${"1".repeat(80)}`, 400], ["", 400], ["protocol=aerodrome-v1", 400]]) {
      const r = await get(`/api/claim-fees/target?${q}`);
      assert.strictEqual(r.status, st, `${q}: ${r.status} ${r.body.slice(0, 120)}`);
      assert.strictEqual(JSON.parse(r.body).ok, false);
    }
    // not a write route: anything but GET is refused
    for (const method of ["POST", "PUT", "DELETE"]) {
      const r = await request(port, "/api/claim-fees/target?protocol=aerodrome-v1&id=79371151", { method, headers: h });
      assert.ok(r.status >= 400 && !/"ok":\s*true/.test(r.body), `${method}: ${r.status} ${r.body.slice(0, 100)}`);
    }

    // every existing refusal still holds
    for (const p of ["/api/collect", "/api/arm", "/api/arm/setup", "/api/unlock", "/api/lock"]) {
      const r = await request(port, p, { method: "POST", headers: h });
      assert.strictEqual(r.status, 403, `${p}: ${r.status}`); assert.ok(/read-only/.test(r.body));
    }
    for (const p of ["/api/approval?v=3", "/api/v4-approval", "/api/sell/quote?token=0x0000000000000000000000000000000000000001&amount=1", "/api/mint/context"]) {
      const r = await get(p);
      assert.strictEqual(r.status, 403, `${p}: ${r.status}`); assert.ok(!/"operator":"0x/.test(r.body));
    }
    const chain = JSON.parse((await get("/api/chain")).body);
    assert.strictEqual(chain.noTx, true); assert.strictEqual(chain.readOnly, true);

    // the browser modules
    for (const f of ["/claim-fees.js", "/claim-fees-core.js"]) {
      const r = await get(f);
      assert.strictEqual(r.status, 200, f); assert.ok(/application\/javascript/.test(r.headers["content-type"]), f);
      assert.strictEqual(r.body, fs.readFileSync(path.join(ROOT, f.slice(1)), "utf8"), `${f} is served unchanged`);
    }
    const page = await get("/");
    assert.ok(/\/claim-fees\.js/.test(page.body), "dashboard.html loads claim-fees.js");

    // the mocked chain was all that was reached
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    assert.ok(!calls.some((c) => c.method === "eth_sendTransaction" || c.method === "eth_sendRawTransaction" || c.method === "eth_sign"), "no write RPC");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
  console.log("claim-fees-route tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
