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
const SWAP = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const coder = ethers.AbiCoder.defaultAbiCoder();

// One balance behind two interfaces (Arc's native USDC) emits a Transfer under
// both. The ERC-20 leg is kept; the native pseudo-address is a duplicate.
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_TOPIC = ethers.zeroPadValue(ZERO, 32);
const BLOCK_MS_FALLBACK = 1000;
// Bumped whenever the rules for reading a receipt change. 2: every liquidity
// change counts, only pool-manager <-> owner flows are attributed, shared or
// unattributable payouts are unavailable, a missing receipt fails the chunk.
// 3: principal and value use the pool price at the transaction, not at the end of
// its block (a later swap in the same block moved it).
// 4: principal of an add is rounded up, as the pool rounds it (removals down);
// verified against every fee-free add on Arc, which then reconciles exactly.
const DECODER = 4;

/**
 * Token amounts for a liquidity change, rounded the way v4's SqrtPriceMath does:
 * up for an add (what the pool takes), down for a removal (what it pays).
 */
const Q96 = 1n << 96n;
const divUp = (a, b) => (a % b === 0n ? a / b : a / b + 1n);
function amountsFor(sqrtP, lo, hi, liquidity, roundUp) {
  const a = u.getSqrtRatioAtTick(lo), b = u.getSqrtRatioAtTick(hi);
  const amt0 = (x, y) => {                       // x < y
    const n1 = liquidity << 96n, n2 = y - x;
    return roundUp ? divUp(divUp(n1 * n2, y), x) : (n1 * n2) / y / x;
  };
  const amt1 = (x, y) => (roundUp ? divUp(liquidity * (y - x), Q96) : (liquidity * (y - x)) / Q96);
  if (sqrtP <= a) return { amount0: amt0(a, b), amount1: 0n };
  if (sqrtP < b) return { amount0: amt0(sqrtP, b), amount1: amt1(a, sqrtP) };
  return { amount0: 0n, amount1: amt1(a, b) };
}
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

  let state, loadedMtime = 0;
  function load() {
    try { loadedMtime = fs.statSync(FILE).mtimeMs; } catch { loadedMtime = 0; }
    try { state = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { state = { v: 1, scopes: {} }; }
    if (!state.scopes) state.scopes = {};
  }
  load();

  // One writer per file. Several servers can share a data directory (the main
  // dashboard, a preview, the smoke test); a process that saved its own in-memory
  // copy would overwrite the scanner's progress with a stale one. The scanning
  // process takes `<file>.lock`; while a live process holds it, every other
  // process only reads, and re-reads the file whenever it has changed.
  const LOCK = `${FILE}.lock`;
  let owner = false;
  function lockHolder() {
    let pid;
    try { pid = Number(fs.readFileSync(LOCK, "utf8").trim()); } catch { return null; }
    if (!pid || pid === process.pid) return null;
    try { process.kill(pid, 0); return pid; } catch (e) { return e.code === "EPERM" ? pid : null; }
  }
  function acquireWriter() {
    if (owner) return true;
    const holder = lockHolder();
    if (holder) return false;
    try { fs.unlinkSync(LOCK); } catch {}              // stale: its process is gone
    try { fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" }); } catch { return false; }
    owner = true;
    process.on("exit", () => {
      try { if (Number(fs.readFileSync(LOCK, "utf8")) === process.pid) fs.unlinkSync(LOCK); } catch {}
    });
    if (fs.existsSync(FILE)) load();                   // start from what is on disk now
    return true;
  }
  const foreign = () => !owner && lockHolder() != null;
  function refresh() {
    let m = 0;
    try { m = fs.statSync(FILE).mtimeMs; } catch {}
    if (m && m !== loadedMtime) load();
  }
  const S = () => {
    if (foreign()) refresh();
    const s = (state.scopes[scope] = state.scopes[scope] || { events: {} });
    if (!s.tokens) {
      // Older files kept one cursor for the whole scope, which cannot say which
      // positions were tracked while it moved. Its records stay (they are keyed
      // and deduplicated) but count only once a per-position scan covers them.
      s.tokens = {};
      delete s.scannedFrom; delete s.scannedTo; delete s.fromT; delete s.toT; delete s.complete;
    }
    if (!s.meta) s.meta = {};
    // Records decoded under older rules are not evidence under the current ones:
    // their coverage is dropped (tracked positions are kept) and everything is
    // rescanned. Old records stay keyed and are overwritten as the scan reaches them.
    if (s.decoder !== DECODER) {
      s.tokens = {};
      for (const k of Object.keys(s.events)) if (s.events[k].decoder !== DECODER) delete s.events[k];
      s.decoder = DECODER;
    }
    return s;
  };
  // Written to a temporary file and renamed into place, so a crash or a kill in
  // the middle of a write leaves the previous progress intact, never a torn file
  // that would parse as nothing and restart every scan from the head.
  const save = () => {
    if (foreign()) return;                              // another live process owns the file
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, FILE);
  };

  const blockT = new Map();
  async function blockTime(n) {
    if (blockT.has(n)) return blockT.get(n);
    if (blockT.size > 5000) blockT.clear();     // a long background scan touches many boundaries
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

  /**
   * The pool's price at the moment a log was emitted: the price after the last swap
   * in that pool earlier in the same block (log index order), else the pool's state
   * at the end of the previous block. Reading the log's own block would return the
   * price after every swap in that block, including ones that came later.
   */
  async function priceAtLog(l) {
    const swaps = await provider.getLogs({ address: pm, topics: [SWAP, l.topics[1]], fromBlock: l.blockNumber, toBlock: l.blockNumber });
    const before = swaps.filter((x) => x.index < l.index).sort((a, b) => a.index - b.index);
    if (before.length) return BigInt(coder.decode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], before[before.length - 1].data)[2]);
    return BigInt((await sv.getSlot0(l.topics[1], { blockTag: l.blockNumber - 1 }))[0]);
  }

  const topicAddr = (t) => ("0x" + String(t).slice(26)).toLowerCase();
  const short = (a) => `${a.slice(0, 6)}\u2026${a.slice(-4)}`;

  /**
   * Decode every fee realisation this receipt holds for our manager's tracked
   * positions. A figure is produced only when every token movement in the pair
   * can be attributed; otherwise the record carries `unavailable` and withholds
   * the position's total.
   *
   * v4 realises accrued fees on any liquidity change, so three kinds count:
   *   collect     (delta = 0)  fees = paid out − paid in
   *   withdrawal  (delta < 0)  fees = paid out − paid in − principal removed
   *   increase    (delta > 0)  fees = paid out − paid in + principal added
   *                            (fees are netted against the deposit)
   * The opening deposit (the position's mint is in the same receipt) has no fees
   * and is not a record. Principal comes from |delta| at the pool price read at
   * the transaction (see priceAtLog).
   *
   * Only Transfers between the PoolManager and the owner are attributed. If the
   * pair's tokens also move between the PoolManager and anyone else, or another
   * change in the same transaction could share the payout (same owner and a
   * shared token, or a position whose pair is unknown), the payout cannot be
   * split and the record is unavailable.
   */
  async function claimsInReceipt(receipt, meta, metaAll = meta) {
    const ours = [];
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== pm || l.topics[0] !== MODIFY_LIQUIDITY) continue;
      if (topicAddr(l.topics[2]) !== posm) continue;
      // A log from our manager that cannot be decoded throws: the chunk fails and is
      // retried, instead of the position looking as if nothing happened.
      const [tl, tu, delta, salt] = coder.decode(["int24", "int24", "int256", "bytes32"], l.data);
      ours.push({ l, tl, tu, delta, tokenId: BigInt(salt).toString() });
    }
    const minted = new Set(receipt.logs
      .filter((x) => x.address.toLowerCase() === posm && x.topics[0] === TRANSFER && x.topics.length === 4 && topicAddr(x.topics[1]) === ZERO)
      .map((x) => BigInt(x.topics[3]).toString()));
    const out = [];
    for (const o of ours) {
      const m = meta(o.tokenId);
      if (!m) continue;                               // not a position we track
      if (o.delta > 0n && minted.has(o.tokenId)) continue;   // the opening deposit: no fees yet
      const { l, tl, tu, delta, tokenId } = o;
      const t0 = String(m.token0).toLowerCase(), t1 = String(m.token1).toLowerCase();
      const owner = String(m.owner).toLowerCase();
      const kind = delta < 0n ? "withdrawal" : delta > 0n ? "increase" : "collect";
      let unavailable = null;
      // A native-ETH leg is paid by a value transfer, which emits no log. Reading
      // it as zero would print a verified figure that leaves that leg out.
      if (t0 === ZERO || t1 === ZERO) {
        unavailable = "the native ETH leg is paid by a plain value transfer, which emits no log, so its amount cannot be read from the receipt";
      }
      if (!unavailable) {
        const sharing = ours.filter((x) => x !== o).filter((x) => {
          const mm = metaAll(x.tokenId);
          if (!mm) return true;
          const a0 = String(mm.token0).toLowerCase(), a1 = String(mm.token1).toLowerCase();
          return String(mm.owner).toLowerCase() === owner && [a0, a1].some((t) => t === t0 || t === t1);
        });
        if (sharing.length) {
          unavailable = `this transaction holds ${sharing.length} other liquidity change(s) (${sharing.map((x) => "#" + x.tokenId).join(", ")}) that could share this payout, so it cannot be split between them`;
        }
      }
      const flow = { out: { [t0]: 0n, [t1]: 0n }, in: { [t0]: 0n, [t1]: 0n } };
      const strangers = new Set();
      for (const x of receipt.logs) {
        if (x.topics[0] !== TRANSFER || x.topics.length !== 3) continue;
        const a = x.address.toLowerCase();
        if (NATIVE_PSEUDO.has(a) || (a !== t0 && a !== t1)) continue;
        const from = topicAddr(x.topics[1]), to = topicAddr(x.topics[2]);
        if (from === pm) { if (to === owner) flow.out[a] += BigInt(x.data); else strangers.add(to); }
        else if (to === pm) { if (from === owner) flow.in[a] += BigInt(x.data); else strangers.add(from); }
      }
      if (!unavailable && strangers.size) {
        unavailable = `the pair's tokens also moved between the pool manager and ${[...strangers].map(short).join(", ")}, not this position's owner, so the payout cannot be attributed`;
      }
      // The pool price at this block: needed to separate principal, and kept on
      // every record so it can be valued at the price of its moment.
      let sqrtP = null;
      if (sv && !unavailable) {
        try { sqrtP = await priceAtLog(l); if (!(sqrtP > 0n)) throw new Error("the pool had no price yet"); } catch (err) {
          sqrtP = null;
          if (delta !== 0n) unavailable = `the pool price at block ${l.blockNumber} could not be read (${err.shortMessage || err.message})`;
        }
      }
      if (delta !== 0n && !unavailable && !sv) unavailable = "no StateView: principal cannot be separated from fees";
      let p0 = 0n, p1 = 0n, fee0 = null, fee1 = null;
      if (!unavailable) {
        if (delta !== 0n) {
          const amt = amountsFor(sqrtP, Number(tl), Number(tu), delta < 0n ? -delta : delta, delta > 0n);
          p0 = amt.amount0; p1 = amt.amount1;
        }
        const sign = delta < 0n ? -1n : delta > 0n ? 1n : 0n;
        const fee = (t, p) => flow.out[t] - flow.in[t] + sign * p;
        let f0 = fee(t0, p0), f1 = fee(t1, p1);
        // Principal uses the pool's own rounding direction, so a fee-free change
        // reconciles exactly; one unit of slack is kept for a price exactly on a
        // range edge. Anything more negative means the flows do not fit the model.
        if (f0 < -1n || f1 < -1n) {
          unavailable = `the token flows (${flow.out[t0]}/${flow.out[t1]} out, ${flow.in[t0]}/${flow.in[t1]} in) do not match a ${kind} of this size, so fees cannot be separated`;
        } else {
          fee0 = f0 < 0n ? 0n : f0; fee1 = f1 < 0n ? 0n : f1;
        }
      }
      // An increase that realised nothing is a deposit, not a claim.
      if (kind === "increase" && !unavailable && fee0 === 0n && fee1 === 0n) continue;
      out.push({
        key: `${receipt.hash}:${l.index}`, tokenId, chainId: Number(chainId), positionManager: posm,
        block: l.blockNumber, tx: receipt.hash, kind, verified: true, poolId: l.topics[1],
        sqrtP: sqrtP == null ? null : sqrtP.toString(),
        fee0: unavailable ? null : fee0.toString(), fee1: unavailable ? null : fee1.toString(),
        principal0: p0.toString(), principal1: p1.toString(),
        paidOut0: flow.out[t0].toString(), paidOut1: flow.out[t1].toString(),
        paidIn0: flow.in[t0].toString(), paidIn1: flow.in[t1].toString(),
        token0: t0, token1: t1, unavailable, decoder: DECODER,
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
  async function scan(meta, { ids = null, chunk = 9000, budget = 12, floor = null, lookbackMs = null, forward = true } = {}) {
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
      // Every change counts — adds realise fees too. A log that cannot be decoded
      // or a receipt the RPC does not return fails the chunk, so the cursor never
      // moves past a transaction that was not read.
      const byTx = new Set();
      for (const l of logs) {
        const [, , , salt] = coder.decode(["int24", "int24", "int256", "bytes32"], l.data);
        if (needs(BigInt(salt).toString(), l.blockNumber)) byTx.add(l.transactionHash);
      }
      for (const h of byTx) {
        const r = await provider.getTransactionReceipt(h);
        if (!r) throw new Error(`the RPC returned no receipt for ${h}; this chunk is retried`);
        for (const c of await claimsInReceipt(r, (id) => (want.has(id) ? meta(id) : null), meta)) {
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
    while (forward && chunks < budget) {
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
    const lag = tracked.length ? head - Math.min(...tracked.map((id) => T(id).to)) : 0;
    return { chunks, folded, floor, blockMs: ms, lag, pending: tracked.filter((id) => !done(T(id))).length };
  }

  /**
   * Remember what the scanner needs for a position (pair and owner), persisted
   * with the progress so a restarted process can resume before any card renders.
   */
  function remember(tokenId, m) {
    if (!m || !m.token0 || !m.token1 || !m.owner) return;
    const s = S(), id = String(tokenId);
    const next = { token0: String(m.token0).toLowerCase(), token1: String(m.token1).toLowerCase(), owner: String(m.owner).toLowerCase() };
    const cur = s.meta[id];
    if (cur && cur.token0 === next.token0 && cur.token1 === next.token1 && cur.owner === next.owner) return;
    s.meta[id] = next;
    save();
  }
  /** The persisted pair and owner for a position, or null. */
  function metaOf(tokenId) { return S().meta[String(tokenId)] || null; }
  /** Every position this scope has been asked to track. */
  function knownIds() { return Object.keys(S().meta); }

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
    // `t` is when the price was observed: the block time for a pool read at the
    // transaction, the hour for the price log.
    if (e && px && isFinite(px.p0) && isFinite(px.p1)) e.px = { p0: +px.p0, p1: +px.p1, src: String(px.src || "unknown"), t: px.t ?? null };
  }

  /** Where one position's history stands; shared by the card summary and /api/claims. */
  // A position's history is whole only when its own mint was observed inside the
  // scanned interval. No other source of an opening block is accepted.
  function coverage(tokenId) {
    const s = S();
    const t = s.tokens[String(tokenId)];
    if (!t || t.from > t.to) return null;
    const opened = t.mint;
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
      lookbackDays: s.lookbackMs ? +(s.lookbackMs / 86400000).toFixed(2) : null,
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
  /**
   * Where a position's claim history stands, as one explicit state:
   *   not-scanned       no block range has been scanned for it yet
   *   undecodable       a relevant event in the scanned range could not be read or
   *                     attributed; no figure is given (takes precedence)
   *   scanning          the scan has not reached the verified mint yet
   *   lookback-reached  the configured lookback floor was reached without finding
   *                     the mint, so lifetime history is incomplete
   *   complete          the scan covers the verified mint and every event decoded
   */
  function claimState(cov, bad) {
    if (!cov) return "not-scanned";
    if (bad) return "undecodable";
    if (cov.coversOpening) return "complete";
    return cov.reachedLookbackFloor ? "lookback-reached" : "scanning";
  }

  function summary(tokenId, { dec0, dec1, sym0, sym1, usd0, usd1 }) {
    const sc = { chainId: Number(chainId), positionManager: posm, tokenId: String(tokenId) };
    const cov = coverage(tokenId);
    if (!cov) {
      return { status: "unavailable", state: "not-scanned", verifiedZero: false,
        reason: "no block range has been scanned for this position yet", scope: sc };
    }
    const mine = rows(tokenId);
    const bad = mine.filter((e) => e.unavailable);
    if (bad.length) {
      return { status: "unavailable", state: claimState(cov, true), verifiedZero: false, scope: sc, coverage: cov,
        reason: `${bad.length} of ${mine.length} records in the scanned range cannot be read in full (${bad[0].unavailable}); a total would be a guess` };
    }
    let a0 = 0n, a1 = 0n, last = null, withdrawals = 0, usd = 0, atClaim = 0, atToday = 0, unpriced = 0;
    const srcs = new Set();
    const priceSources = { block: 0, pricelog: 0, today: 0, none: 0 };
    for (const e of mine) {
      const r0 = BigInt(e.fee0 || "0"), r1 = BigInt(e.fee1 || "0");
      a0 += r0; a1 += r1;
      const x0 = Number(ethers.formatUnits(r0, dec0)), x1 = Number(ethers.formatUnits(r1, dec1));
      if (e.px) { usd += x0 * e.px.p0 + x1 * e.px.p1; atClaim++; srcs.add(e.px.src); priceSources[e.px.src === "pricelog" ? "pricelog" : "block"]++; }
      else if (usd0 != null && usd1 != null) { usd += x0 * usd0 + x1 * usd1; atToday++; priceSources.today++; }
      else { unpriced++; priceSources.none++; }
      if (e.kind === "withdrawal") withdrawals++;
      if (e.t && (!last || e.t > last)) last = e.t;
    }
    const f0 = Number(ethers.formatUnits(a0, dec0)), f1 = Number(ethers.formatUnits(a1, dec1));
    const usdBasis = !mine.length ? null : unpriced ? null : !atToday ? "at-claim" : !atClaim ? "today" : "mixed";
    const basis = !mine.length ? "token amounts are exact from chain"
      : unpriced ? `token amounts are exact from chain; ${unpriced} of ${mine.length} collections have no price at their time and a leg has no price today, so there is no USD total`
      : usdBasis === "at-claim" ? `token amounts are exact from chain; USD is valued at each claim's own moment (${[priceSources.block ? `${priceSources.block} at the pool price at the transaction` : "", priceSources.pricelog ? `${priceSources.pricelog} from the hourly price log` : ""].filter(Boolean).join(", ")})`
      : usdBasis === "today" ? "token amounts are exact from chain; no price of their moment was found, so USD is valued at today's prices"
      : `token amounts are exact from chain; ${atClaim} of ${mine.length} collections are valued at their own moment's price, ${atToday} at today's`;
    const state = claimState(cov, false);
    const complete = state === "complete";
    return {
      status: complete ? "ok" : "partial",
      state,
      // Zero is a finding only when the whole life was scanned and read.
      verifiedZero: complete && a0 === 0n && a1 === 0n,
      ...(cov.gap ? { reason: cov.gap } : {}),
      since: cov.coversOpening ? (cov.openedT ?? cov.fromT) : cov.fromT,
      count: mine.length, last, withdrawals,
      scope: sc,
      tokens: [{ symbol: sym0, amount: f0.toLocaleString("en-US", { maximumFractionDigits: 6 }) },
               { symbol: sym1, amount: f1.toLocaleString("en-US", { maximumFractionDigits: 6 }) }],
      raw0: a0.toString(), raw1: a1.toString(),
      // Nothing found in an incomplete range is not a $0 floor worth printing.
      // Full precision: rounding to cents here turned $0.0361 into "$0.040" on the card.
      usd: !mine.length ? (complete ? 0 : null) : unpriced ? null : +usd.toPrecision(12),
      usdBasis, usdAtClaim: atClaim, usdAtToday: atToday, priceSources,
      ...(unpriced ? { usdMissing: `${unpriced} collection(s) have no price at their time and a leg has no price today` } : {}),
      principalSeparated: withdrawals > 0,
      coverage: cov,
      basis,
    };
  }

  return { scan, rows, summary, coverage, setPrice, save, remember, metaOf, knownIds, acquireWriter,
    /** True while another live process owns the file: read it, never write it. */
    get readOnly() { return foreign(); }, get scope() { return scope; }, get state() { return S(); } };
}

module.exports = { create, amountsFor, MODIFY_LIQUIDITY, TRANSFER, SWAP, NATIVE_PSEUDO, ZERO, DECODER };
