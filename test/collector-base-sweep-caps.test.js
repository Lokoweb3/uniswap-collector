// node test/collector-base-sweep-caps.test.js -- acceptance 15, 26, 27, 28, 29: simulate prints the whole plan and writes nothing; the caps cover every
// transaction; every tx type is sign-first; fee fields and tampered fields are refused; one Telegram summary. Mocked chain, no network.
"use strict";
const assert = require("assert");
const { ethers } = require("ethers");
const X = require("./lib/sweep-scene");
const { exitCodeOf } = require("../collector-base");

const { sweepScene, decodeSent, kindOf, OWNER, OP, USDC, WETH, CBBTC, LAPTOP, E18, SL, L, lc, ID_A, ID_B, MGR_A, MGR_B } = X;
const AMT = 2n * E18 / 100n;
const wethPos = () => [{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 5_000_000n }];
const mk = (positions = wethPos(), o = {}) => { const S = sweepScene({ positions, ...o }); S.init(); return S; };
const names = (signer) => decodeSent(signer).map((t) => t.name);
const NOW = Date.now();
const entry = (o = {}) => ({ t: NOW - 3600_000, wei: "1000", kind: "settled", tx: "0x" + "ab".repeat(32), nonce: 1, ...o });

(async () => {
  // ---- 15. simulate: the plan, and nothing written, signed, unlocked or sent
  {
    const S = mk([
      { id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 5_000_000n },
      { id: ID_B, mgr: MGR_B, t0: CBBTC, t1: LAPTOP, a0: 100_000n, a1: 400n * E18 },
    ]);
    const stateBefore = JSON.stringify(S.state); const ledgerBefore = S.snap();
    let getSignerCalls = 0;
    const r = await S.run({ mode: "simulate", extra: { getSigner: async () => { getSignerCalls++; return S.signer(); } } });
    assert.strictEqual(getSignerCalls, 0, "getSigner is never called"); assert.strictEqual(r.signerCalls(), 0);
    assert.strictEqual(r.signer.signs.length, 0, "zero signTransaction calls"); assert.strictEqual(S.w.broadcasts.length, 0);
    assert.strictEqual(r.saved.length, 0, "saveState is never called"); assert.strictEqual(S.saves, 0, "the sweep ledger is never written");
    assert.strictEqual(JSON.stringify(S.state), stateBefore); assert.strictEqual(S.snap(), ledgerBefore);
    assert.strictEqual(S.notes.length, 0, "no Telegram");
    assert.strictEqual(r.res.wouldCollect, 2); assert.strictEqual(r.res.collected, 0);
    const t = r.text;
    assert.ok(/#79371151 .* -> collect: .*; not sent/.test(t));
    assert.ok(/sweep plan #79371151: collect to the operator 0x[0-9a-fA-F]{40} \(simulated amounts\), then per token:/.test(t));
    for (const [sym, quote] of [["WETH", S.quote("WETH", AMT)], ["cbBTC", S.quote("cbBTC", 100_000n)], ["LAPTOP", S.quote("LAPTOP", 400n * E18)]]) {
      const line = r.lines.find((l) => l.startsWith(`    ${sym} `));
      assert.ok(line, `${sym} line`);
      assert.ok(line.includes(`quote ${SL.fmtUsdc(quote)} USDC`) && /mid [\d.]+ \(after fee [\d.]+\), impact \d+ bps, minOut [\d.]+; decision: swap/.test(line), line);
      assert.ok(/pool\/factory proof ok/.test(line));
    }
    assert.ok(r.lines.some((l) => /^    USDC 5\.0 USDC: USDC fee leg, no quote, no approve, no swap; one transfer to the owner$/.test(l)));
    assert.ok(r.lines.some((l) => l === "    split: 0% vault: vault.tba not set"));
    assert.ok(r.lines.some((l) => l.startsWith(`    recipients: owner ${OWNER}; estimated sweep txs after the collect:`)));
    assert.ok(/caps: ok \(planned worst case [\d.]+ ETH over \d+ transactions\)/.test(t));
    assert.ok(S.w.estimates.every((e) => e.name === "collect"), "only the collect was estimated");
    // a leg that fails a proof is shown with its reason
    const P = mk(); P.pools.WETH.observeFails = true;
    const pr = await P.run({ mode: "simulate" });
    assert.ok(pr.lines.some((l) => /WETH .*decision: unswapped to the owner \(no usable TWAP/.test(l)), pr.text);
    // the resume plan for an open leg
    const O = mk(); await O.run({ signer: O.signer({ maxSigns: 1 }) });
    const sim = await O.run({ mode: "simulate" });
    assert.ok(sim.lines.some((l) => /sweep resume plan: #79371151 WETH is collected/.test(l)), sim.text);
    const savesBefore = O.saves; await O.run({ mode: "simulate" }); assert.strictEqual(O.saves, savesBefore);
    // off: one line and today's behaviour
    const D = mk([], {}); const d = await D.run({ mode: "simulate", sweep: { enabled: false } });
    assert.ok(d.lines.includes("sweep: disabled (baseSweep.enabled is not true)"));
  }

  // ---- 26. the caps cover every transaction; a preflight that cannot afford the whole chain skips the collect
  {
    // the planned chain of WETH + USDC: collect + (reset, approve, swap, reset, transfer) + transfer = 7 transactions
    let S = mk(); let r = await S.run({ sweep: { maxTxPerRun: 6 } });
    assert.strictEqual(r.signer.sent.length, 0); assert.strictEqual(S.balance(WETH, OP), 0n, "nothing moved onto the operator");
    assert.ok(/sweep preflight: the planned chain needs 7 transactions, maxTxPerRun 6/.test(r.text) && r.res.skipped === 1, r.text);
    S = mk(); r = await S.run({ sweep: { maxTxPerRun: 7 } });
    assert.strictEqual(r.signer.sent.length, 5); assert.strictEqual(r.res.aborted, false);
    // the first tx that would exceed maxTxPerRun is not signed (reverting swaps eat the budget)
    S = mk(); S.failNext.push(Object.assign((p) => lc(p.to) === lc(SL.ROUTER), { sticky: true }));
    r = await S.run({ sweep: { maxTxPerRun: 7 } });
    assert.ok(r.signer.sent.length <= 7 && r.signer.signs.length === r.signer.sent.length, `${r.signer.sent.length} sent, ${r.signer.signs.length} signed`);
    assert.strictEqual(r.signer.sent.length, 7, "exactly the cap");
    assert.ok(/maxTxPerRun 7 reached; skipped/.test(r.text), r.text);
    assert.ok(S.ledger().jobs[0].legs[0].phase !== "delivered", "the unfinished leg waits for the next run");
    // dailyTxCap counts entries with an op only; plain collects do not count
    S = mk(); S.state.gasSpends = Array.from({ length: 38 }, (_, i) => entry({ op: "transfer", nonce: i }));
    r = await S.run({ sweep: { dailyTxCap: 40 } });
    assert.strictEqual(r.signer.sent.length, 0); assert.ok(/needs 7 transactions, dailyTxCap 40 \(38 in 24 h\)/.test(r.text), r.text);
    S = mk(); S.state.gasSpends = Array.from({ length: 90 }, (_, i) => entry({ nonce: i, wei: "1" }));
    assert.strictEqual((await S.run({ sweep: { dailyTxCap: 40 } })).signer.sent.length, 5, "entries without an op do not count");
    S = mk(); S.state.gasSpends = Array.from({ length: 90 }, (_, i) => entry({ op: "swap", nonce: i, wei: "1", t: NOW - 25 * 3600_000 }));
    assert.strictEqual((await S.run({ sweep: { dailyTxCap: 40 } })).signer.sent.length, 5, "entries older than 24 h do not count");
    assert.strictEqual(SL.opCount24h({ gasSpends: [entry({ op: "swap", kind: "reserved", t: 1 }), entry({ op: "swap", t: 1 }), entry({})] }, NOW), 1, "an unsettled one always counts");
    // maxGasPerRunEth / dailyGasCapEth: reservations of every op count in spentWindowWei
    assert.strictEqual(L.spentWindowWei({ gasSpends: [{ t: 1, wei: "5", kind: "reserved", op: "swap" }, { t: 1, wei: "7", kind: "unknown", op: "transfer" }, { t: 1, wei: "9", kind: "settled", op: "approve" }, { t: NOW, wei: "11", kind: "settled", op: "approve-reset" }] }, NOW), 5n + 7n + 11n);
    S = mk(); r = await S.run({ sweep: { maxGasPerRunEth: 0.0001 } });
    assert.strictEqual(r.signer.sent.length, 0); assert.ok(/would exceed maxGasPerRunEth 0\.0001|maxGasPerRunEth 0\.0001 ETH would be exceeded/.test(r.text), r.text);
    S = mk(); S.state.gasSpends = [entry({ op: "swap", wei: String(3_900_000_000_000_000n) })]; // 0.0039 of 0.004 already spent today
    r = await S.run({}); assert.strictEqual(r.signer.sent.length, 0); assert.ok(/dailyGasCapEth 0\.004/.test(r.text), r.text);
    S = mk(); S.state.gasSpends = [entry({ op: "swap", kind: "reserved", wei: String(3_900_000_000_000_000n), t: 1 })]; // an old unsettled reservation counts at any age
    r = await S.run({}); assert.strictEqual(r.signer.sent.length, 0);
    S = mk(); S.state.gasSpends = [entry({ op: "swap", wei: String(3_900_000_000_000_000n), t: NOW - 26 * 3600_000 })];
    assert.strictEqual((await S.run({})).signer.sent.length, 5, "outside the 24 h window it does not count");
    // the per-run gas cap stops a run in the middle: reverts spend the budget, the next tx is not signed
    S = mk(); S.failNext.push(Object.assign((p) => lc(p.to) === lc(SL.ROUTER), { sticky: true }));
    r = await S.run({ sweep: { maxGasPerRunEth: 0.00022 } });
    const spent = r.state.gasSpends.reduce((a, e) => a + BigInt(e.wei), 0n);
    assert.ok(spent <= ethers.parseEther("0.00022"), `spent ${spent}`);
    assert.ok(r.signer.signs.length === r.signer.sent.length && r.lines.some((l) => /maxGasPerRunEth 0\.00022 ETH would be exceeded.*skipped/.test(l)), r.text);
    assert.ok(r.signer.sent.length >= 4 && r.signer.sent.length < 10, "stopped part-way by the cap");
    // maxCollectsPerRun keeps counting collects only
    S = mk([{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 0n }, { id: ID_B, mgr: MGR_B, t0: WETH, t1: USDC, a0: AMT, a1: 0n }]);
    r = await S.run({ baseCollect: { maxCollectsPerRun: 1 } });
    assert.deepStrictEqual(names(r.signer), ["collect", "approve", "exactInputSingle", "transfer"], "the sweep txs are not collects");
    assert.ok(/maxCollectsPerRun 1 reached/.test(r.text));
    // the sweep gas overrides replace the baseCollect ones, within 5x the default
    assert.strictEqual(SL.config({ maxGasPerTxEth: 1 }).maxGasPerTxEth, 0.0035); assert.strictEqual(SL.config({ dailyGasCapEth: 1 }).dailyGasCapEth, 0.02);
    assert.deepStrictEqual(SL.limitOverrides(SL.config({})), { maxGasPerTxEth: 0.0007, maxGasPerRunEth: 0.002, dailyGasCapEth: 0.004 });
  }

  // ---- 27. sign-first for every tx type: sign < sweep ledger intent < gas reservation on disk < broadcast
  {
    const S = mk([{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 5_000_000n }]);
    S.setAllowance(CBBTC, OP, SL.ROUTER, 9n); // a stale one: the approve-reset at run start
    S.hooks.push((p) => { if (kindOf(p) === "collect") S.setAllowance(WETH, OP, SL.ROUTER, 3n); }); // and a leftover: a second reset
    const r = await S.run({});
    const ops = r.state.gasSpends.map((e) => e.op);
    assert.deepStrictEqual([...new Set(ops)].sort(), ["approve", "approve-reset", "collect", "swap", "transfer"], "every op type was sent");
    const ev = S.ev;
    for (const [i, e] of ev.entries()) {
      if (e.k !== "broadcast") continue;
      const before = ev.slice(0, i);
      const signed = before.map((x) => x.k).lastIndexOf("sign");
      const stateAt = before.map((x, j) => (x.k === "state" && x.txs.includes(`${e.hash}:reserved`) ? j : -1)).filter((j) => j >= 0)[0];
      assert.ok(signed >= 0 && stateAt !== undefined && stateAt > signed, `the reservation of ${e.hash} is on disk after signing and before the broadcast`);
      const ledgerAt = before.map((x, j) => (x.k === "ledger" && x.pending.includes(e.hash) ? j : -1)).filter((j) => j >= 0)[0];
      const tx = S.txs.find((t) => t.hash === e.hash);
      const isStale = ops[r.state.gasSpends.findIndex((g) => g.tx === e.hash)] === "approve-reset" && ledgerAt === undefined;
      if (!isStale) assert.ok(ledgerAt !== undefined && ledgerAt > signed && ledgerAt < stateAt, `the ledger intent of ${e.hash} comes between signing and the reservation`);
      assert.ok(tx);
    }
    assert.ok(r.state.gasSpends.every((g) => /^0x[0-9a-f]{64}$/.test(g.tx) && Number.isInteger(g.nonce) && g.kind === "settled"));
    assert.strictEqual(ev.filter((x) => x.k === "broadcast").length, ops.length);

    // a failing reservation save blocks the broadcast and stops the run, for each op type
    for (const op of ["approve", "swap", "transfer", "approve-reset"]) {
      const T = mk([{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 5_000_000n }]);
      if (op === "approve-reset") T.hooks.push((p) => { if (kindOf(p) === "collect") T.setAllowance(WETH, OP, SL.ROUTER, 3n); });
      T.failStateAt = (st) => st.gasSpends.some((e) => e.op === op && e.kind === "reserved");
      const t = await T.run({});
      assert.strictEqual(t.res.aborted, true, op)
      assert.ok(t.signer.signs.length > t.signer.sent.length, `${op}: signed but not broadcast`);
      assert.ok(!t.state.gasSpends.some((e) => e.op === op), `${op}: no reservation was kept`);
      assert.ok(/STOP: the budget cannot be recorded/.test(t.text));
    }

    // broadcast error / timeout / bad receipt: the worst case stays counted, the run stops, the next start settles by receipt or nonce
    const modes = {
      "broadcast error": (op) => ({ broadcastError: (p) => kindOf(p) === op }),
      "timeout": (op) => ({ neverMined: (p) => kindOf(p) === op }),
      "bad receipt": (op) => ({ receiptTweak: (rc, p) => (kindOf(p) === op ? { ...rc, to: OWNER } : rc) }),
    };
    for (const op of ["approve", "exactInputSingle", "transfer"]) for (const [mode, sig] of Object.entries(modes)) {
      const T = mk([{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 0n }]);
      const t1 = await T.run({ baseCollect: { waitTimeoutSec: 0.05 }, signer: T.signer(sig(op)) });
      const label = `${op} / ${mode}`;
      assert.strictEqual(t1.res.aborted, true, label);
      const open = t1.state.gasSpends.filter((e) => e.kind === "reserved" || e.kind === "unknown");
      assert.strictEqual(open.length, 1, `${label}: the worst case stays counted`);
      assert.ok(BigInt(open[0].wei) > 0n && open[0].op, label);
      assert.ok(t1.res.spentWei >= BigInt(open[0].wei), `${label}: counted in the run`);
      // the next start: all entries settled from the receipt or the nonce, the leg finishes
      if (mode === "broadcast error") {
        // the node never saw it and the nonce is unused: it stays pending and counted, the leg waits
        const w2 = await T.run({ signer: T.signer() });
        assert.ok(w2.state.gasSpends.some((e) => e.kind === "reserved" || e.kind === "unknown"), `${label}: still counted`); assert.strictEqual(w2.signer.sent.length, 0, label);
        assert.ok(/is pending: nonce \d+ not used yet; its worst case/.test(w2.text), label);
        T.w.latestNonce = open[0].nonce + 1; // something else used the nonce
      }
      const t2 = await T.run({ signer: T.signer() });
      assert.ok(t2.state.gasSpends.every((e) => e.kind === "settled"), `${label}: settled at the next start\n${t2.text}`);
      assert.strictEqual(T.ledger().jobs[0].legs[0].phase, "delivered", `${label}: ${t2.text}`);
      assert.strictEqual(T.balance(WETH, OP), 0n, label); assert.strictEqual(T.balance(USDC, OP), 0n, label);
      assert.strictEqual(T.txs.filter((x) => lc(x.to) === lc(MGR_A)).length, 1, `${label}: one collect`);
      assert.strictEqual(T.txs.filter((x) => lc(x.to) === lc(SL.ROUTER)).length <= 1, true, `${label}: at most one swap mined`);
    }
  }

  // ---- 28. fee fields, gas ceilings, and the last look at every field of every op
  {
    // a high base fee: no fee is ever signed above the caps; at the limit it refuses
    const S = mk(); S.w.block = { baseFeePerGas: 400_000_000n }; // 0.4 gwei: maxFee = min(2 x + tip, 1 gwei)
    const r = await S.run({});
    assert.ok(r.signer.sent.length >= 4);
    for (const t of r.signer.sent) { assert.ok(t.maxFeePerGas <= 1_000_000_000n && t.maxPriorityFeePerGas <= 10_000_000n && t.maxPriorityFeePerGas > 0n && t.maxPriorityFeePerGas <= t.maxFeePerGas); }
    const H = mk(); H.w.block = { baseFeePerGas: 2_000_000_000n };
    const h = await H.run({}); assert.strictEqual(h.signer.sent.length, 0); assert.ok(/exceeds maxGasPriceGwei/.test(h.text));
    // a gas estimate above an op's ceiling is skipped, never clamped; the leg falls back to the owner
    const C = mk([{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 0n }]);
    const base = C.w.gasEstimate;
    C.w.gasEstimate = (tx) => { return String(tx.data).startsWith("0x095ea7b3") ? 400_000n : base(tx); };
    const c = await C.run({});
    assert.ok(!decodeSent(c.signer).some((t) => t.name === "approve" || t.name === "exactInputSingle"), c.text);
    assert.ok(/gas estimate 400000 exceeds the approve ceiling 100000; skipped/.test(c.text));
    assert.deepStrictEqual(names(c.signer), ["collect", "transfer"]); assert.strictEqual(C.balance(WETH, OWNER), AMT);
    for (const t of c.signer.sent) assert.ok(t.gasLimit <= (lc(t.to) === lc(MGR_A) ? 500000n : 120000n));
    assert.strictEqual(SL.config({ maxGasLimitByOp: { swap: 9_999_999, transfer: 1000 } }).maxGasLimitByOp.swap, 350000, "settings can only lower a ceiling");
    assert.strictEqual(SL.config({ maxGasLimitByOp: { swap: 9_999_999, transfer: 1000 } }).maxGasLimitByOp.transfer, 1000);

    // assertSignableSweep: every op, every tampered field
    const lim = { ...L.limits({}), ...SL.limitOverrides(SL.config({})), maxGasLimitByOp: SL.GAS_CEILINGS };
    const evil = "0x00000000000000000000000000000000000000ee";
    const base1 = { type: 2, chainId: 8453, value: 0n, nonce: 3, gasLimit: 50_000n, maxFeePerGas: 61_000_000n, maxPriorityFeePerGas: 1_000_000n };
    const swapP = { tokenIn: WETH, tokenOut: USDC, fee: 500, recipient: OP, amountIn: 1000n, amountOutMinimum: 900n, sqrtPriceLimitX96: 0 };
    const specs = {
      approve: { tx: { ...base1, to: WETH, data: SL.calldata.approve(SL.ROUTER, 1000n) }, expect: { token: WETH, legTokens: [WETH], amount: 1000n, operator: OP } },
      "approve-reset": { tx: { ...base1, to: WETH, data: SL.calldata.approve(SL.ROUTER, 0n) }, expect: { token: WETH, legTokens: [WETH], amount: 0n, operator: OP } },
      swap: { tx: { ...base1, gasLimit: 250_000n, to: SL.ROUTER, data: SL.calldata.swap(swapP) }, expect: { params: swapP, operator: OP } },
      transfer: { tx: { ...base1, to: USDC, data: SL.calldata.transfer(OWNER, 1000n) }, expect: { token: USDC, legTokens: [USDC], amount: 1000n, recipients: [OWNER], operator: OP } },
    };
    for (const [op, { tx, expect }] of Object.entries(specs)) {
      SL.assertSignableSweep(tx, lim, op, expect); // the genuine one passes
      const refuse = (name, mut) => assert.throws(() => SL.assertSignableSweep(mut({ ...tx }), lim, op, expect), /refusing to sign/, `${op}: ${name}`);
      refuse("wrong to", (t) => ({ ...t, to: evil })); refuse("value", (t) => ({ ...t, value: 1n })); refuse("type 1", (t) => ({ ...t, type: 1 })); refuse("gasPrice", (t) => ({ ...t, gasPrice: 1n }));
      refuse("chain", (t) => ({ ...t, chainId: 1 })); refuse("gas above the ceiling", (t) => ({ ...t, gasLimit: SL.GAS_CEILINGS[op] ? BigInt(SL.GAS_CEILINGS[op]) + 1n : 1n }));
      refuse("fee above the cap", (t) => ({ ...t, maxFeePerGas: 2_000_000_000n })); refuse("tip above the cap", (t) => ({ ...t, maxPriorityFeePerGas: 20_000_000n })); refuse("no tip", (t) => ({ ...t, maxPriorityFeePerGas: 0n }));
      refuse("negative nonce", (t) => ({ ...t, nonce: -1 })); refuse("trailing bytes", (t) => ({ ...t, data: t.data + "00" })); refuse("empty data", (t) => ({ ...t, data: "0x" }));
      refuse("another selector", (t) => ({ ...t, data: "0x12345678" + t.data.slice(10) })); refuse("zero gas", (t) => ({ ...t, gasLimit: 0n }));
    }
    const refuseData = (op, data, to) => assert.throws(() => SL.assertSignableSweep({ ...specs[op].tx, to: to || specs[op].tx.to, data }, lim, op, specs[op].expect), /refusing to sign/, `${op} ${data.slice(0, 20)}`);
    refuseData("approve", SL.calldata.approve(evil, 1000n)); refuseData("approve", SL.calldata.approve(SL.ROUTER, 1001n)); refuseData("approve", SL.calldata.approve(SL.ROUTER, ethers.MaxUint256));
    refuseData("approve", SL.calldata.transfer(OWNER, 1000n)); refuseData("approve", SL.calldata.approve(SL.ROUTER, 0n)); refuseData("approve", SL.calldata.approve(SL.ROUTER, 1000n), USDC);
    refuseData("approve-reset", SL.calldata.approve(SL.ROUTER, 1n)); refuseData("approve-reset", SL.calldata.approve(evil, 0n)); refuseData("approve-reset", SL.calldata.approve(SL.ROUTER, 0n), OTHER_TOKEN());
    refuseData("transfer", SL.calldata.transfer(evil, 1000n)); refuseData("transfer", SL.calldata.transfer(OP, 1000n)); refuseData("transfer", SL.calldata.transfer(OWNER, 1001n)); refuseData("transfer", SL.calldata.transfer(OWNER, 0n));
    refuseData("transfer", SL.calldata.approve(OWNER, 1000n)); refuseData("transfer", SL.calldata.transfer(OWNER, 1000n), WETH);
    const sw2 = (o) => SL.calldata.swap({ ...swapP, ...o });
    refuseData("swap", sw2({ recipient: OWNER })); refuseData("swap", sw2({ recipient: evil })); refuseData("swap", sw2({ amountIn: 1001n })); refuseData("swap", sw2({ amountOutMinimum: 0n })); refuseData("swap", sw2({ amountOutMinimum: 1n }));
    refuseData("swap", sw2({ tokenOut: WETH })); refuseData("swap", sw2({ tokenIn: evil })); refuseData("swap", sw2({ fee: 3000 })); refuseData("swap", sw2({ sqrtPriceLimitX96: 5 })); refuseData("swap", sw2({}), evil); refuseData("swap", sw2({}), SL.QUOTER);
    assert.throws(() => SL.assertSignableSweep(specs.swap.tx, lim, "collect", specs.swap.expect), /not a sweep op/);
    assert.throws(() => SL.assertSignableSweep(specs.swap.tx, lim, "swap", null), /refusing to sign/);
    // a transfer to a token that is not the leg's
    assert.throws(() => SL.assertSignableSweep({ ...specs.transfer.tx, to: WETH }, lim, "transfer", { ...specs.transfer.expect, token: WETH, legTokens: [USDC] }), /not a token of the active leg/);

    // through the real run: a tampered field never reaches the signer or the network
    for (const [op, , tamper] of [
      ["transfer", "transfer", (f) => ({ ...f, data: SL.calldata.transfer(evil, 1000n) })],
      ["swap", "exactInputSingle", (f) => ({ ...f, to: SL.QUOTER })],
      ["approve", "approve", (f) => ({ ...f, data: SL.calldata.approve(evil, 1n) })],
      ["transfer", "transfer", (f) => ({ ...f, value: 1n })],
    ]) {
      const T = mk([{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 0n }]);
      const t = await T.run({ extra: { tweakTxFields: (f, ctx) => (ctx && ctx.op === op ? tamper(f) : f) } });
      assert.ok(t.signer.sent.every((x) => !x.data.toLowerCase().includes(evil.slice(2).toLowerCase()) && x.value === 0n && lc(x.to) !== lc(SL.QUOTER)), `${op}: nothing tampered was sent`);
      assert.ok(/refusing to sign/.test(t.text), `${op}: refused\n${t.text}`);
    }
  }

  // ---- 29. one Telegram summary in collect mode; a throwing notifier changes nothing; simulate never calls it
  {
    const S = mk([{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 5_000_000n }, { id: ID_B, mgr: MGR_B, t0: LAPTOP, t1: USDC, a0: 100n * E18, a1: 0n }]);
    const r = await S.run({ sweep: { routes: { LAPTOP: { enabled: false } } } });
    assert.strictEqual(S.notes.length, 1, "notify once");
    const n = S.notes[0];
    assert.ok(/^=== base sweep: 2 positions, delivered 44\.\d+ USDC, 1 tokens unswapped, 0 stuck, gas [\d.]+ ETH ===/.test(n), n);
    assert.ok(/unswapped LAPTOP: LAPTOP route is disabled in settings/.test(n)); assert.ok(/vault: 0% \(vault\.tba not set\)/.test(n));
    assert.ok(r.lines.some((l) => /^=== base sweep: 2 positions, delivered .* USDC, 1 tokens unswapped, 0 stuck, gas /.test(l)), "the closing summary line");
    // stuck legs are in it
    const T = mk(); T.failNext.push(Object.assign((p) => kindOf(p) === "transfer", { sticky: true }));
    await T.run({}); assert.ok(/STUCK: #79371151 WETH/.test(T.notes[0]) && /2 stuck/.test(T.notes[0]), T.notes[0]);
    // a throwing notifier: the same results, a note in the log
    const A = mk(); const B2 = mk(); B2.noteFail = true;
    const ra = await A.run({}); const rb = await B2.run({});
    assert.strictEqual(rb.res.aborted, ra.res.aborted); assert.strictEqual(rb.res.collected, ra.res.collected); assert.strictEqual(B2.balance(USDC, OWNER), A.balance(USDC, OWNER));
    assert.strictEqual(rb.signer.sent.length, ra.signer.sent.length); assert.ok(/the Telegram summary could not be sent \(telegram down\)/.test(rb.text));
    assert.strictEqual(exitCodeOf(rb.res), 0);
    // simulate never notifies; neither does a run with the sweep off
    const Sm = mk(); await Sm.run({ mode: "simulate" }); assert.strictEqual(Sm.notes.length, 0);
    const Off = mk(); await Off.run({ sweep: null }); assert.strictEqual(Off.notes.length, 0);
    // a refusal is also reported (collect mode)
    const Rf = sweepScene({ positions: wethPos() }); await Rf.run({}); assert.ok(/base sweep REFUSED: sweep-state\.json is missing/.test(Rf.notes[0]));
  }
  console.log("collector-base-sweep-caps tests passed");
})().catch((e) => { console.error(e); process.exit(1); });

function OTHER_TOKEN() { return "0x940181a94A35A4569E4529A3CDfB74e38FD98631"; }
