// node test/aggregate.test.js -- the cross-chain aggregation, without HTTP (aggregate.js).
//
// What matters: the grand total is exactly what was counted (lp + fees + pending rewards + tokens),
// nothing is counted twice, a chain that is down / slow / stale is never shown as $0, and nothing
// from an instance except a whitelisted handful of fields reaches the output.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const agg = require("../aggregate");
const F = require("./lib/aggregate-fixtures");
const { addr, lp, ext, reward, tok, row } = F;

const CH = [
  { key: "a", label: "Alpha", accent: "#111111", port: 1 },
  { key: "b", label: "Beta", accent: "#222222", port: 2 },
  { key: "c", label: "Gamma", accent: "#333333", port: 3 },
];
const clock = { t: F.AT + 60000 };
/** A responder table: data[chainKey][part] is a payload, {__code}, {__http, body} or {__raw}. */
function make(data, opts = {}) {
  const calls = [];
  const ag = agg.createAggregator({
    chains: opts.chains || CH, now: () => clock.t, waitMs: 1000, ttlMs: 30000, ...opts,
    fetchJson: async (chain, p) => {
      calls.push(`${chain.key}${p}`);
      const part = p.split("/").pop();
      const v = data[chain.key] && data[chain.key][part];
      if (v === undefined) return { code: "unreachable" };
      if (v && v.__code) return { code: v.__code };
      if (v && v.__http) return { status: v.__http, data: v.body };
      if (v && v.__raw) return v.__raw;
      return { status: 200, data: JSON.parse(JSON.stringify(v, (k, x) => (typeof x === "number" && !Number.isFinite(x) ? "__nf" : x)), (k, x) => (x === "__nf" ? (k === "neg" ? -1 : Infinity) : x)) };
    },
  });
  ag.calls = calls;
  return ag;
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
const sum = (o) => Object.values(o).filter((v) => v !== null).reduce((x, y) => x + y, 0);

// ---- scenario: three chains, wallets M (main), W1, W2/W3, P ---------------------------------
const M = addr(1), W1 = addr(2), W3 = addr(3), P = addr(4), SN = addr(5050);
function scenario() {
  const a = {
    positions: F.positions(M, {
      positions: [lp(101, { valueUsd: 1000, feesUsd: 10 }), lp("v4-202", { valueUsd: 500, feesUsd: 5, pair: "X / Y" })],
      external: [ext("aerodrome-cl2", 55, { staked: true, valueUsd: 300, feesUsd: 0, rewards: reward(12.5) })],
    }),
    watch: F.watch([F.walletRow(W1, "Wallet 1", {
      positions: [lp(301, { valueUsd: 200, feesUsd: 4 })],
      holdings: { ok: true, unscaled: [], tokens: [tok("ETH", 50, { native: true }), tok("SPAM", null)] },
    })]),
    portfolio: F.portfolio(M, [
      row("ETH", 1, 2000, { native: true }),
      // wallet 100, but `pools`/`fees`/`usd` include LP principal and fees that /api/positions already values
      row("USDC", 100, 1, { pools: 100, fees: 2, usd: 207, total: 202 }),
      row("POOLONLY", 0, 3, { source: "pools", pools: 5, usd: 15 }),
      row("sNET", 10, 5, { assumed: true, address: SN }),
    ]),
    staking: F.staking([F.stakeTok(SN, 10, 50)]),
  };
  const b = {
    positions: F.positions(M, { ownerLabel: "Treasury", positions: [lp(7, { valueUsd: 100, feesUsd: 1 })] }),
    watch: F.watch([
      F.walletRow(M, "Treasury", { positions: [lp(7, { valueUsd: 100, feesUsd: 1 })] }),
      F.walletRow(W3, "Wallet 3", { holdings: { ok: true, unscaled: [], tokens: [tok("USDC", 30)] } }),
    ]),
    portfolio: F.portfolio(M, [row("USDC", 20, 1, { address: addr(222) })]),
    staking: F.staking(),
  };
  const c = {
    positions: F.positions(P, {
      ownerLabel: "Pulse",
      external: [
        ext("PulseX v2", "p1", { staked: true, valueUsd: 400, counted: true, thin: false, rewards: reward(3) }),
        ext("PulseX v2", "p2", { valueUsd: 99, counted: false, priceGapPct: 25 }),
        ext("PulseX v2", "p3", { valueUsd: 77, thin: true, counted: true, rewards: reward(5) }),
        ext("PulseX v2", "p4", { valueUsd: null, rewards: reward(null) }),
        ext("PulseX v2", "p5", { valueUsd: 10, rewards: reward(8, { killed: true }) }),
        ext("PulseX v2", "p6", { valueUsd: 11, counted: false }),
      ],
    }),
    watch: F.watch(),
    portfolio: F.portfolio(P, [row("NOPRICE", 3, null), row("BROKEN", 4, 1, { unavailable: "decimals not read" })]),
    staking: F.staking(),
  };
  return { a, b, c };
}

(async () => {
  // ---- 8. happy path: hand-computed totals ----------------------------------------------------
  {
    const r = await make(scenario()).get();
    assert.strictEqual(r.ok, true);
    const t = r.totals;
    near(t.lpUsd, 2510, "lp"); near(t.feesUsd, 20, "fees"); near(t.rewardsUsd, 20.5, "rewards"); near(t.tokensUsd, 2250, "tokens");
    near(t.grandUsd, 4800.5, "grand = lp + fees + rewards + tokens");
    assert.ok(t.rewardsUsd > 0);
    near(t.grandUsd, t.lpUsd + t.feesUsd + t.rewardsUsd + t.tokensUsd, "formula");
    near(sum(Object.fromEntries(r.chains.map((c) => [c.key, c.totals.countedUsd]))), t.grandUsd, "chain countedUsd sums to grand");
    for (const k of ["byChain", "byWallet", "byProtocol"]) near(sum(r.breakdown[k]), t.grandUsd, `${k} sums to grand (rewards included)`);
    near(r.breakdown.byChain.a, 4231.5, "chain a"); near(r.breakdown.byChain.b, 151, "chain b"); near(r.breakdown.byChain.c, 418, "chain c");
    assert.deepStrictEqual(r.chains.map((c) => c.status), ["ok", "ok", "ok"]);
    assert.strictEqual(r.incomplete, false);
    near(t.assumedUsd, 50, "priced by assumption");

    // ---- 9. protocol mapping
    const byProto = {};
    for (const i of r.items) byProto[i.protocol] = (byProto[i.protocol] || 0) + 1;
    assert.strictEqual(byProto["uniswap-v3"], 3); assert.strictEqual(byProto["uniswap-v4"], 1);
    assert.strictEqual(byProto.aerodrome, 1); assert.strictEqual(byProto["pulsex-v2"], 6);
    assert.ok(r.items.find((i) => i.protocol === "aerodrome").flags.staked, "the staked NFT is flagged");
    near(r.breakdown.byProtocol["uniswap-v3"], 1315, "v3"); near(r.breakdown.byProtocol["uniswap-v4"], 505, "v4");
    near(r.breakdown.byProtocol.aerodrome, 312.5, "aerodrome includes its reward"); near(r.breakdown.byProtocol["pulsex-v2"], 418, "pulsex");
    near(r.breakdown.byProtocol.token, 2250, "tokens");
    const odd = await make({ a: { positions: F.positions(M, { external: [ext("MegaSwap", 1), ext("slipstream", 2)] }), watch: F.watch(), portfolio: F.portfolio(M), staking: F.staking() } }, { chains: [CH[0]] }).get();
    assert.deepStrictEqual(odd.items.map((i) => i.protocol).sort(), ["aerodrome", "other:megaswap"]);

    // ---- 10. wallet merge
    const w = r.wallets.find((x) => x.key === M.toLowerCase());
    assert.deepStrictEqual(w.chains, ["a", "b"], "M is one wallet on two chains");
    assert.strictEqual(r.wallets.filter((x) => x.key === M.toLowerCase()).length, 1);
    assert.deepStrictEqual(w.labels, { a: "Main", b: "Treasury" }, "labels per chain");
    assert.strictEqual(w.label, "Main", "first non-empty label in chain order"); assert.deepStrictEqual(w.aliases, ["Treasury"]);
    near(r.breakdown.byWallet[M.toLowerCase()], 4098.5, "M = A + B counted (lp + fees + rewards + tokens)");
    near(w.countedUsd, 4098.5, "wallet countedUsd");
    assert.ok(r.items.filter((i) => i.wallet.key === M.toLowerCase()).some((i) => i.chain === "b") && r.items.some((i) => i.wallet.key === M.toLowerCase() && i.chain === "a"));
    // same address, different casing: one wallet
    const cased = await make({
      a: { positions: F.positions(M.toUpperCase().replace("0X", "0x")), watch: F.watch(), portfolio: F.portfolio(M), staking: F.staking() },
      b: { positions: F.positions(M), watch: F.watch(), portfolio: F.portfolio(M), staking: F.staking() },
    }, { chains: CH.slice(0, 2) }).get();
    assert.strictEqual(cased.wallets.length, 1, "casing does not split a wallet");

    // ---- 11. positions vs watch: counted once, reward once
    const dupData = {
      a: {
        positions: F.positions(M, { external: [ext("aerodrome-cl2", 55, { staked: true, valueUsd: 300, rewards: reward(12.5) })] }),
        watch: F.watch([F.walletRow(M, "Dup", { external: [ext("aerodrome-cl2", 55, { staked: true, valueUsd: 300, rewards: reward(12.5) })] })]),
        portfolio: F.portfolio(M), staking: F.staking(),
      },
    };
    const d = await make(dupData, { chains: [CH[0]] }).get();
    assert.strictEqual(d.items.length, 1); near(d.totals.rewardsUsd, 12.5, "reward added once, not twice"); near(d.totals.grandUsd, 312.5, "grand");
    // the same entry twice in one payload (positions[] and external[] both listing it)
    const dup2 = await make({ a: { positions: F.positions(M, { positions: [ext("aerodrome-cl2", 55, { staked: true, valueUsd: 300, rewards: reward(12.5) })], external: [ext("aerodrome-cl2", 55, { staked: true, valueUsd: 300, rewards: reward(12.5) })] }), watch: F.watch(), portfolio: F.portfolio(M), staking: F.staking() } }, { chains: [CH[0]] }).get();
    near(dup2.totals.grandUsd, 312.5, "one payload, listed twice: counted once (13)");
    // a non-main watched wallet appearing twice is also once
    const twice = await make({ a: { positions: F.positions(M), watch: F.watch([F.walletRow(W1, "W", { positions: [lp(1, { valueUsd: 10, feesUsd: 0 })] }), F.walletRow(W1.toUpperCase().replace("0X", "0x"), "W", { positions: [lp(1, { valueUsd: 10, feesUsd: 0 })] })]), portfolio: F.portfolio(M), staking: F.staking() } }, { chains: [CH[0]] }).get();
    near(twice.totals.grandUsd, 10, "same wallet row twice (11)");

    // ---- 12. holdings vs LP: only wallet x price from /api/portfolio
    const usdc = r.items.find((i) => i.chain === "a" && i.name === "USDC" && i.kind === "token");
    near(usdc.valueUsd, 100, "pools / fees / usd of the portfolio row are not counted"); assert.strictEqual(usdc.amount, 100);
    assert.ok(!r.items.some((i) => i.name === "POOLONLY"), "a pools-only row contributes nothing");
    const lpToken = await make({ a: {
      positions: F.positions(M, { positions: [lp(1, { valueUsd: 50, feesUsd: 0, poolAddress: addr(0x777) })] }),
      watch: F.watch(), portfolio: F.portfolio(M, [row("LPTOK", 4, 10, { address: addr(0x777) })]), staking: F.staking() } }, { chains: [CH[0]] }).get();
    const dupTok = lpToken.items.find((i) => i.kind === "token");
    assert.strictEqual(dupTok.reason, "duplicate-of-holdings"); assert.strictEqual(dupTok.counted, false); assert.strictEqual(dupTok.valueUsd, null);
    near(lpToken.totals.grandUsd, 50, "the LP token is not counted again");

    // ---- 13. staked: counted once; v2 farm and unstaked are two
    const v2 = await make({ c: {
      positions: F.positions(P, { external: [
        ext("PulseX v2", "0xpair", { valueUsd: 100, counted: true }),
        ext("PulseX v2", "0xpair-farm-3", { staked: true, valueUsd: 50, counted: true, rewards: reward(2) })] }),
      watch: F.watch(), portfolio: F.portfolio(P), staking: F.staking() } }, { chains: [CH[2]] }).get();
    assert.strictEqual(v2.items.length, 2); near(v2.totals.grandUsd, 152, "both counted, reward once");

    // ---- 14. sNET: not added again; staking rewards never added
    const stk = r.items.find((i) => i.chain === "a" && i.name === "sNET");
    assert.strictEqual(stk.kind, "token"); assert.strictEqual(stk.flags.staking, true); assert.strictEqual(stk.aprPct, 12.5);
    assert.deepStrictEqual(stk.stakingRewards, { d7Usd: 7, d30Usd: 30, totalUsd: 90 });
    const sc2 = scenario(); sc2.a.staking = F.staking();
    const noStk = await make(sc2).get();
    near(noStk.totals.grandUsd, r.totals.grandUsd, "the staking payload changes nothing");
    const sc3 = scenario(); sc3.a.staking.tokens[0].rewards = { today: 0, d7: 0, d30: 0, total: 0, totalUsd: 0, d7Usd: 0, d30Usd: 0 };
    near((await make(sc3).get()).totals.grandUsd, r.totals.grandUsd, "staking rewards do not move rewardsUsd or grandUsd");
    near((await make(sc3).get()).totals.rewardsUsd, r.totals.rewardsUsd, "nor rewardsUsd");
    const sc4 = scenario(); sc4.a.portfolio = { __code: "timeout" };
    const fb = await make(sc4).get();
    const st = fb.items.find((i) => i.kind === "staking");
    assert.ok(st, "holdings part down: the staking balance is added once"); assert.strictEqual(st.counted, true); near(st.valueUsd, 50, "staking value");
    assert.strictEqual(fb.items.filter((i) => i.kind === "staking").length, 1);
    near(fb.totals.tokensUsd, 2250 - 2000 - 100 - 50 + 50, "staking balance counted in tokensUsd, no reward added");
    near(fb.totals.rewardsUsd, 20.5, "still no staking rewards");

    // ---- 16. uncounted rules
    const c = r.items.filter((i) => i.chain === "c" && i.kind === "lp");
    const reasons = c.map((i) => i.reason).sort((x, y) => String(x).localeCompare(String(y)));
    assert.deepStrictEqual(reasons, [null, null, "price-gap", "thin-pool", "unanchored", "unpriced"].sort((x, y) => String(x).localeCompare(String(y))));
    near(t.uncountedUsd, 99 + 77 + 11, "uncounted USD = price-gap + thin + unanchored (unpriced adds 0)");
    assert.strictEqual(t.uncountedCount, 4 + 2 + 1, "4 uncounted pools + 2 uncounted wallet tokens + 1 unpriced airdrop on chain a");
    const nop = r.items.find((i) => i.name === "NOPRICE"), broken = r.items.find((i) => i.name === "BROKEN");
    assert.strictEqual(nop.valueUsd, null); assert.strictEqual(nop.reason, "unpriced"); assert.strictEqual(nop.amount, 3); assert.strictEqual(nop.counted, false);
    assert.strictEqual(broken.reason, "decimals-unverified"); assert.strictEqual(broken.valueUsd, null);
    const sc5 = scenario(); sc5.c.portfolio = F.portfolio(P, []);
    near((await make(sc5).get()).totals.grandUsd, r.totals.grandUsd, "removing the uncounted tokens changes nothing");
    // rewards
    near(t.rewardsUncountedUsd, 8, "killed reward's USD reported, not counted"); assert.strictEqual(t.rewardsUncountedCount, 2);
    const p3 = c.find((i) => i.reason === "thin-pool"); assert.strictEqual(p3.rewardsCounted, true, "a thin LP's priced reward still counts"); assert.strictEqual(p3.counted, false);
    const p4 = c.find((i) => i.reason === "unpriced"); assert.strictEqual(p4.rewardsReason, "unpriced"); assert.strictEqual(p4.rewardsCounted, false); assert.strictEqual(p4.rewardsUsd, null);
    const p5 = c.find((i) => i.rewardsReason === "gauge-killed"); assert.ok(p5.flags.killedGauge); assert.strictEqual(p5.counted, true);
    const sc6 = scenario();
    sc6.c.positions.external = sc6.c.positions.external.map((e) => (e.rewards && (e.rewards.usd === null || e.rewards.killed) ? { ...e, rewards: null } : e));
    near((await make(sc6).get()).totals.grandUsd, r.totals.grandUsd, "removing unpriced / killed rewards leaves grand unchanged");
    const sc6b = scenario(); sc6b.c.positions.external[4].gaugeKilled = true; sc6b.c.positions.external[4].rewards = reward(8);
    const gk = await make(sc6b).get(); assert.strictEqual(gk.items.find((i) => i.flags.killedGauge).rewardsReason, "gauge-killed");

    // ---- 17. fees / rewards
    const sc7 = scenario(); sc7.a.positions.positions[0].feesOk = false; sc7.a.positions.positions[1].feesUsd = null;
    const fe = await make(sc7).get();
    const f1 = fe.items.find((i) => i.name === "WETH / USDC" && i.chain === "a"), f2 = fe.items.find((i) => i.name === "X / Y");
    assert.ok(f1.flags.feesUnavailable && f2.flags.feesUnavailable, "listed with the flag"); near(fe.totals.feesUsd, 20 - 10 - 5, "unavailable fees add nothing");
    assert.ok(f1.counted && f1.valueUsd === 1000, "the position stays");
    near(r.totals.feesUsd, 20, "fees of uncounted pools are not in feesUsd"); // c has none; add one below
    const un = await make({ c: { positions: F.positions(P, { external: [ext("PulseX v2", "z", { valueUsd: 50, thin: true, feesUsd: 9 })] }), watch: F.watch(), portfolio: F.portfolio(P), staking: F.staking() } }, { chains: [CH[2]] }).get();
    near(un.totals.feesUsd, 0, "fees of an uncounted pool"); near(un.totals.grandUsd, 0, "nothing counted");
    // the hand-computed example
    const ex = (withReward) => make({ a: { positions: F.positions(M, { external: [ext("aerodrome-cl2", 1, { staked: true, valueUsd: 1000, feesUsd: 0, rewards: withReward ? reward(12.5) : null })] }),
      watch: F.watch(), portfolio: F.portfolio(M, [row("TOK", 100, 2)]), staking: F.staking() } }, { chains: [CH[0]] }).get();
    const e1 = await ex(true), e0 = await ex(false);
    assert.deepStrictEqual([e1.totals.lpUsd, e1.totals.feesUsd, e1.totals.rewardsUsd, e1.totals.tokensUsd, e1.totals.grandUsd], [1000, 0, 12.5, 200, 1212.5]);
    assert.strictEqual(e1.breakdown.byProtocol.aerodrome, 1012.5); assert.strictEqual(e1.breakdown.byProtocol.token, 200);
    assert.strictEqual(e0.totals.grandUsd, 1200); assert.strictEqual(e1.totals.grandUsd - e0.totals.grandUsd, 12.5);

    // ---- 18. thin and assumed tokens
    const th = await make({ a: { positions: F.positions(M), watch: F.watch(), staking: F.staking(),
      portfolio: F.portfolio(M, [row("THIN", 10, 1, { thin: true, walletUsd: 4 }), row("ASSUME", 10, 1, { assumed: true })]) } }, { chains: [CH[0]] }).get();
    const thin = th.items.find((i) => i.name === "THIN");
    assert.ok(thin.counted && thin.flags.thin); near(thin.valueUsd, 4, "counts at the already-capped usd");
    near(th.totals.assumedUsd, 10, "assumed rows summed beside the total"); near(th.totals.tokensUsd, 14, "tokens");
  }

  // ---- 15. native twin --------------------------------------------------------------------------
  {
    const r = await make({ a: { positions: F.positions(M), watch: F.watch([F.walletRow(W1, "W", { holdings: { ok: true, unscaled: [], tokens: [
      tok("USDC", 25, { native: true, amount: 25, price: 1 }), tok("USDC", 25, { amount: 25, price: 1, address: addr(0x3600) }), tok("USDC", 25, { native: true, amount: 25, price: 1 })] } })]),
    portfolio: F.portfolio(M), staking: F.staking() } }, { chains: [CH[0]] }).get();
    assert.strictEqual(r.items.length, 1, "one row for the native coin and its ERC-20 twin"); near(r.totals.tokensUsd, 25, "counted once");
  }

  // ---- 19. chain down --------------------------------------------------------------------------
  {
    const s = scenario(); s.b = { positions: { __code: "unreachable" }, watch: { __code: "unreachable" }, portfolio: { __code: "unreachable" }, staking: { __code: "unreachable" } };
    const r = await make(s).get();
    const b = r.chains.find((c) => c.key === "b");
    assert.strictEqual(b.status, "down"); assert.ok(b.problems.every((p) => p.code === "unreachable"));
    assert.ok(!r.items.some((i) => i.chain === "b"));
    near(r.totals.grandUsd, 4231.5 + 418, "A + C only (rewards included)"); assert.strictEqual(r.incomplete, true);
    assert.strictEqual(r.breakdown.byChain.b, null, "B is a down marker, not a 0");
    assert.ok(r.incompleteList.some((x) => x.chain === "b"));
  }

  // ---- 21. last good ---------------------------------------------------------------------------
  {
    const s = scenario(); clock.t = F.AT + 60000;
    const ag = make(s, { ttlMs: 1000 });
    const first = await ag.get();
    const t0 = first.chains[0].fetchedAt;
    assert.ok(t0);
    s.a = { positions: { __code: "timeout" }, watch: { __code: "timeout" }, portfolio: { __code: "timeout" }, staking: { __code: "timeout" } };
    clock.t += 5000;
    const r = await ag.get();
    const a = r.chains[0];
    assert.strictEqual(a.status, "stale"); assert.strictEqual(a.lastGoodAt, t0); assert.ok(a.ageMs > 0);
    assert.ok(r.items.filter((i) => i.chain === "a").length > 0 && r.items.filter((i) => i.chain === "a").every((i) => i.flags.stale), "items flagged stale");
    near(r.totals.staleUsd, 4231.5, "staleUsd includes the stale chain's pending rewards"); near(r.totals.grandUsd, first.totals.grandUsd, "grand unchanged, still includes A");
    assert.strictEqual(r.incomplete, true); assert.ok(r.totals.staleOldestAsOf);
    s.a = scenario().a; clock.t += 5000;
    const back = await ag.get();
    assert.strictEqual(back.chains[0].status, "ok"); assert.ok(!back.items.some((i) => i.flags.stale)); near(back.totals.staleUsd, 0, "cleared");
    // ---- 26. failure isolation: a failed refresh keeps the last good and leaves the others
    s.b = { positions: { __code: "http-500" }, watch: scenario().b.watch, portfolio: scenario().b.portfolio, staking: scenario().b.staking };
    clock.t += 5000;
    const iso = await ag.get();
    assert.strictEqual(iso.chains[1].parts.positions, "http-500"); assert.strictEqual(iso.chains[1].status, "partial");
    assert.ok(iso.items.some((i) => i.chain === "b" && i.kind === "lp" && i.flags.stale), "B's last good positions are kept, flagged stale");
    assert.strictEqual(iso.chains[0].status, "ok", "A is untouched by B's failure");
  }

  // ---- 22/23. stale source, stale wallet, loading ----------------------------------------------------
  {
    const s = scenario(); s.a.watch.at = clock.t - 20 * 60 * 1000;
    const r = await make(s).get();
    assert.strictEqual(r.chains[0].status, "partial"); assert.ok(r.chains[0].problems.some((p) => p.part === "watch" && p.code === "stale-source"));
    assert.ok(r.items.filter((i) => i.chain === "a" && i.source === "watch").every((i) => i.flags.stale));
    const w = scenario();
    w.a.watch = F.watch([
      F.walletRow(W1, "Wallet 1", { stale: true, staleSince: F.AT - 600000, staleError: "rpc https://rpc.example/KEY-secret failed", positions: [lp(301, { valueUsd: 200, feesUsd: 4 })] }),
      F.walletRow(W3, "Wallet 3", { ok: false, totals: null, error: "boom https://rpc.example/KEY-secret" }),
    ]);
    const rw = await make(w).get();
    const pa = rw.chains[0].problems;
    assert.ok(pa.some((p) => p.wallet === W1.toLowerCase() && p.code === "stale" && p.since === F.AT - 600000));
    assert.ok(pa.some((p) => p.wallet === W3.toLowerCase() && p.code === "unavailable"));
    const w1 = rw.items.find((i) => i.wallet.key === W1.toLowerCase());
    assert.strictEqual(w1.flags.stale, true); assert.strictEqual(w1.asOf, F.AT - 600000);
    assert.ok(!rw.items.some((i) => i.chain === "a" && i.wallet.key === W3.toLowerCase()), "a failed wallet contributes nothing, not 0");
    const w3 = rw.wallets.find((x) => x.key === W3.toLowerCase());
    assert.ok(w3 && typeof w3.countedUsd === "number" && !w3.unavailable, "readable on other chains: keeps its figure");
    const ra = await make(w, { chains: [CH[0]] }).get();
    const w3a = ra.wallets.find((x) => x.key === W3.toLowerCase());
    assert.ok(w3a && w3a.countedUsd === null && w3a.unavailable === true, "a wallet with no readable data is unavailable, not $0");
    const w1o = rw.wallets.find((x) => x.key === W1.toLowerCase());
    assert.ok(w1o && typeof w1o.countedUsd === "number" && !w1o.unavailable, "a readable wallet keeps its figure");
    assert.ok(!JSON.stringify(rw).includes("KEY-secret"), "raw upstream error text never reaches the output");
    // 23 loading
    const l = scenario(); l.a.watch = { __http: 202, body: { ok: false, refreshing: true, error: "watched wallets still loading", wallets: [] } };
    l.a.portfolio = { __http: 503, body: { ok: false, error: "portfolio still loading" } };
    const rl = await make(l).get();
    assert.strictEqual(rl.chains[0].status, "partial"); assert.strictEqual(rl.chains[0].parts.watch, "loading"); assert.strictEqual(rl.chains[0].parts.portfolio, "loading");
    assert.ok(rl.items.some((i) => i.chain === "a" && i.kind === "lp"), "the main wallet's positions still show");
    const zero = scenario(); zero.a.watch = F.watch([]); assert.strictEqual((await make(zero).get()).chains[0].status, "ok");
  }

  // ---- 24. bad upstreams --------------------------------------------------------------------------
  {
    const one = async (v) => (await make({ a: { positions: v, watch: F.watch(), portfolio: F.portfolio(M), staking: F.staking() } }, { chains: [CH[0]] }).get());
    assert.strictEqual((await one({ __http: 500, body: undefined })).chains[0].parts.positions, "http-500");
    assert.strictEqual((await one({ __raw: { status: 200, data: undefined } })).chains[0].parts.positions, "bad-json");
    assert.strictEqual((await one({ __raw: { status: 200, data: [1, 2] } })).chains[0].parts.positions, "bad-json", "an array is not an object");
    assert.strictEqual((await one({ __raw: { status: 200, data: { ok: false, error: "SECRET upstream text" } } })).chains[0].parts.positions, "upstream-error");
    assert.strictEqual((await one({ __code: "too-large" })).chains[0].parts.positions, "too-large");
    const noArrays = await one({ ok: true, at: F.AT, owner: M });
    assert.strictEqual(noArrays.chains[0].parts.positions, "ok"); assert.strictEqual(noArrays.items.length, 0);
    const weird = await one(F.positions(M, { positions: [
      lp(1, { valueUsd: "5", feesUsd: "1" }), lp(2, { valueUsd: Infinity, feesUsd: -3 }), lp(3, { valueUsd: -10 }), lp(4, { valueUsd: NaN })],
    external: [ext("aerodrome-cl2", 9, { staked: true, valueUsd: 10, rewards: reward(-1) }), ext("aerodrome-cl2", 10, { valueUsd: 10, rewards: reward(Infinity) })] }));
    const wl = weird.items;
    assert.ok(wl.filter((i) => i.name === "WETH / USDC").every((i) => i.valueUsd === null && i.counted === false), "non-finite, negative and string values are unpriced");
    near(weird.totals.rewardsUsd, 0, "such rewards are not counted"); assert.strictEqual(weird.totals.rewardsUncountedCount, 2);
    near(weird.totals.grandUsd, 20, "only the two valid pool values");
    // the fetch layer itself
    const ports = [];
    const srv = http.createServer((q, r) => {
      if (q.url === "/big") { r.writeHead(200, { "Content-Type": "application/json" }); const iv = setInterval(() => { r.write("x".repeat(40000)); }, 1); r.on("close", () => { clearInterval(iv); ports.push("closed"); }); return; }
      if (q.url === "/hang") { q.socket.on("close", () => ports.push("hang-closed")); return; }
      if (q.url === "/html") { r.writeHead(500); return r.end("<html>"); }
      r.writeHead(200, { "Content-Type": "application/json" }); r.end("{not json");
    });
    await new Promise((res) => srv.listen(0, "127.0.0.1", res));
    const port = srv.address().port;
    const big = await agg.defaultFetchJson(port, "/big", { maxBytes: 100000, timeoutMs: 5000 });
    assert.deepStrictEqual(big, { code: "too-large" });
    const hang = await agg.defaultFetchJson(port, "/hang", { timeoutMs: 150 });
    assert.deepStrictEqual(hang, { code: "timeout" });
    const h500 = await agg.defaultFetchJson(port, "/html", {});
    assert.strictEqual(h500.status, 500); assert.strictEqual(agg.classify(h500), "http-500");
    const bad = await agg.defaultFetchJson(port, "/x", {});
    assert.strictEqual(agg.classify(bad), "bad-json");
    await new Promise((res) => setTimeout(res, 100));
    assert.ok(ports.includes("closed"), "the over-cap upstream's socket was destroyed"); assert.ok(ports.includes("hang-closed"), "and the timed-out one");
    await new Promise((res) => srv.close(res));
    assert.deepStrictEqual(await agg.defaultFetchJson(port, "/y", {}), { code: "unreachable" });
    assert.strictEqual(agg.classify({ status: 503, data: { ok: false, error: "portfolio still loading" } }), "loading");
    assert.strictEqual(agg.classify({ status: 503, data: { ok: false, error: "oops" } }), "http-503");
  }

  // ---- 25. cache ------------------------------------------------------------------------------------
  {
    clock.t = F.AT + 60000;
    const ag = make(scenario(), { ttlMs: 30000 });
    await ag.get(); await ag.get();
    for (const c of CH) for (const p of Object.values(agg.PATHS)) assert.strictEqual(ag.calls.filter((x) => x === `${c.key}${p}`).length, 1, `one request per path (${c.key}${p})`);
    clock.t += 31000; await ag.get();
    assert.strictEqual(ag.calls.filter((x) => x === "a/api/watch").length, 2, "after the TTL a request refreshes");
    // 20 concurrent callers share one round
    clock.t += 31000;
    const before = ag.calls.length;
    await Promise.all(Array.from({ length: 20 }, () => ag.get()));
    assert.strictEqual(ag.calls.length - before, 12, "one upstream round (4 paths x 3 chains) for 20 callers");
    // ?refresh=1 forces, a second within 5 s does not
    const n1 = ag.calls.length; await ag.get({ refresh: true }); assert.strictEqual(ag.calls.length - n1, 12);
    const n2 = ag.calls.length; await ag.get({ refresh: true }); assert.strictEqual(ag.calls.length - n2, 0, "rate-limited");
    clock.t += 6000; const n3 = ag.calls.length; await ag.get({ refresh: true }); assert.strictEqual(ag.calls.length - n3, 12);
    assert.ok(ag.calls.every((x) => !x.includes("?") && !x.includes("fresh=1")), "no query string upstream");
    assert.ok(ag.calls.every((x) => Object.values(agg.PATHS).some((p) => x.endsWith(p))), "only the four fixed paths");
  }

  // ---- 20. slow chain (in-process): wait deadline answers from cache with the chain loading --------------
  {
    const s = scenario();
    let release;
    const ag = agg.createAggregator({ chains: CH, now: () => clock.t, waitMs: 100, ttlMs: 30000,
      fetchJson: (chain, p) => (chain.key === "b" ? new Promise((res) => { release = () => res({ code: "timeout" }); }) : Promise.resolve({ status: 200, data: s[chain.key][p.split("/").pop()] })) });
    const t0 = Date.now(); const r = await ag.get(); assert.ok(Date.now() - t0 < 1500);
    assert.strictEqual(r.chains[1].status, "loading"); assert.ok(r.chains[1].problems.some((p) => p.code === "loading"));
    assert.strictEqual(r.chains[0].status, "ok"); assert.strictEqual(r.chains[2].status, "ok");
    near(r.totals.grandUsd, 4231.5 + 418, "A and C complete"); assert.strictEqual(r.incomplete, true);
    release();
  }

  // ---- 27. output bounds ---------------------------------------------------------------------------------
  {
    const long = "L".repeat(300);
    const many = Array.from({ length: 6000 }, (_, i) => ext("aerodrome-cl2", i + 1, { staked: true, valueUsd: 1, feesUsd: 0, rewards: reward(1, { symbol: long }), pair: long, symbol0: long }));
    const r = await make({ a: { positions: F.positions(M, { ownerLabel: long, external: many }), watch: F.watch(), portfolio: F.portfolio(M), staking: F.staking() } }, { chains: [CH[0]] }).get();
    assert.strictEqual(r.items.length, 5000); assert.strictEqual(r.truncated, true); assert.strictEqual(r.totals.itemCount, 6000);
    near(r.totals.rewardsUsd, 6000, "totals cover all 6000"); near(r.totals.grandUsd, 12000, "grand");
    const walk = (v) => { if (typeof v === "string") assert.ok(v.length <= 80, `string too long: ${v.length}`); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
    walk(r);
    assert.ok(JSON.stringify((await make(scenario()).get())).length < 1024 * 1024);

    // the cap keeps the most valuable items; unpriced ones go last
    const mixed = [
      ...Array.from({ length: 5500 }, (_, i) => ext("aerodrome-cl2", i + 1, { staked: true, valueUsd: null, feesUsd: 0 })),
      ...Array.from({ length: 600 }, (_, i) => ext("aerodrome-cl2", 10000 + i, { staked: true, valueUsd: 1 + i, feesUsd: 0 })),
      ext("aerodrome-cl2", 99999, { staked: true, valueUsd: 777777, feesUsd: 0 }),
    ];
    const m = await make({ a: { positions: F.positions(M, { external: mixed }), watch: F.watch(), portfolio: F.portfolio(M), staking: F.staking() } }, { chains: [CH[0]] }).get();
    assert.strictEqual(m.truncated, true); assert.strictEqual(m.items.length, 5000);
    assert.strictEqual(m.items[0].valueUsd, 777777, "the highest-value item survives the cap");
    assert.ok(m.items.filter((i) => i.valueUsd !== null).length === 601, "every priced item is kept");
    assert.ok(m.items[601].valueUsd === null && m.items[4999].valueUsd === null, "unpriced items fill the rest");
  }

  // ---- 27b. live-shape fixtures go through ingest/compose/build ------------------------------------------
  {
    const dir = path.join(__dirname, "fixtures", "aggregate");
    const keys = ["robinhood", "arc", "base"];
    const data = {};
    for (const k of keys) data[k] = JSON.parse(fs.readFileSync(path.join(dir, `live-shape-${k}.json`), "utf8"));
    const chains = keys.map((k, i) => ({ key: k, label: k, accent: "#123456", port: 10 + i }));
    let r;
    r = await make(data, { chains }).get();
    assert.strictEqual(r.ok, true);
    near(r.totals.grandUsd, r.totals.lpUsd + r.totals.feesUsd + r.totals.rewardsUsd + r.totals.tokensUsd, "live shape: grand = lp + fees + rewards + tokens");
    for (const k of ["byChain", "byWallet", "byProtocol"]) near(sum(r.breakdown[k]), r.totals.grandUsd, `live shape: ${k} sums to grand`);
    const protos = (chain) => new Set(r.items.filter((i) => i.chain === chain).map((i) => i.protocol));
    assert.ok(protos("robinhood").has("other:up"), "robinhood has other:up");
    assert.ok(protos("base").has("aerodrome"), "base has aerodrome");
  }

  // ---- P2 1-4, 6. holdings-unavailable is a per-wallet note ---------------------------------------------------
  {
    const one = [CH[0]];
    const healthyA = (wallets, over = {}) => ({ a: { positions: F.positions(M, { positions: [lp(1, { valueUsd: 100, feesUsd: 1 })] }), watch: F.watch(wallets), portfolio: F.portfolio(M, [row("ETH", 1, 2000, { native: true })]), staking: F.staking(), ...over } });
    const bad = (a, label, tokens = [], extra = {}) => F.walletRow(a, label, { holdings: { ok: false, unscaled: [], tokens }, ...extra });
    const good = (a, label, tokens = []) => F.walletRow(a, label, { holdings: { ok: true, unscaled: [], tokens } });
    const toks = [tok("USDC", 30), tok("NOPRICE", 5, { usd: null, price: null })];
    const rBad = await make(healthyA([bad(W1, "Wallet 1", toks)]), { chains: one }).get();
    const rGood = await make(healthyA([good(W1, "Wallet 1", toks)]), { chains: one }).get();
    const c = rBad.chains[0];
    assert.strictEqual(c.status, "ok"); assert.ok(!c.problems.some((p) => p.code === "holdings-unavailable"));
    assert.ok(!rBad.incompleteList.some((p) => p.code === "holdings-unavailable")); assert.strictEqual(rBad.incomplete, false);
    assert.deepStrictEqual(c.notes, [{ wallet: W1.toLowerCase(), code: "holdings-unavailable" }]);
    const w = rBad.wallets.find((x) => x.key === W1.toLowerCase());
    assert.ok(w.holdingsUnknown === true && w.notes.includes("holdings-unavailable"));
    const wt = rBad.items.filter((i) => i.wallet.key === W1.toLowerCase() && i.kind === "token");
    assert.ok(wt.length >= 2 && wt.every((i) => i.flags.holdingsUnknown === true));
    assert.strictEqual(wt.find((i) => i.name === "NOPRICE").valueUsd, null);
    assert.ok(!wt.some((i) => i.valueUsd === 0), "no zero item");
    assert.ok(!rGood.wallets.find((x) => x.key === W1.toLowerCase()).holdingsUnknown);
    near(rBad.totals.grandUsd, rGood.totals.grandUsd, "counting unchanged");
    assert.strictEqual(typeof rBad.breakdown.byWallet[W1.toLowerCase()], "number");
    const rEmpty = await make(healthyA([bad(W1, "Wallet 1")]), { chains: one }).get();
    assert.ok(!rEmpty.items.some((i) => i.wallet.key === W1.toLowerCase()), "no rows, no items");
    assert.strictEqual(rEmpty.chains[0].status, "ok");

    // every other cause still makes the chain partial; combined, only the other cause is listed
    const cases = {
      "http-500": healthyA([good(W1, "W")], { staking: { __http: 500, body: {} } }),
      loading: healthyA([good(W1, "W")], { watch: { __http: 202, body: { ok: false, loading: true } } }),
      "stale-source": healthyA([good(W1, "W")], { watch: F.watch([good(W1, "W")], { at: clock.t - 20 * 60000 }) }),
      unavailable: healthyA([good(W1, "W")].map((x) => ({ ...x, ok: false, totals: null }))),
      stale: healthyA([{ ...good(W1, "W"), stale: true, staleSince: clock.t - 1000 }]),
      "tokens-unavailable": healthyA([good(W1, "W")], { portfolio: { __code: "unreachable" } }),
      "no-owner": { a: { positions: { __code: "unreachable" }, watch: F.watch([good(W1, "W")]), portfolio: { __code: "unreachable" }, staking: F.staking([F.stakeTok(SN, 10, 50)]) } },
    };
    for (const [code, data] of Object.entries(cases)) {
      for (const withBad of [false, true]) {
        const d = JSON.parse(JSON.stringify(data));
        if (withBad) d.a.watch = { ...d.a.watch, wallets: [...(d.a.watch.wallets || []), bad(W3, "Wallet 3")] };
        const r = await make(d, { chains: one }).get();
        assert.strictEqual(r.chains[0].status, "partial", `${code}: partial`);
        assert.strictEqual(r.incomplete, true, `${code}: incomplete`);
        assert.ok(r.incompleteList.some((p) => p.code === code || (code === "http-500" && p.code === "http-500")), `${code}: listed ${JSON.stringify(r.incompleteList)}`);
        assert.ok(!r.incompleteList.some((p) => p.code === "holdings-unavailable"), `${code}: bad wallet not listed`);
      }
    }

    // fixtures: two wallets without discovery on a chain that is otherwise fine
    for (const k of ["base", "robinhood"]) {
      const d = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "aggregate", `live-shape-${k}.json`), "utf8"));
      d.watch.wallets.slice(0, 2).forEach((x) => { x.holdings.ok = false; });
      const r = await make({ [k]: d }, { chains: [{ key: k, label: k, accent: "#123456", port: 1 }] }).get();
      assert.strictEqual(r.chains[0].status, "ok", `${k}: ok`);
      assert.strictEqual(r.wallets.filter((x) => x.holdingsUnknown).length, 2, `${k}: two unknown wallets`);
    }
  }

  // ---- P2 8-10. ages and the 15-minute flag are computed at response time ---------------------------------------
  {
    const one = [CH[0]];
    const T0 = F.AT + 60000;
    const mk = (delayRef, ttlMs = 30000) => {
      const state = { t: T0, upstream: 0 };
      const ag = agg.createAggregator({
        chains: one, now: () => state.t, waitMs: 50, ttlMs,
        fetchJson: async (chain, p) => {
          state.upstream++;
          if (delayRef.ms) await new Promise((r) => setTimeout(r, delayRef.ms));
          const part = p.split("/").pop();
          const body = { positions: F.positions(M), watch: F.watch([], { at: state.watchAt ?? T0 }), portfolio: F.portfolio(M), staking: F.staking() }[part];
          return { status: 200, data: { ...body, at: part === "watch" ? (state.watchAt ?? T0) : T0 } };
        },
      });
      return { state, ag };
    };
    // 8: idle gap, slow upstream
    {
      const delay = { ms: 0 };
      const { state, ag } = mk(delay);
      const r1 = await ag.get(); assert.strictEqual(r1.chains[0].status, "ok");
      state.t = T0 + 20 * 60000; delay.ms = 300;
      const r2 = await ag.get();
      assert.strictEqual(r2.at, state.t, "at is the new clock time");
      assert.ok(r2.chains[0].ageMs >= 20 * 60000);
      assert.ok(r2.chains[0].problems.some((p) => p.part === "watch" && p.code === "stale-source"));
      assert.strictEqual(r2.chains[0].status, "partial");
      await new Promise((r) => setTimeout(r, 400));
    }
    // 9 + 10: boundary, ages move, build reuse
    {
      const { state, ag } = mk({ ms: 0 }, 1e9);
      await ag.get();
      const up = state.upstream;
      state.t = T0 + 15 * 60000 - 1;
      // keep the round TTL out of play by checking the cached payload only
      let p = JSON.parse(await ag.getJson());
      const before = state.upstream;
      assert.ok(!p.chains[0].problems.some((x) => x.code === "stale-source"));
      state.t = T0 + 15 * 60000 + 1;
      p = JSON.parse(await ag.getJson());
      const sp = p.chains[0].problems.find((x) => x.code === "stale-source" && x.part === "watch");
      assert.ok(sp && sp.part === "watch" && sp.since === T0, "stale flag flips on time");
      assert.strictEqual(p.chains[0].status, "partial");
      assert.ok(up > 0 && before === up && state.upstream === up, "no upstream request between the two calls");
    }
    {
      const { state, ag } = mk({ ms: 0 });
      await ag.get();
      const a1 = JSON.parse(await ag.getJson());
      state.t += 1000;
      const a2 = JSON.parse(await ag.getJson());
      assert.ok(a2.at !== a1.at && a2.chains[0].ageMs >= a1.chains[0].ageMs + 1000, "ages move");
      const b = ag.stats.builds;
      state.t += 500;
      await ag.getJson();
      assert.strictEqual(ag.stats.builds, b, "inside buildMaxAgeMs: one build reused");
      state.t += 1000;
      await Promise.all(Array.from({ length: 20 }, () => ag.getJson()));
      assert.strictEqual(ag.stats.builds, b + 1, "20 concurrent calls: at most one build");
    }
  }

  // ---- 33. performance ----------------------------------------------------------------------------------------
  {
    const big = {};
    for (const c of CH) {
      const wallets = Array.from({ length: 4 }, (_, w) => F.walletRow(addr(500 + w), `Wallet ${w}`, {
        positions: Array.from({ length: 20 }, (_, i) => lp(`${c.key}${w}${i}`.replace(/\D/g, "") + i, { valueUsd: 10 + i, feesUsd: 1 })),
        external: Array.from({ length: 20 }, (_, i) => ext("aerodrome-cl2", `${w}${i}`, { staked: true, valueUsd: 20, rewards: reward(1) })),
        holdings: { ok: true, unscaled: [], tokens: Array.from({ length: 80 }, (_, i) => ({ ...tok(`T${i}`, 5), address: addr(10000 + i) })) } }));
      big[c.key] = { positions: F.positions(addr(900)), watch: F.watch(wallets), portfolio: F.portfolio(addr(900)), staking: F.staking() };
    }
    const t0 = process.hrtime.bigint();
    const r = await make(big).get();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(r.items.length >= 3 * 4 * 120, `items ${r.items.length}`);
    assert.ok(ms < 250, `aggregated in ${ms.toFixed(1)} ms`);
  }

  // ---- 34. the serialised payload is built once per round -----------------------------------------------------
  {
    const data = { a: { positions: F.positions(addr(1), { positions: [lp(1, { valueUsd: 10, feesUsd: 1 })] }), watch: F.watch(), portfolio: F.portfolio(addr(1)), staking: F.staking() } };
    const ag = agg.createAggregator({
      chains: [CH[0]], now: () => clock.t, waitMs: 1000, ttlMs: 30000,
      fetchJson: async (chain, p) => ({ status: 200, data: data[chain.key][p.split("/").pop()] }),
    });
    const j1 = await ag.getJson();
    const b1 = ag.stats.builds;
    const j2 = await ag.getJson();
    const p3 = await ag.get();
    assert.strictEqual(ag.stats.builds, b1, "two more requests inside one round: no rebuild");
    assert.strictEqual(j1, j2, "the same serialised payload");
    assert.strictEqual(JSON.stringify(p3), j1);
    await ag.get({ refresh: true });     // a forced round (the clock has not moved)
    await ag.getJson();
    assert.ok(ag.stats.builds > b1, "a new round rebuilds");
    const b2 = ag.stats.builds;
    await ag.getJson();
    assert.strictEqual(ag.stats.builds, b2, "and is then reused");
  }

  // ---- 35. static scope ------------------------------------------------------------------------------------------
  {
    const src = fs.readFileSync(path.join(__dirname, "..", "aggregate.js"), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
    for (const bad of [/\bethers\b/, /\bWallet\b/, /signTransaction/, /\brpc\b/i, /\bprovider\b/i, /\bfs\b/, /process\.env/]) assert.ok(!bad.test(code), `aggregate.js must not match ${bad}`);
    const reqs = [...code.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
    assert.deepStrictEqual(reqs, ["http"], "requires only http");
    assert.deepStrictEqual(Object.values(agg.PATHS).sort(), ["/api/portfolio", "/api/positions", "/api/staking", "/api/watch"]);
    assert.ok(!/createServer/.test(code), "no server");
  }

  console.log("aggregate.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
