// node test/wallet-overview-scope.test.js — on the Dashboard, the Wallet overview
// panel appears only when the Wallet picker is on "All wallets".
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "dashboard.js"), "utf8");
const from = src.indexOf("\nfunction renderWalletPanel(");
assert.ok(from >= 0, "renderWalletPanel is gone from dashboard.js");
const body = src.slice(from, src.indexOf("\n}\n", from) + 3);
const html = fs.readFileSync(path.join(__dirname, "..", "dashboard.html"), "utf8");
assert.match(html, /<section[^>]*id="walletpanel"[^>]*\bhidden\b/, "the panel starts hidden, so a single-wallet view never flashes it");

function run({ scope, pickerHidden = false, picker = true }) {
  const el = (extra = {}) => ({ hidden: false, innerHTML: "", textContent: "", ...extra });
  const els = { "#walletbars": el(), "#walletpanelnote": el(), "#walletpaneltotal": el(), "#walletpanel": el({ hidden: true }) };
  if (picker) els["#pfscope"] = el({ hidden: pickerHidden });
  const f = new Function("$", "pfScope", "lastMain", "lastPortfolio", "lastWatchForPf", "usd", "esc", "shortA", "ownerLabel",
    body + "; return renderWalletPanel;")(
    (s) => els[s] || null, () => scope, null, null, null, (n) => "$" + n, (s) => String(s), (s) => s, () => "Main");
  f();
  return els;
}

const all = run({ scope: "all" });
assert.strictEqual(all["#walletpanel"].hidden, false, "All wallets shows the overview");
assert.match(all["#walletbars"].innerHTML, /No wallet values yet/, "and draws it");

for (const [why, opts] of [
  ["the main wallet alone", { scope: "owner" }],
  ["one watched wallet", { scope: "0xb1cdc09b4c7f28365a8e7bfa2332af54f5462af5" }],
  ["no picker (no watched wallets)", { scope: "all", pickerHidden: true }],
  ["a page without the picker", { scope: "all", picker: false }],
]) {
  const e = run(opts);
  assert.strictEqual(e["#walletpanel"].hidden, true, `the overview is hidden for ${why}`);
  assert.strictEqual(e["#walletbars"].innerHTML, "", `and not drawn for ${why}`);
}
console.log("wallet overview: shown only for All wallets");
