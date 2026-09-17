"use strict";
/**
 * Claimed-fee records derived from chain, stored per instance, keyed by
 * (chainId, positionManager, tokenId).
 *
 * Identity. A record's scope is part of what was *observed*, not something added
 * afterwards from config. The ModifyLiquidity log carries all of it: the chain is
 * the RPC we asked, `sender` is the position manager, `salt` is the token id. A
 * row from the older tokenId-only ledgers cannot be given that scope
 * retroactively — nothing in it says which chain or manager it came from — so it
 * is kept as `verified: false` and never contributes to a displayed figure.
 *
 * Deduplication. Every record is keyed by `${txHash}:${logIndex}` of its
 * ModifyLiquidity log, which is unique on a chain. Re-scanning a range, or
 * restarting mid-scan, rewrites the same keys instead of appending, so totals
 * cannot inflate.
 *
 * Progress. Each tracked position has its own contiguous `[from, to]` interval,
 * persisted to the instance's own data directory. A position that starts being
 * tracked later has seen none of the blocks scanned before it, so one shared
 * cursor would claim coverage it never had. A cursor only advances after a chunk
 * has been folded, so a failure or a budget cut shortens the interval and never
 * holes it. Coverage timestamps come from those boundary blocks.
 *
 * Opening. The same scan records each position's mint (ERC-721 Transfer from
 * the zero address on the position manager). History covers a position's whole
 * life only when its interval reaches that block — `coversOpening`. Separately,
 * `reachedLookbackFloor` says the scan went as far back as it was configured to;
 * a position older than the lookback reaches the floor without covering its
 * opening, and the two are never reported as the same thing.
 *
 * Block time is measured from two real block timestamps, per chain, never
 * assumed: the lookback floor is a block number derived from it.
 */
const fs = require("fs");
const { ethers } = require("ethers");
const u = require("./univ3");
const { dataPath } = require("./data-dir");

const MODIFY_LIQUIDITY = ethers.id("ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)");
const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const coder = ethers.AbiCoder.defaultAbiCoder();

// One balance behind two interfaces (Arc's native USDC) emits a Transfer under
// both. The ERC-20 leg is kept; the native pseudo-address is a duplicate.
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_TOPIC = ethers.zeroPadValue(ZERO, 32);
const BLOCK_MS_FALLBACK = 1000;
const NATIVE_PSEUDO = new Set([
  "0xfffffffffffffffffffffffffffffffffffffffe",
  "0xffffffffffffffffffffffffffffffffffffffff",
  "0x0000000000000000000000000000000000000000",
]);

