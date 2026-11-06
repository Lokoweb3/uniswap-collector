// node test/base-slipstream.test.js -- Aerodrome Slipstream on Base (and the Robinhood "up"
// scenario) through slipstream.js, with a mocked chain: no network, no key.
//
//   example   settings.base.example.json loads, holds no secret, no collector/vault/risk
//   staked    ownerOf = gauge, gauge.nft() = manager, stakedValues, earned x AERO price
//   killed    a killed gauge (earned reverts "NA") is zero rewards with a note, not an error
//   unstaked  collect.staticCall fees, no gauge read for the position
//   managers  two managers on one chain stay apart (address, not name())
//   blockscout an HTML page is "unavailable" (said once), JSON behaves as before
//   scan      chunked, budgeted, resumable, partial on failure; EIP-7702 owners are not gauges
//   robinhood the same scan over 2,000,000-block ranges finds a staked NFT in a gauge
//   pricing   ETH/USD decimals (18 vs 6); an unpriced side is null, never 0
//   uniswap   a v3 position through univ3.js with the example's Base addresses
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-base-slip-"));
process.env.LP_DATA_DIR = TMP;                 // token-meta and the scan cursors stay here
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const ROOT = path.join(__dirname, "..");
const u = require("../univ3");
const slip = require("../slipstream");
const settings = require("../settings");
const { world, revert } = require("./fixtures/mock-chain");

