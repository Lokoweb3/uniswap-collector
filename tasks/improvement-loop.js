// tasks/improvement-loop.js  v3
// Patched per Theo's review:
//   #1 — null guards on benchmark comparisons
//   #2 — explicit null check on il before feeIlRatio
//   #3 — template literals verified correct
//   #4 — 48h guard on zero-fee wallet flag
//   #5 — runs every 6h via cron, API load is fine

"use strict";
const fs   = require("fs");
const path = require("path");
const http = require("http");

const BASE    = "http://127.0.0.1:8787";
const OUT_DIR = path.join(__dirname, "output");
const BRAIN   = path.join(__dirname, "..", "brain", "proposals.md");

function get(endpoint) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${endpoint}`, res => {
      let data = "";
      res.on("data", d => data += d);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`JSON parse ${endpoint}: ${e.message}`)); }
      });
    }).on("error", reject);
  });
}

function fmt(n, prefix = "$") {
  if (n == null) return "n/a";
  const abs = Math.abs(n);
  const s = abs >= 1000 ? `${prefix}${(abs / 1000).toFixed(1)}K`
                        : `${prefix}${abs.toFixed(2)}`;
  return n < 0 ? `-${s}` : s;
}

function ageHours(sinceMs) {
  return sinceMs ? (Date.now() - sinceMs) / 3600000 : 999;
}

function analyseAttribution(attr) {
  const issues = [], suggestions = [];
  if (!attr?.book?.totals || !Array.isArray(attr.wallets)) {
    console.warn("[loop] attribution response malformed — skipping analysis");
    return { feeIlRatio: null, walletFees: [], totals: {}, benchmarks: null, issues, suggestions };
  }
  const b = attr.book.totals;

  let feeIlRatio = null;
  if (b.il != null && b.il !== 0 && b.fees != null) {
    feeIlRatio = Math.abs(b.fees / b.il);
  }

  if (feeIlRatio !== null && feeIlRatio < 1) {
    issues.push({ severity: "HIGH", msg: `IL (${fmt(b.il)}) eating more than fees earned (${fmt(b.fees)}) — ratio ${feeIlRatio.toFixed(2)}x` });
    suggestions.push("Consider tighter ranges to reduce IL, or move to stable/stable pools");
  }

  const main7 = attr.mainBenchmarks?.find(bm => bm.windowDays === 7);

  if (main7 && main7.portfolioPct != null && main7.ethPct != null && main7.portfolioPct < main7.ethPct) {
    issues.push({ severity: "MEDIUM", msg: `Portfolio ${main7.portfolioPct.toFixed(1)}% vs ETH ${main7.ethPct.toFixed(1)}% over ${main7.actualDays.toFixed(1)}d — LP underperforming hold` });
    suggestions.push("Review which positions have negative net P&L after IL");
  }

  if (main7 && main7.portfolioPct != null && main7.stakingPct != null && main7.portfolioPct < main7.stakingPct) {
    issues.push({ severity: "MEDIUM", msg: `Staking (${main7.stakingPct.toFixed(1)}%) outperforming LP portfolio (${main7.portfolioPct.toFixed(1)}%) — consider increasing sNET stake` });
  }

  const walletFees = attr.wallets
    .map(w => ({ label: w.label, key: w.key, fees: w.totals.fees, net: w.totals.net }))
    .sort((a, b) => b.fees - a.fees);

  const posAgeByWallet = {};
  for (const pos of (attr.positions || [])) {
    const h = ageHours(pos.since);
    if (!posAgeByWallet[pos.key] || posAgeByWallet[pos.key] < h) {
      posAgeByWallet[pos.key] = h;
    }
  }

  for (const w of walletFees) {
    const walletAge = posAgeByWallet[w.key] ?? 999;
    if (w.fees === 0 && walletAge > 48) {
      suggestions.push(`${w.label} wallet earned $0 in fees this week — check for idle capital`);
    }
  }

  if (walletFees[0]?.fees > 0) {
    suggestions.push(`Top fee earner: ${walletFees[0].label} — ${fmt(walletFees[0].fees)} fees this week`);
  }

  return { feeIlRatio, walletFees, totals: b, benchmarks: main7, issues, suggestions };
}

function analysePositions(attr) {
  const issues = [], suggestions = [];
  const positions = attr.positions || [];

  for (const pos of positions) {
    const age = ageHours(pos.since);
    if (age > 48 && pos.feesToday !== null && pos.feesToday < 1) {
      issues.push({ severity: "LOW", msg: `${pos.pair} #${pos.tokenId} earned only ${fmt(pos.feesToday)} today` });
    }
    if (pos.pnlUsd < 0) {
      issues.push({ severity: "MEDIUM", msg: `${pos.pair} #${pos.tokenId} has negative PnL ${fmt(pos.pnlUsd)} since opening` });
      suggestions.push(`Review ${pos.pair} — consider closing if trend continues`);
    }
    if (pos.priceAndIl != null && pos.fees != null && pos.priceAndIl < 0 && Math.abs(pos.priceAndIl) > pos.fees) {
      issues.push({ severity: "HIGH", msg: `${pos.pair}: IL+price (${fmt(pos.priceAndIl)}) exceeds fees earned (${fmt(pos.fees)})` });
    }
  }

  const best = positions
    .filter(p => p.valueUsd > 0 && ageHours(p.since) > 48)
    .map(p => ({ ...p, feeRatio: p.fees / p.valueUsd }))
    .sort((a, b) => b.feeRatio - a.feeRatio)[0];

  if (best) {
    suggestions.push(`Best fee/value ratio: ${best.pair} at ${(best.feeRatio * 100).toFixed(1)}% return — consider adding capital here`);
  }

  return { positions, issues, suggestions };
}

