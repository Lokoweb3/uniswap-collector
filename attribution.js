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

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAIN = "main";

const dayKey = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayStart = (t) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Latest point at or before `t` in a time-sorted [{t,…}] array, or null. */
function at(series, t) {
  let best = null;
  for (const p of series) {
    if (p.t <= t) best = p;
    else break;
  }
  return best;
}

/** Price table for the hour at or before `t` (price-log rows), or null. */
function priceRowAt(priceHours, t) {
  let bestH = null;
  for (const h of Object.keys(priceHours)) {
    const n = Number(h);
    if (n <= t && (bestH == null || n > bestH)) bestH = n;
  }
  return bestH == null ? null : { h: bestH, row: priceHours[String(bestH)] };
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
      if (w.main) {
        for (const g of input.gasSpends || []) {
          if (g.t >= d0 && g.t < d1) {
            const px = ethPriceAt(g.t);
            if (px != null) gas -= (Number(g.wei) / 1e18) * px;
          }
        }
      }
      // Price move on current holdings. Only a real number when at least one held
      // token has a price in both day-boundary rows; empty holdings (e.g. the live
      // portfolio view was absent when load() built them) or no matching price means
      // the move is UNKNOWN, not zero -- a confident 0 would fabricate a price leg.
      let price = null;
      const p0 = priceRowAt(input.priceHours || {}, d0), p1 = priceRowAt(input.priceHours || {}, d1);
      const hold = (input.holdings || {})[w.key] || {};
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
      rows.push({ day: dayKey(d0), fees, staking, vault, gas, price, flows, il, dv, net, exact: dv != null && price != null });
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
    const feesToday = (input.feesByPosition || {})[String(p.tokenId)] ? sumHours(input.feesByPosition[String(p.tokenId)], todayStart, now) : null;
    return { key: p.key, tokenId: String(p.tokenId), pair: p.pair, version: p.version, valueUsd: p.valueUsd || 0, fees, feesToday, priceAndIl, pnlUsd: p.pnlUsd, since: p.pnlSince || null, approx: !!p.pnlApprox };
  });

  return {
    ok: true, at: now, days, dayList: dayList.map(dayKey),
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
function benchmarks({ bookSeries = [], ethSeries = [], stakingSamples = [], principal = null, now = Date.now(), windows = [7, 30, 90] }) {
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
    const portfolioPct = startPt.v > 0 ? (endPt.v / startPt.v - 1) * 100 : null;
    const e0 = ethSeries.find((p) => p.t >= startPt.t - HOUR) || ethSeries[0];
    const e1 = ethSeries.length ? ethSeries[ethSeries.length - 1] : null;
    const ethPct = e0 && e1 && e0.p > 0 && e1.t > e0.t ? (e1.p / e0.p - 1) * 100 : null;
    let stakingPct = null;
    if (stakingSamples.length >= 2) {
      const s0 = stakingSamples.find((s) => s.t >= startPt.t - HOUR) || stakingSamples[0];
      const s1 = stakingSamples[stakingSamples.length - 1];
      const base = principal != null && principal > 0 ? principal : s0.bal;
      if (base > 0 && s1.t > s0.t) stakingPct = ((s1.bal - s0.bal) / base) * 100;
    }
    out.push({
      windowDays: w, actualDays: +actualDays.toFixed(2), since: startPt.t,
      portfolioPct, ethPct, usdgPct: 0, stakingPct,
      note: actualDays < w - 0.5 ? `only ${actualDays.toFixed(1)} days of history` : null,
    });
  }
  return out;
}

