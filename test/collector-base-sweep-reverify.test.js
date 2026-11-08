// node test/collector-base-sweep-reverify.test.js -- the re-review of 4930f2a: ledger duplicates (L-1), swap output re-proved from the receipts (L-1),
// transfers without block balances need a Transfer log (L-2), a broadcast collect that is never found is unattributed (L-3), and the frozen
// vault implementation allowlist (Info). A mocked chain, no network, no key, no transaction ever leaves the process.
"use strict";
const assert = require("assert");
const fs = require("fs");
const X = require("./lib/sweep-scene");
const { exitCodeOf } = require("../collector-base");
const { revert } = require("./fixtures/mock-chain");

const { sweepScene, decodeSent, kindOf, OWNER, OP, USDC, WETH, E18, SL, VAULT, lc, ID_A, MGR_A } = X;
const AMT = 2n * E18 / 100n;
const wethPos = () => [{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 0n }];
const mk = (positions = wethPos(), o = {}) => { const S = sweepScene({ positions, ...o }); S.init(); return S; };
const names = (signer) => decodeSent(signer).map((t) => t.name);
const leg0 = (S) => S.ledger().jobs[0].legs[0];
const edit = (S, fn) => { const j = S.ledger(); fn(j); fs.writeFileSync(S.file, JSON.stringify(j, null, 2) + "\n"); };
const SHORT = { waitTimeoutSec: 0.05 };
const H1 = "0x" + "11".repeat(32), H2 = "0x" + "22".repeat(32);

