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
// 5: every event is attributed to the NFT's owner AT that event (from the
// position's Transfer history), not to whoever tracks it now; the history of
// transfers and liquidity changes is kept per position.
// 6: the capital side is kept too — a mint deposit or a fee-free add is stored
// with `capitalOnly`, so a position's deposits and withdrawals (each at the price
// of its own transaction) can be read back. They are never claims: the claim
// summary, its count and its verified zero ignore them.
// 7: the pool price behind a liquidity change is read from the swap that set it
// rather than from pruned archive state, so records previously refused as
// "the pool price at block N could not be read" are worth decoding again.
// 8: a payout is attributed when the pool manager pays the owner OR an address
// collecting on the owner's behalf (the configured operator), and a native leg's
// amount is read from the transaction's internal transfers instead of being refused
// outright. Both were needed together: this collector takes fees to its operator and
// sweeps them to the owner, so every collector-run settlement looked like a payment
// to a stranger, and on the native side there was no amount to attribute anyway.
// 9: the position manager is an accepted counterparty in a transaction the owner or a
// collector sent. It is how a native leg is paid in (msg.value -> position manager ->
// pool manager), so every native increase was refused as a payment by a stranger.
const DECODER = 9;

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

/**
 * How a fee settlement left the pool: "collect" for an explicit collect (a zero
 * liquidity change), "liquidity" for the fees v4 settles as a side effect of adding
 * or removing liquidity. Every record is one or the other.
 */
function actionOf(e) {
  return e.kind === "collect" ? "collect" : "liquidity";
}
const newAct = () => ({ count: 0, raw0: 0n, raw1: 0n, hist: 0, priced: 0, unpriced: 0 });
// Same rule as the whole: a USD total only when every record in it is priced.
function actOut(a, dec0, dec1, sym0, sym1) {
  const f = (raw, dec) => Number(ethers.formatUnits(raw, dec)).toLocaleString("en-US", { maximumFractionDigits: 6 });
  return { count: a.count, raw0: a.raw0.toString(), raw1: a.raw1.toString(),
    tokens: [{ symbol: sym0, amount: f(a.raw0, dec0) }, { symbol: sym1, amount: f(a.raw1, dec1) }],
    usd: !a.count ? 0 : a.unpriced ? null : +a.hist.toPrecision(12),
    usdPricedSubtotal: +a.hist.toPrecision(12), pricedRecords: a.priced, unpricedRecords: a.unpriced };
}

