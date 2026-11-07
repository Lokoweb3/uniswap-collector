// node test/aggregate-view.test.js -- the /portfolio page script: rendering, filtering, escaping, read-only.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const walk = require("acorn-walk");
const agg = require("../aggregate");
const F = require("./lib/aggregate-fixtures");
const V = require("../aggregate-view");
const { addr, lp, ext, reward, row } = F;

const SRC = fs.readFileSync(path.join(__dirname, "..", "aggregate-view.js"), "utf8");
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, `${m}: ${a} vs ${b}`);
const CH = [
  { key: "a", label: "Alpha", accent: "#111111", port: 1 },
  { key: "b", label: "Beta", accent: "#222222", port: 2 },
];
const M = addr(1);
async function payloadFor(data, opts = {}) {
  const ag = agg.createAggregator({
    chains: CH, now: () => F.AT + 60000, waitMs: 500, ...opts,
    fetchJson: async (chain, p) => { const v = data[chain.key][p.split("/").pop()]; return v.__code ? { code: v.__code } : { status: 200, data: v }; },
  });
  return ag.get();
}
const healthy = () => ({
  a: {
    positions: F.positions(M, { positions: [lp(1, { valueUsd: 1000, feesUsd: 10 })], external: [ext("aerodrome-cl2", 2, { staked: true, valueUsd: 300, rewards: reward(12.5) })] }),
    watch: F.watch([F.walletRow(addr(2), "Wallet 1", { positions: [lp(3, { valueUsd: 200, feesUsd: 4 })] })]),
    portfolio: F.portfolio(M, [row("ETH", 1, 2000, { native: true }), row("JUNK", 5, null)]), staking: F.staking(),
  },
  b: {
    positions: F.positions(M, { ownerLabel: "Treasury", positions: [lp(7, { valueUsd: 100, feesUsd: 1 })] }),
    watch: F.watch(), portfolio: F.portfolio(M, [row("USDC", 20, 1)]), staking: F.staking(),
  },
});

