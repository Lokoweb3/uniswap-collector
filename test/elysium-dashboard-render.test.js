// node test/elysium-dashboard-render.test.js -- dashboard.js with a native balance whose decimals are unverified
// (Elysium testnet): raw wei with a badge, kept out of the dust filter, amountRaw carried through watchedRows
// (never added as null), and every other chain's rows unchanged.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const dash = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
const grab = (re) => { const m = re.exec(dash); assert.ok(m, `dashboard.js has ${re}`); return m[0]; };
const watchedSrc = grab(/function watchedRows\(w\)\{[\s\S]*?\n\}\n/);
const mergeSrc = grab(/function mergeRows\(lists\)\{[\s\S]*?\n\}\n/);
const rawSrc = grab(/const rawWei = x => .*\n/);
const api = new Function(`const NATIVE_KEY = "native", ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
${watchedSrc}\n${mergeSrc}\n${rawSrc}\nreturn { watchedRows, mergeRows, rawWei };`)();

const TOKEN = "0x" + "ab".repeat(20);
// a watched wallet on the testnet: a native holding with unknown decimals
const w = { holdings: { tokens: [{ native: true, symbol: "HYPE", address: null, amount: null, amountRaw: "489000000000000000", decimalsUnverified: true, price: null }] }, positions: [], external: [] };
{
  const rows = api.watchedRows(w);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].walletRaw, "489000000000000000", "amountRaw is carried");
  assert.strictEqual(rows[0].decimalsUnverified, true);
  assert.strictEqual(rows[0].wallet, 0, "the null amount was not added (no NaN, no null)");
  const merged = api.mergeRows([rows, api.watchedRows(w)]);
  assert.strictEqual(merged[0].walletRaw, "978000000000000000", "raw amounts of several wallets are summed as integers");
  assert.ok(merged[0].decimalsUnverified && Number.isFinite(merged[0].total));
  const html = api.rawWei(merged[0]);
  assert.ok(html.includes("978000000000000000 wei") && html.includes("decimals unverified"), html);
}
// other chains unchanged: a normal native and a token carry no raw fields
{
  const ok = { holdings: { tokens: [{ native: true, symbol: "ETH", amount: 1.5, price: 2000 }, { symbol: "T", address: TOKEN, amount: 2, price: 1 }] }, positions: [], external: [] };
  const rows = api.watchedRows(ok);
  assert.strictEqual(rows.find((r) => r.native).wallet, 1.5);
  assert.ok(rows.every((r) => !("walletRaw" in r) && !("decimalsUnverified" in r)));
  const merged = api.mergeRows([rows]);
  assert.ok(merged.every((r) => !("walletRaw" in r) && !("decimalsUnverified" in r)));
}
// renderPortfolio: the row stays out of the dust filter and prints the raw figure in Wallet and Total; others use q()/amount()
{
  assert.ok(/rows\.filter\(x => showDust \|\| x\.decimalsUnverified \|\| \(x\.usd == null \? x\.source === 'pools' : x\.usd >= 1\)\)/.test(dash), "unverified rows are exempt from the dust filter, the rest of the filter is unchanged");
  assert.ok(/<td>\$\{x\.decimalsUnverified \? rawWei\(x\) : q\(x\.wallet\)\}<\/td>/.test(dash));
  assert.ok(/<td>\$\{x\.decimalsUnverified \? rawWei\(x\) : `<b>\$\{amount\(x\.total\)\}<\/b>`\}<\/td>/.test(dash));
}
console.log("elysium dashboard render: raw wei + badge, dust exemption, amountRaw carried, other chains unchanged passed");
