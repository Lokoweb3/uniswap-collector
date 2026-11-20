#!/usr/bin/env node
/**
 * chain-router.js — one URL, both chains.
 *
 * Each chain keeps its own dashboard process, data directory, ledgers and collector
 * state. That isolation is deliberate: an Arc mistake has never been able to reach
 * Robinhood's money, and merging the processes would end that for a cosmetic gain.
 * server.js derives 95 module-level constants from a single settings.load(), so one
 * process genuinely means one chain.
 *
 * So this sits in front instead. It picks a chain per browser (a cookie), proxies
 * every request to that chain's instance unchanged, and injects a picker into HTML
 * responses. The page's 29 same-origin /api/… fetches keep working untouched,
 * because from the page's point of view nothing has changed.
 *
 * What it deliberately does NOT do:
 *   - merge data across chains on the proxy path. Everything proxied (the dashboards and
 *     their /api/... calls) is one chain's data, unmerged. The one exception is a separate,
 *     read-only, labelled-per-chain view, /portfolio + /api/aggregate (aggregate.js): it
 *     reads four cached GET endpoints per chain, never sums over a chain it could not
 *     read, shows each chain's status and stale data as such, and has no write path.
 *   - proxy anywhere but a configured chain. The target is chosen from a fixed list
 *     by key; nothing in a request can point it elsewhere.
 *   - share cookies between chains. Each instance's cookies are namespaced per chain
 *     on the way out and restored on the way in, so a session or CSRF token minted
 *     on one chain is never presented to the other.
 *
 *   node chain-router.js                  # 8800, Robinhood + Arc
 *   node chain-router.js --chains=robinhood,arc,base   # also Base (:8796)
 *   node chain-router.js --chains=robinhood,arc,pulsechain   # also PulseChain (:8795)
 *   node chain-router.js --chains=robinhood,arc,elysium-testnet   # also the Elysium TESTNET (:8794), never counted in a total
 *
 * Not 8799: test/smoke.js starts its own dashboard there, and a router squatting on
 * that port makes the whole smoke suite fail with "fetch failed".
 *   node chain-router.js --port=9000
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const csrf = require("./csrf");
const elysium = require("./elysium-chains");
const aggregate = require("./aggregate");
const { URL } = require("url");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};

const PORT = Number(arg("port", 8800));
const HOST = arg("host", process.env.HOST || "127.0.0.1");
const COOKIE = "lpchain";

// Server-side detail for failures whose text must not reach the client. Only a short alphanumeric code is
// ever logged: no message text (which can carry URLs, keys or addresses), no stack.
const safeCode = (err) => (err && typeof err.code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.code) ? err.code : "unknown");
const logDetail = (msg) => console.error(`[chain-router] ${msg}`);

// The only targets that exist. A request cannot name anything outside this list.
// accent: each chain gets its own colour so the bar reads as "which chain" at a
// glance, before any word is read.
const KNOWN_CHAINS = [
  { key: "robinhood", label: "Robinhood", accent: "#34d399", port: Number(arg("robinhood-port", 8787)) },
  { key: "arc", label: "Arc", accent: "#38bdf8", port: Number(arg("arc-port", 8797)) },
  { key: "base", label: "Base", accent: "#0052ff", port: Number(arg("base-port", 8796)) },
  { key: "pulsechain", label: "PulseChain", accent: "#c026d3", port: Number(arg("pulsechain-port", 8795)) },
  // A test network: tagged TESTNET in the picker and the Portfolio tabs, and never counted in any total (aggregate.js).
  { key: "elysium-testnet", label: "Elysium Testnet", accent: "#f59e0b", port: Number(arg("elysium-testnet-port", 8794)), testnet: true },
];
// Which of the known chains this router fronts: --chains=robinhood,arc,base,pulsechain or LP_ROUTER_CHAINS.
// The default is exactly the list it has always had, so nothing changes unless a chain is
// named. An unknown name is ignored (a request still cannot name a target), and the list
// keeps the order given, so the picker reads the way the operator wrote it.
const WANTED = String(arg("chains", process.env.LP_ROUTER_CHAINS || "robinhood,arc")).split(",").map((k) => k.trim()).filter(Boolean);
// The Elysium mainnet is prepared but disabled. Naming it is an explicit error, not the silent "unknown name" path.
if (WANTED.includes("elysium-mainnet")) {
  console.error(`[chain-router] ${elysium.MAINNET_DISABLED_MESSAGE}`);
  process.exit(1);
}
const CHAINS = [...new Set(WANTED)].map((k) => KNOWN_CHAINS.find((c) => c.key === k)).filter(Boolean);
if (!CHAINS.length) CHAINS.push(KNOWN_CHAINS[0]);
const DEFAULT = arg("default", "robinhood");
const byKey = (k) => CHAINS.find((c) => c.key === k) || null;

// Arming is not per chain. The unlock lives in the process that runs the collector
// (Robinhood's), and one window covers every chain's collector run on this machine;
// the other instances are read-only and refuse it. So arm, unlock and lock always go
// to that instance, whichever chain the picker shows -- otherwise the Arc view's
// Wallet page offered an Arm button that could only ever answer "read-only".
const ARM_CHAIN = arg("arm-chain", "robinhood");
const ARM_PATH = /^\/api\/(arm|unlock|lock)(\/|$)/;
/** The instance a request is sent to: the picked chain, except for arming. */
function targetFor(chain, pathname) {
  return ARM_PATH.test(pathname) ? byKey(ARM_CHAIN) || chain : chain;
}

