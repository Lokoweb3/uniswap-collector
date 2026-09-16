/**
 * Uniswap v4 read helpers, shaped to match univ3.loadPosition so the server
 * can treat both generations alike.
 *
 * What differs from v3:
 *  - Position NFTs live in a v4 PositionManager that cannot enumerate an
 *    owner's tokens, so discovery is Blockscout's holdings list plus a forward
 *    scan of Transfer logs that survives Blockscout's indexing lag.
 *  - Pool state lives in one PoolManager and is read through StateView.
 *  - Fees are not stored per position: they are liquidity times the fee-growth
 *    delta since the position last touched the pool, computed here.
 *  - A pool can hold native ETH (currency address zero) and can have hooks.
 *
 * Read-only. Collecting v4 fees is not wired into the collector.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const u = require("./univ3");
// Ledgers belong to the instance, not the checkout (see data-dir.js).
const { dataPath } = require("./data-dir");

const POSM_ABI = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns (tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, uint256 info)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
];

const STATE_VIEW_ABI = [
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
];

const DYNAMIC_FEE_FLAG = 0x800000;
const MASK256 = (1n << 256n) - 1n;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const CHUNK = 2000; // the smallest getLogs window we will ask any RPC for
const MAX_SPAN = 5_000_000; // the widest; quartered down to CHUNK when refused

const NATIVE = { address: ethers.ZeroAddress, symbol: "ETH", decimals: 18 };

/** PositionInfo is packed: poolId (top 25 bytes) | tickUpper | tickLower | hasSubscriber. */
function unpackInfo(info) {
  const int24 = (x) => {
    const v = Number(x & 0xffffffn);
    return v >= 0x800000 ? v - 0x1000000 : v;
  };
  return { tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n) };
}

function poolIdOf(key) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["tuple(address,address,uint24,int24,address)"],
      [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]
    )
  );
}

async function getCurrency(address, provider) {
  return address === ethers.ZeroAddress ? NATIVE : u.getToken(address, provider);
}

/** Build the full picture for one v4 position, in univ3.loadPosition's shape. */
async function loadPosition(ctx, tokenId) {
  const { provider, posm, stateView, cfg } = ctx;
  const id = BigInt(tokenId);

  // "Gone" only when the chain answers with a different owner. An RPC error
  // here must surface as an error, not as a transfer, or a hiccup would make
  // the server forget the position for good.
  let owner;
  try {
    owner = await posm.ownerOf(id);
  } catch (err) {
    const msg = err.shortMessage || err.message || "";
    // ownerOf reverts for a burned token: that one really is gone. But
    // "missing revert data" is ethers' words for a call that came back empty,
    // which is an RPC that did not answer — not a chain saying the token does
    // not exist. Arc returns exactly that for entries inside a batched call, and
    // treating it as a burn made the server forget live positions for good.
    if (/missing revert data/i.test(msg)) throw err;
    if (/revert|nonexistent|invalid token/i.test(msg) && !/rate|timeout|network|429|503/i.test(msg)) {
      return { tokenId: id.toString(), gone: true };
    }
    throw err;
  }
  if (owner.toLowerCase() !== cfg.ownerAddress.toLowerCase()) {
    return { tokenId: id.toString(), gone: true };
  }

  // v4 pays fees out whenever liquidity changes, so an empty position owes
  // nothing: zero liquidity is closed, full stop.
  const liquidity = await posm.getPositionLiquidity(id);
  if (liquidity === 0n) return { tokenId: id.toString(), closed: true };

  const { key, info } = await posm.getPoolAndPositionInfo(id);
  const { tickLower, tickUpper } = unpackInfo(info);
  const poolId = poolIdOf(key);

  const [t0, t1, slot0] = await Promise.all([
    getCurrency(key.currency0, provider),
    getCurrency(key.currency1, provider),
    stateView.getSlot0(poolId),
  ]);

  const currentTick = Number(slot0.tick);
  const sqrtCurrent = slot0.sqrtPriceX96;
  const sqrtLower = u.getSqrtRatioAtTick(tickLower);
  const sqrtUpper = u.getSqrtRatioAtTick(tickUpper);
  const { amount0, amount1 } = u.getAmountsForLiquidity(sqrtCurrent, sqrtLower, sqrtUpper, liquidity);

  // Uncollected fees: growth inside the range now, minus growth when the
  // position last touched the pool, times liquidity. The subtraction wraps
  // like the on-chain uint256 arithmetic does.
  let fees = { amount0: 0n, amount1: 0n, ok: true, error: null };
  try {
    const salt = ethers.zeroPadValue(ethers.toBeHex(id), 32);
    const [now, last] = await Promise.all([
      stateView.getFeeGrowthInside(poolId, tickLower, tickUpper),
      stateView.getPositionInfo(poolId, await posm.getAddress(), tickLower, tickUpper, salt),
    ]);
    fees.amount0 = (liquidity * ((now[0] - last[1]) & MASK256)) >> 128n;
    fees.amount1 = (liquidity * ((now[1] - last[2]) & MASK256)) >> 128n;
  } catch (err) {
    fees = { amount0: 0n, amount1: 0n, ok: false, error: err.shortMessage || err.message };
  }

  const feeTier = Number(key.fee) === DYNAMIC_FEE_FLAG ? Number(slot0.lpFee) : Number(key.fee);

  return {
    version: 4,
    tokenId: id.toString(),
    poolAddress: poolId,
    hooks: key.hooks,
    feeTier,
    liquidity: liquidity.toString(),
    token0: t0,
    token1: t1,
    tickLower,
    tickUpper,
    currentTick,
    inRange: currentTick >= tickLower && currentTick < tickUpper,
    closed: false,
    amounts: { amount0: amount0.toString(), amount1: amount1.toString() },
    fees: {
      amount0: fees.amount0.toString(),
      amount1: fees.amount1.toString(),
      ok: fees.ok,
      error: fees.error,
    },
    prices: {
      current: u.priceFromSqrt(sqrtCurrent, t0.decimals, t1.decimals),
      lower: u.priceAtTick(tickLower, t0.decimals, t1.decimals),
      upper: u.priceAtTick(tickUpper, t0.decimals, t1.decimals),
    },
  };
}

