// node test/base-vault-verify.test.js -- tools/verify-base-vault.js against an in-memory chain: the good vault and every way to break it.
"use strict";
const assert = require("assert");
const fs = require("fs");
const { ethers } = require("ethers");
const core = require("../tools/base-vault-core");
const Flow = require("../tools/base-vault/flow");
const V = require("../tools/verify-base-vault");
const S = require("../collector-base-sweep-logic");
const { Chain, FakeProvider, MAIN, REG, REGISTRY_FAKE_CODE } = require("./base-vault-chain");

const IMPL = ethers.getCreateAddress({ from: MAIN, nonce: 0 });
const NFT = ethers.getCreateAddress({ from: MAIN, nonce: 1 });
const WRONG = "0x000000000000000000000000000000000000dEaD";
const OTHER_IMPL = "0x1111111111111111111111111111111111111111";
const FAKE_KECCAK = ethers.keccak256(REGISTRY_FAKE_CODE);

function good(mut) {
  const chain = new Chain({ mainNonce: 2 });
  const tba = chain.seedVault(IMPL, NFT, { split: 20 });
  if (mut) mut(chain, tba);
  return { chain, tba };
}
async function run(chain, args = []) {
  const out = [];
  const code = await V.run([`--nft=${NFT}`, ...args], { provider: new FakeProvider(chain), out: (s) => out.push(s), registryRuntimeKeccak: FAKE_KECCAK });
  return { code, text: out.join("\n") };
}

