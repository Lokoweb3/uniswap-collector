// node test/collector-base-fees.test.js -- the Base collect pass signs only capped fees: malicious RPC, gas-limit ceiling,
// worst-case caps, the L1 data fee, and what happens to reverted / unconfirmed / failed transactions. Mocked chain only.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { TMP, MGR_A, MGR_B, EVIL, OP, cfgOf, enableMain, scene, fakeSigner, pass } = require("./lib/base-scene"); // sets LP_DATA_DIR first
const L = require("../collector-base-logic");
const cl = require("../collector-logic");
const { ORACLE_ABI, MANAGER_ABI } = require("../collector-base");

const gwei = (n) => ethers.parseUnits(String(n), "gwei");
const ORACLE = "0x420000000000000000000000000000000000000f";
const ownLim = (o) => L.limits(o);
// scene numbers: block base fee 0.03 gwei, tip hint 0.001 gwei -> maxFee 0.061 gwei; estimate 150000 -> gasLimit 187500
// the L1 allowance is max(2 x quote, floor 0.00002 ETH): with a zero (or small) quote it is the floor
const FLOOR = 20_000_000_000_000n;
const GAS_LIMIT = 187_500n, MAX_FEE = 61_000_000n, WORST0 = GAS_LIMIT * MAX_FEE + FLOOR;
const eth = (wei) => ethers.formatEther(wei);
const roomy = { maxGasPerTxEth: 0.01, maxGasPerRunEth: 0.1, dailyGasCapEth: 0.1 };