function create({ provider, chainId, positionManager, poolManager, stateView, file = null, log = console, maxLogRange = null, priceSearchRequests = 24, collectors = [], internalTransfers = null }) {
  if (!chainId) throw new Error("claims-store needs a chainId");
  if (!positionManager) throw new Error("claims-store needs a position manager");
  if (!poolManager) throw new Error("claims-store needs a pool manager");
  const posm = String(positionManager).toLowerCase();
  const pm = String(poolManager).toLowerCase();
  // Addresses that receive a payout on the owner's behalf -- this collector's operator.
  // A settlement it runs sends the fees to the operator, which sweeps them to the owner,
  // so without this every collector-run collect read as a payment to an unrelated party
  // and was refused. They are the owner's own agents, named in settings, not strangers.
  const COLLECTORS = new Set((collectors || []).filter(Boolean).map((a) => String(a).toLowerCase()));
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
      s.nft = {};
      s.liq = {};
      for (const k of Object.keys(s.events)) if (s.events[k].decoder !== DECODER) delete s.events[k];
      s.decoder = DECODER;
    }
    if (!s.nft) s.nft = {};      // tokenId -> { "tx:logIndex": { block, index, from, to, tx } }
    if (!s.liq) s.liq = {};      // tokenId -> { "tx:logIndex": { block, index, delta, tx } }
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

  const sqrtOfSwap = (x) => BigInt(coder.decode(["int128", "int128", "uint160", "uint128", "int24", "uint24"], x.data)[2]);
  // Memoised per exact (pool, block) question. It deliberately does NOT reuse "the
  // last swap before block B" as an answer for a later block: swaps may have
  // happened in between, and returning the older one would hand back a stale price
  // that silently mis-splits principal from fees. A wrong price is worse than a slow
  // scan, and worse than no answer at all.
  const lastSwapCache = new Map();

  /**
   * The most recent swap in a pool strictly before `block`, by walking backwards in
   * spans. In v4 only a swap moves the price -- a liquidity change does not, and nor
   * does a donation -- so the price it leaves behind is still the pool's price when
   * the log we care about was emitted. Exact, not an approximation.
   */
  async function lastSwapBefore(poolId, block) {
    const key = `${poolId}:${block}`;
    if (lastSwapCache.has(key)) return lastSwapCache.get(key);
    let to = block - 1;
    let span = Math.max(100, Number(maxLogRange) || 50000);
    for (let reqs = 0; reqs < priceSearchRequests && to > 0; ) {
      const from = Math.max(0, to - span + 1);
      let logs;
      try {
        logs = await provider.getLogs({ address: pm, topics: [SWAP, poolId], fromBlock: from, toBlock: to });
        reqs++;
      } catch (err) {
        // A refused span says nothing about the range; it says the range was too
        // wide. Narrow it and try the same ground again.
        reqs++;
        if (span <= 100) throw err;
        span = Math.max(100, Math.floor(span / 4));
        continue;
      }
      if (logs.length) {
        // Within a span, the last log is the latest swap: getLogs returns them in
        // block then index order.
        const last = logs[logs.length - 1];
        const found = { block: last.blockNumber, sqrt: sqrtOfSwap(last) };
        lastSwapCache.set(key, found);
        return found;
      }
      if (from === 0) break;
      to = from - 1;
    }
    lastSwapCache.set(key, null);   // searched and not found: do not search again
    return null;
  }

  /**
   * The pool's price at the moment a log was emitted: the price after the last swap
   * in that pool earlier in the same block (log index order), else after the last
   * swap before that block, else the pool's state at the end of the previous block.
   * Reading the log's own block would return the price after every swap in that
   * block, including ones that came later.
   *
   * The state read is last, not first, because it is the one that needs an archive
   * node. This chain's RPC has pruned: getSlot0 at an old block answers "missing
   * revert data", which made every liquidity change whose principal had to be
   * separated undecodable -- forty-two of forty-three records on one position, and
   * most of the claim history on the page. Logs are kept where state is not, and
   * the swap that set the price is in them.
   */
  async function priceAtLog(l) {
    const poolId = l.topics[1];
    const swaps = await provider.getLogs({ address: pm, topics: [SWAP, poolId], fromBlock: l.blockNumber, toBlock: l.blockNumber });
    const before = swaps.filter((x) => x.index < l.index).sort((a, b) => a.index - b.index);
    if (before.length) return sqrtOfSwap(before[before.length - 1]);
    const prior = await lastSwapBefore(poolId, l.blockNumber).catch(() => null);
    if (prior) return prior.sqrt;
    return BigInt((await sv.getSlot0(poolId, { blockTag: l.blockNumber - 1 }))[0]);
  }

  const topicAddr = (t) => ("0x" + String(t).slice(26)).toLowerCase();
  const posmRead = new ethers.Contract(posm, ["function ownerOf(uint256) view returns (address)"], provider);
  const after = (a, b) => a.block > b.block || (a.block === b.block && a.index > b.index);

  /**
   * Who owned `tokenId` when the log at (block, index) was emitted. The first
   * recorded NFT transfer after that point names it (its `from`); with no later
   * transfer the owner is today's, read from chain at the scan head. Transfers
   * after an event are always recorded before the event is decoded: scans run
   * from the head backwards, and a chunk's transfers are folded before its
   * receipts. Returns null only when the owner cannot be established.
   */
  function ownerAtFactory(s, headOwners, head) {
    return async function ownerAt(tokenId, block, index) {
      const id = String(tokenId);
      const later = Object.values(s.nft[id] || {}).filter((x) => after(x, { block, index }))
        .sort((a, b) => a.block - b.block || a.index - b.index);
      if (later.length) return later[0].from;
      if (!headOwners.has(id)) {
        let who = null;
        try { who = String(await posmRead.ownerOf(BigInt(id), { blockTag: head })).toLowerCase(); } catch (err) {
          // A token with no later transfer still exists (a burn is a transfer), so a
          // failed read is an RPC problem: fail the chunk and retry, never guess.
          throw new Error(`ownerOf(#${id}) at block ${head} could not be read (${err.shortMessage || err.message}); this chunk is retried`);
        }
        headOwners.set(id, who);
      }
      return headOwners.get(id);
    };
  }
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
  async function claimsInReceipt(receipt, meta, metaAll = meta, ownerAt = null) {
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
      // The opening deposit realises no fees, but it is the position's first capital.
      const { l, tl, tu, delta, tokenId } = o;
      const t0 = String(m.token0).toLowerCase(), t1 = String(m.token1).toLowerCase();
      // The owner at this event, not whoever tracks the position now: a previous
      // owner's settlements are theirs.
      const owner = ownerAt ? await ownerAt(tokenId, l.blockNumber, l.index) : String(m.owner).toLowerCase();
      const kind = delta < 0n ? "withdrawal" : delta > 0n ? "increase" : "collect";
      let unavailable = null;
      const nativeLeg = t0 === ZERO || t1 === ZERO;
      // A native leg is paid by a plain value transfer, which emits no log, so the
      // receipt alone cannot say how much moved -- and reading it as zero would print a
      // verified figure with that leg silently missing. The amounts are in the
      // transaction's internal transfers; with a resolver they are read from there and
      // attributed exactly like a token transfer, and without one the record stays
      // unavailable as it was. A transport failure is NOT an answer: it throws, failing
      // the chunk so the cursor does not advance, rather than freezing a blip into a
      // permanent "cannot be read" on a record that would never be revisited.
      let nativeMoves = null;
      if (nativeLeg) {
        if (!internalTransfers) {
          unavailable = "the native ETH leg is paid by a plain value transfer, which emits no log, and no internal-transfer source is configured for this chain, so its amount cannot be read";
        } else {
          nativeMoves = await internalTransfers(receipt.hash);
          if (!Array.isArray(nativeMoves)) {
            throw new Error(`internal transfers for ${receipt.hash} were unreadable; this chunk is retried`);
          }
        }
      }
      if (!unavailable && !owner) unavailable = "the position's owner at this event could not be established";
      if (!unavailable) {
        const sharing = [];
        for (const x of ours) {
          if (x === o) continue;
          const mm = metaAll(x.tokenId);
          if (!mm) { sharing.push(x); continue; }
          const a0 = String(mm.token0).toLowerCase(), a1 = String(mm.token1).toLowerCase();
          const xo = ownerAt ? await ownerAt(x.tokenId, x.l.blockNumber, x.l.index) : String(mm.owner).toLowerCase();
          if (xo === owner && [a0, a1].some((t) => t === t0 || t === t1)) sharing.push(x);
        }
        if (sharing.length) {
          unavailable = `this transaction holds ${sharing.length} other liquidity change(s) (${sharing.map((x) => "#" + x.tokenId).join(", ")}) that could share this payout, so it cannot be split between them`;
        }
      }
      const flow = { out: { [t0]: 0n, [t1]: 0n }, in: { [t0]: 0n, [t1]: 0n } };
      const strangers = new Set();
      // The owner, or an address collecting for them. Anyone else is a stranger and the
      // payout cannot be attributed to this position.
      //
      // The position manager itself also counts, but only in a transaction the owner or
      // a collector sent. A native leg is paid with the transaction's value: the sender
      // hands ETH to the position manager, which settles it with the pool manager and
      // sweeps any change back. So on every native increase the payer the pool manager
      // sees is the position manager, spending the sender's own msg.value, and treating
      // it as a stranger refused every such deposit. It only ever acts for the account
      // that called it, so when that account is ours, so is the money it moves.
      const sender = String(receipt.from || "").toLowerCase();
      const senderIsOurs = sender === owner || COLLECTORS.has(sender);
      const isOurs = (a) => a === owner || COLLECTORS.has(a) || (a === posm && senderIsOurs);
      // Whether any leg was settled through a collector rather than straight to the
      // owner. Kept on the record: the figure is the owner's either way, but a reader
      // checking it against the wallet should know the money arrived by way of the
      // operator and was swept, not as a direct transfer from the pool.
      let viaCollector = false;
      const credit = (bucket, token, amount, counterparty) => {
        if (!isOurs(counterparty)) { strangers.add(counterparty); return; }
        bucket[token] += amount;
        if (COLLECTORS.has(counterparty)) viaCollector = true;
      };
      for (const x of receipt.logs) {
        if (x.topics[0] !== TRANSFER || x.topics.length !== 3) continue;
        const a = x.address.toLowerCase();
        if (NATIVE_PSEUDO.has(a) || (a !== t0 && a !== t1)) continue;
        const from = topicAddr(x.topics[1]), to = topicAddr(x.topics[2]);
        if (from === pm) credit(flow.out, a, BigInt(x.data), to);
        else if (to === pm) credit(flow.in, a, BigInt(x.data), from);
      }
      // Native value moves, read from the transaction's internal transfers, are
      // attributed by exactly the same rule as a token transfer.
      for (const mv of nativeMoves || []) {
        const v = BigInt(mv.value || 0);
        if (v === 0n) continue;
        const from = String(mv.from || "").toLowerCase(), to = String(mv.to || "").toLowerCase();
        if (from === pm) credit(flow.out, ZERO, v, to);
        else if (to === pm) credit(flow.in, ZERO, v, from);
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
      // An increase that realised nothing is a deposit, not a claim; the mint's own
      // deposit is not one either. Both are kept for the capital history and
      // excluded from every fee figure.
      //
      // A position's own mint realises nothing by definition — its salt is new, so
      // there are no prior fees — and that holds whether or not its price can be
      // read. Only its capital value depends on the price, so an unreadable price
      // leaves the capital unknown and never makes the FEE history undecodable.
      const isMintDeposit = delta > 0n && minted.has(tokenId);
      // The native-leg exclusion held only while a native amount could not be read at
      // all; once the internal transfers resolved, a native mint is as decodable as any
      // other and its fees are zero by the same definition.
      if (isMintDeposit && unavailable && (!nativeLeg || nativeMoves)) { unavailable = null; fee0 = 0n; fee1 = 0n; }
      const capitalOnly = delta > 0n && !unavailable && ((kind === "increase" && fee0 === 0n && fee1 === 0n) || isMintDeposit);
      out.push({
        key: `${receipt.hash}:${l.index}`, tokenId, chainId: Number(chainId), positionManager: posm,
        block: l.blockNumber, tx: receipt.hash, kind, verified: true, poolId: l.topics[1],
        sqrtP: sqrtP == null ? null : sqrtP.toString(),
        fee0: unavailable ? null : fee0.toString(), fee1: unavailable ? null : fee1.toString(),
        principal0: p0.toString(), principal1: p1.toString(), principalKnown: sqrtP != null,
        paidOut0: flow.out[t0].toString(), paidOut1: flow.out[t1].toString(),
        paidIn0: flow.in[t0].toString(), paidIn1: flow.in[t1].toString(),
        token0: t0, token1: t1, owner, unavailable, decoder: DECODER,
        ...(viaCollector && !unavailable ? { viaCollector: true } : {}),
        ...(capitalOnly ? { capitalOnly: true, kind: minted.has(tokenId) ? "deposit" : "increase" } : {}),
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
    const headOwners = new Map();
    const ownerAt = ownerAtFactory(s, headOwners, head);

    // Fold [from, to] for the positions in `want` (id -> lowest/highest block that
    // position still needs inside this range). Mints are recorded for the same set.
    const range = async (from, to, want) => {
      const needs = (id, block) => { const w = want.get(id); return !!w && block >= w.lo && block <= w.hi; };
      // Every NFT transfer of the positions in `want` (mint = from zero, burn = to
      // zero), queried by token id so the chain's other positions cost nothing.
      const idTopics = [...want.keys()].map((id) => ethers.zeroPadValue(ethers.toBeHex(BigInt(id)), 32));
      const nftLogs = [];
      for (let i = 0; i < idTopics.length; i += 50) {
        nftLogs.push(...await provider.getLogs({ address: posm, topics: [TRANSFER, null, null, idTopics.slice(i, i + 50)], fromBlock: from, toBlock: to }));
      }
      const logs = await provider.getLogs({ address: pm, topics: [MODIFY_LIQUIDITY, null, ethers.zeroPadValue(posm, 32)], fromBlock: from, toBlock: to });
      for (const l of nftLogs) {
        if (l.topics.length !== 4 || l.address.toLowerCase() !== posm || l.topics[0] !== TRANSFER) continue;
        const id = BigInt(l.topics[3]).toString();
        if (!want.has(id)) continue;
        const rec = { block: l.blockNumber, index: l.index, from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), tx: l.transactionHash };
        (s.nft[id] = s.nft[id] || {})[`${l.transactionHash}:${l.index}`] = rec;   // keyed: a rescan overwrites
        if (rec.from === ZERO && (T(id).mint == null || l.blockNumber < T(id).mint)) T(id).mint = l.blockNumber;
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
        const [, , delta, salt] = coder.decode(["int24", "int24", "int256", "bytes32"], l.data);
        const id = BigInt(salt).toString();
        if (!needs(id, l.blockNumber)) continue;
        byTx.add(l.transactionHash);
        // The position's full liquidity history, for its closure and current size.
        (s.liq[id] = s.liq[id] || {})[`${l.transactionHash}:${l.index}`] = { block: l.blockNumber, index: l.index, delta: delta.toString(), tx: l.transactionHash };
      }
      for (const h of byTx) {
        const r = await provider.getTransactionReceipt(h);
        if (!r) throw new Error(`the RPC returned no receipt for ${h}; this chunk is retried`);
        for (const c of await claimsInReceipt(r, (id) => (want.has(id) ? meta(id) : null), meta, ownerAt)) {
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

  const lc = (a) => (a == null ? null : String(a).toLowerCase());
  /**
   * Every verified record for one position inside its scanned interval, oldest
   * first. With `wallet`, only the settlements made while that wallet owned the
   * NFT (a record whose owner could not be established is kept: it withholds the
   * figure instead of vanishing).
   */
  function rows(tokenId, wallet = null, { capital = false } = {}) {
    const s = S();
    const t = s.tokens[String(tokenId)];
    if (!t) return [];
    const w = lc(wallet);
    return Object.values(s.events)
      .filter((e) => e.tokenId === String(tokenId) && e.chainId === Number(chainId) && e.positionManager === posm)
      .filter((e) => e.block >= t.from && e.block <= t.to)
      .filter((e) => !w || !e.owner || e.owner === w)
      .filter((e) => (capital ? true : !e.capitalOnly))
      .sort((a, b) => a.block - b.block || String(a.key).localeCompare(String(b.key)));
  }

  /**
   * The position's capital movements for a wallet: what it put in and took out,
   * each with the principal the pool computed and the price at that transaction.
   * Fees are not capital and are not included here.
   */
  function capital(tokenId, wallet = null) {
    return rows(tokenId, wallet, { capital: true })
      .filter((e) => e.capitalOnly || (!e.unavailable && (e.principal0 !== "0" || e.principal1 !== "0")))
      .map((e) => ({ key: e.key, t: e.t ?? null, block: e.block, tx: e.tx,
        direction: e.kind === "withdrawal" ? "out" : "in",
        kind: e.kind, principal0: e.principal0, principal1: e.principal1,
        // A movement whose pool price could not be read has a size on chain but no
        // value here: it is listed, and it makes the capital figures unavailable.
        unpriced: e.principalKnown === false || !e.px,
        sqrtP: e.sqrtP, px: e.px || null, token0: e.token0, token1: e.token1 }));
  }

  /** The position's NFT history inside the scanned interval: mint, transfers, burn. */
  function ownership(tokenId) {
    const s = S();
    const list = Object.values(s.nft[String(tokenId)] || {}).sort((a, b) => a.block - b.block || a.index - b.index);
    return {
      mint: list.find((x) => x.from === ZERO) || null,
      burn: list.find((x) => x.to === ZERO) || null,
      transfers: list,
    };
  }

  /**
   * Liquidity changes inside the scanned interval, and when the position reached
   * zero. The running total is only meaningful from the mint, so `complete` says
   * whether the mint is covered; without it a closure is reported unverified.
   */
  function liquidityHistory(tokenId) {
    const s = S();
    const cov = coverage(tokenId);
    const list = Object.values(s.liq[String(tokenId)] || {}).sort((a, b) => a.block - b.block || a.index - b.index);
    const complete = !!(cov && cov.mintCovered);
    let sum = 0n, closedAt = null;
    for (const e of list) {
      sum += BigInt(e.delta);
      if (BigInt(e.delta) < 0n && sum === 0n) closedAt = { block: e.block, index: e.index, tx: e.tx };
      else if (sum > 0n) closedAt = null;
    }
    // Without the mint, the last removal is the best candidate, unverified.
    if (!complete) {
      const lastRemoval = [...list].reverse().find((e) => BigInt(e.delta) < 0n);
      closedAt = lastRemoval ? { block: lastRemoval.block, index: lastRemoval.index, tx: lastRemoval.tx } : null;
    }
    return { complete, events: list, liquidity: complete ? sum.toString() : null, closedAt: closedAt ? { ...closedAt, verified: complete } : null };
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
  // For a wallet, "opening" is when that wallet received the NFT (its mint, or a
  // transfer in); history before that belongs to someone else.
  function coverage(tokenId, wallet = null) {
    const s = S();
    const t = s.tokens[String(tokenId)];
    if (!t || t.from > t.to) return null;
    const w = lc(wallet);
    const received = w ? ownership(tokenId).transfers.filter((x) => x.to === w) : [];
    const opened = w ? (received.length ? received[0].block : null) : t.mint;
    const mintCovered = t.mint != null && t.from <= t.mint;
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
      openedBlock: opened ?? null, openedT: opened != null && opened === t.mint ? t.mintT ?? null : null,
      openedTx: w ? (received[0] ? received[0].tx : null) : null,
      mintBlock: t.mint ?? null, mintCovered,
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

  function summary(tokenId, { dec0, dec1, sym0, sym1, usd0, usd1, wallet = null }) {
    const w = lc(wallet) || lc((S().meta[String(tokenId)] || {}).owner);
    const sc = { chainId: Number(chainId), positionManager: posm, tokenId: String(tokenId), wallet: w };
    const cov = coverage(tokenId, w);
    if (!cov) {
      return { status: "unavailable", state: "not-scanned", verifiedZero: false,
        reason: "no block range has been scanned for this position yet", scope: sc };
    }
    const mine = rows(tokenId, w);
    const bad = mine.filter((e) => e.unavailable);
    if (bad.length) {
      return { status: "unavailable", state: claimState(cov, true), verifiedZero: false, scope: sc, coverage: cov,
        reason: `${bad.length} of ${mine.length} records in the scanned range cannot be read in full (${bad[0].unavailable}); a total would be a guess` };
    }
    let a0 = 0n, a1 = 0n, last = null, withdrawals = 0, hist = 0, priced = 0, unpriced = 0;
    const priceSources = { block: 0, pricelog: 0, today: 0, none: 0 };
    // The same fees, split by how they left the pool: an explicit collect, or the
    // settlement v4 forces whenever liquidity is added or removed. Both are the
    // owner's fees; the split answers "what did I (or the collector) collect" apart
    // from "what came out because I changed the position".
    const acts = { collect: newAct(), liquidity: newAct() };
    for (const e of mine) {
      const r0 = BigInt(e.fee0 || "0"), r1 = BigInt(e.fee1 || "0");
      a0 += r0; a1 += r1;
      const x0 = Number(ethers.formatUnits(r0, dec0)), x1 = Number(ethers.formatUnits(r1, dec1));
      const act = acts[actionOf(e)];
      act.count++; act.raw0 += r0; act.raw1 += r1;
      // Historical USD only from a verified price of the claim's own moment. A
      // record without one keeps its exact token amounts and simply has no
      // historical value; today's price is never substituted into this figure.
      if (e.px) { const v = x0 * e.px.p0 + x1 * e.px.p1; hist += v; act.hist += v; act.priced++; priced++; priceSources[e.px.src === "pricelog" ? "pricelog" : "block"]++; }
      else { unpriced++; act.unpriced++; priceSources.none++; }
      if (e.kind === "withdrawal") withdrawals++;
      if (e.t && (!last || e.t > last)) last = e.t;
    }
    const f0 = Number(ethers.formatUnits(a0, dec0)), f1 = Number(ethers.formatUnits(a1, dec1));
    const state = claimState(cov, false);
    const complete = state === "complete";
    const usdBasis = !mine.length ? null : unpriced ? (priced ? "partial" : "none") : "at-claim";
    const src = [priceSources.block ? `${priceSources.block} at the pool price at the transaction` : "", priceSources.pricelog ? `${priceSources.pricelog} from the hourly price log` : ""].filter(Boolean).join(", ");
    const basis = !mine.length ? "token amounts are exact from chain"
      : !unpriced ? `token amounts are exact from chain; USD is valued at each claim's own moment (${src}). The pool price is the one that produced the payout, not an independent valuation: other venues' prices for the same token can differ materially.`
      : priced ? `token amounts are exact from chain; ${priced} of ${mine.length} claims have a verified price of their moment (${src}), ${unpriced} have none, so only a priced subtotal is given`
      : "token amounts are exact from chain; no claim has a verified price of its moment, so there is no historical USD figure";
    // Today's prices, as a separate, labelled figure over ALL verified amounts.
    const usdCurrent = mine.length && usd0 != null && usd1 != null
      ? { usd: +(f0 * usd0 + f1 * usd1).toPrecision(12), note: "all claimed token amounts at today's prices; not what they were worth when claimed" }
      : null;
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
      // Historical total only when every claim is priced; nothing found in an
      // incomplete range is not a $0 floor worth printing.
      usd: !mine.length ? (complete ? 0 : null) : unpriced ? null : +hist.toPrecision(12),
      usdPricedSubtotal: +hist.toPrecision(12), pricedRecords: priced, unpricedRecords: unpriced,
      usdCurrent,
      usdBasis, priceSources,
      ...(unpriced ? { usdMissing: `${unpriced} of ${mine.length} claims have no verified price of their moment` } : {}),
      principalSeparated: withdrawals > 0,
      byAction: {
        collect: actOut(acts.collect, dec0, dec1, sym0, sym1),
        liquidity: actOut(acts.liquidity, dec0, dec1, sym0, sym1),
      },
      coverage: cov,
      basis,
    };
  }

  return { scan, rows, capital, summary, coverage, ownership, liquidityHistory, setPrice, save, remember, metaOf, knownIds, acquireWriter,
    /** True while another live process owns the file: read it, never write it. */
    get readOnly() { return foreign(); }, get scope() { return scope; }, get state() { return S(); } };
}

module.exports = { create, actionOf, amountsFor, MODIFY_LIQUIDITY, TRANSFER, SWAP, NATIVE_PSEUDO, ZERO, DECODER };
