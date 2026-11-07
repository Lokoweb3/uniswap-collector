// node test/collector-base.test.js -- collector-base.js on a mocked Base (no network, no real key, no keystore):
// opt-in flags, the isApprovedForAll gate, thresholds and caps, owner-only recipient, simulate, chain check.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-base-collect-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const u = require("../univ3");
const settings = require("../settings");
const L = require("../collector-base-logic");
const { runPass, skipLine, MANAGER_ABI, MAX128, makeReaders } = require("../collector-base");
const { world, revert } = require("./fixtures/mock-chain");
const { hermeticEnv, hermeticCwd } = require("./lib/hermetic");

const OWNER = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743", W11 = "0xFc1235E6523Becf4b329ed9ADf21750cfAF65Bfb";
const MGR_A = "0x827922686190790b37229fd06084350E74485b72", MGR_B = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53";
const FAC_A = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", FAC_B = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef";
const WETH = "0x4200000000000000000000000000000000000006", USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POOL_A = "0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1", POOL_B = "0x99cf3E8bfB02c300312c53Aac5D0B082e3D5975C";
const GAUGE = "0x41b2126661C673C2beDd208cC72E85DC51a5320a", VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5", AERO_POOL = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631", POOL_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const ID_A = 79371151, ID_B = 8905958, TICK = -200300, E18 = 10n ** 18n;
const EVIL = "0x00000000000000000000000000000000000000ee";
const iface = new ethers.Interface(MANAGER_ABI);
const exampleRaw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "settings.base.example.json"), "utf8"));
const cfgOf = (mutate = () => {}, baseCollect) => {
  const raw = JSON.parse(JSON.stringify(exampleRaw));
  mutate(raw);
  if (baseCollect) raw.baseCollect = baseCollect;
  return settings.toLegacy(raw);
};
const enableMain = (r) => { r.wallets.main.collect = true; };

// the operator: a throwaway key, never the real one
const operatorKey = ethers.Wallet.createRandom();
const OP = operatorKey.address;

/** A mocked Base: two managers, one unstaked position each, owned by OWNER unless `o` says otherwise. */
function scene(o = {}) {
  const w = world();
  const approved = { [MGR_A]: true, [MGR_B]: true, ...(o.approved || {}) };
  const fees = { [MGR_A]: [2n * 10n ** 15n, 5_000_000n], [MGR_B]: [3n * 10n ** 15n, 1_000_000n], ...(o.fees || {}) };
  const ownerCalls = { [MGR_A]: 0, [MGR_B]: 0 };
  for (const [a, s, d] of [[WETH, "WETH", 18], [USDC, "USDC", 6], [AERO, "AERO", 18]]) w.on(a, "symbol", () => [s]).on(a, "decimals", () => [d]);
  w.on(POOL_FACTORY, "getPool", () => [AERO_POOL]).on(AERO_POOL, "token0", () => [AERO]).on(AERO_POOL, "getReserves", () => [1000n * E18, 600n * 10n ** 6n, 0n]);
  w.contract(GAUGE).contract(POOL_A).contract(POOL_B).contract(MGR_A).contract(MGR_B);
  const POS = (liq) => [0n, ethers.ZeroAddress, WETH, USDC, 100n, BigInt(TICK - 700), BigInt(TICK + 700), BigInt(liq), 0n, 0n, 0n, 0n];
  const dex = (mgr, fac, pool, id, holder) => {
    w.on(fac, "getPool", () => [pool]).on(fac, "voter", () => [VOTER]);
    w.on(pool, "slot0", () => [u.getSqrtRatioAtTick(TICK), BigInt(TICK), 0n, 1n, 1n, true]).on(pool, "gauge", () => [GAUGE]);
    w.on(mgr, "balanceOf", (who) => [who.toLowerCase() === OWNER.toLowerCase() && holder === OWNER ? 1n : 0n]).on(mgr, "tokenOfOwnerByIndex", () => [BigInt(id)]);
    w.on(mgr, "ownerOf", (x) => {
      if (BigInt(x) !== BigInt(id)) throw revert("nonexistent");
      ownerCalls[mgr]++;
      return [o.ownerAt ? o.ownerAt(mgr, ownerCalls[mgr]) : holder];
    });
    w.on(mgr, "positions", () => POS(5n * 10n ** 15n));
    w.on(mgr, "isApprovedForAll", (owner, op) => [approved[mgr] && op.toLowerCase() === OP.toLowerCase()]);
    w.on(mgr, "collect", (params, tx) => {
      // the owner's estimate (the reader) always works; the operator's simulation needs the approval
      if (tx && tx.from && tx.from.toLowerCase() === OP.toLowerCase() && !approved[mgr]) throw revert("Not approved");
      if (o.feesFail && mgr === MGR_A && tx && tx.from && tx.from.toLowerCase() !== OP.toLowerCase()) throw revert("collect failed");
      return fees[mgr];
    });
  };
  w.on(VOTER, "isAlive", () => [false]);
  w.on(GAUGE, "nft", () => [MGR_A]).on(GAUGE, "rewardToken", () => [AERO]).on(GAUGE, "stakedValues", () => [o.stakedA ? [BigInt(ID_A)] : []]);
  w.on(GAUGE, "stakedContains", () => [!!o.stakedA]).on(GAUGE, "earned", () => { throw revert("NA"); });
  dex(MGR_A, FAC_A, POOL_A, ID_A, o.stakedA ? GAUGE : OWNER);
  dex(MGR_B, FAC_B, POOL_B, ID_B, OWNER);
  if (o.chainId) w.chainId = o.chainId;
  if (o.gasEstimate !== undefined) w.gasEstimate = o.gasEstimate;
  if (o.feeData) w.feeData = o.feeData;
  return w;
}

