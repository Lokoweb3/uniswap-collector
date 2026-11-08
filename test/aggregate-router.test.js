// node test/aggregate-router.test.js -- /portfolio and /api/aggregate through the real chain router,
// against stub chain instances on ephemeral loopback ports (no real chain, no real port).
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const F = require("./lib/aggregate-fixtures");
const { addr, lp, ext, reward, row } = F;

const ROOT = path.join(__dirname, "..");
const M = addr(1), O2 = addr(2), O3 = addr(3);

/** A stub instance. `payloads` maps path -> JSON (or a function); `mode` can refuse/hang. */
function stub(name, payloads, { hang = false } = {}) {
  const hits = [];
  const closed = [];
  const s = http.createServer((q, r) => {
    hits.push({ method: q.method, url: q.url, host: q.headers.host });
    q.socket.on("close", () => closed.push(q.url));
    if (hang && q.url.startsWith("/api/") && q.url !== "/api/who") return;
    if (q.url === "/api/who") { r.writeHead(200, { "Content-Type": "application/json" }); return r.end(JSON.stringify({ chain: name })); }
    const p = payloads[q.url.split("?")[0]];
    if (p === undefined) { r.writeHead(200, { "Content-Type": "text/html" }); return r.end(`<html><body>${name} page</body></html>`); }
    r.writeHead(200, { "Content-Type": "application/json" });
    r.end(JSON.stringify(typeof p === "function" ? p() : p));
  });
  return new Promise((res) => s.listen(0, "127.0.0.1", () => res({ server: s, port: s.address().port, hits, closed, name })));
}
// Every answer is stamped with the current time, as a live instance's would be.
const live = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, () => ({ ...v, at: Date.now() })]));
const instancePayloads = (owner, over = {}) => live({
  "/api/positions": F.withSecrets(F.positions(owner, { positions: [lp(11, { valueUsd: 100, feesUsd: 2 })], external: [ext("aerodrome-cl2", 5, { staked: true, valueUsd: 50, rewards: reward(1.5) })] })),
  "/api/watch": F.watch([]),
  "/api/portfolio": F.portfolio(owner, [row("ETH", 1, 10, { native: true })]),
  "/api/staking": F.staking(),
  ...over,
});

/** A fresh router bound to the given stubs. Env is read when the module loads. */
function fresh({ chains, ports, env = {} }) {
  const old = { argv: process.argv, env: { ...process.env } };
  Object.assign(process.env, { LP_AGG_TTL_MS: "60000", LP_AGG_WAIT_MS: "3000", LP_AGG_TIMEOUT_MS: "3000" }, env);
  process.argv = [old.argv[0], old.argv[1], `--chains=${chains.join(",")}`, "--port=0", ...Object.entries(ports).map(([k, v]) => `--${k}-port=${v}`)];
  for (const m of ["../chain-router"]) delete require.cache[require.resolve(m)];
  const mod = require("../chain-router");
  process.argv = old.argv;
  for (const k of Object.keys(process.env)) if (!(k in old.env)) delete process.env[k];
  Object.assign(process.env, old.env);
  return mod;
}
const listen = (mod) => new Promise((res) => mod.server.listen(0, "127.0.0.1", () => res(mod.server.address().port)));
const close = (s) => new Promise((res) => { s.closeAllConnections && s.closeAllConnections(); s.close(res); });
function call(port, p, { method = "GET", headers = {} } = {}) {
  return new Promise((res, rej) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (up) => {
      let body = ""; up.setEncoding("utf8"); up.on("data", (c) => (body += c)); up.on("end", () => res({ status: up.statusCode, headers: up.headers, body }));
    });
    r.on("error", rej); r.end();
  });
}
const strip = (j) => { const o = JSON.parse(j); delete o.at; for (const c of o.chains) delete c.ageMs; return JSON.stringify(o); };

