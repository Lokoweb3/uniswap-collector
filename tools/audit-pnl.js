#!/usr/bin/env node
/**
 * audit-pnl.js — what the LP positions and fee tokens actually came to.
 *
 * Read-only. It sends nothing, writes nothing, and changes no ledger.
 *
 * Three questions, answered separately because they have different evidence:
 *
 *   1. Per position: what went in, what came out, what is still in it, and how that
 *      compares with having simply held the two tokens. The difference between those
 *      last two IS the impermanent loss, net of the fees earned -- there is no
 *      separate "IL number" that means anything on its own, because a position's
 *      fees are what it is paid for bearing that loss.
 *
 *   2. Fee tokens: what the collector sold them for against what they were worth
 *      when they arrived (strategy.js lots, cost basis and realised proceeds).
 *
 *   3. Coverage: what the answer does NOT include. This matters more than the
 *      totals. Nineteen of this instance's positions pay a native-asset leg that
 *      emits no log and cannot be reconstructed; some collects have no recorded
 *      price; one token is 80% of the main wallet and is valued by assumption. A
 *      profit figure quoted without those is a guess wearing a decimal point.
 *
 * Figures come from the running dashboard's own endpoints, so this reports what the
 * instance believes rather than a second opinion computed here -- if it is wrong,
 * it is wrong on the page too, and that is the thing worth knowing.
 *
 *   node tools/audit-pnl.js                 # this chain (8787)
 *   node tools/audit-pnl.js --port=8797     # the Arc instance
 */
"use strict";

const http = require("http");

const arg = (n, d = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split("=").slice(1).join("=") : d;
};
const PORT = Number(arg("port", 8787));
const HOST = arg("host", "127.0.0.1");

const get = (path) => new Promise((resolve) => {
  http.get({ host: HOST, port: PORT, path, timeout: 180000 }, (r) => {
    let body = "";
    r.setEncoding("utf8");
    r.on("data", (c) => (body += c));
    r.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  }).on("error", () => resolve(null)).on("timeout", function () { this.destroy(); resolve(null); });
});

