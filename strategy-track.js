/**
 * Strategy track record: score every strategy proposal an agent makes against
 * what actually happened once its horizon passes, so we learn which advice pays.
 *
 * A proposal is a set of items, each naming a wallet + pair (and optionally a
 * tokenId) with an action and an expected outcome. When now >= t + horizonDays
 * the proposal is scored once against the position history (position_history,
 * served at /api/strategy/positions) and the collect history (/api/history):
 * for each item we pull the matching position(s) and compare the realised
 * collects / fee APR / time in range / net result with what was expected,
 * giving a per-item verdict and a per-proposal score (share of items met or
 * beat). "avoid" items are met when no position was opened in that pair during
 * the window.
 *
 * Collects are windowed: only collect rows whose timestamp falls inside the
 * proposal's window [t, t + horizonDays] count, so a position that predates the
 * proposal does not carry earlier collects into the comparison. The fee APR is
 * computed over the window from those collects and the position's deposited
 * USD. Time in range comes from the position row (the range log is per
 * position, not per window) and is flagged in the item's note when the position
 * predates the window. The position row's whole-life figures are kept under
 * actuals.lifetime for reference.
 *
 * Read-only apart from the proposals ledger (strategy-proposals.json, atomic
 * tmp+rename). No chain calls beyond what position_history already does: we
 * call the local HTTP API like strategy.js does.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const DAY = 86400000;
const HOUR = 3600000;
const round = (n, p = 2) => (n == null || !isFinite(n) ? null : +Number(n).toFixed(p));

/** Ledger path: the create() dir when given (tests use a temp dir), else the module dir. */
function ledgerFile(dir) {
  return path.join(dir || __dirname, "strategy-proposals.json");
}

/**
 * "ETH / LAPTOP", "LAPTOP/ETH", "laptop / eth", "ETH / USDG 1% V4" -> "eth|laptop" / "eth|usdg":
 * order-insensitive, and tier or version tags an agent may append ("1%", "0.3%", "v3", "v4") are ignored.
 */
function pairKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?%|\bv[34]\b|\(.*?\)/g, " ")
    .replace(/\s+/g, "")
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean)
    .sort()
    .join("|");
}

function readProposals(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function writeProposals(file, rows) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 1));
  fs.renameSync(tmp, file);
}