(async () => {
  // ---- 13/14/15. the good vault -------------------------------------------------------------------------------------
  {
    const origWrite = fs.writeFileSync; let writes = 0;
    fs.writeFileSync = (...a) => { writes++; return origWrite(...a); };
    const { chain, tba } = good();
    const r = await run(chain);
    fs.writeFileSync = origWrite;
    assert.strictEqual(r.code, 0, r.text);
    assert.strictEqual(writes, 0, "the verifier writes no file");
    assert.ok(r.text.includes("All checks passed"));
    assert.ok(!/FAIL/.test(r.text));
    assert.ok(/PENDING \(expected until the deferred step\)/.test(r.text));
    const json = JSON.parse(r.text.slice(r.text.indexOf("{\n"), r.text.indexOf("\n}\n") + 2));
    const v = json.baseSweep.vault;
    assert.deepStrictEqual(Object.keys(v), ["nft", "tokenId", "tba", "implementation", "registry", "salt", "expectedOwner", "splitPct", "maxSplitPct"]);
    assert.strictEqual(v.splitPct, 20); assert.strictEqual(v.maxSplitPct, 20); assert.strictEqual(v.tokenId, 1);
    const cfg = S.config({ vault: v }).vault;
    for (const k of ["tba", "nft", "tokenId", "implementation", "registry", "salt", "expectedOwner"]) assert.strictEqual(cfg[k], v[k], k);
    assert.strictEqual(v.tba, tba); assert.strictEqual(v.implementation, IMPL); assert.strictEqual(v.expectedOwner, MAIN);
    assert.ok(r.text.includes(`+const VAULT_IMPLEMENTATIONS = deepFreeze(["${IMPL}"]);`));
    assert.ok(r.text.includes("-const VAULT_IMPLEMENTATIONS = deepFreeze([]);"));
    assert.ok(r.text.includes("collector-base-sweep-security.test.js:21") && r.text.includes("collector-base-sweep-reverify.test.js:301"));
    assert.ok(r.text.includes("0xaDf94A20558E1E6d64c429F8F9f017169BF3d743"));
    assert.deepStrictEqual(S.VAULT_IMPLEMENTATIONS, []);
    // --impl cross-check, split option
    assert.strictEqual((await run(chain, [`--impl=${IMPL}`])).code, 0);
    assert.notStrictEqual((await run(chain, [`--impl=${OTHER_IMPL}`])).code, 0);
    const ten = good((c) => { c.nfts[NFT.toLowerCase()].split = 10; });
    const t1 = await run(ten.chain); assert.notStrictEqual(t1.code, 0); assert.ok(/FAIL.*feeSplitPct\(\) is 20 \(got 10\).*contract default/.test(t1.text));
    assert.strictEqual((await run(ten.chain, ["--expect-split=10"])).code, 0);
    // 15. allowlist
    const req = await run(chain, ["--require-allowlisted"]);
    assert.notStrictEqual(req.code, 0); assert.ok(/FAIL.*NOT in VAULT_IMPLEMENTATIONS/.test(req.text));
  }

  // ---- 13. every way to break it ----------------------------------------------------------------------------------------
  const cases = {
    "wrong ownerOf(1)": (c) => { c.nfts[NFT.toLowerCase()].owner1 = WRONG; },
    "wrong NFT.owner()": (c) => { c.nfts[NFT.toLowerCase()].owner = WRONG; },
    "implementation with a different runtime hash": (c) => { c.code[IMPL.toLowerCase()] = art6(); },
    "TBA proxy points at a different implementation": (c, tba) => { c.code[tba.toLowerCase()] = Flow.proxyCode(OTHER_IMPL, ethers.ZeroHash, 8453, NFT, 1); },
    "footer wrong chainId": (c, tba) => { c.code[tba.toLowerCase()] = Flow.proxyCode(IMPL, ethers.ZeroHash, 1, NFT, 1); },
    "footer wrong nft": (c, tba) => { c.code[tba.toLowerCase()] = Flow.proxyCode(IMPL, ethers.ZeroHash, 8453, WRONG, 1); },
    "footer wrong tokenId": (c, tba) => { c.code[tba.toLowerCase()] = Flow.proxyCode(IMPL, ethers.ZeroHash, 8453, NFT, 2); },
    "token() wrong chainId": (c, tba) => { c.tbas[tba.toLowerCase()].token = [1n, NFT, 1n]; },
    "token() wrong nft": (c, tba) => { c.tbas[tba.toLowerCase()].token = [8453n, WRONG, 1n]; },
    "token() wrong tokenId": (c, tba) => { c.tbas[tba.toLowerCase()].token = [8453n, NFT, 2n]; },
    "TBA.owner() is not Main": (c, tba) => { c.tbas[tba.toLowerCase()].owner = WRONG; },
    "registry.account mismatch": (c) => { c.regAccounts = {}; },
    "non-canonical registry": (c) => { c.nfts[NFT.toLowerCase()].registry = WRONG; },
    "registry code is not the canonical code": (c) => { c.code[REG.toLowerCase()] = "0x6080"; },
    "NFT runtime differs": (c) => { c.code[NFT.toLowerCase()] = core.expectedRuntime("nft", WRONG).hex; },
    "feeSplitPct != 20": (c) => { c.nfts[NFT.toLowerCase()].split = 5; },
    "paused": (c) => { c.nfts[NFT.toLowerCase()].paused = true; },
    "no code at TBA": (c, tba) => { delete c.code[tba.toLowerCase()]; },
    "wrong chainName": (c) => { c.nfts[NFT.toLowerCase()].chainName = "Arc"; },
  };
  function art6() { return "0x6080604052" + "cd".repeat(30); }
  for (const [name, mut] of Object.entries(cases)) {
    const { chain } = good(mut);
    const r = await run(chain);
    assert.notStrictEqual(r.code, 0, name);
    assert.ok(/FAIL/.test(r.text), name);
    assert.ok(!r.text.includes("All checks passed"), name);
    assert.ok(!r.text.includes("settings snippet"), name + " prints no snippet");
  }
  // RPC on another chain
  {
    const { chain } = good(); chain.chainId = 1;
    const r = await run(chain);
    assert.notStrictEqual(r.code, 0); assert.ok(/FAIL.*chain id is 8453/.test(r.text));
  }
  // missing --nft
  assert.strictEqual(await V.run([], { out: () => {} }), 1);
  console.log("base-vault-verify: ok");
})().catch((e) => { console.error(e); process.exit(1); });
