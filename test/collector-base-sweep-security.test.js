// node test/collector-base-sweep-security.test.js -- the security-review fixes of the Base sweep (M1-M3, L1, L3, L4, R1, R2, L2). A mocked chain,
// no network, no key, no transaction ever leaves the process.
"use strict";
const assert = require("assert");
const fs = require("fs");
const X = require("./lib/sweep-scene");
const { exitCodeOf } = require("../collector-base");

const { sweepScene, decodeSent, kindOf, OWNER, OP, USDC, WETH, OTHER, E18, SL, L, VAULT, lc, ID_A, MGR_A } = X;
const EVIL = "0x00000000000000000000000000000000000000ee";
const AMT = 2n * E18 / 100n;
const wethPos = () => [{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: AMT, a1: 0n }];
const mk = (positions = wethPos(), o = {}) => { const S = sweepScene({ positions, ...o }); S.init(); return S; };
const names = (signer) => decodeSent(signer).map((t) => t.name);
const leg0 = (S) => S.ledger().jobs[0].legs[0];
const SHORT = { waitTimeoutSec: 0.05 };
const transfers = (S) => S.txs.filter((t) => lc(t.data).startsWith("0xa9059cbb"));
const edit = (S, fn) => { const j = S.ledger(); fn(j); fs.writeFileSync(S.file, JSON.stringify(j, null, 2) + "\n"); };

// L1 first, before any scene touches the allowlist: it ships empty and settings cannot change the registry.
assert.deepStrictEqual(SL.VAULT_IMPLEMENTATIONS, [], "the implementation allowlist is empty by default");
assert.strictEqual(SL.ERC6551_REGISTRY, "0x000000006551c19487814612e58FE06813775758");
assert.strictEqual(SL.config({ vault: { registry: EVIL } }).vault.registry, EVIL, "the raw setting is carried but never used (verifyVault refuses a different one)");

