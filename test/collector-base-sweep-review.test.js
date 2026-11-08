// node test/collector-base-sweep-review.test.js -- the reviewer fixes of the Base sweep: an unconfirmed vault transfer never falls through to the
// owner, a pending tx is looked up by receipt before the gas entry, recovery needs no ETH/USD price, an approved leg that turns unswapped resets
// its allowance, the collect gets its own gas ceiling, the preflight budgets the whole chain. Mocked chain, no network.
"use strict";
const assert = require("assert");
const X = require("./lib/sweep-scene");

const { sweepScene, decodeSent, kindOf, OWNER, OP, USDC, WETH, E18, SL, VAULT, lc, ID_A, MGR_A } = X;
const AMT = 2n * E18 / 100n;
const wethPos = () => [{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 0n }];
const mk = (positions = wethPos(), o = {}) => { const S = sweepScene({ positions, ...o }); S.init(); return S; };
const names = (signer) => decodeSent(signer).map((t) => t.name);
const SHORT = { waitTimeoutSec: 0.05 };
const leg0 = (S) => S.ledger().jobs[0].legs[0];
const toVault = (p) => kindOf(p) === "transfer" && lc(p.data).includes(lc(VAULT.tba).slice(2));

(async () => {
  // ---- 1. a vault transfer without a receipt: nothing goes to the owner this run; the next run pays only the remainder
  {
    const S = mk(); const vc = S.vault({});
    const r1 = await S.run({ sweep: { vault: vc }, signer: S.signer({ revertNoReceipt: toVault }) });
    assert.strictEqual(r1.res.aborted, false, "an unknown outcome without a stop");
    const t1 = decodeSent(r1.signer).filter((t) => t.name === "transfer");
    assert.strictEqual(t1.length, 1, `only the vault transfer was sent\n${r1.text}`); assert.strictEqual(t1[0].args[0], VAULT.tba);
    assert.strictEqual(S.balance(USDC, OWNER), 0n, "the owner got nothing yet");
    assert.ok(/VAULT transfer not confirmed/.test(r1.text));
    const l1 = leg0(S); assert.strictEqual(l1.pending.op, "transfer"); assert.strictEqual(l1.pending.to, VAULT.tba, "the pending intent is the vault transfer");
    assert.notStrictEqual(l1.vault && l1.vault.failed, true);
    const hash = l1.pending.tx; const vaultAmt = BigInt(l1.pending.raw);
    // it was mined after all
    S.reveal(hash);
    const r2 = await S.run({ sweep: { vault: vc }, signer: S.signer() });
    const out = BigInt(leg0(S).swap.outRaw);
    assert.deepStrictEqual(names(r2.signer), ["transfer"], `only the remainder to the owner\n${r2.text}`);
    assert.strictEqual(S.balance(USDC, VAULT.tba), vaultAmt); assert.strictEqual(S.balance(USDC, OWNER), out - vaultAmt, "no double pay");
    assert.strictEqual(leg0(S).phase, "delivered"); assert.strictEqual(S.balance(USDC, OP), 0n);

    // it was not mined and its nonce was used by someone else: voided, the owner gets the whole proceeds
    const N = mk(); const nc = N.vault({});
    const n1 = await N.run({ sweep: { vault: nc }, signer: N.signer({ revertNoReceipt: toVault }) });
    N.hidden = new Map(); // never mined: the effect is undone
    const pend = leg0(N).pending; const vamt = BigInt(pend.raw);
    N.add(USDC, OP, vamt); N.add(USDC, VAULT.tba, -vamt);
    assert.ok(n1.res.aborted === false); N.w.latestNonce = pend.nonce + 1;
    const n2 = await N.run({ sweep: { vault: nc }, signer: N.signer() });
    const nout = BigInt(leg0(N).swap.outRaw);
    assert.deepStrictEqual(names(n2.signer), ["transfer"]); assert.strictEqual(N.balance(USDC, OWNER), nout); assert.strictEqual(N.balance(USDC, VAULT.tba), 0n);
    assert.strictEqual(leg0(N).phase, "delivered");

    // a recovered, reverted vault transfer is recorded as failed
    const F = mk(); const fc = F.vault({});
    F.failNext.push((parsed) => parsed.data.toLowerCase().startsWith("0xa9059cbb") && parsed.data.toLowerCase().includes(VAULT.tba.slice(2).toLowerCase()));
    const f1 = await F.run({ sweep: { vault: fc }, signer: F.signer({ revertNoReceipt: toVault }) });
    assert.strictEqual(f1.res.aborted, false); F.reveal(leg0(F).pending.tx);
    await F.run({ sweep: { vault: fc }, signer: F.signer() });
    assert.strictEqual(leg0(F).vault.failed, true); assert.strictEqual(F.balance(USDC, OWNER), BigInt(leg0(F).swap.outRaw)); assert.strictEqual(leg0(F).phase, "delivered");
  }

  // ---- 2. the gas entry was pruned: the receipt is still found, the mined swap is not sent again
  {
    const S = mk();
    const r1 = await S.run({ baseCollect: SHORT, signer: S.signer({ dropReceipt: (p) => kindOf(p) === "exactInputSingle" }) });
    assert.strictEqual(r1.res.aborted, true); assert.strictEqual(leg0(S).pending.op, "swap");
    const h = leg0(S).pending.tx;
    S.state.gasSpends = S.state.gasSpends.filter((e) => e.tx !== h); // pruned after 7 days
    const r2 = await S.run({ signer: S.signer() });
    assert.deepStrictEqual(names(r2.signer), ["transfer"], `no second swap\n${r2.text}`);
    assert.ok(/recovery: swap of WETH \(#79371151\) succeeded/.test(r2.text), r2.text);
    assert.strictEqual(leg0(S).phase, "delivered"); assert.strictEqual(S.balance(WETH, OP), 0n);
    assert.strictEqual(S.txs.filter((t) => lc(t.to) === lc(SL.ROUTER)).length, 1);
    // a receipt from another sender is not accepted without the entry
    const T = mk();
    await T.run({ baseCollect: SHORT, signer: T.signer({ dropReceipt: (p) => kindOf(p) === "exactInputSingle" }) });
    const th = leg0(T).pending.tx; T.state.gasSpends = T.state.gasSpends.filter((e) => e.tx !== th);
    T.mined.get(th).from = OWNER;
    const t2 = await T.run({ signer: T.signer() });
    assert.strictEqual(t2.signer.sent.length, 0); assert.ok(/receipt rejected \(from /.test(t2.text), t2.text); assert.strictEqual(leg0(T).pending.op, "swap");
  }

  // ---- 3. no ETH/USD price, or no wallet with collect:true: the open legs are still finished
  {
    const S = mk();
    await S.run({ signer: S.signer({ maxSigns: 1 }) });
    assert.strictEqual(leg0(S).phase, "collected");
    const r2 = await S.run({ signer: S.signer(), extra: { getEthUsd: async () => 0 } });
    assert.ok(/ETH\/USD is unavailable/.test(r2.text)); assert.deepStrictEqual(names(r2.signer), ["approve", "exactInputSingle", "transfer"], r2.text);
    assert.strictEqual(leg0(S).phase, "delivered"); assert.ok(/=== base sweep:/.test(r2.text)); assert.ok(S.notes.length >= 2);
    const W = mk();
    await W.run({ signer: W.signer({ maxSigns: 1 }) });
    const w2 = await W.run({ signer: W.signer(), raw: (raw) => { raw.wallets.main.collect = false; } });
    assert.deepStrictEqual(names(w2.signer), ["approve", "exactInputSingle", "transfer"], w2.text); assert.strictEqual(W.ledger().jobs[0].legs[0].phase, "delivered");
    assert.strictEqual(w2.signer.sent.filter((t) => lc(t.to) === lc(MGR_A)).length, 0, "no new collect");
    // no ledger and no wallet: still nothing to do
    const E = sweepScene({ positions: wethPos() });
    const e1 = await E.run({ sweep: null, noIo: true, raw: (raw) => { raw.wallets.main.collect = false; } });
    assert.ok(/no wallet has collect:true; nothing to do/.test(e1.text)); assert.strictEqual(e1.signer.sent.length, 0);
  }

  // ---- 4. approved, then the decision turns unswapped: the allowance goes back to 0 and the token is delivered as it is
  {
    const S = mk();
    await S.run({ signer: S.signer({ maxSigns: 2 }) });
    assert.strictEqual(leg0(S).phase, "approved"); assert.strictEqual(S.allowance(WETH, OP, SL.ROUTER), AMT);
    const r2 = await S.run({ sweep: { routes: { WETH: { enabled: false } } }, signer: S.signer() });
    assert.deepStrictEqual(names(r2.signer), ["approve", "transfer"], r2.text);
    assert.strictEqual(decodeSent(r2.signer)[0].args[1], 0n); assert.strictEqual(S.allowance(WETH, OP, SL.ROUTER), 0n);
    assert.strictEqual(S.balance(WETH, OWNER), AMT); assert.strictEqual(S.balance(WETH, OP), 0n); assert.strictEqual(leg0(S).phase, "delivered-unswapped");
  }

  // ---- 5. maxGasLimitByOp.collect applies to the collect while the sweep is on
  {
    const S = mk();
    const r = await S.run({ sweep: { maxGasLimitByOp: { collect: 160000 } } });
    assert.strictEqual(decodeSent(r.signer)[0].gasLimit, 160000n, "min(maxGasLimit, the collect ceiling)");
    const T = mk();
    const t = await T.run({ sweep: { maxGasLimitByOp: { collect: 100000 } } });
    assert.strictEqual(t.signer.sent.length, 0); assert.ok(/gas estimate 150000 exceeds maxGasLimit 100000/.test(t.text), t.text);
    const O = mk();
    const o = await O.run({ sweep: null, noIo: true });
    assert.strictEqual(decodeSent(o.signer)[0].gasLimit, 187500n, "sweep off: unchanged");
  }

  // ---- 6. a leg that is unswapped at plan time but has an enabled route is budgeted for the whole chain
  {
    const S = mk();
    const pl = await S.run({ mode: "simulate", sweep: { minSwapValueUsdc: 100 } });
    assert.ok(/WETH .*unswapped to the owner/.test(pl.text), pl.text);
    assert.ok(/estimated sweep txs after the collect: 5\b/.test(pl.text), pl.text);
    const tight = await S.run({ mode: "simulate", sweep: { minSwapValueUsdc: 100, maxTxPerRun: 4 } });
    assert.ok(/caps: NOT ok/.test(tight.text), tight.text);
    const real = await S.run({ sweep: { minSwapValueUsdc: 100, maxTxPerRun: 4 } });
    assert.strictEqual(real.signer.sent.length, 0, "the collect is skipped by the preflight"); assert.ok(/sweep preflight/.test(real.text));
    const off = await S.run({ mode: "simulate", sweep: { minSwapValueUsdc: 100, routes: { WETH: { enabled: false } } } });
    assert.ok(/estimated sweep txs after the collect: 1\b/.test(off.text), off.text);
  }
  console.log("collector-base-sweep-review tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
