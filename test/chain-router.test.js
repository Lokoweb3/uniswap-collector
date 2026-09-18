// node test/chain-router.test.js — one URL, two chains, nothing shared between them.
//
// The router sits in front of two single-chain dashboards. What matters is not that
// it proxies, but that it cannot mix the chains up: a request must reach the chain
// the browser chose, a session or CSRF cookie minted on one chain must never be
// presented to the other, and the page must always say which chain it is showing.
// Reading Arc's numbers believing they are Robinhood's is the failure this prevents.
"use strict";
const assert = require("assert");
const http = require("http");
const { chainFor, renameSetCookie, restoreCookieHeader, injectPicker, CHAINS, COOKIE, nsName } = require("../chain-router");

const req = (cookie) => ({ headers: cookie ? { cookie } : {} });
const url = (q = "") => new URL(`http://x/page${q}`);

// ---- 1. which chain a request goes to ----------------------------------------
{
  assert.strictEqual(chainFor(req(), url()).chain.key, "robinhood", "the default chain when nothing is chosen");
  assert.strictEqual(chainFor(req(`${COOKIE}=arc`), url()).chain.key, "arc", "the cookie decides");
  const q = chainFor(req(`${COOKIE}=arc`), url("?chain=robinhood"));
  assert.strictEqual(q.chain.key, "robinhood", "an explicit ?chain= overrides the cookie");
  assert.strictEqual(q.fromQuery, true, "and is remembered, so the query can be dropped");
  // Anything not in the list falls back; a request cannot name an arbitrary target.
  assert.strictEqual(chainFor(req(), url("?chain=http://evil")).chain.key, "robinhood");
  assert.strictEqual(chainFor(req(`${COOKIE}=../../etc`), url()).chain.key, "robinhood");
  assert.strictEqual(chainFor(req(`${COOKIE}=ARC`), url()).chain.key, "robinhood", "keys are exact, not fuzzy");
}

// ---- 2. cookies never cross between chains -----------------------------------
{
  // Both instances issue a cookie of the same name; namespacing keeps them apart.
  const rh = renameSetCookie("csrf=abc123; Path=/; HttpOnly", "robinhood");
  const arc = renameSetCookie("csrf=zzz999; Path=/; HttpOnly", "arc");
  assert.ok(rh.startsWith(`${nsName("robinhood", "csrf")}=abc123`), rh);
  assert.ok(arc.startsWith(`${nsName("arc", "csrf")}=zzz999`), arc);
  assert.ok(rh.includes("HttpOnly") && rh.includes("Path=/"), "attributes survive");

  // On the way back, each chain sees only its own, under the original name.
  const jar = `${nsName("robinhood", "csrf")}=abc123; ${nsName("arc", "csrf")}=zzz999; ${COOKIE}=arc`;
  const toArc = restoreCookieHeader(jar, "arc");
  assert.strictEqual(toArc, "csrf=zzz999", `arc sees only its own: ${toArc}`);
  const toRh = restoreCookieHeader(jar, "robinhood");
  assert.strictEqual(toRh, "csrf=abc123", `robinhood sees only its own: ${toRh}`);
  assert.ok(!toArc.includes("abc123") && !toRh.includes("zzz999"), "no token crosses chains");
  assert.ok(!toArc.includes(COOKIE), "the router's own cookie is not forwarded upstream");
}

// ---- 3. the page always says which chain ------------------------------------
{
  const html = injectPicker("<html><body><h1>Dashboard</h1></body></html>", CHAINS[1]);
  assert.ok(html.includes("lp-chain-picker"), "a picker is injected");
  // Every chain is on screen at once rather than hidden inside a dropdown, and the
  // one being shown is marked as current -- reading Arc's figures as Robinhood's is
  // the mistake this exists to prevent, so which chain is in view cannot be subtle.
  for (const c of CHAINS) assert.ok(html.includes(`data-chain="${c.key}"`), `${c.label} is visible without opening anything`);
  assert.ok(/data-chain="arc" aria-current="page"/.test(html), "the current chain is marked as current");
  assert.strictEqual((html.match(/aria-current="page"/g) || []).length, 1, "and only one chain is");
  // Plain links, so the picker survives JavaScript being off or still loading.
  assert.ok(/<a href="\?chain=robinhood"/.test(html), "the other chain is a real link, not a script-only control");
  assert.ok(html.indexOf("lp-chain-picker") < html.indexOf("</body>"), "inside the body");
  // Injecting twice would stack pickers on every proxied response.
  assert.strictEqual(injectPicker(html, CHAINS[1]), html, "injection is idempotent");
  // A body with no </body> still gets one rather than silently losing it.
  assert.ok(injectPicker("<h1>bare</h1>", CHAINS[0]).includes("lp-chain-picker"));
}

