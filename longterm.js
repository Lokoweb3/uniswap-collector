"use strict";
/**
 * longterm.js — long-term per-position returns (TASK-51).
 *
 * Pure: no files, no network. The server and attribution.load() feed it the
 * open positions (main and watched), the collect history rows, the range log,
 * and the daily per-position value ledger, and get back one `longTerm` block
 * per open position:
 *
 *   { id, chainId, chainSince, chained, members,
 *     sinceOpen: measure, d30: measure,
 *     chain: null | { id, since, members: [{ id, openedAt, closedAt, feesUsd, netUsd, depositedUsd }],
 *                     sinceOpen: measure, d30: measure } }
 *
 *   measure = { days, feesUsd, feeAprPct, netUsd, netPct, basis, basisUsd, approx, unpricedCollects }
 *
 * Rules:
 *  - Fee APR = fees over the window ÷ basis, annualised over the ACTUAL elapsed days
 *    (the 30 d window uses min(30, age)). Fees = priced collects in the window
 *    (history rows, already deduped) + the uncollected fees now.
 *  - Net return = fees + price move + IL = the position's pnlUsd (deposit-basis
 *    decomposition). null when any leg is unknown — never a fabricated 0.
 *  - Basis is never current value: "open" = value at open (deposited); "twa" =
 *    time-weighted average of the daily value ledger over the window, used when
 *    the ledger covers ≥ 80 % of it. Reported with its USD amount.
 *  - Chain: successive positions of the same wallet and pair (pair string,
 *    normalised — closed rows carry no pool key) whose open follows the previous
 *    close by < 48 h. chainId = first tokenId, chainSince = first open. Fees and
 *    days accumulate along the chain; the chain basis is the members' open
 *    basis weighted by their open time, known only when every member's is.
 */

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const GAP_MS = 48 * HOUR;
const WINDOW_DAYS = 30;
const TWA_MIN_COVERAGE = 0.8;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (n, d = 2) => (n == null ? null : +Number(n).toFixed(d));
function pairKey(pair) { return String(pair || "").replace(/\s+/g, "").toLowerCase(); }
function idKey(tokenId, version) {
  const s = String(tokenId);
  return s.startsWith("v4-") ? s : version === 4 ? `v4-${s}` : s;
}

/**
 * The price-log price of `addr` at the hour at or just before `t` (within `maxAge`), or null.
 * `hours` is price-log.json's `{ "<hourMs>": { "<addr lower>": usd } }`. Pure.
 */
function priceAt(hours, addr, t, maxAge = 36 * HOUR) {
  if (!hours || num(t) == null || !addr) return null;
  const a = String(addr).toLowerCase();
  let best = null;
  for (const k of Object.keys(hours)) {
    const h = Number(k);
    if (!Number.isFinite(h) || h > t || t - h > maxAge) continue;
    if (best == null || h > best) best = h;
  }
  if (best == null) return null;
  const v = hours[String(best)] && hours[String(best)][a];
  return num(v) != null && v > 0 ? v : null;
}

/** An open position from a positions/watch payload. */
function openRecord(p, walletAddress) {
  const legs = p.pnlLegs || null;
  return {
    id: idKey(p.tokenId, p.version), walletAddress: String(walletAddress || "").toLowerCase(),
    pair: p.pair || null, pairKey: pairKey(p.pair), version: p.version || 3, open: true,
    openedAt: num(p.pnlSince), closedAt: null,
    // The "value at open" basis is the deposit priced AT OPEN (legs.depositedAtOpen, from the
    // price-log hour of the first deposit). legs.deposited is the same quantity at TODAY's
    // prices — the HODL comparator — and must never be the APR basis (TASK-82): unknown → null.
    depositedUsd: legs ? num(legs.depositedAtOpen) : null,
    depositedTodayUsd: legs ? num(legs.deposited) : null,
    collectedLegUsd: legs ? num(legs.collected) : null,
    uncollectedUsd: num(p.feesUsd) != null ? num(p.feesUsd) : legs ? num(legs.uncollected) : null,
    pnlUsd: legs ? num(p.pnlUsd) : null,
    approx: !!p.pnlApprox, valueUsd: num(p.valueUsd),
  };
}

