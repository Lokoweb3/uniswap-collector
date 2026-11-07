// node test/collector-golden.test.js -- the Robinhood collector must not change when the Base pass is added.
//
// Fixtures in test/fixtures/collector-golden/ were captured from the UNMODIFIED code (HEAD 956bb20, before
// Task 3) with GOLDEN_CAPTURE=1 and are asserted byte for byte here:
//   robinhood-simulate.txt   stdout of `collector.js --mode=simulate` against a mocked Robinhood chain (timestamps normalised)
//   run-collector.json       what `run-collector.sh simulate|collect|full|collect --quiet(locked)` executes under a stubbed
//                            node / sync-to-vm.sh, with no Base data dir
//   hashes.json              sha256 of the files Task 3 must not touch
// Then, with a Base data dir present, the Robinhood part of the output and command sequence is an identical prefix and
// the Base pass comes only after it; a failing Base pass changes neither the exit status nor the Robinhood output.
// Nothing here reads the real /dev/shm, ~/.lp-collector, a keystore or .env: the script runs as a copy in a temp tree whose
// /dev/shm path is redirected into that tree, under a temp HOME.
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { hermeticEnv, hermeticCwd, PRELOAD } = require("./lib/hermetic");

const ROOT = path.join(__dirname, "..");
const FIX = path.join(__dirname, "fixtures", "collector-golden");
const CAPTURE = process.env.GOLDEN_CAPTURE === "1";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-golden-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const PROTECTED = ["collector.js", "collector-logic.js", "collector-swap.js", "collect-v4.js", "treasury.js"];
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, f))).digest("hex");
const check = (name, actual) => {
  const file = path.join(FIX, name);
  const text = typeof actual === "string" ? actual : JSON.stringify(actual, null, 2) + "\n";
  if (CAPTURE) { fs.mkdirSync(FIX, { recursive: true }); fs.writeFileSync(file, text); return; }
  assert.strictEqual(text, fs.readFileSync(file, "utf8"), `${name} differs from the capture taken before Task 3`);
};

// ---------------------------------------------------------------------------------------------------------------------
// 1. The Robinhood collector, simulate mode, mocked chain
// ---------------------------------------------------------------------------------------------------------------------
const OWNER = "0x00000000000000000000000000000000000000a1";
const NPM = "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3", QUOTER = "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const IFACE = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)",
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const answer = (to, data) => {
  const d = IFACE.parseTransaction({ data });
  const t = to.toLowerCase();
  const out = (v) => IFACE.encodeFunctionResult(d.fragment, v);
  if (t === NPM.toLowerCase()) {
    if (d.name === "balanceOf") return out([2n]);
    if (d.name === "tokenOfOwnerByIndex") return out([d.args[1] + 7n]); // ids 7 and 8
    if (d.name === "positions") {
      return d.args[0] === 7n
        ? out([0n, ethers.ZeroAddress, WETH, USDG, 3000n, -600n, 600n, 10n ** 18n, 0n, 0n, 0n, 0n])
        : out([0n, ethers.ZeroAddress, WETH, USDG, 3000n, -600n, 600n, 0n, 0n, 0n, 0n, 0n]); // closed
    }
    if (d.name === "collect") return out([3n * 10n ** 15n, 12_500_000n]);
  }
  if (t === QUOTER.toLowerCase()) return out([4n * 10n ** 15n, 0n, 0n, 0n]);
  if (d.name === "symbol") return out([t === WETH.toLowerCase() ? "WETH" : "USDG"]);
  if (d.name === "decimals") return out([t === WETH.toLowerCase() ? 18 : 6]);
  throw new Error(`unmocked ${t}.${d.name}`);
};
function rpcServer() {
  const hex = (n) => "0x" + BigInt(n).toString(16);
  const one = (r) => {
    const reply = (result) => ({ jsonrpc: "2.0", id: r.id, result });
    switch (r.method) {
      case "eth_chainId": return reply(hex(4663));
      case "net_version": return reply("4663");
      case "eth_blockNumber": return reply(hex(1000));
      case "eth_gasPrice": return reply(hex(1_000_000_000));
      case "eth_maxPriorityFeePerGas": return reply(hex(100_000_000));
      case "eth_getBalance": return reply(hex(10n ** 17n));
      case "eth_getCode": return reply("0x6080");
      case "eth_getBlockByNumber": return reply({ number: hex(1000), hash: "0x" + "11".repeat(32), parentHash: "0x" + "00".repeat(32), timestamp: hex(1_700_000_000), nonce: "0x0000000000000000", difficulty: "0x0", gasLimit: hex(30_000_000), gasUsed: "0x0", miner: ethers.ZeroAddress, extraData: "0x", baseFeePerGas: hex(500_000_000), transactions: [] });
      case "eth_call":
        try { return reply(answer(r.params[0].to, r.params[0].data || r.params[0].input)); } catch (e) { return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted", data: "0x" } }; }
      default: return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `no ${r.method}` } };
    }
  };
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let b = ""; req.on("data", (c) => (b += c));
      req.on("end", () => { const j = JSON.parse(b); res.setHeader("content-type", "application/json"); res.end(JSON.stringify(Array.isArray(j) ? j.map(one) : one(j))); });
    }).listen(0, "127.0.0.1", () => resolve(s));
  });
}
const normalise = (s) => s.replace(/\[\d{4}-\d\d-\d\dT[\d:.]+Z\]/g, "[TS]");

