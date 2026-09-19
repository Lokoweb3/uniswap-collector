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

const msgOf = (e) => String((e && (e.shortMessage || e.message)) || e || "unknown").slice(0, 200);
const DYNAMIC_FEE_FLAG = 0x800000;
const MASK256 = (1n << 256n) - 1n;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const CHUNK = 2000; // the smallest getLogs window we will ask any RPC for
const MAX_SPAN = 5_000_000; // the widest; quartered down to CHUNK when refused

// The chain's native currency, from explicit configuration only.
//
// It is NOT the pricing numeraire. They coincide on Arc, where both are USDC, and
// that coincidence is not a rule: on Robinhood the numeraire is WETH while the
// native asset is ether. Taking one for the other gets the identity wrong and
// would get the decimals wrong on any chain where they differ.
//
// With no `chain.nativeCurrency` configured the native token is unverified, and
// every accounting path refuses it rather than assuming 18-decimal ether.
const NATIVE_UNVERIFIED = {
  address: ethers.ZeroAddress, symbol: "native", decimals: null, decimalsOk: false,
  decimalsError: "no chain.nativeCurrency is configured, so the native asset's decimals are unknown",
};
function nativeToken(cfg) {
  const n = cfg && cfg.nativeCurrency;
  if (n && Number.isInteger(n.decimals) && n.decimals >= 0 && n.decimals <= 36 && n.symbol) {
    return { address: ethers.ZeroAddress, symbol: String(n.symbol), decimals: n.decimals, decimalsOk: true, fromSettings: true };
  }
  return NATIVE_UNVERIFIED;
}
const NATIVE = NATIVE_UNVERIFIED; // kept for callers that only want the address/shape

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

async function getCurrency(address, provider, cfg = null) {
  return address === ethers.ZeroAddress ? nativeToken(cfg) : u.getToken(address, provider, cfg && cfg.chainId);
}

/** Build the full picture for one v4 position, in univ3.loadPosition's shape. */
/**
 * Did this token really cease to exist, or did the RPC simply not answer?
 *
 * Positive evidence only, and all of it has to line up:
 *   - the provider is on the chain this instance is configured for;
 *   - there is a position manager at that address on this chain;
 *   - ownerOf refuses a second time, because one refusal is one endpoint's
 *     opinion and two endpoints disagreeing is a reason to do nothing;
 *   - the manager reports an empty pool key for the id, which is what a burned
 *     v4 position leaves behind and a live one never does.
 *
 * Anything else — an empty response, a transport failure, a revert nothing
 * corroborates, a chain or address mismatch — returns gone:false with a reason,
 * and the caller reports the read as unavailable instead of dropping the id.
 */
async function verifyGone({ provider, posm, cfg }, tokenId, firstError) {
  const id = BigInt(tokenId);
  const no = (reason) => ({ gone: false, reason });

  if (cfg && cfg.chainId != null) {
    let seen;
    try {
      seen = (await provider.getNetwork()).chainId;
    } catch (e) {
      return no(`could not confirm the chain before judging #${id}: ${msgOf(e)}`);
    }
    if (BigInt(seen) !== BigInt(cfg.chainId)) {
      return no(`refusing to judge #${id} against chain ${seen}; this instance is configured for ${cfg.chainId}`);
    }
  }

  const addr = posm && (posm.target || posm.address);
  if (addr && provider && typeof provider.getCode === "function") {
    let code;
    try {
      code = await provider.getCode(addr);
    } catch (e) {
      return no(`could not read the position manager's code: ${msgOf(e)}`);
    }
    if (!code || code === "0x") {
      return no(`no position manager at ${addr} on this chain, so #${id} cannot be judged`);
    }
  }

  // Both ownership reads have to be the manager's own refusal — a revert that
  // carried data back from the contract. An empty response, a timeout, a 429 or
  // a dead socket is the transport failing, and says nothing about the token.
  const first = nonexistentEvidence(firstError, cfg);
  if (!first.ok) return no(`#${id}: ${first.why}`);

  try {
    await posm.ownerOf(id);
    return no(`#${id} answered ownerOf on a second read, so it is not gone`);
  } catch (e) {
    const second = nonexistentEvidence(e, cfg);
    if (!second.ok) return no(`#${id}: the second ownership read ${second.why}`);
  }

  // The manager's own account of the id, and it has to be a read that succeeded
  // and decoded. A missing or undecodable field is not an empty pool key.
  let r;
  try {
    r = await posm.getPoolAndPositionInfo(id);
  } catch (e) {
    return no(`#${id} refused ownerOf twice but its pool key could not be read: ${msgOf(e)}`);
  }
  const key = r && (r.key !== undefined ? r.key : r[0]);
  if (!key) return no(`#${id}: the pool key read returned nothing to decode`);
  const c0 = key.currency0 !== undefined ? key.currency0 : key[0];
  const c1 = key.currency1 !== undefined ? key.currency1 : key[1];
  const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  if (!ADDRESS.test(String(c0)) || !ADDRESS.test(String(c1))) {
    return no(`#${id}: the pool key did not decode to two addresses, so it proves nothing`);
  }
  const ZERO = "0x" + "0".repeat(40);
  if (String(c0).toLowerCase() !== ZERO || String(c1).toLowerCase() !== ZERO) {
    return no(`#${id} refused ownerOf but still has a pool key, so it is not confirmed gone`);
  }
  return { gone: true, reason: `#${id}: the manager refused ownerOf twice and decoded an empty pool key` };
}

