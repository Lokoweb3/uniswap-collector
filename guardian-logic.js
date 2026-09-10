/**
 * Pure decision logic for the risk guardian: given a position's rule block
 * and its sample history, derive the status the dashboard shows, the alerts
 * that should fire and whether the position should be closed. No I/O, so
 * test/guardian.test.js can feed it synthetic samples.
 *
 * A sample: { t, price (token per quote), liq (pool active liquidity or TVL,
 *             Number), feeUsd (uncollected fees, USD), inRange (bool), valueUsd }
 *
 * Prices are quoted as TOKEN PER QUOTE (ETH or the reference stable), so a
 * higher number means the token is worth LESS. Every comparison below is
 * made on the token's value in the quote (1 / price), so "-30%" means the
 * token lost 30% of its quote value.
 *
 * One rule block per position (settings.json `risk.memecoins[]`, or the defaults
 * under `risk.defaults` for discovered positions):
 *   alertPct            price down this much in 1h            -> dump alert
 *   closePct            price down this much from entry       -> close-now alert, or close when autoClose
 *   outOfRangeMinutes   out of range this long                -> alert, or close when autoClose
 *   tvlDropPct          pool liquidity down this much vs 24h  -> LPs-leaving alert
 *   feeFloorPerHour     15-min fee rate below this (USD/h)    -> fees-dropping alert (null = off)
 *   collectedTargetUsd  swept USDG reached this               -> target alert, once (optional)
 *   autoClose           close through the operator when a close trigger holds
 *   alertOnly           never close, whatever autoClose says (safety latch)
 * Every event sends exactly one Telegram message, with the cool-downs in alertsFor.
 */
"use strict";
const tokenValue = (price) => (price > 0 ? 1 / price : null);

const HOUR = 3600 * 1000;
const RULE_DEFAULTS = { alertPct: 20, closePct: 50, outOfRangeMinutes: 120, tvlDropPct: 50, feeFloorPerHour: null, collectedTargetUsd: null, autoClose: false, alertOnly: true };
const VOLUME_DROP_PCT = 70; // fees/h down this much vs 30 min ago -> "volume dying" status (no alert: the fee floor covers it)

/** The effective rule block for one entry: its own values over the defaults, numbers checked. */
function rulesOf(entry = {}, defaults = {}) {
  const base = { ...RULE_DEFAULTS, ...defaults };
  const num = (k, allowNull) => {
    // An explicit null on a floor/target switches it off; on a threshold it means "use the default".
    const own = entry[k] !== undefined && (allowNull || (entry[k] !== null && entry[k] !== ""));
    const v = own ? entry[k] : base[k];
    if (v == null || v === "") return allowNull ? null : RULE_DEFAULTS[k];
    const n = Number(v);
    if (isFinite(n) && n >= 0) return n;
    return allowNull ? null : own ? Number(base[k]) >= 0 ? Number(base[k]) : RULE_DEFAULTS[k] : RULE_DEFAULTS[k];
  };
  return {
    alertPct: num("alertPct"), closePct: num("closePct"), outOfRangeMinutes: num("outOfRangeMinutes"), tvlDropPct: num("tvlDropPct"),
    feeFloorPerHour: num("feeFloorPerHour", true), collectedTargetUsd: num("collectedTargetUsd", true),
    autoClose: (entry.autoClose !== undefined ? entry.autoClose : base.autoClose) === true,
    alertOnly: (entry.alertOnly !== undefined ? entry.alertOnly : base.alertOnly) !== false,
  };
}

/** Find the newest sample at least `ms` older than `now`. */
function sampleBefore(samples, now, ms) {
  let best = null;
  for (const s of samples) if (now - s.t >= ms && (!best || s.t > best.t)) best = s;
  return best;
}

/**
 * Derive the current status from the rule block + samples (newest last).
 * `now` defaults to the newest sample's time.
 */
