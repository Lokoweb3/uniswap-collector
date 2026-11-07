// node test/collector-base-settle.test.js -- TASK L1: sign first, record hash and nonce, then broadcast; settle every
// recorded entry at the next run start; strict state validation; exact manager. All on a mocked chain, no network.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ethers } = require("ethers");

const { TMP, MGR_A, MGR_B, OP, exampleRaw, cfgOf, enableMain, scene, fakeSigner, pass } = require("./lib/base-scene"); // sets LP_DATA_DIR first
const L = require("../collector-base-logic");
const { hermeticEnv, hermeticCwd } = require("./lib/hermetic");

const DAY = 86400_000;
const NOW = Date.now();
const FLOOR = 20_000_000_000_000n;
const GAS_LIMIT = 187_500n, MAX_FEE = 61_000_000n;
const WORST = GAS_LIMIT * MAX_FEE + FLOOR; // what a normal send of this scene reserves
const dayCap = ethers.parseUnits("0.001", 18);
const H = (c) => "0x" + c.repeat(32);
const TX = H("ab");
const noneApproved = { approved: { [MGR_A]: false, [MGR_B]: false } };
const entry = (o = {}) => ({ t: NOW - 3600_000, wei: String(WORST), kind: "reserved", tx: TX, nonce: 3, from: OP, to: MGR_A, gasLimit: String(GAS_LIMIT), maxFeePerGas: String(MAX_FEE), l1: String(FLOOR), ...o });
const rcOf = (o = {}) => ({ hash: TX, from: OP, to: MGR_A, blockNumber: 5, blockHash: H("cd"), status: 1, gasUsed: 100_000n, gasPrice: 50_000_000n, ...o });
const cost = (gasUsed, price) => BigInt(gasUsed) * BigInt(price) + FLOOR;
/** A pass at the fixed clock over `gasSpends`; the mocked chain is configured by `setup(w)`. */
async function run(gasSpends, { setup = () => {}, sc = noneApproved, mode = "collect", extra = {}, cfg = cfgOf(enableMain), at = NOW } = {}) {
  const w = scene(sc); setup(w);
  const r = await pass(w, { cfg, mode, state: { gasSpends }, extra: { now: () => at, ...extra } });
  return { w, r, e: r.state.gasSpends };
}
const noStack = (text) => assert.ok(!/ {4}at /.test(text), "no stack in the log");