async function robinhoodSimulate() {
  const server = await rpcServer();
  const dir = hermeticCwd();
  const settings = JSON.parse(fs.readFileSync(path.join(ROOT, "settings.example.json"), "utf8"));
  settings.chain.rpcUrl = `http://127.0.0.1:${server.address().port}`;
  settings.wallets.main.address = OWNER; settings.wallets.watched = [];
  settings.collector.sweepDestination = OWNER; settings.collector.v4Collect = { enabled: false };
  settings.contracts.v4 = undefined; settings.contracts.slipstream = [];
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings));
  const env = hermeticEnv({ LP_DATA_DIR: dir, NODE_OPTIONS: `--require "${PRELOAD}" --require "${path.join(__dirname, "fixtures", "golden-preload.js")}"` });
  const child = spawn(process.execPath, [path.join(ROOT, "collector.js"), "--mode=simulate"], { cwd: dir, env });
  let out = "", err = "";
  child.stdout.on("data", (c) => (out += c)); child.stderr.on("data", (c) => (err += c));
  const code = await new Promise((res) => child.on("close", res));
  server.close();
  assert.strictEqual(code, 0, `collector.js simulate exited ${code}: ${err}${out}`);
  assert.strictEqual(err, "");
  return normalise(out);
}

// ---------------------------------------------------------------------------------------------------------------------
// 2. run-collector.sh under stubs
// ---------------------------------------------------------------------------------------------------------------------
// The script is copied into a temp tree (its HERE) together with stub collector helpers. Its only hard-wired outside path,
// /dev/shm/.lp-collector-<uid>, is redirected into that tree, so the real unlock cache is never read.
function harness({ baseDir = null, failBase = false, unlocked = true, keystore = true } = {}) {
  const here = fs.mkdtempSync(path.join(TMP, "here-"));
  const bin = path.join(here, "bin");
  fs.mkdirSync(bin);
  const shm = path.join(here, "shm");
  fs.mkdirSync(shm);
  fs.writeFileSync(path.join(here, "run-collector.sh"), fs.readFileSync(path.join(ROOT, "run-collector.sh"), "utf8").split("/dev/shm/").join(shm + "/"), { mode: 0o755 });
  const calls = path.join(here, "calls.jsonl");
  fs.writeFileSync(path.join(bin, "node"), '#!/usr/bin/env bash\nexec "$STUB_REAL_NODE" "$STUB_REC" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(here, "sync-to-vm.sh"), `#!/usr/bin/env bash\necho '"sync-to-vm"' >> "$STUB_CALLS"\n`, { mode: 0o755 });
  const env = hermeticEnv({ STUB_HERE: here, STUB_REAL_NODE: process.execPath, STUB_REC: path.join(__dirname, "fixtures", "stub-node-record.js"), STUB_CALLS: calls, STUB_BASE: baseDir || "/nonexistent-base", PATH: `${bin}:${process.env.PATH}`, ...(failBase ? { STUB_FAIL_BASE: "1" } : {}), ...(baseDir ? { LP_BASE_DATA_DIR: baseDir } : {}) });
  if (keystore) {
    fs.mkdirSync(path.join(env.HOME, ".lp-collector"));
    fs.writeFileSync(path.join(env.HOME, ".lp-collector", "operator-keystore.json"), "{}"); // placeholder only: the stub node never reads it
  }
  if (unlocked) {
    const cache = path.join(shm, `.lp-collector-${process.getuid()}`);
    fs.writeFileSync(cache, "throwaway-passphrase"); fs.writeFileSync(cache + ".ttl", String(Math.floor(Date.now() / 1000) + 3600));
  }
  return { here, env, calls };
}
function run(h, args) {
  const r = spawnSync("bash", [path.join(h.here, "run-collector.sh"), ...args], { env: h.env, cwd: h.here, encoding: "utf8", stdin: "ignore", timeout: 60000 });
  const calls = fs.existsSync(h.calls) ? fs.readFileSync(h.calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const norm = (s) => s.split(h.here).join("$HERE").replace(/\d{4}-\d\d-\d\dT[\d:+\-Z]+/g, "<ISO>");
  const logFile = path.join(h.here, "collector.log");
  return { status: r.status, stdout: norm(r.stdout), stderr: norm(r.stderr), calls, log: fs.existsSync(logFile) ? norm(fs.readFileSync(logFile, "utf8")) : "" };
}
const CASES = [["simulate", ["simulate"]], ["collect", ["collect"]], ["full", ["full"]], ["full-compound", ["full", "--compound"]], ["locked-quiet", ["collect", "--quiet"], { unlocked: false }], ["usage", ["bogus"]]];

(async () => {
  // 0. files Task 3 must not touch
  const hashes = Object.fromEntries(PROTECTED.map((f) => [f, sha(f)]));
  check("hashes.json", hashes);

  // 1. Robinhood collector output
  const first = await robinhoodSimulate();
  assert.ok(/=== mode=simulate chainId=4663 ===/.test(first) && /#7 WETH\/USDG/.test(first) && /=== done ===/.test(first), first);
  check("robinhood-simulate.txt", first);
  assert.strictEqual(await robinhoodSimulate(), first, "the capture is deterministic");

  // 2. run-collector.sh, no Base data dir
  const golden = {};
  for (const [name, args, opt] of CASES) golden[name] = run(harness(opt || {}), args);
  check("run-collector.json", golden);
  for (const [name, args, opt] of CASES) assert.deepStrictEqual(run(harness(opt || {}), args), golden[name], `${name} is deterministic`);
  assert.ok(golden.collect.calls.some((c) => c.pass === "set"), "the stub saw a passphrase for collect");
  assert.ok(golden["locked-quiet"].stdout.includes("locked, skipping collect run"), golden["locked-quiet"].stdout);
  assert.ok(!JSON.stringify(golden).includes("collector-base"), "no Base pass without a Base data dir");

  if (CAPTURE) { console.log("golden fixtures captured"); return; }

  // 3. with a Base data dir: the Robinhood part is an identical prefix, the Base pass comes after it
  const base = fs.mkdtempSync(path.join(TMP, "base-"));
  fs.writeFileSync(path.join(base, "settings.json"), "{}");
  for (const [name, args, opt] of CASES) {
    const g = golden[name], w = run(harness({ ...(opt || {}), baseDir: base }), args);
    assert.strictEqual(w.status, g.status, `${name}: exit status`);
    assert.ok(w.stdout.startsWith(g.stdout), `${name}: Robinhood stdout is a byte-identical prefix\n${w.stdout}`);
    const isBase = (c) => typeof c !== "string" && c.argv.some((a) => a.endsWith("collector-base.js"));
    const baseCalls = w.calls.filter(isBase);
    assert.deepStrictEqual(w.calls.filter((c) => !isBase(c)), g.calls, `${name}: the Robinhood commands are unchanged`);
    const expectBase = name.startsWith("locked") || name === "usage" ? 0 : 1;
    assert.strictEqual(baseCalls.length, expectBase, `${name}: Base pass count`);
    if (expectBase) {
      const mode = name === "simulate" ? "simulate" : "collect";
      assert.deepStrictEqual(baseCalls[0].argv, ["$HERE/collector-base.js", `--mode=${mode}`]);
      assert.strictEqual(baseCalls[0].dataDir, "$BASE", "the Base pass runs on the Base data dir");
      const rh = w.calls.findIndex((c) => typeof c !== "string" && c.argv.some((a) => a.endsWith("collector.js")));
      assert.ok(rh >= 0 && w.calls.indexOf(baseCalls[0]) > rh, "the Base pass comes after the Robinhood call");
      if (mode === "collect") assert.deepStrictEqual([baseCalls[0].pass, baseCalls[0].keystorePath], ["set", "$HOME/.lp-collector/operator-keystore.json"]);
      else assert.strictEqual(baseCalls[0].pass, "unset", "simulate gets no passphrase");
    }
    // 12. a failing Base pass changes neither the exit status nor the Robinhood output
    if (expectBase) {
      const f = run(harness({ ...(opt || {}), baseDir: base, failBase: true }), args);
      assert.strictEqual(f.status, g.status, `${name}: a failing Base pass keeps the exit status`);
      assert.ok(f.stdout.startsWith(g.stdout), `${name}: Robinhood output unchanged by a failing Base pass`);
      assert.ok(/base pass failed/.test(f.stdout + f.stderr), `${name}: the failure is reported\n${f.stdout}${f.stderr}`);
    }
  }

  // 12. locked + --quiet: the same "locked, skipping" line, Base pass never starts (calls identical to the golden ones)
  {
    const w = run(harness({ unlocked: false, baseDir: base }), ["full", "--quiet"]);
    assert.ok(/locked, skipping full run/.test(w.stdout));
    assert.ok(!JSON.stringify(w.calls).includes("collector-base"), "locked: no Base pass");
  }

  // the Arc wrapper sets LP_DATA_DIR: that run must not start a Base pass
  {
    const h = harness({ baseDir: base });
    h.env.LP_DATA_DIR = path.join(TMP, "arc-data");
    for (const args of [["collect"], ["simulate"]]) {
      const w = run(h, args);
      assert.ok(!JSON.stringify(w.calls).includes("collector-base"), `${args[0]}: no Base pass on another chain's data dir`);
    }
  }

  // 12. bash -n
  assert.strictEqual(spawnSync("bash", ["-n", path.join(ROOT, "run-collector.sh")]).status, 0, "bash -n run-collector.sh");

  // 11. hashes recorded from the unmodified code
  const recorded = JSON.parse(fs.readFileSync(path.join(FIX, "hashes.json"), "utf8"));
  assert.deepStrictEqual(hashes, recorded, "collector.js, collector-logic.js, collector-swap.js, collect-v4.js and treasury.js are byte-identical to HEAD 956bb20");
  console.log("collector-golden: Robinhood collector and run-collector.sh unchanged; Base pass is a suffix");
})().catch((e) => { console.error(e); process.exit(1); });
