#!/usr/bin/env node
/**
 * Weekly LP report for Telegram.
 *
 *   node digest.js --print          # build from the running dashboard and print
 *   node digest.js --send           # build and send (treasury chat, falls back to the personal chat)
 *   node digest.js --print --base http://127.0.0.1:8797
 *
 * The server tick calls `maybeSend()` every ten minutes and sends once per ISO
 * week, the first tick on or after Monday 09:00 local time; digest-state.json
 * remembers the week that was sent. `build(data)` is pure so tests can feed it
 * mock payloads; `gather(base)` collects the payloads from the dashboard API
 * plus the local ledgers (state.json gas, price-log.json, portfolio-all.json).
 */
"use strict";
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "digest-state.json");
const SEND_DOW = 1; // Monday
const SEND_HOUR = 9; // local time
const WEEK_MS = 7 * 86400000;

const usd = (n) => (n == null || !isFinite(n) ? "$—" : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signedUsd = (n) => (n == null || !isFinite(n) ? "$—" : (n >= 0 ? "+" : "-") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (n) => (n == null || !isFinite(n) ? "—" : (n >= 0 ? "+" : "") + n.toFixed(1) + "%");

/** ISO week key, e.g. "2026-W37". */
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

/** Nearest point of a {t,...} series at or before `at` (ms). */
function pointAt(points, at) {
  let best = null;
  for (const p of points) if (p.t <= at && (!best || p.t > best.t)) best = p;
  return best;
}

/** Price from the hourly price log for `key` at or before `at`. */
function priceAt(priceLog, key, at) {
  const hours = Object.keys((priceLog && priceLog.hours) || {}).map(Number).filter((h) => h <= at).sort((a, b) => b - a);
  for (const h of hours) {
    const v = priceLog.hours[h][key];
    if (v != null) return v;
  }
  return null;
}

/**
 * Build the report text from the data bundle:
 * { now, positions, watch, history, staking, treasury, portfolioAll, priceLog, gasSpends, memecoins, usdgAddress }
 */
function build(d) {
  const now = d.now || Date.now();
  const weekAgo = now - WEEK_MS;
  const twoWeeksAgo = now - 2 * WEEK_MS;
  const ethNow = (d.positions && d.positions.wethUsd) || priceAt(d.priceLog, "eth", now) || null;

  // -- Fees: collected (history rows across every wallet) + accrued (main daily ledger + watched accrual), last 7 days vs the 7 before.
  const rows = (d.history && d.history.rows) || [];
  const collected = (from, to) => rows.filter((r) => r.t > from && r.t <= to && r.usd != null).reduce((s, r) => s + r.usd, 0);
  const dailyHours = (d.daily && d.daily.hours) || [];
  const accrued = (from, to) => dailyHours.filter((h) => h.h > from && h.h <= to).reduce((s, h) => s + Object.values(h.p || {}).reduce((a, b) => a + b, 0), 0);
  const watchedAccrued = (from, to) => {
    let s = 0;
    for (const w of (d.watch && d.watch.wallets) || []) {
      for (const day of (w.earned && w.earned.daily) || []) {
        const t = new Date(day.day + "T12:00:00").getTime();
        if (t > from && t <= to) s += day.usd || 0;
      }
    }
    return s;
  };
  // Collected fees are the cash figure; accrued-but-uncollected is added so the week is not understated.
  const feesThis = collected(weekAgo, now) + Math.max(0, accrued(weekAgo, now) + watchedAccrued(weekAgo, now) - collected(weekAgo, now));
  const feesPrev = collected(twoWeeksAgo, weekAgo) + Math.max(0, accrued(twoWeeksAgo, weekAgo) + watchedAccrued(twoWeeksAgo, weekAgo) - collected(twoWeeksAgo, weekAgo));

  // -- Positions across wallets, for best / worst / watch list.
  const allPositions = [];
  for (const p of (d.positions && d.positions.positions) || []) allPositions.push({ ...p, wallet: (d.positions && d.positions.ownerLabel) || "Main" });
  for (const w of (d.watch && d.watch.wallets) || []) for (const p of w.positions || []) allPositions.push({ ...p, wallet: w.label || w.address });
  const earning = allPositions.filter((p) => p.dailyUsd != null && p.dailyUsd > 0);
  const best = earning.sort((a, b) => b.dailyUsd - a.dailyUsd)[0] || null;
  // Worst: impermanent loss = (LP vs holding) minus the fees, i.e. the price-move part of the PnL,
  // for positions with a liquidity-ledger basis; else the largest negative PnL vs holding.
  const withIl = allPositions.map((p) => {
    const legs = p.pnlLegs;
    if (!legs || p.pnlUsd == null) return null;
    const fees = (legs.collected || 0) + (legs.uncollected || 0);
    const base = legs.deposited || p.valueUsd || 0;
    return { p, il: p.pnlUsd - fees, base };
  }).filter((x) => x && x.base > 0);
  let worst = null;
  if (withIl.length) {
    const w = withIl.sort((a, b) => a.il - b.il)[0];
    if (w.il < 0) worst = { pair: w.p.pair, text: `${(Math.abs(w.il) / w.base * 100).toFixed(1)}% IL (${usd(w.il)})` };
  }
  if (!worst) {
    const neg = allPositions.filter((p) => p.pnlUsd != null && p.pnlUsd < 0).sort((a, b) => a.pnlUsd - b.pnlUsd)[0];
    if (neg) worst = { pair: neg.pair, text: `${(Math.abs(neg.pnlUsd) / Math.max(1, neg.valueUsd) * 100).toFixed(1)}% behind holding (${usd(neg.pnlUsd)})` };
  }

  // -- Vault.
  const t = d.treasury || {};
  const vaultTotal = t.totalSplitUsdg || 0;
  const vaultWeek = (t.recent || []).filter((r) => r.status !== "failed" && new Date(r.timestamp).getTime() > weekAgo).reduce((s, r) => s + (Number(r.splitUsdg) || 0), 0);

  // -- sNET.
  const stakeUsd = ((d.staking && d.staking.tokens) || []).reduce((s, x) => s + ((x.rewards && x.rewards.d7Usd) || 0), 0);

  // -- Memecoin plays: every v4 position (the guardian watches them all); entry prices from config or discovery.
  const memeCfg = new Map(((d.memecoins || [])).map((m) => [String(m.tokenId), m]));
  const memes = allPositions.filter((p) => p.version === 4);
  const memeText = memes.length
    ? memes.map((p) => {
        const m = memeCfg.get(String(p.nftId || p.tokenId).replace(/^v4-/, ""));
        let vs = "";
        if (m && m.entryPrice && p.priceCurrent) {
          // entryPrice is token per quote (ETH, or USDG for stable-paired pools); priceCurrent is token1 per token0.
          // With the quote as token0 that is the same number; otherwise invert. The move is reported as the token's value change.
          const quoteIs0 = /^(ETH|WETH|USDG) \//.test(p.pair || "");
          const nowPerQuote = quoteIs0 ? p.priceCurrent : 1 / p.priceCurrent;
          const change = (m.entryPrice / nowPerQuote - 1) * 100;
          vs = ` ${pct(change)} vs entry`;
        }
        return `${p.pair} ${usd(p.valueUsd)}${vs}${p.inRange ? "" : " (out of range)"}`;
      }).join("; ")
    : "none open";

  // -- Gas: operator spends in the window, valued at the ETH price.
  const gasWei = (d.gasSpends || []).filter((g) => g.t > weekAgo && g.t <= now).reduce((s, g) => s + Number(g.wei), 0);
  const gasUsd = ethNow ? (gasWei / 1e18) * ethNow : null;

  // -- Portfolio and benchmarks from the combined hourly series and the price log.
  const pts = (d.portfolioAll && d.portfolioAll.points) || [];
  const pNow = pts.length ? pts[pts.length - 1] : null;
  const pThen = pointAt(pts, weekAgo);
  const portfolioNow = pNow ? pNow.total : null;
  const portfolioChange = pNow && pThen && pThen.total > 0 ? (pNow.total / pThen.total - 1) * 100 : null;
  const historyNote = pNow && !pThen ? ` (history since ${new Date(pts[0].t).toLocaleDateString(undefined, { month: "short", day: "numeric" })})` : "";
  const ethThen = priceAt(d.priceLog, "eth", weekAgo);
  const ethBench = ethNow && ethThen ? (ethNow / ethThen - 1) * 100 : null;
  const usdgKey = (d.usdgAddress || "").toLowerCase();
  const usdgNow = usdgKey ? priceAt(d.priceLog, usdgKey, now) : null;
  const usdgThen = usdgKey ? priceAt(d.priceLog, usdgKey, weekAgo) : null;
  const usdgBench = usdgNow && usdgThen ? (usdgNow / usdgThen - 1) * 100 : ethBench != null ? 0 : null; // a dollar stable: 0% when priced, else unknown

  // -- Watch list: out of range or within 5% of an edge.
  const NEAR = 5;
  const watch = allPositions.filter((p) => !p.inRange || (p.toUpperPct != null && p.toUpperPct < NEAR) || (p.toLowerPct != null && p.toLowerPct < NEAR))
    .map((p) => `${p.pair} (${p.wallet}) ${!p.inRange ? "out of range" : "near the edge"}`);

  const date = new Date(now).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return [
    `📊 Weekly LP Report — ${date}`,
    "",
    `💰 Fees: ${usd(feesThis)} (${signedUsd(feesThis - feesPrev)} vs last week)`,
    `🏆 Best: ${best ? `${best.pair} ${usd(best.dailyUsd)}/day${best.aprPct != null ? ` at ${best.aprPct.toFixed(0)}% APR` : ""}` : "no position earning yet"}`,
    `📉 Worst: ${worst ? `${worst.pair} ${worst.text}` : "no IL recorded"}`,
    `🔐 LOKOVault: ${usd(vaultTotal)} (${signedUsd(vaultWeek)} this week)`,
    `📈 sNET: ${usd(stakeUsd)} rewards`,
    `🎰 Memecoin plays: ${memeText}`,
    `⛽ Gas: ${gasUsd == null ? "$—" : usd(gasUsd)}`,
    "",
    `Portfolio: ${usd(portfolioNow)} (${portfolioChange == null ? "n/a" : pct(portfolioChange)} vs last week)${historyNote}`,
    `ETH benchmark: ${pct(ethBench)} | USDG benchmark: ${pct(usdgBench)}`,
    "",
    `⚠️ Watch: ${watch.length ? watch.join(", ") : "nothing near an edge"}`,
  ].join("\n");
}

/** Fetch every payload the report needs from a running dashboard plus the local ledgers. */
async function gather(base = "http://127.0.0.1:8787") {
  const get = async (p) => {
    try {
      const r = await fetch(base + p, { signal: AbortSignal.timeout(20000) });
      return await r.json();
    } catch {
      return null;
    }
  };
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8"));
    } catch {
      return null;
    }
  };
  const [positions, watch, history, daily, staking, treasury, portfolioAll] = await Promise.all([
    get("/api/positions"), get("/api/watch"), get("/api/history"), get("/api/daily"), get("/api/staking"), get("/api/treasury"), get("/api/portfolio-all"),
  ]);
  let cfg = {}; try { cfg = require("./settings").load(); } catch {}
  const state = read("state.json") || {};
  return {
    now: Date.now(), positions, watch, history, daily, staking, treasury, portfolioAll,
    priceLog: read("price-log.json"), gasSpends: state.gasSpends || [],
    // Entries the guardian watches: config plus what it discovered (entry prices included).
    memecoins: [...(cfg.memecoins || []), ...(read("memecoin-discovered.json") || [])], usdgAddress: cfg.usdReference && cfg.usdReference.stable,
  };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}