(async () => {
  // ---- 1-2. sign -> save (reservation already on disk) -> broadcast; the signed bytes are what was asked for and quoted
  {
    const w = scene(); const calls = []; const snapshots = [];
    const signer = fakeSigner(w, { log: calls });
    const quoted = [];
    w.on("0x420000000000000000000000000000000000000f", "getL1Fee", (data) => { quoted.push(data); return [0n]; });
    const r = await pass(w, { cfg: cfgOf(enableMain), signer, extra: { saveState: (s) => { calls.push("save"); snapshots.push(JSON.parse(JSON.stringify(s))); } } });
    assert.deepStrictEqual(calls.slice(0, 3), ["sign", "save", "broadcast"], "sign, then the first save, then the broadcast");
    assert.strictEqual(r.res.collected, 2);
    const raw0 = signer.sent[0].raw, p0 = ethers.Transaction.from(raw0);
    const first = snapshots[0].gasSpends[0];
    assert.strictEqual(snapshots[0].gasSpends.length, 1);
    assert.deepStrictEqual(Object.keys(first).sort(), ["from", "gasLimit", "kind", "l1", "maxFeePerGas", "maxPriorityFeePerGas", "nonce", "t", "to", "tx", "wei"]);
    assert.strictEqual(first.kind, "reserved"); assert.strictEqual(first.tx, p0.hash); assert.strictEqual(first.nonce, 7); assert.strictEqual(first.from, OP); assert.strictEqual(first.to, MGR_A);
    assert.strictEqual(first.maxPriorityFeePerGas, String(p0.maxPriorityFeePerGas)); assert.strictEqual(first.gasLimit, String(GAS_LIMIT)); assert.strictEqual(first.maxFeePerGas, String(MAX_FEE)); assert.strictEqual(first.wei, String(WORST)); assert.strictEqual(first.l1, String(FLOOR));
    assert.strictEqual(w.broadcasts[0], raw0);
    // 2: the decoded bytes
    assert.strictEqual(p0.type, 2); assert.strictEqual(p0.chainId, 8453n); assert.strictEqual(p0.to, MGR_A); assert.strictEqual(p0.value, 0n); assert.strictEqual(p0.nonce, 7);
    assert.ok(p0.maxFeePerGas <= L.gweiToWei(1) && p0.maxPriorityFeePerGas <= p0.maxFeePerGas);
    assert.strictEqual(quoted[0], p0.unsignedSerialized, "the oracle was shown exactly the unsigned form of the signed bytes");
    assert.strictEqual(ethers.Transaction.from(signer.sent[1].raw).nonce, 8, "the next send uses the next nonce");
  }

  // ---- 3. a signer that signs something else
  {
    const stranger = ethers.Wallet.createRandom();
    for (const [what, opts] of [["to", { signTweak: (t) => ({ ...t, to: t.to === MGR_A ? MGR_B : MGR_A }) }], ["nonce", { signTweak: (t) => ({ ...t, nonce: t.nonce + 1 }) }], ["from", { key: stranger }]]) {
      const w = scene(); const signer = fakeSigner(w, opts); const saves = [];
      const r = await pass(w, { cfg: cfgOf(enableMain), signer, extra: { saveState: (s) => saves.push(s) } });
      assert.strictEqual(w.broadcasts.length, 0, what); assert.strictEqual(saves.length, 0, `${what}: nothing saved`); assert.strictEqual(r.res.collected, 0);
      assert.strictEqual(r.lines.filter((l) => new RegExp(`signing refused: the signed transaction differs from the one asked for \\(.*${what}`).test(l)).length, 2, `${what}: named, once per position, the run went on\n${r.text}`);
      assert.strictEqual(signer.signs.length, 2, `${what}: the second position was still tried`);
      assert.ok(!r.res.aborted, what);
    }
  }

  // ---- 4. the reservation cannot be saved: no broadcast, abort, no second send
  {
    const w = scene(); const signer = fakeSigner(w);
    const r = await pass(w, { cfg: cfgOf(enableMain), signer, extra: { saveState: () => { throw new Error("disk full"); } } });
    assert.strictEqual(w.broadcasts.length, 0); assert.strictEqual(r.res.aborted, true); assert.ok(r.lines.some((l) => /^STOP:/.test(l)), r.text);
    assert.strictEqual(signer.signs.length, 1, "the second qualifying position is not sent"); assert.strictEqual(r.lines.filter((l) => /^  sending #/.test(l)).length, 1);
  }

  // ---- 5. a later save fails (hash, unknown, settlement): abort, no further send
  {
    for (const [what, nth, opts] of [["hash", 2, {}], ["settlement", 3, {}], ["unknown", 2, { broadcastResult: () => ({}) }]]) {
      const w = scene(); const signer = fakeSigner(w, opts); let n = 0;
      const r = await pass(w, { cfg: cfgOf(enableMain), signer, extra: { saveState: () => { if (++n === nth) throw new Error("disk full"); } } });
      assert.strictEqual(r.res.aborted, true, what); assert.ok(r.lines.includes("STOP: the budget cannot be recorded; nothing more is sent this run") || r.lines.some((l) => /^STOP: the budget cannot be recorded/.test(l)), `${what}\n${r.text}`);
      assert.strictEqual(signer.signs.length, 1, `${what}: no further send`); assert.strictEqual(w.broadcasts.length, 1, what);
      noStack(r.text);
    }
  }

  // ---- 6. the broadcast rejects: the reservation (hash, nonce) stays, the run stops
  {
    for (const err of [new Error("nonce too low"), Object.assign(new Error("request timeout"), { code: "TIMEOUT" })]) {
      const w = scene(); const signer = fakeSigner(w, { sendError: err });
      const r = await pass(w, { cfg: cfgOf(enableMain), signer });
      assert.strictEqual(r.state.gasSpends.length, 1); const e = r.state.gasSpends[0];
      assert.strictEqual(e.kind, "reserved"); assert.strictEqual(e.tx, ethers.Transaction.from(w.broadcasts[0]).hash); assert.strictEqual(e.nonce, 7); assert.strictEqual(e.wei, String(WORST));
      assert.strictEqual(r.res.aborted, true); assert.strictEqual(r.res.collected, 0); assert.strictEqual(signer.signs.length, 1); assert.strictEqual(w.broadcasts.length, 1); noStack(r.text);
    }
  }

  // ---- 7. the broadcast answers without a usable hash
  {
    const answers = [() => undefined, () => ({}), () => ({ hash: H("ee") })];
    for (const [i, a] of answers.entries()) {
      const w = scene(); const signer = fakeSigner(w, { broadcastResult: a });
      const r = await pass(w, { cfg: cfgOf(enableMain), signer });
      const e = r.state.gasSpends[0];
      assert.strictEqual(r.state.gasSpends.length, 1, `answer ${i}`); assert.strictEqual(e.kind, "unknown"); assert.strictEqual(e.wei, String(WORST));
      assert.strictEqual(e.tx, ethers.Transaction.from(w.broadcasts[0]).hash, "the locally computed hash is kept");
      assert.strictEqual(r.res.aborted, true); assert.strictEqual(signer.signs.length, 1); assert.ok(r.lines.some((l) => /^STOP: broadcast returned no\/mismatching hash/.test(l)), r.text);
      assert.ok(r.saved.length >= 2 && r.saved[r.saved.length - 1].gasSpends[0].kind === "unknown", "saved"); noStack(r.text);
    }
  }

  // ---- 8. a valid receipt settles at gasUsed x min(price, maxFee) + l1
  {
    const { e, r } = await run([entry()], { setup: (w) => { w.receipts = () => rcOf(); } });
    assert.strictEqual(e[0].kind, "settled"); assert.strictEqual(e[0].wei, String(cost(100_000n, 50_000_000n)));
    assert.ok(r.saved.length >= 1 && r.saved[0].gasSpends[0].kind === "settled", "saved"); assert.ok(BigInt(e[0].wei) <= WORST);
    const hi = await run([entry()], { setup: (w) => { w.receipts = () => rcOf({ gasPrice: 10n ** 12n }); } });
    assert.strictEqual(hi.e[0].wei, String(cost(100_000n, MAX_FEE)), "price clamped to maxFeePerGas");
    const hash2 = await run([entry({ tx: TX.toUpperCase().replace("0X", "0x") })], { setup: (w) => { w.receipts = () => rcOf(); } });
    assert.strictEqual(hash2.e[0].kind, "settled", "hash compared case-insensitively");
    const tx = await run([entry()], { setup: (w) => { w.receipts = () => { const { hash, ...rest } = rcOf(); return { ...rest, transactionHash: hash }; }; } });
    assert.strictEqual(tx.e[0].kind, "settled", "transactionHash accepted");
  }

  // ---- 9. each failed receipt check keeps the worst case, unknown, not closed, and says which
  {
    const cases = [
      ["wrong hash", { hash: H("11") }, /hash mismatch/], ["from not the operator", { from: "0x00000000000000000000000000000000000000ee" }, /is not the operator/],
      ["to not allowlisted", { to: "0x00000000000000000000000000000000000000ee" }, /not an allowlisted manager/], ["to != entry.to", { to: MGR_B }, /is not the recorded manager/],
      ["no blockNumber", { blockNumber: null }, /no blockNumber/], ["gasUsed 20999", { gasUsed: 20999n }, /below 21000/],
      ["gasUsed above gasLimit", { gasUsed: GAS_LIMIT + 1n }, /above the gas limit/], ["gasUsed not a number", { gasUsed: "abc" }, /is not a number/],
    ];
    for (const [name, over, re] of cases) {
      const { e, r } = await run([entry()], { setup: (w) => { w.receipts = () => rcOf(over); w.latestNonce = 3; } });
      assert.strictEqual(e[0].kind, "unknown", name); assert.strictEqual(e[0].wei, String(WORST), name); assert.ok(!e[0].closed, name);
      assert.ok(r.lines.some((l) => /receipt rejected/.test(l) && re.test(l)), `${name}\n${r.text}`);
      assert.ok(L.spentWindowWei({ gasSpends: e }, NOW + 10 * DAY) === WORST, `${name}: still counted at any age`);
    }
    // boundary values are accepted
    for (const g of [21000n, GAS_LIMIT]) assert.strictEqual((await run([entry()], { setup: (w) => { w.receipts = () => rcOf({ gasUsed: g }); } })).e[0].kind, "settled");
    assert.strictEqual((await run([entry()], { setup: (w) => { w.receipts = () => rcOf({ gasUsed: "100000" }); } })).e[0].wei, String(cost(100_000n, 50_000_000n)), "integer string accepted");
  }

  // ---- 9b. a rejected receipt: nonce unused stays counted and untouched; nonce used closes once at the worst case
  {
    const bad = (nonce) => (w) => { w.receipts = () => rcOf({ hash: H("11") }); w.latestNonce = nonce; };
    const u = await run([entry()], { setup: bad(3) });
    assert.strictEqual(u.e[0].kind, "unknown"); assert.ok(!u.e[0].closed); assert.strictEqual(L.spentWindowWei({ gasSpends: u.e }, NOW + 10 * DAY), WORST);
    const u2 = await run(u.e, { setup: bad(3) });
    assert.strictEqual(u2.r.saved.length, 0, "an unchanged unknown entry is not rewritten");
    const a = await run([entry({ t: NOW - 2 * DAY })], { setup: bad(4) });
    assert.strictEqual(a.e[0].kind, "settled"); assert.strictEqual(a.e[0].closed, "receipt-rejected"); assert.strictEqual(a.e[0].t, NOW); assert.strictEqual(a.e[0].wei, String(WORST));
    const b = await run(a.e, { setup: bad(4), at: NOW + 1000 });
    assert.strictEqual(b.w.receiptCalls.length, 0); assert.strictEqual(b.e[0].t, NOW); assert.strictEqual(b.e[0].closed, "receipt-rejected");
    assert.strictEqual(L.spentWindowWei({ gasSpends: a.e }, NOW + DAY - 1), WORST); assert.strictEqual(L.spentWindowWei({ gasSpends: a.e }, NOW + DAY + 1), 0n, "ages out after 24 h");
    // a previously unknown entry (rejected earlier) is closed the same way
    const c = await run([entry({ kind: "unknown" })], { setup: bad(4) });
    assert.strictEqual(c.e[0].closed, "receipt-rejected");
  }

  // ---- 10. replaced or dropped: found by nonce, or closed once at the worst case
  {
    const used = (w) => { w.receipts = () => null; w.latestNonce = 4; };
    const other = H("77");
    const found = { receipt: rcOf({ hash: other, gasUsed: 90_000n }), tx: { hash: other, nonce: 3, from: OP, gasLimit: 187_500n } };
    const a = await run([entry()], { setup: used, extra: { findByNonce: async (addr, n) => { assert.strictEqual(addr, OP); assert.strictEqual(n, 3); return found; } } });
    assert.strictEqual(a.e[0].kind, "settled"); assert.strictEqual(a.e[0].wei, String(cost(90_000n, 50_000_000n))); assert.ok(!a.e[0].closed);
    // default (null): the worst case, once, with a fresh clock
    const b = await run([entry({ t: NOW - 2 * DAY })], { setup: used });
    assert.strictEqual(b.e[0].kind, "settled"); assert.strictEqual(b.e[0].closed, "replaced-or-dropped"); assert.strictEqual(b.e[0].wei, String(WORST)); assert.strictEqual(b.e[0].t, NOW);
    // a second run: no receipt or nonce call for it, not counted twice
    const w2 = scene(noneApproved); used(w2);
    const r2 = await pass(w2, { cfg: cfgOf(enableMain), state: { gasSpends: b.e }, extra: { now: () => NOW + 1000 } });
    assert.strictEqual(w2.receiptCalls.length, 0); assert.ok(!w2.nonceCalls.includes("latest")); assert.strictEqual(r2.state.gasSpends.length, 1);
    assert.strictEqual(L.spentWindowWei(r2.state, NOW + 1000), WORST);
    assert.strictEqual(L.spentWindowWei(r2.state, NOW + DAY - 1), WORST); assert.strictEqual(L.spentWindowWei(r2.state, NOW + DAY + 1), 0n, "24 h + 1 ms later it no longer counts");
    // a lookup result that fails the checks
    for (const bad of [{ receipt: rcOf({ hash: other, to: "0x00000000000000000000000000000000000000ee" }), tx: found.tx }, { receipt: found.receipt, tx: { ...found.tx, nonce: 4 } }, { receipt: found.receipt, tx: { ...found.tx, from: "0x00000000000000000000000000000000000000ee" } }, { receipt: rcOf({ hash: other, gasUsed: 10n }), tx: found.tx }, { receipt: found.receipt, tx: { ...found.tx, gasLimit: undefined } }, { receipt: found.receipt, tx: { hash: other, nonce: 3, from: OP } }, { receipt: found.receipt, tx: { ...found.tx, gasLimit: "abc" } }]) {
      const c = await run([entry()], { setup: used, extra: { findByNonce: async () => bad } });
      assert.strictEqual(c.e[0].wei, String(WORST)); assert.strictEqual(c.e[0].closed, "replaced-or-dropped");
    }
    const t = await run([entry()], { setup: used, extra: { findByNonce: async () => { throw new Error("explorer down"); } } });
    assert.strictEqual(t.e[0].kind, "reserved", "a failing lookup leaves the entry unchanged"); assert.ok(!t.e[0].closed);
  }

  // ---- 11. pending: nonce not used yet
  {
    const pending = (w) => { w.receipts = () => null; w.latestNonce = 3; };
    const old = NOW - 2 * DAY;
    const a = await run([entry({ t: old, wei: "1000" })], { setup: pending, sc: {} });
    assert.strictEqual(a.e[0].kind, "reserved"); assert.strictEqual(a.e[0].wei, "1000"); assert.ok(a.r.lines.some((l) => /pending: nonce 3 not used yet/.test(l)), a.r.text);
    assert.strictEqual(a.r.res.collected, 2, "the run may still send");
    assert.strictEqual(L.spentWindowWei({ gasSpends: [entry({ t: old })] }, NOW), WORST, "counted although 48 h old");
    const b = await run([entry({ t: old, wei: String(dayCap - WORST + 1n) })], { setup: pending, sc: {} });
    assert.strictEqual(b.r.signer.sent.length, 0); assert.ok(/24 h gas cap 0\.001 ETH would be exceeded/.test(b.r.text), b.r.text); assert.strictEqual(b.r.res.aborted, false);
  }

  // ---- 12. a crashed run: a reserved entry three days old
  {
    const old = NOW - 3 * DAY;
    const a = await run([entry({ t: old })], { setup: (w) => { w.receipts = () => rcOf(); } });
    assert.strictEqual(a.e[0].kind, "settled"); assert.strictEqual(a.e[0].wei, String(cost(100_000n, 50_000_000n)));
    const b = await run([entry({ t: old })], { setup: (w) => { w.receipts = () => null; w.latestNonce = 9; } });
    assert.strictEqual(b.e[0].closed, "replaced-or-dropped"); assert.strictEqual(b.e[0].t, NOW); assert.strictEqual(b.e[0].wei, String(WORST));
    const c = await run([entry({ t: old })], { setup: (w) => { w.receipts = () => null; w.latestNonce = 3; } });
    assert.strictEqual(c.e[0].kind, "reserved"); assert.strictEqual(L.spentWindowWei({ gasSpends: c.e }, NOW), WORST, "still counted");
    assert.strictEqual(L.spentWindowWei({ gasSpends: [{ t: old, wei: "5", kind: "reserved" }] }, NOW), 5n);
    assert.ok(JSON.parse(L.serializeState({ gasSpends: [{ t: NOW - 30 * DAY, wei: "5", kind: "reserved" }] }, NOW)).gasSpends.length === 1, "never pruned while reserved");
  }

  // ---- 13. legacy entries (f0c24ab and earlier)
  {
    const mkLegacy = () => ({ t: NOW - 3600_000, wei: String(WORST), kind: "unknown", tx: null, gasLimit: String(GAS_LIMIT), maxFeePerGas: String(MAX_FEE), l1: String(FLOOR) });
    const a = await run([mkLegacy()], { setup: (w) => { w.receipts = () => null; } });
    assert.strictEqual(a.e[0].kind, "settled"); assert.strictEqual(a.e[0].closed, "legacy-unsettled"); assert.strictEqual(a.e[0].t, NOW); assert.strictEqual(a.e[0].wei, String(WORST)); assert.strictEqual(a.w.receiptCalls.length, 0);
    const b = await run([{ ...mkLegacy(), tx: TX }], { setup: (w) => { w.receipts = () => null; } });
    assert.strictEqual(b.e[0].closed, "legacy-unsettled"); assert.strictEqual(b.w.receiptCalls.length, 1);
    const c = await run([{ ...mkLegacy(), tx: TX }], { setup: (w) => { w.receipts = () => rcOf(); } });
    assert.strictEqual(c.e[0].kind, "settled"); assert.ok(!c.e[0].closed); assert.strictEqual(c.e[0].wei, String(cost(100_000n, 50_000_000n)));
    const d = await run([{ t: NOW - 3600_000, wei: String(WORST), kind: "reserved", tx: null }], {});
    assert.strictEqual(d.e[0].closed, "legacy-unsettled", "a bare reserved entry too");
    // the f0c24ab-shaped fixture blocks, then lets the next run send again without any file edit
    const big = { ...mkLegacy(), wei: String(dayCap - WORST + 1n) };
    const first = await run([big], { sc: {}, setup: (w) => { w.receipts = () => null; } });
    assert.strictEqual(first.r.signer.sent.length, 0); assert.ok(/24 h gas cap/.test(first.r.text));
    const w2 = scene(); const r2 = await pass(w2, { cfg: cfgOf(enableMain), state: { gasSpends: first.e }, extra: { now: () => NOW + DAY + 1 } });
    assert.strictEqual(r2.res.collected, 2, r2.text);
  }

  // ---- 14. RPC errors while settling: unchanged, counted, no crash, no abort
  {
    for (const [what, setup] of [["nonce", (w) => { w.receipts = () => null; w.latestNonce = new Error("rpc down"); }], ["receipt", (w) => { w.receipts = () => new Error("rpc down"); }]]) {
      const x = await run([entry(), entry({ tx: H("22"), nonce: 4 })], { setup });
      assert.deepStrictEqual(x.e.map((q) => q.kind), ["reserved", "reserved"], what); assert.ok(x.e.every((q) => !q.closed && q.wei === String(WORST)));
      assert.strictEqual(x.r.res.aborted, false, what); assert.ok(x.r.lines.some((l) => /rpc down/.test(l)), x.r.text); assert.ok(/=== base done/.test(x.r.text)); noStack(x.r.text);
    }
    const sendOk = await run([entry({ wei: "1000" })], { sc: {}, setup: (w) => { w.receipts = () => new Error("rpc down"); } });
    assert.strictEqual(sendOk.r.res.collected, 2, "the pass continues");
  }

  // ---- 15. simulate: no settlement calls, no writes, but the entries count in the cap decisions
  {
    const x = await run([entry({ wei: String(dayCap - WORST + 1n) })], { sc: {}, mode: "simulate", setup: (w) => { w.receipts = () => rcOf(); w.latestNonce = 9; } });
    assert.strictEqual(x.w.receiptCalls.length, 0); assert.ok(!x.w.nonceCalls.includes("latest")); assert.strictEqual(x.r.saved.length, 0); assert.strictEqual(x.e[0].kind, "reserved");
    assert.ok(/24 h gas cap 0\.001 ETH would be exceeded/.test(x.r.text), x.r.text); assert.strictEqual(x.r.res.wouldCollect, 0);
    const y = await run([entry({ kind: "unknown", wei: String(dayCap - WORST + 1n) })], { sc: {}, mode: "simulate" });
    assert.ok(/24 h gas cap/.test(y.r.text));
  }

  // ---- 16. a settlement whose save fails stops the run
  {
    const w = scene(); const signer = fakeSigner(w); w.receipts = () => rcOf();
    const r = await pass(w, { cfg: cfgOf(enableMain), signer, state: { gasSpends: [entry()] }, extra: { saveState: () => { throw new Error("disk full"); } } });
    assert.strictEqual(r.res.aborted, true); assert.strictEqual(signer.signs.length, 0); assert.strictEqual(w.broadcasts.length, 0); assert.ok(r.lines.some((l) => /^STOP: the budget cannot be recorded/.test(l)));
  }

  // ---- 17. readState validates every field
  {
    const dir = fs.mkdtempSync(path.join(TMP, "rs-"));
    const full = { t: NOW, wei: "5", kind: "reserved", tx: TX, nonce: 0, from: OP, to: MGR_A, gasLimit: "1", maxFeePerGas: "2", l1: "3", closed: "x", whatever: { a: 1 } };
    const write = (entries) => { const f = path.join(dir, "s.json"); fs.writeFileSync(f, JSON.stringify({ version: 1, gasSpends: entries })); return f; };
    const ok = (entries) => L.readState(write(entries));
    assert.strictEqual(ok([full, { t: NOW, wei: "1" }, { t: NOW, wei: "1", tx: null, kind: "settled", closed: "a".repeat(40) }]).ok, true);
    const bad = [["kind", "weird", "kind is not"], ["tx", "0x12", "tx is not"], ["tx", 123, "tx is not"], ["nonce", -1, "nonce is not a non-negative integer"], ["nonce", 1.5, "nonce is not"], ["nonce", "3", "nonce is not"], ["nonce", 2 ** 60, "nonce is not"],
      ["gasLimit", "abc", "gasLimit is not"], ["maxFeePerGas", -5, "maxFeePerGas is not"], ["l1", 1e30, "l1 is not"], ["from", "nothex", "from is not"], ["to", 5, "to is not"], ["closed", {}, "closed is not"], ["closed", "a".repeat(41), "closed is not"]];
    for (const [k, v, msg] of bad) {
      const r = ok([full, { ...full }, { ...full, [k]: v }]);
      assert.strictEqual(r.ok, false, `${k}=${JSON.stringify(v)}`); assert.strictEqual(r.kind, "corrupt");
      assert.ok(r.reason.startsWith(`gasSpends[2].${k} `) && r.reason.includes(msg), r.reason);
    }
  }

  // ---- 18. runPass over each corrupt fixture; then the real CLI
  {
    const dir = fs.mkdtempSync(path.join(TMP, "bad-"));
    const f = path.join(dir, "state.json");
    for (const [k, v] of [["kind", "weird"], ["tx", "0x12"], ["nonce", -1], ["gasLimit", "abc"], ["from", "nothex"]]) {
      const text = JSON.stringify({ version: 1, gasSpends: [{ ...entry(), [k]: v }] });
      fs.writeFileSync(f, text);
      const w = scene(); const signer = fakeSigner(w);
      const r = await pass(w, { cfg: cfgOf(enableMain), signer, extra: { readState: () => L.readState(f), state: undefined, saveState: () => assert.fail("must not save") } });
      assert.strictEqual(r.res.aborted, true); assert.strictEqual(signer.signs.length, 0); assert.strictEqual(w.broadcasts.length, 0);
      assert.ok(r.lines.some((l) => l.startsWith(`STATE UNREADABLE (gasSpends[0].${k} `)), r.text); noStack(r.text);
      assert.strictEqual(fs.readFileSync(f, "utf8"), text, "file untouched");
    }
    // the real CLI: corrupt state in a temp data dir, no keystore, the network guard on. settings.json must name an https RPC, which
    // the guard refuses, so the process ends at the first chain read: what is checked here is exit code 1, one line, no stack, state untouched.
    {
      const data = hermeticCwd();
      const raw = JSON.parse(JSON.stringify(exampleRaw)); raw.chain.rpcUrl = "https://rpc.invalid.example"; raw.wallets.main.collect = true;
      fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify(raw));
      const bad = JSON.stringify({ version: 1, gasSpends: [{ t: NOW, wei: "1", nonce: -1 }] });
      fs.writeFileSync(path.join(data, "state.json"), bad);
      const out = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, "..", "collector-base.js"), "--mode=collect"], { cwd: data, env: hermeticEnv({ LP_DATA_DIR: data, LP_READONLY: "1" }) });
        let text = ""; const kill = setTimeout(() => child.kill("SIGKILL"), 30000);
        child.stdout.on("data", (c) => { text += c; }); child.stderr.on("data", (c) => { text += c; });
        child.on("close", (code) => { clearTimeout(kill); resolve({ code, text }); });
      });
      assert.strictEqual(out.code, 1, out.text); noStack(out.text); assert.ok(!/TypeError|SyntaxError/.test(out.text), out.text);
      assert.strictEqual(fs.readFileSync(path.join(data, "state.json"), "utf8"), bad);
    }
  }

  // ---- 20. a scene where the position belongs to manager A but the fields are built for manager B
  {
    const w = scene(); const signer = fakeSigner(w);
    const r = await pass(w, { cfg: cfgOf(enableMain), signer, extra: { tweakTxFields: (t, ctx) => ({ ...t, to: ctx.manager.positionManager === MGR_A ? MGR_B : MGR_A }) } });
    assert.strictEqual(signer.signs.length, 0); assert.strictEqual(w.broadcasts.length, 0);
    assert.ok(r.lines.some((l) => /refusing to sign: to .* is not this position's manager/.test(l)), r.text);
  }

  // ---- 21. price floor: a price below the signed tip counts maxFee; an old entry without the field still reads and settles
  {
    const TIP = 1_000_000n;
    const ok = await run([entry({ maxPriorityFeePerGas: String(TIP) })], { setup: (w) => { w.receipts = () => rcOf(); } });
    assert.strictEqual(ok.e[0].wei, String(cost(100_000n, 50_000_000n)), "normal price untouched");
    for (const price of [0n, TIP - 1n]) {
      const lo = await run([entry({ maxPriorityFeePerGas: String(TIP) })], { setup: (w) => { w.receipts = () => rcOf({ gasPrice: price }); } });
      assert.strictEqual(lo.e[0].wei, String(cost(100_000n, MAX_FEE)), `price ${price} counts maxFeePerGas`);
    }
    const old = await run([entry()], { setup: (w) => { w.receipts = () => rcOf({ gasPrice: 0n }); } });
    assert.strictEqual(old.e[0].kind, "settled"); assert.strictEqual(old.e[0].wei, String(FLOOR), "no tip recorded: price 0 stays 0 (old state file)");
    for (const bad of [-1, "abc", "-5", 5n]) assert.strictEqual(L.entryProblem({ maxPriorityFeePerGas: bad }), "maxPriorityFeePerGas is not a decimal string");
    assert.strictEqual(L.entryProblem({ maxPriorityFeePerGas: "5" }), null); assert.strictEqual(L.entryProblem({}), null);
  }

  // ---- 22. late-paid gas counts in the current window
  {
    const old = await run([entry({ t: NOW - 3 * 86400_000 })], { setup: (w) => { w.receipts = () => rcOf(); } });
    assert.strictEqual(old.e[0].kind, "settled"); assert.strictEqual(old.e[0].t, NOW, "t moved to now");
    const fresh = await run([entry({ t: NOW - 3600_000 })], { setup: (w) => { w.receipts = () => rcOf(); } });
    assert.strictEqual(fresh.e[0].t, NOW - 3600_000, "a young entry keeps its time");
  }

  // ---- 23. blockNumber must be a positive safe integer
  {
    const L2 = require("../collector-base-logic");
    const base = { hash: TX, from: OP, to: MGR_A, gasUsed: 100_000n };
    const chk = (bn) => L2.checkReceipt({ ...base, blockNumber: bn }, { hash: TX, operator: OP, entry: entry() });
    for (const bn of [5, 5n, "5", "0x5", 2 ** 53 - 1]) assert.strictEqual(chk(bn), null, String(bn));
    for (const bn of [0, 0n, -1, -1n, 1.5, NaN, Infinity, 2 ** 53, 2n ** 60n, "0", "0x0", "abc", "1e3", "-4", {}, [], true]) assert.ok(/blockNumber/.test(chk(bn) || ""), String(bn));
  }

  console.log("collector-base-settle tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