/**
 * Is this error the position manager saying the token does not exist, or is it
 * the plumbing failing? Only the first may condemn a position.
 *
 * The distinguishing fact is mechanical, not textual: a contract that reverts
 * sends data back, and ethers surfaces it as a CALL_EXCEPTION carrying `data`
 * (or a decoded `revert`). A call that came back empty has data null — that is
 * ethers' "missing revert data" — and a timeout or a 5xx never reaches the
 * contract at all. Message text is used only to exclude, never to condemn.
 */
/**
 * The only errors that mean "this token does not exist".
 *
 * Read off the deployed managers rather than assumed: on 2026-09-16 the v4
 * PositionManager and the v3 NonfungiblePositionManager on both Arc (5042) and
 * Robinhood (4663) answer ownerOf for an unminted id with Error(string) carrying
 * "NOT_MINTED" — solmate's ERC721. The OpenZeppelin spellings are listed too so a
 * future deployment on a different base is recognised rather than mistaken for
 * something unknown, and settings can add to the list for a manager that uses
 * neither.
 *
 * Anything outside this list is not identified, and an unidentified revert leaves
 * the position unavailable. An encoded revert is not evidence merely for being
 * encoded: a manager can revert for many reasons that have nothing to do with the
 * token existing.
 */
const ERROR_STRING_SELECTOR = "0x08c379a0"; // Error(string)
const NONEXISTENT_STRINGS = new Set([
  "NOT_MINTED",                                 // solmate — what both deployed managers use
  "ERC721: invalid token ID",                   // OpenZeppelin v4
  "ERC721: owner query for nonexistent token",  // OpenZeppelin v3
]);
const NONEXISTENT_SELECTORS = new Map([
  [ethers.id("ERC721NonexistentToken(uint256)").slice(0, 10), "ERC721NonexistentToken(uint256), OpenZeppelin v5"],
  [ethers.id("InvalidTokenId(uint256)").slice(0, 10), "InvalidTokenId(uint256)"],
]);

/**
 * Is this error one of the recognised nonexistent-token answers, from the
 * manager itself? Transport failures and empty responses are excluded first,
 * because they never reached the contract; then the payload has to be one we
 * can name. Message text is used to exclude and to match an exact known string,
 * never to condemn on a resemblance.
 */
function nonexistentEvidence(err, cfg) {
  if (!err) return { ok: false, why: "there was no error to judge" };

  const code = err.code || (err.info && err.info.code) || "";
  if (/TIMEOUT|NETWORK_ERROR|SERVER_ERROR|UNKNOWN_ERROR|CONNECTION/i.test(String(code))) {
    return { ok: false, why: `was a transport failure (${code}), not the contract answering` };
  }
  if (/timeout|econnre|socket|network|rate limit|429|503|502|504/i.test(msgOf(err))) {
    return { ok: false, why: `looks like a transport failure: ${msgOf(err)}` };
  }
  if (String(code) !== "CALL_EXCEPTION") {
    return { ok: false, why: `was not a contract revert (code ${code || "none"})` };
  }

  const raw = err.data !== undefined && err.data !== null
    ? err.data
    : err.info && err.info.error && err.info.error.data;
  const data = typeof raw === "string" && /^0x[0-9a-fA-F]*$/.test(raw) ? raw : null;
  if (!data || data === "0x") {
    return { ok: false, why: "came back with no revert data, so the call was never answered" };
  }

  const extra = (cfg && cfg.contracts && cfg.contracts.v4 && cfg.contracts.v4.nonexistentReverts) || [];
  const allowedStrings = new Set([...NONEXISTENT_STRINGS, ...extra.filter((x) => !/^0x/i.test(x))]);
  const allowedSelectors = new Map([
    ...NONEXISTENT_SELECTORS,
    ...extra.filter((x) => /^0x[0-9a-fA-F]{8}$/.test(x)).map((x) => [x.toLowerCase(), "from settings"]),
  ]);

  const selector = data.slice(0, 10).toLowerCase();
  if (selector === ERROR_STRING_SELECTOR) {
    let reason = null;
    try {
      reason = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10))[0];
    } catch {
      return { ok: false, why: "reverted with an Error(string) that would not decode" };
    }
    if (allowedStrings.has(reason)) return { ok: true, why: `the manager reverted with ${reason}` };
    return { ok: false, why: `reverted with "${reason}", which is not a nonexistent-token error` };
  }

  if (allowedSelectors.has(selector)) {
    return { ok: true, why: `the manager reverted with ${allowedSelectors.get(selector)}` };
  }
  return { ok: false, why: `reverted with an unrecognised error ${selector}, so the token cannot be judged` };
}


