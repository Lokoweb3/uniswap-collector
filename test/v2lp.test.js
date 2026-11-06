// node test/v2lp.test.js -- the PulseX (Uniswap-v2-style) LP reader, mocked chain, no network:
// math, v1/v2 separation, unpriced and thin pairs, discovery (pinned / explorer list / enumeration with a
// budget and a resumable cursor), the WPLS/USD reserves rate, and the view-only farm adapter.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("ethers");
const { world, units } = require("./fixtures/mock-pulse");
const v2lp = require("../v2lp");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lp-v2lp-"));
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });
const A = (n) => ethers.getAddress("0x" + n.toString(16).padStart(40, "0"));
const WPLS = A(0x101), DAI = A(0x102), USDC = A(0x103), USDT = A(0x104), PDAI = A(0x105);
const F1 = A(0x201), F2 = A(0x202), FX = A(0x203);
const WALLET = A(0x301), OTHER = A(0x302);
const WPLS_USD = 0.05;                       // 50,000 DAI over 1,000,000 WPLS
const MIN = 100;

function baseWorld(opts) {
  const w = world(opts);
  w.token(WPLS, "WPLS", 18); w.token(DAI, "DAI", 18); w.token(USDC, "USDC", 6); w.token(USDT, "USDT", 6); w.token(PDAI, "DAI", 18);
  w.factory(F1); w.factory(F2); w.factory(FX);
  return w;
}
const cfgOf = (extra = {}) => ({
  chainId: 369,
  contracts: { weth: WPLS, v2lp: [{ name: "pulsex-v1", factory: F1, scan: false }, { name: "pulsex-v2", factory: F2, scan: false }], pulsex: { stables: [DAI, USDC, USDT], minQuoteUsd: MIN, ...(extra.pulsex || {}) } },
  usdReference: { stable: DAI }, numeraire: { address: WPLS }, ...extra.top,
});
const quiet = { warn() {}, error() {}, log() {} };
const setOf = (w, cfg, extra = {}) => v2lp.createSet({ provider: w.runner, cfg, persist: false, dataDir: TMP, log: quiet, ...extra });
const html = (type, body) => ({ ok: true, status: 200, headers: { get: () => type }, json: async () => JSON.parse(body), text: async () => body });

