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
const LOG_PATH = path.join(ROOT, "test", ".tmp", "smoke-server.log");

// Sleep that wakes early when the server exits; its timer is always cleared.
function sleepOrExit(ms, exitP) {
  let t;
  return Promise.race([new Promise((r) => { t = setTimeout(r, ms); }), exitP]).finally(() => clearTimeout(t));
}

// Resolves true when the url answers, false on timeout, and the EXITED marker
// as soon as the server process has died (no point polling a dead server).
const EXITED = Symbol("exited");
async function waitFor(url, ms, perRequestMs = 3000, exitP = new Promise(() => {})) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await Promise.race([fetch(url, { signal: AbortSignal.timeout(perRequestMs) }), exitP.then(() => EXITED)]);
      if (r === EXITED) return EXITED;
      if (r.ok) return true;
    } catch {}
    if ((await sleepOrExit(1000, exitP)) === EXITED) return EXITED;
  }
  return false;
}

// Build the failure message for a server that died before the run finished.
function earlyExitMessage(info) {
  let text = "";
  try { text = fs.readFileSync(LOG_PATH, "utf8"); } catch {}
  if (/settings\.json is missing/.test(text)) {
    return `settings.json missing: copy settings.example.json to settings.json and fill it in (or pass --data-dir); server log: ${LOG_PATH}`;
  }
  const tail = text.split("\n").slice(-20).join("\n").slice(-2048);
  const what = info.error ? `error=${info.error.message}` : `code=${info.code} signal=${info.signal}`;
  return `server exited before answering (${what})\n--- tail of ${LOG_PATH} ---\n${tail}`;
}

async function main() {
  if (!fs.existsSync(CHROME)) {
    console.error(`smoke: Chrome not found at ${CHROME}; set CHROME=<path>`);
    process.exit(1);
  }
  fs.mkdirSync(path.join(ROOT, "test", ".tmp"), { recursive: true });
  const log = fs.openSync(LOG_PATH, "w");
  const server = spawn(process.execPath, ["server.js", `--port=${PORT}`], { cwd: ROOT, stdio: ["ignore", log, log], env: { ...process.env, TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: "" } });
  let exited = null;
  let onExit, onError;
  const exitP = new Promise((resolve) => {
    onExit = (code, signal) => { exited = { code, signal }; resolve(EXITED); };
    onError = (error) => { exited = { error }; resolve(EXITED); };
    server.once("exit", onExit);
    server.once("error", onError);
  });
  let failed = 0;
  try {
    const base = `http://127.0.0.1:${PORT}`;
    const up = await waitFor(`${base}/api/positions`, 360000, 3000, exitP);
    if (up === EXITED) throw new Error(earlyExitMessage(exited));
    if (!up) throw new Error("server did not answer /api/positions within 6 min (see test/.tmp/smoke-server.log)");
    // Warm the views the Analytics page fetches: the collect history prices its
    // events through the RPC on a cold server, which can take minutes and would
    // otherwise outlast the per-page Chrome limit below.
    // The Wallet page also fetches the approval audit on load (it scans the chain
    // for every operator the wallets ever approved), which is minutes on a cold server.
    for (const warm of ["/api/history", "/api/strategy/lots", "/api/approvals"]) {
      const ok = await waitFor(`${base}${warm}`, 300000, 240000, exitP);
      if (ok === EXITED) throw new Error(earlyExitMessage(exited));
      if (!ok) console.error(`smoke: ${warm} did not answer within 5 min; continuing`);
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
    server.off("exit", onExit);
    server.off("error", onError);
    if (server.exitCode == null && server.signalCode == null) {
      server.kill("SIGTERM");
      await sleep(500);
      if (server.exitCode == null && server.signalCode == null) server.kill("SIGKILL");
    }
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