const usd = (n) => (n == null ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const pct = (n) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
const pad = (s, n) => String(s).padEnd(n);

async function main() {
  const [chain, positions, lots, treasury, history, watch] = await Promise.all([
    get("/api/chain"), get("/api/positions"), get("/api/strategy/lots"), get("/api/treasury"), get("/api/history"), get("/api/watch"),
  ]);
  if (!chain || !positions) throw new Error(`no answer from ${HOST}:${PORT} — is that dashboard running?`);

  console.log(`\n=== Profitability audit — ${chain.chainName} (chain ${chain.chainId}) ===`);
  console.log(`Read from the dashboard on ${HOST}:${PORT}. Nothing here was computed independently of it.\n`);

  // ---- 1. open positions: in, out, still in, and versus holding ---------------
  // The main wallet is only one of them, and on some instances it is empty: Arc's
  // positions are all held by a watched wallet. Reporting the main wallet alone
  // would put $278 on the page while thousands sit elsewhere.
  const watched = ((watch && watch.wallets) || []).filter((w) => w.ok);
  const open = [
    ...(positions.positions || []).filter((p) => !p.closed).map((p) => ({ ...p, owner: "Main" })),
    ...watched.flatMap((w) => (w.positions || []).map((p) => ({ ...p, owner: w.label || w.address }))),
  ];
  console.log(`--- Open positions (${open.length}) ---`);
  console.log(pad("  wallet", 13) + pad("pair", 22) + pad("deposited", 12) + pad("held now", 12) + pad("fees", 11) + pad("vs holding", 13) + "basis");
  let dep = 0, held = 0, unc = 0, coll = 0, wdr = 0, vsHold = 0, unknownLegs = 0, unmeasured = 0;
  // Kept apart from the totals above: a net figure may only be formed from
  // positions whose deposit is known, or it is capital masquerading as profit.
  let heldKnown = 0, uncKnown = 0;
  for (const p of open) {
    // A position with no opening basis has no legs at all. Printing $0.00 for it
    // reads as "nothing in it" when the truth is "we do not know what went in" --
    // and these two hold most of the LP capital on this chain. Its present value is
    // still known, so that is shown and the unknown side is left blank.
    const l = p.pnlLegs || null;
    const known = !!l;
    const d = known ? Number(l.deposited) || 0 : null;
    const h = known ? Number(l.held) || 0 : (Number(p.valueUsd) || 0);
    const u = known ? Number(l.uncollected) || 0 : (Number(p.feesUsd) || 0);
    const c = known ? Number(l.collected) || 0 : 0;
    const w = known ? Number(l.withdrawn) || 0 : 0;
    if (known) { dep += d; coll += c; wdr += w; heldKnown += h; uncKnown += u; } else { unmeasured += h + u; }
    held += h; unc += u;
    if (p.pnlUsd != null) vsHold += p.pnlUsd;
    if (p.pnlUnavailable || p.pnlApprox || p.pnlUsd == null) unknownLegs++;
    console.log(
      pad(`  ${p.owner}`, 13) + pad(p.pair, 22) + pad(d == null ? "unknown" : usd(d), 12) + pad(usd(h), 12) + pad(usd(u + c), 11)
      + pad(p.pnlUsd == null ? "—" : `${usd(p.pnlUsd)} ${pct(p.pnlPct)}`, 13)
      + (p.pnlUnavailable ? "unavailable" : p.pnlApprox ? `${p.pnlSource || "?"} (approx)` : p.pnlSource || "?"),
    );
  }
  console.log(`\n  put in            ${usd(dep)}  (only the positions whose opening basis is known)`);
  console.log(`  still in them     ${usd(held)}`);
  console.log(`  fees taken out    ${usd(coll)}`);
  console.log(`  fees still inside ${usd(unc)}`);
  console.log(`  principal out     ${usd(wdr)}`);
  // Only over the positions with a known deposit. Subtracting a deposit total that
  // excludes the unmeasured positions from a held total that includes them reported
  // $3,811 of "net on capital" where the true figure was $0.54 and the rest was
  // capital whose basis nobody recorded.
  const net = heldKnown + uncKnown + coll + wdr - dep;
  console.log(`  net on capital    ${usd(net)}  (held + fees + withdrawn - deposited, over the ${open.length - unknownLegs} position(s) with a known basis)`);
  console.log(`  versus holding    ${usd(vsHold)}  <- fees earned MINUS impermanent loss`);
  console.log("  The second figure is the one that answers \"was providing liquidity worth it\":");
  console.log("  positive means the fees more than paid for the divergence, negative means they did not.");
  if (unmeasured > 0) {
    console.log(`\n  NOT ANSWERED      ${usd(unmeasured)} of open LP value has no opening basis recorded,`);
    console.log(`                    so whether it made or lost money cannot be established from what exists.`);
    console.log(`                    That is ${((unmeasured / (held + unc)) * 100).toFixed(0)}% of the open LP value on this chain.`);
  }
  if (unknownLegs) console.log(`  ${unknownLegs} position(s) have an approximate or unavailable basis — see coverage below.`);
  for (const p of open) {
    if (p.pnlUnavailable) console.log(`    #${p.nftId || p.tokenId} ${p.pair}: ${p.pnlUnavailable}`);
  }

  // ---- 2. fee tokens: what they were worth, what they fetched ----------------
  if (lots && lots.lots) {
    const rows = lots.lots;
    const disposed = rows.filter((r) => Number(r.disposedAmount) > 0 && r.proceedsUsd != null);
    const basis = disposed.reduce((t, r) => t + (Number(r.usd) || 0) * (Number(r.disposedAmount) / Number(r.amount) || 0), 0);
    const proceeds = disposed.reduce((t, r) => t + (Number(r.proceedsUsd) || 0), 0);
    const openLots = rows.filter((r) => Number(r.remainingAmount) > 0);
    console.log(`\n--- Fee tokens (${rows.length} lots) ---`);
    console.log(`  sold            ${disposed.length} lot(s): worth ${usd(basis)} when collected, fetched ${usd(proceeds)}  (${usd(proceeds - basis)})`);
    console.log(`  still held      ${openLots.length} lot(s), ${usd(openLots.reduce((t, r) => t + (Number(r.usd) || 0), 0))} at their collect-time value`);
    if (lots.soldAtCollect) {
      const s = lots.soldAtCollect;
      console.log(`  sold at collect ${s.count ?? (s.rows || []).length ?? 0} — proceeds are income already and never became lots`);
    }
  }

  // ---- 3. what the answer leaves out -----------------------------------------
  console.log(`\n--- Coverage: what these figures do NOT include ---`);
  const claims = await get("/api/claims/total");
  if (claims && claims.coverage) {
    const c = claims.coverage;
    console.log(`  claim history complete for ${c.positionsComplete} of ${c.positionsTotal} position(s)`);
    const unsupported = (c.unsupported || []).length, partial = (c.partial || []).length;
    if (unsupported) console.log(`  ${unsupported} cannot be reconstructed at all (native-asset legs emit no log)`);
    if (partial) console.log(`  ${partial} are partial — their figures are floors, not totals`);
  }
  if (positions.totals && positions.totals.unpricedCount) console.log(`  ${positions.totals.unpricedCount} token(s) have no price and are excluded from every value above`);
  const pf = await get("/api/portfolio");
  if (pf && pf.totals && pf.totals.assumedUsd) {
    console.log(`  ${usd(pf.totals.assumedUsd)} of the portfolio is priced by assumption (${(pf.totals.assumedTokens || []).map((t) => `${t.symbol} as ${t.via}`).join(", ")}),`);
    console.log(`    which is ${((pf.totals.assumedUsd / pf.totals.totalUsd) * 100).toFixed(0)}% of it — no market prices that token on this chain`);
  }
  if (history && history.rows) {
    const unlocked = history.rows.filter((r) => !r.locked && r.usd != null).length;
    console.log(`  ${unlocked} collect(s) are valued at today's prices rather than the price when they were taken`);
  }
  if (treasury && treasury.totalSplitUsdg != null) {
    console.log(`  ${usd(treasury.totalSplitUsdg)} of fees went to the vault (${treasury.count} split(s)) and is inside the fee figures above, not additional to them`);
  }
  console.log("\nNothing above is a projection. Where a figure could not be measured it is left out and said so.\n");
}

main().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
