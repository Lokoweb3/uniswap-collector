// node test/elysium-testnet.test.js -- the Elysium Testnet instance as a whole, no network and no real port or process:
// the registry (testnet enabled, mainnet hard-disabled), the example settings, the wallet add/switch flow, explorer
// links, the router and its picker, start-all.sh / stop-all.sh under a stub harness, a read-only server answered from
// memory, tools/verify-onchain.js elysium-testnet, the README and repo hygiene.
// LIVE checks run only with LP_LIVE_TESTS=1.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { hermeticEnv, hermeticCwd, PRELOAD } = require("./lib/hermetic");

const ROOT = path.join(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-ely-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });
const EXAMPLE_FILE = path.join(ROOT, "settings.elysium-testnet.example.json");
const example = fs.readFileSync(EXAMPLE_FILE, "utf8");
const STUB = path.join(__dirname, "fixtures", "stub-elysium-network.js");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const settings = require("../settings");
const chains = require("../elysium-chains");
const links = require("../explorer-links");
const walletChain = require("../wallet-chain");

const freePort = () => new Promise((res) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const request = (port, p, { method = "GET", headers = {} } = {}) => new Promise((resolve) => {
  const r = http.request({ host: "127.0.0.1", port, path: p, method, headers, timeout: 20000 }, (res) => {
    let body = ""; res.on("data", (c) => (body += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  r.on("timeout", () => { r.destroy(); resolve({ status: 0, headers: {}, body: "" }); }); r.on("error", () => resolve({ status: 0, headers: {}, body: "" }));
  r.end();
});
const upstream = (key, port, page) => new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    res.setHeader("Set-Cookie", `csrf=${key}-token; Path=/`);
    if (req.url.startsWith("/api/")) { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify({ chain: key, cookie: req.headers.cookie || "" })); }
    res.setHeader("Content-Type", "text/html"); res.end(page || `<html><body>UPSTREAM-${key}</body></html>`);
  }).listen(port, "127.0.0.1", () => resolve(s));
});
const mkDir = (text = example) => { const d = fs.mkdtempSync(path.join(TMP, "inst-")); fs.writeFileSync(path.join(d, "settings.json"), text); return d; };
/** Start server.js on `dir` under the Elysium stub. */
async function startServer(dir, env = {}, { readonly = true } = {}) {
  const port = await freePort();
  const out = [];
  const child = spawn(process.execPath, ["--require", PRELOAD, "--require", STUB, path.join(ROOT, "server.js"), `--data-dir=${dir}`, `--port=${port}`, "--no-loops", "--no-services"], {
    cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: "", ...(readonly ? { LP_READONLY: "1" } : {}), HOME: dir, LP_BIND: "127.0.0.1", ...env }),
  });
  child.stdout.on("data", (d) => out.push(String(d))); child.stderr.on("data", (d) => out.push(String(d)));
  const t0 = Date.now();
  while (!out.join("").includes("Dashboard running")) {
    if (child.exitCode != null) return { exited: child.exitCode, out };
    if (Date.now() - t0 > 30000) { child.kill(); throw new Error("server did not start"); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { child, out, port, stop: async () => { child.kill("SIGTERM"); await new Promise((r) => child.once("exit", r)); } };
}

(async () => {
  // ---- 1. 2. the registry ---------------------------------------------------------------------------------
  const T = chains.CHAINS["elysium-testnet"], M = chains.CHAINS["elysium-mainnet"];
  assert.strictEqual(T.chainId, 99801); assert.strictEqual(T.chainIdHex, "0x185d9"); assert.strictEqual(0x185d9, 99801);
  assert.strictEqual(T.testnet, true); assert.strictEqual(T.enabled, true); assert.strictEqual(T.name, "Elysium Testnet");
  assert.strictEqual(T.nativeCurrency.symbol, "HYPE");
  assert.strictEqual(T.rpcUrl, "https://testnet-rpc.elysium.kinetiq.xyz");
  assert.strictEqual(T.explorer, "https://elysium.kinetiq.xyz/testnet-explorer");
  assert.strictEqual(T.settlementChainId, 998); assert.notStrictEqual(T.settlementChainId, T.chainId);
  // V3: 18 decimals is NOT independently proven, so it is absent everywhere and the example says so
  assert.ok(!("decimals" in T.nativeCurrency), "decimals absent from the registry");
  const raw = JSON.parse(example);
  assert.ok(!("decimals" in raw.chain.nativeCurrency), "decimals absent from the example");
  assert.ok(/NOT independently proven/.test(raw._comment) && /NOT independently proven/.test(raw.chain._nativeCurrencyComment), "and the _comment says so");
  assert.throws(() => { T.chainId = 1; }, /read only|Cannot assign/, "the registry is frozen");
  // 998 appears nowhere as a wallet, provider or router chain
  assert.ok(!/0x3e6\b/i.test(read("wallet.html") + read("chain-router.js") + read("wallet-chain.js")), "no 0x3e6 chain id");
  assert.ok(!/\b998\b/.test(read("wallet.html").replace(/<!--[\s\S]*?-->/g, "") + read("chain-router.js").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "") + read("wallet-chain.js").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "no 998 in the wallet page, router or wallet-chain code");

  // ---- 3. the example settings ----------------------------------------------------------------------------
  {
    for (const k of ["collector", "vault", "arm", "risk", "baseCollect", "baseSweep"]) assert.ok(!(k in raw), `no ${k} section`);
    assert.ok(!("contracts" in raw), "no contracts section: no DEX or NPM address is known");
    assert.ok(!/privateKey|mnemonic|keystore|passphrase|proapi_|BEGIN [A-Z ]*PRIVATE|apikey|api_key/i.test(example), "no key material in the example");
    assert.strictEqual(raw.noTransactionData, true);
    const cfg = settings.load({ file: EXAMPLE_FILE });
    assert.strictEqual(cfg.chainId, 99801); assert.strictEqual(cfg.noTransactionData, true); assert.strictEqual(cfg.chainName, "Elysium Testnet");
    assert.strictEqual(cfg.testnet, true); assert.strictEqual(cfg.settlementChainId, 998);
    assert.strictEqual(cfg.rpcUrl, T.rpcUrl); assert.strictEqual(cfg.explorer, T.explorer);
    assert.strictEqual(cfg.nativeCurrency, undefined, "an unverified native currency is not carried");
    assert.strictEqual(raw.dashboard.port, 8794);
    assert.ok(!cfg.contracts.positionManager && !cfg.contracts.factory && !cfg.contracts.v4);
    // the only addresses are the wallets
    const walletAddrs = new Set([raw.wallets.main.address, ...raw.wallets.watched.map((w) => w.address)].map((a) => a.toLowerCase()));
    for (const a of example.match(/0x[0-9a-fA-F]{40}\b/g)) assert.ok(walletAddrs.has(a.toLowerCase()), `${a} is a wallet`);
    // a verified decimals declaration, when someone adds one, flows through
    const withDec = JSON.parse(example); withDec.chain.nativeCurrency.decimals = 18;
    assert.deepStrictEqual(settings.toLegacy(withDec).nativeCurrency, { symbol: "HYPE", decimals: 18 });
  }

  // ---- 4. strict endpoints and the env override -------------------------------------------------------------
  {
    assert.ok(settings.STRICT_CHAINS.has(99801));
    for (const [field, value] of [["rpcUrl", "http://testnet-rpc.elysium.kinetiq.xyz"], ["rpcUrl", "https://localhost"], ["rpcUrl", "https://127.0.0.1"], ["explorer", "http://elysium.kinetiq.xyz/testnet-explorer"]]) {
      const c = JSON.parse(example); c.chain[field] = value;
      assert.throws(() => settings.toLegacy(c), new RegExp(`chain\\.${field} rejected`), `${field} ${value}`);
    }
    const prev = process.env.LP_ELYSIUM_TESTNET_RPC_URL;
    process.env.LP_ELYSIUM_TESTNET_RPC_URL = "https://keyed.example/v2/0123456789abcdefABCDEF0123456789";
    try {
      const cfg = settings.toLegacy(JSON.parse(example));
      assert.ok(cfg.rpcUrl.startsWith("https://keyed.example/")); assert.strictEqual(cfg.rpcPublic, T.rpcUrl);
      process.env.LP_ELYSIUM_TESTNET_RPC_URL = "http://keyed.example/SECRETPATH";
      assert.throws(() => settings.toLegacy(JSON.parse(example)), (e) => /LP_ELYSIUM_TESTNET_RPC_URL rejected/.test(e.message) && !/SECRETPATH/.test(e.message));
    } finally { if (prev === undefined) delete process.env.LP_ELYSIUM_TESTNET_RPC_URL; else process.env.LP_ELYSIUM_TESTNET_RPC_URL = prev; }
  }

  // ---- 5. 6. 7. the mainnet is disabled -----------------------------------------------------------------------
  {
    assert.strictEqual(M.chainId, 99901); assert.strictEqual(M.chainIdHex, "0x1863d"); assert.strictEqual(0x1863d, 99901);
    assert.strictEqual(M.symbol, "HYPE"); assert.strictEqual(M.settlementChainId, 999); assert.strictEqual(M.enabled, false);
    assert.strictEqual(M.status, "awaiting verification"); assert.strictEqual(M.testnet, false);
    assert.strictEqual(M.rpcUrl, null); assert.strictEqual(M.explorer, null); assert.strictEqual(M.nativeDecimals, null);
    const expect = (e) => /99901/.test(e.message) && /awaiting verification/.test(e.message);
    assert.throws(() => chains.requireEnabled(M), expect);
    const full = { ...M, enabled: true, rpcUrl: "https://x.example", explorer: "https://y.example", nativeDecimals: 18 };
    assert.strictEqual(chains.requireEnabled(full), full, "only a copy with all three set passes");
    for (const missing of ["rpcUrl", "explorer", "nativeDecimals"]) assert.throws(() => chains.requireEnabled({ ...full, [missing]: null }), expect, `enabled but ${missing} null`);
    assert.throws(() => chains.requireEnabled({ ...full, enabled: false }), expect);
    assert.strictEqual(chains.requireEnabled(T), T, "the testnet is usable");
    // settings refuse chain 99901
    const bad = JSON.parse(example); bad.chain.chainId = 99901;
    assert.throws(() => settings.toLegacy(bad), expect);
    const badFile = path.join(TMP, "mainnet.json"); fs.writeFileSync(badFile, JSON.stringify(bad));
    assert.throws(() => settings.load({ file: badFile }), expect);
    // the router refuses by name, loudly, and listens on nothing
    const rp = await freePort();
    const r = spawnSync(process.execPath, ["--require", PRELOAD, path.join(ROOT, "chain-router.js"), `--port=${rp}`, "--chains=robinhood,elysium-mainnet"], { cwd: hermeticCwd(), env: hermeticEnv({ LP_ROUTER_CHAINS: "" }), encoding: "utf8", timeout: 20000 });
    assert.notStrictEqual(r.status, 0); assert.ok(expect({ message: r.stderr }), r.stderr);
    assert.strictEqual((await request(rp, "/")).status, 0, "nothing is listening");
    const r2 = spawnSync(process.execPath, ["--require", PRELOAD, path.join(ROOT, "chain-router.js"), `--port=${rp}`], { cwd: hermeticCwd(), env: hermeticEnv({ LP_ROUTER_CHAINS: "elysium-mainnet" }), encoding: "utf8", timeout: 20000 });
    assert.notStrictEqual(r2.status, 0, "LP_ROUTER_CHAINS too");
    // verify-onchain: non-zero, and no network call at all (the no-network guard would log one)
    const nolog = path.join(TMP, "nn.log");
    const v = spawnSync(process.execPath, ["--require", PRELOAD, path.join(ROOT, "tools/verify-onchain.js"), "elysium-mainnet"], { cwd: hermeticCwd(), env: hermeticEnv({ NO_NETWORK_LOG: nolog }), encoding: "utf8", timeout: 20000 });
    assert.notStrictEqual(v.status, 0); assert.ok(expect({ message: v.stderr }));
    assert.ok(!fs.existsSync(nolog) || fs.readFileSync(nolog, "utf8").trim() === "", "no network attempt");
    // no mainnet env var, no mainnet example, no mainnet start in the scripts, no mainnet URL anywhere
    for (const f of ["settings.js", "start-all.sh", "stop-all.sh", "chain-router.js", "server.js", "tools/verify-elysium.js"]) assert.ok(!/LP_ELYSIUM_MAINNET/.test(read(f)), `${f}: no mainnet variable`);
    assert.ok(!fs.readdirSync(ROOT).some((f) => /elysium.*mainnet.*\.json$/i.test(f)), "no mainnet example");
    const tracked = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter((f) => f && !/^(SPEC-elysium-testnet|VERIFICATION-elysium)\.md$|^node_modules|^test\//.test(f) && /\.(js|mjs|json|sh|html|md)$/.test(f));
    for (const f of tracked) {
      const text = fs.readFileSync(path.join(ROOT, f), "utf8");
      assert.ok(!/https?:\/\/[^\s"'`]*elysium[^\s"'`]*(mainnet|\/explorer\b)/i.test(text.replace(/testnet-explorer/g, "")), `${f}: no mainnet RPC or explorer URL`);
    }
  }

  // ---- 8. 9. wallet add / switch ---------------------------------------------------------------------------------
  {
    const verified = { chainId: 99801, chainName: "Elysium Testnet", rpc: T.rpcUrl, explorer: T.explorer, nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 } };
    const expected = { chainId: "0x185d9", chainName: "Elysium Testnet", rpcUrls: ["https://testnet-rpc.elysium.kinetiq.xyz"], nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 }, blockExplorerUrls: ["https://elysium.kinetiq.xyz/testnet-explorer"] };
    assert.deepStrictEqual(walletChain.walletChainParams(verified), expected);
    assert.deepStrictEqual(Object.keys(walletChain.walletChainParams(verified)).sort(), Object.keys(expected).sort(), "no extra keys");
    assert.strictEqual(walletChain.walletChainParams({ ...verified, nativeCurrency: null }), null, "not built when the native currency is unverified");
    assert.strictEqual(walletChain.walletChainParams({ ...verified, nativeCurrency: { symbol: "HYPE" } }), null, "nor with no decimals");
    assert.strictEqual(walletChain.walletChainParams({ ...verified, chainId: 998 }).chainId, "0x3e6", "the id comes from the server, never from a settlement constant");
    const mock = (switchErr) => {
      const calls = [];
      return { calls, request: async ({ method, params }) => { calls.push({ method, params }); if (method === "wallet_switchEthereumChain" && switchErr) throw switchErr; return null; } };
    };
    let eth = mock(null);
    assert.strictEqual(await walletChain.switchOrAdd(eth, verified), "switched");
    assert.deepStrictEqual(eth.calls.map((c) => c.method), ["wallet_switchEthereumChain"]); assert.deepStrictEqual(eth.calls[0].params, [{ chainId: "0x185d9" }]);
    eth = mock(Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }));
    assert.strictEqual(await walletChain.switchOrAdd(eth, verified), "added");
    assert.deepStrictEqual(eth.calls.map((c) => c.method), ["wallet_switchEthereumChain", "wallet_addEthereumChain"], "switch, then add exactly once");
    assert.deepStrictEqual(eth.calls[1].params, [expected]);
    eth = mock(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    await assert.rejects(walletChain.switchOrAdd(eth, verified), /User rejected/);
    assert.deepStrictEqual(eth.calls.map((c) => c.method), ["wallet_switchEthereumChain"], "a rejection never adds");
    eth = mock(new Error("Unrecognized chain ID '0x185d9'. Try adding the chain"));
    assert.strictEqual(await walletChain.switchOrAdd(eth, verified), "added");
    assert.strictEqual(eth.calls.filter((c) => c.method === "wallet_addEthereumChain").length, 1);
    // unknown chain and unverified native currency: no add, a clear message
    eth = mock(Object.assign(new Error("x"), { code: 4902 }));
    await assert.rejects(walletChain.switchOrAdd(eth, { ...verified, nativeCurrency: null }), /Add it by hand.*will not guess/);
    assert.deepStrictEqual(eth.calls.map((c) => c.method), ["wallet_switchEthereumChain"]);
    // the page uses it, and still carries no chain of its own (test/chain-identity.test.js still passes; it was updated to allow the shared wallet-chain.js module)
    const html = read("wallet.html");
    assert.ok(/<script src="\/wallet-chain\.js"><\/script>/.test(html));
    assert.strictEqual((html.match(/window\.WalletChain\.switchOrAdd\(window\.ethereum,/g) || []).length, 2, "switchChain and connectWallet both run the tested switchOrAdd");
    assert.ok(!/wallet_addEthereumChain|wallet_switchEthereumChain'\s*,\s*\[\{ chainId: '0x' \+ CHAIN_ID/.test(html.replace(/<!--[\s\S]*?-->/g, "")), "no hand-rolled add/switch left in the page");
    assert.ok(!/(?<!window\.)\bWalletChain\./.test(html.replace(/<script src="\/wallet-chain\.js">/, "")), "every use goes through window.WalletChain, so a missing module is not a ReferenceError");
    assert.strictEqual((html.match(/if \(!window\.WalletChain\)/g) || []).length, 2, "both entry points say so when the module is missing");
    // the manual-add message names everything the user must type
    const man = walletChain.manualAddMessage({ ...verified, nativeCurrency: null, nativeSymbol: "HYPE" });
    for (const s of ["Elysium Testnet", "99801", "0x185d9", T.rpcUrl, "HYPE", T.explorer]) assert.ok(man.includes(s), `manual message has ${s}: ${man}`);
    eth = mock(Object.assign(new Error("x"), { code: 4902 }));
    await assert.rejects(walletChain.switchOrAdd(eth, { ...verified, nativeCurrency: null, nativeSymbol: "HYPE" }), (e) => ["99801", "0x185d9", "HYPE", T.rpcUrl, T.explorer, "Elysium Testnet"].every((s) => e.message.includes(s)));
    assert.strictEqual(spawnSync(process.execPath, [path.join(__dirname, "chain-identity.test.js")], { encoding: "utf8" }).status, 0, "chain-identity.test.js passes");
    // statically: no signing request in the new wallet code
    assert.ok(!/personal_sign|eth_sign|eth_signTypedData|eth_sendTransaction|mnemonic|privateKey/.test(read("wallet-chain.js")));
  }

  // ---- 11. explorer links ----------------------------------------------------------------------------------------
  {
    const H = "0x" + "ab".repeat(32), A = "0x" + "cd".repeat(20);
    for (const base of [T.explorer, T.explorer + "/", T.explorer + "//"]) {
      assert.strictEqual(links.txUrl(base, H), `https://elysium.kinetiq.xyz/testnet-explorer/tx/${H}`);
      assert.strictEqual(links.addressUrl(base, A), `https://elysium.kinetiq.xyz/testnet-explorer/address/${A}`);
    }
    for (const bad of ["0x12", "0x" + "zz".repeat(32), H.slice(2), H + "00", "", null, undefined, 5]) assert.strictEqual(links.txUrl(T.explorer, bad), null, String(bad));
    for (const bad of ["0x12", "0x" + "zz".repeat(20), A.slice(2), A + "00", H, "", null]) assert.strictEqual(links.addressUrl(T.explorer, bad), null, String(bad));
    for (const base of ["javascript:alert(1)", "http://elysium.kinetiq.xyz/testnet-explorer", "", null, undefined, "//x.example", "https://", "https://a b.example", "data:text/html,x"]) {
      assert.strictEqual(links.txUrl(base, H), null, String(base)); assert.strictEqual(links.addressUrl(base, A), null, String(base));
    }
  }

  // ---- 13. 14. 15. the router -----------------------------------------------------------------------------------
  {
    const R = require("../chain-router");
    assert.deepStrictEqual(R.CHAINS.map((c) => c.key), ["robinhood", "arc"], "the default list is exactly what it was");
    const last = R.KNOWN_CHAINS[R.KNOWN_CHAINS.length - 1];
    assert.deepStrictEqual({ key: last.key, label: last.label, port: last.port, testnet: last.testnet }, { key: "elysium-testnet", label: "Elysium Testnet", port: 8794, testnet: true });
    assert.deepStrictEqual(R.KNOWN_CHAINS.map((c) => c.key), ["robinhood", "arc", "base", "pulsechain", "elysium-testnet"]);
    assert.strictEqual(R.KNOWN_CHAINS.filter((c) => c.testnet).length, 1, "only the Elysium testnet is a testnet");
    // hyphenated key cookie namespacing
    const sc = R.renameSetCookie("name=v; Path=/", "elysium-testnet");
    assert.strictEqual(sc, "c_elysium-testnet__name=v; Path=/");
    assert.strictEqual(R.restoreCookieHeader("c_elysium-testnet__name=v; c_arc__name=z; other=1", "elysium-testnet"), "name=v; other=1");
    R.server.close();
    const [rh, arc, ely, router1] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
    const page = '<html><body>UPSTREAM-ely<div id="lp-testnet-banner">TESTNET</div></body></html>';
    const servers = [await upstream("robinhood", rh), await upstream("arc", arc), await upstream("elysium-testnet", ely, page)];
    const out = [];
    const child = spawn(process.execPath, ["--require", PRELOAD, path.join(ROOT, "chain-router.js"), `--port=${router1}`, `--robinhood-port=${rh}`, `--arc-port=${arc}`, `--elysium-testnet-port=${ely}`, "--chains=robinhood,arc,base,pulsechain,elysium-testnet,bogus"], { cwd: hermeticCwd(), env: hermeticEnv({ LP_ROUTER_CHAINS: "" }) });
    child.stdout.on("data", (d) => out.push(String(d))); child.stderr.on("data", (d) => out.push(String(d)));
    try {
      const t0 = Date.now();
      while ((out.join("").match(/->\s+127\.0\.0\.1:/g) || []).length < 5) { if (Date.now() - t0 > 10000) throw new Error("router did not start: " + out.join("")); await new Promise((r) => setTimeout(r, 50)); }
      assert.ok(new RegExp(`Elysium Testnet\\s+->\\s+127\\.0\\.0\\.1:${ely}`).test(out.join("")), "the --elysium-testnet-port override and the banner");
      assert.ok(!/bogus/.test(out.join("")), "an unknown key is still ignored");
      const picked = await request(router1, "/", { headers: { cookie: "lpchain=elysium-testnet" } });
      assert.ok(picked.body.includes("UPSTREAM-ely"));
      const picker = picked.body.slice(picked.body.indexOf('id="lp-chain-picker"'));
      assert.ok(picker.includes('data-chain="elysium-testnet"') && picker.includes("Elysium Testnet"), "the picker tab");
      assert.strictEqual((picker.match(/>TESTNET<\/span>/g) || []).length, 1, "a TESTNET tag on that tab only");
      assert.ok(picker.includes("#f59e0b"));
      assert.ok(/c_elysium-testnet__csrf=elysium-testnet-token/.test(String(picked.headers["set-cookie"])), String(picked.headers["set-cookie"]));
      const sel = await request(router1, "/x?chain=elysium-testnet");
      assert.strictEqual(sel.status, 302); assert.ok(/lpchain=elysium-testnet/.test(String(sel.headers["set-cookie"]))); assert.strictEqual(sel.headers.location, "/x");
      const api = JSON.parse((await request(router1, "/api/thing", { headers: { cookie: "lpchain=elysium-testnet; c_elysium-testnet__csrf=E; c_arc__csrf=A" } })).body);
      assert.strictEqual(api.chain, "elysium-testnet"); assert.ok(/csrf=E/.test(api.cookie) && !/csrf=A/.test(api.cookie), api.cookie);
      // the Portfolio shell carries the tag
      const pf = await request(router1, "/portfolio", { headers: { host: `127.0.0.1:${router1}` } });
      assert.strictEqual(pf.status, 200);
      const tab = pf.body.match(/<a class="chain-tab"[^>]*data-key="elysium-testnet"[^>]*>.*?<\/a>/s)[0];
      assert.ok(tab.includes("Elysium Testnet") && tab.includes(">TESTNET<"), tab);
      assert.strictEqual((pf.body.match(/>TESTNET</g) || []).length, 1, "and no other tab does");
      // a default router has neither
      const home = await request(router1, "/", { headers: { cookie: "lpchain=robinhood" } });
      assert.ok(home.body.includes("UPSTREAM-robinhood"));
      assert.ok(/class="testnet-tag"/.test(home.body), "(the picker lists every chain this router fronts, so the testnet tab is visible from any chain)");
      // when the testnet instance is down, the 502 page names it
      await new Promise((r) => servers[2].close(r));
      const down = await request(router1, "/", { headers: { cookie: "lpchain=elysium-testnet" } });
      assert.strictEqual(down.status, 502); assert.ok(/Elysium Testnet is not answering/.test(down.body) && down.body.includes(">TESTNET<"));
    } finally { child.kill("SIGTERM"); for (const s of servers) s.close(); }
    // a router that does not front it shows no testnet tag
    const noEly = spawnSync(process.execPath, ["--require", PRELOAD, "-e", `const r=require(${JSON.stringify(path.join(ROOT, "chain-router"))});console.log(r.pickerHtml(r.CHAINS[0]).includes("TESTNET")||r.portfolioHtml().includes("TESTNET"));r.server.close()`], { cwd: hermeticCwd(), env: hermeticEnv({ LP_ROUTER_CHAINS: "" }), encoding: "utf8" });
    assert.strictEqual(noEly.stdout.trim(), "false");
    const withEly = spawnSync(process.execPath, ["--require", PRELOAD, "-e", `process.argv.push("--chains=robinhood,arc,base,pulsechain,elysium-testnet");const r=require(${JSON.stringify(path.join(ROOT, "chain-router"))});console.log(JSON.stringify(r.CHAINS.map(c=>[c.key,c.port])));r.server.close()`], { cwd: hermeticCwd(), env: hermeticEnv(), encoding: "utf8" });
    assert.deepStrictEqual(JSON.parse(withEly.stdout.trim()), [["robinhood", 8787], ["arc", 8797], ["base", 8796], ["pulsechain", 8795], ["elysium-testnet", 8794]]);
  }

  // ---- 10. 16. 17. the read-only server, answered from memory ---------------------------------------------------
  {
    // without LP_READONLY=1: refused
    const refused = await startServer(mkDir(), {}, { readonly: false });
    assert.strictEqual(refused.exited, 1); assert.ok(/Refusing to start/.test(refused.out.join("")));

    const WALLET = JSON.parse(example).wallets.main.address;
    const dir = mkDir();
    const log = path.join(TMP, "rpc.log");
    const srv = await startServer(dir, { STUB_LOG: log, STUB_BALANCES: JSON.stringify({ [WALLET]: "489000000000000000" }) });
    try {
      const h = { host: `127.0.0.1:${srv.port}`, origin: `http://127.0.0.1:${srv.port}`, "content-type": "application/json" };
      const ch = JSON.parse((await request(srv.port, "/api/chain", { headers: h })).body);
      assert.strictEqual(ch.chainId, 99801); assert.strictEqual(ch.chainName, "Elysium Testnet"); assert.strictEqual(ch.testnet, true);
      assert.strictEqual(ch.rpc, "https://testnet-rpc.elysium.kinetiq.xyz", "an origin only"); assert.strictEqual(ch.explorer, T.explorer);
      assert.strictEqual(ch.nativeCurrency, null, "unverified: the wallet page will not guess");
      assert.strictEqual(ch.nativeSymbol, "HYPE"); assert.strictEqual(ch.nativeDecimalsUnverified, true, "the symbol is exposed, marked unverified");
      assert.strictEqual(ch.noTx, true); assert.strictEqual(ch.readOnly, true);
      const vi = JSON.parse((await request(srv.port, "/api/vault-info", { headers: h })).body);
      assert.strictEqual(vi.ok, true); assert.strictEqual(vi.testnet, true); assert.strictEqual(vi.artError, undefined, "no error for a vault that does not exist here");
      // every page names the testnet
      for (const p of ["/", "/analytics", "/wallet"]) {
        const r = await request(srv.port, p, { headers: h });
        assert.strictEqual(r.status, 200, p);
        assert.ok(r.body.includes('id="lp-testnet-banner"') && r.body.includes("TESTNET") && r.body.includes("Elysium Testnet"), `${p}: the TESTNET banner`);
      }
      assert.ok((await request(srv.port, "/wallet-chain.js", { headers: h })).body.includes("walletChainParams"), "the browser module is served");
      // no calldata, no signing endpoints
      for (const p of ["/api/approval?v=3", "/api/v4-approval", "/api/sell/quote?token=0x0000000000000000000000000000000000000001&amount=1", "/api/mint/context", "/api/mint/quote"]) {
        const r = await request(srv.port, p, { headers: h });
        assert.strictEqual(r.status, 403, `${p}: ${r.status}`);
      }
      for (const p of ["/api/collect", "/api/arm", "/api/unlock", "/api/lock"]) assert.strictEqual((await request(srv.port, p, { method: "POST", headers: h })).status, 403, p);
      // positions and LP readers are empty, never an error
      const pos = JSON.parse((await request(srv.port, "/api/positions", { headers: h })).body);
      assert.strictEqual(pos.ok, true); assert.deepStrictEqual(pos.positions, []); assert.strictEqual(pos.chainId, 99801);
      let watch;
      for (let i = 0; i < 60; i++) { const r = await request(srv.port, "/api/watch", { headers: h }); watch = JSON.parse(r.body); if (watch.ok) break; await new Promise((res) => setTimeout(res, 300)); }
      assert.strictEqual(watch.ok, true);
      for (const w of watch.wallets) { assert.deepStrictEqual(w.positions, []); assert.deepStrictEqual(w.external, []); assert.deepStrictEqual(w.errors, []); }
      // the native balance: raw wei, labelled, never scaled by a guess and never priced
      let pf;
      for (let i = 0; i < 60; i++) { const r = await request(srv.port, "/api/portfolio", { headers: h }); pf = JSON.parse(r.body); if (pf.ok !== false) break; await new Promise((res) => setTimeout(res, 300)); }
      const native = pf.rows.find((r) => r.native);
      assert.ok(native, `a native row: ${JSON.stringify(pf).slice(0, 300)}`);
      assert.strictEqual(native.symbol, "HYPE"); assert.strictEqual(native.walletRaw, "489000000000000000"); assert.strictEqual(native.decimalsUnverified, true);
      assert.strictEqual(native.wallet, null); assert.strictEqual(native.price, null); assert.strictEqual(native.walletUsd, null);
      // /api/balances: the native row is raw wei under the chain's symbol, never "ETH" and never formatEther
      const bal = JSON.parse((await request(srv.port, "/api/balances", { headers: h })).body);
      assert.strictEqual(bal.ok, true, JSON.stringify(bal).slice(0, 300));
      const bn = bal.rows.find((r) => r.native);
      assert.strictEqual(bn.symbol, "HYPE"); assert.strictEqual(bn.balance, null); assert.strictEqual(bn.balanceRaw, "489000000000000000");
      assert.strictEqual(bn.decimalsUnverified, true); assert.strictEqual(bn.usd, null);
      // only read methods reached the chain
      const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((c) => c.kind === "rpc").map((c) => c.method);
      const READ = new Set(["eth_chainId", "net_version", "eth_blockNumber", "eth_getBalance", "eth_gasPrice", "eth_feeHistory", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_estimateGas"]);
      assert.ok(calls.length > 0 && calls.every((m) => READ.has(m)), `only read methods: ${[...new Set(calls)]}`);
      assert.ok(!calls.some((m) => /send|sign/i.test(m)));
    } finally { await srv.stop(); }

    // decimals verified in settings: the balance is scaled by them
    const withDec = JSON.parse(example); withDec.chain.nativeCurrency.decimals = 18;
    const srv2 = await startServer(mkDir(JSON.stringify(withDec)), { STUB_BALANCES: JSON.stringify({ [WALLET]: "489000000000000000" }) });
    try {
      const h = { host: `127.0.0.1:${srv2.port}`, origin: `http://127.0.0.1:${srv2.port}` };
      const ch = JSON.parse((await request(srv2.port, "/api/chain", { headers: h })).body);
      assert.deepStrictEqual(ch.nativeCurrency, { name: "HYPE", symbol: "HYPE", decimals: 18 });
      let pf;
      for (let i = 0; i < 60; i++) { pf = JSON.parse((await request(srv2.port, "/api/portfolio", { headers: h })).body); if (pf.ok !== false) break; await new Promise((res) => setTimeout(res, 300)); }
      const native = pf.rows.find((r) => r.native);
      assert.strictEqual(native.wallet, 0.489); assert.strictEqual(native.price, null, "a testnet balance is never priced"); assert.ok(!native.decimalsUnverified);
      const bal2 = JSON.parse((await request(srv2.port, "/api/balances", { headers: h })).body);
      const bn2 = bal2.rows.find((r) => r.native);
      assert.strictEqual(bn2.symbol, "HYPE"); assert.strictEqual(bn2.balance, 0.489); assert.ok(!bn2.decimalsUnverified, "verified decimals: scaled");
    } finally { await srv2.stop(); }

    // the env RPC: used in-process, never in a served response or the log
    const KEY = "0123456789abcdefABCDEF0123456789";
    const srv3 = await startServer(mkDir(), { LP_ELYSIUM_TESTNET_RPC_URL: `https://x.example/ely/${KEY}` });
    try {
      const h = { host: `127.0.0.1:${srv3.port}`, origin: `http://127.0.0.1:${srv3.port}` };
      for (const p of ["/api/chain", "/api/watch", "/api/positions", "/api/vault-info", "/wallet"]) assert.ok(!(await request(srv3.port, p, { headers: h })).body.includes(KEY), `${p}: no key`);
      assert.strictEqual(JSON.parse((await request(srv3.port, "/api/chain", { headers: h })).body).rpc, T.rpcUrl);
      assert.ok(!srv3.out.join("").includes(KEY));
    } finally { await srv3.stop(); }
  }

  // ---- approve-serve.js (npm run approve) reads a keystore and answers approval state: it refuses a testnet ----------
  {
    const dir = mkDir();
    const r = spawnSync(process.execPath, ["--require", PRELOAD, "--require", STUB, path.join(ROOT, "approve-serve.js")], {
      cwd: hermeticCwd(), env: hermeticEnv({ LP_DATA_DIR: dir, PORT: String(await freePort()), LP_BIND: "127.0.0.1" }), encoding: "utf8", timeout: 30000,
    });
    assert.strictEqual(r.status, 1, "approve-serve exits at startup for the testnet");
    assert.ok(/Refusing to start: approve-serve\.js is not available for chain 99801/.test(r.stderr), r.stderr);
  }

  // ---- 20. 21. start-all.sh / stop-all.sh under a stub harness ------------------------------------------------
  {
    for (const f of ["start-all.sh", "stop-all.sh"]) assert.strictEqual(spawnSync("bash", ["-n", path.join(ROOT, f)]).status, 0, `${f} parses`);
    const bin = path.join(TMP, "bin"); fs.mkdirSync(bin);
    const LOG = path.join(TMP, "calls.log");
    const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 }); };
    stub("node", 'echo "node $*" >> "$STUB_LOG"; exit 0');
    stub("nohup", 'echo "nohup[LP_READONLY=${LP_READONLY:-}] $*" >> "$STUB_LOG"; exit 0');
    stub("pgrep", "exit 1");
    stub("ss", '[ "${1:-}" = "-ltnp" ] && { for p in $STUB_LISTEN; do echo "LISTEN 0 511 127.0.0.1:$p 0.0.0.0:* users:((\\"node\\",pid=$((4000+p%1000)),fd=19))"; done; exit 0; }\nfor p in $STUB_LISTEN; do echo "LISTEN 0 511 127.0.0.1:$p 0.0.0.0:*"; done; exit 0');
    const appDir = path.join(TMP, "app"); fs.mkdirSync(appDir);
    for (const f of ["start-all.sh", "stop-all.sh"]) fs.copyFileSync(path.join(ROOT, f), path.join(appDir, f));
    fs.mkdirSync(path.join(TMP, "emptyproc"));
    fs.writeFileSync(path.join(TMP, "stubfns.sh"), 'kill() { echo "kill $*" >> "$STUB_LOG"; return 0; }\n');
    const run = (script, home, { listen = "", proc = "", env = {} } = {}) => {
      fs.writeFileSync(LOG, "");
      const r = spawnSync("bash", [path.join(appDir, script)], {
        cwd: appDir, encoding: "utf8", timeout: 20000,
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, STUB_LOG: LOG, STUB_LISTEN: listen, LP_TEST: "1", LP_PROC_ROOT: proc || path.join(TMP, "emptyproc"), BASH_ENV: path.join(TMP, "stubfns.sh"), ...env },
      });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
      return { r, calls: fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean) };
    };
    const fakeProc = (pid, argv) => { const d = path.join(TMP, `proc-${pid}-${Math.random().toString(36).slice(2)}`); fs.mkdirSync(path.join(d, String(pid)), { recursive: true }); fs.writeFileSync(path.join(d, String(pid), "cmdline"), argv.join("\0") + "\0"); return d; };
    const mkHome = (...dirs) => { const h = fs.mkdtempSync(path.join(TMP, "home-")); for (const d of dirs) { fs.mkdirSync(path.join(h, d)); fs.writeFileSync(path.join(h, d, "settings.json"), "{}"); } return h; };

    let h = mkHome();
    let x = run("start-all.sh", h);
    assert.strictEqual(x.r.status, 0, x.r.stderr);
    assert.ok(!x.calls.some((c) => /elysium|8794/i.test(c)), `nothing Elysium-related without settings: ${x.calls.join(" | ")}`);
    h = mkHome("arc-data", "base-data", "pulse-data");
    x = run("start-all.sh", h);
    assert.ok(/--chains=robinhood,arc,base,pulsechain(\s|$)/.test(x.calls.find((c) => /chain-router/.test(c))), "other chains' router list unchanged");
    assert.ok(!x.calls.some((c) => /elysium/.test(c)), "--chains does not contain elysium-testnet");
    assert.strictEqual(x.calls.filter((c) => /server\.js/.test(c)).length, 4, "arc, base, pulse and the main dashboard started as before");
    // present: one read-only start, the router lists it
    h = mkHome("elysium-testnet-data");
    x = run("start-all.sh", h);
    const starts = x.calls.filter((c) => /server\.js/.test(c) && /8794/.test(c));
    assert.strictEqual(starts.length, 1, x.calls.join(" | "));
    assert.ok(starts[0].startsWith("nohup[LP_READONLY=1]"), starts[0]);
    assert.ok(starts[0].includes(`node server.js --data-dir=${h}/elysium-testnet-data --port=8794 --no-loops --no-services`), starts[0]);
    assert.ok(!/--claim-scan/.test(starts[0]));
    const r1 = x.calls.filter((c) => /chain-router/.test(c));
    assert.strictEqual(r1.length, 1); assert.ok(/--chains=robinhood,arc,elysium-testnet(\s|$)/.test(r1[0]), r1[0]);
    h = mkHome("arc-data", "base-data", "pulse-data", "elysium-testnet-data");
    x = run("start-all.sh", h);
    assert.ok(/--chains=robinhood,arc,base,pulsechain,elysium-testnet(\s|$)/.test(x.calls.find((c) => /chain-router/.test(c))));
    // custom location and port; already running
    const custom = fs.mkdtempSync(path.join(TMP, "custom-")); fs.writeFileSync(path.join(custom, "settings.json"), "{}");
    x = run("start-all.sh", mkHome(), { env: { LP_ELYSIUM_TESTNET_DATA_DIR: custom, LP_ELYSIUM_TESTNET_PORT: "18794" } });
    assert.ok(x.calls.some((c) => c.includes(`--data-dir=${custom} --port=18794 --no-loops --no-services`)), x.calls.join(" | "));
    x = run("start-all.sh", h, { listen: "8794" });
    assert.strictEqual(x.calls.filter((c) => /server\.js.*--port=8794/.test(c)).length, 0);
    assert.ok(/elysium testnet viewer: already running on :8794/.test(x.r.stdout), x.r.stdout);

    // stop-all.sh: only a process that really is the Elysium viewer
    const pid = 4000 + 8794 % 1000;
    x = run("stop-all.sh", h, { listen: "8794", proc: fakeProc(pid, ["node", "server.js", `--data-dir=${h}/elysium-testnet-data`, "--port=8794", "--no-loops", "--no-services"]) });
    assert.ok(x.calls.filter((c) => /^kill /.test(c)).includes(`kill ${pid}`), x.calls.join(" | "));
    assert.ok(/elysium testnet viewer: stopped/.test(x.r.stdout));
    for (const argv of [["python3", "-m", "http.server", "8794"], ["node", "server.js", `--data-dir=${h}/pulse-data`, "--port=8794"], ["node", "other.js", `--data-dir=${h}/elysium-testnet-data`], ["node", "server.js", `--data-dir=${h}/elysium-testnet-data-2`, "--port=8794"]]) {
      x = run("stop-all.sh", h, { listen: "8794", proc: fakeProc(pid, argv) });
      assert.ok(!x.calls.some((c) => c === `kill ${pid}`), `must not kill ${argv.join(" ")}: ${x.calls.join(" | ")}`);
      assert.ok(/not the Elysium testnet viewer/.test(x.r.stdout), x.r.stdout);
    }
    x = run("stop-all.sh", h, { listen: "8795 8796", proc: fakeProc(4000 + 8795 % 1000, ["node", "server.js", `--data-dir=${h}/elysium-testnet-data`, "--port=8794"]) });
    assert.ok(!/elysium testnet viewer/.test(x.r.stdout), "other ports never trigger the Elysium stop");
  }

  // ---- 22. tools/verify-onchain.js elysium-testnet -----------------------------------------------------------------
  {
    const run = (env) => spawnSync(process.execPath, ["--require", PRELOAD, "--require", STUB, path.join(ROOT, "tools/verify-onchain.js"), "elysium-testnet"], { cwd: hermeticCwd(), env: hermeticEnv({ ELYSIUM_TESTNET_RPC: "https://testnet-rpc.elysium.kinetiq.xyz", ...env }), encoding: "utf8", timeout: 60000 });
    const ok = run({ STUB_CHAIN_ID: "99801" });
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    assert.ok(/PASS\s+eth_chainId 0x185d9/.test(ok.stdout));
    for (const label of ["INFO  native decimals", "INFO  baseFeePerGas", "INFO  eth_gasPrice", "INFO  NodeInterface"]) assert.ok(ok.stdout.includes(label), label);
    assert.ok(/NOT independently proven/.test(ok.stdout));
    const wrong = run({ STUB_CHAIN_ID: "1" });
    assert.strictEqual(wrong.status, 1); assert.ok(/FAIL\s+eth_chainId 0x1/.test(wrong.stdout));
    const usage = spawnSync(process.execPath, [path.join(ROOT, "tools/verify-onchain.js"), "nope"], { encoding: "utf8" });
    assert.strictEqual(usage.status, 2); assert.ok(/elysium-testnet/.test(usage.stderr));
    const bad = run({ ELYSIUM_TESTNET_RPC: "http://127.0.0.1:1/SECRETPATH" });
    assert.notStrictEqual(bad.status, 0); assert.ok(!/SECRETPATH/.test(bad.stdout + bad.stderr), "a rejected RPC is not echoed");
    const code = read("tools/verify-elysium.js").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/sendTransaction|signTransaction|signMessage|new ethers\.Wallet|sendRaw|eth_send|personal_sign/.test(code), "no write RPC method name");
    // base and pulse modes are unchanged: the usage branch still runs them
    assert.ok(/mode !== "base" && mode !== "pulse"/.test(read("tools/verify-onchain.js")));
  }

  // ---- 29. README --------------------------------------------------------------------------------------------------
  {
    const readme = read("README.md");
    const sec = readme.slice(readme.indexOf("## Elysium Testnet (read-only instance)"), readme.indexOf("## Blockscout API key"));
    for (const s of ["mkdir -p ~/elysium-testnet-data && cp settings.elysium-testnet.example.json", "8794", "LP_ELYSIUM_TESTNET_PORT", "LP_ELYSIUM_TESTNET_DATA_DIR", "LP_ELYSIUM_TESTNET_RPC_URL", "Testnet only, no transactions", "Portfolio policy: testnets are excluded", "awaiting verification", "NOT independently proven", "99901"]) assert.ok(sec.includes(s), `README: ${s}`);
  }

  // ---- 27. hygiene: no Base-only collector reaches the Elysium code --------------------------------------------------
  {
    for (const f of ["elysium-chains.js", "explorer-links.js", "orbit-fees.js", "wallet-chain.js", "tools/verify-elysium.js"]) assert.ok(!/collector-base|claim-fees/.test(read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f} does not touch the Base-only modules`);
    const diff = spawnSync("git", ["diff", "--name-only", "master...HEAD"], { cwd: ROOT, encoding: "utf8" });
    if (diff.status === 0) assert.ok(!diff.stdout.split("\n").some((f) => /^(collector-base|claim-fees)/.test(f) || f === ".gitignore"), "the Base-only modules and .gitignore are untouched");
  }

  // ---- 12. 23. LIVE (LP_LIVE_TESTS=1) -----------------------------------------------------------------------------------
  if (process.env.LP_LIVE_TESTS === "1") {
    const v = spawnSync(process.execPath, [path.join(ROOT, "tools/verify-onchain.js"), "elysium-testnet"], { encoding: "utf8", timeout: 20000, env: { ...process.env, LP_ELYSIUM_TESTNET_RPC_URL: "", ELYSIUM_TESTNET_RPC: "" } });
    assert.strictEqual(v.status, 0, v.stdout + v.stderr); assert.ok(/PASS\s+eth_chainId 0x185d9/.test(v.stdout));
    console.log("LIVE: the real RPC passed the chain id check");
  }

  console.log("elysium testnet: registry, mainnet disabled, settings, wallet flow, explorer links, router, read-only server, scripts, verify tool, README passed");
})().catch((e) => { console.error(e); process.exit(1); });
