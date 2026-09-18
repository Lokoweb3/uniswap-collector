"use strict";
// Read-only decision summaries. No signing, network, or persistence here.
const { TZ, dayKey, dayStart } = require("./daykey");
const HOUR = 3600000, DAY = 24 * HOUR;
const number = x => typeof x === "number" && Number.isFinite(x);
const time = x => typeof x === "number" ? x : Date.parse(x);
const money = x => number(x) ? "$" + x.toFixed(2) : "unknown";
const idOf = p => String(p.tokenId).startsWith("v4-") ? String(p.tokenId) : `${p.version === 4 ? "v4-" : ""}${p.tokenId}`;
const prior = (points, t) => points.filter(p => p.t <= t).at(-1);

// Require price evidence for every held asset. A persisted partial flag is not sufficient:
// older versions cleared that flag on the second missing-price sample.
function complete(p) {
  return !!(p && number(p.total) && !p.partial && p.a && p.p &&
    Object.entries(p.a).every(([k, a]) => number(a) && (a <= 0 || number(p.p[k]))));
}
function span(points, start, end) {
  const first = prior(points, start), last = prior(points, end);
  const samples = points.filter(p => p.t > start && p.t <= end);
  let previous = first, covered = 0;
  for (const p of samples) {
    if (previous && complete(previous) && complete(p) && p.t - previous.t <= 2 * HOUR)
      covered += Math.max(0, p.t - Math.max(start, previous.t));
    previous = p;
  }
  const valid = complete(first) && complete(last) && start - first.t <= 2 * HOUR &&
    end - last.t <= 2 * HOUR && covered >= end - start - 2 * HOUR;
  return { first, last, valid, coveragePct: Math.min(100, covered / (end - start) * 100) };
}
function attention(d, now) {
  const p = d.positions, items = [];
  const add = (priority, title, detail, href) => items.push({ priority, title, detail, href });
  if (!p || !p.at || now - p.at > 10 * 60000) add(0, "Position data needs a refresh", "Attention items may be incomplete until positions update.", "/#reload");
  if (p) {
    for (const loop of Object.values(p.loops || {})) if (loop.stale)
      add(1, `${loop.label || "Background loop"} stopped reporting`, "Check its last run in Operator.", "/wallet#operator");
    // "ETH remaining" on a chain whose gas is USDC sends someone to top up the wrong
    // asset; the payload names the currency now.
    if (p.operatorGas && p.operatorGas.low) add(2, "Top up operator gas", `${p.operatorGas.eth} ${p.operatorGas.symbol || ""} remaining.`.trim(), "/wallet#operator");
    if (p.unlock && !p.unlock.armed) add(3, "Collector is locked", "Scheduled collections need an active arm window.", "/wallet#arm");
    else if (p.unlock && p.unlock.minutesLeft < 360) add(3, "Arm window expires soon", `${Math.max(0, Math.round(p.unlock.minutesLeft))} minutes remaining.`, "/wallet#arm");
    const run = p.ops && p.ops.lastRun;
    if (run && /failed|aborted/.test(run.result || "")) add(2, "Last collector run failed", String(run.result), "/wallet#operator");
    const wallets = [{ label: p.ownerLabel || "Main", address: p.owner, positions: p.positions || [] }, ...((d.watch || {}).wallets || []).filter(w => w.ok)];
    for (const w of wallets) for (const x of w.positions || []) if (x.inRange === false)
      add(4, `${x.pair || "Position"} is out of range`, `${w.label || w.address} · #${idOf(x)} · review the range before moving it.`, `/#scope=${encodeURIComponent(w.address === p.owner ? "owner" : w.address)}`);
    if (p.totals && p.totals.eligibleCount > 0) add(5, "Fees ready to collect", `${money(p.totals.collectableUsd)} across ${p.totals.eligibleCount} eligible positions.`, "/#collect");
  }
  return items.sort((a, b) => a.priority - b.priority).slice(0, 3);
}
function changes(d, since, now) {
  const p = d.positions || {}, items = [];
  if (d.history) {
    const rows = d.history.filter(r => time(r.t) > since && time(r.t) <= now);
    const known = rows.filter(r => number(r.usd));
    items.push(`${rows.length} collects recorded across all wallets · ${money(known.reduce((s, r) => s + r.usd, 0))}${known.length < rows.length ? " + unpriced fees" : ""}${rows.some(r => !r.locked) ? " (some prices estimated)" : ""}.`);
  } else items.push("Collect history is not loaded yet.");
  for (const x of p.positions || []) {
    const segs = ((d.ranges || {})[idOf(x)] || {}).segments || [];
    if (x.inRange === false && segs.some(s => !s.inRange && s.from > since && s.from <= now))
      items.push(`${x.pair || "Position"} #${idOf(x)} moved out of range (main wallet).`);
  }
  for (const w of ((d.watch || {}).wallets || []).filter(w => w.ok)) for (const x of w.positions || []) {
    if (x.inRange === false && x.range && time(x.range.streakSince) > since && time(x.range.streakSince) <= now)
      items.push(`${x.pair || "Position"} #${idOf(x)} moved out of range (${w.label || w.address}).`);
  }
  const pts = d.series || [], before = prior(pts, since), after = pts.at(-1);
  if (complete(before) && complete(after) && since - before.t <= 2 * HOUR && now - after.t <= 2 * HOUR)
    items.push(`Main wallet value changed by ${money(after.total - before.total)}; includes transfers and market moves.`);
  else items.push("Main wallet value change unavailable: a complete recent price sample is missing.");
  const run = p.ops && p.ops.lastRun;
  if (run && time(run.t) > since && /failed|aborted/.test(run.result || "")) items.push(`Latest collector run: ${run.result}.`);
  return items;
}
function weeks(now) {
  let end = dayStart(now);
  // Walk local midnights, not 24-hour offsets, across DST transitions.
  while (new Date(dayKey(end) + "T12:00:00Z").getUTCDay() !== 1) end = dayStart(end - 1);
  const out = [];
  for (let n = 0; n < 2; n++) {
    let start = end;
    for (let i = 0; i < 7; i++) start = dayStart(start - 1);
    out.unshift({ start, end, label: `${dayKey(start)} – ${dayKey(end - 1)}` });
    end = start;
  }
  return out;
}
function weekly(d, now) {
  return weeks(now).map(w => {
    const s = span(d.series || [], w.start, w.end);
    const inside = t => time(t) >= w.start && time(t) < w.end;
    const fees = d.fees ? Object.entries(d.fees).filter(([t]) => inside(Number(t)))
      .reduce((sum, [, per]) => sum + Object.values(per).reduce((a, x) => a + (number(x) ? x : 0), 0), 0) : null;
    let gas = d.gas ? 0 : null;
    const prices = Object.entries(d.prices || {}).map(([t, p]) => ({ t: Number(t), eth: p.eth })).sort((a, b) => a.t - b.t);
    for (const g of (d.gas || []).filter(g => inside(g.t))) {
      const p = prior(prices, time(g.t));
      if (!p || !number(p.eth) || time(g.t) - p.t > 2 * HOUR || !/^\d+$/.test(String(g.wei))) { gas = null; break; }
      gas += Number(g.wei) / 1e18 * p.eth;
    }
    let observed = 0, earning = 0;
    for (const r of Object.values(d.ranges || {})) for (const seg of r.segments || []) {
      const duration = Math.max(0, Math.min(w.end, seg.to ?? seg.last) - Math.max(w.start, seg.from));
      if (number(duration)) { observed += duration; if (seg.inRange) earning += duration; }
    }
    let transfers = d.flows ? 0 : null;
    const owner = String((d.positions || {}).owner || "").toLowerCase();
    for (const f of (d.flows || []).filter(f => inside(f.t) && ["sent", "received"].includes(f.kind))) {
      if (String(f.kind === "sent" ? f.from : f.to).toLowerCase() !== owner) continue;
      if (!number(f.usd)) { transfers = null; break; }
      transfers += (f.kind === "sent" ? -1 : 1) * f.usd;
    }
    const valueChange = s.valid ? s.last.total - s.first.total : null;
    // Portfolio value already reflects gas; do not subtract it a second time.
    const result = number(valueChange) && number(transfers) ? valueChange - transfers : null;
    return { ...w, coveragePct: s.coveragePct, feesUsd: s.valid ? fees : null, gasUsd: gas,
      timeInRangePct: observed ? earning / observed * 100 : null, observedPositionHours: observed / HOUR,
      valueChangeUsd: valueChange, recordedTransfersUsd: transfers, resultUsd: result,
      returnPct: number(result) && s.first.total > 0 ? result / s.first.total * 100 : null };
  });
}
function build(d, { now = Date.now(), since = now - DAY } = {}) {
  if (!number(since) || since > now || since < now - 30 * DAY) since = now - DAY;
  d = { ...d, series: [...(d.series || [])].sort((a, b) => a.t - b.t) };
  const p = d.positions || {}, at = p.at || null;
  return { ok: true, at: now, since, timezone: TZ, scope: p.ownerLabel || "Main",
    freshness: { positionsAt: at, stale: !at || now - at > 10 * 60000,
      watchAt: d.watch && d.watch.at || null,
      unpricedTokens: d.portfolio && d.portfolio.totals ? d.portfolio.totals.unpricedCount : null },
    attention: attention(d, now), changes: changes(d, since, now), weeks: weekly(d, now),
    notes: "Weekly figures cover the main wallet and two complete Monday–Sunday weeks. Fees are measured accrual estimates. Time in range covers observed position-hours only. Returns subtract recorded external transfers; incomplete transfer history can distort them. Gas is already reflected in value change. Unavailable figures are not zero." };
}
module.exports = { build, weeks, complete, span };
