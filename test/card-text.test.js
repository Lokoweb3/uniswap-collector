// node test/card-text.test.js — the wording on the LP position cards: claimed-fee
// states, verified zeros, the pool fee rate, full range, performance
// prerequisites, pricing text and freshness.
//
// dashboard.js is browser code; functions are lifted out of the source the way
// test/claims-watch-ui.test.js does it.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "dashboard.html"), "utf8");

function lift(name) {
  let from = src.indexOf(`\nasync function ${name}(`);
  if (from < 0) from = src.indexOf(`\nfunction ${name}(`);
  assert.ok(from >= 0, `${name} is gone from dashboard.js`);
  const first = src.slice(from + 1, src.indexOf("\n", from + 1));
  if (/\}\s*$/.test(first)) return "\n" + first + "\n";          // a one-line function
  return src.slice(from, src.indexOf("\n}\n", from) + 3);
}
function liftConst(name) {
  const from = src.indexOf(`\nconst ${name} = `);
  assert.ok(from >= 0, `${name} is gone from dashboard.js`);
  const lines = src.slice(from + 1).split("\n");
  const out = [lines[0]];
  for (let i = 1; i < lines.length && (/^\s/.test(lines[i]) || /^}/.test(lines[i])); i++) out.push(lines[i]);
  return out.join("\n") + "\n";
}

const consts = ["esc", "usd", "usdK", "CLAIM_STATES", "cDate", "cTime", "CLAIM_MIXED_NOTE", "endStop",
  "POOL_RATE_LABEL", "approxRate", "ACTIVE_LIQ_TIP", "DIRECT_RATE_TIP", "SCANNER_RATE_TIP", "LT_NEEDS",
  "PRICING_FALLBACK", "fetchedAt", "clock", "ltPctText", "ltDate"];
const fns = ["claimState", "claimVerifiedZero", "claimValuation", "claimMoney", "claimWhy", "claimRowValue",
  "claimKindLabel", "claimPriceLabel", "claimPanelHtml", "claimedMetric", "coverageText", "claimedLine",
  "ratePct", "poolRateText", "poolLine", "rangeStatus", "ltNeeds", "perfEmptyNote", "ltBasisText", "longTermLine",
  "notePricing", "pricingText", "freshText", "feeMetric", "renderWalletPanel"];
const exported = ["claimState", "claimVerifiedZero", "claimPanelHtml", "claimedMetric", "coverageText", "claimedLine",
  "ratePct", "poolLine", "rangeStatus", "perfEmptyNote", "longTermLine", "notePricing", "pricingText", "freshText",
  "feeMetric", "renderWalletPanel"];

function page() {
  const els = {
    pricefoot: { textContent: "" },
    "#walletbars": { innerHTML: "" }, "#walletpanelnote": { textContent: "" }, "#walletpaneltotal": { textContent: "" },
    "#walletpanel": { hidden: true }, "#pfscope": { hidden: false },
  };
  const document = { getElementById: (id) => els[id] || null };
  const state = { main: null, pf: null, watch: null };
  const body = `
    let PRICING = null;
    const linkify = (s) => esc(s);
    ${consts.map(liftConst).join("")}
    ${fns.map(lift).join("")}
    return { ${exported.join(", ")}, fetchedAt };`;
  const api = new Function("document", "$", "pfScope", "ownerLabel", "shortA", "state", `
    let lastMain = null, lastPortfolio = null, lastWatchForPf = null;
    const api = (() => { ${body} })();
    api.setData = (m, pf, w) => { lastMain = m; lastPortfolio = pf; lastWatchForPf = w; };
    return api;`)(document, (s) => els[s] || null, () => "all", () => "Main", (a) => a.slice(0, 6));
  return { api, els };
}

