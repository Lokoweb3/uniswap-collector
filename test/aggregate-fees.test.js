// node test/aggregate-fees.test.js -- Portfolio fee totals, the LP totals row, breakdown fee columns and the
// measured earning rate (aggregate.js + aggregate-view.js). Same fixtures as the other aggregate tests.
"use strict";
const assert = require("assert");
const agg = require("../aggregate");
const F = require("./lib/aggregate-fixtures");
const V = require("../aggregate-view");
const { addr, lp, ext, reward } = F;

const CH = [
  { key: "robinhood", label: "Robinhood", accent: "#111111", port: 1 },
  { key: "base", label: "Base", accent: "#222222", port: 2 },
  { key: "arc", label: "Arc", accent: "#333333", port: 3 },
];
const M = addr(1), W = addr(2);
const ALL = () => ({ chains: new Set(CH.map((c) => c.key)), wallet: "", sort: "value" });
const sel = (chains, wallet = "") => ({ chains: chains ? new Set(chains) : new Set(CH.map((c) => c.key)), wallet, sort: "value" });

async function payloadFor(data, chains = CH) {
  const ag = agg.createAggregator({
    chains, now: () => F.AT + 60000, waitMs: 500,
    fetchJson: async (chain, p) => {
      const v = (data[chain.key] || {})[p.split("/").pop()];
      if (v === undefined) return { code: "unreachable" };
      return v.__code ? { code: v.__code } : { status: 200, data: JSON.parse(JSON.stringify(v)) };
    },
  });
  return JSON.parse(JSON.stringify(await ag.get()));
}
const empty = (over = {}) => ({ positions: F.positions(M), watch: F.watch(), portfolio: F.portfolio(M), staking: F.staking(), ...over });
/** Test 1 fixture: robinhood M has A (fees 10, reward 4) and B (fees 5); base W has C (fees 2). */
const base1 = (extra = {}) => ({
  robinhood: empty({
    positions: F.positions(M, {
      positions: [
        lp(1, { valueUsd: 1000, feesUsd: 10, dailyUsd: 2.4, rateWindowH: 20, rewards: reward(4) }),
        lp(2, { valueUsd: 500, feesUsd: 5, dailyUsd: 0.6, rateWindowH: 20 }),
        ...(extra.rhLp || []),
      ],
      external: extra.rhExt || [],
    }),
  }),
  base: empty({ watch: F.watch([F.walletRow(W, "Wallet W", { positions: [lp(3, { valueUsd: 100, feesUsd: 2 })], earned: { perHour: 0.5, rateWindowH: 24 }, ...(extra.wOver || {}) })]) }),
  arc: empty(),
});
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, `${m}: ${a} vs ${b}`);
const html = (p, s) => V.renderPage(p, s || ALL());
const rateOf = (p, chain, wallet) => p.rates.find((r) => r.chain === chain && r.wallet === wallet);
const thin = () => lp(4, { valueUsd: 50, feesUsd: 3, thin: true });

