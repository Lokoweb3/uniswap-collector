// node test/aggregate-roi.test.js -- the ROI column on /portfolio (aggregate.js + aggregate-view.js).
//
// What matters: an instance's return-on-capital figure reaches the page as numbers only;
// a position without one says "not tracked", never 0%; a testnet never shows one; the
// total is the summed gain over the summed basis of the tracked positions only.
"use strict";
const assert = require("assert");
const agg = require("../aggregate");
const F = require("./lib/aggregate-fixtures");
const V = require("../aggregate-view");
const { addr, lp, row } = F;

const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, `${m}: ${a} vs ${b}`);
const M = addr(1);
async function payloadFor(chains, data) {
  const ag = agg.createAggregator({
    chains, now: () => F.AT + 60000, waitMs: 500,
    fetchJson: async (chain, p) => ({ status: 200, data: JSON.parse(JSON.stringify(data[chain.key][p.split("/").pop()])) }),
  });
  return JSON.parse(JSON.stringify(await ag.get()));
}
const roiLp = (id, o) => lp(id, {
  valueUsd: 1000, feesUsd: 10,
  returnOnCapitalUsd: o.usd, returnOnCapitalPct: o.pct, returnOnCapitalBasisUsd: o.basis,
  returnOnCapitalUnavailable: "<img src=x onerror=alert(1)> upstream text",
  pnlApprox: o.approx === true, pnlSince: F.AT - 86400000, pnlUsd: 999, pnlLegs: { secret: 1 },
});
const chainData = () => ({
  positions: F.positions(M, { positions: [lp(1, { valueUsd: 500, feesUsd: 5 })] }),
  watch: F.watch([F.walletRow(addr(2), "Trading", {
    positions: [roiLp(11, { usd: 100, pct: 5, basis: 2000 }), roiLp(12, { usd: -50, pct: -10, basis: 500, approx: true }), lp(13, { valueUsd: 50, feesUsd: 0 })],
  })]),
  portfolio: F.portfolio(M, [row("ETH", 1, 2000, { native: true })]), staking: F.staking(),
});

(async () => {
  const CH = [{ key: "a", label: "Alpha", accent: "#111111", port: 1 }];
  const pl = await payloadFor(CH, { a: chainData() });
  const lps = pl.items.filter((it) => it.kind === "lp");
  assert.strictEqual(lps.length, 4);
  const byName = (re) => lps.filter((it) => it.roi).find((it) => re(it.roi));

  // ---- numbers pass, upstream text and legs do not
  const up = byName((r) => r.usd === 100);
  assert.deepStrictEqual(Object.keys(up.roi).sort(), ["approx", "basisUsd", "pct", "since", "usd"]);
  near(up.roi.pct, 5, "pct"); near(up.roi.basisUsd, 2000, "basis"); assert.strictEqual(up.roi.approx, false);
  const raw = JSON.stringify(pl);
  assert.ok(!raw.includes("upstream text") && !raw.includes("secret") && !raw.includes("pnlLegs"), "only whitelisted roi fields leave");
  assert.strictEqual(byName((r) => r.usd === -50).roi.approx, true);

  // ---- no basis: null, rendered as "not tracked", never 0%
  const untracked = lps.filter((it) => !it.roi);
  assert.strictEqual(untracked.length, 2);
  for (const it of untracked) assert.strictEqual(it.roi, null);
  const cell = V.lpRowHtml(pl, untracked[0]);
  assert.ok(cell.includes("not tracked") && !cell.includes("0.0%"));
  assert.strictEqual((cell.match(/<td/g) || []).length, 8, "eight cells per LP row");

  // ---- a tracked row: signed percent and dollars, approx marker
  const neg = V.lpRowHtml(pl, byName((r) => r.usd === -50));
  assert.ok(neg.includes("-10.0%") && neg.includes("-$50.00") && neg.includes("≈") && neg.includes('class="neg"'));
  assert.ok(V.lpRowHtml(pl, up).includes("+5.0%"));

  // ---- total: summed gain / summed basis of tracked rows; coverage stated
  const sel = { chains: new Set(["a"]), wallet: "", sort: "value" };
  const html = V.renderPage(pl, sel);
  assert.ok(html.includes("<th data-sort=\"roi\" class=\"sortable\">ROI</th>"));
  const foot = V.totalsRowHtml(pl, pl.totals, sel);
  assert.ok(foot.includes("+2.0%") && foot.includes("+$50.00"), "50 / 2500 = +2.0%: " + foot);
  assert.ok(foot.includes("2 of 4 positions tracked"));
  assert.ok(!html.includes("<img"), "escaped");

  // ---- sort: tracked by pct desc, untracked last
  const sorted = V.sortItems(lps.slice(), "roi");
  assert.deepStrictEqual(sorted.map((it) => it.roi && it.roi.pct), [5, -10, null, null]);

  // ---- testnet: no roi
  const TN = [{ key: "t", label: "Test", accent: "#111111", port: 1, testnet: true }];
  const tp = await payloadFor(TN, { t: chainData() });
  for (const it of tp.items.filter((x) => x.kind === "lp")) assert.strictEqual(it.roi, null, "testnet roi nulled");

  console.log("aggregate-roi.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