/** The chain for this request: an explicit ?chain= wins, then the cookie, then the default. */
function chainFor(req, url) {
  const asked = url.searchParams.get("chain");
  if (asked && byKey(asked)) return { chain: byKey(asked), fromQuery: true };
  const raw = req.headers.cookie || "";
  const hit = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
  let fromCookie = null;
  if (hit) {
    // A malformed escape ("%", "%E0%A4%A") makes decodeURIComponent throw; that is a bad cookie, not a crash.
    try { fromCookie = byKey(decodeURIComponent(hit.slice(COOKIE.length + 1))); } catch { fromCookie = null; }
  }
  return { chain: fromCookie || byKey(DEFAULT) || CHAINS[0], fromQuery: false };
}

// Cookies are namespaced per chain so the two instances cannot overwrite each
// other's session or CSRF state in one browser.
const nsName = (key, name) => `c_${key}__${name}`;
function renameSetCookie(value, key) {
  return String(value).replace(/^([^=]+)=/, (_m, name) => `${nsName(key, name.trim())}=`);
}
function restoreCookieHeader(raw, key) {
  const prefix = `c_${key}__`;
  return String(raw || "").split(";").map((s) => s.trim()).filter(Boolean)
    .filter((c) => c.startsWith(prefix) || !c.startsWith("c_"))     // this chain's, plus anything unprefixed
    .map((c) => (c.startsWith(prefix) ? c.slice(prefix.length) : c))
    .filter((c) => !c.startsWith(`${COOKIE}=`))                      // the router's own cookie stays here
    .join("; ");
}

