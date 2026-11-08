// node test/collector-base-sweep-docs.test.js -- acceptance 30, 31, 32 (the Robinhood files and the new tests) and 33: the README section, the pinned
// Robinhood files, discovery by run-all, and the read-only verify tool. Mocked chain, no network.
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const X = require("./lib/sweep-scene");

const { sweepScene, SL, USDC, WETH, CBBTC, LAPTOP, OP, OWNER, VAULT, lc } = X;
const ROOT = path.join(__dirname, "..");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, f))).digest("hex");

(async () => {
  // ---- 30. the README section
  {
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const start = readme.indexOf("\n## Sweep on Base");
    assert.ok(start > 0, "section 'Sweep on Base'");
    const section = readme.slice(start + 1, readme.indexOf("\n## ", start + 5));
    for (const word of ["**How to enable it.**", "**RISK.**", "**Caps and what stuck / held means.**", "**How to verify.**", "**Vault later.**", "**What it does.**"]) assert.ok(section.includes(word), `${word} in the section`);
    // how to enable
    for (const word of ["`baseSweep.enabled`", "boolean `true`", "--init-state", "setApprovalForAll", "both", "0x827922686190790b37229fd06084350E74485b72", "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53", "sweep-state.json", "simulate"]) assert.ok(section.includes(word), `${word} (enable)`);
    // the risk
    const risk = section.slice(section.indexOf("**RISK."), section.indexOf("**Caps and"));
    assert.ok(/operator key briefly holds the collected tokens and the swap proceeds/.test(risk.replace(/\s+/g, " ")) && /setApprovalForAll/.test(risk) && /\*\*every\*\* approved NFT/.test(risk.replace(/\s+/g, " ")), "the risk paragraph");
    // caps and stuck/held
    for (const k of Object.keys(SL.NUMBERS)) assert.ok(section.includes("`" + k + "`"), `${k} documented`);
    for (const word of ["`maxGasLimitByOp`", "`maxCollectsPerRun`", "**held**", "**stuck**", "**unattributed**", "**pending**", "exit code 1", "never redirected", "`routes.<WETH|cbBTC|LAPTOP>.enabled`"]) assert.ok(section.includes(word), `${word} (caps)`);
    // verify
    for (const word of ["`node tools/verify-base-sweep.js`", "node collector-base.js --mode=simulate", "read-only", "=== base sweep: N positions, delivered X USDC, Y tokens unswapped, Z stuck, gas G ETH ==="]) assert.ok(section.includes(word), `${word} (verify)`);
    // the vault
    for (const word of ["`baseSweep.vault.tba`", "`null`", "`splitPct`", "`maxSplitPct`", "hard maximum 20", "ERC-6551", "`expectedOwner`", "verified on chain at every run"]) assert.ok(section.includes(word), `${word} (vault)`);
    // every address and constant the section shows is the code constant
    for (const a of [SL.USDC, SL.ROUTER, SL.QUOTER, SL.FACTORY, ...Object.values(SL.ROUTES).flatMap((r) => [r.token, r.pool])]) assert.ok(section.includes(a), `${a} in the section`);
    for (const [k, d] of Object.entries(SL.NUMBERS)) assert.ok(new RegExp("`" + k + "` \\(" + String(d.def).replace(".", "\\.") + "[,)]").test(section), `${k} default ${d.def} stated`);
    // the old Base section is still there and the sweep ships off in the example
    assert.ok(readme.includes("## Auto-collect on Base"));
    assert.strictEqual(X.exampleRaw.baseSweep.enabled, false); assert.strictEqual(X.exampleRaw.baseSweep.vault.tba, null);
    // every key of the example is a known key
    const known = new Set([...Object.keys(SL.NUMBERS), "_comment", "enabled", "targetToken", "maxGasLimitByOp", "routes", "vault"]);
    for (const k of Object.keys(X.exampleRaw.baseSweep)) assert.ok(known.has(k), `example key ${k}`);
    // the example's numbers are the code defaults
    for (const [k, d] of Object.entries(SL.NUMBERS)) assert.strictEqual(X.exampleRaw.baseSweep[k], d.def, k);
    assert.strictEqual(X.exampleRaw.baseSweep.targetToken, USDC);
    // sweep-state.json is git-ignored
    const ig = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    assert.ok(/^sweep-state\.json$/m.test(ig), "sweep-state.json in .gitignore");
  }

  // ---- 31. the Robinhood files are untouched and pinned
  {
    const PIN = {
      "collector.js": "1dc8be8428e8dfc04b9178db6703d5129a79c53365955f4759560edf052ebb4f",
      "collector-swap.js": "1210326c2004c1b546a9b32fe87376e51c36572b9a7d63d7e9358290b9670b66",
      "treasury.js": "210d6460dfd4de96580dc92e10cc1e749b5880bfaa0aa8972a1ec328fb777d6b",
    };
    for (const [f, h] of Object.entries(PIN)) assert.strictEqual(sha(f), h, `${f} is byte-for-byte the Robinhood original`);
    const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "collector-golden", "hashes.json"), "utf8"));
    for (const f of ["collector.js", "collector-logic.js", "collector-swap.js", "collect-v4.js", "treasury.js"]) assert.strictEqual(sha(f), golden[f], `${f} equals hashes.json`);
    // git diff against the base commit is empty for the protected files (skipped where the commit is not available)
    let have = true;
    try { execFileSync("git", ["cat-file", "-e", "3103487^{commit}"], { cwd: ROOT, stdio: "ignore" }); } catch { have = false; }
    if (have) {
      const files = ["collector.js", "collector-logic.js", "collector-swap.js", "collect-v4.js", "treasury.js", "slipstream.js", "run-collector.sh", "test/fixtures/collector-golden"];
      const diff = execFileSync("git", ["diff", "3103487", "--", ...files], { cwd: ROOT, encoding: "utf8" });
      assert.strictEqual(diff, "", "git diff 3103487 on the Robinhood files is empty");
    }
    // the sweep is never started by a CLI argument: the wiring has no such flag
    const base = fs.readFileSync(path.join(ROOT, "collector-base.js"), "utf8");
    assert.ok(!/process\.argv[^\n]*sweep/i.test(base) && !/--sweep|LP_SWEEP/i.test(base), "no CLI flag or environment switch for the sweep");
    assert.ok(!/LP_READONLY/.test(base.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "")));
    for (const f of ["server.js", "slipstream.js", "watch.js", "claim-fees-target.js", "chain-router.js"]) assert.ok(!/collector-base-sweep/.test(fs.readFileSync(path.join(ROOT, f), "utf8")), `${f} does not import the sweep`);
    // the new modules read no keystore and build no signer
    for (const f of ["collector-base-sweep.js", "collector-base-sweep-logic.js"]) assert.ok(!/keystore|fromEncryptedJson|Wallet\b|getSigner|signTransaction|broadcastTransaction/i.test(fs.readFileSync(path.join(ROOT, f), "utf8")), `${f} has no signing`);
  }

  // ---- 32. discovered by run-all
  {
    const found = fs.readdirSync(__dirname).filter((f) => f.endsWith(".test.js") && /^collector-base-sweep-/.test(f));
    assert.ok(found.length >= 6, found.join(","));
    const runAll = fs.readFileSync(path.join(__dirname, "run-all.js"), "utf8");
    assert.ok(/readdirSync\(DIR\)/.test(runAll) && /endsWith\("\.test\.js"\)/.test(runAll), "run-all.js discovers *.test.js files rather than listing them");
  }

  // ---- 33. tools/verify-base-sweep.js is read-only and reports ok / FAIL
  {
    const src = fs.readFileSync(path.join(ROOT, "tools", "verify-base-sweep.js"), "utf8");
    assert.ok(!/Wallet|keystore|signTransaction|getSigner|sendTransaction|broadcastTransaction|fromEncryptedJson|LP_KEYSTORE|PRIVATE|\.sign\(/i.test(src), "no signer and no keystore import");
    const { run } = require("../tools/verify-base-sweep");
    const S = sweepScene({ positions: [] });
    const good = await run(S.w.runner);
    assert.strictEqual(good.bad, 0, good.lines.join("\n"));
    const text = good.lines.join("\n");
    assert.ok(/ok {4}SwapRouter02 0x2626664c2603336E57B271c5C0b26F421741e481 \d+ bytes/.test(text) && /ok {4}QuoterV2/.test(text) && /ok {4}Uniswap v3 factory/.test(text) && /ok {4}USDC decimals\(\) is 6/.test(text));
    for (const sym of ["WETH", "cbBTC", "LAPTOP"]) assert.ok(text.includes(`route ${sym} -> USDC`), sym);
    assert.ok(/ok {4}factory\.getPool == 0xd0b53D9277642d899DF5C87A3966A349A798F224; pool\.factory\(\), token0\/token1 and fee\(\) agree/.test(text));
    assert.ok(/ok {4}probe quote [\d.]+ USDC/.test(text) && /ok {4}\d+ s TWAP tick/.test(text));
    assert.ok(/ok {4}vault\.tba is null: the split is 0%/.test(text)); assert.ok(text.includes("All checks passed."));
    assert.strictEqual(S.w.broadcasts.length, 0); assert.strictEqual(S.w.estimates.length, 0, "no gas estimate either: eth_call and eth_getCode only");

    // each broken fact is a FAIL line
    const breaks = [
      ["factory differs", { getPool: () => "0x00000000000000000000000000000000000000ee" }, null, /FAIL {2}route proof: factory\.getPool\(WETH, USDC, 500\)/],
      ["no code at the router", {}, (s) => { delete s.w.code[lc(SL.ROUTER)]; }, /FAIL {2}SwapRouter02 .* has NO CODE/],
      ["pool.fee differs", {}, (s) => { s.pools.cbBTC.feeActual = 100; }, /FAIL {2}route proof: pool\.fee\(\) is 100, not 500/],
      ["observe reverts", {}, (s) => { s.pools.LAPTOP.observeFails = true; }, /FAIL {2}observe\(\[1800, 0\]\) reverts: too little oracle cardinality/],
      ["thin pool", { poolUsdc: 100n * 10n ** 6n }, null, /FAIL {2}pool USDC balance 100\.0 \(minPoolUsdc 2000\)/],
      ["USDC decimals", { usdcDecimals: 18 }, null, /FAIL {2}USDC decimals\(\) is 18 \(must be 6\)/],
    ];
    for (const [name, so, mutate, re] of breaks) {
      const B = sweepScene({ positions: [], ...so }); if (mutate) mutate(B);
      const r = await run(B.w.runner);
      assert.ok(r.bad > 0 && re.test(r.lines.join("\n")), `${name}\n${r.lines.join("\n")}`);
    }
    // the vault block: a verified vault is ok, a broken one FAIL, the Robinhood TBA (no code) FAIL
    const V = sweepScene({ positions: [] }); const vcfg = V.vault({});
    const vr = await run(V.w.runner, { vault: vcfg, owners: [vcfg.expectedOwner] });
    assert.strictEqual(vr.bad, 0, vr.lines.join("\n")); assert.ok(vr.lines.join("\n").includes(`vault ${VAULT.tba} verified; effective split 10%`));
    const V2 = sweepScene({ positions: [] }); const v2 = V2.vault({ tbaOwner: "0x00000000000000000000000000000000000000ee" });
    const vr2 = await run(V2.w.runner, { vault: v2, owners: [v2.expectedOwner] }); assert.ok(vr2.bad === 1 && /FAIL {2}vault refused: tba\.owner\(\) is/.test(vr2.lines.join("\n")));
    const V3 = sweepScene({ positions: [] }); const v3 = V3.vault({ cfg: { tba: "0x4941943B0a3860f07767d8918Cce50D8451b340B" }, tbaCode: false });
    const vr3 = await run(V3.w.runner, { vault: v3, owners: [v3.expectedOwner] }); assert.ok(vr3.bad === 1 && /FAIL {2}vault refused: tba 0x4941943B0a3860f07767d8918Cce50D8451b340B has no code/.test(vr3.lines.join("\n")));
    // the CLI is not run here (it would use the network); it exits through main() only when executed directly
    assert.ok(/require\.main === module/.test(src));
  }
  console.log("collector-base-sweep-docs tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
