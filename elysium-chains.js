/**
 * elysium-chains.js -- the Elysium (Arbitrum Orbit chain that settles to HyperEVM) registry.
 * Pure data and one guard; no I/O, no network, nothing read from the environment.
 *
 * The testnet is enabled and read-only. The mainnet is prepared but HARD-DISABLED: its RPC,
 * explorer and native decimals are null until they are verified, and requireEnabled() refuses
 * unless all three are set as well as `enabled`. Flipping `enabled` alone is not enough.
 *
 * settlementChainId (998 / 999) is HyperEVM, the chain Elysium settles to. It is metadata
 * only: never a wallet chain id, a provider chain id or a router key.
 *
 * Native decimals: the docs (V1 in VERIFICATION-elysium.md) state the symbol but no decimals,
 * and no second source proves 18, so `nativeCurrency.decimals` is deliberately absent.
 */
"use strict";

const MAINNET_DISABLED_MESSAGE = "Elysium mainnet (99901) is disabled: awaiting verification of RPC, explorer and native decimals";

const CHAINS = Object.freeze({
  "elysium-testnet": Object.freeze({
    key: "elysium-testnet",
    chainId: 99801,
    chainIdHex: "0x185d9",
    settlementChainId: 998,
    name: "Elysium Testnet",
    testnet: true,
    enabled: true,
    rpcUrl: "https://testnet-rpc.elysium.kinetiq.xyz",
    explorer: "https://elysium.kinetiq.xyz/testnet-explorer",
    nativeCurrency: Object.freeze({ symbol: "HYPE" }), // decimals: NOT independently proven, so absent
    orbit: true,
  }),
  "elysium-mainnet": Object.freeze({
    key: "elysium-mainnet",
    chainId: 99901,
    chainIdHex: "0x1863d",
    settlementChainId: 999,
    name: "Elysium",
    testnet: false,
    enabled: false,
    status: "awaiting verification",
    symbol: "HYPE",
    rpcUrl: null,
    explorer: null,
    nativeDecimals: null,
    orbit: true,
  }),
});

/** Returns the entry when it may be used; throws otherwise. Mainnet needs every field, not just the flag. */
function requireEnabled(entry) {
  const e = entry || {};
  const decimals = e.nativeDecimals !== undefined ? e.nativeDecimals : e.nativeCurrency && e.nativeCurrency.decimals;
  const complete = e.enabled === true && !!e.rpcUrl && !!e.explorer && Number.isInteger(decimals);
  if (e.testnet === true && e.enabled === true && e.rpcUrl && e.explorer) return e; // the testnet is usable without decimals (shown raw, "decimals unverified")
  if (!complete) throw new Error(MAINNET_DISABLED_MESSAGE);
  return e;
}

/** True for a chain id that is the disabled Elysium mainnet. */
const isMainnetId = (id) => Number(id) === CHAINS["elysium-mainnet"].chainId;

const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The persistent TESTNET banner every page of a test-network instance shows. Static markup, no script. */
function bannerHtml(name, chainId) {
  return `<div id="lp-testnet-banner" role="status" style="position:fixed;left:0;right:0;bottom:0;z-index:99998;background:#f59e0b;color:#111827;font:700 12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.4px;text-align:center;padding:4px 8px">TESTNET &middot; ${esc(name)}${chainId ? ` (chain ${esc(chainId)})` : ""} &middot; test tokens have no value &middot; read-only</div>`;
}

/** Inserts the banner before </body> (or appends it). Idempotent. */
function injectBanner(html, name, chainId) {
  const text = String(html);
  if (text.includes('id="lp-testnet-banner"')) return text;
  const tag = bannerHtml(name, chainId);
  return text.includes("</body>") ? text.replace("</body>", `${tag}</body>`) : text + tag;
}

module.exports = { bannerHtml, injectBanner, CHAINS, requireEnabled, isMainnetId, MAINNET_DISABLED_MESSAGE };
