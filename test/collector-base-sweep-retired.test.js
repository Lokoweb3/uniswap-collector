// node test/collector-base-sweep-retired.test.js -- security L-1 of 08afeee: a tampered sweep-state.json must not credit a real, older operator
// receipt of a pruned job. Retired-hash list (validated in readSweepState, bounded, persisted by serializeSweepState), the block-order rule
// (swap/transfer receipts not below the job's verified collect block; a collect strictly newer than any retired collect of the position),
// and the reviewer nit (both hold reasons listed). Mocked chain, no network, no key.
"use strict";
const assert = require("assert");
const fs = require("fs");
const X = require("./lib/sweep-scene");

const { sweepScene, decodeSent, OWNER, USDC, WETH, CBBTC, OTHER, E18, SL, lc, ID_A, ID_B, MGR_A, MGR_B } = X;
const clone = (x) => JSON.parse(JSON.stringify(x));
const DAY = 24 * 3600 * 1000;
const hex = (n) => "0x" + n.toString(16).padStart(64, "0");
const posA = () => ({ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: 2n * E18 / 100n, a1: 0n });
const posB = () => ({ id: ID_B, mgr: MGR_B, t0: CBBTC, t1: USDC, a0: 100_000n, a1: 0n });
const otherPos = () => ({ id: ID_A, mgr: MGR_A, t0: USDC, t1: OTHER, a0: 0n, a1: 5n * E18 });
const names = (signer) => decodeSent(signer).map((t) => t.name);
const byToken = (led, id) => led.jobs.find((j) => j.tokenId === String(id));

/** A scene where job J1 (#A, WETH -> USDC, delivered) is followed by J2 (#B, cbBTC -> USDC, delivered): J2's collect is in a later block than all of J1's receipts. */
async function twoJobs() {
  const S = sweepScene({ positions: [posA(), posB()] }); S.init();
  await S.run({});
  const led = S.ledger();
  const j1 = byToken(led, ID_A), j2 = byToken(led, ID_B);
  assert.ok(j1 && j2 && j1.legs[0].phase === "delivered" && j2.legs[0].phase === "delivered", JSON.stringify(led.jobs.map((j) => j.legs.map((l) => l.phase))));
  const lastJ1 = Math.max(...[j1.collect.block, j1.maxBlock]);
  assert.ok(j2.collect.block > lastJ1, `J2 collect block ${j2.collect.block} is after J1's last receipt block ${lastJ1}`);
  return { S, led, j1, j2 };
}
/** J2's first leg rewound to "swap pending at `tx`" (as a tampered ledger could write it); J2's own swap record is erased. */
function rewindToPendingSwap(j2, tx) {
  const l = j2.legs[0];
  l.phase = "collected"; l.doneRaw = "0"; l.outDone = undefined; l.deliver = null; delete l.transferTxs;
  l.swap = { amountIn: null, quoteRaw: null, minOutRaw: null, outRaw: "0", tx: null };
  l.pending = { op: "swap", tx, nonce: 99, raw: l.owedRaw };
}
function rewindToPendingTransfer(j2, tx, to, raw) {
  const l = j2.legs[0];
  l.phase = "swapped"; l.outDone = "0"; l.deliver = null; delete l.transferTxs;
  l.pending = { op: "transfer", tx, nonce: 99, raw, to, kind: "proceeds" };
}
/** The ledger text with job `j1` retired by the real pruning (a terminal job older than 30 days). */
function pruned(led, id) {
  const l = clone(led);
  const j = byToken(l, id); j.finishedAt = Date.now() - 40 * DAY;
  return JSON.parse(SL.serializeSweepState(l, Date.now()));
}
const write = (S, obj) => fs.writeFileSync(S.file, JSON.stringify(obj));

