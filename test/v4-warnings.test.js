// node test/v4-warnings.test.js -- the Uniswap v4 discovery warnings: the pure helper (univ4.discoveryWarnings),
// GET /api/positions and /api/watch on the Base example over a stubbed chain, and the page rendering
// (dashboard.js function injection). An unfinished scan or an on-chain balance larger than what was found must be
// said out loud, never read as "no positions". No network.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const v4 = require("../univ4");
const base = require("./lib/base-v4-server");

const ROOT = path.join(__dirname, "..");
const W = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743";
const W11 = "0xFc1235E6523Becf4b329ed9ADf21750cfAF65Bfb";
const KEYS = ["balanceOf", "chainId", "code", "complete", "error", "ids", "known", "label", "message", "missing", "pinned", "scannedFrom", "scope", "severity", "wallet"];
const st = (o = {}) => ({ complete: false, scannedFrom: null, lastScanned: 0, window: null, error: null, known: 0, pinned: 0, ...o });
const warn = (o) => v4.discoveryWarnings({ wallet: W.toLowerCase(), label: "Trading", chainId: 8453, status: st(), balanceOf: null, knownOwned: 0, pinnedInvalid: [], pinnedNotOwned: [], ...o });
const codes = (a) => a.map((x) => `${x.code}:${x.severity}`);

