// node test/wallet-escape.test.js -- token symbols, labels and history text are escaped in the Sell/Mint/Approve tabs.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ROOT, "wallet.html"), "utf8");
const lines = html.split("\n");
const evil = "<img src=x onerror=alert(1)>";
const escHtml = (x) => String(x == null ? "" : x).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const find = (re) => { const l = lines.find((x) => re.test(x)); assert.ok(l, "found " + re); return l; };
// Evaluate the right-hand side of an `x.innerHTML = <expr>;` line in a sandbox.
function rhs(line, sandbox) {
  const expr = line.replace(/^.*?\.innerHTML = /, "").replace(/;\s*$/, "");
  return vm.runInNewContext(expr, { escHtml, usdF: (n) => "$" + n, short: (a) => a, ...sandbox });
}

{ // Sell token list
  const out = rhs(find(/q\('sl-token'\)\.innerHTML = data\.rows/), { data: { rows: [{ address: "0xabc", symbol: evil, balance: 1, usd: 2 }] } });
  assert.ok(!out.includes("<img"), out);
  assert.ok(out.includes("&lt;img src=x onerror=alert(1)&gt;"), "shown as text");
}
{ // token info
  const out = rhs(find(/q\('sl-tokinfo'\)\.innerHTML = /), { t: { priceUsd: 1, change1hPct: 0, change24hPct: 0, balance: 1, symbol: evil, usd: 1 }, pctF: () => "", Number });
  assert.ok(!out.includes("<img"), out);
}
{ // sell history
  const out = rhs(find(/q\('sl-historyrows'\)\.innerHTML = /), { history: [{ at: 0, amount: 1, symbol: evil, out: evil, usd: null, explorer: "https://x", tx: '"><b>' }] });
  assert.ok(!/<img|<b>/.test(out), out);
}
{ // mint token options and history
  const tokOpt = vm.runInNewContext(find(/const tokOpt = /).replace(/^\s*const tokOpt = /, "").replace(/;\s*$/, ""), { escHtml, usdF: (n) => "$" + n });
  const out = tokOpt({ address: '"><script>', symbol: evil, usd: null });
  assert.ok(!/<img|<script/.test(out), out);
  const h = rhs(find(/q\('mt-historyrows'\)\.innerHTML = /), { history: [{ at: 0, label: evil, text: evil, usd: null, tx: "0x1" }], ctx: { explorer: "https://x" } });
  assert.ok(!h.includes("<img"), h);
  const pools = rhs(find(/q\('mt-pool'\)\.innerHTML = pools\.map/), { pools: [{ label: evil, liquidity: "1" }], BigInt });
  assert.ok(!pools.includes("<img"), pools);
  const from = rhs(find(/q\('mt-from'\)\.innerHTML = ctx\.positions/), { ctx: { positions: [{ version: 4, tokenId: "1", pair: evil, valueUsd: 1, inRange: true }] } });
  assert.ok(!from.includes("<img"), from);
}
{ // approve tab: wallet list and revoke-other
  const w = rhs(find(/\[data-id="wallets"\]'\)\.innerHTML = /), { cfg: { wallets: [{ address: "0x1", label: evil }] }, account: null });
  assert.ok(!w.includes("<img"), w);
  const o = rhs(find(/\[data-id="others"\]'\)\.innerHTML = /), { others: [{ address: '"><img src=x>' }], account: null, chainOk: false });
  assert.ok(!o.includes("<img"), o);
  assert.ok(/data-op="&quot;&gt;/.test(o), "data-op attribute escaped");
}
// No statusHtml interpolates an unescaped short(); no innerHTML option line interpolates a bare symbol/label.
for (const l of lines) {
  if (/statusHtml\(/.test(l) && !/const statusHtml/.test(l)) assert.ok(!/\$\{short\(/.test(l), l.trim().slice(0, 90));
  if (/<option/.test(l) && /innerHTML|insertAdjacentHTML|tokOpt =/.test(l)) assert.ok(!/\$\{(t|p|h|w|pool)\.(symbol|label|address|pair)\}/.test(l), "unescaped option: " + l.trim().slice(0, 90));
}

// Line scan: every ${...} inside an innerHTML template that interpolates a data field must be wrapped in a safe call.
// Allow-list (documented): escHtml(...) (and its alias esc(...)), healthBadge(...) (escapes internally), usdF(...), fmt(...), num(...), pctF(...), ago(...) and numeric .toFixed(...) results
// (all return escaped or purely numeric text), plus short(account) -- the connected wallet's own address, which is
// hex from the wallet provider. Conditions before a ternary '?' only choose a branch and are not output, so they are ignored.
const TAINTED = /\b(symbol|label|spender|spenderLabel|token|manager|operator|holder|admin|tba|pair|address|text|name|error)\b|\bshort\(/;
function stripCalls(e) { // remove balanced safe calls: escHtml(...), usdF(...), ...
  const re = /\b(escHtml|esc|healthBadge|usdF|fmt|num|pctF|ago)\(/g; let m;
  while ((m = re.exec(e))) {
    let depth = 1, j = m.index + m[0].length;
    while (j < e.length && depth) { if (e[j] === "(") depth++; else if (e[j] === ")") depth--; j++; }
    e = e.slice(0, m.index) + "0" + e.slice(j); re.lastIndex = 0;
  }
  return e;
}
function interpolations(line) {
  const out = []; let i = 0;
  while ((i = line.indexOf("${", i)) >= 0) {
    let depth = 1, j = i + 2;
    while (j < line.length && depth) { const c = line[j]; if (c === "{") depth++; else if (c === "}") depth--; j++; }
    const inner = line.slice(i + 2, j - 1).trim();
    out.push(inner.replace(/`[^`]*`/g, "''"), ...interpolations(inner)); i = j; // nested templates are checked on their own
  }
  return out;
}
function unsafe(expr) {
  let e = expr;
  const q = e.indexOf(" ? ");
  if (q > 0) e = e.slice(q + 3);
  e = stripCalls(e).replace(/\$\{[^}]*\}/g, "").replace(/'[^']*'|"[^"]*"/g, "''").replace(/^\s*short\(account\)\s*$/, "0");
  if (/\.toFixed\(\d*\)\s*$/.test(e)) return false;
  return TAINTED.test(e);
}
const scanned = [];
const offenders = [];
lines.forEach((l, n) => {
  if (!(/innerHTML\s*=|insertAdjacentHTML|tokOpt =|statusHtml\(/.test(l) || /^\s*<(td|div|span|tr|option|b)\b/.test(l)) || !l.includes("${")) return;
  scanned.push(n + 1);
  for (const e of interpolations(l)) if (unsafe(e)) offenders.push(`${n + 1}: \${${e.slice(0, 70)}}`);
});
assert.ok(scanned.length > 40, "line scan covers the templates (" + scanned.length + ")");
assert.deepStrictEqual(offenders, [], "unescaped interpolations in innerHTML templates:\n" + offenders.join("\n"));
// The scanner itself catches what it should.
assert.ok(unsafe("short(r.token)") && unsafe("o.operator") && unsafe("l.label") && unsafe("v.tba || '-'"));
assert.ok(!unsafe("escHtml(short(r.token))") && !unsafe("(r.x).toFixed(2)") && !unsafe("short(account)") && !unsafe("v.holder === a ? 'main' : 'other'"));

// Server side: /api/sell/tokens strips markup characters from symbols and never returns an empty one.
const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
assert.ok(/replace\(\/\[\^A-Za-z0-9 \._\$\+-\]\/g, ""\)\.slice\(0, 16\)/.test(serverSrc), "sell/tokens sanitises the symbol");
{
  const m = serverSrc.match(/function cleanSymbol\([\s\S]*?\n}\n/);
  assert.ok(m, "cleanSymbol helper present");
  const cleanSymbol = vm.runInNewContext("(" + m[0].replace(/^function cleanSymbol/, "function") + ")");
  assert.strictEqual(cleanSymbol("<>", "0x1234567890abcdef"), "0x12345678", "empty after sanitising falls back to address slice");
  assert.strictEqual(cleanSymbol("<b>USDC</b>", "0x1"), "bUSDCb");
}
assert.ok(/symbol: cleanSymbol\(meta\.symbol \|\| h\.symbol, meta\.address\)/.test(serverSrc), "sell/tokens uses cleanSymbol");
console.log("wallet-escape ok");
