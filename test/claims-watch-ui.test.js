// node test/claims-watch-ui.test.js — the watched-wallet cards and the claim panel
// keep their last good data when a refresh fails or answers ok:false, and say so;
// a "verified $0.00" is only drawn with whole coverage and an "ok" from the server.
//
// dashboard.js is browser code; the functions are lifted out of the source the way
// test/fee-unavailable.test.js lifts feeFace.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
function lift(name) {
  let from = src.indexOf(`\nasync function ${name}(`);
  if (from < 0) from = src.indexOf(`\nfunction ${name}(`);
  assert.ok(from >= 0, `${name} is gone from dashboard.js`);
  const to = src.indexOf("\n}\n", from) + 3;
  return src.slice(from, to);
}
const escLine = src.match(/^const esc = .*$/m)[0];
// A top-level const, including one whose value continues on indented lines.
function liftConst(name) {
  const from = src.indexOf(`\nconst ${name} = `);
  assert.ok(from >= 0, `${name} is gone from dashboard.js`);
  const lines = src.slice(from + 1).split("\n");
  const out = [lines[0]];
  for (let i = 1; i < lines.length && (/^\s/.test(lines[i]) || /^}/.test(lines[i])); i++) out.push(lines[i]);
  return out.join("\n") + "\n";
}
// The claim-state helpers every claimed-fee view reads.
const claimHelpers = () => ["CLAIM_STATES", "cDate", "cTime", "CLAIM_MIXED_NOTE", "endStop", "COPY_ICON"].map(liftConst).join("") +
  ["claimState", "claimVerifiedZero", "claimValuation", "claimMoney", "claimSubtotal", "claimCurrent", "claimWhy", "claimRowValue",
   "chainRef", "txRef"].map(lift).join("");

// A tiny harness: the lifted functions share one scope with stubbed page state.
function page() {
  const els = { "#watchstale": { hidden: true, className: "", textContent: "", innerHTML: "" } };
  const h = { renders: [], fails: [], oks: [], timers: 0, answers: [] };
  const body = `
    ${escLine}
    const usd = (n) => '$' + Number(n || 0).toFixed(2);
    const linkify = (s) => esc(s);
    let EXPLORER = null;
    let lastWatchForPf = null, lastPortfolio = null;
    const fetchedAt = new WeakMap();
    ${claimHelpers()}
    ${lift("apiOutcome")}${lift("staleNote")}${lift("loadWatch")}${lift("watchFailed")}
    ${lift("claimKindLabel")}${lift("claimPriceLabel")}${lift("claimPanelHtml")}
    const claimPanels = new Map();
    ${lift("refreshClaimPanel")}
    ${lift("claimedMetric")}${lift("claimedLine")}
    return { apiOutcome, loadWatch, refreshClaimPanel, claimedMetric, claimedLine, claimPanelHtml,
             get last() { return lastWatchForPf; } };`;
  const fetch = async () => {
    const a = h.answers.shift();
    if (a instanceof Error) throw a;
    return { status: a.status, json: async () => { if (a.body instanceof Error) throw a.body; return a.body; } };
  };
  const api = new Function("fetch", "$", "renderWatch", "renderPortfolio", "loadOk", "loadFailed", "setTimeout", body)(
    fetch, (sel) => els[sel] || null,
    (d) => h.renders.push(d), () => {},
    (s) => h.oks.push(s), (s, e) => h.fails.push(`${s}: ${e.message}`),
    () => { h.timers++; });
  return { api, h, els };
}

