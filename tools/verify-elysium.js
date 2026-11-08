"use strict";
/**
 * tools/verify-elysium.js -- the `elysium-testnet` mode of tools/verify-onchain.js. Read-only:
 * eth_chainId, eth_blockNumber, eth_getBalance, eth_gasPrice, eth_getBlockByNumber, eth_feeHistory,
 * eth_call and eth_estimateGas (the last two through orbit-fees.js). Signs nothing, sends nothing,
 * writes no file, needs no secret.
 *
 *   ELYSIUM_TESTNET_RPC=https://...  (or LP_ELYSIUM_TESTNET_RPC_URL; validated, shown as an origin only)
 *   EXAMPLE=/path/settings.elysium-testnet.example.json
 *
 * Exit code 1 on a chain id mismatch or any FAIL. The mainnet (99901) is disabled and refused
 * before any network call.
 */
const path = require("path");
const { ethers } = require("ethers");
const { validateEndpoint, redactUrl, redactText, registerEndpoint } = require("../endpoint");
const elysium = require("../elysium-chains");
const orbit = require("../orbit-fees");

/** Resolves to the process exit code. */
async function run(mode, { log = console.log } = {}) {
  if (mode === "elysium-mainnet") {
    console.error(elysium.MAINNET_DISABLED_MESSAGE);
    return 1;
  }
  const T = elysium.CHAINS["elysium-testnet"];
  let fails = 0;
  const out = (kind, label, detail = "") => {
    if (kind === "FAIL") fails++;
    log(`${kind.padEnd(4)}  ${label}${detail ? `  ->  ${detail}` : ""}`);
  };
  const envRpc = process.env.ELYSIUM_TESTNET_RPC || process.env.LP_ELYSIUM_TESTNET_RPC_URL || "";
  const rpc = validateEndpoint(envRpc || T.rpcUrl, "ELYSIUM_TESTNET_RPC");
  registerEndpoint(rpc, { env: !!envRpc });
  const example = process.env.EXAMPLE || path.join(__dirname, "..", "settings.elysium-testnet.example.json");
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const rpcCall = (m, p = []) => provider.send(m, p);
  log(`rpc: ${redactUrl(rpc)}   example: ${path.basename(example)}`);
  try {
    const cfg = require("../settings").load({ file: example });
    if (cfg.chainId === T.chainId) out("PASS", `example settings chain id ${cfg.chainId}`); else out("FAIL", `example settings chain id ${cfg.chainId}`, `expected ${T.chainId}`);
    const dec = cfg.nativeCurrency && cfg.nativeCurrency.decimals;
    out("INFO", "native decimals", Number.isInteger(dec) ? `settings state ${dec} (proven only if VERIFICATION-elysium.md says so)` : "18 NOT independently proven; settings omit decimals, balances are shown raw");
    let id;
    try { id = await rpcCall("eth_chainId"); } catch (err) { out("FAIL", "eth_chainId", redactText(err.shortMessage || err.message)); return 1; }
    // The answer comes from a remote endpoint: print it only if it looks like a hex quantity.
    const shownId = /^0x[0-9a-fA-F]{1,16}$/.test(String(id)) ? String(id) : "<not a hex quantity>";
    if (String(id).toLowerCase() === T.chainIdHex) out("PASS", `eth_chainId ${shownId} (${T.chainId})`); else out("FAIL", `eth_chainId ${shownId}`, `expected ${T.chainIdHex}`);
    if (fails) return 1;
    try { out("INFO", "eth_blockNumber", String(BigInt(await rpcCall("eth_blockNumber")))); } catch (err) { out("FAIL", "eth_blockNumber", redactText(err.shortMessage || err.message)); }
    try {
      const f = await orbit.readFees(provider);
      out("INFO", "eth_gasPrice", `${f.gasPrice} wei`);
      out("INFO", "baseFeePerGas (EIP-1559)", f.eip1559 ? `${f.baseFeePerGas} wei, priority fee ${f.maxPriorityFeePerGas}` : "absent: legacy gas price");
    } catch (err) { out("FAIL", "fee read", redactText(err.shortMessage || err.message)); }
    const wallets = [cfg.ownerAddress, ...(cfg.watchWallets || []).map((w) => w.address)].filter(Boolean);
    for (const a of wallets) {
      try { out("PASS", `eth_getBalance ${a}`, `${BigInt(await rpcCall("eth_getBalance", [a, "latest"]))} wei (raw)`); } catch (err) { out("FAIL", `eth_getBalance ${a}`, redactText(err.shortMessage || err.message)); }
    }
    try {
      const probe = wallets[0];
      const g = await orbit.estimateGas(provider, { to: probe, from: probe });
      out("INFO", "NodeInterface 0x...C8 gasEstimateComponents", g.source === "nodeinterface" ? `answers (gas ${g.raw}, L1 part ${g.gasForL1})` : "no answer: eth_estimateGas fallback is used");
    } catch (err) { out("INFO", "gas estimate", redactText(err.shortMessage || err.message)); }
  } catch (err) {
    out("FAIL", "verification", redactText(err.shortMessage || err.message));
  }
  log(fails ? `\n${fails} check(s) FAILED` : "\nall checks passed (read-only)");
  return fails ? 1 : 0;
}

module.exports = { run };