const PICKER_ID = "lp-chain-picker";
// The visible mark on a test network's tab. Static markup, same in the picker and the Portfolio tabs.
const TESTNET_TAG = '<span class="testnet-tag" style="font-size:9px;font-weight:800;letter-spacing:.8px;border:1px solid currentColor;border-radius:4px;padding:0 4px;margin-left:2px">TESTNET</span>';
// Methods a browser may send cross-site without the guard mattering; everything else
// is checked before it is forwarded.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
function pickerHtml(current) {
  // A dropdown was easy to miss: it read as page furniture, and the chain a figure
  // belongs to is the one thing here that must never be misread. So: every chain
  // visible at once, the current one filled in its own colour and marked as current,
  // the others plainly clickable. Nothing is hidden behind an interaction.
  //
  // Anchors, not buttons, so it works with JavaScript off, opens in a new tab on
  // middle click, and can be tabbed to. The click handler only adds preserving the
  // rest of the query string, which a bare href cannot do.
  const tabs = CHAINS.map((c) => {
    const here = c.key === current.key;
    return `<a href="?chain=${encodeURIComponent(c.key)}" data-chain="${c.key}"${here ? ' aria-current="page"' : ""}
      title="${here ? `Showing ${c.label}` : `Switch to ${c.label}`}"
      style="display:flex;align-items:center;gap:6px;text-decoration:none;border-radius:7px;padding:6px 11px;
      font-weight:${here ? 700 : 500};letter-spacing:.2px;white-space:nowrap;
      color:${here ? "#0b1220" : "#cbd5e1"};background:${here ? c.accent : "transparent"};
      border:1px solid ${here ? c.accent : "rgba(148,163,184,.3)"}">
      <span style="width:7px;height:7px;border-radius:50%;background:${here ? "#0b1220" : c.accent};opacity:${here ? 0.75 : 1}"></span>
      ${c.label}${c.testnet ? TESTNET_TAG : ""}</a>`;
  }).join("");
  // The cross-chain page is not a chain, so it has no data-chain: the click handler below
  // only reacts to a[data-chain] and leaves this a plain link.
  const portfolioTab = `<a href="/portfolio" title="All chains, one page"
      style="display:flex;align-items:center;text-decoration:none;border-radius:7px;padding:6px 11px;margin-left:4px;
      font-weight:500;white-space:nowrap;color:#e2e8f0;
      background:transparent;border:1px dashed rgba(226,232,240,.55)">Portfolio</a>`;
  // Bottom left: at the top right it sat on the page's own Refresh / Collect buttons.
  // Fixed, always visible, and it names the chain in the page's own words: a picker
  // you cannot see is how someone reads Arc's numbers believing they are Robinhood's.
  return `
<div id="${PICKER_ID}" role="navigation" aria-label="Chain"
  style="position:fixed;bottom:12px;left:12px;z-index:99999;display:flex;gap:8px;align-items:center;
  background:rgba(15,23,42,.96);border:1px solid ${current.accent}66;border-radius:11px;padding:7px 9px;
  font:13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;color:#e2e8f0;
  box-shadow:0 6px 22px rgba(0,0,0,.45),0 0 0 3px ${current.accent}1f">
  <span style="font-size:10px;text-transform:uppercase;letter-spacing:.9px;opacity:.6;padding-left:2px">Chain</span>
  <span style="display:flex;gap:5px">${tabs}</span>${portfolioTab}
</div>
<script>(function(){var d=document.getElementById(${JSON.stringify(PICKER_ID)});if(!d)return;
d.addEventListener('click',function(e){var a=e.target.closest('a[data-chain]');
  if(!a||e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;
  e.preventDefault();
  var u=new URL(location.href);u.searchParams.set('chain',a.getAttribute('data-chain'));location.href=u.toString();});})();</script>`;
}

function injectPicker(html, chain) {
  if (html.includes(`id="${PICKER_ID}"`)) return html;
  const tag = pickerHtml(chain);
  return html.includes("</body>") ? html.replace("</body>", `${tag}</body>`) : html + tag;
}

/**
 * One chain's vault, or why it could not be read. Never throws, never blocks the others.
 *
 * Why it failed is not one thing. A chain that is not running refuses the connection;
 * a busy one accepts it and answers late. Both used to read "no answer from
 * 127.0.0.1:8787", which sent someone to check a port that was in fact answering
 * other routes in six milliseconds -- it was rebuilding a claim history at the time.
 * /api/vault-info reads the NFT, its art and several balances from chain, so seconds
 * are normal for it and a slow answer is not an outage.
 */