function create({ provider, chainId, positionManager, poolManager, stateView, file = null, log = console }) {
  if (!chainId) throw new Error("claims-store needs a chainId");
  if (!positionManager) throw new Error("claims-store needs a position manager");
  if (!poolManager) throw new Error("claims-store needs a pool manager");
  const posm = String(positionManager).toLowerCase();
  const pm = String(poolManager).toLowerCase();
  const scope = `${chainId}:${posm}`;
  const FILE = file || dataPath("claims.json");
  const sv = !stateView ? null
    : typeof stateView === "object" && typeof stateView.getSlot0 === "function" ? stateView
    : new ethers.Contract(stateView, ["function getSlot0(bytes32) view returns (uint160,int24,uint24,uint24)"], provider);

  let state;
  try { state = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { state = { v: 1, scopes: {} }; }
  if (!state.scopes) state.scopes = {};
  const S = () => {
    const s = (state.scopes[scope] = state.scopes[scope] || { events: {} });
    if (!s.tokens) {
      // Older files kept one cursor for the whole scope, which cannot say which
      // positions were tracked while it moved. Its records stay (they are keyed
      // and deduplicated) but count only once a per-position scan covers them.
      s.tokens = {};
      delete s.scannedFrom; delete s.scannedTo; delete s.fromT; delete s.toT; delete s.complete;
    }
    return s;
  };
  const save = () => fs.writeFileSync(FILE, JSON.stringify(state));

  const blockT = new Map();
  async function blockTime(n) {
    if (blockT.has(n)) return blockT.get(n);
    let t = null;
    try { const b = await provider.getBlock(n); t = b ? b.timestamp * 1000 : null; } catch {}
    blockT.set(n, t);
    return t;
  }

  /** Milliseconds per block on this chain, measured once from two real blocks. */
  let blockMs = null;
  async function measureBlockMs(head) {
    if (blockMs) return blockMs;
    const back = Math.min(100000, Math.max(1, head - 1));
    const [a, b] = await Promise.all([blockTime(head), blockTime(head - back)]);
    if (a == null || b == null || !(a > b)) return null;   // unmeasured: not cached, retried next scan
    blockMs = (a - b) / back;
    return blockMs;
  }

  /** Decode every claim this receipt holds for our manager. */
  async function claimsInReceipt(receipt, meta) {
    const out = [];
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== pm || l.topics[0] !== MODIFY_LIQUIDITY) continue;
      if (("0x" + l.topics[2].slice(26)).toLowerCase() !== posm) continue;
      const [tl, tu, delta, salt] = coder.decode(["int24", "int24", "int256", "bytes32"], l.data);
      if (delta > 0n) continue;                       // a mint or an add is not a claim
      const tokenId = BigInt(salt).toString();
      const m = meta(tokenId);
      if (!m) continue;                               // not a position we track
      const t0 = String(m.token0).toLowerCase(), t1 = String(m.token1).toLowerCase();
      const owner = String(m.owner).toLowerCase();
      const paid = { [t0]: 0n, [t1]: 0n };
      for (const x of receipt.logs) {
        if (x.topics[0] !== TRANSFER || x.topics.length !== 3) continue;
        const a = x.address.toLowerCase();
        if (NATIVE_PSEUDO.has(a) || (a !== t0 && a !== t1)) continue;
        if (("0x" + x.topics[2].slice(26)).toLowerCase() !== owner) continue;
        paid[a] += BigInt(x.data);
      }
      let fee0 = paid[t0], fee1 = paid[t1], p0 = 0n, p1 = 0n, kind = delta < 0n ? "withdrawal" : "collect", unavailable = null, sqrtP = null;
      // A native-ETH leg is paid by a value transfer, which emits no log. Reading
      // it as zero would print a verified figure that leaves that leg out.
      if (t0 === ZERO || t1 === ZERO) {
        unavailable = "the native ETH leg is paid by a plain value transfer, which emits no log, so its amount cannot be read from the receipt";
      }
      // The pool price at this block: needed to separate principal on a withdrawal,
      // and kept on every record so it can be valued at the price of its moment.
      if (sv && !unavailable) {
        try { sqrtP = BigInt((await sv.getSlot0(l.topics[1], { blockTag: l.blockNumber }))[0]); } catch (err) {
          if (delta < 0n) unavailable = `the pool price at block ${l.blockNumber} could not be read (${err.shortMessage || err.message})`;
        }
      }
      if (delta < 0n && !unavailable) {
        if (!sv) unavailable = "no StateView: principal cannot be separated from fees";
        else {
          const a = u.getAmountsForLiquidity(sqrtP,
            u.getSqrtRatioAtTick(Number(tl)), u.getSqrtRatioAtTick(Number(tu)), -delta);
          p0 = a.amount0; p1 = a.amount1;
          fee0 = paid[t0] > p0 ? paid[t0] - p0 : 0n;
          fee1 = paid[t1] > p1 ? paid[t1] - p1 : 0n;
        }
      }
      out.push({
        key: `${receipt.hash}:${l.index}`, tokenId, chainId: Number(chainId), positionManager: posm,
        block: l.blockNumber, tx: receipt.hash, kind, verified: true, poolId: l.topics[1],
        sqrtP: sqrtP == null ? null : sqrtP.toString(),
        fee0: unavailable ? null : fee0.toString(), fee1: unavailable ? null : fee1.toString(),
        principal0: p0.toString(), principal1: p1.toString(),
        token0: t0, token1: t1, unavailable,
      });
    }
    return out;
  }

  /**
   * Extend each tracked position's interval forward to the head, then backwards
   * until it reaches the position's mint or the lookback floor, under one chunk
   * budget. `meta(tokenId)` supplies the pair and owner; `ids` lists the positions
   * to track. The floor is `floor` when given, else `lookbackMs` converted to
   * blocks with this chain's measured block time.
   */
  async function scan(meta, { ids = null, chunk = 9000, budget = 12, floor = null, lookbackMs = null } = {}) {
    const s = S();
    const head = await provider.getBlockNumber();
    const ms = await measureBlockMs(head);
    if (floor == null) {
      if (lookbackMs == null) floor = 0;
      // An unmeasured block time must not become a guessed floor: fall back to the
      // previous floor, or a conservative one that reaches less far, never further.
      else floor = Math.max(0, head - Math.ceil(lookbackMs / (ms || BLOCK_MS_FALLBACK)));
    }
    const tracked = [...new Set((ids || Object.keys(s.tokens)).map(String))].filter((id) => meta(id));
    for (const id of tracked) if (!s.tokens[id]) s.tokens[id] = { from: head + 1, to: head, mint: null, fromT: null, toT: null };
    const T = (id) => s.tokens[id];
    let folded = 0, chunks = 0;

    // Fold [from, to] for the positions in `want` (id -> lowest/highest block that
    // position still needs inside this range). Mints are recorded for the same set.
    const range = async (from, to, want) => {
      const needs = (id, block) => { const w = want.get(id); return !!w && block >= w.lo && block <= w.hi; };
      const [logs, mints] = await Promise.all([
        provider.getLogs({ address: pm, topics: [MODIFY_LIQUIDITY, null, ethers.zeroPadValue(posm, 32)], fromBlock: from, toBlock: to }),
        provider.getLogs({ address: posm, topics: [TRANSFER, ZERO_TOPIC], fromBlock: from, toBlock: to }),
      ]);
      for (const l of mints) {
        if (l.topics.length !== 4 || l.address.toLowerCase() !== posm) continue;
        const id = BigInt(l.topics[3]).toString();
        if (want.has(id) && (T(id).mint == null || l.blockNumber < T(id).mint)) T(id).mint = l.blockNumber;
      }
      // `salt` is in the log data, so the token id is readable without a receipt.
      // Only transactions touching a position we track are worth a receipt fetch —
      // this manager serves every position on the chain, and fetching a receipt per
      // transaction made a single 9,000-block chunk take minutes.
      const byTx = new Set();
      for (const l of logs) {
        try {
          const [, , delta, salt] = coder.decode(["int24", "int24", "int256", "bytes32"], l.data);
          if (delta > 0n) continue;
          if (needs(BigInt(salt).toString(), l.blockNumber)) byTx.add(l.transactionHash);
        } catch {}
      }
      for (const h of byTx) {
        const r = await provider.getTransactionReceipt(h);
        if (!r) continue;
        for (const c of await claimsInReceipt(r, (id) => (want.has(id) ? meta(id) : null))) {
          c.t = await blockTime(c.block);
          const prev = s.events[c.key];
          // keyed by tx:logIndex — a rescan overwrites; a price already fixed for
          // this record's block stays with it.
          if (prev && prev.px && prev.sqrtP === c.sqrtP) c.px = prev.px;
          s.events[c.key] = c;
          folded++;
        }
      }
    };

    // Forward first, so the newest claims appear soonest.
    while (chunks < budget) {
      const lag = tracked.filter((id) => T(id).to < head);
      if (!lag.length) break;
      const from = Math.min(...lag.map((id) => T(id).to)) + 1;
      const to = Math.min(from + chunk - 1, head);
      const want = new Map(lag.filter((id) => T(id).to < to).map((id) => [id, { lo: T(id).to + 1, hi: to }]));
      await range(from, to, want);
      for (const id of want.keys()) T(id).to = to;
      chunks++; save();
    }
    // Then backwards, each position until its mint or the floor.
    const done = (t) => (t.mint != null ? t.from <= t.mint : t.from <= floor);
    while (chunks < budget) {
      const pending = tracked.filter((id) => !done(T(id)));
      if (!pending.length) break;
      const to = Math.max(...pending.map((id) => T(id).from)) - 1;
      const from = Math.max(floor, to - chunk + 1);
      const want = new Map(pending.filter((id) => T(id).from > from).map((id) => [id, { lo: from, hi: T(id).from - 1 }]));
      await range(from, to, want);
      for (const id of want.keys()) T(id).from = from;
      chunks++; save();
    }
    for (const id of tracked) {
      const t = T(id);
      if (t.from <= t.to) { t.fromT = await blockTime(t.from); t.toT = await blockTime(t.to); }
      if (t.mint != null) t.mintT = await blockTime(t.mint);
    }
    s.floor = floor; s.head = head; s.blockMs = ms; s.lookbackMs = lookbackMs;
    save();
    return { chunks, folded, floor, blockMs: ms, pending: tracked.filter((id) => !done(T(id))).length };
  }

  /** Every verified record for one position inside its scanned interval, oldest first. */
  function rows(tokenId) {
    const s = S();
    const t = s.tokens[String(tokenId)];
    if (!t) return [];
    return Object.values(s.events)
      .filter((e) => e.tokenId === String(tokenId) && e.chainId === Number(chainId) && e.positionManager === posm)
      .filter((e) => e.block >= t.from && e.block <= t.to)
      .sort((a, b) => a.block - b.block);
  }

  /** Attach the USD prices of a record's own moment. `px` = { p0, p1, src }. */
  function setPrice(key, px) {
    const e = S().events[key];
    if (e && px && isFinite(px.p0) && isFinite(px.p1)) e.px = { p0: +px.p0, p1: +px.p1, src: String(px.src || "unknown") };
  }

  /** Where one position's history stands; shared by the card summary and /api/claims. */
  function coverage(tokenId, openedBlock = null) {
    const s = S();
    const t = s.tokens[String(tokenId)];
    if (!t || t.from > t.to) return null;
    const opened = t.mint != null ? t.mint : openedBlock;
    const coversOpening = opened != null && t.from <= opened;
    const reachedLookbackFloor = s.floor != null && t.from <= s.floor;
    let gap = null;
    if (!coversOpening) {
      const days = s.lookbackMs >= 86400000 ? Math.round(s.lookbackMs / 86400000) : null;
      gap = reachedLookbackFloor
        ? `this position opened before the ${days ? days + "-day " : ""}lookback window, so claims before ${t.fromT ? new Date(t.fromT).toISOString().slice(0, 10) : "block " + t.from} are not included`
        : "the scan has not yet reached the block this position was opened in";
    }
    return {
      fromBlock: t.from, toBlock: t.to, fromT: t.fromT, toT: t.toT,
      openedBlock: opened ?? null, openedT: t.mint != null ? t.mintT ?? null : null,
      coversOpening, reachedLookbackFloor, floorBlock: s.floor ?? null,
      blockMs: s.blockMs ?? null, gap,
    };
  }

  /**
   * The card's figure. A number is produced only from verified records inside the
   * scanned interval; anything else is stated, never approximated.
   *
   * USD. A record carrying `px` is valued at the prices of its own block or hour;
   * one without it falls back to today's prices, and the summary says how many of
   * each. A record with neither makes the total null, with `usdMissing` saying why —
   * distinct from a total that simply has not been priced.
   */
  function summary(tokenId, { dec0, dec1, sym0, sym1, usd0, usd1, openedBlock = null }) {
    const sc = { chainId: Number(chainId), positionManager: posm, tokenId: String(tokenId) };
    const cov = coverage(tokenId, openedBlock);
    if (!cov) {
      return { status: "unavailable", reason: "no block range has been scanned for this position yet", scope: sc };
    }
    const mine = rows(tokenId);
    const bad = mine.filter((e) => e.unavailable);
    if (bad.length) {
      return { status: "unavailable", scope: sc, coverage: cov,
        reason: `${bad.length} of ${mine.length} records cannot be read in full (${bad[0].unavailable}); a total would be a guess` };
    }
    let a0 = 0n, a1 = 0n, last = null, withdrawals = 0, usd = 0, atClaim = 0, atToday = 0, unpriced = 0;
    const srcs = new Set();
    for (const e of mine) {
      const r0 = BigInt(e.fee0 || "0"), r1 = BigInt(e.fee1 || "0");
      a0 += r0; a1 += r1;
      const x0 = Number(ethers.formatUnits(r0, dec0)), x1 = Number(ethers.formatUnits(r1, dec1));
      if (e.px) { usd += x0 * e.px.p0 + x1 * e.px.p1; atClaim++; srcs.add(e.px.src); }
      else if (usd0 != null && usd1 != null) { usd += x0 * usd0 + x1 * usd1; atToday++; }
      else unpriced++;
      if (e.kind === "withdrawal") withdrawals++;
      if (e.t && (!last || e.t > last)) last = e.t;
    }
    const f0 = Number(ethers.formatUnits(a0, dec0)), f1 = Number(ethers.formatUnits(a1, dec1));
    const usdBasis = !mine.length ? null : unpriced ? null : !atToday ? "at-claim" : !atClaim ? "today" : "mixed";
    const basis = !mine.length ? "token amounts are exact from chain"
      : unpriced ? `token amounts are exact from chain; ${unpriced} of ${mine.length} collections have no price at their time and a leg has no price today, so there is no USD total`
      : usdBasis === "at-claim" ? "token amounts are exact from chain; USD is valued at the price of each collection's own block or hour"
      : usdBasis === "today" ? "token amounts are exact from chain; no price of their moment was found, so USD is valued at today's prices"
      : `token amounts are exact from chain; ${atClaim} of ${mine.length} collections are valued at their own moment's price, ${atToday} at today's`;
    return {
      status: cov.coversOpening ? "ok" : "partial",
      ...(cov.gap ? { reason: cov.gap } : {}),
      since: cov.coversOpening ? (cov.openedT ?? cov.fromT) : cov.fromT,
      count: mine.length, last, withdrawals,
      scope: sc,
      tokens: [{ symbol: sym0, amount: f0.toLocaleString("en-US", { maximumFractionDigits: 6 }) },
               { symbol: sym1, amount: f1.toLocaleString("en-US", { maximumFractionDigits: 6 }) }],
      raw0: a0.toString(), raw1: a1.toString(),
      usd: !mine.length ? 0 : unpriced ? null : +usd.toFixed(2),
      usdBasis, usdAtClaim: atClaim, usdAtToday: atToday,
      ...(unpriced ? { usdMissing: `${unpriced} collection(s) have no price at their time and a leg has no price today` } : {}),
      principalSeparated: withdrawals > 0,
      coverage: cov,
      basis,
    };
  }

  return { scan, rows, summary, coverage, setPrice, save, get scope() { return scope; }, get state() { return S(); } };
}

module.exports = { create, MODIFY_LIQUIDITY, TRANSFER, NATIVE_PSEUDO, ZERO };