(async () => {
  // ---- L-1. readSweepState rejects a duplicate collect.tx across jobs and duplicate leg tokens within a job
  {
    const S = mk();
    await S.run({});
    const good = SL.readSweepState(S.file); assert.ok(good.ok); const pristine = JSON.stringify(S.ledger());
    const dupJob = S.ledger(); dupJob.jobs.push({ ...JSON.parse(JSON.stringify(dupJob.jobs[0])), id: "other:1:1" });
    fs.writeFileSync(S.file, JSON.stringify(dupJob));
    const r1 = SL.readSweepState(S.file); assert.ok(!r1.ok && r1.kind === "corrupt" && /duplicates the collect of an earlier job/.test(r1.reason), JSON.stringify(r1));
    // case differences do not hide it
    dupJob.jobs[1].collect.tx = dupJob.jobs[1].collect.tx.toUpperCase().replace("0X", "0x"); fs.writeFileSync(S.file, JSON.stringify(dupJob));
    assert.ok(!SL.readSweepState(S.file).ok);
    const dupLeg = S.ledger(); dupLeg.jobs[0].legs.push(JSON.parse(JSON.stringify(dupLeg.jobs[0].legs[0]))); fs.writeFileSync(S.file, JSON.stringify(dupLeg));
    const r2 = SL.readSweepState(S.file); assert.ok(!r2.ok && /duplicates an earlier leg of the same job/.test(r2.reason), JSON.stringify(r2));
    // and the collector refuses to run on such a ledger
    const r3 = await S.run({ signer: S.signer() });
    assert.ok(/sweep-state\.json is unreadable/.test(r3.text), r3.text); assert.strictEqual(r3.signer.sent.length, 0);
    // a malformed swap.txs is corrupt; the legacy single-hash shape (no txs) still reads
    const legacy = JSON.parse(pristine); legacy.jobs[0].legs[0].swap.txs = undefined; fs.writeFileSync(S.file, JSON.stringify(legacy)); assert.ok(SL.readSweepState(S.file).ok, "legacy shape (swap.tx only)");
    legacy.jobs[0].legs[0].swap.txs = ["nope"]; fs.writeFileSync(S.file, JSON.stringify(legacy)); assert.ok(!SL.readSweepState(S.file).ok);
    legacy.jobs[0].legs[0].swap.txs = [H1, H1.toUpperCase().replace("0X", "0x")]; fs.writeFileSync(S.file, JSON.stringify(legacy)); assert.ok(!SL.readSweepState(S.file).ok);
  }

  // ---- L-1. every swap hash is recorded
  {
    const S = mk();
    await S.run({});
    const sw = leg0(S).swap;
    assert.ok(Array.isArray(sw.txs) && sw.txs.length === 1 && sw.txs[0] === sw.tx, JSON.stringify(sw));
  }

  // ---- L-1. outRaw is capped at the swap output shown in the receipt before the first proceeds transfer
  {
    // a run that is interrupted after the swap (the signer refuses the next signature), so the leg waits in "swapped"
    const mkSwapped = async () => {
      const S = mk();
      await S.run({ signer: S.signer({ maxSigns: 3 }), baseCollect: SHORT });
      assert.strictEqual(leg0(S).phase === "swapped" || leg0(S).phase === "approved" || leg0(S).phase === "collected", true, leg0(S).phase);
      return S;
    };
    // normal resume first: delivers exactly the receipt amount
    {
      const S = await mkSwapped(); const real = BigInt(leg0(S).swap.outRaw);
      assert.ok(real > 0n);
      await S.run({ signer: S.signer() });
      assert.strictEqual(S.balance(USDC, OWNER), real); assert.strictEqual(leg0(S).phase, "delivered");
    }
    // inflated ledger + extra USDC on the operator: only the receipt amount is delivered
    {
      const S = await mkSwapped(); const real = BigInt(leg0(S).swap.outRaw);
      edit(S, (j) => { j.jobs[0].legs[0].swap.outRaw = (real * 10n).toString(); });
      S.add(USDC, OP, real * 20n);
      const r = await S.run({ signer: S.signer() });
      assert.ok(/exceeds the \d+ the swap receipt\(s\) show; capped/.test(r.text), r.text);
      assert.strictEqual(S.balance(USDC, OWNER), real, "only the receipt amount reaches the owner"); assert.strictEqual(S.balance(USDC, OP), real * 20n);
      assert.strictEqual(leg0(S).swap.outRaw, real.toString());
    }
    // several swaps: both hashes are summed (the second receipt is a real one, minted by hand into the mined set)
    {
      const S = await mkSwapped(); const real = BigInt(leg0(S).swap.outRaw); const h = leg0(S).swap.tx;
      const rc = S.mined.get(h);
      S.mined.set(H2, { ...rc, hash: H2 });
      edit(S, (j) => { const l = j.jobs[0].legs[0]; l.swap.txs = [h, H2]; l.swap.outRaw = (real * 2n).toString(); });
      S.add(USDC, OP, real);
      await S.run({ signer: S.signer() });
      assert.strictEqual(S.balance(USDC, OWNER), real * 2n, "both swap receipts count");
    }
    // a swap hash with no receipt: held, nothing sent
    {
      const S = await mkSwapped(); const real = BigInt(leg0(S).swap.outRaw);
      edit(S, (j) => { const l = j.jobs[0].legs[0]; l.swap.txs = [l.swap.tx, H1]; });
      const r = await S.run({ signer: S.signer() });
      assert.ok(/swap receipt 0x1111.* cannot be found/.test(r.text), r.text);
      assert.ok(!decodeSent(r.signer).some((t) => t.name === "transfer")); assert.strictEqual(S.balance(USDC, OWNER), 0n); assert.ok(real > 0n);
      assert.strictEqual(leg0(S).phase, "held"); assert.strictEqual(exitCodeOf(r.res), 1);
    }
    // a receipt that paid the operator nothing (a different hash than the swap): outRaw cannot be proven, unattributed
    {
      const S = await mkSwapped(); const h = leg0(S).swap.tx;
      S.mined.set(h, { ...S.mined.get(h), logs: [] });
      const r = await S.run({ signer: S.signer() });
      assert.ok(!decodeSent(r.signer).some((t) => t.name === "transfer")); assert.strictEqual(leg0(S).unattributed, true); assert.strictEqual(exitCodeOf(r.res), 1);
    }
    // the legacy shape (swap.tx only, no txs) still delivers
    {
      const S = await mkSwapped(); const real = BigInt(leg0(S).swap.outRaw);
      edit(S, (j) => { delete j.jobs[0].legs[0].swap.txs; });
      await S.run({ signer: S.signer() });
      assert.strictEqual(S.balance(USDC, OWNER), real);
    }
  }

  // ---- L-2. block-tagged balance reads fail: a Transfer(operator -> to, amount) log from the token is required
  {
    const failBlockReads = (S) => {
      const h = S.w.handlers[lc(USDC)].balanceOf;
      S.w.on(USDC, "balanceOf", (who, tx) => { if (tx && tx.blockTag !== undefined && tx.blockTag !== "latest") throw revert("missing trie node"); return h(who, tx); });
    };
    // with the log: delivered
    {
      const S = mk(); failBlockReads(S);
      const r = await S.run({});
      assert.deepStrictEqual(names(r.signer), ["collect", "approve", "exactInputSingle", "transfer"], r.text); assert.strictEqual(leg0(S).phase, "delivered");
    }
    // each way the log can be wrong: absent, other token, other recipient, other amount
    const mutations = {
      absent: () => [],
      "other token": (l) => [{ ...l, address: WETH }],
      "other recipient": (l) => [{ ...l, topics: [l.topics[0], l.topics[1], "0x" + "00".repeat(12) + "ee".repeat(20)] }],
      "other amount": (l) => [{ ...l, data: "0x" + (1n).toString(16).padStart(64, "0") }],
    };
    for (const [name, mut] of Object.entries(mutations)) {
      const S = mk(); failBlockReads(S);
      const sg = S.signer({ receiptTweak: (rc, p) => (kindOf(p) === "transfer" ? { ...rc, logs: mut(rc.logs[0]) } : rc) });
      const r = await S.run({ signer: sg });
      const l = leg0(S);
      assert.strictEqual(l.phase, "held", name); assert.strictEqual(l.unattributed, true, name); assert.ok(/neither the block balances nor a matching Transfer log/.test(l.reason), `${name}: ${l.reason}`);
      assert.strictEqual(exitCodeOf(r.res), 1, name);
      const r2 = await S.run({ signer: S.signer() });
      assert.ok(!decodeSent(r2.signer).some((t) => t.name === "transfer"), `${name}: never resent`);
    }
  }

  // ---- L-3. a broadcast collect that is never found becomes unattributed, not voided
  {
    const S = mk();
    const r1 = await S.run({ baseCollect: SHORT, signer: S.signer({ neverMined: (p) => kindOf(p) === "collect" }) });
    assert.strictEqual(r1.res.aborted, true); const nonce = S.ledger().jobs[0].pending.nonce;
    S.w.latestNonce = nonce + 1; // the nonce is used, but neither a receipt nor the transaction can be found
    const r2 = await S.run({ signer: S.signer() });
    assert.ok(/collect of #79371151 waits \(nonce \d+ is used but neither a receipt nor the transaction was found \(run 1 of 2\)/.test(r2.text), r2.text);
    assert.strictEqual(r2.signer.sent.length, 0);
    const r3 = await S.run({ signer: S.signer() });
    assert.strictEqual(S.ledger().jobs[0].collect.status, "unattributed", r3.text);
    assert.ok(/was broadcast but is not found/.test(r3.text), r3.text);
    assert.strictEqual(S.ledger().jobs[0].pending, null);
    assert.strictEqual(r3.signer.sent.length, 0, "no new collect while it is unattributed");
    assert.ok(r3.res.sweep.report.unattributed.length >= 1); assert.strictEqual(exitCodeOf(r3.res), 1);
    const r4 = await S.run({ signer: S.signer() });
    assert.strictEqual(r4.signer.sent.length, 0); assert.ok(/sweep: new collects are blocked \(job .* is unattributed\)/.test(r4.text), r4.text);
  }

  // ---- Info. VAULT_IMPLEMENTATIONS is deeply frozen; the injected list is what verifyVault uses
  {
    assert.ok(Object.isFrozen(SL.VAULT_IMPLEMENTATIONS));
    assert.throws(() => SL.VAULT_IMPLEMENTATIONS.push(VAULT.impl), TypeError);
    assert.deepStrictEqual(SL.VAULT_IMPLEMENTATIONS, []);
    const A = mk(); const ac = A.vault({ allowImpl: false });
    const ar = await A.run({ sweep: { vault: ac } });
    assert.ok(ar.res.sweep.report.vault.some((m) => /not in the code allowlist/.test(m))); assert.strictEqual(A.balance(USDC, VAULT.tba), 0n);
    const B = mk(); const bc = B.vault({});
    await B.run({ sweep: { vault: bc } });
    assert.ok(B.balance(USDC, VAULT.tba) > 0n, "the injected implementation verifies the vault"); assert.deepStrictEqual(SL.VAULT_IMPLEMENTATIONS, [], "the constant is untouched");
  }

  console.log("collector-base-sweep-reverify tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