/** Assemble compute()/benchmarks() inputs from the ledgers and the server's live views. */
function create({ cfg, getPortfolio, getWatch, getPositions, getStaking, dir = __dirname }) {
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
    valueSeries[MAIN] = (pj.series || []).map((s) => ({ t: s.t, v: s.total })).filter((p) => p.v != null);
    const pa = readJson("portfolio-all.json", { points: [] });
    for (const w of wallets) {
      if (w.main) continue;
      valueSeries[w.key] = (pa.points || []).map((p) => ({ t: p.t, v: p.wallets && p.wallets[w.key] })).filter((p) => p.v != null);
    }
    const bookSeries = (pa.points || []).map((p) => ({ t: p.t, v: p.total })).filter((p) => p.v != null);

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

    // Holdings (current): tokens in the wallet + inside positions + uncollected fees.
    const holdings = {};
    if (pf && pf.rows) {
      holdings[MAIN] = {};
      for (const r of pf.rows) {
        const k = r.native ? "eth" : normAddr(r.address);
        holdings[MAIN][k] = (holdings[MAIN][k] || 0) + (Number(r.total) || 0);
      }
    }
    for (const w of (wl && wl.wallets) || []) {
      const h = (holdings[w.address.toLowerCase()] = {});
      for (const t of (w.holdings && w.holdings.tokens) || []) {
        const k = t.native ? "eth" : normAddr(t.address);
        h[k] = (h[k] || 0) + (Number(t.amount) || 0);
      }
      for (const p of w.positions || []) {
        const k0 = normAddr(p.token0), k1 = normAddr(p.token1);
        h[k0] = (h[k0] || 0) + (Number(p.amount0) || 0) + (Number(p.fee0) || 0);
        h[k1] = (h[k1] || 0) + (Number(p.amount1) || 0) + (Number(p.fee1) || 0);
      }
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
    let stakingSamples = [], principal = null;
    if (stk && stk.tokens && stk.tokens[0]) {
      for (const d of stk.tokens[0].daily || []) stakingDaily[d.day] = (stakingDaily[d.day] || 0) + (Number(d.usd) || 0);
      stakingSamples = (stk.tokens[0].series || []).map((s) => ({ t: s.t, bal: s.bal }));
      principal = stk.tokens[0].principal;
    }

    // Vault splits per wallet, gas from the operator's state file.
    const splits = readJson("fee-split-ledger.json", []);
    const vaultSplits = [];
    for (const r of Array.isArray(splits) ? splits : []) {
      if (r.status === "failed" || !r.splitUsdg) continue;
      const addr = String(r.walletAddress || "").toLowerCase();
      const key = !addr || addr === String(cfg.ownerAddress).toLowerCase() ? MAIN : addr;
      vaultSplits.push({ t: Date.parse(r.timestamp), key, usd: Number(r.splitUsdg) });
    }
    const st = readJson("state.json", {});
    const gasSpends = (st.gasSpends || []).map((g) => ({ t: g.t, wei: g.wei }));

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
      if (r.kind === "received") {
        const wkey = r.to ? r.to.toLowerCase() : (r.wallet ? r.wallet.toLowerCase() : MAIN);
        const key = wkey === String(cfg.ownerAddress).toLowerCase() ? MAIN : wkey;
        flows.push({ t: r.t, key, kind: "received", usd: Number(r.usd) });
        continue;
      }
      if (r.kind !== "sent") continue; // sold / deposit / move: internal, not a flow
      const wkey = r.from ? r.from.toLowerCase() : (r.wallet ? r.wallet.toLowerCase() : MAIN);
      const key = wkey === String(cfg.ownerAddress).toLowerCase() ? MAIN : wkey;
      flows.push({ t: r.t, key, kind: "sent", usd: -Number(r.usd) });
    }

    // Positions with their PnL legs, main and watched.
    const positions = [];
    for (const p of (pos && pos.positions) || []) positions.push({ key: MAIN, tokenId: p.tokenId, pair: p.pair, version: p.version, pnlUsd: p.pnlUsd, pnlLegs: p.pnlLegs, pnlSince: p.pnlSince, pnlApprox: p.pnlApprox, valueUsd: p.valueUsd, feesUsd: p.feesUsd });
    for (const w of (wl && wl.wallets) || []) for (const p of w.positions || []) positions.push({ key: w.address.toLowerCase(), tokenId: p.tokenId, pair: p.pair, version: p.version, pnlUsd: p.pnlUsd, pnlLegs: p.pnlLegs, pnlSince: p.pnlSince, pnlApprox: p.pnlApprox, valueUsd: p.valueUsd, feesUsd: p.feesUsd });

    const input = { wallets, valueSeries, feesByHour, feesByPosition, holdings, priceHours, stakingDaily, vaultSplits, gasSpends, positions, flows };
    const result = compute(input, { days, now });
    result.benchmarks = benchmarks({ bookSeries, ethSeries, stakingSamples, principal, now });
    result.mainBenchmarks = benchmarks({ bookSeries: valueSeries[MAIN], ethSeries, stakingSamples, principal, now });
    result.history = { bookSince: bookSeries.length ? bookSeries[0].t : null, mainSince: valueSeries[MAIN].length ? valueSeries[MAIN][0].t : null, priceSince: ethSeries.length ? ethSeries[0].t : null };
    return result;
  }

  return { load, compute, benchmarks };
}

module.exports = { create, compute, benchmarks, dayKey };
