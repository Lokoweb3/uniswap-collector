// node test/collector-base.test.js -- collector-base.js on a mocked Base (no network, no real key, no keystore):
// opt-in flags, the isApprovedForAll gate, thresholds and caps, owner-only recipient, simulate, chain check.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const { TICK, TMP, OWNER, W11, MGR_A, MGR_B, FAC_A, FAC_B, ID_A, ID_B, EVIL, E18, OP, iface, exampleRaw, cfgOf, enableMain, scene, fakeSigner, pass } = require("./lib/base-scene"); // sets LP_DATA_DIR first
const u = require("../univ3");
const settings = require("../settings");
const L = require("../collector-base-logic");
const { skipLine, MANAGER_ABI, ORACLE_ABI, MAX128 } = require("../collector-base");
const { hermeticEnv, hermeticCwd } = require("./lib/hermetic");

const writes = (w, signer) => w.estimates.length + (signer ? signer.sent.length : 0) + w.calls.filter((c) => c.name === "collect").length;
const forbiddenCalls = (w) => w.calls.filter((c) => /^(approve|setApprovalForAll|safeTransferFrom|transferFrom|transfer|swap|safeTransfer)/i.test(c.name) || !["ownerOf", "isApprovedForAll", "collect", "balanceOf", "tokenOfOwnerByIndex", "positions", "getL1Fee"].includes(c.name) && !/^(getPool|slot0|symbol|decimals|voter|isAlive|gauge|nft|rewardToken|stakedValues|stakedContains|earned|token0|getReserves)$/.test(c.name));

