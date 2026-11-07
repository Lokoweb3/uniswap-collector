// node test/claim-fees-target.test.js -- claim-fees-target.js on a mocked chain (no network): the manager
// comes from settings only, the owner and fees from the chain, and nothing resembling calldata is returned.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-claim-target-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const u = require("../univ3");
const slip = require("../slipstream");
const pricing = require("../pricing");
const settings = require("../settings");
const { resolveTarget, cached } = require("../claim-fees-target");
const { world, revert } = require("./fixtures/mock-chain");

const WALLET = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743";
const MGR_A = "0x827922686190790b37229fd06084350E74485b72", MGR_B = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53";
const FAC_A = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", FAC_B = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef";
const WETH = "0x4200000000000000000000000000000000000006", USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POOL_A = "0x70aCDF2Ad0bf2402C957154f944c19Ef4e1cbAE1", POOL_B = "0x99cf3E8bfB02c300312c53Aac5D0B082e3D5975C";
const GAUGE = "0x41b2126661C673C2beDd208cC72E85DC51a5320a", VOTER = "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5", AERO_POOL = "0x6cDcb1C4A4D1C3C6d054b27AC5B77e89eAFb971d";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631", POOL_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
const TICK = -200300, E18 = 10n ** 18n;
const EVIL = "0x00000000000000000000000000000000000000ee";
const cfg = settings.load({ file: path.join(__dirname, "..", "settings.base.example.json") });
const toFloat = (a, d) => Number(ethers.formatUnits(a, d));
const priceSides = pricing.makePriceSides({ weth: WETH, stable: USDC });
const POS = (liq) => [0n, ethers.ZeroAddress, WETH, USDC, 100n, BigInt(TICK - 700), BigInt(TICK + 700), BigInt(liq), 0n, 0n, 0n, 0n];

function scene({ stakedA = false } = {}) {
  const w = world();
  for (const [a, s, d] of [[WETH, "WETH", 18], [USDC, "USDC", 6], [AERO, "AERO", 18]]) w.on(a, "symbol", () => [s]).on(a, "decimals", () => [d]);
  w.on(POOL_FACTORY, "getPool", () => [AERO_POOL]).on(AERO_POOL, "token0", () => [AERO]).on(AERO_POOL, "getReserves", () => [1000n * E18, 600n * 10n ** 6n, 0n]);
  w.contract(GAUGE).contract(POOL_A).contract(POOL_B).contract(MGR_A).contract(MGR_B);
  const dex = (mgr, fac, pool, id, owner, collect) => {
    w.on(fac, "getPool", () => [pool]).on(fac, "voter", () => [VOTER]);
    w.on(pool, "slot0", () => [u.getSqrtRatioAtTick(TICK), BigInt(TICK), 0n, 1n, 1n, true]).on(pool, "gauge", () => [GAUGE]);
    w.on(mgr, "balanceOf", () => [owner === WALLET ? 1n : 0n]).on(mgr, "tokenOfOwnerByIndex", () => [BigInt(id)]);
    w.on(mgr, "ownerOf", (x) => { if (BigInt(x) !== BigInt(id)) throw revert("nonexistent"); return [owner]; });
    w.on(mgr, "positions", () => POS(5n * 10n ** 15n)).on(mgr, "collect", () => collect);
  };
  w.on(VOTER, "isAlive", () => [false]);
  w.on(GAUGE, "nft", () => [MGR_A]).on(GAUGE, "rewardToken", () => [AERO]).on(GAUGE, "stakedValues", () => [stakedA ? [79371151n] : []]);
  w.on(GAUGE, "stakedContains", () => [stakedA]).on(GAUGE, "earned", () => { throw revert("NA"); });
  dex(MGR_A, FAC_A, POOL_A, 79371151, stakedA ? GAUGE : WALLET, [2n * 10n ** 15n, 5_000_000n]);
  dex(MGR_B, FAC_B, POOL_B, 8905958, WALLET, [3n * 10n ** 15n, 1_000_000n]);
  return w;
}
const silent = { warn() {}, error() {}, log() {} };
async function positionsOf(w) {
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => "text/html" }, json: async () => { throw new SyntaxError("html"); } });
  const out = [];
  for (const spec of cfg.contracts.slipstream) {
    const r = slip.create({ provider: w.runner, cfg, spec: { ...spec, scan: false }, priceSides, toFloat, bsFetch: null, dataDir: fs.mkdtempSync(path.join(TMP, "d-")), log: silent });
    out.push(...(await r.positionsOf(WALLET, 2000)).positions);
  }
  return out;
}
const C = { ...cfg, explorer: "https://basescan.org" };
const ask = (w, positions, protocol, id) => resolveTarget({ cfg: C, provider: w.runner, positions, protocol, id });
const FORBIDDEN = ["data", "calldata", "to", "tx"];

