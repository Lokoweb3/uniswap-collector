// node test/base-vault-core.test.js -- artifact pins, reproducibility, unsigned transaction builder, runbook, forbidden code.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const core = require("../tools/base-vault-core");
const txs = require("../tools/base-vault-txs");
const { Chain, FakeProvider } = require("./base-vault-chain");

const ROOT = path.join(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bvault-"));
const art = core.loadArtifact();
const IMPL = "0x9932381F27f720DC1131349c4b4459F306d42DC7";
const NFT = "0x094126611290c5EC8660e8f5dCa708e35aCA573C";

(async () => {
  // ---- 2. builder with known inputs (nonce 0) -----------------------------------------------------------------
  {
    const chain = new Chain({ mainNonce: 0 });
    const provider = new FakeProvider(chain);
    const out = []; const err = [];
    const code = await txs.run(["--predict", "--format=json"], { provider, out: (s) => out.push(s), err: (s) => err.push(s) });
    assert.strictEqual(code, 0);
    const arr = JSON.parse(out.join("\n"));
    assert.strictEqual(arr.length, 4);
    assert.strictEqual(arr[0].data, art.account.initCode);
    assert.ok(!("to" in arr[0]) && !("to" in arr[1]));
    for (const t of arr) { assert.strictEqual(t.chainId, "0x2105"); assert.strictEqual(t.value, "0x0"); assert.strictEqual(t.from, core.MAIN); }
    const ctor = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "string"], [IMPL, core.REGISTRY, "Base"]);
    assert.strictEqual(arr[1].data, art.nft.initCode + ctor.slice(2));
    assert.strictEqual(arr[2].data, "0x6a627842" + core.MAIN.slice(2).toLowerCase().padStart(64, "0"));
    assert.strictEqual(arr[2].to, NFT);
    assert.strictEqual(arr[3].data, "0xbf9e114a" + (20).toString(16).padStart(64, "0"));
    assert.strictEqual(arr[3].to, NFT);
    assert.ok(/PREDICTED/.test(err.join("\n")), "JSON mode labels predictions on stderr");
    // text mode
    const t = []; await txs.run(["--predict"], { provider, out: (s) => t.push(s), err: () => {} });
    const text = t.join("\n");
    assert.ok(/PREDICTED/.test(text));
    assert.ok(text.includes(core.PINNED.account.initCodeKeccak) && text.includes(core.PINNED.nft.initCodeKeccak));
    assert.ok(text.includes(core.PINNED.account.runtimeKeccak));
    // determinism, --raw, --step
    const a = []; const b = [];
    await txs.run(["--predict", "--format=json"], { provider, out: (s) => a.push(s), err: () => {} });
    await txs.run(["--predict", "--format=json"], { provider, out: (s) => b.push(s), err: () => {} });
    assert.deepStrictEqual(a, b);
    const raw = []; await txs.run(["--predict", "--raw", "--step=3"], { provider, out: (s) => raw.push(s), err: () => {} });
    assert.strictEqual(raw[0], arr[2].data);
    // explicit addresses, nonce 5 -> prediction follows the nonce
    chain.nonce[core.MAIN.toLowerCase()] = 5;
    const p = await core.predict(new FakeProvider(chain));
    assert.strictEqual(p.impl, ethers.getCreateAddress({ from: core.MAIN, nonce: 5 }));
    assert.strictEqual(p.nft, ethers.getCreateAddress({ from: core.MAIN, nonce: 6 }));
    // wrong chain RPC refused
    const e1 = []; const wrong = await txs.run(["--predict"], { provider: new FakeProvider(new Chain({ chainId: 1 })), out: (s) => e1.push(s), err: (s) => e1.push(s) });
    assert.strictEqual(wrong, 1); assert.ok(!e1.some((l) => l.includes("=== Step")));
    // step 2 without an address is refused
    const e2 = []; assert.strictEqual(await txs.run(["--step=2"], { out: () => {}, err: (s) => e2.push(s) }), 1);
    assert.ok(e2.join("").includes("--impl"));
  }

  // ---- 3. artifact integrity ------------------------------------------------------------------------------------
  {
    const good = fs.readFileSync(core.ARTIFACT_PATH, "utf8");
    const mutate = (name, fn) => { const f = path.join(tmp, name); fs.writeFileSync(f, fn(good)); return f; };
    const flipInit = mutate("a.json", (s) => { const j = JSON.parse(s); const c = j.account.initCode; j.account.initCode = c.slice(0, 20) + (c[20] === "0" ? "1" : "0") + c.slice(21); return JSON.stringify(j, null, 2) + "\n"; });
    const flipFile = mutate("b.json", (s) => s + " ");
    const flipVer = mutate("c.json", (s) => s.replace(core.PINNED.solcVersion, "0.8.99+commit.deadbeef"));
    const flipSettings = mutate("d.json", (s) => s.replace('"runs": 200', '"runs": 201'));
    for (const f of [flipInit, flipFile, flipVer, flipSettings]) {
      assert.throws(() => core.loadArtifact(f), core.ArtifactError, f);
      const out = []; const err = [];
      assert.strictEqual(await txs.run(["--predict"], { artifactPath: f, out: (s) => out.push(s), err: (s) => err.push(s) }), 2);
      assert.deepStrictEqual(out, [], "no transaction printed");
      assert.throws(() => require("../tools/base-vault-serve").createServer({ artifactPath: f }), core.ArtifactError);
    }
    // same-content, re-pinned file still must match settings/version/hashes: a file with matching sha but a flipped byte is caught by the keccak pins
    const f = mutate("e.json", (s) => { const j = JSON.parse(s); const c = j.nft.runtime; j.nft.runtime = c.slice(0, 30) + (c[30] === "0" ? "1" : "0") + c.slice(31); return JSON.stringify(j, null, 2) + "\n"; });
    const pins = { ...core.PINNED, artifactFileSha256: core.sha256(fs.readFileSync(f)) };
    assert.throws(() => core.loadArtifact(f, pins), /runtime keccak256/);
  }

  // ---- 4. reproducibility (the one test allowed to compile) -------------------------------------------------------
  {
    let solc = null;
    try { solc = require("solc"); } catch (e) { console.log("SKIP reproducibility: solc cannot be loaded (" + e.message + ")"); }
    if (solc) {
      const r = core.verifyReproducible(art, solc);
      assert.deepStrictEqual(r.problems, []);
      assert.strictEqual(art.solcVersion, solc.version());
      assert.strictEqual(core.PINNED.account.runtimeKeccak, "0x4019de98b57e19d75b5891f785eb53ad8bdaa8508b8cfc6db7fea9c1a0334a07");
      assert.strictEqual(core.PINNED.account.runtimeKeccak, core.ARC_IMPL_RUNTIME_KECCAK);
      const { compileArtifact, serialize } = require("../tools/compile-base-vault");
      assert.strictEqual(serialize(compileArtifact(solc)), fs.readFileSync(core.ARTIFACT_PATH, "utf8"));
    }
  }

  // ---- 5. expectedRuntime ---------------------------------------------------------------------------------------
  {
    const e = core.expectedRuntime("nft", core.REGISTRY, art);
    const hex = e.hex.slice(2);
    for (const r of art.nft.immutableReferences) {
      assert.strictEqual(hex.slice(r.start * 2, (r.start + r.length) * 2), core.REGISTRY.slice(2).toLowerCase().padStart(64, "0"));
      assert.strictEqual(art.nft.runtime.slice(2 + r.start * 2, 2 + (r.start + r.length) * 2), "0".repeat(64), "artifact keeps the slot zeroed");
    }
    assert.strictEqual(e.hex.length, art.nft.runtime.length);
    assert.notStrictEqual(core.expectedRuntime("nft", "0x" + "11".repeat(20), art).keccak, e.keccak);
    assert.strictEqual(core.PINNED.nft.runtimeKeccak, ethers.keccak256(art.nft.runtime), "the pin is on the zero-masked runtime");
    assert.strictEqual(core.expectedRuntime("account", core.REGISTRY, art).keccak, core.PINNED.account.runtimeKeccak);
  }

  // ---- 16. deferred step ----------------------------------------------------------------------------------------
  {
    const S = require("../collector-base-sweep-logic");
    assert.deepStrictEqual(S.VAULT_IMPLEMENTATIONS, []);
    assert.ok(/const VAULT_IMPLEMENTATIONS = deepFreeze\(\[\]\);/.test(fs.readFileSync(path.join(ROOT, "collector-base-sweep-logic.js"), "utf8")));
  }

  // ---- 12 (grep part). no key / signing code in any new file --------------------------------------------------------
  {
    const files = ["tools/base-vault-core.js", "tools/base-vault-txs.js", "tools/base-vault-serve.js", "tools/verify-base-vault.js", "tools/compile-base-vault.js",
      "tools/base-vault/flow.js", "tools/base-vault/page.js", "tools/base-vault/index.html"];
    const banned = ["Wallet(", "privateKey", "fromEncryptedJson", "LP_KEYSTORE", "sendTransaction(", "signTransaction", "personal_sign", "eth_sign", "promptHidden", "wallet_addEthereumChain", "eth_sendRawTransaction"];
    for (const f of files) {
      const s = fs.readFileSync(path.join(ROOT, f), "utf8");
      for (const b of banned) assert.ok(!s.includes(b), `${f} contains ${b}`);
    }
    for (const f of ["tools/base-vault/flow.js", "tools/base-vault/page.js", "tools/base-vault/index.html"]) {
      const s = fs.readFileSync(path.join(ROOT, f), "utf8");
      assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(s), `${f} uses browser storage`);
    }
  }

  // ---- 17. runbook ----------------------------------------------------------------------------------------------
  {
    const s = fs.readFileSync(path.join(ROOT, "docs", "base-vault-runbook.md"), "utf8");
    for (const need of ["node tools/base-vault-txs.js --predict", "node tools/base-vault-serve.js", "http://127.0.0.1:8745", "node tools/verify-base-vault.js --nft=", "0.0005 ETH",
      "0.006 gwei", "transferOwnership", "VAULT_IMPLEMENTATIONS", "LP_ROUTER_CHAINS", "splitPct", "permanent", "operator", "nonce", "Main must be a configured owner", "100% to the owner"]) assert.ok(s.includes(need), "runbook lacks: " + need);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("base-vault-core: ok");
})().catch((e) => { console.error(e); process.exit(1); });