(async () => {
  // ---- 3. collect:false everywhere (the shipped example) -> nothing at all
  {
    const cfg = cfgOf();
    assert.strictEqual(exampleRaw.wallets.main.collect, false);
    assert.ok(exampleRaw.wallets.watched.length >= 2 && exampleRaw.wallets.watched.every((x) => x.collect === false), "every watched wallet ships collect:false");
    assert.strictEqual(cfg.ownerCollect, false);
    assert.ok(L.owners(cfg).every((x) => !x.enabled));
    assert.deepStrictEqual(L.limits(cfg.baseCollect), { minFeesUsd: 2, minFeesToGasRatio: 5, maxGasPerRunEth: 0.0003, maxGasPriceGwei: 1, maxCollectsPerRun: 6, dailyGasCapEth: 0.001, maxGasPerTxEth: 0.0002, maxGasLimit: 500000, maxPriorityFeeGwei: 0.01, waitTimeoutSec: 120, minL1AllowanceEth: 0.00002 }, "the example carries the defaults");
    assert.deepStrictEqual(L.limits(cfg.baseCollect), L.limits(undefined));
    const w = scene();
    const r = await pass(w, { cfg });
    assert.strictEqual(w.calls.length, 0, "no contract read at all");
    assert.strictEqual(writes(w, r.signer), 0);
    assert.strictEqual(r.signerCalls(), 0, "no key requested");
    assert.ok(/Trading \(0xaDf94A20558E1E6d64c429F8F9f017169BF3d743\): collect is not enabled/.test(r.text), r.text);
    assert.ok(/no wallet has collect:true/.test(r.text));
    assert.ok(r.lines.includes(`Operator: ${OP}`), "the operator address is shown even when nothing is enabled (README step)");
    assert.strictEqual(r.res.collected, 0);
    // the file on disk is the example: a run against settings.base.example.json parsed from disk does the same
    const disk = settings.load({ file: path.join(__dirname, "..", "settings.base.example.json") });
    const w2 = scene(); const r2 = await pass(w2, { cfg: disk });
    assert.strictEqual(w2.calls.length, 0); assert.strictEqual(r2.signer.sent.length, 0);
    // a watched wallet alone enabled: still only that wallet
    const w3 = scene({ approved: { [MGR_A]: false, [MGR_B]: false } });
    const r3 = await pass(w3, { cfg: cfgOf((raw) => { raw.wallets.watched[0].collect = true; }) });
    assert.ok(/--- Wallet 11 \(/.test(r3.text) && !/--- Trading/.test(r3.text), r3.text);
    assert.ok(/Trading .* collect is not enabled/.test(r3.text));
    // collect must be the boolean true
    const w4 = scene(); const r4 = await pass(w4, { cfg: cfgOf((raw) => { raw.wallets.main.collect = "true"; }) });
    assert.strictEqual(w4.calls.length, 0); assert.ok(/collect is not enabled/.test(r4.text));
  }

  // ---- 4. enabled but the operator is not approved: the exact SKIP line, nothing else
  {
    const w = scene({ approved: { [MGR_A]: false, [MGR_B]: false } });
    const r = await pass(w, { cfg: cfgOf(enableMain) });
    const expectA = `SKIP aerodrome-v1 Trading ${OWNER}: operator ${OP} is not approved for all on ${MGR_A} (isApprovedForAll=false); no transaction sent, no approval requested`;
    const expectB = `SKIP aerodrome-cl2 Trading ${OWNER}: operator ${OP} is not approved for all on ${MGR_B} (isApprovedForAll=false); no transaction sent, no approval requested`;
    assert.ok(r.lines.includes(expectA), r.text); assert.ok(r.lines.includes(expectB), r.text);
    assert.strictEqual(skipLine({ manager: { name: "aerodrome-v1", positionManager: MGR_A }, owner: { label: "Trading", address: OWNER }, operator: OP }), expectA);
    assert.strictEqual(w.estimates.length, 0, "no estimateGas"); assert.strictEqual(r.signer.sent.length, 0, "no sendTransaction");
    assert.strictEqual(w.calls.filter((c) => c.name === "collect").length, 0, "no staticCall collect");
    assert.strictEqual(w.calls.filter((c) => c.name === "positions" || c.name === "balanceOf").length, 0, "positions not even read");
    assert.deepStrictEqual(forbiddenCalls(w), [], "no approval or write call of any kind");
    assert.deepStrictEqual([...new Set(w.calls.map((c) => c.name))], ["isApprovedForAll"]);
    assert.strictEqual(r.signerCalls(), 0, "the key is never asked for");
    assert.strictEqual(r.res.collected, 0);
    // per-token approval is not accepted: getApproved is not even in the ABI
    assert.ok(!MANAGER_ABI.join(" ").includes("getApproved"));
  }

  // ---- 5. approved on A only
  {
    const w = scene({ approved: { [MGR_B]: false } });
    const r = await pass(w, { cfg: cfgOf(enableMain) });
    assert.strictEqual(r.signer.sent.length, 1);
    assert.strictEqual(r.signer.sent[0].to, MGR_A);
    assert.ok(r.lines.some((l) => l.startsWith("SKIP aerodrome-cl2 Trading")), r.text);
    assert.ok(r.lines.some((l) => new RegExp(`^#${ID_A} WETH / USDC fees \\$[\\d.]+ gas \\$[\\d.]+ -> collect:`).test(l)), r.text);
    assert.ok(!r.lines.some((l) => l.startsWith(`#${ID_B}`)), "nothing is read for the unapproved manager");
  }

  // ---- 6. approved: one collect per qualifying position, to the owner, signed by the operator
  {
    const w = scene();
    const r = await pass(w, { cfg: cfgOf(enableMain) });
    assert.strictEqual(r.signer.sent.length, 2, r.text);
    for (const [i, [mgr, id]] of [[MGR_A, ID_A], [MGR_B, ID_B]].entries()) {
      const s = r.signer.sent[i];
      assert.strictEqual(s.from, OP, "signed by the operator key"); assert.strictEqual(s.to, mgr); assert.strictEqual(s.value, 0n); assert.strictEqual(s.chainId, 8453n);
      const d = iface.parseTransaction({ data: s.data });
      assert.strictEqual(d.name, "collect");
      assert.strictEqual(d.args[0].tokenId, BigInt(id)); assert.strictEqual(d.args[0].recipient, OWNER);
      assert.strictEqual(d.args[0].amount0Max, MAX128); assert.strictEqual(d.args[0].amount1Max, MAX128); assert.strictEqual(MAX128, 2n ** 128n - 1n);
      assert.strictEqual(s.data, iface.encodeFunctionData("collect", [{ tokenId: BigInt(id), recipient: OWNER, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }]));
    }
    // the simulation and the estimate came from the operator
    assert.ok(w.estimates.every((e) => e.from === OP.toLowerCase() && e.name === "collect"));
    assert.deepStrictEqual(forbiddenCalls(w), []);
    assert.strictEqual(r.res.collected, 2);
    assert.ok(/=== base collect mode=collect chainId=8453 ===/.test(r.lines[0]));
    assert.ok(/^--- Trading \(0xaDf94A20558E1E6d64c429F8F9f017169BF3d743\) ---$/.test(r.lines.find((l) => l.startsWith("---"))));
    assert.ok(r.lines.some((l) => /^  collected #79371151 to 0xaDf9.* tx 0x[0-9a-f]{64}, simulated amounts \d+ \/ \d+ \(raw\), gas used 120000, paid 0\.000026 ETH$/.test(l)), r.text);
    assert.ok(/^=== base done: 2 collected, 0 skipped, gas 0\.000052 ETH ===$/.test(r.lines[r.lines.length - 1]), r.lines[r.lines.length - 1]);
    // spend recorded for the rolling cap
    assert.strictEqual(r.state.gasSpends.length, 2); assert.ok(r.state.gasSpends.every((e) => e.kind === "settled" && /^0x[0-9a-f]{64}$/.test(e.tx)));
    assert.strictEqual(r.saved.length, 6, "reservation, hash and settlement per send");
    assert.strictEqual(BigInt(r.state.gasSpends[0].wei), 120_000n * 50_000_000n + 20_000_000_000_000n);

    // ownerOf at send time differs from the configured owner -> no send
    const w2 = scene({ ownerAt: (mgr, n) => (mgr === MGR_A && n >= 3 ? EVIL : OWNER) }); // call 1 is the reader's, 2 the decision's, 3 the one just before sending
    const r2 = await pass(w2, { cfg: cfgOf(enableMain) });
    assert.strictEqual(r2.signer.sent.length, 1, r2.text); assert.strictEqual(r2.signer.sent[0].to, MGR_B);
    assert.ok(r2.lines.some((l) => l.includes(`ownerOf changed to ${ethers.getAddress(EVIL)} just before sending`)), r2.text);
    // owner already different when the position is read
    const w3 = scene({ ownerAt: (mgr, n) => (mgr === MGR_A ? EVIL : OWNER) });
    const r3 = await pass(w3, { cfg: cfgOf(enableMain) });
    assert.strictEqual(r3.signer.sent.length, 1);
    assert.ok(r3.lines.some((l) => l.includes(`ownerOf is ${ethers.getAddress(EVIL)}, not the configured owner`)), r3.text);
    // a failed send may still have been broadcast: the worst case stays counted and the run stops
    const w4 = scene();
    const r4 = await pass(w4, { cfg: cfgOf(enableMain), signer: fakeSigner(w4, { failFirst: true }) });
    assert.strictEqual(r4.signer.sent.length, 0); assert.ok(r4.lines.some((l) => /broadcast failed \(nonce too low\); not ruled out that it was sent/.test(l)), r4.text);
    assert.strictEqual(r4.res.collected, 0); assert.strictEqual(r4.res.aborted, true); assert.strictEqual(r4.state.gasSpends[0].kind, "reserved");
    // a collect mined as reverted still cost gas: recorded, not counted as collected
    const w5 = scene();
    const r5 = await pass(w5, { cfg: cfgOf(enableMain), signer: fakeSigner(w5, { status: 0 }) });
    assert.ok(r5.lines.some((l) => /collect reverted on-chain/.test(l)));
    assert.strictEqual(r5.res.collected, 0); assert.strictEqual(r5.state.gasSpends.length, 2);
    // the unlocked key must be the operator whose approval was checked
    const w6 = scene();
    const other = fakeSigner(w6); other.address = EVIL;
    const r6 = await pass(w6, { cfg: cfgOf(enableMain), signer: other });
    assert.strictEqual(other.sent.length, 0); assert.ok(/not the operator whose approval was checked/.test(r6.text));
    // a key that cannot be unlocked: asked for once, nothing sent
    const w7 = scene(); let asked = 0;
    const r7 = await pass(w7, { cfg: cfgOf(enableMain), getSigner: async () => { asked++; throw new Error("invalid password"); } });
    assert.strictEqual(asked, 1, "a failed unlock is not retried per position"); assert.strictEqual(r7.res.collected, 0);
  }

  // ---- 7. staked, feesOk:false, below threshold: each with its own reason
  {
    const w = scene({ stakedA: true });
    const r = await pass(w, { cfg: cfgOf(enableMain) });
    assert.ok(r.lines.some((l) => l.startsWith(`#${ID_A} `) && /-> skip: staked in a gauge/.test(l)), r.text);
    assert.strictEqual(r.signer.sent.length, 1); assert.strictEqual(r.signer.sent[0].to, MGR_B);

    const wf = scene({ feesFail: true });
    const rf = await pass(wf, { cfg: cfgOf(enableMain) });
    assert.ok(rf.lines.some((l) => l.startsWith(`#${ID_A} `) && /-> skip: fees could not be read \(collect failed\)/.test(l)), rf.text);
    assert.strictEqual(rf.signer.sent.length, 1);

    const wl = scene({ fees: { [MGR_A]: [1n * 10n ** 14n, 100_000n] } }); // $0.2 + $0.1
    const rl = await pass(wl, { cfg: cfgOf(enableMain) });
    assert.ok(rl.lines.some((l) => l.startsWith(`#${ID_A} `) && /-> skip: below minFeesUsd/.test(l)), rl.text);
    assert.strictEqual(rl.signer.sent.length, 1);

    // fees below 5x gas: an expensive gas estimate
    const wg = scene(); wg.l1Fee = 10n ** 15n; // an L1 quote of 0.001 ETH = $2 per collect: fees $9 < 5 x $2
    const rg = await pass(wg, { cfg: cfgOf(enableMain, { maxGasPerTxEth: 0.01, maxGasPerRunEth: 0.1, dailyGasCapEth: 0.1 }) });
    assert.ok(rg.lines.some((l) => /-> skip: fees < 5x gas/.test(l)), rg.text);
    assert.strictEqual(rg.signer.sent.length, 0);

    // unpriced: no ETH/USD -> everything skipped, fail closed
    const wu = scene();
    const ru = await pass(wu, { cfg: cfgOf(enableMain), ethUsd: null });
    assert.ok(/ETH\/USD is unavailable/.test(ru.text)); assert.strictEqual(ru.signer.sent.length, 0); assert.strictEqual(wu.estimates.length, 0);
  }

  // ---- caps, end to end
  {
    const w = scene();
    const r = await pass(w, { cfg: cfgOf(enableMain, { maxCollectsPerRun: 1 }) });
    assert.strictEqual(r.signer.sent.length, 1);
    assert.ok(r.lines.some((l) => /-> skip: maxCollectsPerRun 1 reached/.test(l)), r.text);
    const wg = scene(); wg.block = { baseFeePerGas: 2_000_000_000n }; // a base fee of 2 gwei against a 1 gwei cap
    const rg = await pass(wg, { cfg: cfgOf(enableMain) });
    assert.strictEqual(rg.signer.sent.length, 0); assert.ok(/base fee 2 gwei .*exceeds maxGasPriceGwei 1 \(cap 1 gwei\)/.test(rg.text), rg.text);
    const wr = scene();
    const rr = await pass(wr, { cfg: cfgOf(enableMain, { maxGasPerRunEth: 0.00005 }) }); // one worst case is ~0.0000314 ETH (incl. the L1 floor), the first settles at 0.000026: the second would pass 0.00005
    assert.strictEqual(rr.signer.sent.length, 1); assert.ok(/maxGasPerRunEth 0\.00005 ETH would be exceeded/.test(rr.text), rr.text);
    const wd = scene();
    const rd = await pass(wd, { cfg: cfgOf(enableMain), state: { gasSpends: [{ t: Date.now() - 3600_000, wei: String(ethers.parseUnits("0.000995", 18)) }] } });
    assert.strictEqual(rd.signer.sent.length, 0); assert.ok(/24 h gas cap 0\.001 ETH would be exceeded/.test(rd.text), rd.text);
  }

  // ---- 8. simulate: nothing sent, no key, same decision lines marked (simulate)
  {
    const w = scene();
    const sim = await pass(w, { cfg: cfgOf(enableMain), mode: "simulate", getSigner: async () => { throw new Error("simulate must not unlock a key"); } });
    assert.strictEqual(sim.signer.sent.length, 0); assert.strictEqual(sim.res.collected, 0); assert.strictEqual(sim.res.wouldCollect, 2);
    assert.strictEqual(sim.saved.length, 0, "no state written");
    const real = await pass(scene(), { cfg: cfgOf(enableMain) });
    const decisions = (lines) => lines.filter((l) => l.startsWith("#")).map((l) => l.replace(/ \(simulate\)$/, "").replace(/ -> collect: (.*?)(; not sent)?$/, " -> collect: $1"));
    assert.deepStrictEqual(decisions(sim.lines), decisions(real.lines));
    assert.ok(sim.lines.filter((l) => l.startsWith("#")).every((l) => / \(simulate\)$/.test(l)), sim.text);
    assert.ok(/mode=simulate/.test(sim.lines[0]) && /\(simulate: 2 would collect, nothing sent\)/.test(sim.lines[sim.lines.length - 1]));
    // no keystore: skipped with a line, not an error
    const none = await pass(scene(), { cfg: cfgOf(enableMain), mode: "simulate", operatorAddress: null });
    assert.ok(/no keystore with a public address/.test(none.text)); assert.ok(!none.res.aborted);
    const wn = scene();
    const noneCollect = await pass(wn, { cfg: cfgOf(enableMain), operatorAddress: null });
    assert.ok(noneCollect.res.aborted && wn.calls.length === 0);
  }

  // ---- 9. wrong chain: abort before any position is read
  {
    const w = scene({ chainId: 1n });
    const r = await pass(w, { cfg: cfgOf(enableMain) });
    assert.ok(r.res.aborted && /ABORT: the RPC reports chainId 1/.test(r.text), r.text);
    assert.strictEqual(w.calls.length, 0); assert.strictEqual(writes(w, r.signer), 0); assert.strictEqual(r.signerCalls(), 0);
    const w2 = scene();
    const bad = cfgOf(enableMain); bad.chainId = 1;
    const r2 = await pass(w2, { cfg: bad });
    assert.ok(r2.res.aborted && /ABORT: settings chainId is 1/.test(r2.text)); assert.strictEqual(w2.calls.length, 0);
    // the CLI refuses a non-Base settings file before touching any network
    const dir = hermeticCwd();
    const raw = JSON.parse(JSON.stringify(exampleRaw)); raw.chain.chainId = 1; raw.chain.rpcUrl = "https://rpc.invalid.example"; raw.wallets.main.collect = true;
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(raw));
    const run = spawnSync(process.execPath, [path.join(__dirname, "..", "collector-base.js"), "--mode=simulate"], { cwd: dir, env: hermeticEnv({ LP_DATA_DIR: dir, LP_READONLY: "1" }), encoding: "utf8", timeout: 30000 });
    assert.strictEqual(run.status, 1, run.stdout + run.stderr); assert.ok(/ABORT: settings chainId is 1/.test(run.stdout), run.stdout + run.stderr);
    assert.ok(fs.existsSync(path.join(dir, "collector.log")), "the Base pass logs into its own data dir");
  }

  // ---- allowlist: a configured manager that is not one of the two is never used
  {
    const w = scene();
    const cfg = cfgOf((raw) => { enableMain(raw); raw.contracts.slipstream.push({ name: "evil", positionManager: EVIL, factory: FAC_A }); });
    const r = await pass(w, { cfg });
    assert.ok(r.lines.some((l) => l.includes(`manager ${EVIL} is not on the allowlist`)), r.text);
    assert.ok(!w.calls.some((c) => c.to === EVIL.toLowerCase()) && !r.signer.sent.some((s) => s.to === EVIL));
  }

  // ---- the ETH/USD path main() uses: the Uniswap v3 reference pool of the Base settings
  {
    const w = scene();
    const cfg = cfgOf(enableMain);
    const REF_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
    w.on(cfg.contracts.factory, "getPool", () => [REF_POOL]);
    // Uniswap v3's slot0 has seven outputs (the shared mock's Slipstream one has six): answer that pool by hand
    const v3Pool = new ethers.Interface(u.POOL_ABI);
    const runner = Object.create(w.runner);
    runner.call = (tx) => (tx.to.toLowerCase() === REF_POOL.toLowerCase()
      ? v3Pool.encodeFunctionResult("slot0", [u.getSqrtRatioAtTick(TICK), BigInt(TICK), 0n, 1n, 1n, 0n, true])
      : w.runner.call(tx));
    const usd = await require("../collector-base").ethUsdOf(cfg, runner)();
    assert.ok(usd > 1900 && usd < 2100, `WETH priced at ${usd}`);
    assert.strictEqual(w.callsTo(cfg.contracts.factory, "getPool").length, 1);
  }

  // ---- 10. swaps impossible: static scan and the ABI
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "collector-base.js"), "utf8");
    const logicSrc = fs.readFileSync(path.join(__dirname, "..", "collector-base-logic.js"), "utf8");
    for (const [name, text] of [["collector-base.js", src], ["collector-base-logic.js", logicSrc]]) {
      const hit = /swap|exactInput|approve\(|setApprovalForAll|transfer|safeTransfer|decreaseLiquidity|burn|withdraw|deposit|exactOutput|Router|Quoter/i.exec(text);
      assert.ok(!hit, `${name} mentions ${hit && hit[0]}`);
    }
    assert.strictEqual(MANAGER_ABI.length, 3);
    assert.strictEqual(ORACLE_ABI.length, 1); assert.deepStrictEqual(new ethers.Interface(ORACLE_ABI).fragments.map((f) => f.name), ["getL1Fee"]);
    assert.ok(src.split("\n").filter((l) => /"function /.test(l)).length === 4, "three manager strings and one oracle string");
    assert.deepStrictEqual(new ethers.Interface(MANAGER_ABI).fragments.map((f) => f.name).sort(), ["collect", "isApprovedForAll", "ownerOf"]);
    assert.ok(src.split("\n").filter((l) => /^\s*"function /.test(l)).length === 3, "exactly three ABI strings in the file");
    assert.ok(!/gasPrice\s*:/.test(src), "no gasPrice key is ever built");
    assert.ok(/signer\.signTransaction\(txFields\)/.test(src) && /logic\.assertSignable\(txFields, lim, \{/.test(src), "the signed object is the asserted one");
    assert.ok(!/sendTransaction/.test(src), "no send through the signer");
    assert.strictEqual((src.match(/\.signTransaction\(/g) || []).length, 1); assert.strictEqual((src.match(/\.broadcastTransaction\(/g) || []).length, 1);
    // the only transaction it builds is collect
    assert.ok((src.match(/encodeFunctionData\("([a-zA-Z]+)"/g) || []).length === 1 && /encodeFunctionData\("collect"/.test(src));
    // it does not consult LP_READONLY, and the server never imports it
    assert.ok(!/LP_READONLY/.test(src.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "")), "collector-base.js does not read LP_READONLY");
    for (const f of ["server.js", "slipstream.js", "watch.js", "claim-fees-target.js"]) assert.ok(!/collector-base/.test(fs.readFileSync(path.join(__dirname, "..", f), "utf8")), `${f} does not import collector-base`);
  }
  // ---- S6: the passphrase is cleared from the environment on success AND on failure; the keystore here is a throwaway one
  {
    const { unlockSigner } = require("../collector-base");
    const ks = path.join(fs.mkdtempSync(path.join(TMP, "ks-")), "ks.json");
    fs.writeFileSync(ks, await ethers.encryptKeystoreJson(ethers.Wallet.createRandom(), "right", { scrypt: { N: 16 } }));
    const good = { LP_KEYSTORE_PATH: ks, LP_KEYSTORE_PASS: "right" };
    const signer = await unlockSigner(null, good);
    assert.ok(signer.address); assert.ok(!("LP_KEYSTORE_PASS" in good), "cleared after success");
    const wrong = { LP_KEYSTORE_PATH: ks, LP_KEYSTORE_PASS: "wrong" };
    await assert.rejects(() => unlockSigner(null, wrong)); assert.ok(!("LP_KEYSTORE_PASS" in wrong), "cleared after a failed decrypt");
    const nofile = { LP_KEYSTORE_PATH: path.join(TMP, "missing.json"), LP_KEYSTORE_PASS: "x" };
    await assert.rejects(() => unlockSigner(null, nofile)); assert.ok(!("LP_KEYSTORE_PASS" in nofile), "cleared when the file cannot be read");
    await assert.rejects(() => unlockSigner(null, {}), /must be set/);
  }
  console.log("collector-base tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