function writeState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s));
  } catch {}
}

/** Is it time for this week's report? Monday 09:00 local or later, not yet sent this ISO week. */
function due(now = new Date(), state = readState()) {
  const dow = now.getDay();
  const afterMonday9 = dow > SEND_DOW || (dow === SEND_DOW && now.getHours() >= SEND_HOUR);
  if (!afterMonday9 || dow === 0) return false; // Sunday belongs to the previous week; wait for Monday
  return state.lastSentWeek !== isoWeek(now);
}

/** Send the text to the treasury chat, falling back to the personal chat. `send(text, chatId)` comes from alerts.js. */
async function deliver(text, alerts) {
  let chats = {}; try { chats = require("./settings").load().alerts || {}; } catch {}
  const treasuryChat = process.env.TELEGRAM_TREASURY_CHAT_ID || chats.treasuryChat || chats.telegramChat || "";
  const personal = process.env.TELEGRAM_CHAT_ID || chats.fallbackChat || "";
  if (await alerts.send(text, treasuryChat)) return treasuryChat;
  if (await alerts.send(text, personal)) return personal;
  return null;
}

/** Called from the server tick. Returns the chat it sent to, or null. */
async function maybeSend({ alerts, base, now = new Date(), log = console } = {}) {
  if (!due(now)) return null;
  const text = build(await gather(base));
  const to = await deliver(text, alerts);
  if (to) {
    writeState({ ...readState(), lastSentWeek: isoWeek(now), lastSentAt: new Date().toISOString(), to });
    log.log(`digest: weekly report sent (${isoWeek(now)})`);
  } else log.error("digest: weekly report could not be delivered");
  return to;
}

module.exports = { build, gather, due, isoWeek, maybeSend, deliver };

if (require.main === module) {
  const args = process.argv.slice(2);
  const base = args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:8787";
  (async () => {
    const text = build(await gather(base));
    if (args.includes("--send")) {
      const alerts = require("./alerts").create();
      const to = await deliver(text, alerts);
      writeState({ ...readState(), lastSentWeek: isoWeek(new Date()), lastSentAt: new Date().toISOString(), to });
      console.log(to ? `sent to ${to}` : "not sent (no token or every chat refused)");
    } else console.log(text);
  })().catch((e) => {
    console.error("digest:", e.message);
    process.exit(1);
  });
}
