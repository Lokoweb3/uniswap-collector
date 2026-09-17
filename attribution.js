/**
 * Performance attribution: where each day's P&L came from, per wallet and for
 * the whole book, plus benchmarks against simply holding ETH or USDG or
 * staking NET.
 *
 * Per wallet and day (local time):
 *   fees     = fee accrual that day (main: fee-daily.json; watched: watch-accrual.json)   exact
 *   staking  = sNET rebase rewards that day, at the sampled price (main only)           exact
 *   vault    = -USDG that left the wallet as LOKOVault splits (fee-split-ledger.json)   exact
 *   gas      = -operator gas that day at the ETH price (charged to the main wallet)     exact
 *   price    = current token holdings x price change over the day (price-log.json)     approximate
 *   flows    = money that crossed the wallet boundary: transfers out (sent) and in
 *              (received), read from token-disposals.json. LP deposits/withdrawals,
 *              collects and sales are internal moves and are NOT flows.           approximate
 *   il       = value change - fees - staking + vault - price - flows             residual
 *   net      = value change - gas  ( = fees + price + il + staking + vault + flows + gas)
 * The value change comes from the hourly totals (portfolio.json for the main
 * wallet, portfolio-all.json for every wallet). The decomposition is wallet
 * balance + LP value + uncollected fees, so internal moves change nothing in dv;
 * only transfers across the wallet boundary (a sent row at the hourly price of
 * that hour, a received row scanned the same way) are flows. Because `il` is the
 * residual, a day with an unpriced flow (or no value sample on one side) is
 * reported with il = null.
 *
 * compute() is pure so the decomposition can be tested with synthetic ledgers;
 * load() assembles the inputs from the ledgers and the server's live views.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { markPartial } = require("./portfolio");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAIN = "main";

// Day keys and day boundaries come from daykey.js (LP_TZ, else the process zone), the same
// calendar the daily line-up, the MCP, staking, the watch view and the audit use.
const { dayKey, dayStart: dayStartTz } = require("./daykey");
const longterm = require("./longterm");
const dayStart = (t) => {
  return dayStartTz(t);
};

/** Latest point at or before `t` in a time-sorted [{t,…}] array, or null. Binary search: the
 *  series are months of hourly rows and every day of every wallet looks up several of them. */