function create({ cfg, dir = __dirname, port }) {
  const BASE = `http://127.0.0.1:${port}`;
  const FILE = ledgerFile(dir);

  async function get(p) {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
    return r.json();
  }

  /** Validate a proposal row; returns a cleaned copy or throws. */
  function validate(body) {
    if (!body || typeof body !== "object") throw new Error("proposal object required");
    const author = String(body.author || "").trim().slice(0, 80);
    if (!author) throw new Error("author required");
    const horizonDays = Number(body.horizonDays);
    if (!isFinite(horizonDays) || horizonDays <= 0 || horizonDays > 365) throw new Error("horizonDays must be a positive number of days (max 365)");
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new Error("at least one item required");
    if (items.length > 50) throw new Error("at most 50 items per proposal");
    const cleanItems = items.map((it) => {
      if (!it || typeof it !== "object") throw new Error("each item must be an object");
      const wallet = String(it.wallet || "").trim().slice(0, 80);
      const pair = String(it.pair || "").trim().slice(0, 80);
      if (!wallet || !pair) throw new Error("each item needs wallet and pair");
      const action = String(it.action || "hold");
      if (!["hold", "close", "open", "rebalance", "avoid"].includes(action)) throw new Error(`unknown action ${action}`);
      const tokenId = it.tokenId != null ? String(it.tokenId).slice(0, 40) : null;
      const range = it.range && typeof it.range === "object" ? { lower: it.range.lower ?? null, upper: it.range.upper ?? null } : null;
      const expected = it.expected && typeof it.expected === "object"
        ? { feeAprPct: it.expected.feeAprPct ?? null, feesUsd: it.expected.feesUsd ?? null, netResultUsd: it.expected.netResultUsd ?? null }
        : null;
      return { wallet, pair, tokenId, action, range, expected };
    });
    return {
      id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      t: Date.now(),
      author,
      source: String(body.source || "api").slice(0, 20),
      horizonDays,
      rationale: String(body.rationale || "").slice(0, 4000),
      items: cleanItems,
      scoredAt: null,
      outcome: null,
    };
  }

  /** Record a new proposal (the one write path). */
  function record(body) {
    const row = validate(body);
    const rows = readProposals(FILE);
    rows.push(row);
    writeProposals(FILE, rows);
    return { ok: true, id: row.id, t: row.t, horizonDays: row.horizonDays, items: row.items.length };
  }

  /** Match a proposal item to position(s) from position_history: by tokenId when given, else by pair. */
  function matchPositions(item, positions) {
    const k = pairKey(item.pair);
    const byPair = positions.filter((p) => pairKey(p.pair) === k);
    if (item.tokenId != null) {
      const byId = byPair.filter((p) => String(p.tokenId) === String(item.tokenId));
      if (byId.length) return byId;
    }
    return byPair;
  }

  /** Whole-life realised metrics for a position that was open at some point inside [t0, t1]. */
  function lifetimeFor(pos, t0, t1) {
    const opened = pos.openedAt ? Date.parse(pos.openedAt) : null;
    const closed = pos.closedAt ? Date.parse(pos.closedAt) : null;
    const start = opened != null ? opened : t0;
    const end = closed != null ? closed : t1;
    if (end < t0 || start > t1) return null; // entirely outside the window
    return {
      collectsUsd: pos.collects && pos.collects.usd != null ? pos.collects.usd : null,
      feeAprPct: pos.realizedFeeAprPct != null ? pos.realizedFeeAprPct : null,
      pctInRange: pos.timeInRange && pos.timeInRange.pctInRange != null ? pos.timeInRange.pctInRange : null,
      resultVsDepositUsd: pos.closed && pos.closed.resultVsDepositUsd != null ? pos.closed.resultVsDepositUsd : null,
      depositedUsd: pos.depositedUsd != null ? pos.depositedUsd : null,
      status: pos.status,
      predatesWindow: opened != null && opened < t0,
    };
  }

  /** Sum the collect rows for a position that fall inside [t0, t1] (same id, version and wallet). */
  function windowedCollectsUsd(pos, history, t0, t1) {
    const nft = String(pos.tokenId);
    const addr = String(pos.walletAddress || "").toLowerCase();
    let sum = 0;
    for (const r of history) {
      if (r.principal) continue; // a close's principal is not a collect
      if (r.t == null || r.t < t0 || r.t > t1) continue;
      if (String(r.nftId) !== nft) continue;
      if ((r.version || 3) !== (pos.version || 3)) continue; // a v3 and a v4 position can share a number
      if (String(r.walletAddress || "").toLowerCase() !== addr) continue;
      sum += r.usd || 0;
    }
    return sum;
  }

  /** Verdict for one expected metric given the actual; tolerances scale with |expected|, so negative targets work too. */
  function metricVerdict(actual, expected) {
    if (actual == null || expected == null) return null; // no data for this metric
    const tol = Math.abs(expected) * 0.05;
    if (actual >= expected + tol) return "beat";
    if (actual >= expected - tol) return "met";
    return "missed";
  }

  /** Score one item against its matched positions and the collect history. */
  function scoreItem(item, positions, history, t0, t1) {
    const k = pairKey(item.pair);
    if (item.action === "avoid") {
      const openedInWindow = positions.some((p) => {
        const o = p.openedAt ? Date.parse(p.openedAt) : null;
        return o != null && o >= t0 && o <= t1 && pairKey(p.pair) === k;
      });
      return { verdict: openedInWindow ? "missed" : "met", delta: null, actuals: null, note: openedInWindow ? "a position was opened in this pair during the window" : "no position opened in this pair during the window" };
    }

    const matched = matchPositions(item, positions).map((p) => ({ pos: p, life: lifetimeFor(p, t0, t1) })).filter((m) => m.life);
    if (!matched.length) return { verdict: "no data", delta: null, actuals: null, note: "no matching position in the window" };

    // Windowed collects: the collect rows inside [t0, t1] for each matched position.
    let collectsUsd = 0, depositedUsd = null, predates = 0;
    for (const m of matched) {
      collectsUsd += windowedCollectsUsd(m.pos, history, t0, t1);
      if (m.life.depositedUsd != null) depositedUsd = (depositedUsd == null ? 0 : depositedUsd) + m.life.depositedUsd;
      if (m.life.predatesWindow) predates++;
    }
    // Fee APR over the window from those collects and the deposit; null when the deposit is unknown.
    const hoursInWindow = (t1 - t0) / HOUR;
    const feeAprPct = depositedUsd > 0 && hoursInWindow > 0 ? (collectsUsd / depositedUsd) * (8760 / hoursInWindow) * 100 : null;

    // Time in range and net result stay per position (whole life).
    const rangeN = matched.filter((m) => m.life.pctInRange != null).length;
    const rangeSum = matched.reduce((s, m) => s + (m.life.pctInRange || 0), 0);
    const resultN = matched.filter((m) => m.life.resultVsDepositUsd != null).length;
    const resultSum = matched.reduce((s, m) => s + (m.life.resultVsDepositUsd || 0), 0);
    const lifeAprN = matched.filter((m) => m.life.feeAprPct != null).length;
    const actuals = {
      collectsUsd: round(collectsUsd),
      feeAprPct: round(feeAprPct, 1),
      pctInRange: rangeN ? round(rangeSum / rangeN, 1) : null,
      resultVsDepositUsd: resultN ? round(resultSum / resultN) : null,
      positions: matched.length,
      lifetime: {
        collectsUsd: round(matched.reduce((s, m) => s + (m.life.collectsUsd || 0), 0)),
        feeAprPct: lifeAprN ? round(matched.reduce((s, m) => s + (m.life.feeAprPct || 0), 0) / lifeAprN, 1) : null,
        pctInRange: rangeN ? round(rangeSum / rangeN, 1) : null,
        resultVsDepositUsd: resultN ? round(resultSum / resultN) : null,
      },
    };

    const exp = item.expected || {};
    const deltas = {};
    const verdicts = [];
    if (exp.feesUsd != null) { deltas.feesUsd = actuals.collectsUsd != null ? round(actuals.collectsUsd - exp.feesUsd) : null; const v = metricVerdict(actuals.collectsUsd, exp.feesUsd); if (v) verdicts.push(v); }
    if (exp.feeAprPct != null) { deltas.feeAprPct = actuals.feeAprPct != null ? round(actuals.feeAprPct - exp.feeAprPct, 1) : null; const v = metricVerdict(actuals.feeAprPct, exp.feeAprPct); if (v) verdicts.push(v); }
    if (exp.netResultUsd != null) { deltas.netResultUsd = actuals.resultVsDepositUsd != null ? round(actuals.resultVsDepositUsd - exp.netResultUsd) : null; const v = metricVerdict(actuals.resultVsDepositUsd, exp.netResultUsd); if (v) verdicts.push(v); }

    let verdict;
    if (!verdicts.length) verdict = "no data";
    else if (verdicts.includes("missed")) verdict = "missed";
    else if (verdicts.includes("met")) verdict = "met";
    else verdict = "beat";

    const note = predates ? `${predates} matched position(s) predate the proposal; time in range covers their whole life, not only the window` : null;
    return { verdict, delta: deltas, actuals, note };
  }

  /** Score every due, unscored proposal once. Cheap; safe to call every tick. */
  async function score() {
    const rows = readProposals(FILE);
    const now = Date.now();
    let changed = false;
    let positions = null, history = null; // fetched once per call, only when something is due
    for (const row of rows) {
      if (row.scoredAt != null) continue;
      if (now < row.t + row.horizonDays * DAY) continue;
      const t0 = row.t, t1 = row.t + row.horizonDays * DAY;
      if (!positions) {
        try {
          positions = (await get("/api/strategy/positions")).positions || [];
          history = (await get("/api/history")).rows || [];
        } catch {
          return { ok: true, scored: false }; // dashboard not reachable; try again next tick
        }
      }
      const items = row.items.map((it) => {
        const s = scoreItem(it, positions, history, t0, t1);
        return { ...it, verdict: s.verdict, delta: s.delta, actuals: s.actuals, note: s.note };
      });
      const met = items.filter((i) => i.verdict === "met" || i.verdict === "beat").length;
      row.outcome = { items, score: items.length ? round((met / items.length) * 100, 1) : null, scoredAt: now };
      row.scoredAt = now;
      changed = true;
    }
    if (changed) writeProposals(FILE, rows);
    return { ok: true, scored: changed };
  }

  /** View: proposals newest first with items + outcome, plus a summary. */
  function view() {
    const rows = readProposals(FILE).slice().sort((a, b) => b.t - a.t);
    const byAuthor = {};
    for (const r of rows) {
      const a = byAuthor[r.author] || (byAuthor[r.author] = { author: r.author, proposals: 0, scored: 0, scoreSum: 0 });
      a.proposals++;
      if (r.outcome) { a.scored++; a.scoreSum += r.outcome.score || 0; }
    }
    const scored = rows.filter((r) => r.outcome);
    return {
      ok: true,
      asOf: new Date().toISOString(),
      proposals: rows.map((r) => ({
        id: r.id, t: new Date(r.t).toISOString(), author: r.author, source: r.source,
        horizonDays: r.horizonDays, rationale: r.rationale,
        dueAt: new Date(r.t + r.horizonDays * DAY).toISOString(),
        items: (r.outcome ? r.outcome.items : r.items).map((it) => ({
          wallet: it.wallet, pair: it.pair, tokenId: it.tokenId, action: it.action,
          range: it.range, expected: it.expected,
          ...(r.outcome ? { verdict: it.verdict, delta: it.delta, actuals: it.actuals, note: it.note } : {}),
        })),
        scoredAt: r.scoredAt ? new Date(r.scoredAt).toISOString() : null,
        outcome: r.outcome ? { score: r.outcome.score, scoredAt: new Date(r.outcome.scoredAt).toISOString() } : null,
      })),
      summary: {
        proposals: rows.length,
        scored: scored.length,
        pending: rows.length - scored.length,
        avgScore: scored.length ? round(scored.reduce((x, r) => x + (r.outcome.score || 0), 0) / scored.length, 1) : null,
        byAuthor: Object.values(byAuthor).map((a) => ({ author: a.author, proposals: a.proposals, scored: a.scored, avgScore: a.scored ? round(a.scoreSum / a.scored, 1) : null })),
      },
    };
  }

  return { record, score, view };
}

module.exports = { create, pairKey };
