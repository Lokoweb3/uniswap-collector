// node test/collector-base-sweep-recovery.test.js -- acceptance 19-25: crash recovery from the ledger and the chain, attempts and stuck legs,
// recovery before new collects (also with the flag turned off), and state.json staying version 1. Mocked chain, no network.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const X = require("./lib/sweep-scene");
const { exitCodeOf } = require("../collector-base");

const { sweepScene, decodeSent, kindOf, OWNER, OP, USDC, WETH, E18, SL, L, lc, ID_A, ID_B, MGR_A, MGR_B } = X;
const AMT = 2n * E18 / 100n;
const wethPos = () => [{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 0n }];
const mk = (positions = wethPos(), o = {}) => { const S = sweepScene({ positions, ...o }); S.init(); return S; };
const names = (signer) => decodeSent(signer).map((t) => t.name);
const SHORT = { waitTimeoutSec: 0.05 };
const leg0 = (S) => S.ledger().jobs[0].legs[0];

(async () => {
  // ---- 19. the collect mined but the process never saw the receipt: the pending intent is resolved from the receipt's Collect event
  {
    const S = mk();
    const r1 = await S.run({ baseCollect: SHORT, signer: S.signer({ dropReceipt: (p) => kindOf(p) === "collect" }) });
    assert.strictEqual(r1.res.aborted, true, "the first run stopped on the unconfirmed collect");
    assert.deepStrictEqual(names(r1.signer), ["collect"]);
    const j = S.ledger().jobs[0];
    assert.strictEqual(j.legs.length, 0); assert.strictEqual(j.collect.status, "intent"); assert.strictEqual(j.pending.op, "collect");
    assert.strictEqual(S.balance(WETH, OP), AMT, "the fees are on the operator");
    assert.strictEqual(r1.state.gasSpends[0].kind, "unknown"); assert.strictEqual(r1.state.gasSpends[0].op, "collect");
    const r2 = await S.run({ signer: S.signer() });
    assert.deepStrictEqual(names(r2.signer), ["approve", "exactInputSingle", "transfer"], `no second collect\n${r2.text}`);
    assert.ok(/recovery: collect of #79371151 was mined; attributing from its receipt/.test(r2.text));
    assert.ok(/attributed \(Collect event\): 0\.02 WETH/.test(r2.text));
    assert.strictEqual(S.ledger().jobs.length, 1); assert.strictEqual(leg0(S).phase, "delivered"); assert.strictEqual(S.balance(WETH, OP), 0n);
    assert.ok(S.balance(USDC, OWNER) > 39_000_000n); assert.ok(r2.state.gasSpends.every((e) => e.kind === "settled"));
    // no Collect event in the receipt: unattributed (L3), no fallback to the simulated amounts, nothing swept from balances
    const N = mk(wethPos(), { noCollectEvent: true });
    const n1 = await N.run({ baseCollect: SHORT, signer: N.signer({ dropReceipt: (p) => kindOf(p) === "collect" }) });
    assert.strictEqual(n1.res.aborted, true);
    const n2 = await N.run({ signer: N.signer() });
    assert.strictEqual(n2.signer.sent.length, 0, n2.text); assert.strictEqual(N.ledger().jobs[0].collect.status, "unattributed");
    assert.strictEqual(N.balance(WETH, OP), AMT, "the fees stay on the operator, untouched");
    // neither usable: unattributed, nothing sent, reported, exit 1, new collects blocked
    const U = mk(wethPos(), { noCollectEvent: true });
    const u1 = await U.run({ baseCollect: SHORT, signer: U.signer({ dropReceipt: (p) => kindOf(p) === "collect" }) });
    assert.strictEqual(u1.res.aborted, true);
    U.w.on(WETH, "balanceOf", () => { throw new Error("rpc down"); });
    const u2 = await U.run({ signer: U.signer() });
    assert.strictEqual(u2.signer.sent.length, 0); assert.strictEqual(U.ledger().jobs[0].collect.status, "unattributed");
    assert.strictEqual(exitCodeOf(u2.res), 1); assert.ok(/UNATTRIBUTED/.test(U.notes[U.notes.length - 1]));
    const u3 = await U.run({ signer: U.signer() });
    assert.strictEqual(u3.signer.sent.length, 0, "an unattributed job is never swept from balances"); assert.strictEqual(exitCodeOf(u3.res), 1);
  }

  // ---- 20. collected-not-swapped (stop after the collect, and after the approve): a fresh quote, no duplicate collect, allowance reset
  {
    for (const [name, maxSigns, expect, preApproved] of [["after the collect", 1, ["approve", "exactInputSingle", "transfer"], false], ["after the approve", 2, ["exactInputSingle", "transfer"], true]]) {
      const S = mk();
      const r1 = await S.run({ signer: S.signer({ maxSigns }) });
      assert.strictEqual(r1.res.aborted, false);
      assert.strictEqual(leg0(S).phase, preApproved ? "approved" : "collected", name);
      assert.strictEqual(S.allowance(WETH, OP, SL.ROUTER), preApproved ? AMT : 0n);
      const oldQuote = S.quote("WETH", AMT); const oldMin = (oldQuote * 9950n) / 10000n;
      S.quoteFor.WETH = (a) => (S.mid("WETH", a) * 9970n) / 10000n; // the market moved: a different quote
      const r2 = await S.run({ signer: S.signer() });
      assert.deepStrictEqual(names(r2.signer), expect, `${name}\n${r2.text}`);
      const sw = decodeSent(r2.signer).find((t) => t.name === "exactInputSingle");
      const newQuote = (S.mid("WETH", AMT) * 9970n) / 10000n;
      assert.strictEqual(sw.args[0].amountOutMinimum, (newQuote * 9950n) / 10000n, `${name}: minOut from the new quote`);
      assert.notStrictEqual(sw.args[0].amountOutMinimum, oldMin, "the old minOut is not reused");
      assert.strictEqual(S.allowance(WETH, OP, SL.ROUTER), 0n, "the allowance is back to 0");
      assert.strictEqual(leg0(S).phase, "delivered"); assert.strictEqual(S.balance(WETH, OP), 0n);
      assert.strictEqual(S.txs.filter((t) => lc(t.to) === lc(MGR_A)).length, 1, `${name}: exactly one collect ever`);
    }
  }

  // ---- 21. swapped-not-sent: the swap receipt's USDC outRaw is delivered exactly, no second swap
  {
    const S = mk();
    const r1 = await S.run({ signer: S.signer({ maxSigns: 3 }) });
    assert.deepStrictEqual(names(r1.signer), ["collect", "approve", "exactInputSingle"]);
    const out = BigInt(leg0(S).swap.outRaw); assert.strictEqual(leg0(S).phase, "swapped"); assert.strictEqual(S.balance(USDC, OP), out);
    S.quoteFor.WETH = 1n; // a re-quote would now be worthless; nothing may ask
    const quotesBefore = S.w.callsTo(SL.QUOTER).length;
    const r2 = await S.run({ signer: S.signer() });
    assert.deepStrictEqual(names(r2.signer), ["transfer"], r2.text);
    assert.strictEqual(decodeSent(r2.signer)[0].args[1], out); assert.strictEqual(S.balance(USDC, OWNER), out);
    assert.strictEqual(S.w.callsTo(SL.QUOTER).length, quotesBefore, "no quote was asked for in the second run");
    assert.strictEqual(S.txs.filter((t) => lc(t.to) === lc(SL.ROUTER)).length, 1, "one swap ever");

    // the ledger write after the swap failed (a crash): the pending swap is resolved from its receipt's USDC Transfer log
    const T = mk(); let down = false; // the disk goes away right after the swap was mined
    T.failSaveAt = (n, ledger) => { const l = ledger.jobs[0] && ledger.jobs[0].legs[0]; if (l && l.swap && l.swap.tx) down = true; return down; };
    const t1 = await T.run({});
    assert.deepStrictEqual(names(t1.signer), ["collect", "approve", "exactInputSingle"]); assert.ok(/STOP: the sweep ledger cannot be written/.test(t1.text));
    assert.strictEqual(leg0(T).pending.op, "swap", "the ledger still says: swap pending"); assert.strictEqual(leg0(T).phase, "approved");
    const tout = T.balance(USDC, OP);
    T.failSaveAt = null;
    const t2 = await T.run({ signer: T.signer() });
    assert.deepStrictEqual(names(t2.signer), ["transfer"], t2.text);
    assert.ok(/recovery: swap of WETH \(#79371151\) succeeded; leg is swapped/.test(t2.text));
    assert.strictEqual(decodeSent(t2.signer)[0].args[1], tout); assert.strictEqual(T.balance(USDC, OWNER), tout);
  }

  // ---- 22. pending with no receipt: unused nonce waits; used nonce voids; never reserved voids
  {
    const stall = async () => {
      const S = mk();
      const r1 = await S.run({ baseCollect: SHORT, signer: S.signer({ neverMined: (p) => kindOf(p) === "exactInputSingle" }) });
      assert.strictEqual(r1.res.aborted, true); assert.strictEqual(leg0(S).pending.op, "swap");
      return { S, nonce: leg0(S).pending.nonce };
    };
    // unused nonce: the leg is skipped, no second swap
    {
      const { S, nonce } = await stall();
      S.w.latestNonce = nonce; // the node has not used it
      const r2 = await S.run({ signer: S.signer() });
      assert.strictEqual(r2.signer.sent.length, 0, `no second swap\n${r2.text}`); assert.strictEqual(S.signer().signs.length, 0);
      assert.ok(/recovery: swap of WETH \(#79371151\) waits \(nonce \d+ is not used yet/.test(r2.text));
      assert.strictEqual(leg0(S).pending.op, "swap"); assert.strictEqual(r2.res.sweep.report.pending, 1);
      assert.strictEqual(exitCodeOf(r2.res), 0, "waiting is not an error");
    }
    // used nonce, no receipt, and the node does not know the tx: run 1 waits, run 2 holds the leg as unattributed; NO second swap (M2)
    {
      const { S, nonce } = await stall();
      S.w.latestNonce = nonce + 1;
      const r2 = await S.run({ signer: S.signer() });
      assert.ok(/recovery: swap of WETH \(#79371151\) waits \(nonce \d+ is used but neither a receipt nor the transaction was found \(run 1 of 2\)/.test(r2.text), r2.text);
      assert.ok(!decodeSent(r2.signer).some((t) => t.name === "exactInputSingle"));
      const r3 = await S.run({ signer: S.signer() });
      assert.ok(/UNATTRIBUTED WETH of #79371151: swap .* has no receipt and is not found/.test(r3.text), r3.text);
      assert.ok(!decodeSent(r3.signer).some((t) => t.name === "exactInputSingle" || t.name === "transfer"), "no second swap, no transfer");
      assert.strictEqual(leg0(S).unattributed, true); assert.strictEqual(leg0(S).phase, "held"); assert.strictEqual(exitCodeOf(r3.res), 1);
    }
    // an intent that was never reserved (the budget file could not be written): voided at the next start
    {
      const S = mk();
      S.failStateAt = (st) => st.gasSpends.some((e) => e.op === "swap" && e.kind === "reserved");
      const r1 = await S.run({});
      assert.strictEqual(r1.res.aborted, true); assert.deepStrictEqual(names(r1.signer), ["collect", "approve"]);
      assert.strictEqual(leg0(S).pending.op, "swap"); assert.ok(!r1.state.gasSpends.some((e) => e.op === "swap"), "no reservation exists");
      S.failStateAt = null;
      const r2 = await S.run({ signer: S.signer() });
      assert.ok(/swap intent of WETH \(#79371151\) voided \(the intent has no gas reservation: it was never broadcast\)/.test(r2.text), r2.text);
      assert.deepStrictEqual(names(r2.signer), ["exactInputSingle", "transfer"]); assert.strictEqual(leg0(S).phase, "delivered");
    }
    // the same for the collect: voided, and the fees (still in the NFT) are collected normally
    {
      const S = mk();
      S.failStateAt = (st) => st.gasSpends.some((e) => e.op === "collect" && e.kind === "reserved");
      const r1 = await S.run({});
      assert.strictEqual(r1.signer.sent.length, 0); assert.strictEqual(S.ledger().jobs[0].pending.op, "collect");
      S.failStateAt = null;
      const r2 = await S.run({ signer: S.signer() });
      assert.ok(/collect intent of #79371151 voided/.test(r2.text), r2.text);
      assert.deepStrictEqual(names(r2.signer), ["collect", "approve", "exactInputSingle", "transfer"]);
      assert.deepStrictEqual(S.ledger().jobs.map((j) => j.collect.status), ["voided", "mined"]);
    }
  }

  // ---- 23. attempts: reverting swaps fall back to unswapped; a transfer that keeps reverting is stuck, reported every run, never redirected
  {
    const S = mk();
    S.failNext.push(Object.assign((p) => lc(p.to) === lc(SL.ROUTER), { sticky: true }));
    const r = await S.run({});
    assert.deepStrictEqual(names(r.signer), ["collect", "approve", "exactInputSingle", "approve", "approve", "exactInputSingle", "approve", "approve", "exactInputSingle", "approve", "transfer"], r.text);
    assert.strictEqual(S.allowance(WETH, OP, SL.ROUTER), 0n);
    assert.strictEqual(leg0(S).phase, "delivered-unswapped"); assert.strictEqual(leg0(S).attempts, 3);
    assert.strictEqual(decodeSent(r.signer).pop().args[0], OWNER); assert.strictEqual(S.balance(WETH, OWNER), AMT);
    assert.ok(/swap failed 3 times/.test(r.text) && /delivered unswapped/.test(r.text));

    const T = mk();
    T.failNext.push(Object.assign((p) => kindOf(p) === "transfer", { sticky: true }));
    const t1 = await T.run({});
    assert.strictEqual(leg0(T).phase, "stuck"); assert.strictEqual(leg0(T).tAttempts, 3); assert.strictEqual(exitCodeOf(t1.res), 1);
    assert.strictEqual(t1.res.sweep.report.stuck.length, 1); assert.ok(/STUCK WETH of #79371151/.test(t1.text));
    assert.ok(decodeSent(t1.signer).filter((t) => t.name === "transfer").every((t) => t.args[0] === OWNER && t.args[1] <= 10n ** 30n), "every attempt went to the owner");
    assert.ok(/STUCK: #79371151/.test(T.notes[0]));
    const n1 = t1.signer.sent.length;
    // a new fee appears on the other manager: new collects are blocked while a leg is stuck
    T.addPosition({ id: ID_B, mgr: MGR_B, t0: WETH, t1: USDC, a0: AMT, a1: 0n });
    T.failNext.length = 0;
    const t2 = await T.run({ signer: T.signer() });
    assert.strictEqual(t2.signer.sent.length, 0, `nothing is sent: no retry of the stuck leg, no new collect\n${t2.text}`);
    assert.ok(/sweep: new collects are blocked \(job .* has a stuck leg\)/.test(t2.text)); assert.strictEqual(exitCodeOf(t2.res), 1);
    assert.strictEqual(t2.res.sweep.report.stuck.length, 1, "reported again every run"); assert.ok(n1 > 0);
    assert.strictEqual(T.balance(WETH, OWNER), 0n, "never redirected");
  }

  // ---- 24. recovery runs before new collects, also with the flag turned off (no new job starts)
  {
    const S = mk([...wethPos(), { id: ID_B, mgr: MGR_B, t0: WETH, t1: USDC, a0: AMT, a1: 0n }]);
    // run 1 collects only A (the second position is not there yet), stops after the collect
    const only = S.pos[ID_B]; delete S.pos[ID_B];
    await S.run({ signer: S.signer({ maxSigns: 1 }) });
    assert.strictEqual(leg0(S).phase, "collected");
    S.pos[ID_B] = only;
    const r2 = await S.run({ sweep: { enabled: false }, signer: S.signer() });
    const sent = decodeSent(r2.signer);
    assert.deepStrictEqual(sent.map((t) => t.name), ["approve", "exactInputSingle", "transfer", "collect"], `the open leg is finished first\n${r2.text}`);
    assert.strictEqual(sent[3].args[0].recipient, OWNER, "the new collect is the plain one, to the owner: no new job");
    assert.strictEqual(S.ledger().jobs.length, 1); assert.strictEqual(leg0(S).phase, "delivered");
    assert.ok(/sweep: disabled .*finishing the open legs of earlier jobs, no new job starts/.test(r2.text));
    assert.strictEqual(S.balance(WETH, OWNER), AMT, "B's fees went straight to the owner");
    assert.strictEqual(r2.state.gasSpends.at(-1).op, undefined, "the plain collect carries no op");
    // recovery precedes the new collect even when the sweep stays on
    const T = mk([...wethPos()]);
    await T.run({ signer: T.signer({ maxSigns: 1 }) });
    T.addPosition({ id: ID_B, mgr: MGR_B, t0: WETH, t1: USDC, a0: AMT, a1: 0n });
    const t2 = await T.run({ signer: T.signer() });
    assert.deepStrictEqual(names(t2.signer), ["approve", "exactInputSingle", "transfer", "collect", "approve", "exactInputSingle", "transfer"]);
  }

  // ---- 25. state.json stays version 1; new entries carry a valid op; an invalid op is corrupt
  {
    const S = mk(); await S.run({});
    const text = L.serializeState(S.state);
    assert.strictEqual(JSON.parse(text).version, 1); assert.strictEqual(L.STATE_VERSION, 1);
    assert.ok(JSON.parse(text).gasSpends.every((e) => SL.OPS.includes(e.op)));
    const dir = fs.mkdtempSync(path.join(X.TMP, "st-")); const f = path.join(dir, "state.json");
    const t = (e) => { fs.writeFileSync(f, JSON.stringify({ version: 1, gasSpends: [{ t: 1, wei: "5", ...e }] })); return L.readState(f); };
    for (const op of SL.OPS) assert.ok(t({ op }).ok, op);
    assert.ok(t({}).ok, "an entry without op is still valid");
    for (const op of ["bogus", "", 5, null, "Swap", "collect "]) { const r = t({ op }); assert.ok(!r.ok && r.kind === "corrupt" && /op is not a known sweep op/.test(r.reason), String(op)); }
    // and a run refuses to send on such a file
    fs.writeFileSync(f, JSON.stringify({ version: 1, gasSpends: [{ t: 1, wei: "5", op: "bogus" }] }));
    const bad = await mk().run({ extra: { readState: () => L.readState(f) } });
    assert.strictEqual(bad.signer.sent.length, 0); assert.ok(bad.res.aborted);
  }

  // ---- the ledger itself fails closed (D9)
  {
    const f = path.join(fs.mkdtempSync(path.join(X.TMP, "lg-")), "sweep-state.json");
    const good = { id: "j", tokenId: "1", manager: MGR_A, owner: OWNER, collect: { status: "mined" }, createdAt: 1, pending: null, legs: [{ token: WETH, owedRaw: "5", doneRaw: "0", phase: "collected", attempts: 0, pending: null }] };
    const t = (mutate) => { const j = JSON.parse(JSON.stringify(good)); mutate(j); fs.writeFileSync(f, JSON.stringify({ version: 1, jobs: [j] })); return SL.readSweepState(f); };
    assert.ok(t(() => {}).ok);
    for (const [name, m] of [["bad phase", (j) => { j.legs[0].phase = "nope"; }], ["manager not allowlisted", (j) => { j.manager = USDC; }], ["done > owed", (j) => { j.legs[0].doneRaw = "6"; }],
      ["owed not a string", (j) => { j.legs[0].owedRaw = 5; }], ["pending op", (j) => { j.legs[0].pending = { op: "sudo", tx: null, nonce: 1 }; }], ["pending nonce", (j) => { j.legs[0].pending = { op: "swap", tx: null, nonce: -1 }; }],
      ["no collect status", (j) => { j.collect = {}; }], ["token not an address", (j) => { j.legs[0].token = "x"; }], ["tokenId", (j) => { j.tokenId = "-1"; }]]) {
      const r = t(m); assert.ok(!r.ok && r.kind === "corrupt", name);
    }
    fs.writeFileSync(f, JSON.stringify({ version: 1, jobs: [] })); fs.chmodSync(f, 0o600);
    assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    L.writeFileAtomic(f, SL.serializeSweepState({ jobs: [] })); assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600, "written with mode 0600");
    // terminal jobs are kept 30 days, open ones always
    const old = { ...good, collect: { status: "mined" }, legs: [{ ...good.legs[0], phase: "delivered" }], finishedAt: 1000 }, open = { ...good, id: "o", createdAt: 1 };
    const kept = JSON.parse(SL.serializeSweepState({ jobs: [old, open] }, 1000 + 31 * 86400_000)).jobs.map((j) => j.id);
    assert.deepStrictEqual(kept, ["o"]);
    assert.deepStrictEqual(JSON.parse(SL.serializeSweepState({ jobs: [old, open] }, 1000 + 29 * 86400_000)).jobs.map((j) => j.id), ["j", "o"]);
  }
  console.log("collector-base-sweep-recovery tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
