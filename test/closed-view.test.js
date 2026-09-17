// node test/closed-view.test.js — the Open · Closed · All position filter and the
// cards for positions that are no longer open: counts per status, a transferred
// position never called closed, dates only when recorded (and "not verified" when
// the server could not verify them), the unsettled-fee sentence, claim states on
// closed cards, no principal or return figure, the wallet on the history request,
// and a failed refresh that keeps the last good list.
//
// dashboard.js is browser code. Functions are lifted out of the source together
// with every top-level function or const they use, the way
// test/claims-pipeline.test.js does it; the page state is stubbed.
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
  return /\}\s*$/.test(first) ? "\n" + first + "\n" : src.slice(f, src.indexOf("\n}\n", f) + 3);   // a one-line function
}
// roots plus everything they reference, minus the names the harness provides
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

// Names the harness supplies instead of lifting: page plumbing, and a few
// generic words (`panel`, `load`, `render`, …) that are local variables in the
// lifted bodies but also top-level names elsewhere in dashboard.js.
const PROVIDED = ["$", "pref", "setPref", "loadOk", "loadFailed", "histScope", "shortA",
  "panel", "load", "render", "tick", "price", "amount", "clock", "linkify"];
function page() {
  const el = (x = {}) => ({ hidden: false, innerHTML: "", className: "", textContent: "", ...x });
  const els = { "#posfilter": el({ contains: () => false, querySelector: () => null }), "#histsec": el({ hidden: true }), "#histstale": el({ hidden: true }), "#histlist": el() };
  const prefs = new Map();
  const classes = new Set();
  const h = { answers: [], urls: [], oks: [], fails: [], scope: "all" };
  const document = {
    activeElement: null,
    body: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
    querySelector: () => null,
  };
  const fetch = async (url) => {
    h.urls.push(url);
    const a = h.answers.shift();
    if (a instanceof Error) throw a;
    return { status: a.status, json: async () => { if (a.body instanceof Error) throw a.body; return a.body; } };
  };
  const body = `
    let EXPLORER = 'https://explorer.example', CHAIN = { id: 5042, name: null };
    const shortA = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '—';
    const amount = (n) => String(n), price = (n) => String(n), linkify = (s) => esc(s);
    ${lifted(["histListHtml", "closedCard", "posFilterHtml", "posFilterCounts", "posFilterStep", "histWallet", "unsettledText",
      "histDateLine", "loadPosHistory", "renderPosHistory", "setPosFilter", "refreshClaimPanel", "claimedMetric"], PROVIDED)}
    return { histListHtml, closedCard, posFilterHtml, posFilterCounts, posFilterStep, histWallet, unsettledText, histDateLine,
      loadPosHistory, renderPosHistory, setPosFilter, refreshClaimPanel, HIST };`;
  const api = new Function("document", "fetch", "$", "pref", "setPref", "loadOk", "loadFailed", "histScope", body)(
    document, fetch, (s) => els[s] || null,
    (k) => (prefs.has(k) ? prefs.get(k) : null), (k, v) => prefs.set(k, v),
    (s) => h.oks.push(s), (s, e) => h.fails.push(`${s}: ${e.message}`), () => h.scope);
  return { api, els, h, prefs, classes };
}

const strip = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const noTitles = (s) => String(s).replace(/ title="[^"]*"/g, "");