function vaultOf(chain, timeoutMs = 15000) {
  const get = (path) => new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: chain.port, path, method: "GET", timeout: timeoutMs }, (up) => {
      let body = "";
      up.setEncoding("utf8");
      up.on("data", (c) => (body += c));
      up.on("end", () => {
        try { resolve({ data: JSON.parse(body) }); }
        catch { resolve({ fail: `answered ${up.statusCode} but not with JSON` }); }
      });
    });
    r.on("timeout", () => { r.destroy(); resolve({ fail: `did not answer within ${Math.round(timeoutMs / 1000)}s — busy, not down` }); });
    r.on("error", (err) => {
      // Fixed strings only reach the client; the code is logged server-side (a bare code, never a message).
      if (err.code !== "ECONNREFUSED") logDetail(`vault ${chain.key}: upstream error code ${safeCode(err)}`);
      resolve({ fail: err.code === "ECONNREFUSED" ? `nothing is listening on 127.0.0.1:${chain.port}` : "could not reach the instance" });
    });
    r.end();
  });
  return Promise.all([get("/api/vault-info"), get("/api/treasury")]).then(([v, t]) => {
    const vault = v.data && v.data.ok ? v.data : null;
    const treasury = t.data && t.data.ok ? t.data : null;
    return {
      key: chain.key, label: chain.label, port: chain.port,
      ok: !!vault,
      // Read-only, and kept apart: each chain's figures stay under that chain's name.
      // Nothing here is added to anything from another chain.
      vault, treasury,
      error: vault ? null : v.fail || "answered, but not with a vault",
      // Whether the instance is reachable at all, which is a different question from
      // whether it produced a vault. A card that says "not running" when the process
      // is merely busy sends someone to restart something that is working.
      reachable: !v.fail || !/nothing is listening/.test(v.fail),
    };
  });
}

// ---- the cross-chain Portfolio view (read-only) ----------------------------------------
// /portfolio, /api/aggregate, /aggregate-view.js and /aggregate.css are answered here, ahead
// of the ?chain= redirect and the proxy: they belong to no single chain. They accept GET and
// HEAD only, check the Host header (these four routes only; the proxy path is unchanged) and
// reach only the fixed ports in CHAINS, over the four fixed GET paths in aggregate.js and
// /api/earnlog (the Earned today figure, below).
const envMs = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };
const aggregator = aggregate.createAggregator({
  chains: CHAINS,
  timeoutMs: envMs("LP_AGG_TIMEOUT_MS", 8000),
  waitMs: envMs("LP_AGG_WAIT_MS", 4000),
  ttlMs: envMs("LP_AGG_TTL_MS", 30000),
  buildMaxAgeMs: envMs("LP_AGG_BUILD_MS", 1000),
  maxBytes: envMs("LP_AGG_MAX_BYTES", 8 * 1024 * 1024),
});
const AGG_ROUTES = new Set(["/portfolio", "/portfolio/", "/api/aggregate", "/aggregate-view.js", "/aggregate.css"]);

