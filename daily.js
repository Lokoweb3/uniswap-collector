/**
 * daily.js — one short Telegram line-up each day, from live data.
 *
 * The weekly digest (digest.js) is the long read; this is the glance: is the
 * collector armed and until when, what was collected in the last 24 h and
 * where it went, what each position is earning, what the guardian sees,
 * operator gas, and anything that is stopped or locked. Every figure comes
 * from the dashboard at send time, the same views the status_report MCP tool
 * uses, so it never reports from memory.
 *
 * Schedule: `alerts.dailySummary` in settings.json: { enabled, hour (local, default 8),
 * chat: "main" | "group" }. Sent once per local day from the server tick;
 * state in digest-state.json (lastDailyDate). `node daily.js --print` previews.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const STATE_FILE = path.join(HERE, "digest-state.json");
// "Local" means LP_TZ (default America/New_York), not the server's clock, which runs in UTC under WSL.
const TZ = process.env.LP_TZ || "America/New_York";
const usd = (n) => (n == null || !isFinite(n) ? "—" : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (n) => (n == null || !isFinite(n) ? "—" : (n >= 0 ? "+" : "") + Number(n).toFixed(1) + "%");
const hm = (mins) => (mins == null ? "—" : mins >= 1440 ? `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h` : `${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m`);

function settings(cfg) {
  const d = (cfg && cfg.dailySummary) || {};
  return { enabled: d.enabled !== false, hour: Number.isFinite(Number(d.hour)) ? Number(d.hour) : 8, chat: d.chat === "group" ? "group" : "main" };
}

async function gather(base = "http://127.0.0.1:8787") {
  const get = async (p) => {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
    return r.json();
  };
  const [positions, watch, history, memecoins, treasury] = await Promise.all([
    get("/api/positions"), get("/api/watch").catch(() => null), get("/api/history").catch(() => null), get("/api/memecoins").catch(() => null), get("/api/treasury").catch(() => null),
  ]);
  let splits = [];
  try { splits = JSON.parse(fs.readFileSync(path.join(HERE, "fee-split-ledger.json"), "utf8")); } catch {}
  return { now: Date.now(), positions, watch, history, memecoins, treasury, splits };
}

function build(d) {
  const now = d.now || Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const p = d.positions || {};
  const lines = [`📋 Daily LP check — ${new Date(now).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ })}`];

  // Arm window
  const u = p.unlock || {};
  lines.push(u.armed ? `🔐 Armed, ${hm(u.minutesLeft)} left${u.minutesLeft != null && u.minutesLeft < 360 ? " — re-arm soon" : ""}` : "🔓 NOT ARMED — nothing collects until you arm at /arm");

  // Collected in 24 h, per wallet, and the vault's share
  const rows = ((d.history && d.history.rows) || []).filter((r) => r.t && r.t > dayAgo);
  const byWallet = {};
  for (const r of rows) byWallet[r.wallet || "Main"] = (byWallet[r.wallet || "Main"] || 0) + (r.usd || 0);
  const total = Object.values(byWallet).reduce((s, v) => s + v, 0);
  const vault24 = (d.splits || []).filter((s) => Date.parse(s.timestamp) > dayAgo).reduce((s, x) => s + (x.splitUsdg || 0), 0);
  lines.push(rows.length
    ? `💰 Collected 24h: ${usd(total)} in ${rows.length} collect${rows.length === 1 ? "" : "s"} (${Object.entries(byWallet).map(([w, v]) => `${w} ${usd(v)}`).join(", ")})${vault24 ? ` · vault +${vault24.toFixed(2)} USDG` : ""}`
    : "💰 Collected 24h: nothing");

  // Fee tokens sold at collect time (sell-v4.js)
  let salesRows = [];
  try { salesRows = JSON.parse(fs.readFileSync(path.join(HERE, "token-sales.json"), "utf8")).filter((r) => r.t > dayAgo); } catch {}
  const sold = salesRows.filter((r) => !r.skipped), skipped = salesRows.filter((r) => r.skipped);
  if (sold.length || skipped.length) {
    const byTok = {};
    for (const r of sold) byTok[r.token] = (byTok[r.token] || 0) + (r.usd || 0);
    lines.push(`💱 Fee tokens sold 24h: ${sold.length ? Object.entries(byTok).map(([t, v]) => `${t} ${usd(v)}`).join(", ") : "none"}${skipped.length ? ` · ${skipped.length} skipped (${skipped[skipped.length - 1].reason})` : ""}`);
  }

  // Open positions and what they earn
  const all = [];
  for (const x of p.positions || []) all.push({ ...x, wallet: p.ownerLabel || "Main" });
  for (const w of (d.watch && d.watch.wallets) || []) if (w.ok) for (const x of w.positions || []) all.push({ ...x, wallet: w.label || w.address });
  const uncollected = all.reduce((s, x) => s + (x.feesUsd || 0), 0);
  const out = all.filter((x) => !x.inRange);
  lines.push(`📊 ${all.length} open position${all.length === 1 ? "" : "s"}, ${usd(uncollected)} uncollected${out.length ? `, ${out.length} OUT of range (${out.map((x) => x.pair).join(", ")})` : ", all in range"}`);
  // Fee rate per position: the dashboard's accrual for the main wallet, the guardian's rate for the rest.
  const gRate = new Map(((d.memecoins && d.memecoins.positions) || []).filter((x) => !x.closed && x.feesPerHour != null).map((x) => [String(x.tokenId), x.feesPerHour]));
  const rated = all.map((x) => ({ pair: x.pair, perHour: x.dailyUsd != null ? x.dailyUsd / 24 : gRate.get(String(x.nftId || String(x.tokenId).replace(/^v4-/, ""))) ?? null })).filter((x) => x.perHour != null);
  const earners = rated.sort((a, b) => b.perHour - a.perHour).slice(0, 3);
  if (earners.length) lines.push(`   top: ${earners.map((x) => `${x.pair} ${usd(x.perHour)}/h`).join(" · ")}`);

  // Guardian
  const m = d.memecoins;
  if (m) {
    if (m.stale) lines.push("🛡️ Guardian NOT reporting — restart the dashboard (./start-all.sh)");
    else {
      const ps = (m.positions || []).filter((x) => !x.closed);
      const flagged = ps.filter((x) => x.status !== "green");
      lines.push(`🛡️ Guardian: ${ps.length} watched${flagged.length ? `, ${flagged.length} flagged: ${flagged.map((x) => `${x.pair} ${x.status} (${(x.reasons || []).join(", ") || "—"}, ${pct(x.priceVsEntryPct)} vs entry)`).join("; ")}` : ", all green"}`);
    }
    if (m.autoCollect) lines.push(`⚡ Auto-collect: ≥ ${usd(m.autoCollect.minUsd)} rule${m.autoCollect.stale ? " — loop NOT running" : m.autoCollect.lastRunAt ? `, last run ${hm((now - m.autoCollect.lastRunAt) / 60000)} ago` : ", no run yet"}`);
  }

  // Vault, gas, last run
  if (d.treasury) lines.push(`🏦 Vault: ${(d.treasury.balanceUsdg ?? 0).toFixed(2)} USDG held, split ${d.treasury.pct}%`);
  const g = p.operatorGas;
  if (g) lines.push(`⛽ Operator gas: ${Number(g.eth).toFixed(4)} ETH${g.low ? " — LOW, top up" : ""}`);
  const lr = p.ops && p.ops.lastRun;
  if (lr) lines.push(`🕘 Last collector run: ${lr.result || "?"}${lr.failures && lr.failures.length ? ` · ${lr.failures.length} failure line(s)` : ""}`);
  if (p.loops) {
    const stale = Object.entries(p.loops).filter(([, v]) => v && v.stale).map(([k]) => k);
    if (stale.length) lines.push(`⚠️ Stopped: ${stale.join(", ")}`);
  }
  return lines.join("\n");
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch {} }
const dayKey = (now) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
const hourIn = (now) => Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hour12: false }).format(now).replace(/\D/g, "")) % 24;

/** Time to send today's line-up? At or after the configured hour in LP_TZ, not yet sent today. */
function due(cfg, now = new Date(), state = readState()) {
  const s = settings(cfg);
  if (!s.enabled) return false;
  if (hourIn(now) < s.hour) return false;
  return state.lastDailyDate !== dayKey(now);
}

/** Called from the server tick. Returns true when sent. */
async function maybeSend({ cfg, alerts, base, now = new Date(), log = console } = {}) {
  if (!due(cfg, now)) return false;
  if (!alerts || !alerts.enabled) return false;
  const text = build(await gather(base));
  const s = settings(cfg);
  const ok = s.chat === "group" && alerts.sendGroup ? await alerts.sendGroup(text) : await alerts.send(text);
  if (ok) {
    writeState({ ...readState(), lastDailyDate: dayKey(now), lastDailyAt: new Date().toISOString() });
    log.log("daily: summary sent");
  } else log.error("daily: summary could not be delivered");
  return !!ok;
}

module.exports = { build, gather, due, maybeSend, settings };

if (require.main === module) {
  const port = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] || process.env.LP_DASHBOARD_PORT || 8787);
  gather(`http://127.0.0.1:${port}`).then((d) => { console.log(build(d)); }).catch((e) => { console.error(e.message); process.exit(1); });
}
