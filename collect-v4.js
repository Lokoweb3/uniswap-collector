/**
 * Uniswap v4 fee collection for the collector.
 *
 * v4 has no collect(): fees are paid out by a modifyLiquidities() call whose
 * action list is DECREASE_LIQUIDITY with liquidity 0 followed by TAKE_PAIR to
 * the recipient. The PositionManager only lets the owner, the token's approved
 * address, or an operator (setApprovalForAll) do that, so the owner must run
 * `node approve-operator.js --v4` once before the collector can act.
 *
 * Native ETH is a currency in v4 (address zero): it arrives as ETH, and the
 * caller wraps whatever is above the gas reserve into WETH so the existing
 * swap-and-sweep path handles it like any other collected token.
 */
"use strict";
const { ethers } = require("ethers");
const v4 = require("./univ4");

const ACTION_DECREASE_LIQUIDITY = 0x01;
const ACTION_TAKE_PAIR = 0x11;
const NATIVE = ethers.ZeroAddress;

const POSM_WRITE_ABI = [
  ...v4.POSM_ABI,
  "function modifyLiquidities(bytes unlockData, uint256 deadline) payable",
];

/** Encode the collect: decrease 0 liquidity (pays fees out), then take both currencies. */
function buildCollectUnlockData({ tokenId, key, recipient }) {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const actions = ethers.concat([new Uint8Array([ACTION_DECREASE_LIQUIDITY]), new Uint8Array([ACTION_TAKE_PAIR])]);
  const params = [
    abi.encode(["uint256", "uint256", "uint128", "uint128", "bytes"], [BigInt(tokenId), 0n, 0n, 0n, "0x"]),
    abi.encode(["address", "address", "address"], [key.currency0, key.currency1, recipient]),
  ];
  return abi.encode(["bytes", "bytes[]"], [actions, params]);
}

function create({ provider, cfg, log = console.log }) {
  const V4 = cfg.contracts.v4 || {};
  if (!V4.positionManager || !V4.stateView) return null;
  const posm = new ethers.Contract(V4.positionManager, POSM_WRITE_ABI, provider);
  const stateView = new ethers.Contract(V4.stateView, v4.STATE_VIEW_ABI, provider);

  /**
   * Ids the dashboard has discovered: v4-positions.json for the main owner,
   * v4-positions-<address>.json for a watched wallet (watch.js writes those),
   * plus config extras for the main owner.
   */
  function knownIds(ownerAddress = null) {
    const ids = new Set(ownerAddress ? [] : (cfg.v4Collect && cfg.v4Collect.tokenIds) || []);
    const file = ownerAddress ? `v4-positions-${String(ownerAddress).toLowerCase()}.json` : "v4-positions.json";
    try {
      const j = JSON.parse(require("fs").readFileSync(require("path").join(__dirname, file), "utf8"));
      for (const id of j.ids || []) ids.add(String(id));
    } catch {}
    return [...ids];
  }

  /** Is `operator` allowed to modify the owner's position `tokenId`? */
  async function approved(tokenId, operator) {
    if (await posm.isApprovedForAll(cfg.ownerAddress, operator)) return true;
    try {
      return (await posm.getApproved(tokenId)).toLowerCase() === operator.toLowerCase();
    } catch {
      return false;
    }
  }

  /** Read the position and its accrued fees. Same shape as the v3 simulation where it matters. */
  async function simulate(tokenId) {
    const p = await v4.loadPosition({ provider, posm, stateView, cfg }, tokenId);
    if (p.gone) return null;
    if (p.closed) return { tokenId: String(tokenId), closed: true };
    if (!p.fees.ok) {
      log(`  ! v4 #${tokenId}: fee read failed (${p.fees.error || "unknown"}), skipping`);
      return null;
    }
    const { key } = await posm.getPoolAndPositionInfo(BigInt(tokenId));
    return {
      version: 4,
      tokenId: String(tokenId),
      key: { currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks },
      t0: { address: p.token0.address, symbol: p.token0.symbol, decimals: p.token0.decimals, native: p.token0.address === NATIVE },
      t1: { address: p.token1.address, symbol: p.token1.symbol, decimals: p.token1.decimals, native: p.token1.address === NATIVE },
      amount0: BigInt(p.fees.amount0),
      amount1: BigInt(p.fees.amount1),
      fee: Number(key.fee), // lpFee in hundredths of a bip, like v3
      hooks: p.hooks && p.hooks !== ethers.ZeroAddress ? p.hooks : null,
      closed: false,
    };
  }

  /**
   * Static-call the collect as `from` (owner or approved operator). Proves the
   * calldata without a signature. Returns { ok, error }.
   */
  async function dryRun(sim, recipient, from) {
    const data = buildCollectUnlockData({ tokenId: sim.tokenId, key: sim.key, recipient });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    try {
      await posm.modifyLiquidities.staticCall(data, deadline, { from });
      const gas = await provider.estimateGas({ from, to: posm.target, data: posm.interface.encodeFunctionData("modifyLiquidities", [data, deadline]) }).catch(() => null);
      return { ok: true, gas };
    } catch (err) {
      return { ok: false, error: err.shortMessage || err.message };
    }
  }

  /** Send the collect from the operator wallet. Returns the receipt. */
  async function collect(sim, recipient, wallet) {
    const data = buildCollectUnlockData({ tokenId: sim.tokenId, key: sim.key, recipient });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const tx = await posm.connect(wallet).modifyLiquidities(data, deadline);
    log(`collect v4 #${sim.tokenId} -> ${tx.hash}`);
    const rcpt = await tx.wait();
    return rcpt;
  }

  return { posm, knownIds, approved, simulate, dryRun, collect, buildCollectUnlockData };
}

module.exports = { create, buildCollectUnlockData, ACTION_DECREASE_LIQUIDITY, ACTION_TAKE_PAIR };
