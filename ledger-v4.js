/**
 * v4 liquidity ledger, read straight from the chain.
 *
 * v4 has no IncreaseLiquidity/DecreaseLiquidity events on the PositionManager
 * (it only emits Transfer/Approval). Liquidity changes surface as
 * ModifyLiquidity events on the PoolManager, emitted with sender = the
 * PositionManager when it settles a modifyLiquidities() call, and the tokenId
 * in the event's `salt` (the PositionManager stores each position under
 * salt = tokenId). The salt is not indexed, so the filter is topic2 = the
 * PositionManager plus, when known, topic1 = the pool ids our positions live
 * in; the salt is decoded from each event and only our ids are kept.
 *
 * Token amounts are not in the event. They are derived from liquidityDelta,
 * the tick range and the pool's sqrtPrice at that block, using the same
 * LiquidityAmounts math as univ3.js. The sqrtPrice comes from an eth_call at
 * the block while the RPC still serves that state (about 4500 blocks), and
 * from the nearest Swap event in the pool before that; a row that cannot be
 * priced either way is kept with priced:false so nothing is valued at
 * today's price by mistake.
 *
 * A fee-only modify (liquidityDelta 0, the owner collecting through the
 * PositionManager) is a collect, not a basis row: it is written to
 * v4-owner-collects.json in the v4-collects.json shape (amounts from the
 * ERC-20 transfers out of the PoolManager in that transaction; a native ETH
 * leg is not visible in logs and is recorded as unknown) and merged by
 * history.js. That file belongs to the server alone; v4-collects.json
 * belongs to the collector, so the two never write the same file.
 *
 * Rows are written in the v3 ledger's shape (liquidity-ledger.json), keyed by
 * the bare tokenId inside this file; callers add the v4- prefix.
 *
 * Two cursors, both in 2000-block chunks (the RPC's getLogs cap), resumable,
 * persisted in v4-liquidity-ledger.json:
 *   forward  - from the collect scanner's start block up to the block the
 *              latest position list was read at, advanced every tick;
 *   backward - from just before that start block down to each open position's
 *              mint, once, in the background.
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const u = require("./univ3");
const v4 = require("./univ4");

const FILE = path.join(__dirname, "v4-liquidity-ledger.json");
const OWNER_COLLECTS = path.join(__dirname, "v4-owner-collects.json");
const CHUNK = 2000;
const PACE_MS = 100;
const STATE_DEPTH = 4000; // blocks back the RPC still answers eth_call for (probed: ~4500)
const SWAP_LOOKBACK = 20000; // blocks to search back for a Swap price before an event (~35 min)
const HEAD_WALK_CHUNKS = 400; // chunks to walk forward looking for the next swap (~800k blocks, about a day)

const MOD_TOPIC = ethers.id("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)");
const SWAP_TOPIC = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const INIT_TOPIC = ethers.id("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MOD_IFACE = new ethers.Interface([
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
]);

function create({ provider, poolManager, posm, posmAddress, stateView, forwardStart, log = console.log }) {
  posmAddress = posmAddress || (posm && posm.target);
  const pmLower = String(poolManager).toLowerCase();
  let state = { fwd: forwardStart - 1, tokens: {} };
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (s.tokens) state = { ...state, ...s };
  } catch {}

  const persist = () => {
    try {
      const tmp = FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, FILE);
    } catch {}
  };
  // back: the next block the backward scan will read down from, or null if
  // it has not started for this id. mint: the block the NFT was minted at.
  const entry = (id) => state.tokens[id] || (state.tokens[id] = { mint: null, back: null, poolId: null, events: [] });

  const timeCache = new Map();
  async function blockTime(bn) {
    if (!timeCache.has(bn)) {
      const b = await provider.getBlock(bn).catch(() => null);
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

  // Pool key per tokenId from the PositionManager (zeroed for a closed position).
  const keyCache = new Map();
  async function poolKeyOf(tokenId) {
    if (keyCache.has(tokenId)) return keyCache.get(tokenId);
    let key = null;
    try {
      const r = await posm.getPoolAndPositionInfo(BigInt(tokenId));
      key = { currency0: r[0].currency0, currency1: r[0].currency1, fee: Number(r[0].fee), tickSpacing: Number(r[0].tickSpacing), hooks: r[0].hooks };
      if (key.currency1 === ethers.ZeroAddress) key = null; // closed: nothing to learn
    } catch {
      key = null;
    }
    keyCache.set(tokenId, key);
    return key;
  }

  /**
   * Pool ids our positions live in, to narrow the topic1 filter: recorded ones
   * plus the manager's key for open ids. A closed position's pool is unknown
   * until its first event is seen, so when any id in the set has no pool yet
   * the answer is null (match every pool); the topic2 filter still limits the
   * scan to the PositionManager's own modifies, which is the bulk of the saving.
   */
  async function knownPoolIds(idSet) {
    const out = new Set();
    for (const id of idSet) {
      const e = state.tokens[id];
      if (e && e.poolId) { out.add(e.poolId); continue; }
      const key = await poolKeyOf(id);
      if (key) out.add(v4.poolIdOf(key)); else return null;
    }
    return [...out];
  }

  // sqrtPrice of a pool at a block: the RPC's state while it still has it,
  // else the last Swap in the pool before the block. Cached per pool:block.
  const sv = new ethers.Contract(stateView, v4.STATE_VIEW_ABI, provider);
  const priceCache = new Map();
  async function sqrtPriceAt(poolId, block) {
    const k = `${poolId}:${block}`;
    if (priceCache.has(k)) return priceCache.get(k);
    let val = null;
    const head = await provider.getBlockNumber().catch(() => null);
    if (head != null && head - block <= STATE_DEPTH) {
      try {
        const r = await sv.getSlot0(poolId, { blockTag: block });
        val = { sqrtPriceX96: r[0], source: "state" };
      } catch {}
    }
    // Nearest Swap before the block (chunked, the RPC caps a query at 2000 blocks), then the first after it.
    for (let to = block, n = 0; !val && n < SWAP_LOOKBACK / CHUNK; n++) {
      const from = Math.max(0, to - CHUNK + 1);
      try {
        const logs = await getLogs({ address: poolManager, topics: [SWAP_TOPIC, poolId], fromBlock: from, toBlock: to });
        const last = logs[logs.length - 1];
        if (last) val = { sqrtPriceX96: MOD_IFACE.parseLog(last).args.sqrtPriceX96, source: `swap ${block - last.blockNumber} blocks earlier` };
      } catch { break; }
      to = from - 1;
    }
    // Look ahead to the first swap after the event; if there has been none at all up to the
    // head, the pool's price has not moved since, so the current state is exact for that block.
    let reachedHead = false;
    for (let from = block + 1, n = 0; !val && n < HEAD_WALK_CHUNKS; n++) {
      if (head != null && from > head) { reachedHead = true; break; }
      const to = head != null ? Math.min(from + CHUNK - 1, head) : from + CHUNK - 1;
      try {
        const logs = await getLogs({ address: poolManager, topics: [SWAP_TOPIC, poolId], fromBlock: from, toBlock: to });
        if (logs.length) val = { sqrtPriceX96: MOD_IFACE.parseLog(logs[0]).args.sqrtPriceX96, source: `swap ${logs[0].blockNumber - block} blocks later` };
      } catch { break; }
      from = to + 1;
      if (head != null && from > head) reachedHead = true;
    }
    if (!val && reachedHead) {
      try {
        const r = await sv.getSlot0(poolId);
        val = { sqrtPriceX96: r[0], source: "current state (no swap since)" };
      } catch {}
    }
    if (!val) {
      // A pool with no swap yet (the mint right after creation): the Initialize event carries the starting price.
      // Walk back in chunks; pools are created shortly before their first position, so this stays short.
      try {
        for (let to = block, n = 0; to > 0 && n < 50 && !val; n++) {
          const from = Math.max(0, to - CHUNK + 1);
          const logs = await getLogs({ address: poolManager, topics: [INIT_TOPIC, poolId], fromBlock: from, toBlock: to });
          if (logs.length) {
            const ev = MOD_IFACE.parseLog(logs[logs.length - 1]);
            val = { sqrtPriceX96: ev.args.sqrtPriceX96, source: `pool initialize ${block - logs[logs.length - 1].blockNumber} blocks earlier` };
          }
          to = from - 1;
        }
      } catch {}
    }
    priceCache.set(k, val);
    return val;
  }

  // The owner collecting through the PositionManager (liquidityDelta 0):
  // amounts are the ERC-20 transfers out of the PoolManager in that tx; a
  // native ETH leg leaves no log and is recorded as unknown. The wallet is the
  // position's owner at that block, else the transfer recipient.
  const ownerCollectsSeen = () => {
    try { return new Set(JSON.parse(fs.readFileSync(OWNER_COLLECTS, "utf8")).map((r) => `${r.tx}:${r.tokenId}`)); } catch { return new Set(); }
  };
  async function recordOwnerCollect({ id, block, tx, poolId }) {
    const key = `${tx}:v4-${id}`;
    if (ownerCollectsSeen().has(key)) return;
    let rows = [];
    try { rows = JSON.parse(fs.readFileSync(OWNER_COLLECTS, "utf8")); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    const rcpt = await provider.getTransactionReceipt(tx).catch(() => null);
    const pk = await poolKeyOf(id);
    let t0 = null, t1 = null;
    if (pk) {
      const [c0, c1] = await Promise.all([v4.getCurrency(pk.currency0, provider), v4.getCurrency(pk.currency1, provider)]).catch(() => [null, null]);
      if (c0 && c1) { t0 = { address: c0.address, symbol: c0.symbol, decimals: Number(c0.decimals) }; t1 = { address: c1.address, symbol: c1.symbol, decimals: Number(c1.decimals) }; }
    }
    let fee0 = 0n, fee1 = 0n, recipient = null, nativeLeg = null;
    if (rcpt) {
      for (const l of rcpt.logs) {
        if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
        const from = `0x${l.topics[1].slice(26)}`.toLowerCase();
        if (from !== pmLower) continue;
        const to = ethers.getAddress(`0x${l.topics[2].slice(26)}`);
        const amt = BigInt(l.data);
        recipient = recipient || to;
        if (t0 && l.address.toLowerCase() === t0.address.toLowerCase()) fee0 += amt;
        else if (t1 && l.address.toLowerCase() === t1.address.toLowerCase()) fee1 += amt;
      }
    }
    if (t0 && t0.address === ethers.ZeroAddress) nativeLeg = "fee0 unknown (native ETH leaves no log)";
    if (t1 && t1.address === ethers.ZeroAddress) nativeLeg = "fee1 unknown (native ETH leaves no log)";
    let wallet = null;
    try { wallet = await posm.ownerOf(BigInt(id), { blockTag: block }); } catch { try { wallet = await posm.ownerOf(BigInt(id)); } catch { wallet = recipient; } }
    if (!wallet) wallet = recipient;
    rows.push({
      block, t: await blockTime(block), tx, tokenId: `v4-${id}`,
      fee0: fee0.toString(), fee1: fee1.toString(), principal: false,
      wallet: wallet ? String(wallet).toLowerCase() : null, walletLabel: null,
      t0, t1, src: "owner-modify", poolId, note: nativeLeg || undefined,
    });
    rows.sort((a, b) => a.block - b.block);
    try {
      const tmp = OWNER_COLLECTS + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(rows));
      fs.renameSync(tmp, OWNER_COLLECTS);
      log(`ledger-v4: #${id} owner collect at block ${block} recorded${nativeLeg ? " (" + nativeLeg + ")" : ""}`);
    } catch (err) {
      log(`ledger-v4: could not write v4-owner-collects.json: ${err.message}`);
    }
  }

  async function ingest(logs, idSet) {
    for (const l of logs) {
      if (l.topics[0] === TRANSFER_TOPIC) {
        // A mint is an ERC-721 Transfer from the zero address; the id is topic 3.
        if (l.topics[1] !== ethers.ZeroHash || l.topics.length < 4) continue;
        const id = BigInt(l.topics[3]).toString();
        if (!idSet.has(id)) continue;
        const e = entry(id);
        if (e.mint == null) log(`ledger-v4: #${id} minted at block ${l.blockNumber}; its history is complete`);
        e.mint = l.blockNumber;
        continue;
      }
      if (l.topics[0] !== MOD_TOPIC) continue;
      const ev = MOD_IFACE.parseLog(l);
      const id = BigInt(ev.args.salt).toString();
      if (!idSet.has(id)) continue;
      const e = entry(id);
      const k = `${l.transactionHash}:${l.index}`;
      if (e.events.some((x) => x.k === k)) continue;

      const liqDelta = ev.args.liquidityDelta; // int256, signed
      const type = liqDelta >= 0n ? "inc" : "dec";
      const liq = liqDelta < 0n ? -liqDelta : liqDelta;
      const poolId = ev.args.id; // the event's own id is authoritative (the manager zeroes a closed position's key)
      if (!e.poolId) e.poolId = poolId;

      if (liq === 0n) {
        await recordOwnerCollect({ id, block: l.blockNumber, tx: l.transactionHash, poolId }).catch((err) => log(`ledger-v4: owner collect #${id}: ${err.message}`));
        continue;
      }

      let a0 = "0", a1 = "0", priced = false, priceSource = null;
      const px = await sqrtPriceAt(poolId, l.blockNumber);
      if (px && px.sqrtPriceX96) {
        try {
          const sqrtLower = u.getSqrtRatioAtTick(Number(ev.args.tickLower));
          const sqrtUpper = u.getSqrtRatioAtTick(Number(ev.args.tickUpper));
          const { amount0, amount1 } = u.getAmountsForLiquidity(px.sqrtPriceX96, sqrtLower, sqrtUpper, liq);
          a0 = amount0.toString();
          a1 = amount1.toString();
          priced = true;
          priceSource = px.source;
        } catch {}
      }
      e.events.push({
        k, block: l.blockNumber, t: await blockTime(l.blockNumber), tx: l.transactionHash,
        type, liq: liq.toString(), a0, a1, priced, priceSource, poolId,
        tickLower: Number(ev.args.tickLower), tickUpper: Number(ev.args.tickUpper),
      });
    }
  }

  // topic1 = pool ids (OR-list; null = any pool when none are known yet), topic2 = the PositionManager.
  const posmTopic = ethers.zeroPadValue(posmAddress, 32);
  const filterFor = (poolIds) => [MOD_TOPIC, poolIds && poolIds.length ? poolIds : null, posmTopic];

  let fwdBusy = false;
  let fwdCaughtUp = false;

  async function scanForward(ids, upTo) {
    if (fwdBusy || !ids.length || !(upTo > state.fwd)) return;
    fwdBusy = true;
    try {
      const idSet = new Set(ids.map(String));
      const poolIds = await knownPoolIds(idSet);
      const modTopics = filterFor(poolIds);
      let from = state.fwd + 1;
      while (from <= upTo) {
        const to = Math.min(from + CHUNK - 1, upTo);
        const [modLogs, mintLogs] = await Promise.all([
          getLogs({ address: poolManager, topics: modTopics, fromBlock: from, toBlock: to }),
          getLogs({ address: posmAddress, topics: [TRANSFER_TOPIC, ethers.ZeroHash], fromBlock: from, toBlock: to }),
        ]);
        await ingest([...modLogs, ...mintLogs], idSet);
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

  function pendingBack(openIds) {
    return openIds.map(String).filter((id) => {
      const e = entry(id);
      return e.mint == null && (e.back == null || e.back >= 0);
    });
  }

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
        const poolIds = await knownPoolIds(new Set(group));
        const modTopics = filterFor(poolIds);
        const [modLogs, mintLogs] = await Promise.all([
          getLogs({ address: poolManager, topics: modTopics, fromBlock: from, toBlock: to }),
          getLogs({ address: posmAddress, topics: [TRANSFER_TOPIC, ethers.ZeroHash], fromBlock: from, toBlock: to }),
        ]);
        await ingest([...modLogs, ...mintLogs], new Set(group));
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

  /** Deposit/withdraw basis in the v3 ledger's shape; null until the mint is known or if any row is unpriced. */
  function basis(id) {
    const e = state.tokens[String(id)];
    if (!e || e.mint == null) return null;
    let dep0 = 0n, dep1 = 0n, wd0 = 0n, wd1 = 0n, liq = 0n, increases = 0, firstT = null, unpriced = 0;
    for (const ev of e.events) {
      if (!ev.priced) unpriced++;
      if (ev.type === "inc") {
        dep0 += BigInt(ev.a0); dep1 += BigInt(ev.a1); liq += BigInt(ev.liq); increases++;
        if (firstT == null || (ev.t && ev.t < firstT)) firstT = ev.t;
      } else {
        wd0 += BigInt(ev.a0); wd1 += BigInt(ev.a1); liq -= BigInt(ev.liq);
      }
    }
    if (unpriced) return null; // an unpriced add would understate the deposit; better no basis than a wrong one
    return { dep0: dep0.toString(), dep1: dep1.toString(), wd0: wd0.toString(), wd1: wd1.toString(), liq: liq.toString(), firstT, increases, source: "rpc-v4" };
  }

  return {
    scanForward, scanBack, basis, pendingBack,
    get forwardCaughtUp() { return fwdCaughtUp; },
    get forwardBlock() { return state.fwd; },
    get scanning() { return fwdBusy || backBusy; },
    get state() { return state; },
  };
}

module.exports = { create };
