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
const CHUNK = 2000; // the RPC's getLogs range cap
const BS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

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
    // ownerOf reverts for a burned token: that one really is gone.
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
  const FILE = stateFile || path.join(__dirname, "v4-positions.json");
  let state = { lastScanned: 0, ids: [], blockscoutAt: 0 };
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
        const r = await fetch(`${explorerApi}/v2/addresses/${owner}/nft?${params}`, {
          headers: { "User-Agent": BS_UA, Accept: "application/json" },
          signal: AbortSignal.timeout(20000),
        });
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

  async function scan(maxChunks) {
    const latest = await provider.getBlockNumber();
    // First run: start about a day back. Anything older is Blockscout's job.
    const to = ethers.zeroPadValue(owner, 32);
    // First run: sweep the whole chain backwards in big windows. This RPC
    // answers a topic-filtered query over ~5M blocks in one call (the whole
    // chain at once times out); a window that fails is retried a quarter the
    // size. Finds every position ever sent to the owner, so Blockscout is only
    // a fallback. If even that fails, start a day back as before.
    if (!state.lastScanned) {
      try {
        let hi = latest, span = 5_000_000, calls = 0;
        while (hi >= 0 && calls < 60) {
          const lo = Math.max(0, hi - span + 1);
          calls++;
          try {
            const logs = await provider.getLogs({ address: posmAddress, topics: [TRANSFER_TOPIC, null, to], fromBlock: lo, toBlock: hi });
            for (const l of logs) ids.add(BigInt(l.topics[3]).toString());
            hi = lo - 1;
          } catch (e) {
            if (span <= 250_000) throw e;
            span = Math.floor(span / 4);
          }
        }
        state.lastScanned = latest;
        save();
        return true;
      } catch {
        state.lastScanned = Math.max(0, latest - 900000);
      }
    }
    let chunks = 0;
    while (state.lastScanned < latest && chunks < maxChunks) {
      const from = state.lastScanned + 1;
      const end = Math.min(from + CHUNK - 1, latest);
      const logs = await provider.getLogs({
        address: posmAddress,
        topics: [TRANSFER_TOPIC, null, to],
        fromBlock: from,
        toBlock: end,
      });
      for (const l of logs) ids.add(BigInt(l.topics[3]).toString());
      state.lastScanned = end;
      chunks++;
    }
    save();
    return state.lastScanned >= latest;
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
      } catch {}
      return [...ids];
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