(async () => {
  // 3. both managers, from settings; owner and fees from the mocked chain
  {
    const w = scene();
    const positions = await positionsOf(w);
    assert.strictEqual(positions.length, 2);
    const a = await ask(w, positions, "aerodrome-v1", "79371151");
    assert.strictEqual(a.status, 200); assert.strictEqual(a.body.ok, true, JSON.stringify(a.body));
    assert.strictEqual(a.body.manager, MGR_A); assert.strictEqual(a.body.owner, WALLET);
    assert.strictEqual(a.body.chainId, 8453); assert.strictEqual(a.body.staked, false); assert.strictEqual(a.body.feesOk, true);
    assert.strictEqual(a.body.fee0, 0.002); assert.strictEqual(a.body.fee1, 5);
    assert.strictEqual(a.body.symbol0, "WETH"); assert.strictEqual(a.body.decimals1, 6);
    assert.ok(a.body.feesUsd > 5, "usd value of the estimate");
    assert.strictEqual(a.body.explorer, "https://basescan.org");
    const b = await ask(w, positions, "aerodrome-cl2", "8905958");
    assert.strictEqual(b.body.manager, MGR_B); assert.strictEqual(b.body.owner, WALLET);
    assert.strictEqual(b.body.fee0, 0.003); assert.strictEqual(b.body.fee1, 1);
    // the estimate is made from the owner (static call), never a write
    const c = w.callsTo(MGR_A, "collect").pop();
    assert.ok(c, "collect staticCall made");
    for (const r of [a, b]) for (const k of FORBIDDEN) assert.ok(!(k in r.body), `no ${k} key`);
    assert.ok(!/"(data|calldata|to|tx)"\s*:/.test(JSON.stringify(a.body)));
  }

  // 4. invalid input: refused, and no RPC call at all
  {
    const w = scene();
    const positions = await positionsOf(w);
    const before = w.calls.length;
    const cases = [
      ["other", "79371151", 404], ["aerodrome-v1", "1", 404], ["aerodrome-v1", "abc", 400], ["aerodrome-v1", "1".repeat(80), 400],
      [null, "79371151", 400], ["aerodrome-v1", null, 400], [undefined, undefined, 400], ["aerodrome-v1", "-1", 400], ["aerodrome-v1", "1.5", 400],
      ["aerodrome-v1", "8905958", 404], // the id belongs to the other manager
      ["../x", "1", 400], ["aerodrome-v1", "0x1", 400],
    ];
    for (const [p, i, status] of cases) {
      const r = await ask(w, positions, p, i);
      assert.strictEqual(r.status, status, `${p} ${i}: ${r.status}`);
      assert.strictEqual(r.body.ok, false);
    }
    assert.strictEqual(w.calls.length, before, "no RPC call for invalid or unknown input");
    // extra manager / to / recipient parameters are not inputs of the function: the answer is the settings manager
    const r = await resolveTarget({ cfg: C, provider: w.runner, positions, protocol: "aerodrome-v1", id: "79371151", manager: EVIL, to: EVIL, recipient: EVIL, owner: EVIL });
    assert.strictEqual(r.body.manager, MGR_A); assert.strictEqual(r.body.owner, WALLET);
    assert.ok(!JSON.stringify(r.body).toLowerCase().includes(EVIL.slice(2)));
    assert.ok(!w.calls.some((c) => c.to === EVIL.toLowerCase()), "the evil address is never called");
    // a position whose recorded manager differs is irrelevant: the manager is the settings entry
    const forged = positions.map((p) => ({ ...p, positionManager: EVIL }));
    assert.strictEqual((await ask(w, forged, "aerodrome-v1", "79371151")).body.manager, MGR_A);
  }

  // 5. staked: owner is the gauge
  {
    const w = scene({ stakedA: true });
    const positions = await positionsOf(w);
    const p = positions.find((x) => x.nftId === "79371151");
    assert.strictEqual(p.staked, true);
    const r = await ask(w, positions, "aerodrome-v1", "79371151");
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.staked, true); assert.strictEqual(r.body.owner, GAUGE);
    for (const k of FORBIDDEN) assert.ok(!(k in r.body), `no ${k} key`);
    assert.strictEqual(w.callsTo(MGR_A, "collect").length, 0, "no fee estimate for a staked position");
    // even when the payload says unstaked, an owner equal to the gauge counts as staked
    const r2 = await ask(w, positions.map((x) => ({ ...x, staked: false })), "aerodrome-v1", "79371151");
    assert.strictEqual(r2.body.staked, true);
  }

  // an unreadable fee and an unreadable owner are reported, not invented
  {
    const w = scene();
    const positions = await positionsOf(w);
    w.on(MGR_A, "collect", () => { throw revert("boom"); });
    const r = await ask(w, positions, "aerodrome-v1", "79371151");
    assert.strictEqual(r.body.ok, true); assert.strictEqual(r.body.feesOk, false); assert.strictEqual(r.body.fee0, 0);
    w.on(MGR_A, "ownerOf", () => { throw revert("gone"); });
    const r2 = await ask(w, positions, "aerodrome-v1", "79371151");
    assert.strictEqual(r2.status, 502); assert.strictEqual(r2.body.ok, false);
  }
  // cache and in-flight dedupe: a burst costs one ownerOf plus one collect.staticCall
  {
    const w = scene();
    const positions = await positionsOf(w);
    let t = 1000; const fast = cached(resolveTarget, { ttlMs: 12000, now: () => t });
    const go = () => fast({ cfg: C, provider: w.runner, positions, protocol: "aerodrome-v1", id: "79371151" });
    const before = w.callsTo(MGR_A, "ownerOf").length, beforeC = w.callsTo(MGR_A, "collect").length;
    const rs = await Promise.all([go(), go(), go()]);
    await go();
    assert.ok(rs.every((r) => r.status === 200 && r.body.owner === WALLET));
    assert.strictEqual(w.callsTo(MGR_A, "ownerOf").length - before, 1, "one ownerOf");
    assert.strictEqual(w.callsTo(MGR_A, "collect").length - beforeC, 1, "one collect.staticCall");
    t += 13000; await go();
    assert.strictEqual(w.callsTo(MGR_A, "ownerOf").length - before, 2, "expires after the ttl");
  }
  console.log("claim-fees-target tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
