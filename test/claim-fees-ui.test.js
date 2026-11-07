// node test/claim-fees-ui.test.js -- claim-fees.js with a fake window.ethereum (records request() calls), a fake fetch and
// a capturing render function; plus the card markup from dashboard.js. No network, no real wallet.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..");
const core = require("../claim-fees-core");
const ClaimFees = require("../claim-fees");

const OWNER = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743";
const OTHER = "0x000000000000000000000000000000000000dEaD";
const MGR = "0x827922686190790b37229fd06084350E74485b72";
const HASH = "0x" + "ab".repeat(32);
const EVIL = "<img src=x onerror=alert(1)>";
const target = (o = {}) => ({ ok: true, chainId: 8453, chainName: "Base", explorer: "https://basescan.org", manager: MGR, tokenId: "79371151", owner: OWNER, protocol: "aerodrome-v1", staked: false, fee0: 0.002, fee1: 5, symbol0: "WETH", symbol1: "USDC", decimals0: 18, decimals1: 6, feesUsd: 9, feesOk: true, ...o });
const word = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");

/** A wallet: answers by method; records every request; `on` records listeners. */
function wallet(o = {}) {
  const w = { calls: [], listeners: {}, chain: o.chain || "0x2105", account: o.account || OWNER };
  w.request = async ({ method, params }) => {
    w.calls.push({ method, params });
    if (o.fail && o.fail[method]) throw o.fail[method];
    switch (method) {
      case "eth_requestAccounts": return [w.account];
      case "eth_chainId": return w.chain;
      case "wallet_switchEthereumChain": w.chain = params[0].chainId; return null;
      case "eth_call": return o.ownerOfResult || word(OWNER);
      case "eth_sendTransaction": return o.hash || HASH;
      default: throw new Error("unexpected " + method);
    }
  };
  w.on = (ev, fn) => { (w.listeners[ev] = w.listeners[ev] || []).push(fn); };
  w.removeListener = (ev, fn) => { w.listeners[ev] = (w.listeners[ev] || []).filter((x) => x !== fn); };
  w.sent = () => w.calls.filter((c) => c.method === "eth_sendTransaction");
  return w;
}
function ui(wal, t) {
  const html = []; const urls = [];
  const ctl = ClaimFees.create({
    fetch: async (u) => { urls.push(u); return { json: async () => (typeof t === "function" ? t() : t) }; },
    getEthereum: () => wal, render: (h) => html.push(h),
  });
  return { ctl, html, urls, last: () => html[html.length - 1] };
}
const text = (h) => String(h);

