/**
 * orbit-fees.js -- read-only fee helpers for an Arbitrum Orbit chain (Elysium).
 * Takes an ethers-like provider ({ send(method, params) }); never signs, never sends a transaction,
 * opens no connection at import. RPC methods used: eth_gasPrice, eth_getBlockByNumber, eth_feeHistory,
 * eth_call (NodeInterface) and eth_estimateGas.
 *
 * Verified on the Elysium testnet (VERIFICATION-elysium.md V5): the latest block carries baseFeePerGas,
 * eth_feeHistory rewards are 0 (no priority tips), and the NodeInterface at 0x...C8 answers eth_call
 * for gasEstimateComponents even though eth_getCode there returns "0x" (it is a virtual contract,
 * as on Arbitrum One). So code presence is NOT used to decide: the call itself is.
 */
"use strict";
const { ethers } = require("ethers");
const { gasEstimate: withHeadroom } = require("./collector-logic");

const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";
const NI_IFACE = new ethers.Interface(["function gasEstimateComponents(address to,bool contractCreation,bytes data) returns (uint64 gasEstimate,uint64 gasEstimateForL1,uint256 baseFee,uint256 l1BaseFeeEstimate)"]);
const UINT64_MAX = (1n << 64n) - 1n;

/** A hex quantity string ("0x..") to bigint, or throw a clear error (never NaN). */
function hexToBig(v, what) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`${what}: not a hex quantity`);
  return BigInt(v);
}

/** { gasPrice, baseFeePerGas|null, eip1559, maxFeePerGas|null, maxPriorityFeePerGas|null } */
async function readFees(provider) {
  const gasPrice = hexToBig(await provider.send("eth_gasPrice", []), "eth_gasPrice");
  const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
  const baseFeePerGas = block && block.baseFeePerGas != null ? hexToBig(block.baseFeePerGas, "baseFeePerGas") : null;
  if (baseFeePerGas === null) return { gasPrice, baseFeePerGas: null, eip1559: false, maxFeePerGas: null, maxPriorityFeePerGas: null };
  // The priority fee is normally 0 on Orbit; use what eth_feeHistory reports (median of the 50th percentile
  // rewards) only when it is available and non-zero.
  let tip = 0n;
  try {
    const h = await provider.send("eth_feeHistory", [4, "latest", [50]]);
    const rewards = (h && Array.isArray(h.reward) ? h.reward : []).map((r) => Array.isArray(r) && r[0] != null ? hexToBig(r[0], "reward") : 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (rewards.length) tip = rewards[Math.floor(rewards.length / 2)];
  } catch { /* feeHistory unavailable or malformed: priority fee stays 0 */ }
  // Headroom of 2x the base fee covers base-fee growth between estimate and inclusion.
  return { gasPrice, baseFeePerGas, eip1559: true, maxFeePerGas: baseFeePerGas * 2n + tip, maxPriorityFeePerGas: tip };
}

/**
 * Gas for a transaction, with collector-logic headroom applied to the total.
 * NodeInterface.gasEstimateComponents first (eth_call only); its gasEstimate already includes the L1
 * component (gasForL1 is reported separately). Any revert, empty answer or error falls back to eth_estimateGas.
 * Returns { gas, gasForL1, source, raw } where gas is the total WITH headroom and raw is without.
 */
async function estimateGas(provider, { to, data = "0x", from, value } = {}, { headroomPct = 25 } = {}) {
  if (!ethers.isAddress(to)) throw new Error("estimateGas: `to` is not an address");
  const tx = { to, data };
  if (from) tx.from = from;
  if (value != null) tx.value = "0x" + BigInt(value).toString(16); // JSON-RPC quantity: no leading zeros
  let total = null, gasForL1 = null, source = null;
  try {
    const callData = NI_IFACE.encodeFunctionData("gasEstimateComponents", [to, false, data]);
    const ret = await provider.send("eth_call", [{ to: NODE_INTERFACE, data: callData, ...(from ? { from } : {}), ...(tx.value ? { value: tx.value } : {}) }, "latest"]);
    // The first two words are uint64: a word above that range is an overflow, not a gas figure (ethers would truncate it).
    const word = (i) => BigInt("0x" + ret.slice(2 + i * 64, 2 + (i + 1) * 64));
    if (typeof ret === "string" && /^0x[0-9a-fA-F]{256}$/.test(ret) && word(0) <= UINT64_MAX && word(1) <= UINT64_MAX) {
      const r = NI_IFACE.decodeFunctionResult("gasEstimateComponents", ret);
      if (r[0] > 0n && r[0] <= UINT64_MAX) { total = r[0]; gasForL1 = r[1]; source = "nodeinterface"; }
    }
  } catch { /* not available here: fall back */ }
  if (total === null) {
    total = hexToBig(await provider.send("eth_estimateGas", [tx]), "eth_estimateGas");
    gasForL1 = null; source = "eth_estimateGas";
  }
  return { gas: withHeadroom(total, 1n, headroomPct), gasForL1, source, raw: total };
}

module.exports = { readFees, estimateGas, NODE_INTERFACE, hexToBig };
