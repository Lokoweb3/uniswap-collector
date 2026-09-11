/**
 * verdict.js — keep / watch / close for one open position, from the guardian's
 * view of it (an /api/risk row) and its collect history. Pure: no I/O, so the
 * server, the daily summary and the tests all get the same answer.
 *
 *   keep   green, in range, earned within the last two days
 *   watch  yellow, or out of range, or no fees for 2 days, or under 5% APR
 *   close  red (a close trigger holds), or out of range past the rule's minutes,
 *          or no fees for 7 days
 *   hold   the rule block says hold: the owner decided to keep the position
 *          whatever the data says, so the summary never asks them to close it
 *
 * "Last earned" is the newest of: the last collect, the last hour with fee
 * accrual in fee-daily.json (main wallet), and now when the guardian sees fees
 * coming in at ≥ $0.01/h. The fee rate shown is the guardian's live rate, or the
 * realised 7-day collect rate when that is higher (bursty pools such as the
 * WETH/Index rewards position earn in lumps the live rate misses).
 */
"use strict";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const THRESHOLDS = { idleWatchHours: 48, idleCloseHours: 7 * 24, minRatePerHour: 0.01, lowAprPct: 5 };

/**
 * @param p        an /api/risk position row: status, reasons, feesPerHour, feesPerHour15m,
 *                 valueUsd, inRange, outMinutes, rules { outOfRangeMinutes, hold }, entryAt,
 *                 collected { usd, usd7d, last }
 * @param feeHours { hourMs: usd } accrual buckets for this position (fee-daily.json), optional
 */
function verdictFor(p = {}, { feeHours = {}, now = Date.now() } = {}) {
  const rules = p.rules || {};
  const col = p.collected || {};
  const liveRate = p.feesPerHour != null && isFinite(p.feesPerHour) ? Number(p.feesPerHour) : null;

  // Realised rate over the last week of collects (or since the mint when newer).
  let windowH = 7 * 24;
  if (p.entryAt && now - p.entryAt > HOUR) windowH = Math.min(windowH, (now - p.entryAt) / HOUR);
  // Accrual this week (the same fees before they are collected, so the larger of the two, not the sum).
  let accrued7d = 0, last = col.last ? Number(col.last) : null;
  for (const [h, usd] of Object.entries(feeHours || {})) {
    if (!(Number(usd) > 0)) continue;
    if (Number(h) > now - 7 * DAY) accrued7d += Number(usd);
    const t = Math.min(now, Number(h) + HOUR);
    if (last == null || t > last) last = t; // last time the position earned anything
  }
  const realised = col.usd7d != null || accrued7d > 0 ? Math.max(Number(col.usd7d) || 0, accrued7d) / windowH : null;
  const rate = liveRate == null && realised == null ? null : Math.max(liveRate || 0, realised || 0);
  if ((liveRate || 0) >= THRESHOLDS.minRatePerHour || (p.feesPerHour15m || 0) >= THRESHOLDS.minRatePerHour) last = now;
  const idleHours = last == null ? null : Math.max(0, (now - last) / HOUR);
  const aprPct = rate != null && p.valueUsd > 0 ? (rate * 24 * 365 / p.valueUsd) * 100 : null;

  const why = [];
  const push = (s) => { if (s && !why.includes(s)) why.push(s); };
  const idleDays = idleHours == null ? null : Math.floor(idleHours / 24);
  const outLong = !p.inRange && rules.outOfRangeMinutes != null && (p.outMinutes || 0) >= rules.outOfRangeMinutes;
  let verdict = "keep";
  if (rules.hold) {
    verdict = "hold";
    push("held by choice");
  } else if (p.status === "red" || outLong || (idleHours != null && idleHours >= THRESHOLDS.idleCloseHours)) {
    verdict = "close";
    if (p.status === "red") for (const r of p.reasons || []) push(r);
    else if (outLong) push(`out of range ${Math.round(p.outMinutes)} min`);
    if (idleHours != null && idleHours >= THRESHOLDS.idleCloseHours) push(`no fees for ${idleDays}d`);
  } else {
    const idleLong = idleHours != null && idleHours >= THRESHOLDS.idleWatchHours;
    const noFees = (rate || 0) < THRESHOLDS.minRatePerHour;
    const lowApr = aprPct != null && aprPct < THRESHOLDS.lowAprPct;
    if (p.status === "yellow" || !p.inRange || idleLong || noFees || lowApr) {
      verdict = "watch";
      if (p.status === "yellow") for (const r of p.reasons || []) push(r);
      if (!p.inRange) push("out of range");
      if (idleLong) push(`no fees for ${idleDays}d`);
      else if (noFees) push(idleHours == null ? "never seen earning" : "fees stopped");
      else if (lowApr) push(`${aprPct.toFixed(1)}% APR`);
    }
  }
  return { verdict, why, feesPerHour: rate, liveFeesPerHour: liveRate, idleHours, lastEarnedAt: last, aprPct };
}

/** "earned 2h ago" / "earned 3d ago" / "never earned". */
function idleText(v) {
  if (!v || v.idleHours == null) return "never earned";
  if (v.idleHours < 1) return "earning now";
  if (v.idleHours < 24) return `earned ${Math.round(v.idleHours)}h ago`;
  return `earned ${(v.idleHours / 24).toFixed(v.idleHours < 10 * 24 ? 1 : 0)}d ago`;
}

module.exports = { verdictFor, idleText, THRESHOLDS, HOUR, DAY };