(async () => {
  // ---- 3. math -------------------------------------------------------------------------------
  {
    const w = baseWorld();
    const P1 = w.pair(A(0x401), F1, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(100, 18) });
    const P2 = w.pair(A(0x402), F1, WPLS, USDC, units(2_000_000, 18), units(100_000, 6), units(1000, 18), { [WALLET]: units(250, 18) });
    const P0 = w.pair(A(0x403), F1, WPLS, USDT, units(1_000_000, 18), units(50_000, 6), units(1000, 18), { [OTHER]: units(10, 18) });
    const cfg = cfgOf();
    cfg.contracts.v2lp[0].pairs = [P1, P2, P0];
    const set = setOf(w, cfg);
    const r = await set.positionsOf(WALLET, WPLS_USD);
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.positions.length, 2, "the pair this wallet holds nothing of returns no position");
    const p = r.positions.find((x) => x.pairAddress === P1);
    assert.strictEqual(p.protocol, "pulsex-v1");
    assert.strictEqual(p.tokenId, `pulsex-v1-${P1}`);
    assert.strictEqual(p.pair, "WPLS / DAI");
    assert.strictEqual(p.sharePct, 1);
    assert.strictEqual(p.amount0, 10_000); assert.strictEqual(p.amount1, 500);
    assert.strictEqual(p.valueUsd, 10_000 * WPLS_USD + 500 * 1);
    assert.strictEqual(p.lpBalance, 100); assert.strictEqual(p.totalSupply, 10_000);
    assert.strictEqual(p.reserve0, 1_000_000); assert.strictEqual(p.reserve1, 50_000);
    assert.strictEqual(p.fee0, 0); assert.strictEqual(p.fee1, 0);
    assert.ok(/realised when liquidity is removed/.test(p.feesNote));
    assert.ok(!("inRange" in p) && !("tickLower" in p), "no range fields on a v2 position");
    assert.strictEqual(p.staked, false); assert.strictEqual(p.thin, false);
    // mixed decimals: WPLS 18 / USDC 6, share 25 %
    const q = r.positions.find((x) => x.pairAddress === P2);
    assert.strictEqual(q.sharePct, 25);
    assert.strictEqual(q.amount0, 500_000); assert.strictEqual(q.amount1, 25_000);
    assert.strictEqual(q.valueUsd, 500_000 * WPLS_USD + 25_000);
    // a wallet with a zero balance: no position at all
    assert.deepStrictEqual((await set.positionsOf(A(0x999), WPLS_USD)).positions, []);
    // positions are placed by watch.js in `external` (never `positions`): the reader has no way to act on them
    assert.ok(!/sendTransaction|signTransaction|signMessage|new ethers\.Wallet|\.approve\(|setApprovalForAll|\.deposit\(|\.withdraw\(|harvest|getReward/.test(fs.readFileSync(path.join(__dirname, "..", "v2lp.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), "v2lp.js has no write path");
  }

  // ---- 4. v1 / v2 separation ----------------------------------------------------------------
  {
    const w = baseWorld();
    const a = w.pair(A(0x411), F1, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(100, 18) });
    const b = w.pair(A(0x412), F2, WPLS, DAI, units(500_000, 18), units(25_000, 18), units(5_000, 18), { [WALLET]: units(100, 18) });
    const foreign = w.pair(A(0x413), FX, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(100, 18) });
    const cfg = cfgOf();
    cfg.contracts.v2lp[0].pairs = [a, b, foreign];   // pinned on the wrong reader and a foreign pair on purpose
    cfg.contracts.v2lp[1].pairs = [a, b, foreign];
    const r = await setOf(w, cfg).positionsOf(WALLET, WPLS_USD);
    assert.deepStrictEqual(r.positions.map((p) => p.tokenId).sort(), [`pulsex-v1-${a}`, `pulsex-v2-${b}`].sort(), "the same token pair on v1 and v2 gives two positions, each on its own factory");
    assert.ok(r.positions.every((p) => p.pairAddress !== foreign), "a pair of an unconfigured factory is ignored");
    assert.ok(r.errors.some((e) => e.error.includes(foreign)), "and a pinned foreign pair is reported, not silently dropped");
    // an LP whose symbol is "PLP" but whose factory is not ours is not accepted either (the spam token case)
    const spam = A(0x414); w.token(spam, "PLP", 18, { [WALLET]: units(5, 18) });
    const cfg2 = cfgOf(); cfg2.contracts.v2lp[0].pairs = [spam];
    assert.deepStrictEqual((await setOf(w, cfg2).positionsOf(WALLET, WPLS_USD)).positions, []);
    // a symbol that is markup is reduced to plain text
    const evilTok = A(0x415); w.token(evilTok, "<img src=x onerror=alert(1)>", 18);
    const ev = w.pair(A(0x416), F1, evilTok, DAI, units(1000, 18), units(1000, 18), units(10, 18), { [WALLET]: units(1, 18) });
    const cfg3 = cfgOf(); cfg3.contracts.v2lp[0].pairs = [ev];
    const e3 = (await setOf(w, cfg3).positionsOf(WALLET, WPLS_USD)).positions[0];
    assert.ok(!/[<>]/.test(e3.pair + e3.symbol0), `symbol sanitised: ${e3.pair}`);
  }

  // ---- 5. unpriced sides, own-pair circularity, thin pairs ------------------------------------
  {
    const w = baseWorld();
    const MEME = A(0x421), MEME2 = A(0x422), THIN = A(0x423);
    for (const t of [MEME, MEME2, THIN]) w.token(t, "T" + (t % 16), 18);
    // MEME has only its own pair with WPLS: it must not be priced from it
    const ownOnly = w.pair(A(0x431), F2, MEME, WPLS, units(1_000_000, 18), units(1_000_000, 18), units(1000, 18), { [WALLET]: units(10, 18) });
    // two memes paired together, neither priced anywhere
    const none = w.pair(A(0x432), F2, MEME2, THIN, units(1000, 18), units(1000, 18), units(1000, 18), { [WALLET]: units(10, 18) });
    // THIN has a WPLS pool worth under $100 on the WPLS side (1,000 WPLS * 0.05 = $50) and nothing else
    const thin = w.pair(A(0x433), F1, THIN, WPLS, units(1000, 18), units(1000, 18), units(100, 18), { [WALLET]: units(10, 18) });
    const cfg = cfgOf(); cfg.contracts.v2lp[0].pairs = [thin]; cfg.contracts.v2lp[1].pairs = [ownOnly, none];
    const r = await setOf(w, cfg).positionsOf(WALLET, WPLS_USD);
    const byPair = (p) => r.positions.find((x) => x.pairAddress === p);
    assert.strictEqual(byPair(ownOnly).valueUsd, null, "a pair's own ratio does not price its own token");
    assert.ok(/outside this pair/.test(byPair(ownOnly).valueNote), byPair(ownOnly).valueNote);
    assert.strictEqual(byPair(none).valueUsd, null, "no pool at all: unpriced, not 0");
    assert.ok(byPair(none).valueNote && !byPair(none).valueUsd && byPair(none).valueUsd !== 0);
    // thin pool is flagged, and not used as a price source: MEME2/THIN stays unpriced although THIN has a (thin) WPLS pool
    assert.strictEqual(byPair(thin).thin, true, "a pair whose quote side is under the minimum is thin");
    assert.strictEqual(byPair(none).valueUsd, null);
    assert.ok(/thin pools are not a price source|no price outside/.test(byPair(none).valueNote), byPair(none).valueNote);
    // a second, deep pool for MEME on the other factory prices it for the pair held on this one
    w.pair(A(0x434), F1, MEME, DAI, units(10_000, 18), units(20_000, 18), units(1, 18));     // MEME = $2
    const r2 = await setOf(w, cfg).positionsOf(WALLET, WPLS_USD);
    const priced = r2.positions.find((x) => x.pairAddress === ownOnly);
    assert.strictEqual(priced.usd0, 2, "MEME priced from a different pair");
    // the held MEME/WPLS pair is 1:1 in units but MEME is priced at $2 and WPLS at $0.05 elsewhere: the sides
    // (10,000 MEME * $2 vs 10,000 WPLS * 0.05) disagree by far more than 10%: the value is kept as 2 x the smaller side but flagged
    // and not counted. The MEME side is also capped at what 10,000 MEME realise through the MEME/DAI pool (10,000 / 20,000 DAI): 10,000 DAI.
    assert.strictEqual(priced.side0Usd, 10_000); assert.strictEqual(priced.side1Usd, 500);
    assert.strictEqual(priced.valueUsd, 1000);
    assert.ok(priced.priceGapPct > 90 && /priced 95% apart/.test(priced.valueNote), priced.valueNote);
    assert.strictEqual(priced.counted, false); assert.ok(/not counted/.test(priced.countNote), priced.countNote);
    // consistent sides: value = 2 x the smaller side. MEME/WPLS reserves 25,000 MEME ($2) vs 1,000,000 WPLS ($0.05) = $50,000 each side
    {
      const w3 = baseWorld(); const M = A(0x4A1); w3.token(M, "MEME", 18);
      const held = w3.pair(A(0x4A2), F2, M, WPLS, units(25_000, 18), units(1_000_000, 18), units(1000, 18), { [WALLET]: units(10, 18) });
      w3.pair(A(0x4A3), F1, M, DAI, units(10_000, 18), units(20_000, 18), units(1, 18));
      const c3 = cfgOf(); c3.contracts.v2lp[1].pairs = [held];
      const ok3 = (await setOf(w3, c3).positionsOf(WALLET, WPLS_USD)).positions[0];
      const cap250 = 20_000 * 250 / 10_250;           // 250 MEME sold through the MEME/DAI pool (x*y=k), below 250 x $2
      assert.ok(Math.abs(ok3.valueUsd - 2 * Math.min(cap250, 10_000 * WPLS_USD)) < 1e-9, "2 x min(capped side0Usd, side1Usd)");
      assert.strictEqual(ok3.counted, true, "an anchor side, no gap, not thin: counted"); assert.strictEqual(ok3.priceGapPct, undefined);
      // within 10%: 5% apart is valued as 2 x the smaller side
      const w4 = baseWorld(); w4.token(M, "MEME", 18); w4.pair(A(0x4A3), F1, M, DAI, units(10_000, 18), units(20_000, 18), units(1, 18));
      const near = w4.pair(A(0x4A4), F2, M, WPLS, units(25_000, 18), units(1_050_000, 18), units(1000, 18), { [WALLET]: units(10, 18) });
      const c4 = cfgOf(); c4.contracts.v2lp[1].pairs = [near];
      const n4 = (await setOf(w4, c4).positionsOf(WALLET, WPLS_USD)).positions[0];
      assert.ok(Math.abs(n4.valueUsd - 2 * Math.min(cap250, 10_500 * WPLS_USD)) < 1e-9);
    }
    // the forked pDAI is not a dollar: it is not in the stable list, so it is priced like any token
    const pd = w.pair(A(0x435), F1, PDAI, WPLS, units(1000, 18), units(1_000_000, 18), units(100, 18), { [WALLET]: units(10, 18) });
    const cfg2 = cfgOf(); cfg2.contracts.v2lp[0].pairs = [pd];
    const rp = await setOf(w, cfg2).positionsOf(WALLET, WPLS_USD);
    assert.strictEqual(rp.positions[0].usd0, null, "pDAI (same symbol as DAI) is keyed by address and gets no $1");
    // WPLS/USD unavailable: WPLS is unpriced, values are null with a reason
    const rn = await setOf(w, cfg2).positionsOf(WALLET, null);
    assert.strictEqual(rn.positions[0].valueUsd, null); assert.ok(/PLS\/USD/.test(rn.positions[0].valueNote));
  }

  // ---- 6. discovery -----------------------------------------------------------------------------
  {
    // (b) explorer JSON list: one pair token, one random ERC-20 (factory() reverts), one foreign pair
    const w = baseWorld();
    const lp = w.pair(A(0x501), F2, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(100, 18) });
    const rand = A(0x502); w.token(rand, "RND", 18, { [WALLET]: units(1, 18) });
    const foreign = w.pair(A(0x503), FX, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(100, 18) });
    const seen = [];
    const list = [lp, rand, foreign].map((a) => ({ token: { address_hash: a, type: "ERC-20", symbol: "PLP" }, value: "1" }));   // the random ERC-20 pretends to be a PLP: confirmed on chain
    list.push({ token: { address_hash: A(0x504), type: "ERC-721" }, value: "1" });
    const bsFetch = async (p) => { seen.push(p); return html("application/json; charset=utf-8", JSON.stringify(list)); };
    const cfg = cfgOf();
    const r = await setOf(w, cfg, { bsFetch }).positionsOf(WALLET, WPLS_USD);
    assert.deepStrictEqual(r.positions.map((p) => p.pairAddress), [lp], "the random ERC-20 and the foreign pair are rejected on chain");
    assert.ok(seen[0].startsWith(`/v2/addresses/${WALLET}/token-balances`));
    assert.ok(!w.sub.some((c) => c.name === "allPairs"), "a working explorer list needs no enumeration");

    // (c) HTML / Cloudflare answer -> unavailable -> enumeration, with a call budget and a cursor
    const w2 = baseWorld();
    const N = 400, held = 230;
    const pairs = [];
    for (let i = 0; i < N; i++) pairs.push(w2.pair(A(0x10000 + i), F2, w2.token(A(0x70000 + i), "U" + i, 18), DAI, units(1000, 18), units(50, 18), units(100, 18), i === held ? { [WALLET]: units(10, 18) } : {}));
    const warns = [];
    const cfg2 = cfgOf(); cfg2.contracts.v2lp = [{ name: "pulsex-v2", factory: F2, scanBudget: 4 }];
    const dir = fs.mkdtempSync(path.join(TMP, "scan-"));
    const cf = html("text/html", "<html>Just a moment...</html>");
    const mk = () => v2lp.createSet({ provider: w2.runner, cfg: cfg2, bsFetch: async () => cf, dataDir: dir, log: { ...quiet, warn: (m) => warns.push(m) } });
    let res = await mk().positionsOf(WALLET, WPLS_USD);
    assert.strictEqual(res.positions.length, 0, "the held pair is further along than the first refresh reaches");
    assert.strictEqual(res.partial, true); assert.ok(res.notes.some((n) => /partial/.test(n)), res.notes.join("|"));
    assert.ok(warns.length === 1 && /unavailable/.test(warns[0]), `unavailable is said once: ${warns}`);
    assert.ok(w2.sub.filter((c) => c.name === "allPairs").length <= 150, "bounded work per refresh");
    const cursor = JSON.parse(fs.readFileSync(path.join(dir, "v2lp-scan-pulsex-v2.json"), "utf8"));
    assert.strictEqual(cursor.wallets[WALLET.toLowerCase()].next, 150, "the cursor is persisted");
    w2.sub.length = 0;
    res = await mk().positionsOf(WALLET, WPLS_USD);        // a new instance (a restart) resumes from the file
    assert.strictEqual(res.positions.length, 1, "found on the second refresh");
    assert.strictEqual(res.positions[0].pairAddress, pairs[held]);
    assert.strictEqual(w2.sub.filter((c) => c.name === "allPairs").length, 150, "one bounded range, resumed after the first 150 (not from 0)");
    assert.strictEqual(res.partial, true, "still partial until the end of the list");
    res = await mk().positionsOf(WALLET, WPLS_USD);
    assert.strictEqual(res.partial, false, "complete after the third refresh");
    assert.strictEqual(res.positions.length, 1, "the held pair stays in the cursor");

    // without Multicall3 the same reads work through plain calls
    const w3 = baseWorld({ multicall: false });
    const lp3 = w3.pair(A(0x601), F1, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(100, 18) });
    const c3 = cfgOf(); c3.contracts.v2lp[0].pairs = [lp3];
    const r3 = await setOf(w3, c3).positionsOf(WALLET, WPLS_USD);
    assert.strictEqual(r3.positions[0].valueUsd, 10_000 * WPLS_USD + 500);

    // a bounded number of pairs is read in full; the rest is said
    const w4 = baseWorld();
    const many = [];
    for (let i = 0; i < 12; i++) many.push(w4.pair(A(0x20000 + i), F1, w4.token(A(0x71000 + i), "U" + i, 18), DAI, units(1000, 18), units(50, 18), units(100, 18), { [WALLET]: units(1, 18) }));
    const c4 = cfgOf(); c4.contracts.v2lp[0].pairs = many; c4.contracts.v2lp[0].maxPairs = 5;
    const r4 = await setOf(w4, c4).positionsOf(WALLET, WPLS_USD);
    assert.strictEqual(r4.positions.length, 5); assert.ok(r4.partial && r4.notes.some((n) => /limit 5/.test(n)));
    // a token whose decimals cannot be read is never valued on a guess
    const w5 = baseWorld();
    const bad = A(0x701); w5.token(bad, "BAD", 18);
    const p5 = w5.pair(A(0x702), F1, bad, DAI, units(1000, 18), units(1000, 18), units(10, 18), { [WALLET]: units(1, 18) });
    w5.failCall = (to, name) => to === bad.toLowerCase() && name === "decimals";
    const c5 = cfgOf(); c5.contracts.v2lp[0].pairs = [p5];
    const r5 = await setOf(w5, c5).positionsOf(WALLET, WPLS_USD);
    assert.strictEqual(r5.positions.length, 0); assert.ok(r5.errors.some((e) => /decimals were not read/.test(e.error)));
  }

  // ---- 7. WPLS pricing from a v2 pair's reserves --------------------------------------------------
  {
    const { makeGetWethUsd } = require("../pricing");
    const w = baseWorld();
    const ref = w.pair(A(0x801), F1, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(1, 18));
    const refU = w.pair(A(0x802), F1, USDC, WPLS, units(2_500, 6), units(100_000, 18), units(1, 18));          // token0 = USDC, 6 decimals
    const shallow = w.pair(A(0x803), F1, WPLS, DAI, units(1_000, 18), units(500, 18), units(1, 18));
    const u = { getToken: async (a) => ({ decimals: Number(w.ents[a.toLowerCase()].decimals), decimalsOk: true }) };
    const rate = async (pair, stable, extra = {}) => makeGetWethUsd({ cfg: { contracts: { weth: WPLS }, usdReference: { stable, feeTier: 100, pair, minLiquidityUsd: 1000, ...extra } }, unit: null, factory: null, provider: w.runner, u })();
    assert.strictEqual(await rate(ref, DAI), 0.05);
    assert.ok(Math.abs((await rate(refU, USDC)) - 0.025) < 1e-12, "stable on the token0 side with 6 decimals");
    assert.strictEqual(await rate(shallow, DAI), null, "stable side below the minimum: unpriced");
    assert.strictEqual(await rate(shallow, DAI, { minLiquidityUsd: 100 }), 0.5, "the floor is configurable");
    assert.strictEqual(await rate(ref, USDC), null, "a pair that is not weth/stable is refused");
    // numeraire with a fixed rate still short-circuits; settings carries the field through
    const s = require("../settings").load({ file: path.join(__dirname, "..", "settings.pulsechain.example.json") });
    assert.strictEqual(s.usdReference.pair, "0xE56043671df55dE5CDf8459710433C10324DE0aE");
    assert.strictEqual(s.usdReference.minLiquidityUsd, 1000);
    const rh = require("../settings").load({ file: path.join(__dirname, "..", "settings.example.json") });
    assert.ok(!("pair" in rh.usdReference), "a chain without usdReferencePair keeps the v3 path unchanged");
    assert.deepStrictEqual(Object.keys(rh.usdReference).sort(), ["feeTier", "stable"]);
  }

  // ---- 8. the farm adapter (view-only) ------------------------------------------------------------
  {
    const w = baseWorld();
    const INC = A(0x901); w.token(INC, "INC", 18);
    const pa = w.pair(A(0x902), F1, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(20, 18) });
    const notPair = A(0x903); w.token(notPair, "NOT", 18);
    const FARM = A(0x904);
    w.farm(FARM, INC, [pa, notPair], { [`0:${WALLET.toLowerCase()}`]: [units(100, 18), units(5, 18)], [`1:${WALLET.toLowerCase()}`]: [units(7, 18), 0n] });
    // INC priced by a deep INC/DAI pool
    w.pair(A(0x905), F2, INC, DAI, units(1000, 18), units(3000, 18), units(1, 18));      // INC = $3
    const cfg = cfgOf({ pulsex: { farms: [{ name: "pulsex-farm", address: FARM, kind: "pulsex-masterchef" }] } });
    cfg.contracts.pulsex.farms = [{ name: "pulsex-farm", address: FARM, kind: "pulsex-masterchef" }];
    cfg.contracts.v2lp[0].pairs = [pa];
    const r = await setOf(w, cfg).positionsOf(WALLET, WPLS_USD);
    assert.deepStrictEqual(r.errors, []);
    const wallet = r.positions.find((p) => !p.staked), farm = r.positions.find((p) => p.staked);
    assert.ok(wallet && farm, "LP in the wallet and LP in the farm are two positions");
    assert.strictEqual(wallet.lpBalance, 20);
    assert.strictEqual(farm.lpBalance, 100, "the staked LP amount");
    assert.strictEqual(farm.sharePct, 1);
    assert.strictEqual(farm.valueUsd, 10_000 * WPLS_USD + 500, "valued like unstaked LP");
    assert.strictEqual(farm.farm, "pulsex-farm"); assert.strictEqual(farm.pid, 0); assert.strictEqual(farm.farmAddress, FARM);
    assert.strictEqual(farm.rewards.amount, 5); assert.strictEqual(farm.rewards.symbol, "INC"); assert.strictEqual(farm.rewards.usd, 15);
    assert.notStrictEqual(farm.tokenId, wallet.tokenId);
    assert.ok(r.notes.some((n) => /pool 1/.test(n) && /not a pair of a configured PulseX factory/.test(n)), `a stake in a non-pair pool is said: ${r.notes}`);
    // every call the adapter made is a view
    const names = new Set(w.sub.map((c) => c.name));
    for (const n of names) assert.ok(/^(symbol|decimals|balanceOf|totalSupply|factory|token0|token1|getReserves|getPair|allPairs|allPairsLength|poolLength|poolInfo|userInfo|pendingInc|inc)$/.test(n), n);
    // an unsupported kind is refused, a farm that cannot be read is an error entry not a crash
    assert.throws(() => v2lp.createFarm({ provider: w.runner, shared: v2lp.makeShared({ provider: w.runner, cfg }), spec: { name: "x", address: FARM, kind: "other" } }), /unsupported kind/);
    w.failCall = (to, name) => to === FARM.toLowerCase() && name === "poolLength";
    const rf = await setOf(w, cfg).positionsOf(WALLET, WPLS_USD);
    assert.ok(rf.errors.some((e) => /farm pulsex-farm could not be read/.test(e.error)));
    assert.strictEqual(rf.positions.filter((p) => !p.staked).length, 1, "the wallet's own LP is still shown");
  }

  // ---- 9. review fixes: forged pairs, supply sanity, retries, request splitting, list caps --------------------
  {
    const { iface, MC } = require("./fixtures/mock-pulse");
    // 9a. a contract that claims factory() = F1 but that F1 does not list is rejected
    const w = baseWorld();
    const real = w.pair(A(0xA01), F1, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(100, 18) });
    const forged = A(0xA02);
    w.ents[forged.toLowerCase()] = { kind: "pair", symbol: "PLP", decimals: 18, factory: F1, t0: WPLS, t1: DAI, r0: units(1_000_000, 18), r1: units(50_000, 18), supply: units(10_000, 18), balances: new Map([[WALLET.toLowerCase(), units(9_000, 18)]]) };
    const cfg = cfgOf(); cfg.contracts.v2lp[0].pairs = [real, forged];
    const set = setOf(w, cfg);
    const r = await set.positionsOf(WALLET, WPLS_USD);
    assert.deepStrictEqual(r.positions.map((p) => p.pairAddress), [real], "the forged factory() claim is rejected: the real factory lists another pair");
    assert.ok(r.errors.some((e) => e.error.includes(forged)), "and a pinned forged pair is reported");
    const inf = (await set.shared.pairInfo([forged]))[0];
    assert.strictEqual(inf.ok, false); assert.strictEqual(inf.definite, true, "a factory that disowns the pair is a definite answer");
    // 9b. a genuine pair whose wallet balance exceeds totalSupply is rejected
    const w2 = baseWorld();
    const bad = w2.pair(A(0xA11), F1, WPLS, DAI, units(1000, 18), units(50, 18), units(100, 18), { [WALLET]: units(101, 18) });
    const c2 = cfgOf(); c2.contracts.v2lp[0].pairs = [bad];
    const r2 = await setOf(w2, c2).positionsOf(WALLET, WPLS_USD);
    assert.deepStrictEqual(r2.positions, []); assert.ok(r2.errors.some((e) => /exceeds totalSupply/.test(e.error)), JSON.stringify(r2.errors));
    // wallet + staked together over the supply: also rejected
    const w2b = baseWorld(); const INC = A(0xA1F); w2b.token(INC, "INC", 18);
    const pb = w2b.pair(A(0xA12), F1, WPLS, DAI, units(1000, 18), units(50, 18), units(100, 18), { [WALLET]: units(60, 18) });
    const FARM = A(0xA13); w2b.farm(FARM, INC, [pb], { [`0:${WALLET.toLowerCase()}`]: [units(50, 18), 0n] });
    const c2b = cfgOf(); c2b.contracts.pulsex.farms = [{ name: "f", address: FARM, kind: "pulsex-masterchef" }];
    const r2b = await setOf(w2b, c2b).positionsOf(WALLET, WPLS_USD);
    assert.deepStrictEqual(r2b.positions, []); assert.ok(r2b.errors.some((e) => /exceeds totalSupply/.test(e.error)));
    // 9c. failed sub-calls are not negative-cached for hours; definite answers are
    const w3 = baseWorld();
    const lp = w3.pair(A(0xA21), F1, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(100, 18) });
    const erc = A(0xA22); w3.token(erc, "RND", 18);
    const foreign = w3.pair(A(0xA23), FX, WPLS, DAI, units(1000, 18), units(50, 18), units(100, 18));
    const S3 = v2lp.makeShared({ provider: w3.runner, cfg: cfgOf(), persist: false, log: quiet });
    w3.netFail = (to, name) => to === lp.toLowerCase() && name === "factory";     // a transport failure, not a revert
    let i3 = (await S3.pairInfo([lp, erc, foreign, A(0xA24)]));
    assert.strictEqual(i3[0].ok, false); assert.strictEqual(i3[0].definite, false, "a transport failure of factory() is not a definite no");
    assert.strictEqual(i3[3].definite, true, "no contract at all: definite");
    assert.strictEqual(i3[2].definite, true, "a decoded foreign factory: definite");
    assert.strictEqual(i3[1].definite, true, "factory() reverting on a contract that has code: definite");
    const ercProbes = () => w3.sub.filter((c) => c.to === erc.toLowerCase() && c.name === "factory").length;
    const ercBefore = ercProbes();
    w3.netFail = null;
    const realNow = Date.now; let clock = realNow();
    Date.now = () => clock;
    try {
      assert.strictEqual((await S3.pairInfo([lp]))[0].ok, false, "within the retry window the failure stands");
      clock += 61e3;
      assert.strictEqual((await S3.pairInfo([lp]))[0].ok, true, "a transient failure is retried after about a minute and accepted");
      assert.strictEqual(ercProbes(), ercBefore, "(not probed again within the window)");
      await S3.pairInfo([erc]);
      assert.strictEqual(ercProbes(), ercBefore, "the reverting factory() is probed once, not again after 61 s (cached for the long TTL)");
      clock += 7 * 3600e3;
      const before = w3.sub.length;
      await S3.pairInfo([foreign]);
      assert.ok(w3.sub.length > before, "a definite negative expires after the long TTL");
      // token0/getPair failure also retries soon
      const lp2 = w3.pair(A(0xA25), F1, USDC, USDT, units(1000, 6), units(1000, 6), units(10, 18));
      w3.failCall = (to, name) => to === F1.toLowerCase() && name === "getPair";
      assert.strictEqual((await S3.pairInfo([lp2]))[0].definite, false, "getPair failure is retried, not remembered");
      w3.failCall = null; clock += 61e3;
      assert.strictEqual((await S3.pairInfo([lp2]))[0].ok, true);
      // a gas-starved sub-call inside a COMPLETED aggregate3 (success:false, though a plain call works) is re-run and the LP found
      const lp3 = w3.pair(A(0xA26), F1, USDC, DAI, units(1000, 6), units(1000, 18), units(10, 18));
      const fillers = Array.from({ length: 12 }, (_, k) => w3.token(A(0xA300 + k), "F" + k, 18));
      w3.starve = (to, name, n) => to === lp3.toLowerCase() && n > 1;
      const S3b = v2lp.makeShared({ provider: w3.runner, cfg: cfgOf(), persist: false, log: quiet });
      const got3 = await S3b.pairInfo([...fillers, lp3]);
      assert.strictEqual(got3[12].ok, true, "the starved factory() sub-call was retried in a smaller batch and the LP found");
      w3.starve = null;
    } finally { Date.now = realNow; }
    // 9d. when aggregate3 itself throws, the chunk is halved and retried, down to plain calls
    const w4 = baseWorld();
    const many = [];
    for (let i = 0; i < 40; i++) many.push(w4.pair(A(0xB000 + i), F1, w4.token(A(0xB800 + i), "T", 18), DAI, units(1000, 18), units(50, 18), units(100, 18), { [WALLET]: units(1, 18) }));
    const origCall = w4.runner.call; let thrown = 0, plain = 0;
    w4.runner.call = async (tx) => {
      if (tx.to.toLowerCase() === MC.toLowerCase()) { const n = iface.parseTransaction({ data: tx.data }).args[0].length; if (n > 5) { thrown++; throw new Error("out of gas"); } }
      else plain++;
      return origCall(tx);
    };
    const S4 = v2lp.makeShared({ provider: w4.runner, cfg: cfgOf(), persist: false, log: quiet });
    const got = await S4.batch(many.map((a) => ({ target: a, data: new ethers.Interface(["function token0() view returns (address)"]).encodeFunctionData("token0") })));
    assert.ok(thrown > 0, "the oversized chunk threw");
    assert.ok(got.every((g) => g.ok), "every call was answered after splitting");
    // a single call that keeps failing ends as a transient failure, not a throw, and the extra requests are bounded
    w4.runner.call = async () => { throw new Error("node down"); };
    const dead = await S4.batch(many.map((a) => ({ target: a, data: "0x" })));
    assert.ok(dead.every((g) => !g.ok && g.transient), "unreachable node: transient failures");
    assert.ok(S4.rpcCalls < 400, "bounded extra requests: " + S4.rpcCalls);
    // 9e. explorer list: item cap and body size cap
    const w5 = baseWorld();
    const lp5 = w5.pair(A(0xC01), F1, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(100, 18) });
    const items = [];
    for (let i = 0; i < 2100; i++) items.push({ token: { address_hash: A(0xD000 + i), type: "ERC-20" }, value: "1" });
    items.push({ token: { address_hash: lp5, type: "ERC-20" }, value: "1" });      // beyond the cap: not read
    const S5 = v2lp.makeShared({ provider: w5.runner, cfg: cfgOf(), persist: false, log: quiet, bsFetch: async () => html("application/json", JSON.stringify(items)) });
    const l5 = await S5.listing(WALLET);
    assert.strictEqual(l5.ok, true); assert.strictEqual(l5.tokens.length, 2000, "item count capped"); assert.ok(!l5.tokens.includes(lp5));
    const huge = { ok: true, status: 200, headers: { get: (h) => (/length/i.test(h) ? String(50 * 1024 * 1024) : "application/json") }, json: async () => { throw new Error("must not parse"); }, text: async () => { throw new Error("must not read"); } };
    const warns = [];
    const S6 = v2lp.makeShared({ provider: w5.runner, cfg: cfgOf(), persist: false, log: { ...quiet, warn: (m) => warns.push(m) }, bsFetch: async () => huge });
    assert.strictEqual((await S6.listing(WALLET)).ok, false, "a declared oversized body is refused before parsing");
    const big = { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => " ".repeat(5 * 1024 * 1024) + "[]" };
    await assert.rejects(() => v2lp.readJsonCapped(big, 4 * 1024 * 1024), /too large/);
    const enc = new TextEncoder().encode(" ".repeat(1024) + "[]");
    const streamed = { headers: { get: () => null }, body: { getReader() { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: enc })), cancel: async () => {} }; } } };
    assert.deepStrictEqual(await v2lp.readJsonCapped(streamed, 4096), []);
    await assert.rejects(() => v2lp.readJsonCapped(streamed, 100), /too large/, "a streamed body over the cap is cut off");
  }

  // ---- 10. valuation: per-side depth cap, flagged gaps, what counts toward totals ---------------------
  {
    // two non-anchor tokens, each priced from a pool that holds only $101 on its quote side, at absurd prices ($101 a token)
    const w = baseWorld(); const TA = A(0x601), TB = A(0x602); w.token(TA, "AAA", 18); w.token(TB, "BBB", 18);
    w.pair(A(0x611), F1, TA, DAI, units(1, 18), units(101, 18), units(1, 18));
    w.pair(A(0x612), F1, TB, DAI, units(1, 18), units(101, 18), units(1, 18));
    const ab = w.pair(A(0x613), F2, TA, TB, units(1_000_000, 18), units(1_000_000, 18), units(1000, 18), { [WALLET]: units(100, 18) });
    // an anchor pair whose sides are 15% apart, with MEME priced $2 from a deep pool
    const M = A(0x603); w.token(M, "MEME", 18);
    w.pair(A(0x614), F1, M, DAI, units(10_000, 18), units(20_000, 18), units(1, 18));
    const gap = w.pair(A(0x615), F2, M, WPLS, units(25_000, 18), units(1_150_000, 18), units(1000, 18), { [WALLET]: units(10, 18) });
    // an ordinary WPLS / DAI pair
    const wd = w.pair(A(0x616), F2, WPLS, DAI, units(1_000_000, 18), units(50_000, 18), units(10_000, 18), { [WALLET]: units(100, 18) });
    const cfg = cfgOf(); cfg.contracts.v2lp[1].pairs = [ab, gap, wd];
    const r = await setOf(w, cfg).positionsOf(WALLET, WPLS_USD);
    const by = (a) => r.positions.find((x) => x.pairAddress === a);
    assert.ok(by(ab).valueUsd > 0 && by(ab).valueUsd <= 202.01, `each side is capped at its $101 source pool: ${by(ab).valueUsd}`);
    assert.ok(by(ab).side0Usd < 101 && by(ab).side1Usd < 101);
    assert.strictEqual(by(ab).counted, false, "neither side is an anchor: not counted"); assert.ok(/neither side is WPLS/.test(by(ab).countNote), by(ab).countNote);
    const cap = 20_000 * 250 / 10_250;
    assert.ok(Math.abs(by(gap).valueUsd - 2 * cap) < 1e-9, "the 2 x min value is kept, not nulled");
    assert.ok(by(gap).priceGapPct > 10 && by(gap).priceGapPct < 20, String(by(gap).priceGapPct));
    assert.ok(/approximation/.test(by(gap).valueNote), by(gap).valueNote);
    assert.strictEqual(by(gap).counted, false); assert.ok(/disagree/.test(by(gap).countNote));
    assert.strictEqual(by(wd).valueUsd, 2 * 500); assert.strictEqual(by(wd).counted, true); assert.strictEqual(by(wd).countNote, undefined);
    assert.strictEqual(r.positions.filter((p) => p.counted).reduce((s, p) => s + p.valueUsd, 0), 1000, "only the normal WPLS / DAI LP counts");
    // pinned pairs are probed in their own batch before the explorer list
    {
      const w2 = baseWorld(); const pin = w2.pair(A(0x621), F1, WPLS, DAI, units(1000, 18), units(50, 18), units(100, 18), { [WALLET]: units(1, 18) });
      const other = w2.pair(A(0x622), F1, USDC, USDT, units(1000, 6), units(1000, 6), units(100, 18));
      const c2 = cfgOf(); c2.contracts.v2lp[0].pairs = [pin];
      const bs = async () => html("application/json", JSON.stringify([{ token: { address_hash: other, type: "ERC-20", symbol: "PLP" }, value: "1" }, { token: { address_hash: A(0x623), type: "ERC-20", symbol: "OTHER" }, value: "1" }]));
      w2.sub.length = 0; w2.calls.length = 0;
      await setOf(w2, c2, { bsFetch: bs }).positionsOf(WALLET, WPLS_USD);
      const fac = w2.sub.filter((c) => c.name === "factory").map((c) => c.to);
      assert.deepStrictEqual(fac.slice(0, 2), [pin.toLowerCase(), other.toLowerCase()].slice(0, 2), "pinned first");
      assert.ok(!fac.includes(A(0x623).toLowerCase()), "an explorer item whose symbol is not PLP is not probed");
      const aggFirst = w2.calls.filter((c) => c.name === "aggregate3")[0];
      assert.strictEqual(aggFirst.n, 1, "the first aggregate3 holds one call");
      assert.deepStrictEqual(w2.sub.slice(0, 1), [{ to: pin.toLowerCase(), name: "factory" }], "and it is the pinned pair's factory()");
    }
  }

  console.log("v2lp: math, v1/v2 separation, unpriced/thin, discovery with budget and cursor, WPLS pricing and the farm adapter passed");
})().catch((e) => { console.error(e); process.exit(1); });
