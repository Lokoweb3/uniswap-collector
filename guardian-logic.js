/**
 * Pure decision logic for the memecoin guardian: given a position's config
 * and its sample history, derive the status the dashboard shows and the
 * alerts that should fire. No I/O, so test/guardian.test.js can feed it
 * synthetic samples.
 *
 * A sample: { t, price (token per ETH), liq (pool active liquidity, Number),
 *             feeUsd (uncollected fees, USD), inRange (bool), valueUsd }
 *
 * Prices are quoted as TOKEN PER ETH (how the entry prices were given), so a
 * higher number means the token is worth LESS. Every comparison below is
 * made on the token's value in ETH (1 / price), so "-30%" means the token
 * lost 30% of its ETH value.
 */
"use strict";
const tokenValue = (price) => (price > 0 ? 1 / price : null);

const HOUR = 3600 * 1000;
const THRESH = {
  dump1hPct: 20, // price down this much in 1h -> dump alert
  closeNowPct: 40, // price down this much from entry -> close-now alert
  feeRateDropPct: 70, // fees/h down this much vs 30 min ago -> volume dying
  liqDropPct: 50, // active liquidity down this much from its recent max -> LPs leaving
  cautionDrawdownPct: 20,
  cautionLiqDropPct: 25,
};

/** Find the newest sample at least `ms` older than `now`. */
function sampleBefore(samples, now, ms) {
  let best = null;
  for (const s of samples) if (now - s.t >= ms && (!best || s.t > best.t)) best = s;
  return best;
}

/**
 * Derive the current status from config + samples (newest last).
 * `now` defaults to the newest sample's time.
 */
