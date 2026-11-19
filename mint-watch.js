/**
 * Mint watcher: notices within a minute that one of the wallets did something on chain,
 * so a freshly minted (or closed, or staked) position does not wait for the 10-minute
 * background tick to appear.
 *
 * The signal is the wallet's transaction count (its nonce). It moves on every transaction
 * the wallet sends, whatever the DEX or the position manager, so no protocol needs to be
 * known here: Uniswap v3/v4, a Slipstream fork, a gauge stake in the same minute as the
 * mint (which leaves the wallet's NFT balance unchanged) all show up the same way. All
 * wallets are read at once, which the provider sends as one batched request.
 *
 * What it does not see: a position transferred in by someone else (no transaction from
 * the wallet). The regular tick still picks that up.
 *
 * A change triggers `onChange({ main, watched, wallets })` now and once more on the next
 * tick: a read taken a block after the transaction can still miss it (log-based discovery
 * lags the head by a little), and the second pass is cheap.
 */
function create({ provider, wallets, onChange, log = () => {}, now = () => Date.now() }) {
  const last = new Map(); // lowercased address -> last seen nonce
  let followUp = null;    // a change seen last tick, to be confirmed by one more rescan
  let busy = false;
  let failing = false;    // one log line per outage, one when it clears
  const status = { lastAt: 0, lastChangeAt: 0, lastChanged: [], rescans: 0, error: null };

  async function tick() {
    if (busy) return null;
    busy = true;
    try {
      const list = (wallets() || []).filter((w) => w && w.address);
      let counts;
      try {
        counts = await Promise.all(list.map((w) => provider.getTransactionCount(w.address)));
      } catch (err) {
        status.error = err.shortMessage || err.message;
        if (!failing) { failing = true; log(`cannot read wallet activity: ${status.error}`); }
        return null;
      }
      if (failing) { failing = false; log("reading wallet activity again"); }
      status.error = null;
      status.lastAt = now();

      const changed = [];
      list.forEach((w, i) => {
        const k = w.address.toLowerCase();
        const n = Number(counts[i]);
        // First sight of a wallet is its baseline, not a change.
        if (last.has(k) && last.get(k) !== n) changed.push(w);
        last.set(k, n);
      });

      let job = null;
      if (changed.length) {
        job = { main: changed.some((w) => w.main), watched: changed.some((w) => !w.main), wallets: changed, confirm: false };
        status.lastChangeAt = now();
        status.lastChanged = changed.map((w) => w.label || w.address);
        log(`activity from ${status.lastChanged.join(", ")}; rescanning positions`);
        // Merged with a pending follow-up so neither side is dropped.
        followUp = { main: job.main || !!(followUp && followUp.main), watched: job.watched || !!(followUp && followUp.watched), wallets: changed, confirm: true };
      } else if (followUp) {
        job = followUp;
        followUp = null;
      }
      if (!job) return null;
      status.rescans++;
      try { await onChange(job); }
      catch (err) { log(`rescan failed: ${err.shortMessage || err.message}`); }
      return job;
    } finally {
      busy = false;
    }
  }

  return { tick, status };
}

module.exports = { create };
