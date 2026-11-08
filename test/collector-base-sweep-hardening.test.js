// node test/collector-base-sweep-hardening.test.js -- the fix round after 4a2b63a: readSweepState validates priceUsd / token0 / token1 / tokenDecimals (L-1),
// pending swap hashes join the ledger-wide uniqueness set and a recovered swap hash that collides is not credited (L-2), removed logs are ignored,
// tokenDecimals is pinned on the job, and the Transfer-log proof is preferred to the balance fall. Mocked chain, no network, no key.
"use strict";
const assert = require("assert");
const fs = require("fs");
const X = require("./lib/sweep-scene");
const { exitCodeOf } = require("../collector-base");

const { sweepScene, decodeSent, kindOf, OWNER, OP, USDC, WETH, OTHER, E18, SL, lc, ID_A, MGR_A } = X;
const AMT = 2n * E18 / 100n;
const wethPos = () => [{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 0n }];
const otherPos = () => [{ id: ID_A, mgr: MGR_A, t0: USDC, t1: OTHER, a0: 0n, a1: 5n * E18 }];
const mk = (positions = wethPos(), o = {}) => { const S = sweepScene({ positions, ...o }); S.init(); return S; };
const names = (signer) => decodeSent(signer).map((t) => t.name);
const leg0 = (S) => S.ledger().jobs[0].legs[0];
const clone = (x) => JSON.parse(JSON.stringify(x));
const SHORT = { waitTimeoutSec: 0.05 };
const H1 = "0x" + "11".repeat(32), H2 = "0x" + "22".repeat(32);