function derive(cfgEntry, samples, now = samples.length ? samples[samples.length - 1].t : Date.now()) {
  const last = samples[samples.length - 1];
  if (!last) return null;
  const entry = Number(cfgEntry.entryPrice) || null;
  const priceVsEntryPct = entry && last.price > 0 ? ((tokenValue(last.price) - tokenValue(entry)) / tokenValue(entry)) * 100 : null;
  const drawdownPct = priceVsEntryPct != null ? Math.max(0, -priceVsEntryPct) : null;

  const h1 = sampleBefore(samples, now, HOUR) || samples[0];
  const spanH = h1 && h1 !== last ? Math.max((now - h1.t) / HOUR, 1 / 60) : null;
  const change1hPct = h1 && h1.price > 0 && last.price > 0 && h1 !== last ? ((tokenValue(last.price) - tokenValue(h1.price)) / tokenValue(h1.price)) * 100 : null;
  const velocityPctPerH = change1hPct != null && spanH ? change1hPct / spanH : null;

  // Fee rate: growth of uncollected fees, in USD per hour, over the last 30
  // minutes, compared with the 30 minutes before that. A drop in the fee
  // balance inside a window means a collect happened; the window restarts there.
  const rateOver = (from, to) => {
    const win = samples.filter((x) => x.t >= from && x.t <= to && x.feeUsd != null);
    if (win.length < 2) return null;
    let base = win[0];
    for (const x of win) if (x.feeUsd < base.feeUsd) base = x;
    const end = win[win.length - 1];
    if (end.t <= base.t) return null;
    return (end.feeUsd - base.feeUsd) / ((end.t - base.t) / HOUR);
  };
  const feesPerHour = rateOver(now - 30 * 60000, now) ?? rateOver(now - HOUR, now);
  // 15-minute fee rate for the per-position floor alert; only trusted once the window spans 12+ minutes.
  const win15 = samples.filter((x) => x.t >= now - 15 * 60000 && x.t <= now && x.feeUsd != null);
  let feesPerHour15m = null;
  if (win15.length >= 2) {
    let base = win15[0];
    for (const x of win15) if (x.feeUsd < base.feeUsd) base = x;
    const end = win15[win15.length - 1];
    if (end.t - base.t >= 12 * 60000) feesPerHour15m = (end.feeUsd - base.feeUsd) / ((end.t - base.t) / HOUR);
  }
  const feesPerHour30mAgo = rateOver(now - HOUR, now - 30 * 60000);
  const feeRateChangePct = feesPerHour != null && feesPerHour30mAgo > 0 ? ((feesPerHour - feesPerHour30mAgo) / feesPerHour30mAgo) * 100 : null;

  const liqNow = last.liq;
  const liq1h = h1 && h1 !== last ? h1.liq : null;
  const liqChange1hPct = liq1h > 0 ? ((liqNow - liq1h) / liq1h) * 100 : null;
  const liqMax = samples.reduce((m, s) => Math.max(m, s.liq || 0), 0);
  const liqDropFromMaxPct = liqMax > 0 ? Math.max(0, ((liqMax - liqNow) / liqMax) * 100) : null;

  // Out-of-range duration.
  let outSince = null;
  if (!last.inRange) {
    for (let i = samples.length - 1; i >= 0 && !samples[i].inRange; i--) outSince = samples[i].t;
  }
  const outMinutes = outSince != null ? (now - outSince) / 60000 : 0;

  let status = "green";
  const reasons = [];
  if (!last.inRange) { status = "red"; reasons.push("out of range"); }
  if (drawdownPct != null && drawdownPct >= THRESH.closeNowPct) { status = "red"; reasons.push(`-${drawdownPct.toFixed(0)}% from entry`); }
  if (change1hPct != null && change1hPct <= -THRESH.dump1hPct) { status = "red"; reasons.push(`${change1hPct.toFixed(0)}% in 1h`); }
  if (liqDropFromMaxPct != null && liqDropFromMaxPct >= THRESH.liqDropPct) { status = "red"; reasons.push("LPs leaving"); }
  if (status !== "red") {
    if (drawdownPct != null && drawdownPct >= THRESH.cautionDrawdownPct) { status = "yellow"; reasons.push(`-${drawdownPct.toFixed(0)}% from entry`); }
    if (feeRateChangePct != null && feeRateChangePct <= -THRESH.feeRateDropPct) { status = "yellow"; reasons.push("volume dying"); }
    if (liqDropFromMaxPct != null && liqDropFromMaxPct >= THRESH.cautionLiqDropPct) { status = "yellow"; reasons.push("liquidity thinning"); }
  }

  return {
    tokenId: String(cfgEntry.tokenId), pair: cfgEntry.pair, wallet: cfgEntry.wallet, walletAddress: cfgEntry.walletAddress,
    at: now, price: last.price, entryPrice: entry, priceVsEntryPct, drawdownPct, change1hPct, velocityPctPerH,
    inRange: !!last.inRange, outSince, outMinutes,
    feeUsd: last.feeUsd, feesPerHour, feesPerHour15m, feesPerHour30mAgo, feeRateChangePct,
    // Per-position alert settings (config.json memecoins entry): fee-rate floor, collected-USD target, liquidity-drop alert level.
    feeRateFloorUsdPerHour: Number(cfgEntry.feeRateFloorUsdPerHour) || null,
    collectedTargetUsd: Number(cfgEntry.collectedTargetUsd) || null,
    liqDropAlertPct: Number(cfgEntry.liqDropAlertPct) || null,
    collectedUsd: cfgEntry.collectedUsd != null ? Number(cfgEntry.collectedUsd) : null,
    liq: liqNow, liqChange1hPct, liqDropFromMaxPct, valueUsd: last.valueUsd ?? null,
    status, reasons,
    autoClose: !!cfgEntry.autoClose, maxDrawdownPct: Number(cfgEntry.maxDrawdownPct) || 50,
    outOfRangeCloseMinutes: Number(cfgEntry.outOfRangeCloseMinutes) || 120,
  };
}

/**
 * Alerts to send for a derived status, given the alert memory
 * `sent` ({ key: lastSentMs }, mutated) and `now`. Cool-downs: 60 min for
 * threshold alerts; out/in-range fire once per episode.
 */
