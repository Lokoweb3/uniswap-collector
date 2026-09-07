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
      "Read-only view of the extra wallets listed in config.json watchWallets: each wallet's total value (tokens held in the wallet, valued like the portfolio, plus positions and fees; top tokens listed) and its open Uniswap v3/v4 positions (pair, fee tier, in-range status, distance to edges, price range, holdings, USD value, uncollected fees) and totals. These wallets are only observed, never collected from. Empty when no wallet is configured.",
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

return server;
}

// Run directly: stdio transport, for Claude Code and Claude Desktop.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createServer().connect(new StdioServerTransport());
}
