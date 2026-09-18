"use strict";
/**
 * Every v4 position a wallet on this instance has held, open or not, with the
 * status the chain gives it:
 *
 *   open         the wallet owns it and it holds liquidity
 *   closed       the wallet owns it and its liquidity is zero
 *   burned       the NFT no longer exists (verified: see univ4.verifyGone)
 *   transferred  someone else owns it now — it may still hold liquidity for them,
 *                so it is not "closed"
 *   unavailable  a read failed; the reason is kept, nothing is guessed
 *
 * The ids come from each wallet's v4 discovery (Transfer-to-wallet logs), plus the
 * ids discovery has tombstoned, so a position that left the wallet keeps its
 * identity for historical accounting. Pair, fee, range and hooks come from the
 * position manager; once read they are kept, because a burned position no longer
 * answers.
 *
 * Refreshes run in the background (bounded, one at a time) and persist to the
 * instance's data directory; requests only read the saved view.
 *
 * Discovery completeness: a discovery sweep that has not reached block 0 may have
 * missed older positions. The position manager's deployment block is found once
 * (binary search on eth_getCode, archive reads) — a sweep that reaches it has
 * seen every Transfer the manager ever emitted, so it is complete.
 */
const fs = require("fs");
const { ethers } = require("ethers");

const ZERO = ethers.ZeroAddress;

