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
 *   - merge data across chains. No cross-chain totals, no combined position list.
 *     Two right answers beat one wrong one, and a summed figure hides a stale half.
 *   - proxy anywhere but a configured chain. The target is chosen from a fixed list
 *     by key; nothing in a request can point it elsewhere.
 *   - share cookies between chains. Each instance's cookies are namespaced per chain
 *     on the way out and restored on the way in, so a session or CSRF token minted
 *     on one chain is never presented to the other.
 *
 *   node chain-router.js                  # 8800, Robinhood + Arc
 *
 * Not 8799: test/smoke.js starts its own dashboard there, and a router squatting on
 * that port makes the whole smoke suite fail with "fetch failed".
 *   node chain-router.js --port=9000
 */
"use strict";

const http = require("http");
const csrf = require("./csrf");
const { URL } = require("url");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};

const PORT = Number(arg("port", 8800));
const HOST = arg("host", "127.0.0.1");
const COOKIE = "lpchain";

// The only targets that exist. A request cannot name anything outside this list.
// accent: each chain gets its own colour so the bar reads as "which chain" at a
// glance, before any word is read.
const CHAINS = [
  { key: "robinhood", label: "Robinhood", accent: "#34d399", port: Number(arg("robinhood-port", 8787)) },
  { key: "arc", label: "Arc", accent: "#38bdf8", port: Number(arg("arc-port", 8797)) },
];
const DEFAULT = arg("default", "robinhood");
const byKey = (k) => CHAINS.find((c) => c.key === k) || null;

/** The chain for this request: an explicit ?chain= wins, then the cookie, then the default. */
function chainFor(req, url) {
  const asked = url.searchParams.get("chain");
  if (asked && byKey(asked)) return { chain: byKey(asked), fromQuery: true };
  const raw = req.headers.cookie || "";
  const hit = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${COOKIE}=`));
  const fromCookie = hit ? byKey(decodeURIComponent(hit.slice(COOKIE.length + 1))) : null;
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
      ${c.label}</a>`;
  }).join("");
  // Fixed, always visible, and it names the chain in the page's own words: a picker
  // you cannot see is how someone reads Arc's numbers believing they are Robinhood's.
  return `
<div id="${PICKER_ID}" role="navigation" aria-label="Chain"
  style="position:fixed;top:10px;right:12px;z-index:99999;display:flex;gap:8px;align-items:center;
  background:rgba(15,23,42,.96);border:1px solid ${current.accent}66;border-radius:11px;padding:7px 9px;
  font:13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;color:#e2e8f0;
  box-shadow:0 6px 22px rgba(0,0,0,.45),0 0 0 3px ${current.accent}1f">
  <span style="font-size:10px;text-transform:uppercase;letter-spacing:.9px;opacity:.6;padding-left:2px">Chain</span>
  <span style="display:flex;gap:5px">${tabs}</span>
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

/** One chain's vault, or why it could not be read. Never throws, never blocks the others. */
function vaultOf(chain, timeoutMs = 8000) {
  const get = (path) => new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: chain.port, path, method: "GET", timeout: timeoutMs }, (up) => {
      let body = "";
      up.setEncoding("utf8");
      up.on("data", (c) => (body += c));
      up.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    r.on("timeout", () => { r.destroy(); resolve(null); });
    r.on("error", () => resolve(null));
    r.end();
  });
  return Promise.all([get("/api/vault-info"), get("/api/treasury")]).then(([vault, treasury]) => ({
    key: chain.key, label: chain.label, port: chain.port,
    ok: !!(vault && vault.ok),
    // Read-only, and kept apart: each chain's figures stay under that chain's name.
    // Nothing here is added to anything from another chain.
    vault: vault && vault.ok ? vault : null,
    treasury: treasury && treasury.ok ? treasury : null,
    error: vault && vault.ok ? null : (vault && vault.error) || `no answer from 127.0.0.1:${chain.port}`,
  }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { chain, fromQuery } = chainFor(req, url);

  // A chain chosen by query is remembered and the query dropped, so a shared link
  // does not pin someone to a chain they did not choose on their next click.
  if (fromQuery) {
    url.searchParams.delete("chain");
    res.writeHead(302, {
      "Set-Cookie": `${COOKIE}=${chain.key}; Path=/; SameSite=Lax`,
      Location: url.pathname + (url.search || ""),
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
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
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

  const headers = { ...req.headers, host: `127.0.0.1:${chain.port}` };
  if (headers.origin) headers.origin = `http://127.0.0.1:${chain.port}`;
  if (headers.referer) headers.referer = String(headers.referer).replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${chain.port}`);
  const cookies = restoreCookieHeader(req.headers.cookie, chain.key);
  if (cookies) headers.cookie = cookies; else delete headers.cookie;
  delete headers["accept-encoding"];    // so HTML can be rewritten without decompressing

  const upstream = http.request({ host: "127.0.0.1", port: chain.port, path: req.url, method: req.method, headers }, (r) => {
    const out = { ...r.headers };
    if (out["set-cookie"]) out["set-cookie"] = [].concat(out["set-cookie"]).map((c) => renameSetCookie(c, chain.key));
    const isHtml = String(out["content-type"] || "").includes("text/html");
    if (!isHtml) { res.writeHead(r.statusCode, out); return r.pipe(res); }
    let body = "";
    r.setEncoding("utf8");
    r.on("data", (c) => (body += c));
    r.on("end", () => {
      const html = injectPicker(body, chain);
      delete out["content-length"];
      res.writeHead(r.statusCode, out);
      res.end(html);
    });
  });

  upstream.on("error", (err) => {
    // A chain that is down says which chain and where, rather than a bare 502.
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset="utf-8"><title>${chain.label} is not answering</title>
<body style="font:14px/1.5 system-ui;margin:40px;color:#e2e8f0;background:#0f172a">
<h1 style="font-size:18px">${chain.label} is not answering</h1>
<p>The dashboard for <b>${chain.label}</b> should be listening on 127.0.0.1:${chain.port}. It is not: <code>${err.code || err.message}</code>.</p>
<p>The other chain is unaffected — nothing here is shared between them.</p>
${injectPicker("", chain)}
</body>`);
  });

  req.pipe(upstream);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`chain router on http://${HOST}:${PORT}`);
    for (const c of CHAINS) console.log(`  ${c.label.padEnd(10)} -> 127.0.0.1:${c.port}${c.key === DEFAULT ? "  (default)" : ""}`);
  });
}

module.exports = { chainFor, renameSetCookie, restoreCookieHeader, injectPicker, pickerHtml, vaultOf, CHAINS, COOKIE, nsName, server };
