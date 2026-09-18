// node test/claimed-fees.test.js — claimed fees are scoped, and principal is never
// booked as a fee. Every fixture below is the shape of a real Arc transaction.
"use strict";
const assert = require("assert");
const { ethers } = require("ethers");
const cf = require("../claimed-fees");
const u = require("../univ3");

const POSM = "0x6049c9a0e26405c0985f9e3685c87d0ae917f82b";
const OTHER_POSM = "0x1111111111111111111111111111111111111111";
const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const USDC = "0x3600000000000000000000000000000000000000";
const ARGUS = "0xece5ca8bf9220718e5727754026757512212cb3c";
const NATIVE = "0xfffffffffffffffffffffffffffffffffffffffe";
const OWNER = "0xb1cdc09b4c7f28365a8e7bfa2332af54f5462af5";
const POOL_ID = "0x" + "ab".repeat(32);

const coder = ethers.AbiCoder.defaultAbiCoder();
const pad = (a) => ethers.zeroPadValue(a, 32);
const modLog = (delta, tokenId, { sender = POSM, address = PM, lo = -887200, hi = 887200 } = {}) => ({
  address, topics: [cf.MODIFY_LIQUIDITY, POOL_ID, pad(sender)],
  data: coder.encode(["int24", "int24", "int256", "bytes32"],
                     [lo, hi, delta, ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32)]),
});
const xfer = (token, to, value) => ({
  address: token, topics: [cf.TRANSFER, pad(OWNER), pad(to)], data: ethers.zeroPadValue(ethers.toBeHex(value), 32),
});
const POS = { tokenId: "8240", owner: OWNER, token0: USDC, token1: ARGUS, tickLower: -887200, tickUpper: 887200 };

const stateViewAt = (sqrtPriceX96) => ({ getSlot0: async () => [sqrtPriceX96, 0, 0, 0] });
const make = (over = {}) => cf.create({ provider: {}, chainId: 5042, positionManager: POSM,
  poolManager: PM, stateView: null, log: { log() {}, error() {} }, ...over });

async function main() {
  // ---- 1. scope: chain + manager + token id, never the id alone --------------
  {
    const c = make();
    assert.strictEqual(c.scopeKey("8240"), `5042:${POSM}:8240`);
    const other = make({ chainId: 4663 });
    assert.notStrictEqual(other.scopeKey("8240"), c.scopeKey("8240"),
      "the same id on another chain is a different position and must key differently");
    assert.throws(() => cf.create({ provider: {}, positionManager: POSM }), /chainId/,
      "refusing to build unscoped rows at all is the point");
    assert.throws(() => cf.create({ provider: {}, chainId: 5042 }), /position manager/);
  }

  // ---- 2. a pure fee collect: the whole payout is fees -----------------------
  {
    const c = make();
    const logs = [modLog(0n, "8240"), xfer(USDC, OWNER, 42499934n), xfer(ARGUS, OWNER, 1266966450000000000000n)];
    const r = await c.claimFromLogs(logs, POS, 21130122);
    assert.strictEqual(r.kind, "collect");
    assert.strictEqual(r.fee0, 42499934n, "42.499934 USDC, exactly the payout");
    assert.strictEqual(r.fee1, 1266966450000000000000n);
    assert.strictEqual(r.principal0, 0n, "a zero-delta collect moves no principal");
  }

  // ---- 3. Arc's dual-interface USDC is one balance, not two -----------------
  // The same payout emits a log under the native pseudo-address AND the ERC-20
  // address. Counting both doubles the USDC leg of every claim on that chain.
  {
    const c = make();
    const logs = [modLog(0n, "8240"),
                  xfer(NATIVE, OWNER, 42499934n),
                  xfer(USDC, OWNER, 42499934n),
                  xfer(ARGUS, OWNER, 1266966450000000000000n)];
    const r = await c.claimFromLogs(logs, POS, 21130122);
    assert.strictEqual(r.fee0, 42499934n, `the native duplicate must not be added: got ${r.fee0}`);
  }

  // ---- 4. a withdrawal is not a claim of its whole payout -------------------
  // #8240's real decrease, tx 0xd122153b…: 3,736,665,557,929,942 of liquidity out.
  {
    const L = 3736665557929942n;
    const sqrtP = u.getSqrtRatioAtTick(0);
    const { amount0, amount1 } = u.getAmountsForLiquidity(
      sqrtP, u.getSqrtRatioAtTick(-887200), u.getSqrtRatioAtTick(887200), L);
    const payout0 = amount0 + 2743337n;                 // + 2.743337 USDC of fees
    const payout1 = amount1 + 56358300000000000000n;    // + 56.3583 ARGUS
    const c = make({ stateView: stateViewAt(sqrtP) });
    const r = await c.claimFromLogs(
      [modLog(-L, "8240"), xfer(USDC, OWNER, payout0), xfer(ARGUS, OWNER, payout1)], POS, 21203450);
    assert.strictEqual(r.kind, "decrease");
    assert.strictEqual(r.fee0, 2743337n, `only the excess is a fee, got ${r.fee0}`);
    assert.strictEqual(r.fee1, 56358300000000000000n);
    assert.strictEqual(r.principal0, amount0, "and the principal is reported, not discarded");
    assert.ok(r.fee0 * 200n < payout0,
      "the fee is a small fraction of the payout — booking the payout would overstate it ~228x");
  }

  // ---- 5. another manager's position with the same id is not folded in ------
  {
    const c = make();
    const logs = [modLog(0n, "8240", { sender: OTHER_POSM }), xfer(USDC, OWNER, 999000000n)];
    assert.strictEqual(await c.claimFromLogs(logs, POS, 1), null,
      "id 8240 on a different position manager is a different position");
  }

  // ---- 6. a mint or an add is never a claim --------------------------------
  {
    const c = make();
    assert.strictEqual(await c.claimFromLogs([modLog(644727072015785n, "8240")], POS, 1), null);
  }

  // ---- 7. an unreadable historical price withholds, it does not guess -------
  {
    const c = make({ stateView: null });
    const r = await c.claimFromLogs([modLog(-1000n, "8240"), xfer(USDC, OWNER, 5n)], POS, 1);
    assert.match(r.unavailable, /principal cannot be separated/,
      "with no way to price the principal the claim is withheld, never booked as all-fees");
    assert.strictEqual(r.fee0, undefined, "and no number is produced");
  }

  // ---- 8. a read that throws also withholds --------------------------------
  {
    const c = make({ stateView: { getSlot0: async () => { throw new Error("no archive state"); } } });
    const r = await c.claimFromLogs([modLog(-1000n, "8240"), xfer(USDC, OWNER, 5n)], POS, 1);
    assert.match(r.unavailable, /could not be read/);
    assert.strictEqual(r.fee0, undefined);
  }

  console.log("claimed fees: scoped by chain and manager, principal never booked as a fee, dual-interface counted once");
}
main().catch((e) => { console.error(e); process.exit(1); });
