"use strict";
/**
 * eth_getLogs across a range no single request may cover.
 *
 * Chains cap the span of one getLogs call, and they disagree about the cap: Arc
 * refuses 10,000 blocks and answers 1,000, and it refuses with "could not coalesce
 * error" rather than anything that names a limit. A single unbounded query on such
 * a chain fails outright, which is how the approvals page came to report "scan
 * failed" and "No operator approvals" for a wallet that had in fact approved.
 *
 * So: walk the range in spans, halve the span when a request is refused, and report
 * how far the walk actually got. A caller that stops early still knows what it
 * covered, because a partial scan presented as a whole one is worse than no scan.
 */

const DEFAULT_SPAN = 50000;   // generous; halved on refusal until the chain accepts
const MIN_SPAN = 100;

/**
 * @param provider    ethers provider
 * @param filter      { address?, topics? } — fromBlock/toBlock come from the range
 * @param from,to     inclusive block range
 * @param span        first span to try (default from settings, else DEFAULT_SPAN)
 * @param maxRequests stop after this many requests and report partial coverage
 * @returns { logs, scannedFrom, complete, requests, span }
 */
async function getLogsRange(provider, filter, { from = 0, to, span = DEFAULT_SPAN, maxRequests = 400, onProgress = null } = {}) {
  if (to == null) to = await provider.getBlockNumber();
  const logs = [];
  let cur = to;                       // newest first: a bounded scan should return the recent past
  let width = Math.max(MIN_SPAN, Math.floor(span));
  let requests = 0;
  while (cur >= from) {
    if (requests >= maxRequests) return { logs, scannedFrom: cur + 1, complete: false, requests, span: width, stopped: "request budget" };
    const lo = Math.max(from, cur - width + 1);
    try {
      const got = await provider.getLogs({ ...filter, fromBlock: lo, toBlock: cur });
      requests++;
      logs.push(...got);
      if (onProgress) onProgress({ from: lo, to: cur, found: got.length });
      cur = lo - 1;
    } catch (err) {
      requests++;
      // Any refusal is treated as "too wide" until the span cannot shrink further;
      // at the floor the error is real and the caller is told where it stopped.
      if (width > MIN_SPAN) { width = Math.max(MIN_SPAN, Math.floor(width / 4)); continue; }
      return { logs, scannedFrom: cur + 1, complete: false, requests, span: width, error: err.shortMessage || err.message };
    }
  }
  return { logs, scannedFrom: from, complete: true, requests, span: width };
}

/** The span to start with on this chain: settings win, else a safe default. */
function spanFor(cfg) {
  const n = cfg && (cfg.maxLogRange ?? (cfg.chain && cfg.chain.maxLogRange));
  return Number.isFinite(Number(n)) && Number(n) > 0 ? Number(n) : DEFAULT_SPAN;
}

module.exports = { getLogsRange, spanFor, DEFAULT_SPAN, MIN_SPAN };
