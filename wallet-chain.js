/**
 * wallet-chain.js -- the wallet "switch, then add" flow (EIP-3326 / EIP-3085), pure and
 * usable both in Node (tests) and in the browser (served as /wallet-chain.js, window.WalletChain).
 *
 * walletChainParams(chain) builds the wallet_addEthereumChain parameter from what the server's
 * /api/chain states. It returns null (never a guess) when the native currency is unverified,
 * and it takes the chain id from the server, never from a settlement chain.
 *
 * switchOrAdd(ethereum, chain) calls wallet_switchEthereumChain first; wallet_addEthereumChain
 * only on error code 4902 or an "unrecognized|not added" message. Any other error (4001, user
 * rejected, included) is rethrown and nothing is added.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WalletChain = api;
}(globalThis, function () {
  "use strict";

  function walletChainParams(chain) {
    const c = chain || {};
    const id = Number(c.chainId);
    const nc = c.nativeCurrency;
    if (!Number.isInteger(id) || id <= 0) return null;
    if (!nc || !nc.symbol || !Number.isInteger(nc.decimals)) return null;
    if (!c.rpc || !c.chainName) return null;
    return {
      chainId: "0x" + id.toString(16),
      chainName: String(c.chainName),
      rpcUrls: [String(c.rpc)],
      nativeCurrency: { name: String(nc.name || nc.symbol), symbol: String(nc.symbol), decimals: nc.decimals },
      blockExplorerUrls: c.explorer ? [String(c.explorer)] : [],
    };
  }

  const isUnknownChain = (e) => !!e && (e.code === 4902 || /unrecognized|not added/i.test(String(e.message || "")));

  /** Resolves "switched" or "added"; rejects with the original error (or a clear one) otherwise. */
  async function switchOrAdd(ethereum, chain) {
    const hex = "0x" + Number(chain.chainId).toString(16);
    try {
      await ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      return "switched";
    } catch (e) {
      if (!isUnknownChain(e)) throw e;
      const params = walletChainParams(chain);
      if (!params) throw new Error(`${chain.chainName || "This chain"} is not in your wallet. Add it by hand (chain id ${chain.chainId}, RPC ${chain.rpc}): this page will not guess the chain's native currency.`);
      await ethereum.request({ method: "wallet_addEthereumChain", params: [params] });
      return "added";
    }
  }

  return { walletChainParams, switchOrAdd, isUnknownChain };
}));
