// node test/endpoint-safety.test.js -- H4: configured URLs are validated, a provider key in a
// URL never reaches a page, a log line or an error text, and the Blockscout PRO key is sent
// only to allow-listed hosts. No network: the spawned server runs with test/fixtures/stub-network.js.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-endpoint-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

// The Blockscout key and the data directory must be set before blockscout.js is first required.
const KEYDIR = path.join(TMP, "bs");
fs.mkdirSync(KEYDIR);
const example = JSON.parse(fs.readFileSync(path.join(ROOT, "settings.base.example.json"), "utf8"));
fs.writeFileSync(path.join(KEYDIR, "settings.json"), JSON.stringify(example));
process.env.LP_DATA_DIR = KEYDIR;
process.env.BLOCKSCOUT_API_KEY = "proapi_SECRET";
delete process.env.LP_BASE_RPC_URL;

const { validateEndpoint, redactUrl, redactText, registerEndpoint, scrubError, publicRpc } = require("../endpoint");
const settings = require("../settings");
const bs = require("../blockscout");

(async () => {
  // ---- 9. validateEndpoint ---------------------------------------------------
  {
    for (const bad of [
      "http://mainnet.base.org", "https://user:pw@h.example", "https://localhost", "https://LOCALHOST:8545", "https://a.localhost",
      "https://127.0.0.1", "https://127.1", "https://2130706433", "https://10.0.0.1", "https://172.16.0.1", "https://192.168.1.1",
      "https://169.254.169.254", "https://100.100.100.200", "https://0.0.0.0", "https://[::1]", "https://[::]", "https://[fd00::1]", "https://[fe80::1]",
      "https://[::ffff:127.0.0.1]", "https://[::ffff:a00:1]", "file:///etc/passwd", "ftp://x.example", "wss://x.example", "javascript:alert(1)", "", "not a url", null, undefined, 42,
      "https://metadata.google.internal", "https://host.internal",
      // trailing dots, IPv4-compatible / NAT64 / 6to4 / site-local IPv6
      "https://localhost./", "https://LOCALHOST..", "https://127.0.0.1./", "https://a.localhost.", "https://[::127.0.0.1]", "https://[::7f00:1]", "https://[::10.0.0.1]",
      "https://[64:ff9b::7f00:1]", "https://[64:ff9b::10.0.0.1]", "https://[2002:7f00:1::1]", "https://[2002:a00:1::]", "https://[2002:c0a8:101::1]", "https://[fec0::1]", "https://[feff::1]",
    ]) assert.throws(() => validateEndpoint(bad, "chain.rpcUrl"), /rejected/, `must reject ${bad}`);
    for (const good of ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://api.blockscout.com/8453", "https://basescan.org", "https://8.8.8.8", "https://[2606:4700::1111]", "https://mainnet.base.org.", "https://[2002:808:808::1]"]) {
      assert.ok(validateEndpoint(good), `must accept ${good}`);
    }
    // The error names the setting and the reason, never the URL's path, query or credentials.
    for (const url of ["https://user:pw@h.example/PATHSECRET?k=QUERYSECRET", "http://h.example/PATHSECRET?k=QUERYSECRET", "https://127.0.0.1/PATHSECRET?k=QUERYSECRET"]) {
      try { validateEndpoint(url, "chain.rpcUrl"); assert.fail("accepted"); } catch (e) {
        assert.ok(/chain\.rpcUrl rejected/.test(e.message), e.message);
        assert.ok(!/PATHSECRET|QUERYSECRET|pw@|h\.example|127\.0\.0\.1/.test(e.message), `no part of the URL in: ${e.message}`);
      }
    }
    // A server with such a setting refuses to start, and says so without the path.
    const dir = fs.mkdtempSync(path.join(TMP, "badcfg-"));
    const bad = JSON.parse(JSON.stringify(example));
    bad.chain.rpcUrl = "http://rpc.example/v2/PATHSECRET?key=QUERYSECRET";
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(bad));
    const r = spawnSync(process.execPath, ["-e", 'require("./settings").load()'], { cwd: ROOT, env: { ...process.env, LP_DATA_DIR: dir }, encoding: "utf8" });
    assert.notStrictEqual(r.status, 0, "fails closed");
    assert.ok(/chain\.rpcUrl rejected: only https/.test(r.stderr), r.stderr);
    assert.ok(!/PATHSECRET|QUERYSECRET/.test(r.stdout + r.stderr), "the startup error does not echo the path or query");
    // Each configured URL is checked, and the env override too.
    for (const [field, value] of [["rpcUrl", "https://10.1.2.3"], ["explorer", "http://basescan.org"], ["blockscout", "https://localhost"], ["logsRpcUrl", "https://[::1]"]]) {
      const c = JSON.parse(JSON.stringify(example)); c.chain[field] = value;
      assert.throws(() => settings.toLegacy(c), new RegExp(`chain\\.${field} rejected`), field);
    }
    const c2 = JSON.parse(JSON.stringify(example)); c2.chain.rpcUrls = ["https://ok.example", "https://169.254.169.254/latest"];
    assert.throws(() => settings.toLegacy(c2), /chain\.rpcUrls\[1\] rejected/);
    process.env.LP_BASE_RPC_URL = "http://127.0.0.1:8545/SECRETKEY";
    assert.throws(() => settings.toLegacy(example), (e) => /LP_BASE_RPC_URL rejected/.test(e.message) && !/SECRETKEY/.test(e.message));
    process.env.LP_BASE_RPC_URL = "https://x.example/v2/SECRETKEY";
    const withEnv = settings.toLegacy(example);
    assert.strictEqual(withEnv.rpcUrl, "https://x.example/v2/SECRETKEY", "the env endpoint is the live one");
    assert.deepStrictEqual(withEnv.rpcUrls, ["https://x.example/v2/SECRETKEY", "https://mainnet.base.org"], "with the public one kept as the fallback");
    assert.strictEqual(publicRpc(withEnv), "https://mainnet.base.org", "but a page is only ever told the public origin");
    delete process.env.LP_BASE_RPC_URL;
    assert.strictEqual(publicRpc(settings.toLegacy(example)), "https://mainnet.base.org");
    // Other chains are not re-validated: their behaviour is what it was.
    const arc = settings.toLegacy({ chain: { rpcUrl: "http://127.0.0.1:1", chainId: 5042, explorer: "" }, wallets: { main: { address: "0x1" } }, tokens: {}, contracts: {} });
    assert.strictEqual(arc.rpcUrl, "http://127.0.0.1:1");
    assert.throws(() => settings.toLegacy({ chain: { rpcUrl: "http://127.0.0.1:1", chainId: 5042, strictEndpoints: true }, wallets: { main: {} }, tokens: {}, contracts: {} }), /rejected/, "chain.strictEndpoints opts any chain in");
    // No route lets a request choose an endpoint.
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.ok(!/\.get\(\s*["'](rpc|rpcUrl|url|explorer|blockscout|endpoint|provider)["']\s*\)/.test(src), "server.js reads no rpc/url/explorer query parameter");
    assert.ok(!/headers\[["'](x-rpc|x-explorer|x-blockscout)/i.test(src));
    assert.ok(!/cfg\.rpcUrl/.test(src.replace(/\/\/.*$/gm, "")), "server.js never hands cfg.rpcUrl to a page");
  }

  // ---- redaction helpers -----------------------------------------------------
  {
    assert.strictEqual(redactUrl("https://x.example/v2/SECRETKEY?a=1"), "https://x.example");
    assert.strictEqual(redactUrl("garbage"), "[url]");
    registerEndpoint("https://x.example/v2/SECRETKEY");
    registerEndpoint("https://mainnet.base.org");            // an origin only: nothing to hide, nothing registered
    const err = Object.assign(new Error('server response 500 (request={ }, info={ "requestUrl": "https://x.example/v2/SECRETKEY" }, code=SERVER_ERROR)'), { info: { requestUrl: "https://x.example/v2/SECRETKEY" }, shortMessage: "failed at /v2/SECRETKEY" });
    scrubError(err);
    assert.ok(!/SECRETKEY/.test(err.message + err.shortMessage + JSON.stringify(err.info) + err.stack), "ethers-style error scrubbed");
    assert.ok(!/proapi_SECRET/.test(redactText("Bearer proapi_SECRET and proapi_abc-DEF_9")));
    assert.strictEqual(redactText("plain https://mainnet.base.org text"), "plain https://mainnet.base.org text");
  }

  // ---- redaction: env URL fully, settings-file URL only key-like parts ---------
  {
    const { _protected, redactChunk, installConsoleRedaction } = require("../endpoint");
    registerEndpoint("https://rpc.ankr.com/ethereum");                       // a public settings-file URL
    assert.strictEqual(redactText("the ethereum chain"), "the ethereum chain", "a short public path segment is not redacted");
    registerEndpoint("https://rpc.example/v3/0123456789abcdef0123456789abcdef");   // a keyed settings-file URL
    assert.ok(!/0123456789abcdef/.test(redactText("GET /v3/0123456789abcdef0123456789abcdef failed")), "a key-like segment is");
    registerEndpoint("https://env.example/rpc/Abcdefg1Z2y3/hij?apikey=QKEY123xyz90&x=ab&tag=short", { env: true });
    for (const leak of ["Abcdefg1Z2y3", "QKEY123xyz90", "/rpc/Abcdefg1Z2y3/hij?apikey=QKEY123xyz90&x=ab&tag=short"]) assert.ok(!redactText(`oops ${leak} oops`).includes(leak), `env URL part ${leak} is redacted`);
    assert.strictEqual(redactText("hij and ab and short stay"), "hij and ab and short stay", "short words are left alone, even in an env URL");
    assert.ok(!redactText("see https://env.example/rpc/Abcdefg1Z2y3/hij?apikey=QKEY123xyz90&x=ab&tag=short now").includes("QKEY123xyz90"));

    registerEndpoint("https://x.example/ethereum/0123456789abcdef0123456789abcdef", { env: true });
    assert.strictEqual(redactText("the ethereum chain"), "the ethereum chain", "an env URL's plain word segment is not redacted");
    assert.ok(!redactText("k 0123456789abcdef0123456789abcdef k").includes("0123456789abcdef"), "its key is");

    // scrubError: responseBody and body
    const e2 = Object.assign(new Error("boom"), { info: { requestUrl: "https://env.example/rpc/Abcdefg1Z2y3/hij", responseBody: '{"error":"bad key QKEY123xyz90 at /rpc/Abcdefg1Z2y3"}', nested: { x: "Abcdefg1Z2y3" } }, body: "echo QKEY123xyz90" });
    scrubError(e2);
    assert.ok(!/QKEY123xyz90|Abcdefg1Z2y3/.test(JSON.stringify(e2.info) + e2.body), `info/body scrubbed: ${JSON.stringify(e2.info)}`);

    // console: strings, errors and plain objects
    const lines = [];
    const saved = {}; for (const m of ["log", "info", "warn", "error", "debug"]) { saved[m] = console[m]; }
    const origWrite = process.stdout.write.bind(process.stdout), origErrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = (c) => { lines.push(String(c)); return true; }; process.stderr.write = (c) => { lines.push(String(c)); return true; };
    try {
      installConsoleRedaction();
      console.log("a QKEY123xyz90 b"); console.error(new Error("e QKEY123xyz90")); console.warn({ url: "https://env.example/rpc/Abcdefg1Z2y3/hij", nested: { k: "QKEY123xyz90" } }); console.info([{ deep: "Abcdefg1Z2y3" }]);
      console.log({ fine: 1 });
    } finally { process.stdout.write = origWrite; process.stderr.write = origErrWrite; }
    const text = lines.join("");
    assert.ok(!/QKEY123xyz90|Abcdefg1Z2y3/.test(text), `console output redacted: ${text.slice(0, 300)}`);
    assert.ok(/fine: 1/.test(text), "an object without a secret prints as before");

    // response chunks: string, Buffer, Uint8Array
    assert.ok(!redactChunk("x QKEY123xyz90 y").includes("QKEY123xyz90"));
    const buf = redactChunk(Buffer.from('{"rpc":"Abcdefg1Z2y3","k":"QKEY123xyz90"}'));
    assert.ok(Buffer.isBuffer(buf) && !/QKEY123xyz90|Abcdefg1Z2y3/.test(buf.toString()), "a Buffer body is redacted");
    const u8 = redactChunk(new TextEncoder().encode("QKEY123xyz90"));
    assert.ok(!Buffer.from(u8).toString().includes("QKEY123xyz90"), "a Uint8Array body is redacted");
    const clean = Buffer.from([1, 2, 3]);
    assert.strictEqual(redactChunk(clean), clean, "an untouched chunk is passed through as is");
    assert.strictEqual(redactChunk(undefined), undefined);
    assert.ok(_protected.size > 0);
  }

  // ---- 8b. the Blockscout PRO key goes only to allow-listed hosts -------------
  {
    assert.strictEqual(bs.hasKey(), true);
    assert.ok(bs.EXPLORER === "https://base.blockscout.com", bs.EXPLORER);
    const sent = [];
    global.fetch = async (url, init) => { sent.push({ url: String(url), auth: init.headers.Authorization || null }); return { ok: true }; };
    await bs.bsFetch("https://api.blockscout.com/8453/api/v2/x");
    await bs.bsFetch("https://base.blockscout.com/api/v2/y");
    await bs.bsFetch("/v2/addresses/0x1/tokens");
    assert.strictEqual(sent.length, 3);
    assert.ok(sent.every((s) => s.auth === "Bearer proapi_SECRET"), "the key goes to the allow-listed hosts");
    assert.strictEqual(sent[2].url, "https://api.blockscout.com/8453/api/v2/addresses/0x1/tokens", "a path goes to the PRO gateway for this chain");
    sent.length = 0;
    for (const evil of [
      "https://evil.example/x", "http://api.blockscout.com/8453/x", "https://api.blockscout.com.evil.example/x", "https://api.blockscout.com@evil.example/x",
      "https://evil.example/api.blockscout.com", "ftp://api.blockscout.com/x", "https://user:pw@api.blockscout.com/x", "file:///etc/passwd",
    ]) {
      assert.throws(() => bs.bsFetch(evil), (e) => /not an allowed Blockscout host|not a valid URL/.test(e.message) && !/proapi_SECRET/.test(e.message), `must refuse ${evil}`);
    }
    assert.strictEqual(sent.length, 0, "nothing was sent to a non-allow-listed host, with or without the key");
    // A relative path can only ever extend the gateway's own URL: "//evil.example" is a path here, not a host.
    await bs.bsFetch("//evil.example/x");
    assert.ok(new URL(sent[0].url).host === "api.blockscout.com", sent[0].url);
    sent.length = 0;
    assert.deepStrictEqual([...bs.allowedHosts()].sort(), ["api.blockscout.com", "base.blockscout.com"]);
  }

  // ---- 8. a keyed RPC never reaches a page, a log or an error text -------------
  {
    const port = await new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
    const dir = fs.mkdtempSync(path.join(TMP, "inst-"));
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(example));
    const stubLog = path.join(dir, "stub.log");
    const out = [];
    const child = spawn(process.execPath, ["--require", path.join(__dirname, "fixtures", "stub-network.js"), "server.js", `--data-dir=${dir}`, `--port=${port}`, "--no-loops", "--no-services"], {
      cwd: ROOT,
      env: { ...process.env, LP_DATA_DIR: "", LP_READONLY: "1", HOME: dir, STUB_LOG: stubLog, LP_BASE_RPC_URL: "https://x.example/v2/SECRETKEY", BLOCKSCOUT_API_KEY: "proapi_SECRET", LP_BIND: "127.0.0.1" },
    });
    child.stdout.on("data", (d) => out.push(String(d))); child.stderr.on("data", (d) => out.push(String(d)));
    const get = (p) => new Promise((resolve) => {
      const r = http.get({ host: "127.0.0.1", port, path: p, timeout: 25000 }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: b })); });
      r.on("timeout", () => { r.destroy(); resolve({ status: 0, body: "" }); }); r.on("error", () => resolve({ status: 0, body: "" }));
    });
    try {
      const t0 = Date.now();
      while (!out.join("").includes("Dashboard running")) {
        if (child.exitCode != null) throw new Error(`server exited early: ${out.join("").slice(-400)}`);
        if (Date.now() - t0 > 30000) throw new Error("server did not start");
        await new Promise((r) => setTimeout(r, 100));
      }
      const bodies = {};
      for (const p of ["/api/chain", "/api/watch", "/api/positions", "/api/approvals", "/api/approval", "/api/portfolio", "/api/claims", "/api/ops", "/api/health"]) bodies[p] = (await get(p)).body;
      const chain = JSON.parse(bodies["/api/chain"]);
      assert.strictEqual(chain.rpc, "https://mainnet.base.org", "a page is told the public origin, not the keyed endpoint");
      assert.strictEqual(chain.chainId, 8453);
      await new Promise((r) => setTimeout(r, 1500));       // let startup reads fail and log
      const everything = Object.values(bodies).join("\n") + "\n" + out.join("");
      assert.ok(!/SECRETKEY/.test(everything), `SECRETKEY leaked: ${everything.match(/.{60}SECRETKEY.{20}/)}`);
      assert.ok(!/proapi_SECRET/.test(everything), "the Blockscout key leaked");
      assert.ok(Object.values(bodies).some((b) => b.length > 0), "the routes answered");
      // What the stub saw: the RPC calls went to the configured host, the key only ever to an allow-listed one.
      const seen = fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      assert.ok(seen.some((s) => s.kind === "rpc" && s.host === "x.example"), "the env endpoint is the live one");
      for (const s of seen.filter((x) => x.kind === "fetch" && x.auth)) assert.ok(["api.blockscout.com", "base.blockscout.com"].includes(s.host), `bearer sent to ${s.host}`);
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
  }

  console.log("endpoint safety: validation, redaction, bearer allow-list and a keyed RPC that never reaches a page or a log passed");
})().catch((e) => { console.error(e); process.exit(1); });
