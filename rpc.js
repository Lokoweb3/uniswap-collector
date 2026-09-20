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
// Transport codes only. A revert arrives as CALL_EXCEPTION and must never look
// transient: retrying or failing over on an answer we simply did not like would
// turn a clear "no" into a wandering, slower "no".
const TRANSPORT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "ABORT_ERR", "TIMEOUT",
]);
const isTransient = (err) => {
  if (!err) return false;
  // The useful signal is often on a wrapped cause rather than the outer error:
  // "socket hang up" says little, its code ECONNRESET says everything.
  for (let e = err, hops = 0; e && hops < 4; e = e.cause || e.error, hops++) {
    if (e.code && TRANSPORT_CODES.has(String(e.code))) return true;
  }
  // A JSON-RPC rate limit is throttling by another route: the HTTP exchange
  // succeeded and the refusal is in the body. Failover reads this too, and an
  // endpoint answering -32005 is precisely one worth stepping away from.
  for (let e = err, hops = 0; e && hops < 4; e = e.cause || e.error, hops++) {
    if (e.code === -32005) return true;
  }
  const m = String((err.shortMessage || err.message) || err || "");
  // "missing revert data" is deliberately NOT here: at this layer it is what a
  // genuine revert without a reason string looks like, and a revert must never look
  // transient. The method-level retry above handles the throttled flavour of it,
  // where the call being retried is known to be a read.
  return /429|Too Many Requests|403|Forbidden|502|503|504|Bad Gateway|Gateway Time-out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|timeout|rate limit|could not coalesce/i.test(m);
};

/** Methods that change something. A second attempt could send a second transaction. */
const SENDS = new Set(["eth_sendRawTransaction", "eth_sendTransaction", "eth_signTransaction", "personal_sign", "eth_sign"]);
/** True when a payload -- single or batched -- carries anything that changes state. */
const carriesSend = (payload) => (Array.isArray(payload) ? payload : [payload]).some((p) => p && SENDS.has(p.method));

class RetryingProvider extends ethers.JsonRpcProvider {
  constructor(url, chainId, options) {
    super(url, chainId, options);
    this.rpcStats = { calls: 0, retries: 0, throttled: 0, failed: 0, lastThrottleAt: null };
    // The transport retry below sees only transport failures: a JSON-RPC error
    // response -- a rate limit, say -- is a successful HTTP exchange and is turned
    // into an error further up, after _send has already returned. Arc's throttling
    // arrives that way ({"code":-32005,"message":"rate limit exceeded"}, and empty
    // eth_call data that ethers reports as "missing revert data"), which is why
    // those reached the dashboards as failed panels rather than being retried.
    // withRetry sits at the method level, where that error exists, and refuses to
    // retry anything but a known read.
    require("./rpc-retry").withRetry(this, { attempts: 3, baseMs: 400 });
  }
  async _send(payload) {
    this.rpcStats.calls++;
    let last = null;
    // Never twice for a send. eth_sendRawTransaction may have been broadcast before
    // the socket failed, and the guardian's auto-close signs through this provider:
    // a retry there is a second close, or a second collect.
    const attempts = carriesSend(payload) ? 0 : RETRY_MS.length;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      try {
        return await super._send(payload);
      } catch (err) {
        last = err;
        if (!isTransient(err) || attempt === attempts) break;
        this.rpcStats.retries++;
        if (/429|Too Many|403|Forbidden/i.test(String(err.shortMessage || err.message))) { this.rpcStats.throttled++; this.rpcStats.lastThrottleAt = Date.now(); }
        await new Promise((r) => setTimeout(r, RETRY_MS[attempt] + Math.floor(Math.random() * 200)));
      }
    }
    this.rpcStats.failed++;
    throw last;
  }
}

/**
 * Ask one endpoint what chain it is, without going through a provider (which
 * would recurse back into _send). Returns the chain id, or null if the endpoint
 * did not answer in time or answered nonsense.
 */
async function chainIdOf(url, timeoutMs = 8000) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j && typeof j.result === "string" ? Number(BigInt(j.result)) : null;
  } catch {
    return null;
  }
}