function analysePortfolio(portfolio) {
  const issues = [], suggestions = [];
  // /api/portfolio returns `rows` (usd, share as a percentage, change24h as a percentage), not `tokens`.
  const tokens = (portfolio.rows || portfolio.tokens || [])
    .map(t => ({ symbol: t.symbol, valueUsd: t.valueUsd ?? t.usd, sharePct: t.sharePct ?? t.share, change24hPct: t.change24hPct ?? t.change24h }))
    .filter(t => t.valueUsd > 0)
    .sort((a, b) => b.valueUsd - a.valueUsd);

  const topToken = tokens[0];
  if (topToken && topToken.sharePct > 50) {
    issues.push({ severity: "MEDIUM", msg: `${topToken.symbol} is ${topToken.sharePct.toFixed(1)}% of portfolio — high concentration` });
    suggestions.push(`Consider diversifying from ${topToken.symbol} if it is volatile`);
  }

  const bigDroppers = tokens.filter(t => t.change24hPct != null && t.change24hPct < -10 && t.valueUsd > 10);
  for (const t of bigDroppers) {
    issues.push({ severity: "LOW", msg: `${t.symbol} down ${t.change24hPct.toFixed(1)}% in 24h (${fmt(t.valueUsd)})` });
  }

  const unpricedCount = portfolio.totals?.unpricedCount ?? 0;
  if (unpricedCount > 10) {
    suggestions.push(`${unpricedCount} tokens have no price — wallet cluttered with dust/spam tokens`);
  }

  const { lpUsd = 0, totalUsd = 1 } = portfolio.totals || {};
  const lpPct = totalUsd > 0 ? +(lpUsd / totalUsd * 100).toFixed(1) : 0;
  if (lpPct < 20 && lpUsd < 500) {
    suggestions.push(`Only ${lpPct}% of portfolio (${fmt(lpUsd)}) is in LP positions — consider deploying more capital`);
  }

  return { topToken, bigDroppers, lpPct, issues, suggestions };
}

