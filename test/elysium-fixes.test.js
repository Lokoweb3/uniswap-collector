// node test/elysium-fixes.test.js -- the review fixes for the Elysium testnet branch: a testnet is always no-tx, its
// RPC must be the chain it names, banner injection is literal, orbit-fees input checks, verify output sanitising.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");
const { hermeticEnv, hermeticCwd, PRELOAD } = require("./lib/hermetic");
const ely = require("../elysium-chains");
const orbit = require("../orbit-fees");

const ROOT = path.join(__dirname, "..");
const STUB = path.join(__dirname, "fixtures", "stub-elysium-network.js");
const WRONG = path.join(__dirname, "fixtures", "stub-wrong-chain.js");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-elyfix-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });
const STRICT = new Set([8453, 369, 99801]);

(async () => {
  // ---- L1: NO_TX is forced -------------------------------------------------------------------------------
  assert.strictEqual(ely.resolveNoTx({ chainId: 99801, testnet: true }, STRICT), true);
  assert.strictEqual(ely.resolveNoTx({ chainId: 99801, testnet: true, noTransactionData: true }, STRICT), true);
  assert.strictEqual(ely.resolveNoTx({ chainId: 12345, testnet: true }, new Set()), true, "any testnet");
  assert.strictEqual(ely.resolveNoTx({ chainId: 99801 }, new Set()), true, "chain 99801 even without the flag or strict list");
  assert.throws(() => ely.resolveNoTx({ chainId: 99801, testnet: true, noTransactionData: false }, STRICT), /not allowed/);
  assert.throws(() => ely.resolveNoTx({ chainId: 12345, testnet: true, noTransactionData: false }, STRICT), /not allowed/);
  assert.throws(() => ely.resolveNoTx({ chainId: 99801, noTransactionData: false }, STRICT), /not allowed/);
  // unchanged elsewhere
  assert.strictEqual(ely.resolveNoTx({ chainId: 4663 }, STRICT), false);
  assert.strictEqual(ely.resolveNoTx({ chainId: 4663, noTransactionData: true }, STRICT), true);
  assert.strictEqual(ely.resolveNoTx({ chainId: 8453 }, STRICT), true);
  assert.strictEqual(ely.resolveNoTx({ chainId: 8453, noTransactionData: false }, STRICT), false, "a non-testnet strict chain keeps its explicit setting");

  const example = JSON.parse(fs.readFileSync(path.join(ROOT, "settings.elysium-testnet.example.json"), "utf8"));
  const mkDir = (mut) => { const d = fs.mkdtempSync(path.join(TMP, "inst-")); const o = JSON.parse(JSON.stringify(example)); mut(o); fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(o)); return d; };
  let n = 0;
  const server = (dir, preloads) => spawnSync(process.execPath, ["--require", PRELOAD, ...preloads.flatMap((p) => ["--require", p]), path.join(ROOT, "server.js"),
    `--data-dir=${dir}`, `--port=${18700 + (n++)}`, "--no-loops", "--no-services"], { cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: "", LP_READONLY: "1", HOME: dir, LP_BIND: "127.0.0.1" }), encoding: "utf8", timeout: 30000 });

  const refusedNoTx = server(mkDir((o) => { o.noTransactionData = false; }), [STUB]);
  assert.strictEqual(refusedNoTx.status, 1, "server.js refuses noTransactionData:false on the testnet");
  assert.ok(/Refusing to start: noTransactionData: false is not allowed/.test(refusedNoTx.stderr), refusedNoTx.stderr);

  // ---- I1: the primary RPC must be the named chain ---------------------------------------------------------
  const calls = [];
  const stub = (id) => async (url) => { calls.push(url); return id; };
  const cfg = { testnet: true, chainId: 99801, rpcUrl: "https://rpc.invalid" };
  assert.strictEqual(await ely.assertRpcChain(cfg, stub(99801)), 99801);
  assert.deepStrictEqual(calls, ["https://rpc.invalid"], "asks the primary RPC");
  await assert.rejects(ely.assertRpcChain(cfg, stub(1)), /answers chain id 1, settings say 99801/);
  assert.strictEqual(await ely.assertRpcChain(cfg, stub(null)), null, "an unreachable RPC does not block (the instance shows itself down)");
  assert.strictEqual(await ely.assertRpcChain({ chainId: 4663, rpcUrl: "x" }, async () => { throw new Error("must not be asked"); }), null, "non-testnet: not checked");

  // ---- I1 follow-up: fallback endpoints, and the re-check of an unreachable primary ---------------------------
  {
    const by = (map) => async (url) => (url in map ? map[url] : null);
    const withFb = { testnet: true, chainId: 99801, rpcUrl: "https://p.invalid", rpcUrls: ["https://p.invalid", "https://f1.invalid/KEY123", "https://f2.invalid"] };
    assert.strictEqual(await ely.assertRpcChain(withFb, by({ "https://p.invalid": 99801, "https://f1.invalid/KEY123": 99801, "https://f2.invalid": null })), 99801, "matching and unreachable fallbacks pass");
    await assert.rejects(ely.assertRpcChain(withFb, by({ "https://p.invalid": 99801, "https://f1.invalid/KEY123": 1 })), (e) => /fallback RPC #1 answers chain id 1, settings say 99801/.test(e.message) && !/KEY123/.test(e.message), "a mismatching fallback refuses the start, without naming its URL");
    await assert.rejects(ely.assertRpcChain(withFb, by({ "https://p.invalid": null, "https://f2.invalid": 7 })), /fallback RPC #2 answers chain id 7/, "even when the primary is unreachable");
    const asked = []; await ely.assertRpcChain(withFb, async (u) => { asked.push(u); return 99801; });
    assert.deepStrictEqual(asked, ["https://p.invalid", "https://f1.invalid/KEY123", "https://f2.invalid"], "the primary is not asked twice");

    // watchRpcChain: unref'd; keeps asking while unreachable; verified on a match; mismatch reported
    const run = (answers) => new Promise((resolve) => {
      let i = 0; const asks = [];
      const t = ely.watchRpcChain({ testnet: true, chainId: 99801, rpcUrl: "x" }, async () => { asks.push(1); return answers[Math.min(i++, answers.length - 1)]; }, {
        intervalMs: 5, onVerified: () => resolve({ ok: "verified", asks: asks.length }), onMismatch: (e) => resolve({ ok: "mismatch", asks: asks.length, msg: e.message }),
      });
      assert.strictEqual(t.hasRef(), false, "the timer is unref'd");
    });
    const keepAlive = setTimeout(() => {}, 5000); // unref'd timers do not hold the loop open on their own
    const v = await run([null, null, 99801]);
    assert.deepStrictEqual(v, { ok: "verified", asks: 3 }, "asks until an answer arrives, then clears the flag");
    const m = await run([null, 1]);
    assert.strictEqual(m.ok, "mismatch"); assert.ok(/answers chain id 1, settings say 99801/.test(m.msg));
    clearTimeout(keepAlive);
    assert.ok(ely.bannerHtml("N", 99801, true).includes("NOT VERIFIED") && !ely.bannerHtml("N", 99801).includes("NOT VERIFIED"), "the banner says so only when unverified");
  }

  const mismatch = server(mkDir(() => {}), [STUB, WRONG]);
  assert.strictEqual(mismatch.status, 1, "server.js refuses to start when the RPC is another chain");
  assert.ok(/Refusing to start: the primary RPC answers chain id 1/.test(mismatch.stderr), mismatch.stderr);

  // ---- I2: banner injection is literal ---------------------------------------------------------------------
  const html = ely.injectBanner("<html><body>x</body></html>", "Odd $& $` $' $1 name", 99801);
  assert.ok(html.includes("Odd $&amp; $` $&#39; $1 name") || html.includes("Odd $&amp; $` $' $1 name"), html);
  assert.strictEqual((html.match(/<\/body>/g) || []).length, 1, "the pattern did not expand to a second </body> or copy of the page");
  assert.ok(html.endsWith("</body></html>") && html.indexOf("lp-testnet-banner") < html.indexOf("</body>"));
  assert.ok(ely.injectBanner("no body tag", "T", 1).includes("lp-testnet-banner"));

  // ---- I4: orbit-fees input checks -------------------------------------------------------------------------
  const prov = { send: async () => { throw new Error("must not be called"); } };
  const to = "0x" + "22".repeat(20);
  for (const data of ["zz", "0x1", "0xzz", 5, "0x12 34", null]) await assert.rejects(orbit.estimateGas(prov, { to, data }), /data. is not hex/, String(data));
  await assert.rejects(orbit.estimateGas(prov, { to, data: "0x", value: -1n }), /negative/);
  await assert.rejects(orbit.estimateGas(prov, { to, data: "0x", value: "-5" }), /negative/);
  await assert.rejects(orbit.estimateGas(prov, { to, data: "0x", value: "abc" }), /not an integer/);
  const ok = await orbit.estimateGas({ send: async (m) => (m === "eth_call" ? "0x" : "0x5208") }, { to, data: "0x1234", value: 0n });
  assert.strictEqual(ok.raw, 21000n); assert.strictEqual(ok.source, "eth_estimateGas");

  // ---- verify-elysium: a hostile eth_chainId is never echoed -------------------------------------------------
  {
    const hostile = "0x185d9\u001b[31m<script>";
    ethers.FetchRequest.registerGetUrl(async (req) => {
      const b = JSON.parse(Buffer.from(req.body || new Uint8Array()).toString("utf8"));
      const one = (r) => ({ jsonrpc: "2.0", id: r.id, result: r.method === "eth_chainId" ? hostile : "0x1" });
      const out = Array.isArray(b) ? b.map(one) : one(b);
      return { statusCode: 200, statusMessage: "OK", headers: { "content-type": "application/json" }, body: Uint8Array.from(Buffer.from(JSON.stringify(out))) };
    });
    const lines = [];
    process.env.ELYSIUM_TESTNET_RPC = "https://testnet-rpc.elysium.kinetiq.xyz";
    const code = await require("../tools/verify-elysium").run("elysium-testnet", { log: (l) => lines.push(l) });
    assert.strictEqual(code, 1, "a wrong id fails");
    const joined = lines.join("\n");
    assert.ok(/FAIL\s+eth_chainId <not a hex quantity>/.test(joined), joined);
    assert.ok(!joined.includes("<script>") && !joined.includes("\u001b"), "the remote string never reaches the output");
  }

  // ---- nit: the by-hand message is flagged so pages show it without a "Could not switch network:" prefix ----------
  {
    const wc = require("../wallet-chain");
    const eth = { request: async () => { throw Object.assign(new Error("x"), { code: 4902 }); } };
    await assert.rejects(wc.switchOrAdd(eth, { chainId: 99801, chainName: "Elysium Testnet", rpc: "https://r", nativeSymbol: "HYPE" }), (e) => e.manual === true && /Add it by hand/.test(e.message));
    const html = fs.readFileSync(path.join(ROOT, "wallet.html"), "utf8");
    assert.strictEqual((html.match(/e && e\.manual \? /g) || []).length, 2, "both pages show a by-hand message as is");
  }

  console.log("elysium fixes: no-tx forced, RPC chain checked, banner literal, orbit-fees inputs, verify output sanitised");
  process.exit(0); // the verify tool's provider keeps retrying its network detection against the hostile stub
})().catch((e) => { console.error(e); process.exit(1); });
