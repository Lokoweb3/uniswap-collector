"use strict";
/**
 * The background claim scan: walks every tracked position's history back to its
 * mint (or the lookback floor) one chunk at a time, for as long as the process
 * runs. On Robinhood a 30-day window is ~2,900 chunks, which no amount of panel
 * clicking would ever cover.
 *
 * Priority. The dashboard's requests come first:
 *   - one chunk per step, then a pause (`pauseMs`) that hands the event loop and
 *     the RPC back to whatever else is running;
 *   - before each step it waits while `busy()` says requests are in flight, up to
 *     `maxWaitMs`, so a long-lived request cannot stall the scan forever;
 *   - failures back off exponentially up to `maxBackoffMs`, so a throttling RPC is
 *     not hammered and request reads keep their share;
 *   - once every position is covered it idles, and only extends forward to the
 *     head every `forwardEveryMs`.
 *
 * Exclusivity. The loop and the /api/claims request path share one store, so
 * they share one lock: `tryExclusive(fn)` runs `fn` only when nothing else is
 * scanning and returns `{ ran: false }` otherwise — the request answers from the
 * current state instead of waiting.
 *
 * Persistence is the store's: every chunk is saved (atomically) before the next
 * one starts, so a restart continues from the last folded chunk.
 */

function create({
  store, meta, ids, busy = () => false, onFolded = async () => {}, log = console,
  chunk = 9000, lookbackMs = 30 * 86400 * 1000,
  pauseMs = 500, idleMs = 30000, forwardEveryMs = 30000, maxWaitMs = 2000, maxBackoffMs = 5 * 60 * 1000,
  sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }),
  now = () => Date.now(),
}) {
  let locked = false, running = false, stopped = false, wake = null;
  let lastForward = 0, failures = 0, lastReport = 0, lag = 0;
  const st = { tracked: 0, startedAt: null, steps: 0, chunks: 0, folded: 0, lastAt: null, lastError: null, lastErrorAt: null, pending: null, idle: false };

  async function tryExclusive(fn) {
    if (locked) return { ran: false };
    locked = true;
    try { return { ran: true, value: await fn() }; } finally { locked = false; }
  }

  // A pause that stop() can cut short.
  function nap(ms) {
    return new Promise((resolve) => { wake = resolve; sleep(ms).then(resolve); }).finally(() => { wake = null; });
  }

  async function step() {
    const list = ids();
    st.tracked = list.length;
    if (!list.length) { st.idle = true; st.pending = 0; return { chunks: 0, empty: true }; }
    // Forward on a timer, and continuously while more than a chunk behind the head
    // (after downtime), so catching up does not take one chunk per timer tick.
    const forward = lag > chunk || now() - lastForward >= forwardEveryMs;
    const out = await tryExclusive(() => store.scan(meta, { ids: list, chunk, budget: forward ? 2 : 1, lookbackMs, forward }));
    if (!out.ran) return { chunks: 0, contended: true };
    const r = out.value;
    if (forward) lastForward = now();
    lag = r.lag || 0;
    st.steps++; st.chunks += r.chunks; st.folded += r.folded; st.pending = r.pending; st.lastAt = now();
    st.lag = lag;
    st.idle = r.pending === 0 && lag <= chunk;
    if (r.folded) await onFolded(r);
    return r;
  }

  async function loop() {
    running = true;
    st.startedAt = now();
    while (!stopped) {
      // Requests first: wait for in-flight requests to finish, but not forever.
      const waitUntil = now() + maxWaitMs;
      while (!stopped && busy() && now() < waitUntil) await nap(50);
      if (stopped) break;
      let r = null;
      try {
        r = await step();
        failures = 0;
      } catch (err) {
        failures++;
        st.lastError = err.shortMessage || err.message || String(err);
        st.lastErrorAt = now();
        log.error(`claims scan: step failed (${failures} in a row): ${st.lastError}`);
      }
      if (now() - lastReport > 5 * 60 * 1000 && st.steps) {
        lastReport = now();
        log.log(`claims scan: ${st.chunks} chunk(s) so far, ${st.folded} record(s) folded, ${st.pending ?? "?"} position(s) still short of their opening or floor`);
      }
      const delay = failures ? Math.min(maxBackoffMs, pauseMs * 2 ** failures)
        : !r || r.contended ? pauseMs
        : r.empty ? idleMs
        : st.idle ? Math.max(pauseMs, Math.min(idleMs, forwardEveryMs - (now() - lastForward)))
        : pauseMs;
      await nap(Math.max(delay, 10));
    }
    running = false;
  }

  return {
    start() { if (!running && !stopped) loop().catch((err) => log.error(`claims scan: loop ended: ${err.message}`)); },
    stop() { stopped = true; if (wake) wake(); },
    tryExclusive,
    get scanning() { return locked; },
    status() { return { running, scanning: locked, ...st, failures }; },
  };
}

module.exports = { create };
