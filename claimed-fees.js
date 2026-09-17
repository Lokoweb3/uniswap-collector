"use strict";
/**
 * Claimed fees per position, derived from chain, scoped to one (chainId,
 * positionManager, tokenId) triple.
 *
 * Why this exists. The existing claim history has two halves and each has a hole:
 *
 *   history.js scans the *v3* NonfungiblePositionManager for Collect /
 *   DecreaseLiquidity and nets one against the other, which is right — but it
 *   stores only `tokenId`, and collectSummary() matches on `tokenId` alone. Two
 *   chains, or two managers on one chain, mint overlapping ids, so a row from one
 *   can be attributed to a position on the other.
 *
 *   v4 has no Collect event on that manager, so v4 claims were recorded only when
 *   *this collector* performed them (v4-collects.json / v4-owner-collects.json).
 *   A collect the owner made anywhere else — the Uniswap interface, a script, a
 *   phone — left no row, and the card said "nothing claimed yet".
 *
 * What chain actually tells us, for v4. The PoolManager emits
 *
 *   ModifyLiquidity(PoolId indexed id, address indexed sender, int24 tickLower,
 *                   int24 tickUpper, int256 liquidityDelta, bytes32 salt)
 *
 * and the v4 PositionManager sets `salt = bytes32(tokenId)` and is itself the
 * `sender`. So the event carries every part of the scope we need — chain (the RPC
 * we asked), manager (`sender`), position (`salt`) — and `liquidityDelta` is the
 * thing that separates a fee claim from a withdrawal:
 *
 *   liquidityDelta == 0  a pure fee collect. The whole payout is fees.
 *   liquidityDelta <  0  a withdrawal. The payout is principal PLUS the fees that
 *                        had accrued, and only the excess over principal is a fee.
 *                        Principal is computed from |liquidityDelta| against the
 *                        pool's sqrt price at that block, which is exactly the
 *                        formula the pool itself paid out by.
 *   liquidityDelta >  0  a mint or an add. Not a claim; ignored here.
 *
 * Never treat a whole liquidity-removal payout as claimed fees. On #8240's
 * withdrawal the payout was 624.7460 USDC / 22504.28 ARGUS and the fees inside it
 * were 2.7433 USDC / 56.36 ARGUS — 0.4% of it. Booking the payout would have
 * overstated claimed fees by ~228x on that one event.
 */
const { ethers } = require("ethers");
const u = require("./univ3");

const MODIFY_LIQUIDITY = ethers.id("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)");
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const coder = ethers.AbiCoder.defaultAbiCoder();

/**
 * Some chains expose one balance through two interfaces. Arc's USDC is native at
 * 18 decimals via getBalance and an ERC-20 at 6 via balanceOf, and a payout emits
 * a log under BOTH the native pseudo-address and the ERC-20 address for the same
 * money. Counting both doubles it. The ERC-20 leg is the one kept, because it is
 * the one whose decimals match the pool's token metadata.
 */
const NATIVE_PSEUDO = new Set([
  "0xfffffffffffffffffffffffffffffffffffffffe",
  "0xffffffffffffffffffffffffffffffffffffffff",
  "0x0000000000000000000000000000000000000000",
]);

/** Status a card can be in. Only `ok` may render a number. */
const UNAVAILABLE = "unavailable";
const PARTIAL = "partial";
const OK = "ok";