// What the positions earned today, read from each chain's own earnings log (/api/earnlog,
// earn-log.js), added up and attached to the /api/aggregate answer as `earn`. Kept out of
// aggregate.js on purpose: a chain without a log leaves this figure smaller, it never makes
// the portfolio incomplete, and it is in no total.
const EARN_TTL_MS = 30000;
const earnNum = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
let earnCache = { at: 0, body: null, pending: null };
function earningsJson() {
  if (earnCache.body && Date.now() - earnCache.at < EARN_TTL_MS) return Promise.resolve(earnCache.body);
  if (earnCache.pending) return earnCache.pending;
  const chains = CHAINS.filter((c) => !c.testnet);
  earnCache.pending = Promise.all(chains.map((c) => aggregate.defaultFetchJson(c.port, "/api/earnlog", { timeoutMs: 6000, maxBytes: 2 * 1024 * 1024 })))
    .then((answers) => {
      const out = { ok: false, at: Date.now(), since: null, todayUsd: 0, yesterdayUsd: 0, d7Usd: 0, wallets: {} };
      for (const a of answers) {
        const d = a && a.status === 200 && a.data && a.data.ok === true ? a.data : null;
        if (!d || !d.totals || !(d.since > 0)) continue;   // no log on this chain
        out.ok = true;
        if (!out.since || d.since < out.since) out.since = d.since;
        const days = Array.isArray(d.days) ? d.days : [];
        out.todayUsd += earnNum(days.length ? days[days.length - 1].usd : 0);
        out.yesterdayUsd += earnNum(days.length > 1 ? days[days.length - 2].usd : 0);
        out.d7Usd += days.slice(-7).reduce((s, x) => s + earnNum(x && x.usd), 0);
        for (const p of Array.isArray(d.positions) ? d.positions : []) {
          const addr = p && typeof p.key === "string" ? p.key.slice(0, 42) : "";   // key is "<wallet address>:<position id>"
          if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
          const w = out.wallets[addr] || (out.wallets[addr] = { todayUsd: 0, d7Usd: 0 });
          w.todayUsd += earnNum(p.todayUsd);
          w.d7Usd += earnNum(p.d7Usd);
        }
      }
      earnCache = { at: Date.now(), body: JSON.stringify(out), pending: null };
      return earnCache.body;
    })
    .catch(() => { earnCache.pending = null; return JSON.stringify({ ok: false }); });
  return earnCache.pending;
}
const AGG_EXTRA_HOSTS = String(process.env.LP_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const AGG_THEME_DIR = process.env.LP_AGG_THEME_DIR || __dirname;
const AGG_NOSNIFF = { "X-Content-Type-Options": "nosniff" };
// Portfolio page only (not the proxy path). dashboard.css/aggregate.css use no url(), @import, fonts or
// data: images, and the page has no inline script; the chain tabs and chips carry inline style="--accent"
// attributes, which is the one reason style-src keeps 'unsafe-inline'.
const AGG_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Static files read again only when their mtime changes (the theme can be edited under a running router). */
const fileCache = new Map();
function cachedFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { fileCache.delete(file); return null; }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.body;
  let body;
  try { body = fs.readFileSync(file); } catch { fileCache.delete(file); return null; }
  fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, body });
  return body;
}

/** Loopback names only on the router's own port (or none), plus names in LP_ALLOWED_HOSTS. */
function aggHostAllowed(raw, localPort) {
  if (!raw) return false;
  const host = String(raw).toLowerCase();
  const bare = host.replace(/:\d+$/, "");
  if (["127.0.0.1", "localhost", "[::1]", "::1"].includes(bare)) return host === bare || host === `${bare}:${localPort}`;
  return AGG_EXTRA_HOSTS.includes(host) || AGG_EXTRA_HOSTS.includes(bare);
}

/** dashboard.css (the theme, read at request time) followed by the aggregate rules. */
function aggregateCss(themeDir = AGG_THEME_DIR) {
  const theme = cachedFile(path.join(themeDir, "dashboard.css")) || Buffer.alloc(0);   // the aggregate rules carry fallbacks
  const rules = cachedFile(path.join(__dirname, "aggregate.css")) || Buffer.alloc(0);
  return Buffer.concat([theme, theme.length ? Buffer.from("\n") : Buffer.alloc(0), rules]);
}