(async () => {
  // ---- L-1. priceUsd / token0 / token1 / tokenDecimals are validated; anything invalid makes the ledger corrupt
  {
    const S = mk(); await S.run({});
    const base = S.ledger(); const j0 = base.jobs[0];
    assert.deepStrictEqual(j0.tokenDecimals, [18, 6], "the decimals are pinned at job creation");
    assert.ok(lc(j0.token0) === lc(WETH) && lc(j0.token1) === lc(USDC));
    const t = (mutate) => { const b = clone(base); mutate(b.jobs[0]); fs.writeFileSync(S.file, JSON.stringify(b)); return SL.readSweepState(S.file); };
    assert.ok(t(() => {}).ok);
    for (const ok of [[null, 1.5], [0, 0], [3, null], undefined, null]) assert.ok(t((j) => { j.priceUsd = ok; }).ok, `priceUsd ${JSON.stringify(ok)} is valid`);
    for (const bad of ["5", 5, [1], [1, 2, 3], [-1, 1], ["1", 2], [{}, 1], [true, 1], [1, [2]], {}]) {
      const r = t((j) => { j.priceUsd = bad; }); assert.ok(!r.ok && r.kind === "corrupt" && /priceUsd/.test(r.reason), `priceUsd ${JSON.stringify(bad)}: ${JSON.stringify(r)}`);
    }
    for (const bad of [undefined, null, "x", 5, "0x1234", "0x" + "zz".repeat(20)]) {
      for (const f of ["token0", "token1"]) { const r = t((j) => { j[f] = bad; }); assert.ok(!r.ok && r.kind === "corrupt" && new RegExp(`${f} is not an address`).test(r.reason), `${f} ${JSON.stringify(bad)}: ${JSON.stringify(r)}`); }
    }
    let r = t((j) => { j.token1 = j.token0; }); assert.ok(!r.ok && /token0 equals token1/.test(r.reason), JSON.stringify(r));
    // a leg token that is neither of the position's tokens
    r = t((j) => { j.legs[0].token = OTHER; }); assert.ok(!r.ok && /is not token0 or token1 of the position/.test(r.reason), JSON.stringify(r));
    r = t((j) => { j.token0 = OTHER; }); assert.ok(!r.ok && /is not token0 or token1 of the position/.test(r.reason), JSON.stringify(r));
    for (const bad of ["18", [18], [18, 6, 1], [1.5, 6], [-1, 6], [18, 37], [18, "6"], {}]) {
      r = t((j) => { j.tokenDecimals = bad; }); assert.ok(!r.ok && r.kind === "corrupt" && /tokenDecimals/.test(r.reason), `tokenDecimals ${JSON.stringify(bad)}: ${JSON.stringify(r)}`);
    }
    assert.ok(t((j) => { j.tokenDecimals = [null, 6]; }).ok && t((j) => { delete j.tokenDecimals; }).ok, "null entries and older ledgers without tokenDecimals read");
    // a run on a ledger with an invalid field fails closed
    t((j) => { j.priceUsd = [-1, 1]; });
    const run = await S.run({ signer: S.signer() });
    assert.ok(/sweep-state\.json is unreadable/.test(run.text) && /priceUsd/.test(run.text), run.text); assert.strictEqual(run.signer.sent.length, 0);
  }

  // ---- L-2. a pending op:"swap" hash is in the ledger-wide uniqueness set
  {
    const S = mk(); await S.run({});
    const base = S.ledger(); const swapHash = base.jobs[0].legs[0].swap.tx; const collectHash = base.jobs[0].collect.tx;
    const write = (b) => fs.writeFileSync(S.file, JSON.stringify(b));
    const pend = (tx) => ({ op: "swap", tx, nonce: 7 });
    const second = (b, mut) => { const j2 = clone(b.jobs[0]); j2.id = "other:2:2"; j2.collect.tx = H1; j2.legs[0].swap = { amountIn: null, quoteRaw: null, minOutRaw: null, outRaw: "0", tx: null }; mut(j2); b.jobs.push(j2); return b; };
    // another job's pending swap equals a recorded swap hash (case does not hide it)
    for (const h of [swapHash, swapHash.toUpperCase().replace("0X", "0x")]) {
      const b = second(clone(base), (j) => { j.legs[0].pending = pend(h); }); write(b);
      const r = SL.readSweepState(S.file); assert.ok(!r.ok && r.kind === "corrupt" && /already recorded for another leg/.test(r.reason), JSON.stringify(r));
    }
    // a pending swap equals a collect transaction
    let b = second(clone(base), (j) => { j.legs[0].pending = pend(collectHash); }); write(b);
    let r = SL.readSweepState(S.file); assert.ok(!r.ok && /equals a collect transaction/.test(r.reason), JSON.stringify(r));
    // the pending swap of this same job's first leg is later in the ledger: two pending swaps with one hash
    b = clone(base); b.jobs[0].legs[0].swap.tx = null; b.jobs[0].legs[0].swap.txs = []; b.jobs[0].legs[0].pending = pend(H2); b = second(b, (j) => { j.legs[0].pending = pend(H2); }); write(b);
    r = SL.readSweepState(S.file); assert.ok(!r.ok && /already recorded for another leg/.test(r.reason), JSON.stringify(r));
    // distinct pending swap hashes, and a pending hash that is the leg's own recorded hash, are fine; a non-swap pending hash is not in the set
    b = second(clone(base), (j) => { j.legs[0].pending = pend(H2); }); write(b); assert.ok(SL.readSweepState(S.file).ok);
    b = clone(base); b.jobs[0].legs[0].pending = pend(swapHash); write(b); assert.ok(SL.readSweepState(S.file).ok, "the same leg may list its own hash");
    b = second(clone(base), (j) => { j.legs[0].pending = { op: "transfer", tx: swapHash, nonce: 7 }; }); write(b); assert.ok(SL.readSweepState(S.file).ok, "only op:swap pending hashes count");
  }

  // ---- L-2. recovery: a newly found swap hash is checked against all other legs and jobs before it is credited
  {
    const stall = async () => {
      const S = mk();
      const r1 = await S.run({ baseCollect: SHORT, signer: S.signer({ dropReceipt: (p) => kindOf(p) === "exactInputSingle" }) });
      assert.strictEqual(r1.res.aborted, true); assert.strictEqual(leg0(S).pending.op, "swap");
      return S;
    };
    // control: untampered, the recovered swap is credited
    {
      const S = await stall(); const h = leg0(S).pending.tx;
      const r = await S.run({ signer: S.signer() });
      assert.ok(/recovery: swap of WETH \(#79371151\) succeeded; leg is swapped/.test(r.text), r.text); assert.strictEqual(leg0(S).swap.tx, h);
    }
    // the pending swap hash is also recorded on another job's leg (a ledger that readSweepState would refuse is injected past the reader)
    for (const where of ["swap hash of another job", "collect.tx of another job", "pending swap of another job"]) {
      const S = await stall(); const led = S.ledger(); const h = led.jobs[0].legs[0].pending.tx;
      const j2 = clone(led.jobs[0]); j2.id = "other:2:2"; j2.collect.tx = H1; j2.collect.status = "mined"; j2.pending = null;
      j2.legs[0] = { ...j2.legs[0], phase: "delivered", doneRaw: j2.legs[0].owedRaw, pending: null, swap: { amountIn: null, quoteRaw: null, minOutRaw: null, outRaw: "0", tx: null } };
      if (where === "swap hash of another job") { j2.legs[0].swap.tx = h; j2.legs[0].swap.txs = [h]; }
      else if (where === "collect.tx of another job") j2.collect.tx = h;
      else { j2.legs[0].phase = "collected"; j2.legs[0].doneRaw = "0"; j2.legs[0].pending = { op: "swap", tx: h, nonce: 9 }; }
      led.jobs.push(j2);
      S.io.read = () => ({ ok: true, ledger: led }); // bypasses readSweepState: defence in depth
      const before = S.balance(USDC, OP);
      const r = await S.run({ signer: S.signer() });
      const l = led.jobs[0].legs[0];
      assert.strictEqual(l.unattributed, true, `${where}\n${r.text}`); assert.strictEqual(l.phase, "held", where);
      assert.strictEqual(l.doneRaw, "0", `${where}: nothing credited`); assert.ok(!l.swap.tx && (l.swap.outRaw === "0" || l.swap.outRaw === undefined), `${where}: ${JSON.stringify(l.swap)}`);
      assert.ok(/recovered swap 0x[0-9a-f]+ is already recorded for another leg or job/.test(r.text), r.text);
      assert.ok(!decodeSent(r.signer).some((t) => t.name === "transfer" || t.name === "exactInputSingle"), `${where}: nothing sent`);
      assert.strictEqual(exitCodeOf(r.res), 1, where); assert.strictEqual(S.balance(USDC, OWNER), 0n); assert.strictEqual(S.balance(USDC, OP), before, `${where}: operator balance unchanged`);
    }
  }

  // ---- Info. removed (reorged) logs are ignored by the swap-output parse and the Collect parse
  {
    const rm = (logs) => logs.map((l) => ({ ...l, removed: true }));
    const S = mk();
    const r = await S.run({ signer: S.signer({ receiptTweak: (rc, p) => (kindOf(p) === "exactInputSingle" ? { ...rc, logs: rm(rc.logs) } : rc) }) });
    assert.strictEqual(leg0(S).unattributed, true, r.text); assert.ok(/swap receipt has no USDC transfer to the operator/.test(leg0(S).reason), leg0(S).reason);
    assert.ok(!names(r.signer).includes("transfer"), "nothing is delivered for a swap whose only Transfer log was removed");
    const C = mk();
    const c = await C.run({ signer: C.signer({ receiptTweak: (rc, p) => (kindOf(p) === "collect" ? { ...rc, logs: rm(rc.logs) } : rc) }) });
    assert.strictEqual(C.ledger().jobs[0].collect.status, "unattributed", c.text); assert.deepStrictEqual(names(c.signer), ["collect"]);
    // recovery of a swap whose receipt logs were all removed
    const R = mk();
    await R.run({ baseCollect: SHORT, signer: R.signer({ dropReceipt: (p) => kindOf(p) === "exactInputSingle" }) });
    const h = leg0(R).pending.tx; R.mined.set(h, { ...R.mined.get(h), logs: rm(R.mined.get(h).logs) });
    await R.run({ signer: R.signer() });
    const rl = leg0(R); assert.strictEqual(rl.unattributed, true); assert.strictEqual(rl.phase, "held");
    assert.ok(!rl.swap.outRaw || rl.swap.outRaw === "0", `no proceeds credited: ${JSON.stringify(rl.swap)}`); assert.ok(!rl.outDone || rl.outDone === "0"); assert.strictEqual(R.balance(USDC, OWNER), 0n);
  }

  // ---- Info. tokenDecimals is pinned on the job: used for the value cap, and a live decimals() that differs is refused
  {
    const mkO = (o = {}) => { const S = mk(otherPos(), { feesUsd: 50, usd1: 10, ...o }); S.hooks.push((p) => { if (kindOf(p) === "collect" && S.changeDecimals) S.w.on(OTHER, "decimals", () => [S.changeDecimals]); }); return S; };
    // control: pinned 18, live 18: 5 tokens x 10 USD = 50 under the cap, delivered
    const A = mkO(); const a = await A.run({ sweep: { maxUnswappedValueUsdc: 1000 } });
    assert.deepStrictEqual(names(a.signer), ["collect", "transfer"], a.text); assert.deepStrictEqual(A.ledger().jobs[0].tokenDecimals, [6, 18]);
    // decimals() changes after the collect (6 instead of 18 would value the leg at a million times less): held, not delivered
    const B = mkO(); B.changeDecimals = 6;
    const b = await B.run({ sweep: { maxUnswappedValueUsdc: 1000 } });
    assert.deepStrictEqual(names(b.signer), ["collect"], b.text); assert.strictEqual(leg0(B).phase, "held");
    assert.ok(/decimals\(\) of .* is 6 now but 18 was pinned on the job; refusing/.test(leg0(B).reason), leg0(B).reason); assert.strictEqual(B.balance(OTHER, OWNER), 0n);
    // no pinned decimals (older ledger / unreadable at plan time): no value can be established, held
    const C = mkO();
    await C.run({ sweep: { maxUnswappedValueUsdc: 1000 }, signer: C.signer({ maxSigns: 1 }) });
    const led = C.ledger(); led.jobs[0].tokenDecimals = [null, null]; fs.writeFileSync(C.file, JSON.stringify(led));
    const c = await C.run({ sweep: { maxUnswappedValueUsdc: 1000 }, signer: C.signer() });
    assert.strictEqual(leg0(C).phase, "held", c.text); assert.ok(/no value can be established/.test(leg0(C).reason) && /no pinned decimals/.test(leg0(C).reason), leg0(C).reason); assert.strictEqual(C.balance(OTHER, OWNER), 0n);
  }

  // ---- Info. the Transfer-log proof is preferred; the balance fall alone proves a transfer only when the logs are unavailable
  {
    const tweak = (f) => (rc, p) => (kindOf(p) === "transfer" ? { ...rc, logs: f(rc.logs) } : rc);
    // logs available but no matching one, while the operator balance DID fall (another outflow could fake that): not proven
    const wrong = { "other amount": (ls) => [{ ...ls[0], data: "0x" + (1n).toString(16).padStart(64, "0") }], "other recipient": (ls) => [{ ...ls[0], topics: [ls[0].topics[0], ls[0].topics[1], "0x" + "00".repeat(12) + "ee".repeat(20)] }], "other token": (ls) => [{ ...ls[0], address: WETH }] };
    for (const [name, f] of Object.entries(wrong)) {
      const S = mk(); const r = await S.run({ signer: S.signer({ receiptTweak: tweak(f) }) });
      assert.strictEqual(leg0(S).unattributed, true, `${name}\n${r.text}`); assert.strictEqual(leg0(S).phase, "held", name); assert.ok(/matching Transfer log/.test(leg0(S).reason), leg0(S).reason);
      assert.ok(BigInt(leg0(S).outDone || "0") === 0n, `${name}: not credited`);
    }
    // logs unavailable, a NON-route token (OTHER, unswapped): the balance fall at the receipt block alone proves it
    const O = { feesUsd: 50, usd1: 10 }, OS = { sweep: { maxUnswappedValueUsdc: 1000 } };
    const S = mk(otherPos(), O); const r = await S.run({ ...OS, signer: S.signer({ receiptTweak: tweak(() => []) }) });
    assert.deepStrictEqual(names(r.signer), ["collect", "transfer"], r.text); assert.strictEqual(leg0(S).phase, "delivered-unswapped"); assert.strictEqual(exitCodeOf(r.res), 0);
    assert.strictEqual(S.balance(OTHER, OWNER), 5n * E18);
    // ...and no balance fall with the logs unavailable is not proof
    const N = mk(otherPos(), O); N.noBalanceMove = true; const n = await N.run({ ...OS, signer: N.signer({ receiptTweak: tweak(() => []) }) });
    assert.strictEqual(leg0(N).unattributed, true, n.text);
    // USDC (proceeds) and a route token (WETH, unswapped by a swap-off route): a status-1 receipt with empty logs is NOT proof, even though the balance fell
    {
      const U = mk(); const u = await U.run({ signer: U.signer({ receiptTweak: tweak(() => []) }) });
      assert.strictEqual(leg0(U).unattributed, true, u.text); assert.strictEqual(leg0(U).phase, "held"); assert.ok(/matching Transfer log/.test(leg0(U).reason), leg0(U).reason);
      assert.ok(BigInt(leg0(U).outDone || "0") === 0n, "USDC proceeds with empty logs are not credited"); assert.strictEqual(exitCodeOf(u.res), 1);
      const W2 = mk(wethPos(), { feesUsd: 50, usd0: 2500 }); const w = await W2.run({ sweep: { maxUnswappedValueUsdc: 1000, routes: { WETH: { enabled: false } } }, signer: W2.signer({ receiptTweak: tweak(() => []) }) });
      assert.deepStrictEqual(names(w.signer), ["collect", "transfer"], w.text); assert.strictEqual(leg0(W2).unattributed, true, w.text); assert.ok(BigInt(leg0(W2).doneRaw || "0") === 0n, "route token with empty logs is not credited");
    }
    // recovery: balance fall alone credits a recovered transfer (non-route token) whose receipt has no logs
    const R = mk(otherPos(), O);
    const r1 = await R.run({ ...OS, baseCollect: SHORT, signer: R.signer({ dropReceipt: (p) => kindOf(p) === "transfer" }) });
    assert.strictEqual(r1.res.aborted, true);
    const pend = leg0(R).pending; R.mined.set(pend.tx, { ...R.mined.get(pend.tx), logs: [] });
    await R.run({ ...OS, signer: R.signer() });
    assert.notStrictEqual(leg0(R).unattributed, true); assert.strictEqual(leg0(R).doneRaw, pend.raw); assert.strictEqual(leg0(R).deliver.tx, pend.tx);
    // recovery: a USDC transfer with empty logs is not credited though the balance fell
    const RU = mk();
    await RU.run({ baseCollect: SHORT, signer: RU.signer({ dropReceipt: (p) => kindOf(p) === "transfer" }) });
    const pu = leg0(RU).pending; RU.mined.set(pu.tx, { ...RU.mined.get(pu.tx), logs: [] });
    await RU.run({ signer: RU.signer() });
    assert.strictEqual(leg0(RU).unattributed, true); assert.ok(!leg0(RU).outDone || leg0(RU).outDone === "0");
    // recovery: logs available but not matching, balance fell: not credited
    const W = mk();
    await W.run({ baseCollect: SHORT, signer: W.signer({ dropReceipt: (p) => kindOf(p) === "transfer" }) });
    const wp = leg0(W).pending; const wl = W.mined.get(wp.tx).logs[0];
    W.mined.set(wp.tx, { ...W.mined.get(wp.tx), logs: [{ ...wl, data: "0x" + (1n).toString(16).padStart(64, "0") }] });
    await W.run({ signer: W.signer() });
    assert.strictEqual(leg0(W).unattributed, true); assert.ok(leg0(W).outDone === undefined || leg0(W).outDone === "0");
  }

  // ---- M-1. a repeated job.id is corrupt, and the Collect-receipt check is keyed by manager:tokenId:collect.tx, not by id
  {
    const S = mk(); await S.run({});
    const base = S.ledger();
    const dup = clone(base); const j2 = clone(dup.jobs[0]); j2.collect.tx = H1; j2.legs[0].swap = { amountIn: null, quoteRaw: null, minOutRaw: null, outRaw: "0", tx: null }; dup.jobs.push(j2); // same id, different collect.tx
    fs.writeFileSync(S.file, JSON.stringify(dup));
    const r = SL.readSweepState(S.file); assert.ok(!r.ok && r.kind === "corrupt" && /jobs\[1\]\.id duplicates an earlier job/.test(r.reason), JSON.stringify(r));
    // injected past the reader: the second job shares the id but has a bogus collect.tx; it must not reuse the first job's check
    const T = mk(); await T.run({ baseCollect: SHORT, signer: T.signer({ maxSigns: 1 }) });
    const led = T.ledger(); const first = led.jobs[0]; first.legs[0].phase = "collected";
    const bad = clone(first); bad.collect.tx = H1; bad.legs[0].phase = "collected"; bad.legs[0].swap = { amountIn: null, quoteRaw: null, minOutRaw: null, outRaw: "0", tx: null };
    led.jobs.push(bad); T.io.read = () => ({ ok: true, ledger: led });
    const t = await T.run({ signer: T.signer() });
    assert.ok(/collect receipt/.test(bad.legs[0].reason || "") && bad.legs[0].phase === "held", `${bad.legs[0].phase} ${bad.legs[0].reason}\n${t.text}`);
    assert.notStrictEqual(first.legs[0].phase, "held", "the first job (its own receipt) proceeds"); assert.strictEqual(bad.legs[0].doneRaw, "0", "nothing credited to the second job"); assert.ok(!bad.legs[0].deliver || !bad.legs[0].deliver.tx, "nothing sent for the second job");
  }

  // ---- L-2. pinned decimals and an unreadable live decimals(): the leg is held, the pinned value is not trusted
  {
    const S = mk(otherPos(), { feesUsd: 50, usd1: 10 });
    S.hooks.push((p) => { if (kindOf(p) === "collect") S.w.on(OTHER, "decimals", () => { throw new Error("decimals() reverted"); }); });
    const r = await S.run({ sweep: { maxUnswappedValueUsdc: 1000 } });
    assert.deepStrictEqual(names(r.signer), ["collect"], r.text); assert.strictEqual(leg0(S).phase, "held");
    assert.ok(/decimals\(\) of .* cannot be read now \(18 was pinned on the job\)/.test(leg0(S).reason), leg0(S).reason); assert.strictEqual(S.balance(OTHER, OWNER), 0n);
  }
  // ---- R5. the hold reason names the real cause
  {
    const S = mk(otherPos(), { feesUsd: 50, usd1: 10 }); await S.run({ sweep: { maxUnswappedValueUsdc: 1000 }, signer: S.signer({ maxSigns: 1 }) });
    const led = S.ledger(); led.jobs[0].priceUsd = [null, null]; fs.writeFileSync(S.file, JSON.stringify(led));
    await S.run({ sweep: { maxUnswappedValueUsdc: 1000 }, signer: S.signer() });
    assert.ok(/no per-side USD price/.test(leg0(S).reason) && !/no pinned decimals/.test(leg0(S).reason), leg0(S).reason);
  }
  console.log("collector-base-sweep-hardening tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