function derive(cfgEntry, samples, now = samples.length ? samples[samples.length - 1].t : Date.now(), defaults = {}) {
  const last = samples[samples.length - 1];
  if (!last) return null;
  const rules = rulesOf(cfgEntry, defaults);
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
  // 15-minute fee rate for the fee-floor alert; only trusted once the window spans 12+ minutes.
  const win15 = samples.filter((x) => x.t >= now - 15 * 60000 && x.t <= now && x.feeUsd != null);
  let feesPerHour15m = null;
  if (win15.length >= 2) {
    let base = win15[0];
    for (const x of win15) if (x.feeUsd < base.feeUsd) base = x;
    const end = win15[win15.length - 1];
    if (end.t - base.t >= 12 * 60000) feesPerHour15m = (end.feeUsd - base.feeUsd) / ((end.t - base.t) / HOUR);
  }
  const feesPerHour30mAgo = rateOver(now - HOUR, now - 30 * 60000);
  // A collect inside the last hour resets the fee balance; the comparison would then read as a crash, so it is skipped.
  const collectedRecently = samples.some((x, i) => i > 0 && x.t >= now - HOUR && x.feeUsd != null && samples[i - 1].feeUsd != null && x.feeUsd < samples[i - 1].feeUsd * 0.5);
  const feeRateChangePct = !collectedRecently && feesPerHour != null && feesPerHour30mAgo > 0 ? ((feesPerHour - feesPerHour30mAgo) / feesPerHour30mAgo) * 100 : null;

  const liqNow = last.liq;
  const liq1h = h1 && h1 !== last ? h1.liq : null;
  const liqChange1hPct = liq1h > 0 ? ((liqNow - liq1h) / liq1h) * 100 : null;
  const liqMax = samples.reduce((m, s) => Math.max(m, s.liq || 0), 0);
  const liqDropFromMaxPct = liqMax > 0 && liqNow != null ? Math.max(0, ((liqMax - liqNow) / liqMax) * 100) : null;

  // Out-of-range duration: our own samples, or the dashboard's range log when the entry carries it.
  let outSince = null;
  if (!last.inRange) {
    for (let i = samples.length - 1; i >= 0 && !samples[i].inRange; i--) outSince = samples[i].t;
    if (cfgEntry.outSince && cfgEntry.outSince < outSince) outSince = cfgEntry.outSince;
  }
  const outMinutes = outSince != null ? (now - outSince) / 60000 : 0;

  const feeFloorHit = rules.feeFloorPerHour != null && feesPerHour15m != null && feesPerHour15m < rules.feeFloorPerHour;
  let status = "green";
  const reasons = [];
  if (!last.inRange) { status = "red"; reasons.push(outMinutes >= rules.outOfRangeMinutes ? `out of range ${Math.round(outMinutes)} min` : "out of range"); }
  if (drawdownPct != null && drawdownPct >= rules.closePct) { status = "red"; reasons.push(`-${drawdownPct.toFixed(0)}% from entry`); }
  if (change1hPct != null && change1hPct <= -rules.alertPct) { status = "red"; reasons.push(`${change1hPct.toFixed(0)}% in 1h`); }
  if (liqDropFromMaxPct != null && liqDropFromMaxPct >= rules.tvlDropPct) { status = "red"; reasons.push("LPs leaving"); }
  if (status !== "red") {
    if (drawdownPct != null && drawdownPct >= rules.closePct / 2) { status = "yellow"; reasons.push(`-${drawdownPct.toFixed(0)}% from entry`); }
    if (change1hPct != null && change1hPct <= -rules.alertPct / 2) { status = "yellow"; reasons.push(`${change1hPct.toFixed(0)}% in 1h`); }
    if (feeRateChangePct != null && feeRateChangePct <= -VOLUME_DROP_PCT) { status = "yellow"; reasons.push("volume dying"); }
    if (feeFloorHit) { status = "yellow"; reasons.push(`fees under $${rules.feeFloorPerHour}/h`); }
    if (liqDropFromMaxPct != null && liqDropFromMaxPct >= rules.tvlDropPct / 2) { status = "yellow"; reasons.push("liquidity thinning"); }
  }

  return {
    tokenId: String(cfgEntry.tokenId), version: Number(cfgEntry.version) === 3 ? 3 : 4, pair: cfgEntry.pair, wallet: cfgEntry.wallet, walletAddress: cfgEntry.walletAddress,
    at: now, price: last.price, entryPrice: entry, priceVsEntryPct, drawdownPct, change1hPct, velocityPctPerH,
    inRange: !!last.inRange, outSince, outMinutes,
    feeUsd: last.feeUsd, feesPerHour, feesPerHour15m, feesPerHour30mAgo, feeRateChangePct, feeFloorHit,
    collectedUsd: cfgEntry.collectedUsd != null ? Number(cfgEntry.collectedUsd) : null,
    liq: liqNow, liqChange1hPct, liqDropFromMaxPct, valueUsd: last.valueUsd ?? null,
    status, reasons,
    rules, ...rules, // flat copies for the dashboard and older readers
    canClose: rules.autoClose && !rules.alertOnly,
  };
}