(async () => {
  // ---- 1, 4 totals match the grand total; no uncounted text when nothing is uncounted
  {
    const p = await payloadFor(base1());
    assert.strictEqual(p.totals.feesUsd, 17); assert.strictEqual(p.totals.rewardsUsd, 4);
    near(p.totals.grandUsd - p.totals.tokensUsd - p.totals.lpUsd, 21, "fees + rewards in the grand total");
    const h = html(p);
    assert.ok(h.includes("<tfoot>") && h.includes("Total (counted)"));
    assert.ok(h.includes("fees $17.00") && h.includes("pending rewards $4.00"));
    assert.ok(!h.includes("fees not counted"));
    assert.strictEqual(p.totals.feesUncountedCount, 0); assert.strictEqual(p.totals.feesUncountedUsd, 0);
  }

  // ---- 24 whitelist, 22 PATHS
  {
    const raw = { ok: true, at: 5, owner: M, positions: [lp(1, { dailyUsd: 1.5, rateWindowH: 3, operator: addr(9), rpc: "https://x/KEY" })], external: [] };
    const out = agg.ingest("positions", raw).data.entries[0];
    assert.strictEqual(out.dailyUsd, 1.5); assert.strictEqual(out.rateWindowH, 3);
    assert.ok(!("operator" in out) && !("rpc" in out));
    const w = agg.ingest("watch", { at: 5, wallets: [
      { address: W, label: "w", positions: [], external: [], operator: "x", earned: { perHour: 0.5, rateWindowH: 24, note: "n".repeat(500), daily: [1, 2], since: 1 } },
      { address: addr(3), label: "old" },
    ] }).data.wallets;
    assert.deepStrictEqual(w[0].earned, { perHour: 0.5, rateWindowH: 24 });
    assert.strictEqual(w[1].earned, null, "an old instance without earned");
    assert.ok(!("operator" in w[0]));
    assert.deepStrictEqual({ ...agg.PATHS }, { positions: "/api/positions", watch: "/api/watch", portfolio: "/api/portfolio", staking: "/api/staking" });
  }

  // ---- 2, 3 uncounted fees
  {
    const p = await payloadFor(base1({ rhLp: [thin(), lp(5, { valueUsd: 80, feesUsd: 9, feesOk: false })] }));
    assert.strictEqual(p.totals.feesUsd, 17);
    assert.strictEqual(p.totals.feesUncountedUsd, 12); assert.strictEqual(p.totals.feesUncountedCount, 2);
    const h = html(p);
    assert.ok(h.includes("fees not counted $12.00 (2 items)"));
    assert.ok(h.includes("fees unavailable"));
    assert.ok(h.includes("fees $17.00"));
    const one = await payloadFor(base1({ rhLp: [thin()] }));
    assert.ok(html(one).includes("fees not counted $3.00 (1 items)"));
    assert.strictEqual(one.totals.feesUsd, 17); assert.strictEqual(one.totals.feesUncountedUsd, 3);
    const clean = await payloadFor(base1());
    near(one.totals.grandUsd, clean.totals.grandUsd, "uncounted fees and value never reach the grand total");
  }

  // ---- 5, 6 filters equal a payload built from that chain alone
  {
    const fx = base1({ rhLp: [thin()] });
    const p = await payloadFor(fx);
    const hb = html(p, sel(["base"])), hr = html(p, sel(["robinhood"]));
    assert.ok(hb.includes("fees $2.00") && hb.includes("pending rewards $0.00"));
    assert.ok(hr.includes("fees $15.00") && hr.includes("pending rewards $4.00"));
    assert.ok(html(p, sel(null, W)).includes("fees $2.00"));
    assert.ok(html(p, sel(null, M)).includes("fees $15.00"));
    const x = html(p, sel(["robinhood"], W));
    assert.ok(x.includes("fees $0.00") && !x.includes("undefined") && !x.includes("NaN"));
    for (const keep of ["robinhood", "base"]) {
      const only = await payloadFor({ [keep]: fx[keep] }, CH.filter((c) => c.key === keep));
      const s = sel([keep]);
      const t = V.totalsFor(p, V.filterItems(p, s), s);
      for (const k of ["feesUsd", "rewardsUsd", "feesUncountedUsd", "feesUncountedCount", "grandUsd"]) near(t[k], only.totals[k], `${keep} ${k}`);
    }
  }

  // ---- 7, 8, 9 parity (stale, killed gauge), no double counting, rewards policy
  {
    const stale = base1(); stale.base.watch.at = F.AT - 30 * 60000;
    const killed = base1({ rhExt: [ext("aerodrome-cl2", 7, { staked: true, valueUsd: 90, feesUsd: 0, gaugeKilled: true, rewards: reward(6, { killed: true }) })] });
    const dup = base1(); dup.robinhood.watch = F.watch([F.walletRow(M, "Main", { positions: [lp(1, { valueUsd: 1000, feesUsd: 10 })] })]);
    for (const [name, fx] of [["stale", stale], ["killed", killed], ["dup", dup]]) {
      const p = await payloadFor(fx);
      const ct = V.clientTotals(p.items);
      for (const k of ["feesUsd", "rewardsUsd", "feesUncountedUsd", "feesUncountedCount", "grandUsd"]) near(ct[k], p.totals[k], `${name} ${k}`);
      const counted = p.items.filter((i) => i.kind === "lp" && i.counted && !i.flags.feesUnavailable && i.feesUsd !== null);
      near(counted.reduce((a, i) => a + i.feesUsd, 0), p.totals.feesUsd, `${name} items sum`);
      near(Object.values(p.breakdown.feesByChain).reduce((a, v) => a + (v || 0), 0), p.totals.feesUsd, `${name} feesByChain`);
      near(Object.values(p.breakdown.feesByWallet).reduce((a, v) => a + (v || 0), 0), p.totals.feesUsd, `${name} feesByWallet`);
      near(Object.values(V.breakdownFor(p.items).feesChain).reduce((a, v) => a + v, 0), p.totals.feesUsd, `${name} client feesChain`);
    }
    assert.strictEqual((await payloadFor(stale)).items.some((i) => i.flags.stale), true);
    assert.strictEqual((await payloadFor(dup)).totals.feesUsd, 17, "a position in both sources is counted once");
    const k = await payloadFor(killed);
    assert.strictEqual(k.totals.rewardsUsd, 4); assert.strictEqual(k.totals.rewardsUncountedUsd, 6);
    const kh = html(k);
    assert.ok(kh.includes("rewards $6.00 not counted (gauge killed)") && kh.includes("pending rewards $4.00") && kh.includes("rewards not counted: 1 ($6.00)"));
  }

  // ---- 10, 11, 12 down chain, unavailable wallet, breakdown columns
  {
    const p = await payloadFor(base1());
    const h = html(p);
    assert.ok(h.includes('<td class="num">fees $15.00</td>') && h.includes('<td class="num">fees $2.00</td>'), "fee cells in By chain and By wallet");
    assert.deepStrictEqual(p.breakdown.feesByChain, { robinhood: 15, base: 2, arc: 0 });
    assert.deepStrictEqual(p.breakdown.feesByWallet, { [M]: 15, [W]: 2 });
    assert.strictEqual(p.breakdown.byChain.robinhood, 1519 + 0 - 4 + 4, "the Value contributions are unchanged (lp 1500 + fees 15 + reward 4)");
    const down = base1(); down.base = { positions: { __code: "unreachable" }, watch: { __code: "unreachable" }, portfolio: { __code: "unreachable" }, staking: { __code: "unreachable" } };
    const d = await payloadFor(down);
    assert.strictEqual(d.breakdown.feesByChain.base, null); assert.strictEqual(d.totals.feesUsd, 15);
    const dh = html(d);
    assert.ok(dh.includes('<td class="num muted">down, no figure</td><td></td><td class="num">no figure</td>'));
    assert.ok(dh.includes("Base is down"));
    const u = await payloadFor(base1({ wOver: { ok: false } }));
    assert.ok(u.wallets.find((w) => w.key === W).unavailable);
    const uh = V.renderPage(u, sel(null, W));
    assert.ok(uh.includes('Total (counted)</td><td class="num">unavailable</td><td class="num">unavailable</td>'));
    assert.ok(!uh.includes("$0.00/day"));
  }

  // ---- 13 to 19 rates
  {
    const p = await payloadFor(base1());
    const r = rateOf(p, "robinhood", M);
    assert.strictEqual(r.kind, "positions"); near(r.perDayUsd, 3, "sum"); assert.strictEqual(r.windowH, 20); assert.strictEqual(r.measured, 2); assert.strictEqual(r.total, 2);
    const rw = rateOf(p, "base", W);
    assert.strictEqual(rw.kind, "wallet"); assert.strictEqual(rw.perDayUsd, 12); assert.strictEqual(rw.windowH, 24); assert.strictEqual(rw.measured, null);
    const h1 = V.ratesHtml(p, sel(["robinhood"]));
    assert.ok(h1.includes("$3.00/day") && h1.includes("$21.00/week") && h1.includes("excludes pending rewards") && h1.includes("20.0 h"));
    const hw = V.ratesHtml(p, sel(["base"]));
    assert.ok(hw.includes("$12.00/day") && hw.includes("wallet accrual, all positions") && hw.includes("24.0 h"));
    const all = V.ratesHtml(p, ALL());
    assert.ok(all.includes("$15.00/day") && all.includes("$105.00/week"));
    const hm = V.ratesHtml(p, sel(null, M));
    assert.ok(hm.includes("$3.00/day") && !hm.includes("$12.00/day"));
    const none = V.ratesHtml(p, sel(["robinhood"], W));
    assert.ok(!none.includes("/day") && !none.includes("undefined"), "nothing in scope: no figure");

    // 14 partial
    const part = base1(); part.robinhood.positions.positions[1].dailyUsd = null;
    const pp = await payloadFor(part);
    const pr = rateOf(pp, "robinhood", M);
    near(pr.perDayUsd, 2.4, "partial"); assert.strictEqual(pr.measured, 1); assert.strictEqual(pr.total, 2);
    assert.ok(V.ratesHtml(pp, sel(["robinhood"])).includes("1 of 2 positions measured"));

    // 15 unknown (null, string, negative, part missing)
    for (const bad of [null, "3", -1]) {
      const fx = base1(); for (const e of fx.robinhood.positions.positions) e.dailyUsd = bad;
      const q = await payloadFor(fx);
      assert.strictEqual(rateOf(q, "robinhood", M).perDayUsd, null, `dailyUsd ${bad}`);
      const th = V.ratesHtml(q, sel(["robinhood"]));
      assert.ok(th.includes("rate unknown") && !th.includes("/day"));
      assert.ok(!html(q, sel(["robinhood"])).includes("$0.00/day"));
    }
    const miss = base1(); miss.robinhood.positions = { __code: "unreachable" };
    const mp = await payloadFor(miss);
    assert.strictEqual(rateOf(mp, "robinhood", M).perDayUsd, null);
    assert.ok(V.ratesHtml(mp, sel(["robinhood"])).includes("rate unknown"));

    // 16 watched wallet without a rate
    for (const earned of [{ perHour: null, rateWindowH: null }, undefined]) {
      const q = await payloadFor(base1({ wOver: { earned } }));
      assert.strictEqual(rateOf(q, "base", W).perDayUsd, null);
      assert.ok(V.ratesHtml(q, sel(["base"])).includes("Base Wallet W: rate unknown"));
    }

    // 18 mixed known and unknown
    const mixed = base1(); mixed.base.watch = F.watch(); mixed.arc.positions = F.positions(M, { positions: [lp(8, { valueUsd: 10, feesUsd: 1 })] });
    const mx = await payloadFor(mixed);
    const mh = V.ratesHtml(mx, ALL());
    assert.ok(mh.includes("$3.00/day") && mh.includes("Arc Main: rate unknown") && mh.includes("1 of 2 sources"));
    const ah = V.ratesHtml(mx, sel(["arc"]));
    assert.ok(ah.includes("rate unknown") && !ah.includes("/day") && !ah.includes("$"));

    // 19 stale, short window, a real zero
    const st = base1(); st.robinhood.positions.at = F.AT - 30 * 60000; st.robinhood.positions.positions[0].rateWindowH = 3;
    const sp = await payloadFor(st);
    assert.strictEqual(rateOf(sp, "robinhood", M).stale, true);
    const sh = V.ratesHtml(sp, sel(["robinhood"]));
    assert.ok(sh.includes("stale") && sh.includes("short window") && sh.includes("3.0 h"));
    const z = base1(); for (const e of z.robinhood.positions.positions) e.dailyUsd = 0;
    const zh = V.ratesHtml(await payloadFor(z), sel(["robinhood"]));
    assert.ok(zh.includes("$0.00/day") && !zh.includes("rate unknown"));
  }

  // ---- 20, 21 escaping and markup
  {
    const X = "<img src=x onerror=alert(1)>", Y = '"><script>x</script>';
    const fx = {
      robinhood: empty({
        positions: F.positions(M, { positions: [lp(1, { pair: X, valueUsd: 10, feesUsd: 1, dailyUsd: 1, rateWindowH: 10 })], external: [ext("aerodrome-cl2", 2, { pair: X, valueUsd: 5, feesUsd: 1, rewards: reward(2, { symbol: X }) })] }),
        watch: F.watch([F.walletRow(W, Y, { positions: [lp(3, { pair: Y, valueUsd: 10, feesUsd: 2 })], earned: { perHour: 1, rateWindowH: 10 } })]),
      }),
    };
    const p = await payloadFor(fx, [{ key: "robinhood", label: X, accent: "#123456", port: 1 }]);
    const h = html(p, { chains: new Set(["robinhood"]), wallet: "", sort: "value" });
    assert.ok(!h.includes("<img") && !h.includes("<script"));
    assert.ok(h.includes("&lt;img") && h.includes("&lt;script"));
    assert.ok(!/<[^>]*\son[a-z]+=/i.test(h), "no handler attributes");
    for (const style of h.match(/style="[^"]*"/g) || []) assert.ok(/^style="--accent:#[0-9a-f]+"$/i.test(style), style);
  }
  console.log("aggregate-fees ok");
})().catch((e) => { console.error(e); process.exit(1); });
