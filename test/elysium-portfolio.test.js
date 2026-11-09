// node test/elysium-portfolio.test.js -- Portfolio policy for a test network: EXCLUDED from every total and shown on its
// own. A priced testnet figure must never reach grandUsd, any other total, any breakdown, any wallet figure or the rates.
"use strict";
const assert = require("assert");
const agg = require("../aggregate");
const F = require("./lib/aggregate-fixtures");
const V = require("../aggregate-view");
const { addr, lp, row } = F;

const REAL = { key: "real", label: "Real", accent: "#111111", port: 1 };
const TEST = { key: "elysium-testnet", label: "Elysium Testnet", accent: "#f59e0b", port: 2, testnet: true };
const M = addr(1);
const data = (extraTest = {}) => ({
  real: {
    positions: F.positions(M, { positions: [lp(1, { valueUsd: 1000, feesUsd: 10 })] }),
    watch: F.watch([F.walletRow(addr(2), "Wallet 1", { positions: [lp(3, { valueUsd: 200, feesUsd: 4 })] })]),
    portfolio: F.portfolio(M, [row("ETH", 1, 2000, { native: true })]), staking: F.staking(),
  },
  [TEST.key]: {
    // a misconfigured price: the testnet native balance AND an LP carry real-looking USD figures
    positions: F.positions(M, { positions: [lp(1, { valueUsd: 1000, feesUsd: 50 })] }),
    watch: F.watch([F.walletRow(addr(9), "Testnet only", { positions: [lp(5, { valueUsd: 1000 })] })]),
    portfolio: F.portfolio(M, [row("HYPE", 1000, 1, { native: true, price: 1 })]), staking: F.staking(),
    ...extraTest,
  },
});
async function payload(chains, d, opts = {}) {
  const ag = agg.createAggregator({ chains, now: () => F.AT + 60000, waitMs: 500, ...opts, fetchJson: async (chain, p) => { const v = d[chain.key][p.split("/").pop()]; return v.__code ? { code: v.__code } : { status: 200, data: v }; } });
  return ag.get();
}