const EXAMPLE = path.join(ROOT, "settings.base.example.json");
const WALLET = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743";
const A = {
  mgrA: "0x827922686190790b37229fd06084350E74485b72", facA: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
  mgrB: "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53", facB: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  poolFactory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  weth: "0x4200000000000000000000000000000000000006", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  cbbtc: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", aero: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
  laptop: "0xB095274743941e953c746F9C228DA9c18Bb6ec29",
  gaugeA: "0x41b2126661C673C2beDd208cC72E85DC51a5320a", poolA: "0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1",
  gaugeB: "0x334C37C4133aC56961Ef428696D2D375E89cCA03", poolB: "0x99cf3E8bfB02c300312c53Aac5D0B082e3D5975C",
  voter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5", aeroPool: "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d",
};
const TICK = -200300;                           // WETH(18)/USDC(6) near $2,000
const E18 = 10n ** 18n;
const cfg = { usdReference: { stable: A.usdc }, contracts: { weth: A.weth } };
const toFloat = (a, d) => Number(ethers.formatUnits(a, d));
const WETH_L = A.weth.toLowerCase(), USDC_L = A.usdc.toLowerCase();
// The module server.js uses (pricing.js), not a copy of it.
const pricing = require("../pricing");
const priceSides = pricing.makePriceSides({ weth: A.weth, stable: A.usdc });
const silent = { warn() {}, error() {}, log() {} };
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} !~ ${b}`);

/** Token metadata + the classic AERO/USDC pool, shared by every scene. */
function tokens(w) {
  for (const [a, s, d] of [[A.weth, "WETH", 18], [A.usdc, "USDC", 6], [A.aero, "AERO", 18], [A.cbbtc, "cbBTC", 8], [A.laptop, "LAPTOP", 18]]) {
    w.on(a, "symbol", () => [s]).on(a, "decimals", () => [d]);
  }
  w.on(A.poolFactory, "getPool", (x, y, stable) => [typeof stable === "boolean" && (String(x).toLowerCase() === A.aero.toLowerCase() || String(y).toLowerCase() === A.aero.toLowerCase()) && String(x + y).toLowerCase().includes(USDC_L.slice(2)) ? A.aeroPool : ethers.ZeroAddress]);
  w.on(A.aeroPool, "token0", () => [A.aero]).on(A.aeroPool, "getReserves", () => [1000n * E18, 600n * 10n ** 6n, 0n]); // AERO = $0.60
  return w;
}

/** One Slipstream DEX in the world: manager, factory, pool, gauge; positions by id. */
function dex(w, { mgr, fac, pool, gauge, positions, owners, owned = [], staked = [], alive = true, earned = null, nftOfGauge = null, collect = [0n, 0n], gaugeOfPool = true }) {
  w.contract(gauge).contract(pool).contract(mgr).contract(fac);
  w.on(fac, "getPool", () => [pool]).on(fac, "voter", () => [A.voter]);
  w.on(A.voter, "isAlive", () => [alive]);
  w.on(pool, "slot0", () => [u.getSqrtRatioAtTick(TICK), BigInt(TICK), 0n, 1n, 1n, true]);
  w.on(pool, "gauge", () => [gaugeOfPool ? gauge : ethers.ZeroAddress]);
  w.on(gauge, "nft", () => [nftOfGauge || mgr]).on(gauge, "rewardToken", () => [A.aero]);
  w.on(gauge, "stakedValues", () => [staked.map(BigInt)]);
  w.on(gauge, "stakedContains", (_who, id) => [staked.map(BigInt).includes(BigInt(id))]);
  w.on(gauge, "earned", () => { if (earned == null) throw revert("NA"); return [earned]; });
  w.on(mgr, "balanceOf", () => [BigInt(owned.length)]).on(mgr, "tokenOfOwnerByIndex", (_o, i) => [BigInt(owned[Number(i)])]);
  w.on(mgr, "ownerOf", (id) => { const o = (owners || {})[String(id)]; if (!o) throw revert("nonexistent"); return [o]; });
  w.on(mgr, "positions", (id) => { const p = positions[String(id)]; if (!p) throw revert("no position"); return p; });
  w.on(mgr, "collect", () => collect);
}
const POS = (t0, t1, ts, lo, hi, liq, o0 = 0n, o1 = 0n, op = ethers.ZeroAddress) => [0n, op, t0, t1, BigInt(ts), BigInt(lo), BigInt(hi), BigInt(liq), 0n, 0n, BigInt(o0), BigInt(o1)];
const WETH_USDC = (liq = 5n * 10n ** 15n) => POS(A.weth, A.usdc, 100, TICK - 700, TICK + 700, liq);

const mk = (w, spec, extra = {}) => slip.create({
  provider: w.runner, cfg: { ...cfg, ...(extra.cfg || {}) }, spec, priceSides, toFloat,
  bsFetch: extra.bsFetch === undefined ? null : extra.bsFetch, logsProvider: extra.logsProvider || null, dataDir: extra.dataDir || fs.mkdtempSync(path.join(TMP, "d-")), log: extra.log || silent,
});
const SPEC_A = { name: "aerodrome-v1", positionManager: A.mgrA, factory: A.facA, poolFactory: A.poolFactory };
const SPEC_B = { name: "aerodrome-cl2", positionManager: A.mgrB, factory: A.facB, poolFactory: A.poolFactory };
const htmlPage = () => ({ ok: true, status: 200, headers: { get: () => "text/html; charset=UTF-8" }, json: async () => { throw new SyntaxError("Unexpected token <"); } });
const jsonPage = (obj) => ({ ok: true, status: 200, headers: { get: () => "application/json" }, json: async () => obj });

(async () => {
  // ---- 2. the example file --------------------------------------------------
  {
    const text = fs.readFileSync(EXAMPLE, "utf8");
    const raw = JSON.parse(text);
    const flat = settings.load({ file: EXAMPLE });
    assert.strictEqual(flat.chainId, 8453);
    assert.ok(/^https:\/\//.test(flat.rpcUrl), "a public https rpcUrl");
    require("../endpoint").validateEndpoint(flat.rpcUrl);
    require("../endpoint").validateEndpoint(flat.logsRpcUrl);
    assert.strictEqual(flat.maxLogRange, 50000);
    assert.strictEqual(flat.usdReference.feeTier, 3000, "ETH/USD from the deepest pool, Uniswap v3 fee 3000");
    assert.strictEqual(flat.usdReference.stable, A.usdc, "the legacy USDG slot is Base USDC");
    for (const bad of ["collector", "vault", "arm", "alerts"]) assert.ok(!(bad in raw), `no ${bad} section`);
    assert.ok(!raw.risk, "no risk.autoCollect / risk.sell");
    assert.ok(!/proapi_|apikey=|api[_-]?key"\s*:|privateKey|mnemonic|passphrase|\/v2\/[A-Za-z0-9]{8,}/i.test(text), "no secret or keyed URL in the example");
    const names = flat.contracts.slipstream.map((s) => s.name);
    assert.strictEqual(new Set(names).size, 2, "two slipstream specs with distinct names");
    assert.deepStrictEqual(names, ["aerodrome-v1", "aerodrome-cl2"]);
    assert.notStrictEqual(flat.contracts.slipstream[0].positionManager, flat.contracts.slipstream[1].positionManager);
    for (const a of text.match(/0x[0-9a-fA-F]{40}\b/g)) assert.strictEqual(ethers.getAddress(a), a, `${a} is a checksummed address`);
    assert.deepStrictEqual(flat.contracts.slipstream.map((s) => s.tokenIds), [[79371151], [8905958]]);
    assert.ok(flat.contracts.slipstream.every((s) => s.fromBlock > 0), "deploy blocks pinned");
    assert.strictEqual(flat.ownerAddress, WALLET);
  }

  // ---- the shipped scan settings ----------------------------------------------
  {
    const base = JSON.parse(fs.readFileSync(EXAMPLE, "utf8")).contracts.slipstream;
    assert.ok(base.length === 2 && base.every((e) => e.scan === false), "Base example: scan is off for both Aerodrome managers");
    const rh = JSON.parse(fs.readFileSync(path.join(ROOT, "settings.example.json"), "utf8")).contracts.slipstream.find((e) => e.name === "up");
    assert.strictEqual(rh.scanRange, 2000000, "Robinhood's up entry states its 2,000,000-block range");
  }

  // ---- 3. staked: ownerOf is a gauge ----------------------------------------
  {
    const w = tokens(world());
    dex(w, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 7: WETH_USDC() }, owners: { 7: A.gaugeA }, staked: [7], earned: 3n * E18 / 2n });
    const r = mk(w, { ...SPEC_A, tokenIds: [7] });
    const x = await r.positionsOf(WALLET, 2000);
    assert.strictEqual(x.positions.length, 1, JSON.stringify(x.errors));
    const p = x.positions[0];
    assert.strictEqual(p.staked, true);
    assert.strictEqual(p.gauge, A.gaugeA);
    assert.strictEqual(p.tokenId, "aerodrome-v1-7");
    near(p.rewards.amount, 1.5);
    near(p.rewards.priceUsd, 0.6);
    near(p.rewards.usd, 1.5 * 0.6);
    assert.strictEqual(p.rewards.symbol, "AERO");
    assert.strictEqual(p.fee0, 0); assert.strictEqual(p.fee1, 0);
    assert.strictEqual(w.callsTo(A.mgrA, "collect").length, 0, "a staked position's fees are not simulated");
    assert.ok(p.valueUsd > 0, "valued");
    assert.strictEqual(p.gaugeKilled, false);
    // Kept apart from `positions`: watch.js puts these in `external`, and the server counts them from there.
    const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    assert.ok(/const external = ext\.positions;/.test(src) && /const open = \[\.\.\.positions, \.\.\.external\];/.test(src), "server.js keeps slipstream positions in `external`");
    // The wallet-level path (watch.externalOf) returns them and nothing else touches `positions`.
    global.fetch = async () => htmlPage();               // watch.js uses the real Blockscout client: keep it offline
    const watch = require("../watch").create({ provider: w.runner, cfg: { ...cfg, contracts: { ...cfg.contracts, slipstream: [{ ...SPEC_A, tokenIds: [7] }] } }, priceSides, toFloat });
    const ext = await watch.externalOf(WALLET, 2000);
    assert.strictEqual(ext.positions.length, 1);
    assert.strictEqual(ext.positions[0].staked, true);
    assert.ok(!ext.errors.some((e) => /could not be read/.test(e.error)), "no read failure");
  }

  // ---- 3b. a killed gauge ---------------------------------------------------
  {
    const w = tokens(world());
    dex(w, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 7: WETH_USDC() }, owners: { 7: A.gaugeA }, staked: [7], earned: null, alive: false });
    const x = await mk(w, { ...SPEC_A, tokenIds: [7] }).positionsOf(WALLET, 2000);
    assert.strictEqual(x.errors.length, 0, "a killed gauge is not an error");
    const p = x.positions[0];
    assert.strictEqual(p.staked, true);
    assert.strictEqual(p.gaugeKilled, true);
    assert.strictEqual(p.rewards.amount, 0);
    assert.strictEqual(p.rewards.killed, true);
    assert.ok(/gauge killed/.test(p.rewards.note));
    // And a live gauge whose earned() reverts stays an error (null, not 0).
    const w2 = tokens(world());
    dex(w2, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 7: WETH_USDC() }, owners: { 7: A.gaugeA }, staked: [7], earned: null, alive: true });
    const y = (await mk(w2, { ...SPEC_A, tokenIds: [7] }).positionsOf(WALLET, 2000)).positions[0];
    assert.strictEqual(y.rewards.amount, null);
    assert.ok(y.rewards.error);
  }

  // ---- 4. unstaked: fees by collect.staticCall, no gauge read ---------------
  {
    const w = tokens(world());
    dex(w, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 9: WETH_USDC() }, owners: { 9: WALLET }, owned: [9], collect: [2n * 10n ** 15n, 5_000_000n], gaugeOfPool: false });
    const x = await mk(w, SPEC_A).positionsOf(WALLET, 2000);
    const p = x.positions[0];
    assert.strictEqual(p.staked, false);
    assert.strictEqual(p.gauge, null);
    assert.strictEqual(p.rewards, null);
    near(p.fee0, 0.002); near(p.fee1, 5);
    assert.strictEqual(p.feesOk, true);
    assert.strictEqual(w.callsTo(A.mgrA, "collect").length, 1);
    assert.strictEqual(w.callsTo(A.gaugeA).length, 0, "no gauge call at all");
    // A gauge exists but holds nothing for the wallet: still no earned() for the position.
    const w2 = tokens(world());
    dex(w2, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 9: WETH_USDC() }, owners: { 9: WALLET }, owned: [9], staked: [] });
    const y = await mk(w2, SPEC_A).positionsOf(WALLET, 2000);
    assert.strictEqual(y.positions[0].staked, false);
    assert.strictEqual(w2.callsTo(A.gaugeA, "earned").length, 0);
  }

  // ---- 5. two managers ------------------------------------------------------
  {
    const w = tokens(world());
    dex(w, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 79371151: WETH_USDC() }, owners: { 79371151: WALLET }, owned: [79371151] });
    dex(w, { mgr: A.mgrB, fac: A.facB, pool: A.poolB, gauge: A.gaugeB, positions: { 8905958: POS(A.usdc, A.laptop, 200, 305400, 309400, 14324821211673834n) }, owners: { 8905958: WALLET }, owned: [8905958] });
    // The real managers share one name(); nothing here may rely on it.
    for (const m of [A.mgrA, A.mgrB]) w.on(m, "name", () => ["Slipstream Position NFT v1"]);
    const ra = mk(w, SPEC_A), rb = mk(w, SPEC_B);
    const a = await ra.positionsOf(WALLET, 2000), b = await rb.positionsOf(WALLET, 2000);
    assert.deepStrictEqual(a.positions.map((p) => p.tokenId), ["aerodrome-v1-79371151"]);
    assert.strictEqual(b.errors.length, 0, JSON.stringify(b.errors));
    assert.deepStrictEqual(b.positions.map((p) => p.tokenId), ["aerodrome-cl2-8905958"]);
    assert.strictEqual(a.positions[0].positionManager, A.mgrA);
    assert.strictEqual(b.positions[0].positionManager, A.mgrB);
    assert.strictEqual(b.positions[0].pair, "USDC / LAPTOP");
    // Each read went to its own manager and factory.
    assert.ok(w.callsTo(A.mgrA, "positions").every((c) => c.args[0] === 79371151n));
    assert.strictEqual(w.callsTo(A.facB, "getPool").length > 0, true);
    assert.strictEqual(w.callsTo(A.facA, "getPool").every((c) => c.args[2] === 100n), true, "reader A asked its own factory about tickSpacing 100 only");

    // A gauge of manager B is rejected by reader A: nft() differs.
    const w2 = tokens(world());
    dex(w2, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 5: WETH_USDC() }, owners: { 5: A.gaugeB }, staked: [5] });
    w2.on(A.gaugeA, "stakedValues", () => [[5n]]);
    w2.contract(A.gaugeB);
    w2.on(A.gaugeB, "nft", () => [A.mgrB]).on(A.gaugeB, "rewardToken", () => [A.aero]).on(A.gaugeB, "stakedValues", () => [[5n]]).on(A.gaugeB, "stakedContains", () => [true]);
    const rej = await mk(w2, { ...SPEC_A, tokenIds: [5] }).positionsOf(WALLET, 2000);
    assert.strictEqual(rej.positions.length, 0, "reader A does not take a gauge whose nft() is manager B");
    assert.strictEqual(w2.callsTo(A.gaugeB, "stakedValues").length, 0, "and never asks it what is staked");
  }

  // ---- 6. no Blockscout -----------------------------------------------------
  {
    const build = () => {
      const w = tokens(world());
      dex(w, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 7: WETH_USDC() }, owners: { 7: A.gaugeA }, staked: [7], earned: E18, gaugeOfPool: false });
      return w;
    };
    // A Cloudflare page, HTTP 200 with HTML.
    let w = build();
    const warns = [];
    const reader = mk(w, { ...SPEC_A, tokenIds: [7], scan: false }, { bsFetch: async () => htmlPage(), log: { warn: (m) => warns.push(m) } });
    let x = await reader.positionsOf(WALLET, 2000);
    assert.strictEqual(x.positions.length, 1, "the pinned id still finds the staked position");
    assert.strictEqual(x.positions[0].staked, true);
    assert.ok(!x.errors.some((e) => /could not be read|SyntaxError/.test(e.error)), "an HTML page is not an error");
    assert.strictEqual(w.logCalls.length, 0, "scan: false really disables the log scan, even with Blockscout unavailable");
    assert.deepStrictEqual(x.notes, [], "no scan, no partial note");
    await reader.positionsOf(WALLET, 2000);
    assert.strictEqual(warns.length, 1, `logged once: ${warns.join(" | ")}`);
    assert.ok(/unavailable/.test(warns[0]));
    // 402 / 403 are "unavailable" too, whatever they carry.
    for (const status of [402, 403]) {
      const ww = build(); const wn = [];
      const rr = mk(ww, { ...SPEC_A, tokenIds: [7] }, { bsFetch: async () => ({ ok: false, status, headers: { get: () => "application/json" }, json: async () => ({ error: "pay" }) }), log: { warn: (m) => wn.push(m) } });
      const y = await rr.positionsOf(WALLET, 2000);
      assert.strictEqual(y.positions.length, 1); assert.strictEqual(wn.length, 1);
    }
    // JSON Blockscout: behaves as it did: the recipient is a candidate gauge, found without pins or a scan.
    w = build();
    const items = [{ to: { hash: A.gaugeA }, token: { address_hash: A.mgrA } }, { to: { hash: ethers.ZeroAddress }, token: { address_hash: A.mgrA } }];
    const jr = mk(w, SPEC_A, { bsFetch: async () => jsonPage({ items }), logsProvider: w.runner });
    x = await jr.positionsOf(WALLET, 2000);
    assert.strictEqual(x.positions.length, 1); assert.strictEqual(x.positions[0].staked, true);
    assert.strictEqual(w.logCalls.length, 0, "with Blockscout answering, no log scan runs");
    assert.strictEqual(x.errors.length, 0);
  }

  // ---- 7. the log scan ------------------------------------------------------
  {
    const buildW = () => {
      const w = tokens(world({ head: 100_000 }));
      dex(w, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 7: WETH_USDC() }, owners: { 7: A.gaugeA }, staked: [7], earned: E18, gaugeOfPool: false });
      // The wallet's NFT went into the gauge at block 15,000 (an old range): discovery by the scan only.
      w.transfer(A.mgrA, ethers.ZeroAddress, WALLET, 7, 14_000).transfer(A.mgrA, WALLET, A.gaugeA, 7, 15_000);
      return w;
    };
    const w = buildW();
    const logsW = world({ head: 100_000 });
    logsW.logs = w.logs;
    const spec = { ...SPEC_A, fromBlock: 0, scanBudget: 8, scanRange: 10_000 };             // 4 ranges (x2 directions) per refresh
    const DIR7 = fs.mkdtempSync(path.join(TMP, "scan-"));
    const r = mk(w, spec, { logsProvider: logsW.runner, dataDir: DIR7 });
    // refresh 1: head 100,000: newest 40,000 blocks.
    let x = await r.positionsOf(WALLET, 2000);
    assert.ok(logsW.logCalls.length > 0 && logsW.logCalls.length <= 8, `budget respected: ${logsW.logCalls.length}`);
    assert.strictEqual(w.logCalls.length, 0, "logs went to the logs provider, not the main one");
    for (const c of logsW.logCalls) assert.ok(c.toBlock - c.fromBlock + 1 <= 10_000, `no range wider than scanRange: ${c.fromBlock}..${c.toBlock}`);
    assert.strictEqual(x.positions.length, 0, "the transfer is in an older range: not found yet");
    assert.ok(x.notes.some((e) => /partial/.test(e)), "and the page says the discovery is partial");
    assert.ok(!x.errors.some((e) => /partial/.test(e.error)), "as a note, not as a position error");
    const stateFile = path.join(DIR7, "slipstream-scan-aerodrome-v1.json");
    const st1 = JSON.parse(fs.readFileSync(stateFile, "utf8")).wallets[WALLET.toLowerCase()];
    assert.strictEqual(st1.hi, 100_000); assert.strictEqual(st1.lo, 60_001, "the cursor is persisted");
    // refresh 2 (a new reader, as after a restart) resumes from the cursor
    const first = logsW.logCalls.length;
    const r2 = mk(w, spec, { logsProvider: logsW.runner, dataDir: DIR7 });
    x = await r2.positionsOf(WALLET, 2000);
    const second = logsW.logCalls.slice(first);
    assert.strictEqual(Math.max(...second.map((c) => c.toBlock)), 60_000, "resumes just below the cursor");
    assert.strictEqual(Math.min(...logsW.logCalls.map((c) => c.fromBlock)) >= 0, true);
    // refresh 3 reaches block 15,000: the Transfer to the gauge is read; the gauge is verified and staked
    x = await mk(w, spec, { logsProvider: logsW.runner, dataDir: DIR7 }).positionsOf(WALLET, 2000);
    assert.strictEqual(x.positions.length, 1, JSON.stringify(x.errors));
    assert.strictEqual(x.positions[0].staked, true);
    assert.strictEqual(x.positions[0].gauge, A.gaugeA);
    // refresh 4 completes to block 0 and the partial note goes away
    x = await mk(w, spec, { logsProvider: logsW.runner, dataDir: DIR7 }).positionsOf(WALLET, 2000);
    x = await mk(w, spec, { logsProvider: logsW.runner, dataDir: DIR7 }).positionsOf(WALLET, 2000);
    assert.ok(!x.notes.some((e) => /partial/.test(e)), "complete: no partial note");
    const st = JSON.parse(fs.readFileSync(stateFile, "utf8")).wallets[WALLET.toLowerCase()];
    assert.strictEqual(st.lo, 0);
    // a later refresh only reads the new blocks
    logsW.head = 100_500;
    const before = logsW.logCalls.length;
    await mk(w, spec, { logsProvider: logsW.runner, dataDir: DIR7 }).positionsOf(WALLET, 2000);
    const fresh = logsW.logCalls.slice(before);
    assert.ok(fresh.length === 2 && fresh.every((c) => c.fromBlock === 100_001 && c.toBlock === 100_500), `only new blocks: ${JSON.stringify(fresh)}`);

    // A failing chunk: partial with the reason, never an empty answer, the cursor is not moved, and the
    // window shrinks before giving up; the history is then left alone for the backoff period.
    const bad = world({ head: 100_000 });
    bad.failLogs = "range too large";
    const DIRF = fs.mkdtempSync(path.join(TMP, "scan-"));
    const badFile = path.join(DIRF, "slipstream-scan-fail.json");
    const w3 = buildW();
    const rb = mk(w3, { ...SPEC_A, name: "fail", fromBlock: 0, scanBackoffMs: 60_000, scanRange: 10_000 }, { logsProvider: bad.runner, dataDir: DIRF });
    x = await rb.positionsOf(WALLET, 2000);
    assert.ok(x.notes.some((e) => /partial/.test(e) && /range too large/.test(e)), JSON.stringify(x.notes));
    assert.ok(bad.logCalls.length >= 2 && bad.logCalls.every((c) => c.toBlock - c.fromBlock + 1 <= 10_000), "it narrowed its window but never widened it");
    const widths = bad.logCalls.map((c) => c.toBlock - c.fromBlock + 1);
    assert.ok(widths[widths.length - 1] <= 1000, `shrunk to the floor: ${widths}`);
    const sf = JSON.parse(fs.readFileSync(badFile, "utf8")).wallets[WALLET.toLowerCase()];
    assert.strictEqual(sf.lo, 100_001, "nothing was marked as read");
    const callsBefore = bad.logCalls.length;
    await rb.positionsOf(WALLET, 2000);
    assert.strictEqual(bad.logCalls.length, callsBefore, "within the backoff, a refused history is not hammered again");
    // Pins and held pools still worked while the scan failed.
    const wp = buildW();
    const pinned = await mk(wp, { ...SPEC_A, name: "fail2", tokenIds: [7], fromBlock: 0, scanRange: 10_000 }, { logsProvider: bad.runner, dataDir: DIRF }).positionsOf(WALLET, 2000);
    assert.strictEqual(pinned.positions.length, 1, "a failed scan does not lose the pinned position");
    assert.ok(pinned.notes.some((e) => /partial/.test(e)));
  }

  // ---- 7b. EIP-7702 owners are not gauge candidates -------------------------
  {
    const w = tokens(world());
    dex(w, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 9: WETH_USDC() }, owners: { 9: "0x1111111111111111111111111111111111111111" }, gaugeOfPool: false });
    w.code["0x1111111111111111111111111111111111111111"] = "0xef0100" + "69007702764179f14f51cdce752f4f775d74e139";
    const x = await mk(w, { ...SPEC_A, tokenIds: [9] }).positionsOf(WALLET, 2000);
    assert.strictEqual(x.positions.length, 0);
    assert.strictEqual(w.callsTo("0x1111111111111111111111111111111111111111").length, 0, "a delegated EOA is never asked nft()");
    // The wallet's own NFT: never a candidate either.
    const w2 = tokens(world());
    dex(w2, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 9: WETH_USDC() }, owners: { 9: WALLET }, owned: [9], gaugeOfPool: false });
    w2.code[WALLET.toLowerCase()] = "0xef0100" + "69007702764179f14f51cdce752f4f775d74e139";
    const y = await mk(w2, { ...SPEC_A, tokenIds: [9] }).positionsOf(WALLET, 2000);
    assert.strictEqual(y.positions.length, 1); assert.strictEqual(y.positions[0].staked, false);
    assert.strictEqual(w2.callsTo(WALLET).length, 0);
  }

  // ---- Robinhood: the same fallback over 2,000,000-block ranges --------------
  {
    const UP = "0x07F44c47743A2f36414A82b9F558ECFCf0EEdCEf", UPF = "0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3", UPPF = "0xFA5429AEBa338BEa2BFcc1b9a889862Ee395bc28";
    const RH_GAUGE = "0x34e626Eca01615a752F859DED5ac2b2779433797", RH_POOL = "0x2222222222222222222222222222222222222222";
    const RH_WALLET = "0x698C3A3F06B7EdBD175169d1cfa219c8232F48d8";
    const w = tokens(world({ head: 107_160_000 }));
    // #278599, #317922, #317976 closed (held by the wallet, zero liquidity); #317987 staked in the gauge.
    const closed = POS(A.weth, A.usdc, 100, TICK - 700, TICK + 700, 0);
    dex(w, { mgr: UP, fac: UPF, pool: RH_POOL, gauge: RH_GAUGE, positions: { 278599: closed, 317922: closed, 317976: closed, 317987: WETH_USDC() }, owners: { 278599: RH_WALLET, 317922: RH_WALLET, 317976: RH_WALLET, 317987: RH_GAUGE }, owned: [278599, 317922, 317976], staked: [317987], earned: E18, gaugeOfPool: false });
    w.on(UPF, "getPool", () => [RH_POOL]);
    for (const [id, blk] of [[278599, 50_000_000], [317922, 51_000_000], [317976, 52_000_000], [317987, 53_000_000]]) w.transfer(UP, ethers.ZeroAddress, RH_WALLET, id, blk);
    w.transfer(UP, RH_WALLET, RH_GAUGE, 317987, 53_500_000);        // staked
    w.transfer(UP, RH_WALLET, "0x3333333333333333333333333333333333333333", 317922, 51_500_000); // an unrelated recipient
    const warns = [];
    const DIRR = fs.mkdtempSync(path.join(TMP, "scan-"));
    // chain.maxLogRange 10,000 is set (the main RPC's limit) and must NOT shrink the slipstream scan: it uses its own scanRange (default 2,000,000).
    const r = slip.create({ provider: w.runner, cfg: { ...cfg, maxLogRange: 10_000 }, spec: { name: "up", positionManager: UP, factory: UPF, poolFactory: UPPF }, priceSides, toFloat, bsFetch: async () => htmlPage(), logsProvider: null, dataDir: DIRR, log: { warn: (m) => warns.push(m) } });
    const x = await r.positionsOf(RH_WALLET, 2000);
    assert.strictEqual(warns.length, 1, "Blockscout's Cloudflare challenge is 'unavailable', once");
    const lc = w.logCalls;
    assert.strictEqual(lc.length, 108, `54 ranges x 2 directions: ${lc.length}`);
    assert.ok(lc.every((c) => c.toBlock - c.fromBlock + 1 <= 2_000_000), "ranges of at most 2,000,000 blocks");
    assert.strictEqual(Math.min(...lc.map((c) => c.fromBlock)), 0, "from block 0");
    assert.strictEqual(Math.max(...lc.map((c) => c.toBlock)), 107_160_000, "to the head");
    const topicKinds = new Set(lc.map((c) => `${c.topics.length}:${c.topics[1] ? "from" : "to"}`));
    assert.deepStrictEqual([...topicKinds].sort(), ["2:from", "3:to"], "both directions: from=wallet and to=wallet");
    assert.ok(lc.every((c) => c.address.toLowerCase() === UP.toLowerCase()));
    assert.strictEqual(x.errors.length, 0, JSON.stringify(x.errors));
    assert.strictEqual(x.closed, 3, "the three closed NFTs");
    assert.strictEqual(x.positions.length, 1);
    assert.strictEqual(x.positions[0].tokenId, "up-317987");
    assert.strictEqual(x.positions[0].staked, true);
    assert.strictEqual(x.positions[0].gauge, RH_GAUGE);
    assert.strictEqual(x.positions[0].rewards.amount, 1);
    // Second refresh: converged, only the new head.
    const n = lc.length;
    w.head += 1000;
    await slip.create({ provider: w.runner, cfg, spec: { name: "up", positionManager: UP, factory: UPF, poolFactory: UPPF }, priceSides, toFloat, bsFetch: async () => htmlPage(), dataDir: DIRR, log: silent }).positionsOf(RH_WALLET, 2000);
    assert.strictEqual(w.logCalls.length - n, 2, "an incremental refresh is one range per direction");
  }

  // ---- scan stall: a hanging log RPC cannot hold a refresh -------------------
  {
    const w = tokens(world({ head: 100_000 }));
    dex(w, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 7: WETH_USDC() }, owners: { 7: A.gaugeA }, staked: [7], earned: E18, gaugeOfPool: false });
    const hung = world({ head: 100_000 });
    hung.hangLogs = true;
    const DIRH = fs.mkdtempSync(path.join(TMP, "scan-"));
    const r = mk(w, { ...SPEC_A, tokenIds: [7], fromBlock: 0, scanMs: 300, scanRange: 10_000 }, { logsProvider: hung.runner, dataDir: DIRH });
    const t0 = Date.now();
    const x = await r.positionsOf(WALLET, 2000);
    const took = Date.now() - t0;
    assert.ok(took < 300 + 1500, `positionsOf returned in ${took} ms despite a log RPC that never answers`);
    assert.strictEqual(hung.logCalls.length, 1, "a timeout goes straight to backoff: no shrink-and-retry");
    assert.strictEqual(x.positions.length, 1, "the pinned position was still read");
    assert.ok(x.notes.some((n) => /partial/.test(n) && /timed out/.test(n)), JSON.stringify(x.notes));
    const calls = hung.logCalls.length;
    await r.positionsOf(WALLET, 2000);
    assert.strictEqual(hung.logCalls.length, calls, "and it is not retried within the backoff");
  }

  // ---- scan budget: slow but answering is not a failing RPC -------------------
  {
    const w = tokens(world({ head: 100_000 }));
    dex(w, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 7: WETH_USDC() }, owners: { 7: A.gaugeA }, staked: [7], earned: E18, gaugeOfPool: false });
    const slow = world({ head: 100_000 });
    const inner = slow.runner;
    const slowRunner = new Proxy(inner, { get: (tgt, k) => (k === "getLogs" ? async (...a) => { await new Promise((r) => setTimeout(r, 400)); return tgt.getLogs(...a); } : (typeof tgt[k] === "function" ? tgt[k].bind(tgt) : tgt[k])) });
    const DIRS = fs.mkdtempSync(path.join(TMP, "scan-"));
    const spec = { ...SPEC_A, tokenIds: [7], fromBlock: 0, scanMs: 1000, scanBudget: 100, scanRange: 10_000, scanBackoffMs: 60_000 };
    const x1 = await mk(w, spec, { logsProvider: slowRunner, dataDir: DIRS }).positionsOf(WALLET, 2000);
    const stF = path.join(DIRS, "slipstream-scan-aerodrome-v1.json");
    const st = JSON.parse(fs.readFileSync(stF, "utf8"));
    for (const ws of Object.values(st.wallets)) assert.ok(!ws.backoffUntil, "running out of budget while answering is not a backoff");
    assert.ok(x1.notes.every((n) => !/timed out/.test(n)), JSON.stringify(x1.notes));
    const before = slow.logCalls.length;
    await mk(w, spec, { logsProvider: slowRunner, dataDir: DIRS }).positionsOf(WALLET, 2000);
    assert.ok(slow.logCalls.length > before, "the next refresh scans history again");
  }

  // ---- the logs provider: no retry ladder -------------------------------------
  {
    const rpc = require("../rpc");
    assert.strictEqual(rpc.createLogsProvider({}), null);
    let n = 0, status = 500;
    const Base = Object.getPrototypeOf(rpc.LogsProvider.prototype);
    const orig = Base._send;
    Base._send = async () => { n++; const e = new Error(status === 429 ? "429 Too Many Requests" : "server error 500"); throw e; };
    try {
      const p2 = rpc.createLogsProvider({ logsRpcUrl: "https://logs.example/key", chainId: 8453 });
      await assert.rejects(p2._send({ method: "eth_getLogs", params: [], id: 1, jsonrpc: "2.0" }));
      assert.strictEqual(n, 1, "a failure is not retried");
      n = 0; status = 429;
      await assert.rejects(p2._send({ method: "eth_getLogs", params: [], id: 1, jsonrpc: "2.0" }));
      assert.strictEqual(n, 2, "a 429 is retried once");
    } finally { Base._send = orig; }
  }

  // ---- 13. pricing ---------------------------------------------------------
  {
    // WETH(0x42..) sorts before USDC(0x83..): token0 = WETH, price = USDC per WETH, read with (18, 6).
    const sqrt = u.getSqrtRatioAtTick(TICK);
    const p = u.priceFromSqrt(sqrt, 18, 6);
    assert.ok(p > 1900 && p < 2100, `ETH/USD ${p}`);
    const wrong = u.priceFromSqrt(sqrt, 6, 18);
    assert.ok(wrong < 1e-3 || wrong > 1e6, "the decimals matter: swapped they are off by 10^12");
    // A WETH/cbBTC position is valued from the ETH price; an unpriced pair is null, never 0.
    const w = tokens(world());
    dex(w, { mgr: A.mgrA, fac: A.facA, pool: A.poolA, gauge: A.gaugeA, positions: { 1: POS(A.weth, A.cbbtc, 100, TICK - 700, TICK + 700, 10n ** 15n), 2: POS(A.cbbtc, A.laptop, 100, TICK - 700, TICK + 700, 10n ** 15n) }, owners: { 1: WALLET, 2: WALLET }, owned: [1, 2], gaugeOfPool: false });
    const x = await mk(w, SPEC_A).positionsOf(WALLET, p);
    const byId = Object.fromEntries(x.positions.map((q) => [q.nftId, q]));
    assert.ok(byId[1].valueUsd > 0 && byId[1].usd0 === p, "WETH side priced from the ETH price");
    assert.strictEqual(byId[2].valueUsd, null, "an unpriced side is null");
    assert.strictEqual(byId[2].feesUsd, null);
    assert.notStrictEqual(byId[2].valueUsd, 0);
    // No ETH price at all: nothing is invented.
    const y = await mk(w, SPEC_A).positionsOf(WALLET, null);
    assert.ok(y.positions.every((q) => q.valueUsd === null));
  }

  // ---- 13b. the reference pool follows usdReference.feeTier -----------------
  {
    const POOL500 = "0x5000000000000000000000000000000000000500", POOL3000 = "0x3000000000000000000000000000000000003000";
    const w = tokens(world());
    const asked = [];
    const factory = { getPool: async (a, b, fee) => { asked.push(Number(fee)); return Number(fee) === 3000 ? POOL3000 : Number(fee) === 500 ? POOL500 : ethers.ZeroAddress; } };
    const sqrt = (pool) => (pool === POOL3000 ? u.getSqrtRatioAtTick(TICK) : u.getSqrtRatioAtTick(TICK + 20000));
    const seen = [];
    const provider = { call: async (tx) => { seen.push(String(tx.to).toLowerCase()); return w.runner.call(tx); } };
    for (const pool of [POOL3000, POOL500]) w.on(pool, "slot0", () => [sqrt(pool), BigInt(TICK), 0n, 1n, 1n, true]);
    const mkUsd = (feeTier) => pricing.makeGetWethUsd({ cfg: { usdReference: { stable: A.usdc, feeTier }, contracts: { weth: A.weth } }, unit: { usdRate: null }, factory, provider, u: { ...u, POOL_ABI: ["function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)"], getToken: async (a) => ({ address: a, decimals: a.toLowerCase() === A.usdc.toLowerCase() ? 6 : 18 }) } });
    const p3000 = await mkUsd(3000)();
    assert.deepStrictEqual(asked, [3000], "the configured fee tier is the one asked for");
    assert.ok(seen.includes(POOL3000.toLowerCase()) && !seen.includes(POOL500.toLowerCase()), "the fee-3000 pool is read");
    near(p3000, u.priceFromSqrt(u.getSqrtRatioAtTick(TICK), 18, 6), 1e-9);
    const p500 = await mkUsd(500)();
    assert.notStrictEqual(Math.round(p500), Math.round(p3000), "fee tier 500 reads a different pool");
    assert.strictEqual(await mkUsd(10000)(), null, "no pool at that tier: null, not a guess");
    assert.strictEqual(await pricing.makeGetWethUsd({ cfg: { usdReference: { stable: A.usdc, feeTier: 3000 }, contracts: { weth: A.weth } }, unit: { usdRate: 1 }, factory, provider, u })(), 1, "a dollar unit needs no pool");
  }

  // ---- 14. Uniswap v3 on Base, through univ3.js ------------------------------
  {
    const flat = settings.load({ file: EXAMPLE });
    const UNI_NPM = flat.contracts.positionManager, UNI_F = flat.contracts.factory, UNI_POOL = "0x6c561B446416E1A00E8E93E221854d6eA4171372";
    assert.strictEqual(UNI_NPM, "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1");
    const w = tokens(world());
    const seen = [];
    w.on(UNI_NPM, "balanceOf", () => [1n]).on(UNI_NPM, "tokenOfOwnerByIndex", () => [42n]);
    w.on(UNI_NPM, "positions", (id) => { seen.push(String(id)); return [0n, ethers.ZeroAddress, A.weth, A.usdc, 3000n, BigInt(TICK - 600), BigInt(TICK + 600), 10n ** 15n, 0n, 0n, 0n, 0n]; });
    w.on(UNI_NPM, "collect", () => [1n, 2n]);
    w.on(UNI_F, "getPool", () => [UNI_POOL]);
    // univ3's pool has the seven-field slot0 (feeProtocol), unlike Slipstream's six
    const poolIface = new ethers.Interface(u.POOL_ABI);
    const baseCall = w.runner.call;
    w.runner.call = async (tx) => (String(tx.to).toLowerCase() === UNI_POOL.toLowerCase()
      ? poolIface.encodeFunctionResult("slot0", [u.getSqrtRatioAtTick(TICK), BigInt(TICK), 0, 1, 1, 0, true])
      : baseCall(tx));
    const npm = new ethers.Contract(UNI_NPM, u.NPM_ABI, w.runner), factory = new ethers.Contract(UNI_F, u.FACTORY_ABI, w.runner);
    const ids = await u.listTokenIds(npm, WALLET);
    assert.deepStrictEqual(ids, [42n]);
    const pos = await u.loadPosition({ provider: w.runner, npm, factory, cfg: { ownerAddress: WALLET } }, ids[0]);
    assert.strictEqual(pos.feeTier, 3000);
    assert.strictEqual(pos.poolAddress, UNI_POOL);
    assert.strictEqual(pos.token0.symbol, "WETH");
    assert.strictEqual(pos.inRange, true);
    assert.strictEqual(pos.fees.ok, true);
    // v4 absent from settings: the flat configuration has none, and the server's own guard skips it.
    const raw = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
    delete raw.contracts.v4;
    const noV4 = settings.toLegacy(raw);
    assert.strictEqual(noV4.contracts.v4, undefined);
    assert.ok(/cfg\.contracts\.v4 && cfg\.contracts\.v4\.positionManager/.test(fs.readFileSync(path.join(ROOT, "server.js"), "utf8")), "server.js skips v4 when it is not configured");
  }

  console.log("base slipstream: example, staked/killed/unstaked, two managers, no-Blockscout discovery, resumable scan, Robinhood 2M ranges, pricing, Uniswap v3 passed");
})().catch((e) => { console.error(e); process.exit(1); });
