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
function bannerHtml(name, chainId, unverified = false) {
  return `<div id="lp-testnet-banner" role="status" style="position:fixed;left:0;right:0;bottom:0;z-index:99998;background:#f59e0b;color:#111827;font:700 12px/1.3 system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.4px;text-align:center;padding:4px 8px">TESTNET &middot; ${esc(name)}${chainId ? ` (chain ${esc(chainId)})` : ""} &middot; test tokens have no value &middot; read-only${unverified ? " &middot; RPC chain id NOT VERIFIED" : ""}</div>`;
}

/** Inserts the banner before </body> (or appends it). Idempotent. */
function injectBanner(html, name, chainId, unverified = false) {
  const text = String(html);
  if (text.includes('id="lp-testnet-banner"')) return text;
  const tag = bannerHtml(name, chainId, unverified);
  // A function replacer: a string replacement would expand "$&" / "$`" patterns found in the tag (the chain name).
  return text.includes("</body>") ? text.replace("</body>", () => tag + "</body>") : text + tag;
}

/** Chain ids that never get transaction data or a keystore, whatever settings say. */
const NO_TX_CHAIN_IDS = new Set([99801]);

/**
 * Whether an instance serves no transaction data. A testnet, or chain 99801, is ALWAYS no-tx: an explicit
 * "noTransactionData": false in its settings is refused (throws), not honoured. Other chains keep the
 * explicit setting, else `strictChains` (settings.STRICT_CHAINS).
 */
function resolveNoTx(cfg, strictChains) {
  const forced = cfg.testnet === true || NO_TX_CHAIN_IDS.has(Number(cfg.chainId));
  if (forced && cfg.noTransactionData === false) {
    throw new Error("noTransactionData: false is not allowed on a testnet or chain 99801: it never serves transaction data or reads a keystore");
  }
  if (forced) return true;
  return typeof cfg.noTransactionData === "boolean" ? cfg.noTransactionData : strictChains.has(Number(cfg.chainId));
}

/**
 * A testnet instance must be talking to the chain it says it is. `chainIdOf(url)` resolves to a number or null
 * (unreachable). A different id throws; an unreachable RPC does not (the caller flags the instance as unverified
 * and re-checks, see watchRpcChain). The fallback endpoints (cfg.rpcUrls) are held to the same rule: one that
 * ANSWERS with another chain id refuses the start (it is not silently dropped from failover); one that does not
 * answer cannot be judged, and the failover provider checks the id again before it ever uses it.
 * Returns the primary's id (or null).
 */
async function assertRpcChain(cfg, chainIdOf) {
  if (cfg.testnet !== true) return null;
  const want = Number(cfg.chainId);
  const seen = await chainIdOf(cfg.rpcUrl);
  if (seen != null && seen !== want) {
    throw new Error(`the primary RPC answers chain id ${seen}, settings say ${want}`);
  }
  const fallbacks = (Array.isArray(cfg.rpcUrls) ? cfg.rpcUrls : []).filter((u) => u && u !== cfg.rpcUrl);
  for (let i = 0; i < fallbacks.length; i++) {
    const other = await chainIdOf(fallbacks[i]);
    // By position only: a fallback URL may carry a provider key and must not reach a log line.
    if (other != null && other !== want) throw new Error(`fallback RPC #${i + 1} answers chain id ${other}, settings say ${want}`);
  }
  return seen;
}

/**
 * Re-asks the primary RPC on a timer until it answers (for an instance that started with it unreachable).
 * A matching id calls onVerified(); another id calls onMismatch(error). Either way the timer stops.
 * The timer is unref'd, so it never keeps the process alive. Returns the timer.
 */
function watchRpcChain(cfg, chainIdOf, { intervalMs = 30000, onVerified, onMismatch } = {}) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const seen = await chainIdOf(cfg.rpcUrl);
      if (seen == null) return;
      clearInterval(timer);
      if (seen !== Number(cfg.chainId)) onMismatch && onMismatch(new Error(`the primary RPC answers chain id ${seen}, settings say ${Number(cfg.chainId)}`));
      else onVerified && onVerified();
    } catch { /* ask again next tick */ } finally { busy = false; }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { resolveNoTx, assertRpcChain, watchRpcChain, NO_TX_CHAIN_IDS, bannerHtml, injectBanner, CHAINS, requireEnabled, isMainnetId, MAINNET_DISABLED_MESSAGE };