const { api, els } = page();
const strip = (s) => String(s).replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const tile = (claimed) => api.claimedMetric({ nftId: "1", claimed }, "u");
const face = (claimed) => strip(tile(claimed).replace(/title="[^"]*"/, ""));
const cov = (over) => ({ fromBlock: 100, toBlock: 900, fromT: Date.UTC(2026, 8, 10), toT: Date.UTC(2026, 8, 17),
  openedBlock: 120, openedT: Date.UTC(2026, 8, 10, 1), coversOpening: true, reachedLookbackFloor: false, lookbackDays: 30, ...over });
const tokens = [{ symbol: "USDC", amount: "70.85" }, { symbol: "ARGUS", amount: "2,580.18" }];

// ---- 1. claim states: six distinct wordings; "complete history" only when complete ----
{
  const complete = { state: "complete", status: "ok", verifiedZero: false, count: 10, last: Date.UTC(2026, 8, 16), tokens,
    usd: 149.92, usdBasis: "at-claim", priceSources: { block: 10, pricelog: 0, today: 0 }, coverage: cov({}) };
  const scanning = { state: "scanning", status: "partial", verifiedZero: false, count: 2, tokens, usd: 12.5, usdBasis: "at-claim",
    priceSources: { block: 1, pricelog: 1, today: 0 }, reason: "the scan has not yet reached the block this position was opened in",
    coverage: cov({ coversOpening: false, openedBlock: null, openedT: null }) };
  const lookback = { state: "lookback-reached", status: "partial", verifiedZero: false, count: 3, tokens, usd: 20, usdBasis: "at-claim",
    priceSources: { block: 3, pricelog: 0, today: 0 },
    reason: "this position opened before the 30-day lookback window, so claims before 2026-09-10 are not included",
    coverage: cov({ coversOpening: false, reachedLookbackFloor: true, openedBlock: null, openedT: null }) };
  const undecodable = { state: "undecodable", status: "unavailable", verifiedZero: false, coverage: cov({}),
    reason: "1 of 4 records in the scanned range cannot be read in full (a transfer could not be attributed); a total would be a guess" };
  const notScanned = { state: "not-scanned", status: "unavailable", verifiedZero: false, reason: "no block range has been scanned for this position yet" };
  const unsupported = { state: "unsupported", status: "unavailable", verifiedZero: false, reason: "claim history is not scanned for v3 positions" };

  const all = { complete, scanning, lookback, undecodable, notScanned, unsupported };
  const faces = {};
  for (const [k, c] of Object.entries(all)) {
    faces[k] = face(c) + " | " + strip(api.coverageText({ claimed: c })) + " | " + strip(api.claimedLine({ claimed: c }));
    assert.strictEqual(/complete history/.test(faces[k]), k === "complete", `"complete history" appears only for complete (${k}): ${faces[k]}`);
  }
  assert.strictEqual(new Set(Object.values(faces)).size, 6, "six distinct wordings");

  // complete
  assert.match(face(complete), /\$149\.92/);
  assert.match(face(complete), /10 claims .*complete history .*valued at each claim’s transaction price/);
  assert.ok(!/at least/.test(face(complete)), "a complete total is not a floor");
  // scanning: a floor, from when, in progress, the server's reason in the footer
  assert.match(face(scanning), /at least \$12\.50/);
  assert.match(face(scanning), /2 claims found so far since Sep \d+, 2026 · scan in progress/);
  assert.match(api.coverageText({ claimed: scanning }), /scan in progress.*has not yet reached the block this position was opened in\..*floor/);
  assert.match(strip(api.claimedLine({ claimed: scanning })), /Claimed at least .*at least \$12\.50.*scan in progress/);
  assert.match(tile(scanning), /title="[^"]*has not yet reached the block/);
  // lookback reached: lifetime incomplete, from when
  assert.match(face(lookback), /at least \$20\.00/);
  assert.match(face(lookback), /lifetime history incomplete · covers since Sep \d+, 2026/);
  assert.match(api.coverageText({ claimed: lookback }), /lifetime history incomplete, covers only since Sep \d+, 2026 — this position opened before the 30-day lookback window/);
  // undecodable: the reason, no figure
  assert.match(face(undecodable), /No figure/);
  assert.match(face(undecodable), /cannot be read in full/);
  assert.ok(!/\$/.test(face(undecodable)), "no dollar figure when undecodable");
  assert.match(api.coverageText({ claimed: undecodable }), /no figure — 1 of 4 records/);
  assert.match(strip(api.claimedLine({ claimed: undecodable })), /no figure — 1 of 4 records/);
  // not scanned / unsupported
  assert.match(face(notScanned), /Not scanned yet/);
  assert.match(api.coverageText({ claimed: notScanned }), /not scanned yet — no block range has been scanned/);
  assert.match(face(unsupported), /Not supported.*not scanned for v3/);
  assert.match(api.coverageText({ claimed: unsupported }), /not supported — claim history is not scanned for v3 positions\./);
  // no summary at all
  assert.match(face(null), /Not scanned yet/);

  // a scanning answer with nothing found yet has no figure and says so
  const scanningEmpty = { ...scanning, count: 0, tokens: [], usd: null };
  assert.match(face(scanningEmpty), /Scanning…/);
  assert.match(face(scanningEmpty), /none found so far/);
  assert.ok(!/\$/.test(face(scanningEmpty)));
  assert.match(strip(api.claimedLine({ claimed: scanningEmpty })), /No claims found since .*not a zero/);
  const lookbackEmpty = { ...lookback, count: 0, tokens: [], usd: null };
  assert.match(face(lookbackEmpty), /Incomplete/);

  // the server's reason wins; no invented cause beside it
  assert.ok(!/Claim history is not supported for this position/.test(tile(unsupported)));
  assert.match(tile({ state: "unsupported", status: "unavailable" }), /Claim history is not supported for this position/);

  // tile, line and panel of a complete claim say the claimed and uncollected fees are valued differently
  assert.match(tile(complete), /historical prices; uncollected fees are valued at current prices/);
  assert.match(api.claimedLine({ claimed: complete }), /historical prices; uncollected fees are valued at current prices/);
  assert.match(strip(api.feeMetric({ feesUsd: 3 })), /at current prices/);
}

