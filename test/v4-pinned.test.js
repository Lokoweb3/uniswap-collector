// node test/v4-pinned.test.js -- pinned Uniswap v4 ids (wallets.main.v4Ids / wallets.watched[].v4Ids):
// used when discovery found nothing, never persisted, verified with ownerOf (a pin that is not ours is
// reported, not shown and not tombstoned), invalid entries ignored and named. Fake provider + the Base
// example server on a stubbed chain; no network.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "v4pin-"));
process.env.LP_DATA_DIR = TMP;
process.on("exit", () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* gone */ } });

const v4 = require("../univ4");
const S = require("../settings");
const base = require("./lib/base-v4-server");

const POSM = "0x" + "11".repeat(20);
const OWNER = "0x" + "22".repeat(20);
const WALLET = "0xaDf94A20558E1E6d64c429F8F9f017169BF3d743";
const OTHER = "0x00000000000000000000000000000000000000ee";
const stateFile = (n) => path.join(TMP, n + ".json");
// a provider whose log scan finds nothing and never reaches block 0 (the live Base case)
const blindProvider = () => ({ async getBlockNumber() { return 100_000; }, async getLogs() { throw new Error("403 Forbidden"); } });

// load the Base example with the raw JSON literal 12345678901234567891 (a number past 2^53) as a pin
function settingsLoad() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "settings.base.example.json"), "utf8"));
  raw.wallets.main.v4Ids = ["__BIG__"]; raw.wallets.watched[0].v4Ids = ["__BIG__"];
  const f = path.join(fs.mkdtempSync(path.join(TMP, "big-")), "settings.json");
  fs.writeFileSync(f, JSON.stringify(raw).replace(/"__BIG__"/g, "12345678901234567891"));
  return S.load({ file: f });
}

