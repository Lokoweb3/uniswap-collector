/**
 * Incremental Collect-event history for the owner's positions.
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

  /** Scan new blocks for Collect/DecreaseLiquidity on the given tokenIds. */
  async function scan(tokenIds) {
    if (scanning || !tokenIds || !tokenIds.length) return;
    scanning = true;
    try {
      const head = await provider.getBlockNumber();
      const idTopics = tokenIds.map((id) => ethers.zeroPadValue(ethers.toBeHex(id), 32));

      let from = state.lastScanned + 1;
      while (from <= head) {
        const to = Math.min(from + CHUNK - 1, head);

        // The RPC rate-limits bursts; retry each chunk with backoff, and if it
        // keeps failing stop here — progress is persisted and the next tick
        // resumes from lastScanned.
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

        for (const e of byKey.values()) {
          const f0 = e.c0 - e.d0 > 0n ? e.c0 - e.d0 : 0n;
          const f1 = e.c1 - e.d1 > 0n ? e.c1 - e.d1 : 0n;
          if (e.c0 === 0n && e.c1 === 0n) continue; // decrease with no collect yet
          state.events.push({
            block: e.block,
            t: await blockTime(e.block),
            tx: e.tx,
            tokenId: e.tokenId,
            fee0: f0.toString(),
            fee1: f1.toString(),
            principal: (e.d0 > 0n || e.d1 > 0n),
          });
        }

        state.lastScanned = to;
        from = to + 1;
        if ((to - START_BLOCK) % (CHUNK * 10) < CHUNK) persist(); // survive hard kills
        await new Promise((r) => setTimeout(r, 120)); // stay under the rate limit
      }
    } finally {
      state.events.sort((a, b) => a.block - b.block);
      persist();
      scanning = false;
    }
  }

  return {
    scan,
    get events() {
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
