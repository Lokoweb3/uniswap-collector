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
 *   node chain-router.js                  # 8799, Robinhood + Arc
 *   node chain-router.js --port=9000
 */
"use strict";

const http = require("http");
const { URL } = require("url");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};

const PORT = Number(arg("port", 8799));
const HOST = arg("host", "127.0.0.1");
const COOKIE = "lpchain";

// The only targets that exist. A request cannot name anything outside this list.
const CHAINS = [
  { key: "robinhood", label: "Robinhood", port: Number(arg("robinhood-port", 8787)) },
  { key: "arc", label: "Arc", port: Number(arg("arc-port", 8797)) },
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
function pickerHtml(current) {
  const opts = CHAINS.map((c) => `<option value="${c.key}"${c.key === current.key ? " selected" : ""}>${c.label}</option>`).join("");
  // Fixed, always visible, and it names the chain in the page's own words: a picker
  // you cannot see is how someone reads Arc's numbers believing they are Robinhood's.
  return `
<div id="${PICKER_ID}" style="position:fixed;top:8px;right:10px;z-index:99999;display:flex;gap:6px;align-items:center;
  background:rgba(15,23,42,.92);border:1px solid rgba(148,163,184,.35);border-radius:8px;padding:5px 8px;
  font:12px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;color:#e2e8f0;box-shadow:0 2px 10px rgba(0,0,0,.35)">
  <span style="opacity:.7">chain</span>
  <select aria-label="Chain" style="background:#0f172a;color:#e2e8f0;border:1px solid rgba(148,163,184,.35);
    border-radius:6px;padding:2px 6px;font:inherit">${opts}</select>
</div>
<script>(function(){var d=document.getElementById(${JSON.stringify(PICKER_ID)});if(!d)return;
d.querySelector('select').addEventListener('change',function(e){
  var u=new URL(location.href);u.searchParams.set('chain',e.target.value);location.href=u.toString();});})();</script>`;
}

function injectPicker(html, chain) {
  if (html.includes(`id="${PICKER_ID}"`)) return html;
  const tag = pickerHtml(chain);
  return html.includes("</body>") ? html.replace("</body>", `${tag}</body>`) : html + tag;
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

  const headers = { ...req.headers, host: `127.0.0.1:${chain.port}` };
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

module.exports = { chainFor, renameSetCookie, restoreCookieHeader, injectPicker, pickerHtml, CHAINS, COOKIE, nsName, server };
