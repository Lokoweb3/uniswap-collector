// node test/settings.test.js — settings.json sections <-> the flat configuration the modules use.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const S = require("../settings");

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "settings.example.json"), "utf8"));
const flat = S.toLegacy(raw);
assert.strictEqual(flat.chainId, raw.chain.chainId);
assert.strictEqual(flat.ownerAddress, raw.wallets.main.address);
assert.strictEqual(flat.usdReference.stable, raw.tokens.USDG, "USDG written once, read as the USD reference");
assert.strictEqual(flat.contracts.weth, raw.tokens.WETH, "WETH written once, read as contracts.weth");
assert.strictEqual(flat.treasuryTBA, raw.vault.tba); assert.strictEqual(flat.feeSplitMax, raw.vault.feeSplitMax);
assert.deepStrictEqual(flat.wallets.list, raw.wallets.watched); assert.strictEqual(flat.wallets.ownerLabel, raw.wallets.main.label);
assert.strictEqual(flat.memecoins.length, raw.risk.memecoins.length); assert.deepStrictEqual(flat.memecoinCollect, raw.risk.autoCollect);
assert.strictEqual(flat.alerts.telegramChat, raw.alerts.telegramChat); assert.deepStrictEqual(flat.dailySummary, raw.alerts.dailySummary);
assert.ok(!("_comment" in flat.thresholds), "comment keys are stripped");
// round trip: legacy -> sections -> legacy keeps every leaf
const back = S.toLegacy(S.fromLegacy(flat, { owner: { label: flat.wallets.ownerLabel }, watched: flat.wallets.list }, { group: raw.alerts.telegramChat, main: raw.alerts.fallbackChat }));
const leaves = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (k.startsWith("_") ? [] : v && typeof v === "object" && !Array.isArray(v) ? leaves(v, p + k + ".") : [[p + k, JSON.stringify(v)]]));
for (const [k, v] of leaves(flat)) if (!["watchWallets", "wallets"].some((x) => k.startsWith(x))) assert.strictEqual(JSON.stringify(back).includes(v) || v === "null", true, k);
assert.strictEqual(back.ownerAddress, flat.ownerAddress); assert.strictEqual(back.usdReference.stable, flat.usdReference.stable);
// save() edits a section in place
const tmp = path.join(require("os").tmpdir(), `settings-test-${process.pid}.json`);
fs.writeFileSync(tmp, JSON.stringify(raw));
const edited = S.save((r) => { r.vault.withdrawAlertUsdg = 250; }, tmp);
assert.strictEqual(edited.treasuryWithdrawAlertUsdg, 250); assert.strictEqual(JSON.parse(fs.readFileSync(tmp, "utf8")).vault.withdrawAlertUsdg, 250);
fs.unlinkSync(tmp);
// a missing file says what to do
assert.throws(() => S.read(path.join(require("os").tmpdir(), "no-such-settings.json")), /copy settings.example.json/);
console.log("settings: sections map to the flat configuration, round trip, save and missing-file assertions passed");