/** A fake operator signer: signs with the throwaway key, records the signed transaction, never broadcasts. */
function fakeSigner(w, { failFirst = false, status = 1, gasUsed = 120_000n } = {}) {
  const s = { address: OP, sent: [], failures: 0, nonce: 7 };
  s.sendTransaction = async (tx) => {
    if (failFirst && s.failures === 0) { s.failures++; throw new Error("nonce too low"); }
    const raw = await operatorKey.signTransaction({ type: 2, chainId: 8453n, nonce: s.nonce++, to: tx.to, data: tx.data, value: tx.value, gasLimit: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
    const parsed = ethers.Transaction.from(raw);
    s.sent.push({ from: parsed.from, to: parsed.to, data: parsed.data, value: parsed.value, chainId: parsed.chainId, tx });
    return { hash: parsed.hash, wait: async () => ({ status, gasUsed, gasPrice: 50_000_000n }) };
  };
  return s;
}

async function pass(w, { cfg, mode = "collect", signer = fakeSigner(w), state = { gasSpends: [] }, getSigner, operatorAddress = OP, ethUsd = 2000 } = {}) {
  const lines = [];
  const saved = [];
  const readers = makeReaders({ cfg, provider: w.runner, dataDir: fs.mkdtempSync(path.join(TMP, "d-")), log: (l) => lines.push(l) });
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, json: async () => { throw new SyntaxError("html"); } });
  let signerCalls = 0;
  const res = await runPass({
    cfg, mode, provider: w.runner, operatorAddress, readers, state, saveState: (s) => saved.push(JSON.parse(JSON.stringify(s))),
    getSigner: getSigner || (async () => { signerCalls++; return signer; }), getEthUsd: async () => ethUsd, log: (l) => lines.push(l), now: () => Date.now(),
  });
  return { res, lines, text: lines.join("\n"), signer, saved, state, signerCalls: () => signerCalls };
}
const writes = (w, signer) => w.estimates.length + (signer ? signer.sent.length : 0) + w.calls.filter((c) => c.name === "collect").length;
const forbiddenCalls = (w) => w.calls.filter((c) => /^(approve|setApprovalForAll|safeTransferFrom|transferFrom|transfer|swap|safeTransfer)/i.test(c.name) || !["ownerOf", "isApprovedForAll", "collect", "balanceOf", "tokenOfOwnerByIndex", "positions"].includes(c.name) && !/^(getPool|slot0|symbol|decimals|voter|isAlive|gauge|nft|rewardToken|stakedValues|stakedContains|earned|token0|getReserves)$/.test(c.name));

