#!/usr/bin/env node
/**
 * MCP server for the LP dashboard.
 *
 * Exposes the dashboard's read-only data as tools, so Claude Desktop or
 * Claude Code can answer questions from the live numbers: open positions,
 * the collects history, the daily revenue ledger, and the owner's wallet
 * balances. Everything is fetched from the running dashboard server over
 * loopback; nothing here can sign, collect, or reach the operator key.
 *
 * Run:      node lp-mcp.mjs            (stdio transport; the client spawns it)
 * Dashboard: LP_DASHBOARD_URL, default http://127.0.0.1:8787
 * Timezone:  LP_TZ for "day" grouping, default America/New_York
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";

const BASE = (process.env.LP_DASHBOARD_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const TZ = process.env.LP_TZ || "America/New_York";

async function get(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  const j = await r.json();
  if (j.ok === false) throw new Error(`${path} -> ${j.error || "not ok"}`);
  return j;
}

const text = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 1) }] });
const fail = (err) => ({
  isError: true,
  content: [{ type: "text", text: `Dashboard not reachable at ${BASE}: ${err.message}. Start it with ./run-dashboard.sh.` }],
});

const dayKey = (t) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
const monthKey = (t) => dayKey(t).slice(0, 7);
const round = (n, d = 2) => (n == null ? null : +Number(n).toFixed(d));

/** Build a server with the four tools. Each transport gets its own instance. */
export function createServer() {
const server = new McpServer({ name: "lp-dashboard", version: "1.0.0" });

server.registerTool(
  "positions",
  {
    title: "Open LP positions",
    description:
      "Current state of every open Uniswap v3/v4 position owned by the wallet: pair, fee tier, in-range status and distance to each edge, USD value, uncollected fees, accrual rate per day, APR, PnL vs holding with its legs, and whether the collector will take its fees next run. Also totals and the list of closed positions. Prices are read from pool state; tokens not paired with WETH or the reference stable have no USD value.",
    inputSchema: {
      include_closed: z.boolean().optional().describe("Also list closed positions (default false)"),
    },
  },
  async ({ include_closed }) => {
    try {
      const d = await get("/api/positions");
      const positions = d.positions.map((p) => ({
        tokenId: p.nftId || p.tokenId,
        version: p.version || 3,
        pair: p.pair,
        feeTier: p.feeTierLabel,
        inRange: p.inRange,
        state: p.inRange ? (p.toUpperPct < 12 || p.toLowerPct < 12 ? "near the edge" : "in range") : p.rawPos > 1 ? "above range (idle)" : "below range (idle)",
        pctToUpperEdge: round(p.toUpperPct, 1),
        pctToLowerEdge: round(p.toLowerPct, 1),
        price: { current: p.priceCurrent, lower: p.priceLower, upper: p.priceUpper, unit: `${p.symbol1} per ${p.symbol0}` },
        holdings: { [p.symbol0]: p.amount0, [p.symbol1]: p.amount1 },
        valueUsd: round(p.valueUsd),
        uncollectedFees: { [p.symbol0]: p.fee0, [p.symbol1]: p.fee1, usd: round(p.feesUsd) },
        accrual: p.dailyUsd != null ? { usdPerDay: round(p.dailyUsd), aprPct: round(p.aprPct, 1), measuredOverHours: round(p.rateWindowH, 1) } : null,
        timeInRange: p.range ? { pctInRange: round(p.range.pctInRange, 1), trackedHours: round(p.range.trackedHours, 1), since: new Date(p.range.since).toISOString(), flips: p.range.flips, currentlyInRangeSince: new Date(p.range.streakSince).toISOString() } : null,
        collectableNextRun: p.eligible,
        approvedForCollector: p.approved,
        pnlVsHolding: p.pnlUsd != null ? { usd: round(p.pnlUsd), pct: round(p.pnlPct, 1), since: new Date(p.pnlSince).toISOString(), verified: !p.pnlApprox, legs: p.pnlLegs && Object.fromEntries(Object.entries(p.pnlLegs).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])) } : null,
      }));
      return text({
        asOf: new Date(d.at).toISOString(),
        block: d.blockNumber,
        wethUsd: round(d.wethUsd),
        totals: Object.fromEntries(Object.entries(d.totals).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])),
        collector: d.ops,
        positions,
        closed: include_closed ? d.closed : `${d.closed.length} closed (pass include_closed to list)`,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "watched_wallets",
  {
    title: "Watched wallets",
    description:
      "Read-only view of the extra wallets listed in wallets.json (fallback: config.json watchWallets): each wallet's total value (tokens held in the wallet, valued like the portfolio, plus positions and fees; top tokens listed) and its open Uniswap v3/v4 positions (pair, fee tier, in-range status, distance to edges, price range, holdings, USD value, uncollected fees) and totals. These wallets are only observed, never collected from. Empty when no wallet is configured.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = await get("/api/watch");
      return text({
        asOf: new Date(d.at).toISOString(),
        wallets: d.wallets.map((w) => ({
          address: w.address, label: w.label, ok: w.ok, error: w.error,
          totals: w.totals && Object.fromEntries(Object.entries(w.totals).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])),
          closed: w.closed,
          positions: (w.positions || []).map((p) => ({
            tokenId: p.nftId, version: p.version, pair: p.pair, feeTier: p.feeTierLabel, inRange: p.inRange,
            state: p.inRange ? "in range" : p.rawPos > 1 ? "above range (idle)" : "below range (idle)",
            pctToUpperEdge: round(p.toUpperPct, 1), pctToLowerEdge: round(p.toLowerPct, 1),
            price: { current: p.priceCurrent, lower: p.priceLower, upper: p.priceUpper, unit: `${p.symbol1} per ${p.symbol0}` },
            holdings: { [p.symbol0]: p.amount0, [p.symbol1]: p.amount1 },
            valueUsd: round(p.valueUsd),
            uncollectedFees: { [p.symbol0]: p.fee0, [p.symbol1]: p.fee1, usd: round(p.feesUsd) },
          })),
        })),
      });
    } catch (err) {
      return fail(err);
    }
  }
);
server.registerTool(
  "collects",
  {
    title: "Fee collects history",
    description:
      "Every fee collect (fees actually taken from positions), oldest first, with token amounts, USD value, WETH equivalent, and whether the USD value was locked at the prices of the collect's moment or estimated at today's prices. Filter by month (YYYY-MM) or position. Includes per-month and per-day totals. Days and months are in the dashboard timezone.",
    inputSchema: {
      month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("Only collects in this month, e.g. 2026-09"),
      tokenId: z.string().optional().describe("Only collects for this position id"),
      include_rows: z.boolean().optional().describe("Include the individual collects (default true; set false for totals only)"),
    },
  },
  async ({ month, tokenId, include_rows }) => {
    try {
      const d = await get("/api/history");
      let rows = d.rows;
      if (month) rows = rows.filter((r) => r.t && monthKey(r.t) === month);
      if (tokenId) rows = rows.filter((r) => String(r.tokenId) === String(tokenId));
      const byMonth = {}, byDay = {};
      for (const r of rows) {
        if (!r.t) continue;
        const add = (o, k) => {
          o[k] = o[k] || { collects: 0, usd: 0, weth: 0, atTodaysPrices: 0, unpriced: 0 };
          o[k].collects++;
          if (r.usd == null) o[k].unpriced++;
          else { o[k].usd += r.usd; o[k].weth += r.weth || 0; if (!r.locked) o[k].atTodaysPrices++; }
        };
        add(byMonth, monthKey(r.t));
        add(byDay, dayKey(r.t));
      }
      const fin = (o) => Object.fromEntries(Object.entries(o).sort().map(([k, v]) => [k, { ...v, usd: round(v.usd), weth: round(v.weth, 4) }]));
      return text({
        timezone: TZ,
        note: "usd for a collect is locked at the prices of its moment when 'priceBasis' is 'collect time'; 'today' means valued at current prices (no price record). Collects in pairs no longer held may have no USD value.",
        totalUsd: round(rows.reduce((s, r) => s + (r.usd || 0), 0)),
        totalWeth: round(rows.reduce((s, r) => s + (r.weth || 0), 0), 4),
        count: rows.length,
        byMonth: fin(byMonth),
        byDay: fin(byDay),
        rows: include_rows === false ? undefined : rows.map((r) => ({
          time: r.t ? new Date(r.t).toISOString() : null,
          tokenId: r.tokenId, pair: r.pair,
          fees: { [r.sym0]: r.f0, [r.sym1]: r.f1 },
          usd: round(r.usd), weth: round(r.weth, 5),
          priceBasis: r.usd == null ? null : r.locked ? "collect time" : "today",
          partOfClose: r.principal, tx: r.tx,
        })),
      });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "daily_revenue",
  {
    title: "Daily revenue (fees as they accrue)",
    description:
      "Fees earned per day and per pool, whether or not collected yet, measured as the change in each position's uncollected fees between five-minute snapshots and valued at the prices of that moment. Days are in the dashboard timezone; the first day is partial from when tracking began, and today is partial. Compare with the 'collects' tool for cash actually swept.",
    inputSchema: {
      days: z.number().int().positive().optional().describe("Only the most recent N days (default all)"),
      by_position: z.boolean().optional().describe("Break each day down by position id instead of by pool (default false)"),
    },
  },
  async ({ days, by_position }) => {
    try {
      const d = await get("/api/daily");
      const poolOf = (id) => { const p = d.pools[id] || {}; return (p.pair || "#" + id) + (p.tier ? " " + p.tier : ""); };
      const byDay = {};
      for (const h of d.hours) {
        const k = dayKey(h.h);
        byDay[k] = byDay[k] || { totalUsd: 0, breakdown: {} };
        for (const [id, usd] of Object.entries(h.p)) {
          const key = by_position ? id : poolOf(id);
          byDay[k].totalUsd += usd;
          byDay[k].breakdown[key] = (byDay[k].breakdown[key] || 0) + usd;
        }
      }
      let keys = Object.keys(byDay).sort();
      if (days) keys = keys.slice(-days);
      const out = {};
      for (const k of keys) out[k] = { totalUsd: round(byDay[k].totalUsd), breakdown: Object.fromEntries(Object.entries(byDay[k].breakdown).sort((a, b) => b[1] - a[1]).map(([p, v]) => [p, round(v)])) };
      const first = d.hours.length ? new Date(d.hours[0].h).toISOString() : null;
      return text({ timezone: TZ, trackingSince: first, today: dayKey(Date.now()), days: out, positionsToPools: Object.fromEntries(Object.keys(d.pools).map((id) => [id, poolOf(id)])) });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "portfolio",
  {
    title: "Portfolio",
    description:
      "Everything the wallet holds, per token: balance sitting in the wallet, amount inside open LP positions, uncollected fees, USD price and value, share of the portfolio, and 24h price change. Totals split wallet / pools / fees, plus an hourly history of the total portfolio value. Tokens with no WETH or stable pool have no USD value.",
    inputSchema: {
      history_days: z.number().int().positive().optional().describe("Include the value history for the last N days (default: totals only)"),
    },
  },
  async ({ history_days }) => {
    try {
      const d = await get("/api/portfolio");
      const cutoff = history_days ? Date.now() - history_days * 86400000 : null;
      return text({
        asOf: new Date(d.at).toISOString(),
        totals: Object.fromEntries(Object.entries(d.totals).map(([k, v]) => [k, typeof v === "number" ? round(v) : v])),
        tokens: d.rows.map((r) => ({
          symbol: r.symbol, address: r.address,
          inWallet: r.wallet, inPools: r.pools, uncollectedFees: r.fees, total: r.total,
          priceUsd: r.price == null ? null : +r.price.toPrecision(6),
          valueUsd: round(r.usd), sharePct: round(r.share, 1), change24hPct: round(r.change24h, 1),
        })),
        history: cutoff == null ? `${d.series.length} hourly points (pass history_days to include)` :
          d.series.filter((s) => s.t >= cutoff).map((s) => ({ time: new Date(s.t).toISOString(), totalUsd: s.total, walletUsd: s.wallet, poolsUsd: s.lp, feesUsd: s.fees })),
      });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "wallet_balances",
  {
    title: "Owner wallet balances",
    description: "Token balances sitting in the owner wallet (what the collects delivered, plus anything else held), with USD values where a price is known.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = await get("/api/balances");
      return text({ owner: d.owner, totalUsd: round(d.totalUsd), rows: (d.rows || []).map((r) => ({ ...r, usd: round(r.usd) })) });
    } catch (err) {
      return fail(err);
    }
  }
);

// -- Tools added 2026-09-08: risk, vault, staking, attribution, digest, health (all read-only) --

server.registerTool(
  "memecoin_watch",
  {
    title: "Risk guardian status and rules",
    description:
      "Live status of every open position the risk guardian watches (v4 every 60 s, v3 every 5 min) with each position's rule block: alertPct (1h dump alert), closePct (drawdown from entry: close-now alert, or close when autoClose), outOfRangeMinutes, tvlDropPct (pool liquidity vs 24h high), feeFloorPerHour, autoClose/alertOnly. Prices are TOKENS PER QUOTE (ETH or USDG; higher = token worth less); use priceVsEntryPct for gain/loss vs entry. Includes drawdown, in/out of range and for how long, fees per hour, pool liquidity change, status colour with reasons, and the last close attempts. Read-only: rule changes and closing happen on the dashboard machine.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = await get("/api/risk");
      return text({
        at: d.at,
        stale: d.stale,
        howToRead: "Prices are quoted as TOKENS PER QUOTE ASSET (quoteSymbol: ETH, or USDG for stable-paired pools). A higher number means the token is worth LESS. tokenValueVsEntryPct is the change in the token's ETH value since entry (negative = the token fell = loss for the LP); it is the figure to report.",
        positions: (d.positions || []).map((p) => ({
          tokenId: p.tokenId, pair: p.pair, wallet: p.wallet, status: p.status, reasons: p.reasons,
          quoteSymbol: p.quoteSymbol || "ETH", tokensPerEthNow: p.price, tokensPerEthAtEntry: p.entryPrice, entrySource: p.entrySource || "config",
          tokenValueVsEntryPct: round(p.priceVsEntryPct, 1),
          drawdownFromEntryPct: round(p.drawdownPct, 1),
          inRange: p.inRange, outMinutes: round(p.outMinutes, 0),
          feesPerHourUsd: round(p.feesPerHour), uncollectedFeesUsd: round(p.feeUsd),
          poolActiveLiquidityUsd: round(p.liquidityUsd, 0), poolLiquidityChange1hPct: round(p.liqChange1hPct, 1),
          tokenValueVelocityPctPerHour: round(p.velocityPctPerHour, 1),
          autoClose: p.autoClose, closeConfirm: p.closeConfirm,
        })),
        recentCloses: d.recent || [],
      });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "vault",
  {
    title: "LOKOVault treasury",
    description: "The treasury that receives a percentage of every wallet's collected fees: split percentage, vault (TBA) address and USDG balance, total split all time, split amounts by month, the most recent split ledger entries and any failed transfers.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = await get("/api/treasury");
      return text({ enabled: d.enabled, splitPct: d.pct, maxPct: d.max, tba: d.tba, balanceUsdg: round(d.balanceUsdg), totalSplitUsdg: round(d.totalSplitUsdg), splitsRecorded: d.count, failed: d.failed, byMonth: d.byMonth, recent: d.recent });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "staking",
  {
    title: "Staking rewards (sNET)",
    description: "The rebasing staking position: balance, principal (from the 1:1 stake transfers), price, USD value, rewards today / 7d / 30d / all time in tokens and USD, realised APR, and rewards per day.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = await get("/api/staking");
      return text({ tokens: (d.tokens || []).map((t) => ({ symbol: t.symbol, label: t.label, balance: round(t.balance, 6), principal: round(t.principal, 6), price: round(t.price), usd: round(t.usd), aprPct: round(t.aprPct, 1), rewards: t.rewards, daily: (t.daily || []).slice(-14) })) });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "attribution",
  {
    title: "Performance attribution and benchmarks",
    description: "Daily P&L decomposition per wallet and position (fees, price move, impermanent loss, staking, vault splits, gas, net) over the last N days, with totals and benchmarks vs holding ETH, USDG or staking NET.",
    inputSchema: { days: z.number().int().min(1).max(365).optional().describe("Window in days (default 30)") },
  },
  async ({ days }) => {
    try {
      return text(await get(`/api/attribution?days=${days || 30}`));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "weekly_digest",
  {
    title: "Weekly report text",
    description: "The Monday weekly LP report as it would be sent to Telegram (fees, best/worst position, vault, staking, memecoin plays, gas, portfolio vs benchmarks, watch list), built from the current ledgers.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = await get("/api/digest");
      return { content: [{ type: "text", text: d.text || JSON.stringify(d) }] };
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "health",
  {
    title: "System health",
    description: "Whether the collector is armed and until when, the last collect run and its result, background loop status (memecoin guardian, fee auto-collect), the vault split setting, and the chain block the dashboard last read.",
    inputSchema: {},
  },
  async () => {
    try {
      const d = await get("/api/positions");
      const c = await get("/api/collect").catch(() => null);
      return text({ blockNumber: d.blockNumber, cached: !!d.cached, armed: d.unlock, lastRun: d.ops && d.ops.lastRun, loops: d.loops, collectRun: c && c.run ? { startedAt: c.run.startedAt, done: c.run.done, tail: String(c.run.output || "").slice(-400) } : null });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "status_report",
  {
    title: "Verified status report",
    description:
      "One call that answers 'is everything set?' from live data, for end-of-day summaries: arm window (armed until when), fee auto-collect settings (dollar threshold, minimum gap, last run, loop alive), the LOKOVault split in force (read from the contract) and vault balance, the memecoin guardian's watched positions with entry source, price vs entry and fee rate, uncollected fees per wallet, operator gas, the last collector run and its result, and Telegram alert status. Every figure comes from the dashboard at call time; report these numbers rather than remembered ones.",
    inputSchema: {},
  },
  async () => {
    try {
      const [d, w, m, t] = await Promise.all([get("/api/positions"), get("/api/watch").catch(() => null), get("/api/memecoins").catch(() => null), get("/api/treasury").catch(() => null)]);
      const wallets = [{ label: d.ownerLabel || "Main", address: d.owner, positions: d.positions || [] }, ...((w && w.wallets) || []).filter((x) => x.ok).map((x) => ({ label: x.label, address: x.address, positions: x.positions || [] }))];
      const unlock = d.unlock || {};
      return text({
        asOf: new Date().toISOString(),
        armed: { armed: !!unlock.armed, minutesLeft: unlock.minutesLeft ?? null, until: unlock.until ? new Date(unlock.until).toISOString() : null,
          note: unlock.armed ? "The collector can sign until this time; re-arm at /arm (up to 7 days) before it lapses." : "Nothing can be collected or closed until the collector is armed at /arm." },
        autoCollect: m && m.autoCollect ? { ...m.autoCollect, lastRunAt: m.autoCollect.lastRunAt ? new Date(m.autoCollect.lastRunAt).toISOString() : null, lastCheckAt: m.autoCollect.lastCheckAt ? new Date(m.autoCollect.lastCheckAt).toISOString() : null,
          rule: `runs the collector when any memecoin position has ≥ $${m.autoCollect.minUsd} uncollected, at most every ${m.autoCollect.minIntervalMinutes} min` } : null,
        vault: t ? { splitPct: t.pct, splitSource: t.pctSource || "config", maxPct: t.max, balanceUsdg: round(t.balanceUsdg), totalSplitUsdg: round(t.totalSplitUsdg), splits: t.count, note: "The split applies to fees swapped to USDG; tokens with no swap route go back to the wallet whole." } : null,
        guardian: m ? { alive: !m.stale, watching: m.watching, discovery: m.discovery, positions: (m.positions || []).filter((p) => !p.closed).map((p) => ({ pair: p.pair, tokenId: p.tokenId, wallet: p.wallet, status: p.status, quoteSymbol: p.quoteSymbol || "ETH", tokensPerQuoteNow: p.price, entry: p.entryPrice, entrySource: p.entrySource || "config", tokenValueVsEntryPct: round(p.priceVsEntryPct, 1), inRange: p.inRange, uncollectedFeesUsd: round(p.feeUsd), feesPerHourUsd: round(p.feesPerHour), autoClose: !!p.autoClose })) } : null,
        wallets: wallets.map((x) => ({ label: x.label, address: x.address, openPositions: x.positions.length, uncollectedFeesUsd: round(x.positions.reduce((s, p) => s + (p.feesUsd || 0), 0)),
          positions: x.positions.map((p) => ({ pair: p.pair, tokenId: p.nftId || p.tokenId, version: p.version || 3, inRange: p.inRange, uncollectedFeesUsd: round(p.feesUsd), feesPerHourUsd: p.dailyUsd != null ? round(p.dailyUsd / 24) : null })) })),
        operatorGas: d.operatorGas || null,
        gas24h: d.ops && d.ops.gas24h,
        lastCollectorRun: d.ops && d.ops.lastRun,
        loops: d.loops || null,
        alerts: d.alerts || null,
        wethUsd: round(d.wethUsd),
      });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "position_history",
  {
    title: "Position history (strategy dataset)",
    description:
      "One record per LP position ever seen across every wallet, open and closed, for judging what worked: opened/closed times, hours open, deposited and withdrawn USD, every collect (count, USD at collect time, per day), realized fee APR, time in range and flips, the price range and its width, PnL vs holding with its legs, the pool's TVL/volume/fees/APR, and for closed positions the net result. Use it to compare ranges, tiers, pairs and holding times before proposing a strategy. Filters: wallet (label or address), include_closed (default true), days (only positions active in the last N days).",
    inputSchema: {
      wallet: z.string().optional().describe("Wallet label or address (default all)"),
      include_closed: z.boolean().optional().describe("Include closed positions (default true)"),
      days: z.number().optional().describe("Only positions open at some point in the last N days"),
    },
  },
  async ({ wallet, include_closed, days }) => {
    try {
      const qs = new URLSearchParams();
      if (wallet) qs.set("wallet", wallet);
      if (include_closed === false) qs.set("closed", "0");
      if (days) qs.set("days", String(days));
      return text(await get(`/api/strategy/positions?${qs}`));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "price_history",
  {
    title: "Hourly price history of a token",
    description:
      "Hourly USD prices of a token as the dashboard recorded them (pool-derived), with the ETH-relative price for non-ETH tokens, over the last N days (default 7) at a chosen step in hours. Tokens are logged only while held or in a position. Pass a symbol (LAPTOP, Bucket, ETH) or a contract address.",
    inputSchema: {
      token: z.string().describe("Token symbol or contract address; ETH for ether"),
      days: z.number().optional().describe("Window in days (default 7)"),
      step_hours: z.number().optional().describe("Sampling step in hours (default 1)"),
    },
  },
  async ({ token, days, step_hours }) => {
    try {
      const qs = new URLSearchParams({ token });
      if (days) qs.set("days", String(days));
      if (step_hours) qs.set("step", String(step_hours));
      return text(await get(`/api/strategy/prices?${qs}`));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "pool_scout_history",
  {
    title: "Pool scout history",
    description:
      "The pool scout's hourly record of each position's pool fee APR versus the best sibling pool for the same pair (other fee tier or Uniswap version), with TVL and how many days the sibling has been ahead. Shows whether a position has been sitting in the wrong pool. Last N days (default 30).",
    inputSchema: { days: z.number().optional().describe("Window in days (default 30)") },
  },
  async ({ days }) => {
    try {
      return text(await get(`/api/strategy/scout?days=${days || 30}`));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "token_lots",
  {
    title: "Cost basis of fee tokens received",
    description:
      "Every fee token the wallets received unconverted (LAPTOP, Bucket, CRUMBS, ...): one lot per collect leg with the amount and the USD price of that hour, plus per-token totals: lots, amount, basis USD, average cost, price now, value now, unrealized gain, and the balance still held. This is the tax basis for tokens that were not swapped at collect time. ETH, WETH and USDG legs are excluded (already swapped and counted as income). soldAtCollect lists fee tokens the collector sold in their v4 pool at collect time (sell-v4.js policy: ≥ $25 batches, 3% impact cap), with proceeds and skips. Filters: token symbol, wallet, days.",
    inputSchema: {
      token: z.string().optional().describe("Only this token symbol"),
      wallet: z.string().optional().describe("Wallet label or address"),
      days: z.number().optional().describe("Only lots from the last N days"),
    },
  },
  async ({ token, wallet, days }) => {
    try {
      const qs = new URLSearchParams();
      if (token) qs.set("token", token);
      if (wallet) qs.set("wallet", wallet);
      if (days) qs.set("days", String(days));
      return text(await get(`/api/strategy/lots?${qs}`));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "record_strategy_proposal",
  {
    title: "Record a strategy proposal",
    description:
      "The ONE write tool on this MCP. Records a strategy proposal (a set of items, each naming a wallet + pair with an action and an expected outcome) to the local strategy-proposals.json ledger so it can be scored against what actually happens once its horizon passes. It writes ONLY to that ledger file on the dashboard machine: nothing on chain, no signing, no transactions. Use it to log the advice you give so the track record can tell which advice pays. Returns the proposal id.",
    inputSchema: {
      author: z.string().describe("Who is making the proposal (your model name or a label)"),
      horizon_days: z.number().positive().describe("How many days out the proposal is scored"),
      rationale: z.string().optional().describe("Why this proposal; free text"),
      items: z.array(z.object({
        wallet: z.string().describe("Wallet label or address the item applies to"),
        pair: z.string().describe("Pair, e.g. 'ETH / LAPTOP' (order-insensitive)"),
        token_id: z.string().optional().describe("Position token id, when the item is about a specific position"),
        action: z.enum(["hold", "close", "open", "rebalance", "avoid"]).describe("The recommended action"),
        range: z.object({ lower: z.number().optional(), upper: z.number().optional() }).optional().describe("Suggested price range"),
        expected: z.object({ fee_apr_pct: z.number().optional(), fees_usd: z.number().optional(), net_result_usd: z.number().optional() }).optional().describe("Expected outcome to score against"),
      })).min(1).describe("The items being proposed"),
    },
  },
  async ({ author, horizon_days, rationale, items }) => {
    try {
      const body = {
        author, horizonDays: horizon_days, rationale: rationale || "", source: "mcp",
        items: items.map((it) => ({
          wallet: it.wallet, pair: it.pair, tokenId: it.token_id ?? null, action: it.action,
          range: it.range ? { lower: it.range.lower ?? null, upper: it.range.upper ?? null } : null,
          expected: it.expected ? { feeAprPct: it.expected.fee_apr_pct ?? null, feesUsd: it.expected.fees_usd ?? null, netResultUsd: it.expected.net_result_usd ?? null } : null,
        })),
      };
      const r = await fetch(BASE + "/api/strategy/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      return text({ ok: true, id: j.id, t: new Date(j.t).toISOString(), horizonDays: j.horizonDays, items: j.items });
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "strategy_track_record",
  {
    title: "Strategy track record",
    description:
      "Every strategy proposal recorded (via record_strategy_proposal) with its items and, once the horizon has passed, the outcome: per-item verdict (beat / met / missed / no data) against what actually happened in the position history, and a per-proposal score (share of items met or beat). Includes a summary with the average score and a per-author breakdown. Use it to see which advice has paid off.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await get("/api/strategy/track"));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "pending_sales",
  {
    title: "Fee-token sales awaiting approval",
    description:
      "With confirm-before-sell on, the collector announces each fee-token sale (token, amount, pool, quoted proceeds in USD, price impact, the vault's share and the wallet's share) and waits up to the configured minutes for a decision. This lists the sales waiting now plus the last day's decided ones, with their ids. A sale nobody approves in time is handed back unsold.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await get("/api/sales/pending"));
    } catch (err) {
      return fail(err);
    }
  }
);

server.registerTool(
  "approve_sale",
  {
    title: "Approve or reject a pending fee-token sale",
    description:
      "Records the owner's decision on a pending sale by id (from pending_sales or the Telegram message). approve lets the collector send the swap it already quoted and dry-ran; reject hands the tokens back unsold. Only relays a decision the owner has given; never decide on your own. Writes only the local sales-pending.json; the collector does the transaction.",
    inputSchema: {
      id: z.string().describe("The pending sale id"),
      decision: z.enum(["approve", "reject"]).describe("The owner's decision"),
    },
  },
  async ({ id, decision }) => {
    try {
      const r = await fetch(BASE + "/api/sales/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, decision, by: "loko_ai" }), signal: AbortSignal.timeout(30000) });
      const j = await r.json();
      if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
      return text(j);
    } catch (err) {
      return fail(err);
    }
  }
);

return server;
}

// Run directly: stdio transport, for Claude Code and Claude Desktop.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
}
