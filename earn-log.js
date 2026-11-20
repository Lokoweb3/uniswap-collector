/**
 * Earnings log: what every open position earns per calendar day, what it was worth when
 * tracking began, and when its fees or rewards were last claimed. One ledger for every
 * wallet and every DEX, so "are we making money" has one answer.
 *
 * It reads the position rows the dashboard already builds (/api/positions and /api/watch)
 * and keeps, per position:
 *   - startUsd / startT: the position's value the first time it was seen here;
 *   - days[YYYY-MM-DD]: USD earned that day. "Earned" is the growth of what is waiting to
 *     be claimed (uncollected fees in both tokens, plus pending gauge rewards) between two
 *     samples, valued at the prices of the later sample;
 *   - lastClaimT: the waiting amount dropped, so it was claimed between two samples.
 *
 * Net result = (value now - start value) + earned since the start. Fees that were already
 * waiting when tracking began are not counted as earned.
 *
 * Limits, stated rather than hidden:
 *   - a claim is noticed at the next sample, so its time is right to within one sample
 *     interval, and what accrued between the previous sample and the claim is not counted;
 *   - adding or removing liquidity is recognised from the position's size (derived from its
 *     amounts and range) changing by more than SIZE_STEP; the start value is then moved by
 *     the capital that went in or out, so it is not booked as profit or loss.
 */
"use strict";
const fs = require("fs");

const DAY = 86400000;
const KEEP_DAYS = 400;      // per-position daily history kept
const CLOSED_SHOW_MS = 7 * DAY;
const CLAIM_DROP = 0.05;    // the waiting amount fell by more than this share: a claim
const CLAIM_MIN_USD = 0.01; // ...and was worth at least this
const SIZE_STEP = 0.02;     // liquidity changed by more than this share: capital moved

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * A number proportional to the position's liquidity, from its amounts and range, or null
 * when the row does not carry them. Prices are token1 per token0, as on the rows.
 */
function sizeOf(p) {
  const P = num(p.priceCurrent), a = num(p.priceLower), b = num(p.priceUpper);
  const x = num(p.amount0), y = num(p.amount1);
  if (P == null || a == null || b == null || x == null || y == null || !(a > 0) || !(b > a) || !(P > 0)) return null;
  const sa = Math.sqrt(a), sb = Math.sqrt(b), sp = Math.sqrt(Math.min(Math.max(P, a), b));
  const from0 = sb - sp > 0 ? (x * sp * sb) / (sb - sp) : null;
  const from1 = sp - sa > 0 ? y / (sp - sa) : null;
  if (from0 == null) return from1;
  if (from1 == null) return from0;
  // In range both legs give the same answer; take the one with more room behind it, which
  // is the less sensitive to the price's rounding.
  return sb - sp >= sp - sa ? from0 : from1;
}

/** The waiting amounts of a row, each with the price to value it at. A leg that cannot be read is absent. */
function legsOf(p) {
  const legs = {};
  if (p.feesOk !== false && num(p.fee0) != null && num(p.fee1) != null) {
    legs.f0 = { amount: p.fee0, price: num(p.usd0) };
    legs.f1 = { amount: p.fee1, price: num(p.usd1) };
  }
  const r = p.rewards;
  if (r && num(r.amount) != null) {
    const price = num(r.priceUsd) != null ? r.priceUsd : r.amount > 0 && num(r.usd) != null ? r.usd / r.amount : null;
    legs.r = { amount: r.amount, price };
  }
  return legs;
}