/**
 * Persistent discovery of the owner's v4 token ids.
 *
 * Two sources, unioned: Blockscout's current-holdings list (complete but hours
 * behind the chain) and a forward scan of Transfer(to: owner) logs on the
 * position manager (live, but 2000 blocks per request, so it advances in
 * budgeted steps and persists its progress). Ids stay in the set until a load
 * finds them owned by someone else.
 */
function createDiscovery({ provider, posmAddress, owner, explorerApi, stateFile }) {
  const FILE = stateFile || dataPath("v4-positions.json");
  let state = { lastScanned: 0, ids: [], blockscoutAt: 0, scannedFrom: null, complete: false, span: 0, lastError: null };
  try {
    state = { ...state, ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
  } catch {}
  const ids = new Set(state.ids.map(String));
  const save = () => {
    state.ids = [...ids];
    try {
      fs.writeFileSync(FILE, JSON.stringify(state));
    } catch {}
  };

  // Blockscout pages the holdings 50 at a time and, depending on version,
  // names the contract `address` or `address_hash`. The stamp only advances
  // on a clean read so a Cloudflare page or timeout is retried next build.
  async function fromBlockscout() {
    if (!explorerApi || Date.now() - state.blockscoutAt < 6 * 3600 * 1000) return;
    try {
      let params = new URLSearchParams({ type: "ERC-721" });
      for (let page = 0; page < 20; page++) {
        const r = await require("./blockscout").bsFetch(`/v2/addresses/${owner}/nft?${params}`);
        const j = await r.json();
        if (!Array.isArray(j.items)) throw new Error("unexpected holdings response");
        for (const item of j.items) {
          const addr = (item.token?.address_hash || item.token?.address || "").toLowerCase();
          if (addr === posmAddress.toLowerCase()) ids.add(String(item.id));
        }
        if (!j.next_page_params) break;
        params = new URLSearchParams(
          Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)])
        );
      }
      state.blockscoutAt = Date.now();
      save();
    } catch {
      /* Cloudflare or lag; the log scan covers it */
    }
  }

  // One getLogs call. No adaptation here — the callers decide the window.
  async function logsIn(lo, hi) {
    return provider.getLogs({
      address: posmAddress,
      topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(owner, 32)],
      fromBlock: lo,
      toBlock: hi,
    });
  }
  const reason = (e) => String((e && (e.shortMessage || e.message)) || e || "unknown").slice(0, 200);

  /**
   * Sweep [0 .. hi] backwards, adapting the window to whatever this RPC accepts.
   * Chains differ by three orders of magnitude here: some answer a 5M-block
   * topic-filtered query, Arc's rejects anything over ~10k with "requested range
   * too large". So the window starts wide and quarters on refusal down to CHUNK,
   * and the first width that works is remembered for next time.
   *
   * Returns where it actually got to. `coveredFrom` is the lowest block genuinely
   * read — never an assumption — so a caller can resume from there and can tell
   * an exhausted budget from a dead RPC.
   */
  async function sweepBack(hi, budget) {
    let span = Math.max(CHUNK, Math.min(state.span || MAX_SPAN, hi + 1));
    let calls = 0;
    let coveredFrom = hi + 1; // nothing read yet
    while (hi >= 0 && calls < budget) {
      const lo = Math.max(0, hi - span + 1);
      calls++;
      try {
        for (const l of await logsIn(lo, hi)) ids.add(BigInt(l.topics[3]).toString());
        state.span = span; // this width works on this RPC; start here next time
        coveredFrom = lo;
        hi = lo - 1;
      } catch (e) {
        if (span <= CHUNK) return { coveredFrom, complete: false, error: reason(e) };
        span = Math.max(CHUNK, Math.floor(span / 4));
      }
    }
    return { coveredFrom, complete: hi < 0, error: null };
  }

  /**
   * Bring the state up to date. Two halves, and neither ever moves a cursor over
   * a range it did not successfully read:
   *   forward  — new blocks since `lastScanned`, in CHUNK steps.
   *   backfill — the history below `scannedFrom`, when the first sweep ran out of
   *              budget or the RPC refused. Resumable across calls.
   */
  async function scan(maxChunks) {
    const latest = await provider.getBlockNumber();
    state.lastError = null;

    // --- forward -----------------------------------------------------------
    if (state.lastScanned) {
      let chunks = 0;
      while (state.lastScanned < latest && chunks < maxChunks) {
        const from = state.lastScanned + 1;
        const end = Math.min(from + CHUNK - 1, latest);
        try {
          for (const l of await logsIn(from, end)) ids.add(BigInt(l.topics[3]).toString());
        } catch (e) {
          // Leave the cursor where it is: this range is unread, and pretending
          // otherwise is how a position disappears for good.
          state.lastError = reason(e);
          save();
          return false;
        }
        state.lastScanned = end;
        chunks++;
      }
    }

    // --- first run ---------------------------------------------------------
    if (!state.lastScanned) {
      const r = await sweepBack(latest, 60);
      if (r.coveredFrom <= latest) {
        // Only claim the range that was actually read.
        state.scannedFrom = r.coveredFrom;
        state.lastScanned = latest;
      }
      state.complete = r.complete;
      if (r.error) state.lastError = r.error;
      save();
      return !!state.complete;
    }

    // --- backfill ----------------------------------------------------------
    if (!state.complete && state.scannedFrom > 0) {
      const r = await sweepBack(state.scannedFrom - 1, Math.max(1, maxChunks));
      if (r.coveredFrom < state.scannedFrom) state.scannedFrom = r.coveredFrom;
      state.complete = r.complete;
      if (r.error) state.lastError = r.error;
    }

    save();
    return !!state.complete && state.lastScanned >= latest;
  }

  return {
    ids,
    forget(id) {
      if (ids.delete(String(id))) save();
    },
    async discover(maxChunks = 20) {
      await fromBlockscout();
      try {
        await scan(maxChunks);
      } catch (e) {
        // Recorded, not swallowed. An empty list from a blind scan must never
        // read like an empty wallet.
        state.lastError = reason(e);
        save();
      }
      return [...ids];
    },
    /**
     * What the caller needs to tell "this wallet has no positions" from "this
     * scan did not finish". `complete` false means history is still unread.
     */
    get status() {
      return {
        complete: !!state.complete,
        scannedFrom: state.scannedFrom == null ? null : state.scannedFrom,
        lastScanned: state.lastScanned || 0,
        window: state.span || null,
        error: state.lastError || null,
        known: ids.size,
      };
    },
    get caughtUp() {
      return state.lastScanned;
    },
  };
}

module.exports = {
  POSM_ABI,
  STATE_VIEW_ABI,
  NATIVE,
  poolIdOf,
  unpackInfo,
  getCurrency,
  loadPosition,
  createDiscovery,
};