function create({ provider, cfg, posm, v4, getToken, wallets, discoveryFor, remember = () => {}, file, log = console, now = () => Date.now() }) {
  const posmAddr = String(cfg.contracts.v4.positionManager).toLowerCase();
  const chainId = Number(cfg.chainId);
  let state = { v: 1, at: 0, entries: {}, deployBlock: null, deployCheckedAt: 0, times: {} };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(file, "utf8")) }; } catch {}
  const save = () => {
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (err) { log.error(`position registry: could not save: ${err.message}`); }
  };
  const lc = (a) => (a == null ? null : String(a).toLowerCase());
  const keyOf = (wallet, id) => `${chainId}:${posmAddr}:${id}:${lc(wallet)}`;

  async function blockTime(n) {
    if (n == null) return null;
    if (state.times[n] != null) return state.times[n];
    try { const b = await provider.getBlock(n); if (b) state.times[n] = b.timestamp * 1000; } catch {}
    return state.times[n] ?? null;
  }

  /** The position manager's deployment block, or null when it cannot be established. */
  async function deployBlock() {
    if (state.deployBlock != null) return state.deployBlock;
    if (now() - state.deployCheckedAt < 6 * 3600 * 1000) return null;
    state.deployCheckedAt = now();
    try {
      const head = await provider.getBlockNumber();
      const has = async (b) => (await provider.getCode(posmAddr, b)) !== "0x";
      if (!(await has(head))) return null;
      let lo = 0, hi = head;                     // invariant: no code at lo-1 is unknown; code at hi
      if (await has(0)) { state.deployBlock = 0; save(); return 0; }
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (await has(mid)) hi = mid; else lo = mid;
      }
      state.deployBlock = hi;
      save();
      return hi;
    } catch (err) {
      // No archive state (or a refusal): completeness then rests on the sweep alone.
      log.error(`position registry: deployment block of ${posmAddr} not found: ${err.shortMessage || err.message}`);
      return null;
    }
  }

  async function tokenInfo(address) {
    if (!address) return null;
    if (lc(address) === ZERO) {
      const n = v4.nativeToken(cfg);
      return { address: ZERO, symbol: n.symbol, decimals: n.decimals, native: true };
    }
    const t = await getToken(address);
    return { address: lc(address), symbol: t.symbol, decimals: t.decimalsOk === true ? t.decimals : null };
  }

  /**
   * The block a token id was minted in. v4 ids are issued in sequence, so the
   * first block whose nextTokenId is above the id is its mint. Archive reads; null
   * when they are refused.
   */
  const seq = new ethers.Contract(posmAddr, ["function nextTokenId() view returns (uint256)"], provider);
  async function mintBlockOf(id) {
    try {
      const head = await provider.getBlockNumber();
      const above = async (b) => BigInt(await seq.nextTokenId({ blockTag: b })) > BigInt(id);
      if (!(await above(head))) return null;
      let lo = Math.max(0, (state.deployBlock ?? 1) - 1), hi = head;   // not minted at lo (or unknown), minted at hi
      if (await above(lo)) return lo;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (await above(mid)) hi = mid; else lo = mid;
      }
      return hi;
    } catch (err) {
      log.error(`position registry: mint block of #${id} not found: ${err.shortMessage || err.message}`);
      return null;
    }
  }
  /** Pair, fee, range and hooks, read at `blockTag` (a burned position answers only in the past). */
  async function describe(e, id, blockTag) {
    const { key, info } = await posm.getPoolAndPositionInfo(BigInt(id), blockTag != null ? { blockTag } : {});
    if (!key || !key.currency1 || lc(key.currency1) === ZERO) return false;
    const { tickLower, tickUpper } = v4.unpackInfo(info);
    const [t0, t1] = await Promise.all([tokenInfo(key.currency0), tokenInfo(key.currency1)]);
    Object.assign(e, { token0: t0, token1: t1, pair: `${t0.symbol} / ${t1.symbol}`, fee: Number(key.fee),
      tickSpacing: Number(key.tickSpacing), hooks: lc(key.hooks), tickLower, tickUpper, poolId: v4.poolIdOf(key) });
    return true;
  }

  async function classify(wallet, label, id, prev) {
    const e = { ...(prev || {}), key: keyOf(wallet, id), chainId, positionManager: posmAddr, protocol: "v4",
      tokenId: String(id), wallet: lc(wallet), walletLabel: label || null, checkedAt: now() };
    let owner = null, ownerErr = null;
    try { owner = lc(await posm.ownerOf(BigInt(id))); } catch (err) { ownerErr = err; }
    if (ownerErr) {
      let gone = null;
      try { gone = await v4.verifyGone({ provider, posm, cfg }, BigInt(id), ownerErr); } catch {}
      if (gone && gone.gone) {
        // Seen for the first time already burned: read what it was at its mint.
        if (!e.token0) {
          const mb = await mintBlockOf(id);
          if (mb != null) { try { await describe(e, id, mb); e.mintBlock = mb; } catch {} }
        }
        return { ...e, status: "burned", statusReason: `the NFT no longer exists (${gone.reason})`, liquidity: "0", currentOwner: null,
          ...(e.token0 ? {} : { pairReason: "burned before this instance read it, and its pool could not be read from archive state" }) };
      }
      return { ...e, status: "unavailable", statusReason: `the owner could not be read: ${(gone && gone.reason) || ownerErr.shortMessage || ownerErr.message}`, currentOwner: null };
    }
    e.currentOwner = owner;
    try {
      await describe(e, id, null);
    } catch (err) {
      if (!e.token0) return { ...e, status: "unavailable", statusReason: `the position's pool could not be read: ${err.shortMessage || err.message}` };
    }
    if (owner !== lc(wallet)) {
      return { ...e, status: "transferred", statusReason: `owned by ${owner} now; it may still hold liquidity for that owner`, liquidity: null };
    }
    try {
      const L = await posm.getPositionLiquidity(BigInt(id));
      e.liquidity = L.toString();
      return L === 0n
        ? { ...e, status: "closed", statusReason: "owned by this wallet with zero liquidity" }
        : { ...e, status: "open", statusReason: "owned by this wallet and holding liquidity" };
    } catch (err) {
      return { ...e, status: "unavailable", statusReason: `the position's liquidity could not be read: ${err.shortMessage || err.message}`, liquidity: null };
    }
  }

  let inFlight = null;
  /** Re-read every known position of every wallet. Single-flight; never throws. */
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      await deployBlock();
      for (const w of wallets()) {
        const disc = discoveryFor(w.address);
        if (!disc) continue;
        const ids = new Set([...disc.ids].map(String));
        for (const id of Object.keys(disc.tombstones || {})) ids.add(String(id));
        for (const e of Object.values(state.entries)) if (e.wallet === lc(w.address)) ids.add(e.tokenId);
        for (const id of ids) {
          const k = keyOf(w.address, id);
          try {
            const e = await classify(w.address, w.label, id, state.entries[k]);
            state.entries[k] = e;
            if (e.token0 && e.token1) remember(id, { token0: e.token0.address, token1: e.token1.address, owner: e.wallet });
          } catch (err) {
            log.error(`position registry: #${id} for ${w.address}: ${err.shortMessage || err.message}`);
          }
        }
      }
      state.at = now();
      save();
      return state.at;
    })().catch((err) => { log.error(`position registry: refresh failed: ${err.message}`); return null; })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  /** Discovery completeness per wallet, judged against the manager's deployment. */
  function discoveryStatus(address) {
    const disc = discoveryFor(address);
    if (!disc) return null;
    const st = disc.status;
    const dep = state.deployBlock;
    const reachedDeploy = dep != null && st.scannedFrom != null && st.scannedFrom <= dep;
    return { ...st, complete: !!(st.complete || reachedDeploy), deployBlock: dep, reachedDeploy };
  }

  return {
    refresh,
    blockTime,
    discoveryStatus,
    get at() { return state.at; },
    get inFlight() { return !!inFlight; },
    get deployBlock() { return state.deployBlock; },
    /** Saved entries for the given wallets (lowercase addresses), newest id first. */
    entries(walletSet) {
      return Object.values(state.entries)
        .filter((e) => !walletSet || walletSet.has(e.wallet))
        .sort((a, b) => (BigInt(b.tokenId) > BigInt(a.tokenId) ? 1 : -1));
    },
    save,
  };
}

module.exports = { create };
