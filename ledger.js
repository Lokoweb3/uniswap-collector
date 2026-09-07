/**
 * Liquidity ledger, read straight from the chain.
 *
 * Every IncreaseLiquidity and DecreaseLiquidity on the owner's positions,
 * plus each position's mint, from the RPC's own logs. The PnL basis comes
 * from this rather than from Blockscout: Blockscout's index has been seen to
 * drop whole transactions (a 2026-09-01 removal on #834424 is absent from
 * both its log query and its transaction lookup), and a basis built on it is
 * then silently wrong. The RPC is the chain; if it has the block it has the
 * log.
 *
 * Two cursors, both in 2000-block chunks (the RPC's getLogs cap), resumable,
 * persisted in liquidity-ledger.json:
 *   forward  - from the collect scanner's start block up to the block the
 *              latest position list was read at, advanced every tick;
 *   backward - from just before that start block down to each open position's
 *              mint, once, in the background (about an hour for a week-old
 *              position at this RPC's pace).
 * One query serves both event types and mints: the tokenId sits in topic 1
 * for the liquidity events, and a mint is a Transfer whose topic 1 (from) is
 * zero, so the same topic-1 filter admits both and the rest is sorted here.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const FILE = path.join(__dirname, "liquidity-ledger.json");
const CHUNK = 2000;
const PACE_MS = 100;

const INC_TOPIC = ethers.id("IncreaseLiquidity(uint256,uint128,uint256,uint256)");
const DEC_TOPIC = ethers.id("DecreaseLiquidity(uint256,uint128,uint256,uint256)");
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const coder = ethers.AbiCoder.defaultAbiCoder();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const topicOf = (id) => ethers.zeroPadValue(ethers.toBeHex(BigInt(id)), 32);

function create({ provider, npmAddress, forwardStart }) {
  let state = { fwd: forwardStart - 1, tokens: {} };
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (s.tokens) state = { ...state, ...s };
  } catch {}

  const persist = () => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(state));
    } catch {}
  };
  // back: the next block the backward scan will read down from, or null if
  // it has not started for this id. Everything in (back, forwardStart) is
  // scanned. mint: the block the NFT was minted at, once seen.
  const entry = (id) => state.tokens[id] || (state.tokens[id] = { mint: null, back: null, events: [] });

  const timeCache = new Map();
  async function blockTime(bn) {
    if (!timeCache.has(bn)) {
      const b = await provider.getBlock(bn);
      timeCache.set(bn, b ? b.timestamp * 1000 : null);
    }
    return timeCache.get(bn);
  }

  async function getLogs(filter) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.getLogs(filter);
      } catch (err) {
        if (attempt >= 3) throw err;
        await sleep(1500 * (attempt + 1));
      }
    }
  }

  const filterFor = (ids) => [[INC_TOPIC, DEC_TOPIC, TRANSFER_TOPIC], [...ids.map(topicOf), ethers.ZeroHash]];

  async function ingest(logs, idSet) {
    for (const l of logs) {
      if (l.topics[0] === TRANSFER_TOPIC) {
        if (l.topics[1] !== ethers.ZeroHash || l.topics.length < 4) continue;
        const id = BigInt(l.topics[3]).toString();
        if (!idSet.has(id)) continue;
        const e = entry(id);
        if (e.mint == null) console.log(`ledger: #${id} minted at block ${l.blockNumber}; its history is complete`);
        e.mint = l.blockNumber;
        continue;
      }
      const id = BigInt(l.topics[1]).toString();
      if (!idSet.has(id)) continue;
      const e = entry(id);
      const k = `${l.transactionHash}:${l.index}`;
      if (e.events.some((x) => x.k === k)) continue;
      const [liq, a0, a1] = coder.decode(["uint128", "uint256", "uint256"], l.data);
      e.events.push({
        k,
        block: l.blockNumber,
        t: await blockTime(l.blockNumber),
        tx: l.transactionHash,
        type: l.topics[0] === INC_TOPIC ? "inc" : "dec",
        liq: liq.toString(),
        a0: a0.toString(),
        a1: a1.toString(),
      });
    }
  }

  let fwdBusy = false;
  let fwdCaughtUp = false;

  /**
   * Advance the forward cursor to `upTo` -- the block the position list was
   * read at, not the head, so a position minted after the list was taken is
   * not skipped over before its id joins the filter.
   */
  async function scanForward(ids, upTo) {
    if (fwdBusy || !ids.length || !(upTo > state.fwd)) return;
    fwdBusy = true;
    try {
      const idSet = new Set(ids.map(String));
      const topics = filterFor([...idSet]);
      let from = state.fwd + 1;
      while (from <= upTo) {
        const to = Math.min(from + CHUNK - 1, upTo);
        const logs = await getLogs({ address: npmAddress, topics, fromBlock: from, toBlock: to });
        await ingest(logs, idSet);
        state.fwd = to;
        from = to + 1;
        if ((to - forwardStart) % (CHUNK * 25) < CHUNK) persist();
        await sleep(PACE_MS);
      }
      fwdCaughtUp = true;
      persist();
    } finally {
      fwdBusy = false;
    }
  }

  let backBusy = false;

  /** Ids whose mint is still unknown and whose backward scan has not hit block 0. */
  function pendingBack(openIds) {
    return openIds.map(String).filter((id) => {
      const e = entry(id);
      return e.mint == null && (e.back == null || e.back >= 0);
    });
  }

  /**
   * Walk backward from the forward start block toward each open position's
   * mint, at most maxChunks queries per call. Ids at the same cursor share a
   * query; the group furthest behind goes first so they converge.
   */
  async function scanBack(openIds, maxChunks) {
    if (backBusy) return;
    backBusy = true;
    try {
      let chunks = 0;
      while (chunks < maxChunks) {
        const need = pendingBack(openIds);
        if (!need.length) break;
        const cursorOf = (id) => entry(id).back ?? forwardStart - 1;
        const cur = Math.max(...need.map(cursorOf));
        const group = need.filter((id) => cursorOf(id) === cur);
        const to = cur;
        const from = Math.max(0, to - CHUNK + 1);
        const logs = await getLogs({ address: npmAddress, topics: filterFor(group), fromBlock: from, toBlock: to });
        await ingest(logs, new Set(group));
        for (const id of group) entry(id).back = from - 1;
        chunks++;
        if (chunks % 25 === 0) persist();
        await sleep(PACE_MS);
      }
      persist();
    } finally {
      backBusy = false;
    }
  }

  /**
   * Deposit/withdraw totals for one position, in the same shape basis.js
   * produces, or null until its history reaches back to the mint.
   */
  function basis(id) {
    const e = state.tokens[String(id)];
    if (!e || e.mint == null) return null;
    let dep0 = 0n, dep1 = 0n, wd0 = 0n, wd1 = 0n, liq = 0n, increases = 0, firstT = null;
    for (const ev of e.events) {
      if (ev.type === "inc") {
        dep0 += BigInt(ev.a0);
        dep1 += BigInt(ev.a1);
        liq += BigInt(ev.liq);
        increases++;
        if (firstT == null || (ev.t && ev.t < firstT)) firstT = ev.t;
      } else {
        wd0 += BigInt(ev.a0);
        wd1 += BigInt(ev.a1);
        liq -= BigInt(ev.liq);
      }
    }
    return {
      dep0: dep0.toString(), dep1: dep1.toString(),
      wd0: wd0.toString(), wd1: wd1.toString(),
      liq: liq.toString(), firstT, increases,
      source: "rpc",
    };
  }

  return {
    scanForward,
    scanBack,
    basis,
    pendingBack,
    get forwardCaughtUp() {
      return fwdCaughtUp;
    },
    get forwardBlock() {
      return state.fwd;
    },
    get scanningBack() {
      return backBusy;
    },
  };
}

module.exports = { create };