/** The page shell. No inline script and no upstream data: the view script fills it in. */
function portfolioHtml() {
  const tabs = CHAINS.map((c) => `<a class="chain-tab" href="/?chain=${encodeURIComponent(c.key)}" data-key="${c.key}" style="--accent:${c.accent}"><span class="dot"></span>${c.label}${c.testnet ? TESTNET_TAG : ""}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Portfolio - all chains</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Sora:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600;700&family=Bebas+Neue&family=Yellowtail&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/aggregate.css">
</head>
<body class="agg">
<div class="wrap">
<header class="topbar">
  <div class="topbar-left">
    <h1 class="brand">LP Dashboard</h1>
    <nav class="pages" aria-label="Pages"><a href="/">Dashboard</a><a href="/analytics">Analytics</a><a href="/wallet">Wallet</a><a href="/portfolio" class="here" aria-current="page">Portfolio</a></nav>
  </div>
  <div class="topbar-right"><span class="agg-sub">Portfolio${CHAINS.length > 1 ? " · all chains" : ""}</span></div>
</header>
<div class="agg-chainbar" role="navigation" aria-label="Chain"><span class="agg-chainbar-label">Open a chain</span>${tabs}<a class="chain-tab all" href="/">Dashboard</a></div>
<main id="agg-root" aria-live="polite"><p class="agg-loading">Loading the portfolio...</p></main>
<noscript><p>This page needs JavaScript to list the portfolio.</p></noscript>
</div>
<script src="/aggregate-view.js" defer></script>
</body>
</html>
`;
}

/** Returns true when the request was one of the Portfolio routes (and has been answered). */
function handleAggregate(req, res, url) {
  if (!AGG_ROUTES.has(url.pathname)) return false;
  const send = (status, headers, body) => {
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : body);
  };
  if (!aggHostAllowed(req.headers.host, req.socket && req.socket.localPort)) {
    send(421, { "Content-Type": "application/json", "Cache-Control": "no-store", ...AGG_NOSNIFF }, JSON.stringify({ ok: false }));
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(405, { Allow: "GET, HEAD", "Content-Type": "application/json", ...AGG_NOSNIFF }, JSON.stringify({ ok: false, error: "read-only" }));
    return true;
  }
  const htmlHeaders = {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache",
    "Content-Security-Policy": AGG_CSP, "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer", ...AGG_NOSNIFF,
  };
  if (url.pathname === "/portfolio" || url.pathname === "/portfolio/") {
    send(200, htmlHeaders, portfolioHtml());
  } else if (url.pathname === "/aggregate.css") {
    send(200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-cache", ...AGG_NOSNIFF }, aggregateCss());
  } else if (url.pathname === "/aggregate-view.js") {
    const body = cachedFile(path.join(__dirname, "aggregate-view.js"));
    if (!body || !body.length) send(404, { "Content-Type": "application/json", ...AGG_NOSNIFF }, JSON.stringify({ ok: false }));
    else send(200, { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", ...AGG_NOSNIFF }, body);
  } else {
    const json = { "Content-Type": "application/json", "Cache-Control": "no-store", ...AGG_NOSNIFF };
    if (req.method === "HEAD") { send(200, json); return true; }
    // The earnings read never holds the answer back: past a second, the last known figure (or none) is sent.
    const earnSoon = Promise.race([earningsJson(), new Promise((r) => setTimeout(() => r(earnCache.body), 1000))]);
    Promise.all([aggregator.getJson({ refresh: url.searchParams.get("refresh") === "1" }), earnSoon])
      .then(([body, earn]) => send(200, json, earn && typeof body === "string" && body.endsWith("}") && body.length > 2 ? `${body.slice(0, -1)},"earn":${earn}}` : body))
      .catch(() => send(500, json, JSON.stringify({ ok: false, error: "aggregate failed" })));
  }
  return true;
}

function handle(req, res) {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || "localhost"}`); } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": 12, "Connection": "close" });
    return res.end("bad request\n");
  }

  // Before the ?chain= redirect: these routes ignore the chain cookie and query.
  if (handleAggregate(req, res, url)) return;

  const { chain, fromQuery } = chainFor(req, url);

  // A chain chosen by query is remembered and the query dropped, so a shared link
  // does not pin someone to a chain they did not choose on their next click.
  if (fromQuery) {
    url.searchParams.delete("chain");
    res.writeHead(302, {
      "Set-Cookie": `${COOKIE}=${chain.key}; Path=/; SameSite=Lax`,
      // Same-origin path only: dot-segment removal turns "/.//evil.example" into
      // "//evil.example", which a browser follows to another site. Strip every leading
      // slash and backslash, then put back exactly one.
      Location: "/" + url.pathname.replace(/^[/\\]+/, "") + (url.search || ""),
    });
    return res.end();
  }

  // Every chain's vault at once, answered by the router rather than proxied: no
  // single instance can see another chain, and none of them should have to.
  if (url.pathname === "/api/vaults" && req.method === "GET") {
    Promise.all(CHAINS.map((c) => vaultOf(c))).then((chains) => {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, at: Date.now(), current: chain.key, chains }));
    }).catch((err) => {
      logDetail(`/api/vaults failed: ${err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "Error"} ${safeCode(err)}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "vault summary unavailable" }));
    });
    return;
  }

    // The router forwards under the upstream's own host, so an Origin naming the
  // router no longer matches it and every state-changing request was rejected as a
  // cross-site one -- which is what the AI panel kept reporting. The guard is not
  // dropped, it moves to the edge: the request is checked against the ROUTER's own
  // origin, exactly as the instance would have checked it against its own, and only
  // then is the Origin rewritten to the upstream it is actually being sent to.
  if (!SAFE_METHODS.has(req.method) && csrf.isCrossSite({
    origin: req.headers.origin, host: req.headers.host,
    secFetchSite: req.headers["sec-fetch-site"], viaGate: req.headers["x-lp-gate"] === "1",
  })) {
    res.writeHead(403, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: false, error: "cross-site request" }));
  }

  const picked = chain;
  const target = targetFor(picked, url.pathname);
  const headers = { ...req.headers, host: `127.0.0.1:${target.port}` };
  if (headers.origin) headers.origin = `http://127.0.0.1:${target.port}`;
  if (headers.referer) headers.referer = String(headers.referer).replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${target.port}`);
  const cookies = restoreCookieHeader(req.headers.cookie, target.key);
  if (cookies) headers.cookie = cookies; else delete headers.cookie;
  delete headers["accept-encoding"];    // so HTML can be rewritten without decompressing

  const upstream = http.request({ host: "127.0.0.1", port: target.port, path: req.url, method: req.method, headers }, (r) => {
    const out = { ...r.headers };
    if (out["set-cookie"]) out["set-cookie"] = [].concat(out["set-cookie"]).map((c) => renameSetCookie(c, target.key));
    const isHtml = String(out["content-type"] || "").includes("text/html");
    if (!isHtml) { res.writeHead(r.statusCode, out); return r.pipe(res); }
    let body = "";
    r.setEncoding("utf8");
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const html = injectPicker(body, picked);
      delete out["content-length"];
      res.writeHead(r.statusCode, out);
      res.end(html);
    });
  });

  upstream.on("error", (err) => {
    logDetail(`proxy ${target.key}: ${safeCode(err)}`);
    // A chain that is down says which chain and where, rather than a bare 502.
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>${target.label} is not answering</title>
<body style="font:14px/1.5 system-ui;margin:40px;color:#e2e8f0;background:#0f172a">
<h1 style="font-size:18px">${target.label} is not answering</h1>
<p>The dashboard for <b>${target.label}</b> should be listening on 127.0.0.1:${target.port}. It is not: <code>${err && err.code === "ECONNREFUSED" ? "connection refused" : "no answer"}</code>.</p>
<p>The other chain is unaffected — nothing here is shared between them.</p>
${injectPicker("", picked)}
</body>`);
  });

  req.pipe(upstream);
}

// An unexpected throw in a handler answers 500 instead of taking the router (and every chain's view) down.
const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    logDetail(`request failed: ${err && typeof err.name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(err.name) ? err.name : "Error"}`);
    try {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", "Connection": "close" });
      res.end("internal error\n");
    } catch { /* the socket is gone */ }
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`chain router on http://${HOST}:${PORT}`);
    if (!["127.0.0.1", "::1", "localhost"].includes(HOST)) {
      console.error(`[chain-router] WARNING: bound to ${HOST}, not loopback. Every proxied chain is exposed without router-level auth; LP_ALLOWED_HOSTS only covers /portfolio.`);
    }
    for (const c of CHAINS) console.log(`  ${c.label.padEnd(10)} -> 127.0.0.1:${c.port}${c.key === DEFAULT ? "  (default)" : ""}`);
  });
}

module.exports = { KNOWN_CHAINS, chainFor, targetFor, renameSetCookie, restoreCookieHeader, injectPicker, pickerHtml, vaultOf, CHAINS, COOKIE, nsName, server, aggregateCss, portfolioHtml, aggHostAllowed, aggregator };
