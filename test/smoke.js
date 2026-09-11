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
const CHROME = process.env.CHROME || "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
const PAGES = [
  { path: "/", marker: 'id="summary"' },
  { path: "/analytics", marker: 'id="perfsec"' },
  { path: "/wallet", marker: 'id="sec-arm"' },
  { path: "/wallet#vault", marker: 'id="sec-vault"' },
  { path: "/wallet#sell", marker: 'id="sec-sell"' },
];
// Console lines that are noise, not errors.
const IGNORE = [/Password field is not contained in a form/i, /DevTools listening/i, /Fontconfig/i];

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

function loadPage(url, width = 1280) {
  const r = spawnSync(
    CHROME,
    ["--headless=new", "--disable-gpu", "--enable-logging=stderr", "--v=0", "--virtual-time-budget=20000", `--window-size=${width},${width < 600 ? 812 : 900}`, "--dump-dom", url],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 90000 }
  );
  const dom = r.stdout || "";
  const consoleLines = (r.stderr || "")
    .split("\n")
    .filter((l) => /CONSOLE|Uncaught/.test(l))
    .filter((l) => !IGNORE.some((re) => re.test(l)));
  const errors = consoleLines.filter((l) => /Uncaught|TypeError|ReferenceError|SyntaxError|:ERROR:|"error/i.test(l) || /CONSOLE\(\d+\)\] "?(Failed to load|Refused)/.test(l));
  return { dom, errors, consoleLines, status: r.status };
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
    for (const warm of ["/api/history", "/api/strategy/lots"]) {
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
      for (const e of errors) problems.push(e.trim().slice(0, 200));
      if (problems.length) {
        failed++;
        console.log(`FAIL ${p.path} @${width}px\n  ${problems.join("\n  ")}`);
      } else {
        console.log(`ok   ${p.path} @${width}px (${dom.length} bytes)`);
      }
    }
    // The split assets must be served with the right types.
    for (const [file, type] of [["/dashboard.css", "text/css"], ["/dashboard.js", "application/javascript"]]) {
      const r = await fetch(base + file);
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
