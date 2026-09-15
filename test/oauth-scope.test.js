"use strict";
// TASK-78: OAuth clients are read-only end to end. Runs the real remote-MCP routes from a
// temp copy with synthetic state (adapted from brain/tasks/astra-evidence/oauth-scope.cjs):
//  1. an authorize asking for "read write" is refused with invalid_scope (no silent downgrade)
//  2. an authorize asking for "read" yields a read token; the write tools stay hidden after refresh
//  3. a stored OAuth grant that carries "write" is stripped on load and lists no write tools
//  4. a machine token (clientId "token:<label>") issued with --write still lists the three
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const net = require("net");
const { pathToFileURL } = require("url");
const { once } = require("events");

const ROOT = path.resolve(__dirname, "..");
const WRITE = ["approve_sale", "run_tasks", "record_strategy_proposal"];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-scope-"));
const h = (s) => crypto.createHash("sha256").update(String(s)).digest("base64url");
let server, port;
const origListen = net.Server.prototype.listen;
net.Server.prototype.listen = function () { server = this; return origListen.call(this, 0, "127.0.0.1"); };

function request(route, body, token) {
  const isJson = body && !(body instanceof URLSearchParams);
  const data = body ? (isJson ? JSON.stringify(body) : body.toString()) : "";
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method: body ? "POST" : "GET", agent: false,
      headers: { Accept: "application/json, text/event-stream", ...(body ? { "Content-Type": isJson ? "application/json" : "application/x-www-form-urlencoded" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => (text += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.setTimeout(5000, () => req.destroy(new Error("timeout"))); req.on("error", reject); req.end(data);
  });
}
const form = (o) => new URLSearchParams(o);
async function toolsFor(token) {
  const r = await request("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, token);
  assert.strictEqual(r.status, 200, `tools/list: ${r.text}`);
  const ev = r.text.split("\n").find((l) => l.startsWith("data: "));
  const j = JSON.parse(ev ? ev.slice(6) : r.text);
  return j.result.tools.map((t) => t.name);
}

(async () => {
  for (const f of ["lp-mcp-remote.mjs", "lp-mcp.mjs", "daykey.js"]) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"), "dir");
  const pass = "synthetic-test-passphrase", salt = "synthetic-salt";
  const staleOauth = "stale-oauth-access-token-with-write", staleRefresh = "stale-oauth-refresh-with-write", machine = "machine-token-with-write";
  const future = Math.floor(Date.now() / 1000) + 3600;
  const stateFile = path.join(tmp, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ hashed: true,
    passphrase: { salt, hash: crypto.scryptSync(pass, salt, 64).toString("hex") },
    clients: {}, codes: {},
    tokens: { [h(staleOauth)]: { clientId: "oauth-client-old", scopes: ["read", "write"], expiresAt: future },
              [h(machine)]: { clientId: "token:bot", label: "bot", scopes: ["read", "write"], issuedAt: Date.now(), expiresAt: future } },
    refresh: { [h(staleRefresh)]: { clientId: "oauth-client-old", scopes: ["read", "write"], issuedAt: Date.now() } } }), { mode: 0o600 });
  process.env.LP_MCP_STATE = stateFile; process.env.LP_MCP_PUBLIC_URL = "https://test.invalid"; process.env.LP_MCP_PORT = "0";
  process.env.LP_DASHBOARD_URL = "http://dashboard-must-not-be-called.invalid";
  await import(pathToFileURL(path.join(tmp, "lp-mcp-remote.mjs")).href);
  if (!server.listening) await once(server, "listening");
  port = server.address().port;

  // 3. stored OAuth grant with write was clamped on load
  const staleNames = await toolsFor(staleOauth);
  for (const t of WRITE) assert.ok(!staleNames.includes(t), `stale OAuth write grant must not list ${t}`);
  const stored = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.deepStrictEqual(stored.tokens[h(staleOauth)].scopes, ["read"], "stored OAuth access scopes clamped to read on save");
  assert.deepStrictEqual(stored.refresh[h(staleRefresh)].scopes, ["read"], "stored OAuth refresh scopes clamped to read on save");

  // 4. machine token keeps the write tools
  const machineNames = await toolsFor(machine);
  for (const t of WRITE) assert.ok(machineNames.includes(t), `machine --write token must list ${t}`);

  const reg = await request("/register", { client_name: "t", redirect_uris: ["http://127.0.0.1:19999/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
  assert.strictEqual(reg.status, 201, reg.text);
  const client = JSON.parse(reg.text); const redirect = client.redirect_uris[0];
  const authz = (scope, verifier) => request("/authorize?" + form({ client_id: client.client_id, redirect_uri: redirect, response_type: "code", code_challenge_method: "S256", code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), state: "s1", ...(scope === undefined ? {} : { scope }) }));

  // 1. asking for write is refused, not downgraded
  const refused = await authz("read write", "v".repeat(43));
  assert.strictEqual(refused.status, 302, "authorize with write redirects with an error");
  const errUrl = new URL(refused.headers.location);
  assert.strictEqual(errUrl.searchParams.get("error"), "invalid_scope", "error is invalid_scope");
  assert.ok(!errUrl.searchParams.get("code"), "no code issued");

  // 2. read consent -> read token; refresh stays read
  const verifier = crypto.randomBytes(32).toString("base64url");
  const consent = await authz("read", verifier);
  assert.strictEqual(consent.status, 200, consent.text.slice(0, 200));
  const nonce = consent.text.match(/name="n" value="([^"]+)"/)[1];
  const login = await request("/login", form({ n: nonce, p: pass }));
  assert.strictEqual(login.status, 302);
  const code = new URL(login.headers.location).searchParams.get("code");
  const tok = await request("/token", form({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: redirect }));
  assert.strictEqual(tok.status, 200, tok.text);
  const tokens = JSON.parse(tok.text);
  assert.strictEqual(tokens.scope, "read");
  for (const t of WRITE) assert.ok(!(await toolsFor(tokens.access_token)).includes(t), `OAuth read token must not list ${t}`);
  // a refresh that asks for write again is clamped to read
  const rf = await request("/token", form({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token, scope: "read write" }));
  assert.strictEqual(rf.status, 200, rf.text);
  const rtok = JSON.parse(rf.text);
  assert.strictEqual(rtok.scope, "read", "refresh cannot widen an OAuth grant");
  for (const t of WRITE) assert.ok(!(await toolsFor(rtok.access_token)).includes(t), `refreshed OAuth token must not list ${t}`);

  console.log("oauth-scope: write scope refused at authorize, read grants stay read through refresh, stale OAuth write grants clamped, machine --write token keeps the write tools — all assertions passed");
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (server && server.listening) await new Promise((r) => server.close(r));
  net.Server.prototype.listen = origListen;
  fs.rmSync(tmp, { recursive: true, force: true });
});
