#!/usr/bin/env node
/**
 * Remote MCP server for the LP dashboard, for claude.ai and the Claude
 * mobile app ("custom connector").
 *
 * Same four read-only tools as lp-mcp.mjs, served over Streamable HTTP and
 * guarded by a self-contained OAuth 2.1 provider: claude.ai registers itself
 * as a client (dynamic client registration), sends you to a login page where
 * you type the passphrase set with --set-passphrase, and gets a bearer token
 * back. Access tokens last an hour, refresh tokens rotate. Everything is in
 * this file; the only state is mcp-auth.json next to it.
 *
 * Listens on 127.0.0.1 only. Put it on the internet with an HTTPS tunnel
 * (Tailscale Funnel, Cloudflare Tunnel) and set LP_MCP_PUBLIC_URL to that
 * address; the connector URL in claude.ai is <LP_MCP_PUBLIC_URL>/mcp.
 *
 *   node lp-mcp-remote.mjs --set-passphrase
 *   node lp-mcp-remote.mjs --issue-token <label> [--days N]   # for an agent with no browser
 *   node lp-mcp-remote.mjs --list-tokens | --revoke-token <label>
 *   LP_MCP_PUBLIC_URL=https://your-host.example node lp-mcp-remote.mjs
 *
 * Env: LP_MCP_PORT (8788), LP_MCP_PUBLIC_URL (required to serve),
 *      LP_MCP_STATE (mcp-auth.json), LP_DASHBOARD_URL / LP_TZ as in lp-mcp.mjs.
 */

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createLpServer } from "./lp-mcp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.LP_MCP_STATE || path.join(HERE, "mcp-auth.json");
const PORT = Number(process.env.LP_MCP_PORT || 8788);
const SCOPES = ["read"];
const ACCESS_TTL = 3600; // seconds
const CODE_TTL = 10 * 60 * 1000; // ms
const PENDING_TTL = 10 * 60 * 1000; // ms

// -- State -------------------------------------------------------------------
let state = { passphrase: null, clients: {}, codes: {}, tokens: {}, refresh: {}, hashed: false };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) };
} catch {}
// Tokens and codes are stored as SHA-256 hashes, so the state file is not a
// bearer credential if it leaks. Older files held them in the clear; convert.
const h = (secret) => crypto.createHash("sha256").update(String(secret)).digest("base64url");
if (!state.hashed) {
  for (const k of ["codes", "tokens", "refresh"]) {
    state[k] = Object.fromEntries(Object.entries(state[k] || {}).map(([key, v]) => [h(key), v]));
  }
  state.hashed = true;
}
function save() {
  const now = Date.now();
  for (const [k, v] of Object.entries(state.codes)) if (v.expiresAt < now) delete state.codes[k];
  for (const [k, v] of Object.entries(state.tokens)) if (v.expiresAt * 1000 < now) delete state.tokens[k];
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), { mode: 0o600 });
}
const rand = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");

// -- Passphrase ---------------------------------------------------------------
function hashPassphrase(pass, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pass, salt, 64).toString("hex") };
}
function checkPassphrase(pass) {
  if (!state.passphrase) return false;
  const { hash } = hashPassphrase(pass, state.passphrase.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(state.passphrase.hash, "hex"));
}
async function promptHidden(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  if (process.stdin.isTTY) {
    // Echo nothing while the passphrase is typed.
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(question); };
  }
  return new Promise((res) => rl.question(question, (a) => { rl.close(); if (process.stdin.isTTY) process.stdout.write("\n"); res(a); }));
}
if (process.argv.includes("--set-passphrase")) {
  const a = await promptHidden("New passphrase: ");
  if (a.length < 12) { console.error("Use at least 12 characters."); process.exit(1); }
  const b = process.stdin.isTTY ? await promptHidden("Again: ") : a;
  if (a !== b) { console.error("They differ."); process.exit(1); }
  state.passphrase = hashPassphrase(a);
  // A new passphrase invalidates every issued token; clients re-login.
  state.tokens = {}; state.refresh = {}; state.codes = {};
  save();
  console.log(`Passphrase set. Stored in ${STATE_FILE}.`);
  process.exit(0);
}