async function loadPosition(ctx, tokenId) {
  const { provider, posm, stateView, cfg } = ctx;
  const id = BigInt(tokenId);

  // A position is only "gone" when the chain says so, verified. Never inferred
  // from error prose: "revert", "missing revert data", a timeout and a dead
  // endpoint all arrive as text, vary by RPC vendor and ethers version, and the
  // consequence here is irreversible — watch.js drops the id from discovery.
  // Anything short of a verified answer is an unavailable read, and the id stays.
  let owner = null, ownerErr = null;
  try {
    owner = await posm.ownerOf(id);
  } catch (err) {
    ownerErr = err;
  }

  if (ownerErr) {
    const v = await verifyGone({ provider, posm, cfg }, id, ownerErr);
    if (v.gone) return { tokenId: id.toString(), gone: true, verified: true, goneReason: v.reason };
    const e = new Error(v.reason);
    e.unverified = true;
    e.cause = ownerErr;
    e.shortMessage = v.reason;
    throw e;
  }

  // An owner that is not ours is the one case the chain answers directly.
  if (owner.toLowerCase() !== cfg.ownerAddress.toLowerCase()) {
    return { tokenId: id.toString(), gone: true, verified: true, goneReason: `owned by ${owner}` };
  }

  // v4 pays fees out whenever liquidity changes, so an empty position owes
  // nothing: zero liquidity is closed, full stop.
  const liquidity = await posm.getPositionLiquidity(id);
  if (liquidity === 0n) return { tokenId: id.toString(), closed: true };

  const { key, info } = await posm.getPoolAndPositionInfo(id);
  const { tickLower, tickUpper } = unpackInfo(info);
  const poolId = poolIdOf(key);

  const [t0, t1, slot0] = await Promise.all([
    getCurrency(key.currency0, provider, cfg),
    getCurrency(key.currency1, provider, cfg),
    stateView.getSlot0(poolId),
  ]);

  // Every amount below is scaled by these decimals. If either was not read from
  // the chain there is no honest figure to produce, so the position is reported
  // unavailable with the reason rather than valued on a guess. The id is kept:
  // this is a failed read, not a position that stopped existing.
  for (const [side, t] of [["token0", t0], ["token1", t1]]) {
    if (!t || t.decimalsOk !== true) {
      const e = new Error(
        `#${id}: ${side} decimals were not read from the chain` +
          (t && t.decimalsError ? ` (${t.decimalsError})` : "") +
          ", so amounts, fees and values cannot be computed"
      );
      e.unverified = true;
      e.shortMessage = e.message;
      throw e;
    }
  }

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

    // --- a state with no floor ----------------------------------------------
    // lastScanned set and scannedFrom null: a first run that read the head but never
    // recorded how far back it reached, or state written before that field existed.
    // The backfill below is guarded by `scannedFrom > 0`, which is false for null,
    // so discovery could never resume and never report complete -- every wallet on
    // this instance had been stuck there, with the page saying an older position
    // could not be ruled out. Re-establish the floor from what was scanned.
    if (!state.complete && state.scannedFrom == null && state.lastScanned > 0) {
      const r = await sweepBack(state.lastScanned, Math.max(1, maxChunks));
      if (r.coveredFrom <= state.lastScanned) state.scannedFrom = r.coveredFrom;
      state.complete = r.complete;
      if (r.error) state.lastError = r.error;
      save();
      return !!state.complete && state.lastScanned >= latest;
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
    /**
     * Stop asking about an id, without losing that it existed. The identity is
     * kept with the reason and a timestamp so a wrong call can be undone and so
     * anyone can see what was dropped and why. Only ever called for a verified
     * gone: see verifyGone().
     */
    forget(id, reason) {
      const k = String(id);
      if (!ids.delete(k)) return false;
      state.gone = state.gone || {};
      state.gone[k] = { at: Date.now(), reason: String(reason || "verified gone").slice(0, 200) };
      save();
      return true;
    },
    /** Put a tombstoned id back into discovery. */
    restore(id) {
      const k = String(id);
      if (!state.gone || !state.gone[k]) return false;
      delete state.gone[k];
      ids.add(k);
      save();
      return true;
    },
    /** What has been tombstoned, and why. */
    get tombstones() {
      return { ...(state.gone || {}) };
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
  verifyGone,
  nonexistentEvidence,
  NATIVE,
  nativeToken,
  poolIdOf,
  unpackInfo,
  getCurrency,
  loadPosition,
  createDiscovery,
};
