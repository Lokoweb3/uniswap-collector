// Starts the Base example server (settings.base.example.json + a mutation, LP_READONLY=1, --no-loops --no-services,
// an ephemeral port, hermetic env, stub-base-network.js with optional Uniswap v4 NFTs) and stops it by PID.
// For test/v4-pinned.test.js and test/v4-warnings.test.js. No real network, no real data dir.
"use strict";
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { hermeticEnv, hermeticCwd, PRELOAD } = require("./hermetic");

const ROOT = path.join(__dirname, "..", "..");
const LIVE_PORTS = [8787, 8788, 8790, 8791, 8794, 8796, 8797, 8800, 3847];
const freePort = () => new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const request = (port, p) => new Promise((resolve) => {
  const h = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
  const r = http.request({ host: "127.0.0.1", port, path: p, headers: h, timeout: 30000 }, (res) => {
    let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  r.on("timeout", () => { r.destroy(); resolve({ status: 0, body: "" }); }); r.on("error", () => resolve({ status: 0, body: "" }));
  r.end();
});

/**
 * opts.mutate(settings)  edits the parsed Base example before it is written
 * opts.state             object written to <dir>/v4-positions.json (the main wallet's discovery state)
 * opts.files            { name: object } more JSON files written to <dir> (a watched wallet's discovery state)
 * opts.rawDiscoveryError  raw text every discovery reports as status.error (a state file's lastError that was never redacted)
 * opts.stubV4            STUB_V4 (see stub-base-network.js); opts.logsFail: eth_getLogs refuses; opts.logsError: getLogs throws this text
 * returns { port, dir, get(path), stop(), dataFile(name), calls(), editSettings(fn), writeRaw(text) }
 */
async function start(opts = {}) {
  const port = await freePort();
  if (LIVE_PORTS.includes(port)) throw new Error("ephemeral port collided with a live service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-v4-"));
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "settings.base.example.json"), "utf8"));
  if (opts.mutate) opts.mutate(settings);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  if (opts.state) fs.writeFileSync(path.join(dir, "v4-positions.json"), JSON.stringify(opts.state));
  for (const [n, o] of Object.entries(opts.files || {})) fs.writeFileSync(path.join(dir, n), JSON.stringify(o));
  const extra = { LP_DATA_DIR: "", LP_READONLY: "1", HOME: dir, LP_BIND: "127.0.0.1" };
  if (opts.stubV4) extra.STUB_V4 = JSON.stringify(opts.stubV4);
  if (opts.logsFail) extra.STUB_LOGS_FAIL = "1";
  if (opts.callLog) extra.STUB_LOG = path.join(dir, "stub-calls.jsonl"); // v4 calls: { kind: "v4", name, id }
  if (opts.rawDiscoveryError) extra.STUB_RAW_DISC_ERR = opts.rawDiscoveryError; // every discovery's status.error reads as this raw text (see the fixture)
  if (opts.logsError) extra.STUB_LOGS_ERR = opts.logsError; // getLogs throws a plain Error with this text
  const out = [];
  const child = spawn(process.execPath, ["--require", PRELOAD, "--require", path.join(__dirname, "..", "fixtures", "stub-base-network.js"), ...(opts.rawDiscoveryError ? ["--require", path.join(__dirname, "..", "fixtures", "stub-raw-discovery-error.js")] : []), path.join(ROOT, "server.js"), `--data-dir=${dir}`, `--port=${port}`, "--no-loops", "--no-services"], {
    cwd: hermeticCwd(), env: hermeticEnv(extra),
  });
  child.stdout.on("data", (d) => out.push(String(d))); child.stderr.on("data", (d) => out.push(String(d)));
  const stop = () => new Promise((resolve) => {
    if (child.exitCode != null) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } return resolve(); }
    child.once("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } resolve(); });
    child.kill();
  });
  const t0 = Date.now();
  while (!out.join("").includes("Dashboard running")) {
    if (child.exitCode != null) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
      throw new Error(`server exited early: ${out.join("").slice(-400)}`);
    }
    if (Date.now() - t0 > 40000) { await stop(); throw new Error("server did not start"); }
    await new Promise((r) => setTimeout(r, 100));
  }
  const sfile = path.join(dir, "settings.json");
  let tick = Date.now() / 1000;
  const writeRaw = (text) => { fs.writeFileSync(sfile, text); tick += 5; fs.utimesSync(sfile, tick, tick); }; // a new mtime: the server's settings cache is mtime-keyed
  const editSettings = (fn) => { const o = JSON.parse(fs.readFileSync(sfile, "utf8")); fn(o); writeRaw(JSON.stringify(o)); };
  return { port, dir, writeRaw, editSettings, get: (p) => request(port, p), stop, log: () => out.join(""), dataFile: (n) => path.join(dir, n), calls: () => { try { return fs.readFileSync(path.join(dir, "stub-calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } } };
}

module.exports = { start, LIVE_PORTS };