// -- Machine tokens -----------------------------------------------------------
// An agent on a server has no browser for the login page, so it gets a
// long-lived bearer token issued here instead. Same read-only scope, stored
// as a hash like every other token, revocable by label. The running server
// holds the state in memory, so restart it after issuing or revoking.
const argAfter = (flag) => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : null; };
if (process.argv.includes("--issue-token")) {
  const label = argAfter("--issue-token");
  if (!label || label.startsWith("--")) { console.error("Usage: --issue-token <label> [--days N]"); process.exit(1); }
  const days = Number(argAfter("--days") || 365);
  for (const [k, v] of Object.entries(state.tokens)) if (v.label === label) delete state.tokens[k];
  const token = rand(32);
  state.tokens[h(token)] = { clientId: `token:${label}`, label, scopes: SCOPES, issuedAt: Date.now(), expiresAt: Math.floor(Date.now() / 1000) + days * 86400 };
  save();
  console.log(`Token for "${label}", valid ${days} days. Shown once; store it now:\n${token}\nRestart the server for it to take effect.`);
  process.exit(0);
}
if (process.argv.includes("--list-tokens")) {
  const rows = Object.values(state.tokens).filter((t) => t.label);
  if (!rows.length) console.log("No machine tokens.");
  for (const t of rows) console.log(`${t.label}\tissued ${new Date(t.issuedAt).toISOString().slice(0, 10)}\texpires ${new Date(t.expiresAt * 1000).toISOString().slice(0, 10)}`);
  process.exit(0);
}
if (process.argv.includes("--revoke-token")) {
  const label = argAfter("--revoke-token");
  let n = 0;
  for (const [k, v] of Object.entries(state.tokens)) if (v.label === label) { delete state.tokens[k]; n++; }
  save();
  console.log(n ? `Revoked "${label}". Restart the server for it to take effect.` : `No token labelled "${label}".`);
  process.exit(0);
}

// -- Login throttle: five wrong passphrases from one address lock that
// address out for 15 minutes; a stranger cannot lock you out from theirs.
const failures = new Map(); // ip -> { count, until }
function loginAllowed(ip) { const f = failures.get(ip); return !f || Date.now() >= f.until; }
function loginFailed(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  f.count++;
  if (f.count >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  failures.set(ip, f);
  if (failures.size > 5000) for (const [k, v] of failures) { if (Date.now() >= v.until && v.count === 0) failures.delete(k); }
}
function loginSucceeded(ip) { failures.delete(ip); }

// -- OAuth provider ----------------------------------------------------------
const pending = new Map(); // login page nonce -> { client, params, expiresAt }
const PENDING_MAX = 500;
const CLIENTS_MAX = 100;

// Claude's hosted apps use one fixed callback; Claude Code uses a loopback
// redirect on a per-session port (RFC 8252: match ignoring the port).
function redirectAllowed(uri) {
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol === "https:" && u.host === "claude.ai" && u.pathname === "/api/mcp/auth_callback") return true;
  if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.pathname === "/callback") return true;
  return false;
}

// Keep the client list bounded: drop the oldest clients that hold no live
// token once there are more than CLIENTS_MAX.
function pruneClients() {
  const ids = Object.keys(state.clients);
  if (ids.length <= CLIENTS_MAX) return;
  const live = new Set([...Object.values(state.tokens), ...Object.values(state.refresh)].map((t) => t.clientId));
  ids
    .filter((id) => !live.has(id))
    .sort((a, b) => (state.clients[a].client_id_issued_at || 0) - (state.clients[b].client_id_issued_at || 0))
    .slice(0, ids.length - CLIENTS_MAX)
    .forEach((id) => delete state.clients[id]);
}