function create({ file, now = () => Date.now(), dayKey = require("./daykey").dayKey, log = () => {} } = {}) {
  let state = { v: 1, since: null, src: {}, pos: {} };
  if (file) {
    try {
      const read = JSON.parse(fs.readFileSync(file, "utf8"));
      if (read && read.pos) state = { ...state, ...read };
    } catch (err) {
      if (err.code !== "ENOENT") log(`could not read ${file}: ${err.message}; starting a new log`);
    }
  }
  const save = () => {
    if (!file) return;
    try {
      fs.writeFileSync(file + ".tmp", JSON.stringify(state));
      fs.renameSync(file + ".tmp", file);
    } catch (err) { log(`could not write ${file}: ${err.message}`); }
  };

  /**
   * One sample. `wallets` is [{ address, label, rows }] and must only hold wallets whose
   * read succeeded: a position missing from a listed wallet is taken as closed. `source`
   * with `at` makes a repeated call with the same data a no-op.
   */
  function record({ source = "all", at = now(), wallets = [] }) {
    if (state.src[source] && state.src[source] >= at) return { skipped: true };
    state.src[source] = at;
    if (!state.since) state.since = at;
    const day = dayKey(at);
    const out = { earnedUsd: 0, opened: [], closed: [], claims: [] };

    for (const w of wallets) {
      const addr = String(w.address || "").toLowerCase();
      if (!addr) continue;
      const seen = new Set();
      for (const p of w.rows || []) {
        if (!p || p.tokenId == null) continue;
        const key = `${addr}:${p.tokenId}`;
        seen.add(key);
        const legs = legsOf(p);
        const value = num(p.valueUsd);
        const size = sizeOf(p);
        let rec = state.pos[key];
        if (!rec) {
          if (value == null) continue; // no start value to record yet; try the next sample
          rec = state.pos[key] = {
            wallet: addr, tokenId: String(p.tokenId), startT: at, startUsd: value,
            earnedUsd: 0, claims: 0, lastClaimT: null, lastClaimUsd: null, capitalMoves: 0, days: {}, pend: {},
          };
          for (const [k, l] of Object.entries(legs)) rec.pend[k] = l.amount;
          out.opened.push(key);
        } else {
          // Capital in or out: move the start by it, so it is neither profit nor loss.
          if (size != null && rec.size > 0 && value != null && !rec.closedT) {
            const ratio = size / rec.size;
            if (ratio > 1 + SIZE_STEP) { rec.startUsd += value * (1 - 1 / ratio); rec.capitalMoves++; }
            else if (ratio < 1 - SIZE_STEP) { rec.startUsd *= ratio; rec.capitalMoves++; }
          }
          let earned = 0, claimedUsd = 0, claimed = false;
          for (const [k, l] of Object.entries(legs)) {
            const prev = rec.pend[k];
            if (prev != null) {
              if (l.amount >= prev) {
                if (l.price != null) earned += (l.amount - prev) * l.price;
              } else if (prev - l.amount > prev * CLAIM_DROP && (l.price == null || prev * l.price >= CLAIM_MIN_USD)) {
                claimed = true;
                if (l.price != null) { claimedUsd += (prev - l.amount) * l.price; earned += l.amount * l.price; }
              }
            }
            rec.pend[k] = l.amount;
          }
          if (claimed) {
            rec.claims++; rec.lastClaimT = at; rec.lastClaimUsd = claimedUsd;
            out.claims.push({ key, usd: claimedUsd });
          }
          if (earned > 0) {
            rec.earnedUsd += earned;
            rec.days[day] = +(((rec.days[day] || 0) + earned).toFixed(6));
            out.earnedUsd += earned;
          }
          if (rec.closedT) delete rec.closedT; // seen again (a read that had failed, or a restake)
        }
        rec.label = w.label || rec.label || addr;
        rec.pair = p.pair || rec.pair || "?";
        rec.nftId = String(p.nftId || p.tokenId);
        rec.pool = `${typeof p.version === "number" ? "v" + p.version : String(p.protocol || p.version || "")} ${p.feeTierLabel || ""}`.trim();
        rec.staked = !!p.staked;
        rec.rewardSymbol = (p.rewards && p.rewards.symbol) || null;
        rec.inRange = p.inRange !== false;
        if (value != null) rec.valueUsd = value;
        if (size != null) rec.size = size;
        rec.pendingUsd = Object.values(legs).reduce((s, l) => s + (l.price != null ? l.amount * l.price : 0), 0);
        // The chain's own claim history, where the dashboard has it (Uniswap positions).
        const chainLast = p.claimed && num(p.claimed.last);
        if (chainLast && (!rec.chainClaimT || chainLast > rec.chainClaimT)) rec.chainClaimT = chainLast;
        rec.lastT = at;
      }
      for (const [key, rec] of Object.entries(state.pos)) {
        if (rec.wallet === addr && !seen.has(key) && !rec.closedT) { rec.closedT = at; out.closed.push(key); }
      }
    }

    const cutoff = dayKey(at - KEEP_DAYS * DAY);
    for (const [key, rec] of Object.entries(state.pos)) {
      for (const d of Object.keys(rec.days)) if (d < cutoff) delete rec.days[d];
      if (rec.closedT && at - rec.closedT > KEEP_DAYS * DAY) delete state.pos[key];
    }
    save();
    return out;
  }

  /** What the page shows: `days` calendar days of earnings, one card per position, and totals. */
  function view({ days = 30 } = {}) {
    const t = now();
    const keys = [];
    for (let i = days - 1; i >= 0; i--) keys.push(dayKey(t - i * DAY));
    const uniq = [...new Set(keys)]; // a DST day can repeat a key
    const today = uniq[uniq.length - 1], yesterday = uniq[uniq.length - 2] || null;
    const last7 = new Set(uniq.slice(-7));
    const sinceDay = state.since ? dayKey(state.since) : today;

    const positions = [];
    const byDay = Object.fromEntries(uniq.map((d) => [d, 0]));
    for (const [key, rec] of Object.entries(state.pos)) {
      for (const [d, usd] of Object.entries(rec.days)) if (d in byDay) byDay[d] += usd;
      const open = !rec.closedT;
      if (!open && t - rec.closedT > CLOSED_SHOW_MS) continue;
      const d7 = Object.entries(rec.days).reduce((s, [d, usd]) => s + (last7.has(d) ? usd : 0), 0);
      const trackedDays = Math.max((((open ? t : rec.closedT) - rec.startT) / DAY), 1 / 24);
      const changeUsd = open ? (rec.valueUsd || 0) - rec.startUsd : null;
      const netUsd = open ? changeUsd + rec.earnedUsd : null;
      const lastClaimT = Math.max(rec.lastClaimT || 0, rec.chainClaimT || 0) || null;
      positions.push({
        key, wallet: rec.label, pair: rec.pair, nftId: rec.nftId, tokenId: rec.tokenId, pool: rec.pool, staked: !!rec.staked,
        rewardSymbol: rec.rewardSymbol || null, open, inRange: rec.inRange !== false, closedT: rec.closedT || null,
        startT: rec.startT, startUsd: rec.startUsd, valueUsd: open ? rec.valueUsd || 0 : null, changeUsd,
        earnedUsd: rec.earnedUsd, todayUsd: rec.days[today] || 0, d7Usd: d7, perDayUsd: rec.earnedUsd / trackedDays,
        pendingUsd: open ? rec.pendingUsd || 0 : null, netUsd, netPct: open && rec.startUsd > 0 ? (netUsd / rec.startUsd) * 100 : null,
        lastClaimT, lastClaimUsd: rec.lastClaimT && rec.lastClaimT === lastClaimT ? rec.lastClaimUsd : null,
        claims: rec.claims, capitalMoves: rec.capitalMoves || 0,
        spark: uniq.slice(-14).map((d) => +(rec.days[d] || 0).toFixed(4)),
      });
    }
    positions.sort((a, b) => Number(b.open) - Number(a.open) || (b.valueUsd || 0) - (a.valueUsd || 0));

    const open = positions.filter((p) => p.open);
    const sum = (k) => open.reduce((s, p) => s + (p[k] || 0), 0);
    const series = uniq.filter((d) => d >= sinceDay).map((d) => ({ day: d, usd: +byDay[d].toFixed(4) }));
    const week = series.slice(-7);
    const startUsd = sum("startUsd"), netUsd = sum("netUsd");
    return {
      ok: true, at: t, since: state.since, lastSampleAt: Math.max(0, ...Object.values(state.src)) || null,
      days: series, positions,
      totals: {
        open: open.length, startUsd, valueUsd: sum("valueUsd"), changeUsd: sum("changeUsd"), earnedUsd: sum("earnedUsd"),
        pendingUsd: sum("pendingUsd"), netUsd, netPct: startUsd > 0 ? (netUsd / startUsd) * 100 : null,
        todayUsd: byDay[today] || 0, yesterdayUsd: yesterday && yesterday >= sinceDay ? byDay[yesterday] : null,
        d7Usd: week.reduce((s, d) => s + d.usd, 0), avgDayUsd: week.length ? week.reduce((s, d) => s + d.usd, 0) / week.length : null,
        avgDays: week.length,
      },
    };
  }

  /** The running result of one position, for the rows other pages show; null when it is not on record. */
  function figures(address, tokenId) {
    const rec = state.pos[`${String(address || "").toLowerCase()}:${tokenId}`];
    if (!rec || rec.closedT || !(rec.startUsd > 0)) return null;
    const netUsd = (rec.valueUsd || 0) - rec.startUsd + rec.earnedUsd;
    return { netUsd, netPct: (netUsd / rec.startUsd) * 100, startUsd: rec.startUsd, earnedUsd: rec.earnedUsd, since: rec.startT };
  }

  return { record, view, figures, get state() { return state; } };
}

module.exports = { create, sizeOf, legsOf };
