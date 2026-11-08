// node test/collector-base-sweep-reverify.test.js -- the re-review of 4930f2a: ledger duplicates (L-1), swap output re-proved from the receipts (L-1),
// transfers without block balances need a Transfer log (L-2), a broadcast collect that is never found is unattributed (L-3), and the frozen
// vault implementation allowlist (Info). A mocked chain, no network, no key, no transaction ever leaves the process.
"use strict";
const assert = require("assert");
const fs = require("fs");
const X = require("./lib/sweep-scene");
const { exitCodeOf } = require("../collector-base");
const { revert } = require("./fixtures/mock-chain");

const { sweepScene, decodeSent, kindOf, OWNER, OP, USDC, WETH, OTHER, E18, SL, VAULT, lc, ID_A, MGR_A, priceOf, ROUTES } = X;
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
      "removed (reorged) log": (l) => [{ ...l, removed: true }],
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

  // ---- review fix 1. the receipt-total cache is per swap-hash set: a second swap in the same run is not cut down
  {
    const S = mk();
    // the collect leaves only half the WETH on the operator; the other half arrives after the first swap, so the leg swaps twice in one run
    S.hooks.push((p) => {
      if (kindOf(p) === "collect") S.setBalance(WETH, OP, AMT / 2n);
      if (lc(p.to) === lc(SL.ROUTER) && !S.topped) { S.topped = true; S.add(WETH, OP, AMT / 2n); }
    });
    const r = await S.run({});
    const swaps = names(r.signer).filter((n) => n === "exactInputSingle").length;
    assert.strictEqual(swaps, 2, r.text);
    const l = leg0(S);
    assert.strictEqual(l.swap.txs.length, 2, "both swap hashes recorded");
    assert.strictEqual(l.phase, "delivered", r.text + JSON.stringify(l));
    assert.strictEqual(S.balance(USDC, OWNER), BigInt(l.swap.outRaw), "the proceeds of both swaps reach the owner, none cut"); assert.ok(!/capped \(tampered ledger\)/.test(r.text), r.text);
  }

  // ---- review fix 2. one swap receipt backs one leg; a swap hash is never a collect hash
  {
    const S = mk();
    await S.run({});
    const base = S.ledger();
    const write = (j) => fs.writeFileSync(S.file, JSON.stringify(j));
    const clone = (x) => JSON.parse(JSON.stringify(x));
    // cross-job: a second job whose leg reuses the first job's swap hash (its own collect.tx differs)
    const a = clone(base); const j2 = clone(a.jobs[0]); j2.id = "other:2:2"; j2.collect.tx = H1; a.jobs.push(j2); write(a);
    const ra = SL.readSweepState(S.file); assert.ok(!ra.ok && ra.kind === "corrupt" && /swap hash .* already recorded for another leg/.test(ra.reason), JSON.stringify(ra));
    // case differences do not hide it
    j2.legs[0].swap.tx = j2.legs[0].swap.tx.toUpperCase().replace("0X", "0x"); j2.legs[0].swap.txs = [j2.legs[0].swap.tx]; write(a); assert.ok(!SL.readSweepState(S.file).ok);
    // cross-leg: a second leg of the same job (another token) reuses it
    const b = clone(base); const l2 = clone(b.jobs[0].legs[0]); l2.token = USDC; b.jobs[0].legs.push(l2); write(b);
    const rb = SL.readSweepState(S.file); assert.ok(!rb.ok && /already recorded for another leg/.test(rb.reason), JSON.stringify(rb));
    // a swap hash equal to a collect.tx (this job's, the legacy single-hash shape; and another job's)
    const c = clone(base); c.jobs[0].legs[0].swap.txs = undefined; c.jobs[0].legs[0].swap.tx = c.jobs[0].collect.tx; write(c);
    const rc = SL.readSweepState(S.file); assert.ok(!rc.ok && /equals a collect transaction/.test(rc.reason), JSON.stringify(rc));
    const d = clone(base); const j3 = clone(d.jobs[0]); j3.id = "other:3:3"; j3.legs = []; j3.collect.tx = d.jobs[0].legs[0].swap.tx; d.jobs.push(j3); write(d);
    const rd = SL.readSweepState(S.file); assert.ok(!rd.ok && /equals a collect transaction/.test(rd.reason), JSON.stringify(rd));
    // the pristine ledger still reads, and tx/txs listing the same hash in one leg is not a duplicate
    write(base); assert.ok(SL.readSweepState(S.file).ok);
  }

  // ---- review fix 3. an unswapped delivery is capped at run time; a swap-planned leg is capped in preflight
  {
    // a swap that fails maxAttemptsPerLeg times while the price rises over the cap: held, not delivered
    const mkFail = (extra = {}) => {
      let broken = false;
      const S = mk(wethPos(), { getPool: () => (broken ? OTHER : undefined), ...extra });
      S.failNext.push(Object.assign((p) => lc(p.to) === lc(SL.ROUTER), { sticky: true }));
      let fails = 0;
      S.hooks.push((p) => {
        if (lc(p.to) !== lc(SL.ROUTER) || ++fails < 3) return;
        const np = priceOf(ROUTES.WETH, 20000); Object.assign(S.pools.WETH, { sqrt: np.sqrt, tick: np.tick, twapTick: np.tick });
        if (extra.breakPool) broken = true;
      });
      return S;
    };
    const S = mkFail();
    const r = await S.run({ sweep: { maxUnswappedValueUsdc: 100 } });
    assert.strictEqual(leg0(S).phase, "held", r.text); assert.ok(/unswapped value .* is above maxUnswappedValueUsdc 100/.test(leg0(S).reason), leg0(S).reason);
    assert.strictEqual(S.balance(WETH, OWNER), 0n, "not delivered"); assert.strictEqual(S.balance(WETH, OP), AMT, "still on the operator");
    assert.ok(!names(r.signer).includes("transfer")); assert.strictEqual(exitCodeOf(r.res), 1);
    // no mid and no price at all: held with a clear reason
    const N = mkFail({ breakPool: true, usd0: null });
    const n = await N.run({ sweep: { maxUnswappedValueUsdc: 100 } });
    assert.strictEqual(leg0(N).phase, "held", n.text); assert.ok(/no value can be established/.test(leg0(N).reason), leg0(N).reason);
    assert.strictEqual(N.balance(WETH, OWNER), 0n);
    // control: no mid but the leg's own per-side price (usd0 = 1 per WETH here) is under the cap: delivered, as before
    const C = mkFail({ breakPool: true });
    const c = await C.run({ sweep: { maxUnswappedValueUsdc: 100 } });
    assert.strictEqual(C.balance(WETH, OWNER), AMT, c.text); assert.strictEqual(leg0(C).phase, "delivered-unswapped");
    // preflight: a swap-planned WETH leg worth about 40 USDC is refused over a cap of 10; nothing is collected
    const P = mk();
    const p = await P.run({ sweep: { maxUnswappedValueUsdc: 10 } });
    assert.deepStrictEqual(names(p.signer), [], p.text); assert.ok(/planned swap of WETH value .* above maxUnswappedValueUsdc 10/.test(p.text) && /the fees stay in the NFT/.test(p.text), p.text);
  }

  // ---- review fix 4. a no-mid leg is valued from its own side price, not the position-wide fee value
  {
    const mkO = (o) => mk([{ id: ID_A, mgr: MGR_A, t0: USDC, t1: OTHER, a0: 0n, a1: 5n * E18 }], o);
    // the position-wide feesUsd is tiny, but this token's own price makes it worth 5 * 400 = 2000 USDC: refused over a cap of 1000
    const A = mkO({ feesUsd: 3, usd1: 400 });
    const a = await A.run({ sweep: { maxUnswappedValueUsdc: 1000 } });
    assert.deepStrictEqual(names(a.signer), [], a.text); assert.ok(/above maxUnswappedValueUsdc 1000; the fees stay in the NFT/.test(a.text), a.text);
    // a huge feesUsd with a small side price does not block it
    const B = mkO({ feesUsd: 99999, usd1: 10 });
    assert.deepStrictEqual(names((await B.run({ sweep: { maxUnswappedValueUsdc: 1000 } })).signer), ["collect", "transfer"]);
    // no per-side price: refused
    const C = mkO({ feesUsd: 3, usd1: null });
    const c = await C.run({ sweep: { maxUnswappedValueUsdc: 1000 } });
    assert.deepStrictEqual(names(c.signer), [], c.text); assert.ok(/no per-side USD price/.test(c.text), c.text);
  }

  // ---- review fix 5. recovery credits a mined transfer only with proof
  {
    const run1 = async () => {
      const S = mk(); S.noBalanceMove = true;
      const r1 = await S.run({ baseCollect: SHORT, signer: S.signer({ dropReceipt: (p) => kindOf(p) === "transfer" }) });
      assert.strictEqual(r1.res.aborted, true, r1.text); assert.ok(leg0(S).pending && leg0(S).pending.op === "transfer", JSON.stringify(leg0(S)));
      return S;
    };
    // no balance fall at the block and no Transfer log: unattributed, not credited, never resent
    const S = await run1(); const h = leg0(S).pending.tx;
    S.mined.set(h, { ...S.mined.get(h), logs: [] });
    const r2 = await S.run({ signer: S.signer() });
    assert.strictEqual(leg0(S).unattributed, true, r2.text); assert.strictEqual(leg0(S).phase, "held"); assert.strictEqual(leg0(S).outDone === undefined || leg0(S).outDone === "0", true);
    assert.ok(!decodeSent(r2.signer).some((t) => t.name === "transfer")); assert.strictEqual(exitCodeOf(r2.res), 1);
    // with the matching Transfer log (balances unprovable) the same recovery credits it
    const T = await run1();
    await T.run({ signer: T.signer() });
    assert.notStrictEqual(leg0(T).unattributed, true, "a transfer with its log is credited");
  }

  // ---- review fix 6. hardening
  {
    // (a) a swap receipt without to / from is refused
    for (const field of ["to", "from"]) {
      const S = mk();
      await S.run({ signer: S.signer({ maxSigns: 3 }), baseCollect: SHORT });
      const h = leg0(S).swap.tx; const rc = { ...S.mined.get(h) }; delete rc[field]; S.mined.set(h, rc);
      const r = await S.run({ signer: S.signer() });
      assert.ok(!decodeSent(r.signer).some((t) => t.name === "transfer"), field); assert.strictEqual(leg0(S).phase, "held", `${field}: ${r.text}`);
    }
    // (c) a non-array implementations list fails closed
    const sweepMod = require("../collector-base-sweep");
    const vcfg = SL.config({ enabled: true, vault: { tba: VAULT.tba, nft: VAULT.nft, tokenId: 7, implementation: VAULT.impl, registry: VAULT.reg, salt: "0x" + "00".repeat(32), expectedOwner: OWNER, splitPct: 10, maxSplitPct: 20 } });
    for (const bad of [{}, "x", 5, null]) {
      const v = await sweepMod.verifyVault(null, vcfg, { operator: OP, owners: [OWNER], tokens: [], implementations: bad });
      assert.ok(!v.ok && /not in the code allowlist/.test(v.reason), `${JSON.stringify(bad)}: ${v.reason}`);
    }
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