// ---- fallback: state derived from the older fields when `state` is absent ----
{
  const S = (c) => api.claimState(c);
  assert.strictEqual(S({ status: "ok", coverage: { coversOpening: true } }), "complete");
  assert.strictEqual(S({ status: "ok", coverage: { coversOpening: false } }), "scanning", "ok without the opening is not complete");
  assert.strictEqual(S({ status: "partial", coverage: { coversOpening: false, reachedLookbackFloor: true } }), "lookback-reached");
  assert.strictEqual(S({ status: "partial", coverage: { coversOpening: false, reachedLookbackFloor: false } }), "scanning");
  assert.strictEqual(S({ status: "partial" }), "scanning");
  assert.strictEqual(S({ status: "unavailable", coverage: { fromBlock: 1 } }), "undecodable");
  assert.strictEqual(S({ status: "unavailable", reason: "x" }), "not-scanned");
  assert.strictEqual(S(null), "not-scanned");
  assert.strictEqual(S({ state: "lookback-reached", status: "ok", coverage: { coversOpening: true } }), "lookback-reached", "the server's state wins");
}

// ---- verified zero: only from verifiedZero === true (or the strict fallback) ----
{
  const base = { state: "complete", status: "ok", count: 0, tokens: [], usd: 0, coverage: cov({}) };
  const isZero = (c) => /\$0\.00/.test(face(c)) && /verified/.test(face(c));
  assert.ok(isZero({ ...base, verifiedZero: true }), "verifiedZero:true shows a verified zero");
  assert.match(face({ ...base, verifiedZero: true }), /none claimed · complete history, verified/);
  assert.ok(!isZero({ ...base, verifiedZero: false }), "verifiedZero:false never shows a zero, even with count 0 and $0");
  assert.ok(!/No fees claimed yet/.test(api.claimedLine({ claimed: { ...base, verifiedZero: false } })));
  // fallback without the flag: complete + count 0 + usd 0
  const { verifiedZero, ...noFlag } = { ...base, verifiedZero: true };
  assert.ok(isZero({ ...noFlag, state: undefined }), "fallback: complete, count 0, $0");
  // missing records are never zero
  for (const [why, c] of [
    ["count missing", { ...noFlag, count: undefined }],
    ["usd missing", { ...noFlag, usd: undefined }],
    ["usd null", { ...noFlag, usd: null }],
    ["scanning", { ...noFlag, state: "scanning" }],
    ["lookback", { ...noFlag, state: "lookback-reached" }],
    ["undecodable", { ...noFlag, state: "undecodable" }],
    ["no coverage fallback", { status: "ok", count: 0, usd: 0 }],
  ]) {
    assert.ok(!isZero(c), `no verified zero when ${why}`);
    assert.ok(!api.claimVerifiedZero(c), `claimVerifiedZero false when ${why}`);
    assert.ok(!/No fees claimed yet/.test(api.claimedLine({ claimed: c })), `line: no zero when ${why}`);
  }
  // panel
  const panel = (over) => api.claimPanelHtml({ ok: true, rows: [], coverage: cov({}), ...over });
  assert.match(panel({ state: "complete", status: "ok", verifiedZero: true }), /never had fees collected \(verified\)/);
  assert.ok(!/never had fees collected/.test(panel({ state: "complete", status: "ok", verifiedZero: false })));
  assert.match(panel({ state: "complete", status: "ok", verifiedZero: false }), /did not confirm a zero/);
  assert.ok(!/never had fees collected/.test(panel({ state: "scanning", status: "partial" })));
  assert.match(panel({ state: "scanning", status: "partial" }), /not the same as none having happened/);
}