(async () => {
  // ---- esc is the dashboard's esc
  {
    const lift = (src) => new Function(`${/const esc = [^\n]+/.exec(src)[0]}; return esc;`)();
    const theirs = lift(fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8"));
    for (const s of ["<img src=x onerror=alert(1)>", '"><script>', "it's & that", null, undefined, 5, "plain"]) assert.strictEqual(V.esc(s), theirs(s));
    assert.strictEqual(V.usd(null), "unpriced"); assert.strictEqual(V.usd(undefined), "unpriced"); assert.strictEqual(V.usd(0), "$0.00");
    assert.strictEqual(V.usd(1234567.891), "$1,234,567.89"); assert.strictEqual(V.usd(NaN), "unpriced");
  }

  // ---- a truncated payload: unfiltered shows the server's totals, filtered says they cover only the list
  {
    const tp = JSON.parse(JSON.stringify(await payloadFor(healthy())));
    tp.truncated = true; tp.totals.grandUsd = 987654.32; tp.items = tp.items.slice(0, 2);
    const uf = { chains: new Set(["a", "b"]), wallet: "", sort: "value" };
    assert.strictEqual(V.totalsFor(tp, V.filterItems(tp, uf), uf), tp.totals, "unfiltered + truncated: the server's totals, not a recompute");
    const html = V.renderPage(tp, uf);
    assert.ok(html.includes(V.usd(987654.32)) && html.includes("totals cover everything"));
    const fl = { ...uf, chains: new Set(["a"]) };
    const fh = V.renderPage(tp, fl);
    assert.ok(fh.includes("cover only the listed items"), "filtered + truncated: the note says so");
  }

  // ---- rendering a healthy payload, filters recompute the totals
  const p = await payloadFor(healthy());
  const all = { chains: new Set(["a", "b"]), wallet: "", sort: "value" };
  {
    const html = V.renderPage(p, all);
    for (const s of ["LP positions", "Tokens", "Staking", "By chain", "By wallet", "By protocol", "pending rewards (included)", "rewards not counted: 0", "uncounted", "priced by assumption", "Not counted (1)", "unpriced"]) {
      assert.ok(html.includes(s), `page shows "${s}"`);
    }
    assert.ok(html.includes(V.usd(p.totals.grandUsd)), "the unfiltered tile is the server's total");
    // 10. filter to wallet M: items from both chains, totals recomputed
    const m = { ...all, wallet: M.toLowerCase() };
    const items = V.filterItems(p, m);
    assert.deepStrictEqual([...new Set(items.map((i) => i.chain))].sort(), ["a", "b"]);
    const t = V.totalsFor(p, items, m);
    near(t.grandUsd, 1000 + 10 + 300 + 12.5 + 2000 + 100 + 1 + 20, "wallet M across both chains, rewards included");
    near(t.rewardsUsd, 12.5, "rewards line");
    const onlyB = V.totalsFor(p, V.filterItems(p, { ...all, chains: new Set(["b"]) }), { ...all, chains: new Set(["b"]) });
    near(onlyB.grandUsd, 121, "chain filter recomputes");
    near(V.totalsFor(p, p.items, all).grandUsd, p.totals.grandUsd, "unfiltered: same as the server");
    // breakdown by chain of the filtered set
    const by = V.breakdownFor(V.filterItems(p, { ...all, chains: new Set(["a"]) }));
    near(by.chain.a, 3526.5, "by chain");
    // sort
    const byFees = V.sortItems(p.items, "fees")[0]; assert.strictEqual(byFees.feesUsd, 10);
    assert.strictEqual(V.sortItems(p.items, "value")[0].valueUsd, 2000);
    assert.strictEqual(V.sortItems(p.items, "chain")[0].chain, "a");
    // preselect: unknown chains ignored
    const sel = V.initialSelection(p, "?chains=a,http://evil,../x&wallet=<script>");
    assert.deepStrictEqual([...sel.chains], ["a"]); assert.strictEqual(sel.wallet, "");
    assert.strictEqual(V.initialSelection(p, "?wallet=treasury").wallet, M.toLowerCase());
  }

  // ---- an unreadable wallet selected in the Wallet filter: "unavailable", never $0.00
  {
    const d = healthy();
    d.a.watch = F.watch([F.walletRow(addr(2), "Wallet 1", { ok: false })]);
    const u = await payloadFor(d);
    const w = u.wallets.find((x) => x.key === addr(2).toLowerCase());
    assert.ok(w && w.unavailable === true, "the wallet is marked unavailable");
    const html = V.renderPage(u, { chains: new Set(["a", "b"]), wallet: w.key, sort: "value" });
    const tile = html.slice(html.indexOf('<div class="tile">'), html.indexOf("items shown"));
    assert.ok(tile.includes("unavailable") && !tile.includes("$0.00"), "tile: " + tile);
    assert.ok(V.renderPage(u, all).includes("$"), "unfiltered tile still shows figures");
  }

  // ---- 19. chain down: the banner names it, no figure
  {
    const d = healthy(); d.b = { positions: { __code: "unreachable" }, watch: { __code: "unreachable" }, portfolio: { __code: "unreachable" }, staking: { __code: "unreachable" } };
    const down = await payloadFor(d);
    const html = V.renderPage(down, all);
    assert.ok(/Beta is down/.test(html), "banner names the chain and its state");
    assert.ok(html.includes("missing from the total") && html.includes("incomplete"));
    assert.ok(/Beta<\/td><td class="num muted">down, no figure/.test(html), "the chain breakdown shows 'no figure', not $0.00");
    // filtering the chain away never hides its banner
    assert.ok(V.renderPage(down, { ...all, chains: new Set(["a"]) }).includes("Beta is down"));
  }

  // ---- 21. stale banner shows the last good timestamp
  {
    const t0 = F.AT + 60000;
    const clk = { t: t0 };
    const d = healthy();
    const ag = agg.createAggregator({ chains: CH, now: () => clk.t, ttlMs: 10, waitMs: 500,
      fetchJson: async (chain, pth) => { const v = d[chain.key][pth.split("/").pop()]; return v.__code ? { code: v.__code } : { status: 200, data: v }; } });
    await ag.get();
    d.b = { positions: { __code: "timeout" }, watch: { __code: "timeout" }, portfolio: { __code: "timeout" }, staking: { __code: "timeout" } };
    clk.t += 120000;
    const stale = await ag.get();
    const html = V.renderPage(stale, all);
    assert.ok(/Beta is stale/.test(html)); assert.ok(html.includes(new Date(t0).toISOString().slice(0, 16).replace("T", " ")), "the last-good timestamp");
    assert.ok(html.includes("included in the total") && html.includes("stale $"), "stale amount is shown separately");
  }

  // ---- 30. escaping
  {
    const evil = [`<img src=x onerror=alert(1)>`, `"><script>alert(2)</script>`, `it's & "q"`];
    const d = healthy();
    d.a.positions.ownerLabel = evil[0];
    d.a.positions.positions[0].pair = evil[1];
    d.a.positions.external[0].protocol = `aerodrome-${evil[0]}`;
    d.a.positions.external[0].rewards.symbol = evil[2];
    d.a.watch.wallets[0].label = evil[1];
    d.a.portfolio.rows[0].symbol = evil[0];
    const q = await payloadFor(d);
    q.chains[1].label = evil[0]; q.chains[1].accent = `red" onmouseover="alert(3)`;
    q.chains[0].problems.push({ part: evil[1], code: evil[2] }); q.chains[0].status = "partial";
    q.wallets[0].aliases = [evil[1]];
    q.items[0].protocol = evil[0];
    const html = V.renderPage(q, { ...all, wallet: "" });
    assert.ok(!html.includes("<img") && !/<script/i.test(html), "no markup from a value survives");
    assert.ok(!html.includes("onmouseover=\"alert"), "the accent cannot break out of its attribute");
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;") && html.includes("it&#39;s &amp; &quot;q&quot;"), "values appear escaped");
    // every quote-delimited attribute value in the output is balanced: parse tags crudely
    for (const tag of html.match(/<[a-z][^>]*>/gi) || []) assert.ok((tag.match(/"/g) || []).length % 2 === 0, `balanced quotes in ${tag}`);
  }

  // ---- 30/31. static checks on the shipped source
  {
    const ast = acorn.parse(SRC, { ecmaVersion: 2023, sourceType: "script" });
    const SAFE_FNS = new Set(["esc", "encodeURIComponent"]);
    const isHtmlName = (n) => /Html$/.test(n);
    const safe = (n) => {
      switch (n.type) {
        case "Literal": return true;
        case "Identifier": return isHtmlName(n.name) || n.name === "cols";
        case "TemplateLiteral": return n.expressions.every(safe);
        case "ConditionalExpression": return safe(n.consequent) && safe(n.alternate);
        case "BinaryExpression": return n.operator === "+" && safe(n.left) && safe(n.right);
        case "CallExpression": {
          const c = n.callee;
          if (c.type === "Identifier") return SAFE_FNS.has(c.name) || isHtmlName(c.name);
          if (c.type === "MemberExpression" && c.property.name === "join") return (c.object.type === "Identifier" && isHtmlName(c.object.name)) || mapsToSafe(c.object);
          return false;
        }
        default: return false;
      }
    };
    function mapsToSafe(n) {
      if (n.type !== "CallExpression" || n.callee.type !== "MemberExpression" || n.callee.property.name !== "map") return false;
      const cb = n.arguments[0];
      if (!cb || cb.type !== "ArrowFunctionExpression") return false;
      if (cb.body.type === "BlockStatement") {
        const ret = cb.body.body.find((s) => s.type === "ReturnStatement");
        return !!ret && safe(ret.argument);
      }
      return safe(cb.body);
    }
    const bad = [];
    walk.full(ast, (node) => {
      if (node.type === "TemplateLiteral") {
        // only templates that build markup matter
        const raw = node.quasis.map((q) => q.value.raw).join("");
        if (!/</.test(raw) && !/data-|class=/.test(raw)) return;
        for (const e of node.expressions) if (!safe(e)) bad.push(SRC.slice(e.start, e.end));
      }
      if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression" && /innerHTML|outerHTML/.test(node.left.property.name || "")) {
        if (!(node.right.type === "Identifier" && node.right.name === "html")) bad.push(`innerHTML = ${SRC.slice(node.right.start, node.right.end)}`);
      }
      if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.name === "insertAdjacentHTML") bad.push("insertAdjacentHTML");
    });
    assert.deepStrictEqual(bad, [], "every value interpolated into markup goes through esc() (or is a *Html fragment)");
    // the one innerHTML assignment lives in setHtml, which is only handed renderPage output
    assert.strictEqual((SRC.match(/\.innerHTML\s*=/g) || []).length, 1);
    assert.ok(/function setHtml\(el, html\) \{\s*el\.innerHTML = html;/.test(SRC));
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/\beval\s*\(|new Function|document\.write|insertAdjacentHTML/.test(code), "no eval / document.write");
    assert.ok(!/\bon[a-z]+\s*=\s*["'\\]/i.test(code.replace(/\bon[a-z]+\s*=>/g, "")), "no inline handler attributes written");
    assert.ok(!/<form|method:\s*["']POST|XMLHttpRequest|sendBeacon/i.test(code));
    assert.ok(!/\b(Collect|Claim|Arm|Approve|Sell|Mint)\b/.test(code), "no action words");
    const fetches = [...code.matchAll(/fetch\(([^;]*?)\{/g)].map((m) => m[1]);
    assert.ok(fetches.length === 1 && fetches.every((f) => /\/api\/aggregate/.test(f)), `only /api/aggregate is fetched: ${fetches}`);
    // links are only /?chain=<fixed key>
    const hrefs = [...code.matchAll(/href="([^"$]*)/g)].map((m) => m[1]);
    assert.ok(hrefs.every((h) => h === "/?chain="), `hrefs: ${hrefs}`);
    assert.ok(/encodeURIComponent\(c\.key\)/.test(code));
  }

  console.log("aggregate-view.test.js ok");
})().catch((e) => { console.error(e); process.exit(1); });