(async () => {
  // ---- 5. incomplete scan ---------------------------------------------------------
  {
    const a = warn({ status: st({ complete: false }), balanceOf: 6, knownOwned: 0 });
    assert.deepStrictEqual(codes(a), ["v4-discovery-incomplete:warn", "v4-balance-exceeds-known:warn"]);
    assert.strictEqual(a[1].missing, 6); assert.strictEqual(a[0].missing, 6);
    assert.ok(/not complete for Trading.*0 known, 6 held on-chain/.test(a[0].message), a[0].message);
    assert.ok(/Trading holds 6 Uniswap v4 NFTs on-chain but only 0 are known: 6 not shown\. Pin their ids in settings \(wallets\.main\.v4Ids\)/.test(a[1].message), a[1].message);
    const b = warn({ status: st({ complete: false }), balanceOf: null, knownOwned: 0 });
    assert.deepStrictEqual(codes(b), ["v4-discovery-incomplete:warn"]);
    assert.strictEqual(b[0].balanceOf, null); assert.strictEqual(b[0].missing, null);
    assert.ok(/unknown held on-chain/.test(b[0].message));
    // bigint balance is accepted
    assert.strictEqual(warn({ status: st(), balanceOf: 6n, knownOwned: 2 })[1].missing, 4);
  }
  // ---- 6. balance exceeds known on a complete scan -------------------------------
  {
    const a = warn({ status: st({ complete: true }), balanceOf: 6, knownOwned: 5 });
    assert.deepStrictEqual(codes(a), ["v4-balance-exceeds-known:warn"]);
    assert.strictEqual(a[0].missing, 1);
  }
  // ---- 7. nothing to say ------------------------------------------------------------
  {
    assert.deepStrictEqual(warn({ status: st({ complete: true }), balanceOf: 6, knownOwned: 6 }), []);
    assert.deepStrictEqual(warn({ status: st({ complete: true }), balanceOf: 0, knownOwned: 0 }), []);
    assert.deepStrictEqual(warn({ status: st({ complete: true }), balanceOf: null, knownOwned: 3 }), [], "an unreadable balance on a complete scan is not a warning");
    assert.deepStrictEqual(warn({ status: st({ complete: true }), balanceOf: 2, knownOwned: 3 }), [], "fewer on-chain than known (a transfer away) is not a shortfall");
  }
  // ---- 8. incomplete, but all accounted for -------------------------------------------
  {
    const a = warn({ status: st({ complete: false, pinned: 6 }), balanceOf: 6, knownOwned: 6 });
    assert.deepStrictEqual(codes(a), ["v4-discovery-incomplete:info"]);
    assert.ok(a.every((x) => x.severity !== "warn"));
    assert.strictEqual(a[0].pinned, 6); assert.strictEqual(a[0].known, 6); assert.strictEqual(a[0].missing, 0);
    assert.ok(/match the on-chain balance/.test(a[0].message));
  }
  // ---- 9. shape ------------------------------------------------------------------------
  {
    const long = "x".repeat(500) + "\nsecond line";
    const all = warn({ status: st({ complete: false, error: long, scannedFrom: 123, pinned: 1 }), balanceOf: 6, knownOwned: 0, pinnedInvalid: ["abc"], pinnedNotOwned: ["22"] });
    assert.deepStrictEqual(codes(all), ["v4-discovery-incomplete:warn", "v4-balance-exceeds-known:warn", "v4-pinned-not-owned:warn", "v4-pinned-invalid:warn"]);
    for (const x of all) {
      assert.deepStrictEqual(Object.keys(x).sort(), KEYS, x.code);
      assert.strictEqual(x.chainId, 8453); assert.strictEqual(x.wallet, W, "checksummed");
      assert.strictEqual(x.scope, "uniswap-v4"); assert.strictEqual(x.label, "Trading");
      assert.strictEqual(typeof x.message, "string"); assert.ok(!/\n/.test(x.message));
      assert.ok(x.error.length <= 200 && !/\n/.test(x.error)); assert.strictEqual(x.scannedFrom, 123);
    }
    assert.deepStrictEqual(all[2].ids, ["22"]); assert.deepStrictEqual(all[3].ids, ["abc"]);
    assert.strictEqual(all[0].ids, null); assert.strictEqual(all[1].ids, null);
    assert.strictEqual(warn({ label: null, status: st({ complete: true }), balanceOf: 2, knownOwned: 0 })[0].label, null);
  }

  // ---- 10. HTTP: GET /api/positions ------------------------------------------------------
  const six = [1, 2, 3, 4, 5, 6];
  {
    // discovery cannot finish, nothing pinned, the wallet holds 6: two warnings
    const a = await base.start({ stubV4: { balance: 6, owned: six }, logsFail: true });
    try {
      const r = await a.get("/api/positions");
      assert.strictEqual(r.status, 200, r.body.slice(0, 300));
      const d = JSON.parse(r.body);
      assert.ok(Array.isArray(d.warnings));
      assert.deepStrictEqual(codes(d.warnings), ["v4-discovery-incomplete:warn", "v4-balance-exceeds-known:warn"]);
      assert.strictEqual(d.warnings[1].missing, 6); assert.strictEqual(d.warnings[0].balanceOf, 6);
      assert.strictEqual(d.warnings[0].chainId, 8453); assert.strictEqual(d.warnings[0].wallet, W); assert.strictEqual(d.warnings[0].label, "Trading");
      assert.strictEqual(d.positions.filter((p) => p.version === 4).length, 0);
      assert.ok(!/https?:\/\//.test(JSON.stringify(d.warnings)), "no URL in a warning");
    } finally { await a.stop(); }

    // the same chain with the six pinned and owned: only the info entry, six v4 cards
    const b = await base.start({ mutate: (s) => { s.wallets.main.v4Ids = six; }, stubV4: { balance: 6, owned: six }, logsFail: true });
    try {
      const d = JSON.parse((await b.get("/api/positions")).body);
      assert.deepStrictEqual(codes(d.warnings), ["v4-discovery-incomplete:info"]);
      assert.deepStrictEqual(d.positions.filter((p) => p.version === 4).map((p) => p.nftId).sort(), six.map(String));
      assert.strictEqual(d.warnings[0].pinned, 6); assert.strictEqual(d.warnings[0].known, 6);
    } finally { await b.stop(); }

    // a complete scan and six ids found by it: nothing
    const c = await base.start({ state: { ids: six.map(String), complete: true, lastScanned: 30_000_000, scannedFrom: 0 }, stubV4: { balance: 6, owned: six } });
    try {
      const d = JSON.parse((await c.get("/api/positions")).body);
      assert.deepStrictEqual(d.warnings, []);
      assert.strictEqual(d.positions.filter((p) => p.version === 4).length, 6);
    } finally { await c.stop(); }

    // no v4 NFT mock at all (the manager is unknown to the chain): warnings is still an array
    const e = await base.start({ logsFail: true });
    try {
      const d = JSON.parse((await e.get("/api/positions")).body);
      assert.ok(Array.isArray(d.warnings));
      assert.ok(d.warnings.every((x) => x.balanceOf === null), "balanceOf unreadable: null");
    } finally { await e.stop(); }
  }

  // ---- pure: default and explicit pin hints, redaction before cut ---------------------------
  {
    const w1 = warn({ status: st({ complete: true }), balanceOf: 2, knownOwned: 1 });
    assert.ok(w1[0].message.includes("wallets.main.v4Ids"));
    const w2 = warn({ status: st({ complete: true }), balanceOf: 2, knownOwned: 1, pinHint: "wallets.watched[].v4Ids" });
    assert.ok(w2[0].message.includes("wallets.watched[].v4Ids") && !w2[0].message.includes("wallets.main"));
  }

  // ---- 11. HTTP: GET /api/watch ------------------------------------------------------------
  {
    const srv = await base.start({ stubV4: { balance: 0, owned: [], balances: { [W11.toLowerCase()]: 3 } }, logsFail: true });
    try {
      let d = null;
      for (let i = 0; i < 100; i++) {
        const r = await srv.get(i === 0 ? "/api/watch?fresh=1" : "/api/watch");
        if (r.status === 200) { d = JSON.parse(r.body); if (!d.refreshing) break; }
        await new Promise((res) => setTimeout(res, 300));
      }
      assert.ok(d && d.ok, "watch answered");
      const w = d.wallets.find((x) => x.address === W11);
      assert.ok(w && Array.isArray(w.warnings), "the watched wallet carries warnings");
      assert.deepStrictEqual(codes(w.warnings), ["v4-discovery-incomplete:warn", "v4-balance-exceeds-known:warn"]);
      assert.ok(/wallets\.watched\[\]\.v4Ids/.test(w.warnings[1].message) && !/wallets\.main/.test(w.warnings[1].message), w.warnings[1].message);
      assert.ok(Array.isArray(w.v4Ids) && w.v4Ids.length === 0, "the response carries the parsed pin list");
      assert.strictEqual(w.warnings[1].missing, 3); assert.strictEqual(w.warnings[0].wallet, W11); assert.strictEqual(w.warnings[0].label, "Wallet 11");
      assert.ok(w.discovery && w.discovery.complete === false, "the discovery field is unchanged");
    } finally { await srv.stop(); }
  }

  // ---- 12. the page (function injection from dashboard.js) -----------------------------------
  {
    const src = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");
    const fn = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf("\n}\n", i) + 3); };
    const i0 = src.indexOf("$('#errors').innerHTML = warn");
    const i1 = src.indexOf(".join('');", src.indexOf("$('#errors').innerHTML += ", i0)) + ".join('');".length;
    assert.ok(i0 > 0 && i1 > i0, "the #errors block is found");
    const block = src.slice(i0, i1);
    const ctx = { out: "" };
    vm.createContext(ctx);
    vm.runInContext([src.match(/^const esc = .*$/m)[0], fn("v4WarningBanners"), fn("v4WarningNotes"), fn("walletIssues"),
      "const el = { innerHTML: '' }; const $ = () => el;",
      "this.renderErrors = function (d) { el.innerHTML = ''; const warn = ''; " + block + " return el.innerHTML; }; this.issues = walletIssues;"].join("\n"), ctx);
    const mk = (severity, message) => ({ code: "v4-x", severity, message });
    const html = ctx.renderErrors({ errors: [{ tokenId: "v4-5", error: "boom" }], notes: ["a note"], warnings: [mk("warn", "first <b>one</b>"), mk("warn", "second"), mk("info", "quiet line")] });
    const banners = html.match(/<div class="warn-banner warn" role="alert">/g) || [];
    assert.strictEqual(banners.length, 2, html);
    assert.ok(html.indexOf("first &lt;b&gt;one&lt;/b&gt;") >= 0 && html.indexOf("second") > html.indexOf("first"));
    assert.ok(html.lastIndexOf('role="alert"') < html.indexOf("a note"), "banners come before the notes");
    assert.ok(html.indexOf("quiet line") > html.lastIndexOf('role="alert"') && html.indexOf("quiet line") < html.indexOf("a note"), "the info line is a muted line before the notes");
    assert.ok(!/role="alert">[^<]*quiet/.test(html), "an info entry is not a banner");
    assert.ok(/class="muted v4note"/.test(html));
    // hostile text
    const evil = ctx.renderErrors({ warnings: [mk("warn", "<img src=x onerror=1>"), { code: "c", severity: "info", message: "<img src=x onerror=1>" }] });
    assert.ok(!/<img/i.test(evil), evil);
    assert.ok(evil.includes("&lt;img src=x onerror=1&gt;"));
    // nothing: no container, no banner
    for (const none of [undefined, null, []]) {
      const h = ctx.renderErrors({ errors: [], notes: [], warnings: none });
      assert.ok(!/role="alert"|v4note|warn-banner/.test(h), h);
    }
    // watched wallet
    const wi = ctx.issues({ errors: [], notes: ["n"], warnings: [mk("warn", "wallet banner <i>"), mk("info", "info line")] });
    assert.strictEqual((wi.match(/role="alert"/g) || []).length, 1);
    assert.ok(wi.includes("wallet banner &lt;i&gt;") && !/<i>/.test(wi));
    assert.ok(wi.indexOf('role="alert"') < wi.indexOf(">n<"), "banner first");
    assert.strictEqual(ctx.issues({ errors: [], notes: [], warnings: [] }), "", "empty: no container");
    assert.strictEqual(ctx.issues({}), "");
    assert.ok(ctx.issues({ warnings: [mk("info", "only info")] }).includes("only info"));
  }

  console.log("v4-warnings tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
