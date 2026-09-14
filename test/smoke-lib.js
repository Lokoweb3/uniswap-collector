"use strict";
/**
 * test/smoke-lib.js — the dashboard's page list and the headless-Chrome capture, shared by
 * the smoke test (test/smoke.js) and the dashboard review task (tasks/dashboard-review.js).
 *
 * Needs Windows Chrome reachable from WSL (CHROME below) — the Linux chromium on this
 * machine is a snap stub.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");

const CHROME = process.env.CHROME || "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
const PAGES = [
  { path: "/", marker: 'id="summary"', markers: ["Fee APR", "Net return"] },
  { path: "/analytics", marker: 'id="perfsec"' },
  { path: "/wallet", marker: 'id="sec-arm"' },
  { path: "/wallet#vault", marker: 'id="sec-vault"' },
  { path: "/wallet#sell", marker: 'id="sec-sell"' },
  { path: "/wallet#mint", marker: 'id="sec-mint"' },
];
// Console lines that are noise, not errors.
const IGNORE = [/Password field is not contained in a form/i, /DevTools listening/i, /Fontconfig/i];

const chromeArgs = (width, extra, url) => ["--headless=new", "--disable-gpu", "--enable-logging=stderr", "--v=0", "--virtual-time-budget=20000", `--window-size=${width},${width < 600 ? 812 : 900}`, ...extra, url];

/**
 * Load one page at a width: the rendered DOM, the console lines and the ones that count as
 * errors. With `screenshot: "<path>.png"` a second Chrome run writes the picture (Chrome does
 * not combine --dump-dom and --screenshot in one run); `screenshotOk` says whether it landed.
 */
function loadPage(url, width = 1280, { screenshot = null } = {}) {
  const r = spawnSync(CHROME, chromeArgs(width, ["--dump-dom"], url), { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 90000 });
  const dom = r.stdout || "";
  const consoleLines = (r.stderr || "")
    .split("\n")
    .filter((l) => /CONSOLE|Uncaught/.test(l))
    .filter((l) => !IGNORE.some((re) => re.test(l)));
  const errors = consoleLines.filter((l) => /Uncaught|TypeError|ReferenceError|SyntaxError|:ERROR:|"error/i.test(l) || /CONSOLE\(\d+\)\] "?(Failed to load|Refused)/.test(l));
  let screenshotOk = null;
  if (screenshot) {
    // Chrome runs on the Windows side, so it needs a Windows path: <drive>:\ for /mnt/<drive>/…,
    // else the distro's UNC share (\\wsl.localhost\<distro>\…). Both were verified to land the file.
    const target = /^\/mnt\/[a-z]\//.test(screenshot)
      ? screenshot.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\")
      : `\\\\wsl.localhost\\${process.env.WSL_DISTRO_NAME || "Ubuntu"}${screenshot.replace(/\//g, "\\")}`;
    const s = spawnSync(CHROME, chromeArgs(width, [`--screenshot=${target}`, "--hide-scrollbars"], url), { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 90000 });
    screenshotOk = s.status === 0 && fs.existsSync(screenshot);
  }
  return { dom, errors, consoleLines, status: r.status, screenshotOk };
}

module.exports = { CHROME, PAGES, IGNORE, loadPage };