function analyseScout(scoutRows) {
  const issues = [], suggestions = [];
  const moveOpps = [];

  const byPos = new Map();
  for (const row of scoutRows) {
    if (!byPos.has(row.tokenId)) byPos.set(row.tokenId, []);
    byPos.get(row.tokenId).push(row);
  }

  for (const [tokenId, rows] of byPos) {
    rows.sort((a, b) => a.t.localeCompare(b.t));
    const latest = rows[rows.length - 1];

    if (!latest.beats) continue;
    if ((latest.streakDays || 0) < 2) continue;
    if (latest.bestTvl < 100_000) continue;

    const recentRows  = rows.slice(-20);
    const beatingRows = recentRows.filter(r => r.beats);
    const counts      = {};
    beatingRows.forEach(r => { counts[r.bestSibling] = (counts[r.bestSibling] || 0) + 1; });
    const topSibling  = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    const stability   = topSibling && beatingRows.length > 0 ? topSibling[1] / beatingRows.length : 0;
    if (stability < 0.7) continue;

    const multNum = latest.ownAprPct > 0 ? latest.bestAprPct / latest.ownAprPct : Infinity;
    const mult    = Number.isFinite(multNum) ? multNum.toFixed(1) : "∞";
    const urgency = latest.streakDays >= 3 && multNum >= 5 ? "HIGH" : "MEDIUM";

    moveOpps.push({ tokenId, pair: latest.pair, wallet: latest.wallet, urgency, mult: Number.isFinite(multNum) ? +multNum.toFixed(1) : 999, bestSibling: latest.bestSibling, bestAprPct: Math.round(latest.bestAprPct), ownAprPct: Math.round(latest.ownAprPct), tvl: latest.bestTvl, streakDays: latest.streakDays, stability: Math.round(stability * 100) });
    issues.push({ severity: urgency, msg: `${latest.pair} #${tokenId}: ${latest.bestSibling} earning ${mult}x more (${Math.round(latest.bestAprPct)}% vs ${Math.round(latest.ownAprPct)}%) for ${latest.streakDays}d — ${Math.round(stability * 100)}% consistent` });
    suggestions.push(`[${urgency}] Move ${latest.pair} → ${latest.bestSibling} ($${(latest.bestTvl / 1000).toFixed(0)}K TVL, ${latest.streakDays}d streak)`);
  }

  moveOpps.sort((a, b) => (a.urgency === "HIGH" ? 0 : 1) - (b.urgency === "HIGH" ? 0 : 1) || b.mult - a.mult);
  return { moveOpps, issues, suggestions };
}

function synthesise({ attrAnalysis, posAnalysis, portAnalysis, scoutAnalysis, ts }) {
  const allIssues = [
    ...scoutAnalysis.issues, ...attrAnalysis.issues,
    ...posAnalysis.issues,   ...portAnalysis.issues,
  ].sort((a, b) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 }[a.severity] - { HIGH: 0, MEDIUM: 1, LOW: 2 }[b.severity]));

  const allSuggestions = [
    ...scoutAnalysis.suggestions, ...attrAnalysis.suggestions,
    ...posAnalysis.suggestions,   ...portAnalysis.suggestions,
  ];

  const highCount = allIssues.filter(i => i.severity === "HIGH").length;
  const medCount  = allIssues.filter(i => i.severity === "MEDIUM").length;
  const lowCount  = allIssues.filter(i => i.severity === "LOW").length;
  const status    = highCount > 0 ? "🔴 ACTION NEEDED" : medCount > 0 ? "🟡 WATCH" : "🟢 HEALTHY";

  const b  = attrAnalysis.totals;
  const bm = attrAnalysis.benchmarks;

  const proposal = `
---
## Improvement Loop — ${ts}
**${status}** | ${highCount} high · ${medCount} medium · ${lowCount} low

### Snapshot (7d)
- Fees: ${fmt(b.fees)} | IL: ${b.il != null ? fmt(b.il) : "incomplete"} | Staking: ${fmt(b.staking)}
- Fee/IL ratio: ${attrAnalysis.feeIlRatio != null ? attrAnalysis.feeIlRatio.toFixed(2) + "x" : "unknown"} ${attrAnalysis.feeIlRatio != null && attrAnalysis.feeIlRatio < 1 ? "⚠️" : "✅"}
- Portfolio: ${bm?.portfolioPct != null ? bm.portfolioPct.toFixed(1) + "%" : "n/a"} | ETH: ${bm?.ethPct != null ? bm.ethPct.toFixed(1) + "%" : "n/a"} | Staking: ${bm?.stakingPct != null ? bm.stakingPct.toFixed(1) + "%" : "n/a"}
- LP deployed: ${portAnalysis.lpPct}% of portfolio
- Top wallet: ${attrAnalysis.walletFees[0]?.label ?? "n/a"} — ${fmt(attrAnalysis.walletFees[0]?.fees ?? 0)} fees

### Issues
${allIssues.length ? allIssues.map(i => `- [${i.severity}] ${i.msg}`).join("\n") : "- None"}

### Actions
${allSuggestions.length ? allSuggestions.map((s, i) => `${i + 1}. ${s}`).join("\n") : "1. No actions needed"}

### Next check
${new Date(Date.now() + 6 * 3600000).toISOString()}
---`.trim();

  return { proposal, allIssues, allSuggestions, status };
}

