// node test/claims-price-from-swaps.test.js — the pool price behind a liquidity
// change comes from the swap that set it, not from archive state.
//
// Separating principal from fees needs the pool's price at the moment of the change.
// It was read with getSlot0 at an old block, which this chain's RPC answers with
// "missing revert data" because it has pruned: forty-two of forty-three records on
// one position, and most of the claim history on the page, were refused as
// undecodable for want of a price that logs still hold.
//
// In v4 only a swap moves the price — a liquidity change does not, and neither does
// a donation — so the last swap before the log gives the exact price, not an
// estimate. Logs are kept where state is not.
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "claims-store.js"), "utf8");

// lastSwapBefore closes over the module's provider, so it is lifted out and given
// a fake chain: what matters is which blocks it asks for and what it concludes.
const from = src.indexOf("  async function lastSwapBefore(poolId, block) {");
assert.ok(from >= 0, "lastSwapBefore is gone from claims-store.js");
const body = src.slice(from, src.indexOf("\n  }\n", from) + 4);

const SWAP = "0xswap";
const sqrtAt = (block) => BigInt(block) * 1000n;

/** A chain with swaps at the given blocks, and a span it refuses to exceed. */
function chain({ swaps = [], cap = Infinity } = {}) {
  const calls = [];
  const provider = {
    async getLogs({ fromBlock, toBlock }) {
      calls.push([fromBlock, toBlock]);
      if (toBlock - fromBlock + 1 > cap) {
        const e = new Error("could not coalesce error");
        throw e;
      }
      return swaps.filter((b) => b >= fromBlock && b <= toBlock).sort((a, b) => a - b)
        .map((b) => ({ blockNumber: b, data: "0x" }));
    },
  };
  return { provider, calls };
}

function run({ swaps, cap, maxLogRange = 50000, priceSearchRequests = 24, block = 1000, cache = new Map() }) {
  const { provider, calls } = chain({ swaps, cap });
  const fn = new Function("provider", "pm", "SWAP", "maxLogRange", "priceSearchRequests",
    "lastSwapCache", "sqrtOfSwap",
    body + "; return lastSwapBefore;")(
    provider, "0xpm", SWAP, maxLogRange, priceSearchRequests, cache,
    (x) => sqrtAt(x.blockNumber));
  return { find: (b = block) => fn("0xpool", b), calls, cache };
}

(async () => {
  // ---- 1. the price comes from the last swap before the block -----------------
  {
    const r = run({ swaps: [100, 500, 940, 990], block: 1000 });
    const hit = await r.find();
    assert.ok(hit, "a swap before the block is found");
    assert.strictEqual(hit.block, 990, "the latest one, not merely any one");
    assert.strictEqual(hit.sqrt, sqrtAt(990), "and its price is what is returned");
  }

  // ---- 2. a swap in the block itself is not the answer ------------------------
  {
    // The caller has already handled earlier-in-the-same-block by log index; this
    // search must stay strictly before, or it would use a price set afterwards.
    const r = run({ swaps: [500, 1000, 1200], block: 1000 });
    const hit = await r.find();
    assert.strictEqual(hit.block, 500, "a swap at the block itself is not used");
    for (const [, to] of r.calls) assert.ok(to < 1000, `no request reaches the block itself: ${to}`);
    assert.strictEqual(hit.sqrt, sqrtAt(500), "and the price is the one that swap left behind");
  }

  // ---- 3. a chain that caps getLogs is narrowed, not given up on --------------
  {
    // Arc refuses a span over about 1,000 blocks and says only "could not coalesce
    // error" — nothing that names a limit. The search must narrow and carry on.
    // A realistic height: near block 0 the first span is clamped by the start of the
    // chain and never actually exceeds the cap, so nothing would be narrowed.
    const r = run({ swaps: [99940], cap: 1000, maxLogRange: 50000, block: 100000 });
    const hit = await r.find(100000);
    assert.ok(hit && hit.block === 99940, `found despite the cap: ${hit && hit.block}`);
    assert.ok(r.calls.some(([f, t]) => t - f + 1 > 1000), "it tried a wide span first");
    assert.ok(r.calls.some(([f, t]) => t - f + 1 <= 1000), "and narrowed until the chain accepted one");
  }

  // ---- 4. a pool that has never swapped gives no answer, not a wrong one ------
  {
    const r = run({ swaps: [], block: 1000, maxLogRange: 100, priceSearchRequests: 4 });
    assert.strictEqual(await r.find(), null, "no swap, no price — the caller falls back");
    assert.ok(r.calls.length <= 4, `the search is bounded: ${r.calls.length} requests`);
  }

  // ---- 5. the cache never answers a question it was not asked -----------------
  {
    // The trap: having found "the last swap before 1000", it is tempting to reuse it
    // for block 2000. But a swap at 1500 would then be missed and the price returned
    // would be stale — silently mis-splitting principal from fees on a record that
    // looks perfectly decoded.
    const cache = new Map();
    const a = run({ swaps: [900, 1500], block: 1000, cache });
    const first = await a.find(1000);
    assert.strictEqual(first.block, 900);
    const b = run({ swaps: [900, 1500], block: 2000, cache });
    const second = await b.find(2000);
    assert.strictEqual(second.block, 1500, "a later block gets the swap that actually precedes it");
    assert.notStrictEqual(second.sqrt, first.sqrt, "and a different price");
  }

  // ---- 6. the same question twice costs one search ----------------------------
  {
    const cache = new Map();
    const r = run({ swaps: [900], block: 1000, cache });
    await r.find(1000);
    const n = r.calls.length;
    await r.find(1000);
    assert.strictEqual(r.calls.length, n, "the repeated question is answered from the cache");
    // Including a fruitless search: scanning the same empty range again is waste.
    const empty = run({ swaps: [], block: 500, maxLogRange: 100, priceSearchRequests: 3, cache });
    await empty.find(500);
    const m = empty.calls.length;
    await empty.find(500);
    assert.strictEqual(empty.calls.length, m, "and so is a search that found nothing");
  }

  // ---- 7. the store says why this exists --------------------------------------
  {
    assert.match(src, /const DECODER = 7;/, "the decoder version is bumped so old refusals are reconsidered");
    assert.ok(/sv\.getSlot0\(poolId, \{ blockTag: l\.blockNumber - 1 \}\)/.test(src),
      "the archive read is kept as a last resort for chains that still serve it");
    const order = src.indexOf("lastSwapBefore(poolId, l.blockNumber)") < src.indexOf("sv.getSlot0(poolId,");
    assert.ok(order, "and is tried after the logs, not before");
  }

  console.log("claims price: taken from the swap that set it, bounded and narrowed for chains that cap getLogs, never reused for a block it was not measured for");
})().catch((e) => { console.error(e); process.exit(1); });