const provider = {
  clientsStore: {
    getClient: (id) => state.clients[id],
    registerClient: (client) => {
      // Registration is open by design (that is how claude.ai connects), but
      // only the Claude apps' callbacks are accepted, so a stranger cannot
      // register a client that sends your sign-in to their own site.
      for (const uri of client.redirect_uris || []) {
        if (!redirectAllowed(uri)) throw new InvalidClientMetadataError(`redirect_uri not allowed: ${uri}`);
      }
      const full = { ...client, client_id: client.client_id || rand(16), client_id_issued_at: client.client_id_issued_at || Math.floor(Date.now() / 1000) };
      state.clients[full.client_id] = full;
      pruneClients();
      save();
      return full;
    },
  },

  // The consent screen: one passphrase, then back to Claude with a code.
  async authorize(client, params, res) {
    const nonce = rand(24);
    for (const [k, v] of pending) if (v.expiresAt < Date.now()) pending.delete(k);
    while (pending.size >= PENDING_MAX) pending.delete(pending.keys().next().value); // oldest first
    pending.set(nonce, { client, params, expiresAt: Date.now() + PENDING_TTL });
    res.status(200).type("html").send(loginPage({ nonce, client, params }));
  },

  async challengeForAuthorizationCode(client, code) {
    const c = state.codes[h(code)];
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError("Unknown or expired code");
    return c.codeChallenge;
  },

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri) {
    const c = state.codes[h(code)];
    if (!c || c.clientId !== client.client_id || c.expiresAt < Date.now()) throw new InvalidGrantError("Unknown or expired code");
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    delete state.codes[h(code)];
    return issueTokens(client.client_id, c.scopes);
  },

  async exchangeRefreshToken(client, refreshToken, scopes) {
    const r = state.refresh[h(refreshToken)];
    if (!r || r.clientId !== client.client_id) throw new InvalidGrantError("Unknown refresh token");
    delete state.refresh[h(refreshToken)]; // rotate
    const granted = scopes && scopes.length ? scopes.filter((s) => r.scopes.includes(s)) : r.scopes;
    return issueTokens(client.client_id, granted);
  },

  async verifyAccessToken(token) {
    const t = state.tokens[h(token)];
    if (!t) throw new InvalidTokenError("Unknown token");
    if (t.expiresAt < Math.floor(Date.now() / 1000)) throw new InvalidTokenError("Token expired");
    return { token, clientId: t.clientId, scopes: t.scopes, expiresAt: t.expiresAt };
  },

  async revokeToken(client, { token }) {
    if (state.tokens[h(token)]?.clientId === client.client_id) delete state.tokens[h(token)];
    if (state.refresh[h(token)]?.clientId === client.client_id) delete state.refresh[h(token)];
    save();
  },
};

