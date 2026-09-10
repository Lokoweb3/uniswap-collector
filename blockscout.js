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
const EXPLORER = "https://robinhoodchain.blockscout.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const KEY = [process.env.BLOCKSCOUT_API_KEY, process.env.LP_BLOCKSCOUT_KEY].find((k) => k && k.startsWith("proapi_")) || null;
let chainId = null;
try {
  chainId = require("./settings").load().chainId;
} catch {}

const hasKey = () => !!KEY;

/** Base URL for the explorer API ("…/api"), PRO or anonymous. */
function apiBase() {
  return KEY && chainId ? `https://api.blockscout.com/${chainId}/api` : `${EXPLORER}/api`;
}

/** Headers for any Blockscout request. */
function headers(extra = {}) {
  const h = { "User-Agent": UA, Accept: "application/json", ...extra };
  if (KEY) h.Authorization = `Bearer ${KEY}`;
  return h;
}

/**
 * fetch() against a path under the API base: `bsFetch("/v2/addresses/0x…/tokens?type=ERC-20")`
 * or a full URL. Timeout defaults to 20 s.
 */
function bsFetch(pathOrUrl, { timeoutMs = 20000, ...init } = {}) {
  const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : apiBase() + pathOrUrl;
  return fetch(url, { ...init, headers: headers(init.headers), signal: AbortSignal.timeout(timeoutMs) });
}

module.exports = { EXPLORER, UA, apiBase, headers, bsFetch, hasKey };