/**
 * A reader that can move to another endpoint when the one it is using stops
 * answering. Chains publish several public RPCs (Arc has four keyless ones);
 * with a single URL any of them going down takes the dashboard's reads with it.
 *
 * What counts as a reason to move: a transport failure or a throttling answer,
 * the same set RetryingProvider already retries on. A revert or any other
 * JSON-RPC error is an ANSWER, not an outage, and never causes a failover --
 * those come back as a normal response body, so they do not reach the catch
 * below at all.
 *
 * Before it will use a fallback it asks that endpoint for its chain id and
 * refuses it unless it matches. A fallback quietly pointing at a different
 * chain would be far worse than an outage: every read would look plausible and
 * be wrong. A rejected endpoint is logged and never tried again.
 *
 * Signing paths deliberately do not use this: failing over mid-transaction is a
 * nonce hazard. The collector keeps its single endpoint.
 */
class FailoverProvider extends RetryingProvider {
  constructor(urls, chainId, options = {}) {
    const { log = (m) => console.log(m), ...rest } = options;
    super(urls[0], chainId, rest);
    this._urls = urls.slice();
    this._active = 0;
    this._rejected = new Set();
    this._log = log;
    this._wantChainId = Number(chainId) || null;
    this.rpcStats.endpoint = urls[0];
    this.rpcStats.failovers = 0;
  }

  /** The connection ethers sends through: the active endpoint, not always the first. */
  _getConnection() {
    const req = super._getConnection();
    if (this._active > 0) req.url = this._urls[this._active];
    return req;
  }

  /** Move to the next endpoint that answers with the right chain id. */
  async _failover(reason) {
    for (let i = this._active + 1; i < this._urls.length; i++) {
      const url = this._urls[i];
      if (this._rejected.has(url)) continue;
      const seen = this._wantChainId == null ? this._wantChainId : await chainIdOf(url);
      if (this._wantChainId != null && seen !== this._wantChainId) {
        this._rejected.add(url);
        this._log(`rpc: refusing ${url} — reports chain ${seen == null ? "no answer" : seen}, expected ${this._wantChainId}`);
        continue;
      }
      const from = this._urls[this._active];
      this._active = i;
      this.rpcStats.failovers++;
      this.rpcStats.endpoint = url;
      this._log(`rpc: ${from} failed (${reason}); failing over to ${url}`);
      return true;
    }
    return false;
  }

  async _send(payload) {
    let last = null;
    for (let hop = 0; hop < this._urls.length; hop++) {
      try {
        return await super._send(payload);
      } catch (err) {
        last = err;
        // An answer we do not like is still an answer: only an outage moves us.
        if (!isTransient(err)) throw err;
        const moved = await this._failover(String(err.shortMessage || err.message).slice(0, 80));
        if (!moved) break;
      }
    }
    throw last;
  }
}

/**
 * The provider for `cfg`; staticNetwork so the chain id is never re-fetched.
 * With `cfg.rpcUrls` (array, in priority order) it can fail over to a later
 * endpoint; with only `cfg.rpcUrl` it behaves exactly as it always has.
 */
function createProvider(cfg, options = {}) {
  const list = Array.isArray(cfg.rpcUrls) ? cfg.rpcUrls.filter(Boolean) : [];
  const urls = list.length ? list : [cfg.rpcUrl];
  const chainId = Number(cfg.chainId) || undefined;
  // Some chains answer a JSON-RPC batch wrongly rather than refusing it. Arc's
  // endpoints return empty data for entries inside a batched eth_call, which
  // surfaces either as "missing revert data" or — worse, because it looks like an
  // answer — as a fee read that reports nothing. `rpcBatch: false` in the chain
  // settings sends one request per call. Omitted, batching stays on and every
  // other chain behaves exactly as before.
  //
  // FailoverProvider keeps one JsonRpcProvider and only swaps the URL in
  // _getConnection(), so this applies to every endpoint in the list, not just
  // the first. test/rpc-batching.test.js holds that.
  const batch = cfg.rpcBatch === false ? { batchMaxCount: 1 } : {};
  const opts = { staticNetwork: true, ...batch, ...options };
  if (urls.length < 2) return new RetryingProvider(urls[0], chainId, opts);
  return new FailoverProvider(urls, chainId, opts);
}

module.exports = { createProvider, RetryingProvider, FailoverProvider, chainIdOf, isTransient, RETRY_MS, SENDS, carriesSend };