/**
 * Alerts to send for a derived status, given the alert memory
 * `sent` ({ key: lastSentMs }, mutated) and `now`. One message per event:
 * a dump / close-now alert repeats after `cooldownMs` while it holds,
 * range and LPs-leaving alerts fire once per episode, fee floor and
 * LPs-leaving repeat after six hours if they persist. When `closing` is
 * set the close path reports instead of the close-now / out-for-long alerts.
 */
function alertsFor(d, sent, now = d.at, cooldownMs = 60 * 60000, { closing = false } = {}) {
  const out = [];
  const say = (key, text, once = false) => {
    const last = sent[key] || 0;
    if (once ? last : now - last < cooldownMs) return;
    sent[key] = now;
    out.push(text);
  };
  const id = d.tokenId, r = d.rules;
  const closeHint = d.canClose ? "auto-close will run once the trigger holds" : "consider closing";
  if (d.change1hPct != null && d.change1hPct <= -r.alertPct) say(`dump:${id}`, `🚨 DUMP ALERT ${d.pair} ${d.change1hPct.toFixed(0)}% in 1h — consider closing`);
  else if (d.change1hPct != null && d.change1hPct > -r.alertPct / 2) delete sent[`dump:${id}`]; // recovered: a fresh dump can alert again inside the cool-down
  if (!d.inRange) {
    say(`out:${id}:${d.outSince}`, `🔴 ${d.pair} OUT OF RANGE — earning $0`, true);
    delete sent[`in:${id}`];
    if (!closing && d.outMinutes >= r.outOfRangeMinutes) say(`outlong:${id}:${d.outSince}`, `🔴 ${d.pair} out of range for ${Math.round(d.outMinutes)} min (limit ${r.outOfRangeMinutes}) — ${closeHint}`, true);
  } else if (Object.keys(sent).some((k) => k.startsWith(`out:${id}:`))) {
    for (const k of Object.keys(sent)) if (k.startsWith(`out:${id}:`) || k.startsWith(`outlong:${id}:`)) delete sent[k];
    say(`in:${id}`, `🟢 ${d.pair} back in range`, true);
  }
  if (d.liqDropFromMaxPct != null) {
    if (d.liqDropFromMaxPct >= r.tvlDropPct) {
      if (!sent[`liq:${id}`] || now - sent[`liq:${id}`] >= 6 * HOUR) {
        sent[`liq:${id}`] = now;
        out.push(`🚨 ${d.pair} LPs leaving — pool liquidity -${d.liqDropFromMaxPct.toFixed(0)}% from its 24h high (limit -${r.tvlDropPct}%)`);
      }
    } else if (d.liqDropFromMaxPct < r.tvlDropPct * 0.75) delete sent[`liq:${id}`];
  }
  if (!closing && d.drawdownPct != null && d.drawdownPct >= r.closePct) say(`closenow:${id}`, `🚨 ${d.pair} CLOSE NOW (-${d.drawdownPct.toFixed(0)}% from entry, limit -${r.closePct}%)`);
  if (r.feeFloorPerHour != null && d.feesPerHour15m != null) {
    if (d.feesPerHour15m < r.feeFloorPerHour) {
      if (!sent[`feefloor:${id}`] || now - sent[`feefloor:${id}`] >= 6 * HOUR) {
        sent[`feefloor:${id}`] = now;
        out.push(`⚠️ ${d.pair} fees dropping — $${d.feesPerHour15m.toFixed(2)}/hour (below $${r.feeFloorPerHour} floor).\nConsider closing position.`);
      }
    } else delete sent[`feefloor:${id}`];
  }
  if (r.collectedTargetUsd != null && d.collectedUsd != null && d.collectedUsd >= r.collectedTargetUsd) {
    const key = `target:${id}:${r.collectedTargetUsd}`;
    if (!sent[key]) {
      sent[key] = now;
      out.push(`🎯 ${d.pair} hit $${r.collectedTargetUsd} collected!\nCurrent fees/hour: $${(d.feesPerHour15m ?? d.feesPerHour ?? 0).toFixed(2)}\nConsider closing and redeploying.`);
    }
  }
  return out;
}

/** Should the guardian close this position now? Returns a reason string or null. */
function shouldClose(d) {
  if (!d.canClose) return null;
  const r = d.rules;
  if (d.drawdownPct != null && d.drawdownPct >= r.closePct) return `price ${d.priceVsEntryPct.toFixed(0)}% from entry (limit -${r.closePct}%)`;
  if (!d.inRange && d.outMinutes >= r.outOfRangeMinutes) return `out of range for ${Math.round(d.outMinutes)} min (limit ${r.outOfRangeMinutes})`;
  return null;
}

module.exports = { derive, alertsFor, shouldClose, rulesOf, RULE_DEFAULTS, HOUR };
