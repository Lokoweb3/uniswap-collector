/**
 * Calldata and checks for the browser-wallet "Claim fees" button, with no dependency.
 * UMD: `require` in tests, the global ClaimFeesCore in the page.
 *
 * collectCalldata encodes collect((uint256 tokenId, address recipient, uint128 amount0Max,
 * uint128 amount1Max)) with both maxima at 2^128-1. The only inputs are the token id and the
 * NFT's on-chain owner, who is the recipient: there is no way to name another recipient or
 * another amount, and extra fields on the argument are ignored.
 */
"use strict";
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.ClaimFeesCore = api;
})(globalThis, function () {
  const COLLECT_SELECTOR = "0xfc6f7865"; // collect((uint256,address,uint128,uint128))
  const OWNER_OF_SELECTOR = "0x6352211e"; // ownerOf(uint256)
  const MAX_UINT256 = (1n << 256n) - 1n;
  const MAX_UINT128 = (1n << 128n) - 1n;
  const BASE_CHAIN_ID = 8453;
  const BASE_CHAIN_HEX = "0x2105";

  // The only managers this button will ever send to (Aerodrome Slipstream on Base). Hard-coded on purpose:
  // a hostile or mistaken server answer cannot widen it.
  const BASE_MANAGERS = ["0x827922686190790b37229fd06084350E74485b72", "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53"];

  const isAddress = (a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
  const sameAddress = (a, b) => isAddress(a) && isAddress(b) && a.toLowerCase() === b.toLowerCase();
  const isAllowedManager = (a) => isAddress(a) && BASE_MANAGERS.some((m) => m.toLowerCase() === a.toLowerCase());
  const isTxHash = (h) => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
  const shortAddr = (a) => (isAddress(a) ? `${a.slice(0, 6)}...${a.slice(-4)}` : "an unknown address");
  const word = (n) => n.toString(16).padStart(64, "0");

  /** A token id as a bigint, or throws: only whole numbers 0..2^256-1 (a bigint, a safe integer, or a digit string). */
  function toTokenId(v) {
    let n;
    if (typeof v === "bigint") n = v;
    else if (typeof v === "number" && Number.isSafeInteger(v)) n = BigInt(v);
    else if (typeof v === "string" && /^\d{1,78}$/.test(v)) n = BigInt(v);
    else throw new Error("tokenId must be a whole number");
    if (n < 0n || n > MAX_UINT256) throw new Error("tokenId out of range");
    return n;
  }

  function collectCalldata(arg) {
    const a = arg || {};
    const tokenId = toTokenId(a.tokenId);
    if (!isAddress(a.owner)) throw new Error("owner must be an address");
    return COLLECT_SELECTOR + word(tokenId) + a.owner.slice(2).toLowerCase().padStart(64, "0") + word(MAX_UINT128) + word(MAX_UINT128);
  }

  function ownerOfCalldata(tokenId) { return OWNER_OF_SELECTOR + word(toTokenId(tokenId)); }

  /** The address in a 32-byte eth_call result, or null. */
  function addressFromWord(hex) {
    if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hex)) return null;
    return "0x" + hex.slice(26);
  }

  /** An explorer base URL that is https with a plain host (and optional path), without trailing slash; else null. */
  function safeExplorer(u) {
    if (typeof u !== "string") return null;
    const m = /^(https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~\-/]*)?)$/.exec(u.trim());
    return m ? m[1].replace(/\/+$/, "") : null;
  }

  return { collectCalldata, ownerOfCalldata, addressFromWord, toTokenId, isAddress, sameAddress, isAllowedManager, BASE_MANAGERS, isTxHash, shortAddr, safeExplorer, COLLECT_SELECTOR, OWNER_OF_SELECTOR, MAX_UINT128, BASE_CHAIN_ID, BASE_CHAIN_HEX };
});
