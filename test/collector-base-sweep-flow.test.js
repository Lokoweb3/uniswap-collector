// node test/collector-base-sweep-flow.test.js -- acceptance 4, 5, 11, 13, 14: who every signed tx goes to, the owner re-read at delivery,
// the decoded swap calldata, exact approvals and their reset, and that only ledger-attributed amounts ever move. Mocked chain, no network.
"use strict";
const assert = require("assert");
const X = require("./lib/sweep-scene");
const { exitCodeOf } = require("../collector-base");

const { sweepScene, defaultPositions, decodeSent, kindOf, OWNER, OP, USDC, WETH, CBBTC, LAPTOP, OTHER, NEW_OWNER, E18, SL, lc, ID_A, ID_B, MGR_A, MGR_B } = X;
const mk = (positions = defaultPositions(), o = {}) => { const S = sweepScene({ positions, ...o }); S.init(); return S; };
const wethOnly = (o = {}) => mk([{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: 2n * E18 / 100n, a1: 0n }], o);
const names = (signer) => decodeSent(signer).map((t) => t.name);
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

(async () => {
  // ---- 4. every signed tx of a full run: destinations, spender, recipients
  {
    const S = mk([
      { id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: 2n * E18 / 100n, a1: 5_000_000n },
      { id: ID_B, mgr: MGR_B, t0: CBBTC, t1: LAPTOP, a0: 100_000n, a1: 400n * E18 },
    ]);
    const r = await S.run({});
    const sent = decodeSent(r.signer);
    assert.strictEqual(r.res.aborted, false, r.text);
    assert.deepStrictEqual(sent.map((t) => t.name), ["collect", "approve", "exactInputSingle", "transfer", "transfer", "collect", "approve", "exactInputSingle", "transfer", "approve", "exactInputSingle", "transfer"]);
    const legTokens = [WETH, USDC, CBBTC, LAPTOP];
    for (const t of sent) {
      assert.strictEqual(t.value, 0n, "no value anywhere");
      if (t.name === "exactInputSingle") assert.strictEqual(lc(t.to), lc(SL.ROUTER), "swap to the router constant");
      else if (t.name === "collect") { assert.ok([MGR_A, MGR_B].some((m) => lc(m) === lc(t.to))); assert.strictEqual(t.args[0].recipient, OP, "collect pays the operator"); }
      else {
        assert.ok(legTokens.some((a) => lc(a) === lc(t.to)), `${t.name} to a token of a leg`);
        if (t.name === "approve") assert.strictEqual(t.args[0], SL.ROUTER, "approve spender is the router only");
        if (t.name === "transfer") assert.strictEqual(t.args[0], OWNER, "every transfer goes to the live ownerOf");
      }
    }
    for (const t of sent.filter((x) => x.name === "exactInputSingle")) { assert.strictEqual(t.args[0].recipient, OP); assert.strictEqual(t.args[0].tokenOut, USDC); }
    // the delivery went to the owner and the operator keeps nothing
    for (const tok of [WETH, USDC, CBBTC, LAPTOP]) assert.strictEqual(S.balance(tok, OP), 0n, `operator holds no ${tok}`);
    assert.ok(S.balance(USDC, OWNER) > 100_000_000n);
    assert.strictEqual(S.balance(LAPTOP, OWNER), 0n, "LAPTOP was swapped");
    // every gas entry carries a valid op
    assert.ok(r.state.gasSpends.every((e) => SL.OPS.includes(e.op)), "ops recorded");
    assert.deepStrictEqual([...new Set(r.state.gasSpends.map((e) => e.op))].sort(), ["approve", "collect", "swap", "transfer"]);
    assert.ok(r.state.gasSpends.every((e) => e.kind === "settled"));
    assert.strictEqual(exitCodeOf(r.res), 0);
  }

  // ---- 5. ownerOf changes between collect and delivery: nothing is sent, the leg is held; the original owner restored -> delivered
  {
    const S = wethOnly();
    S.hooks.push((parsed) => { if (kindOf(parsed) === "collect") S.owners[ID_A] = NEW_OWNER; });
    const r1 = await S.run({});
    assert.deepStrictEqual(names(r1.signer), ["collect"], `only the collect; nothing is swapped or sent for a changed owner\n${r1.text}`);
    assert.strictEqual(S.balance(WETH, OP), 2n * E18 / 100n, "the fees sit on the operator, still attributed");
    assert.strictEqual(S.balance(WETH, NEW_OWNER), 0n); assert.strictEqual(S.balance(USDC, NEW_OWNER), 0n);
    const leg = S.ledger().jobs[0].legs[0];
    assert.strictEqual(leg.phase, "held"); assert.ok(/not the owner recorded at collect time/.test(leg.reason));
    assert.strictEqual(exitCodeOf(r1.res), 1, "exit code 1"); assert.strictEqual(r1.res.sweep.problems, 1);
    assert.ok(/HELD WETH of #79371151/.test(r1.text));
    assert.ok(S.notes.length === 1 && /HELD: #79371151 WETH/.test(S.notes[0]), "reported to Telegram");
    // still changed: a second run sends nothing and does not collect again
    S.hooks.length = 0;
    const r2 = await S.run({});
    assert.strictEqual(r2.signer.sent.length, 1, "no new tx"); assert.strictEqual(exitCodeOf(r2.res), 1);
    // restored: the next run delivers (swap + transfer) and does not collect again
    S.owners[ID_A] = OWNER;
    const r3 = await S.run({});
    assert.deepStrictEqual(names(r3.signer), ["collect", "approve", "exactInputSingle", "transfer"], r3.text);
    assert.strictEqual(S.ledger().jobs[0].legs[0].phase, "delivered"); assert.strictEqual(exitCodeOf(r3.res), 0);
    assert.ok(S.balance(USDC, OWNER) > 39_000_000n); assert.strictEqual(S.balance(WETH, OP), 0n);

    // the owner changes after the swap: the USDC proceeds stay on the operator, held, then delivered exactly
    const T = wethOnly();
    T.hooks.push((parsed) => { if (kindOf(parsed) === "exactInputSingle") T.owners[ID_A] = NEW_OWNER; });
    const t1 = await T.run({});
    assert.deepStrictEqual(names(t1.signer), ["collect", "approve", "exactInputSingle"], t1.text);
    const held = T.ledger().jobs[0].legs[0]; assert.strictEqual(held.phase, "held"); assert.strictEqual(held.heldFrom, "swapped");
    const out = BigInt(held.swap.outRaw); assert.ok(out > 0n); assert.strictEqual(T.balance(USDC, OP), out);
    T.hooks.length = 0; T.owners[ID_A] = OWNER;
    const t2 = await T.run({});
    assert.deepStrictEqual(names(t2.signer), ["collect", "approve", "exactInputSingle", "transfer"]);
    assert.strictEqual(T.balance(USDC, OWNER), out, "exactly the swap output");
    // the zero address and the operator are never a recipient
    for (const bad of [ZERO_ADDR, OP]) {
      const Z = wethOnly(); Z.hooks.push((parsed) => { if (kindOf(parsed) === "collect") Z.owners[ID_A] = bad; });
      const z = await Z.run({});
      assert.deepStrictEqual(names(z.signer), ["collect"]); assert.ok(/ownerOf is the (zero address|operator)/.test(z.text));
    }
  }

  // ---- 11 + 14. the swap calldata, and only attributed amounts move while the operator holds more
  {
    const S = mk([{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: 2n * E18 / 100n, a1: 5_000_000n }]);
    S.setBalance(WETH, OP, 5n * E18); S.setBalance(USDC, OP, 123_000_000n); S.setBalance(OTHER, OP, 9n * E18); S.setBalance(CBBTC, OP, 77n);
    S.w.ethBalance = 3n * E18;
    const r = await S.run({});
    const sent = decodeSent(r.signer);
    const swap = sent.find((t) => t.name === "exactInputSingle");
    const p = swap.args[0];
    const attributed = 2n * E18 / 100n;
    assert.strictEqual(p.amountIn, attributed, "amountIn is the attributed leg amount, not the full balance");
    assert.strictEqual(p.recipient, OP); assert.strictEqual(p.tokenIn, WETH); assert.strictEqual(p.tokenOut, USDC); assert.strictEqual(p.fee, 500n);
    assert.strictEqual(p.sqrtPriceLimitX96, 0n);
    const quote = S.quote("WETH", attributed);
    assert.strictEqual(p.amountOutMinimum, (quote * 9950n) / 10000n, "minOut = quote * (10000 - slippageBps) / 10000");
    assert.strictEqual(swap.data, SL.calldata.swap({ tokenIn: WETH, tokenOut: USDC, fee: 500, recipient: OP, amountIn: attributed, amountOutMinimum: p.amountOutMinimum, sqrtPriceLimitX96: 0 }));
    // the transfers: the swap output and the 5 USDC fee only; the pre-existing 123 USDC stays
    const transfers = sent.filter((t) => t.name === "transfer");
    assert.deepStrictEqual(transfers.map((t) => t.args[1]), [quote, 5_000_000n]);
    assert.strictEqual(S.balance(WETH, OP), 5n * E18, "the unrelated WETH is untouched"); assert.strictEqual(S.balance(USDC, OP), 123_000_000n);
    assert.strictEqual(S.balance(OTHER, OP), 9n * E18); assert.strictEqual(S.balance(CBBTC, OP), 77n);
    assert.strictEqual(S.balance(USDC, OWNER), quote + 5_000_000n);
    // native ETH is never sent: no tx has value != 0, none goes to an EOA, and no WETH withdraw exists
    assert.ok(S.w.broadcasts.every((raw) => X.SL && require("ethers").Transaction.from(raw).value === 0n));
    assert.ok(sent.every((t) => t.value === 0n && !["withdraw", "deposit"].includes(t.name)));
    assert.strictEqual(S.w.ethBalance, 3n * E18, "the mocked ETH balance is only ever read");
    // WETH is the ordinary ERC-20 here: approve and the swap input are on the WETH token contract
    assert.strictEqual(lc(sent.find((t) => t.name === "approve").to), lc(WETH));

    // a low native ETH balance: the collect is skipped and nothing moves onto the operator
    const Lo = wethOnly(); Lo.w.ethBalance = 10_000_000_000n;
    const lo = await Lo.run({});
    assert.strictEqual(lo.signer.sent.length, 0); assert.strictEqual(Lo.balance(WETH, OP), 0n); assert.strictEqual(Lo.ledger().jobs.length, 0);
    assert.ok(/sweep preflight: operator ETH .* is below the planned worst case .* \+ reserve 0\.0005; nothing collected, the fees stay in the NFT/.test(lo.text), lo.text);
    assert.strictEqual(lo.res.skipped, 1);
    // exactly at the margin: worst case + reserve is enough
    const Ok = wethOnly(); Ok.w.ethBalance = 10n ** 18n;
    assert.strictEqual((await Ok.run({})).signer.sent.length, 4);
  }

  // ---- 13. approvals: exact, never infinite, leftovers reset, reset after a revert, stale reset at start, zero after every run
  {
    const S = wethOnly();
    // a leftover allowance appears after the collect (found when the swap leg starts)
    S.hooks.push((parsed) => { if (kindOf(parsed) === "collect") S.setAllowance(WETH, OP, SL.ROUTER, 777n); });
    const r = await S.run({});
    const sent = decodeSent(r.signer);
    assert.deepStrictEqual(sent.map((t) => t.name), ["collect", "approve", "approve", "exactInputSingle", "transfer"]);
    assert.strictEqual(sent[1].args[1], 0n, "approve(router, 0) first (leftover found)");
    assert.strictEqual(sent[2].args[1], 2n * E18 / 100n, "then the exact amount");
    assert.ok(sent.filter((t) => t.name === "approve").every((t) => t.args[0] === SL.ROUTER && t.args[1] !== SL.MAX_UINT256));
    assert.strictEqual(S.allowance(WETH, OP, SL.ROUTER), 0n);
    assert.deepStrictEqual(r.state.gasSpends.map((e) => e.op), ["collect", "approve-reset", "approve", "swap", "transfer"]);

    // a reverted swap: approve(router, 0) follows, then the leg retries with a fresh approve and succeeds
    const R = wethOnly();
    R.failNext.push((parsed) => lc(parsed.to) === lc(SL.ROUTER));
    const rr = await R.run({});
    const s2 = decodeSent(rr.signer);
    assert.deepStrictEqual(s2.map((t) => t.name), ["collect", "approve", "exactInputSingle", "approve", "approve", "exactInputSingle", "transfer"], rr.text);
    assert.strictEqual(s2[3].args[1], 0n, "after the reverted swap the allowance is reset"); assert.strictEqual(s2[4].args[1], 2n * E18 / 100n);
    assert.strictEqual(R.allowance(WETH, OP, SL.ROUTER), 0n); assert.strictEqual(R.ledger().jobs[0].legs[0].phase, "delivered");

    // a stale allowance with no active leg is reset at the start of the run, before the collect
    const T = wethOnly();
    T.setAllowance(CBBTC, OP, SL.ROUTER, 5n); T.setAllowance(USDC, OP, SL.ROUTER, 1n);
    const tr = await T.run({});
    const s3 = decodeSent(tr.signer);
    assert.deepStrictEqual(s3.map((t) => t.name).slice(0, 3), ["approve", "approve", "collect"], tr.text);
    assert.deepStrictEqual(s3.slice(0, 2).map((t) => lc(t.to)).sort(), [lc(USDC), lc(CBBTC)].sort());
    assert.ok(s3.slice(0, 2).every((t) => t.args[0] === SL.ROUTER && t.args[1] === 0n));
    for (const tok of [WETH, USDC, CBBTC, LAPTOP]) assert.strictEqual(T.allowance(tok, OP, SL.ROUTER), 0n, "the mocked allowance is 0 after the run");
    // a third party can never be approved: the spender is the router in every approve of every scenario above
    for (const sc of [S, R, T]) assert.ok(sc.txs.filter((t) => lc(t.data).startsWith("0x095ea7b3")).every((t) => lc(t.data).slice(34, 74) === lc(SL.ROUTER).slice(2)));
  }
  console.log("collector-base-sweep-flow tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
