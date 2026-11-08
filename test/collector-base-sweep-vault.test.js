// node test/collector-base-sweep-vault.test.js -- acceptance 16, 17, 18: the vault split is written but gated. Unverified means 100% to the
// owner with the failing check named; a verified vault gets floor(out * pct) exactly as treasury.split computes it. Mocked chain.
"use strict";
const assert = require("assert");
const X = require("./lib/sweep-scene");
const treasury = require("../treasury");

const { sweepScene, decodeSent, OWNER, OP, USDC, WETH, LAPTOP, OTHER, E18, SL, VAULT, lc, ID_A, ID_B, MGR_A } = X;
const RH_TBA = "0x4941943B0a3860f07767d8918Cce50D8451b340B";
const wethPos = () => [{ id: ID_A, mgr: MGR_A, t0: WETH, t1: USDC, a0: 2n * E18 / 100n, a1: 0n }];
const mk = (positions = wethPos(), o = {}) => { const S = sweepScene({ positions, ...o }); S.init(); return S; };
const targets = (signer) => decodeSent(signer).flatMap((t) => [lc(t.to), t.name === "transfer" ? lc(t.args[0]) : ""]);
const noVaultTx = (r, tba) => assert.ok(!targets(r.signer).includes(lc(tba)) && !r.signer.sent.some((t) => lc(t.data).includes(lc(tba).slice(2))), "no tx targets the unverified address");