// ---- panel: state wording, row USD with source and price time ----
{
  const t = Date.UTC(2026, 8, 12, 14, 0);
  const d = { ok: true, state: "complete", status: "ok", verifiedZero: false, usd: 3.5, priceSources: { block: 1, pricelog: 1, today: 1 },
    coverage: cov({}), rows: [
      { t, kind: "collect", fee0: "1 USDC", fee1: "2 ARGUS", priceSrc: "block", usd: 1.25, priceT: t, tx: "0x" + "ab".repeat(32) },
      { t, kind: "collect", fee0: "1 USDC", fee1: "3 ARGUS", priceSrc: "pricelog", usd: 2, priceT: Date.UTC(2026, 8, 12, 13) },
      { t, kind: "collect", fee0: "0.2 USDC", fee1: "0 ARGUS", priceSrc: null, usd: 0.25, priceT: Date.UTC(2026, 8, 17, 9) },
      { t, kind: "collect", fee0: "0.1 USDC", fee1: "0 ARGUS", priceSrc: "block", usd: null },
    ] };
  const h = api.claimPanelHtml(d);
  const txt = strip(h);
  assert.match(txt, /Complete history: scanned blocks 100–900/);
  assert.match(txt, /Total ≈\$3\.50, valued at each claim’s transaction price \(1\) or the hourly price log \(1\); 1 of 3 at today’s prices/);
  assert.match(txt, /\$1\.25transaction price · Sep 12/);
  assert.match(txt, /\$2\.00hourly price log · Sep 12/);
  assert.match(txt, /≈\$0\.250today’s price · Sep 17/);
  assert.match(txt, /no USD valuetransaction price/, "a row without USD says so, never $0");
  assert.match(h, /<th scope="col">USD value<\/th>/);

  const scan = strip(api.claimPanelHtml({ ...d, state: "scanning", status: "partial", reason: "the scan has not yet reached the block this position was opened in" }));
  assert.match(scan, /Scan in progress: only blocks 100–900 .*has not yet reached the block.*floor, not a total/);
  assert.ok(!/complete history/i.test(scan));
  const lb = strip(api.claimPanelHtml({ ...d, state: "lookback-reached", status: "partial", reason: "opened before the lookback window" }));
  assert.match(lb, /Lifetime history incomplete: the scan reached its lookback limit and covers only claims since Sep \d+, 2026/);
  const und = strip(api.claimPanelHtml({ ...d, state: "undecodable", status: "unavailable", reason: "a payout could not be attributed" }));
  assert.match(und, /No figure: a payout could not be attributed\. .*not a zero/);
  assert.ok(!/Total/.test(und));
  assert.match(strip(api.claimPanelHtml({ state: "not-scanned", status: "unavailable", reason: "no block range has been scanned for this position yet" })),
    /not scanned yet: no block range has been scanned for this position yet\. .*not a zero/);
  assert.match(strip(api.claimPanelHtml({ state: "unsupported", status: "unavailable", reason: "v3 is not scanned" })), /not supported: v3 is not scanned\./);
}