/** Closed positions inferred from the collect rows (and the range log) for ids that are not open. */
function closedRecords(collects, openIds, rangeLog = {}, closedDeposits = {}, closedWithdrawals = {}) {
  const by = new Map();
  for (const r of collects || []) {
    const id = idKey(r.tokenId, r.version);
    const wa = String(r.walletAddress || "").toLowerCase();
    const k = `${wa}:${id}`;
    if (openIds.has(k)) continue;
    if (!by.has(k)) by.set(k, { id, walletAddress: wa, pair: r.pair || null, pairKey: pairKey(r.pair), version: r.version || 3, open: false, ts: [] });
    const rec = by.get(k);
    if (num(r.t) != null) rec.ts.push(r.t);
    if (!rec.pair && r.pair) { rec.pair = r.pair; rec.pairKey = pairKey(r.pair); }
  }
  const out = [];
  for (const rec of by.values()) {
    const rl = rangeLog[rec.id] || rangeLog[String(rec.id).replace(/^v4-/, "")];
    const segs = rl && Array.isArray(rl.segments) ? rl.segments : [];
    const first = segs.length ? num(segs[0].from) : null;
    const lastSeg = segs.length ? segs[segs.length - 1] : null;
    const last = lastSeg ? num(lastSeg.to) ?? num(lastSeg.last) : null;
    const tMin = rec.ts.length ? Math.min(...rec.ts) : null;
    const tMax = rec.ts.length ? Math.max(...rec.ts) : null;
    const openedAt = [first, tMin].filter((x) => x != null).reduce((a, b) => Math.min(a, b), Infinity);
    const closedAt = [last, tMax].filter((x) => x != null).reduce((a, b) => Math.max(a, b), -Infinity);
    out.push({
      ...rec, ts: undefined,
      openedAt: Number.isFinite(openedAt) ? openedAt : null, closedAt: Number.isFinite(closedAt) ? closedAt : null,
      depositedUsd: num((closedDeposits || {})[rec.id]) ?? num((closedDeposits || {})[`${rec.walletAddress}:${rec.id}`]),
      withdrawnUsd: num((closedWithdrawals || {})[rec.id]) ?? num((closedWithdrawals || {})[`${rec.walletAddress}:${rec.id}`]),
      collectedLegUsd: null, uncollectedUsd: 0, pnlUsd: null, approx: false, valueUsd: null,
    });
  }
  return out;
}