function alertsFor(d, sent, now = d.at, cooldownMs = 60 * 60000) {
  const out = [];
  const say = (key, text, once = false) => {
    const last = sent[key] || 0;
    if (once ? last : now - last < cooldownMs) return;
    sent[key] = now;
    out.push(text);
  };
  const id = d.tokenId;
  if (d.change1hPct != null && d.change1hPct <= -THRESH.dump1hPct) say(`dump:${id}`, `🚨 DUMP ALERT ${d.pair} ${d.change1hPct.toFixed(0)}% in 1h — consider closing`);
  if (!d.inRange) {
    say(`out:${id}:${d.outSince}`, `🔴 ${d.pair} OUT OF RANGE — earning $0`, true);
    delete sent[`in:${id}`];
  } else if (Object.keys(sent).some((k) => k.startsWith(`out:${id}:`))) {
    for (const k of Object.keys(sent)) if (k.startsWith(`out:${id}:`)) delete sent[k];
    say(`in:${id}`, `🟢 ${d.pair} back in range`, true);
  }
  if (d.feeRateChangePct != null && d.feeRateChangePct <= -THRESH.feeRateDropPct) say(`volume:${id}`, `⚠️ ${d.pair} volume dying (fees/h ${d.feeRateChangePct.toFixed(0)}%)`);
  if (d.liqDropFromMaxPct != null && d.liqDropFromMaxPct >= THRESH.liqDropPct) say(`liq:${id}`, `🚨 ${d.pair} LPs leaving — exit signal (active liquidity -${d.liqDropFromMaxPct.toFixed(0)}% from recent max)`);
  if (d.drawdownPct != null && d.drawdownPct >= THRESH.closeNowPct) say(`closenow:${id}`, `🚨 ${d.pair} CLOSE NOW (-${d.drawdownPct.toFixed(0)}% from entry)`);

  // Per-position rules (set in the config entry). These go to the group chat; see the guardian's send().
  const group = (text) => out.push({ text, group: true });
  const fpH = d.feesPerHour15m;
  if (d.feeRateFloorUsdPerHour != null && fpH != null) {
    if (fpH < d.feeRateFloorUsdPerHour) {
      // once per episode, and again after 6 h if it stays low
      if (!sent[`feefloor:${id}`] || now - sent[`feefloor:${id}`] >= 6 * HOUR) {
        sent[`feefloor:${id}`] = now;
        group(`⚠️ ${d.pair} fees dropping — $${fpH.toFixed(2)}/hour (below $${d.feeRateFloorUsdPerHour} threshold).\nConsider closing position.`);
      }
    } else delete sent[`feefloor:${id}`];
  }
  if (d.collectedTargetUsd != null && d.collectedUsd != null && d.collectedUsd >= d.collectedTargetUsd) {
    const key = `target:${id}:${d.collectedTargetUsd}`;
    if (!sent[key]) {
      sent[key] = now;
      group(`🎯 ${d.pair} hit $${d.collectedTargetUsd} collected!\nCurrent fees/hour: $${(d.feesPerHour15m ?? d.feesPerHour ?? 0).toFixed(2)}\nConsider closing and redeploying.`);
    }
  }
  if (d.liqDropAlertPct != null && d.liqDropFromMaxPct != null) {
    if (d.liqDropFromMaxPct >= d.liqDropAlertPct) {
      if (!sent[`liqmax:${id}`] || now - sent[`liqmax:${id}`] >= 6 * HOUR) {
        sent[`liqmax:${id}`] = now;
        group(`🚨 ${d.pair} pool thinning fast (-${d.liqDropFromMaxPct.toFixed(0)}% from max).\nFees may drop soon — watch closely.`);
      }
    } else if (d.liqDropFromMaxPct < d.liqDropAlertPct * 0.75) delete sent[`liqmax:${id}`];
  }
  return out;
}

/** Should the guardian close this position now? Returns a reason string or null. */
function shouldClose(d) {
  if (!d.autoClose) return null;
  if (d.drawdownPct != null && d.drawdownPct >= d.maxDrawdownPct) return `price ${d.priceVsEntryPct.toFixed(0)}% from entry (limit -${d.maxDrawdownPct}%)`;
  if (!d.inRange && d.outMinutes >= d.outOfRangeCloseMinutes) return `out of range for ${Math.round(d.outMinutes)} min (limit ${d.outOfRangeCloseMinutes})`;
  return null;
}

module.exports = { derive, alertsFor, shouldClose, THRESH, HOUR };