(async () => {
  // ---- 2. a malicious RPC cannot make us sign more than the caps
  {
    const w = scene({ feeData: { maxFeePerGas: 10n ** 18n, maxPriorityFeePerGas: 10n ** 18n, gasPrice: 10n ** 18n } });
    const r = await pass(w, { cfg: cfgOf(enableMain) });
    assert.strictEqual(r.signer.sent.length, 2, r.text);
    for (const s of r.signer.sent) {
      assert.ok(s.maxFeePerGas <= gwei(1), "maxFeePerGas <= cap");
      assert.ok(s.maxPriorityFeePerGas <= gwei("0.01") && s.maxPriorityFeePerGas <= s.maxFeePerGas);
      assert.strictEqual(s.type, 2);
      assert.strictEqual(s.tx.type, 2);
      assert.ok(!("gasPrice" in s.tx), "no gasPrice key");
      assert.strictEqual(s.maxFeePerGas, 70_000_000n); assert.strictEqual(s.maxPriorityFeePerGas, gwei("0.01"));
      assert.strictEqual(s.gasLimit, GAS_LIMIT);
    }
  }

  // ---- 3. a huge or missing base fee: nothing is sent
  {
    const w = scene(); w.block = { baseFeePerGas: gwei(5) };
    const r = await pass(w, { cfg: cfgOf(enableMain) });
    assert.strictEqual(r.signer.sent.length, 0);
    assert.ok(/exceeds maxGasPriceGwei 1/.test(r.text) && /base fee 5 gwei/.test(r.text) && /cap 1 gwei/.test(r.text), r.text);
    // base + tip over the cap by a hair (tip is clamped to 0.001 here because the hint is 0.001 gwei)
    const w2 = scene(); w2.block = { baseFeePerGas: gwei("0.9995") };
    const r2 = await pass(w2, { cfg: cfgOf(enableMain) });
    assert.strictEqual(r2.signer.sent.length, 0); assert.ok(/exceeds maxGasPriceGwei/.test(r2.text));
    const w2b = scene(); w2b.block = { baseFeePerGas: gwei("0.999") };
    assert.strictEqual((await pass(w2b, { cfg: cfgOf(enableMain, roomy) })).signer.sent.length, 2, "base + tip exactly at the cap still sends");
    for (const bad of [undefined, 0n, 5, "5"]) {
      const wb = scene(); wb.block = { baseFeePerGas: bad };
      const rb = await pass(wb, { cfg: cfgOf(enableMain) });
      assert.strictEqual(rb.signer.sent.length, 0, `base fee ${String(bad)}`); assert.ok(/base fee is unavailable/.test(rb.text));
    }
    const wn = scene(); wn.block = null;
    assert.strictEqual((await pass(wn, { cfg: cfgOf(enableMain) })).signer.sent.length, 0, "no block at all");
  }

  // ---- 4. the gas-limit ceiling
  {
    for (const est of [10n ** 9n, 600_000n]) {
      const w = scene({ gasEstimate: est });
      const r = await pass(w, { cfg: cfgOf(enableMain) });
      assert.strictEqual(r.signer.sent.length, 0); assert.ok(new RegExp(`gas estimate ${est} exceeds maxGasLimit 500000`).test(r.text), r.text);
    }
    const w = scene({ gasEstimate: 300_000n });
    assert.strictEqual((await pass(w, { cfg: cfgOf(enableMain, roomy) })).signer.sent[0].gasLimit, 375_000n);
    const w2 = scene({ gasEstimate: 450_000n });
    assert.strictEqual((await pass(w2, { cfg: cfgOf(enableMain, roomy) })).signer.sent[0].gasLimit, 500_000n, "min(1.25 x estimate, ceiling)");
    const w3 = scene({ gasEstimate: 0n });
    assert.strictEqual((await pass(w3, { cfg: cfgOf(enableMain, roomy) })).signer.sent[0].gasLimit, 500_000n, "the zero-estimate fallback is bounded by the ceiling too");
    const w4 = scene({ gasEstimate: 300_000n });
    const r4 = await pass(w4, { cfg: cfgOf(enableMain, { ...roomy, maxGasLimit: 200000 }) });
    assert.strictEqual(r4.signer.sent.length, 0); assert.ok(/exceeds maxGasLimit 200000/.test(r4.text), "the ceiling is configurable");
  }

  // ---- 5. every cap is checked against the worst case actually signed
  {
    const cap = (wei) => ethers.formatEther(wei); // exact decimal text of a wei amount
    // per tx: just over / exactly at
    const X5 = 5n * 10n ** 13n; // 2 x quote (1e14) is above the floor
    const w = scene(); w.l1Fee = X5;
    const worst = WORST0 - FLOOR + 2n * X5;
    const over = await pass(w, { cfg: cfgOf(enableMain, { maxGasPerTxEth: Number(cap(worst - 1n)) }) });
    assert.strictEqual(over.signer.sent.length, 0); assert.ok(/maxGasPerTxEth/.test(over.text), over.text);
    const w1 = scene(); w1.l1Fee = X5;
    const at = await pass(w1, { cfg: cfgOf(enableMain, { maxGasPerTxEth: Number(cap(worst)) }) });
    assert.strictEqual(at.signer.sent.length, 2, at.text);
    // per run: the second send is blocked because spent + worst case > cap
    const settled = 120_000n * 50_000_000n + FLOOR;
    const w2 = scene();
    const run1 = await pass(w2, { cfg: cfgOf(enableMain, { maxGasPerRunEth: Number(cap(settled + WORST0 - 1n)) }) });
    assert.strictEqual(run1.signer.sent.length, 1); assert.ok(/maxGasPerRunEth/.test(run1.text), run1.text);
    const w3 = scene();
    assert.strictEqual((await pass(w3, { cfg: cfgOf(enableMain, { maxGasPerRunEth: Number(cap(settled + WORST0)) }) })).signer.sent.length, 2);
    // 24 h: the state already holds spend
    const dayCap = ethers.parseUnits("0.001", 18);
    const w4 = scene();
    const d1 = await pass(w4, { cfg: cfgOf(enableMain), state: { gasSpends: [{ t: Date.now() - 3600_000, wei: String(dayCap - WORST0 + 1n) }] } });
    assert.strictEqual(d1.signer.sent.length, 0); assert.ok(/24 h gas cap 0\.001 ETH/.test(d1.text), d1.text);
    const w5 = scene();
    const d2 = await pass(w5, { cfg: cfgOf(enableMain, { maxCollectsPerRun: 1 }), state: { gasSpends: [{ t: Date.now() - 3600_000, wei: String(dayCap - WORST0) }] } });
    assert.strictEqual(d2.signer.sent.length, 1);
    // regression: the old rule (estimate x min(gasPrice, maxFee) x 1.25) fit, the worst case at the signed maxFee does not
    const w6 = scene({ gasEstimate: 300_000n }); w6.block = { baseFeePerGas: gwei("0.9") };
    const old = cl.gasEstimate(300_000n, 50_000_000n);
    assert.ok(old <= ethers.parseUnits("0.0002", 18), "the old estimate would have passed the per-tx cap");
    const r6 = await pass(w6, { cfg: cfgOf(enableMain, { minFeesUsd: 0.01, minFeesToGasRatio: 0.01 }) });
    assert.strictEqual(r6.signer.sent.length, 0); assert.ok(/maxGasPerTxEth 0\.0002 ETH would be exceeded/.test(r6.text), r6.text);
  }

  // ---- 6. assertSignable is the last guard: a bypassed buildFees still cannot get a bad transaction signed
  {
    const w = scene();
    const badFees = () => ({ ok: true, maxFeePerGas: gwei(2), maxPriorityFeePerGas: gwei("0.01"), baseFeeWei: gwei(1), expectedPriceWei: gwei("1.01") });
    const r = await pass(w, { cfg: cfgOf(enableMain, roomy), extra: { buildFees: badFees } });
    assert.strictEqual(r.signer.sent.length, 0); assert.ok(/refusing to sign: maxFeePerGas/.test(r.text), r.text);
    assert.strictEqual(r.state.gasSpends.length, 0, "nothing reserved"); assert.strictEqual(r.saved.length, 0);
    const tipOver = () => ({ ok: true, maxFeePerGas: gwei("0.5"), maxPriorityFeePerGas: gwei("0.6"), baseFeeWei: 1n, expectedPriceWei: gwei("0.5") });
    const r2 = await pass(scene(), { cfg: cfgOf(enableMain, roomy), extra: { buildFees: tipOver } });
    assert.strictEqual(r2.signer.sent.length, 0); assert.ok(/refusing to sign: maxPriorityFeePerGas|priorityFee cannot be more than maxFee/.test(r2.text), r2.text); // ethers itself refuses to serialize it for the L1 quote
  }

  // ---- 7. the L1 data fee: reservation, per-tx cap and settlement carry 2 x quote; the expectation 1 x quote
  {
    const X = 5n * 10n ** 13n;
    const w = scene(); w.l1Fee = X;
    const r = await pass(w, { cfg: cfgOf(enableMain), signer: fakeSigner(w, {}) });
    assert.strictEqual(r.signer.sent.length, 2, r.text);
    const reserved = r.saved.find((s) => s.gasSpends.length === 1).gasSpends[0];
    assert.strictEqual(reserved.kind, "reserved"); assert.strictEqual(reserved.wei, String(WORST0 - FLOOR + 2n * X));
    assert.strictEqual(r.state.gasSpends[0].wei, String(120_000n * 50_000_000n + 2n * X), "settled = gasUsed x price + 2 x L1");
    assert.ok(/worst case 0\.0001114375 ETH/.test(r.text), r.text);
    // expected cost in decide: units x min(maxFee, base + tip) + 1 x L1, in USD at 2000
    const expectedUsd = Number(eth(150_000n * 31_000_000n + X)) * 2000;
    assert.ok(r.lines.some((l) => l.includes(`gas $${expectedUsd.toFixed(4)} -> collect`)), `${expectedUsd.toFixed(4)} in ${r.text}`);
    // the per-tx cap sees 2 x L1: with a cap between worst0 + X and worst0 + 2X
    const w2 = scene(); w2.l1Fee = X;
    const r2 = await pass(w2, { cfg: cfgOf(enableMain, { maxGasPerTxEth: Number(eth(WORST0 - FLOOR + 2n * X - 1n)) }) });
    assert.strictEqual(r2.signer.sent.length, 0); assert.ok(/maxGasPerTxEth/.test(r2.text));
    // only the oracle is asked for the L1 fee
    assert.ok(w.calls.filter((c) => c.name === "getL1Fee").length >= 2);
    assert.ok(w.calls.filter((c) => c.name === "getL1Fee").every((c) => c.to === ORACLE));
    // unreadable / garbage -> skip, fail closed
    for (const bad of [() => { throw new Error("execution reverted"); }, () => "garbage", () => -1n]) {
      const wb = scene(); wb.l1Fee = bad;
      const rb = await pass(wb, { cfg: cfgOf(enableMain) });
      assert.strictEqual(rb.signer.sent.length, 0); assert.ok(/L1 fee unreadable/.test(rb.text), rb.text);
    }
    assert.strictEqual(ORACLE_ABI.length, 1); assert.strictEqual(MANAGER_ABI.length, 3);
  }

  // ---- 8. a collect that reverts on-chain still costs gas, and the run goes on
  {
    const X = 10n ** 12n; // 2 x quote is below the floor: the floor is the allowance
    const w = scene(); w.l1Fee = X;
    const wait = async () => { throw Object.assign(new Error("transaction execution reverted"), { code: "CALL_EXCEPTION", receipt: { gasUsed: 120_000n, gasPrice: 50_000_000n, status: 0 } }); };
    const r = await pass(w, { cfg: cfgOf(enableMain), signer: fakeSigner(w, { wait }) });
    assert.strictEqual(r.signer.sent.length, 2, "the run continues to the next position");
    assert.strictEqual(r.state.gasSpends.length, 2);
    for (const e of r.state.gasSpends) { assert.strictEqual(e.kind, "settled"); assert.strictEqual(e.wei, String(120_000n * 50_000_000n + FLOOR)); }
    assert.ok(r.lines.some((l) => /reverted on-chain/.test(l)), r.text); assert.strictEqual(r.res.collected, 0); assert.ok(!r.res.aborted);
    assert.strictEqual(r.res.spentWei, 2n * (120_000n * 50_000_000n + FLOOR));
    // a receipt price above the signed maxFeePerGas is clamped to it
    const w2 = scene();
    const wait2 = async () => ({ status: 1, gasUsed: 100_000n, gasPrice: 10n ** 18n });
    const r2 = await pass(w2, { cfg: cfgOf(enableMain), signer: fakeSigner(w2, { wait: wait2 }) });
    assert.strictEqual(r2.state.gasSpends[0].wei, String(100_000n * MAX_FEE + FLOOR));
  }

  // ---- 9. revert without a receipt: the receipt is fetched (2nd try), the delay is injected
  {
    const w = scene();
    const receipt = { gasUsed: 100_000n, gasPrice: 40_000_000n, status: 0 };
    w.receipts = (hash, n) => (n >= 2 ? receipt : null);
    const sleeps = [];
    const wait = async () => { throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" }); };
    const r = await pass(w, { cfg: cfgOf(enableMain, { maxCollectsPerRun: 1 }), signer: fakeSigner(w, { wait }), extra: { sleep: async (ms) => { sleeps.push(ms); } } });
    assert.strictEqual(w.receiptCalls.length, 2); assert.strictEqual(sleeps.length, 1);
    assert.strictEqual(r.state.gasSpends[0].kind, "settled"); assert.strictEqual(r.state.gasSpends[0].wei, String(100_000n * 40_000_000n + FLOOR));
    assert.strictEqual(r.state.gasSpends[0].tx, r.signer.sent.length ? r.state.gasSpends[0].tx : null);
  }

  // ---- 10. receipt never found: the worst case stays counted as unknown
  {
    for (const lookup of [() => null, () => new Error("rpc down")]) {
      const w = scene(); w.receipts = lookup;
      const wait = async () => { throw Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION" }); };
      const r = await pass(w, { cfg: cfgOf(enableMain), signer: fakeSigner(w, { wait }) });
      assert.strictEqual(w.receiptCalls.length, 6, "3 tries per transaction");
      assert.strictEqual(r.state.gasSpends.length, 2);
      for (const e of r.state.gasSpends) { assert.strictEqual(e.kind, "unknown"); assert.strictEqual(e.wei, String(WORST0)); }
      assert.strictEqual(cl.gasSpentLast24h(r.state), 2n * WORST0, "counted by the 24 h total");
      assert.ok(r.lines.some((l) => /outcome unknown/.test(l)));
    }
  }

  // ---- 11. a wait that never returns: counted, STOP, nothing more sent
  {
    const w = scene();
    const r = await pass(w, { cfg: cfgOf(enableMain, { waitTimeoutSec: 0.02 }), signer: fakeSigner(w, { wait: () => new Promise(() => {}) }) });
    assert.strictEqual(r.signer.sent.length, 1, "the second qualifying position is not sent");
    assert.strictEqual(r.res.aborted, true); assert.ok(r.lines.some((l) => /^STOP:/.test(l)), r.text);
    assert.strictEqual(r.state.gasSpends.length, 1); assert.strictEqual(r.state.gasSpends[0].kind, "unknown"); assert.strictEqual(r.state.gasSpends[0].wei, String(WORST0));
    // a TIMEOUT error from wait itself behaves the same
    const w2 = scene();
    const r2 = await pass(w2, { cfg: cfgOf(enableMain), signer: fakeSigner(w2, { wait: async () => { throw Object.assign(new Error("timeout"), { code: "TIMEOUT" }); } }) });
    assert.strictEqual(r2.signer.sent.length, 1); assert.strictEqual(r2.res.aborted, true); assert.strictEqual(r2.state.gasSpends[0].kind, "unknown");
    // an unknown error type after a broadcast also stops
    const w3 = scene();
    const r3 = await pass(w3, { cfg: cfgOf(enableMain), signer: fakeSigner(w3, { wait: async () => { throw new Error("boom"); } }) });
    assert.strictEqual(r3.signer.sent.length, 1); assert.strictEqual(r3.res.aborted, true); assert.strictEqual(r3.state.gasSpends[0].kind, "unknown");
  }

  // ---- 12. sendTransaction failures (S2): the transaction may already be signed and broadcast, so ANY error keeps the worst case and stops
  {
    for (const err of [new Error("replacement transaction underpriced"), new Error("insufficient funds for intrinsic transaction cost"), Object.assign(new Error("custom error 0xdeadbeef"), { code: "ACTION_REJECTED" }), "plain string"]) {
      const w = scene();
      const r = await pass(w, { cfg: cfgOf(enableMain), signer: fakeSigner(w, { sendError: err }) });
      assert.strictEqual(r.state.gasSpends.length, 1, "reservation kept"); assert.strictEqual(r.state.gasSpends[0].kind, "unknown"); assert.strictEqual(r.state.gasSpends[0].wei, String(WORST0));
      assert.strictEqual(r.state.gasSpends[0].tx, null);
      assert.strictEqual(r.res.aborted, true); assert.ok(r.lines.some((l) => /^STOP:/.test(l)), r.text);
      assert.strictEqual(r.lines.filter((l) => /^  sending #/.test(l)).length, 1, "the run stopped");
      assert.strictEqual(r.res.spentWei, WORST0, "counted toward the run's spend");
      assert.strictEqual(cl.gasSpentLast24h(r.state), WORST0);
    }
    // it counts toward maxCollectsPerRun / sent: the second position is not tried even with room
    const w1 = scene();
    const r1 = await pass(w1, { cfg: cfgOf(enableMain, roomy), signer: fakeSigner(w1, { failFirst: true }) });
    assert.strictEqual(r1.signer.sent.length, 0); assert.strictEqual(r1.state.gasSpends.length, 1); assert.strictEqual(r1.res.aborted, true);
    const w2 = scene();
    const r2 = await pass(w2, { cfg: cfgOf(enableMain), signer: fakeSigner(w2, { sendError: Object.assign(new Error("request timeout"), { code: "TIMEOUT" }) }) });
    assert.strictEqual(r2.state.gasSpends.length, 1); assert.strictEqual(r2.state.gasSpends[0].kind, "unknown"); assert.strictEqual(r2.state.gasSpends[0].wei, String(WORST0));
    assert.strictEqual(r2.res.aborted, true); assert.strictEqual(r2.lines.filter((l) => /^  sending #/.test(l)).length, 1, "the run stopped");
    // a save that fails before the send: no send at all
    const w3 = scene();
    const r3 = await pass(w3, { cfg: cfgOf(enableMain), extra: { saveState: () => { throw new Error("disk full"); } } });
    assert.strictEqual(r3.signer.sent.length, 0); assert.strictEqual(r3.res.aborted, true); assert.ok(/state\.json could not be saved \(reservation: disk full\)/.test(r3.text), r3.text);
    assert.strictEqual(r3.state.gasSpends.length, 0);
  }

  // ---- 13. crash safety: the worst case is on disk before wait() returns
  {
    const file = path.join(fs.mkdtempSync(path.join(TMP, "crash-")), "state.json");
    fs.writeFileSync(file, L.serializeState({ gasSpends: [] }));
    const w = scene();
    let onDisk = null;
    const wait = async () => { onDisk = JSON.parse(fs.readFileSync(file, "utf8")); return { status: 1, gasUsed: 120_000n, gasPrice: 50_000_000n }; };
    const r = await pass(w, { cfg: cfgOf(enableMain, { maxCollectsPerRun: 1 }), signer: fakeSigner(w, { wait }), extra: { saveState: (s) => L.writeFileAtomic(file, L.serializeState(s)) } });
    assert.strictEqual(r.signer.sent.length, 1);
    assert.strictEqual(onDisk.version, 1); assert.strictEqual(onDisk.gasSpends.length, 1);
    assert.strictEqual(onDisk.gasSpends[0].kind, "reserved"); assert.strictEqual(onDisk.gasSpends[0].wei, String(WORST0)); assert.ok(/^0x[0-9a-f]{64}$/.test(onDisk.gasSpends[0].tx), "hash recorded too");
    const final = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(final.gasSpends[0].kind, "settled"); assert.strictEqual(final.gasSpends[0].wei, String(120_000n * 50_000_000n + FLOOR));
  }

  // ---- S1: a lying receipt can never make the count negative or below what was reserved for it
  {
    for (const gasUsed of [-1n, -(10n ** 30n), 187_501n, 10n ** 12n]) {
      const w = scene();
      const wait = async () => ({ status: 1, gasUsed, gasPrice: 50_000_000n });
      const r = await pass(w, { cfg: cfgOf(enableMain, roomy), signer: fakeSigner(w, { wait }) });
      assert.strictEqual(r.signer.sent.length, 2, r.text);
      for (const e of r.state.gasSpends) { assert.strictEqual(e.kind, "settled"); assert.strictEqual(e.wei, String(WORST0), `gasUsed ${gasUsed} counts the full worst case`); }
      assert.strictEqual(r.res.spentWei, 2n * WORST0);
    }
    for (const gasPrice of [-5n, 10n ** 18n, "junk"]) {
      const w = scene();
      const r = await pass(w, { cfg: cfgOf(enableMain, roomy), signer: fakeSigner(w, { wait: async () => ({ status: 1, gasUsed: 100_000n, gasPrice }) }) });
      assert.strictEqual(r.state.gasSpends[0].wei, String(100_000n * MAX_FEE + FLOOR), `price ${String(gasPrice)}`);
    }
    const w3 = scene();
    const r3 = await pass(w3, { cfg: cfgOf(enableMain), signer: fakeSigner(w3, { wait: async () => ({ status: 1, gasUsed: 0n, gasPrice: 0n }) }) });
    assert.ok(r3.state.gasSpends.every((e) => BigInt(e.wei) >= 0n && BigInt(e.wei) <= WORST0));
  }

  // ---- R1: a receipt that is null or has no gasUsed is an unknown outcome, not a crash
  {
    for (const rc of [null, { status: 1 }, { status: 1, gasUsed: null }]) {
      const w = scene();
      const r = await pass(w, { cfg: cfgOf(enableMain), signer: fakeSigner(w, { wait: async () => rc }) });
      assert.strictEqual(r.signer.sent.length, 1, "the run stops"); assert.strictEqual(r.res.aborted, true);
      assert.strictEqual(r.state.gasSpends[0].kind, "unknown"); assert.strictEqual(r.state.gasSpends[0].wei, String(WORST0));
      assert.ok(r.lines.some((l) => /receipt without gasUsed/.test(l)), r.text); assert.ok(r.lines.some((l) => /^STOP:/.test(l)));
    }
  }

  // ---- S3: an oracle that answers 0 still leaves the floor as the allowance
  {
    const w = scene(); w.l1Fee = 0n;
    const r = await pass(w, { cfg: cfgOf(enableMain) });
    assert.strictEqual(r.saved.find((s) => s.gasSpends.length === 1).gasSpends[0].wei, String(GAS_LIMIT * MAX_FEE + FLOOR));
    const w2 = scene(); w2.l1Fee = 0n;
    const r2 = await pass(w2, { cfg: cfgOf(enableMain, { minL1AllowanceEth: 0.0001 }) });
    assert.strictEqual(r2.saved.find((s) => s.gasSpends.length === 1).gasSpends[0].wei, String(GAS_LIMIT * MAX_FEE + 10n ** 14n), "the floor is configurable");
  }

  // ---- S5: unknown entries keep counting at any age, and are settled from the chain at the start of a run
  {
    const dayCap = ethers.parseUnits("0.001", 18);
    const old = Date.now() - 3 * 86400_000;
    const tx = "0x" + "ab".repeat(32);
    const blocked = await pass(scene(), { cfg: cfgOf(enableMain), state: { gasSpends: [{ t: old, wei: String(dayCap - WORST0 + 1n), kind: "unknown", tx: null }] } });
    assert.strictEqual(blocked.signer.sent.length, 0); assert.ok(/24 h gas cap/.test(blocked.text), blocked.text);
    const aged = await pass(scene(), { cfg: cfgOf(enableMain), state: { gasSpends: [{ t: old, wei: String(dayCap - WORST0 + 1n), kind: "settled", tx: null }] } });
    assert.strictEqual(aged.signer.sent.length, 2, "a settled entry older than 24 h no longer counts");
    // no receipt yet / no hash: stays unknown, nothing is queried without a hash
    const w2 = scene(); w2.receipts = () => null;
    const e2 = { t: old, wei: String(dayCap - WORST0 + 1n), kind: "unknown", tx, gasLimit: "187500", maxFeePerGas: "61000000", l1: String(FLOOR) };
    const r2 = await pass(w2, { cfg: cfgOf(enableMain), state: { gasSpends: [e2] } });
    assert.strictEqual(w2.receiptCalls.length, 1); assert.strictEqual(r2.state.gasSpends[0].kind, "unknown"); assert.strictEqual(r2.signer.sent.length, 0);
    const w3 = scene(); w3.receipts = () => null;
    await pass(w3, { cfg: cfgOf(enableMain), state: { gasSpends: [{ ...e2, tx: null }] } });
    assert.strictEqual(w3.receiptCalls.length, 0, "no hash, no lookup");
    // receipt found: settled (clamped), the budget is free again and the run can send
    const w4 = scene(); w4.receipts = () => ({ status: 1, gasUsed: 100_000n, gasPrice: 50_000_000n });
    const r4 = await pass(w4, { cfg: cfgOf(enableMain), state: { gasSpends: [{ ...e2 }] } });
    assert.strictEqual(r4.state.gasSpends[0].kind, "settled"); assert.strictEqual(r4.state.gasSpends[0].wei, String(100_000n * 50_000_000n + FLOOR));
    assert.strictEqual(r4.signer.sent.length, 2, r4.text); assert.ok(r4.lines.some((l) => /settled from its receipt/.test(l)));
    // a lying receipt settles at the worst case, never below
    for (const gasUsed of [-7n, 10n ** 20n]) {
      const w5 = scene(); w5.receipts = () => ({ status: 1, gasUsed, gasPrice: 50_000_000n });
      const r5 = await pass(w5, { cfg: cfgOf(enableMain, roomy), state: { gasSpends: [{ ...e2, wei: "123456789" }] } });
      assert.strictEqual(r5.state.gasSpends[0].wei, "123456789");
    }
    // simulate never settles or writes
    const w6 = scene(); w6.receipts = () => ({ status: 1, gasUsed: 1n, gasPrice: 1n });
    const r6 = await pass(w6, { cfg: cfgOf(enableMain), mode: "simulate", state: { gasSpends: [{ ...e2 }] } });
    assert.strictEqual(w6.receiptCalls.length, 0); assert.strictEqual(r6.state.gasSpends[0].kind, "unknown");
  }

  // ---- S7 at pass level: fees with tip 0.5 gwei / maxFee 0.9 gwei are valid for ethers; the guard (not serialization) refuses
  {
    const fat = () => ({ ok: true, maxFeePerGas: gwei("0.9"), maxPriorityFeePerGas: gwei("0.5"), baseFeeWei: gwei("0.4"), expectedPriceWei: gwei("0.9") });
    const r = await pass(scene(), { cfg: cfgOf(enableMain, roomy), extra: { buildFees: fat } });
    assert.strictEqual(r.signer.sent.length, 0); assert.ok(/refusing to sign: maxPriorityFeePerGas .* exceeds maxPriorityFeeGwei 0\.01/.test(r.text), r.text);
    assert.strictEqual(r.state.gasSpends.length, 0);
    const zeroTip = () => ({ ok: true, maxFeePerGas: gwei("0.9"), maxPriorityFeePerGas: 0n, baseFeeWei: gwei("0.4"), expectedPriceWei: gwei("0.9") });
    const r2 = await pass(scene(), { cfg: cfgOf(enableMain, roomy), extra: { buildFees: zeroTip } });
    assert.strictEqual(r2.signer.sent.length, 0); assert.ok(/refusing to sign: maxPriorityFeePerGas is not in/.test(r2.text), r2.text);
  }

  // limits are plain numbers the pass can read
  assert.strictEqual(ownLim({}).waitTimeoutSec, 120);
  assert.ok(EVIL && MGR_A && MGR_B && OP);
  console.log("collector-base-fees tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
