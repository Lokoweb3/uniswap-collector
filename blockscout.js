/**
 * One Blockscout client for every module.
 *
 * With a PRO key (BLOCKSCOUT_API_KEY, or the older LP_BLOCKSCOUT_KEY; free at
 * https://dev.blockscout.com, values start with "proapi_") requests go to
 * api.blockscout.com/<chainId>/... with Bearer auth: 5 requests per second
 * instead of the anonymous explorer's ~10 per 15 minutes. Without one the
 * anonymous explorer API is used unchanged. The key is read from the
 * environment only and never logged.
 */
"use strict";
// The explorer comes from settings, not from a chain baked in here: a second
// chain has a different one, and Arc has none the public can reach.
let EXPLORER = "";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const KEY = [process.env.BLOCKSCOUT_API_KEY, process.env.LP_BLOCKSCOUT_KEY].find((k) => k && k.startsWith("proapi_")) || null;
let chainId = null;
try {
  const c = require("./settings").load();
  chainId = c.chainId;
  EXPLORER = c.blockscout || "";
} catch {}

const hasKey = () => !!KEY;

// Chains whose public Blockscout API answers JSON without a key and is not served by the PRO
// gateway (PulseChain: api.scan.pulsechain.com; the scan.pulsechain.com frontend host answers an
// HTML 404). For these the PRO key is never used or sent, and the host is allow-listed for full URLs.
const KEYLESS_HOSTS = { 369: "api.scan.pulsechain.com" };
const keyless = () => Object.prototype.hasOwnProperty.call(KEYLESS_HOSTS, chainId);
const useKey = () => !!KEY && !keyless();

/**
 * Whether a Blockscout API covers this chain at all. A PRO key changes how we
 * reach it, not whether it exists, so this asks only whether one is configured
 * (settings chain.blockscout, defaulting to the explorer). Arc has a good public
 * explorer but no Blockscout, so it sets "" and callers must say "not available
 * on this chain" rather than report an empty or failed answer, which would read
 * as a discrepancy in the ledgers.
 */
const available = () => !!EXPLORER;

/** The PRO gateway; the only host besides the configured explorer that a full URL may name. */
const PRO_HOST = "api.blockscout.com";

/** Hosts a request (and so the bearer key) may go to: the PRO gateway and this chain's configured explorer. */
function allowedHosts() {
  const hosts = new Set([PRO_HOST]);
  if (keyless()) hosts.add(KEYLESS_HOSTS[chainId]);
  try { if (EXPLORER) hosts.add(new URL(EXPLORER).host.toLowerCase()); } catch { /* no explorer */ }
  return hosts;
}

/** Base URL for the explorer API ("…/api"), PRO or anonymous. */
function apiBase() {
  return useKey() && chainId ? `https://${PRO_HOST}/${chainId}/api` : `${EXPLORER}/api`;
}

/** Headers for any Blockscout request. */
function headers(extra = {}) {
  const h = { "User-Agent": UA, Accept: "application/json", ...extra };
  if (useKey()) h.Authorization = `Bearer ${KEY}`;
  return h;
}

/**
 * fetch() against a path under the API base: `bsFetch("/v2/addresses/0x…/tokens?type=ERC-20")`
 * or a full URL. Timeout defaults to 20 s.
 *
 * A full URL is accepted only for an allow-listed host (api.blockscout.com and the
 * configured explorer), and the PRO key is sent only to those: a URL assembled from
 * data the chain or an API returned must not be able to carry the key to a stranger.
 * The check is on the parsed URL, so credentials, "@" tricks and look-alike hosts
 * do not pass. Redirects are not followed with the key attached.
 */
function bsFetch(pathOrUrl, { timeoutMs = 20000, ...init } = {}) {
  let url = pathOrUrl;
  if (/^[a-z][a-z0-9+.-]*:/i.test(String(pathOrUrl))) {
    let u;
    try { u = new URL(pathOrUrl); } catch { throw new Error("blockscout: not a valid URL"); }
    if (u.protocol !== "https:" || u.username || u.password || !allowedHosts().has(u.host.toLowerCase())) {
      throw new Error(`blockscout: ${u.host || "that host"} is not an allowed Blockscout host`);
    }
    url = u.toString();
  } else {
    url = apiBase() + pathOrUrl;
  }
  return fetch(url, { ...init, ...(useKey() ? { redirect: "manual" } : {}), headers: headers(init.headers), signal: AbortSignal.timeout(timeoutMs) });
}

module.exports = { EXPLORER, UA, apiBase, headers, bsFetch, hasKey, available, allowedHosts };