// ---- valuation labels on the tile ----
{
  const c = (ps, basis) => ({ state: "complete", status: "ok", verifiedZero: false, count: 2, tokens, usd: 10, usdBasis: basis, priceSources: ps, coverage: cov({}) });
  assert.match(face(c({ block: 2, pricelog: 0, today: 0 }, "at-claim")), /^Claimed fees\$10\.00.*valued at each claim’s transaction price/);
  assert.match(face(c({ block: 0, pricelog: 2, today: 0 }, "at-claim")), /valued at the hourly price log/);
  assert.match(face(c({ block: 1, pricelog: 0, today: 1 }, "mixed")), /≈\$10\.00.*partly at today’s prices/);
  assert.match(face(c({ block: 0, pricelog: 0, today: 2 }, "today")), /≈\$10\.00.*at today’s prices/);
  // older server without priceSources
  assert.match(face(c(undefined, "mixed")), /≈\$10\.00.*partly at today’s prices/);
  assert.match(face(c(undefined, "at-claim")), /valued at claim-time prices/);
  // no USD total
  assert.match(face({ ...c({ block: 0, pricelog: 0, today: 0 }, null), usd: null, usdMissing: "a leg has no price" }), /No USD total/);
}

// ---- 2. pool fee rate ----
{
  const R = api.ratePct;
  assert.strictEqual(R(0.26084381710996607), "0.26%");
  assert.strictEqual(R(0.004), "<0.01%", "tiny positive rates are not rounded to 0%");
  assert.strictEqual(R(0.0004), "<0.01%");
  assert.strictEqual(R(0.01), "0.01%");
  assert.strictEqual(R(0.0456), "0.046%");
  assert.strictEqual(R(0.5), "0.5%");
  assert.strictEqual(R(12.34), "12.3%");
  assert.strictEqual(R(3.04), "3%");
  assert.strictEqual(R(1448.3252), "1,448%", "large rates are not capped");
  assert.strictEqual(R(0), "0%");
  assert.strictEqual(R(null), null);
  assert.strictEqual(R(undefined), null);
  assert.strictEqual(R(NaN), null);

  const direct = { direct: true, tvl: 76627576.69, fees24h: 547.61, aprPct: 0.26084, feesWindowH: 23.8, siblings: [] };
  const line = (q) => strip(api.poolLine({ pool: q }));
  const l1 = line(direct);
  assert.match(l1, /active \(in-range\) liquidity \$76\.63M/);
  assert.match(l1, /fees \$547\.61\/24h extrapolated to 24 h from 23\.8 h observed/);
  assert.match(l1, /Estimated annualized pool fee rate ~0\.26%/);
  assert.ok(!/~0%/.test(l1), "never a false 0%");
  const h1 = api.poolLine({ pool: direct });
  assert.match(h1, /title="Active \(in-range\) liquidity: the virtual reserves[^"]*not the pool’s total deposits/);
  assert.match(h1, /title="Estimated annualized pool fee rate[^"]*CURRENT active liquidity[^"]*CURRENT token prices[^"]*whole window[^"]*not this position’s return/);
  // a full window is not called extrapolated
  assert.match(line({ ...direct, feesWindowH: 24 }), /observed over the last 24\.0 h/);
  // today's liquidity is assumed for the whole window: say so when the samples strayed
  assert.match(line({ ...direct, aprPct: 1448, liqRange: { min: 0.95, max: 1.52, samples: 24 } }), /active liquidity ranged 0\.95–1\.52× today’s over the window/);
  assert.match(line({ ...direct, aprPct: 1448 }), /~1,448%/, "a large rate is shown as computed, not capped");
  assert.ok(!/ranged/.test(line({ ...direct, liqRange: { min: 0.97, max: 1.04, samples: 24 } })), "a steady window needs no note");
  assert.ok(!/extrapolated/.test(line({ ...direct, feesWindowH: 24 })));
  // tiny / large / withheld
  assert.match(line({ ...direct, aprPct: 0.004 }), /pool fee rate <0\.01%/);
  assert.match(api.poolLine({ pool: { ...direct, aprPct: 0.004 } }), /<b>&lt;0\.01%<\/b>/, "the bound is escaped, not parsed as markup");
  assert.match(line({ ...direct, aprPct: 12.3 }), /pool fee rate ~12\.3%/);
  assert.match(line({ ...direct, fees24h: null, aprPct: null, feesWindowH: null }), /fee rate withheld: fewer than 30 minutes of fee-growth samples/);
  assert.match(line({ ...direct, fees24h: null, aprPct: null, feesWindowH: 2 }), /fee rate withheld: a token in this pool has no price/);
  assert.match(line({ ...direct, tvl: null, aprPct: null }), /liquidity unpriced.*fee rate withheld: active liquidity has no positive value/);
  // scanner row and siblings use the same formatting
  const scanner = { tvl: 2e6, vol24h: 1e6, fees24h: 30, aprPct: 0.5475, siblings: [
    { feePct: 0.3, version: "v3", tvl: 5e5, fees24h: 1, aprPct: 0.073 },
    { feePct: 1, version: "v4", tvl: 5e5, fees24h: 1, aprPct: 0.002 },
    { feePct: 0.05, version: "v4", tvl: 5e5, fees24h: null, aprPct: null },
  ] };
  const l2 = line(scanner);
  assert.match(l2, /pool TVL \$2\.00M .*Estimated annualized pool fee rate ~0\.55%/);
  assert.match(l2, /0\.3% v3 ~0\.073%/);
  assert.match(l2, /1% v4 <0\.01%/);
  assert.match(l2, /0\.05% v4 —/);
  assert.ok(!/\b0%/.test(l2.replace(/0\.0?5% v4|0\.3% v3|1% v4/g, "")), "no sibling rounds to 0%");
  assert.match(line({ ...scanner, aprPct: null, siblings: [] }), /fee rate withheld: the scanner gives no fees or TVL/);
  assert.ok(!/toFixed\(0\) \+ '%'/.test(lift("poolLine")), "no whole-number rounding left in poolLine");
}