(async () => {
  // 8. happy path
  {
    const wal = wallet(); const u = ui(wal, target());
    await u.ctl.open("aerodrome-v1", "79371151");
    assert.deepStrictEqual(u.urls, ["/api/claim-fees/target?protocol=aerodrome-v1&id=79371151"]);
    let h = u.last();
    assert.ok(h.includes("0.002 WETH") && h.includes("5 USDC") && h.includes("$9.00") && /estimate, at current prices/.test(h), h);
    assert.ok(h.includes(MGR) && h.includes("0x8279...5b72") && h.includes(OWNER), "manager (short, full in title) and owner shown");
    assert.strictEqual(wal.calls.length, 0, "opening the panel touches no wallet method");
    await u.ctl.send();
    assert.strictEqual(wal.sent().length, 1);
    const tx = wal.sent()[0].params[0];
    assert.deepStrictEqual(Object.keys(tx).sort(), ["chainId", "data", "from", "to", "value"], "no gas or fee fields");
    assert.strictEqual(tx.chainId, "0x2105"); assert.strictEqual(tx.to, MGR); assert.strictEqual(tx.from, OWNER); assert.strictEqual(tx.value, "0x0");
    const iface = new ethers.Interface(["function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256, uint256)"]);
    assert.strictEqual(tx.data, iface.encodeFunctionData("collect", [{ tokenId: 79371151n, recipient: OWNER, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }]));
    h = u.last();
    assert.ok(h.includes(HASH) && h.includes(`href="https://basescan.org/tx/${HASH}"`) && h.includes('rel="noopener"'), h);
    assert.deepStrictEqual(wal.calls.map((c) => c.method), ["eth_requestAccounts", "eth_chainId", "eth_call", "eth_chainId", "eth_sendTransaction"]);
    const call = wal.calls[2].params[0];
    assert.strictEqual(call.to, MGR); assert.strictEqual(call.data, core.ownerOfCalldata(79371151n));
    // a second send on the finished panel does nothing
    await u.ctl.send(); assert.strictEqual(wal.sent().length, 1);
  }

  // 9. wrong account: nothing sent; the message names both
  {
    const wal = wallet({ account: OTHER }); const u = ui(wal, target());
    await u.ctl.open("aerodrome-v1", "79371151"); await u.ctl.send();
    assert.strictEqual(wal.sent().length, 0);
    assert.ok(u.last().includes("0xaDf9...d743") && u.last().includes("0x0000...dEaD"), u.last());
    assert.ok(!wal.calls.some((c) => c.method === "eth_call"), "stops before the ownerOf read");
  }

  // 10. wrong chain: switch first; rejection (4001, 4902) stops; success continues
  {
    const wal = wallet({ chain: "0x1" }); const u = ui(wal, target());
    await u.ctl.open("aerodrome-v1", "79371151"); await u.ctl.send();
    const methods = wal.calls.map((c) => c.method);
    assert.ok(methods.indexOf("wallet_switchEthereumChain") > -1 && methods.indexOf("wallet_switchEthereumChain") < methods.indexOf("eth_sendTransaction"));
    assert.deepStrictEqual(wal.calls.find((c) => c.method === "wallet_switchEthereumChain").params, [{ chainId: "0x2105" }]);
    assert.ok(!methods.includes("wallet_addEthereumChain"), "never adds a chain");
    assert.strictEqual(wal.sent().length, 1);
    for (const code of [4001, 4902]) {
      const w2 = wallet({ chain: "0x1", fail: { wallet_switchEthereumChain: Object.assign(new Error("no"), { code }) } }); const u2 = ui(w2, target());
      await u2.ctl.open("aerodrome-v1", "79371151"); await u2.ctl.send();
      assert.strictEqual(w2.sent().length, 0, `switch error ${code}`);
      assert.ok(!w2.calls.some((c) => c.method === "wallet_addEthereumChain"));
      assert.ok(/switch|Switch/.test(u2.last()));
    }
    // a wallet that says it switched but is still elsewhere sends nothing
    const w3 = wallet({ chain: "0x1" }); w3.request = ((orig) => async (r) => (r.method === "wallet_switchEthereumChain" ? (w3.calls.push(r), null) : orig(r)))(w3.request);
    const u3 = ui(w3, target()); await u3.ctl.open("aerodrome-v1", "79371151"); await u3.ctl.send();
    assert.strictEqual(w3.sent().length, 0);
  }

  // 11. the wallet's own ownerOf disagrees
  {
    const wal = wallet({ ownerOfResult: word(OTHER) }); const u = ui(wal, target());
    await u.ctl.open("aerodrome-v1", "79371151"); await u.ctl.send();
    assert.strictEqual(wal.sent().length, 0); assert.ok(/does not match/.test(u.last()));
    const w2 = wallet({ ownerOfResult: "0x" }); const u2 = ui(w2, target());
    await u2.ctl.open("aerodrome-v1", "79371151"); await u2.ctl.send();
    assert.strictEqual(w2.sent().length, 0, "an unreadable ownerOf is not a pass");
  }

  // 12. rejected in the wallet: message, no hash, button re-enabled and works again
  {
    const wal = wallet({ fail: { eth_sendTransaction: Object.assign(new Error("User rejected"), { code: 4001 }) } }); const u = ui(wal, target());
    await u.ctl.open("aerodrome-v1", "79371151"); await u.ctl.send();
    assert.ok(/Rejected in the wallet\. Nothing changed\./.test(u.last()));
    assert.ok(!u.last().includes(HASH) && !/class="cfhash"/.test(u.last()));
    assert.ok(/data-cf-act="send"(?! disabled)/.test(u.last()), "send button enabled again");
    assert.strictEqual(u.ctl.state.hash, null);
    // the connect prompt rejected too
    const w2 = wallet({ fail: { eth_requestAccounts: Object.assign(new Error("x"), { code: 4001 }) } }); const u2 = ui(w2, target());
    await u2.ctl.open("aerodrome-v1", "79371151"); await u2.ctl.send();
    assert.ok(/Rejected/.test(u2.last())); assert.strictEqual(w2.sent().length, 0);
  }

  // blocked cases: staked, nothing to collect, fee unreadable, wrong chain id from the server, mismatched token id
  {
    for (const [t, why] of [[target({ staked: true }), /Staked in the gauge/], [target({ fee0: 0, fee1: 0 }), /Nothing to collect/], [target({ feesOk: false }), /Fee read unavailable/],
      [target({ chainId: 1 }), /Cannot claim/], [target({ tokenId: "5" }), /Cannot claim/], [target({ manager: "nope" }), /Cannot claim/], [{ ok: false, error: "unknown protocol" }, /Cannot claim: unknown protocol/]]) {
      const wal = wallet(); const u = ui(wal, t);
      await u.ctl.open("aerodrome-v1", "79371151");
      assert.ok(why.test(u.last()), String(why) + " " + u.last());
      await u.ctl.send();
      assert.strictEqual(wal.calls.length, 0, "no wallet call");
      assert.ok(/data-cf-act="send" disabled/.test(u.last()));
    }
    // a bad reference never reaches fetch
    const u = ui(wallet(), target()); await u.ctl.open("a b", "1"); await u.ctl.open("aerodrome-v1", "1x");
    assert.deepStrictEqual(u.urls, []);
    // no wallet installed
    const none = ClaimFees.create({ fetch: async () => ({ json: async () => target() }), getEthereum: () => null, render: () => {} });
    await none.open("aerodrome-v1", "79371151"); await none.send();
    assert.ok(/No browser wallet/.test(none.panel()));
  }

  // account / chain change closes an idle panel, not one in flight
  {
    const wal = wallet(); const u = ui(wal, target());
    await u.ctl.open("aerodrome-v1", "79371151");
    assert.strictEqual(wal.listeners.accountsChanged.length, 1);
    wal.listeners.chainChanged[0]();
    assert.strictEqual(u.last(), null, "panel closed");
    assert.strictEqual(wal.listeners.accountsChanged.length, 0, "unsubscribed");
    // the switch we ask for ourselves fires chainChanged: must not close the panel
    const w2 = wallet({ chain: "0x1" });
    const origReq = w2.request; w2.request = async (r) => { const out = await origReq(r); if (r.method === "wallet_switchEthereumChain") (w2.listeners.chainChanged || []).forEach((f) => f()); return out; };
    const u2 = ui(w2, target()); await u2.ctl.open("aerodrome-v1", "79371151"); await u2.ctl.send();
    assert.strictEqual(w2.sent().length, 1);
  }

  // chain changes between the ownerOf check and the send: nothing is sent
  {
    const wal = wallet(); const u = ui(wal, target());
    const orig = wal.request;
    wal.request = async (r) => { const out = await orig(r); if (r.method === "eth_call") wal.chain = "0x1"; return out; };
    await u.ctl.open("aerodrome-v1", "79371151"); await u.ctl.send();
    assert.strictEqual(wal.sent().length, 0, "nothing sent off Base");
    assert.ok(/no longer on Base/.test(u.last()), u.last());
  }

  // a hostile server answer naming another manager: no panel action, nothing sent, message escaped
  {
    const wal = wallet(); const other = "0x00000000000000000000000000000000000000ee";
    const u = ui(wal, target({ manager: other, symbol0: EVIL }));
    await u.ctl.open("aerodrome-v1", "79371151");
    assert.ok(/Cannot claim/.test(u.last()) && !/<img/.test(u.last()), u.last());
    await u.ctl.send();
    assert.strictEqual(wal.calls.length, 0); assert.strictEqual(wal.sent().length, 0);
    // a manager swapped after the panel opened is refused at send time too
    const u2 = ui(wallet(), target()); await u2.ctl.open("aerodrome-v1", "79371151");
    u2.ctl.state.target.manager = other; await u2.ctl.send();
    assert.strictEqual(u2.ctl.state.phase, "error");
    // the allowlist compares case-insensitively
    const w3 = wallet(); const u3 = ui(w3, target({ manager: MGR.toLowerCase() }));
    await u3.ctl.open("aerodrome-v1", "79371151"); await u3.ctl.send();
    assert.strictEqual(w3.sent().length, 1);
  }

  // accountsChanged / chainChanged after the tx was sent keep the panel and the hash
  {
    const wal = wallet(); const u = ui(wal, target());
    await u.ctl.open("aerodrome-v1", "79371151"); await u.ctl.send();
    assert.strictEqual(u.ctl.state.phase, "sent");
    for (const ev of ["accountsChanged", "chainChanged"]) (wal.listeners[ev] || []).forEach((f) => f());
    assert.ok(u.last() && u.last().includes(HASH), "hash still visible");
  }

  // 13. hostile data
  {
    const evilTarget = target({ symbol0: EVIL, symbol1: '"><script>alert(1)</script>', explorer: "javascript:alert(1)", tokenId: "79371151" });
    const wal = wallet({ hash: '0x"><script>' }); const u = ui(wal, evilTarget);
    await u.ctl.open("aerodrome-v1", "79371151");
    for (const h of u.html) assert.ok(!/<img|<script|javascript:/i.test(text(h)), text(h));
    await u.ctl.send();
    for (const h of u.html) assert.ok(!/<img|<script|javascript:|href=/i.test(text(h)), text(h));
    assert.ok(!u.last().includes("cfhash"), "an invalid hash is not shown or linked");
    // valid hash but non-https / odd explorer: shown, not linked
    for (const explorer of ["javascript:alert(1)", "http://basescan.org", 'https://x.org/"><script>', null]) {
      const w2 = wallet(); const u2 = ui(w2, target({ explorer }));
      await u2.ctl.open("aerodrome-v1", "79371151"); await u2.ctl.send();
      assert.ok(u2.last().includes(HASH) && !/href=/.test(u2.last()), String(explorer));
    }
    // markup in a wallet error message
    const w3 = wallet({ fail: { eth_sendTransaction: new Error(EVIL + "<script>x</script>") } }); const u3 = ui(w3, target());
    await u3.ctl.open("aerodrome-v1", "79371151"); await u3.ctl.send();
    assert.ok(/Wallet error/.test(u3.last()) && !/<img|<script/i.test(u3.last()) && u3.last().includes("&lt;img"), u3.last());
    // a server error message with markup
    const u4 = ui(wallet(), { ok: false, error: EVIL }); await u4.ctl.open("aerodrome-v1", "79371151");
    assert.ok(!/<img/.test(u4.last()));
  }

  // 14. the card markup from dashboard.js (function injection)
  {
    const src = fs.readFileSync(path.join(ROOT, "dashboard.js"), "utf8");
    const fn = (name) => { const i = src.indexOf(`function ${name}(`); assert.ok(i >= 0, name); return src.slice(i, src.indexOf("\n}\n", i) + 3); };
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext([src.match(/^const esc = .*$/m)[0], src.match(/^const shortA = .*$/m)[0], "let CHAIN = { id: null }; let EXPLORER = null; const chainRef = (e, p, label) => label;",
      fn("claimFeesChain"), fn("claimFeesControl"), fn("platformMetric"), "this.ctl = claimFeesControl; this.pm = platformMetric; this.setChain = (i) => { CHAIN = { id: i }; };"].join("\n"), ctx);
    const base = { protocol: "aerodrome-v1", positionManager: MGR, nftId: "79371151", staked: false, feesOk: true, fee0: 0.002, fee1: 5, gauge: null };
    const d = { chainId: 8453 };
    const open = ctx.ctl(base, d);
    assert.ok(/<button type="button" class="claimbtn" data-protocol="aerodrome-v1" data-id="79371151" title/.test(open) && !/disabled/.test(open), open);
    assert.ok(!/data-[a-z-]+="0x/i.test(open) && !/0x[0-9a-fA-F]{40}/.test(open), "no address in the markup");
    const attrs = [...open.matchAll(/ (data-[a-z-]+)=/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(attrs, ["data-id", "data-protocol"]);
    const staked = ctx.ctl({ ...base, staked: true, gauge: "0x41b2126661C673C2beDd208cC72E85DC51a5320a", fee0: 0, fee1: 0 }, d);
    assert.ok(/<button[^>]* disabled /.test(staked) && /Staked in the gauge: trading fees go to the gauge&#39;s voters\. Rewards are claimed through the gauge, not here\./.test(staked), staked);
    const unread = ctx.ctl({ ...base, feesOk: false }, d);
    assert.ok(/<button[^>]* disabled /.test(unread) && /Fee read unavailable/.test(unread));
    const zero = ctx.ctl({ ...base, fee0: 0, fee1: 0 }, d);
    assert.ok(/<button[^>]* disabled /.test(zero) && /Nothing to collect/.test(zero));
    // not Slipstream, or not Base: no button at all
    assert.strictEqual(ctx.ctl({ version: 3, nftId: "5", positionManager: MGR }, d), "", "v3");
    assert.strictEqual(ctx.ctl({ version: 4, nftId: "5", tokenId: "v4-5" }, d), "", "v4");
    assert.strictEqual(ctx.ctl({ protocol: "pulsex-v2", kind: "v2lp", nftId: "x" }, d), "", "v2 LP");
    assert.strictEqual(ctx.ctl(base, { chainId: 4663 }), "", "another chain");
    ctx.setChain(8453); assert.ok(ctx.ctl(base, null).includes("claimbtn"), "falls back to the page's chain");
    // hostile protocol / id are escaped
    const ev = ctx.ctl({ ...base, protocol: '"><img src=x>', nftId: '1"><script>' }, d);
    assert.ok(!/<img|<script/.test(ev), ev);
    // the platform line
    assert.ok(/fees can be claimed with your browser wallet/.test(ctx.pm(base, d)));
    assert.ok(/through the gauge/.test(ctx.pm({ ...base, staked: true, gauge: base.positionManager }, d)));
    assert.ok(/read only: not collected, closed or sold here/.test(ctx.pm(base, { chainId: 4663 })), "other chains keep the old line");
    // card wiring: control is rendered from positionCard and the platform line gets d
    assert.ok(/\$\{claimFeesControl\(p, d\)\}/.test(src) && /platformMetric\(p, d\)/.test(src));
  }

  // the page loads both scripts before dashboard.js
  {
    const html = fs.readFileSync(path.join(ROOT, "dashboard.html"), "utf8");
    const i = html.indexOf("/claim-fees-core.js"), j = html.indexOf("/claim-fees.js"), k = html.indexOf("/dashboard.js");
    assert.ok(i > 0 && i < j && j < k);
  }
  console.log("claim-fees-ui tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