// ---- fixtures, shaped like GET /api/positions/history ------------------------------
const POSM = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b";
const W1 = "0xB1cdC09B4C7F28365a8E7BFA2332aF54f5462aF5";
const W2 = "0x0556f2f94efd53f2d3f8281dd3b88d6341e4b659";
const NEW_OWNER = "0x7777777777777777777777777777777777777777";
const USDC = "0x3600000000000000000000000000000000000000";
const ARGUS = "0xece5ca8bf9220718e5727754026757512212cb3c";
const H = (n) => "0x" + String(n).padStart(2, "0").repeat(32);
const T = (d, h = 12) => Date.UTC(2026, 8, d, h);
const cov = (over) => ({ fromBlock: 100, toBlock: 900, fromT: T(1), toT: T(17), openedBlock: 120, openedT: T(1, 13), coversOpening: true, reachedLookbackFloor: false, ...over });
const tokens = [{ symbol: "USDC", amount: "12.5" }, { symbol: "ARGUS", amount: "300" }];
const CLAIM = {
  complete: { state: "complete", status: "ok", verifiedZero: false, count: 4, last: T(10), tokens, raw0: "12500000", raw1: "300000000000000000000",
    usd: 12.34, usdPricedSubtotal: 12.34, pricedRecords: 4, unpricedRecords: 0, usdCurrent: { usd: 13.1, note: "today's pool prices" },
    usdBasis: "at-claim", priceSources: { block: 4, pricelog: 0, today: 0, none: 0 }, coverage: cov({}) },
  subtotal: { state: "complete", status: "ok", verifiedZero: false, count: 3, last: T(11), tokens, usd: null, usdPricedSubtotal: 5.5,
    pricedRecords: 2, unpricedRecords: 1, usdCurrent: { usd: 9.99, note: null }, priceSources: { block: 2, pricelog: 0, today: 0, none: 1 }, coverage: cov({}) },
  partial: { state: "scanning", status: "partial", verifiedZero: false, count: 2, tokens, usd: 3.25, pricedRecords: 2, unpricedRecords: 0, usdPricedSubtotal: 3.25,
    priceSources: { block: 2, pricelog: 0, today: 0, none: 0 }, reason: "the scan has not yet reached the block this position was opened in",
    coverage: cov({ coversOpening: false, openedBlock: null, openedT: null }) },
  undecodable: { state: "undecodable", status: "unavailable", verifiedZero: false, coverage: cov({}),
    reason: "a payout in this position's history could not be attributed to it; a total would be a guess" },
  unsupported: { state: "unsupported", status: "unavailable", verifiedZero: false, reason: "one leg is the chain's native asset, which the claim scanner does not read" },
  zero: { state: "complete", status: "ok", verifiedZero: true, count: 0, tokens: [], usd: 0, pricedRecords: 0, unpricedRecords: 0, usdPricedSubtotal: 0,
    priceSources: { block: 0, pricelog: 0, today: 0, none: 0 }, coverage: cov({}) },
};
const pos = (over) => ({
  key: `5042:${POSM}:${over.tokenId}:${(over.wallet || W1).toLowerCase()}`,
  chainId: 5042, positionManager: POSM, protocol: "v4", wallet: W1, walletLabel: "Arc LP", pair: "USDC / ARGUS",
  token0: { address: USDC, symbol: "USDC", decimals: 6 }, token1: { address: ARGUS, symbol: "ARGUS", decimals: 18 },
  fee: 500, tickLower: -887220, tickUpper: 887220, hooks: "0x0000000000000000000000000000000000000000",
  status: "open", statusReason: "liquidity is above zero and the wallet owns the NFT", liquidity: "1000", currentOwner: W1,
  openedAt: { block: 120, t: T(1, 13), tx: H(11) }, closedAt: null, transferredAt: null, burnedAt: null,
  unsettledFees: { state: "unknown", reason: "the position still holds liquidity, so fees keep accruing" },
  claimed: CLAIM.complete, ...over,
});
const P = {
  open: pos({ tokenId: "8240" }),
  closed: pos({ tokenId: "9001", status: "closed", liquidity: "0", statusReason: "liquidity reached zero at block 700 and the wallet still owns the NFT",
    closedAt: { block: 700, t: T(12), tx: H(21), verified: true }, unsettledFees: { state: "none", reason: "v4 settles all fees when liquidity reaches zero" }, claimed: CLAIM.subtotal }),
  unverified: pos({ tokenId: "9002", status: "closed", liquidity: "0", statusReason: "liquidity is zero; the scan has not reached the block where it was removed",
    closedAt: { block: 650, t: T(9), tx: H(22), verified: false }, unsettledFees: { state: "unknown", reason: "history before the closing is not fully scanned" }, claimed: CLAIM.partial }),
  nodate: pos({ tokenId: "9006", status: "closed", liquidity: "0", statusReason: "liquidity is zero; when it was removed has not been found yet",
    closedAt: null, unsettledFees: null, claimed: CLAIM.zero }),
  burned: pos({ tokenId: "9003", status: "burned", liquidity: null, currentOwner: null, statusReason: "the NFT was burned in the transaction at block 800",
    closedAt: { block: 790, t: T(13), tx: H(23), verified: true }, burnedAt: { block: 800, t: T(14), tx: H(24) },
    unsettledFees: { state: "none", reason: "v4 settles all fees when liquidity reaches zero" }, claimed: CLAIM.undecodable }),
  transferred: pos({ tokenId: "9004", status: "transferred", liquidity: "5000", currentOwner: NEW_OWNER,
    statusReason: "the NFT was transferred to another address at block 820; it still holds liquidity for that owner",
    transferredAt: { block: 820, t: T(15), tx: H(25), to: NEW_OWNER },
    unsettledFees: { state: "unknown", reason: "fees now accrue to the new owner" }, claimed: CLAIM.zero }),
  unavailable: pos({ tokenId: "9005", wallet: W2, walletLabel: "SEAL wallet", status: "unavailable", liquidity: null, currentOwner: null, openedAt: null,
    statusReason: "ownerOf reverted and the position could not be read", unsettledFees: { state: "unknown", reason: "the position could not be read" }, claimed: CLAIM.unsupported }),
};
const HISTORY = {
  ok: true, at: T(17, 9), chainId: 5042, positionManager: POSM, pricing: { text: "priced against USDC" },
  scanner: { running: true, idle: true, pending: 0, lag: 0, chunks: 10, lastAt: T(17, 9), lastError: null },
  wallets: [
    { address: W1, label: "Arc LP", discovery: { complete: true, scannedFrom: 1, lastScanned: 900, error: null, known: 6 } },
    { address: W2, label: "SEAL wallet", discovery: { complete: true, scannedFrom: 1, lastScanned: 900, error: null, known: 1 } },
  ],
  counts: { open: 1, closed: 3, burned: 1, transferred: 1, unavailable: 1, all: 7 },
  positions: Object.values(P),
};
const cardOf = (h, tokenId) => {
  const parts = h.split("<article").slice(1).map((x) => "<article" + x.slice(0, x.indexOf("</article>") + 10));
  const hit = parts.find((x) => new RegExp(`data-key="5042:${POSM}:${tokenId}:`).test(x));
  assert.ok(hit, `card #${tokenId} is rendered`);
  return hit;
};