(async () => {
  // ---- 3. collect:false everywhere (the shipped example) -> nothing at all
  {
    const cfg = cfgOf();
    assert.strictEqual(exampleRaw.wallets.main.collect, false);
    assert.ok(exampleRaw.wallets.watched.length >= 2 && exampleRaw.wallets.watched.every((x) => x.collect === false), "every watched wallet ships collect:false");
    assert.strictEqual(cfg.ownerCollect, false);
    assert.ok(L.owners(cfg).every((x) => !x.enabled));
    assert.deepStrictEqual(L.limits(cfg.baseCollect), { minFeesUsd: 2, minFeesToGasRatio: 5, maxGasPerRunEth: 0.0003, maxGasPriceGwei: 1, maxCollectsPerRun: 6, dailyGasCapEth: 0.001 }, "the example carries the defaults");
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
    assert.ok(r.lines.some((l) => /^  collected #79371151 to 0xaDf9.* tx 0x[0-9a-f]{64}, simulated amounts \d+ \/ \d+ \(raw\), gas used 120000, paid 0\.000006 ETH$/.test(l)), r.text);
    assert.ok(/^=== base done: 2 collected, 0 skipped, gas 0\.000012 ETH ===$/.test(r.lines[r.lines.length - 1]), r.lines[r.lines.length - 1]);
    // spend recorded for the rolling cap
    assert.strictEqual(r.state.gasSpends.length, 2); assert.strictEqual(r.saved.length, 2);
    assert.strictEqual(BigInt(r.state.gasSpends[0].wei), 120_000n * 50_000_000n);

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
    // a failed send is logged and the pass goes on
    const w4 = scene();
    const r4 = await pass(w4, { cfg: cfgOf(enableMain), signer: fakeSigner(w4, { failFirst: true }) });
    assert.strictEqual(r4.signer.sent.length, 1); assert.ok(r4.lines.some((l) => /collect failed: nonce too low; continuing/.test(l)), r4.text);
    assert.strictEqual(r4.res.collected, 1);
    // a collect mined as reverted still cost gas: recorded, not counted as collected
    const w5 = scene();
    const r5 = await pass(w5, { cfg: cfgOf(enableMain), signer: fakeSigner(w5, { status: 0 }) });
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
    const wg = scene({ gasEstimate: 40_000_000n }); // 40M gas * 0.05 gwei = 0.002 ETH = $4
    const rg = await pass(wg, { cfg: cfgOf(enableMain) });
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
    const wg = scene({ feeData: { maxFeePerGas: 3_000_000_000n, gasPrice: 2_000_000_000n, maxPriorityFeePerGas: 0n } });
    const rg = await pass(wg, { cfg: cfgOf(enableMain) });
    assert.strictEqual(rg.signer.sent.length, 0); assert.ok(/gas price 2\.0000 gwei exceeds maxGasPriceGwei 1/.test(rg.text), rg.text);
    const wr = scene();
    const rr = await pass(wr, { cfg: cfgOf(enableMain, { maxGasPerRunEth: 0.00001 }) }); // one collect's estimate is ~0.0000094 ETH, two exceed it
    assert.strictEqual(rr.signer.sent.length, 1); assert.ok(/maxGasPerRunEth 0\.00001 ETH would be exceeded/.test(rr.text), rr.text);
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
    assert.deepStrictEqual(new ethers.Interface(MANAGER_ABI).fragments.map((f) => f.name).sort(), ["collect", "isApprovedForAll", "ownerOf"]);
    assert.ok(src.split("\n").filter((l) => /^\s*"function /.test(l)).length === 3, "exactly three ABI strings in the file");
    // the only transaction it builds is collect
    assert.ok((src.match(/encodeFunctionData\("([a-zA-Z]+)"/g) || []).length === 1 && /encodeFunctionData\("collect"/.test(src));
    // it does not consult LP_READONLY, and the server never imports it
    assert.ok(!/LP_READONLY/.test(src.replace(/^\s*\*.*$/gm, "").replace(/\/\/.*$/gm, "")), "collector-base.js does not read LP_READONLY");
    for (const f of ["server.js", "slipstream.js", "watch.js", "claim-fees-target.js"]) assert.ok(!/collector-base/.test(fs.readFileSync(path.join(__dirname, "..", f), "utf8")), `${f} does not import collector-base`);
  }
  console.log("collector-base tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