// ---- 3. full range ----
{
  const st = api.rangeStatus({ tickLower: -887272, tickUpper: 887272, inRange: true }, {}, false);
  assert.strictEqual(st.text, "Full range");
  assert.strictEqual(st.sub, "Full range — fees accrue when eligible swaps occur.");
  assert.ok(!/always earning|never idle/.test(src), "the old wording is gone");
}

// ---- 4. performance prerequisites ----
{
  const m = (over) => ({ days: 5, feesUsd: 10, feeAprPct: 12, netUsd: 3, netPct: 1.5, basis: "open", basisUsd: 100, approx: false, unpricedCollects: 0, ...over });
  const lt = (d30, extra) => ({ longTerm: { chained: false, members: 1, d30, sinceOpen: d30, ...extra } });
  const note = (p) => api.perfEmptyNote(p);
  const line = (p) => strip(api.longTermLine(p));

  assert.match(note({ longTerm: null }), /have not been computed for this position in this read/);
  assert.ok(!/opening value/.test(note({ longTerm: null })), "a missing record is not described as a missing opening value");
  assert.match(note(lt(null, { sinceOpen: null })), /need the time this position was opened/);

  // basis only missing: both figures need it, fee observations are fine
  const noBasis = lt(m({ basisUsd: null, basis: null, feeAprPct: null, netPct: null }));
  assert.match(line(noBasis), /Fee APR and net return unavailable — need an opening value/);
  assert.ok(!/fee observation/.test(line(noBasis)), "fee observations are not claimed missing");
  // fees only missing: fee APR needs a fee observation, net return is shown
  const noFees = lt(m({ feesUsd: null, feeAprPct: null }));
  assert.match(line(noFees), /Fee APR —.*Net return \+1\.5%/);
  assert.match(api.longTermLine(noFees), /Unavailable: needs a fee observation at the start of the window/);
  assert.ok(!/Unavailable: needs an opening value/.test(api.longTermLine(noFees)));
  // net leg only missing
  const noNet = lt(m({ netUsd: null, netPct: null }));
  assert.match(line(noNet), /Fee APR 12%.*Net return —/);
  assert.match(api.longTermLine(noNet), /Unavailable: needs every leg of net return/);
  // window too short
  const short = lt(m({ days: 0.02, feeAprPct: null, netPct: null, netUsd: null }));
  assert.match(line(short), /Fee APR unavailable — needs a window of at least one hour; net return unavailable — needs every leg of net return/);
  // fees and basis both missing: both named, for the right figures
  const both = lt(m({ basisUsd: null, feesUsd: null, feeAprPct: null, netPct: null }));
  assert.match(line(both), /Fee APR unavailable — needs an opening value .* and a fee observation .*; net return unavailable — needs an opening value/);
  // all present: figures, no "unavailable"
  assert.match(line(lt(m({}))), /Fee APR 12%Net return \+1\.5%/);
  assert.ok(!/Unavailable/.test(api.longTermLine(lt(m({})))));
  // the old blanket sentence is gone
  assert.ok(!/neither is available here/.test(src));
}