async function main() {
  // ---- apiOutcome ----------------------------------------------------------------
  {
    const { api } = page();
    assert.strictEqual(api.apiOutcome(200, { ok: true }).kind, "ok");
    assert.strictEqual(api.apiOutcome(202, { ok: false, refreshing: true }).kind, "pending");
    assert.strictEqual(api.apiOutcome(200, { ok: false, refreshing: true }).kind, "pending", "no data yet, still building");
    const e1 = api.apiOutcome(200, { ok: false, error: "rpc down" });
    assert.deepStrictEqual(e1, { kind: "error", msg: "rpc down" }, "ok:false on HTTP 200 is a failure");
    assert.strictEqual(api.apiOutcome(200, { ok: false }).kind, "error", "ok:false with no reason is still a failure");
    assert.strictEqual(api.apiOutcome(500, { ok: false, error: "internal error", refreshing: true }).kind, "error",
      "a 5xx is never 'still loading'");
    assert.strictEqual(api.apiOutcome(200, {}).kind, "error", "an answer without ok:true is not data");
    assert.strictEqual(api.apiOutcome(502, null).kind, "error");
  }

  // ---- watched wallets: last good data survives, stale state is visible -----------
  {
    const { api, h, els } = page();
    const good = { ok: true, at: Date.UTC(2026, 8, 17, 9, 30), wallets: [{ ok: true, address: "0xabc", positions: [] }] };
    h.answers.push({ status: 200, body: good });
    await api.loadWatch();
    assert.strictEqual(h.renders.length, 1);
    assert.strictEqual(api.last, good);
    assert.ok(els["#watchstale"].hidden, "no stale note after a good refresh");

    for (const bad of [
      { status: 200, body: { ok: false, error: "watched wallets: rpc timeout" } },
      { status: 500, body: { ok: false, error: "internal error" } },
      { status: 502, body: new SyntaxError("Unexpected token < in JSON") },
      new TypeError("Failed to fetch"),
    ]) {
      h.answers.push(bad);
      await api.loadWatch();
      assert.strictEqual(h.renders.length, 1, "a failed refresh never redraws (or wipes) the cards");
      assert.strictEqual(api.last, good, "the last good payload is kept");
      assert.strictEqual(els["#watchstale"].hidden, false, "the section shows it is stale");
      assert.match(els["#watchstale"].innerHTML, /last successful refresh from .*latest refresh failed/);
    }
    assert.ok(h.fails.length === 4 && h.fails.every((f) => f.startsWith("Watched wallets:")), "each failure reaches the page strip");
    assert.match(h.fails[0], /rpc timeout/);

    // pending does not count as a failure and does not wipe the cards
    h.answers.push({ status: 202, body: { ok: false, refreshing: true, wallets: [] } });
    await api.loadWatch();
    assert.strictEqual(h.renders.length, 1);
    assert.strictEqual(h.timers, 1, "a first build still running is polled again");

    // recovery clears the stale note
    h.answers.push({ status: 200, body: { ...good, at: good.at + 60000 } });
    await api.loadWatch();
    assert.strictEqual(h.renders.length, 2);
    assert.ok(els["#watchstale"].hidden);
    assert.deepStrictEqual(h.oks.slice(-1), ["Watched wallets"]);
  }
  {
    // a failure before anything loaded says so, and is not an empty list
    const { api, h, els } = page();
    h.answers.push({ status: 200, body: { ok: false, error: "no wallets could be read" } });
    await api.loadWatch();
    assert.strictEqual(h.renders.length, 0);
    assert.match(els["#watchstale"].innerHTML, /Could not load: no wallets could be read.*not an empty result/);
  }

  // ---- claim panel: refetched on open, last good kept on failure ------------------
  {
    const { api, h } = page();
    const panel = { id: "ch-5042-8240", innerHTML: "" };
    const btn = { dataset: { tokenid: "8240", chainid: "5042", manager: "0x6049" } };
    const good = { ok: true, status: "ok", scope: {}, coverage: { fromBlock: 1, toBlock: 9, coversOpening: true, reachedLookbackFloor: false },
      rows: [{ t: 1, block: 5, tx: "0x" + "e8".repeat(32), kind: "collect", fee0: "42.499934 USDC", fee1: "1,266.96645 ARGUS", priceSrc: "block" }] };

    h.answers.push({ status: 200, body: { ok: false, error: "scan store unreadable" } });
    await api.refreshClaimPanel(panel, btn);
    assert.match(panel.innerHTML, /could not be loaded: scan store unreadable.*not a statement that nothing was collected/);
    assert.ok(!/No collections/.test(panel.innerHTML), "ok:false is never drawn as an empty history");

    h.answers.push({ status: 200, body: good });
    await api.refreshClaimPanel(panel, btn);
    assert.match(panel.innerHTML, /42\.499934 USDC/);

    // an add that realised fees is labelled as what it was, not as a collect
    const withAdd = { ...good, rows: [...good.rows, { t: 2, block: 6, tx: "0x" + "63".repeat(32), kind: "increase", fee0: "0.202463 USDC", fee1: "0 ARGUS", priceSrc: "block" }] };
    assert.match(api.claimPanelHtml(withAdd), /add \(fees netted\)[\s\S]*0\.202463 USDC[\s\S]*0 ARGUS/);

    h.answers.push({ status: 200, body: { ok: false, error: "rpc 429" } });
    await api.refreshClaimPanel(panel, btn);
    assert.match(panel.innerHTML, /last successful refresh from .*latest refresh failed: rpc 429/);
    assert.match(panel.innerHTML, /42\.499934 USDC/, "the last good rows stay on screen");

    h.answers.push(new TypeError("Failed to fetch"));
    await api.refreshClaimPanel(panel, btn);
    assert.match(panel.innerHTML, /Failed to fetch/);
    assert.match(panel.innerHTML, /42\.499934 USDC/);
  }

  // ---- "verified $0.00" needs whole coverage and an ok from the server -----------
  {
    const { api } = page();
    const zeroish = (over) => ({ nftId: "11989", claimed: { status: "ok", count: 0, usd: 0, tokens: [],
      scope: { chainId: 5042, tokenId: "11989" },
      coverage: { fromBlock: 21098589, toBlock: 21306196, openedBlock: 21104302, coversOpening: true }, ...over } });
    const isZero = (html) => /\$0\.00/.test(html) && /verified/.test(html);

    assert.ok(isZero(api.claimedMetric(zeroish({}), "u")), "mint covered, ok, nothing found: a verified zero");
    assert.ok(/No fees claimed yet/.test(api.claimedLine(zeroish({}))));

    const notZero = [
      ["the scan has not reached the mint", zeroish({ status: "partial", coverage: { fromBlock: 5, toBlock: 9, coversOpening: false } })],
      ["coverage says nothing about the opening", zeroish({ coverage: { fromBlock: 5, toBlock: 9 } })],
      ["no coverage at all", zeroish({ coverage: undefined })],
      ["a payout could not be decoded", { nftId: "1", claimed: { status: "unavailable", reason: "the pair's tokens also moved…" } }],
      ["no summary", { nftId: "1", claimed: null }],
    ];
    for (const [why, p] of notZero) {
      assert.ok(!isZero(api.claimedMetric(p, "u")), `tile must not show a verified zero when ${why}`);
      assert.ok(!/No fees claimed yet/.test(api.claimedLine(p)), `line must not show a verified zero when ${why}`);
    }

    // the panel: "never had fees collected" only when complete and every row readable
    const panelD = (over) => ({ ok: true, status: "ok", rows: [], coverage: { fromBlock: 1, toBlock: 9, coversOpening: true }, ...over });
    assert.match(api.claimPanelHtml(panelD({})), /never had fees collected/);
    assert.ok(!/never had fees collected/.test(api.claimPanelHtml(panelD({ status: "partial", coverage: { fromBlock: 1, toBlock: 9, coversOpening: false } }))));
    assert.ok(!/never had fees collected/.test(api.claimPanelHtml(panelD({ coverage: { fromBlock: 1, toBlock: 9 } }))));
  }

  console.log("claims/watch UI: ok:false keeps the last good data and says it is stale; a verified zero needs whole coverage and every payout read");
}
main().catch((e) => { console.error(e); process.exit(1); });
