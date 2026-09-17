// node test/claims-total-ui.test.js — the read-only "Total claimed fees" control
// and its panel: the button's label, scope and read-only wording; the headline for
// every state; tokens grouped by address; the historical figure and today's figure
// kept apart; the open/closed/other subtotals; per-position rows; the query the
// filters build; the collection rows; the coverage lists; and a failed refresh
// that keeps the last good panel with a stale note.
//
// dashboard.js is browser code; the functions are lifted out of the source with
// everything they reference, as test/closed-view.test.js does it.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");
const html = fs.readFileSync(path.join(ROOT, "dashboard.html"), "utf8");

function constOf(name) {
  const f = src.indexOf(`\nconst ${name} =`);
  if (f < 0) return null;
  let depth = 0, quote = null;
  for (let i = f + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === ";" && depth === 0) return src.slice(f, i + 1) + "\n";
  }
  return null;
}
function bodyOf(name) {
  let f = src.indexOf(`\nasync function ${name}(`);
  if (f < 0) f = src.indexOf(`\nfunction ${name}(`);
  if (f < 0) return constOf(name);
  const first = src.slice(f + 1, src.indexOf("\n", f + 1));
  return /\}\s*$/.test(first) ? "\n" + first + "\n" : src.slice(f, src.indexOf("\n}\n", f) + 3);
}
function lifted(roots, provided) {
  const all = new Set([...src.matchAll(/\n(?:async )?function ([A-Za-z_$][\w$]*)\(/g), ...src.matchAll(/\nconst ([A-Za-z_$][\w$]*) =/g)].map((m) => m[1]));
  const skip = new Set(["esc", ...provided]);
  const need = new Set(), queue = [...roots];
  while (queue.length) {
    const n = queue.pop();
    if (need.has(n) || skip.has(n)) continue;
    const body = bodyOf(n);
    assert.ok(body, `${n} missing from dashboard.js`);
    need.add(n);
    for (const m of body.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) if (m[1] !== n && all.has(m[1]) && !need.has(m[1]) && !skip.has(m[1])) queue.push(m[1]);
  }
  return src.match(/^const esc = .*$/m)[0] + "\n" + [...need].map(bodyOf).join("\n");
}
const PROVIDED = ["$", "pref", "setPref", "loadOk", "loadFailed", "histScope", "shortA", "ownerLabel",
  "panel", "load", "render", "tick", "price", "amount", "clock", "linkify"];

function page() {
  const el = (x = {}) => ({ hidden: false, innerHTML: "", className: "", textContent: "", title: "", value: "", dataset: {}, ...x });
  const els = { "#ctotbtn": el(), "#ctbody": el(), "#chaintax": el(), "#chaintaxtotal": el(), "#ctwalletwrap": el({ hidden: true }), "#ctwallet": el(),
    "#ctstatus": el({ value: "all" }), "#ctfrom": el(), "#ctto": el(),
    "#posfilter": el({ contains: () => false, querySelector: () => null }), "#histsec": el({ hidden: true }), "#histstale": el({ hidden: true }), "#histlist": el() };
  const prefs = new Map();
  const h = { answers: [], urls: [], oks: [], fails: [], scope: "all" };
  const document = { activeElement: null, body: { classList: { toggle: () => {} } }, querySelector: () => null };
  const fetch = async (url) => {
    h.urls.push(url);
    const a = h.answers.shift();
    if (a instanceof Error) throw a;
    return { status: a.status, json: async () => { if (a.body instanceof Error) throw a.body; return a.body; } };
  };
  const body = `
    let EXPLORER = 'https://explorer.example', CHAIN = { id: 5042, name: null };
    let lastMain = { owner: '0xB1cdC09B4C7F28365a8E7BFA2332aF54f5462aF5' };
    let lastWatchForPf = { wallets: [{ address: '0x0556f2f94efd53f2d3f8281dd3b88d6341e4b659', label: 'SEAL wallet' }] };
    const shortA = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';
    const ownerLabel = () => 'Arc LP';
    const amount = (n) => String(n), price = (n) => String(n), linkify = (s) => esc(s);
    let chainFeesD = null;
    const usd = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ${lifted(["ctotalQuery", "ctotalHeadline", "ctotalButtonHtml", "ctotalPanelHtml", "ctotalBodyHtml", "ctTokensText",
      "loadClaimTotal", "renderClaimTotalButton", "renderClaimTotalPanel", "readCtFilters", "ctDay", "ctotalFailHead", "loadPosHistory",
      "renderChainTax"], [...PROVIDED, "usd"])}
    return { ctotalQuery, ctotalHeadline, ctotalButtonHtml, ctotalPanelHtml, ctotalBodyHtml, ctTokensText, ctDay,
      loadClaimTotal, renderClaimTotalButton, renderClaimTotalPanel, readCtFilters, loadPosHistory, CTOT, HIST,
      renderChainTax: (d) => { chainFeesD = d; return renderChainTax(); } };`;
  const api = new Function("document", "fetch", "$", "pref", "setPref", "loadOk", "loadFailed", "histScope", body)(
    document, fetch, (s) => els[s] || null,
    (k) => (prefs.has(k) ? prefs.get(k) : null), (k, v) => prefs.set(k, v),
    (s) => h.oks.push(s), (s, e) => h.fails.push(`${s}: ${e.message}`), () => h.scope);
  return { api, els, h };
}
const strip = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const noTitles = (s) => String(s).replace(/ title="[^"]*"/g, "");

// ---- fixtures, shaped like GET /api/claims/total ------------------------------------
const POSM = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b";
const W1 = "0xb1cdc09b4c7f28365a8e7bfa2332af54f5462af5";
const W2 = "0x0556f2f94efd53f2d3f8281dd3b88d6341e4b659";
const OTHER = "0x7777777777777777777777777777777777777777";
// two different contracts that both call themselves USDC
const USDC_A = "0x3600000000000000000000000000000000000000";
const USDC_B = "0xaaaa000000000000000000000000000000000001";
const ARGUS = "0xece5ca8bf9220718e5727754026757512212cb3c";
const H = (n) => "0x" + String(n).padStart(2, "0").repeat(32);
const T = (d, h = 12) => Date.UTC(2026, 8, d, h);
const key = (id, w = W1) => `5042:${POSM}:${id}:${w}`;
const TOTAL = {
  ok: true, at: T(17, 9),
  scope: { chainId: 5042, positionManager: POSM, wallets: [{ address: W1, label: "Arc LP" }, { address: W2, label: "SEAL wallet" }], status: "all", from: null, to: null },
  label: "Total claimed fees · Arc LP · Open + closed",
  state: "complete", stateLabel: "Verified claimed — complete history", verifiedZero: false,
  tokens: [
    { address: USDC_A, symbol: "USDC", decimals: 6, raw: "85049703", amount: "85.049703" },
    { address: USDC_B, symbol: "USDC", decimals: 6, raw: "2000000", amount: "2.0" },
    { address: ARGUS, symbol: "ARGUS", decimals: 18, raw: "3392295495038757166445", amount: "3,392.295495" },
  ],
  usd: { historical: 123.45, pricedSubtotal: 123.45, pricedRecords: 12, unpricedRecords: 0, excluded: [] },
  current: { usd: 150.5, note: "today's pool prices for the same amounts" },
  subtotals: {
    open: { tokens: [{ address: USDC_A, symbol: "USDC", amount: "80.0" }], usdHistorical: 100.2, pricedSubtotal: 100.2, records: 9, positions: 2 },
    closed: { tokens: [{ address: USDC_A, symbol: "USDC", amount: "5.049703" }], usdHistorical: 20.25, pricedSubtotal: 20.25, records: 2, positions: 2 },
    other: { tokens: [{ address: USDC_B, symbol: "USDC", amount: "2.0" }], usdHistorical: 3.0, pricedSubtotal: 3.0, records: 1, positions: 1 },
  },
  positions: [
    { key: key("8240"), tokenId: "8240", wallet: W1, walletLabel: "Arc LP", status: "open", pair: "USDC / ARGUS",
      tokens: [{ address: USDC_A, symbol: "USDC", amount: "80.0" }], usdHistorical: 100.2, pricedSubtotal: 100.2, records: 9, lastT: T(16), state: "complete", reason: null },
    { key: key("9001"), tokenId: "9001", wallet: W1, walletLabel: "Arc LP", status: "closed", pair: "USDC / EURC",
      tokens: [{ address: USDC_A, symbol: "USDC", amount: "5.049703" }], usdHistorical: 20.25, pricedSubtotal: 20.25, records: 2, lastT: T(12), state: "complete", reason: null },
    { key: key("9004", W2), tokenId: "9004", wallet: W2, walletLabel: "SEAL wallet", status: "transferred", pair: "USDC / ARGUS",
      tokens: [{ address: USDC_B, symbol: "USDC", amount: "2.0" }], usdHistorical: null, pricedSubtotal: 3.0, records: 1, lastT: T(11), state: "partial",
      reason: "the scan has not reached this position's opening" },
  ],
  rows: [
    { key: key("8240"), logIndex: 0, tokenId: "8240", wallet: W1, t: T(16), block: 700, tx: H(41), kind: "collect", recipient: W1,
      tokens: [{ address: USDC_A, symbol: "USDC", amount: "40.0" }, { address: ARGUS, symbol: "ARGUS", amount: "1,200.0" }], usd: 60.2, priceSrc: "block", priceT: T(16) },
    { key: key("9001"), logIndex: 3, tokenId: "9001", wallet: W1, t: T(12), block: 650, tx: H(42), kind: "withdrawal", recipient: OTHER,
      tokens: [{ address: USDC_A, symbol: "USDC", amount: "5.049703" }, { address: ARGUS, symbol: "ARGUS", amount: "0.0" }], usd: 20.25, priceSrc: "pricelog", priceT: T(12, 11) },
    { key: key("9004", W2), logIndex: 1, tokenId: "9004", wallet: W2, t: T(11), block: 600, tx: H(43), kind: "increase", recipient: W2,
      tokens: [{ address: USDC_B, symbol: "USDC", amount: "2.0" }], usd: null, priceSrc: null, priceT: null },
  ],
  coverage: {
    positionsTotal: 5, positionsComplete: 3,
    partial: [{ key: key("9004", W2), tokenId: "9004", state: "partial", reason: "the scan has not reached this position's opening" }],
    unsupported: [{ key: key("7001"), tokenId: "7001", reason: "one leg is the chain's native asset, which the scanner cannot attribute" },
      { key: key("7002"), tokenId: "7002", reason: "a v3 position: this scanner reads v4 only" }],
    discovery: [{ wallet: W1, complete: true, scannedFrom: 1, error: null }, { wallet: W2, complete: false, scannedFrom: 5000, error: "rpc 429" }],
    note: "Fees only; withdrawn principal and added deposits are excluded from every figure here.",
  },
};
const withUsd = (over) => ({ ...TOTAL, ...over, usd: { ...TOTAL.usd, ...(over.usd || {}) } });

async function main() {
  const { api } = page();

  // ---- the control is a read-only history button ------------------------------------
  {
    assert.match(html, /<button type="button" class="ctotbtn" id="ctotbtn" aria-expanded="false" aria-controls="ctotalpanel"[\s\S]*?title="Read-only history — no transaction"/);
    assert.match(html, /<section class="ctpanel" id="ctotalpanel"[^>]*aria-labelledby="ctotaltitle"[^>]*hidden>/);
    assert.match(html, /<h3 id="ctotaltitle">Total claimed fees<\/h3>/);
    const b = api.ctotalButtonHtml(TOTAL.label, api.ctotalHeadline(TOTAL), null);
    assert.match(strip(b), /Total claimed fees · Arc LP · Open \+ closed \$123\.45 Verified claimed — complete history Read-only history — no transaction/);
    assert.ok(!/claim now|collect|withdraw/i.test(strip(b)), "nothing on the control suggests it moves money");
    assert.match(strip(api.ctotalButtonHtml("x", api.ctotalHeadline(TOTAL), "rpc down")), /stale: latest refresh failed/);
  }

  // ---- the headline, state by state --------------------------------------------------
  {
    const H0 = (d) => api.ctotalHeadline(d);
    assert.deepStrictEqual(H0(TOTAL), { fig: "$123.45", sub: "Verified claimed — complete history", cls: "" });
    // complete, but not every record has a historical price: a named subtotal, never a total
    const sub = withUsd({ usd: { historical: null, pricedSubtotal: 80.5, pricedRecords: 10, unpricedRecords: 2 } });
    assert.deepStrictEqual(H0(sub), { fig: "Priced subtotal $80.50", sub: "Complete history · 2 records without a historical price excluded", cls: "partial" });
    // partial history: a floor, said so
    const part = withUsd({ state: "partial", stateLabel: "Verified claimed so far — partial history" });
    assert.deepStrictEqual(H0(part), { fig: "at least $123.45", sub: "Verified claimed so far — partial history", cls: "partial" });
    const partNoUsd = withUsd({ state: "partial", usd: { historical: null, pricedSubtotal: 0, pricedRecords: 0, unpricedRecords: 4 } });
    assert.strictEqual(H0(partNoUsd).fig, "Verified claimed so far");
    // a verified zero, and an empty answer that is not one
    const zero = withUsd({ state: "empty", stateLabel: "No verified settlements", verifiedZero: true, tokens: [], usd: { historical: 0, pricedSubtotal: 0, pricedRecords: 0, unpricedRecords: 0 } });
    assert.deepStrictEqual(H0(zero), { fig: "$0.00", sub: "Verified zero — complete history, nothing settled", cls: "zero" });
    const empty = { ...zero, verifiedZero: false };
    assert.strictEqual(H0(empty).fig, "No verified settlements");
    assert.ok(!/\$0/.test(H0(empty).fig + H0(empty).sub), "an empty answer is never drawn as $0.00");
    assert.match(H0(empty).sub, /not a zero/);
    // complete with a zero total the server did not verify: no zero either
    const unverifiedZero = withUsd({ verifiedZero: false, tokens: [{ address: USDC_A, symbol: "USDC", amount: "0.0000004" }], usd: { historical: 0, pricedSubtotal: 0, pricedRecords: 1, unpricedRecords: 0 } });
    assert.strictEqual(unverifiedZero.usd.historical, 0);
    assert.ok(!/^\$0\.00$/.test(H0(unverifiedZero).fig), "a $0 the server did not confirm is not shown as a verified zero");
    assert.match(H0(unverifiedZero).sub, /did not confirm a zero/);
    // unavailable, and nothing loaded yet
    assert.deepStrictEqual(H0({ state: "unavailable", stateLabel: "the claim store could not be read" }),
      { fig: "Unavailable", sub: "the claim store could not be read", cls: "unavail" });
    assert.strictEqual(H0(null).fig, "Loading…");
    // complete, nothing priced at all: the token amounts, no invented dollars
    const noPrice = withUsd({ usd: { historical: null, pricedSubtotal: 0, pricedRecords: 0, unpricedRecords: 3 } });
    assert.match(H0(noPrice).fig, /^85\.049703 USDC \(0x3600…0000\) \+ 2\.0 USDC \(0xaaaa…0001\) \+ 3,392\.295495 ARGUS$/);
    assert.match(H0(noPrice).sub, /no historical price/);
  }

  // ---- the panel --------------------------------------------------------------------
  {
    const p = api.ctotalPanelHtml(TOTAL, false);
    const t = strip(noTitles(p));
    assert.match(t, /Verified claimed — complete history · read Sep 17/);
    // historical and today's, apart and labelled
    assert.match(t, /Historical value \$123\.45 each settlement at its own verified price/);
    assert.match(t, /At today’s prices \$150\.50 A separate figure: today’s value of the same verified tokens\. Not a historical value and never added to it\. today's pool prices for the same amounts\./);
    assert.ok(!/\$273\.95/.test(t), "the two figures are never summed");
    // tokens grouped by address: one symbol, two contracts, two rows
    const tokRows = p.slice(p.indexOf("Tokens claimed")).split("<tr>").slice(2, 5).map(strip);
    assert.strictEqual(tokRows.length, 3);
    assert.match(tokRows[0], /USDC 0x3600…0000 85\.049703/);
    assert.match(tokRows[1], /USDC 0xaaaa…0001 2\.0/);
    assert.match(tokRows[2], /ARGUS 0xece5…cb3c 3,392\.295495/);
    assert.match(p, /Grouped by token contract, not by symbol/);
    assert.match(p, /href="https:\/\/explorer\.example\/token\/0xaaaa000000000000000000000000000000000001"/);
    // subtotals
    assert.match(t, /Open \$100\.20 2 positions · 9 records/);
    assert.match(t, /Closed \$20\.25 2 positions · 2 records/);
    assert.match(t, /Burned, transferred or unavailable \$3\.00 1 position · 1 record/);
    assert.match(strip(api.ctotalPanelHtml({ ...TOTAL, subtotals: { open: TOTAL.subtotals.open } }, false)), /Closed not in this answer/);
    // an empty bucket has no figure: a $0.00 there would read as a verified zero
    const emptyBucket = strip(api.ctotalPanelHtml({ ...TOTAL, subtotals: { ...TOTAL.subtotals, other: { tokens: [], usdHistorical: 0, pricedSubtotal: 0, records: 0, positions: 0 } },
      positions: [{ ...TOTAL.positions[0], tokens: [], usdHistorical: 0, pricedSubtotal: 0, records: 0, lastT: null }] }, false));
    assert.match(emptyBucket, /Burned, transferred or unavailable no settlements 0 positions · 0 records/);
    assert.match(emptyBucket, /#8240 USDC \/ ARGUS Arc LP Open none no settlements 0 —/);
    assert.ok(!/\$0\.00/.test(emptyBucket), "nothing recorded is never drawn as $0.00");
    // per position
    assert.match(t, /#8240 USDC \/ ARGUS Arc LP Open 80\.0 USDC 0x3600…0000 \$100\.20 9 Sep 16, .* complete history/);
    assert.match(t, /#9004 USDC \/ ARGUS SEAL wallet Transferred .* Priced subtotal \$3\.00 1 Sep 11, .* partial history — the scan has not reached this position's opening\./);
    assert.ok(!/#9004[^#]*Closed/.test(t), "a transferred position is not called closed here either");
    // one wallet in scope: no wallet column
    assert.ok(!/<th scope="col">Wallet<\/th>/.test(api.ctotalPanelHtml(TOTAL, true)));
    assert.match(api.ctotalPanelHtml(TOTAL, false), /<th scope="col">Wallet<\/th>/);
    // rows: recipient, both amounts, valuation basis, tx link, own scroll container
    const rows = p.slice(p.indexOf("Collections")).split("<tr>").slice(2).map(strip);
    assert.match(rows[0], /Sep 16, .* #8240 USDC \/ ARGUS Arc LP collect 0xb1cd…2af5 40\.0 USDC 1,200\.0 ARGUS \$60\.20 transaction price · Sep 16/);
    assert.match(rows[1], /withdrawal \(principal excluded\) 0x7777…7777 5\.049703 USDC 0\.0 ARGUS \$20\.25 hourly price log · Sep 12/);
    assert.match(rows[2], /add \(fees netted\) .* 2\.0 USDC no USD value no historical price/);
    assert.ok(!/≈\$/.test(rows[2]), "a row with no historical price is not valued at today's price");
    assert.match(p, /href="https:\/\/explorer\.example\/tx\/0x(41){32}"/);
    assert.match(p, /<div class="ctscroll" role="region" aria-label="Collection rows, scrolls sideways" tabindex="0"><table class="chtable ctrows">/);
    assert.match(p, /Fees only — withdrawn principal and added deposits are excluded from every row/);
    // coverage
    assert.match(t, /Coverage 3 of 5 positions have a complete claim history/);
    assert.match(t, /Partial histories — their figures are floors: #9004 \(partial history\) — the scan has not reached this position's opening\./);
    assert.match(t, /Not covered \(unsupported histories, such as native-asset legs, v3 or undecodable payouts\): #7001 — one leg is the chain's native asset.*#7002 — a v3 position/);
    assert.match(t, /Position discovery per wallet: Arc LP — complete, scanned from block 1 SEAL wallet — not complete, scanned from block 5000 — rpc 429\./);
    assert.match(t, /Fees only; withdrawn principal and added deposits are excluded from every figure here\./);
    // the excluded records, when there are any
    const exc = api.ctotalPanelHtml(withUsd({ usd: { historical: null, pricedSubtotal: 80.5, pricedRecords: 10, unpricedRecords: 2,
      excluded: [{ key: key("9001"), tokenId: "9001", reason: "no verified price within three hours of the collection" }] } }), false);
    assert.match(strip(exc), /Priced subtotal \$80\.50 10 records with a verified historical price; 2 excluded — not the full total/);
    assert.match(strip(exc), /1 record left out of the USD figure #9001 — no verified price within three hours of the collection\./);
    // an empty answer says so without a zero
    const emptyPanel = strip(api.ctotalPanelHtml({ ...TOTAL, state: "empty", stateLabel: "No verified settlements", verifiedZero: false, tokens: [], rows: [], positions: [],
      usd: { historical: null, pricedSubtotal: 0, pricedRecords: 0, unpricedRecords: 0, excluded: [] }, current: null }, true));
    assert.match(emptyPanel, /No verified token amounts in this scope\. That is not a zero\./);
    assert.match(emptyPanel, /No verified collections in this selection\./);
    assert.match(emptyPanel, /At today’s prices — No value at today’s prices in this answer\./);
    // a verified zero is allowed to say zero
    assert.match(strip(api.ctotalPanelHtml({ ...TOTAL, verifiedZero: true, tokens: [], rows: [], positions: [], current: null,
      usd: { historical: 0, pricedSubtotal: 0, pricedRecords: 0, unpricedRecords: 0, excluded: [] } }, true)),
      /Historical value \$0\.00 verified zero: every relevant position has a complete history and nothing was settled/);
  }

  // ---- the shapes the server really sends ---------------------------------------------
  {
    // amounts as numbers, and rows keyed by their own log rather than by position
    const live = { ...TOTAL,
      tokens: [{ address: ARGUS, symbol: "ARGUS", decimals: 18, raw: "13581534522957175017455", amount: 13581.534522957176 },
        { address: USDC_A, symbol: "USDC", decimals: 6, raw: "18681", amount: 0.018681 }],
      positions: [{ key: key("8240"), tokenId: "8240", wallet: W1, walletLabel: "Arc LP", status: "open", pair: "USDC / ARGUS",
        tokens: [{ address: ARGUS, symbol: "ARGUS", amount: 812.1118766283165 }], usdHistorical: 27.64, pricedSubtotal: 27.64, records: 1, lastT: T(16), state: "complete", reason: null }],
      rows: [{ key: `${H(41)}:30`, logIndex: 30, tokenId: "8240", wallet: W1, walletLabel: "Arc LP", status: "open", t: T(16), block: 21353562, tx: H(41), kind: "collect", recipient: W1,
        tokens: [{ address: USDC_A, symbol: "USDC", raw: "14195789", amount: 14.195789 }, { address: ARGUS, symbol: "ARGUS", raw: "812111876628316516541", amount: 812.1118766283165 }],
        usd: 27.643164999, priceSrc: "block", priceT: T(16) }],
      coverage: { ...TOTAL.coverage, discovery: [{ wallet: W1, label: "Arc LP", complete: false, scannedFrom: 2533871, error: null }] } };
    const t = strip(noTitles(api.ctotalPanelHtml(live, false)));
    assert.match(t, /ARGUS 0xece5…cb3c 13,581\.534523/, "a numeric amount is formatted, with its small digits kept");
    assert.match(t, /USDC 0x3600…0000 0\.018681/);
    assert.match(t, /#8240 USDC \/ ARGUS Arc LP collect .* 14\.195789 USDC 812\.111877 ARGUS \$27\.64 transaction price/,
      "a row finds its position by token id and wallet, not by the row's own log key");
    assert.match(t, /Arc LP — not complete, scanned from block 2533871/);
    // the same wallet labelled only in the coverage list
    assert.match(strip(api.ctotalPanelHtml({ ...live, scope: { ...live.scope, wallets: [] } }, false)), /Arc LP — not complete/);
  }

  // ---- the query the filters build ---------------------------------------------------
  {
    assert.strictEqual(api.ctotalQuery({ wallet: "all", status: "all" }), "wallet=all&status=all");
    assert.strictEqual(api.ctotalQuery({ wallet: W1, status: "closed" }), `wallet=${W1}&status=closed`);
    assert.strictEqual(api.ctotalQuery({ wallet: W1, status: "made-up" }), `wallet=${W1}&status=all`, "an unknown status falls back to everything");
    assert.strictEqual(api.ctotalQuery({}), "wallet=all&status=all");
    const q = new URLSearchParams(api.ctotalQuery({ wallet: "all", status: "other", from: "2026-09-01", to: "2026-09-15" }));
    assert.strictEqual(q.get("status"), "other");
    assert.strictEqual(Number(q.get("from")), new Date(2026, 8, 1).getTime(), "whole local days");
    assert.strictEqual(Number(q.get("to")), new Date(2026, 8, 15, 23, 59, 59, 999).getTime(), "the end date is included");
    assert.ok(!new URLSearchParams(api.ctotalQuery({ wallet: "all", status: "all", from: "not-a-date" })).has("from"));
    assert.strictEqual(api.ctDay("2026-13-99", false), null);
  }

  // ---- loading: default scope, the panel's own filters, stale state -------------------
  {
    const { api: a, els, h } = page();
    // the headline covers every position of the wallet scope, whatever the list filter is
    h.answers.push({ status: 200, body: TOTAL });
    await a.loadClaimTotal("head");
    assert.strictEqual(h.urls[0], "/api/claims/total?wallet=all&status=all");
    assert.match(strip(els["#ctotbtn"].innerHTML), /Total claimed fees · Arc LP · Open \+ closed \$123\.45/);
    assert.match(els["#ctotbtn"].title, /Read-only history — no transaction/);
    assert.deepStrictEqual(h.oks, ["Total claimed fees"]);

    // the panel: same scope, then narrowed by its own filters
    h.answers.push({ status: 200, body: TOTAL });
    await a.loadClaimTotal("panel");
    assert.strictEqual(h.urls[1], "/api/claims/total?wallet=all&status=all");
    assert.match(strip(els["#ctbody"].innerHTML), /Historical value \$123\.45/);
    assert.strictEqual(els["#ctwalletwrap"].hidden, false, "the wallet filter is offered when the scope is every wallet");
    assert.match(els["#ctwallet"].innerHTML, /<option value="0x0556f2f94efd53f2d3f8281dd3b88d6341e4b659">SEAL wallet \(0x0556…b659\)<\/option>/);

    els["#ctwallet"].value = W2;
    els["#ctstatus"].value = "closed";
    els["#ctfrom"].value = "2026-09-01";
    els["#ctto"].value = "2026-09-15";
    a.readCtFilters();
    h.answers.push({ status: 200, body: { ...TOTAL, label: "Total claimed fees · SEAL wallet · Closed" } });
    await a.loadClaimTotal("panel");
    const q = new URLSearchParams(h.urls[2].split("?")[1]);
    assert.strictEqual(q.get("wallet"), W2);
    assert.strictEqual(q.get("status"), "closed");
    assert.ok(q.has("from") && q.has("to"));

    // the button's own figure is unaffected by the panel's filters
    h.answers.push({ status: 200, body: TOTAL });
    await a.loadClaimTotal("head");
    assert.strictEqual(h.urls[3], "/api/claims/total?wallet=all&status=all");

    // a failed refresh keeps the last good panel and says it is stale
    for (const bad of [
      { status: 200, body: { ok: false, error: "claim store unreadable" } },
      { status: 500, body: { ok: false, error: "internal error" } },
      new TypeError("Failed to fetch"),
    ]) {
      h.answers.push(bad);
      await a.loadClaimTotal("panel");
      const body = els["#ctbody"].innerHTML;
      assert.match(strip(body), /Showing the last successful refresh from .*The latest refresh failed/);
      assert.match(strip(body), /Historical value \$123\.45/, "the last good answer stays on screen");
    }
    // and the button keeps its figure, marked stale
    h.answers.push({ status: 200, body: { ok: false, error: "claim store unreadable" } });
    await a.loadClaimTotal("head");
    assert.match(strip(els["#ctotbtn"].innerHTML), /\$123\.45.*stale: latest refresh failed/);
    assert.match(els["#ctotbtn"].title, /latest failed: claim store unreadable/);
    assert.match(h.fails.at(-1), /^Total claimed fees: claim store unreadable$/);
  }

  // ---- before the endpoint exists: not available, not a zero -------------------------
  {
    const { api: a, els, h } = page();
    h.answers.push({ status: 404, body: new SyntaxError("Unexpected token N") });
    await a.loadClaimTotal("head");
    assert.match(strip(els["#ctotbtn"].innerHTML), /Not available yet This server does not offer the total yet/);
    assert.deepStrictEqual(h.fails, [], "a route that is not there yet is not a failed refresh");
    h.answers.push({ status: 404, body: new SyntaxError("Unexpected token N") });
    await a.loadClaimTotal("panel");
    assert.match(strip(els["#ctbody"].innerHTML), /not available from this server yet \(HTTP 404\)\. This is a failed read, not a zero\./);
    // still building
    assert.match(strip(a.ctotalBodyHtml(null, { kind: "pending" }, false, true)), /still building the claim history/);
    assert.match(strip(a.ctotalBodyHtml(null, null, true, true)), /Loading total claimed fees/);
    assert.match(strip(a.ctotalBodyHtml({ d: TOTAL, at: T(17, 8) }, null, true, true)), /Refreshing….*Historical value \$123\.45/);
    // no scope yet: no request
    h.scope = null;
    const n = h.urls.length;
    await a.loadClaimTotal("head");
    assert.strictEqual(h.urls.length, n);
  }

  // ---- the scope label when the server sends none ------------------------------------
  {
    const { api: a, els, h } = page();
    h.scope = W2;
    h.answers.push({ status: 200, body: { ...TOTAL, label: undefined } });
    await a.loadClaimTotal("head");
    assert.match(strip(els["#ctotbtn"].innerHTML), /Total claimed fees · SEAL wallet · Open \+ closed/);
    const { api: a2, els: e2, h: h2 } = page();
    h2.scope = "0xb1cdc09b4c7f28365a8e7bfa2332af54f5462af5";
    h2.answers.push({ status: 200, body: { ...TOTAL, label: null } });
    await a2.loadClaimTotal("head");
    assert.match(strip(e2["#ctotbtn"].innerHTML), /Total claimed fees · Arc LP · Open \+ closed/);
  }

  // ---- income for taxes, read from chain: by month, by wallet, never merged -------
{
  const { api, els } = page();
  const sep = Date.UTC(2026, 8, 16, 5, 0), oct = Date.UTC(2026, 9, 2, 5, 0);
  api.renderChainTax({ stateLabel: "Verified claimed — complete history", rows: [
    { t: sep, usd: 143.12, wallet: W1, walletLabel: "Arc LP" },
    { t: sep + 3600e3, usd: 0.008, wallet: W2, walletLabel: "SEAL wallet" },
    { t: oct, usd: 12.5, wallet: W1, walletLabel: "Arc LP" },
    { t: oct, usd: null, wallet: W1, walletLabel: "Arc LP" },
  ] });
  const t = strip(els["#chaintax"].innerHTML);
  assert.match(t, /September 2026 2 \$143\.13/, `two September settlements, summed: ${t}`);
  assert.match(t, /Arc LP \$143\.12 · SEAL wallet \$0\.01/, "split by wallet");
  assert.match(t, /October 2026 2 \$12\.50 1 unpriced/, "an unpriced settlement is counted and named, not valued");
  assert.match(t, /each settlement at its own transaction price/);
  assert.match(t, /Withdrawn principal is not income/);
  assert.strictEqual(els["#chaintaxtotal"].textContent, "$155.63");
  // nothing loaded, or nothing found: never a zero that looks like income
  const p2 = page();
  p2.api.renderChainTax(null);
  assert.match(strip(p2.els["#chaintax"].innerHTML), /not loaded/);
  assert.strictEqual(p2.els["#chaintaxtotal"].textContent, "");
  const p3 = page();
  p3.api.renderChainTax({ stateLabel: "x", rows: [] });
  assert.match(strip(p3.els["#chaintax"].innerHTML), /No verified settlements/);
  assert.strictEqual(p3.els["#chaintaxtotal"].textContent, "none");
}

console.log("claims total UI: chain-derived tax rows, read-only button and scope label, a headline per state, tokens by address, historical and today kept apart, subtotals, per-position and collection rows, filter queries, coverage lists, stale panel kept");
}
main().catch((e) => { console.error(e); process.exit(1); });
