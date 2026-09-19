#!/usr/bin/env node
/**
 * Headless smoke test: start the dashboard server on a spare port, load every
 * page in headless Chrome, and fail on console errors or missing markup.
 *
 *   npm run smoke          (or: node test/smoke.js)
 *
 * Needs Windows Chrome reachable from WSL (the path below) — the Linux
 * chromium on this machine is a snap stub. No .env is loaded: alerts stay
 * off, which is what we want in a test. Ledgers may be absent; the pages
 * must still render their skeleton without throwing.
 */
"use strict";
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = Number(process.env.SMOKE_PORT || 8799);
const ROOT = path.join(__dirname, "..");
const { CHROME, PAGES, loadPage } = require("./smoke-lib");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, ms, perRequestMs = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(perRequestMs) });
      if (r.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`smoke: Chrome not found at ${CHROME}; set CHROME=<path>`);
    process.exit(1);
  }
  fs.mkdirSync(path.join(ROOT, "test", ".tmp"), { recursive: true });
  const log = fs.openSync(path.join(ROOT, "test", ".tmp", "smoke-server.log"), "w");
  const server = spawn(process.execPath, ["server.js", `--port=${PORT}`], { cwd: ROOT, stdio: ["ignore", log, log], env: { ...process.env, TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: "" } });
  let failed = 0;
  try {
    const base = `http://127.0.0.1:${PORT}`;
    if (!(await waitFor(`${base}/api/positions`, 360000))) {
      console.error("smoke: server did not answer /api/positions within 6 min (see test/.tmp/smoke-server.log)");
      process.exit(1);
    }
    // Warm the views the Analytics page fetches: the collect history prices its
    // events through the RPC on a cold server, which can take minutes and would
    // otherwise outlast the per-page Chrome limit below.
    // The Wallet page also fetches the approval audit on load (it scans the chain
    // for every operator the wallets ever approved), which is minutes on a cold server.
    for (const warm of ["/api/history", "/api/strategy/lots", "/api/approvals"]) {
      if (!(await waitFor(`${base}${warm}`, 300000, 240000))) console.error(`smoke: ${warm} did not answer within 5 min; continuing`);
    }
    // Every page at desktop width and at a 375 px phone width: same markers, no console errors.
    for (const width of [1280, 375]) for (const p of PAGES) {
      let { dom, errors, status } = loadPage(base + p.path, width);
      // A slow RPC moment can time a page out; one retry separates that from a real failure.
      if (status !== 0 || !dom.includes(p.marker) || errors.length) ({ dom, errors, status } = loadPage(base + p.path, width));
      const problems = [];
      if (status !== 0) problems.push(`chrome exited ${status}`);
      if (!dom.includes(p.marker)) problems.push(`marker ${p.marker} missing`);
      for (const m of p.markers || []) if (!dom.includes(m)) problems.push(`marker ${m} missing`);
      for (const e of errors) problems.push(e.trim().slice(0, 200));
      if (problems.length) {
        failed++;
        console.log(`FAIL ${p.path} @${width}px\n  ${problems.join("\n  ")}`);
      } else {
        console.log(`ok   ${p.path} @${width}px (${dom.length} bytes)`);
      }
    }
    // The split assets must be served with the right types.
    for (const [file, type] of [["/dashboard.css", "text/css"], ["/dashboard.js", "application/javascript"], ["/insights-view.js", "application/javascript"]]) {
      // The page loop above aborts its own requests on a timeout, which can leave a
      // socket in undici's pool that looks reusable and is not: the next request on
      // it fails with UND_ERR_SOCKET before reaching the server. That is a client
      // artefact, not a fault in what is being tested, so one retry on a socket
      // error distinguishes it from a real failure, which fails again.
      let r;
      try { r = await fetch(base + file); }
      catch (e) {
        if (!e.cause || e.cause.code !== "UND_ERR_SOCKET") throw e;
        r = await fetch(base + file);
      }
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.startsWith(type)) {
        failed++;
        console.log(`FAIL ${file}: HTTP ${r.status} ${ct}`);
      } else console.log(`ok   ${file} (${ct})`);
    }
  } finally {
    server.kill("SIGTERM");
    await sleep(500);
    if (server.exitCode == null) server.kill("SIGKILL");
    fs.closeSync(log);
  }
  if (failed) {
    console.error(`smoke: ${failed} failure(s)`);
    process.exit(1);
  }
  console.log("smoke: all pages load without console errors");
}

main().catch((e) => {
  console.error("smoke:", e.message);
  process.exit(1);
});
