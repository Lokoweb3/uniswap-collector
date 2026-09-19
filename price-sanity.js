"use strict";
/**
 * price-sanity.js — how far a live price has moved from the last hourly reading.
 *
 * Both the sell path and the guardian's auto-close take the pool's current state as
 * their reference. The impact cap in sell-v4.js is measured against spot, and minOut
 * is derived from the same quote, so a price someone has already pushed becomes the
 * thing everything is checked against: the cap is satisfied by construction and the
 * sale goes through at the pushed price. The guardian compares one cycle to the
 * previous one, so a move of 9% a minute passes its stability check while adding up
 * to a drawdown that triggers a close.
 *
 * price-log.json holds hourly USD prices for every token the dashboard values. It is
 * written by a different path, on a different schedule, so it is a genuinely separate
 * opinion — not another read of the same pool a minute later. Comparing against it
 * does not prove a price is right; it shows when the live one has left the recent
 * record behind, which is the case worth refusing to act on.
 *
 * Deliberately no I/O and no clock of its own: the caller supplies the log and the
 * time, so the decision is testable and the same in both callers.
 */

const HOUR = 3600 * 1000;

/**
 * The most recent hourly USD price for `token`, at or before `now`.
 * @returns {{usd: number, t: number, ageMs: number}|null} null when the log has none.
 */
function latestHourly(log, token, now = Date.now(), { maxAgeMs = 6 * HOUR } = {}) {
  const hours = log && log.hours;
  if (!hours || typeof hours !== "object") return null;
  const key = String(token || "").toLowerCase();
  let best = null;
  for (const [ms, row] of Object.entries(hours)) {
    const t = Number(ms);
    if (!Number.isFinite(t) || t > now) continue;              // never read the future
    if (!row || typeof row !== "object") continue;
    const usd = Number(row[key]);
    if (!Number.isFinite(usd) || usd <= 0) continue;
    if (!best || t > best.t) best = { usd, t };
  }
  // A reading from days ago says nothing about now, and treating it as a reference
  // would block every sale after a quiet spell.
  if (!best || now - best.t > maxAgeMs) return null;
  return { ...best, ageMs: now - best.t };
}

/**
 * How far `liveUsd` sits from the latest hourly reading, as a percentage of it.
 *
 * @returns {{deviationPct: number, hourlyUsd: number, ageMs: number}|null}
 *   null when there is nothing to compare against — no log, no entry for this token,
 *   or nothing recent enough. A null is not agreement: the caller decides what to do
 *   without a second opinion, and must not read it as a pass.
 */
function deviation(log, token, liveUsd, now = Date.now(), opts = {}) {
  const live = Number(liveUsd);
  if (!Number.isFinite(live) || live <= 0) return null;
  const hourly = latestHourly(log, token, now, opts);
  if (!hourly) return null;
  return {
    deviationPct: Math.abs(live - hourly.usd) / hourly.usd * 100,
    hourlyUsd: hourly.usd,
    ageMs: hourly.ageMs,
  };
}

/**
 * Whether a live price is too far from the record to act on.
 * @returns {{ok: boolean, reason: string|null, deviationPct: number|null, hourlyUsd: number|null}}
 */
function check(log, token, liveUsd, maxDeviationPct, now = Date.now(), opts = {}) {
  const d = deviation(log, token, liveUsd, now, opts);
  if (!d) return { ok: true, reason: null, deviationPct: null, hourlyUsd: null, compared: false };
  const limit = Number(maxDeviationPct);
  if (!Number.isFinite(limit) || limit <= 0) return { ok: true, reason: null, deviationPct: d.deviationPct, hourlyUsd: d.hourlyUsd, compared: true };
  if (d.deviationPct > limit) {
    return {
      ok: false,
      reason: `live price $${liveUsd} is ${d.deviationPct.toFixed(1)}% from the hourly log's $${d.hourlyUsd} (limit ${limit}%, reading ${Math.round(d.ageMs / 60000)} min old)`,
      deviationPct: d.deviationPct, hourlyUsd: d.hourlyUsd, compared: true,
    };
  }
  return { ok: true, reason: null, deviationPct: d.deviationPct, hourlyUsd: d.hourlyUsd, compared: true };
}

module.exports = { latestHourly, deviation, check, HOUR };