(async () => {
  // ---- M1. a mined transfer with a lagging RPC balance: one transfer, ever, never a retry
  {
    const S = mk();
    let lag = null; // the "latest" USDC balance of the operator, frozen at the pre-transfer value
    const orig = S.rawEffect;
    S.rawEffect = (p) => { const before = S.balance(USDC, OP); const r = orig(p); if (kindOf(p) === "transfer") lag = before; return r; };
    const h = S.w.handlers[lc(USDC)].balanceOf;
    S.w.on(USDC, "balanceOf", (who, tx) => (lag !== null && lc(who) === lc(OP) && (!tx || tx.blockTag === undefined || tx.blockTag === "latest") ? [lag] : h(who, tx)));
    const r1 = await S.run({});
    assert.deepStrictEqual(names(r1.signer), ["collect", "approve", "exactInputSingle", "transfer"], r1.text);
    assert.strictEqual(leg0(S).phase, "delivered", "balances were read at the receipt block, not at the lagging latest");
    assert.strictEqual(exitCodeOf(r1.res), 0);
    lag = null; await S.run({}); await S.run({});
    assert.strictEqual(transfers(S).length, 1, "exactly one transfer ever");
  }

  // ---- M1b. a mined transfer whose balance really did not move at the receipt block: held + unattributed, never resent, owner never paid the full amount
  {
    for (const withVault of [false, true]) {
      const S = mk(); S.noBalanceMove = true;
      const cfg = withVault ? S.vault({}) : undefined;
      const sweep = withVault ? { vault: cfg } : undefined;
      const r1 = await S.run({ sweep });
      assert.strictEqual(transfers(S).length, 1, `one transfer in the first run (vault ${withVault})\n${r1.text}`);
      assert.strictEqual(leg0(S).unattributed, true); assert.strictEqual(leg0(S).phase, "held"); assert.strictEqual(exitCodeOf(r1.res), 1);
      assert.ok(/UNATTRIBUTED WETH of #79371151/.test(r1.text) && r1.res.sweep.report.unattributed.length === 1);
      if (withVault) assert.strictEqual(transfers(S).filter((t) => !lc(t.data).includes(lc(VAULT.tba).slice(2))).length, 0, "the owner was not paid after the vault transfer");
      assert.ok(BigInt(leg0(S).outDone || "0") === 0n, "the proceeds are not credited as delivered");
      await S.run({ sweep }); await S.run({ sweep });
      assert.strictEqual(transfers(S).length, 1, `still exactly one transfer ever (vault ${withVault})`);
    }
  }

  // ---- M2. a lagging RPC (receipt not there yet, nonce already used): no second swap, no second transfer
  {
    for (const op of ["exactInputSingle", "transfer"]) {
      const S = mk();
      const r1 = await S.run({ baseCollect: SHORT, signer: S.signer({ dropReceipt: (p) => kindOf(p) === op }) });
      assert.strictEqual(r1.res.aborted, true, op);
      const pend = leg0(S).pending; assert.ok(pend, `${op}: the intent is pending`);
      const hash = pend.tx; const rc = S.mined.get(hash); S.mined.delete(hash); // the node's receipt index lags
      S.w.latestNonce = pend.nonce + 1;
      S.w.getTx = (hh) => (hh === hash ? { hash } : null); // but the node knows the transaction
      for (let i = 0; i < 3; i++) {
        const r = await S.run({ signer: S.signer() });
        assert.ok(!r.signer.sent.some((t) => ["exactInputSingle", "transfer"].includes(decodeSent({ sent: [t] })[0].name)), `${op}: nothing re-sent (run ${i})\n${r.text}`);
        assert.ok(leg0(S).pending, `${op}: still pending, not voided`);
      }
      // the receipt catches up: the leg completes from it, exactly one swap and one transfer overall
      S.mined.set(hash, rc);
      const r5 = await S.run({ signer: S.signer() });
      assert.strictEqual(leg0(S).phase, "delivered", `${op}\n${r5.text}`);
      assert.strictEqual(S.txs.filter((t) => lc(t.to) === lc(SL.ROUTER)).length, 1, `${op}: one swap ever`);
      assert.strictEqual(transfers(S).length, 1, `${op}: one transfer ever`);
    }
    // not found once, then the receipt shows up: the counter alone never voids
    const T = mk();
    await T.run({ baseCollect: SHORT, signer: T.signer({ dropReceipt: (p) => kindOf(p) === "exactInputSingle" }) });
    const pend = leg0(T).pending; const rc = T.mined.get(pend.tx); T.mined.delete(pend.tx); T.w.latestNonce = pend.nonce + 1;
    await T.run({ signer: T.signer() });
    assert.strictEqual(leg0(T).pending.notFoundRuns, 1, "run 1 of 2 recorded in the ledger intent");
    T.mined.set(pend.tx, rc);
    const t3 = await T.run({ signer: T.signer() });
    assert.strictEqual(leg0(T).phase, "delivered", t3.text); assert.strictEqual(T.txs.filter((t) => lc(t.to) === lc(SL.ROUTER)).length, 1);
    // a lookup that fails is waiting, never void
    const E = mk();
    await E.run({ baseCollect: SHORT, signer: E.signer({ neverMined: (p) => kindOf(p) === "exactInputSingle" }) });
    E.w.latestNonce = leg0(E).pending.nonce + 1; E.w.getTx = () => new Error("rpc down");
    for (let i = 0; i < 3; i++) await E.run({ signer: E.signer() });
    assert.ok(leg0(E).pending, "a failing getTransaction never voids"); assert.strictEqual(E.txs.filter((t) => lc(t.to) === lc(SL.ROUTER)).length, 0);
  }

  // ---- M3a. an injected job for a foreign owner: refused, nothing sent, reported, new collects blocked
  {
    const S = mk();
    await S.run({ signer: S.signer({ maxSigns: 3 }) }); // collect, approve, swap done; the proceeds await delivery
    assert.strictEqual(leg0(S).phase, "swapped");
    S.owners[ID_A] = EVIL; // the chain agrees with the tampered ledger, only the configuration disagrees
    edit(S, (j) => { j.jobs[0].owner = EVIL; });
    const r = await S.run({ signer: S.signer() });
    assert.strictEqual(r.signer.sent.length, 0, r.text); assert.strictEqual(S.balance(USDC, EVIL), 0n);
    assert.ok(/REFUSED: job .* is not a configured owner address/.test(r.text)); assert.strictEqual(exitCodeOf(r.res), 1);
    assert.ok(r.res.sweep.report.held.some((m) => /not a configured owner/.test(m)));
    const sweepOnly = await S.run({ signer: S.signer() });
    assert.ok(!sweepOnly.signer.sent.some((t) => lc(t.to) === lc(MGR_A)), "no new collect while a foreign-owner job is in the ledger");
  }

  // ---- M3b. an inflated owedRaw is refused against the Collect receipt: nothing approved, swapped or transferred
  {
    const S = mk();
    await S.run({ signer: S.signer({ maxSigns: 1 }) });
    S.add(WETH, OP, 9n * AMT); // funds the operator holds for other reasons
    edit(S, (j) => { j.jobs[0].legs[0].owedRaw = (10n * AMT).toString(); });
    const r = await S.run({ signer: S.signer() });
    assert.strictEqual(r.signer.sent.length, 0, r.text);
    assert.ok(/ledger owes \d+ raw WETH but the Collect receipt paid \d+; tampered ledger, refusing/.test(r.text), r.text);
    assert.strictEqual(leg0(S).phase, "held"); assert.strictEqual(exitCodeOf(r.res), 1); assert.strictEqual(S.balance(WETH, OWNER), 0n);
    // a leg of a token the position does not hold is refused too
    const T = mk();
    await T.run({ signer: T.signer({ maxSigns: 1 }) });
    edit(T, (j) => { j.jobs[0].legs[0].token = OTHER; });
    T.setBalance(OTHER, OP, AMT);
    const t2 = await T.run({ signer: T.signer() });
    assert.strictEqual(t2.signer.sent.length, 0, t2.text); assert.ok(/is not a token of position/.test(t2.text));
    // an unreadable collect receipt fails closed
    const U = mk();
    await U.run({ signer: U.signer({ maxSigns: 1 }) });
    U.mined.clear();
    const u2 = await U.run({ signer: U.signer() });
    assert.strictEqual(u2.signer.sent.length, 0); assert.ok(/cannot be checked against the collect receipt/.test(u2.text));
  }

  // ---- M3c. the unswapped value cap
  {
    // USDC fees over the cap are held, not transferred
    const S = mk([{ id: ID_A, mgr: MGR_A, t0: USDC, t1: OTHER, a0: 500n * 10n ** 6n, a1: 0n }]);
    const r = await S.run({ sweep: { maxUnswappedValueUsdc: 100 } });
    // (re-review of 4930f2a, MEDIUM) the cap is applied BEFORE the collect: the over-cap USDC leg is never collected, the fees stay in the NFT
    assert.deepStrictEqual(names(r.signer), [], r.text); assert.ok(/above maxUnswappedValueUsdc 100/.test(r.text) && /the fees stay in the NFT/.test(r.text), r.text);
    assert.strictEqual(S.ledger().jobs.length, 0, "no job, no intent"); assert.strictEqual(S.balance(USDC, OP), 0n, "nothing reached the operator");
    // under the cap: delivered
    const U = mk([{ id: ID_A, mgr: MGR_A, t0: USDC, t1: OTHER, a0: 50n * 10n ** 6n, a1: 0n }]);
    const u = await U.run({ sweep: { maxUnswappedValueUsdc: 100 } });
    assert.deepStrictEqual(names(u.signer), ["collect", "transfer"], u.text);
    // a routed token the swap declined (value above maxSwapValueUsdc) is valued at the pool mid price: 1 WETH (about 2000 USDC) over a 1000 cap is held
    const W = mk([{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: E18, a1: 0n }]);
    const w = await W.run({ sweep: { maxUnswappedValueUsdc: 1000 } });
    assert.deepStrictEqual(names(w.signer), [], w.text); assert.ok(/WETH value .* above maxUnswappedValueUsdc 1000; the fees stay in the NFT/.test(w.text), w.text);
    assert.strictEqual(W.balance(WETH, OP), 0n, "the declined WETH leg was not collected");
    // a token with no price and no route is capped by the position fee value: over the cap refused, under it delivered
    const N = mk([{ id: ID_A, mgr: MGR_A, t0: USDC, t1: OTHER, a0: 0n, a1: 5n * E18 }], { feesUsd: 9000, usd1: 1800 });
    const n = await N.run({ sweep: { maxUnswappedValueUsdc: 1000 } });
    assert.deepStrictEqual(names(n.signer), [], n.text); assert.ok(/no price and no safe route to USDC|above maxUnswappedValueUsdc 1000; the fees stay in the NFT/.test(n.text), n.text);
    const M = mk([{ id: ID_A, mgr: MGR_A, t0: USDC, t1: OTHER, a0: 0n, a1: 5n * E18 }], { feesUsd: 50, usd1: 10 });
    assert.deepStrictEqual(names((await M.run({ sweep: { maxUnswappedValueUsdc: 1000 } })).signer), ["collect", "transfer"]);
    // ...and with no per-side price it is refused; the position-wide fee value is no longer consulted (preflight directly)
    const sweepMod = require("../collector-base-sweep");
    const sw0 = sweepMod.create({ sw: SL.config({ enabled: true, maxUnswappedValueUsdc: 1000 }), provider: null, operator: OP, log() {}, now: () => 0, io: null, owners: [OWNER] });
    const noRoute = { swap: false, reason: "no allowlisted route for this token" };
    const pre = (leg) => sw0.preflight({ legs: [leg], ops: ["transfer"] }, { collectWorstWei: 1n, perOpWei: () => 1n, run: {}, feesUsd: 1 });
    for (const bad of [undefined, null, NaN, "abc", -1, 0, Infinity]) {
      const pf = await pre({ token: OTHER, amount: 5n * E18, d: noRoute, usd: bad, decimals: 18 });
      assert.ok(!pf.ok && /no per-side USD price/.test(pf.reason), `${bad}: ${pf.reason}`);
    }
    assert.ok(!(await pre({ token: OTHER, amount: 5n * E18, d: noRoute, usd: 10, decimals: null })).ok, "unknown decimals are refused");
    const hi = await pre({ token: OTHER, amount: 5n * E18, d: noRoute, usd: 201, decimals: 18 });
    assert.ok(!hi.ok && /above maxUnswappedValueUsdc 1000; the fees stay in the NFT/.test(hi.reason), hi.reason);
    // (review) a swap-planned leg is capped at its mid price too, so a forced swap failure cannot get around the cap
    const planned = await pre({ token: WETH, amount: E18, d: { swap: true, mid: 2000n * 10n ** 6n } });
    assert.ok(!planned.ok && /planned swap of WETH value 2000.* above maxUnswappedValueUsdc 1000; the fees stay in the NFT/.test(planned.reason), planned.reason);
    // bounds
    assert.strictEqual(SL.config({ maxUnswappedValueUsdc: 1e12 }).maxUnswappedValueUsdc, 50000); assert.strictEqual(SL.config({}).maxUnswappedValueUsdc, 5000);
  }

  // ---- L1. the vault: empty implementation allowlist, canonical registry, expectedOwner among the configured owners
  {
    const A = mk(); const ac = A.vault({ allowImpl: false });
    assert.ok(Object.isFrozen(SL.VAULT_IMPLEMENTATIONS) && SL.VAULT_IMPLEMENTATIONS.length === 0, "the allowlist constant is frozen and was never mutated");
    const ar = await A.run({ sweep: { vault: ac } });
    assert.ok(ar.res.sweep.report.vault.some((m) => /not in the code allowlist of ERC-6551 implementations/.test(m)), JSON.stringify(ar.res.sweep.report.vault));
    assert.ok(decodeSent(ar.signer).filter((t) => t.name === "transfer").every((t) => t.args[0] === OWNER)); assert.strictEqual(A.balance(USDC, VAULT.tba), 0n);
    const B = mk(); const bc = B.vault({ cfg: { registry: EVIL } });
    const br = await B.run({ sweep: { vault: bc } });
    assert.ok(br.res.sweep.report.vault.some((m) => /is not the canonical ERC-6551 registry/.test(m))); assert.strictEqual(B.balance(USDC, VAULT.tba), 0n);
    const C = mk(); const cc = C.vault({ cfg: { expectedOwner: EVIL }, tbaOwner: EVIL, nftOwner: EVIL });
    const cr = await C.run({ sweep: { vault: cc } });
    assert.ok(cr.res.sweep.report.vault.some((m) => /expectedOwner .* is not one of the configured owner addresses/.test(m)), JSON.stringify(cr.res.sweep.report.vault));
    assert.strictEqual(C.balance(USDC, VAULT.tba), 0n); assert.ok(C.balance(USDC, OWNER) > 39_000_000n);
    // the shipped config with the canonical registry omitted still works once an implementation is allowlisted
    const D = mk(); const dc = D.vault({ cfg: { registry: null } });
    await D.run({ sweep: { vault: dc } });
    assert.ok(D.balance(USDC, VAULT.tba) > 0n, "registry omitted -> the canonical one is used");
  }

  // ---- L3. no Collect event: unattributed, no fallback to the simulated amounts
  {
    const S = mk(wethPos(), { noCollectEvent: true });
    const r = await S.run({});
    assert.deepStrictEqual(names(r.signer), ["collect"], r.text); assert.strictEqual(S.ledger().jobs[0].collect.status, "unattributed");
    assert.strictEqual(exitCodeOf(r.res), 1); assert.strictEqual(S.balance(WETH, OP), AMT);
    assert.ok(!/simulated amounts clamped/.test(r.text));
  }

  // ---- L4. assertSignableSweep: approve targets, reset targets, transfer targets
  {
    const lim = { ...L.limits({}), ...SL.limitOverrides(SL.config({})), maxGasLimitByOp: SL.GAS_CEILINGS };
    const b = { type: 2, chainId: 8453, value: 0n, nonce: 3, gasLimit: 50_000n, maxFeePerGas: 61_000_000n, maxPriorityFeePerGas: 1_000_000n };
    const ap = (token, amt) => [{ ...b, to: token, data: SL.calldata.approve(SL.ROUTER, amt) }, { token, legTokens: [token], amount: amt, operator: OP }];
    const tr = (token, legTokens) => [{ ...b, to: token, data: SL.calldata.transfer(OWNER, 5n) }, { token, legTokens, amount: 5n, recipients: [OWNER], operator: OP }];
    const ok = (op, [tx, ex]) => SL.assertSignableSweep(tx, lim, op, ex);
    const no = (op, [tx, ex], re) => assert.throws(() => SL.assertSignableSweep(tx, lim, op, ex), re);
    ok("approve", ap(WETH, 7n));
    no("approve", ap(USDC, 7n), /approve target .* is not a swap-route token/);
    no("approve", ap(OTHER, 7n), /approve target .* is not a swap-route token/);
    ok("approve-reset", ap(WETH, 0n)); ok("approve-reset", ap(USDC, 0n));
    no("approve-reset", ap(OTHER, 0n), /approve-reset target .* is not a route token or USDC/);
    ok("transfer", tr(WETH, [WETH])); ok("transfer", tr(USDC, [USDC])); ok("transfer", tr(OTHER, [OTHER]));
    no("transfer", tr(OTHER, []), /is not a token of the active leg/);
    no("transfer", tr(OTHER, [WETH]), /is not a token of the active leg/);
  }

  // ---- R1. a vault transfer skipped before signing is retried next run (vaultTried only once a signed intent exists)
  {
    const S = mk(); const vc = S.vault({});
    await S.run({ signer: S.signer({ maxSigns: 3 }), sweep: { vault: vc } }); // collect, approve, swap
    S.estimateFail.add("transfer"); // the transfer estimate fails: skipped before signing
    const r2 = await S.run({ sweep: { vault: vc }, signer: S.signer() });
    assert.strictEqual(r2.signer.signs.length, 0, r2.text); assert.ok(!leg0(S).vaultTried, "not marked tried: nothing was signed");
    S.estimateFail.delete("transfer");
    const r3 = await S.run({ sweep: { vault: vc }, signer: S.signer() });
    const out = BigInt(leg0(S).swap.outRaw);
    assert.deepStrictEqual(decodeSent(r3.signer).filter((t) => t.name === "transfer").map((t) => t.args[0]), [VAULT.tba, OWNER], r3.text);
    assert.strictEqual(S.balance(USDC, VAULT.tba), (out * 10n) / 100n, "the vault split was retried and paid");
    assert.strictEqual(leg0(S).vaultTried, true);
  }

  // ---- R2. no collecting wallet: the pass continues only for open jobs or an unreadable ledger
  {
    const S = mk();
    await S.run({}); // everything delivered: only terminal jobs
    const e = await S.run({ signer: S.signer(), raw: (raw) => { raw.wallets.main.collect = false; } });
    assert.ok(/no wallet has collect:true; nothing to do/.test(e.text), e.text); assert.strictEqual(e.signer.sent.length, 0); assert.strictEqual(exitCodeOf(e.res), 0);
    const O = mk();
    await O.run({ signer: O.signer({ maxSigns: 1 }) }); // an open job
    const o = await O.run({ signer: O.signer(), raw: (raw) => { raw.wallets.main.collect = false; } });
    assert.ok(!/nothing to do/.test(o.text)); assert.deepStrictEqual(names(o.signer), ["approve", "exactInputSingle", "transfer"], o.text);
    const C = mk();
    fs.writeFileSync(C.file, "{ not json");
    const c = await C.run({ signer: C.signer(), raw: (raw) => { raw.wallets.main.collect = false; } });
    assert.ok(!/nothing to do/.test(c.text), "an unreadable ledger is never skipped silently"); assert.strictEqual(c.signer.sent.length, 0); assert.strictEqual(exitCodeOf(c.res), 1);
  }

  // ---- L2. minOut uses the lower of the quote and the TWAP-priced output
  {
    const sw = SL.config({ enabled: true });
    const S = mk();
    const p = S.pools.WETH; const amountIn = AMT;
    const f = { route: SL.ROUTES.WETH, amountIn, quote: S.quote("WETH", amountIn), sqrtPriceX96: p.sqrt, tick: p.tick, liquidity: p.liquidity, poolUsdc: p.usdc, twapTick: p.tick };
    const d1 = SL.decideSwap(sw, f); assert.strictEqual(d1.swap, true);
    // the TWAP sits 1.5% higher in price than the quote's own pool tick: the quote is the lower reference, minOut unchanged
    assert.strictEqual(d1.minOut, SL.minOutOf(f.quote, sw.slippageBps));
    // the TWAP price is far lower (but within the deviation bound) than a quote near the mid: minOut follows the TWAP
    const lowTick = p.tick - 150; // about 1.5% lower in price terms
    const d2 = SL.decideSwap(sw, { ...f, quote: S.quote("WETH", amountIn, 0), twapTick: lowTick });
    if (d2.swap) assert.ok(d2.minOut < SL.minOutOf(S.quote("WETH", amountIn, 0), sw.slippageBps), "minOut is below the quote-based floor");
  }
  console.log("collector-base-sweep-security tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
