// node test/base-vault-serve.test.js -- the static signing-page server: loopback bind, fixed routes, host guard, headers.
"use strict";
const assert = require("assert");
const http = require("http");
const { createServer } = require("../tools/base-vault-serve");

function req(port, { method = "GET", path = "/", host, address = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: address, port, method, path, headers: { Host: host || `127.0.0.1:${port}` } }, (res) => {
      const chunks = []; res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject); r.end();
  });
}
const listen = (server, host) => new Promise((res, rej) => { server.once("error", rej); server.listen(0, host, () => res(server.address())); });
const close = (server) => new Promise((res) => server.close(res));

(async () => {
  const saved = process.env.HOST;
  delete process.env.HOST;
  const servers = [];
  try {
    // default bind
    const s = createServer(); servers.push(s);
    const a = await listen(s, process.env.HOST || "127.0.0.1");
    assert.strictEqual(a.address, "127.0.0.1");
    const p = a.port;
    // routes
    for (const [path, type] of [["/", "text/html"], ["/flow.js", "javascript"], ["/page.js", "javascript"], ["/ethers.umd.min.js", "javascript"], ["/plan.json", "application/json"]]) {
      const r = await req(p, { path });
      assert.strictEqual(r.status, 200, path); assert.ok(r.headers["content-type"].includes(type), path);
      assert.ok(r.headers["content-security-policy"].includes("default-src 'none'") && r.headers["content-security-policy"].includes("script-src 'self'"));
      assert.strictEqual(r.headers["cache-control"], "no-store"); assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
    }
    const plan = JSON.parse((await req(p, { path: "/plan.json" })).body);
    assert.strictEqual(plan.constants.main, "0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8");
    assert.ok(plan.account.initCode.startsWith("0x") && plan.pins.account.runtimeKeccak);
    assert.ok(!/key|secret|mnemonic/i.test(JSON.stringify(Object.keys(plan))));
    assert.strictEqual((await req(p, { method: "HEAD" })).status, 200);
    // methods
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) assert.strictEqual((await req(p, { method })).status, 405, method);
    // paths
    for (const path of ["/nope", "/../package.json", "/%2e%2e/package.json", "/flow.js/../../package.json", "//etc/passwd", "/tools/base-vault/index.html", "/plan.json.bak"]) assert.strictEqual((await req(p, { path })).status, 404, path);
    // host guard
    assert.strictEqual((await req(p, { host: "evil.example" })).status, 403);
    assert.strictEqual((await req(p, { host: `evil.example:${p}` })).status, 403);
    assert.strictEqual((await req(p, { host: `localhost:${p}` })).status, 200);
    assert.strictEqual((await req(p, { host: "127.0.0.1" })).status, 403, "no port");
    // HOST override
    process.env.HOST = "127.0.0.2";
    const s2 = createServer(); servers.push(s2);
    const a2 = await listen(s2, process.env.HOST);
    assert.strictEqual(a2.address, "127.0.0.2");
    assert.strictEqual((await req(a2.port, { address: "127.0.0.2", host: `127.0.0.2:${a2.port}` })).status, 200);
    assert.strictEqual((await req(a2.port, { address: "127.0.0.2", host: "evil.example" })).status, 403);
  } finally {
    for (const s of servers) if (s.listening) await close(s);
    if (saved === undefined) delete process.env.HOST; else process.env.HOST = saved;
  }
  console.log("base-vault-serve: ok");
})().catch((e) => { console.error(e); process.exit(1); });