(async () => {
  // ---- 1. pruning retires the hashes, bounded and idempotent; the file reads back
  {
    const { led, j1 } = await twoJobs();
    const out = pruned(led, ID_A);
    assert.strictEqual(out.jobs.length, 1, "J1 was pruned");
    const hashes = out.retired.hashes.map((e) => e.hash);
    const want = [j1.collect.tx, j1.legs[0].swap.tx, j1.legs[0].deliver.tx].map((h) => h.toLowerCase());
    for (const h of want) assert.ok(hashes.includes(h), `${h} retired`);
    assert.strictEqual(out.retired.collectBlock[`${MGR_A}:${ID_A}`.toLowerCase()], j1.collect.block, "the position's collect block is the high-water");
    assert.ok(out.retired.hashes.every((e) => e.block === Math.max(j1.collect.block, j1.maxBlock)));
    // idempotent: saving again from the loaded ledger gives the same text
    const l2 = clone(led); byToken(l2, ID_A).finishedAt = Date.now() - 40 * DAY;
    assert.strictEqual(SL.serializeSweepState(l2, Date.now()), SL.serializeSweepState(l2, Date.now()));
    // a live-only ledger carries no retired block (the file is as before the list existed)
    assert.ok(!("retired" in JSON.parse(SL.serializeSweepState(clone(led), Date.now()))));
    // the pruned ledger reads and keeps its list
    const f = require("path").join(require("os").tmpdir(), `sweep-retired-${process.pid}.json`);
    fs.writeFileSync(f, JSON.stringify(out));
    const r = SL.readSweepState(f); fs.rmSync(f, { force: true });
    assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.ledger.retired.hashes.length, want.length);
    assert.strictEqual(SL.retiredHas(r.ledger.retired, want[1].toUpperCase().replace("0X", "0x")), true, "case does not hide a hash");
  }

  // ---- 2. replaying a pruned job's swap receipt is refused (the list makes the ledger corrupt; nothing is sent)
  {
    const { S, led, j1 } = await twoJobs();
    const pr = pruned(led, ID_A);
    const j2 = byToken(pr, ID_B); rewindToPendingSwap(j2, j1.legs[0].swap.tx);
    write(S, pr);
    const r = SL.readSweepState(S.file);
    assert.ok(!r.ok && r.kind === "corrupt" && /retired with a pruned job/.test(r.reason), JSON.stringify(r));
    const run = await S.run({ signer: S.signer() });
    assert.strictEqual(run.signer.sent.length, 0, run.text); assert.ok(/sweep-state\.json is unreadable/.test(run.text) && /retired/.test(run.text), run.text);
    // the same via an already-credited swap hash (swap.txs) of a live leg
    const pr2 = pruned(led, ID_A); const l2 = byToken(pr2, ID_B).legs[0]; l2.swap.txs = [...(l2.swap.txs || []), j1.legs[0].swap.tx];
    write(S, pr2); assert.ok(/retired with a pruned job/.test(SL.readSweepState(S.file).reason));
    // and a live job that uses the pruned job's collect hash
    const pr3 = pruned(led, ID_A); byToken(pr3, ID_B).collect.tx = j1.collect.tx;
    write(S, pr3); assert.ok(/retired with a pruned job/.test(SL.readSweepState(S.file).reason));
  }

  // ---- 3. replaying a pruned job's transfer receipt is refused
  {
    const { S, led, j1 } = await twoJobs();
    const pr = pruned(led, ID_A);
    const d = j1.legs[0].deliver;
    rewindToPendingTransfer(byToken(pr, ID_B), d.tx, d.to, d.raw);
    write(S, pr);
    const r = SL.readSweepState(S.file);
    assert.ok(!r.ok && r.kind === "corrupt" && /retired with a pruned job/.test(r.reason), JSON.stringify(r));
    const run = await S.run({ signer: S.signer() });
    assert.strictEqual(run.signer.sent.length, 0, run.text);
    // the transfer hashes of EVERY delivery are kept, not only the last (transferTxs)
    assert.ok(Array.isArray(j1.legs[0].transferTxs) && j1.legs[0].transferTxs.includes(d.tx));
  }

  // ---- 4. block-order rule: a swap / transfer receipt below the job's verified collect block is refused (no retired list involved)
  {
    const { S, led, j1 } = await twoJobs();
    const leg = () => byToken(S.ledger(), ID_B).legs[0];
    // 4a. swap: J1 is gone from the ledger without a retired list (a ledger pruned by the older code); J2 points at J1's swap
    const a = clone(led); a.jobs = a.jobs.filter((j) => j.tokenId !== String(ID_A));
    rewindToPendingSwap(byToken(a, ID_B), j1.legs[0].swap.tx); write(S, a);
    assert.ok(SL.readSweepState(S.file).ok, "readable: only the block rule can stop it");
    const r1 = await S.run({ signer: S.signer() });
    assert.strictEqual(r1.signer.sent.length, 0, r1.text);
    assert.strictEqual(leg().unattributed, true, r1.text); assert.strictEqual(leg().phase, "held");
    assert.ok(/before the job's collect in block/.test(leg().reason), leg().reason);
    assert.strictEqual(leg().doneRaw, "0", "nothing credited"); assert.strictEqual(leg().swap.outRaw, "0");
    // 4b. transfer
    const b = clone(led); b.jobs = b.jobs.filter((j) => j.tokenId !== String(ID_A));
    const d = j1.legs[0].deliver;
    rewindToPendingTransfer(byToken(b, ID_B), d.tx, d.to, d.raw); write(S, b);
    const r2 = await S.run({ signer: S.signer() });
    assert.strictEqual(r2.signer.sent.length, 0, r2.text);
    assert.strictEqual(leg().unattributed, true, r2.text); assert.ok(/before the job's collect in block/.test(leg().reason), leg().reason);
    assert.strictEqual(leg().outDone, "0", "nothing credited");
    // 4c. control: J2's OWN swap receipt (block >= its collect) is accepted by the same path
    const c = clone(led); const j2 = byToken(c, ID_B); const own = j2.legs[0].swap.tx;
    rewindToPendingSwap(j2, own); write(S, c);
    const r3 = await S.run({ signer: S.signer() });
    assert.ok(/recovery: swap of .* succeeded/.test(r3.text), r3.text); assert.notStrictEqual(leg().unattributed, true);
    assert.ok(BigInt(leg().swap.outRaw) > 0n);
  }

  // ---- 5. block-order rule for the collect: strictly newer than any retired collect of the same position
  {
    const S = sweepScene({ positions: [posA()] }); S.init();
    await S.run({});
    const led = S.ledger(); const j = led.jobs[0]; const key = `${MGR_A}:${ID_A}`.toLowerCase();
    const rewind = (hi) => {
      const l = clone(led); const jj = l.jobs[0];
      jj.legs[0].phase = "collected"; jj.legs[0].doneRaw = "0"; jj.legs[0].outDone = undefined; jj.legs[0].deliver = null; jj.legs[0].swap = { amountIn: null, quoteRaw: null, minOutRaw: null, outRaw: "0", tx: null }; delete jj.legs[0].swap.txs;
      if (hi !== null) l.retired = { hashes: [], floor: 0, collectBlock: { [key]: hi } };
      write(S, l);
    };
    for (const hi of [j.collect.block, j.collect.block + 50]) {
      rewind(hi);
      const run = await S.run({ signer: S.signer() });
      assert.strictEqual(run.signer.sent.length, 0, run.text);
      const leg = S.ledger().jobs[0].legs[0];
      assert.strictEqual(leg.phase, "held", run.text); assert.ok(/not newer than the retired collect of this position in block/.test(leg.reason), leg.reason);
    }
    // control: a retired collect one block older does not trigger this rule (the leg is held for a different reason: the WETH is gone)
    rewind(j.collect.block - 1);
    const ok = await S.run({ signer: S.signer() });
    assert.ok(!/not newer than the retired collect/.test(ok.text), ok.text);
    // the retired floor refuses a collect at or below it too, and a retired hash is refused as a collect
    assert.ok(/not newer|retired/.test(SL.collectReplayProblem({ hashes: [], floor: 10, collectBlock: {} }, hex(1), 10, MGR_A, ID_A) || ""), "floor");
    assert.ok(/retired job/.test(SL.collectReplayProblem({ hashes: [{ hash: hex(1), block: 1 }], floor: 0, collectBlock: {} }, hex(1).toUpperCase().replace("0X", "0x"), 99, MGR_A, ID_A)));
    assert.strictEqual(SL.collectReplayProblem({ hashes: [], floor: 0, collectBlock: { [key]: 5 } }, hex(2), 6, MGR_A, ID_A), null);
    assert.strictEqual(SL.collectReplayProblem({ hashes: [], floor: 0, collectBlock: { [key]: 5 } }, hex(2), 5, MGR_A, ID_B) , null, "another position is unaffected");
  }

  // ---- 6. a malformed retired list is a corrupt ledger
  {
    const S = sweepScene({ positions: [posA()] }); S.init();
    await S.run({});
    const base = S.ledger(); const key = `${MGR_A}:${ID_A}`.toLowerCase();
    const good = () => ({ hashes: [{ hash: hex(1), block: 3 }], floor: 0, collectBlock: { [key]: 7 } });
    const t = (mut) => { const l = clone(base); l.retired = good(); mut(l.retired, l); write(S, l); return SL.readSweepState(S.file); };
    assert.ok(t(() => {}).ok, "the good list reads");
    { const l = clone(base); write(S, l); assert.ok(SL.readSweepState(S.file).ok, "an older ledger with no list reads"); }
    const bad = {
      "not an object": (r, l) => { l.retired = []; },
      "string": (r, l) => { l.retired = "x"; },
      "null": (r, l) => { l.retired = null; },
      "hashes not an array": (r) => { r.hashes = {}; },
      "entry is a bare string": (r) => { r.hashes = [hex(1)]; },
      "entry null": (r) => { r.hashes = [null]; },
      "bad hash (short)": (r) => { r.hashes[0].hash = "0x1234"; },
      "bad hash (chars)": (r) => { r.hashes[0].hash = "0x" + "zz".repeat(32); },
      "hash not a string": (r) => { r.hashes[0].hash = 5; },
      "duplicate": (r) => { r.hashes.push({ hash: hex(1), block: 4 }); },
      "duplicate in other case": (r) => { r.hashes = [{ hash: "0x" + "ab".repeat(32), block: 1 }, { hash: "0x" + "AB".repeat(32), block: 2 }]; },
      "over the bound": (r) => { r.hashes = Array.from({ length: SL.MAX_RETIRED_HASHES + 1 }, (_, i) => ({ hash: hex(i + 1), block: 1 })); },
      "block negative": (r) => { r.hashes[0].block = -1; },
      "block fraction": (r) => { r.hashes[0].block = 1.5; },
      "block string": (r) => { r.hashes[0].block = "3"; },
      "floor negative": (r) => { r.floor = -1; },
      "floor string": (r) => { r.floor = "0"; },
      "floor missing": (r) => { delete r.floor; },
      "collectBlock array": (r) => { r.collectBlock = []; },
      "collectBlock missing": (r) => { delete r.collectBlock; },
      "collectBlock bad key": (r) => { r.collectBlock = { "not-a-key": 5 }; },
      "collectBlock key not lowercase": (r) => { r.collectBlock = { [key.replace(/[a-f]/g, (c) => c.toUpperCase())]: 5 }; },
      "collectBlock zero": (r) => { r.collectBlock[key] = 0; },
      "collectBlock string": (r) => { r.collectBlock[key] = "7"; },
    };
    for (const [name, mut] of Object.entries(bad)) {
      const r = t(mut); assert.ok(!r.ok && r.kind === "corrupt" && /retired/.test(r.reason), `${name}: ${JSON.stringify(r)}`);
    }
    // exactly at the bound is allowed
    assert.ok(t((r) => { r.hashes = Array.from({ length: SL.MAX_RETIRED_HASHES }, (_, i) => ({ hash: hex(i + 1), block: 1 })); }).ok, "exactly the bound");
    // a run on a corrupt list sends nothing
    t((r) => { r.hashes[0].hash = "0xnope"; });
    const run = await S.run({ signer: S.signer() });
    assert.strictEqual(run.signer.sent.length, 0); assert.ok(/sweep-state\.json is unreadable/.test(run.text), run.text);
    // leg.transferTxs is validated the same way
    { const l = clone(base); l.jobs[0].legs[0].transferTxs = ["0x12"]; write(S, l); assert.ok(/transferTxs/.test(SL.readSweepState(S.file).reason)); }
    { const l = clone(base); l.jobs[0].collect.block = -3; write(S, l); assert.ok(/collect\.block/.test(SL.readSweepState(S.file).reason)); }
  }

  // ---- 7. eviction at the bound raises the floor, so an evicted hash is still refused by the block rule; collectBlock is never lowered
  {
    const key = `${MGR_A}:${ID_A}`.toLowerCase();
    const mkJob = (n, block, fin) => ({ id: `j${n}`, tokenId: String(n), manager: MGR_A, owner: OWNER, token0: WETH, token1: USDC, collect: { tx: hex(100000 + n), status: "mined", block }, maxBlock: block + 3, pending: null, createdAt: fin, finishedAt: fin, legs: [] });
    const old = { hashes: Array.from({ length: SL.MAX_RETIRED_HASHES }, (_, i) => ({ hash: hex(i + 1), block: 100 + i })), floor: 0, collectBlock: { [key]: 5000 } };
    const ledger = { jobs: [mkJob(1, 9000, 1), mkJob(2, 9100, 2)], retired: old };
    const out = JSON.parse(SL.serializeSweepState(ledger, Date.now()));
    assert.strictEqual(out.jobs.length, 0, "both finished jobs were pruned");
    assert.strictEqual(out.retired.hashes.length, SL.MAX_RETIRED_HASHES, "the list stays at the bound");
    assert.strictEqual(out.retired.floor, 100 + 1, "the two oldest entries (blocks 100, 101) were evicted; the floor is the highest evicted block");
    assert.ok(!out.retired.hashes.some((e) => e.hash === hex(1)), "oldest evicted");
    assert.ok(out.retired.hashes.some((e) => e.hash === hex(100001)) && out.retired.hashes.some((e) => e.hash === hex(100002)), "the newly retired hashes are kept");
    assert.strictEqual(out.retired.collectBlock[`${MGR_A}:1`.toLowerCase()], 9000);
    assert.strictEqual(out.retired.collectBlock[key], 5000, "an older high-water is untouched by a job of another position");
    // an evicted hash (no longer on the list) is still refused: its block is at or below the floor
    assert.ok(!SL.retiredHas(out.retired, hex(1)) && /at or below the retired floor/.test(SL.receiptReplayProblem(out.retired, hex(1), 100, 50)));
    assert.ok(/at or below the retired floor/.test(SL.receiptReplayProblem(out.retired, hex(2), 101, null)));
    assert.strictEqual(SL.receiptReplayProblem(out.retired, hex(999999), 102, 50), null, "above the floor and the collect block");
    // the collect high-water for a position is never lowered by pruning an older job of the same position
    const l2 = { jobs: [mkJob(1, 40, 1)], retired: { hashes: [], floor: 0, collectBlock: { [`${MGR_A}:1`.toLowerCase()]: 9000 } } };
    assert.strictEqual(JSON.parse(SL.serializeSweepState(l2, Date.now())).retired.collectBlock[`${MGR_A}:1`.toLowerCase()], 9000);
    // reading what was written back works, and a job that is not terminal or not old stays
    const keepLedger = { jobs: [{ ...mkJob(3, 10, Date.now()), finishedAt: Date.now() }, { ...mkJob(4, 10, 1), collect: { tx: hex(9), status: "intent" }, legs: [] }], retired: SL.emptyRetired() };
    assert.strictEqual(JSON.parse(SL.serializeSweepState(keepLedger, Date.now())).jobs.length, 2);
    // the rule for a receipt below the job's own collect block
    assert.ok(/before the job's collect in block 50/.test(SL.receiptReplayProblem(SL.emptyRetired(), hex(5), 49, 50)));
    assert.strictEqual(SL.receiptReplayProblem(SL.emptyRetired(), hex(5), 50, 50), null, "the collect block itself is allowed");
    assert.ok(/no usable block number/.test(SL.receiptReplayProblem(SL.emptyRetired(), hex(5), undefined, 50)));
  }

  // ---- 8. reviewer nit: with BOTH the pinned decimals and the price missing, BOTH reasons are listed
  {
    const S = sweepScene({ positions: [otherPos()], feesUsd: 50, usd1: 10 }); S.init();
    await S.run({ sweep: { maxUnswappedValueUsdc: 1000 }, signer: S.signer({ maxSigns: 1 }) });
    const led = S.ledger(); led.jobs[0].tokenDecimals = [null, null]; led.jobs[0].priceUsd = [null, null]; write(S, led);
    await S.run({ sweep: { maxUnswappedValueUsdc: 1000 }, signer: S.signer() });
    const reason = S.ledger().jobs[0].legs[0].reason;
    assert.ok(/no pinned decimals/.test(reason) && /no per-side USD price/.test(reason), reason);
    assert.ok(/no pinned decimals and no per-side USD price/.test(reason), reason);
  }
  console.log("collector-base-sweep-retired tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
