// node test/collector-base-sweep-agehold.test.js -- the "age hold" round of the Base sweep: an old collect is only HELD (warning from ~day 20), the head
// check allows 64 blocks of slack, an RPC failure at start is kind "rpc", and pruning needs the chain's age as well as the clock's (security Low-2).
// Mocked chain, no network, no key.
"use strict";
const assert = require("assert");
const fs = require("fs");
const X = require("./lib/sweep-scene");
const sweepMod = require("../collector-base-sweep");

const { sweepScene, OWNER, OP, USDC, WETH, E18, SL, ID_A, MGR_A } = X;
const clone = (x) => JSON.parse(JSON.stringify(x));
const DAY = 24 * 3600 * 1000;
const hex = (n) => "0x" + n.toString(16).padStart(64, "0");
const wethPos = () => [{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: 2n * E18 / 100n, a1: 0n }];
const write = (S, obj) => fs.writeFileSync(S.file, JSON.stringify(obj));
const starter = (S, provider) => sweepMod.create({ sw: SL.config({ enabled: true }), provider, operator: OP, log() {}, now: () => Date.now(), io: S.io, owners: [OWNER] });

(async () => {
  // ---- 1. the day-20 warning thresholds (pure)
  {
    const head = 5_000_000;
    assert.strictEqual(SL.COLLECT_WARN_BLOCKS, 864000, "20 days of 2 s blocks");
    assert.strictEqual(SL.collectAgeWarning(head, head - SL.COLLECT_WARN_BLOCKS), null, "exactly day 20: no warning yet");
    assert.ok(/about 20 days old/.test(SL.collectAgeWarning(head, head - SL.COLLECT_WARN_BLOCKS - 1)));
    assert.ok(SL.collectAgeWarning(head, head - SL.COLLECT_MAX_AGE_BLOCKS) !== null, "just inside the limit: still a warning");
    assert.strictEqual(SL.collectAgeWarning(head, head - SL.COLLECT_MAX_AGE_BLOCKS - 1), null, "past the limit it is the hold, not a warning");
  }

  // ---- 2. a day-21 collect still proceeds, with a warning in the log and in the Telegram summary; a past-limit one is held and does not block a new collect
  {
    const S = sweepScene({ positions: wethPos() }); S.init(); await S.run({});
    const led = S.ledger(); const collectBlock = led.jobs[0].collect.block;
    const rewind = (l) => { const lg = l.jobs[0].legs[0]; lg.phase = "collected"; lg.doneRaw = "0"; lg.outDone = undefined; lg.deliver = null; lg.swap = { amountIn: null, quoteRaw: null, minOutRaw: null, outRaw: "0", tx: null }; };
    rewind(led); delete led.retired; write(S, led);
    S.add(WETH, OP, 2n * E18 / 100n); // the rewound leg owes WETH again
    S.w.head = collectBlock + 21 * 43200;
    S.notes = [];
    const run = await S.run({ signer: S.signer() });
    assert.strictEqual(S.ledger().jobs[0].legs[0].phase, "delivered", "day 21: not held: " + run.text);
    assert.ok(/WARNING #\d+ collect 0x[0-9a-f]+: .*about 21 days old/.test(run.text), run.text);
    assert.ok(S.notes.some((n) => /WARNING: #\d+ collect .*about 21 days old/.test(n)), "the Telegram summary carries the warning: " + JSON.stringify(S.notes));
    // past the limit: held (not unattributed), reported, and a new position is still collected
    const l2 = S.ledger(); rewind(l2); write(S, l2);
    S.addPosition({ id: X.ID_B, mgr: X.MGR_B, t0: X.CBBTC, t1: USDC, a0: 100_000n, a1: 0n });
    S.w.head = collectBlock + SL.COLLECT_MAX_AGE_BLOCKS + 10;
    S.notes = [];
    const r2 = await S.run({ signer: S.signer() });
    const a = S.ledger();
    assert.strictEqual(a.jobs[0].legs[0].phase, "held"); assert.ok(!a.jobs[0].legs[0].unattributed, "held, not unattributed");
    assert.strictEqual(a.jobs.length, 2, "the new collect went ahead: " + r2.text);
    assert.ok(S.notes.some((n) => /HELD: #\d+ WETH: collect .*more than 1166400 blocks/.test(n)), "the held leg is in the summary: " + JSON.stringify(S.notes));
  }

  // ---- 3. head check with 64 blocks of slack, at start (both sides of the boundary)
  {
    const S = sweepScene({ positions: wethPos() }); S.init(); await S.run({});
    const base = S.ledger(); const HEAD = 1_000_000;
    assert.strictEqual(SL.HEAD_SLACK_BLOCKS, 64);
    for (const [delta, ok] of [[64, true], [65, false]]) {
      const l = clone(base); l.jobs[0].collect.block = HEAD + delta; write(S, l);
      const r = await starter(S, S.w.runner).start({ simulate: false });
      assert.strictEqual(r.ok, ok, `head + ${delta}: ${JSON.stringify(r)}`);
      if (!ok) assert.ok(r.kind === "corrupt" && /above the chain head/.test(r.reason), JSON.stringify(r));
    }
    assert.strictEqual(SL.ledgerAheadProblem({ jobs: [], retired: { floor: HEAD + 64, hashes: [], collectBlock: {} } }, HEAD), null);
    assert.ok(SL.ledgerAheadProblem({ jobs: [], retired: { floor: HEAD + 65, hashes: [], collectBlock: {} } }, HEAD));
  }

  // ---- 4. an RPC failure at start is kind "rpc", not "corrupt"; the sweep still refuses everything
  {
    const S = sweepScene({ positions: wethPos() }); S.init(); await S.run({});
    const failing = new Proxy(S.w.runner, { get: (t, k) => (k === "getBlockNumber" ? async () => { throw new Error("rpc down"); } : t[k]) });
    const r = await starter(S, failing).start({ simulate: false });
    assert.ok(!r.ok && r.kind === "rpc" && /RPC failed/.test(r.reason) && !/unreadable/.test(r.reason), JSON.stringify(r));
    // a corrupt file keeps kind corrupt
    fs.writeFileSync(S.file, "{ not json");
    const r2 = await starter(S, S.w.runner).start({ simulate: false });
    assert.ok(!r2.ok && r2.kind === "corrupt", JSON.stringify(r2));
  }

  // ---- 5. finishedAt is validated
  {
    const S = sweepScene({ positions: wethPos() }); S.init(); await S.run({});
    const job = S.ledger().jobs[0];
    assert.ok(typeof job.finishedAt === "number", "a terminal job carries finishedAt");
    assert.strictEqual(SL.jobProblem(job), null);
    for (const bad of ["yesterday", NaN, null, 0, -5, Date.now() + DAY, Infinity, {}]) {
      const j = clone(job); j.finishedAt = bad;
      assert.ok(/finishedAt/.test(SL.jobProblem(j) || ""), `finishedAt ${String(bad)} is a problem`);
    }
    const j = clone(job); j.finishedAt = Date.now() + 60_000; assert.strictEqual(SL.jobProblem(j), null, "a minute of clock skew is tolerated");
    const l = S.ledger(); l.jobs[0].finishedAt = Date.now() + 30 * DAY; write(S, l);
    const r = SL.readSweepState(S.file); assert.ok(!r.ok && r.kind === "corrupt" && /finishedAt/.test(r.reason), JSON.stringify(r));
  }

  // ---- 6. pruning needs clock age AND chain age
  {
    const mk = (fin, block) => ({ id: "j", tokenId: "1", manager: MGR_A, owner: OWNER, token0: WETH, token1: USDC, collect: { tx: hex(7), status: "mined", block }, maxBlock: block + 3, pending: null, createdAt: fin, finishedAt: fin, legs: [] });
    const B = SL.KEEP_TERMINAL_BLOCKS; assert.strictEqual(B, 1_296_000);
    const jobsAfter = (job, head) => JSON.parse(SL.serializeSweepState({ jobs: [job], retired: SL.emptyRetired() }, Date.now(), head)).jobs.length;
    const old = Date.now() - 40 * DAY;
    assert.strictEqual(jobsAfter(mk(old, 9000), 9003 + B), 0, "clock-old and chain-old: pruned");
    assert.strictEqual(jobsAfter(mk(old, 9000), 9003 + B - 1), 1, "clock-old but chain-young (one block short): kept");
    assert.strictEqual(jobsAfter(mk(old, 9000), 9100), 1, "clock-old but chain-young: kept");
    assert.strictEqual(jobsAfter(mk(old, 9000), undefined), 1, "no known head: nothing is pruned");
    assert.strictEqual(jobsAfter(mk(Date.now() - DAY, 9000), 9003 + 2 * B), 1, "chain-old but clock-young: kept");
    const kept = JSON.parse(SL.serializeSweepState({ jobs: [mk(old, 9000)], retired: SL.emptyRetired() }, Date.now(), 9100));
    assert.ok(!kept.retired, "a kept job retires nothing");
  }
  console.log("collector-base-sweep-agehold tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
