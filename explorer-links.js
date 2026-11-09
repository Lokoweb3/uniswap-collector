/**
 * explorer-links.js -- pure explorer URL builders. No I/O.
 *
 * The base keeps whatever path prefix it has (Elysium's is /testnet-explorer): the pieces are
 * joined as strings, never with new URL("/tx/..", base), which would drop the prefix.
 * Anything malformed, or a base that is not https, gives null: never a guessed link.
 *
 * The /tx/ and /address/ segments are the conventional ones; they are NOT confirmed against the
 * Elysium explorer (it answers automated requests with a bot challenge, see VERIFICATION-elysium.md).
 */
"use strict";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

function cleanBase(base) {
  if (typeof base !== "string") return null;
  const b = base.trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(b)) return null;
  return b;
}

function txUrl(base, hash) {
  const b = cleanBase(base);
  return b && typeof hash === "string" && HASH_RE.test(hash) ? `${b}/tx/${hash}` : null;
}

function addressUrl(base, addr) {
  const b = cleanBase(base);
  return b && typeof addr === "string" && ADDR_RE.test(addr) ? `${b}/address/${addr}` : null;
}

module.exports = { txUrl, addressUrl };