function issueTokens(clientId, scopes) {
  const access = rand(), refresh = rand();
  const expiresAt = Math.floor(Date.now() / 1000) + ACCESS_TTL;
  state.tokens[h(access)] = { clientId, scopes, expiresAt };
  state.refresh[h(refresh)] = { clientId, scopes, issuedAt: Date.now() };
  save();
  return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") };
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function loginPage({ nonce, client, params, error }) {
  const host = (() => { try { return new URL(params.redirectUri).host; } catch { return params.redirectUri; } })();
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LP dashboard · sign in</title>
<style>body{font:15px system-ui,sans-serif;background:#031116;color:#D3E0D9;display:flex;justify-content:center;padding:40px 16px}
form{background:#121F23;border:1px solid #1A282D;border-radius:10px;padding:26px 28px;max-width:380px;width:100%}
h1{font-size:17px;margin:0 0 6px;color:#fff}p{margin:6px 0;color:#7D9A94;font-size:13px}
input[type=password]{width:100%;box-sizing:border-box;margin:14px 0;padding:10px;border:1px solid #39494E;border-radius:6px;background:#0D1B20;color:#fff;font-size:16px}
button{width:100%;padding:10px;border:0;border-radius:6px;background:#14F46F;color:#031116;font-weight:600;font-size:15px}
.err{color:#FF517A}</style>
<form method="post" action="/login">
<h1>LP dashboard</h1>
<p><b>${esc(client.client_name || "A Claude app")}</b> wants read-only access to your positions, collects, daily revenue, and wallet balances.</p>
<p>After sign-in you will be sent back to <b>${esc(host)}</b>.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<input type="hidden" name="n" value="${esc(nonce)}">
<input type="password" name="p" placeholder="Passphrase" autocomplete="current-password" autofocus required>
<button>Allow</button>
</form>`;
}

// -- HTTP ---------------------------------------------------------------------
function main() {
  if (!state.passphrase) {
    console.error("No passphrase set. Run: node lp-mcp-remote.mjs --set-passphrase");
    process.exit(1);
  }
  const PUBLIC = process.env.LP_MCP_PUBLIC_URL;
  if (!PUBLIC) {
    console.error("LP_MCP_PUBLIC_URL is required: the https address your tunnel gives this server.");
    process.exit(1);
  }
  const issuer = new URL(PUBLIC);
  const mcpUrl = new URL("/mcp", issuer);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);

  const app = express();
  app.disable("x-powered-by");
  // One proxy hop in front (the tunnel), so client IPs come from X-Forwarded-For
  // and the SDK's rate limiters see the real caller rather than 127.0.0.1.
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY", // the sign-in page must not be framed
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      baseUrl: issuer,
      resourceServerUrl: mcpUrl,
      resourceName: "LP dashboard",
      scopesSupported: SCOPES,
      clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
    })
  );

  app.post("/login", express.urlencoded({ extended: false, limit: "4kb" }), (req, res) => {
    const p = pending.get(req.body.n);
    if (!p || p.expiresAt < Date.now()) return res.status(400).type("text").send("This sign-in page has expired. Go back to Claude and connect again.");
    if (!loginAllowed(req.ip)) return res.status(429).type("html").send(loginPage({ ...p, nonce: req.body.n, error: "Too many attempts. Try again in 15 minutes." }));
    if (!checkPassphrase(String(req.body.p || ""))) {
      loginFailed(req.ip);
      return res.status(401).type("html").send(loginPage({ ...p, nonce: req.body.n, error: "Wrong passphrase." }));
    }
    loginSucceeded(req.ip);
    pending.delete(req.body.n);
    const code = rand();
    state.codes[h(code)] = {
      clientId: p.client.client_id,
      codeChallenge: p.params.codeChallenge,
      redirectUri: p.params.redirectUri,
      scopes: p.params.scopes && p.params.scopes.length ? p.params.scopes : SCOPES,
      expiresAt: Date.now() + CODE_TTL,
    };
    save();
    const to = new URL(p.params.redirectUri);
    to.searchParams.set("code", code);
    if (p.params.state) to.searchParams.set("state", p.params.state);
    res.redirect(302, to.href);
  });

  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: SCOPES, resourceMetadataUrl });

  // Stateless: a fresh server + transport per request, nothing to keep alive.
  app.post("/mcp", bearer, express.json({ limit: "1mb" }), async (req, res) => {
    const server = createLpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const noSession = (_req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Stateless server: use POST" }, id: null });
  app.get("/mcp", bearer, noSession);
  app.delete("/mcp", bearer, noSession);

  app.get("/", (_req, res) => res.type("text").send("LP dashboard MCP server. Connector URL: " + mcpUrl.href));

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`Remote MCP server on http://127.0.0.1:${PORT}, public ${issuer.href}`);
    console.log(`Add to claude.ai as a custom connector: ${mcpUrl.href}`);
  });
}

main();
