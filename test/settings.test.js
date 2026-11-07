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
// Base auto-collect (Task 3): wallets.main.collect and the top-level baseCollect survive load -> toLegacy -> fromLegacy/save
{
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "settings.base.example.json"), "utf8"));
  const f0 = S.toLegacy(base);
  assert.strictEqual(f0.ownerCollect, false, "the shipped example has main.collect false");
  assert.ok(f0.wallets.list.length >= 2 && f0.wallets.list.every((w) => w.collect === false));
  assert.ok(f0.baseCollect && f0.baseCollect.minFeesUsd === 2 && !("_comment" in f0.baseCollect), "baseCollect is carried, comments stripped");
  const raw2 = JSON.parse(JSON.stringify(base));
  raw2.wallets.main.collect = true; raw2.baseCollect = { minFeesUsd: 9, maxCollectsPerRun: 2 };
  const f1 = S.toLegacy(raw2);
  assert.strictEqual(f1.ownerCollect, true); assert.deepStrictEqual(f1.baseCollect, { minFeesUsd: 9, maxCollectsPerRun: 2 });
  const sections = S.fromLegacy(f1, { owner: { label: f1.wallets.ownerLabel }, watched: f1.wallets.list }, {});
  assert.strictEqual(sections.wallets.main.collect, true); assert.deepStrictEqual(sections.baseCollect, { minFeesUsd: 9, maxCollectsPerRun: 2 });
  const f2 = S.toLegacy(sections);
  assert.strictEqual(f2.ownerCollect, true); assert.deepStrictEqual(f2.baseCollect, f1.baseCollect);
  // save() keeps both
  const file = path.join(require("os").tmpdir(), `settings-base-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify(raw2));
  const after = S.save((r) => { r.wallets.watched[0].collect = true; }, file);
  assert.strictEqual(after.ownerCollect, true); assert.strictEqual(after.baseCollect.minFeesUsd, 9); assert.strictEqual(after.wallets.list[0].collect, true);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(written.wallets.main.collect, true); assert.strictEqual(written.baseCollect.maxCollectsPerRun, 2);
  fs.unlinkSync(file);
  // absent stays absent: a settings file without them is unchanged by the new keys
  const plain = S.toLegacy(raw);
  assert.ok(!("ownerCollect" in plain) && !("baseCollect" in plain), "no new keys for a file that does not use them");
  assert.ok(!("collect" in S.fromLegacy(plain, null, {}).wallets.main), "and none written back");
  // the Base example still has no Robinhood-side sections
  for (const k of ["collector", "vault", "arm", "risk"]) assert.ok(!(k in base), `no ${k} section in the Base example`);
}
console.log("settings: sections map to the flat configuration, round trip, save and missing-file assertions passed");