/** Link records of one wallet + pair into chains: open follows the previous close by < 48 h. */
function chainRecords(records) {
  const groups = new Map();
  for (const r of records) {
    const k = `${r.walletAddress}|${r.pairKey}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const chains = new Map(); // chainId -> [records in order]
  for (const rs of groups.values()) {
    rs.sort((a, b) => (a.openedAt ?? Infinity) - (b.openedAt ?? Infinity));
    let cur = null;
    for (const r of rs) {
      const prev = cur ? cur[cur.length - 1] : null;
      const linked = prev && prev.closedAt != null && r.openedAt != null && r.openedAt - prev.closedAt < GAP_MS && r.openedAt - prev.closedAt > -HOUR;
      if (linked) cur.push(r);
      else { cur = [r]; chains.set(r.id, cur); }
    }
  }
  const chainOf = new Map();
  for (const [id, members] of chains) for (const m of members) chainOf.set(`${m.walletAddress}:${m.id}`, { chainId: id, members });
  return chainOf;
}

/** Time-weighted average of piecewise-constant samples [{ t, usd }] over [from, to]; null under 80 % coverage. */
function twa(samples, from, to) {
  const s = (samples || []).filter((x) => num(x.t) != null && num(x.usd) != null).sort((a, b) => a.t - b.t);
  if (s.length < 2 || !(to > from)) return null;
  let covered = 0, area = 0;
  for (let i = 0; i < s.length; i++) {
    const a = Math.max(from, s[i].t);
    const b = Math.min(to, i + 1 < s.length ? s[i + 1].t : to);
    if (b <= a) continue;
    covered += b - a;
    area += (b - a) * s[i].usd;
  }
  if (covered / (to - from) < TWA_MIN_COVERAGE) return null;
  return area / covered;
}

/** The ledger sample at or just before t (within 36 h), for a window-start value. */
function sampleAt(samples, t) {
  let best = null;
  for (const x of samples || []) if (num(x.t) != null && x.t <= t && (!best || x.t > best.t)) best = x;
  return best && t - best.t <= 36 * HOUR ? best : null;
}

function windowFees(rec, collectsById, from, to, now) {
  const rows = collectsById.get(`${rec.walletAddress}:${rec.id}`) || [];
  let fees = 0, unpriced = 0, any = false;
  for (const r of rows) {
    if (r.principal) continue; // a principal withdrawal rides in the same tx as a collect: not a fee
    if (num(r.t) == null || r.t < from || r.t > to) continue;
    if (num(r.usd) == null) { unpriced++; continue; }
    fees += r.usd; any = true;
  }
  if (rec.open && to >= now - HOUR && rec.uncollectedUsd != null) { fees += rec.uncollectedUsd; any = true; }
  return { feesUsd: any ? fees : 0, unpricedCollects: unpriced };
}

function aprOf(feesUsd, basisUsd, days) {
  if (feesUsd == null || basisUsd == null || !(basisUsd > 0) || !(days >= 1 / 24)) return null;
  return (feesUsd / basisUsd) * (365 / days) * 100;
}

/** One position, one window [from, to]. */
function measureOne(rec, { collectsById, values, now, from, to }) {
  const days = (to - from) / DAY;
  const { feesUsd, unpricedCollects } = windowFees(rec, collectsById, from, to, now);
  const samples = values[`${rec.walletAddress}:${rec.id}`] || values[rec.id] || [];
  const twaUsd = twa(samples, from, to);
  const basis = twaUsd != null ? "twa" : "open";
  const basisUsd = twaUsd != null ? twaUsd : rec.depositedUsd;
  // Net return: the whole life is the deposit-basis pnlUsd; a shorter window needs the
  // ledger's value + fees at the window start, else it is unknown.
  let netUsd = null;
  const wholeLife = rec.openedAt != null && from <= rec.openedAt + HOUR;
  if (wholeLife) netUsd = rec.open ? rec.pnlUsd : null;
  else if (rec.open && rec.valueUsd != null && rec.uncollectedUsd != null) {
    const start = sampleAt(samples, from);
    if (start && num(start.usd) != null && num(start.fees) != null) {
      const collectsIn = (collectsById.get(`${rec.walletAddress}:${rec.id}`) || []).filter((r) => num(r.t) != null && r.t >= from && r.t <= to && num(r.usd) != null).reduce((s, r) => s + r.usd, 0);
      netUsd = rec.valueUsd + rec.uncollectedUsd + collectsIn - (start.usd + start.fees);
    }
  }
  return {
    days: round(days, 2), feesUsd: round(feesUsd), feeAprPct: round(aprOf(feesUsd, basisUsd, days), 1),
    netUsd: round(netUsd), netPct: netUsd != null && basisUsd > 0 ? round((netUsd / basisUsd) * 100, 2) : null,
    basis: basisUsd != null ? basis : null, basisUsd: round(basisUsd), approx: !!rec.approx, unpricedCollects,
  };
}

/** A chain of members over [from, to]: fees and days accumulate; basis is open-time-weighted. */
function measureChain(members, { collectsById, values, now, from, to }) {
  const days = (to - from) / DAY;
  let fees = 0, unpriced = 0, netSum = 0, netKnown = true, basisNum = 0, basisDen = 0, basisKnown = true, approx = false;
  const twaParts = [];
  for (const m of members) {
    const mFrom = Math.max(from, m.openedAt ?? from), mTo = Math.max(mFrom, Math.min(to, m.closedAt ?? to));
    if (m.closedAt != null && m.closedAt < from) continue; // ended before the window
    const w = windowFees(m, collectsById, mFrom, mTo, now);
    fees += w.feesUsd; unpriced += w.unpricedCollects;
    const whole = m.openedAt != null && from <= m.openedAt + HOUR;
    // A closed member's net needs its withdrawal, which the collect rows do not carry (optional
    // closedWithdrawals input); unknown -> the chain's net is unknown, never a partial sum.
    const mNet = m.open ? (whole ? m.pnlUsd : null) : (m.depositedUsd != null && m.withdrawnUsd != null ? m.withdrawnUsd + w.feesUsd - m.depositedUsd : null);
    if (mNet == null) netKnown = false; else netSum += mNet;
    if (m.depositedUsd == null) basisKnown = false; else { basisNum += m.depositedUsd * (mTo - mFrom); basisDen += mTo - mFrom; }
    approx = approx || !!m.approx;
    const samples = values[`${m.walletAddress}:${m.id}`] || values[m.id] || [];
    for (const s of samples) if (num(s.t) != null && s.t >= mFrom - DAY && s.t <= mTo) twaParts.push(s);
  }
  const twaUsd = twa(twaParts, from, to);
  const basis = twaUsd != null ? "twa" : basisKnown && basisDen > 0 ? "open" : null;
  const basisUsd = twaUsd != null ? twaUsd : basis === "open" ? basisNum / basisDen : null;
  const netUsd = netKnown && members.length ? netSum : null;
  return {
    days: round(days, 2), feesUsd: round(fees), feeAprPct: round(aprOf(fees, basisUsd, days), 1),
    netUsd: round(netUsd), netPct: netUsd != null && basisUsd > 0 ? round((netUsd / basisUsd) * 100, 2) : null,
    basis, basisUsd: round(basisUsd), approx, unpricedCollects: unpriced,
  };
}

/**
 * compute({ open: [{ p, walletAddress }], collects, rangeLog, values, closedDeposits, now })
 *   open          open positions as the payloads carry them, with their wallet address
 *   collects      /api/history rows ({ t, usd, tokenId, version, walletAddress, pair })
 *   rangeLog      range-log.json .positions (segments per id) — closed positions' open/close times
 *   values        position-values.json: { "<wallet>:<id>": [{ t, usd, fees }] } (daily ledger)
 *   closedDeposits / closedWithdrawals  optional { "<id>": usd } for closed members whose deposit / withdrawal is known
 * Returns Map "<wallet>:<id>" -> longTerm block for every open position.
 */
function compute({ open = [], collects = [], rangeLog = {}, values = {}, closedDeposits = {}, closedWithdrawals = {}, now = Date.now() } = {}) {
  const openRecs = open.map(({ p, walletAddress }) => openRecord(p, walletAddress));
  const openIds = new Set(openRecs.map((r) => `${r.walletAddress}:${r.id}`));
  const closed = closedRecords(collects, openIds, rangeLog, closedDeposits, closedWithdrawals);
  const all = [...openRecs, ...closed];
  const collectsById = new Map();
  for (const r of collects || []) {
    const k = `${String(r.walletAddress || "").toLowerCase()}:${idKey(r.tokenId, r.version)}`;
    if (!collectsById.has(k)) collectsById.set(k, []);
    collectsById.get(k).push(r);
  }
  const chainOf = chainRecords(all);
  const out = new Map();
  const win = WINDOW_DAYS * DAY;
  for (const rec of openRecs) {
    const key = `${rec.walletAddress}:${rec.id}`;
    const ctx = { collectsById, values, now };
    let sinceOpen = null, d30 = null;
    if (rec.openedAt != null && now > rec.openedAt) {
      sinceOpen = measureOne(rec, { ...ctx, from: rec.openedAt, to: now });
      d30 = measureOne(rec, { ...ctx, from: Math.max(rec.openedAt, now - win), to: now });
    }
    const c = chainOf.get(key);
    const members = c ? c.members : [rec];
    let chain = null;
    if (c && members.length > 1 && members[0].openedAt != null) {
      const since = members[0].openedAt;
      chain = {
        id: c.chainId, since,
        members: members.map((m) => ({ id: m.id, openedAt: m.openedAt, closedAt: m.closedAt, depositedUsd: round(m.depositedUsd),
          feesUsd: round(windowFees(m, collectsById, m.openedAt ?? since, m.closedAt ?? now, now).feesUsd) })),
        sinceOpen: measureChain(members, { ...ctx, from: since, to: now }),
        d30: measureChain(members, { ...ctx, from: Math.max(since, now - win), to: now }),
      };
    }
    out.set(key, { id: rec.id, chainId: c ? c.chainId : rec.id, chainSince: members[0].openedAt ?? rec.openedAt ?? null, chained: !!chain, members: members.length, sinceOpen, d30, chain });
  }
  return out;
}

module.exports = { compute, chainRecords, closedRecords, openRecord, twa, priceAt, idKey, pairKey, WINDOW_DAYS, GAP_MS };