// ---- 4. end to end: two fake chains, one router ------------------------------
(async () => {
  const mk = (name) => new Promise((res) => {
    const s = http.createServer((q, r) => {
      if (q.url === "/api/who") { r.writeHead(200, { "Content-Type": "application/json" }); return r.end(JSON.stringify({ chain: name, cookie: q.headers.cookie || null, origin: q.headers.origin || null, host: q.headers.host || null })); }
      r.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": `csrf=${name}-token; Path=/` });
      r.end(`<html><body>${name} page</body></html>`);
    });
    s.listen(0, "127.0.0.1", () => res(s));
  });
  const a = await mk("robinhood"), b = await mk("arc");
  process.env.X = "";
  // Re-require with the fake ports bound to the real chain keys.
  const fresh = (...argv) => {
    const old = process.argv;
    process.argv = [old[0], old[1], ...argv];
    delete require.cache[require.resolve("../chain-router")];
    const mod = require("../chain-router");
    process.argv = old;
    return mod;
  };
  const mod = fresh(`--robinhood-port=${a.address().port}`, `--arc-port=${b.address().port}`, "--port=0");
  const router = mod.server;
  await new Promise((res) => router.listen(0, "127.0.0.1", res));
  const port = router.address().port;

  const get = (path, cookie) => new Promise((res) => {
    http.get({ host: "127.0.0.1", port, path, headers: cookie ? { cookie } : {} }, (r) => {
      let body = ""; r.setEncoding("utf8"); r.on("data", (c) => (body += c));
      r.on("end", () => res({ status: r.statusCode, headers: r.headers, body }));
    });
  });

  const dflt = await get("/api/who");
  assert.strictEqual(JSON.parse(dflt.body).chain, "robinhood", "default routes to Robinhood");
  const onArc = await get("/api/who", `${COOKIE}=arc`);
  assert.strictEqual(JSON.parse(onArc.body).chain, "arc", "the cookie routes to Arc");

  // The upstream cookie is namespaced on the way out...
  const page = await get("/", `${COOKIE}=arc`);
  const setC = [].concat(page.headers["set-cookie"] || []).join("|");
  assert.ok(setC.includes(nsName("arc", "csrf")), `namespaced on the way out: ${setC}`);
  assert.ok(page.body.includes("lp-chain-picker") && page.body.includes("arc page"), "the page is proxied and carries the picker");

  // ...and the other chain never receives it.
  const jar = `${COOKIE}=robinhood; ${nsName("arc", "csrf")}=arc-token`;
  const leak = await get("/api/who", jar);
  const seen = JSON.parse(leak.body);
  assert.strictEqual(seen.chain, "robinhood");
  assert.ok(!String(seen.cookie || "").includes("arc-token"), `Arc's token must not reach Robinhood: ${seen.cookie}`);

  // ---- state-changing requests: guarded here, then made to agree upstream -----
  {
    // The router forwards under the upstream's own host, so an Origin naming the
    // router stopped matching and every POST came back "cross-site request" -- which
    // is what the assistant panel kept reporting. The guard is not weakened: it runs
    // against the router's own origin, and only a request that passes it is rewritten.
    const post = (path, headers) => new Promise((res) => {
      const r = http.request({ host: "127.0.0.1", port, path, method: "POST", headers }, (up) => {
        let body = ""; up.setEncoding("utf8"); up.on("data", (c) => (body += c));
        up.on("end", () => res({ status: up.statusCode, body }));
      });
      r.end("{}");
    });

    const evil = await post("/api/who", { origin: "http://evil.example", "content-type": "application/json" });
    assert.strictEqual(evil.status, 403, "a cross-site POST is refused");
    assert.ok(/cross-site request/.test(evil.body), "and says why");

    const ok = await post("/api/who", { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" });
    assert.strictEqual(ok.status, 200, `a same-origin POST reaches the chain: ${ok.body}`);
    // The upstream must see an Origin matching the host it was called on, or it
    // applies its own guard and refuses a request the router already vouched for.
    const seen = JSON.parse(ok.body);
    assert.strictEqual(seen.origin, `http://${seen.host}`, `the origin names the host it was sent to, not the router: ${seen.origin} vs ${seen.host}`);
    assert.ok(!seen.origin.includes(String(port)), `and no longer names the router's port ${port}`);

    // A GET is never blocked by this: it changes nothing.
    const get = await new Promise((res) => http.get({ host: "127.0.0.1", port, path: "/api/who",
      headers: { origin: "http://evil.example" } }, (r) => { let b = ""; r.on("data", (c) => (b += c)); r.on("end", () => res({ status: r.statusCode })); }));
    assert.strictEqual(get.status, 200, "a cross-site GET is still served");
  }

  // ---- every chain's vault, side by side, never summed ------------------------
  {
    const all = await get("/api/vaults");
    assert.strictEqual(all.status, 200);
    const d = JSON.parse(all.body);
    assert.strictEqual(d.ok, true);
    assert.strictEqual(d.chains.length, 2, "one entry per configured chain");
    assert.deepStrictEqual(d.chains.map((c) => c.key), ["robinhood", "arc"]);
    // The fake chains answer /api/vault-info with an HTML page, so neither is ok --
    // what matters is the shape: per-chain entries, each with its own error, and no
    // field anywhere that adds one chain's figures to another's.
    for (const c of d.chains) {
      assert.ok("vault" in c && "treasury" in c && "error" in c, "each chain reports itself");
      assert.ok(!("total" in c) && !("combined" in c), "no cross-chain arithmetic");
    }
    assert.ok(!("total" in d) && !("combined" in d) && !("sum" in d), "and none at the top level either");
    assert.ok(d.current === "robinhood" || d.current === "arc", "it says which chain the page is on");
  }

  // A chain that is down explains itself instead of failing blankly.
  await new Promise((r) => b.close(r));
  const down = await get("/", `${COOKIE}=arc`);
  assert.strictEqual(down.status, 502);
  assert.ok(/Arc is not answering/.test(down.body), "it names the chain that is down");
  assert.ok(down.body.includes("lp-chain-picker"), "and still lets you switch to the other one");
  const stillUp = await get("/api/who", `${COOKIE}=robinhood`);
  assert.strictEqual(JSON.parse(stillUp.body).chain, "robinhood", "the other chain is unaffected");

  // ---- a chain that is not running reads differently from one that is slow ----
  {
    // Both used to say "no answer from 127.0.0.1:8787". The Robinhood instance was
    // once reported that way while it answered other routes in six milliseconds --
    // it was rebuilding a claim history -- and the reader was sent to check a port
    // that was working. Being refused and being late are different facts.
    const all = JSON.parse((await get("/api/vaults")).body);
    const down = all.chains.find((c) => c.key === "arc");
    assert.strictEqual(down.ok, false, "the closed chain has no vault");
    assert.strictEqual(down.reachable, false, "and is reported as not reachable");
    assert.ok(/nothing is listening on 127\.0\.0\.1:/.test(down.error), `named as refused: ${down.error}`);

    const up = all.chains.find((c) => c.key === "robinhood");
    assert.strictEqual(up.ok, false, "the fake chain answers HTML, so it yields no vault");
    assert.strictEqual(up.reachable, true, "but it is running, and must not be called down");
    assert.ok(!/nothing is listening/.test(up.error), `a reachable chain is not reported as refused: ${up.error}`);
  }

  await new Promise((r) => router.close(r));
  await new Promise((r) => a.close(r));
  console.log("chain router: requests reach the chosen chain, cookies never cross, the page always names its chain, and a chain that is down says so");
})().catch((e) => { console.error(e); process.exit(1); });
