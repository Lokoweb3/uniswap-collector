/**
 * rpc.js — the JSON-RPC provider every long-running reader uses, with a retry
 * on throttling. The public RPC answers 429 (and sometimes 403) in bursts; a
 * read that fails on the first answer used to fail outright, and a whole view
 * (watched wallets, treasury, history) carried that failure for its next
 * refresh window. Now a throttled or transiently failed request is retried
 * twice with a short, growing pause before it counts as failed. Throttle hits
 * are counted in provider.rpcStats for the ops view.
 */
"use strict";
const { ethers } = require("ethers");

const RETRY_MS = [400, 1500]; // pause before retry 1 and retry 2
const isTransient = (err) => {
  const m = String((err && (err.shortMessage || err.message)) || err || "");
  return /429|Too Many Requests|403|Forbidden|502|503|504|Bad Gateway|Gateway Time-out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|timeout/i.test(m);
};

class RetryingProvider extends ethers.JsonRpcProvider {
  constructor(url, chainId, options) {
    super(url, chainId, options);
    this.rpcStats = { calls: 0, retries: 0, throttled: 0, failed: 0, lastThrottleAt: null };
  }
  async _send(payload) {
    this.rpcStats.calls++;
    let last = null;
    for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
      try {
        return await super._send(payload);
      } catch (err) {
        last = err;
        if (!isTransient(err) || attempt === RETRY_MS.length) break;
        this.rpcStats.retries++;
        if (/429|Too Many|403|Forbidden/i.test(String(err.shortMessage || err.message))) { this.rpcStats.throttled++; this.rpcStats.lastThrottleAt = Date.now(); }
        await new Promise((r) => setTimeout(r, RETRY_MS[attempt] + Math.floor(Math.random() * 200)));
      }
    }
    this.rpcStats.failed++;
    throw last;
  }
}

/** The provider for `cfg` (rpcUrl, chainId); staticNetwork so the chain id is never re-fetched. */
function createProvider(cfg, options = {}) {
  return new RetryingProvider(cfg.rpcUrl, Number(cfg.chainId) || undefined, { staticNetwork: true, ...options });
}

module.exports = { createProvider, RetryingProvider, isTransient, RETRY_MS };