(async () => {
  // ---- 16. shipped config: 0% and no tx to any vault; the Robinhood TBA has no code on Base
  {
    const S = mk();
    const r = await S.run({});
    assert.ok(decodeSent(r.signer).every((t) => t.name !== "transfer" || t.args[0] === OWNER));
    assert.ok(r.signer.sent.every((t) => ![VAULT.tba, VAULT.nft, RH_TBA].some((a) => lc(t.data).includes(lc(a).slice(2)))));
    assert.strictEqual(S.w.calls.filter((c) => [VAULT.reg, VAULT.tba].some((a) => lc(a) === c.to)).length, 0, "no vault read when none is configured");
    const sim = await mk().run({ mode: "simulate" });
    assert.ok(sim.lines.some((l) => /split: 0% vault: vault\.tba not set/.test(l)), sim.text);
    assert.strictEqual(r.res.sweep.report.vault.length, 0, "an unset vault is not an error");
    assert.ok(/vault: 0% \(vault\.tba not set\)/.test(S.notes[0]));

    const R = mk();
    const cfg = R.vault({ cfg: { tba: RH_TBA }, tbaCode: false });
    const rr = await R.run({ sweep: { vault: cfg } });
    assert.ok(decodeSent(rr.signer).filter((t) => t.name === "transfer").every((t) => t.args[0] === OWNER));
    noVaultTx(rr, RH_TBA);
    assert.ok(rr.res.sweep.report.vault.some((m) => m.includes(`tba ${RH_TBA} has no code`)), JSON.stringify(rr.res.sweep.report.vault));
    assert.ok(/VAULT split refused: tba .* has no code; 100% goes to the owner/.test(rr.text));
    assert.ok(R.notes[0].includes("has no code"), "reported to Telegram");
    assert.ok(R.balance(USDC, OWNER) > 39_000_000n);
  }

  // ---- 17. each failure alone refuses the split, names the check, and gives 100% to the owner
  {
    const evil = "0x00000000000000000000000000000000000000ee";
    const cases = [
      ["registry.account differs", { accountResult: evil }, {}, /registry\.account\(\.\.\.\) is 0x0+ee, not tba/i],
      ["tba has no code", { tbaCode: false }, {}, /tba .* has no code/],
      ["token() wrong chainId", { chainId: 1 }, {}, /tba\.token\(\) chainId is 1, not 8453/],
      ["token() wrong NFT", { nftBound: evil }, {}, /tba\.token\(\) nft is 0x0+ee/i],
      ["token() wrong tokenId", { tokenId: 8 }, {}, /tba\.token\(\) tokenId is 8, not 7/],
      ["tba.owner differs", { tbaOwner: evil }, {}, /tba\.owner\(\) is 0x0+ee, not expectedOwner/i],
      ["nft.ownerOf differs", { nftOwner: evil }, {}, /nft\.ownerOf\(7\) is 0x0+ee, not expectedOwner/i],
      ["account() reverts", { revertAccount: true }, {}, /a vault call reverted or failed/],
      ["token() reverts", { revertToken: true }, {}, /a vault call reverted or failed/],
      ["owner() reverts", { revertOwner: true }, {}, /a vault call reverted or failed/],
      ["tba is the operator", {}, { tba: OP }, /tba equals the operator/],
      ["tba is the zero address", {}, { tba: "0x0000000000000000000000000000000000000000" }, /tba equals the zero address/],
      ["tba is the router", {}, { tba: SL.ROUTER }, /tba equals the router/],
      ["tba is a token (USDC)", {}, { tba: USDC }, /tba equals a token/],
      ["tba is a token (WETH)", {}, { tba: WETH }, /tba equals a token/],
      ["tba is a pool", {}, { tba: SL.ROUTES.WETH.pool }, /tba equals a pool/],
      ["no tokenId", {}, { tokenId: null }, /vault\.tokenId is not a non-negative integer/],
      ["no registry", {}, { registry: null }, /vault\.registry is not an address/],
    ];
    for (const [name, v, cfgOver, why] of cases) {
      const S = mk(); S.setBalance(WETH, OP, 0n);
      const cfg = S.vault({ ...v, cfg: cfgOver });
      const r = await S.run({ sweep: { vault: cfg } });
      const reason = r.res.sweep.report.vault.join(" | ");
      assert.ok(why.test(reason), `${name}: ${reason}`);
      const tr = decodeSent(r.signer).filter((t) => t.name === "transfer");
      assert.ok(tr.length >= 1 && tr.every((t) => t.args[0] === OWNER), `${name}: every transfer goes to the owner`);
      const shared = [OP, "0x0000000000000000000000000000000000000000", SL.ROUTER, USDC, WETH, SL.ROUTES.WETH.pool].some((a) => lc(a) === lc(cfg.tba || ""));
      if (shared) assert.ok(tr.every((t) => lc(t.args[0]) !== lc(cfg.tba)), `${name}: no transfer recipient is the address (it is also a legitimate target of other txs)`);
      else noVaultTx(r, cfg.tba || VAULT.tba);
      assert.strictEqual(S.balance(USDC, OWNER) > 39_000_000n, true, name); assert.strictEqual(S.balance(USDC, VAULT.tba), 0n);
      assert.ok(r.text.includes("100% goes to the owner"), name);
      assert.ok(S.notes[0].includes(reason.split(" | ")[0]), `${name}: the reason is in the Telegram summary`);
    }
    // a zero splitPct with a fully valid vault is a 0% split, not an error
    const Z = mk(); const zc = Z.vault({ cfg: { splitPct: 0 } });
    const zr = await Z.run({ sweep: { vault: zc } });
    assert.ok(decodeSent(zr.signer).filter((t) => t.name === "transfer").every((t) => t.args[0] === OWNER) && zr.res.sweep.report.vault.length === 0);
  }

  // ---- 18. a valid vault: floor(out * pct) to the vault, the rest to the owner; clamps; unswapped never split; a failing vault transfer
  {
    // parity with treasury.split
    for (const amt of [0n, 1n, 9n, 99n, 100n, 12_345_678n, 39_940_823n, 10n ** 30n + 7n]) for (const pct of [0, 5, 10, 12.5, 20]) {
      const a = SL.split(amt, pct), b = treasury.split(amt, pct);
      assert.deepStrictEqual([a.toVault, a.toOwner], [b.toVault, b.toOwner], `${amt} @ ${pct}`);
    }
    assert.strictEqual(SL.vaultPct({ splitPct: 50, maxSplitPct: 20 }), 20); assert.strictEqual(SL.vaultPct({ splitPct: 50, maxSplitPct: 90 }), 20, "never above 20");
    assert.strictEqual(SL.vaultPct({ splitPct: -4, maxSplitPct: 20 }), 0); assert.strictEqual(SL.vaultPct({ splitPct: "x", maxSplitPct: 20 }), 0);
    assert.strictEqual(SL.vaultPct({ splitPct: 10, maxSplitPct: 5 }), 5);

    const S = mk(); const cfg = S.vault({});
    const r = await S.run({ sweep: { vault: cfg } });
    const out = BigInt(S.ledger().jobs[0].legs[0].swap.outRaw);
    const tr = decodeSent(r.signer).filter((t) => t.name === "transfer");
    assert.deepStrictEqual(tr.map((t) => [t.args[0], t.args[1]]), [[VAULT.tba, treasury.split(out, 10).toVault], [OWNER, treasury.split(out, 10).toOwner]], "vault share first, then the rest");
    assert.strictEqual(S.balance(USDC, VAULT.tba), (out * 10n) / 100n); assert.strictEqual(S.balance(USDC, OWNER), out - (out * 10n) / 100n);
    assert.strictEqual(S.balance(USDC, OP), 0n); assert.strictEqual(r.res.sweep.report.vault.length, 0);
    assert.ok(r.text.includes(`to the vault ${VAULT.tba}`));

    // splitPct 50 is clamped to 20
    const C = mk(); const cc = C.vault({ cfg: { splitPct: 50 } });
    await C.run({ sweep: { vault: cc } });
    const cout = BigInt(C.ledger().jobs[0].legs[0].swap.outRaw);
    assert.strictEqual(C.balance(USDC, VAULT.tba), treasury.split(cout, 20).toVault);

    // unswapped tokens are never split: a USDC fee leg, a routeless token and a disabled route all go 100% to the owner
    const U = mk([{ id: ID_A, mgr: MGR_A, t0: USDC, t1: OTHER, a0: 9_000_000n, a1: 5n * E18 }, { id: ID_B, mgr: X.MGR_B, t0: LAPTOP, t1: USDC, a0: 100n * E18, a1: 0n }]);
    const uc = U.vault({});
    const ur = await U.run({ sweep: { vault: uc, routes: { LAPTOP: { enabled: false } } } });
    assert.strictEqual(U.balance(USDC, VAULT.tba), 0n, "no USDC fee split"); assert.strictEqual(U.balance(OTHER, VAULT.tba), 0n); assert.strictEqual(U.balance(LAPTOP, VAULT.tba), 0n);
    assert.strictEqual(U.balance(USDC, OWNER), 9_000_000n); assert.strictEqual(U.balance(OTHER, OWNER), 5n * E18); assert.strictEqual(U.balance(LAPTOP, OWNER), 100n * E18);
    assert.ok(decodeSent(ur.signer).every((t) => t.name !== "transfer" || t.args[0] === OWNER));

    // a reverting vault transfer: the owner gets the full remaining amount, the ledger records the failure
    const F = mk(); const fc = F.vault({});
    F.failNext.push((parsed) => parsed.data.toLowerCase().startsWith("0xa9059cbb") && parsed.data.toLowerCase().includes(VAULT.tba.slice(2).toLowerCase()));
    const fr = await F.run({ sweep: { vault: fc } });
    const fout = BigInt(F.ledger().jobs[0].legs[0].swap.outRaw);
    assert.strictEqual(F.balance(USDC, OWNER), fout, "the owner receives everything"); assert.strictEqual(F.balance(USDC, VAULT.tba), 0n);
    const leg = F.ledger().jobs[0].legs[0];
    assert.strictEqual(leg.vault.failed, true); assert.strictEqual(leg.phase, "delivered"); assert.strictEqual(leg.vaultTried, true);
    assert.ok(fr.res.sweep.report.vault.some((m) => /vault transfer failed/.test(m)));
    assert.ok(/VAULT transfer failed \(reverted\); the owner gets the full remaining amount/.test(fr.text));
    assert.strictEqual(F.notes.length, 1); assert.ok(/vault transfer failed/.test(F.notes[0]));
  }
  console.log("collector-base-sweep-vault tests passed");
})().catch((e) => { console.error(e); process.exit(1); });
