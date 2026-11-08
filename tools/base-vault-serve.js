#!/usr/bin/env node
/**
 * base-vault-serve.js -- a tiny static server for the Base LOKOVault signing page. It serves four fixed files
 * and /plan.json (built from the pinned, verified artifact). It holds no keys, makes no RPC calls, and has no
 * endpoint that accepts data. The page talks to the wallet (Rabby) in the browser; this server never sees it.
 *
 *   node tools/base-vault-serve.js        # http://127.0.0.1:8745   (HOST / PORT override)
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const core = require("./base-vault-core");

const PAGE_DIR = path.join(__dirname, "base-vault");
const ETHERS_UMD = path.join(__dirname, "..", "node_modules", "ethers", "dist", "ethers.umd.min.js");
const CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'";
const ROUTES = {
  "/": [path.join(PAGE_DIR, "index.html"), "text/html; charset=utf-8"],
  "/page.js": [path.join(PAGE_DIR, "page.js"), "application/javascript; charset=utf-8"],
  "/flow.js": [path.join(PAGE_DIR, "flow.js"), "application/javascript; charset=utf-8"],
  "/ethers.umd.min.js": [ETHERS_UMD, "application/javascript; charset=utf-8"],
};

/** Throws core.ArtifactError (or a read error) when the artifact does not verify; nothing is served then. */
function createServer({ artifactPath = core.ARTIFACT_PATH, host = process.env.HOST || "127.0.0.1" } = {}) {
  const art = core.loadArtifact(artifactPath);
  const planJson = JSON.stringify(core.buildPlan(art));
  const files = {};
  for (const [route, [file, type]] of Object.entries(ROUTES)) files[route] = { body: fs.readFileSync(file), type };
  files["/plan.json"] = { body: Buffer.from(planJson), type: "application/json; charset=utf-8" };

  const server = http.createServer((req, res) => {
    const headers = (type) => ({ "Content-Type": type, "Content-Security-Policy": CSP, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    const end = (code, text) => { res.writeHead(code, headers("text/plain; charset=utf-8")); res.end(text); };
    const port = server.address() && server.address().port;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `${host}:${port}`]);
    if (!allowed.has(String(req.headers.host || "").toLowerCase())) return end(403, "forbidden host");
    if (req.method !== "GET" && req.method !== "HEAD") { res.setHeader("Allow", "GET, HEAD"); return end(405, "method not allowed"); }
    const pathname = String(req.url || "").split("?")[0];
    const f = Object.prototype.hasOwnProperty.call(files, pathname) ? files[pathname] : null;
    if (!f) return end(404, "not found");
    res.writeHead(200, headers(f.type));
    res.end(req.method === "HEAD" ? undefined : f.body);
  });
  return server;
}

module.exports = { createServer, CSP };

if (require.main === module) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8745);
  let server;
  try { server = createServer({ host }); } catch (e) { console.error(`REFUSING TO START: ${e.message}`); process.exit(2); }
  server.listen(port, host, () => console.log(`Base LOKOVault signing page: http://${host}:${port}  (Ctrl-C to stop)`));
}