(async () => {
  const rh = await stub("robinhood", instancePayloads(M));
  const arc = await stub("arc", instancePayloads(M, { "/api/positions": F.withSecrets(F.positions(M, { ownerLabel: "Treasury", positions: [lp(12, { valueUsd: 200, feesUsd: 0 })] })) }));
  const base = await stub("base", instancePayloads(O3));
  const ports = { robinhood: rh.port, arc: arc.port, base: base.port };
  const all = [rh, arc, base];
  const totalHits = () => all.reduce((n, s) => n + s.hits.length, 0);

  const mod = fresh({ chains: ["robinhood", "arc", "base"], ports });
  const rport = await listen(mod);
  const origins = {};

  // ---- 1. the page and its headers
  {
    const r = await call(rport, "/portfolio");
    assert.strictEqual(r.status, 200);
    assert.ok(/^text\/html; charset=utf-8$/.test(r.headers["content-type"]));
    assert.strictEqual(r.headers["content-security-policy"], "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    assert.ok(!/url\(|@import|@font-face|data:/.test(fs.readFileSync(path.join(ROOT, "aggregate.css"), "utf8") + fs.readFileSync(path.join(ROOT, "dashboard.css"), "utf8")), "the CSP allows no fonts or data: images because the css uses none");
    assert.strictEqual(r.headers["x-frame-options"], "DENY"); assert.strictEqual(r.headers["cache-control"], "no-cache");
    assert.strictEqual(r.headers["x-content-type-options"], "nosniff"); assert.strictEqual(r.headers["referrer-policy"], "no-referrer");
    assert.ok(r.body.includes('<nav class="pages"') && r.body.includes('href="/portfolio"'));
    const order = ["robinhood", "arc", "base"].map((k) => r.body.indexOf(`href="/?chain=${k}"`));
    assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], "every chain, in CHAINS order, linking to /?chain=<key>");
    assert.strictEqual((r.body.match(/class="chain-tab" /g) || []).length, 3);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(r.body), "no inline script in the shell");
    assert.strictEqual((await call(rport, "/portfolio/")).status, 200);
    origins.html = r.body;
  }

  // ---- 2. ?chain= and the cookie do not matter
  {
    const q = await call(rport, "/portfolio?chain=arc");
    assert.strictEqual(q.status, 200); assert.ok(!q.headers["set-cookie"]); assert.ok(!q.headers.location);
    const a1 = await call(rport, "/api/aggregate?chain=arc");
    assert.strictEqual(a1.status, 200); assert.ok(!a1.headers["set-cookie"]);
    const a2 = await call(rport, "/api/aggregate", { headers: { cookie: "lpchain=arc" } });
    const a3 = await call(rport, "/api/aggregate");
    assert.strictEqual(strip(a2.body), strip(a3.body), "the same body with and without the cookie");
    assert.strictEqual(strip(a1.body), strip(a3.body));
    const j = JSON.parse(a3.body);
    assert.strictEqual(j.ok, true); assert.deepStrictEqual(j.chains.map((c) => c.key), ["robinhood", "arc", "base"]);
    assert.ok(j.chains.every((c) => c.status === "ok" && !("port" in c)), "ok, and no port in the output: " + JSON.stringify(j.chains.map((c) => [c.status, c.problems])));
    // robinhood: lp 100 + fees 2 + 50 + reward 1.5 + 10 token; arc: M again (different label) lp 200 + token 10; base: O3
    assert.strictEqual(j.totals.rewardsUsd, 3, "two chains' rewards");
    assert.ok(Array.isArray(j.rates) && j.rates.every((r) => typeof r.chain === "string" && typeof r.wallet === "string"), "rates ride along");
    assert.ok(j.breakdown.feesByChain && j.breakdown.feesByWallet && typeof j.totals.feesUncountedCount === "number");
    assert.ok(j.totals.grandUsd > 0);
  }

  // ---- 25 (over HTTP). cache: one upstream round per chain per TTL
  {
    for (const s of all) for (const p of ["/api/positions", "/api/watch", "/api/portfolio", "/api/staking"]) {
      assert.strictEqual(s.hits.filter((h) => h.url === p).length, 1, `${s.name} ${p} requested once despite many polls`);
    }
    assert.ok(all.every((s) => s.hits.every((h) => !h.url.includes("?") && h.method === "GET")), "no query string, only GET upstream");
    await call(rport, "/api/aggregate?refresh=1");
    assert.strictEqual(rh.hits.filter((h) => h.url === "/api/watch").length, 2, "refresh=1 forces a round");
    await call(rport, "/api/aggregate?refresh=1");
    assert.strictEqual(rh.hits.filter((h) => h.url === "/api/watch").length, 2, "a second forced round within 5 s is refused");
    assert.ok(all.every((s) => s.hits.every((h) => !/fresh=1/.test(h.url))));
    assert.ok(all.every((s) => s.hits.every((h) => !/\/api\/daily/.test(h.url))), "the fee rate comes from the four existing paths, never /api/daily");
  }

  // ---- 3. read-only: other methods, HEAD
  {
    const n = totalHits();
    for (const p of ["/portfolio", "/api/aggregate", "/aggregate-view.js", "/aggregate.css"]) {
      for (const m of ["POST", "PUT", "DELETE"]) {
        const r = await call(rport, p, { method: m, headers: { origin: `http://127.0.0.1:${rport}` } });
        assert.strictEqual(r.status, 405, `${m} ${p}`); assert.strictEqual(r.headers.allow, "GET, HEAD");
      }
      const g = await call(rport, p), h = await call(rport, p, { method: "HEAD" });
      assert.strictEqual(h.status, 200); assert.strictEqual(h.body, "");
      for (const k of ["content-type", "cache-control", "x-content-type-options", "content-security-policy"]) assert.strictEqual(h.headers[k], g.headers[k], `HEAD ${p} ${k}`);
    }
    assert.strictEqual(totalHits(), n, "no upstream request for the refused methods or HEAD");
  }

  // ---- 4. Host guard on these four routes only
  {
    const n = totalHits();
    for (const p of ["/portfolio", "/api/aggregate", "/aggregate-view.js", "/aggregate.css"]) {
      const r = await call(rport, p, { headers: { host: "evil.example" } });
      assert.strictEqual(r.status, 421); assert.deepStrictEqual(JSON.parse(r.body), { ok: false });
      for (const host of [`127.0.0.1:${rport}`, `localhost:${rport}`, "127.0.0.1", "[::1]"]) assert.strictEqual((await call(rport, p, { headers: { host } })).status, 200, `${host} ${p}`);
      assert.strictEqual((await call(rport, p, { headers: { host: `127.0.0.1:${rport}`, "x-lp-gate": "1" } })).status, 200);
      assert.strictEqual((await call(rport, p, { headers: { host: "127.0.0.1:1" } })).status, 421, "a loopback name on someone else's port");
    }
    assert.strictEqual(totalHits(), n, "a refused host reaches no upstream (the rest were cached)");
    // the proxy path is unchanged: it still answers whatever the Host header says
    const proxied = await call(rport, "/api/who", { headers: { host: "evil.example" } });
    assert.strictEqual(proxied.status, 200); assert.strictEqual(JSON.parse(proxied.body).chain, "robinhood");
    // LP_ALLOWED_HOSTS
    const m2 = fresh({ chains: ["robinhood"], ports, env: { LP_ALLOWED_HOSTS: "my.tail.ts.net" } });
    const p2 = await listen(m2);
    assert.strictEqual((await call(p2, "/portfolio", { headers: { host: "my.tail.ts.net" } })).status, 200);
    assert.strictEqual((await call(p2, "/portfolio", { headers: { host: "other.ts.net" } })).status, 421);
    await close(m2.server);
  }

  // ---- 5. the public gate lets them through, and only as GET/HEAD
  {
    const gate = fs.readFileSync(path.join(ROOT, "lp-gate.mjs"), "utf8");
    const hit = /allow: (\(m, p\) => \(\(m === "GET"[\s\S]*?)\s*\}, \/\/ in-site chat/.exec(gate);
    assert.ok(hit, "the dashboard allow() was found in lp-gate.mjs");
    const allow = new Function(`return ${hit[1]}`)();
    for (const p of ["/portfolio", "/api/aggregate", "/aggregate-view.js", "/aggregate.css"]) {
      assert.strictEqual(allow("GET", p), true, p); assert.strictEqual(allow("HEAD", p), true); assert.strictEqual(allow("POST", p), false);
    }
    assert.strictEqual(allow("POST", "/api/aggregate"), false);
    assert.strictEqual(allow("GET", "/api/collect"), false, "the lifted rule is the real one");
  }

  // ---- 6/7. the picker link and isolation
  {
    const page = await call(rport, "/", { headers: { cookie: "lpchain=arc" } });
    const picker = page.body.slice(page.body.indexOf('id="lp-chain-picker"'));
    assert.ok(/href="\/portfolio"[^>]*>[\s\S]*?Portfolio<\/a>/.test(picker), "the Portfolio anchor is inside the picker");
    const a = /<a href="\/portfolio"[^>]*>/.exec(picker)[0];
    assert.ok(!a.includes("data-chain"), "the click handler's a[data-chain] selector does not match it");
    const who = await call(rport, "/api/portfolio", { headers: { cookie: "lpchain=arc" } });
    const doc = JSON.parse(who.body);
    assert.strictEqual(doc.rows[0].symbol, "ETH"); assert.ok(!("chains" in doc) && !("items" in doc), "a proxied /api/portfolio is the instance's, not the aggregator's");
    assert.ok(arc.hits.some((h) => h.url === "/api/portfolio" && h.host === `127.0.0.1:${arc.port}`));
    let diff = "";
    // server.js, portfolio.js and wallet.html left this list when the Elysium testnet was added (SPEC-elysium-testnet.md
    // changes all three on purpose: the testnet flag, the raw-wei native row, the wallet add/switch flow).
    const untouched = ["watch", "slipstream", "v2lp", "staking", "dashboard", "dashboard", "dashboard", "lp-gate"]
      .map((n, i) => `${n}${[".js", ".js", ".js", ".js", ".html", ".js", ".css", ".mjs"][i]}`);
    try {
      diff = execFileSync("git", ["diff", "e2b5ac0", "--stat", "--", ...untouched], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch { diff = ""; /* no git here: nothing to compare */ }
    assert.strictEqual(diff.trim(), "", "the instance files are untouched");
  }

  // ---- 28. only fixed targets, nothing echoed
  {
    const n = totalHits();
    for (const q of ["?chains=http://evil", "?chains=../x", "?wallet=<script>", "?chains=%3Cimg%20src=x%3E&wallet=%22%3E%3Cscript%3E"]) {
      for (const p of ["/api/aggregate", "/portfolio"]) {
        const r = await call(rport, p + q);
        assert.strictEqual(r.status, 200, q);
        assert.ok(!/evil|<script>|\.\.\/x|<img/.test(r.body), `${q} is not echoed`);
      }
    }
    assert.strictEqual(totalHits(), n, "no new upstream request");
    assert.ok(all.every((s) => s.hits.every((h) => ["/api/positions", "/api/watch", "/api/portfolio", "/api/staking", "/", "/api/who", "/api/aggregate"].includes(h.url) || h.url === "/")));
  }

  // ---- 29/31. nothing internal in the output; the page is read-only
  {
    const j = (await call(rport, "/api/aggregate")).body;
    const html = origins.html, js = (await call(rport, "/aggregate-view.js")).body;
    for (const [what, body] of [["api", j], ["html", html], ["js", js]]) {
      for (const secret of [F.SECRET.operator, F.SECRET.rpcKey, F.SECRET.keystore, "rpc", "keystore", "unlock", "operatorGas", "series", "explorer.example", "rpc.example", "could not reach"]) {
        assert.ok(!body.includes(secret), `${what} must not contain ${secret}`);
      }
    }
    for (const k of ["claimed", "pnlUsd", "spark", "loops", "alerts"]) assert.ok(!j.includes(`"${k}"`), `no ${k}`);
    assert.ok(!/\b(Collect|Claim|Arm|Approve|Sell|Mint)\b/.test(html + js), "no action words in the shell or the script");
    assert.ok(!/<form|method:\s*["']POST/i.test(html + js));
    const fetched = [...js.matchAll(/fetch\(([^)]*)\)/g)].map((m) => m[1]);
    assert.ok(fetched.length >= 1 && fetched.every((a) => /\/api\/aggregate/.test(a) && !/["'`]\/(?!api\/aggregate)/.test(a.replace(/\{[^}]*\}/, ""))), `only /api/aggregate is fetched: ${fetched}`);
  }

  // ---- 32. themes
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agg-theme-"));
    try {
      const theme = "/* temp theme */\n:root{--bg:#010203}\n";
      fs.writeFileSync(path.join(dir, "dashboard.css"), theme);
      const css = mod.aggregateCss(dir);
      assert.ok(css.subarray(0, Buffer.byteLength(theme)).equals(Buffer.from(theme)), "begins with the exact bytes of dashboard.css");
      assert.ok(css.length > theme.length && css.toString().includes("body.agg"), "followed by the aggregate rules");
      // via the route, with the theme directory pointed at the temp dir
      const m3 = fresh({ chains: ["robinhood"], ports, env: { LP_AGG_THEME_DIR: dir } });
      const p3 = await listen(m3);
      const r3 = await call(p3, "/aggregate.css");
      assert.strictEqual(r3.status, 200); assert.ok(r3.body.startsWith(theme)); assert.ok(/^text\/css/.test(r3.headers["content-type"]));
      fs.unlinkSync(path.join(dir, "dashboard.css"));
      const r4 = await call(p3, "/aggregate.css");
      assert.strictEqual(r4.status, 200); assert.ok(r4.body.startsWith("/* Aggregate"), "dashboard.css missing: the aggregate rules alone");
      await close(m3.server);
      const rules = fs.readFileSync(path.join(ROOT, "aggregate.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      const naked = rules.replace(/var\([^)]*\)/g, "");
      assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(naked) && !/rgba?\(/.test(naked), "every aggregate-specific colour is var(--x, fallback)");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // ---- 32b. static files are cached until their mtime changes
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agg-cache-"));
    try {
      const f = path.join(dir, "dashboard.css");
      fs.writeFileSync(f, "/* one */\n");
      assert.ok(mod.aggregateCss(dir).toString().startsWith("/* one */"));
      const orig = fs.readFileSync;
      let reads = 0;
      fs.readFileSync = function (...a) { if (String(a[0]) === f) reads++; return orig.apply(this, a); };
      try {
        mod.aggregateCss(dir); mod.aggregateCss(dir);
        assert.strictEqual(reads, 0, "unchanged mtime: no re-read");
        fs.writeFileSync(f, "/* two!! */\n");
        const t = new Date(Date.now() + 5000); fs.utimesSync(f, t, t);
        assert.ok(mod.aggregateCss(dir).toString().startsWith("/* two!! */"));
        assert.strictEqual(reads, 1, "changed mtime: one re-read");
      } finally { fs.readFileSync = orig; }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  // ---- 32c. a malformed Host is a 400, not a crash
  {
    const net = require("net");
    const raw = (head) => new Promise((res) => {
      const c = net.connect(rport, "127.0.0.1", () => c.write(head));
      let out = ""; c.setEncoding("utf8"); c.on("data", (d) => (out += d)); c.on("close", () => res(out)); c.on("error", () => res(out));
      setTimeout(() => c.destroy(), 1500);
    });
    const out = await raw("GET /portfolio HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n");
    assert.ok(/^HTTP\/1\.1 400 /.test(out), out.slice(0, 80));
    assert.ok(out.endsWith("bad request\n"), "fixed body");
    const out2 = await raw("GET /anything HTTP/1.1\r\nHost: [x\r\nConnection: close\r\n\r\n");
    assert.ok(/^HTTP\/1\.1 400 /.test(out2));
    assert.strictEqual((await call(rport, "/portfolio")).status, 200, "still serving");
  }

  // ---- 34. a disabled chain is not asked about; a listed one that is down still shows
  {
    const pulse = await stub("pulsechain", instancePayloads(O2));
    const m4 = fresh({ chains: ["robinhood", "arc"], ports: { ...ports, pulsechain: pulse.port } });
    const p4 = await listen(m4);
    const body = (await call(p4, "/api/aggregate")).body;
    assert.strictEqual(pulse.hits.length, 0, "no request to a chain that is not enabled");
    assert.ok(!body.includes("pulsechain") && !body.includes("PulseChain"));
    await close(m4.server);
    const dead = await stub("dead", {}); const deadPort = dead.port; await close(dead.server);
    const m5 = fresh({ chains: ["robinhood", "pulsechain"], ports: { ...ports, pulsechain: deadPort } });
    const p5 = await listen(m5);
    const j = JSON.parse((await call(p5, "/api/aggregate")).body);
    const pc = j.chains.find((c) => c.key === "pulsechain");
    assert.strictEqual(pc.status, "down"); assert.ok(pc.problems.every((p) => p.code === "unreachable"));
    assert.strictEqual(j.breakdown.byChain.pulsechain, null); assert.strictEqual(j.incomplete, true);
    await close(m5.server); await close(pulse.server);
  }

  // ---- 20. a chain that never answers
  {
    const slowArc = await stub("arc", instancePayloads(M), { hang: true });
    const m6 = fresh({ chains: ["robinhood", "arc", "base"], ports: { ...ports, arc: slowArc.port }, env: { LP_AGG_TIMEOUT_MS: "300", LP_AGG_WAIT_MS: "200" } });
    const p6 = await listen(m6);
    const t0 = Date.now();
    const r = await call(p6, "/api/aggregate");
    assert.ok(Date.now() - t0 < 1500, `answered in ${Date.now() - t0} ms`);
    const j = JSON.parse(r.body);
    assert.deepStrictEqual(j.chains.map((c) => c.status), ["ok", "loading", "ok"]);
    assert.ok(j.chains[1].problems.some((p) => ["timeout", "loading"].includes(p.code)));
    assert.ok(j.items.some((i) => i.chain === "robinhood") && j.items.some((i) => i.chain === "base") && !j.items.some((i) => i.chain === "arc"));
    assert.strictEqual(j.breakdown.byChain.arc, null); assert.strictEqual(j.incomplete, true);
    await new Promise((res) => setTimeout(res, 600));
    assert.ok(slowArc.closed.length >= 4, `the router closed its connections to the silent chain (${slowArc.closed.length})`);
    const later = JSON.parse((await call(p6, "/api/aggregate")).body);
    assert.strictEqual(later.chains[1].status, "down", "once the round finished with timeouts and no last good");
    assert.ok(later.chains[1].problems.every((p) => p.code === "timeout"));
    await close(m6.server); await close(slowArc.server);
  }

  await close(mod.server);
  for (const s of all) await close(s.server);
  console.log("aggregate-router.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