(async () => {
  // ---- 1. pins are used, unioned, not persisted, removable ---------------------
  {
    const file = stateFile("pins");
    fs.writeFileSync(file, JSON.stringify({ ids: [], complete: false }));
    const d = v4.createDiscovery({ provider: blindProvider(), posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: file, pinnedIds: [11, "22", 11] });
    assert.deepStrictEqual(await d.discover(5), ["11", "22"]);
    assert.strictEqual(d.status.pinned, 2);
    assert.strictEqual(d.status.complete, false);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).ids, [], "pins are not written into the state file");
    assert.deepStrictEqual(d.pinned, ["11", "22"]);
    d.setPinned([]);
    assert.deepStrictEqual(await d.discover(5), [], "removing the pin removes the position");
    assert.strictEqual(d.status.pinned, 0);
    d.setPinned(["33"]);
    assert.deepStrictEqual(await d.discover(5), ["33"]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).ids, []);

    // union with discovered ids, no duplicates
    const file2 = stateFile("union");
    fs.writeFileSync(file2, JSON.stringify({ ids: ["5", "11"], complete: false }));
    const d2 = v4.createDiscovery({ provider: blindProvider(), posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: file2, pinnedIds: [11, 7] });
    assert.deepStrictEqual((await d2.discover(5)).sort(), ["11", "5", "7"]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file2, "utf8")).ids.sort(), ["11", "5"]);

    // without pins the return value is exactly the old one
    const file3 = stateFile("nopin");
    fs.writeFileSync(file3, JSON.stringify({ ids: ["9", "4"], complete: false }));
    const d3 = v4.createDiscovery({ provider: blindProvider(), posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: file3 });
    assert.deepStrictEqual(await d3.discover(5), ["9", "4"]);
    assert.strictEqual(d3.status.pinned, 0);
  }

  // ---- 3. invalid pins are ignored without throwing, and named -----------------
  {
    const many = Array.from({ length: 201 }, (_, i) => i + 1);
    const r = v4.parsePinnedIds([-1, "abc", "1e3", 1.5, null, { a: 1 }, ...many]);
    assert.strictEqual(r.ids.length, 194, "200 entries are considered; the 6 junk entries took 6 of them");
    assert.deepStrictEqual(r.invalid.slice(0, 6), ["-1", "abc", "1e3", "1.5", "null", '{"a":1}']);
    assert.strictEqual(r.invalid.length, 6 + 7, "the 201st..207th entries are over the limit");
    assert.deepStrictEqual(v4.parsePinnedIds(["007", "7", 7]).ids, ["7"], "canonical decimal, duplicates collapsed");
    assert.deepStrictEqual(v4.parsePinnedIds("5").ids, ["5"], "a bare scalar is a one-element list");
    assert.deepStrictEqual(v4.parsePinnedIds(undefined), { ids: [], invalid: [], invalidMore: 0 });
    assert.deepStrictEqual(v4.parsePinnedIds(["9".repeat(79)]).ids, [], "more than 78 digits");
    const d = v4.createDiscovery({ provider: blindProvider(), posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: stateFile("bad"), pinnedIds: [-1, "abc", "1e3", 4] });
    assert.deepStrictEqual(await d.discover(5), ["4"]);
    assert.deepStrictEqual(d.pinnedInvalid, ["-1", "abc", "1e3"]);
    const w = v4.discoveryWarnings({ wallet: OWNER, chainId: 8453, status: d.status, balanceOf: 1, knownOwned: 1, pinnedInvalid: d.pinnedInvalid });
    assert.deepStrictEqual(w.map((x) => x.code), ["v4-discovery-incomplete", "v4-pinned-invalid"]);
    assert.deepStrictEqual(w[1].ids, ["-1", "abc", "1e3"]);
  }

  // ---- S1/S2/S3: unsafe numbers, > uint256, huge lists ------------------------
  {
    const r = v4.parsePinnedIds([12345678901234567891, "2" + "0".repeat(77), String(2n ** 256n), String(2n ** 256n - 1n), 5]);
    assert.deepStrictEqual(r.ids, [String(2n ** 256n - 1n), "5"], "uint256 max is the ceiling");
    assert.strictEqual(r.invalid.length, 3, "unsafe JSON number, 78-digit > 2^256, 2^256");
    const sf = settingsLoad();
    assert.deepStrictEqual(v4.parsePinnedIds(sf.ownerV4Ids).ids, [], "main: unsafe number is invalid, not a different id");
    assert.deepStrictEqual(v4.parsePinnedIds(sf.wallets.list[0].v4Ids).ids, [], "watched: same");
    assert.strictEqual(v4.parsePinnedIds(sf.ownerV4Ids).invalid.length, 1);
    const huge = Array.from({ length: 10000 }, (_, i) => "x" + i);
    const h = v4.parsePinnedIds(huge);
    assert.strictEqual(h.invalid.length, 20);
    assert.strictEqual(h.invalidMore, 10000 - 20);
    const w = v4.discoveryWarnings({ wallet: OWNER, chainId: 8453, status: { complete: true }, pinnedInvalid: h.invalid, pinnedInvalidMore: h.invalidMore });
    assert.ok(w[0].message.endsWith(" and 9980 more") && w[0].message.length < 400 && w[0].ids.length === 20, w[0].message.slice(-60));
    const h2 = v4.parsePinnedIds(Array.from({ length: 10000 }, (_, i) => i));
    assert.strictEqual(h2.ids.length, 200); assert.strictEqual(h2.invalid.length, 20); assert.strictEqual(h2.invalidMore, 10000 - 200 - 20);
  }

  // ---- balance(): number on success, null on any failure -----------------------
  {
    const d = v4.createDiscovery({ provider: blindProvider(), posmAddress: POSM, owner: OWNER, explorerApi: "", stateFile: stateFile("bal") });
    assert.strictEqual(await d.balance(), null, "a provider that cannot call: null, not a throw");
  }

  // ---- 4. settings.js carries v4Ids ---------------------------------------------
  {
    const file = path.join(__dirname, "..", "settings.base.example.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepStrictEqual(raw.wallets.main.v4Ids, []);
    assert.ok(raw.wallets.watched.every((w) => Array.isArray(w.v4Ids) && w.v4Ids.length === 0));
    assert.ok(/v4Ids: Uniswap v4 token ids pinned for this wallet/.test(raw.wallets._comment));
    for (const k of ["collector", "vault", "arm", "risk"]) assert.ok(!(k in raw), `the Base example has no ${k}`);
    const dir = fs.mkdtempSync(path.join(TMP, "set-"));
    const f = path.join(dir, "settings.json");
    const r2 = JSON.parse(JSON.stringify(raw));
    r2.wallets.main.v4Ids = [123, "456"]; r2.wallets.watched[0].v4Ids = [7, 8];
    fs.writeFileSync(f, JSON.stringify(r2));
    const flat = S.load({ file: f });
    assert.deepStrictEqual(flat.ownerV4Ids, [123, "456"]);
    assert.deepStrictEqual(flat.wallets.list[0].v4Ids, [7, 8]);
    assert.deepStrictEqual(flat.watchWallets[0].v4Ids, [7, 8]);
    const sections = S.fromLegacy(flat, { owner: { label: flat.wallets.ownerLabel }, watched: flat.wallets.list }, {});
    assert.deepStrictEqual(sections.wallets.main.v4Ids, [123, 456]);
    assert.deepStrictEqual(sections.wallets.watched[0].v4Ids, [7, 8]);
    const back = S.toLegacy(sections);
    assert.deepStrictEqual(v4.parsePinnedIds(back.ownerV4Ids).ids, v4.parsePinnedIds(flat.ownerV4Ids).ids, "same pins after the round trip");
    assert.deepStrictEqual(back.wallets.list, flat.wallets.list);
    const saved = S.save((r) => { r.wallets.watched[1].collect = true; }, f);
    assert.deepStrictEqual(saved.ownerV4Ids, [123, "456"]);
    const onDisk = JSON.parse(fs.readFileSync(f, "utf8"));
    assert.deepStrictEqual(onDisk.wallets.main.v4Ids, [123, "456"], "save leaves the file's own v4Ids alone");
    // absent -> []
    const r3 = JSON.parse(JSON.stringify(raw)); delete r3.wallets.main.v4Ids; fs.writeFileSync(f, JSON.stringify(r3));
    assert.deepStrictEqual(S.load({ file: f }).ownerV4Ids, []);
    assert.ok(!("v4Ids" in S.fromLegacy(S.load({ file: f }), null, {}).wallets.main), "nothing written back when there are no pins");
    assert.deepStrictEqual(S.load({ file }).ownerV4Ids, [], "the shipped example pins nothing");
  }

  // ---- R2/R3/S3/S5: denylisted owned id, pins re-read per build, bounded response ----
  {
    const srv = await base.start({
      mutate: (s) => { s.wallets.main.v4Ids = [11, 12]; s.collector = { ...(s.collector || {}), denylist: ["v4-12"] }; },
      stubV4: { balance: 2, owned: [11, 12] },
      logsFail: true,
    });
    try {
      const d = JSON.parse((await srv.get("/api/positions")).body);
      assert.deepStrictEqual(d.positions.filter((p) => p.version === 4).map((p) => p.nftId), ["11"], "12 is denylisted");
      assert.ok(!d.warnings.some((x) => x.code === "v4-balance-exceeds-known"), "a denied owned id is not missing: " + JSON.stringify(d.warnings));
    } finally { await srv.stop(); }
    const big = await base.start({
      mutate: (s) => { s.wallets.main.v4Ids = Array.from({ length: 10000 }, (_, i) => "bad" + i); },
      stubV4: { balance: 0, owned: [] }, logsFail: true,
    });
    try {
      const r = await big.get("/api/positions");
      const d = JSON.parse(r.body);
      const inv = d.warnings.find((x) => x.code === "v4-pinned-invalid");
      assert.ok(inv && inv.ids.length === 20 && /and 9980 more$/.test(inv.message), JSON.stringify(inv).slice(0, 300));
      assert.ok(JSON.stringify(d.warnings).length < 5000, "warning payload bounded");
    } finally { await big.stop(); }
  }

  // ---- 2. HTTP: a pin owned by someone else is not shown, not tombstoned, reported ----
  {
    const srv = await base.start({
      mutate: (s) => { s.wallets.main.v4Ids = [11, "22", -1, "abc"]; },
      stubV4: { balance: 1, owned: [11], foreign: { 22: OTHER } },
      logsFail: true,
    });
    try {
      const r = await srv.get("/api/positions");
      assert.strictEqual(r.status, 200, r.body.slice(0, 300));
      const d = JSON.parse(r.body);
      const v4s = d.positions.filter((p) => p.version === 4);
      assert.deepStrictEqual(v4s.map((p) => p.nftId), ["11"], "only the owned pin is a card");
      assert.strictEqual(v4s[0].tokenId, "v4-11");
      assert.ok(Array.isArray(d.warnings));
      const no = d.warnings.find((x) => x.code === "v4-pinned-not-owned");
      assert.ok(no && no.severity === "warn" && JSON.stringify(no.ids) === '["22"]', JSON.stringify(d.warnings));
      const inv = d.warnings.find((x) => x.code === "v4-pinned-invalid");
      assert.ok(inv && JSON.stringify(inv.ids) === '["-1","abc"]', JSON.stringify(d.warnings));
      assert.ok(!d.warnings.some((x) => x.code === "v4-balance-exceeds-known"), "balance 1 == 1 known");
      const st = JSON.parse(fs.readFileSync(srv.dataFile("v4-positions.json"), "utf8"));
      assert.deepStrictEqual(st.ids, [], "pins never reach the persisted state");
      assert.ok(!st.gone || Object.keys(st.gone).length === 0, "the not-owned pin is not tombstoned: " + JSON.stringify(st.gone));
      assert.ok(!d.errors.some((e) => /22/.test(String(e.tokenId))), "a not-owned pin is a warning, not a read error");
    } finally { await srv.stop(); }
  }

  console.log("v4-pinned tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
