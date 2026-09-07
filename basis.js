/**
 * Blockscout-backed backfill and PnL basis.
 *
 * The RPC prunes state and caps getLogs at 2000 blocks, but Blockscout's
 * classic API answers full-range topic-filtered log queries (with a browser
 * User-Agent; its index lags the chain by a while, which is why the live RPC
 * scanner in history.js owns recent blocks and this module owns everything
 * before that scanner's start block).
 *
 * Produces, per position: total deposited amounts (IncreaseLiquidity), total
 * withdrawn principal (DecreaseLiquidity), and fee-collect events older than
 * the scanner window — enough for all-time earnings and PnL vs HODL.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const FILE = path.join(__dirname, "backfill.json");
const REFRESH_MS = 24 * 3600 * 1000;

const COLLECT_TOPIC = ethers.id("Collect(uint256,address,uint256,uint256)");
const DECREASE_TOPIC = ethers.id("DecreaseLiquidity(uint256,uint128,uint256,uint256)");
const INCREASE_TOPIC = ethers.id("IncreaseLiquidity(uint256,uint128,uint256,uint256)");
const coder = ethers.AbiCoder.defaultAbiCoder();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Blockscout PRO API key (proapi_..., from https://dev.blockscout.com,
// exported as LP_BLOCKSCOUT_KEY) routes queries through api.blockscout.com
// with Bearer auth — 100k credits/day, 5 RPS on the free tier. Without one,
// fall back to the anonymous explorer API, which throttles hard.
const bs = require("./blockscout");
const PRO_KEY = bs.hasKey() ? "set" : null; // value stays inside blockscout.js
const PACE_MS = PRO_KEY ? 300 : 2500;
let blockedUntil = 0; // epoch ms until which the anonymous API has told us to wait

async function bsLogs(address, topic0, tokenId) {
  const topic1 = ethers.zeroPadValue(ethers.toBeHex(BigInt(tokenId)), 32);
  const query =
    `module=logs&action=getLogs&fromBlock=0&toBlock=latest` +
    `&address=${address}&topic0=${topic0}&topic1=${topic1}&topic0_1_opr=and`;
  const url = `${bs.apiBase()}?${query}`;
  const headers = bs.headers();
  // The anonymous API allows ten requests per window and says when the window
  // resets (x-ratelimit-reset, ms). Once it says no, stop asking until then:
  // retrying inside the window only wastes time, and the build is resumable.
  if (Date.now() < blockedUntil) {
    throw new Error(`blockscout: rate limited, resuming after ${new Date(blockedUntil).toISOString().slice(11, 19)}Z`);
  }
  let d = null;
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    d = await r.json();
    if (Array.isArray(d.result) || !/too many requests/i.test(d.message || d.result || "")) break;
    const reset = Number(r.headers.get("x-ratelimit-reset"));
    if (reset > 0) {
      blockedUntil = Date.now() + reset + 2000;
      throw new Error(`blockscout: rate limited, resuming after ${new Date(blockedUntil).toISOString().slice(11, 19)}Z`);
    }
    if (attempt >= 3) throw new Error("blockscout: rate limited, giving up for now");
    await sleep(15000 * (attempt + 1));
  }
  if (!Array.isArray(d.result)) {
    if (/no records/i.test(d.message || "")) return [];
    throw new Error(`blockscout: ${d.message || JSON.stringify(d.result).slice(0, 80)}`);
  }
  const seen = new Set();
  const out = [];
  for (const l of d.result) {
    const key = `${l.transactionHash}:${parseInt(l.logIndex, 16) || l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      block: parseInt(l.blockNumber, 16),
      t: l.timeStamp ? parseInt(l.timeStamp, 16) * 1000 : null,
      tx: l.transactionHash,
      data: l.data,
    });
  }
  return out;
}

function create({ npmAddress }) {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!state.tokens) state = null; // discard pre-resumable format
  } catch {}

  let building = false;

  /**
   * openIds get a full PnL basis; all ids get their pre-cutoff collect history.
   * cutoffBlock = the live scanner's start block (its events begin there).
   */
  async function build(allIds, openIds, cutoffBlock) {
    if (building) return;
    building = true;
    try {
      // Resumable: one entry per token, persisted as each finishes. A rate-limit
      // abort resumes where it left off on the next tick; a completed pass older
      // than the refresh window starts over.
      if (!state) {
        state = { completeAt: null, cutoff: cutoffBlock, tokens: {} };
      } else if (state.completeAt && Date.now() - state.completeAt > REFRESH_MS) {
        // Daily refresh touches only open positions (their basis can change);
        // a closed position's pre-cutoff history is settled.
        state.completeAt = null;
        for (const id of openIds) delete state.tokens[String(id)];
      }

      for (const id of allIds) {
        const key = String(id);
        if (state.tokens[key] && (state.tokens[key].basis || !openIds.includes(key))) continue;
        const collects = await bsLogs(npmAddress, COLLECT_TOPIC, id);
        await sleep(PACE_MS);
        const decreases = await bsLogs(npmAddress, DECREASE_TOPIC, id);
        await sleep(PACE_MS);

        // Pre-cutoff fee events: collect minus same-tx decrease, like history.js.
        const byTx = new Map();
        for (const l of collects.filter((l) => l.block < cutoffBlock)) {
          const [, a0, a1] = coder.decode(["address", "uint256", "uint256"], l.data);
          const e = byTx.get(l.tx) || { block: l.block, t: l.t, tx: l.tx, c0: 0n, c1: 0n, d0: 0n, d1: 0n };
          e.c0 += a0;
          e.c1 += a1;
          byTx.set(l.tx, e);
        }
        for (const l of decreases.filter((l) => l.block < cutoffBlock)) {
          const [, a0, a1] = coder.decode(["uint128", "uint256", "uint256"], l.data);
          const e = byTx.get(l.tx);
          if (e) {
            e.d0 += a0;
            e.d1 += a1;
          }
        }
        const entry = { events: [], basis: null };
        for (const e of byTx.values()) {
          const f0 = e.c0 - e.d0 > 0n ? e.c0 - e.d0 : 0n;
          const f1 = e.c1 - e.d1 > 0n ? e.c1 - e.d1 : 0n;
          entry.events.push({
            block: e.block, t: e.t, tx: e.tx, tokenId: key,
            fee0: f0.toString(), fee1: f1.toString(),
            principal: e.d0 > 0n || e.d1 > 0n,
          });
        }

        // PnL basis for open positions: everything deposited and withdrawn.
        if (openIds.includes(key)) {
          const increases = await bsLogs(npmAddress, INCREASE_TOPIC, id);
          await sleep(PACE_MS);
          let dep0 = 0n, dep1 = 0n, wd0 = 0n, wd1 = 0n, liq = 0n, firstT = null;
          for (const l of increases) {
            const [dl, a0, a1] = coder.decode(["uint128", "uint256", "uint256"], l.data);
            dep0 += a0;
            dep1 += a1;
            liq += dl;
            if (firstT == null || (l.t && l.t < firstT)) firstT = l.t;
          }
          for (const l of decreases) {
            const [dl, a0, a1] = coder.decode(["uint128", "uint256", "uint256"], l.data);
            wd0 += a0;
            wd1 += a1;
            liq -= dl;
          }
          entry.basis = {
            dep0: dep0.toString(), dep1: dep1.toString(),
            wd0: wd0.toString(), wd1: wd1.toString(),
            liq: liq.toString(), firstT,
            increases: increases.length,
          };
        }

        entry.builtAt = Date.now();
        state.tokens[key] = entry;
        fs.writeFileSync(FILE, JSON.stringify(state));
      }

      state.completeAt = Date.now();
      fs.writeFileSync(FILE, JSON.stringify(state));
    } finally {
      building = false;
    }
  }

  /**
   * Drop the entries for these ids so the next build refetches them. Used
   * when a position's live liquidity disagrees with its basis (an add or
   * remove since the entry was built) rather than waiting for the daily
   * refresh. Returns how many entries were dropped.
   */
  function invalidate(ids, liveById = {}) {
    if (!state) return 0;
    if (!state.live) state.live = {};
    let n = 0;
    for (const id of ids) {
      if (delete state.tokens[String(id)]) n++;
      // Remember what the chain said when we gave up on the old entry, so the
      // caller can tell "changed again" from "Blockscout still lacks it".
      if (liveById[String(id)] != null) state.live[String(id)] = liveById[String(id)];
    }
    if (n) {
      state.completeAt = null;
      fs.writeFileSync(FILE, JSON.stringify(state));
    }
    return n;
  }

  function builtAt(id) {
    const t = state && state.tokens[String(id)];
    return t && t.builtAt ? t.builtAt : null;
  }

  /** Live liquidity at the time this id's entry was last invalidated, if known. */
  function liveAtBuild(id) {
    return state && state.live ? state.live[String(id)] ?? null : null;
  }

  return {
    build,
    invalidate,
    builtAt,
    liveAtBuild,
    get stale() {
      return !state || !state.completeAt || Date.now() - state.completeAt > REFRESH_MS;
    },
    get events() {
      if (!state) return [];
      const all = [];
      for (const t of Object.values(state.tokens)) all.push(...t.events);
      return all.sort((a, b) => a.block - b.block);
    },
    get basis() {
      if (!state) return {};
      const out = {};
      for (const [id, t] of Object.entries(state.tokens)) {
        if (t.basis) out[id] = t.basis;
      }
      return out;
    },
    get cutoff() {
      return state ? state.cutoff : null;
    },
    get ready() {
      return !!(state && state.completeAt);
    },
    get building() {
      return building;
    },
  };
}

module.exports = { create };
