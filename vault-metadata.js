"use strict";
/**
 * What a LOKOVault token says about its own chain, checked against the chain it is
 * actually on.
 *
 * Two different things can be wrong, and they need different words.
 *
 * The first TreasuryNFT wrote the chain into tokenURI as a string literal. The vault
 * deployed on Arc therefore describes itself as "Robinhood Chain", chain 4663, in
 * text no setter can reach — while its account is bound to 5042 and answers to its
 * holder. The money was never at risk; only the label is wrong. A page must say so
 * rather than quietly relabelling the token, because anyone opening it in a wallet
 * sees the token's own words, not the dashboard's.
 *
 * The current TreasuryNFT takes the id from block.chainid, which cannot disagree with
 * the chain executing it, so that fault cannot recur. The human name is still chosen
 * once at deployment and is just as permanent, so it can still be wrong — and a
 * mismatch there is worth reporting quietly, not as an alarm: the id is right, the
 * account is right, and it is the two names that differ.
 *
 * Reporting both at once would describe one fault twice: a token that names another
 * chain entirely is already covered by the id.
 */

const norm = (x) => String(x == null ? "" : x).trim().toLowerCase();

/**
 * @param meta       decoded tokenURI JSON (may be null or malformed)
 * @param chainId    the chain this instance is really on
 * @param chainName  what this instance calls that chain
 * @returns {{claimedChain: ?string, claimedChainId: ?string, mislabelled: boolean, misnamed: boolean}}
 */
function chainClaim(meta, chainId, chainName) {
  const attrs = (meta && Array.isArray(meta.attributes)) ? meta.attributes : [];
  const valueOf = (t) => {
    const hit = attrs.find((a) => a && a.trait_type === t);
    return hit && hit.value != null ? String(hit.value) : null;
  };
  const claimedChainId = valueOf("Chain ID");
  const claimedChain = valueOf("Chain");
  // A claim that is not a number is not a claim about an id. Treating it as one
  // would make every such token permanently "on the wrong chain".
  const claimedNum = claimedChainId != null && /^\d+$/.test(claimedChainId.trim())
    ? Number(claimedChainId.trim()) : null;
  const mislabelled = claimedNum != null && Number.isFinite(Number(chainId)) && claimedNum !== Number(chainId);
  // Silent when this instance cannot say what it calls its own chain: disagreeing
  // with nothing is not a disagreement.
  const misnamed = !mislabelled && claimedChain != null && norm(chainName) !== ""
    && norm(claimedChain) !== norm(chainName);
  return { claimedChain, claimedChainId, mislabelled, misnamed };
}

module.exports = { chainClaim };
