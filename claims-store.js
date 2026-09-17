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
 * Progress. `scannedFrom`/`scannedTo` is one contiguous block interval per scope,
 * persisted to the instance's own data directory. A cursor only advances after a
 * chunk has been folded, so a failure or a budget cut shortens the interval and
 * never holes it. Coverage timestamps come from those boundary blocks.
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
  const S = () => (state.scopes[scope] = state.scopes[scope] || { events: {}, scannedFrom: null, scannedTo: null, fromT: null, toT: null });
  const save = () => fs.writeFileSync(FILE, JSON.stringify(state));

  const blockT = new Map();
  async function blockTime(n) {
    if (blockT.has(n)) return blockT.get(n);
    let t = null;
    try { const b = await provider.getBlock(n); t = b ? b.timestamp * 1000 : null; } catch {}
    blockT.set(n, t);
    return t;
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
      let fee0 = paid[t0], fee1 = paid[t1], p0 = 0n, p1 = 0n, kind = "collect", unavailable = null;
      if (delta < 0n) {
        kind = "withdrawal";
        if (!sv) unavailable = "no StateView: principal cannot be separated from fees";
        else {
          try {
            const slot0 = await sv.getSlot0(l.topics[1], { blockTag: l.blockNumber });
            const a = u.getAmountsForLiquidity(BigInt(slot0[0]),
              u.getSqrtRatioAtTick(Number(tl)), u.getSqrtRatioAtTick(Number(tu)), -delta);
            p0 = a.amount0; p1 = a.amount1;
            fee0 = paid[t0] > p0 ? paid[t0] - p0 : 0n;
            fee1 = paid[t1] > p1 ? paid[t1] - p1 : 0n;
          } catch (err) {
            unavailable = `the pool price at block ${l.blockNumber} could not be read (${err.shortMessage || err.message})`;
          }
        }
      }
      out.push({
        key: `${receipt.hash}:${l.index}`, tokenId, chainId: Number(chainId), positionManager: posm,
        block: l.blockNumber, tx: receipt.hash, kind, verified: true,
        fee0: unavailable ? null : fee0.toString(), fee1: unavailable ? null : fee1.toString(),
        principal0: p0.toString(), principal1: p1.toString(),
        token0: t0, token1: t1, unavailable,
      });
    }
    return out;
  }

  /**
   * Extend the scanned interval backwards from the head under a chunk budget.
   * `meta(tokenId)` supplies the pair and owner for positions we care about.
   */
  async function scan(meta, { chunk = 9000, budget = 12, floor = 0 } = {}) {
    const s = S();
    const head = await provider.getBlockNumber();
    let folded = 0, chunks = 0;
    const range = async (from, to) => {
      const logs = await provider.getLogs({ address: pm, topics: [MODIFY_LIQUIDITY, null, ethers.zeroPadValue(posm, 32)], fromBlock: from, toBlock: to });
      // `salt` is in the log data, so the token id is readable without a receipt.
      // Only transactions touching a position we track are worth a receipt fetch —
      // this manager serves every position on the chain, and fetching a receipt per
      // transaction made a single 9,000-block chunk take minutes.
      const byTx = new Set();
      for (const l of logs) {
        try {
          const [, , delta, salt] = coder.decode(["int24", "int24", "int256", "bytes32"], l.data);
          if (delta > 0n) continue;
          if (meta(BigInt(salt).toString())) byTx.add(l.transactionHash);
        } catch {}
      }
      for (const h of byTx) {
        const r = await provider.getTransactionReceipt(h);
        if (!r) continue;
        for (const c of await claimsInReceipt(r, meta)) {
          c.t = await blockTime(c.block);
          s.events[c.key] = c;                 // keyed by tx:logIndex — a rescan overwrites
          folded++;
        }
      }
    };
    // Forward first, so the newest claims appear soonest.
    if (s.scannedTo != null && s.scannedTo < head) {
      let from = s.scannedTo + 1;
      while (from <= head && chunks < budget) {
        const to = Math.min(from + chunk - 1, head);
        await range(from, to);
        s.scannedTo = to; from = to + 1; chunks++; save();
      }
    } else if (s.scannedTo == null) {
      s.scannedTo = head; s.scannedFrom = head + 1;
    }
    // Then backwards towards the floor.
    while (s.scannedFrom - 1 >= floor && chunks < budget) {
      const to = s.scannedFrom - 1;
      const from = Math.max(floor, to - chunk + 1);
      await range(from, to);
      s.scannedFrom = from; chunks++; save();
    }
    s.fromT = await blockTime(s.scannedFrom);
    s.toT = await blockTime(s.scannedTo);
    s.floor = floor;
    s.complete = s.scannedFrom <= floor;
    save();
    return { chunks, folded, scannedFrom: s.scannedFrom, scannedTo: s.scannedTo, complete: s.complete };
  }

  /** Every verified record for one position, oldest first. */
  function rows(tokenId) {
    const s = S();
    return Object.values(s.events)
      .filter((e) => e.tokenId === String(tokenId) && e.chainId === Number(chainId) && e.positionManager === posm)
      .sort((a, b) => a.block - b.block);
  }

  /**
   * The card's figure. A number is produced only from verified records inside the
   * scanned interval; anything else is stated, never approximated.
   */
  function summary(tokenId, { dec0, dec1, sym0, sym1, usd0, usd1, openedBlock = null }) {
    const s = S();
    if (s.scannedFrom == null || s.scannedTo == null) {
      return { status: "unavailable", reason: "no block range has been scanned for this chain and position manager yet", scope: { chainId: Number(chainId), positionManager: posm, tokenId: String(tokenId) } };
    }
    const mine = rows(tokenId);
    const bad = mine.filter((e) => e.unavailable);
    if (bad.length) {
      return { status: "unavailable", scope: { chainId: Number(chainId), positionManager: posm, tokenId: String(tokenId) },
        reason: `${bad.length} of ${mine.length} records could not have principal separated from fees (${bad[0].unavailable}); a total would be a guess` };
    }
    let a0 = 0n, a1 = 0n, last = null, withdrawals = 0;
    for (const e of mine) {
      a0 += BigInt(e.fee0 || "0"); a1 += BigInt(e.fee1 || "0");
      if (e.kind === "withdrawal") withdrawals++;
      if (e.t && (!last || e.t > last)) last = e.t;
    }
    // Complete only when the scan actually reached back past the position's first
    // block. Without a known opening block the honest answer is "partial".
    const complete = openedBlock != null && s.scannedFrom <= openedBlock;
    const f0 = Number(ethers.formatUnits(a0, dec0)), f1 = Number(ethers.formatUnits(a1, dec1));
    return {
      status: complete ? "ok" : "partial",
      count: mine.length, last, withdrawals,
      scope: { chainId: Number(chainId), positionManager: posm, tokenId: String(tokenId) },
      tokens: [{ symbol: sym0, amount: f0.toLocaleString("en-US", { maximumFractionDigits: 6 }) },
               { symbol: sym1, amount: f1.toLocaleString("en-US", { maximumFractionDigits: 6 }) }],
      raw0: a0.toString(), raw1: a1.toString(),
      usd: usd0 == null || usd1 == null ? null : +(f0 * usd0 + f1 * usd1).toFixed(2),
      principalSeparated: withdrawals > 0,
      coverage: { fromBlock: s.scannedFrom, toBlock: s.scannedTo, fromT: s.fromT, toT: s.toT, complete: !!s.complete },
      basis: "token amounts are exact from chain; USD is valued at today's prices",
    };
  }

  return { scan, rows, summary, save, get scope() { return scope; }, get state() { return S(); } };
}

module.exports = { create, MODIFY_LIQUIDITY, TRANSFER, NATIVE_PSEUDO };