(async () => {
  const without = await payload([REAL], data());
  const withT = await payload([REAL, TEST], data());

  // 18. identical totals, breakdowns and wallet figures with and without the testnet chain
  assert.deepStrictEqual(withT.totals, without.totals, "every totals.* is identical");
  assert.ok(withT.totals.grandUsd > 0);
  assert.deepStrictEqual(withT.breakdown, without.breakdown, "byChain / byWallet / byProtocol / fees are identical");
  assert.deepStrictEqual(withT.wallets, without.wallets, "wallet figures (countedUsd) are identical; a testnet-only wallet adds none");
  assert.deepStrictEqual(withT.rates, without.rates, "no rate from the testnet");
  const tItems = withT.items.filter((i) => i.chain === TEST.key);
  assert.ok(tItems.length >= 2, "the testnet items are listed");
  for (const it of tItems) {
    assert.strictEqual(it.testnet, true); assert.strictEqual(it.counted, false); assert.strictEqual(it.reason, "testnet");
    assert.strictEqual(it.valueUsd, null, "no USD figure leaves the aggregate for a testnet item");
    assert.strictEqual(it.rewardsCounted, false);
  }
  assert.ok(withT.items.filter((i) => i.chain === "real").every((i) => !i.testnet));
  assert.deepStrictEqual(withT.testnet, { chains: [TEST.key], items: tItems.length });
  const tc = withT.chains.find((c) => c.key === TEST.key);
  assert.strictEqual(tc.testnet, true); assert.strictEqual(tc.totals.countedUsd, null);
  assert.strictEqual(withT.chains.find((c) => c.key === "real").testnet, undefined);
  assert.strictEqual(withT.incomplete, false, "a healthy testnet does not make the total incomplete");
  assert.ok(!("elysium-testnet" in withT.breakdown.byChain), "the testnet is not in the by-chain breakdown");

  // 19. a testnet that is down: shown as down with its own code; the real total's honesty and grandUsd are untouched
  const downData = data();
  downData[TEST.key] = { positions: { __code: "unreachable" }, watch: { __code: "unreachable" }, portfolio: { __code: "unreachable" }, staking: { __code: "unreachable" } };
  const down = await payload([REAL, TEST], downData);
  assert.strictEqual(down.chains.find((c) => c.key === TEST.key).status, "down");
  assert.strictEqual(down.totals.grandUsd, without.totals.grandUsd, "grandUsd is unchanged");
  assert.deepStrictEqual(down.totals, without.totals);
  assert.strictEqual(down.incomplete, false, "the real total is still complete");
  assert.ok(down.incompleteList.some((e) => e.chain === TEST.key && e.code === "testnet-down" && e.testnet === true), "flagged in incompleteList with its own code");
  assert.ok(down.incompleteList.every((e) => e.chain === TEST.key), "and nothing else is flagged");
  assert.ok(!down.breakdown.byChain.hasOwnProperty(TEST.key));

  // aggregate-view: a separate section, no testnet amount in the grand total, no USD for testnet rows
  const sel = { chains: new Set(["real", TEST.key]), wallet: "", sort: "value" };
  const html = V.renderPage(withT, sel);
  assert.ok(html.includes("Testnets (not counted)"), "the separate section");
  assert.ok(html.includes("TESTNET"));
  const grand = /<div class="grand">([^<]*)<\/div>/.exec(html)[1];
  assert.strictEqual(grand, V.usd(without.totals.grandUsd), "the grand total is the real one");
  const tSection = html.slice(html.indexOf("Testnets (not counted)"));
  assert.ok(!/\$[0-9]/.test(tSection.replace(/<[^>]*>/g, " ")), "no dollar amount in the testnet section");
  assert.ok(!html.slice(0, html.indexOf("Testnets (not counted)")).includes("HYPE"), "no testnet row among the counted tables");
  assert.ok(V.renderPage(down, sel).includes("(testnet) is down"), "a down testnet is announced as down, not as $0");
  assert.ok(!V.renderPage(down, sel).includes("missing from the total"), "and not as something missing from the total");

  // an unfiltered selection that unticks the testnet chip still uses the server's totals
  const noT = { chains: new Set(["real"]), wallet: "", sort: "value" };
  assert.strictEqual(V.totalsFor(withT, V.filterItems(withT, noT), noT), withT.totals);

  // raw wei with unverified decimals: carried through ingest, shown labelled, never a USD figure
  const rawData = data({ portfolio: F.portfolio(M, [{ symbol: "HYPE", address: null, native: true, wallet: null, walletRaw: "489000000000000000", decimalsUnverified: true, pools: 0, fees: 0, price: null, walletUsd: null, usd: null, source: "wallet" }]) });
  const raw = await payload([REAL, TEST], rawData);
  const rawItem = raw.items.find((i) => i.chain === TEST.key && i.kind === "token");
  assert.ok(rawItem, "the raw native balance is an item");
  assert.strictEqual(rawItem.amountRaw, "489000000000000000"); assert.strictEqual(rawItem.decimalsUnverified, true);
  assert.strictEqual(rawItem.amount, null); assert.strictEqual(rawItem.counted, false);
  const rawHtml = V.renderPage(raw, sel);
  assert.ok(rawHtml.includes("489000000000000000 wei") && rawHtml.includes("decimals unverified"));
  assert.deepStrictEqual(raw.totals, without.totals);
  // a non-digit raw value is not ingested
  const evil = data({ portfolio: F.portfolio(M, [{ symbol: "HYPE", address: null, native: true, wallet: null, walletRaw: "<img>", decimalsUnverified: true }]) });
  assert.ok(!JSON.stringify(await payload([REAL, TEST], evil)).includes("<img>"));

  console.log("elysium portfolio: a testnet is excluded from every total, listed on its own, down means down");
})().catch((e) => { console.error(e); process.exit(1); });
