#!/usr/bin/env node
/**
 * lp-gate.mjs - passphrase gate in front of the LP dashboard (8787) and the pool
 * scanner (3847) so they can be published with Tailscale Funnel.
 *
 *   dashboard  ->  gate :8790  ->  funnel https://<node>.ts.net:8443
 *   scanner    ->  gate :8791  ->  funnel https://<node>.ts.net:10000
 *
 * - Login: the same passphrase as the remote MCP server (scrypt hash read from
 *   mcp-auth.json, so `node lp-mcp-remote.mjs --set-passphrase` changes both).
 * - Session: HMAC-signed cookie, 30 days, HttpOnly + Secure + SameSite=Lax.
 *   The HMAC secret lives in gate-state.json (mode 600). Delete it to log
 *   everyone out.
 * - Only read requests reach the dashboard; /api/collect, /api/unlock and
 *   /api/lock are refused whatever the method. Those endpoints trust loopback,
 *   and through a proxy every request is loopback, so they must never pass.
 * - The scanner additionally accepts POST /api/chat and /api/chat/reset.
 * - Five wrong passphrases from one address lock that address for 15 minutes.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const AUTH_FILE = path.join(HERE, "mcp-auth.json");
const STATE_FILE = path.join(HERE, "gate-state.json");
const COOKIE = "lpgate";
const TTL_S = 30 * 86400;
const SITES = [
  { name: "LP dashboard", port: Number(process.env.LP_GATE_DASHBOARD_PORT || 8790), upstream: 8787,
    // /vault, /treasury, /qr.js and /api/digest are plain GETs and pass (weekly-digest-and-vault).
    allow: (m, p) => (m === "GET" || m === "HEAD") && !/^\/api\/(collect|unlock|lock|arm)(\/|$)/.test(p) && !/^\/arm(\.html)?$/.test(p) },
  { name: "Robinhood LP scanner", port: Number(process.env.LP_GATE_SCANNER_PORT || 8791), upstream: 3847,
    allow: (m, p) => m === "GET" || m === "HEAD" || (m === "POST" && /^\/api\/chat(\/reset)?$/.test(p)) },
];

// -- secret --------------------------------------------------------------------
let secret;
try { secret = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")).secret; } catch { /* first run */ }
if (!secret || secret.length < 32) {
  secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(STATE_FILE, JSON.stringify({ secret, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}

// -- passphrase (shared with lp-mcp-remote.mjs) --------------------------------
function checkPassphrase(pass) {
  let entry;
  try { entry = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")).passphrase; } catch { return false; }
  if (!entry || !entry.salt || !entry.hash || typeof pass !== "string" || pass.length > 256) return false;
  const hash = crypto.scryptSync(pass, entry.salt, 64);
  const want = Buffer.from(entry.hash, "hex");
  return hash.length === want.length && crypto.timingSafeEqual(hash, want);
}

// -- session cookie ------------------------------------------------------------
const sign = (exp) => crypto.createHmac("sha256", secret).update(String(exp)).digest("base64url");
function issue() { const exp = Math.floor(Date.now() / 1000) + TTL_S; return `${exp}.${sign(exp)}`; }
function valid(token) {
  if (typeof token !== "string") return false;
  const [exp, sig] = token.split(".");
  if (!/^\d+$/.test(exp || "") || !sig || Number(exp) < Date.now() / 1000) return false;
  const want = Buffer.from(sign(exp)); const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}

// -- login throttle ------------------------------------------------------------
const fails = new Map(); // ip -> { n, until }
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  return (xff ? String(xff).split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
}
function locked(ip) { const f = fails.get(ip); return !!(f && f.until > Date.now()); }
function fail(ip) {
  if (fails.size > 5000) fails.clear();
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60_000; f.n = 0; }
  fails.set(ip, f);
}

// -- pages ---------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function loginPage(site, next, msg) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(site.name)}</title><meta name="robots" content="noindex">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px system-ui,sans-serif;background:#f4f4f1;color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#151515;color:#eee}form{background:#1f1f1f!important;border-color:#333!important}input{background:#111;color:#eee;border-color:#444!important}}
form{background:#fff;border:1px solid #ddd;border-radius:12px;padding:26px 28px;width:min(92vw,340px);box-shadow:0 8px 30px rgba(0,0,0,.08)}
h1{font-size:17px;margin:0 0 4px}p{margin:0 0 16px;color:#777;font-size:13px}input{width:100%;box-sizing:border-box;font-size:16px;padding:10px 12px;border:1px solid #ccc;border-radius:8px}
button{margin-top:12px;width:100%;padding:10px;font-size:15px;border:0;border-radius:8px;background:#2a78d6;color:#fff;cursor:pointer}.err{color:#c9403d;font-size:13px;margin:10px 0 0}</style></head>
<body><form method="post" action="/__gate/login"><h1>${esc(site.name)}</h1><p>Enter the passphrase to continue.</p>
<input type="hidden" name="next" value="${esc(next)}"><input type="password" name="p" placeholder="Passphrase" autocomplete="current-password" autofocus required>
<button>Sign in</button>${msg ? `<div class="err">${esc(msg)}</div>` : ""}</form></body></html>`;
}
function send(res, code, body, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer", ...extra });
  res.end(body);
}
function readForm(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => { buf += c; if (buf.length > 4096) { reject(new Error("too large")); req.destroy(); } });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(buf))));
    req.on("error", reject);
  });
}
const safeNext = (n) => (typeof n === "string" && /^\/(?!\/)/.test(n) && !n.startsWith("/__gate") ? n : "/");

// -- proxy ---------------------------------------------------------------------
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "cookie", "host"]);
function proxy(site, req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  headers.host = `127.0.0.1:${site.upstream}`;
  headers["x-forwarded-for"] = clientIp(req);
  headers["x-lp-gate"] = "1";
  const up = http.request({ host: "127.0.0.1", port: site.upstream, method: req.method, path: req.url, headers }, (ur) => {
    const h = { ...ur.headers, "x-frame-options": "DENY", "referrer-policy": "no-referrer", "strict-transport-security": "max-age=31536000" };
    delete h["set-cookie"];
    res.writeHead(ur.statusCode || 502, h);
    ur.pipe(res);
  });
  up.on("error", (e) => { if (!res.headersSent) send(res, 502, JSON.stringify({ ok: false, error: `${site.name} is not running (${e.code || e.message})` }), "application/json"); else res.destroy(); });
  req.pipe(up);
}

// -- server --------------------------------------------------------------------
for (const site of SITES) {
  http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const ip = clientIp(req);
    try {
      if (url.pathname === "/__gate/login" && req.method === "POST") {
        if (locked(ip)) return send(res, 429, loginPage(site, "/", "Too many attempts. Try again in 15 minutes."));
        const form = await readForm(req);
        if (!checkPassphrase(form.p || "")) { fail(ip); console.log(`[${site.name}] wrong passphrase from ${ip}`); return send(res, 401, loginPage(site, safeNext(form.next), "Wrong passphrase.")); }
        fails.delete(ip);
        console.log(`[${site.name}] login from ${ip}`);
        return send(res, 303, "", "text/plain", { location: safeNext(form.next), "set-cookie": `${COOKIE}=${issue()}; Path=/; Max-Age=${TTL_S}; HttpOnly; Secure; SameSite=Lax` });
      }
      if (url.pathname === "/__gate/logout") return send(res, 303, "", "text/plain", { location: "/", "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` });
      if (!valid(cookies(req)[COOKIE])) {
        const wantsHtml = /text\/html/.test(req.headers.accept || "") && (req.method === "GET" || req.method === "HEAD");
        if (wantsHtml) return send(res, 200, loginPage(site, req.url, locked(ip) ? "Too many attempts. Try again in 15 minutes." : ""));
        return send(res, 401, JSON.stringify({ ok: false, error: "sign in first" }), "application/json");
      }
      if (!site.allow(req.method, url.pathname)) return send(res, 403, JSON.stringify({ ok: false, error: "not available through the public gate" }), "application/json");
      proxy(site, req, res);
    } catch (e) {
      send(res, 400, JSON.stringify({ ok: false, error: e.message }), "application/json");
    }
  }).listen(site.port, "127.0.0.1", () => console.log(`gate for ${site.name}: 127.0.0.1:${site.port} -> 127.0.0.1:${site.upstream}`));
}