async function main() {
  const { api } = page();

  // ---- filter: counts, markup, keys ------------------------------------------------
  {
    assert.deepStrictEqual(api.posFilterCounts(HISTORY.counts), { open: 1, closed: 6, all: 7 }, "closed = closed + burned + transferred + unavailable");
    assert.deepStrictEqual(api.posFilterCounts({ open: 2, closed: 1 }), { open: 2, closed: 1, all: 3 }, "missing counts are 0, all is derived");
    assert.strictEqual(api.posFilterCounts(null), null);
    const f = api.posFilterHtml("open", api.posFilterCounts(HISTORY.counts));
    assert.strictEqual((f.match(/role="radio"/g) || []).length, 3);
    assert.match(f, /data-pfilter="open" aria-checked="true" tabindex="0" aria-label="Open, 1 position"/);
    assert.match(f, /data-pfilter="closed" aria-checked="false" tabindex="-1" aria-label="Closed, 6 positions"/);
    assert.match(f, /data-pfilter="all" aria-checked="false" tabindex="-1" aria-label="All, 7 positions"/);
    assert.deepStrictEqual(strip(f).trim().split(" "), ["Open", "1", "Closed", "6", "All", "7"]);
    assert.ok(f.split("<button").slice(1).every((b) => /type="button"/.test(b)), "real buttons: Enter and Space work");
    const none = api.posFilterHtml("closed", null);
    assert.match(none, /data-pfilter="closed" aria-checked="true" tabindex="0"/);
    assert.match(none, /count not available yet/);
    assert.ok(!/class="pfn"/.test(none), "no number is shown before the counts arrive");
    assert.match(html, /id="posfilter"[^>]*role="radiogroup"[^>]*aria-label="[^"]+"/, "the filter is a labelled radio group");
    // arrow keys wrap, Home/End jump, other keys do nothing
    assert.strictEqual(api.posFilterStep("open", "ArrowRight"), "closed");
    assert.strictEqual(api.posFilterStep("all", "ArrowRight"), "open");
    assert.strictEqual(api.posFilterStep("open", "ArrowLeft"), "all");
    assert.strictEqual(api.posFilterStep("closed", "ArrowUp"), "open");
    assert.strictEqual(api.posFilterStep("closed", "ArrowDown"), "all");
    assert.strictEqual(api.posFilterStep("all", "Home"), "open");
    assert.strictEqual(api.posFilterStep("open", "End"), "all");
    assert.strictEqual(api.posFilterStep("open", "Enter"), null);
    assert.strictEqual(api.posFilterStep("bogus", "ArrowRight"), null);
    // the wallet parameter follows the page's scope
    assert.strictEqual(api.histWallet("all", W1), "all");
    assert.strictEqual(api.histWallet("owner", W1), W1.toLowerCase());
    assert.strictEqual(api.histWallet("owner", undefined), null, "the main wallet is not known yet");
    assert.strictEqual(api.histWallet(W2, W1), W2);
    assert.strictEqual(api.histWallet("junk", W1), null);
  }

  // ---- classification ----------------------------------------------------------------
  {
    assert.strictEqual(api.histListHtml(HISTORY, "open"), "", "Open adds nothing: the page's own open cards stay as they were");
    const closed = api.histListHtml(HISTORY, "closed");
    assert.deepStrictEqual([...closed.matchAll(/<h3 class="histgh"[^>]*>([^<]+)<span class="pfn">(\d+)<\/span>/g)].map((m) => [m[1].trim(), m[2]]),
      [["Closed", "3"], ["Burned", "1"], ["Transferred", "1"], ["Unavailable", "1"]], "grouped by status, each under its own name");
    assert.ok(!/data-key="5042:[^"]*:8240:/.test(closed), "an open position is not listed under Closed");
    assert.strictEqual((closed.match(/<article/g) || []).length, 6);
    assert.strictEqual(api.histListHtml(HISTORY, "all"), closed, "All adds the same no-longer-open cards below the open ones");
    // newest first inside a group
    const order = [...closed.matchAll(/data-key="5042:[^:]+:(\d+):/g)].map((m) => m[1]);
    assert.deepStrictEqual(order.slice(0, 3), ["9001", "9002", "9006"]);
    // an unknown status is not guessed at
    const odd = api.histListHtml({ ...HISTORY, positions: [pos({ tokenId: "1", status: "weird" })] }, "closed");
    assert.match(odd, /Unavailable <span class="pfn">1/);
    // nothing to list, with and without complete discovery
    const empty = { ...HISTORY, positions: [P.open] };
    assert.match(strip(api.histListHtml(empty, "closed")), /No closed, burned, transferred or unreadable positions for this wallet scope/);
    const partialDisc = { ...empty, wallets: [{ address: W1, label: "Arc LP", discovery: { complete: false, scannedFrom: 500, error: "rpc 429", known: 1 } }] };
    const pd = strip(api.histListHtml(partialDisc, "closed"));
    assert.match(pd, /Position discovery is not complete for Arc LP: rpc 429/);
    assert.match(pd, /not a verified none/);
    // a scan still running is said
    assert.match(strip(api.histListHtml({ ...HISTORY, scanner: { ...HISTORY.scanner, idle: false, pending: 3 } }, "closed")), /history scan is still running \(3 pending\)/);
  }

  // ---- cards: labels, dates, unsettled fees --------------------------------------------
  const list = api.histListHtml(HISTORY, "closed");
  {
    const tr = cardOf(list, "9004");
    assert.match(tr, /<span class="state hstate hs-transferred">Transferred<\/span>/);
    assert.ok(!/\bclosed\b/i.test(strip(noTitles(tr))), `a transferred position is never called closed: ${strip(noTitles(tr))}`);
    assert.match(strip(tr), /Transferred Sep 15, 2026 to 0x7777…7777/);
    assert.match(strip(tr), /Current owner 0x7777…7777/);
    assert.match(strip(tr), /still holds liquidity for that owner/);
    assert.match(strip(tr), /cover only what was settled while this wallet owned the position/);

    const cl = cardOf(list, "9001");
    assert.match(cl, /hs-closed">Closed<\/span>/);
    assert.match(strip(cl), /Closed Sep 12, 2026 · 0x21212121…/);
    assert.ok(!/not verified/.test(cl), "a verified closing has no warning");
    assert.match(cl, /href="https:\/\/explorer\.example\/tx\/0x(21){32}"/, "the closing transaction links to the explorer");
    assert.match(strip(cl), /Unsettled fees None v4 settles all fees when liquidity reaches zero\./);
    assert.match(strip(cl), /Chain Arc \(5042\)/);
    assert.match(strip(cl), /Wallet Arc LP 0xb1cd…2af5/);
    assert.match(strip(cl), /Protocol Uniswap v4/);
    assert.match(strip(cl), /Position manager 0x6049…f82b/);
    assert.match(cl, /href="https:\/\/explorer\.example\/address\/0x6049c9a0e26405c0985f9e3685c87d0ae917f82b"/);
    assert.match(strip(cl), /Token ID 9001/);
    assert.match(cl, /href="https:\/\/explorer\.example\/token\/0x6049[0-9a-f]+\/instance\/9001"/);
    assert.match(strip(cl), /0\.05%/);
    assert.match(strip(cl), /Evidence liquidity reached zero at block 700/);

    const un = cardOf(list, "9002");
    assert.match(strip(un), /Closed Sep 9, 2026 — not verified: history before it is not fully scanned/);
    assert.match(strip(un), /Unsettled fees Unknown history before the closing is not fully scanned\./);

    const nd = cardOf(list, "9006");
    assert.ok(!/Closed (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d/.test(strip(nd)), "no closing date when none was recorded");
    assert.ok(!/not verified/.test(nd));
    assert.match(strip(nd), /Status Closed liquidity is zero; when it was removed has not been found yet\./, "the reason stands in for the date");
    assert.match(strip(nd), /Unsettled fees Not reported/);

    const bu = cardOf(list, "9003");
    assert.match(bu, /hs-burned">Burned<\/span>/);
    assert.match(strip(bu), /Liquidity reached zero Sep 13, 2026 .*Burned Sep 14, 2026/);

    const na = cardOf(list, "9005");
    assert.match(na, /hs-unavailable">Unavailable<\/span>/);
    assert.match(strip(na), /ownerOf reverted and the position could not be read/);
    assert.match(strip(na), /Wallet SEAL wallet 0x0556…b659/);
    assert.match(strip(na), /Opened not recorded/);

    // the unsettled-fee sentence on its own
    assert.deepStrictEqual(api.unsettledText({ state: "none", reason: "v4 settles all fees when liquidity reaches zero" }),
      { label: "None", cls: "zero", text: "v4 settles all fees when liquidity reaches zero." });
    assert.strictEqual(api.unsettledText({ state: "unknown", reason: "x" }).label, "Unknown");
    assert.strictEqual(api.unsettledText({ state: "unknown" }).text, "Whether any fees are left unsettled cannot be established.");
    assert.strictEqual(api.unsettledText(undefined).label, "Not reported");
    // a date given only as a block
    assert.match(strip(api.histDateLine({ status: "closed", closedAt: { block: 42, t: null, tx: null, verified: true } })), /^ ?Closed at block 42 ?$/);
    assert.strictEqual(api.histDateLine({ status: "closed", closedAt: { block: null, t: null, verified: false } }), "", "nothing recorded, nothing said");
  }

  // ---- claim states on closed cards ----------------------------------------------------
  {
    const face = (id) => strip(noTitles(cardOf(list, id).match(/<button type="button" class="metric claimed[\s\S]*?<\/button>/)[0]));
    // complete with a priced subtotal: the subtotal, the excluded count, today's value apart
    assert.match(face("9001"), /Claimed fees Priced subtotal \$5\.50 3 claims · last Sep 11, .* · complete history · 1 without a historical price excluded · \$9\.99 at today’s prices \(separate\)/);
    assert.ok(!/\$15\.49/.test(cardOf(list, "9001")), "today's value is never added to the historical subtotal");
    // partial
    assert.match(face("9002"), /at least \$3\.25/);
    assert.match(face("9002"), /scan in progress/);
    assert.ok(!/complete history/.test(face("9002")));
    // undecodable and unsupported: no figure, never a zero
    assert.match(face("9003"), /No figure/);
    assert.ok(!/\$/.test(face("9003")));
    assert.match(face("9005"), /Not supported .*native asset/);
    assert.ok(!/\$/.test(face("9005")));
    // verified zero only where the server verified it
    assert.match(face("9004"), /\$0\.00 none claimed · complete history, verified/);
    // complete with a full historical total
    const full = api.closedCard(pos({ tokenId: "9100", status: "closed", claimed: CLAIM.complete }), HISTORY);
    assert.match(strip(noTitles(full)), /Claimed fees \$12\.34 4 claims .*complete history · valued at each claim’s transaction price · \$13\.10 at today’s prices \(separate\)/);
    assert.match(full, /title="[^"]*Separately, the same token amounts are worth \$13\.10 at today’s prices \(today&#39;s pool prices\); that is not what they were worth when claimed/);
    // the coverage footer says what the history covers
    assert.match(strip(cardOf(list, "9002")), /Claim history: scan in progress/);
    // no claim summary at all
    const bare = api.closedCard(pos({ tokenId: "9101", status: "closed", claimed: null }), HISTORY);
    assert.match(strip(noTitles(bare)), /Not scanned yet/);
    assert.match(bare, /data-chainid="5042" data-manager="0x6049c9a0e26405c0985f9e3685c87d0ae917f82b"/, "the history request is scoped even without a summary");
  }

  // ---- no principal, no return, no live value ------------------------------------------
  {
    const text = strip(noTitles(list));
    assert.ok(!/Position value|Net return|Fee APR|PnL|ROI|profit|principal returned|Uncollected fees/i.test(text), `no value or return figures on closed cards: ${text.match(/Position value|Net return|Fee APR|PnL|ROI|profit|principal returned|Uncollected fees/i)}`);
    assert.ok(!/class="rail/.test(list), "no range rail");
    assert.strictEqual((text.match(/withdrawn principal is never counted as earnings, and no return is given/g) || []).length, 6);
  }

  // ---- the collection history request names the wallet ---------------------------------
  {
    const { api: a2, h } = page();
    const card = cardOf(list, "9005");
    const btn = card.match(/<button type="button" class="metric claimed"[^>]*>/)[0];
    const data = Object.fromEntries([...btn.matchAll(/data-([a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    assert.strictEqual(data.wallet, W2, "the button carries the wallet");
    assert.match(btn, new RegExp(`aria-controls="${data.claim}"`));
    assert.match(card, new RegExp(`<div class="claimhist" id="${data.claim}" hidden>`));
    assert.notStrictEqual(data.claim, cardOf(list, "9001").match(/data-claim="([^"]+)"/)[1]);
    // the same token id held by two wallets gets two panels
    const twice = [a2.closedCard(pos({ tokenId: "5", status: "closed" }), HISTORY), a2.closedCard(pos({ tokenId: "5", status: "transferred", wallet: W2 }), HISTORY)]
      .map((c) => c.match(/data-claim="([^"]+)"/)[1]);
    assert.notStrictEqual(twice[0], twice[1]);

    h.answers.push({ status: 200, body: { ok: true, state: "complete", status: "ok", verifiedZero: false, coverage: cov({}),
      rows: [{ t: T(10), kind: "withdrawal", fee0: "1 USDC", fee1: "2 ARGUS", priceSrc: "block", priceT: T(10), usd: 1.5, tx: H(31) },
             { t: T(11), kind: "increase", fee0: "0.1 USDC", fee1: "0 ARGUS", priceSrc: null, usd: null, tx: H(32) }] } });
    const panel = { id: data.claim, innerHTML: "" };
    await a2.refreshClaimPanel(panel, { dataset: data });
    const q = new URLSearchParams(h.urls[0].split("?")[1]);
    assert.strictEqual(h.urls[0].split("?")[0], "/api/claims");
    assert.deepStrictEqual(Object.fromEntries(q), { tokenId: "9005", chainId: "5042", manager: POSM, wallet: W2 });
    assert.match(panel.innerHTML, /withdrawal \(principal excluded\)/);
    assert.match(panel.innerHTML, /add \(fees netted\)/);
    assert.match(panel.innerHTML, /href="https:\/\/explorer\.example\/tx\/0x(31){32}"/, "transaction links in the panel");
    assert.match(strip(panel.innerHTML), /no USD value no historical price/, "a row without a historical price is not valued at today's");
    // an open card without a wallet keeps the old request
    const { api: a3, h: h3 } = page();
    h3.answers.push({ status: 200, body: { ok: true, rows: [] } });
    await a3.refreshClaimPanel({ id: "x", innerHTML: "" }, { dataset: { tokenid: "1", chainid: "5042", manager: POSM } });
    assert.ok(!/wallet=/.test(h3.urls[0]));
  }

  // ---- loading, filter choice, failed refresh keeps the last good list ------------------
  {
    const { api: a, els, h, prefs, classes } = page();
    const listHtml = () => els["#histlist"].innerHTML;
    // default: Open, today's view; the section stays hidden
    a.renderPosHistory();
    assert.strictEqual(els["#histsec"].hidden, true);
    assert.ok(classes.has("pf-open") && !classes.has("pf-closed"));
    assert.match(els["#posfilter"].innerHTML, /data-pfilter="open" aria-checked="true"/);

    // the route is not there yet: a clean "not available", not a failure strip, not an empty list
    a.setPosFilter("closed");
    assert.strictEqual(prefs.get("positions:filter"), "closed", "the choice is remembered");
    assert.ok(classes.has("pf-closed") && !classes.has("pf-open"));
    assert.strictEqual(els["#histsec"].hidden, false);
    h.answers.push({ status: 404, body: new SyntaxError("Unexpected token N") });
    await a.loadPosHistory();
    assert.strictEqual(h.urls[0], "/api/positions/history?wallet=all");
    assert.strictEqual(els["#histstale"].hidden, false);
    assert.match(els["#histstale"].innerHTML, /not available from this server yet \(HTTP 404\).*not an empty result/);
    assert.strictEqual(listHtml(), "");
    assert.deepStrictEqual(h.fails, [], "a route that does not exist yet is not reported as a failed refresh");
    assert.match(els["#posfilter"].innerHTML, /count not available yet/);

    // a good answer
    h.answers.push({ status: 200, body: HISTORY });
    await a.loadPosHistory();
    const good = listHtml();
    assert.match(good, /data-key="5042:[^"]*:9004:/);
    assert.strictEqual(els["#histstale"].hidden, true);
    assert.match(els["#posfilter"].innerHTML, /aria-label="Closed, 6 positions"/);
    assert.deepStrictEqual(h.oks, ["Position history"]);

    // failures of every kind keep it, marked stale
    for (const bad of [
      { status: 200, body: { ok: false, error: "rpc down" } },
      { status: 500, body: { ok: false, error: "internal error" } },
      { status: 404, body: { ok: false, error: "unknown wallet" } },
      { status: 502, body: new SyntaxError("Unexpected token <") },
      new TypeError("Failed to fetch"),
    ]) {
      h.answers.push(bad);
      await a.loadPosHistory();
      assert.strictEqual(listHtml(), good, "a failed refresh never replaces the list");
      assert.strictEqual(els["#histstale"].hidden, false);
      assert.match(els["#histstale"].innerHTML, /Showing the last successful refresh from .*The latest refresh failed/);
      assert.match(els["#posfilter"].innerHTML, /aria-label="Closed, 6 positions"/, "the counts stay too");
    }
    assert.match(h.fails[0], /^Position history: rpc down$/);
    assert.match(h.fails[2], /unknown wallet/, "a JSON 404 is the server's answer, not a missing route");
    assert.strictEqual(h.fails.length, 5);

    // still building: the list stays, no alarm
    h.answers.push({ status: 202, body: { ok: false, refreshing: true } });
    await a.loadPosHistory();
    assert.strictEqual(listHtml(), good);
    assert.strictEqual(els["#histstale"].hidden, true);

    // All shows the same cards; Open hides the section again
    a.setPosFilter("all");
    assert.ok(classes.has("pf-all"));
    assert.strictEqual(els["#histsec"].hidden, false);
    a.setPosFilter("open");
    assert.strictEqual(els["#histsec"].hidden, true);
    a.setPosFilter("nonsense");
    assert.strictEqual(prefs.get("positions:filter"), "open", "an unknown choice is ignored");
    prefs.set("positions:filter", "garbage");
    a.renderPosHistory();
    assert.match(els["#posfilter"].innerHTML, /data-pfilter="open" aria-checked="true"/, "a bad stored value falls back to Open");

    // another wallet scope: the previous wallet's cards are not shown for it
    a.setPosFilter("closed");
    h.scope = W2;
    h.answers.push({ status: 200, body: { ok: false, error: "discovery failed" } });
    await a.loadPosHistory();
    assert.strictEqual(h.urls.at(-1), `/api/positions/history?wallet=${W2}`);
    assert.ok(!/<article/.test(listHtml()), "no cards from another scope");
    assert.match(els["#histstale"].innerHTML, /Could not load: discovery failed.*not an empty result/);
    assert.match(els["#posfilter"].innerHTML, /count not available yet/);

    // no scope yet: no request
    const n = h.urls.length;
    h.scope = null;
    await a.loadPosHistory();
    assert.strictEqual(h.urls.length, n);
  }

  console.log("closed view: filter counts and keys, per-status groups (transferred is not closed), dates only when recorded, unsettled fees, claim states, no principal or return, wallet-scoped history, stale list kept");
}
main().catch((e) => { console.error(e); process.exit(1); });