function create({ provider, chainId, positionManager, poolManager, stateView, log = console }) {
  if (!chainId) throw new Error("claimed-fees needs a chainId: an unscoped claim row is worse than none");
  if (!positionManager) throw new Error("claimed-fees needs the position manager it is scoping to");
  const posm = String(positionManager).toLowerCase();
  const pm = poolManager ? String(poolManager).toLowerCase() : null;

  // An object with getSlot0 is used as-is (tests inject one); an address is wired
  // to the real contract.
  const sv = !stateView ? null
    : typeof stateView === "object" && typeof stateView.getSlot0 === "function" ? stateView
    : new ethers.Contract(stateView, ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"], provider);

  /** The scope key every row is filed under. Nothing is looked up by tokenId alone. */
  const scopeKey = (tokenId) => `${chainId}:${posm}:${String(tokenId)}`;

  /**
   * Fold one tx's logs into a claim, given the position's range and token pair.
   * Returns null when the tx holds no claim for this position.
   */
  async function claimFromLogs(logs, { tokenId, owner, token0, token1, tickLower, tickUpper }, blockNumber) {
    const want = String(tokenId);
    const me = String(owner).toLowerCase();
    const t0 = String(token0).toLowerCase(), t1 = String(token1).toLowerCase();

    let mod = null;
    for (const l of logs) {
      if (l.topics[0] !== MODIFY_LIQUIDITY) continue;
      if (pm && l.address.toLowerCase() !== pm) continue;
      // sender is the position manager: a position of a DIFFERENT manager with the
      // same id must not be folded in.
      if (("0x" + l.topics[2].slice(26)).toLowerCase() !== posm) continue;
      const [tl, tu, delta, salt] = coder.decode(["int24", "int24", "int256", "bytes32"], l.data);
      if (BigInt(salt).toString() !== want) continue;
      mod = { poolId: l.topics[1], tickLower: Number(tl), tickUpper: Number(tu), delta };
      break;
    }
    if (!mod || mod.delta > 0n) return null;          // a mint or an add is not a claim

    // Payout: transfers of the pool's two tokens into the owner, native duplicate dropped.
    const paid = { [t0]: 0n, [t1]: 0n };
    for (const l of logs) {
      if (l.topics[0] !== TRANSFER || l.topics.length !== 3) continue;
      const addr = l.address.toLowerCase();
      if (NATIVE_PSEUDO.has(addr)) continue;
      if (addr !== t0 && addr !== t1) continue;
      if (("0x" + l.topics[2].slice(26)).toLowerCase() !== me) continue;
      paid[addr] += BigInt(l.data);
    }

    if (mod.delta === 0n) {
      return { kind: "collect", fee0: paid[t0], fee1: paid[t1], principal0: 0n, principal1: 0n,
               liquidityRemoved: "0", basis: "liquidityDelta 0 — the whole payout is fees" };
    }

    // A withdrawal. Subtract the principal that |delta| was worth at that block.
    if (!sv) {
      return { kind: "decrease", unavailable: "principal cannot be separated without a StateView to read the price at that block" };
    }
    const L = -mod.delta;
    let amount0, amount1;
    try {
      const slot0 = await sv.getSlot0(mod.poolId, blockNumber ? { blockTag: Number(blockNumber) } : {});
      ({ amount0, amount1 } = u.getAmountsForLiquidity(
        BigInt(slot0[0]), u.getSqrtRatioAtTick(tickLower), u.getSqrtRatioAtTick(tickUpper), L));
    } catch (err) {
      return { kind: "decrease", unavailable: `the pool price at that block could not be read (${err.shortMessage || err.message}), so principal cannot be separated from fees` };
    }
    const fee0 = paid[t0] > amount0 ? paid[t0] - amount0 : 0n;
    const fee1 = paid[t1] > amount1 ? paid[t1] - amount1 : 0n;
    return { kind: "decrease", fee0, fee1, principal0: amount0, principal1: amount1,
             liquidityRemoved: L.toString(),
             basis: "payout minus the principal |liquidityDelta| was worth at the pool price of that block" };
  }

  return { scopeKey, claimFromLogs, MODIFY_LIQUIDITY, TRANSFER, NATIVE_PSEUDO, OK, PARTIAL, UNAVAILABLE,
           get chainId() { return chainId; }, get positionManager() { return posm; } };
}

module.exports = { create, MODIFY_LIQUIDITY, TRANSFER, NATIVE_PSEUDO, OK, PARTIAL, UNAVAILABLE };
