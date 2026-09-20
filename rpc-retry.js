"use strict";
/**
 * rpc-retry.js — retry a throttled read, never a send.
 *
 * Arc's RPC throttles a collector's burst. It does not always say so: one run was
 * refused outright with `{"code":-32005,"message":"rate limit exceeded"}` on the
 * first eth_getBalance and died before signing anything; another kept going but
 * answered eth_call with empty data, which ethers reports as "missing revert data".
 * That run read the sweep target's symbol as "???" and skipped a position holding
 * $44 of fees, with a message that reads exactly like a contract-level refusal.
 *
 * Unattended, that is the bad case: a scheduled pass silently skips a position and
 * reports success. So reads are retried with backoff, and the retries are logged —
 * an endpoint that needs three attempts per call should be visible, not absorbed.
 *
 * SENDS ARE NEVER RETRIED. eth_sendRawTransaction may have reached the node and
 * been broadcast before the response was lost; sending again risks a second
 * transaction on the same nonce, or two collects. A failed send is returned to the
 * caller, which already knows how to stop. Anything not on the read list is treated
 * as a send: an unknown method is not assumed safe.
 */

/** Methods that ask a question and change nothing, so asking twice is free. */
const RETRYABLE = new Set([
  "eth_call", "eth_estimateGas", "eth_getBalance", "eth_getCode", "eth_getStorageAt",
  "eth_getLogs", "eth_getTransactionCount", "eth_getTransactionReceipt", "eth_getTransactionByHash",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_blockNumber", "eth_chainId",
  "eth_gasPrice", "eth_feeHistory", "eth_maxPriorityFeePerGas", "net_version",
]);

/**
 * Transient: the endpoint did not answer the question, for a reason that has nothing
 * to do with the answer.
 *
 * "missing revert data" is on this list and is ambiguous — it is also what a genuine
 * revert without a reason string looks like. Retrying such a call costs one extra
 * read and returns the same refusal, which is a far better trade than treating a
 * throttled empty response as a contract's considered answer.
 */
function isTransient(err) {
  if (!err) return false;
  const code = err.code ?? (err.error && err.error.code);
  if (code === -32005 || code === -32603 || code === 429) return true;
  if (err.status === 429 || err.status === 502 || err.status === 503 || err.status === 504) return true;
  const text = `${err.shortMessage || ""} ${err.message || ""} ${(err.error && err.error.message) || ""}`.toLowerCase();
  if (!text.trim()) return false;
  return /rate limit|too many requests|could not coalesce|missing revert data|timeout|timed out|econnreset|etimedout|econnrefused|socket hang up|fetch failed|service unavailable|bad gateway|server error/.test(text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wrap a provider's `send` so idempotent reads are retried.
 *
 * @param provider  an ethers JsonRpcProvider (mutated in place and returned)
 * @param attempts  total tries per call, including the first
 * @param baseMs    first backoff; doubles each time, with jitter
 * @param log       called once per retry, so a struggling endpoint is visible
 */
function withRetry(provider, { attempts = 4, baseMs = 300, log = null, sleepFn = sleep } = {}) {
  const original = provider.send.bind(provider);
  let retried = 0;
  provider.send = async (method, params) => {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await original(method, params);
      } catch (err) {
        lastErr = err;
        // A send, or anything not known to be a read, is never tried twice.
        if (!RETRYABLE.has(method)) throw err;
        if (!isTransient(err) || i === attempts) throw err;
        retried++;
        // Jitter: several calls throttled at the same moment must not all come
        // back at the same moment and be throttled again together.
        const wait = Math.round(baseMs * 2 ** (i - 1) * (0.5 + Math.random()));
        if (log) log(`rpc: ${method} failed (${err.shortMessage || err.message}); retry ${i}/${attempts - 1} in ${wait} ms`);
        await sleepFn(wait);
      }
    }
    throw lastErr;
  };
  provider.retryStats = () => ({ retried });
  return provider;
}

module.exports = { withRetry, isTransient, RETRYABLE };