// ---- 5. pricing text ----
{
  assert.ok(!/WETH or USDG/.test(src), "no inherited 'WETH or USDG' wording in dashboard.js");
  assert.ok(!/not paired with WETH/.test(html), "no WETH-specific pricing wording in dashboard.html");
  assert.match(html, /id="pricefoot"/);
  // without pricing
  api.notePricing({});
  assert.strictEqual(api.pricingText(), "Prices come from on-chain pools against this instance’s unit of account; a token with no such pool is left unpriced.");
  assert.ok(!/WETH|USDG/.test(api.pricingText()));
  assert.strictEqual(els.pricefoot.textContent, api.pricingText());
  // wallet overview note, without pricing
  api.setData({ owner: "0xowner", totals: { liquidityUsd: 10, feesUsd: 1, count: 1 } }, { totals: { walletUsd: 5, unpricedCount: 2 } }, null);
  api.renderWalletPanel();
  assert.match(els["#walletpanelnote"].textContent, /unit of account.*Unpriced tokens are excluded/);
  // with pricing
  const text = "Prices are read on-chain against USDC: position tokens from the position's own pool, wallet tokens from the deepest USDC pool. USDC is counted at $1 by configuration. A token with no such pool is left unpriced.";
  api.notePricing({ pricing: { unit: "USDC", unitUsd: 1, stable: null, text } });
  assert.strictEqual(api.pricingText(), text);
  assert.strictEqual(els.pricefoot.textContent, text);
  api.renderWalletPanel();
  assert.ok(els["#walletpanelnote"].textContent.includes(text));
  // a later payload without pricing keeps the known description
  api.notePricing({ ok: true });
  assert.strictEqual(api.pricingText(), text);
  // every place that described pricing now reads pricingText()
  for (const fn of ["renderPortfolio", "renderWalletPanel", "renderWatch"]) assert.match(lift(fn), /pricingText\(\)/, `${fn} uses pricingText()`);
  assert.match(lift("renderPortfolio"), /pricing side[^`]*\$\{pricingText\(\)\}/, "thin-pool tooltip uses pricingText()");
  for (const fn of ["render", "renderWatch"]) assert.match(lift(fn), /notePricing\(d\)/);
  assert.match(lift("loadBalances"), /notePricing\(d\)/);
  // portfolio totals leave claimed fees out and say so
  assert.match(lift("renderPortfolio"), /claimed fees are not added/);
}

// ---- 6. coverage panel ----
{
  const body = lift("renderCoveragePanel");
  assert.ok(!/loaded on Analytics, not here/.test(body));
  assert.match(body, /collection history opens from its Claimed fees tile/);
  assert.match(body, /Analytics adds the combined collect-by-collect table/);
}

// ---- 7. freshness ----
{
  const at = Date.UTC(2026, 8, 17, 9, 30);
  const d = { ok: true, at };
  assert.match(api.freshText(d), /^Last successful update: data read Sep 17, \d+:30 [AP]M\.$/);
  api.fetchedAt.set(d, Date.UTC(2026, 8, 17, 9, 42));
  assert.match(api.freshText(d), /^Last successful update: data read Sep 17, \d+:30 [AP]M · page last refreshed it Sep 17, \d+:42 [AP]M\.$/);
  assert.match(api.freshText({ ok: true, at, cached: true }), /\(a cached read\)/);
  assert.match(api.freshText({ ok: true }), /data read at an unrecorded time/);
  assert.strictEqual(api.freshText(null), "Last successful update unknown.");
  // the fetch time is recorded on success only; the stale warnings stay
  assert.match(lift("loadWatch"), /if \(o\.kind === 'error'\) return watchFailed\(o\.msg\);\n\s+if \(d && typeof d === 'object'\) fetchedAt\.set\(d, Date\.now\(\)\);/);
  assert.match(lift("load"), /throw new Error[^\n]*\n\s+fetchedAt\.set\(d, Date\.now\(\)\);/);
  assert.match(lift("watchFailed"), /staleNote\(lastWatchForPf && lastWatchForPf\.at, msg\)/);
  assert.match(lift("renderWatch"), /freshText\(d\)/);
  assert.ok(!/'Updated ' \+ new Date\(d\.at\)/.test(src));
  assert.match(lift("positionCard"), /esc\(freshText\(d\)\)/);
}

console.log("card text: claim states, verified zero, pool fee rate, full range, performance prerequisites, pricing text, freshness");