async function main() {
  console.log("[loop] starting improvement loop v3...");
  const ts = new Date().toISOString();

  const [portfolio, attribution, scoutData] = await Promise.all([
    get("/api/portfolio").catch(e => { console.warn("[loop] portfolio:", e.message); return null; }),
    get("/api/attribution?days=7").catch(e => { console.warn("[loop] attribution:", e.message); return null; }),
    get("/api/strategy/scout?days=7").catch(e => { console.warn("[loop] scout:", e.message); return null; }),
  ]);

  if (!attribution) { console.error("[loop] attribution unavailable"); process.exit(1); }

  const attrAnalysis  = analyseAttribution(attribution);
  const posAnalysis   = analysePositions(attribution);
  const portAnalysis  = portfolio ? analysePortfolio(portfolio) : { issues: [], suggestions: [], lpPct: "n/a" };
  const scoutAnalysis = scoutData  ? analyseScout(scoutData.rows || []) : { moveOpps: [], issues: [], suggestions: [] };

  const { proposal, allIssues, allSuggestions, status } = synthesise({ attrAnalysis, posAnalysis, portAnalysis, scoutAnalysis, ts });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "improvement-loop.json"), JSON.stringify({ ts, status, issues: allIssues, suggestions: allSuggestions, scout: scoutAnalysis.moveOpps }, null, 2));

  fs.mkdirSync(path.dirname(BRAIN), { recursive: true });
  fs.appendFileSync(BRAIN, "\n" + proposal + "\n");

  console.log(`[loop] ${status} — ${allIssues.length} issues, ${allSuggestions.length} suggestions`);
  allIssues.forEach(i => console.log(`  [${i.severity}] ${i.msg}`));
  if (allSuggestions.length) console.log("  Top suggestion:", allSuggestions[0]);

  try {
    const settings = require("../settings").load();
    const token  = process.env.TELEGRAM_TOKEN   || settings.alerts?.telegramToken;
    const chatId = process.env.TELEGRAM_CHAT_ID  || settings.alerts?.fallbackChat;
    if (token && chatId) {
      const lines = allIssues.slice(0, 3).map(i => `• [${i.severity}] ${i.msg}`);
      if (allIssues.length > 3) lines.push(`+${allIssues.length - 3} more`);
      lines.push("");
      allSuggestions.slice(0, 2).forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      const msg = `🔄 Improvement loop — ${status}\n\n${lines.join("\n")}`;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg }),
      });
      console.log("[loop] Telegram sent");
    }
  } catch(e) {
    console.warn("[loop] Telegram skipped:", e.message);
  }
}

main().catch(e => { console.error("[loop] FATAL:", e.message); process.exit(1); });