function at(series, t) {
  let lo = 0, hi = series.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) { best = series[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

/** Sorted numeric hour keys of a price-log table, computed once per table object. */
const priceKeyCache = new WeakMap();
function priceKeys(priceHours) {
  let keys = priceKeyCache.get(priceHours);
  if (!keys) {
    keys = Object.keys(priceHours).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    priceKeyCache.set(priceHours, keys);
  }
  return keys;
}

/**
 * Holdings snapshot for a wallet at or just before `t`. `byDay` maps a day key
 * (the ledger's day label) to { addr|'eth': amount }; the snapshot whose day is
 * < = `t` and closest wins. Returns {} when no day covers `t` (a holdings
 * change mid-window only affects the price leg from that day on, and an early
 * day with no snapshot prices as UNKNOWN, never as today's holdings).
 */
function dayHoldingsAt(byDay, t) {
  const day = dayKey(t);
  if (byDay[day] != null) return byDay[day];
  // Fall back to the most recent day-stamped snapshot before `t`, if any. The
  // ledger may not have a row for every single calendar day; the last known
  // holdings before the window still describe that day's position. But an
  // entirely-empty series (no snapshot ever) means UNKNOWN, so {} it is.
  const days = Object.keys(byDay).filter((d) => d <= day).sort();
  return days.length ? byDay[days[days.length - 1]] : {};
}

/** Price table for the hour at or before `t` (price-log rows), or null. */
function priceRowAt(priceHours, t) {
  const keys = priceKeys(priceHours);
  let lo = 0, hi = keys.length - 1, bestH = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keys[mid] <= t) { bestH = keys[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return bestH == null ? null : { h: bestH, row: priceHours[String(bestH)] };
}

/** A ledger timestamp as epoch ms: numbers and numeric strings as-is, ISO strings via Date.parse,
 *  anything else NaN. Ledgers written by different tools have used all three shapes. */
function normT(t) {
  if (typeof t === "number") return Number.isFinite(t) ? t : NaN;
  if (typeof t === "string" && t.trim() !== "") {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
    return Date.parse(t);
  }
  return NaN;
}

function sumHours(hours, from, to) {
  let s = 0;
  for (const [h, usd] of Object.entries(hours || {})) {
    const n = Number(h);
    if (n >= from && n < to) s += Number(usd) || 0;
  }
  return s;
}

/**
 * Pure decomposition. `input`:
 *   wallets: [{ key, label, main }]
 *   valueSeries: { [key]: [{t, v}] }        hourly total value per wallet
 *   feesByHour: { [key]: { hourMs: usd } }  accrual
 *   feesByPosition: { tokenId: { hourMs: usd } }  (main positions)
 *   holdings: { [key]: { addrLower|'eth': amount } }
 *   priceHours: { hourMs: { addrLower|'eth': price } }
 *   stakingDaily: { day: usd }              (main)
 *   vaultSplits: [{ t, key, usd }]          money that left `key`
 *   gasSpends: [{ t, wei }]                 operator gas (charged to main)
 *   flows: [{ t, key, usd, kind }]          money across the wallet boundary: kind "sent"
 *                                            (usd negative) or "received" (usd positive). Only
 *                                            these two kinds count; anything else (sold,
 *                                            deposit, move) is internal and not a flow.
 *   positions: [{ key, tokenId, pair, version, pnlUsd, pnlLegs, pnlSince, pnlApprox, valueUsd, feesUsd }]
 */
function compute(input, { days = 30, now = Date.now() } = {}) {
  const wallets = input.wallets || [];
  const todayStart = dayStart(now);
  const firstDay = todayStart - (days - 1) * DAY;
  const perWallet = {};
  const dayList = [];
  for (let d = firstDay; d <= todayStart; d += DAY) dayList.push(d);

  const ethPriceAt = (t) => {
    const r = priceRowAt(input.priceHours || {}, t);
    return r && r.row.eth != null ? r.row.eth : null;
  };

  for (const w of wallets) {
    const series = (input.valueSeries || {})[w.key] || [];
    const rows = [];
    for (const d0 of dayList) {
      const d1 = Math.min(d0 + DAY, now);
      const fees = sumHours((input.feesByHour || {})[w.key], d0, d1);
      const staking = w.main ? Number((input.stakingDaily || {})[dayKey(d0)] || 0) : 0;
      const vault = -(input.vaultSplits || []).filter((s) => s.key === w.key && s.t >= d0 && s.t < d1).reduce((a, s) => a + (Number(s.usd) || 0), 0);
      // Net money across the wallet boundary today: +received, -sent. Only these two
      // kinds are flows; anything else (sold, deposit, move) is internal.
      const flows = (input.flows || []).filter((f) => (f.kind === "sent" || f.kind === "received") && f.key === w.key && f.t >= d0 && f.t < d1).reduce((a, f) => a + (Number(f.usd) || 0), 0);
      let gas = 0;
      let gasWei = 0n;      // unpriced gas wei (no ETH price at the spend hour): carried, not dropped
      if (w.main) {
        for (const g of input.gasSpends || []) {
          if (g.t >= d0 && g.t < d1) {
            const px = ethPriceAt(g.t);
            if (px != null) gas -= (Number(g.wei) / 1e18) * px;   // priced now
            else gasWei += BigInt(g.wei);                          // price it on a later load
          }
        }
      }
      // Price move on that day's holdings. Only a real number when at least one held
      // token has a price in both day-boundary rows; a missing holdings snapshot
      // (no per-day ledger entry, no wallet snapshot) leaves the move UNKNOWN, never
      // today's holdings and never a fabricated 0.
      //
      // When `holdingsByDay` is supplied (the per-position value ledger + wallet
      // holdings snapshots), the price leg uses the holdings as of THIS day (the
      // snapshot at or just before the day start), so a deposit / withdrawal /
      // rebalance / fee-compound on day N changes the price leg only from day N on.
      // The flat `holdings` map is kept as the fallback so the existing contract
      // (tests, callers without a per-day source) is unchanged.
      let price = null;
      const p0 = priceRowAt(input.priceHours || {}, d0), p1 = priceRowAt(input.priceHours || {}, d1);
      const byDay = (input.holdingsByDay || {})[w.key];
      const hold = byDay != null
        ? dayHoldingsAt(byDay, d0)
        : (input.holdings || {})[w.key] || {};
      if (p0 && p1 && p0.h !== p1.h) {
        let pricedAny = false, acc = 0;
        for (const [addr, amt] of Object.entries(hold)) {
          const a = p0.row[addr], b = p1.row[addr];
          if (a != null && b != null) { pricedAny = true; acc += Number(amt) * (b - a); }
        }
        if (pricedAny) price = acc;
      }
      // Value change from the hourly series.
      const v0 = at(series, d0), v1 = at(series, d1);
      const haveSpan = v0 && v1 && v1.t > v0.t && v0.t >= d0 - 2 * HOUR;
      const dv = haveSpan ? v1.v - v0.v : null;
      const il = dv != null && price != null ? dv - fees - staking + (-vault) - price - flows : null;
      const net = dv != null ? dv + gas : fees + staking + vault + gas + (price || 0) + flows;
      // A day with unpriced gas is incomplete the same way a day with an unpriced
      // price leg is: gasUsd stays the priced part, gasWei carries the unpriced
      // wei, and `exact` goes false. The cost is NOT dropped silently.
      rows.push({ day: dayKey(d0), fees, staking, vault, gas, gasWei: gasWei.toString(), price, flows, il, dv, net, exact: dv != null && price != null && gasWei === 0n });
    }
    const totals = { fees: 0, staking: 0, vault: 0, gas: 0, price: 0, flows: 0, il: 0, net: 0, dv: 0, incomplete: 0 };
    for (const r of rows) {
      totals.fees += r.fees; totals.staking += r.staking; totals.vault += r.vault; totals.gas += r.gas;
      totals.price += r.price || 0; totals.flows += r.flows || 0; totals.il += r.il || 0; totals.net += r.net; totals.dv += r.dv || 0;
      if (!r.exact) totals.incomplete++;
    }
    perWallet[w.key] = { key: w.key, label: w.label, main: !!w.main, rows, totals };
  }

  // Whole book: sum of the wallets per day.
  const book = { rows: [], totals: { fees: 0, staking: 0, vault: 0, gas: 0, price: 0, flows: 0, il: 0, net: 0, dv: 0, incomplete: 0 } };
  for (let i = 0; i < dayList.length; i++) {
    const r = { day: dayKey(dayList[i]), fees: 0, staking: 0, vault: 0, gas: 0, price: 0, flows: 0, il: 0, dv: 0, net: 0, exact: true };
    for (const w of Object.values(perWallet)) {
      const x = w.rows[i];
      r.fees += x.fees; r.staking += x.staking; r.vault += x.vault; r.gas += x.gas;
      r.price += x.price || 0; r.flows += x.flows || 0; r.il += x.il || 0; r.dv += x.dv || 0; r.net += x.net;
      if (!x.exact) r.exact = false;
    }
    book.rows.push(r);
    for (const k of ["fees", "staking", "vault", "gas", "price", "flows", "il", "net", "dv"]) book.totals[k] += r[k];
    if (!r.exact) book.totals.incomplete++;
  }

  // Per position: fees vs everything else, from the PnL legs the cards already carry.
  const positions = (input.positions || []).map((p) => {
    const fees = p.pnlLegs ? (p.pnlLegs.collected || 0) + (p.pnlLegs.uncollected || 0) : (p.feesUsd || 0);
    const priceAndIl = p.pnlUsd != null ? p.pnlUsd - fees : null;
    // Main positions are keyed by tokenId, watched ones by wallet:tokenId (never by a bare id).
    const fbp = input.feesByPosition || {};
    const perPos = p.key === MAIN ? fbp[String(p.tokenId)] : fbp[`${p.key}:${p.tokenId}`];
    const feesToday = perPos ? sumHours(perPos, todayStart, now) : null;
    return { key: p.key, tokenId: String(p.tokenId), pair: p.pair, version: p.version, valueUsd: p.valueUsd || 0, fees, feesToday, priceAndIl, pnlUsd: p.pnlUsd, since: p.pnlSince || null, approx: !!p.pnlApprox, longTerm: p.longTerm || null };
  });

  return {
    ok: true, at: now, days, dayList: dayList.map((t) => dayKey(t)),
    wallets: Object.values(perWallet), book, positions,
    notes: {
      exact: ["fees", "staking", "vault", "gas"],
      approximate: ["price (current holdings x hourly price change)", "flows (wallet-boundary transfers in/out, kind sent/received, valued at the hourly price of that hour)", "il (residual: value change minus fees, staking, vault, price and flows; a day with an unpriced flow has il = null)"],
      incompleteDays: "days without a value sample on both ends have il = null and net = the sum of the exact parts",
    },
  };
}

/**
 * Benchmarks: the book's return over a window against holding ETH, holding
 * USDG (0%) and staking NET (rewards / principal over the same window).
 * `bookSeries` [{t,v}], `ethSeries` [{t,p}], `stakingSamples` [{t,bal}] with
 * `principal`. When the history is shorter than the window, the earliest
 * sample is used and `actualDays` says so.
 */
function benchmarks({ bookSeries = [], ethSeries = [], stakingSamples = [], stakingRewards = null, principal = null, flows = [], flowKey = null, now = Date.now(), windows = [7, 30, 90] }) {
  const out = [];
  for (const w of windows) {
    const from = now - w * DAY;
    const startPt = bookSeries.find((p) => p.t >= from) || bookSeries[0];
    const endPt = bookSeries[bookSeries.length - 1];
    if (!startPt || !endPt || endPt.t <= startPt.t) {
      out.push({ windowDays: w, actualDays: 0, portfolioPct: null, ethPct: null, usdgPct: 0, stakingPct: null, note: "no value history yet" });
      continue;
    }
    const actualDays = (endPt.t - startPt.t) / DAY;
    // A return is what the money earned, not what was paid into it. Transfers across
    // the wallet boundary inside the window are netted out; when they cannot be
    // (an unpriced transfer), or when they dwarf the starting value, or when the
    // history is shorter than the window, no percentage is stated at all — a book
    // that grew from $6 to $2,500 by funding is not an 8,000 % return.
    const win = (flows || []).filter((f) => (f.kind === "sent" || f.kind === "received")
      && (!flowKey || f.key === flowKey) && f.t >= startPt.t && f.t <= endPt.t);
    const unpricedFlow = win.some((f) => f.usd == null || !Number.isFinite(Number(f.usd)));
    const netFlows = win.reduce((a, f) => a + (Number(f.usd) || 0), 0);
    const grown = startPt.v > 0 ? (endPt.v - netFlows) / startPt.v : null;
    let portfolioPct = null, whyNoReturn = null;
    if (!(startPt.v > 0)) whyNoReturn = "the window starts with no recorded value";
    else if (unpricedFlow) whyNoReturn = "a transfer in this window has no recorded price, so it cannot be netted out";
    else if (Math.abs(netFlows) > 0.25 * startPt.v) whyNoReturn = `deposits and withdrawals (${netFlows >= 0 ? "+" : "−"}$${Math.abs(netFlows).toFixed(2)}) dominate this window, so a percentage would describe funding, not performance`;
    else if (grown > 5) whyNoReturn = `the book went from $${startPt.v.toFixed(2)} to $${endPt.v.toFixed(2)} with no recorded transfer to explain it, so the transfer history is incomplete and a percentage would be meaningless`;
    else portfolioPct = (grown - 1) * 100;
    const e0 = ethSeries.find((p) => p.t >= startPt.t - HOUR) || ethSeries[0];
    const e1 = ethSeries.length ? ethSeries[ethSeries.length - 1] : null;
    const ethPct = e0 && e1 && e0.p > 0 && e1.t > e0.t ? (e1.p / e0.p - 1) * 100 : null;
    // Staking: rebase rewards only, never the balance change (a stake deposit is not a
    // return). `stakingRewards` is the deposit-netted list from staking.rewards(); the balance
    // samples only supply the base when no principal is known.
    let stakingPct = null, stakingNote = null;
    if (Array.isArray(stakingRewards)) {
      const s0 = stakingSamples.find((s) => s.t >= startPt.t - HOUR) || stakingSamples[0];
      const base = principal != null && principal > 0 ? principal : s0 && s0.bal > 0 ? s0.bal : null;
      const covered = stakingSamples.length ? stakingSamples[0].t <= startPt.t + DAY : stakingRewards.length > 0;
      if (base != null && covered) {
        const earned = stakingRewards.filter((r) => r.t >= startPt.t - HOUR && r.t <= endPt.t + HOUR).reduce((a, r) => a + (Number(r.amount) || 0), 0);
        stakingPct = (earned / base) * 100;
      } else if (base != null && stakingSamples.length) {
        stakingNote = `staking history starts ${new Date(stakingSamples[0].t).toISOString().slice(0, 10)}`;
      }
    } else if (stakingSamples.length >= 2) {
      // No reward list supplied: balance delta over principal, which counts deposits as return.
      const s0 = stakingSamples.find((s) => s.t >= startPt.t - HOUR) || stakingSamples[0];
      const s1 = stakingSamples[stakingSamples.length - 1];
      const base = principal != null && principal > 0 ? principal : s0.bal;
      if (base > 0 && s1.t > s0.t) stakingPct = ((s1.bal - s0.bal) / base) * 100;
    }
    const notes = [];
    if (whyNoReturn) notes.push(whyNoReturn);
    else if (actualDays < w - 0.5) notes.push(`only ${actualDays.toFixed(1)} days of history`);
    if (!whyNoReturn && netFlows) notes.push(`net transfers of ${netFlows >= 0 ? "+" : "−"}$${Math.abs(netFlows).toFixed(2)} netted out`);
    if (stakingNote) notes.push(stakingNote);
    out.push({
      windowDays: w, actualDays: +actualDays.toFixed(2), since: startPt.t,
      portfolioPct, netFlowsUsd: unpricedFlow ? null : +netFlows.toFixed(2), ethPct, usdgPct: 0, stakingPct,
      note: notes.length ? notes.join("; ") : null,
    });
  }
  return out;
}

/** Assemble compute()/benchmarks() inputs from the ledgers and the server's live views. */
function create({ cfg, getPortfolio, getWatch, getPositions, getStaking, getHistory = null, dir = __dirname }) {
  const readJson = (f, dflt) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      return dflt;
    }
  };
  const WETH = (cfg.contracts && cfg.contracts.weth ? cfg.contracts.weth : "").toLowerCase();
  const normAddr = (a) => {
    const x = String(a || "").toLowerCase();
    return x === WETH || x === "0x0000000000000000000000000000000000000000" ? "eth" : x;
  };

  function load({ days = 30, now = Date.now() } = {}) {
    const pf = getPortfolio ? getPortfolio() : null;
    const wl = getWatch ? getWatch() : null;
    const pos = getPositions ? getPositions() : null;
    const stk = getStaking ? getStaking() : null;

    const ownerLabel = (pos && pos.ownerLabel) || "Main";
    const wallets = [{ key: MAIN, label: ownerLabel, main: true, address: cfg.ownerAddress }];
    for (const w of (wl && wl.wallets) || []) wallets.push({ key: w.address.toLowerCase(), label: w.label || w.address, main: false, address: w.address });

    // Value series: main from portfolio.json, every wallet from portfolio-all.json.
    const valueSeries = {};
    const pj = readJson("portfolio.json", { series: [] });
    // A point where a token priced an hour earlier has no price is a pricing gap, not a
    // value change (portfolio.markPartial); such points are absent for every computation here.
    markPartial(pj.series || []);
    valueSeries[MAIN] = (pj.series || []).filter((s) => !s.partial).map((s) => ({ t: s.t, v: s.total })).filter((p) => p.v != null);
    const pa = readJson("portfolio-all.json", { points: [] });
    const allPts = (pa.points || []).filter((p) => !p.partial);
    for (const w of wallets) {
      if (w.main) continue;
      valueSeries[w.key] = allPts.map((p) => ({ t: p.t, v: p.wallets && p.wallets[w.key] })).filter((p) => p.v != null);
    }
    const bookSeries = allPts.map((p) => ({ t: p.t, v: p.total })).filter((p) => p.v != null);

    // Fees: main per position (fee-daily.json), watched per wallet (watch-accrual.json).
    const fd = readJson("fee-daily.json", { hours: {} });
    const feesByPosition = {};
    const mainHours = {};
    for (const [h, per] of Object.entries(fd.hours || {})) {
      let s = 0;
      for (const [id, usd] of Object.entries(per || {})) {
        feesByPosition[id] = feesByPosition[id] || {};
        feesByPosition[id][h] = (feesByPosition[id][h] || 0) + Number(usd);
        s += Number(usd) || 0;
      }
      mainHours[h] = s;
    }
    const wa = readJson("watch-accrual.json", { hours: {} });
    const feesByHour = { [MAIN]: mainHours };
    for (const w of wallets) if (!w.main) feesByHour[w.key] = (wa.hours || {})[w.key] || {};
    // Watched positions: the same accrual, per position, keyed wallet:tokenId so a watched id can
    // never be read as a main-wallet id.
    for (const [k, hours] of Object.entries(wa.byPos || {})) feesByPosition[k] = hours;

    // Holdings (current): tokens in the wallet + inside positions + uncollected fees.
    const holdings = {};
    const fold = (h, key, amount) => { if (amount == null) return; h[key] = (h[key] || 0) + Number(amount); };
    if (pf && pf.rows) {
      const h = (holdings[MAIN] = {});
      for (const r of pf.rows) fold(h, r.native ? "eth" : normAddr(r.address), r.total);
    }
    // Disk fallback for the main wallet: the live portfolio view may be null at
    // load() time (e.g. mid-refresh). Reconstruct current holdings from the newest
    // persisted portfolio.json series point, which carries per-token amounts (`a`).
    const mainHold = holdings[MAIN];
    if (!(mainHold && Object.keys(mainHold).length) && pj.series && pj.series.length) {
      const last = [...pj.series].reverse().find((s) => !s.partial) || pj.series[pj.series.length - 1];
      const h = (holdings[MAIN] = {});
      for (const [addr, amt] of Object.entries((last && last.a) || {})) fold(h, normAddr(addr === "eth" ? "eth" : addr), amt);
    }
    for (const w of (wl && wl.wallets) || []) {
      const h = (holdings[w.address.toLowerCase()] = {});
      for (const t of (w.holdings && w.holdings.tokens) || []) fold(h, t.native ? "eth" : normAddr(t.address), t.amount != null ? t.amount : t.total);
      for (const p of w.positions || []) {
        fold(h, normAddr(p.token0), p.amount0); fold(h, normAddr(p.token0), p.fee0);
        fold(h, normAddr(p.token1), p.amount1); fold(h, normAddr(p.token1), p.fee1);
      }
    }

    // Per-day holdings (item 3): the price leg uses THAT day's holdings, not today's.
    // The main wallet's persisted portfolio.json series points carry per-token amounts
    // (`a`) with their timestamps, so each point is a holdings snapshot for its day;
    // only points that were not partial (a token priced an hour earlier has no price
    // is a gap, not a change) are snapshots. With no per-day source the map is left
    // undefined and compute() falls back to the flat `holdings` (existing behaviour).
    const holdingsByDay = {};
    const pjPoints = (pj.series || []).filter((s) => s.t != null && !s.partial);
    if (pjPoints.length) {
      const hd = (holdingsByDay[MAIN] = {});
      for (const s of pjPoints) {
        const h = {};
        let any = false;
        for (const [addr, amt] of Object.entries((s && s.a) || {})) {
          if (amt == null) continue;
          fold(h, normAddr(addr === "eth" ? "eth" : addr), amt);
          any = true;
        }
        if (any) hd[dayKey(s.t)] = h;
      }
      if (!Object.keys(hd).length) delete holdingsByDay[MAIN];
    }

    // Prices: price-log hours, normalised so WETH and native ETH share the 'eth' key.
    const pl = readJson("price-log.json", { hours: {} });
    const priceHours = {};
    for (const [h, row] of Object.entries(pl.hours || {})) {
      const r = {};
      for (const [a, p] of Object.entries(row)) r[normAddr(a === "eth" ? "eth" : a)] = p;
      if (r.eth == null && row.eth != null) r.eth = row.eth;
      priceHours[h] = r;
    }
    // The main wallet's own series carries hourly prices further back than the log.
    for (const s of pj.series || []) {
      const h = String(Math.floor(s.t / HOUR) * HOUR);
      if (priceHours[h] || !s.p) continue;
      const r = {};
      for (const [a, p] of Object.entries(s.p)) r[normAddr(a === "eth" ? "eth" : a)] = p;
      priceHours[h] = r;
    }
    const ethSeries = Object.entries(priceHours).map(([h, r]) => ({ t: Number(h), p: r.eth })).filter((x) => x.p != null).sort((a, b) => a.t - b.t);

    // Staking rewards per day (main), from the staking view.
    const stakingDaily = {};
    let stakingSamples = [], stakingRewards = null, principal = null;
    if (stk && stk.tokens && stk.tokens[0]) {
      for (const d of stk.tokens[0].daily || []) stakingDaily[d.day] = (stakingDaily[d.day] || 0) + (Number(d.usd) || 0);
      stakingSamples = (stk.tokens[0].series || []).map((s) => ({ t: s.t, bal: s.bal }));
      principal = stk.tokens[0].principal;
      // Deposit-netted rebase rewards per local day (staking.view() `daily`), placed at that day's noon.
      stakingRewards = (stk.tokens[0].daily || []).map((d) => ({ t: new Date(`${d.day}T12:00:00`).getTime(), amount: Number(d.amount) || 0 })).filter((r) => Number.isFinite(r.t));
    }

    // Vault splits per wallet, gas from the operator's state file.
    // A row whose timestamp cannot be read would silently fail every `>=` comparison and vanish
    // from its day; say so once per ledger instead.
    const badT = {};
    const tOf = (ledger, raw) => { const t = normT(raw); if (Number.isNaN(t)) { if (!badT[ledger]) { badT[ledger] = true; console.warn(`attribution: ${ledger} has a row with an unreadable timestamp (${JSON.stringify(raw)}); such rows are skipped`); } return null; } return t; };
    const splits = readJson("fee-split-ledger.json", []);
    const vaultSplits = [];
    for (const r of Array.isArray(splits) ? splits : []) {
      if (r.status === "failed" || !r.splitUsdg) continue;
      const t = tOf("fee-split-ledger.json", r.timestamp);
      if (t == null) continue;
      const addr = String(r.walletAddress || "").toLowerCase();
      const key = !addr || addr === String(cfg.ownerAddress).toLowerCase() ? MAIN : addr;
      vaultSplits.push({ t, key, usd: Number(r.splitUsdg) });
    }
    const st = readJson("state.json", {});
    const gasSpends = [];
    for (const g of st.gasSpends || []) {
      const t = tOf("state.json gasSpends", g && g.t);
      if (t != null) gasSpends.push({ t, wei: g.wei });
    }

    // Flows: money that crossed the wallet boundary, and nothing else. The value series
    // is wallet balance + LP value + uncollected fees, so LP deposits/withdrawals,
    // collects and sales are internal moves that change nothing in dv. The only flows
    // are transfers in/out from token-disposals.json:
    //   out: kind "sent"   (value already USD per wallet)                        -> -
    //   in:  kind "received" (added by strategy.scanDisposals, valued at the hourly
    //        price of that hour like "sent")                                     -> +
    // kind "sold" is a same-wallet swap through a router (internal); "deposit" and
    // "move" are protocol moves (internal). None of those are flows.
    const flows = [];
    for (const r of readJson("token-disposals.json", { rows: [] }).rows || []) {
      if (!r || r.usd == null || !r.t) continue;
      if (r.kind !== "received" && r.kind !== "sent") continue; // sold / deposit / move: internal, not a flow
      const t = tOf("token-disposals.json", r.t);
      if (t == null) continue;
      if (r.kind === "received") {
        const wkey = r.to ? r.to.toLowerCase() : (r.wallet ? r.wallet.toLowerCase() : MAIN);
        const key = wkey === String(cfg.ownerAddress).toLowerCase() ? MAIN : wkey;
        flows.push({ t, key, kind: "received", usd: Number(r.usd) });
        continue;
      }
      const wkey = r.from ? r.from.toLowerCase() : (r.wallet ? r.wallet.toLowerCase() : MAIN);
      const key = wkey === String(cfg.ownerAddress).toLowerCase() ? MAIN : wkey;
      flows.push({ t, key, kind: "sent", usd: -Number(r.usd) });
    }

    // Positions with their PnL legs, main and watched.
    const positions = [];
    for (const p of (pos && pos.positions) || []) positions.push({ key: MAIN, tokenId: p.tokenId, pair: p.pair, version: p.version, pnlUsd: p.pnlUsd, pnlLegs: p.pnlLegs, pnlSince: p.pnlSince, pnlApprox: p.pnlApprox, valueUsd: p.valueUsd, feesUsd: p.feesUsd });
    for (const w of (wl && wl.wallets) || []) for (const p of w.positions || []) positions.push({ key: w.address.toLowerCase(), tokenId: p.tokenId, pair: p.pair, version: p.version, pnlUsd: p.pnlUsd, pnlLegs: p.pnlLegs, pnlSince: p.pnlSince, pnlApprox: p.pnlApprox, valueUsd: p.valueUsd, feesUsd: p.feesUsd });

    // Long-term returns per position (longterm.js): every wallet, chained across re-mints.
    {
      const open = [];
      for (const p of (pos && pos.positions) || []) open.push({ p, walletAddress: cfg.ownerAddress });
      for (const w of (wl && wl.wallets) || []) for (const p of w.positions || []) open.push({ p, walletAddress: w.address });
      const lt = longterm.compute({
        open, collects: (getHistory && getHistory()) || [],
        rangeLog: readJson("range-log.json", { positions: {} }).positions || {},
        values: readJson("position-values.json", {}), now,
      });
      for (const q of positions) {
        const wa = q.key === MAIN ? String(cfg.ownerAddress).toLowerCase() : q.key;
        q.longTerm = lt.get(`${wa}:${longterm.idKey(q.tokenId, q.version)}`) || null;
      }
    }
    const input = { wallets, valueSeries, feesByHour, feesByPosition, holdings, holdingsByDay, priceHours, stakingDaily, vaultSplits, gasSpends, positions, flows };
    const result = compute(input, { days, now });
    result.benchmarks = benchmarks({ bookSeries, ethSeries, stakingSamples, stakingRewards, principal, flows, now });
    result.mainBenchmarks = benchmarks({ bookSeries: valueSeries[MAIN], ethSeries, stakingSamples, stakingRewards, principal, flows, flowKey: MAIN, now });
    result.history = { bookSince: bookSeries.length ? bookSeries[0].t : null, mainSince: valueSeries[MAIN].length ? valueSeries[MAIN][0].t : null, priceSince: ethSeries.length ? ethSeries[0].t : null };
    return result;
  }

  return { load, compute, benchmarks };
}

module.exports = { create, compute, benchmarks, dayKey };
