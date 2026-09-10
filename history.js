/**
 * Incremental Collect-event history for every wallet's positions: the main
 * wallet plus the wallets listed under wallets in settings.json.
 *
 * The RPC caps eth_getLogs at 2000 blocks per request and the chain moves at
 * ~10 blocks/s, so full history is unreachable; instead we scan forward from
 * the block where the collector went live, persist progress after every batch,
 * and catch up in the background. A day offline is about a minute of scanning.
 *
 * Fee amounts are Collect minus any same-tx DecreaseLiquidity for the same
 * tokenId, so principal withdrawn on a close is not counted as fees.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const FILE = path.join(__dirname, "fee-events.json");
// Uniswap v4 collects have no Collect event on the v3 manager, so the collector
// appends each one it sends to this ledger (also rebuilt from collector.log by
// tools/backfill-v4-collects.js). Rows share the event shape below, with
// tokenId "v4-<id>" and the token metadata inline.
const V4_FILE = path.join(__dirname, "v4-collects.json");
// The owner's own collects through the v4 PositionManager (ledger-v4.js writes
// them; the server owns that file, the collector owns v4-collects.json).
const V4_OWNER_FILE = path.join(__dirname, "v4-owner-collects.json");
const CHUNK = 2000;
const START_BLOCK = 51940000; // just before the collector's first collect (2026-09-01)

const COLLECT_TOPIC = ethers.id("Collect(uint256,address,uint256,uint256)");
const DECREASE_TOPIC = ethers.id("DecreaseLiquidity(uint256,uint128,uint256,uint256)");
const coder = ethers.AbiCoder.defaultAbiCoder();

function create({ provider, npmAddress }) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    state = { lastScanned: START_BLOCK - 1, events: [] };
  }

  let scanning = false;
  const blockTimeCache = new Map();
  // Wallets added after the forward scan started need their older blocks
  // covered once; progress per wallet lives in state.catchup so it survives
  // restarts and is spread over several ticks.
  state.catchup = state.catchup || {};

  async function blockTime(bn) {
    if (!blockTimeCache.has(bn)) {
      const b = await provider.getBlock(bn);
      blockTimeCache.set(bn, b ? b.timestamp * 1000 : null);
    }
    return blockTimeCache.get(bn);
  }

  function persist() {
    fs.writeFileSync(FILE, JSON.stringify(state));
  }

  /** Fetch and fold one block range for the given ids; returns events (without wallet tags). */
  async function scanRange(idTopics, from, to) {
    // The RPC rate-limits bursts; retry each chunk with backoff, and if it
    // keeps failing stop here — progress is persisted and the next tick
    // resumes from where it was.
    let logs = null;
    for (let attempt = 0; attempt < 3 && logs === null; attempt++) {
      try {
        logs = await provider.getLogs({
          address: npmAddress,
          topics: [[COLLECT_TOPIC, DECREASE_TOPIC], idTopics],
          fromBlock: from,
          toBlock: to,
        });
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    // Group by tx+tokenId so a close's principal cancels out of its collect.
    const byKey = new Map();
    for (const l of logs) {
      const tokenId = BigInt(l.topics[1]).toString();
      const key = `${l.transactionHash}:${tokenId}`;
      let e = byKey.get(key);
      if (!e) {
        e = { block: l.blockNumber, tx: l.transactionHash, tokenId, c0: 0n, c1: 0n, d0: 0n, d1: 0n };
        byKey.set(key, e);
      }
      if (l.topics[0] === COLLECT_TOPIC) {
        const [, a0, a1] = coder.decode(["address", "uint256", "uint256"], l.data);
        e.c0 += a0;
        e.c1 += a1;
      } else {
        const [, a0, a1] = coder.decode(["uint128", "uint256", "uint256"], l.data);
        e.d0 += a0;
        e.d1 += a1;
      }
    }
    const out = [];
    for (const e of byKey.values()) {
      const f0 = e.c0 - e.d0 > 0n ? e.c0 - e.d0 : 0n;
      const f1 = e.c1 - e.d1 > 0n ? e.c1 - e.d1 : 0n;
      if (e.c0 === 0n && e.c1 === 0n) continue; // decrease with no collect yet
      out.push({
        block: e.block,
        t: await blockTime(e.block),
        tx: e.tx,
        tokenId: e.tokenId,
        fee0: f0.toString(),
        fee1: f1.toString(),
        principal: e.d0 > 0n || e.d1 > 0n,
      });
    }
    return out;
  }

  /** Normalise the scan input: a flat id list (main wallet only) or [{ address, label, ids }]. */
  function walletsFrom(input, mainAddress) {
    if (!Array.isArray(input) || !input.length) return [];
    if (typeof input[0] === "object" && input[0] && "ids" in input[0]) return input.filter((w) => w.ids && w.ids.length);
    return [{ address: mainAddress || null, label: "Main", ids: input, main: true }];
  }
  const idTopic = (id) => ethers.zeroPadValue(ethers.toBeHex(BigInt(id)), 32);
  const tagged = (events, w) => events.map((e) => ({ ...e, wallet: w.address ? w.address.toLowerCase() : null, walletLabel: w.label || null }));
  const seen = () => new Set(state.events.map((e) => `${e.tx}:${e.tokenId}`));

  /**
   * Scan new blocks for Collect/DecreaseLiquidity for every wallet's ids
   * (forward from lastScanned), then spend a bounded budget on the backward
   * catch-up of wallets whose ids have not yet been covered from START_BLOCK.
   */
  async function scan(input, { mainAddress = null, catchupBudget = 200 } = {}) {
    const wallets = walletsFrom(input, mainAddress);
    if (scanning || !wallets.length) return;
    scanning = true;
    try {
      const head = await provider.getBlockNumber();
      const ownerOf = new Map(); // tokenId -> wallet
      for (const w of wallets) for (const id of w.ids) ownerOf.set(String(id), w);
      const idTopics = [...ownerOf.keys()].map(idTopic);

      let from = state.lastScanned + 1;
      while (from <= head) {
        const to = Math.min(from + CHUNK - 1, head);
        const found = await scanRange(idTopics, from, to);
        for (const e of found) {
          const w = ownerOf.get(e.tokenId) || wallets[0];
          state.events.push(...tagged([e], w));
        }
        state.lastScanned = to;
        from = to + 1;
        if ((to - START_BLOCK) % (CHUNK * 10) < CHUNK) persist(); // survive hard kills
        await new Promise((r) => setTimeout(r, 120)); // stay under the rate limit
      }

      // Backward catch-up, one wallet at a time, budgeted per call.
      let budget = catchupBudget;
      for (const w of wallets) {
        if (w.main || !w.address) continue; // the main wallet was covered by the forward scan from the start
        const key = w.address.toLowerCase();
        const c = (state.catchup[key] = state.catchup[key] || { next: START_BLOCK, until: state.lastScanned, ids: [] });
        // New ids for a known wallet (a later mint) need no catch-up: their events are after the mint, inside the forward scan.
        if (c.next > c.until) continue;
        const topics = w.ids.map(idTopic);
        const known = seen();
        while (c.next <= c.until && budget > 0) {
          const to = Math.min(c.next + CHUNK - 1, c.until);
          const found = await scanRange(topics, c.next, to);
          for (const e of found) if (!known.has(`${e.tx}:${e.tokenId}`)) state.events.push(...tagged([e], w));
          c.next = to + 1;
          budget--;
          if (budget % 20 === 0) persist();
          await new Promise((r) => setTimeout(r, 120));
        }
        if (budget <= 0) break;
      }
    } finally {
      state.events.sort((a, b) => a.block - b.block);
      persist();
      scanning = false;
    }
  }

  /** Catch-up progress per wallet, for the UI. */
  function catchupStatus() {
    const out = {};
    for (const [k, c] of Object.entries(state.catchup)) out[k] = { done: c.next > c.until, next: c.next, until: c.until };
    return out;
  }

  // v4 ledger, re-read when the collector appends to it; merged view cached
  // until either side changes (events is read inside per-position loops).
  let v4 = { mtime: -1, rows: [] };
  let merged = { key: "", rows: [] };
  function v4Rows() {
    let mtime = 0;
    for (const f of [V4_FILE, V4_OWNER_FILE]) { try { mtime += fs.statSync(f).mtimeMs; } catch {} }
    if (mtime !== v4.mtime) {
      let rows = [];
      for (const f of [V4_FILE, V4_OWNER_FILE]) {
        try { rows.push(...JSON.parse(fs.readFileSync(f, "utf8")).filter((r) => r && r.tx && r.tokenId)); } catch {}
      }
      v4 = { mtime, rows: rows.map((r) => ({ ...r, tokenId: String(r.tokenId).startsWith("v4-") ? r.tokenId : `v4-${r.tokenId}`, wallet: r.wallet ? r.wallet.toLowerCase() : null, principal: !!r.principal })) };
    }
    return v4.rows;
  }
  function allEvents() {
    const rows = v4Rows();
    const key = `${state.events.length}:${v4.mtime}:${rows.length}`;
    if (merged.key !== key) {
      const seenKeys = new Set(state.events.map((e) => `${e.tx}:${e.tokenId}`));
      const extra = rows.filter((r) => !seenKeys.has(`${r.tx}:${r.tokenId}`));
      merged = { key, rows: [...state.events, ...extra].sort((a, b) => a.block - b.block) };
    }
    return merged.rows;
  }

  return {
    scan,
    catchupStatus,
    get events() {
      return allEvents();
    },
    get v3Events() {
      return state.events;
    },
    get lastScanned() {
      return state.lastScanned;
    },
    get scanning() {
      return scanning;
    },
    get startBlock() {
      return START_BLOCK;
    },
  };
}

module.exports = { create };
